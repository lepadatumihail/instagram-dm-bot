import { createReadStream } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { pipeline } from "node:stream/promises";
import { config, MINUTE } from "../config.ts";
import { currentToken, isSystemUserToken } from "./token.ts";

/**
 * The few calls the bot makes to the Instagram API. Meta serves it from two
 * hosts with the same paths: graph.facebook.com for system-user tokens (new
 * apps, "Unified login") and graph.instagram.com for Instagram-login tokens.
 */

const VERSION = "v27.0";

/** A read that failed for a passing reason is tried again after these waits, in milliseconds. */
const READ_RETRIES = [300, 1500];

function baseFor(token: string): string {
  if (config.graphBase) return config.graphBase;
  return `https://graph.${isSystemUserToken(token) ? "facebook" : "instagram"}.com/${VERSION}`;
}

/** The account's own node: its id when IG_USER_ID is set, else "me". */
function account(): string {
  return config.igUserId || "me";
}

export class GraphError extends Error {
  /** The HTTP status, or 0 when no answer came at all (network error, timeout). */
  status: number;
  code?: number;
  subcode?: number;
  /** Meta's own word that trying again may work ("is_transient" in the error). */
  transient = false;
  /**
   * No word from Instagram's API on whether the call worked: it took too long,
   * the connection was lost on the way, or something in between answered 5xx.
   * A message sent this way may have arrived all the same.
   */
  maybeSent = false;
  /** Minutes until Meta expects to lift a rate limit, when its usage header says so. */
  regainMinutes = 0;

  constructor(message: string, status: number, code?: number, subcode?: number) {
    super(message);
    this.name = "GraphError";
    this.status = status;
    this.code = code;
    this.subcode = subcode;
  }
}

/**
 * What a failed call means for the message behind it:
 * - "retry":     Instagram didn't answer or failed inside (network error,
 *                timeout, HTTP 5xx, codes 1 and 2). Trying again soon may work.
 * - "limit":     Meta says slow down: a rate limit (codes 4, 17, 32, 613, the
 *                80000s, "too many actions" 9, HTTP 429) or a block on the
 *                account (341, 368, messaging restricted 10/1893063, blocked
 *                from messaging 100/2534029). Nothing more should go out for
 *                a while.
 * - "token":     the access token was turned away (190, 102). Nothing can go
 *                out until a new one is set.
 * - "permanent": Meta refused this very message: the comment is gone or can't
 *                take a private reply (100/2534025), the person can't be
 *                messaged (551, 200/1545041)… Trying again soon won't help.
 * The codes are from Meta's "Rate Limits", "Handle Errors" and Messenger
 * "Error Codes" pages. Anything not listed counts as permanent, so an unknown
 * error is never retried without end.
 */
export type Failure = "retry" | "limit" | "token" | "permanent";

const LIMIT_CODES = new Set([4, 9, 17, 32, 341, 368, 613]);
/** "You are temporarily restricted from sending messages", "The business has been blocked from sending messages". */
const ACCOUNT_BLOCKED = new Set([1893063, 2534029]);
/** How a connection fails when it was never made: nothing was sent. */
const NEVER_CONNECTED = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);

export function failureKind(e: unknown): Failure {
  if (!(e instanceof GraphError)) return "permanent";
  const { status, code = 0, subcode } = e;
  if (code === 190 || code === 102) return "token";
  if (status === 429 || LIMIT_CODES.has(code) || (code >= 80000 && code <= 80014) || ACCOUNT_BLOCKED.has(subcode ?? 0)) {
    return "limit";
  }
  if (e.transient || code === 1 || code === 2 || status === 0 || status >= 500) return "retry";
  return "permanent";
}

/** A failure in one line, for the log and the alerts. */
export function describe(e: unknown): string {
  if (e instanceof GraphError) {
    if (!e.status) return e.message;
    const code = e.code ? `, code ${e.code}${e.subcode ? `/${e.subcode}` : ""}` : "";
    return `${e.message} (HTTP ${e.status}${code})`;
  }
  return e instanceof Error ? e.message : String(e);
}

/**
 * Minutes until Meta lifts a rate limit, from "estimated_time_to_regain_access"
 * in its X-Business-Use-Case-Usage header. 0 when the header doesn't say.
 */
