import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/** A stand-in for graph.instagram.com that records every call. Tests point IG_GRAPH_BASE at it. */

export type Call = {
  method: string;
  path: string;
  query: URLSearchParams;
  body: any;
  token: string;
  /** The request's headers, lower-case. */
  headers: Record<string, string | string[] | undefined>;
  /** When the call arrived and when its answer was out, in milliseconds on the same clock. */
  at: number;
  done?: number;
};

/** A reel's container at the stand-in: what it was created with, the file it got, and how far it is. */
export type Container = {
  id: string;
  params: Record<string, string>;
  /** IN_PROGRESS, FINISHED, PUBLISHED; a test sets ERROR or EXPIRED. */
  status_code: string;
  status?: string;
  /** The file that arrived: its size and SHA-256. */
  upload?: { bytes: number; sha256: string };
  /** Status reads that still say IN_PROGRESS after the file arrived. */
  pollsLeft: number;
  /** The post it became. */
  mediaId?: string;
};

type GraphErrorBody = { message?: string; type?: string; code?: number; error_subcode?: number; is_transient?: boolean };

/** A failure the stand-in gives in place of its normal answer. */
export type Fault = {
  /** Which calls get it. */
  when: (call: Call) => boolean;
  /** How many calls get it. Left out: every matching call, until the test empties `faults`. */
  times?: number;
  status?: number;
  error?: GraphErrorBody;
  headers?: Record<string, string>;
  /** Close the connection without an answer, like a network failure. */
  drop?: boolean;
  /** Do what the call asks, then close the connection without an answer: it happened, and the bot isn't told. */
  loseAnswer?: boolean;
  /** Answer with this text as it is (status 200 unless given), for an answer that isn't Meta's JSON. */
  raw?: string;
};

export type MockState = {
  me: { user_id: string; username: string };
  captions: Record<string, string>;
  media: { id: string; caption: string; permalink?: string; timestamp: string; comments_count?: number }[];
  /** Each post's top-level comments, in the order Instagram would list them (newest first). */
  comments: Record<string, unknown[]>;
  /** Answer a private reply that carries quick replies with a 400, as Meta might. */
  rejectButtonsOnPrivateReply: boolean;
  /** Tokens that get Meta's "invalid token" error (code 190). */
  expiredTokens: string[];
  /** Answer public comment replies with an error. */
  rejectPublicReplies: boolean;
  /** Failures to give in place of the normal answer; the first that matches wins. */
  faults: Fault[];
  /** How long every answer takes, in milliseconds, to keep calls in flight. */
  delayMs: number;
  /** Meta's hourly limit in small: once this many private replies went out, the next ones get error 613. */
  privateReplyLimit: number;
  /** What the usage header says about when a rate limit lifts, in minutes. 0 leaves the header out. */
  regainMinutes: number;
  /** The containers opened for reels, by id. */
  containers: Record<string, Container>;
  /** How many status reads say IN_PROGRESS before a new container's video is FINISHED. */
  processingPolls: number;
  /** What time it is at the stand-in, for a test that moves the clock: a published reel is stamped with it. */
  time?: number;
};

/** Whether a call is a private reply (a message addressed to a comment) or a DM to a person. */
export const isPrivateReply = (c: Call) => c.method === "POST" && c.path.endsWith("/messages") && Boolean(c.body?.recipient?.comment_id);
export const isDm = (c: Call) => c.method === "POST" && c.path.endsWith("/messages") && Boolean(c.body?.recipient?.id);
export const isPublicReply = (c: Call) => c.method === "POST" && c.path.endsWith("/replies");

