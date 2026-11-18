import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { alert } from "./alert.ts";
import { config } from "./config.ts";
import { stats } from "./db.ts";
import { handleWebhook } from "./instagram/bot.ts";
import { allPosts, cancelPost, createPost, Refused, saveVideo } from "./instagram/posts.ts";
import { queueState, requeue } from "./instagram/queue.ts";
import { validSignature } from "./instagram/signature.ts";
import { backfill } from "./instagram/sweep.ts";
import { privacyPage } from "./privacy.ts";

/**
 * The HTTP side:
 *   GET  /health          for Railway's health check
 *   GET  /privacy         the privacy notice Meta asks for
 *   GET  /webhook         Meta's one-time check of the callback URL
 *   POST /webhook         comments, DMs and button taps from Meta
 *   GET  /admin/stats     counts per keyword, the queue (ADMIN_KEY)
 *   GET  /admin/pending   unanswered keyword comments   (ADMIN_KEY)
 *   POST /admin/backfill  answer them                   (ADMIN_KEY)
 *   POST /admin/requeue   put given-up comments back    (ADMIN_KEY)
 *   GET    /admin/posts            the scheduled reels      (ADMIN_KEY)
 *   POST   /admin/posts            schedule one, from JSON  (ADMIN_KEY)
 *   PUT    /admin/posts/:id/video  its video, as the body   (ADMIN_KEY)
 *   DELETE /admin/posts/:id        cancel it                (ADMIN_KEY)
 */

const MAX_BODY = 1024 * 1024;

type Options = { onWebhook?: (done: Promise<string[]>) => void };

/** Webhooks that have had their 200 and are still being read into the line. */
const reading = new Set<Promise<unknown>>();

/** Resolves when every webhook that got its 200 is in the line. server.ts waits for it before it stops. */
export async function webhooksRead(): Promise<void> {
  while (reading.size > 0) await Promise.all(reading);
}

export function createApp(options: Options = {}) {
  const server = createServer((req, res) => {
    route(req, res, options).catch((e) => {
      if (res.headersSent) return console.error(e);
      if (e instanceof Refused) return refuse(req, res, e);
      console.error(e);
      send(res, 500, "error");
    });
  });
  // A big video over a slow line takes longer than the five minutes Node gives a whole request.
  // (On Railway its proxy has the last word: five minutes for a request's body.)
  server.requestTimeout = 30 * 60 * 1000;
  return server;
}

/**
 * Answers what the posts API turns down, with its status and its sentence.
 * If a video is still arriving, the rest of it is read and dropped, so the
 * sender gets to hear the answer instead of a broken connection. Not without
 * end: past twice the largest video, the connection is cut.
 */
function refuse(req: IncomingMessage, res: ServerResponse, e: Refused): void {
  send(res, e.status, `${e.message}\n`);
  let dropped = 0;
  req.on("data", (chunk: Buffer) => {
    if ((dropped += chunk.length) > 2 * config.postMaxBytes) req.destroy();
  });
}

async function route(req: IncomingMessage, res: ServerResponse, options: Options): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  if (req.method === "GET" && path === "/health") return send(res, 200, "ok");
  if (req.method === "GET" && path === "/privacy") {
    return send(res, 200, privacyPage(config.contactEmail), "text/html; charset=utf-8");
  }

  if (path === "/webhook" && req.method === "GET") {
    const p = url.searchParams;
    const ok = config.verifyToken && p.get("hub.mode") === "subscribe" && p.get("hub.verify_token") === config.verifyToken;
    return ok ? send(res, 200, p.get("hub.challenge") ?? "") : send(res, 403, "forbidden");
  }
  if (path === "/webhook" && req.method === "POST") return receive(req, res, options);

  if (path.startsWith("/admin/")) {
    if (!authorized(req)) return send(res, 401, "unauthorized");
    if (req.method === "GET" && path === "/admin/stats") return json(res, { ...stats(), queue: queueState() });
    const days = Math.min(7, Math.max(0, Number(url.searchParams.get("days") ?? 7) || 0));
    const skip = new Set(
      (url.searchParams.get("skip") ?? "")
        .split(",")
        .map((s) => s.trim().replace(/^@/, "").toLowerCase())
        .filter(Boolean),
    );
    if (req.method === "GET" && path === "/admin/pending") return json(res, await backfill(days, skip, false));
    if (req.method === "POST" && path === "/admin/backfill") return json(res, await backfill(days, skip, true));
    if (req.method === "POST" && path === "/admin/requeue") {
      const back = requeue(days);
      return json(res, { count: back.length, requeued: back });
    }
    if (path === "/admin/posts" && req.method === "GET") return json(res, allPosts());
    if (path === "/admin/posts" && req.method === "POST") {
      const body = await readBody(req);
      if (!body) throw new Refused(413, "That is too much for a post: the video goes in a call of its own.");
      let input: unknown;
      try {
        input = JSON.parse(body.toString("utf8"));
      } catch {
        throw new Refused(400, "Send the post as JSON: { caption, at, … }.");
      }
      return json(res, createPost(input), 201);
    }
    const post = path.match(/^\/admin\/posts\/(\d+)(\/video)?$/);
    if (post && post[2] && (req.method === "PUT" || req.method === "POST")) {
      const declared = Number(header(req, "content-length") ?? Number.NaN);
      return json(res, await saveVideo(Number(post[1]), req, Number.isNaN(declared) ? undefined : declared));
    }
    if (post && !post[2] && req.method === "DELETE") return json(res, cancelPost(Number(post[1])));
  }

  send(res, 404, "not found");
}

async function receive(req: IncomingMessage, res: ServerResponse, options: Options): Promise<void> {
  const body = await readBody(req);
  if (!body) return send(res, 413, "too large");

  const signature = header(req, "x-hub-signature-256");
  if (!validSignature(body, signature, config.appSecrets)) {
    if (signature) {
      void alert("signature", "a webhook came with a signature that doesn't match. Check IG_APP_SECRET / META_APP_SECRET.");
    }
    return send(res, 401, "bad signature");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body.toString("utf8"));
  } catch {
    return send(res, 400, "bad json");
  }

  // Meta wants a quick 200; the work happens after. Each event goes in line
  // in the database (queue.ts), so nothing here waits on Instagram.
  send(res, 200, "EVENT_RECEIVED");
  const done = handleWebhook(payload);
  reading.add(done);
  options.onWebhook?.(done);
  const results = await done.finally(() => reading.delete(done));
  console.log(`webhook: ${results.length ? results.join("; ") : "nothing for the bot"}`);
}

function authorized(req: IncomingMessage): boolean {
  if (!config.adminKey) return false;
  const given = Buffer.from(header(req, "authorization") ?? "");
  const expected = Buffer.from(`Bearer ${config.adminKey}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function header(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name];
  return (Array.isArray(value) ? value[0] : value) ?? null;
}

async function readBody(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function send(res: ServerResponse, status: number, body: string, type = "text/plain; charset=utf-8"): void {
  res.writeHead(status, { "content-type": type });
  res.end(body);
}

function json(res: ServerResponse, data: unknown, status = 200): void {
  send(res, status, JSON.stringify(data, null, 2), "application/json");
}
