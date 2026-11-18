import { config } from "../config.ts";
import { currentToken, isSystemUserToken } from "./token.ts";

/**
 * The few calls the bot makes to the Instagram API. Meta serves it from two
 * hosts with the same paths: graph.facebook.com for system-user tokens (new
 * apps, "Unified login") and graph.instagram.com for Instagram-login tokens.
 */

const VERSION = "v27.0";

function baseFor(token: string): string {
  if (config.graphBase) return config.graphBase;
  return `https://graph.${isSystemUserToken(token) ? "facebook" : "instagram"}.com/${VERSION}`;
}

/** The account's own node: its id when IG_USER_ID is set, else "me". */
function account(): string {
  return config.igUserId || "me";
}

export class GraphError extends Error {
  status: number;
  code?: number;
  subcode?: number;

  constructor(message: string, status: number, code?: number, subcode?: number) {
    super(message);
    this.name = "GraphError";
    this.status = status;
    this.code = code;
    this.subcode = subcode;
  }
}

type Query = Record<string, string>;

async function call<T>(method: "GET" | "POST", pathOrUrl: string, options: { query?: Query; body?: unknown } = {}): Promise<T> {
  const token = currentToken();
  if (!token) throw new GraphError("IG_ACCESS_TOKEN is not set", 0);

  const url = new URL(pathOrUrl.startsWith("http") ? pathOrUrl : baseFor(token) + pathOrUrl);
  for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value);

  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(options.body ? { "content-type": "application/json" } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = (await response.json().catch(() => ({}))) as {
    error?: { message?: string; code?: number; error_subcode?: number };
  };
  if (!response.ok || data.error) {
    const e = data.error ?? {};
    throw new GraphError(e.message ?? `HTTP ${response.status}`, response.status, e.code, e.error_subcode);
  }
  return data as T;
}

export type Recipient = { id: string } | { comment_id: string };
export type QuickReply = { content_type: "text"; title: string; payload: string };
export type Message = { text: string; quick_replies?: QuickReply[] };

/** A DM to a user (by the id Instagram gives them in this chat), or the one private reply a comment allows. */
export function sendMessage(recipient: Recipient, message: Message) {
  return call<{ recipient_id?: string; message_id?: string }>("POST", `/${account()}/messages`, {
    body: { recipient, message },
  });
}

/** A public reply in a comment's thread. Instagram threads are one level deep, so `commentId` must be a top-level comment. */
export function replyToComment(commentId: string, message: string) {
  return call<{ id?: string }>("POST", `/${commentId}/replies`, { body: { message } });
}

export async function getCaption(mediaId: string): Promise<string> {
  const media = await call<{ caption?: string }>("GET", `/${mediaId}`, { query: { fields: "caption" } });
  return media.caption ?? "";
}

/** The account's id and username. On /me the account id is `user_id` (`id` is app-scoped); on /{id} it's `id`. */
export function getMe() {
  const fields = config.igUserId ? "id,username" : "user_id,username";
  return call<{ id?: string; user_id?: string; username?: string }>("GET", `/${account()}`, { query: { fields } });
}

type Page<T> = { data?: T[]; paging?: { next?: string } };

/** Every item of a list, following its "next" links, up to `max` items. */
async function all<T>(path: string, query: Query, max: number): Promise<T[]> {
  const items: T[] = [];
  let page = await call<Page<T>>("GET", path, { query });
  for (;;) {
    items.push(...(page.data ?? []));
    if (items.length >= max || !page.paging?.next) return items.slice(0, max);
    page = await call<Page<T>>("GET", page.paging.next);
  }
}

export type Media = { id: string; caption?: string; permalink?: string; timestamp?: string; comments_count?: number };

export function listMedia(max: number) {
  return all<Media>(`/${account()}/media`, { fields: "id,caption,permalink,timestamp,comments_count", limit: "25" }, max);
}

export type Comment = {
  id: string;
  text?: string;
  timestamp?: string;
  username?: string;
  from?: { id?: string; username?: string };
  replies?: { data?: Comment[] };
};

export function listComments(mediaId: string, max: number) {
  return all<Comment>(
    `/${mediaId}/comments`,
    { fields: "id,text,timestamp,username,from,replies{id,text,timestamp,username,from}", limit: "50" },
    max,
  );
}
