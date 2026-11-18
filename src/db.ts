import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config, DAY, MINUTE } from "./config.ts";

/**
 * The bot's memory: one SQLite file (on Railway, on a volume mounted at /data).
 * - comments: every keyword comment the bot has seen, one row each, ever. That
 *   one row is why a webhook retry or the sweep can't cause a second private
 *   reply;
 * - deliveries: every giveaway asked for with a tap or a keyword DM;
 * - seen: the ids of the DMs that asked for one, for two days, so a webhook
 *   Meta delivers twice counts once;
 * - calls: when each private reply and public reply was made, to stay inside
 *   an hourly limit;
 * - posts: the reels scheduled for publishing, and how far each has got
 *   (instagram/posts.ts);
 * - kv: what the bot learns as it runs, like the refreshed access token.
 *
 * comments and deliveries are also the line of messages waiting to go out
 * (queue.ts works it off), so a restart loses nothing. A row's status goes
 *   waiting → sending → sent
 *                     → waiting again, until due_at (a failure that may pass)
 *                     → failed (Meta refused it, or its time ran out)
 * While a row is 'sending', due_at is when the bot stops believing it: a send
 * takes seconds, so a row still 'sending' two minutes on belongs to a process
 * that died mid-send. A comment is then taken up again (Instagram allows one
 * private reply per comment, so it can't arrive twice). A giveaway is not: it
 * may have arrived, and nothing would stop a second one.
 *
 * Node runs one callback at a time and nothing here awaits, so two callers
 * can't both queue or both take the same row.
 *
 * Rows older than KEEP are deleted (the privacy page says so).
 */

const LEASE = 2 * MINUTE;
const DOUBLE_TAP = 2 * MINUTE;
export const KEEP = 90 * DAY;

let db: DatabaseSync | undefined;

