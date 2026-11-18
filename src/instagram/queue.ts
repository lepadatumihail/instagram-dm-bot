import { alert } from "../alert.ts";
import { config, DAY, HOUR, MINUTE, SECOND } from "../config.ts";
import {
  type CommentJob,
  type QueuedComment,
  type QueuedDelivery,
  type Requeued,
  callsSince,
  claimComments,
  claimDeliveries,
  commentStatus,
  failCutOffDeliveries,
  inLine,
  noteCall,
  queueComment,
  queueDelivery,
  requeueFailed,
  settleComment,
  settleDelivery,
} from "../db.ts";
import { GIVEAWAYS } from "./giveaways.ts";
import { describe, failureKind, GraphError, replyToComment, sendMessage } from "./graph.ts";
import { publicReplyText, sendTeaser } from "./teaser.ts";

/**
 * Sends what's in line. The line is in the database (db.ts): bot.ts and the
 * sweep put teasers and giveaways there, and this file works it off, so a
 * burst of comments, a slow Instagram or a restart changes when a message
 * goes out, never whether.
 *
 * - A few sends at a time (SEND_CONCURRENCY), however many are waiting.
 * - Giveaways go before teasers: whoever tapped the button is looking at the
 *   chat. One person's giveaways go one at a time, in the order asked for.
 * - Teasers stay inside Meta's limit on private replies, 750 an hour per
 *   account (the "Rate Limits" page of the Graph API docs). After
 *   PRIVATE_REPLIES_PER_HOUR in any 60 minutes the rest wait their turn; a
 *   private reply is allowed for 7 days, so they still get theirs. Giveaways
 *   go through the Send API, 100 calls a second: SEND_CONCURRENCY alone keeps
 *   the bot far below that.
 * - When a send fails for a reason that isn't about the one message
 *   (Instagram is failing, the token is turned away, Meta says "slow down"),
 *   a gate shuts and nothing passes for a while. The message goes back in
 *   line, and when the gate opens a single message tests the water before
 *   the rest follow. See setback().
 * - A message Meta refuses outright gets a strike. A teaser is given up at
 *   the third (ten minutes and then an hour apart), a giveaway at the first.
 * - A call that got no answer may have arrived all the same. A teaser is
 *   tried again, ten minutes and then an hour later (Instagram allows one
 *   private reply per comment, so a second shouldn't arrive), six times at
 *   most. A giveaway is not sent again: nothing would stop a second copy.
 */

/** Instagram allows a private reply up to 7 days after the comment; an hour is kept to spare. */
export const REPLY_WINDOW = 7 * DAY - HOUR;
/** A giveaway may follow the tap or the keyword DM for 24 hours; an hour is kept to spare. */
const MESSAGE_WINDOW = DAY - HOUR;
/**
 * A try that counts against the message itself is a strike. A teaser is given
 * up at the third when Meta refused it, at the sixth when no answer came. It
 * waits ten minutes after its first strike and an hour after every later one.
 */
const MAX_REFUSED = 3;
const MAX_UNANSWERED = 6;
const STRIKE_WAITS = [10 * MINUTE, HOUR];
/** However it fails, no message is tried more often than this. */
const MAX_ATTEMPTS = 50;
/** When this many messages in a row are refused on their first try, with nothing getting through, it isn't about the messages any more. */
const REFUSAL_STREAK = 10;
/** After Instagram turns a public reply down with "slow down", none are tried for this long. DMs carry on. */
const PUBLIC_REPLY_REST = HOUR;

/**
 * A gate shuts when a send fails for a reason that isn't about the one
 * message: nothing passes before `until`. Each time in a row it has to shut
 * it stays shut longer, and once it opens, messages pass one at a time until
 * one gets through (`strikes` is back to 0).
 */
type Gate = { until: number; strikes: number; because: string };
const gate = (): Gate => ({ until: 0, strikes: 0, because: "" });

/** For every message: Instagram is failing, or the token was turned away. */
const everything = gate();

/**
 * Teasers and giveaways each have a gate of their own for "slow down": they
 * are two APIs with a limit each, so a hold on one doesn't keep the other
 * waiting. `refused` counts the messages in a row that Meta refused on their
 * first try.
 */
