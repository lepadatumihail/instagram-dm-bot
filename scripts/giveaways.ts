/**
 * Builds data/giveaways.json, what each keyword sends, from the giveaway notes
 * in giveaways/ (or GIVEAWAYS_DIR):
 *
 *   npm run giveaways
 *
 * A note counts when it names its keyword in one of the two shapes they use:
 *   "# What to send people who comment AGENCY": the DM is the text between the
 *     first two "---" lines (above them are your own notes, below the caption);
 *   "## DM for people who comment GUIDE": the DM runs to the next heading or
 *     "---" line.
 * The teaser's promise ("the guide") comes from the caption line
 * "Comment GUIDE and I'll send you the guide 👇"; a note without
 * one promises "the link".
 *
 * Instagram takes at most 1,000 bytes per message, so a longer DM is split at
 * blank lines and sent as several messages, in order.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DIR = process.env.GIVEAWAYS_DIR ?? "giveaways";
const OUT = "data/giveaways.json";
const MAX_BYTES = 1000;

type Giveaway = { promise: string; source: string; messages: string[] };

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

/** The keyword and the DM text of a note, or null when it has no DM. */
function dmOf(text: string): { keyword: string; dm: string } | null {
  const lines = text.split("\n");
  const until = (rest: string[], stop: RegExp) => {
    const end = rest.findIndex((l) => stop.test(l));
    return rest.slice(0, end === -1 ? undefined : end).join("\n");
  };

  const section = lines.findIndex((l) => /^## DM for people who comment [A-Z0-9]+\s*$/.test(l));
  if (section !== -1) {
    const keyword = lines[section].replace(/^.*comment ([A-Z0-9]+)\s*$/, "$1");
    return { keyword, dm: until(lines.slice(section + 1), /^(#{1,6} |---\s*$)/) };
  }

  const title = lines[0].match(/^# What to send people who comment ([A-Z0-9]+)\b/);
  const first = lines.indexOf("---");
  if (title && first !== -1) return { keyword: title[1], dm: until(lines.slice(first + 1), /^(---\s*$|## )/) };

  return null;
}

/** Plain DM text: no markdown markers, no runs of blank lines. */
function tidy(dm: string): string {
  return dm
    .split("\n")
    .filter((l) => !l.trim().startsWith("```"))
    .join("\n")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** "the guide" from "Comment GUIDE and I'll send you the guide 👇". */
function promiseOf(text: string, keyword: string): string {
  const line = text.match(new RegExp(`Comment ${keyword} and I(?:'|’)ll send you (.+)`, "i"));
  return line ? line[1].replace(/[\s.!👇]+$/u, "").trim() : "the link";
}

/** Splits at blank lines, then at line breaks, so no message passes MAX_BYTES. */
function split(dm: string): string[] {
  const out: string[] = [];
  let current = "";
  const add = (piece: string, joiner: string) => {
    if (!current) current = piece;
    else if (bytes(current + joiner + piece) <= MAX_BYTES) current += joiner + piece;
    else {
      out.push(current);
      current = piece;
    }
  };
  for (const paragraph of dm.split(/\n\s*\n/)) {
    if (bytes(paragraph) <= MAX_BYTES) {
      add(paragraph, "\n\n");
      continue;
    }
    for (const line of paragraph.split("\n")) {
      if (bytes(line) > MAX_BYTES) throw new Error(`a single line is over ${MAX_BYTES} bytes: ${line.slice(0, 60)}…`);
      add(line, "\n");
    }
  }
  if (current) out.push(current);
  return out;
}

const giveaways: Record<string, Giveaway> = {};
for (const file of readdirSync(DIR).filter((f) => f.endsWith(".md")).sort()) {
  const text = readFileSync(join(DIR, file), "utf8");
  const found = dmOf(text);
  if (!found) continue;
  const dm = tidy(found.dm);
  if (!dm) continue;
  const taken = giveaways[found.keyword];
  if (taken) throw new Error(`${found.keyword} is in both ${taken.source} and ${file}`);
  giveaways[found.keyword] = { promise: promiseOf(text, found.keyword), source: file, messages: split(dm) };
}

const sorted = Object.fromEntries(
  Object.keys(giveaways)
    .sort()
    .map((k) => [k, giveaways[k]]),
);
writeFileSync(OUT, `${JSON.stringify(sorted, null, 2)}\n`);

for (const [keyword, g] of Object.entries(sorted)) {
  const sizes = g.messages.map(bytes).join(" + ");
  console.log(`${keyword.padEnd(10)} ${g.source.padEnd(18)} ${g.messages.length} msg (${sizes} bytes)  promise: ${g.promise}`);
}
console.log(`\n${Object.keys(sorted).length} giveaways → ${OUT}`);

// Every giveaway should arrive as one DM. A longer one still works (it's sent
// in parts), but it reads badly, so say which note to trim and exit non-zero.
const long = Object.entries(sorted).filter(([, g]) => g.messages.length > 1);
for (const [keyword, g] of long) {
  const total = bytes(g.messages.join("\n\n"));
  console.error(`\n${keyword} needs ${g.messages.length} messages (${total} bytes): trim ${g.source} to ${MAX_BYTES} bytes or less.`);
}
if (long.length) process.exit(1);
