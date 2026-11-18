/**
 * How the Instagram bot reads captions, comments and DMs. Pure functions, no
 * I/O, so the rules can be tested on their own.
 *
 * Most keywords are ordinary words (TEST, KEY, UI, CHAT), so a comment only
 * counts on a reel whose caption asks for that keyword ("Comment TEST and I'll
 * send you…"): "did you test it?" under another reel sends nothing. A DM counts
 * only when it is the keyword alone ("guide", "GUIDE 🙏"), which is what
 * people type when they ask by message or have no button to tap.
 */

/** The prefix of a quick-reply payload: "GIVE:GUIDE". */
const PAYLOAD_PREFIX = "GIVE:";

/** Upper-case words, split on anything that isn't a letter or a digit. */
function words(text: string): string[] {
  return text
    .normalize("NFKC")
    .toUpperCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** The known keywords a caption asks for: "Comment GUIDE and I'll send you…" → ["GUIDE"]. */
export function captionKeywords(caption: string, known: ReadonlySet<string>): string[] {
  const found = new Set<string>();
  for (const match of caption.matchAll(/\bcomment\s+(?:the\s+word\s+)?["“'‘«]?([\p{L}\p{N}]{2,24})/giu)) {
    const keyword = match[1].normalize("NFKC").toUpperCase();
    if (known.has(keyword)) found.add(keyword);
  }
  return [...found];
}

/** Whether a comment contains the keyword as a word, in any case. */
export function mentions(text: string, keyword: string): boolean {
  return words(text).includes(keyword);
}

/** The keyword a DM consists of, or null when it says anything more. */
export function exactKeyword(text: string, known: ReadonlySet<string>): string | null {
  const w = words(text);
  return w.length === 1 && known.has(w[0]) ? w[0] : null;
}

export function payloadFor(keyword: string): string {
  return PAYLOAD_PREFIX + keyword;
}

/** The keyword in a quick-reply or postback payload, or null for anything else. */
export function keywordFromPayload(payload: string | undefined, known: ReadonlySet<string>): string | null {
  if (!payload?.startsWith(PAYLOAD_PREFIX)) return null;
  const keyword = payload.slice(PAYLOAD_PREFIX.length);
  return known.has(keyword) ? keyword : null;
}

/** Instagram's timestamps end in "+0000", which not every parser takes. */
export function parseTime(timestamp: string): number {
  return Date.parse(timestamp.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
}
