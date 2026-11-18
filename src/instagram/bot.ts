import { alert } from "../alert.ts";
import { MINUTE } from "../config.ts";
import { firstTime, kvGet, kvSet } from "../db.ts";
import { KEYWORDS } from "./giveaways.ts";
import { describe, getCaption, getMe } from "./graph.ts";
import { captionKeywords, exactKeyword, keywordFromPayload, mentions } from "./match.ts";
import { answerComment, deliver } from "./queue.ts";

/**
 * The comment-to-DM flow:
 *
 * 1. Someone comments the keyword a reel's caption asks for. Instagram allows
 *    one message per comment (a "private reply", within 7 days of it) and
 *    nothing more until the person answers. So the bot sends a short teaser
 *    with one button, "Send it over 👇".
 * 2. Once the DM is out, it replies under the comment, "Hey @name, DM sent 📩",
 *    so the commenter knows to look (a DM from someone they don't follow lands
 *    in their message requests) and everyone else sees the reel delivers.
 * 3. Tapping the button sends its label as their message: that's the answer
 *    Meta waits for. The bot then sends the giveaway, in as many messages of
 *    up to 1,000 bytes as it takes.
 *
 * The button (a quick reply) doesn't show on Instagram on a computer, so the
 * teaser also says "Just reply GUIDE", and a DM that is only a keyword gets
 * its giveaway as well. Any other message is left for you.
 *
 * This file reads what comes in and decides what deserves an answer. It sends
 * nothing itself: each teaser and giveaway goes in line, and queue.ts sends
 * them, a few at a time and inside Meta's limits.
 */

const CAPTION_TTL = 10 * MINUTE;

const captions = new Map<string, { keywords: Promise<string[]>; at: number }>();

/** Saves a reel's keywords when the caption is already at hand (the sweep lists captions). */
export function rememberCaption(mediaId: string, keywords: string[], now = Date.now()): void {
  captions.set(mediaId, { keywords: Promise.resolve(keywords), at: now });
}

/**
 * The keywords a reel's caption asks for, looked up at most every ten minutes.
 * What's kept is the lookup itself, so a hundred comments arriving together
 * on one reel share a single call instead of making one each.
 */
export function reelKeywords(mediaId: string, now = Date.now()): Promise<string[]> {
  const cached = captions.get(mediaId);
  if (cached && now - cached.at < CAPTION_TTL) return cached.keywords;
  const keywords = getCaption(mediaId).then((caption) => captionKeywords(caption, KEYWORDS));
  captions.set(mediaId, { keywords, at: now });
  // A lookup that failed isn't kept: the next comment asks again.
  keywords.catch(() => {
    if (captions.get(mediaId)?.keywords === keywords) captions.delete(mediaId);
  });
  return keywords;
}

let asking: Promise<{ id: string; username: string }> | undefined;

/** The account's own id and username, asked once and kept. */
export async function ownAccount(): Promise<{ id: string; username: string }> {
  const id = kvGet("own_id");
  const username = kvGet("own_username");
  if (id !== undefined && username !== undefined) return { id, username };
  // On a fresh database, comments arriving together share one call here too.
  asking ??= getMe()
    .then((me) => {
      const own = { id: me.user_id ?? me.id ?? "", username: me.username ?? "" };
      kvSet("own_id", own.id);
      kvSet("own_username", own.username);
      return own;
    })
    .finally(() => {
      asking = undefined;
    });
  return asking;
}

async function isOwner(ownerId: string, from: { id?: string; username?: string } | undefined): Promise<boolean> {
  if (!from) return false;
  if (from.id && from.id === ownerId) return true;
  const own = await ownAccount().catch(() => ({ id: "", username: "" }));
  return Boolean((from.id && from.id === own.id) || (from.username && from.username === own.username));
}

type CommentValue = {
  id?: string;
  comment_id?: string;
  parent_id?: string;
  text?: string;
  from?: { id?: string; username?: string };
  media?: { id?: string };
};

export async function handleComment(ownerId: string, value: CommentValue): Promise<string> {
  const commentId = value.comment_id ?? value.id;
  const mediaId = value.media?.id;
  const text = value.text ?? "";
  if (!commentId || !mediaId || !text) return "skipped: not a text comment";
  if (await isOwner(ownerId, value.from)) return "skipped: own comment";
  const keyword = (await reelKeywords(mediaId)).find((k) => mentions(text, k));
  if (!keyword) return "skipped: no keyword for this reel";
  return answerComment({ commentId, mediaId, username: value.from?.username ?? "", keyword, parentId: value.parent_id });
}

type MessagingEvent = {
  sender?: { id?: string };
  message?: { mid?: string; text?: string; is_echo?: boolean; is_deleted?: boolean; quick_reply?: { payload?: string } };
  postback?: { mid?: string; payload?: string };
};

/** Nothing here waits before the giveaway is in line, so one person's messages keep the order they arrived in. */
export async function handleMessaging(ownerId: string, event: MessagingEvent): Promise<string> {
  const userId = event.sender?.id;
  if (!userId || userId === ownerId || event.message?.is_echo) return "skipped: own message";
  if (event.message?.is_deleted) return "skipped: deleted";
  const tapped = keywordFromPayload(event.message?.quick_reply?.payload ?? event.postback?.payload, KEYWORDS);
  const keyword = tapped ?? exactKeyword(event.message?.text ?? "", KEYWORDS);
  if (!keyword) return "skipped: not a keyword";
  // Meta delivers a webhook again when it didn't get its 200, hours later if need be: a message counts the first time only.
  const mid = event.message?.mid ?? event.postback?.mid;
  if (mid && !firstTime(mid)) return "skipped: Meta delivered this message before";
  return deliver(userId, keyword, tapped ? "button" : "keyword");
}

type Entry = {
  id?: string;
  changes?: { field?: string; value?: unknown }[];
  messaging?: MessagingEvent[];
};

/**
 * One webhook delivery from Meta: comments arrive as "changes", DMs and taps
 * as "messaging". Meta can put many events in one delivery, so all of them
 * are started before any is waited for: each goes in line straight away, and
 * the queue decides how many are sent at a time.
 */
export async function handleWebhook(payload: unknown): Promise<string[]> {
  const body = payload as { object?: string; entry?: Entry[] } | null;
  const results: Promise<string>[] = [];
  if (body?.object !== "instagram") return [];
  for (const entry of body.entry ?? []) {
    const ownerId = String(entry.id ?? "");
    for (const change of entry.changes ?? []) {
      const value = change.value;
      if (!value) continue;
      if (change.field === "comments") results.push(guard(() => handleComment(ownerId, value as CommentValue)));
      // The dashboard's "Test" button sends DMs in this shape.
      if (change.field === "messages" || change.field === "messaging_postbacks") {
        results.push(guard(() => handleMessaging(ownerId, value as MessagingEvent)));
      }
    }
    for (const event of entry.messaging ?? []) results.push(guard(() => handleMessaging(ownerId, event)));
  }
  return Promise.all(results);
}

async function guard(run: () => Promise<string>): Promise<string> {
  try {
    return await run();
  } catch (e) {
    await alert("webhook", `an event failed: ${describe(e)}`);
    return `failed: ${describe(e)}`;
  }
}
