import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { after, describe, it } from "node:test";
import { createApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";
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
});
delete process.env.TELEGRAM_BOT_TOKEN;
openDb(":memory:");

let lastWebhook: Promise<string[]> | undefined;
const server = createApp({ onWebhook: (done) => (lastWebhook = done) });
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(async () => {
  server.close();
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
    const stats = (await res.json()) as { comments: unknown[] };
    assert.deepEqual(stats.comments, [{ keyword: "GUIDE", status: "sent", count: 1 }]);
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
});
