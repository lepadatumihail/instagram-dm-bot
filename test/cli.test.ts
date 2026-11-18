import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { createApp } from "../src/app.ts";
import { closeDb, getPost, openDb } from "../src/db.ts";
import { allPosts } from "../src/instagram/posts.ts";
import { startMockGraph } from "./mock-graph.ts";

/** scripts/post-reel.mjs, run as a person would: against the bot's /admin API, and straight against the (stand-in) Graph API. */

const mock = await startMockGraph();
const dir = mkdtempSync(join(tmpdir(), "instagram-dm-bot-cli-"));
Object.assign(process.env, { IG_GRAPH_BASE: mock.base, IG_ACCESS_TOKEN: "seed-token", ADMIN_KEY: "admin-key-do-not-print" });
delete process.env.TELEGRAM_BOT_TOKEN;

const server = createApp();
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const BOT_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(async () => {
  server.close();
  server.closeAllConnections();
  await mock.close();
});

beforeEach(() => {
  closeDb();
  openDb(":memory:");
  mock.reset();
  process.env.POSTS_DIR = mkdtempSync(join(tmpdir(), "instagram-dm-bot-posts-"));
});

const video = join(dir, "reel.mp4");
const bytes = Buffer.alloc(200_000, 3);
bytes.write("\0\0\0\x18ftypisom", 0, "latin1");
writeFileSync(video, bytes);
const captionFile = join(dir, "caption.txt");
writeFileSync(captionFile, "A reel about a bot.\n\nComment BOT 👇\n#one #two\n");

type Run = { code: number; out: string };
const SCRIPT = new URL("../scripts/post-reel.mjs", import.meta.url).pathname;

/** Runs the script with only the environment given, like a fresh terminal. */
function run(args: string[], env: Record<string, string>): Promise<Run> {
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, ...args], { env: { PATH: process.env.PATH ?? "", TZ: "Europe/Madrid", ...env } }, (error, stdout, stderr) => {
      resolve({ code: error ? Number(error.code ?? 1) : 0, out: stdout + stderr });
    });
  });
}
const viaBot = (args: string[]) => run(args, { BOT_URL, ADMIN_KEY: "admin-key-do-not-print" });
const direct = (args: string[]) => run(args, { IG_GRAPH_BASE: mock.base, IG_ACCESS_TOKEN: "secret-token-do-not-print", IG_USER_ID: "OWNER-IG" });
const files = () => readdirSync(process.env.POSTS_DIR as string);

