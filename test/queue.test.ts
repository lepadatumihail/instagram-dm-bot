import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { HOUR, MINUTE, SECOND } from "../src/config.ts";
import { claimComments, claimDeliveries, closeDb, commentStatus, kvGet, kvSet, openDb, queueComment, queueDelivery, stats } from "../src/db.ts";
import { handleWebhook } from "../src/instagram/bot.ts";
import { GIVEAWAYS } from "../src/instagram/giveaways.ts";
import { idle, pump, queueState, requeue, resetQueue, stopQueue } from "../src/instagram/queue.ts";
import { sweep } from "../src/instagram/sweep.ts";
import { comment, dm, runQueue, tap, until } from "./events.ts";
import { type Call, igTime, isDm, isPrivateReply, startMockGraph } from "./mock-graph.ts";

/**
 * The bot under load and when Instagram misbehaves: a burst of comments, a
 * failure that passes, Meta's rate limit, the same webhook twice, a comment
 * Meta refuses, a restart. Time is moved by hand (runQueue(later)), so the
 * tests don't wait out a retry or an hour.
 */

const mock = await startMockGraph();
process.env.IG_GRAPH_BASE = mock.base;
delete process.env.TELEGRAM_BOT_TOKEN;
after(() => mock.close());

mock.state.captions.M1 = "Comment GUIDE and I'll send you the guide 👇";

const SETTINGS = ["SEND_CONCURRENCY", "PRIVATE_REPLIES_PER_HOUR", "PUBLIC_REPLIES_PER_HOUR", "PUBLIC_REPLIES", "IG_GRAPH_TIMEOUT_MS"];

beforeEach(() => {
  closeDb();
  openDb(":memory:");
  resetQueue();
  mock.reset();
  process.env.IG_ACCESS_TOKEN = "seed-token";
  for (const name of SETTINGS) delete process.env[name];
  // As on the live bot, which has long known that private replies take the button.
  kvSet("private_reply_buttons", "yes");
});
afterEach(() => idle());

const from = (i: number | string) => ({ id: `U${i}`, username: `user${i}` });
const guide = (id: string, i: number | string = id) => comment(id, "guide", from(i));
const privateReplies = () => mock.calls.filter(isPrivateReply);
const repliesTo = (commentId: string) => privateReplies().filter((c) => c.body.recipient.comment_id === commentId);
const count = (results: string[], start: string) => results.filter((r) => r.startsWith(start)).length;
const forComment = (commentId: string) => (c: Call) => isPrivateReply(c) && c.body.recipient.comment_id === commentId;
/** How many comments stand at each status, and how many giveaways. */
const byStatus = () => Object.fromEntries((stats().comments as { status: string; count: number }[]).map((row) => [row.status, row.count]));
const giveaways = () => Object.fromEntries((stats().deliveries as { status: string; count: number }[]).map((row) => [row.status, row.count]));
const INSTAGRAM_FAILS = { status: 500, error: { code: 2, message: "An unexpected error has occurred. Please retry your request later." } };

describe("a burst of comments", () => {
  it("answers 200 that arrive together, each exactly once, four at a time", async () => {
    mock.state.delayMs = 3;
    const ids = Array.from({ length: 200 }, (_, i) => `B${i}`);
    // 100 arrive as a webhook each; 100 in a single webhook, as Meta batches under load; and Meta sends 20 of them twice.
    const single = ids.slice(0, 100).map((id, i) => guide(id, i));
    const batch = { object: "instagram", entry: ids.slice(100).map((id, i) => guide(id, 100 + i).entry[0]) };
    const twice = ids.slice(0, 20).map((id, i) => guide(id, i));

    const results = (await Promise.all([...single, batch, ...twice].map((payload) => handleWebhook(payload)))).flat();

    assert.equal(count(results, "teaser sent: GUIDE to @user"), 200);
    assert.equal(count(results, "skipped: already in line"), 20);
    assert.equal(results.length, 220);

    assert.deepEqual(mock.privateReplies().sort(), [...ids].sort(), "every comment got its private reply");
    assert.equal(privateReplies().length, 200, "and no comment got a second one");
    assert.deepEqual(
      mock
        .replies()
        .map((c) => c.path)
        .sort(),
      ids.map((id) => `/${id}/replies`).sort(),
      "one public reply under each",
    );
    assert.deepEqual(byStatus(), { sent: 200 });

    assert.ok(mock.peak() <= 4, `at most 4 calls at a time, saw ${mock.peak()}`);
    assert.ok(mock.peak() >= 3, `the sends do overlap, saw ${mock.peak()} at a time`);
    assert.equal(mock.calls.filter((c) => c.method === "GET").length, 2, "one caption lookup and one account lookup for the whole burst");
  });

  it("goes one at a time with SEND_CONCURRENCY=1", async () => {
    process.env.SEND_CONCURRENCY = "1";
    mock.state.delayMs = 3;
    const results = (await Promise.all(Array.from({ length: 12 }, (_, i) => handleWebhook(guide(`S${i}`, i))))).flat();
    assert.equal(count(results, "teaser sent"), 12);
    assert.equal(mock.peak(), 1);
  });

  it("answers the oldest comment first", async () => {
    process.env.SEND_CONCURRENCY = "1";
    const now = Date.now();
    queueComment({ commentId: "new", mediaId: "M1", username: "c", keyword: "GUIDE", at: now - MINUTE });
    queueComment({ commentId: "old", mediaId: "M1", username: "a", keyword: "GUIDE", at: now - HOUR });
    queueComment({ commentId: "mid", mediaId: "M1", username: "b", keyword: "GUIDE", at: now - 10 * MINUTE });
    await runQueue();
    assert.deepEqual(mock.privateReplies(), ["old", "mid", "new"]);
  });
});