function regainMinutes(headers: Headers): number {
  try {
    const usage = JSON.parse(headers.get("x-business-use-case-usage") ?? "{}") as Record<string, unknown>;
    const entries = Object.values(usage).flat() as { estimated_time_to_regain_access?: unknown }[];
    return Math.max(0, ...entries.map((entry) => Number(entry?.estimated_time_to_regain_access) || 0));
  } catch {
    return 0;
  }
}

type Query = Record<string, string>;
/** `body` goes as JSON, `form` as a form (what the publishing calls were tried with); `timeout` is in milliseconds. */
type Options = { query?: Query; body?: unknown; form?: Record<string, string>; timeout?: number };
type ErrorBody = { error?: { message?: string; code?: number; error_subcode?: number; is_transient?: boolean } };

/** One call, one try. */
async function request<T>(method: "GET" | "POST", pathOrUrl: string, options: Options): Promise<T> {
  const token = currentToken();
  if (!token) throw new GraphError("IG_ACCESS_TOKEN is not set", 0, 190);

  const url = new URL(pathOrUrl.startsWith("http") ? pathOrUrl : baseFor(token) + pathOrUrl);
  for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value);

  // Without a time limit, a connection that hangs would hold its place in the
  // queue for five minutes (fetch's own limit).
  const timeout = options.timeout ?? config.graphTimeout;
  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(options.body ? { "content-type": "application/json" } : {}),
    },
    body: options.form ? new URLSearchParams(options.form) : options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(timeout),
  }).catch((e: unknown) => {
    const timedOut = e instanceof Error && e.name === "TimeoutError";
    const cause = e instanceof Error && e.cause instanceof Error ? e.cause : undefined;
    const why = timedOut ? `${timeout / 1000} s passed` : (cause?.message ?? (e instanceof Error ? e.message : String(e)));
    const error = new GraphError(`no answer from Instagram (${why})`, 0);
    error.maybeSent = !NEVER_CONNECTED.has((cause as { code?: string } | undefined)?.code ?? "");
    throw error;
  });

  const data = (await response.json().catch(() => null)) as (T & ErrorBody) | null;
  if (!response.ok || data?.error) {
    const e = data?.error ?? {};
    const error = new GraphError(e.message ?? `HTTP ${response.status}`, response.status, e.code, e.error_subcode);
    error.transient = e.is_transient === true;
    error.regainMinutes = regainMinutes(response.headers);
    // A 5xx without Meta's own error in it came from something on the way, which can't say what happened behind it.
    error.maybeSent = response.status >= 500 && !data?.error;
    throw error;
  }
  // A list cut off mid-answer must not pass for an empty one: the sweep would take it for the end.
  if (data === null && method === "GET") throw new GraphError("unreadable answer from Instagram", 0);
  return (data ?? {}) as T;
}

/**
 * A call to the API. Reading twice does no harm, so a read that failed for a
 * passing reason is tried again right here. A send is not: the queue retries
 * those, and it knows what has already gone out.
 */
