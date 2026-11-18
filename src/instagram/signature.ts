import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Meta signs every webhook: X-Hub-Signature-256 is "sha256=" and the HMAC of
 * the raw body under the app secret. Meta's docs don't say whether that is the
 * Instagram app secret or the Meta app secret for an Instagram Login app, so
 * either one configured is accepted.
 */
export function validSignature(body: Buffer, header: string | null, secrets: (string | undefined)[]): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const given = Buffer.from(header.slice("sha256=".length), "hex");
  return secrets.some((secret) => {
    if (!secret) return false;
    const expected = createHmac("sha256", secret).update(body).digest();
    return expected.length === given.length && timingSafeEqual(expected, given);
  });
}