type Lane = { name: string; gate: Gate; refused: number; mine: (key: string) => boolean };
const teasers: Lane = { name: "teasers", gate: gate(), refused: 0, mine: (key) => key.startsWith("comment ") };
const giveaways: Lane = { name: "giveaways", gate: gate(), refused: 0, mine: (key) => key.startsWith("delivery ") };

/** Sends in flight, by name: "comment <id>" or "delivery <id>". */
const flying = new Set<string>();
/** Callers waiting to hear how a message's next try went, by the same names. */
const listeners = new Map<string, (result: string) => void>();
/** Callers waiting for the sends in flight to end. */
const idlers: (() => void)[] = [];
/** No public replies before this time. */
let publicRepliesFrom = 0;
let overLimitSaid = false;
let stopped = false;
/**
 * Tests run the queue at a later time instead of waiting: pump(later) moves
 * this clock ahead. (Not while a send is in flight: its two minutes would be
 * over at once.)
 */
let ahead = 0;
const clock = () => Date.now() + ahead;

/** Puts a keyword comment in line for its teaser, once, and reports how its first try went. */
export function answerComment(job: CommentJob): Promise<string> {
  if (queueComment(job, clock())) return queued(`comment ${job.commentId}`);
  const status = commentStatus(job.commentId);
  return Promise.resolve(`skipped: already ${status === "sent" ? "answered" : status === "failed" ? "given up" : "in line"}`);
}

/** Puts a giveaway in line and reports how its first try went. */
export function deliver(userId: string, keyword: string, via: "button" | "keyword"): Promise<string> {
  const id = queueDelivery(userId, keyword, via, clock());
  return id === null ? Promise.resolve("skipped: already sent or on its way") : queued(`delivery ${id}`);
}

/**
 * Puts the comments given up in the last `days` days back in line. For after
 * something that wasn't about them is fixed (a permission, a block on the
 * account); /admin/requeue calls it.
 */
export function requeue(days: number): Requeued[] {
  const back = requeueFailed(clock() - Math.min(days, 7) * DAY, clock());
  pump();
  return back;
}

/**
 * How the next try of a message in line went, or "waiting: …" at once when
 * it can't go out for now. It never rejects: nobody may be listening yet.
 */
function queued(key: string): Promise<string> {
  return new Promise((resolve) => {
    listeners.set(key, resolve);
    if (stopped) return tell(key, "waiting: the bot is restarting");
    try {
      pump();
    } catch (e) {
      console.error("queue:", e);
      tell(key, `waiting: ${describe(e)}`);
    }
  });
}

function tell(key: string, result: string): void {
  const listener = listeners.get(key);
  listeners.delete(key);
  listener?.(result);
}

/**
 * Starts as many waiting sends as there is room for, and returns how many.
 * It runs when a message joins the line, when a send ends, and every few
 * seconds (server.ts) for whatever has come due.
 */
export function pump(at?: number): number {
  if (at !== undefined) ahead = at - Date.now();
  if (stopped) return 0;
  const now = clock();
  let started = 0;
  let privateRepliesLeft = config.privateRepliesPerHour - callsSince("private_reply", now - HOUR);

  const cutOff = failCutOffDeliveries(now);
  if (cutOff > 0) void alert("cut off", `${cutOff} giveaway(s) were being sent when the bot was stopped. They may have arrived, so they aren't sent again.`);

  if (now >= everything.until) {
    const testing = everything.strikes > 0;
    const width = testing ? 1 : config.sendConcurrency;
    const startGiveaways = () => {
      for (const job of claimDeliveries(room(giveaways, width, now), now)) started += start(`delivery ${job.id}`, give(job));
    };
    const startTeasers = () => {
      for (const job of claimComments(Math.min(room(teasers, width, now), privateRepliesLeft), now)) {
        // Counted when the comment is taken, not when Meta answers: a call Meta refuses counts toward its limit too.
        noteCall("private_reply", now);
        privateRepliesLeft--;
        started += start(`comment ${job.commentId}`, answer(job));
      }
    };
    // Giveaways first, except to test the water after Instagram failed: a teaser
    // that gets no answer can be tried again, a giveaway can't.
    if (testing) startTeasers();
    startGiveaways();
    if (!testing) startTeasers();
  }
  tellTheHeld(now, privateRepliesLeft < 1);
  return started;
}