export async function startMockGraph() {
  const calls: Call[] = [];
  const state: MockState = {
    me: { user_id: "OWNER-IG", username: "yourbrand" },
    captions: {},
    media: [],
    comments: {},
    rejectButtonsOnPrivateReply: false,
    expiredTokens: [],
    rejectPublicReplies: false,
    faults: [],
    delayMs: 0,
    privateReplyLimit: Number.POSITIVE_INFINITY,
    regainMinutes: 0,
    containers: {},
    processingPolls: 0,
  };
  let made = 0;
  /**
   * Comments that have had their one private reply. Meta's docs allow no
   * second; the error it gives for one (100/2534025 here) is a guess.
   */
  const replied = new Set<string>();
  let inFlight = 0;
  let peak = 0;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const bytes = Buffer.concat(chunks);
    const type = req.headers["content-type"] ?? "";
    // JSON for messages and replies, a form for the publishing calls, bytes for a video.
    const body = !bytes.length
      ? undefined
      : type.includes("octet-stream")
        ? { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }
        : type.includes("x-www-form-urlencoded")
          ? Object.fromEntries(new URLSearchParams(bytes.toString("utf8")))
          : JSON.parse(bytes.toString("utf8"));
    const token = req.headers.authorization?.replace(/^(Bearer|OAuth) /, "") ?? url.searchParams.get("access_token") ?? "";
    const path = url.pathname.replace(/^\/v27\.0/, "");
    const call: Call = { method: req.method ?? "", path, query: url.searchParams, body, token, headers: req.headers, at: performance.now() };
    calls.push(call);

    peak = Math.max(peak, ++inFlight);
    res.on("finish", () => (call.done = performance.now()));
    res.on("close", () => inFlight--);
    if (state.delayMs) await new Promise((resolve) => setTimeout(resolve, state.delayMs));

    let lose = false;
    const reply = (status: number, data: unknown, headers: Record<string, string> = {}) => {
      if (lose) return void res.destroy();
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(data));
    };

    const fault = state.faults.find((f) => f.when(call));
    if (fault) {
      if (fault.times !== undefined && --fault.times <= 0) state.faults.splice(state.faults.indexOf(fault), 1);
      if (fault.drop) return void res.destroy();
      lose = Boolean(fault.loseAnswer);
    }
    if (fault && !fault.loseAnswer) {
      if (fault.raw !== undefined) return void res.writeHead(fault.status ?? 200, { "content-type": "application/json" }).end(fault.raw);
      return reply(fault.status ?? 500, { error: { message: "An unexpected error has occurred.", ...fault.error } }, fault.headers);
    }

    if (state.expiredTokens.includes(token)) {
      return reply(400, { error: { message: "Error validating access token", type: "OAuthException", code: 190 } });
    }
    if (path === "/refresh_access_token") {
      return reply(200, { access_token: "refreshed-token", token_type: "bearer", expires_in: 5184000 });
    }
    // The account answers at /me and at /{its id}, as on Meta's two hosts.
    const self = (rest: string) => path === `/me${rest}` || path === `/${state.me.user_id}${rest}`;
    if (self("")) return reply(200, { ...state.me, id: state.me.user_id });
    if (self("/messages") && req.method === "POST") {
      const commentId: string | undefined = body?.recipient?.comment_id;
      if (state.rejectButtonsOnPrivateReply && commentId && body?.message?.quick_replies) {
        return reply(400, { error: { message: "Invalid parameter", type: "OAuthException", code: 100 } });
      }
      if (commentId) {
        if (replied.size >= state.privateReplyLimit) {
          const usage = { [state.me.user_id]: [{ type: "instagram", call_count: 100, estimated_time_to_regain_access: state.regainMinutes }] };
          return reply(
            400,
            { error: { message: "Calls to this api have exceeded the rate limit.", type: "OAuthException", code: 613, error_subcode: 2534040 } },
            state.regainMinutes ? { "x-business-use-case-usage": JSON.stringify(usage) } : {},
          );
        }
        if (replied.has(commentId)) {
          return reply(400, { error: { message: "The comment is invalid for a private reply", type: "OAuthException", code: 100, error_subcode: 2534025 } });
        }
        replied.add(commentId);
      }
      return reply(200, { recipient_id: body?.recipient?.id ?? "IGSID", message_id: `mid.${calls.length}` });
    }
    // Publishing a reel: a container, its file, its status, the publish.
    if (self("/media") && req.method === "POST") {
      const id = `CONT${++made}`;
      state.containers[id] = { id, params: body ?? {}, status_code: "IN_PROGRESS", pollsLeft: state.processingPolls };
      return reply(200, { id, uri: `http://${req.headers.host}/upload/${id}` });
    }
    const upload = path.match(/^\/upload\/(\w+)$/);
    if (upload && req.method === "POST") {
      const container = state.containers[upload[1]];
      if (!container) return reply(404, { debug_info: { message: "no such upload session" } });
      if (!String(req.headers.authorization).startsWith("OAuth ")) return reply(401, { debug_info: { message: "the upload wants Authorization: OAuth <token>" } });
      if (Number(req.headers.file_size) !== bytes.length || req.headers.offset !== "0") {
        return reply(400, { debug_info: { message: `file_size says ${req.headers.file_size}, ${bytes.length} bytes came` } });
      }
      container.upload = body;
      return reply(200, { success: true });
    }
    const container = state.containers[path.slice(1)];
    if (container && req.method === "GET") {
      if (container.status_code === "IN_PROGRESS" && container.upload && container.pollsLeft-- <= 0) container.status_code = "FINISHED";
      return reply(200, { id: container.id, status_code: container.status_code, ...(container.status ? { status: container.status } : {}) });
    }
    if (self("/media_publish") && req.method === "POST") {
      const ready = state.containers[body?.creation_id];
      // What Instagram answers for a container that isn't ready, or is published already, isn't in its docs: an error either way here.
      if (!ready || ready.status_code !== "FINISHED") {
        return reply(400, { error: { message: "Media ID is not available", type: "OAuthException", code: 9007, error_subcode: 2207027 } });
      }
      ready.status_code = "PUBLISHED";
      ready.mediaId = `MEDIA${++made}`;
      const stamp = igTime(state.time ?? Date.now());
      state.media.unshift({ id: ready.mediaId, caption: ready.params.caption ?? "", permalink: `https://www.instagram.com/reel/${ready.mediaId}/`, timestamp: stamp });
      return reply(200, { id: ready.mediaId });
    }
    const published = state.media.find((m) => m.id === path.slice(1));
    if (published && req.method === "GET" && url.searchParams.get("fields")?.includes("permalink")) return reply(200, { id: published.id, permalink: published.permalink });
    if (self("/media")) return reply(200, { data: state.media });
    if (req.method === "POST" && /^\/[^/]+\/replies$/.test(path)) {
      if (state.rejectPublicReplies) return reply(400, { error: { message: "Comment replies are limited", code: 368 } });
      return reply(200, { id: `reply.${calls.length}` });
    }
    const comments = path.match(/^\/([^/]+)\/comments$/);
    if (comments) {
      // Pages like Instagram's: `limit` at a time, with a "next" link while there is more.
      const every = state.comments[comments[1]] ?? [];
      const limit = Number(url.searchParams.get("limit") ?? 25);
      const from = Number(url.searchParams.get("after") ?? 0);
      const next = new URL(url);
      next.searchParams.set("after", String(from + limit));
      return reply(200, { data: every.slice(from, from + limit), ...(from + limit < every.length ? { paging: { next: next.href } } : {}) });
    }
    const media = path.match(/^\/([^/]+)$/);
    if (media && media[1] in state.captions) return reply(200, { id: media[1], caption: state.captions[media[1]] });
    reply(404, { error: { message: `mock has no ${req.method} ${path}`, code: 803 } });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    base: `http://127.0.0.1:${port}/v27.0`,
    state,
    calls,
    /** The messages sent (to /me/messages or /{id}/messages), oldest first. */
    sent: () => calls.filter((c) => c.method === "POST" && c.path.endsWith("/messages")),
    /** The public comment replies posted, oldest first. */
    replies: () => calls.filter(isPublicReply),
    /** The comments whose private reply Instagram took, in the order it took them. */
    privateReplies: () => [...replied],
    /** The most calls the stand-in was answering at one moment. */
    peak: () => peak,
    /** The reels that went public, oldest first: [container id, post id]. */
    published: () =>
      Object.values(state.containers)
        .filter((c) => c.mediaId)
        .map((c) => [c.id, c.mediaId]),
    /** Forgets the calls so far. */
    clear: () => {
      calls.length = 0;
    },
    /** A clean start for the next test: no calls, no posts, no private replies given, every switch back to normal. Captions stay. */
    reset: () => {
      calls.length = 0;
      replied.clear();
      peak = 0;
      made = 0;
      Object.assign(state, {
        time: undefined,
        media: [],
        comments: {},
        rejectButtonsOnPrivateReply: false,
        expiredTokens: [],
        rejectPublicReplies: false,
        faults: [],
        delayMs: 0,
        privateReplyLimit: Number.POSITIVE_INFINITY,
        regainMinutes: 0,
        containers: {},
        processingPolls: 0,
      });
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        // A call still being answered would keep its connection, and the test run, open for seconds.
        server.closeAllConnections();
      }),
  };
}

/** A time in Instagram's format: "2026-11-17T10:00:00+0000". */
export function igTime(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "+0000");
}
