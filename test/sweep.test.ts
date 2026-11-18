import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { DAY, HOUR, MINUTE, SECOND } from "../src/config.ts";
import { closeDb, kvGet, kvSet, openDb, stats } from "../src/db.ts";
import { idle, resetQueue } from "../src/instagram/queue.ts";
import { backfill, sweep, sweepOnTimer } from "../src/instagram/sweep.ts";
import { runQueue } from "./events.ts";
import { type Call, igTime, isPrivateReply, startMockGraph } from "./mock-graph.ts";

/** The sweep on a busy post: how much of it is read each time, and that nothing is missed or answered twice. */

const mock = await startMockGraph();
process.env.IG_GRAPH_BASE = mock.base;
delete process.env.TELEGRAM_BOT_TOKEN;
after(() => mock.close());

const SETTINGS = ["SEND_CONCURRENCY", "PRIVATE_REPLIES_PER_HOUR", "PUBLIC_REPLIES"];
let now = 0;

beforeEach(() => {
  closeDb();
  openDb(":memory:");
  resetQueue();
  mock.reset();
  process.env.IG_ACCESS_TOKEN = "seed-token";
  for (const name of SETTINGS) delete process.env[name];
  now = Date.now();
  kvSet("sweep_since", String(now - 5 * HOUR));
  kvSet("private_reply_buttons", "yes");
  kvSet("own_id", "OWNER-IG");
  kvSet("own_username", "yourbrand");
});
afterEach(() => idle());

type Listed = { id: string; text: string; timestamp: string; from: { id: string; username: string }; replies?: { data: Listed[] } };

const listed = (id: string, at: number, text = "KEY"): Listed => ({ id, text, timestamp: igTime(at), from: { id: `U-${id}`, username: `user-${id}` } });

/** Post M7 with `total` keyword comments, as Instagram lists them: newest first. The newest was made now, each one before it `gap` earlier. */
function busyPost(total: number, gap = MINUTE): Listed[] {
  const comments = Array.from({ length: total }, (_, i) => listed(`c${total - 1 - i}`, now - i * gap));
  mock.state.media = [{ id: "M7", caption: "Comment KEY and I'll send you the prompt.", timestamp: igTime(now - DAY), comments_count: total }];
  mock.state.comments.M7 = comments;
  return comments;
}

const pagesRead = (mediaId = "M7") => mock.calls.filter((c: Call) => c.method === "GET" && c.path === `/${mediaId}/comments`).length;
const count = (results: string[], start: string) => results.filter((r) => r.startsWith(start)).length;
const sentCount = () => (stats().comments as { status: string; count: number }[]).find((row) => row.status === "sent")?.count ?? 0;

