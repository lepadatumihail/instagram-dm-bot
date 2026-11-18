import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { after, beforeEach, describe, it } from "node:test";
import { HOUR, MINUTE, SECOND } from "../src/config.ts";
import { changePost, closeDb, getPost, openDb } from "../src/db.ts";
import { allPosts, cancelPost, clearLeftovers, createPost, Refused, runPosts, saveVideo } from "../src/instagram/posts.ts";
import { type Call, startMockGraph } from "./mock-graph.ts";

/**
 * Scheduled reels against the stand-in API. Time is moved by hand:
 * runPosts(later) is the timer's tick at that moment.
 */

const mock = await startMockGraph();
process.env.IG_GRAPH_BASE = mock.base;
process.env.IG_USER_ID = "OWNER-IG";
delete process.env.TELEGRAM_BOT_TOKEN;
after(() => mock.close());

// What the bot tells its owner (alert() logs it and sends it to Telegram): kept here to check, and out of the test output.
const alerts: string[] = [];
const realError = console.error;
const realWarn = console.warn;
const realLog = console.log;
console.error = (...line: unknown[]) => void alerts.push(line.join(" "));
console.warn = () => undefined;
console.log = () => undefined;
after(() => Object.assign(console, { error: realError, warn: realWarn, log: realLog }));

let now = 0;
beforeEach(() => {
  closeDb();
  openDb(":memory:");
  mock.reset();
  alerts.length = 0;
  process.env.IG_ACCESS_TOKEN = "seed-token";
  process.env.POSTS_DIR = mkdtempSync(join(tmpdir(), "instagram-dm-bot-posts-"));
  for (const name of ["POST_LEAD_MINUTES", "POST_GRACE_MINUTES", "POST_MAX_MB"]) delete process.env[name];
  now = Date.now();
});

const CAPTION = "I built my own Instagram DM bot in one evening.\n\nComment BOT and I'll send you the code 👇\n#claudecode #buildinpublic";
const iso = (ms: number) => new Date(ms).toISOString();

/** A small file that starts the way every MP4 does. */
function video(bytes = 4096, fill = 7): Buffer {
  const file = Buffer.alloc(bytes, fill);
  file.write("\0\0\0\x18ftypisom", 0, "latin1");
  return file;
}
const sha = (file: Buffer) => createHash("sha256").update(file).digest("hex");

/** Schedules a reel `minutes` from now and uploads its video. */
async function schedule(minutes: number, extra: Record<string, unknown> = {}, file = video()): Promise<number> {
  const { id } = createPost({ caption: CAPTION, at: iso(now + minutes * MINUTE), ...extra }, now);
  await saveVideo(id, Readable.from([file]), file.length);
  return id;
}
const state = (id: number) => getPost(id)?.state;
const files = () => readdirSync(process.env.POSTS_DIR as string);
const isContainer = (c: Call) => c.method === "POST" && c.path.endsWith("/media");
const isUpload = (c: Call) => c.method === "POST" && c.path.startsWith("/upload/");
const isPublish = (c: Call) => c.method === "POST" && c.path.endsWith("/media_publish");
const isStatus = (c: Call) => c.method === "GET" && /^\/CONT\d+$/.test(c.path);
const count = (which: (c: Call) => boolean) => mock.calls.filter(which).length;
const containerOf = (id: number) => mock.state.containers[getPost(id)?.containerId ?? ""];

/** Runs the timer at a few moments in a row, `step` apart, starting at `from`. The stand-in API's clock moves along. */
async function tick(from: number, times = 1, step = 35 * SECOND): Promise<void> {
  for (let i = 0, at = from; i < times; i++, at += step) {
    mock.state.time = at;
    await runPosts(at);
  }
}

