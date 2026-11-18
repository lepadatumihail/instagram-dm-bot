import { alert } from "../alert.ts";
import { DAY, HOUR, MINUTE } from "../config.ts";
import { commentStatus, kvGet, kvSet } from "../db.ts";
import { ownAccount, rememberCaption } from "./bot.ts";
import { KEYWORDS } from "./giveaways.ts";
import { type Media, commentPages, listMedia } from "./graph.ts";
import { captionKeywords, mentions, parseTime } from "./match.ts";
import { answerComment, REPLY_WINDOW } from "./queue.ts";

/**
 * Looks through recent posts for keyword comments nobody has answered. The bot
 * runs it every SWEEP_MINUTES, so a comment the webhook missed still gets its
 * DM (Meta's docs disagree on whether an app like this one receives comment
 * webhooks at all), and /admin/backfill runs it on demand for comments from
 * before the bot existed.
 *
 * Instagram allows a private reply up to 7 days after the comment, so older
 * comments are left out, with an hour to spare (REPLY_WINDOW).
 *
 * The sweep only finds: what it finds goes in line like a comment from a
 * webhook, and queue.ts sends it.
 *
 * How a post is read. Instagram lists a post's comments newest first, 50 a
 * page, and can't be asked for the comments since a time (its reference for
 * this list says both). So:
 * - every sweep reads from the top down to where the last one started, which
 *   is one page on a quiet post and only the new comments on a busy one;
 * - once an hour it reads the whole post instead, however long. That finds a
 *   keyword written as a reply in an older thread, and it doesn't depend on
 *   the order, in case Instagram's isn't always what the reference says.
 * So a post with thousands of comments is covered without being read in full
 * every ten minutes.
 */

const POSTS = 30;
/** The regular sweep only reads posts from the last two weeks; a backfill reads all 30. */
const SWEEP_POST_AGE = 14 * DAY;
/** How often the sweep reads a whole post rather than only its new comments. */
const WHOLE_POST_EVERY = HOUR;
/** A read goes this far past the newest comment the last one saw, in case Instagram listed a comment late. */
const OVERLAP = 5 * MINUTE;
/** Where the read of one post stops, whatever happens: 400 pages are 20,000 comments. */
const MAX_PAGES = 400;

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

type KeywordPost = { post: Media; keywords: string[] };
type Account = { id: string; username: string };

/** The latest posts that have comments and whose caption asks for a keyword. */
async function keywordPosts(maxAge: number, now: number): Promise<KeywordPost[]> {
  const posts: KeywordPost[] = [];
  for (const post of await listMedia(POSTS)) {
    if (now - parseTime(post.timestamp ?? "") > maxAge) continue;
    if (post.comments_count === 0) continue;
    const keywords = captionKeywords(post.caption ?? "", KEYWORDS);
    rememberCaption(post.id, keywords, now);
    if (keywords.length > 0) posts.push({ post, keywords });
  }
  return posts;
}

/**
 * Reads a post's comments from the newest down and hands each page's keyword
 * comments that the bot has never seen to `found`, page by page, so what was
 * read is kept even if a later page fails. With `downTo`, the read stops after
 * the page that reaches comments older than that time; without, it goes to
 * the end, or to MAX_PAGES. Returns the time of the newest comment it saw.
 */
