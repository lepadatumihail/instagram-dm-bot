import { idle, pump } from "../src/instagram/queue.ts";
import { BUTTON } from "../src/instagram/teaser.ts";

/** What the tests feed the bot: webhook payloads as Meta sends them, and a way to let the queue run. */

export const OWNER = "OWNER-IG";

export function comment(id: string, text: string, from: { id?: string; username?: string }, mediaId = "M1", parentId?: string) {
  const value = { from, media: { id: mediaId, media_product_type: "REELS" }, id, text, ...(parentId ? { parent_id: parentId } : {}) };
  return { object: "instagram", entry: [{ id: OWNER, time: 1, changes: [{ field: "comments", value }] }] };
}

let messages = 0;

/** A DM. Every message has an id of its own, as at Instagram, unless the test gives one to send the same message twice. */
export function dm(sender: string, message: Record<string, unknown>) {
  return {
    object: "instagram",
    entry: [
      { id: OWNER, time: 1, messaging: [{ sender: { id: sender }, recipient: { id: OWNER }, timestamp: 1, message: { mid: `mid-${++messages}`, ...message } }] },
    ],
  };
}

export const tap = (sender: string, keyword: string, mid?: string) =>
  dm(sender, { ...(mid ? { mid } : {}), text: BUTTON, quick_reply: { payload: `GIVE:${keyword}` } });

/**
 * Lets the queue work as if it were `at`, until nothing more can go out at
 * that time. Tests pass a later time instead of waiting for a retry, a pause
 * or the hourly limit.
 */
export async function runQueue(at = Date.now()): Promise<void> {
  let started: number;
  do {
    started = pump(at);
    await idle();
  } while (started > 0);
}

/** Waits until something is true, for things that happen on their own time (a call reaching the stand-in API). */
export async function until(condition: () => boolean, patience = 2000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > patience) throw new Error("waited too long");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