describe("a failure that passes", () => {
  it("Instagram fails inside (HTTP 500, code 2): the comment is tried again seconds later and answered once", async () => {
    mock.state.faults.push({ when: isPrivateReply, times: 1, ...INSTAGRAM_FAILS });
    const now = Date.now();
    const [first] = await handleWebhook(guide("T1"));
    assert.match(first, /^waiting: An unexpected error/);
    assert.equal(commentStatus("T1"), "waiting", "back in line, not failed");
    assert.equal(mock.replies().length, 0, "no public reply before the DM is out");

    assert.equal(pump(now + 4 * SECOND), 0, "everything waits a second, and this comment 5 more");
    await runQueue(now + 7 * SECOND);
    assert.equal(commentStatus("T1"), "sent");
    assert.equal(repliesTo("T1").length, 2, "the try that failed and the one that worked");
    assert.deepEqual(mock.privateReplies(), ["T1"]);
    assert.equal(mock.replies().length, 1);
  });

  // No word from Instagram's API itself: the private reply may have arrived. It is tried again, as
  // Instagram takes only one per comment, but later and not without end.
  const unanswered: [string, Parameters<typeof mock.state.faults.push>[0]][] = [
    ["something on the way answers 503", { when: isPrivateReply, times: 1, status: 503, raw: "<html>Service Unavailable</html>" }],
    ["the connection drops", { when: isPrivateReply, times: 1, drop: true }],
  ];
  for (const [name, fault] of unanswered) {
    it(`${name}: the comment is tried again ten minutes later and answered once`, async () => {
      mock.state.faults.push({ ...fault });
      const now = Date.now();
      const [first] = await handleWebhook(guide("T1"));
      assert.match(first, /^failed: (HTTP 503|no answer from Instagram)/);
      assert.equal(commentStatus("T1"), "waiting", "back in line, not given up");

      assert.equal(pump(now + 9 * MINUTE), 0);
      await runQueue(now + 11 * MINUTE);
      assert.equal(commentStatus("T1"), "sent");
      assert.equal(repliesTo("T1").length, 2);
      assert.deepEqual(mock.privateReplies(), ["T1"]);
      assert.equal(mock.replies().length, 1);
    });
  }

  it("keeps trying while Instagram stays down, further and further apart, and answers when it's back", async () => {
    mock.state.faults.push({ when: isPrivateReply, ...INSTAGRAM_FAILS });
    const now = Date.now();
    await handleWebhook(guide("T2"));
    // After each failure everything waits 1 s, 2 s, 4 s… up to a minute, and the comment 5 s, 15 s, 45 s… up to 10 minutes more.
    let at = now;
    for (const wait of [1 + 5, 2 + 15, 4 + 45, 8 + 135, 16 + 405, 32 + 600, 60 + 600]) {
      assert.equal(pump(at + (wait - 1) * SECOND), 0, `no try before ${wait} s are over`);
      at += (wait + 1) * SECOND;
      await runQueue(at);
    }
    assert.equal(repliesTo("T2").length, 8);
    assert.equal(commentStatus("T2"), "waiting", "eight failures in, it is still not given up");

    mock.state.faults = [];
    await runQueue(at + 12 * MINUTE);
    assert.equal(commentStatus("T2"), "sent");
    assert.deepEqual(mock.privateReplies(), ["T2"]);
  });

  it("doesn't let one comment that keeps failing hold up the others", async () => {
    mock.state.faults.push({ when: forComment("T3"), ...INSTAGRAM_FAILS });
    const now = Date.now();
    assert.match((await handleWebhook(guide("T3")))[0], /^waiting: /);
    // Two seconds on (the short pause after a failure is over), someone else comments.
    pump(now + 2 * SECOND);
    assert.deepEqual(await handleWebhook(guide("T4")), ["teaser sent: GUIDE to @userT4"]);
    assert.equal(repliesTo("T3").length, 1, "the failing one waits for its own turn");
  });

  it("holds everything back while Instagram is failing, then tests the water with one message", async () => {
    mock.state.faults.push({ when: isPrivateReply, ...INSTAGRAM_FAILS });
    const now = Date.now();
    const results = (await Promise.all(Array.from({ length: 30 }, (_, i) => handleWebhook(guide(`H${i}`, i))))).flat();
    assert.equal(count(results, "waiting: "), 30);
    assert.ok(privateReplies().length <= 4, `only the sends in flight failed, not all 30: ${privateReplies().length} calls`);

    const before = privateReplies().length;
    assert.equal(pump(now + 6 * SECOND), 1, "one message tries first");
    await idle();
    assert.equal(privateReplies().length, before + 1, "and when it fails too, the rest stay put");

    mock.state.faults = [];
    await runQueue(now + 20 * MINUTE);
    assert.equal(mock.privateReplies().length, 30, "all 30 are answered once Instagram is back");
    assert.deepEqual(byStatus(), { sent: 30 });
  });

  it("gives up waiting for an answer at the time limit, and Instagram's one-reply rule keeps the second try from doubling the DM", async () => {
    await handleWebhook(guide("T0")); // an ordinary comment first, so the caption and the account are looked up
    // Now Instagram takes a private reply but answers too late: the bot can't know it went out.
    process.env.IG_GRAPH_TIMEOUT_MS = "40";
    mock.state.delayMs = 150;
    const now = Date.now();
    const [first] = await handleWebhook(guide("T5"));
    assert.match(first, /^failed: no answer from Instagram \(0\.04 s passed\)/);
    await until(() => mock.privateReplies().length === 2);

    mock.state.delayMs = 0;
    await runQueue(now + 11 * MINUTE);
    await runQueue(now + 72 * MINUTE);
    assert.deepEqual(mock.privateReplies(), ["T0", "T5"], "the person got one DM");
    assert.equal(commentStatus("T5"), "failed", "the bot's record says failed: it never saw the first one arrive");
    await runQueue(now + 5 * HOUR);
    assert.equal(repliesTo("T5").length, 3, "the one that got no answer and two that Instagram refused, then no more");
  });

  it("tries a teaser that never gets an answer six times over four hours, then gives it up", async () => {
    mock.state.faults.push({ when: forComment("T6"), drop: true });
    const now = Date.now();
    await handleWebhook(guide("T6"));
    for (const minutes of [11, 72, 133, 194]) await runQueue(now + minutes * MINUTE);
    assert.equal(repliesTo("T6").length, 5);
    assert.equal(commentStatus("T6"), "waiting", "three hours without an answer, and it's still not given up");
    await runQueue(now + 255 * MINUTE);
    assert.equal(commentStatus("T6"), "failed");
    await runQueue(now + 24 * HOUR);
    assert.equal(repliesTo("T6").length, 6);
  });
});

