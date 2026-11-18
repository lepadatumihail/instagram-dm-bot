# instagram-dm-bot

Your own "comment a keyword, get a DM" bot for Instagram reels. It uses
Instagram's official API and runs on a small server you deploy yourself, so
there is no per-contact pricing: you pay for the server.

Built in one evening with Claude Code, for
[@lepadatu.dev](https://www.instagram.com/lepadatu.dev/), where it answers the
comments on every reel.

## What it does

1. Someone comments the keyword your caption asks for ("Comment GUIDE and I'll
   send you the guide 👇").
2. They get one DM: a short hello with a **Send it over 👇** button. Right
   after, the bot replies under their comment, "Hey @name, DM sent 📩", in one
   of four wordings so the thread doesn't repeat one line. `PUBLIC_REPLIES=off`
   turns that off.
3. Tapping the button (or replying with the keyword) sends what you promised.

On @lepadatu.dev the reply was up 7 to 15 seconds after the comment (the nine
comments of its first day).

Why a button, and not the link straight away: Instagram allows one message per
comment, and nothing more until the person answers. The tap is that answer. It
opens a 24-hour window, so the bot can send the rest, and you can keep talking.

What it answers:

- a comment that contains the keyword, on a post whose live caption says
  "Comment KEYWORD" (so the same word under another post sends nothing);
- a DM that is only a keyword ("guide", "GUIDE 🙏");
- a tap on the button.

Everything else, including your own comments and any normal DM, is left for you.

## What you need

- An Instagram creator or business account.
- A Meta developer account (free) at
  [developers.facebook.com](https://developers.facebook.com).
- A server with a public HTTPS address and a disk that stays. The steps below
  use [Railway](https://railway.com) (its Hobby plan is $5 a month).
- Node 24 to run it locally. It runs the TypeScript directly: no build step,
  no runtime dependencies.

## Run it locally

```bash
npm install
cp .env.example .env
npm test
npm run dev
```

## 1. Deploy

Deploy first: Meta checks the webhook address when you save it.

```bash
railway init --name instagram-dm-bot
railway up --detach
railway volume add --mount-path /data
railway variable set DB_PATH=/data/bot.db
railway variable set IG_VERIFY_TOKEN=$(openssl rand -hex 24)
railway variable set ADMIN_KEY=$(openssl rand -hex 24)
railway variable set CONTACT_EMAIL=you@example.com
railway variable set IG_USERNAME=yourhandle
railway domain
```

- `railway domain` prints the public address, called `<domain>` below.
- `railway variable list --kv` shows the two random values when you need them.
- Check that `https://<domain>/health` says ok and `https://<domain>/privacy`
  shows the notice. Read that notice: it is published under your name, so it
  has to be true for you. `OWNER_NAME` and `OWNER_URL` add who runs the account.

## 2. The Meta app

These are the steps that worked on 17 November 2026. Meta moves its dashboard
around, so the names may have changed by the time you read this.

1. **Create App** → a name → use case **Manage messaging & content on
   Instagram** → **Create app**.
2. **App settings → Basic**:
   - Privacy policy URL: `https://<domain>/privacy`
   - User data deletion (instructions URL): `https://<domain>/privacy#data-deletion`
   - Category: Messenger bots for business.
3. **Use cases → Customize → API setup with Unified login**. It only opens once
   the app has a business portfolio (**+ Business portfolio**). Connecting a
   portfolio isn't the same as verifying it, and it wasn't asked to be verified.
4. **App roles → Roles → Add People → Instagram Tester** → your account, then
   accept the invite at instagram.com → Settings → Apps and websites → Tester
   invites.
5. **Step 1, Configure your app** → **Create new configuration** → **Create
   from template**. It gives a system-user token that never expires.
6. **Step 3, Configure webhooks**:
   - Callback URL: `https://<domain>/webhook`
   - Verify token: your `IG_VERIFY_TOKEN`
   - Leave "Attach a client certificate" off. The bot checks each webhook's
     signature instead.
   - Click **Verify and save**, then subscribe `comments`, `messages` and
     `messaging_postbacks`.
7. **Step 2, Generate token** next to your account, then set it without it
   landing in your shell history (macOS):

   ```bash
   pbpaste | railway variable set IG_ACCESS_TOKEN --stdin
   ```

8. **App settings → Basic → App secret → Show**, then:

   ```bash
   pbpaste | railway variable set META_APP_SECRET --stdin
   ```

9. Set `IG_USER_ID` to the account id that step 2 shows next to your account.
   With a system-user token the bot calls the account by this id.

## 3. Publish the app

While the app is in development, Meta only sends events from accounts that
have a role on it. On the app's **Publish** page, publishing asked only for the
privacy policy URL. After that, comments from strangers were answered, with no
App Review and no Business Verification. Meta's docs say live data needs App
Review, so yours may be asked for it: then submit `instagram_manage_comments`
and `instagram_manage_messages` with a screen recording of the comment, the
DM and the tap.

The **Test** button next to each webhook field sends a sample event with
made-up ids. Expect a logged failure: it shows the signature check and the
plumbing work.

## 4. First real test

From another Instagram account (the bot ignores yours), comment the keyword
under a post whose caption asks for it. A DM with the button should arrive
within seconds; tap it. Watch it happen with `railway logs`.

If DMs work but comments trigger nothing, Meta isn't sending comment webhooks
to your app. The sweep still finds keyword comments every 10 minutes
(`SWEEP_MINUTES`), so it works either way, just slower.

## What each keyword sends

One note per post in `giveaways/`, in Markdown. Three examples are there. A
note needs two things:

```markdown
## Caption

Comment GUIDE and I'll send you the guide 👇

## DM for people who comment GUIDE

Here you go 👇

The guide: example.com/guide
```

- The caption line gives the button message its promise: "Tap the button
  below and I'll send you the guide."
- The DM section is sent word for word. It has to fit in one Instagram
  message, 1,000 bytes. If it doesn't, the next step fails and names the note.

Then:

```bash
npm run giveaways
```

It writes `data/giveaways.json`, which is what the bot reads. Commit it and
deploy (`railway up`). Set `GIVEAWAYS_DIR` to keep your notes somewhere else.

Each new post: put "Comment KEYWORD and I'll send you …" in its caption (the
bot reads the live caption), write its note, run `npm run giveaways`, deploy.

## Comments from before the bot

The sweep only looks at comments from the first start on. For older ones (up to
7 days back, Meta's limit), preview first, then send. `skip` takes the
usernames you already answered by hand:

```bash
curl -H "Authorization: Bearer $ADMIN_KEY" "https://<domain>/admin/pending?days=7"
curl -X POST -H "Authorization: Bearer $ADMIN_KEY" "https://<domain>/admin/backfill?days=7&skip=name1,name2"
```

## Post a reel from the command line

`scripts/post-reel.mjs` publishes a reel through the same API, in two steps, so
nothing is public until the second one:

```bash
railway run -- node scripts/post-reel.mjs upload --video reel.mp4 --caption-file caption.txt --thumb-offset 2100
railway run -- node scripts/post-reel.mjs publish --container <id from upload>
```

- `railway run` lends the script your bot's token. Locally, use
  `node --env-file=.env scripts/post-reel.mjs …` instead.
- The cover is a frame of the video (`--thumb-offset`, in milliseconds) or a
  JPEG at a public address (`--cover-url`). The API takes no image upload.
- `--ai-label` marks the reel as made with AI.
- An upload expires after 24 hours. There is no timer yet: `publish` posts
  when you run it.

## Day to day

- **Stats:** `curl -H "Authorization: Bearer $ADMIN_KEY" https://<domain>/admin/stats`
  gives messages sent and giveaways delivered, per keyword.
- **Token:** a system-user token never expires. (An older Instagram-login
  token is swapped for a fresh 60-day one every week, automatically.)
- **Failures:** go to `railway logs`, and to Telegram if you set
  `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` (one alert per kind per hour).
- **Data:** records are deleted after 90 days, as `/privacy` says.

## Instagram's rules

From Meta's page "Send a Private Reply to a Commenter", read 18 November 2026:

- one message per comment;
- sent within 7 days of the comment;
- more messages only after the person answers, and within 24 hours of that.

A message holds at most 1,000 bytes. The button is a quick reply; it doesn't
show on Instagram on a computer, so the first message also says "Just reply
GUIDE".

## Files

| File | What it does |
|---|---|
| `src/server.ts` | Starts the bot: database, HTTP server, timers (sweep, token refresh, cleanup) |
| `src/app.ts` | The HTTP routes: `/webhook`, `/privacy`, `/health`, `/admin/*` |
| `src/instagram/bot.ts` | The flow: comment → button message, tap or keyword DM → giveaway |
| `src/instagram/sweep.ts` | Finds keyword comments the webhook missed; backfill |
| `src/instagram/match.ts` | How captions, comments and DMs are read |
| `src/instagram/token.ts` | The access token and its weekly refresh |
| `src/instagram/graph.ts` | The Instagram API calls |
| `src/db.ts` | SQLite (Node's built-in): comments answered, deliveries, settings |
| `src/privacy.ts` | The privacy notice Meta asks for |
| `scripts/giveaways.ts` | Builds `data/giveaways.json` from the notes |
| `scripts/post-reel.mjs` | Posts a reel from the command line |
| `test/` | `npm test`: the flows against a stand-in Instagram API |

## Licence

MIT. Use it, change it, sell what you build with it.