async function readPost(
  { post, keywords }: KeywordPost,
  own: Account,
  since: number,
  now: number,
  downTo: number | undefined,
  found: (pending: Pending[]) => void,
): Promise<number> {
  let newest = 0;
  let pages = 0;
  for await (const page of commentPages(post.id)) {
    const pending: Pending[] = [];
    for (const top of page) {
      newest = Math.max(newest, parseTime(top.timestamp ?? "") || 0);
      const thread = [{ ...top, parentId: undefined as string | undefined }, ...(top.replies?.data ?? []).map((reply) => ({ ...reply, parentId: top.id }))];
      for (const c of thread) {
        const time = parseTime(c.timestamp ?? "");
        if (!(time >= since) || now - time > REPLY_WINDOW) continue;
        const username = c.from?.username ?? c.username ?? "";
        if ((own.id && c.from?.id === own.id) || (own.username && username === own.username)) continue;
        const keyword = keywords.find((k) => mentions(c.text ?? "", k));
        // A comment the bot has seen before is in line, answered or given up: nothing to add.
        if (!keyword || commentStatus(c.id) !== undefined) continue;
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
    found(pending);
    // The page's last comment is its oldest. Once that is older than `downTo`, the rest was read before.
    if (downTo !== undefined && parseTime(page.at(-1)?.timestamp ?? "") < downTo) break;
    if (++pages >= MAX_PAGES) {
      void alert("sweep", `post ${post.permalink || post.id} has more than ${MAX_PAGES * 50} comments: the sweep reads the newest ${MAX_PAGES * 50} only.`);
      break;
    }
  }
  return newest;
}

/** Puts a found comment in line, with the time it was made. */
function answer(found: Pending): Promise<string> {
  return answerComment({ ...found, at: parseTime(found.at) });
}

/** How far a post has been read: the newest comment seen, and when the whole post was last read. */
type Progress = { upTo: number; wholeAt: number };

function progress(mediaId: string): Progress {
  try {
    const saved = JSON.parse(kvGet(`swept ${mediaId}`) ?? "{}") as Partial<Progress>;
    return { upTo: Number(saved.upTo) || 0, wholeAt: Number(saved.wholeAt) || 0 };
  } catch {
    return { upTo: 0, wholeAt: 0 };
  }
}

/** A line per comment for a handful; for a crowd, how many went which way ("700 teaser sent, 2300 waiting"). */
function logResults(results: string[]): void {
  if (results.length <= 20) {
    for (const r of results) console.log(`sweep: ${r}`);
    return;
  }
  const counts = new Map<string, number>();
  for (const r of results) {
    const outcome = r.split(":")[0];
    counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
  }
  console.log(`sweep: ${[...counts].map(([outcome, n]) => `${n} ${outcome}`).join(", ")}`);
}

let running = false;

/**
 * Reads the keyword posts and puts what it finds in line. Done when the
 * reading is: it returns, for each comment found, the promise of how its
 * first try went, and the first failure if a post couldn't be read.
 */
async function readAndQueue(now: number): Promise<{ answers: Promise<string>[]; failure?: unknown }> {
  if (running) return { answers: [] };
  running = true;
  try {
    const since = Number(kvGet("sweep_since") ?? now);
    const own = await ownAccount();
    const answers: Promise<string>[] = [];
    const failures: unknown[] = [];
    for (const kp of await keywordPosts(SWEEP_POST_AGE, now)) {
      const before = progress(kp.post.id);
      const whole = now - before.wholeAt >= WHOLE_POST_EVERY;
      try {
        const newest = await readPost(kp, own, since, now, whole ? undefined : before.upTo - OVERLAP, (pending) => answers.push(...pending.map(answer)));
        // Remembered only now, with everything the read found already in line: a read that failed half-way starts over next time.
        kvSet(`swept ${kp.post.id}`, JSON.stringify({ upTo: Math.max(before.upTo, newest), wholeAt: whole ? now : before.wholeAt }));
      } catch (e) {
        // One post that can't be read doesn't stop the others; the failure is reported once they're done.
        failures.push(e);
      }
    }
    return { answers, failure: failures[0] };
  } finally {
    running = false;
  }
}

/**
 * Answers keyword comments made since the bot first started that the webhook
 * missed, and says how each one's first try went.
 */
export async function sweep(now = Date.now()): Promise<string[]> {
  const { answers, failure } = await readAndQueue(now);
  const results = await Promise.all(answers);
  logResults(results);
  if (failure) throw failure;
  return results;
}

/**
 * The sweep the timer runs: done when the reading is, and the results are
 * logged when they're in. So a slow Instagram can't make the next sweep miss
 * its turn while this one's sends are still going out.
 */
export async function sweepOnTimer(now = Date.now()): Promise<void> {
  const { answers, failure } = await readAndQueue(now);
  void Promise.all(answers).then(logResults);
  if (failure) throw failure;
}

export type BackfillResult =
  | { mode: "preview"; count: number; pending: Pending[] }
  | { mode: "sent"; count: number; results: (Pending & { result: string })[] };

/**
 * Keyword comments from the last `days` days (7 at most) with no answer yet,
 * across the last 30 posts, each read whole. With `send`, each goes in line
 * for its teaser (past the hourly limit its result says "waiting", and it
 * goes out later); without, it's a preview. `skip` holds usernames already
 * handled by hand.
 */
export async function backfill(days: number, skip: ReadonlySet<string>, send: boolean): Promise<BackfillResult> {
  const now = Date.now();
  const since = now - Math.min(days, 7) * DAY;
  const own = await ownAccount();
  const pending: Pending[] = [];
  for (const kp of await keywordPosts(Number.POSITIVE_INFINITY, now)) {
    await readPost(kp, own, since, now, undefined, (page) => pending.push(...page.filter((p) => !skip.has(p.username.toLowerCase()))));
  }
  if (!send) return { mode: "preview", count: pending.length, pending };
  const results = await Promise.all(pending.map(async (found) => ({ ...found, result: await answer(found) })));
  return { mode: "sent", count: pending.length, results };
}