describe("Meta's limit on private replies", () => {
  it("stops short of it and sends the rest as the hour moves on", async () => {
    process.env.PRIVATE_REPLIES_PER_HOUR = "5";
    const now = Date.now();
    const results = (await Promise.all(Array.from({ length: 8 }, (_, i) => handleWebhook(guide(`Q${i}`, i))))).flat();
    assert.equal(count(results, "teaser sent"), 5);
    assert.equal(count(results, "waiting: the hourly limit on private replies is reached"), 3);
    assert.equal(privateReplies().length, 5, "the sixth call is never made");
    assert.equal(queueState().privateRepliesLastHour, 5);
    assert.deepEqual(queueState().inLine, { comments: 3, deliveries: 0 });

    assert.equal(pump(now + 59 * MINUTE), 0, "still inside the same 60 minutes");
    await runQueue(now + 61 * MINUTE);
    assert.equal(mock.privateReplies().length, 8);
    assert.equal(privateReplies().length, 8);
    assert.deepEqual(byStatus(), { sent: 8 });
  });

  it("doesn't count giveaways toward it: a tap is answered while teasers wait", async () => {
    process.env.PRIVATE_REPLIES_PER_HOUR = "1";
    assert.deepEqual(await handleWebhook(guide("Q10")), ["teaser sent: GUIDE to @userQ10"]);
    assert.deepEqual(await handleWebhook(guide("Q11")), ["waiting: the hourly limit on private replies is reached"]);
    assert.deepEqual(await handleWebhook(tap("UQ10", "GUIDE")), ["giveaway sent: GUIDE (button)"]);
  });

  it("when Meta says slow down anyway, stops at once and answers the rest after the pause", async () => {
    mock.state.privateReplyLimit = 5;
    const now = Date.now();
    const ids = Array.from({ length: 12 }, (_, i) => `L${i}`);
    const results = (await Promise.all(ids.map((id, i) => handleWebhook(guide(id, i))))).flat();
    assert.equal(count(results, "teaser sent"), 5);
    assert.equal(count(results, "waiting: "), 7);
    assert.ok(privateReplies().length <= 5 + 4, `no call after the refusals already in flight: ${privateReplies().length} calls`);
    assert.match(queueState().teasersPaused, /^Instagram said to slow down, until /);
    assert.equal(queueState().paused, "no", "only teasers are held");

    // Two minutes on, Meta would take them again, but the bot keeps to its five-minute pause.
    mock.state.privateReplyLimit = Number.POSITIVE_INFINITY;
    const before = mock.calls.length;
    assert.equal(pump(now + 2 * MINUTE), 0);
    assert.equal(mock.calls.length, before, "nothing at all goes out during the pause");

    assert.equal(pump(now + 6 * MINUTE), 1, "after it, one message tests the water");
    await runQueue(now + 6 * MINUTE);
    // The comments Meta turned down wait five minutes more, so that others go first.
    await runQueue(now + 11 * MINUTE);
    assert.deepEqual(mock.privateReplies().sort(), [...ids].sort(), "all 12 are answered");
    assert.equal(mock.replies().length, 12);
    assert.ok(ids.every((id) => repliesTo(id).length <= 2));
    assert.deepEqual(byStatus(), { sent: 12 });
  });

  it("keeps sending giveaways while teasers are held: the people who tapped aren't kept waiting", async () => {
    mock.state.privateReplyLimit = 1;
    assert.deepEqual(await handleWebhook(guide("L10")), ["teaser sent: GUIDE to @userL10"]);
    assert.match((await handleWebhook(guide("L11")))[0], /^waiting: .*exceeded the rate limit/);
    assert.deepEqual(await handleWebhook(guide("L12")), ["waiting: Instagram said to slow down"]);
    assert.deepEqual(await handleWebhook(tap("UL10", "GUIDE", "a")), ["giveaway sent: GUIDE (button)"]);
    assert.deepEqual(await handleWebhook(dm("UL11", { mid: "b", text: "guide" })), ["giveaway sent: GUIDE (keyword)"]);
    assert.equal(privateReplies().length, 2, "and no teaser is tried into the limit meanwhile");
  });

  it("pauses for as long as Meta's usage header says", async () => {
    mock.state.privateReplyLimit = 0;
    mock.state.regainMinutes = 30;
    const now = Date.now();
    assert.match((await handleWebhook(guide("L20")))[0], /^waiting: .*exceeded the rate limit/);
    mock.state.privateReplyLimit = Number.POSITIVE_INFINITY;
    assert.match(queueState(now + 29 * MINUTE).teasersPaused, /^Instagram said to slow down/);
    assert.equal(queueState(now + 31 * MINUTE).teasersPaused, "no");
    await runQueue(now + 36 * MINUTE);
    assert.equal(commentStatus("L20"), "sent");
  });

  it("pauses longer each time Meta says slow down again", async () => {
    mock.state.privateReplyLimit = 0;
    const now = Date.now();
    await handleWebhook(guide("L30")); // refused: teasers are held 5 minutes, this comment 5 more
    await runQueue(now + 11 * MINUTE); // refused again: held 10 minutes now, this comment 15 more
    assert.equal(repliesTo("L30").length, 2);
    assert.match(queueState(now + 20 * MINUTE).teasersPaused, /^Instagram said to slow down/);
    assert.equal(queueState(now + 22 * MINUTE).teasersPaused, "no");
    await runQueue(now + 37 * MINUTE);
    assert.equal(repliesTo("L30").length, 3);
    assert.equal(commentStatus("L30"), "waiting", "however often Meta says slow down, the comment isn't given up");
  });

  it("holds giveaways and teasers apart: a limit on DMs doesn't keep comments waiting", async () => {
    mock.state.faults.push({ when: isDm, status: 400, error: { message: "Calls to this api have exceeded the rate limit.", code: 613, error_subcode: 2534040 } });
    assert.match((await handleWebhook(tap("U1", "GUIDE")))[0], /^waiting: .*exceeded the rate limit/);
    assert.deepEqual(await handleWebhook(tap("U2", "GUIDE")), ["waiting: Instagram said to slow down"]);
    assert.deepEqual(await handleWebhook(guide("L40")), ["teaser sent: GUIDE to @userL40"]);
    assert.match(queueState().giveawaysPaused, /^Instagram said to slow down/);
    assert.equal(queueState().teasersPaused, "no");
    assert.equal(mock.calls.filter(isDm).length, 1, "and no second giveaway is tried into the limit");
  });

  it("doesn't let one message Meta keeps answering 'slow down' hold up the rest for long", async () => {
    // One giveaway gets 368 every time (say, a link Meta's filter doesn't like). Everything else is fine.
    const blocked = (c: Call) => isDm(c) && c.body.recipient.id === "U-bad";
    mock.state.faults.push({ when: blocked, status: 400, error: { message: "The action attempted has been deemed abusive or is otherwise disallowed", code: 368 } });
    const now = Date.now();
    assert.match((await handleWebhook(tap("U-bad", "GUIDE")))[0], /^waiting: .*code 368/);
    assert.deepEqual(await handleWebhook(guide("L50")), ["teaser sent: GUIDE to @userL50"], "teasers aren't held at all");
    assert.deepEqual(await handleWebhook(tap("U-ok", "GUIDE")), ["waiting: Instagram said to slow down"]);

    // When the five minutes are over the other giveaway goes first, and gets through.
    await runQueue(now + 5 * MINUTE + SECOND);
    assert.equal(mock.sent().filter((c) => c.body.recipient.id === "U-ok").length, 1);
    assert.equal(mock.calls.filter(blocked).length, 1);

    // Over the next day the bad one is tried a handful of times, further and further apart, and then its time is up.
    for (let minute = 10; minute <= 26 * 60; minute += 5) await runQueue(now + minute * MINUTE);
    const tries = mock.calls.filter(blocked).length;
    assert.ok(tries >= 4 && tries <= 8, `${tries} tries in a day`);
    assert.deepEqual(giveaways(), { failed: 1, sent: 1 });
    assert.deepEqual(await handleWebhook(tap("U-late", "GUIDE")), ["giveaway sent: GUIDE (button)"]);
  });
});

