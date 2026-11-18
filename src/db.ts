import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config, DAY, MINUTE } from "./config.ts";

/**
 * The bot's memory: one SQLite file (on Railway, on a volume mounted at /data).
 * - comments: every keyword comment the bot answered or tried to, so a webhook
 *   retry or the sweep never sends a second private reply;
 * - deliveries: every giveaway sent after a tap or a keyword DM (stats, and no
 *   double send on a double tap);
 * - kv: what the bot learns as it runs, like the refreshed access token.
 * Rows older than KEEP are deleted (the privacy page says so).
 */

const MAX_ATTEMPTS = 3;
const STUCK = 10 * MINUTE;
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
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL,
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
      error TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS deliveries_by_user ON deliveries (user_id, keyword, created_at);
    CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
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
};

/**
 * True when this caller may answer the comment: it's new, or an earlier try
 * failed (three tries at most), or a try got stuck. Node runs one callback at a
 * time and this has no await inside, so two callers can't both win.
 */
export function claimComment(c: CommentJob, now = Date.now()): boolean {
  const result = conn()
    .prepare(`
      INSERT INTO comments (comment_id, media_id, username, keyword, status, attempts, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'sending', 1, ?, ?)
      ON CONFLICT (comment_id) DO UPDATE SET status = 'sending', attempts = attempts + 1, updated_at = excluded.updated_at
      WHERE (comments.status = 'failed' AND comments.attempts < ?)
         OR (comments.status = 'sending' AND comments.updated_at < ?)
    `)
    .run(c.commentId, c.mediaId, c.username, c.keyword, now, now, MAX_ATTEMPTS, now - STUCK);
  return Number(result.changes) === 1;
}

export function finishComment(commentId: string, ok: boolean, error?: string): void {
  conn()
    .prepare("UPDATE comments SET status = ?, error = ?, updated_at = ? WHERE comment_id = ?")
    .run(ok ? "sent" : "failed", error ?? null, Date.now(), commentId);
}

/** Whether a comment needs no more work: answered, out of tries, or being answered right now. */
export function commentSettled(commentId: string, now = Date.now()): boolean {
  const row = conn()
    .prepare("SELECT status, attempts, updated_at FROM comments WHERE comment_id = ?")
    .get(commentId) as { status: string; attempts: number; updated_at: number } | undefined;
  if (!row) return false;
  if (row.status === "sent") return true;
  if (row.status === "failed") return row.attempts >= MAX_ATTEMPTS;
  return row.updated_at >= now - STUCK;
}

/** Starts a delivery and returns its id, or null when this person got this giveaway in the last two minutes. */
export function claimDelivery(userId: string, keyword: string, via: string, now = Date.now()): number | null {
  const recent = conn()
    .prepare("SELECT 1 FROM deliveries WHERE user_id = ? AND keyword = ? AND status != 'failed' AND created_at > ?")
    .get(userId, keyword, now - DOUBLE_TAP);
  if (recent) return null;
  const result = conn()
    .prepare("INSERT INTO deliveries (user_id, keyword, via, status, created_at) VALUES (?, ?, ?, 'sending', ?)")
    .run(userId, keyword, via, now);
  return Number(result.lastInsertRowid);
}

export function finishDelivery(id: number, ok: boolean, error?: string): void {
  conn()
    .prepare("UPDATE deliveries SET status = ?, error = ? WHERE id = ?")
    .run(ok ? "sent" : "failed", error ?? null, id);
}

/** Counts per keyword: private replies sent or failed, giveaways delivered by button tap or keyword DM. */
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
}
