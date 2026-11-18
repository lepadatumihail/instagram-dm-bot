import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/** A stand-in for graph.instagram.com that records every call. Tests point IG_GRAPH_BASE at it. */

export type Call = { method: string; path: string; query: URLSearchParams; body: any; token: string };

export type MockState = {
  me: { user_id: string; username: string };
  captions: Record<string, string>;
  media: { id: string; caption: string; permalink?: string; timestamp: string; comments_count?: number }[];
  comments: Record<string, unknown[]>;
  /** Answer a private reply that carries quick replies with a 400, as Meta might. */
  rejectButtonsOnPrivateReply: boolean;
  /** Tokens that get Meta's "invalid token" error (code 190). */
  expiredTokens: string[];
  /** Answer public comment replies with an error. */
  rejectPublicReplies: boolean;
};

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
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://mock");
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    const token = req.headers.authorization?.replace(/^Bearer /, "") ?? url.searchParams.get("access_token") ?? "";
    const path = url.pathname.replace(/^\/v27\.0/, "");
    calls.push({ method: req.method ?? "", path, query: url.searchParams, body, token });

    const reply = (status: number, data: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };

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
      if (state.rejectButtonsOnPrivateReply && body?.recipient?.comment_id && body?.message?.quick_replies) {
        return reply(400, { error: { message: "Invalid parameter", type: "OAuthException", code: 100 } });
      }
      return reply(200, { recipient_id: body?.recipient?.id ?? "IGSID", message_id: `mid.${calls.length}` });
    }
    if (self("/media")) return reply(200, { data: state.media });
    if (req.method === "POST" && /^\/[^/]+\/replies$/.test(path)) {
      if (state.rejectPublicReplies) return reply(400, { error: { message: "Comment replies are limited", code: 368 } });
      return reply(200, { id: `reply.${calls.length}` });
    }
    const comments = path.match(/^\/([^/]+)\/comments$/);
    if (comments) return reply(200, { data: state.comments[comments[1]] ?? [] });
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
    replies: () => calls.filter((c) => c.method === "POST" && c.path.endsWith("/replies")),
    clear: () => {
      calls.length = 0;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A time in Instagram's format: "2026-11-17T10:00:00+0000". */
export function igTime(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "+0000");
}