async function call<T>(method: "GET" | "POST", pathOrUrl: string, options: Options = {}): Promise<T> {
  for (let tries = 0; ; tries++) {
    try {
      return await request<T>(method, pathOrUrl, options);
    } catch (e) {
      if (method !== "GET" || tries >= READ_RETRIES.length || failureKind(e) !== "retry") throw e;
      await new Promise((resolve) => setTimeout(resolve, READ_RETRIES[tries]));
    }
  }
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

/** A list, one page at a time, following its "next" links. Stop reading and no more pages are fetched. */
async function* pages<T>(path: string, query: Query): AsyncGenerator<T[]> {
  let page = await call<Page<T>>("GET", path, { query });
  for (;;) {
    yield page.data ?? [];
    if (!page.paging?.next) return;
    page = await call<Page<T>>("GET", page.paging.next);
  }
}

/** Every item of a list, up to `max` items. */
async function all<T>(path: string, query: Query, max: number): Promise<T[]> {
  const items: T[] = [];
  for await (const page of pages<T>(path, query)) {
    items.push(...page);
    if (items.length >= max) break;
  }
  return items.slice(0, max);
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

/**
 * A post's top-level comments with the replies under each, 50 to a page
 * (Meta's most), newest first. Meta's reference for this list says "reverse
 * chronological order" and that comments can't be filtered by time, so the
 * caller reads from the top and stops when it has gone far enough back.
 */
export function commentPages(mediaId: string): AsyncGenerator<Comment[]> {
  return pages<Comment>(`/${mediaId}/comments`, {
    fields: "id,text,timestamp,username,from,replies{id,text,timestamp,username,from}",
    limit: "50",
  });
}

/**
 * Publishing a reel, in the calls and parameters a real one went out with on
 * 18 November 2026 (with the script kept here as
 * scripts/post-reel.mjs): a container, the file sent to the address the
 * container gives, a wait until Instagram has processed it, then the publish.
 * posts.ts decides when each happens.
 */

export type Reel = {
  caption: string;
  shareToFeed: boolean;
  /** Instagram's "AI info" label on the post. */
  aiLabel: boolean;
  /** The cover: a frame of the video, in milliseconds from its start, or a JPEG at a public address. */
  thumbOffset?: number;
  coverUrl?: string;
};

/** Opens a container for a reel. It answers with the container's id and the address its file goes to; it expires after 24 hours. */
export function createReelContainer(reel: Reel) {
  const form: Record<string, string> = {
    media_type: "REELS",
    upload_type: "resumable",
    caption: reel.caption,
    share_to_feed: String(reel.shareToFeed),
  };
  if (reel.aiLabel) form.is_ai_generated = "true";
  if (reel.coverUrl) form.cover_url = reel.coverUrl;
  else if (reel.thumbOffset !== undefined) form.thumb_offset = String(reel.thumbOffset);
  return call<{ id?: string; uri?: string }>("POST", `/${account()}/media`, { form });
}

/** A container goes IN_PROGRESS → FINISHED (ready to publish) → PUBLISHED, or ends in ERROR or EXPIRED. */
export type ContainerStatus = { status_code?: string; status?: string };

export function containerStatus(containerId: string) {
  return call<ContainerStatus>("GET", `/${containerId}`, { query: { fields: "status_code,status" } });
}

/**
 * Makes a container public, and answers with the new post's id. Not a call
 * to repeat on a guess: when it fails, ask containerStatus() what happened.
 */
export function publishContainer(containerId: string) {
  return call<{ id?: string }>("POST", `/${account()}/media_publish`, { form: { creation_id: containerId }, timeout: MINUTE });
}

export async function getPermalink(mediaId: string): Promise<string> {
  const media = await call<{ permalink?: string }>("GET", `/${mediaId}`, { query: { fields: "permalink" } });
  return media.permalink ?? "";
}

/**
 * Sends a reel's file to the address its container gave. It goes from the
 * disk as a stream with its length announced up front, which is how Meta's
 * example sends it: the whole file never sits in memory. (fetch can't do
 * that: given a file it reads all of it first.)
 */
export async function sendVideo(uri: string, file: string, size: number): Promise<void> {
  const token = currentToken();
  if (!token) throw new GraphError("IG_ACCESS_TOKEN is not set", 0, 190);

  const answer = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const send = uri.startsWith("https:") ? httpsRequest : httpRequest;
    const headers = { Authorization: `OAuth ${token}`, offset: "0", file_size: String(size), "Content-Type": "application/octet-stream", "Content-Length": size };
    const req = send(uri, { method: "POST", headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      res.on("error", reject);
    });
    // A minute with nothing moving in either direction, not a limit on the whole upload.
    req.setTimeout(MINUTE, () => req.destroy(new Error("nothing moved for a minute")));
    req.on("error", reject);
    pipeline(createReadStream(file), req).catch(reject);
  }).catch((e: unknown) => {
    const error = new GraphError(`the video didn't get through to Instagram (${e instanceof Error ? e.message : e})`, 0);
    error.maybeSent = true;
    throw error;
  });

  if (answer.status >= 200 && answer.status < 300 && /"success"\s*:\s*true/.test(answer.body)) return;
  let said: ErrorBody["error"] & { debug_info?: { message?: string } } = {};
  try {
    const json = JSON.parse(answer.body) as ErrorBody & { debug_info?: { message?: string } };
    said = { ...json.error, debug_info: json.debug_info };
  } catch {
    // not JSON: the status has to do
  }
  const message = said.message ?? said.debug_info?.message ?? answer.body.slice(0, 200);
  throw new GraphError(`Instagram didn't take the video: ${message || `HTTP ${answer.status}`}`, answer.status, said.code, said.error_subcode);
}
