import { DAY, HOUR } from "../config.ts";
import { commentSettled, kvGet } from "../db.ts";
import { answerComment, ownAccount, rememberCaption } from "./bot.ts";
import { KEYWORDS } from "./giveaways.ts";
import { listComments, listMedia } from "./graph.ts";
import { captionKeywords, mentions, parseTime } from "./match.ts";

/**
 * Looks through recent posts for keyword comments nobody has answered. The bot
 * runs it every SWEEP_MINUTES, so a comment the webhook missed still gets its
 * DM (Meta's docs disagree on whether an app like this one receives comment
 * webhooks at all), and /admin/backfill runs it on demand for comments from
 * before the bot existed.
 *
 * Instagram allows a private reply up to 7 days after the comment, so older
 * comments are left out, with an hour to spare.
 */

const WINDOW = 7 * DAY - HOUR;
const POSTS = 30;
const COMMENTS_PER_POST = 500;
/** The regular sweep only reads posts from the last two weeks; a backfill reads all 30. */
const SWEEP_POST_AGE = 14 * DAY;

export type Pending = {
  commentId: string;
  mediaId: string;
  permalink: string;
  keyword: string;
  username: string;
  text: string;
  at: string;
  /** For a reply in a thread: the top-level comment, where the public reply goes. */
  parentId?: string;
};

export async function findPending(since: number, maxPostAge: number, now = Date.now()): Promise<Pending[]> {
  const own = await ownAccount();
  const pending: Pending[] = [];
  for (const post of await listMedia(POSTS)) {
    if (now - parseTime(post.timestamp ?? "") > maxPostAge) continue;
    if (post.comments_count === 0) continue;
    const keywords = captionKeywords(post.caption ?? "", KEYWORDS);
    rememberCaption(post.id, keywords, now);
    if (keywords.length === 0) continue;

    const comments = (await listComments(post.id, COMMENTS_PER_POST)).flatMap((top) => [
      { ...top, parentId: undefined as string | undefined },
      ...(top.replies?.data ?? []).map((reply) => ({ ...reply, parentId: top.id })),
    ]);
    for (const c of comments) {
      const time = parseTime(c.timestamp ?? "");
      if (!(time >= since) || now - time > WINDOW) continue;
      const username = c.from?.username ?? c.username ?? "";
      if ((own.id && c.from?.id === own.id) || (own.username && username === own.username)) continue;
      const keyword = keywords.find((k) => mentions(c.text ?? "", k));
      if (!keyword || commentSettled(c.id, now)) continue;
      pending.push({
        commentId: c.id,
        mediaId: post.id,
        permalink: post.permalink ?? "",
        keyword,
        username,
        text: c.text ?? "",
        at: c.timestamp ?? "",
        parentId: c.parentId,
      });
    }
  }
  return pending;
}

let running = false;

/** Answers keyword comments made since the bot first started that the webhook missed. */
export async function sweep(): Promise<string[]> {
  if (running) return [];
  running = true;
  try {
    const since = Number(kvGet("sweep_since") ?? Date.now());
    const results: string[] = [];
    for (const job of await findPending(since, SWEEP_POST_AGE)) results.push(await answerComment(job));
    for (const r of results) console.log(`sweep: ${r}`);
    return results;
  } finally {
    running = false;
  }
}

export type BackfillResult =
  | { mode: "preview"; count: number; pending: Pending[] }
  | { mode: "sent"; count: number; results: (Pending & { result: string })[] };

/**
 * Keyword comments from the last `days` days (7 at most) with no answer yet,
 * across the last 30 posts. With `send`, each gets its teaser; without, it's a
 * preview. `skip` holds usernames already handled by hand.
 */
export async function backfill(days: number, skip: ReadonlySet<string>, send: boolean): Promise<BackfillResult> {
  const since = Date.now() - Math.min(days, 7) * DAY;
  const pending = (await findPending(since, Number.POSITIVE_INFINITY)).filter((p) => !skip.has(p.username.toLowerCase()));
  if (!send) return { mode: "preview", count: pending.length, pending };
  const results: (Pending & { result: string })[] = [];
  for (const job of pending) {
    results.push({ ...job, result: await answerComment(job) });
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return { mode: "sent", count: pending.length, results };
}