describe("the same webhook twice", () => {
  it("sends once when Meta delivers a comment again while its first send is in flight, and the sweep finds it too", async () => {
    mock.state.delayMs = 40;
    const now = Date.now();
    const first = handleWebhook(guide("D1"));
    await until(() => privateReplies().length === 1);
    assert.equal(commentStatus("D1"), "sending");

    assert.deepEqual(await handleWebhook(guide("D1")), ["skipped: already in line"]);
    kvSet("sweep_since", String(now - HOUR));
    mock.state.media = [{ id: "M1", caption: mock.state.captions.M1, timestamp: igTime(now - HOUR), comments_count: 1 }];
    mock.state.comments.M1 = [{ id: "D1", text: "guide", timestamp: igTime(now - SECOND), from: from("D1") }];
    assert.deepEqual(await sweep(), []);

    assert.deepEqual(await first, ["teaser sent: GUIDE to @userD1"]);
    assert.deepEqual(await handleWebhook(guide("D1")), ["skipped: already answered"]);
    assert.equal(privateReplies().length, 1);
    assert.equal(mock.replies().length, 1);
    mock.state.media = [];
  });

  it("sends a giveaway once when Meta delivers the same tap again, even hours later", async () => {
    const now = Date.now();
    assert.deepEqual(await handleWebhook(tap("U1", "GUIDE", "tap-1")), ["giveaway sent: GUIDE (button)"]);
    pump(now + 3 * HOUR);
    assert.deepEqual(await handleWebhook(tap("U1", "GUIDE", "tap-1")), ["skipped: Meta delivered this message before"]);
    assert.deepEqual(await handleWebhook(tap("U1", "GUIDE", "tap-2")), ["giveaway sent: GUIDE (button)"], "a new tap is a new request");
    assert.equal(mock.calls.filter(isDm).length, 2);
  });

  it("doesn't take a second tap for a new request when Meta delivers it again after the double-tap guard has let go", async () => {
    const now = Date.now();
    assert.deepEqual(await handleWebhook(tap("U1", "GUIDE", "tap-1")), ["giveaway sent: GUIDE (button)"]);
    assert.deepEqual(await handleWebhook(tap("U1", "GUIDE", "tap-2")), ["skipped: already sent or on its way"], "a double tap");
    pump(now + 3 * MINUTE);
    assert.deepEqual(await handleWebhook(tap("U1", "GUIDE", "tap-2")), ["skipped: Meta delivered this message before"]);
    assert.equal(mock.calls.filter(isDm).length, 1);
  });
});

