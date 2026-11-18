import { readFileSync } from "node:fs";

/**
 * What each keyword sends, from data/giveaways.json. That file is built from
 * the notes in giveaways/ by `npm run giveaways`.
 */

export type Giveaway = {
  /** Finishes "Tap the button below and I'll send you …", from the reel's caption. */
  promise: string;
  /** The note it came from. */
  source: string;
  /** The DM, split into messages of at most 1,000 bytes. */
  messages: string[];
};

export const GIVEAWAYS: Record<string, Giveaway> = JSON.parse(
  readFileSync(new URL("../../data/giveaways.json", import.meta.url), "utf8"),
);

export const KEYWORDS: ReadonlySet<string> = new Set(Object.keys(GIVEAWAYS));
