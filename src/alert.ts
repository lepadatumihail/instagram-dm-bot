import { config, HOUR } from "./config.ts";

/**
 * Logs a failure and tells you on Telegram when TELEGRAM_BOT_TOKEN and
 * TELEGRAM_CHAT_ID are set. One Telegram
 * message per kind of failure per hour, so an expired token doesn't send one
 * alert per comment.
 */
const lastSent = new Map<string, number>();

export async function alert(kind: string, text: string): Promise<void> {
  console.error(`[${kind}] ${text}`);
  const now = Date.now();
  if (now - (lastSent.get(kind) ?? 0) < HOUR) return;
  lastSent.set(kind, now);
  if (!config.telegramToken || !config.telegramChatId) return;

  await fetch(`https://api.telegram.org/bot${config.telegramToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: config.telegramChatId,
      text: `Instagram bot: ${text}`,
      link_preview_options: { is_disabled: true },
    }),
    // An alert must never hold up the work it reports on.
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined);
}
