import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statfsSync } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { alert } from "../alert.ts";
import { config, DAY, MINUTE, SECOND } from "../config.ts";
import { type Post, type PostState, addPost, changePost, getPost, listPosts, postsInHand } from "../db.ts";
import {
  containerStatus,
  createReelContainer,
  describe,
  failureKind,
  getPermalink,
  GraphError,
  listMedia,
  publishContainer,
  sendVideo,
} from "./graph.ts";
import { parseTime } from "./match.ts";

/**
 * Scheduled reels. A post waits in the database with its video on the disk
 * next to it, and a timer (server.ts) walks it through its states:
 *
 *   scheduled   waiting for its time.
 *   uploading   POST_LEAD_MINUTES before its time: a container is opened at
 *               Instagram and the file sent to it.
 *   processing  Instagram is working on the video; the bot asks every half
 *               minute.
 *   ready       Instagram says FINISHED; the bot waits for the time.
 *   publishing  the time has come and the bot has told Instagram to publish.
 *   published   it's out, with its link. The video is deleted.
 * or it ends as
 *   failed      Instagram refused something, for good; Telegram says what.
 *   missed      it would have gone out more than POST_GRACE_MINUTES late (the
 *               bot was down, Instagram was slow), so it didn't go out at all.
 *   cancelled   by you.
 *
 * Publishing is public and can't be taken back, so the rule here is the
 * opposite of the DM queue's: when in doubt, don't. In particular a post is
 * never published twice:
 * - "publishing" is written to the database before Instagram is told, so a
 *   restart knows a publish may be under way;
 * - whenever a publish didn't plainly succeed (no answer, an error, a
 *   restart), the bot first asks Instagram for the container's status.
 *   PUBLISHED means it went out. FINISHED means it didn't, but only after
 *   five minutes is that believed and the publish tried again, three times
 *   at most;
 * - every change of state is made only if the post is still in the state the
 *   step found it in, so a post cancelled a moment ago stays cancelled.
 */

/**
 * How often a post in the works is looked at again (Meta suggests asking for
 * a container's status once a minute), and how soon after the upload the
 * first look comes: a short reel is processed in seconds.
 */
const POLL = 30 * SECOND;
const FIRST_LOOK = 10 * SECOND;
/** Instagram processes a short reel in under a minute. After this long, something is wrong. */
const PROCESSING_LIMIT = 30 * MINUTE;
/** How long a publish that may still be on its way is given before the bot believes it didn't happen. */
const SETTLE = 5 * MINUTE;
const MAX_PUBLISH_TRIES = 3;
/** A post inside its lead time with no video this long after it was scheduled gets a reminder. */
const NO_VIDEO_AFTER = 10 * MINUTE;
/** The disk also holds the database. An upload is turned down if it would leave less than this free. */
const DISK_RESERVE = 200 * 1024 * 1024;
/** A container lasts 24 hours. After that there is nothing left to ask Instagram about. */
const CONTAINER_LIFE = DAY;

/** Meta's limits for a reel's caption ("IG User Media" reference). */
const MAX_CAPTION = 2200;
const MAX_HASHTAGS = 30;
const MAX_MENTIONS = 20;

/** A request the admin API turns down, with the HTTP status to answer and a sentence for whoever asked. */
export class Refused extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "Refused";
    this.status = status;
  }
}

const when = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");
const path = (file: string) => join(config.postsDir, file);

/** What /admin/posts shows of a post. */
export function summary(post: Post) {
  return {
    id: post.id,
    state: post.state,
    publishAt: when(post.publishAt),
    caption: post.caption.split("\n")[0].slice(0, 80),
    video: post.size === null ? "not uploaded yet" : `${(post.size / 1e6).toFixed(1)} MB`,
    cover: post.coverUrl ?? (post.thumbOffset === null ? "the first frame" : `the frame at ${post.thumbOffset} ms`),
    aiLabel: post.aiLabel,
    shareToFeed: post.shareToFeed,
    ...(post.containerId ? { container: post.containerId } : {}),
    ...(post.mediaId ? { media: post.mediaId } : {}),
    ...(post.permalink ? { link: post.permalink } : {}),
    ...(post.error ? { note: post.error } : {}),
  };
}