export function openDb(path = config.dbPath): void {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS comments (
      comment_id TEXT PRIMARY KEY,
      media_id TEXT NOT NULL,
      username TEXT NOT NULL,
      keyword TEXT NOT NULL,
      parent_id TEXT,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL,
      strikes INTEGER NOT NULL DEFAULT 0,
      due_at INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      keyword TEXT NOT NULL,
      via TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      due_at INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS deliveries_by_user ON deliveries (user_id, keyword, created_at);
    CREATE TABLE IF NOT EXISTS seen (mid TEXT PRIMARY KEY, at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS calls (kind TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS calls_by_time ON calls (kind, at);
    CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      caption TEXT NOT NULL,
      publish_at INTEGER NOT NULL,
      thumb_offset INTEGER,
      cover_url TEXT,
      ai_label INTEGER NOT NULL,
      share_to_feed INTEGER NOT NULL,
      file TEXT,
      size INTEGER,
      state TEXT NOT NULL,
      container_id TEXT,
      container_at INTEGER,
      publishing_at INTEGER,
      media_id TEXT,
      permalink TEXT,
      error TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      due_at INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  // A file made before the queue existed lacks these columns. Its rows keep
  // their meaning: 'sent' and 'failed' stay as they are, and a row that a
  // process left 'sending' when it died is dealt with like any other.
  addColumn("comments", "parent_id", "TEXT");
  addColumn("comments", "strikes", "INTEGER NOT NULL DEFAULT 0");
  addColumn("comments", "due_at", "INTEGER NOT NULL DEFAULT 0");
  addColumn("deliveries", "attempts", "INTEGER NOT NULL DEFAULT 0");
  addColumn("deliveries", "due_at", "INTEGER NOT NULL DEFAULT 0");
  db.exec(`
    CREATE INDEX IF NOT EXISTS comments_in_line ON comments (status, due_at);
    CREATE INDEX IF NOT EXISTS deliveries_in_line ON deliveries (status, due_at);
  `);
}

function addColumn(table: "comments" | "deliveries", column: string, type: string): void {
  const exists = conn().prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name = ?`).get(column);
  if (!exists) conn().exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

export function closeDb(): void {
  db?.close();
  db = undefined;
}

function conn(): DatabaseSync {
  if (!db) throw new Error("call openDb() first");
  return db;
}

export function kvGet(key: string): string | undefined {
  const row = conn().prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

export function kvSet(key: string, value: string): void {
  conn()
    .prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
    .run(key, value);
}

export type CommentJob = {
  commentId: string;
  mediaId: string;
  username: string;
  keyword: string;
  /** Set when the comment is itself a reply: the public reply goes under this top-level comment. */
  parentId?: string;
  /** When the comment was made. The sweep knows; a webhook means "just now". */
  at?: number;
};

/** A comment taken from the line for one try. */
export type QueuedComment = CommentJob & {
  at: number;
  /** Tries so far, this one included. */
  attempts: number;
  /** How many of the earlier tries counted against the comment itself. Three and it's given up. */
  strikes: number;
};

/**
 * Puts a keyword comment in line for its teaser. False when the bot already
 * knows the comment, whatever became of it: a comment is queued once, ever.
 */
export function queueComment(c: CommentJob, now = Date.now()): boolean {
  const at = c.at !== undefined && c.at <= now ? c.at : now;
  const result = conn()
    .prepare(`
      INSERT INTO comments (comment_id, media_id, username, keyword, parent_id, status, attempts, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'waiting', 0, ?, ?)
      ON CONFLICT (comment_id) DO NOTHING
    `)
    .run(c.commentId, c.mediaId, c.username, c.keyword, c.parentId ?? null, at, now);
  return Number(result.changes) === 1;
}

/** Where a comment stands ('waiting', 'sending', 'sent', 'failed'), or undefined when the bot has never seen it. */
export function commentStatus(commentId: string): string | undefined {
  const row = conn().prepare("SELECT status FROM comments WHERE comment_id = ?").get(commentId) as { status: string } | undefined;
  return row?.status;
}

/** Takes up to `max` comments from the line for a try, the oldest comment first. */
export function claimComments(max: number, now = Date.now()): QueuedComment[] {
  if (!(max >= 1)) return [];
  const rows = conn()
    .prepare(`
      UPDATE comments SET status = 'sending', attempts = attempts + 1, due_at = ?, updated_at = ?
      WHERE comment_id IN (
        SELECT comment_id FROM comments
        WHERE status IN ('waiting', 'sending') AND due_at <= ?
        ORDER BY created_at, comment_id LIMIT ?
      )
      RETURNING comment_id, media_id, username, keyword, parent_id, attempts, strikes, created_at
    `)
    .all(now + LEASE, now, now, Math.floor(max)) as {
    comment_id: string;
    media_id: string;
    username: string;
    keyword: string;
    parent_id: string | null;
    attempts: number;
    strikes: number;
    created_at: number;
  }[];
  return rows
    .sort((a, b) => a.created_at - b.created_at)
    .map((r) => ({
      commentId: r.comment_id,
      mediaId: r.media_id,
      username: r.username,
      keyword: r.keyword,
      parentId: r.parent_id ?? undefined,
      at: r.created_at,
      attempts: r.attempts,
      strikes: r.strikes,
    }));
}

type Outcome = {
  error?: string;
  /** For a row that goes back to waiting: when to try it again. */
  dueAt?: number;
  /** The try counts against the comment itself. */
  strike?: boolean;
};

/** Records how a comment's try ended. */
export function settleComment(commentId: string, status: "sent" | "waiting" | "failed", outcome: Outcome = {}, now = Date.now()): void {
  conn()
    .prepare("UPDATE comments SET status = ?, error = ?, due_at = ?, strikes = strikes + ?, updated_at = ? WHERE comment_id = ?")
    .run(status, outcome.error ?? null, outcome.dueAt ?? 0, outcome.strike ? 1 : 0, now, commentId);
}

export type Requeued = { commentId: string; username: string; keyword: string; error: string | null };

/**
 * Puts the comments that were given up since `since` back in line, with a
 * clean slate. For after something that wasn't about the comments is fixed
 * (a permission, a block on the account): your call, never the bot's.
 */
export function requeueFailed(since: number, now = Date.now()): Requeued[] {
  const rows = conn()
    .prepare(`
      UPDATE comments SET status = 'waiting', attempts = 0, strikes = 0, due_at = 0, updated_at = ?
      WHERE status = 'failed' AND created_at >= ?
      RETURNING comment_id, username, keyword, error
    `)
    .all(now, since) as { comment_id: string; username: string; keyword: string; error: string | null }[];
  return rows.map((r) => ({ commentId: r.comment_id, username: r.username, keyword: r.keyword, error: r.error }));
}

/** A giveaway taken from the line for one try. */
export type QueuedDelivery = { id: number; userId: string; keyword: string; via: string; at: number; attempts: number };

/**
 * True the first time a DM's id is seen, false when Meta is delivering the
 * same message again (it does, for up to 36 hours, when it didn't get its 200).
 */
export function firstTime(mid: string, now = Date.now()): boolean {
  const result = conn().prepare("INSERT INTO seen (mid, at) VALUES (?, ?) ON CONFLICT (mid) DO NOTHING").run(mid, now);
  return Number(result.changes) === 1;
}

/**
 * Puts a giveaway in line and returns its id. Null when there's nothing to
 * add: the person's giveaway is still on its way, or they got it in the last
 * two minutes (a double tap).
 */
export function queueDelivery(userId: string, keyword: string, via: string, now = Date.now()): number | null {
  const known = conn()
    .prepare(`
      SELECT 1 FROM deliveries
      WHERE user_id = ? AND keyword = ? AND (status IN ('waiting', 'sending') OR (status = 'sent' AND created_at > ?))
    `)
    .get(userId, keyword, now - DOUBLE_TAP);
  if (known) return null;
  const result = conn()
    .prepare("INSERT INTO deliveries (user_id, keyword, via, status, attempts, created_at) VALUES (?, ?, ?, 'waiting', 0, ?)")
    .run(userId, keyword, via, now);
  return Number(result.lastInsertRowid);
}

/**
 * Gives up the giveaways a process was sending when it died (their two
 * minutes are over), and returns how many. One of them may have arrived, and
 * nothing at Instagram would stop a second copy, so it isn't sent again; the
 * person can ask again.
 */
export function failCutOffDeliveries(now = Date.now()): number {
  const result = conn()
    .prepare("UPDATE deliveries SET status = 'failed', error = 'cut off by a restart: it may have arrived, so it is not sent again' WHERE status = 'sending' AND due_at <= ?")
    .run(now);
  return Number(result.changes);
}

/**
 * Takes up to `max` giveaways from the line for a try, the oldest first. One
 * person's giveaways go one at a time and in the order asked for: a later one
 * waits while an earlier one of theirs is still waiting or being sent.
 */
export function claimDeliveries(max: number, now = Date.now()): QueuedDelivery[] {
  if (!(max >= 1)) return [];
  const rows = conn()
    .prepare(`
      UPDATE deliveries SET status = 'sending', attempts = attempts + 1, due_at = ?
      WHERE id IN (
        SELECT d.id FROM deliveries d
        WHERE d.status = 'waiting' AND d.due_at <= ?
          AND NOT EXISTS (
            SELECT 1 FROM deliveries earlier
            WHERE earlier.user_id = d.user_id AND earlier.id < d.id AND earlier.status IN ('waiting', 'sending')
          )
        ORDER BY d.id LIMIT ?
      )
      RETURNING id, user_id, keyword, via, attempts, created_at
    `)
    .all(now + LEASE, now, Math.floor(max)) as { id: number; user_id: string; keyword: string; via: string; attempts: number; created_at: number }[];
  return rows
    .sort((a, b) => a.id - b.id)
    .map((r) => ({ id: r.id, userId: r.user_id, keyword: r.keyword, via: r.via, at: r.created_at, attempts: r.attempts }));
}

/** Records how a giveaway's try ended. */
export function settleDelivery(id: number, status: "sent" | "waiting" | "failed", outcome: Outcome = {}): void {
  conn()
    .prepare("UPDATE deliveries SET status = ?, error = ?, due_at = ? WHERE id = ?")
    .run(status, outcome.error ?? null, outcome.dueAt ?? 0, id);
}

export type CallKind = "private_reply" | "public_reply";

/** Notes a call that counts toward an hourly limit. */
export function noteCall(kind: CallKind, now = Date.now()): void {
  conn().prepare("INSERT INTO calls (kind, at) VALUES (?, ?)").run(kind, now);
}

/** How many calls of a kind were made after `since`. */
export function callsSince(kind: CallKind, since: number): number {
  const row = conn().prepare("SELECT COUNT(*) AS count FROM calls WHERE kind = ? AND at > ?").get(kind, since) as { count: number };
  return row.count;
}

/** How many messages are in line: teasers and giveaways not yet sent. */
export function inLine(): { comments: number; deliveries: number } {
  const count = (table: "comments" | "deliveries") =>
    (conn().prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE status IN ('waiting', 'sending')`).get() as { count: number }).count;
  return { comments: count("comments"), deliveries: count("deliveries") };
}

/** Counts per keyword and status: teasers (waiting, sent, failed), giveaways by button tap or keyword DM. */
export function stats() {
  return {
    comments: conn().prepare("SELECT keyword, status, COUNT(*) AS count FROM comments GROUP BY keyword, status ORDER BY keyword").all(),
    deliveries: conn()
      .prepare("SELECT keyword, via, status, COUNT(*) AS count FROM deliveries GROUP BY keyword, via, status ORDER BY keyword")
      .all(),
  };
}

export function prune(now = Date.now()): void {
  conn().prepare("DELETE FROM comments WHERE created_at < ?").run(now - KEEP);
  conn().prepare("DELETE FROM deliveries WHERE created_at < ?").run(now - KEEP);
  conn().prepare("DELETE FROM calls WHERE at < ?").run(now - DAY);
  conn().prepare("DELETE FROM seen WHERE at < ?").run(now - 2 * DAY);
  conn().prepare("DELETE FROM posts WHERE state IN ('published', 'failed', 'missed', 'cancelled') AND publish_at < ?").run(now - KEEP);
}

/**
 * A reel to publish at a set time. Its state says how far it has got:
 *   scheduled → uploading → processing → ready → publishing → published
 * or it ends as failed, missed (the bot was down past its time) or cancelled.
 * instagram/posts.ts explains each step.
 */
export type PostState = "scheduled" | "uploading" | "processing" | "ready" | "publishing" | "published" | "failed" | "missed" | "cancelled";

export type Post = {
  id: number;
  caption: string;
  publishAt: number;
  thumbOffset: number | null;
  coverUrl: string | null;
  aiLabel: boolean;
  shareToFeed: boolean;
  /** The video's name in the posts folder, until the post is over. */
  file: string | null;
  size: number | null;
  state: PostState;
  containerId: string | null;
  /** When the container was made: Instagram drops it 24 hours later. */
  containerAt: number | null;
  /** When the bot last told Instagram to publish it. */
  publishingAt: number | null;
  mediaId: string | null;
  permalink: string | null;
  error: string | null;
  attempts: number;
  /** The timer leaves the post alone until then. */
  dueAt: number;
  createdAt: number;
  updatedAt: number;
};

const POST_COLUMNS = {
  file: "file",
  size: "size",
  state: "state",
  containerId: "container_id",
  containerAt: "container_at",
  publishingAt: "publishing_at",
  mediaId: "media_id",
  permalink: "permalink",
  error: "error",
  attempts: "attempts",
  dueAt: "due_at",
} as const;

export type PostChanges = Partial<Pick<Post, keyof typeof POST_COLUMNS>>;

function toPost(r: Record<string, unknown>): Post {
  return {
    id: r.id as number,
    caption: r.caption as string,
    publishAt: r.publish_at as number,
    thumbOffset: r.thumb_offset as number | null,
    coverUrl: r.cover_url as string | null,
    aiLabel: r.ai_label === 1,
    shareToFeed: r.share_to_feed === 1,
    file: r.file as string | null,
    size: r.size as number | null,
    state: r.state as PostState,
    containerId: r.container_id as string | null,
    containerAt: r.container_at as number | null,
    publishingAt: r.publishing_at as number | null,
    mediaId: r.media_id as string | null,
    permalink: r.permalink as string | null,
    error: r.error as string | null,
    attempts: r.attempts as number,
    dueAt: r.due_at as number,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  };
}

export function addPost(
  post: { caption: string; publishAt: number; thumbOffset?: number; coverUrl?: string; aiLabel: boolean; shareToFeed: boolean },
  now = Date.now(),
): number {
  const result = conn()
    .prepare(`
      INSERT INTO posts (caption, publish_at, thumb_offset, cover_url, ai_label, share_to_feed, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'scheduled', ?, ?)
    `)
    .run(post.caption, post.publishAt, post.thumbOffset ?? null, post.coverUrl ?? null, post.aiLabel ? 1 : 0, post.shareToFeed ? 1 : 0, now, now);
  return Number(result.lastInsertRowid);
}

export function getPost(id: number): Post | undefined {
  const row = conn().prepare("SELECT * FROM posts WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row && toPost(row);
}

/** Every post, the next to go out first, then the ones that are over, newest first. */
export function listPosts(): Post[] {
  const rows = conn()
    .prepare(`
      SELECT * FROM posts
      ORDER BY state IN ('published', 'failed', 'missed', 'cancelled'), CASE WHEN state IN ('published', 'failed', 'missed', 'cancelled') THEN -publish_at ELSE publish_at END
    `)
    .all() as Record<string, unknown>[];
  return rows.map(toPost);
}

/** The posts the timer has work on now, the earliest first. */
export function postsInHand(now = Date.now()): Post[] {
  const rows = conn()
    .prepare("SELECT * FROM posts WHERE state IN ('scheduled', 'uploading', 'processing', 'ready', 'publishing') AND due_at <= ? ORDER BY publish_at, id")
    .all(now) as Record<string, unknown>[];
  return rows.map(toPost);
}

/**
 * Changes a post, but only while it is in the state (or one of the states)
 * the caller saw it in. False when it has moved on meanwhile: cancelled while
 * its video was uploading, say. That is what keeps a cancelled post from
 * being published by a step that was already under way.
 */
export function changePost(id: number, from: PostState | PostState[], changes: PostChanges, now = Date.now()): boolean {
  const keys = Object.keys(changes) as (keyof typeof POST_COLUMNS)[];
  const states = [from].flat();
  const sets = [...keys.map((key) => `${POST_COLUMNS[key]} = ?`), "updated_at = ?"].join(", ");
  const result = conn()
    .prepare(`UPDATE posts SET ${sets} WHERE id = ? AND state IN (${states.map(() => "?").join(", ")})`)
    .run(...keys.map((key) => changes[key] ?? null), now, id, ...states);
  return Number(result.changes) === 1;
}
