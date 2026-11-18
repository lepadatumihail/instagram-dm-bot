import { createHash } from "node:crypto";
import { alert } from "../alert.ts";
import { config, DAY } from "../config.ts";
import { kvGet, kvSet } from "../db.ts";

/**
 * The access token (IG_ACCESS_TOKEN). Two kinds work:
 * - a system-user token ("EAA…"), which Meta's "Unified login" setup gives new
 *   apps: it never expires and is used on graph.facebook.com;
 * - an Instagram-login token ("IG…"), from apps made before Unified login: it
 *   lasts 60 days, so once a week the bot trades it for a fresh 60-day one
 *   (refresh_access_token, which needs it to be a day old) and keeps that in
 *   the database.
 * Setting a new IG_ACCESS_TOKEN replaces whatever is stored.
 */

const REFRESH_EVERY = 7 * DAY;

/** A system-user (Facebook) token rather than an Instagram-login one. */
export function isSystemUserToken(token: string): boolean {
  return token.startsWith("EAA");
}

function fingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

export function currentToken(): string {
  const seed = config.seedToken;
  if (seed && kvGet("token_seed") !== fingerprint(seed)) {
    kvSet("token_seed", fingerprint(seed));
    kvSet("token", seed);
    kvSet("token_since", String(Date.now()));
  }
  return kvGet("token") ?? seed;
}

export async function refreshTokenIfDue(
  now = Date.now(),
): Promise<"refreshed" | "not due" | "never expires" | "no token" | "failed"> {
  const token = currentToken();
  if (!token) return "no token";
  if (isSystemUserToken(token)) return "never expires";
  if (now - Number(kvGet("token_since") ?? now) < REFRESH_EVERY) return "not due";

  // The refresh endpoint sits at the host root, outside the API version path.
  const url = new URL("/refresh_access_token", config.graphBase || "https://graph.instagram.com");
  url.searchParams.set("grant_type", "ig_refresh_token");
  url.searchParams.set("access_token", token);
  const response = await fetch(url).catch(() => null);
  const data = (await response?.json().catch(() => ({}))) as
    | { access_token?: string; expires_in?: number; error?: { message?: string } }
    | undefined;

  if (!response?.ok || !data?.access_token) {
    await alert(
      "token-refresh",
      `couldn't refresh the access token (${data?.error?.message ?? `HTTP ${response?.status ?? "error"}`}). ` +
        "If it has expired, generate a new one in the Meta app and set IG_ACCESS_TOKEN on Railway.",
    );
    return "failed";
  }
  kvSet("token", data.access_token);
  kvSet("token_since", String(now));
  if (data.expires_in) kvSet("token_expires", String(now + data.expires_in * 1000));
  return "refreshed";
}