describe("the sweep on a busy post", () => {
  it("reads the whole post the first time, and after that only the top of it", async () => {
    busyPost(230);
    const first = await sweep(now);
    assert.equal(count(first, "teaser sent: KEY to @user-c"), 230);
    assert.equal(pagesRead(), 5, "230 comments are five pages of 50");

    mock.clear();
    assert.deepEqual(await sweep(now + 10 * MINUTE), []);
    assert.equal(pagesRead(), 1, "nothing new: one page");
    assert.equal(mock.calls.filter(isPrivateReply).length, 0);
  });

  it("finds a hundred new comments by reading just those, and answers nobody twice", async () => {
    const before = busyPost(230);
    await sweep(now);
    // In the next ten minutes 120 more people comment.
    const fresh = Array.from({ length: 120 }, (_, i) => listed(`n${119 - i}`, now + 10 * MINUTE - i * 4 * SECOND, "key please"));
    mock.state.comments.M7 = [...fresh, ...before];

    mock.clear();
    const second = await sweep(now + 10 * MINUTE);
    assert.equal(count(second, "teaser sent: KEY to @user-n"), 120);
    assert.equal(second.length, 120);
    assert.equal(pagesRead(), 3, "two pages of new comments, and the page that reaches the ones read before");
    assert.equal(new Set(mock.privateReplies()).size, 350);
    assert.equal(mock.privateReplies().length, 350);
  });

  it("reads the whole post again once an hour, which finds a keyword in an older thread", async () => {
    const comments = busyPost(230);
    await sweep(now);
    // Someone answers a comment three pages down with the keyword.
    comments[170].replies = { data: [{ ...listed("deep", now + 5 * MINUTE), from: { id: "U-dora", username: "dora" } }] };

    mock.clear();
    assert.deepEqual(await sweep(now + 10 * MINUTE), [], "the top of the list doesn't show it");
    assert.equal(pagesRead(), 1);

    mock.clear();
    assert.deepEqual(await sweep(now + 61 * MINUTE), ["teaser sent: KEY to @dora"]);
    assert.equal(pagesRead(), 5);
    assert.equal(mock.replies()[0].path, `/${comments[170].id}/replies`, "the public reply goes under the thread's first comment");

    mock.clear();
    await sweep(now + 71 * MINUTE);
    assert.equal(pagesRead(), 1, "and then it's back to the top only, for another hour");
  });

  it("keeps what it read when a page fails, reads the other posts, and starts that post over next time", async () => {
    busyPost(230);
    mock.state.media.push({ id: "M8", caption: "Comment KEY for the prompt", timestamp: igTime(now - DAY), comments_count: 3 });
    mock.state.comments.M8 = [listed("m2", now - MINUTE), listed("m1", now - 2 * MINUTE), listed("m0", now - 3 * MINUTE)];
    const thirdPage = (c: Call) => c.path === "/M7/comments" && c.query.get("after") === "100";
    mock.state.faults.push({ when: thirdPage, status: 400, error: { code: 100, message: "Invalid parameter" } });

    await assert.rejects(sweep(now), /Invalid parameter/);
    assert.equal(sentCount(), 103, "the 100 comments on the two pages it read, and the other post's 3");
    assert.equal(kvGet("swept M7"), undefined, "the failed read isn't remembered as done");

    mock.state.faults = [];
    mock.clear();
    const second = await sweep(now + 10 * MINUTE);
    assert.equal(count(second, "teaser sent"), 130);
    assert.equal(pagesRead(), 5, "the whole post again");
    assert.equal(pagesRead("M8"), 1);
    assert.equal(new Set(mock.privateReplies()).size, 233);
  });

  it("previews and backfills a post of any length", async () => {
    busyPost(230);
    const preview = await backfill(7, new Set(["user-c0", "user-c1"]), false);
    assert.equal(preview.count, 228);
    assert.equal(pagesRead(), 5);
    assert.equal(mock.calls.filter(isPrivateReply).length, 0, "a preview sends nothing");

    process.env.PRIVATE_REPLIES_PER_HOUR = "200";
    const sent = await backfill(7, new Set(["user-c0", "user-c1"]), true);
    assert.ok(sent.mode === "sent");
    assert.equal(sent.results.filter((r) => r.result.startsWith("teaser sent")).length, 200);
    assert.equal(sent.results.filter((r) => r.result === "waiting: the hourly limit on private replies is reached").length, 28);
    await runQueue(now + 61 * MINUTE);
    assert.equal(sentCount(), 228, "the rest went out an hour later, without another backfill");
  });

  it("doesn't wait for the sends when the timer runs it, so a slow Instagram can't make the next sweep miss its turn", async () => {
    busyPost(40);
    await sweep(now - 30 * MINUTE); // the post has been read before
    mock.state.comments.M7.unshift(...Array.from({ length: 12 }, (_, i) => listed(`late${i}`, now - i * SECOND)));
    mock.clear();
    mock.state.delayMs = 30;
    await sweepOnTimer(now);
    assert.ok(mock.calls.filter(isPrivateReply).length <= 4, "the reading is done while the first sends are still on their way");
    await sweepOnTimer(now + SECOND); // a second sweep isn't turned away as 'still running'
    assert.equal(pagesRead(), 2);
    await idle();
    assert.equal(sentCount(), 40 + 12);
    assert.equal(new Set(mock.privateReplies()).size, 52);
  });

  it("stops reading a post at 20,000 comments and remembers that it did", async () => {
    // 20,040 comments nobody needs an answer to, so only the reading is at work here.
    const comments = Array.from({ length: 20_040 }, (_, i) => listed(`x${i}`, now - i * MINUTE, "nice one"));
    mock.state.media = [{ id: "M7", caption: "Comment KEY and I'll send you the prompt.", timestamp: igTime(now - DAY), comments_count: comments.length }];
    mock.state.comments.M7 = comments;
    assert.deepEqual(await sweep(now), []);
    assert.equal(pagesRead(), 400);

    mock.clear();
    assert.deepEqual(await sweep(now + 10 * MINUTE), []);
    assert.equal(pagesRead(), 1, "the next sweep is back to the top only, not another 400 pages");
  });

  it("answers all 3,000 comments of a post over the hours, 700 an hour, each once", async () => {
    process.env.PUBLIC_REPLIES = "off";
    busyPost(3000, 2 * SECOND);
    const first = await sweep(now);
    assert.equal(pagesRead(), 60);
    assert.equal(count(first, "teaser sent"), 700);
    assert.equal(count(first, "waiting: the hourly limit on private replies is reached"), 2300);

    for (let hour = 1; hour <= 4; hour++) {
      const then = now + hour * 61 * MINUTE;
      await runQueue(then);
      assert.equal(sentCount(), Math.min(3000, 700 * (hour + 1)), `after ${hour} h`);
      assert.deepEqual(await sweep(then), [], "the sweep finds nothing to add: they're all in line already");
    }
    assert.equal(mock.privateReplies().length, 3000);
    assert.equal(mock.calls.filter(isPrivateReply).length, 3000, "3,000 private replies for 3,000 comments");
    assert.ok(mock.peak() <= 5, `four sends and the sweep's own read at most, saw ${mock.peak()}`);
  });
});