describe("a scheduled reel", () => {
  it("is left alone until 15 minutes before its time, then handed to Instagram, and published at its time", async () => {
    const file = video(300_000);
    const id = await schedule(120, { thumbOffset: 2100, aiLabel: true }, file);
    const due = now + 2 * HOUR;
    assert.equal(files().length, 1, "the video waits on the disk");

    await tick(now);
    await tick(due - 16 * MINUTE);
    assert.equal(mock.calls.length, 0, "nothing at all before the lead time");
    assert.equal(state(id), "scheduled");

    // 15 minutes before: the container, exactly as the script that published a real reel makes it, then the file.
    mock.state.processingPolls = 2;
    await tick(due - 15 * MINUTE);
    const [container] = mock.calls.filter(isContainer);
    assert.equal(container.path, "/OWNER-IG/media");
    assert.deepEqual(container.body, {
      media_type: "REELS",
      upload_type: "resumable",
      caption: CAPTION,
      share_to_feed: "true",
      is_ai_generated: "true",
      thumb_offset: "2100",
    });
    assert.match(String(container.headers["content-type"]), /x-www-form-urlencoded/);
    assert.equal(container.headers.authorization, "Bearer seed-token");

    const [upload] = mock.calls.filter(isUpload);
    assert.equal(upload.headers.authorization, "OAuth seed-token");
    assert.equal(upload.headers.offset, "0");
    assert.equal(upload.headers.file_size, String(file.length));
    assert.equal(upload.headers["content-length"], String(file.length), "its length is announced, as in Meta's example");
    assert.equal(upload.headers["transfer-encoding"], undefined);
    assert.deepEqual(upload.body, { bytes: file.length, sha256: sha(file) }, "the file arrived whole");
    assert.equal(state(id), "processing");

    // Instagram is still processing, then done. Still not public.
    await tick(due - 15 * MINUTE + 35 * SECOND, 2);
    assert.equal(state(id), "processing");
    await tick(due - 13 * MINUTE);
    assert.equal(state(id), "ready");
    await tick(due - 10 * MINUTE, 3, 3 * MINUTE);
    await tick(due - SECOND);
    assert.equal(count(isPublish), 0, "not a second before its time");

    // What does the database say at the moment Instagram is told to publish? (A check that never fails a call, only looks.)
    let written: string | undefined;
    mock.state.faults.push({ when: (c) => (isPublish(c) && (written = state(id)), false) });
    await tick(due);
    assert.equal(written, "publishing", "'publishing' is in the database before Instagram hears of it");
    assert.equal(state(id), "published");
    assert.deepEqual(mock.published(), [[containerOf(id).id, getPost(id)?.mediaId]]);
    assert.equal(getPost(id)?.permalink, `https://www.instagram.com/reel/${getPost(id)?.mediaId}/`);
    assert.deepEqual(mock.calls.filter(isPublish)[0].body, { creation_id: containerOf(id).id });
    assert.deepEqual(files(), [], "the video is deleted once it's out");
    assert.ok(alerts.some((a) => a.includes("is out: https://www.instagram.com/reel/")), "the owner is told, with the link");

    await tick(due + MINUTE, 5, 10 * MINUTE);
    assert.equal(count(isPublish), 1, "and that was the only publish");
    assert.equal(allPosts()[0].link, getPost(id)?.permalink);
  });

  it("sends the cover and the labels as asked: a cover address instead of a frame, no AI label unless asked", async () => {
    const id = await schedule(10, { coverUrl: "https://yourbrand/cover.jpg", shareToFeed: false });
    await tick(now);
    assert.deepEqual(mock.calls.filter(isContainer)[0].body, {
      media_type: "REELS",
      upload_type: "resumable",
      caption: CAPTION,
      share_to_feed: "false",
      cover_url: "https://yourbrand/cover.jpg",
    });
    assert.equal(getPost(id)?.aiLabel, false);
  });

  it("goes out as soon as it's ready when scheduled for now, without a fuss while its video is still on its way", async () => {
    const { id } = createPost({ caption: CAPTION, at: "now" }, now);
    await tick(now + 5 * SECOND, 3, 20 * SECOND); // the timer comes round before the upload is done
    assert.deepEqual(alerts, [], "no reminder about a video that was asked for a minute ago");
    const file = video();
    await saveVideo(id, Readable.from([file]), file.length);
    await tick(now + 2 * MINUTE, 2);
    assert.equal(state(id), "published");
    assert.equal(count(isPublish), 1);
  });

  it("publishes two reels due at the same time, each once", async () => {
    const a = await schedule(30);
    const b = await schedule(30);
    await tick(now + 15 * MINUTE, 2);
    await tick(now + 30 * MINUTE);
    assert.deepEqual([state(a), state(b)], ["published", "published"]);
    assert.equal(mock.published().length, 2);
    assert.equal(count(isPublish), 2);
  });

  it("waits for a video that comes late, and says so once", async () => {
    const { id } = createPost({ caption: CAPTION, at: iso(now + 30 * MINUTE) }, now);
    await tick(now + 15 * MINUTE, 4);
    assert.equal(mock.calls.length, 0);
    assert.equal(alerts.filter((a) => a.includes("has no video yet")).length, 1);
    assert.equal(allPosts()[0].note, "no video uploaded yet");

    const file = video();
    await saveVideo(id, Readable.from([file]), file.length);
    await tick(now + 25 * MINUTE, 2);
    await tick(now + 30 * MINUTE);
    assert.equal(state(id), "published");
  });
});