describe("a comment Meta refuses", () => {
  const INVALID = { status: 400, error: { message: "The comment is invalid for a private reply", code: 100, error_subcode: 2534025 } };

  it("gets three tries, ten minutes and then an hour apart, and then no more", async () => {
    mock.state.faults.push({ when: forComment("X1"), ...INVALID });
    const now = Date.now();
    const [first] = await handleWebhook(guide("X1"));
    assert.equal(first, "failed: The comment is invalid for a private reply (HTTP 400, code 100/2534025)");
    assert.equal(mock.replies().length, 0, "no public reply without a DM");
    assert.deepEqual(await handleWebhook(guide("X2")), ["teaser sent: GUIDE to @userX2"], "the next comment isn't held up");

    assert.equal(pump(now + 9 * MINUTE), 0);
    await runQueue(now + 11 * MINUTE);
    assert.equal(repliesTo("X1").length, 2);
    assert.equal(commentStatus("X1"), "waiting");
    assert.equal(pump(now + 70 * MINUTE), 0);
    await runQueue(now + 72 * MINUTE);
    assert.equal(repliesTo("X1").length, 3);
    assert.equal(commentStatus("X1"), "failed");

    // Given up: not after hours, not after days, not when the webhook comes again.
    await runQueue(now + 5 * HOUR);
    await runQueue(now + 100 * HOUR);
    assert.deepEqual(await handleWebhook(guide("X1")), ["skipped: already given up"]);
    await runQueue(now + 101 * HOUR);
    assert.equal(repliesTo("X1").length, 3);
    assert.deepEqual(byStatus(), { failed: 1, sent: 1 });
  });

  it("can be put back in line by hand once whatever was wrong is fixed", async () => {
    mock.state.faults.push({ when: forComment("X4"), ...INVALID });
    const now = Date.now();
    await handleWebhook(guide("X4"));
    await runQueue(now + 11 * MINUTE);
    await runQueue(now + 72 * MINUTE);
    assert.equal(commentStatus("X4"), "failed");

    const back = requeue(7);
    assert.deepEqual(
      back.map((r) => [r.commentId, r.username, r.keyword]),
      [["X4", "userX4", "GUIDE"]],
    );
    assert.match(back[0].error ?? "", /invalid for a private reply/);
    await idle();
    assert.equal(commentStatus("X4"), "waiting", "a clean slate: refused once more, it has two tries left");

    mock.state.faults = [];
    await runQueue(now + 72 * MINUTE + 11 * MINUTE);
    assert.equal(commentStatus("X4"), "sent");
    assert.deepEqual(requeue(7), [], "nothing left to put back");
  });

  it("stops and waits when Meta refuses one comment after another: that isn't about the comments", async () => {
    // The app has lost a permission: every private reply is refused with a code the bot doesn't know.
    const refused = { status: 400, error: { message: "Application does not have permission for this action", code: 10 } };
    mock.state.faults.push({ when: isPrivateReply, ...refused });
    const now = Date.now();
    const results = (await Promise.all(Array.from({ length: 40 }, (_, i) => handleWebhook(guide(`P${i}`, i))))).flat();
    assert.equal(count(results, "failed: Application does not have permission"), 9, "the first nine look like refusals of those comments");
    assert.equal(count(results, "waiting: "), 31, "from the tenth on, the bot holds the teasers instead");
    assert.ok(privateReplies().length <= 9 + 4, `${privateReplies().length} calls, not three for each of the 40`);
    assert.match(queueState().teasersPaused, /^Instagram is refusing every message/);

    // Twenty minutes later the permission is back. Nobody was given up.
    for (let minute = 6; minute <= 20; minute += 2) await runQueue(now + minute * MINUTE);
    assert.equal(byStatus().failed, undefined);
    mock.state.faults = [];
    for (let minute = 22; minute <= 100; minute += 2) await runQueue(now + minute * MINUTE);
    assert.deepEqual(byStatus(), { sent: 40 });
    assert.equal(mock.privateReplies().length, 40);
  });

  it("isn't fooled for long when the refused comments really are the trouble: the others go out, the refused are given up", async () => {
    // Twelve comments in a row that can't take a private reply (a spam wave whose accounts are gone), then real people.
    mock.state.faults.push({ when: (c) => isPrivateReply(c) && c.body.recipient.comment_id.startsWith("S"), ...INVALID });
    const now = Date.now();
    await Promise.all(Array.from({ length: 12 }, (_, i) => handleWebhook(guide(`S${i}`, i))));
    assert.match(queueState().teasersPaused, /^Instagram is refusing every message/, "ten first tries refused in a row: it holds the teasers");

    const real = (await Promise.all(Array.from({ length: 20 }, (_, i) => handleWebhook(guide(`R${i}`, 100 + i))))).flat();
    assert.equal(count(real, "waiting: Instagram is refusing every message"), 20);
    await runQueue(now + 5 * MINUTE + SECOND);
    assert.equal(mock.privateReplies().length, 20, "five minutes later a real comment goes first, gets through, and the rest follow");

    for (let minute = 10; minute <= 200; minute += 5) await runQueue(now + minute * MINUTE);
    assert.deepEqual(byStatus(), { failed: 12, sent: 20 });
    assert.equal(queueState(now + 200 * MINUTE).teasersPaused, "no");
    assert.ok(privateReplies().length <= 20 + 12 * 3 + 4, `${privateReplies().length} calls`);
  });

  it("isn't tried at all once the 7 days for a private reply are over", async () => {
    const now = Date.now();
    queueComment({ commentId: "X3", mediaId: "M1", username: "late", keyword: "GUIDE", at: now - 7 * 24 * HOUR });
    await runQueue(now);
    assert.equal(commentStatus("X3"), "failed");
    assert.equal(privateReplies().length, 0);
  });

  it("doesn't try a refused giveaway again, and the person can still ask again", async () => {
    mock.state.faults.push({ when: isDm, times: 1, status: 400, error: { message: "This person isn't available right now.", code: 551, error_subcode: 1545041 } });
    const now = Date.now();
    assert.match((await handleWebhook(tap("U1", "GUIDE", "a")))[0], /^failed: This person isn't available right now/);
    await runQueue(now + HOUR);
    assert.equal(mock.calls.filter(isDm).length, 1);
    assert.deepEqual(await handleWebhook(dm("U1", { mid: "b", text: "guide" })), ["giveaway sent: GUIDE (keyword)"]);
  });
});

describe("giveaways", () => {
  it("tries a giveaway again when Instagram says it failed, and sends it once", async () => {
    mock.state.faults.push({ when: isDm, times: 1, ...INSTAGRAM_FAILS });
    const now = Date.now();
    assert.match((await handleWebhook(tap("U1", "GUIDE")))[0], /^waiting: /);
    assert.deepEqual(await handleWebhook(tap("U1", "GUIDE")), ["skipped: already sent or on its way"], "tapping again while it's in line adds nothing");
    await runQueue(now + 7 * SECOND);
    assert.equal(mock.calls.filter(isDm).length, 2, "the try that failed and the one that worked");
    assert.deepEqual(giveaways(), { sent: 1 });
  });

  it("tries a giveaway again when the connection was never made", async () => {
    const now = Date.now();
    // A port nothing listens on: taken from the system, then given back.
    const closed = createServer().listen(0, "127.0.0.1");
    await once(closed, "listening");
    const port = (closed.address() as AddressInfo).port;
    await new Promise((resolve) => closed.close(resolve));
    process.env.IG_GRAPH_BASE = `http://127.0.0.1:${port}/v27.0`;
    try {
      assert.match((await handleWebhook(tap("U1", "GUIDE")))[0], /^waiting: no answer from Instagram \(connect ECONNREFUSED/);
    } finally {
      process.env.IG_GRAPH_BASE = mock.base;
    }
    await runQueue(now + 7 * SECOND);
    assert.equal(mock.calls.filter(isDm).length, 1);
    assert.deepEqual(giveaways(), { sent: 1 });
  });

  it("never sends a giveaway again on a guess: with no answer it may have arrived, and the person can ask again", async () => {
    mock.state.faults.push({ when: isDm, times: 1, drop: true });
    const now = Date.now();
    const [first] = await handleWebhook(tap("U1", "GUIDE"));
    assert.match(first, /^failed: no answer from Instagram .* \(it may have arrived, so it isn't sent again\)$/);
    await runQueue(now + MINUTE);
    await runQueue(now + 3 * HOUR);
    assert.equal(mock.calls.filter(isDm).length, 1, "not tried a second time");
    assert.deepEqual(giveaways(), { failed: 1 });

    assert.deepEqual(await handleWebhook(dm("U1", { text: "guide" })), ["giveaway sent: GUIDE (keyword)"]);
  });

  it("doesn't send a giveaway again that a killed process left half-way", async () => {
    const now = Date.now();
    queueDelivery("U1", "GUIDE", "button", now);
    assert.equal(claimDeliveries(1, now).length, 1); // a process took it for sending, and died
    await runQueue(now + 3 * MINUTE);
    assert.equal(mock.calls.filter(isDm).length, 0);
    assert.deepEqual(giveaways(), { failed: 1 });
    assert.deepEqual(await handleWebhook(tap("U1", "GUIDE")), ["giveaway sent: GUIDE (button)"], "asking again works");
  });

  it("tests the water with a teaser rather than a giveaway after Instagram gave no answer", async () => {
    await handleWebhook(guide("W0")); // so the caption and the account are looked up
    mock.state.faults.push({ when: isPrivateReply, times: 1, drop: true });
    const now = Date.now();
    await handleWebhook(guide("W1")); // no answer: everything waits a second
    const [tapped, commented] = await Promise.all([handleWebhook(tap("U1", "GUIDE")), handleWebhook(guide("W2"))]);
    assert.deepEqual([tapped[0], commented[0]], ["waiting: Instagram is failing", "waiting: Instagram is failing"]);
    mock.clear();
    await runQueue(now + 2 * SECOND);
    assert.deepEqual(
      mock.sent().map((c) => (isDm(c) ? "giveaway" : "teaser")),
      ["teaser", "giveaway"],
      "the teaser went first; once it was through, the giveaway followed",
    );
  });

  it("sends one person's giveaways one at a time and in the order asked, while other people's go alongside", async () => {
    mock.state.delayMs = 15;
    const results = (
      await Promise.all([
        handleWebhook(tap("U1", "GUIDE", "a")),
        handleWebhook(dm("U1", { mid: "b", text: "key" })),
        handleWebhook(dm("U1", { mid: "c", text: "TEST" })),
        handleWebhook(tap("U2", "KEY", "d")),
        handleWebhook(tap("U3", "KEY", "e")),
      ])
    ).flat();
    assert.equal(count(results, "giveaway sent"), 5);

    const toU1 = mock.sent().filter((c) => c.body.recipient.id === "U1");
    assert.deepEqual(
      toU1.map((c) => c.body.message.text),
      [GIVEAWAYS.GUIDE.messages[0], GIVEAWAYS.KEY.messages[0], GIVEAWAYS.TEST.messages[0]],
    );
    for (let i = 1; i < toU1.length; i++) {
      assert.ok((toU1[i - 1].done ?? Infinity) <= toU1[i].at, "the next one starts only when the one before is out");
    }
    assert.ok(mock.peak() >= 2, "U2's and U3's went out alongside");
  });

  it("answers a tap before the teasers in line", async () => {
    process.env.SEND_CONCURRENCY = "1";
    await handleWebhook(guide("G")); // so the caption and the account are looked up
    mock.state.delayMs = 10;
    const comments = Promise.all(Array.from({ length: 5 }, (_, i) => handleWebhook(guide(`G${i}`, i))));
    await until(() => privateReplies().length === 2); // G0 is on its way, G1 to G4 are in line
    await Promise.all([comments, handleWebhook(tap("U9", "GUIDE", "a"))]);

    const order = mock.sent().map((c) => (isDm(c) ? "giveaway" : "teaser"));
    assert.equal(order.length, 7);
    assert.ok(order.indexOf("giveaway") <= 3, `the giveaway goes as soon as a send ends, ahead of the teasers in line: ${order.join(", ")}`);
  });
});

describe("public replies", () => {
  it("rests them for an hour when Instagram says slow down, while the DMs carry on", async () => {
    mock.state.rejectPublicReplies = true;
    const now = Date.now();
    assert.match((await handleWebhook(guide("R1")))[0], /^teaser sent: GUIDE to @userR1 \(no public reply: Comment replies are limited/);
    assert.deepEqual(await handleWebhook(guide("R2")), ["teaser sent: GUIDE to @userR2 (no public reply: Instagram said to slow down)"]);
    assert.equal(mock.replies().length, 1, "the one Instagram refused, and no second try into the block");
    assert.deepEqual(mock.privateReplies(), ["R1", "R2"]);

    mock.state.rejectPublicReplies = false;
    pump(now + 61 * MINUTE);
    assert.deepEqual(await handleWebhook(guide("R3")), ["teaser sent: GUIDE to @userR3"]);
    assert.equal(mock.replies().length, 2);
  });

  it("can be capped per hour with PUBLIC_REPLIES_PER_HOUR; past it the DM still goes out", async () => {
    process.env.PUBLIC_REPLIES_PER_HOUR = "3";
    const now = Date.now();
    const results = (await Promise.all(Array.from({ length: 6 }, (_, i) => handleWebhook(guide(`R1${i}`, i))))).flat();
    assert.equal(count(results, "teaser sent"), 6);
    assert.equal(results.filter((r) => r.endsWith("(no public reply: PUBLIC_REPLIES_PER_HOUR is reached)")).length, 3);
    assert.equal(mock.replies().length, 3);

    pump(now + 61 * MINUTE);
    assert.deepEqual(await handleWebhook(guide("R20")), ["teaser sent: GUIDE to @userR20"]);
    assert.equal(mock.replies().length, 4);
  });
});

describe("a restart", () => {
  it("lets the sends in flight finish, keeps the rest in line, and the next start sends them", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "instagram-dm-bot-")), "bot.db");
    closeDb();
    openDb(file);
    kvSet("private_reply_buttons", "yes");
    mock.state.delayMs = 30;
    const ids = Array.from({ length: 10 }, (_, i) => `Z${i}`);
    const arriving = Promise.all(ids.map((id, i) => handleWebhook(guide(id, i))));
    await until(() => privateReplies().length >= 1);

    // SIGTERM: no new send starts, the ones in flight end properly.
    await stopQueue();
    const results = (await arriving).flat();
    const sentBefore = mock.privateReplies().length;
    assert.ok(sentBefore >= 1 && sentBefore <= 4, `${sentBefore} were in flight and finished`);
    assert.equal(count(results, "teaser sent"), sentBefore);
    assert.equal(count(results, "waiting: the bot is restarting"), 10 - sentBefore);
    assert.equal(mock.replies().length, sentBefore, "each finished send has its public reply too");
    assert.deepEqual(await handleWebhook(guide("Z10", 10)), ["waiting: the bot is restarting"], "a webhook that still gets in is kept");

    // The process ends; a new one opens the same file.
    closeDb();
    resetQueue();
    openDb(file);
    mock.state.delayMs = 0;
    await runQueue();
    assert.deepEqual(mock.privateReplies().sort(), [...ids, "Z10"].sort());
    assert.equal(privateReplies().length, 11, "nobody got a second one");
    assert.deepEqual(byStatus(), { sent: 11 });
  });

  it("takes up a send again that a killed process left half-way, two minutes later", async () => {
    const now = Date.now();
    queueComment({ commentId: "K1", mediaId: "M1", username: "ann", keyword: "GUIDE" }, now);
    assert.equal(claimComments(1, now).length, 1); // a process took it for sending, and died
    assert.equal(commentStatus("K1"), "sending");

    assert.equal(pump(now + MINUTE), 0, "for two minutes it might still be on its way");
    await runQueue(now + 2 * MINUTE + SECOND);
    assert.equal(commentStatus("K1"), "sent");
    assert.deepEqual(mock.privateReplies(), ["K1"]);
  });
});

describe("the database file from before the queue", () => {
  // The tables as deployed on 17 November 2026 (commit eb6eb4d), which is what the live file looks like.
  const BEFORE = `
    PRAGMA journal_mode = WAL;
    CREATE TABLE comments (
      comment_id TEXT PRIMARY KEY, media_id TEXT NOT NULL, username TEXT NOT NULL, keyword TEXT NOT NULL,
      status TEXT NOT NULL, attempts INTEGER NOT NULL, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, keyword TEXT NOT NULL, via TEXT NOT NULL,
      status TEXT NOT NULL, error TEXT, created_at INTEGER NOT NULL
    );
    CREATE INDEX deliveries_by_user ON deliveries (user_id, keyword, created_at);
    CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `;

  it("opens as it is, keeps what the bot knew, and works as the queue from then on", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "instagram-dm-bot-")), "bot.db");
    const now = Date.now();
    const before = new DatabaseSync(file);
    before.exec(BEFORE);
    const addComment = before.prepare(
      "INSERT INTO comments (comment_id, media_id, username, keyword, status, attempts, error, created_at, updated_at) VALUES (?, 'M1', ?, 'GUIDE', ?, ?, ?, ?, ?)",
    );
    addComment.run("answered", "ann", "sent", 1, null, now - HOUR, now - HOUR);
    addComment.run("given-up", "bob", "failed", 3, "The comment is invalid for a private reply", now - HOUR, now - HOUR);
    addComment.run("failed-once", "cat", "failed", 1, "Invalid parameter", now - HOUR, now - HOUR);
    addComment.run("cut-off", "dan", "sending", 1, null, now - MINUTE, now - MINUTE); // the old process was killed mid-send
    const addDelivery = before.prepare("INSERT INTO deliveries (user_id, keyword, via, status, error, created_at) VALUES (?, 'GUIDE', 'button', ?, null, ?)");
    addDelivery.run("U-ann", "sent", now - MINUTE);
    addDelivery.run("U-old", "sending", now - 30 * HOUR); // cut off more than a day ago: too late to send now
    before.prepare("INSERT INTO kv (key, value) VALUES ('private_reply_buttons', 'yes'), ('sweep_since', '123'), ('own_id', 'OWNER-IG'), ('own_username', 'yourbrand')").run();
    before.close();

    closeDb();
    openDb(file);
    assert.equal(kvGet("sweep_since"), "123");
    assert.equal(kvGet("private_reply_buttons"), "yes");

    await runQueue(now);
    assert.equal(commentStatus("cut-off"), "sent", "the send that was cut off is taken up");
    assert.deepEqual(mock.privateReplies(), ["cut-off"], "and nothing else from the past is sent");
    assert.equal(mock.calls.filter(isDm).length, 0);
    assert.deepEqual(giveaways(), { failed: 1, sent: 1 });

    assert.deepEqual(await handleWebhook(guide("answered")), ["skipped: already answered"]);
    assert.deepEqual(await handleWebhook(guide("given-up")), ["skipped: already given up"]);
    assert.deepEqual(await handleWebhook(guide("failed-once")), ["skipped: already given up"], "failed rows from before stay failed");
    assert.deepEqual(await handleWebhook(tap("U-ann", "GUIDE", "a")), ["skipped: already sent or on its way"], "the double-tap guard reads the old rows");

    assert.deepEqual(await handleWebhook(guide("new")), ["teaser sent: GUIDE to @usernew"]);
    assert.deepEqual(await handleWebhook(tap("U-new", "GUIDE", "b")), ["giveaway sent: GUIDE (button)"]);
    assert.equal(mock.calls.filter((c) => c.method === "GET").length, 0, "the account it had asked for before is still known");

    // The next start opens the same file again: nothing to upgrade, nothing changed.
    const counts = JSON.stringify(stats());
    closeDb();
    openDb(file);
    assert.equal(JSON.stringify(stats()), counts);
  });
});
