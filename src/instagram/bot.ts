import { alert } from "../alert.ts";
import { config, MINUTE } from "../config.ts";
import { type CommentJob, claimComment, claimDelivery, finishComment, finishDelivery, kvGet, kvSet } from "../db.ts";
import { GIVEAWAYS, KEYWORDS } from "./giveaways.ts";
import { GraphError, getCaption, getMe, replyToComment, sendMessage } from "./graph.ts";
import { captionKeywords, exactKeyword, keywordFromPayload, mentions, payloadFor } from "./match.ts";

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
 */

/** A few wordings, so a reel's thread isn't the same line twenty times (Instagram frowns on that). */
const PUBLIC_REPLIES = [
  (u: string) => `Hey @${u}, DM sent 📩`,
  (u: string) => `@${u} sent it to your DMs 🙌`,
  (u: string) => `@${u} check your DMs 📩`,
  (u: string) => `Done @${u}, it's in your DMs 👀`,
];

/** The public reply for a comment: always the same wording for the same comment. */
export function publicReplyText(username: string, commentId: string): string {
  if (!username) return "Sent, check your DMs 📩";
  let hash = 0;
  for (const ch of commentId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return PUBLIC_REPLIES[hash % PUBLIC_REPLIES.length](username);
}

export const BUTTON = "Send it over 👇";
const CAPTION_TTL = 10 * MINUTE;

export function teaser(keyword: string, withButton: boolean): string {
  const promise = GIVEAWAYS[keyword]?.promise ?? "the link";
  const hello = `Hey! You commented ${keyword} on my reel 🙌`;
  return withButton
    ? `${hello}\n\nTap the button below and I'll send you ${promise}.\n\n(No button? Just reply ${keyword}.)`
    : `${hello}\n\nReply ${keyword} here and I'll send you ${promise}.`;
}

/**
 * The private reply. Meta's docs only show plain text in one, so the first
 * time the version with the button is turned down, the bot sends the plain
 * version and skips the button from then on.
 */
export async function sendTeaser(commentId: string, keyword: string): Promise<void> {
  const recipient = { comment_id: commentId };
  const buttons = kvGet("private_reply_buttons");
  if (buttons !== "no") {
    try {
      await sendMessage(recipient, {
        text: teaser(keyword, true),
        quick_replies: [{ content_type: "text", title: BUTTON, payload: payloadFor(keyword) }],
      });
      if (buttons !== "yes") kvSet("private_reply_buttons", "yes");
      return;
    } catch (e) {
      // Once the button has worked, a refusal is about something else.
      if (!(e instanceof GraphError) || e.status !== 400 || buttons === "yes") throw e;
    }
    await sendMessage(recipient, { text: teaser(keyword, false) });
    kvSet("private_reply_buttons", "no");
    return;
  }
  await sendMessage(recipient, { text: teaser(keyword, false) });
}

const captions = new Map<string, { keywords: string[]; at: number }>();

/** Saves a reel's keywords when the caption is already at hand (the sweep lists captions). */
export function rememberCaption(mediaId: string, keywords: string[], now = Date.now()): void {
  captions.set(mediaId, { keywords, at: now });
}

/** The keywords a reel's caption asks for, looked up at most every ten minutes. */
export async function reelKeywords(mediaId: string, now = Date.now()): Promise<string[]> {
  const cached = captions.get(mediaId);
  if (cached && now - cached.at < CAPTION_TTL) return cached.keywords;
  const keywords = captionKeywords(await getCaption(mediaId), KEYWORDS);
  rememberCaption(mediaId, keywords, now);
  return keywords;
}

/** The account's own id and username, asked once and kept. */
export async function ownAccount(): Promise<{ id: string; username: string }> {
  let id = kvGet("own_id");
  let username = kvGet("own_username");
  if (id === undefined || username === undefined) {
    const me = await getMe();
    id = me.user_id ?? me.id ?? "";
    username = me.username ?? "";
    kvSet("own_id", id);
    kvSet("own_username", username);
  }
  return { id, username };
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

/**
 * Answers a keyword comment, once: the teaser DM, then the public "DM sent"
 * reply. The public reply only goes out once the DM has, and if it fails the
 * DM still counts.
 */
export async function answerComment(job: CommentJob): Promise<string> {
  if (!claimComment(job)) return "skipped: already answered";
  try {
    await sendTeaser(job.commentId, job.keyword);
    finishComment(job.commentId, true);
  } catch (e) {
    finishComment(job.commentId, false, describe(e));
    await report(e, `couldn't send the ${job.keyword} teaser to @${job.username}`);
    return `failed: ${describe(e)}`;
  }
  const sent = `teaser sent: ${job.keyword} to @${job.username}`;
  if (!config.publicReplies) return sent;
  try {
    await replyToComment(job.parentId ?? job.commentId, publicReplyText(job.username, job.commentId));
    return sent;
  } catch (e) {
    await report(e, `sent the ${job.keyword} DM to @${job.username}, but couldn't reply under the comment`);
    return `${sent} (no public reply: ${describe(e)})`;
  }
}

type MessagingEvent = {
  sender?: { id?: string };
  message?: { text?: string; is_echo?: boolean; is_deleted?: boolean; quick_reply?: { payload?: string } };
  postback?: { payload?: string };
};

export async function handleMessaging(ownerId: string, event: MessagingEvent): Promise<string> {
  const userId = event.sender?.id;
  if (!userId || userId === ownerId || event.message?.is_echo) return "skipped: own message";
  if (event.message?.is_deleted) return "skipped: deleted";
  const tapped = keywordFromPayload(event.message?.quick_reply?.payload ?? event.postback?.payload, KEYWORDS);
  const keyword = tapped ?? exactKeyword(event.message?.text ?? "", KEYWORDS);
  if (!keyword) return "skipped: not a keyword";
  return deliver(userId, keyword, tapped ? "button" : "keyword");
}

/** Sends a giveaway, unless the same person got it in the last two minutes (a double tap). */
export async function deliver(userId: string, keyword: string, via: "button" | "keyword"): Promise<string> {
  const id = claimDelivery(userId, keyword, via);
  if (id === null) return "skipped: just sent";
  try {
    for (const text of GIVEAWAYS[keyword].messages) await sendMessage({ id: userId }, { text });
    finishDelivery(id, true);
    return `giveaway sent: ${keyword} (${via})`;
  } catch (e) {
    finishDelivery(id, false, describe(e));
    await report(e, `couldn't send the ${keyword} giveaway to someone who asked for it`);
    return `failed: ${describe(e)}`;
  }
}

type Entry = {
  id?: string;
  changes?: { field?: string; value?: unknown }[];
  messaging?: MessagingEvent[];
};

/** One webhook delivery from Meta: comments arrive as "changes", DMs and taps as "messaging". */
export async function handleWebhook(payload: unknown): Promise<string[]> {
  const body = payload as { object?: string; entry?: Entry[] } | null;
  const results: string[] = [];
  if (body?.object !== "instagram") return results;
  for (const entry of body.entry ?? []) {
    const ownerId = String(entry.id ?? "");
    for (const change of entry.changes ?? []) {
      const value = change.value;
      if (!value) continue;
      if (change.field === "comments") results.push(await guard(() => handleComment(ownerId, value as CommentValue)));
      // The dashboard's "Test" button sends DMs in this shape.
      if (change.field === "messages" || change.field === "messaging_postbacks") {
        results.push(await guard(() => handleMessaging(ownerId, value as MessagingEvent)));
      }
    }
    for (const event of entry.messaging ?? []) results.push(await guard(() => handleMessaging(ownerId, event)));
  }
  return results;
}

async function guard(run: () => Promise<string>): Promise<string> {
  try {
    return await run();
  } catch (e) {
    await alert("webhook", `an event failed: ${describe(e)}`);
    return `failed: ${describe(e)}`;
  }
}

export function describe(e: unknown): string {
  if (e instanceof GraphError) {
    const code = e.code ? `, code ${e.code}${e.subcode ? `/${e.subcode}` : ""}` : "";
    return `${e.message} (HTTP ${e.status}${code})`;
  }
  return e instanceof Error ? e.message : String(e);
}

async function report(e: unknown, context: string): Promise<void> {
  if (e instanceof GraphError && (e.code === 190 || e.status === 0)) {
    await alert(
      "token",
      `${context}: the access token isn't working (${describe(e)}). Generate a new one in the Meta app and set IG_ACCESS_TOKEN on Railway.`,
    );
    return;
  }
  const kind = e instanceof GraphError ? `graph ${e.code ?? e.status}/${e.subcode ?? ""}` : "error";
  await alert(kind, `${context}: ${describe(e)}`);
}
