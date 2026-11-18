import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { DAY, HOUR, MINUTE } from "../src/config.ts";
import { closeDb, commentStatus, kvGet, kvSet, openDb } from "../src/db.ts";
import { handleWebhook } from "../src/instagram/bot.ts";
import { GIVEAWAYS } from "../src/instagram/giveaways.ts";
import { idle, resetQueue } from "../src/instagram/queue.ts";
import { backfill, sweep } from "../src/instagram/sweep.ts";
import { BUTTON } from "../src/instagram/teaser.ts";
import { currentToken, refreshTokenIfDue } from "../src/instagram/token.ts";
import { comment, dm, OWNER, runQueue, tap } from "./events.ts";
import { igTime, isPrivateReply, startMockGraph } from "./mock-graph.ts";

const mock = await startMockGraph();
process.env.IG_GRAPH_BASE = mock.base;
delete process.env.TELEGRAM_BOT_TOKEN;
after(() => mock.close());

mock.state.captions.M1 = "Comment GUIDE and I'll send you the guide 👇\n\nThree things I'd check first…";

beforeEach(() => {
  closeDb();
  openDb(":memory:");
  resetQueue();
  mock.reset();
  process.env.IG_ACCESS_TOKEN = "seed-token";
  delete process.env.PUBLIC_REPLIES;
});
afterEach(() => idle());

describe("comments", () => {
  it("answers a keyword comment with one private reply that has the button", async () => {
    assert.deepEqual(await handleWebhook(comment("C1", "Guide 🙏", { id: "U1", username: "alice" })), [
      "teaser sent: GUIDE to @alice",
    ]);
    const [sent] = mock.sent();
    assert.deepEqual(sent.body.recipient, { comment_id: "C1" });
    assert.match(sent.body.message.text, /the guide/);
    assert.deepEqual(sent.body.message.quick_replies, [{ content_type: "text", title: BUTTON, payload: "GIVE:GUIDE" }]);
    assert.equal(sent.token, "seed-token");
  });

  it("never answers the same comment twice (Meta retries webhooks)", async () => {
    await handleWebhook(comment("C1", "guide", { id: "U1", username: "alice" }));
    assert.deepEqual(await handleWebhook(comment("C1", "guide", { id: "U1", username: "alice" })), ["skipped: already answered"]);
    assert.equal(mock.sent().length, 1);
  });

  it("only counts the keyword the reel's caption asks for", async () => {
    // TEST is a keyword too, but this reel's caption asks for GUIDE.
    assert.deepEqual(await handleWebhook(comment("C2", "did you test it?", { id: "U2", username: "bob" })), [
      "skipped: no keyword for this reel",
    ]);
    assert.equal(mock.sent().length, 0);
  });

  it("ignores his own comments, by id or by username", async () => {
    assert.deepEqual(await handleWebhook(comment("C3", "GUIDE", { id: OWNER, username: "yourbrand" })), ["skipped: own comment"]);
    assert.deepEqual(await handleWebhook(comment("C4", "GUIDE", { id: "other-id", username: "yourbrand" })), [
      "skipped: own comment",
    ]);
    assert.equal(mock.sent().length, 0);
  });

  it("falls back to a plain teaser if Instagram refuses the button, and remembers", async () => {
    mock.state.rejectButtonsOnPrivateReply = true;
    assert.deepEqual(await handleWebhook(comment("C5", "guide", { id: "U5", username: "eve" })), ["teaser sent: GUIDE to @eve"]);
    const [refused, plain] = mock.sent();
    assert.ok(refused.body.message.quick_replies);
    assert.equal(plain.body.message.quick_replies, undefined);
    assert.match(plain.body.message.text, /Reply GUIDE here/);
    assert.equal(kvGet("private_reply_buttons"), "no");

    mock.clear();
    await handleWebhook(comment("C6", "guide", { id: "U6", username: "frank" }));
    assert.equal(mock.sent().length, 1);
    assert.equal(mock.sent()[0].body.message.quick_replies, undefined);
  });

  it("keeps a comment in line while the token is bad, and answers it once the token works", async () => {
    mock.state.expiredTokens = ["seed-token"];
    const [result] = await handleWebhook(comment("C7", "guide", { id: "U7", username: "gina" }));
    assert.match(result, /^waiting: .*code 190/);
    assert.equal(commentStatus("C7"), "waiting");

    // The owner sets a new token. Meta sending the webhook again adds nothing:
    // the queue tries by itself once its five-minute pause is over.
    mock.state.expiredTokens = [];
    assert.deepEqual(await handleWebhook(comment("C7", "guide", { id: "U7", username: "gina" })), ["skipped: already in line"]);
    assert.equal(commentStatus("C7"), "waiting");
    await runQueue(Date.now() + 6 * MINUTE);
    assert.equal(commentStatus("C7"), "sent");
    assert.deepEqual(mock.privateReplies(), ["C7"]);
    assert.equal(mock.calls.filter(isPrivateReply).length, 2, "one turned away with the token, one sent");
  });
});