describe("post-reel.mjs through the bot", () => {
  it("schedules a reel: says the moment it understood, creates the post, sends the video", async () => {
    const { code, out } = await viaBot(["schedule", "--video", video, "--caption-file", captionFile, "--at", "2031-07-01 18:30", "--thumb-offset", "2100"]);
    assert.equal(code, 0, out);
    assert.match(out, /^at: 2031-07-01 18:30 Europe\/Madrid \(UTC\+02:00\) = 2031-07-01T16:30:00Z \(read on this computer's clock\)$/m);
    assert.match(out, /^post 1: scheduled \(44 characters, 2 hashtags, cover: the frame at 2100 ms, AI label off\)$/m);
    assert.match(out, /^post 1: 0\.2 MB sent\. The bot publishes it at 2031-07-01 18:30 Europe\/Madrid/m);
    assert.match(out, /cancel --id 1$/m);

    const post = getPost(1);
    assert.equal(post?.publishAt, Date.UTC(2031, 6, 1, 16, 30));
    assert.equal(post?.caption, "A reel about a bot.\n\nComment BOT 👇\n#one #two");
    assert.deepEqual([post?.thumbOffset, post?.aiLabel, post?.size], [2100, false, 200_000]);
    assert.equal(files().length, 1);
  });

  it("reads a time with its offset as that moment, wherever the computer is, and --ai-label turns the label on", async () => {
    const { code, out } = await viaBot(["schedule", "--video", video, "--caption-file", captionFile, "--at", "2031-01-15T09:00:00-05:00", "--ai-label", "--cover-url", "https://example.com/c.jpg"]);
    assert.equal(code, 0, out);
    assert.match(out, /^at: 2031-01-15 15:00 Europe\/Madrid \(UTC\+01:00\) = 2031-01-15T14:00:00Z$/m);
    assert.match(out, /cover: https:\/\/example\.com\/c\.jpg, AI label on\)$/m);
    assert.equal(getPost(1)?.publishAt, Date.UTC(2031, 0, 15, 14, 0));
    assert.equal(getPost(1)?.aiLabel, true);
  });

  it("takes 'now'", async () => {
    const { code, out } = await viaBot(["schedule", "--video", video, "--caption-file", captionFile, "--at", "now"]);
    assert.equal(code, 0, out);
    assert.match(out, /^at: now, as soon as Instagram has processed the video$/m);
    assert.ok(Math.abs((getPost(1)?.publishAt ?? 0) - Date.now()) < 5000);
  });

  it("turns down a time it can't be sure of, before anything is scheduled", async () => {
    for (const [at, says] of [
      ["2031-02-30 18:30", /isn't a time on this computer's clock/],
      ["tomorrow evening", /isn't a time I can read/],
      ["2020-01-01 10:00", /That time is in the past: 2020-01-01 10:00 Europe\/Madrid/],
    ] as const) {
      const { code, out } = await viaBot(["schedule", "--video", video, "--caption-file", captionFile, "--at", at]);
      assert.equal(code, 1, out);
      assert.match(out, says);
    }
    assert.equal((await viaBot(["schedule", "--video", video, "--caption-file", captionFile])).code, 1);
    assert.equal(allPosts().length, 0);
  });

  it("lists and cancels", async () => {
    await viaBot(["schedule", "--video", video, "--caption-file", captionFile, "--at", "2031-07-01 18:30"]);
    const list = await viaBot(["list"]);
    assert.match(list.out, /^  1  scheduled   2031-07-01 18:30 Europe\/Madrid \(UTC\+02:00\) = 2031-07-01T16:30:00Z$/m);
    assert.match(list.out, /A reel about a bot\./);
    assert.match(list.out, /video: 0\.2 MB; cover: the first frame; AI label off/);

    const cancelled = await viaBot(["cancel", "--id", "1"]);
    assert.match(cancelled.out, /^post 1: cancelled\. It was due at 2031-07-01 18:30 Europe\/Madrid/m);
    assert.deepEqual(files(), []);
    assert.match((await viaBot(["cancel", "--id", "1"])).out, /The bot said no \(HTTP 409\): Post 1 is cancelled: too late to cancel\./);
    assert.match((await viaBot(["list"])).out, /cancelled/);
  });

  it("takes the post back when the video doesn't get through, so nothing half-made stays on the schedule", async () => {
    const notAVideo = join(dir, "page.html");
    writeFileSync(notAVideo, "<html>this is not a video</html>");
    const { code, out } = await viaBot(["schedule", "--video", notAVideo, "--caption-file", captionFile, "--at", "2031-07-01 18:30"]);
    assert.equal(code, 1);
    assert.match(out, /The video didn't get through \(HTTP 400\): That doesn't look like an MP4 or MOV file\./);
    assert.match(out, /Post 1 was cancelled again; nothing is scheduled\./);
    assert.equal(getPost(1)?.state, "cancelled");
    assert.deepEqual(files(), []);
  });

  it("never prints the key, and says so plainly when it's missing or wrong", async () => {
    const good = await viaBot(["schedule", "--video", video, "--caption-file", captionFile, "--at", "now"]);
    const wrong = await run(["list"], { BOT_URL, ADMIN_KEY: "not-the-key" });
    const missing = await run(["list"], {});
    const unreachable = await run(["list"], { BOT_URL: "http://127.0.0.1:9", ADMIN_KEY: "admin-key-do-not-print" });
    assert.match(wrong.out, /The bot turned the key down\. Check ADMIN_KEY\./);
    assert.match(missing.out, /BOT_URL and ADMIN_KEY are not set/);
    assert.match(unreachable.out, /Couldn't reach the bot at http:\/\/127\.0\.0\.1:9/);
    for (const { out } of [good, wrong, missing, unreachable]) assert.ok(!out.includes("admin-key-do-not-print") && !out.includes("not-the-key"), out);
  });
});

describe("post-reel.mjs straight to Instagram", () => {
  it("uploads, reports the status and publishes with the calls a real reel went out with", async () => {
    const up = await direct(["upload", "--video", video, "--caption-file", captionFile, "--thumb-offset", "2100"]);
    assert.equal(up.code, 0, up.out);
    assert.match(up.out, /^container CONT1: created \(44 characters, 2 hashtags, AI label off\)$/m);
    assert.match(up.out, /^container CONT1: FINISHED, ready to publish/m);
    const [container, upload] = mock.calls.filter((c) => c.method === "POST");
    assert.deepEqual(container.body, { media_type: "REELS", upload_type: "resumable", caption: "A reel about a bot.\n\nComment BOT 👇\n#one #two", share_to_feed: "true", thumb_offset: "2100" });
    assert.deepEqual([upload.headers.authorization, upload.headers.offset, upload.headers.file_size], ["OAuth secret-token-do-not-print", "0", "200000"]);

    assert.match((await direct(["status", "--container", "CONT1"])).out, /"status_code":"FINISHED"/);
    const out = await direct(["publish", "--container", "CONT1"]);
    assert.match(out.out, /^published: media MEDIA2$/m);
    assert.match(out.out, /^link: https:\/\/www\.instagram\.com\/reel\/MEDIA2\/$/m);
    assert.match((await direct(["publish", "--container", "CONT1"])).out, /container CONT1 is already published\. Nothing sent\./);
    assert.equal(mock.published().length, 1);
    for (const run of [up, out]) assert.ok(!run.out.includes("secret-token-do-not-print"));
  });

  it("puts the AI label on only when asked", async () => {
    await direct(["upload", "--video", video, "--caption-file", captionFile, "--ai-label"]);
    assert.equal(mock.calls.find((c) => c.method === "POST")?.body.is_ai_generated, "true");
  });

  it("says what is missing", async () => {
    assert.match((await run(["upload", "--video", video, "--caption-file", captionFile], {})).out, /IG_ACCESS_TOKEN and IG_USER_ID are not set\./);
    assert.match((await direct(["upload", "--caption-file", captionFile])).out, /--video <file\.mp4> is missing/);
    assert.match((await direct(["frobnicate"])).out, /Usage: post-reel\.mjs schedule\|list\|cancel\|upload\|publish\|status/);
  });
});