/** How many more sends of one kind may start: none while its gate is shut, one at a time while it tests the water. */
function room(lane: Lane, width: number, now: number): number {
  if (now < lane.gate.until) return 0;
  const free = width - flying.size;
  if (lane.gate.strikes === 0) return free;
  return [...flying].some(lane.mine) ? 0 : Math.min(free, 1);
}

function start(key: string, send: Promise<string>): number {
  flying.add(key);
  void send
    .catch((e: unknown) => `failed: ${describe(e)}`)
    .then((result) => {
      flying.delete(key);
      tell(key, result);
      pump();
      if (flying.size === 0) for (const done of idlers.splice(0)) done();
    })
    .catch((e: unknown) => console.error("queue:", e));
  return 1;
}

/** A caller whose message can't go out for now hears so at once, rather than waiting along with it. */
function tellTheHeld(now: number, overLimit: boolean): void {
  if (!overLimit) overLimitSaid = false;
  let overLimitNews = false;
  for (const key of [...listeners.keys()]) {
    if (flying.has(key)) continue;
    const lane = teasers.mine(key) ? teasers : giveaways;
    const shutGate = now < everything.until ? everything : now < lane.gate.until ? lane.gate : undefined;
    if (shutGate) tell(key, `waiting: ${shutGate.because}`);
    else if (overLimit && lane === teasers) {
      tell(key, "waiting: the hourly limit on private replies is reached");
      overLimitNews = true;
    }
  }
  if (overLimitNews && !overLimitSaid) {
    overLimitSaid = true;
    void alert(
      "hourly limit",
      `the bot has sent ${config.privateRepliesPerHour} private replies in an hour (PRIVATE_REPLIES_PER_HOUR; Meta allows 750). ` +
        `${inLine().comments} comments are in line and get their DM as the hour moves on.`,
    );
  }
}

/**
 * Shuts a gate and returns for how long. `pause` gets 1, 2, 4… for the first,
 * second, third time in a row. The sends that were in flight when the gate
 * shut fail the same way and say nothing new, so only the first one counts.
 */
function shut(g: Gate, now: number, because: string, pause: (doubling: number) => number): number {
  if (now >= g.until) g.strikes++;
  const wait = pause(2 ** Math.min(Math.max(g.strikes, 1) - 1, 10));
  g.until = Math.max(g.until, now + wait);
  g.because = because;
  return wait;
}

/** A message got through, or Meta answered about the message itself: whatever was wrong at this gate is over. */
function passed(g: Gate, now: number): void {
  if (now >= g.until) g.strikes = 0;
}

const span = (ms: number) => (ms < MINUTE ? `${Math.round(ms / SECOND)} s` : `${Math.round(ms / MINUTE)} min`);

/**
 * A send failed. Is that about this one message, or about the line? Returns
 * whether it counts against the message (a strike) and when to try it again.
 *
 * - Meta refused the message (the comment is gone, the person can't be
 *   messaged): that's about the message, a strike. But when ten messages in
 *   a row are refused on their first try and nothing gets through, it is
 *   about the line (a permission gone, the account blocked): from the tenth
 *   on, the gate for that kind of message shuts instead, and they wait.
 * - Anything else is about the line. A gate shuts and the message waits:
 *     Instagram failing: everything, for a second, doubling to a minute;
 *     the token turned away: everything, five minutes at a time;
 *     "slow down": that kind of message, for five minutes, doubling to an
 *     hour, or for as long as Meta's usage header says.
 *   The message comes due after the gate opens, later each time it fails
 *   (retries after 5 s, 15 s, 45 s… up to 10 minutes; after "slow down" 5, 15,
 *   45 minutes… up to 12 hours). So another message tests the water first,
 *   and a message that is itself the trouble gets out of the others' way.
 * - A call that got no answer may have arrived all the same, so it is a
 *   strike as well, with a strike's long wait: nothing is sent again on a
 *   guess in a hurry, or without end.
 */