describe("public reply under the comment", () => {
  it("replies 'DM sent' with an @mention once the DM is out", async () => {
    await handleWebhook(comment("P1", "guide", { id: "U30", username: "alice" }));
    const [publicReply] = mock.replies();
    assert.equal(publicReply.path, "/P1/replies");
    assert.match(publicReply.body.message, /@alice/);
    assert.match(publicReply.body.message, /DM/);
    assert.ok(mock.calls.indexOf(mock.sent()[0]) < mock.calls.indexOf(publicReply), "the DM goes first");
  });

  it("replies under the top comment when the keyword came as a reply in a thread", async () => {
    await handleWebhook(comment("P3", "Guide 🙏", { id: "U31", username: "bob" }, "M1", "P2"));
    assert.deepEqual(mock.sent()[0].body.recipient, { comment_id: "P3" }, "the DM answers the reply itself");
    assert.equal(mock.replies()[0].path, "/P2/replies");
  });

  it("keeps the DM when the public reply fails", async () => {
    mock.state.rejectPublicReplies = true;
    const [result] = await handleWebhook(comment("P4", "guide", { id: "U32", username: "cleo" }));
    assert.match(result, /^teaser sent: GUIDE to @cleo \(no public reply: /);
    assert.equal(commentStatus("P4"), "sent");
  });

  it("says nothing in public when the DM failed", async () => {
    mock.state.expiredTokens = ["seed-token"];
    await handleWebhook(comment("P5", "guide", { id: "U33", username: "dan" }));
    assert.equal(mock.replies().length, 0);
  });

  it("can be turned off with PUBLIC_REPLIES=off", async () => {
    process.env.PUBLIC_REPLIES = "off";
    assert.deepEqual(await handleWebhook(comment("P6", "guide", { id: "U34", username: "eli" })), [
      "teaser sent: GUIDE to @eli",
    ]);
    assert.equal(mock.replies().length, 0);
  });
});

describe("DMs", () => {
  it("sends the whole giveaway, in order, when the button is tapped", async () => {
    assert.deepEqual(await handleWebhook(tap("U1", "GUIDE")), ["giveaway sent: GUIDE (button)"]);
    const sent = mock.sent();
    assert.equal(sent.length, GIVEAWAYS.GUIDE.messages.length);
    assert.deepEqual(
      sent.map((c) => c.body.message.text),
      GIVEAWAYS.GUIDE.messages,
    );
    for (const c of sent) assert.deepEqual(c.body.recipient, { id: "U1" });
  });

  it("sends it once on a double tap", async () => {
    await handleWebhook(tap("U1", "GUIDE"));
    assert.deepEqual(await handleWebhook(tap("U1", "GUIDE")), ["skipped: already sent or on its way"]);
  });

  it("answers a DM that is just a keyword, and leaves anything longer for a human", async () => {
    assert.deepEqual(await handleWebhook(dm("U2", { text: "guide!" })), ["giveaway sent: GUIDE (keyword)"]);
    assert.deepEqual(await handleWebhook(dm("U3", { text: "I love the guide reel" })), ["skipped: not a keyword"]);
    assert.deepEqual(await handleWebhook(dm("U4", { text: "hey, can we talk about a website?" })), ["skipped: not a keyword"]);
  });

  it("ignores the echoes of its own messages", async () => {
    assert.deepEqual(await handleWebhook(dm(OWNER, { text: "GUIDE", is_echo: true })), ["skipped: own message"]);
    assert.equal(mock.sent().length, 0);
  });

  it("handles the dashboard's test format (a DM inside 'changes')", async () => {
    const payload = {
      object: "instagram",
      entry: [{ id: OWNER, changes: [{ field: "messages", value: { sender: { id: "U8" }, recipient: { id: OWNER }, message: { mid: "x", text: "GUIDE" } } }] }],
    };
    assert.deepEqual(await handleWebhook(payload), ["giveaway sent: GUIDE (keyword)"]);
  });
});

describe("sweep and backfill", () => {
  function setUpPosts(now: number) {
    mock.state.media = [
      { id: "M5", caption: "Comment KEY and I'll send you the prompt.", timestamp: igTime(now - 2 * DAY), comments_count: 5 },
      { id: "M6", caption: "No keyword on this one.", timestamp: igTime(now - DAY), comments_count: 3 },
    ];
    mock.state.comments.M5 = [
      { id: "K1", text: "KEY", timestamp: igTime(now - 10 * MINUTE), from: { id: "U10", username: "bob" } },
      { id: "K2", text: "key please", timestamp: igTime(now - 2 * HOUR), from: { id: "U11", username: "dave" } },
      { id: "K3", text: "KEY", timestamp: igTime(now - 5 * MINUTE), from: { id: OWNER, username: "yourbrand" } },
      {
        id: "K4",
        text: "nice one",
        timestamp: igTime(now - 5 * MINUTE),
        from: { id: "U12", username: "erin" },
        replies: { data: [{ id: "K5", text: "Key 🔑", timestamp: igTime(now - 3 * MINUTE), from: { id: "U13", username: "carol" } }] },
      },
      { id: "K6", text: "KEY", timestamp: igTime(now - 8 * DAY), from: { id: "U14", username: "old" } },
    ];
  }

  it("answers new keyword comments the webhook missed, once", async () => {
    const now = Date.now();
    setUpPosts(now);
    kvSet("sweep_since", String(now - HOUR));
    assert.deepEqual(await sweep(), ["teaser sent: KEY to @bob", "teaser sent: KEY to @carol"]);
    assert.deepEqual(
      mock
        .replies()
        .map((c) => c.path)
        .sort(),
      ["/K1/replies", "/K4/replies"],
      "carol's keyword was a reply under K4, so her public reply goes under K4",
    );
    assert.equal(
      mock.calls.some((c) => c.path === "/M6/comments"),
      false,
      "posts whose caption asks for nothing are skipped",
    );
    assert.deepEqual(await sweep(), []);
  });

  it("previews older comments from the last 7 days, skips names on request, and sends", async () => {
    const now = Date.now();
    setUpPosts(now);
    const preview = await backfill(7, new Set(), false);
    assert.ok(preview.mode === "preview");
    assert.deepEqual(
      preview.pending.map((p) => p.username),
      ["bob", "dave", "carol"],
    );
    assert.equal(mock.sent().length, 0, "a preview sends nothing");

    const skipped = await backfill(7, new Set(["dave"]), false);
    assert.equal(skipped.count, 2);

    const sent = await backfill(7, new Set(["dave"]), true);
    assert.equal(sent.mode, "sent");
    assert.equal(mock.sent().length, 2);
  });
});

describe("system-user token (Meta's Unified login)", () => {
  it("calls the account by id and never tries to refresh the token", async () => {
    process.env.IG_ACCESS_TOKEN = "EAAsystemusertoken";
    process.env.IG_USER_ID = OWNER;
    try {
      assert.deepEqual(await handleWebhook(comment("S1", "guide", { id: "U20", username: "sam" })), [
        "teaser sent: GUIDE to @sam",
      ]);
      const [sent] = mock.sent();
      assert.equal(sent.path, `/${OWNER}/messages`);
      assert.equal(sent.token, "EAAsystemusertoken");

      kvSet("token_since", String(Date.now() - 30 * DAY));
      assert.equal(await refreshTokenIfDue(), "never expires");
      assert.equal(
        mock.calls.some((c) => c.path === "/refresh_access_token"),
        false,
      );
    } finally {
      delete process.env.IG_USER_ID;
    }
  });
});

describe("token", () => {
  it("starts from IG_ACCESS_TOKEN, refreshes it weekly, and a new IG_ACCESS_TOKEN wins", async () => {
    assert.equal(currentToken(), "seed-token");
    assert.equal(await refreshTokenIfDue(), "not due");

    kvSet("token_since", String(Date.now() - 8 * DAY));
    assert.equal(await refreshTokenIfDue(), "refreshed");
    assert.equal(currentToken(), "refreshed-token");
    assert.ok(Number(kvGet("token_expires")) > Date.now() + 59 * DAY);

    await handleWebhook(dm("U9", { text: "guide" }));
    assert.equal(mock.sent()[0].token, "refreshed-token");

    process.env.IG_ACCESS_TOKEN = "new-seed";
    assert.equal(currentToken(), "new-seed");
  });
});
