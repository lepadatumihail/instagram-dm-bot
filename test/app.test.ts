import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, readdirSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createApp, webhooksRead } from "../src/app.ts";
import { commentStatus, openDb, queueComment, settleComment } from "../src/db.ts";
import { idle } from "../src/instagram/queue.ts";
import { comment } from "./events.ts";
import { startMockGraph } from "./mock-graph.ts";

const mock = await startMockGraph();
mock.state.captions.M1 = "Comment GUIDE and I'll send you the guide 👇";
Object.assign(process.env, {
  IG_GRAPH_BASE: mock.base,
  IG_ACCESS_TOKEN: "seed-token",
  IG_APP_SECRET: "ig-secret",
  META_APP_SECRET: "meta-secret",
  IG_VERIFY_TOKEN: "verify-me",
  ADMIN_KEY: "admin-key",
  CONTACT_EMAIL: "hello@example.com",
  POSTS_DIR: mkdtempSync(join(tmpdir(), "instagram-dm-bot-posts-")),
});
delete process.env.TELEGRAM_BOT_TOKEN;
openDb(":memory:");

let lastWebhook: Promise<string[]> | undefined;
const webhooks: Promise<string[]>[] = [];
const server = createApp({
  onWebhook: (done) => {
    lastWebhook = done;
    webhooks.push(done);
  },
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(async () => {
  server.close();
  server.closeAllConnections();
  await mock.close();
});

const payload = JSON.stringify({
  object: "instagram",
  entry: [
    {
      id: "OWNER-IG",
      time: 1,
      changes: [{ field: "comments", value: { from: { id: "U1", username: "alice" }, media: { id: "M1" }, id: "C1", text: "GUIDE" } }],
    },
  ],
});
const sign = (body: string, secret: string) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
const post = (body: string, signature?: string) =>
  fetch(`${base}/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(signature ? { "x-hub-signature-256": signature } : {}) },
    body,
  });

describe("server", () => {
  it("answers the health check", async () => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "ok");
  });

  it("passes Meta's callback check only with the verify token", async () => {
    const ok = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=1158201444`);
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), "1158201444");
    const wrong = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1`);
    assert.equal(wrong.status, 403);
  });

  it("turns away webhooks without the right signature", async () => {
    assert.equal((await post(payload)).status, 401);
    assert.equal((await post(payload, sign(payload, "wrong"))).status, 401);
    assert.equal(mock.sent().length, 0);
  });

  it("takes a signed webhook, says 200 at once, then sends the teaser", async () => {
    const res = await post(payload, sign(payload, "ig-secret"));
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "EVENT_RECEIVED");
    assert.deepEqual(await lastWebhook, ["teaser sent: GUIDE to @alice"]);
    assert.deepEqual(mock.sent()[0].body.recipient, { comment_id: "C1" });
  });

  it("accepts the Meta app secret too, and rejects broken JSON", async () => {
    const res = await post(payload, sign(payload, "meta-secret"));
    assert.equal(res.status, 200);
    assert.deepEqual(await lastWebhook, ["skipped: already answered"]);
    assert.equal((await post("{oops", sign("{oops", "ig-secret"))).status, 400);
  });

  it("serves the privacy notice with the contact address and the deletion section", async () => {
    const res = await fetch(`${base}/privacy`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    const html = await res.text();
    assert.match(html, /hello@example\.com/);
    assert.match(html, /id="data-deletion"/);
  });

  it("keeps /admin behind ADMIN_KEY", async () => {
    assert.equal((await fetch(`${base}/admin/stats`)).status, 401);
    assert.equal((await fetch(`${base}/admin/stats`, { headers: { authorization: "Bearer wrong" } })).status, 401);
    const res = await fetch(`${base}/admin/stats`, { headers: { authorization: "Bearer admin-key" } });
    assert.equal(res.status, 200);
    const stats = (await res.json()) as { comments: unknown[]; queue: Record<string, unknown> };
    assert.deepEqual(stats.comments, [{ keyword: "GUIDE", status: "sent", count: 1 }]);
    assert.deepEqual(stats.queue, {
      inLine: { comments: 0, deliveries: 0 },
      sending: 0,
      privateRepliesLastHour: 1,
      privateRepliesPerHour: 700,
      paused: "no",
      teasersPaused: "no",
      giveawaysPaused: "no",
    });
  });

  it("previews with GET /admin/pending and sends only with POST /admin/backfill", async () => {
    const auth = { authorization: "Bearer admin-key" };
    const preview = (await (await fetch(`${base}/admin/pending?days=7`, { headers: auth })).json()) as { mode: string };
    assert.equal(preview.mode, "preview");
    assert.equal((await fetch(`${base}/admin/backfill`, { headers: auth })).status, 404);
    const sent = (await (await fetch(`${base}/admin/backfill?days=7`, { method: "POST", headers: auth })).json()) as {
      mode: string;
    };
    assert.equal(sent.mode, "sent");
  });

  it("says 404 for anything else", async () => {
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  });

  it("puts given-up comments back in line with POST /admin/requeue", async () => {
    const auth = { authorization: "Bearer admin-key" };
    queueComment({ commentId: "GU1", mediaId: "M1", username: "zoe", keyword: "GUIDE" });
    settleComment("GU1", "failed", { error: "Application does not have permission for this action (HTTP 400, code 10)" });
    assert.equal((await fetch(`${base}/admin/requeue`, { headers: auth })).status, 404, "only with POST");
    const res = await fetch(`${base}/admin/requeue?days=7`, { method: "POST", headers: auth });
    const body = (await res.json()) as { count: number; requeued: { commentId: string; username: string; error: string }[] };
    assert.equal(body.count, 1);
    assert.deepEqual([body.requeued[0].commentId, body.requeued[0].username], ["GU1", "zoe"]);
    assert.match(body.requeued[0].error, /permission/);
    await idle();
    assert.equal(commentStatus("GU1"), "sent");
  });

  it("knows which webhooks have had their 200 but aren't in the line yet, so a stop can wait for them", async () => {
    // A reel the bot hasn't looked up: the comment waits for its caption after the 200 is out.
    mock.state.captions.M2 = "Comment GUIDE for the repo";
    mock.state.delayMs = 60;
    const body = JSON.stringify(comment("W1", "guide", { id: "WU1", username: "wren" }, "M2"));
    assert.equal((await post(body, sign(body, "ig-secret"))).status, 200);
    assert.equal(commentStatus("W1"), undefined, "not in the line yet");
    await webhooksRead();
    assert.equal(commentStatus("W1"), "sent");
    mock.state.delayMs = 0;
  });

  it("says 200 to a burst of webhooks while Instagram is slow, then answers every comment once", async () => {
    mock.state.delayMs = 40;
    webhooks.length = 0;
    const bodies = Array.from({ length: 60 }, (_, i) => JSON.stringify(comment(`H${i}`, "guide", { id: `HU${i}`, username: `h${i}` })));
    const mine = () => mock.privateReplies().filter((id) => id.startsWith("H"));

    const responses = await Promise.all(bodies.map((body) => post(body, sign(body, "ig-secret"))));
    assert.ok(responses.every((res) => res.status === 200));
    // 60 comments at two slow calls each, four at a time, take over a second. The 200s wait for none of it.
    assert.ok(mine().length < 30, `Meta had its 200s when ${mine().length} of 60 teasers were out`);

    const results = (await Promise.all(webhooks)).flat();
    assert.equal(results.filter((r) => r.startsWith("teaser sent: GUIDE to @h")).length, 60);
    assert.equal(mine().length, 60);
    assert.ok(mock.peak() <= 4, `at most 4 calls at a time, saw ${mock.peak()}`);
    mock.state.delayMs = 0;
  });

  it("still turns away a webhook over 1 MB: the bigger limit is for videos only", async () => {
    const body = JSON.stringify({ object: "instagram", padding: "x".repeat(1024 * 1024) });
    assert.equal((await post(body, sign(body, "ig-secret"))).status, 413);
  });
});

describe("the posts API", () => {
  const auth = { authorization: "Bearer admin-key" };
  const admin = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, { ...init, headers: { ...auth, ...init.headers } });
  const video = (bytes: number) => {
    const file = Buffer.alloc(bytes, 9);
    file.write("\0\0\0\x18ftypisom", 0, "latin1");
    return file;
  };
  const videos = () => readdirSync(process.env.POSTS_DIR as string);
  const newPost = async () => ((await (await admin("/admin/posts", { method: "POST", body: JSON.stringify({ caption: "A reel", at: "2031-03-01T18:30:00+01:00" }) })).json()) as { id: number }).id;

  it("is behind ADMIN_KEY like the rest of /admin", async () => {
    assert.equal((await fetch(`${base}/admin/posts`)).status, 401);
    assert.equal((await fetch(`${base}/admin/posts`, { method: "POST", body: "{}" })).status, 401);
    assert.equal((await fetch(`${base}/admin/posts/1/video`, { method: "PUT", body: video(100) })).status, 401);
    assert.equal((await fetch(`${base}/admin/posts/1`, { method: "DELETE" })).status, 401);
    assert.deepEqual(videos(), []);
  });

  it("schedules a post from JSON, takes its video as the body of a second call, lists it and cancels it", async () => {
    const created = await admin("/admin/posts", { method: "POST", body: JSON.stringify({ caption: "A reel\n#one", at: "2031-03-01T18:30:00+01:00", thumbOffset: 2100, aiLabel: true }) });
    assert.equal(created.status, 201);
    const made = (await created.json()) as { id: number; state: string; publishAt: string; next: string };
    assert.deepEqual([made.state, made.publishAt], ["scheduled", "2031-03-01T17:30:00Z"]);

    const file = video(300_000);
    const sent = await admin(`/admin/posts/${made.id}/video`, { method: "PUT", body: file });
    assert.equal(sent.status, 200);
    assert.deepEqual(await sent.json(), { id: made.id, bytes: 300_000 });
    assert.equal(videos().length, 1);

    const list = (await (await admin("/admin/posts")).json()) as { id: number; state: string; video: string; aiLabel: boolean }[];
    assert.deepEqual(
      list.filter((p) => p.id === made.id).map((p) => [p.state, p.video, p.aiLabel]),
      [["scheduled", "0.3 MB", true]],
    );

    const cancelled = await admin(`/admin/posts/${made.id}`, { method: "DELETE" });
    assert.equal(((await cancelled.json()) as { state: string }).state, "cancelled");
    assert.deepEqual(videos(), []);
  });

  it("answers what is wrong in a sentence", async () => {
    const text = async (res: Response) => `${res.status} ${(await res.text()).trim()}`;
    assert.match(await text(await admin("/admin/posts", { method: "POST", body: "{oops" })), /^400 Send the post as JSON/);
    assert.match(await text(await admin("/admin/posts", { method: "POST", body: JSON.stringify({ caption: "x", at: "18:30" }) })), /^400 at is missing or has no time zone/);
    assert.match(await text(await admin("/admin/posts/99999", { method: "DELETE" })), /^404 There is no post 99999/);
    assert.match(await text(await admin("/admin/posts/99999/video", { method: "PUT", body: video(100) })), /^404 There is no post 99999/);
    const id = await newPost();
    assert.match(await text(await admin(`/admin/posts/${id}/video`, { method: "PUT", body: Buffer.from("<html>not a video</html>") })), /^400 That doesn't look like an MP4 or MOV file/);
    assert.equal((await admin(`/admin/posts/${id}/nothing`, { method: "PUT", body: "x" })).status, 404);
  });

  it("stops a video at the size limit, on a request that says its size and on one that doesn't", async () => {
    process.env.POST_MAX_MB = "1";
    try {
      const id = await newPost();
      const tooBig = await admin(`/admin/posts/${id}/video`, { method: "PUT", body: video(1024 * 1024 + 1) });
      assert.equal(tooBig.status, 413);
      assert.match(await tooBig.text(), /The video is over 1 MB/);

      // The same file sent in pieces, without a Content-Length: the bot can only find out as it arrives.
      const answer = await new Promise<{ status: number; text: string; sent: number }>((resolve, reject) => {
        const req = request(`${base}/admin/posts/${id}/video`, { method: "PUT", headers: auth }, (res) => {
          let text = "";
          res.on("data", (chunk) => (text += chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, text, sent }));
        });
        req.on("error", (e) => (sent > 1024 * 1024 ? undefined : reject(e)));
        let sent = 0;
        const piece = video(256 * 1024);
        const more = () => {
          if (sent >= 8 * 1024 * 1024 || req.destroyed) return void req.end();
          sent += piece.length;
          req.write(piece, () => setTimeout(more, 2));
        };
        more();
      });
      assert.equal(answer.status, 413);
      assert.match(answer.text, /The video is over 1 MB/);
      assert.ok(answer.sent < 8 * 1024 * 1024, `the bot answered after ${Math.round(answer.sent / 1024)} KB, without waiting for all 8 MB`);
      assert.deepEqual(videos(), [], "nothing is left on the disk");

      const fits = await admin(`/admin/posts/${id}/video`, { method: "PUT", body: video(900 * 1024) });
      assert.equal(fits.status, 200);
      await admin(`/admin/posts/${id}`, { method: "DELETE" });
    } finally {
      delete process.env.POST_MAX_MB;
    }
  });
});
