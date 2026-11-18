import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { closeDb, openDb } from "../src/db.ts";
import { describe as describeError, failureKind, getCaption, GraphError, listMedia, sendMessage } from "../src/instagram/graph.ts";
import { type Call, startMockGraph } from "./mock-graph.ts";

const mock = await startMockGraph();
process.env.IG_GRAPH_BASE = mock.base;
after(() => mock.close());

mock.state.captions.M1 = "Comment GUIDE and I'll send you the repo";

beforeEach(() => {
  closeDb();
  openDb(":memory:");
  mock.reset();
  process.env.IG_ACCESS_TOKEN = "seed-token";
  delete process.env.IG_GRAPH_TIMEOUT_MS;
});

const reads = (c: Call) => c.method === "GET";
const sends = (c: Call) => c.method === "POST";
const failure = (run: Promise<unknown>) =>
  run.then(
    () => assert.fail("the call should have failed"),
    (e: unknown) => e as GraphError,
  );

describe("what a failure means", () => {
  const kind = (status: number, code?: number, subcode?: number) => failureKind(new GraphError("x", status, code, subcode));

  it("no answer, or Instagram failing inside: try again", () => {
    assert.equal(kind(0), "retry");
    assert.equal(kind(500), "retry");
    assert.equal(kind(503, 2), "retry");
    assert.equal(kind(400, 1), "retry");
    assert.equal(kind(400, 2, 2018344), "retry");
    const flagged = new GraphError("flagged by Meta", 400, 100);
    flagged.transient = true;
    assert.equal(failureKind(flagged), "retry");
  });

  it("a rate limit or a temporary block: slow down", () => {
    for (const code of [4, 9, 17, 32, 341, 368, 613, 80001, 80002, 80006]) assert.equal(kind(400, code), "limit", `code ${code}`);
    assert.equal(kind(400, 613, 2534040), "limit");
    assert.equal(kind(429), "limit");
    assert.equal(kind(400, 10, 1893063), "limit", "temporarily restricted from sending messages");
  });

  it("a token that was turned away", () => {
    assert.equal(kind(400, 190), "token");
    assert.equal(kind(0, 190), "token", "no token set at all");
    assert.equal(kind(401, 102), "token");
  });

  it("everything else is a refusal of that one message", () => {
    assert.equal(kind(400, 100, 2534025), "permanent", "the comment is invalid for a private reply");
    assert.equal(kind(400, 551, 1545041), "permanent", "this person isn't available right now");
    assert.equal(kind(400, 200, 1545041), "permanent");
    assert.equal(kind(403, 10, 2018108), "permanent", "they can't receive your messages right now");
    assert.equal(kind(400, 10, 2534022), "permanent", "outside the allowed window");
    assert.equal(kind(400, 100), "permanent");
    assert.equal(kind(404, 803), "permanent");
    assert.equal(failureKind(new Error("a bug in the bot")), "permanent");
  });
});

describe("calls", () => {
  it("tries a read again when Instagram fails for a moment", async () => {
    mock.state.faults.push({ when: reads, times: 1, status: 500, error: { code: 2 } });
    assert.match(await getCaption("M1"), /GUIDE/);
    assert.equal(mock.calls.length, 2);
  });

  it("gives up on a read after three tries, and doesn't take a list cut off mid-answer for an empty one", async () => {
    mock.state.faults.push({ when: reads, raw: '{"data":[{"id":"M1"' });
    const e = await failure(listMedia(30));
    assert.equal(failureKind(e), "retry");
    assert.match(describeError(e), /unreadable answer/);
    assert.equal(mock.calls.length, 3);
  });

  it("doesn't repeat a read Meta refused", async () => {
    mock.state.expiredTokens = ["seed-token"];
    const e = await failure(getCaption("M1"));
    assert.equal(failureKind(e), "token");
    assert.equal(mock.calls.length, 1);
  });

  it("never repeats a send by itself: that's the queue's job", async () => {
    mock.state.faults.push({ when: sends, times: 1, status: 500, error: { code: 2 } });
    const e = await failure(sendMessage({ id: "U1" }, { text: "hi" }));
    assert.equal(failureKind(e), "retry");
    assert.equal(mock.calls.length, 1);
  });

  it("takes a dropped connection for a failure that may pass", async () => {
    mock.state.faults.push({ when: sends, times: 1, drop: true });
    const e = await failure(sendMessage({ id: "U1" }, { text: "hi" }));
    assert.ok(e instanceof GraphError);
    assert.equal(e.status, 0);
    assert.equal(failureKind(e), "retry");
    assert.match(describeError(e), /^no answer from Instagram/);
  });

  it("stops waiting for an answer that doesn't come", async () => {
    process.env.IG_GRAPH_TIMEOUT_MS = "50";
    mock.state.delayMs = 400;
    const started = Date.now();
    const e = await failure(sendMessage({ id: "U1" }, { text: "hi" }));
    assert.ok(Date.now() - started < 300, "gave up at the time limit, not when the answer came");
    assert.equal(failureKind(e), "retry");
    assert.match(describeError(e), /0\.05 s passed/);
  });

  it("reads from Meta's usage header how long a rate limit lasts", async () => {
    mock.state.privateReplyLimit = 0;
    mock.state.regainMinutes = 30;
    const e = await failure(sendMessage({ comment_id: "C1" }, { text: "hi" }));
    assert.equal(failureKind(e), "limit");
    assert.equal(e.code, 613);
    assert.equal(e.regainMinutes, 30);
  });

});