function setback(e: unknown, job: { attempts: number; strikes?: number }, lane: Lane, doing: string): { strike: boolean; refused: boolean; dueAt: number } {
  const now = clock();
  const kind = failureKind(e);
  const strikeWait = STRIKE_WAITS[job.strikes ?? 0] ?? HOUR;
  const again = 3 ** Math.min(job.attempts - 1, 10);

  if (kind === "permanent") {
    passed(everything, now);
    // Only a first try can say something about the line: a message refused before is its own trouble.
    if (job.attempts > 1 || ++lane.refused < REFUSAL_STREAK) {
      void report(e, doing);
      return { strike: true, refused: true, dueAt: now + strikeWait };
    }
  }

  const line = inLine();
  const safe = `Nothing is lost: what's in line (${line.comments} teasers, ${line.deliveries} giveaways) goes out after.`;
  const regain = e instanceof GraphError ? Math.min(DAY, e.regainMinutes * MINUTE) : 0;
  const slowDown = (doubling: number) => Math.max(regain, Math.min(HOUR, 5 * MINUTE * doubling));
  let dueAt: number;
  if (kind === "token") {
    shut(everything, now, "the access token isn't working", () => 5 * MINUTE);
    dueAt = everything.until + 5 * SECOND;
    void alert(
      "token",
      `${doing}: the access token isn't working (${describe(e)}). Generate a new one in the Meta app and set IG_ACCESS_TOKEN on Railway. ${safe}`,
    );
  } else if (kind === "retry") {
    const wait = shut(everything, now, "Instagram is failing", (doubling) => Math.min(MINUTE, SECOND * doubling));
    dueAt = everything.until + Math.min(10 * MINUTE, 5 * SECOND * again);
    const text = `${doing}: ${describe(e)}. Everything waits ${span(wait)}.`;
    // One hiccup isn't worth a Telegram message; three in a row are.
    if (everything.strikes >= 3) void alert("no answer", `${text} ${safe}`);
    else console.warn(`[retry] ${text}`);
  } else {
    const refusing = kind === "permanent";
    const because = refusing ? "Instagram is refusing every message" : "Instagram said to slow down";
    const wait = shut(lane.gate, now, because, slowDown);
    dueAt = lane.gate.until + Math.min(12 * HOUR, 5 * MINUTE * again);
    const what = refusing ? `Instagram has refused ${lane.refused} ${lane.name} in a row, so it isn't about them` : "Instagram says slow down";
    void alert(refusing ? "refusing" : "slow down", `${doing}: ${what} (${describe(e)}). No ${lane.name} go out for ${span(wait)}. ${safe}`);
  }
  return e instanceof GraphError && e.maybeSent ? { strike: true, refused: false, dueAt: now + strikeWait } : { strike: false, refused: false, dueAt };
}

function report(e: unknown, context: string): Promise<void> {
  const kind = e instanceof GraphError ? `graph ${e.code ?? e.status}/${e.subcode ?? ""}` : "error";
  return alert(kind, `${context}: ${describe(e)}`);
}

/** One comment's turn: the teaser, then the public reply under the comment. */
async function answer(job: QueuedComment): Promise<string> {
  const who = `${job.keyword} to @${job.username}`;
  if (clock() - job.at > REPLY_WINDOW) {
    settleComment(job.commentId, "failed", { error: "too late: a private reply is allowed for 7 days" }, clock());
    void alert("too late", `the ${job.keyword} teaser for @${job.username} waited past the 7 days a private reply is allowed. It's given up.`);
    return `failed: too late for a private reply (${who})`;
  }
  try {
    await sendTeaser(job.commentId, job.keyword, clock());
  } catch (e) {
    const doing = `couldn't send the ${job.keyword} teaser to @${job.username}`;
    const { strike, refused, dueAt } = setback(e, job, teasers, doing);
    const givenUp = (strike && job.strikes + 1 >= (refused ? MAX_REFUSED : MAX_UNANSWERED)) || job.attempts >= MAX_ATTEMPTS;
    settleComment(job.commentId, givenUp ? "failed" : "waiting", { error: describe(e), dueAt, strike }, clock());
    if (givenUp) void alert("given up", `${doing} in ${job.attempts} tries (${describe(e)}). It's given up; /admin/requeue puts it back in line.`);
    return `${strike || givenUp ? "failed" : "waiting"}: ${describe(e)}`;
  }
  settleComment(job.commentId, "sent", {}, clock());
  got(teasers);

  const sent = `teaser sent: ${who}`;
  if (!config.publicReplies) return sent;
  const skip = noPublicReply(clock());
  if (skip) return `${sent} (no public reply: ${skip})`;
  noteCall("public_reply", clock());
  try {
    await replyToComment(job.parentId ?? job.commentId, publicReplyText(job.username, job.commentId));
    return sent;
  } catch (e) {
    // The DM is out, so the comment is answered. The public reply gets one try: a call that failed
    // without an answer may still have posted, and two "DM sent" under one comment look worse than none.
    if (failureKind(e) === "limit") publicRepliesFrom = clock() + PUBLIC_REPLY_REST;
    void report(e, `sent the ${job.keyword} DM to @${job.username}, but couldn't reply under the comment`);
    return `${sent} (no public reply: ${describe(e)})`;
  }
}

