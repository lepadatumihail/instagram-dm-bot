import { kvGet, kvSet, noteCall } from "../db.ts";
import { GIVEAWAYS } from "./giveaways.ts";
import { failureKind, GraphError, sendMessage } from "./graph.ts";
import { payloadFor } from "./match.ts";

/**
 * What a commenter sees: the teaser DM with its button, and the public "DM
 * sent" reply under their comment. bot.ts explains the flow they belong to.
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
export async function sendTeaser(commentId: string, keyword: string, now = Date.now()): Promise<void> {
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
      // Only Meta refusing the message itself says anything about the button
      // (and once the button has worked, not even that). A rate limit or a
      // failure inside Instagram is for the queue to deal with.
      if (!(e instanceof GraphError) || e.status !== 400 || failureKind(e) !== "permanent" || buttons === "yes") throw e;
    }
    // A second call for the same comment, and Meta's hourly limit counts calls.
    noteCall("private_reply", now);
    await sendMessage(recipient, { text: teaser(keyword, false) });
    kvSet("private_reply_buttons", "no");
    return;
  }
  await sendMessage(recipient, { text: teaser(keyword, false) });
}