export function allPosts() {
  return listPosts().map(summary);
}

/**
 * Checks a new post and puts it on the schedule. `at` is "now" or a time
 * with its offset ("2026-11-20T18:30:00+01:00", or ending in Z): the server
 * doesn't guess a time zone.
 */
export function createPost(input: unknown, now = Date.now()) {
  if (typeof input !== "object" || input === null) throw new Refused(400, "Send the post as JSON: { caption, at, … }.");
  const { caption, at, thumbOffset, coverUrl, aiLabel = false, shareToFeed = true } = input as Record<string, unknown>;

  if (typeof caption !== "string") throw new Refused(400, "caption is missing.");
  const text = caption.trim();
  const chars = [...text].length;
  const hashtags = (text.match(/#[\p{L}\p{N}_]+/gu) ?? []).length;
  const mentions = (text.match(/(?<![\p{L}\p{N}_.])@[\p{L}\p{N}_.]+/gu) ?? []).length;
  if (chars > MAX_CAPTION) throw new Refused(400, `The caption is ${chars} characters; Instagram allows ${MAX_CAPTION}.`);
  if (hashtags > MAX_HASHTAGS) throw new Refused(400, `The caption has ${hashtags} hashtags; Instagram allows ${MAX_HASHTAGS}.`);
  if (mentions > MAX_MENTIONS) throw new Refused(400, `The caption has ${mentions} @ tags; Instagram allows ${MAX_MENTIONS}.`);

  let publishAt = now - (now % SECOND);
  if (at !== "now") {
    if (typeof at !== "string" || !/(Z|[+-]\d{2}:?\d{2})$/.test(at)) {
      throw new Refused(400, 'at is missing or has no time zone. Give "now", or a time with its offset, like 2026-11-20T18:30:00+01:00.');
    }
    publishAt = parseTime(at);
    if (Number.isNaN(publishAt)) throw new Refused(400, `at isn't a time I can read: ${at}`);
    if (publishAt < now - MINUTE) throw new Refused(400, `That time is in the past: ${when(publishAt)} (it is ${when(now)}).`);
  }

  if (thumbOffset !== undefined && coverUrl !== undefined) throw new Refused(400, "Give thumbOffset or coverUrl, not both.");
  if (thumbOffset !== undefined && !(typeof thumbOffset === "number" && Number.isInteger(thumbOffset) && thumbOffset >= 0)) {
    throw new Refused(400, "thumbOffset is the cover frame in milliseconds from the start: a whole number, 0 or more.");
  }
  if (coverUrl !== undefined && !(typeof coverUrl === "string" && URL.canParse(coverUrl) && new URL(coverUrl).protocol === "https:")) {
    throw new Refused(400, "coverUrl must be the https address of a JPEG that Instagram can fetch.");
  }
  if (typeof aiLabel !== "boolean" || typeof shareToFeed !== "boolean") throw new Refused(400, "aiLabel and shareToFeed are true or false.");

  const id = addPost({ caption: text, publishAt, thumbOffset: thumbOffset as number | undefined, coverUrl: coverUrl as string | undefined, aiLabel, shareToFeed }, now);
  return { ...summary(getPost(id) as Post), next: `Send the video: PUT /admin/posts/${id}/video with the file as the body.` };
}

/**
 * Takes a post's video from a request and writes it straight to the disk, so
 * a 300 MB file never sits in memory. `declared` is the request's
 * Content-Length, when it has one. A second upload replaces the first, as
 * long as the post is still waiting for its time.
 */
export async function saveVideo(id: number, body: Readable, declared?: number): Promise<{ id: number; bytes: number }> {
  const max = config.postMaxBytes;
  const tooBig = () => new Refused(413, `The video is over ${Math.round(max / (1024 * 1024))} MB, Instagram's limit for a reel.`);
  const post = getPost(id);
  if (!post) throw new Refused(404, `There is no post ${id}.`);
  if (post.state !== "scheduled") throw new Refused(409, `Post ${id} is ${post.state}: its video can't be changed any more.`);
  if (declared !== undefined && declared > max) throw tooBig();

  mkdirSync(config.postsDir, { recursive: true });
  const { bavail, bsize } = statfsSync(config.postsDir);
  const free = bavail * bsize;
  if (free < (declared ?? max) + DISK_RESERVE) {
    throw new Refused(507, `The server's disk has ${Math.round(free / 1e6)} MB free: not enough for this video and the bot's database. Cancel a scheduled post, or give the volume more room.`);
  }
  const name = `post-${id}-${randomBytes(4).toString("hex")}.mp4`;
  const part = path(`${name}.part`);
  const file = createWriteStream(part);
  let bytes = 0;
  let start = Buffer.alloc(0);
  try {
    // Chunk by chunk, waiting whenever the disk is slower than the network. The request is left open
    // when this stops early, so that the refusal can still be answered on it.
    for await (const chunk of body.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer>) {
      bytes += chunk.length;
      if (bytes > max) throw tooBig();
      if (start.length < 12) start = Buffer.concat([start, chunk]).subarray(0, 12);
      if (!file.write(chunk)) await once(file, "drain");
    }
    file.end();
    await finished(file);
    if (bytes === 0) throw new Refused(400, "No file came with the request.");
    // Every MP4 and MOV file says "ftyp" in its first bytes. This catches the wrong file now rather than at Instagram, minutes before the post is due.
    if (start.subarray(4, 8).toString("latin1") !== "ftyp") throw new Refused(400, "That doesn't look like an MP4 or MOV file.");
    renameSync(part, path(name));
  } catch (e) {
    file.destroy();
    rmSync(part, { force: true });
    throw e instanceof Refused ? e : new Refused(400, `The upload broke off: ${e instanceof Error ? e.message : e}`);
  }
  // The post may have been cancelled, or come due, while the file was arriving.
  if (!changePost(id, "scheduled", { file: name, size: bytes, error: null })) {
    rmSync(path(name), { force: true });
    throw new Refused(409, `Post ${id} is no longer waiting for a video.`);
  }
  if (post.file) rmSync(path(post.file), { force: true });
  return { id, bytes };
}

/** Takes a post off the schedule and deletes its video. Not possible once Instagram has been told to publish. */
export function cancelPost(id: number) {
  const post = getPost(id);
  if (!post) throw new Refused(404, `There is no post ${id}.`);
  if (!changePost(id, ["scheduled", "uploading", "processing", "ready"], { state: "cancelled", file: null })) {
    throw new Refused(409, `Post ${id} is ${getPost(id)?.state}: too late to cancel.`);
  }
  if (post.file) rmSync(path(post.file), { force: true });
  return summary(getPost(id) as Post);
}

/**
 * Deletes what doesn't belong to a post any more from the posts folder: the
 * half of an upload that was interrupted, and a video whose post is over but
 * whose file a restart kept from being deleted. server.ts calls it at the start.
 */
export function clearLeftovers(): void {
  const wanted = new Set(listPosts().map((post) => post.file));
  try {
    for (const file of readdirSync(config.postsDir)) if (!wanted.has(file)) rmSync(path(file), { force: true });
  } catch {
    // no folder yet: nothing was ever uploaded
  }
}

const ACTIVE: PostState[] = ["scheduled", "uploading", "processing", "ready", "publishing"];
let run: Promise<void> | undefined;

/** Moves every post that has something to do one step on. The timer calls it; never two runs at once. */
export function runPosts(now = Date.now()): Promise<void> {
  run ??= walk(now).finally(() => {
    run = undefined;
  });
  return run;
}

/** Resolves when the run under way, if there is one, has ended. server.ts gives it a moment before it stops. */
export function postsAtRest(): Promise<void> {
  return run ?? Promise.resolve();
}

async function walk(now: number): Promise<void> {
  const started = Date.now();
  // A step can take minutes (a big upload): the time is `now` plus what has passed since.
  const at = () => now + (Date.now() - started);
  for (const { id } of postsInHand(now)) {
    // Read again just before its turn: an earlier post's upload can take minutes, and this one may have changed meanwhile.
    const post = getPost(id);
    if (!post || !ACTIVE.includes(post.state) || post.dueAt > at()) continue;
    try {
      await step(post, at);
    } catch (e) {
      setback(getPost(id) ?? post, e, at());
    }
  }
}

type Clock = () => number;

async function step(post: Post, at: Clock): Promise<void> {
  switch (post.state) {
    case "scheduled": {
      const late = at() - post.publishAt;
      if (late > config.postGrace) return miss(post, post.file ? "the bot wasn't running at its time" : "no video was ever uploaded for it");
      if (late < -config.postLead) return;
      if (!post.file) {
        // Not in the minutes after it was scheduled: its video may be on its way right now.
        if (!post.error && at() - post.createdAt > NO_VIDEO_AFTER) {
          changePost(post.id, "scheduled", { error: "no video uploaded yet" });
          void alert(`post ${post.id} no video`, `the reel scheduled for ${when(post.publishAt)} has no video yet. Upload it, or it won't go out.`);
        }
        return;
      }
      if (!changePost(post.id, "scheduled", { state: "uploading", attempts: 0, error: null })) return;
      return upload(post, at);
    }
    case "uploading":
      // Still "uploading" at the start of a step means the last try didn't finish (a restart, a failure): start over with a new container.
      return upload(post, at);
    case "processing":
      return checkProcessing(post, at);
    case "ready":
      return publishWhenDue(post, at);
    case "publishing":
      return afterPublish(post, at);
  }
}

async function upload(post: Post, at: Clock): Promise<void> {
  if (at() - post.publishAt > config.postGrace) return miss(post, "its video couldn't be handed to Instagram in time");
  if (!post.file || post.size === null || !existsSync(path(post.file))) return fail(post, "its video file is gone from the server");
  const container = await createReelContainer({
    caption: post.caption,
    shareToFeed: post.shareToFeed,
    aiLabel: post.aiLabel,
    thumbOffset: post.thumbOffset ?? undefined,
    coverUrl: post.coverUrl ?? undefined,
  });
  if (!container.id || !container.uri) throw new GraphError(`Instagram gave no upload address: ${JSON.stringify(container).slice(0, 200)}`, 400);
  if (!changePost(post.id, "uploading", { containerId: container.id, containerAt: at() })) return;
  await sendVideo(container.uri, path(post.file), post.size);
  if (!changePost(post.id, "uploading", { state: "processing", attempts: 0, dueAt: at() + FIRST_LOOK })) return;
  console.log(`post ${post.id}: video sent to Instagram (container ${container.id}), due ${when(post.publishAt)}`);
}

async function checkProcessing(post: Post, at: Clock): Promise<void> {
  const status = await containerStatus(post.containerId ?? "");
  switch (status.status_code) {
    case "FINISHED":
      if (!changePost(post.id, "processing", { state: "ready", attempts: 0, dueAt: 0 })) return;
      return publishWhenDue({ ...post, state: "ready", attempts: 0 }, at);
    case "IN_PROGRESS":
      if (at() - (post.containerAt ?? at()) > PROCESSING_LIMIT) return fail(post, "Instagram was still processing the video after 30 minutes");
      changePost(post.id, "processing", { dueAt: at() + POLL });
      return;
    case "PUBLISHED":
      return itWentOut(post, at, "it was published from somewhere else");
    default:
      return fail(post, `Instagram couldn't use the video (${status.status_code ?? "no status"}${status.status ? `: ${status.status}` : ""})`);
  }
}

async function publishWhenDue(post: Post, at: Clock): Promise<void> {
  const late = at() - post.publishAt;
  if (late > config.postGrace) return miss(post, "it was ready too late");
  if (late < 0) {
    changePost(post.id, "ready", { dueAt: post.publishAt });
    return;
  }
  // One more look right before it goes public: is the container still there, and still unpublished?
  const status = await containerStatus(post.containerId ?? "");
  if (status.status_code === "PUBLISHED") return itWentOut(post, at, "it was published from somewhere else");
  if (status.status_code !== "FINISHED") return fail(post, `its container is ${status.status_code ?? "gone"}${status.status ? ` (${status.status})` : ""}`);
  // Written down before Instagram is told: from here on, a restart must ask Instagram what happened.
  if (!changePost(post.id, "ready", { state: "publishing", publishingAt: at(), attempts: 1 })) return;
  return publish({ ...post, attempts: 1 }, at);
}

async function publish(post: Post, at: Clock): Promise<void> {
  let media: { id?: string };
  try {
    media = await publishContainer(post.containerId ?? "");
  } catch (e) {
    // Meta refusing outright is an answer: it did not go out. Anything else leaves it open, and afterPublish() asks.
    if (failureKind(e) === "permanent" && !(e instanceof GraphError && e.maybeSent)) {
      return fail(post, `Instagram refused to publish it: ${describe(e)} (container ${post.containerId})`);
    }
    changePost(post.id, "publishing", { error: `publish: ${describe(e)}`, dueAt: at() + POLL });
    console.warn(`post ${post.id}: the publish got no clear answer (${describe(e)}); asking Instagram what happened`);
    return;
  }
  if (!media.id) {
    changePost(post.id, "publishing", { error: "publish: the answer had no id", dueAt: at() + POLL });
    return;
  }
  return itIsOut(post, media.id, at);
}

/** A post found in "publishing": the last publish didn't plainly succeed, or the bot restarted in the middle of it. */
async function afterPublish(post: Post, at: Clock): Promise<void> {
  const status = await containerStatus(post.containerId ?? "");
  if (status.status_code === "PUBLISHED") return itWentOut(post, at, "");
  if (status.status_code === "IN_PROGRESS") {
    changePost(post.id, "publishing", { dueAt: at() + POLL });
    return;
  }
  if (status.status_code !== "FINISHED") {
    return fail(post, `after the publish its container is ${status.status_code ?? "gone"}${status.status ? ` (${status.status})` : ""}. Look on Instagram whether it's there`);
  }
  // Instagram says it has not gone out. A publish may still be on its way, so that is believed only after five minutes.
  if (at() - (post.publishingAt ?? 0) < SETTLE) {
    changePost(post.id, "publishing", { dueAt: at() + POLL });
    return;
  }
  if (at() - post.publishAt > config.postGrace) return miss(post, "the publish didn't go through in time");
  if (post.attempts >= MAX_PUBLISH_TRIES) {
    return fail(post, `${MAX_PUBLISH_TRIES} tries to publish it got no clear answer, and Instagram says it isn't out (container ${post.containerId})`);
  }
  if (!changePost(post.id, "publishing", { publishingAt: at(), attempts: post.attempts + 1 })) return;
  return publish({ ...post, attempts: post.attempts + 1 }, at);
}

/** Instagram says the container is published, but the bot doesn't have the new post's id: look it up among the latest posts. */
async function itWentOut(post: Post, at: Clock, how: string): Promise<void> {
  const since = (post.publishingAt ?? post.containerAt ?? at()) - 10 * MINUTE;
  const latest = await listMedia(10).catch(() => []);
  const match = latest.find((m) => (m.caption ?? "").trim() === post.caption && parseTime(m.timestamp ?? "") >= since);
  if (!changePost(post.id, ["processing", "ready", "publishing"], { state: "published", mediaId: match?.id ?? null, permalink: match?.permalink ?? null, error: how || null, dueAt: 0 })) return;
  done(post);
  void alert(`post ${post.id} out`, `the reel scheduled for ${when(post.publishAt)} is out${how ? ` (${how})` : ""}: ${match?.permalink ?? "Instagram says so, but I couldn't find its link"}`);
}

/** The publish answered with the new post's id. */
async function itIsOut(post: Post, mediaId: string, at: Clock): Promise<void> {
  // First of all, written down: it is out, whatever happens to the rest of this step.
  changePost(post.id, "publishing", { state: "published", mediaId, error: null, dueAt: 0 });
  done(post);
  const permalink = await getPermalink(mediaId).catch(() => "");
  if (permalink) changePost(post.id, "published", { permalink });
  const late = Math.round((at() - post.publishAt) / SECOND);
  console.log(`post ${post.id}: published${late > 90 ? ` ${Math.round(late / 60)} min late` : ""}: ${permalink || `media ${mediaId}`}`);
  void alert(`post ${post.id} out`, `the reel scheduled for ${when(post.publishAt)} is out: ${permalink || `media ${mediaId} (no link came back)`}`);
}

/** The video has done its job, or never will. */
function done(post: Post): void {
  if (post.file) rmSync(path(post.file), { force: true });
  changePost(post.id, ["published", "failed", "missed"], { file: null });
}

function fail(post: Post, why: string): void {
  if (!changePost(post.id, ACTIVE, { state: "failed", error: why, dueAt: 0 })) return;
  done(post);
  void alert(`post ${post.id} failed`, `the reel scheduled for ${when(post.publishAt)} was NOT published: ${why}. Schedule it again once that is fixed.`);
}

function miss(post: Post, why: string): void {
  if (!changePost(post.id, ACTIVE, { state: "missed", error: why, dueAt: 0 })) return;
  done(post);
  const minutes = Math.round(config.postGrace / MINUTE);
  void alert(`post ${post.id} missed`, `the reel scheduled for ${when(post.publishAt)} was NOT published: ${why}, and more than ${minutes} minutes late it doesn't go out by itself. Schedule it again if you still want it.`);
}

/**
 * A step threw. What Meta refuses for good ends the post; anything else
 * (Instagram failing, a rate limit, the token) is tried again, after half a
 * minute, then a minute, two… up to ten. The lateness checks in each step
 * decide when it's too late.
 */
function setback(post: Post, e: unknown, now: number): void {
  const kind = failureKind(e);
  if (post.state === "publishing") {
    // Asking Instagram what happened failed. It may be out; nothing to do but ask again, for as long as the container exists.
    if (now - (post.containerAt ?? now) > CONTAINER_LIFE) {
      return fail(post, `I couldn't find out from Instagram whether the publish went through (${describe(e)}). Look on Instagram whether it's there`);
    }
  } else if (kind === "permanent") {
    return fail(post, describe(e));
  }
  const attempts = post.attempts + 1;
  const wait = Math.min(10 * MINUTE, POLL * 2 ** Math.min(attempts - 1, 10));
  // In "publishing", attempts counts the publishes, so it stays as it is.
  changePost(post.id, post.state, { attempts: post.state === "publishing" ? post.attempts : attempts, error: describe(e), dueAt: now + wait });
  console.warn(`post ${post.id} (${post.state}): ${describe(e)}; trying again in ${Math.round(wait / SECOND)} s`);
  if (post.state === "publishing") {
    void alert(`post ${post.id} trouble`, `the reel scheduled for ${when(post.publishAt)} may or may not be out: I can't reach Instagram to ask (${describe(e)}). I keep asking; nothing is published again before I know.`);
  } else if (kind === "token" || attempts === 3) {
    void alert(`post ${post.id} trouble`, `the reel scheduled for ${when(post.publishAt)} is stuck at "${post.state}": ${describe(e)}. The bot keeps trying until ${when(post.publishAt + config.postGrace)}.`);
  }
}