/** A message of this kind got through: every gate it passed is open again. */
function got(lane: Lane): void {
  passed(everything, clock());
  passed(lane.gate, clock());
  lane.refused = 0;
}

/** Why a comment gets no public reply right now, or "" when it gets one. */
function noPublicReply(now: number): string {
  if (now < publicRepliesFrom) return "Instagram said to slow down";
  const cap = config.publicRepliesPerHour;
  return cap > 0 && callsSince("public_reply", now - HOUR) >= cap ? "PUBLIC_REPLIES_PER_HOUR is reached" : "";
}

/**
 * One giveaway's turn. Every giveaway is one message (the tests insist), so a
 * second try can't repeat a part that already arrived.
 */
async function give(job: QueuedDelivery): Promise<string> {
  const messages = GIVEAWAYS[job.keyword]?.messages;
  if (!messages || clock() - job.at > MESSAGE_WINDOW) {
    const why = messages ? "too late: a DM may follow theirs for 24 hours" : "this keyword has no giveaway any more";
    settleDelivery(job.id, "failed", { error: why });
    void alert("too late", `a ${job.keyword} giveaway wasn't sent (${why}). The person can ask again.`);
    return `failed: ${why} (${job.keyword})`;
  }
  try {
    for (const text of messages) await sendMessage({ id: job.userId }, { text });
  } catch (e) {
    const doing = `couldn't send the ${job.keyword} giveaway to someone who asked for it`;
    const { strike, dueAt } = setback(e, job, giveaways, doing);
    // A strike ends a giveaway: refused, the person can't be messaged; unanswered, it may have arrived,
    // and nothing at Instagram would stop a second copy. Either way they can ask again.
    const givenUp = strike || job.attempts >= MAX_ATTEMPTS;
    const unsure = e instanceof GraphError && e.maybeSent ? " (it may have arrived, so it isn't sent again)" : "";
    settleDelivery(job.id, givenUp ? "failed" : "waiting", { error: describe(e) + unsure, dueAt });
    if (unsure) void alert("unsure", `${doing}: ${describe(e)}. It may have arrived, so it isn't sent again; the person can ask again.`);
    return `${givenUp ? "failed" : "waiting"}: ${describe(e)}${unsure}`;
  }
  settleDelivery(job.id, "sent");
  got(giveaways);
  return `giveaway sent: ${job.keyword} (${job.via})`;
}

/** Resolves when no send is in flight. */
export function idle(): Promise<void> {
  return flying.size === 0 ? Promise.resolve() : new Promise((resolve) => idlers.push(resolve));
}

/**
 * For a shutdown: no new send starts, and the promise resolves when the ones
 * in flight have ended. Whatever is still in line stays in the database for
 * the next start.
 */
export function stopQueue(): Promise<void> {
  stopped = true;
  for (const key of [...listeners.keys()]) if (!flying.has(key)) tell(key, "waiting: the bot is restarting");
  return idle();
}

/** For /admin/stats: what's in line, how close the bot is to the hourly limit, and which gates are shut. */
export function queueState(now = clock()) {
  const held = (g: Gate) => (now < g.until ? `${g.because}, until ${new Date(g.until).toISOString()}` : "no");
  return {
    inLine: inLine(),
    sending: flying.size,
    privateRepliesLastHour: callsSince("private_reply", now - HOUR),
    privateRepliesPerHour: config.privateRepliesPerHour,
    paused: held(everything),
    teasersPaused: held(teasers.gate),
    giveawaysPaused: held(giveaways.gate),
  };
}

/** A clean start for a test: every gate open, the real time. */
export function resetQueue(): void {
  for (const g of [everything, teasers.gate, giveaways.gate]) Object.assign(g, gate());
  teasers.refused = giveaways.refused = 0;
  publicRepliesFrom = 0;
  overLimitSaid = false;
  stopped = false;
  ahead = 0;
}