describe("never twice", () => {
  /** A reel that is ready and due: the next tick publishes it. */
  async function readyAndDue(): Promise<{ id: number; due: number }> {
    const id = await schedule(20);
    await tick(now + 5 * MINUTE, 2);
    assert.equal(state(id), "ready");
    return { id, due: now + 20 * MINUTE };
  }

  it("when Instagram published it but the answer never came, asks Instagram instead of publishing again", async () => {
    const { id, due } = await readyAndDue();
    mock.state.faults.push({ when: isPublish, times: 1, loseAnswer: true });
    await tick(due);
    assert.equal(state(id), "publishing", "it doesn't know yet");
    assert.equal(mock.published().length, 1, "but it is out");

    // The process could die here and start again: all it knows is in the database.
    await tick(due + 35 * SECOND);
    assert.equal(state(id), "published");
    assert.equal(getPost(id)?.permalink, `https://www.instagram.com/reel/${mock.published()[0][1]}/`, "the link is found among the latest posts");
    assert.equal(count(isPublish), 1, "one publish call, ever");
    await tick(due + 10 * MINUTE, 6, 10 * MINUTE);
    assert.equal(count(isPublish), 1);
    assert.equal(mock.published().length, 1);
  });

  it("when the process dies right after writing 'publishing', waits five minutes, asks Instagram, and only then publishes", async () => {
    const { id, due } = await readyAndDue();
    // What a kill between the database write and the call leaves behind.
    changePost(id, "ready", { state: "publishing", publishingAt: due, attempts: 1 }, due);

    await tick(due + 35 * SECOND, 7);
    assert.equal(count(isPublish), 0, "Instagram says it isn't out, but a publish might still be on its way");
    assert.equal(state(id), "publishing");
    await tick(due + 5 * MINUTE + SECOND);
    assert.equal(state(id), "published");
    assert.equal(count(isPublish), 1);
    assert.equal(mock.published().length, 1);
  });

  it("when a publish call never reached Instagram, tries again after five minutes, and it goes out once", async () => {
    const { id, due } = await readyAndDue();
    mock.state.faults.push({ when: isPublish, times: 1, drop: true });
    await tick(due);
    assert.equal(state(id), "publishing");
    assert.equal(mock.published().length, 0);
    await tick(due + 35 * SECOND, 3);
    assert.equal(count(isPublish), 1);
    await tick(due + 5 * MINUTE + 5 * SECOND);
    assert.equal(state(id), "published");
    assert.equal(count(isPublish), 2);
    assert.equal(mock.published().length, 1);
  });

  it("gives up after three publishes that got no answer, and says it was not published", async () => {
    const { id, due } = await readyAndDue();
    mock.state.faults.push({ when: isPublish, drop: true });
    await tick(due, 40, 35 * SECOND);
    assert.equal(count(isPublish), 3);
    assert.equal(state(id), "failed");
    assert.equal(mock.published().length, 0);
    assert.ok(alerts.some((a) => a.includes("was NOT published") && a.includes("3 tries")));
    await tick(due + 30 * MINUTE, 5, 10 * MINUTE);
    assert.equal(count(isPublish), 3);
  });

  it("when Instagram refuses the publish outright, stops there", async () => {
    const { id, due } = await readyAndDue();
    mock.state.faults.push({ when: isPublish, status: 400, error: { message: "The user is not an Instagram Business", code: 10 } });
    await tick(due);
    assert.equal(state(id), "failed");
    assert.match(getPost(id)?.error ?? "", /Instagram refused to publish it: The user is not an Instagram Business/);
    await tick(due + MINUTE, 10, MINUTE);
    assert.equal(count(isPublish), 1);
  });

  it("keeps asking when Instagram can't be reached after a publish, and publishes nothing meanwhile", async () => {
    const { id, due } = await readyAndDue();
    mock.state.faults.push({ when: isPublish, times: 1, loseAnswer: true });
    await tick(due);
    mock.state.expiredTokens = ["seed-token"]; // and now Instagram turns every call away
    await tick(due + MINUTE, 3, 5 * MINUTE);
    assert.equal(state(id), "publishing");
    assert.ok(alerts.some((a) => a.includes("may or may not be out")));
    mock.state.expiredTokens = [];
    await tick(due + 3 * HOUR);
    assert.equal(state(id), "published", "hours later it finds out: it had gone out");
    assert.equal(count(isPublish), 1);
  });

  it("doesn't publish what was published by hand in the meantime", async () => {
    const { id, due } = await readyAndDue();
    const container = containerOf(id);
    container.status_code = "PUBLISHED"; // someone ran post-reel.mjs publish --container …
    await tick(due);
    assert.equal(state(id), "published");
    assert.equal(count(isPublish), 0);
  });

  it("doesn't publish a reel cancelled a moment before its time, and can't cancel one that is being published", async () => {
    const { id, due } = await readyAndDue();
    cancelPost(id);
    await tick(due, 3);
    assert.equal(count(isPublish), 0);
    assert.equal(state(id), "cancelled");

    const other = await schedule(20);
    changePost(other, "scheduled", { state: "publishing", publishingAt: now, attempts: 1 });
    assert.throws(() => cancelPost(other), (e: unknown) => e instanceof Refused && e.status === 409 && /too late to cancel/.test(e.message));
  });
});

describe("when something goes wrong before the publish", () => {
  it("tries again when Instagram fails for a moment, and still publishes on time", async () => {
    const id = await schedule(30);
    mock.state.faults.push({ when: isContainer, times: 1, status: 500, error: { code: 2 } });
    await tick(now + 15 * MINUTE);
    assert.equal(state(id), "uploading");
    await tick(now + 15 * MINUTE + 35 * SECOND, 2);
    assert.equal(state(id), "ready");
    await tick(now + 30 * MINUTE);
    assert.equal(state(id), "published");
    assert.equal(count(isContainer), 2);
  });

  it("starts over with a new container when the file didn't get through", async () => {
    const id = await schedule(30);
    mock.state.faults.push({ when: isUpload, times: 1, drop: true });
    await tick(now + 15 * MINUTE);
    assert.equal(state(id), "uploading");
    await tick(now + 16 * MINUTE, 2);
    assert.equal(state(id), "ready");
    assert.equal(count(isContainer), 2);
    await tick(now + 30 * MINUTE);
    const gotTheFile = Object.values(mock.state.containers).filter((c) => c.upload);
    assert.deepEqual(mock.published().map(([container]) => container), [gotTheFile[0].id], "the second container, the one that got the file, is the one published");
    assert.equal(gotTheFile.length, 1);
  });

  it("fails the post, deletes its video and says why when Instagram can't use the video", async () => {
    const id = await schedule(30);
    await tick(now + 15 * MINUTE);
    Object.assign(containerOf(id), { status_code: "ERROR", status: "Error: unsupported video format" });
    await tick(now + 16 * MINUTE);
    assert.equal(state(id), "failed");
    assert.match(getPost(id)?.error ?? "", /Instagram couldn't use the video \(ERROR: Error: unsupported video format\)/);
    assert.ok(alerts.some((a) => a.includes("was NOT published") && a.includes("unsupported video format")));
    assert.deepEqual(files(), []);
    await tick(now + 30 * MINUTE, 3);
    assert.equal(count(isPublish), 0);
  });

  it("fails the post at once, with the reason, when its video is gone from the disk", async () => {
    const id = await schedule(30);
    rmSync(join(process.env.POSTS_DIR as string, files()[0]));
    await tick(now + 15 * MINUTE);
    assert.equal(state(id), "failed");
    assert.ok(alerts.some((a) => a.includes("was NOT published: its video file is gone from the server")));
    assert.equal(mock.calls.length, 0);
  });

  it("fails the post when its container has expired by the time it's due", async () => {
    const id = await schedule(30);
    await tick(now + 15 * MINUTE, 2);
    assert.equal(state(id), "ready");
    containerOf(id).status_code = "EXPIRED";
    await tick(now + 30 * MINUTE);
    assert.equal(state(id), "failed");
    assert.match(getPost(id)?.error ?? "", /its container is EXPIRED/);
    assert.ok(alerts.some((a) => a.includes("was NOT published")));
    assert.equal(count(isPublish), 0);
  });

  it("keeps trying while the token is turned away, and says so: that can be fixed in time", async () => {
    const id = await schedule(30);
    mock.state.expiredTokens = ["seed-token"];
    await tick(now + 15 * MINUTE, 3, MINUTE);
    assert.equal(state(id), "uploading");
    assert.ok(alerts.some((a) => a.includes("is stuck") && a.includes("code 190")));
    mock.state.expiredTokens = [];
    await tick(now + 25 * MINUTE, 2);
    await tick(now + 30 * MINUTE);
    assert.equal(state(id), "published");
  });
});

describe("a reel whose time has passed", () => {
  it("still goes out when the bot comes back a little late", async () => {
    const id = await schedule(30);
    await tick(now + 50 * MINUTE, 3); // down from before the lead time until 20 minutes after
    assert.equal(state(id), "published");
    assert.equal(mock.published().length, 1);
  });

  it("is marked missed, not published, when the bot comes back more than an hour late", async () => {
    const id = await schedule(30);
    await tick(now + 30 * MINUTE + 61 * MINUTE, 3);
    assert.equal(state(id), "missed");
    assert.equal(mock.calls.length, 0, "nothing was sent to Instagram");
    assert.ok(alerts.some((a) => a.includes("was NOT published") && a.includes("more than 60 minutes late")));
    assert.deepEqual(files(), []);
  });

  it("is marked missed when it was ready but the bot was down at its time and for an hour after", async () => {
    const id = await schedule(30);
    await tick(now + 15 * MINUTE, 2);
    assert.equal(state(id), "ready");
    await tick(now + 30 * MINUTE + 2 * HOUR);
    assert.equal(state(id), "missed");
    assert.equal(count(isPublish), 0);
  });

  it("is marked missed when no video ever came", async () => {
    const { id } = createPost({ caption: CAPTION, at: iso(now + 30 * MINUTE) }, now);
    await tick(now + 30 * MINUTE + 61 * MINUTE);
    assert.equal(state(id), "missed");
    assert.match(getPost(id)?.error ?? "", /no video was ever uploaded/);
  });

  it("follows POST_LEAD_MINUTES and POST_GRACE_MINUTES", async () => {
    process.env.POST_LEAD_MINUTES = "5";
    process.env.POST_GRACE_MINUTES = "10";
    const early = await schedule(30);
    await tick(now + 24 * MINUTE);
    assert.equal(mock.calls.length, 0);
    await tick(now + 25 * MINUTE, 2);
    assert.equal(state(early), "ready");
    const late = await schedule(30);
    changePost(early, "ready", { state: "cancelled" });
    await tick(now + 41 * MINUTE);
    assert.equal(state(late), "missed");
  });
});

describe("the schedule", () => {
  const refusal = (input: unknown) => {
    try {
      createPost(input, now);
    } catch (e) {
      assert.ok(e instanceof Refused, String(e));
      return `${e.status} ${e.message}`;
    }
    return "accepted";
  };
  const soon = () => iso(now + HOUR);

  it("takes a post with a time and its offset, and says what it understood", () => {
    const made = createPost({ caption: `  ${CAPTION}\n`, at: "2031-03-01T18:30:00+01:00", thumbOffset: 2100 }, now);
    assert.equal(made.state, "scheduled");
    assert.equal(made.publishAt, "2031-03-01T17:30:00Z");
    assert.equal(made.cover, "the frame at 2100 ms");
    assert.equal(made.video, "not uploaded yet");
    assert.equal(made.caption, "I built my own Instagram DM bot in one evening.");
    assert.match(made.next, /PUT \/admin\/posts\/\d+\/video/);
    assert.equal(getPost(made.id)?.caption, CAPTION, "kept without the spaces around it");
  });

  it("turns down what Instagram would turn down, in a sentence", () => {
    assert.match(refusal({ at: soon() }), /^400 caption is missing/);
    assert.match(refusal({ caption: "x".repeat(2201), at: soon() }), /^400 The caption is 2201 characters; Instagram allows 2200\./);
    assert.equal(refusal({ caption: "😀".repeat(2200), at: soon() }), "accepted", "an emoji is one character");
    assert.match(refusal({ caption: Array.from({ length: 31 }, (_, i) => `#tag${i}`).join(" "), at: soon() }), /^400 The caption has 31 hashtags; Instagram allows 30\./);
    assert.match(refusal({ caption: Array.from({ length: 21 }, (_, i) => `@user${i}`).join(" "), at: soon() }), /^400 The caption has 21 @ tags; Instagram allows 20\./);
    assert.equal(refusal({ caption: "write to me@example.com", at: soon() }), "accepted", "an email address isn't a tag");
  });

  it("wants a time it can't misread", () => {
    assert.match(refusal({ caption: "x" }), /^400 at is missing or has no time zone/);
    assert.match(refusal({ caption: "x", at: "2031-03-01T18:30:00" }), /^400 at is missing or has no time zone/);
    assert.match(refusal({ caption: "x", at: "tomorrow at 6+01:00" }), /^400 at isn't a time I can read/);
    assert.match(refusal({ caption: "x", at: iso(now - HOUR) }), /^400 That time is in the past/);
    assert.equal(refusal({ caption: "x", at: "now" }), "accepted");
    assert.equal(refusal({ caption: "x", at: "2031-03-01T18:30:00Z" }), "accepted");
  });

  it("wants one cover at most, and a real one", () => {
    assert.match(refusal({ caption: "x", at: soon(), thumbOffset: 100, coverUrl: "https://a.b/c.jpg" }), /^400 Give thumbOffset or coverUrl, not both/);
    assert.match(refusal({ caption: "x", at: soon(), thumbOffset: -5 }), /^400 thumbOffset is the cover frame in milliseconds/);
    assert.match(refusal({ caption: "x", at: soon(), thumbOffset: "2100" }), /^400 thumbOffset is the cover frame in milliseconds/);
    assert.match(refusal({ caption: "x", at: soon(), coverUrl: "http://a.b/c.jpg" }), /^400 coverUrl must be the https address/);
    assert.match(refusal({ caption: "x", at: soon(), aiLabel: "yes" }), /^400 aiLabel and shareToFeed are true or false/);
    assert.match(refusal("caption"), /^400 Send the post as JSON/);
  });

  it("lists the posts: what is coming first, in order, then what is over", async () => {
    const later = await schedule(300);
    const sooner = await schedule(20);
    const gone = await schedule(60);
    cancelPost(gone);
    assert.deepEqual(
      allPosts().map((p) => [p.id, p.state]),
      [
        [sooner, "scheduled"],
        [later, "scheduled"],
        [gone, "cancelled"],
      ],
    );
    assert.match(allPosts()[0].video, /MB$/);
  });

  it("cancels a post and deletes its video, wherever it has got to", async () => {
    const waiting = await schedule(60);
    const processing = await schedule(16);
    mock.state.processingPolls = 50;
    await tick(now + 2 * MINUTE);
    assert.equal(state(processing), "processing");
    assert.equal(files().length, 2);

    assert.equal(cancelPost(waiting).state, "cancelled");
    assert.equal(cancelPost(processing).state, "cancelled");
    assert.deepEqual(files(), []);
    await tick(now + 16 * MINUTE, 3);
    await tick(now + 60 * MINUTE, 3);
    assert.equal(count(isPublish), 0);
    assert.throws(() => cancelPost(waiting), (e: unknown) => e instanceof Refused && e.status === 409);
    assert.throws(() => cancelPost(999), (e: unknown) => e instanceof Refused && e.status === 404);
  });
});

describe("a video on its way in", () => {
  const body = (file: Buffer, chunk = 64 * 1024) => Readable.from(Array.from({ length: Math.ceil(file.length / chunk) }, (_, i) => file.subarray(i * chunk, (i + 1) * chunk)));
  const refused = async (run: Promise<unknown>) => {
    try {
      await run;
    } catch (e) {
      assert.ok(e instanceof Refused, String(e));
      return `${e.status} ${e.message}`;
    }
    return "accepted";
  };
  const newPost = () => createPost({ caption: CAPTION, at: iso(now + HOUR) }, now).id;

  it("is written to the disk as it arrives, under a name the server chose", async () => {
    const id = newPost();
    const file = video(3_000_000, 42);
    assert.deepEqual(await saveVideo(id, body(file)), { id, bytes: file.length });
    const [name] = files();
    assert.match(name, /^post-\d+-[0-9a-f]{8}\.mp4$/);
    assert.equal(getPost(id)?.file, name);
    assert.equal(getPost(id)?.size, file.length);
    await tick(now + 46 * MINUTE);
    assert.deepEqual(mock.calls.filter(isUpload)[0].body, { bytes: file.length, sha256: sha(file) }, "and reaches Instagram byte for byte");
  });

  it("is cut off at the size limit, whether the request says its size or not, and leaves nothing behind", async () => {
    process.env.POST_MAX_MB = "1";
    const id = newPost();
    const big = video(1024 * 1024 + 1);
    assert.match(await refused(saveVideo(id, body(big), big.length)), /^413 The video is over 1 MB/);
    assert.match(await refused(saveVideo(id, body(big))), /^413 The video is over 1 MB/);
    assert.deepEqual(files(), []);
    assert.equal(getPost(id)?.file, null);
    assert.equal(await refused(saveVideo(id, body(video(1024 * 1024)))), "accepted", "exactly the limit is fine");
  });

  it("is turned down when it isn't a video, is empty, or the post isn't waiting for one", async () => {
    const id = newPost();
    assert.match(await refused(saveVideo(id, Readable.from([Buffer.from('{"error":"not found"}')]))), /^400 That doesn't look like an MP4 or MOV file/);
    assert.match(await refused(saveVideo(id, Readable.from([]))), /^400 No file came with the request/);
    assert.match(await refused(saveVideo(999, body(video()))), /^404 There is no post 999/);
    cancelPost(id);
    assert.match(await refused(saveVideo(id, body(video()))), /^409 Post \d+ is cancelled: its video can't be changed any more/);
    assert.deepEqual(files(), []);
  });

  it("replaces the one sent before, as long as the post is still waiting", async () => {
    const id = newPost();
    await saveVideo(id, body(video(5000, 1)));
    const first = files();
    const second = video(6000, 2);
    await saveVideo(id, body(second));
    assert.equal(files().length, 1);
    assert.notDeepEqual(files(), first);
    await tick(now + 46 * MINUTE);
    assert.deepEqual(mock.calls.filter(isUpload)[0].body, { bytes: 6000, sha256: sha(second) });
    assert.match(await refused(saveVideo(id, body(video()))), /^409 Post \d+ is processing/);
  });

  it("leaves no half-written file after a restart", async () => {
    const id = newPost();
    const broken = new Readable({ read() {} });
    const upload = saveVideo(id, broken);
    broken.push(video(1000));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(files().filter((f) => f.endsWith(".part")).length, 1);
    broken.destroy(new Error("connection lost"));
    assert.match(await refused(upload), /^400 The upload broke off: connection lost/);
    assert.deepEqual(files(), []);

    // And if the process died mid-upload, or before it could delete a published reel's video, the next start clears up.
    const kept = newPost();
    await saveVideo(kept, body(video()));
    const again = saveVideo(id, new Readable({ read() {} }).on("error", () => undefined));
    await new Promise((resolve) => setTimeout(resolve, 20));
    writeFileSync(join(process.env.POSTS_DIR as string, "post-77-0badf00d.mp4"), video());
    assert.equal(files().length, 3);
    clearLeftovers();
    assert.deepEqual(files(), [getPost(kept)?.file], "only the video of a post that still needs it stays");
    void again.catch(() => undefined);
  });

  it("is turned down when it would leave the disk, where the database lives too, almost full", async () => {
    process.env.POST_MAX_MB = "100000000000";
    const id = newPost();
    assert.match(await refused(saveVideo(id, body(video()), 1e17)), /^507 The server's disk has \d+ MB free: not enough for this video and the bot's database/);
    assert.deepEqual(files(), []);
  });
});
