#!/usr/bin/env node
// Post a reel to Instagram, now or at a set time.
//
// Through the bot, which keeps the video and publishes it at the time you
// give (BOT_URL and ADMIN_KEY in the environment; the key is never printed):
//
//   node scripts/post-reel.mjs schedule --video reel.mp4 --caption-file caption.txt --at "2026-11-20 18:30"
//   node scripts/post-reel.mjs list
//   node scripts/post-reel.mjs cancel --id 3
//
// --at takes "now", a time with its offset ("2026-11-20T18:30:00+01:00", or
// ending in Z for UTC), or a plain "2026-11-20 18:30", which is read on this
// computer's clock. Either way the script prints the moment it understood,
// in local time and in UTC, before anything is scheduled.
//
// Straight to Instagram through Meta's API, in two steps, so nothing is
// public until "publish" (IG_ACCESS_TOKEN and IG_USER_ID in the environment;
// the token is never printed):
//
//   node scripts/post-reel.mjs upload --video reel.mp4 --caption-file caption.txt
//   node scripts/post-reel.mjs publish --container <id from upload>
//   node scripts/post-reel.mjs status --container <id>
//
// upload: creates the container and sends the file, then waits for Instagram
//   to finish processing. The container is good for 24 hours.
// publish: makes that container public and prints the link.
//
// For schedule and upload alike:
//   --thumb-offset <ms>  the cover: a frame of the video, in milliseconds
//   --cover-url <url>    or a JPEG at a public address (the API takes a cover image no other way)
//   --ai-label           put Instagram's "AI info" label on the post (off unless asked for)
//
// Meta's docs, read 18 Nov 2026: developers.facebook.com/docs/instagram-platform/content-publishing

import { createReadStream, readFileSync, statSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { pipeline } from "node:stream/promises";

const [, , command, ...rest] = process.argv;
const arg = (name) => { const i = rest.indexOf(name); return i === -1 ? undefined : rest[i + 1]; };
const flag = (name) => rest.includes(name);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (message) => { console.error(message); process.exit(1); };

// ---------------------------------------------------------------- the reel

/** The video and caption from the command line, checked against Meta's limits: 2,200 characters, 30 hashtags, 20 @ tags; 300 MB. */
function reel() {
  const video = arg("--video") ?? fail("--video <file.mp4> is missing");
  const captionFile = arg("--caption-file") ?? fail("--caption-file <file.txt> is missing");
  let caption;
  let size;
  try { caption = readFileSync(captionFile, "utf8").trim(); } catch { fail(`Can't read the caption file ${captionFile}.`); }
  try { size = statSync(video).size; } catch { fail(`Can't find the video ${video}.`); }

  const chars = [...caption].length;
  const hashtags = (caption.match(/#[\p{L}\p{N}_]+/gu) ?? []).length;
  if (chars > 2200) fail(`The caption is ${chars} characters; Instagram allows 2,200.`);
  if (hashtags > 30) fail(`The caption has ${hashtags} hashtags; Instagram allows 30.`);
  if (size > 300 * 1024 * 1024) fail(`The video is ${(size / 1e6).toFixed(0)} MB; Instagram allows 300 MB.`);
  if (arg("--cover-url") && arg("--thumb-offset")) fail("Give --thumb-offset or --cover-url, not both.");
  const thumbOffset = arg("--thumb-offset") === undefined ? undefined : Number(arg("--thumb-offset"));
  if (thumbOffset !== undefined && !(Number.isInteger(thumbOffset) && thumbOffset >= 0)) fail("--thumb-offset is the cover frame in milliseconds: a whole number, 0 or more.");
  return { video, size, caption, chars, hashtags, thumbOffset, coverUrl: arg("--cover-url"), aiLabel: flag("--ai-label") };
}

// ---------------------------------------------------------------- through the bot

function bot() {
  const url = (process.env.BOT_URL ?? "").replace(/\/+$/, "");
  const key = process.env.ADMIN_KEY ?? "";
  if (!url || !key) fail("BOT_URL and ADMIN_KEY are not set. BOT_URL is the bot's address (https://…), ADMIN_KEY the key of its /admin routes.");
  // The key travels with every call, so it only goes over https (or to this computer, for a local run).
  const host = URL.canParse(url) ? new URL(url).hostname : "";
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(host);
  if (!url.startsWith("https://") && !(url.startsWith("http://") && local)) fail("BOT_URL must start with https://: the admin key is sent with every call.");
  const clean = (text) => String(text).replaceAll(key, "[key]");

  /** One call to the bot's /admin API. Returns the JSON it answers, or stops with what it said. */
  async function call(method, path, body) {
    let res;
    try {
      res = await fetch(url + path, { method, headers: { authorization: `Bearer ${key}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body && JSON.stringify(body) });
    } catch (e) {
      fail(clean(`Couldn't reach the bot at ${url}: ${e.cause?.message ?? e.message}`));
    }
    const text = await res.text();
    if (res.status === 401) fail("The bot turned the key down. Check ADMIN_KEY.");
    if (!res.ok) fail(clean(`The bot said no (HTTP ${res.status}): ${text.trim().slice(0, 400)}`));
    try { return JSON.parse(text); } catch { fail(clean(`The bot's answer wasn't JSON: ${text.slice(0, 200)}`)); }
  }

  /** Sends a file as the body of a PUT, from the disk as it goes, with its size announced. */
  async function put(path, file, size, onProgress) {
    const send = url.startsWith("https:") ? httpsRequest : httpRequest;
    return new Promise((resolve, reject) => {
      const req = send(url + path, { method: "PUT", headers: { authorization: `Bearer ${key}`, "content-type": "video/mp4", "content-length": size } }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: clean(text.trim()) }));
        res.on("error", (e) => reject(new Error(clean(e.message))));
      });
      req.on("error", (e) => reject(new Error(clean(e.message))));
      const stream = createReadStream(file);
      let sent = 0;
      stream.on("data", (chunk) => onProgress((sent += chunk.length)));
      pipeline(stream, req).catch((e) => reject(new Error(clean(e.message))));
    });
  }
  return { call, put };
}

/**
 * The moment --at means. "now", a time with its offset, or a plain date and
 * time, which is read on this computer's clock.
 */
function moment(at) {
  if (!at) fail('--at "<time>" is missing: "now", "2026-11-20 18:30" (this computer\'s time) or "2026-11-20T18:30:00+01:00".');
  if (at === "now") return { now: true, time: new Date() };
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(at)) {
    const time = new Date(at.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
    if (Number.isNaN(time.getTime())) fail(`--at isn't a time I can read: ${at}`);
    return { time };
  }
  const plain = at.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!plain) fail(`--at isn't a time I can read: ${at}. Write it like "2026-11-20 18:30", or with its offset like "2026-11-20T18:30:00+01:00".`);
  const [year, month, day, hour, minute, second] = plain.slice(1).map((part) => Number(part ?? 0));
  const time = new Date(year, month - 1, day, hour, minute, second);
  // A day or an hour that doesn't exist rolls over (31 November, 25:00): say so instead of guessing.
  if (time.getMonth() !== month - 1 || time.getDate() !== day || time.getHours() !== hour || time.getMinutes() !== minute) {
    fail(`--at isn't a time on this computer's clock: ${at} (a day or an hour that doesn't exist, or one skipped when the clocks change).`);
  }
  return { time, local: true };
}

/** A moment the way a person reads it here, with the zone it is in, and the same moment in UTC. */
function spell(time) {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const offset = -time.getTimezoneOffset();
  const sign = offset < 0 ? "-" : "+";
  const two = (n) => String(Math.abs(n)).padStart(2, "0");
  const local = `${time.getFullYear()}-${two(time.getMonth() + 1)}-${two(time.getDate())} ${two(time.getHours())}:${two(time.getMinutes())}`;
  return `${local} ${zone} (UTC${sign}${two(Math.trunc(offset / 60))}:${two(offset % 60)}) = ${time.toISOString().replace(".000Z", "Z")}`;
}

async function schedule() {
  const { video, size, caption, chars, hashtags, thumbOffset, coverUrl, aiLabel } = reel();
  const { now, time, local } = moment(arg("--at"));
  if (!now && time.getTime() < Date.now() - 60_000) fail(`That time is in the past: ${spell(time)}.`);
  console.log(now ? "at: now, as soon as Instagram has processed the video" : `at: ${spell(time)}${local ? " (read on this computer's clock)" : ""}`);

  const { call, put } = bot();
  const post = await call("POST", "/admin/posts", { caption, at: now ? "now" : time.toISOString(), thumbOffset, coverUrl, aiLabel });
  console.log(`post ${post.id}: scheduled (${chars} characters, ${hashtags} hashtags, cover: ${post.cover}, AI label ${post.aiLabel ? "on" : "off"})`);

  let shown = -1;
  const progress = (sent) => {
    const tenth = Math.floor((sent / size) * 10);
    if (tenth > shown && size > 5e6) console.log(`post ${post.id}: ${(shown = tenth) * 10}% of ${(size / 1e6).toFixed(1)} MB sent`);
  };
  const sent = await put(`/admin/posts/${post.id}/video`, video, size, progress).catch((e) => ({ status: 0, text: e.message }));
  if (sent.status !== 200) {
    // A post without its video would only come to nothing later: take it off the schedule again.
    await call("DELETE", `/admin/posts/${post.id}`);
    fail(`The video didn't get through${sent.status ? ` (HTTP ${sent.status})` : ""}: ${sent.text.slice(0, 400)}\nPost ${post.id} was cancelled again; nothing is scheduled.`);
  }
  console.log(`post ${post.id}: ${(size / 1e6).toFixed(1)} MB sent. The bot publishes it ${now ? "as soon as it's ready" : `at ${spell(time)}`}.`);
  console.log(`To take it back: node scripts/post-reel.mjs cancel --id ${post.id}`);
}

async function list() {
  const posts = await bot().call("GET", "/admin/posts");
  if (posts.length === 0) return console.log("No posts.");
  for (const p of posts) {
    console.log(`${String(p.id).padStart(3)}  ${p.state.padEnd(10)}  ${spell(new Date(p.publishAt))}`);
    console.log(`     ${p.caption}`);
    console.log(`     video: ${p.video}; cover: ${p.cover}; AI label ${p.aiLabel ? "on" : "off"}${p.link ? `\n     ${p.link}` : ""}${p.note ? `\n     note: ${p.note}` : ""}`);
  }
}

async function cancel() {
  const id = arg("--id") ?? fail("--id <number> is missing (see: list)");
  const post = await bot().call("DELETE", `/admin/posts/${Number(id)}`);
  console.log(`post ${post.id}: ${post.state}. It was due at ${spell(new Date(post.publishAt))}.`);
}

// ---------------------------------------------------------------- straight to Instagram

function instagram() {
  const token = process.env.IG_ACCESS_TOKEN;
  const account = process.env.IG_USER_ID;
  if (!token || !account) fail("IG_ACCESS_TOKEN and IG_USER_ID are not set.");
  // A system-user token (EAA…) lives on graph.facebook.com; an Instagram-login one on graph.instagram.com.
  // IG_GRAPH_BASE points somewhere else altogether (the tests' stand-in API).
  const base = process.env.IG_GRAPH_BASE ?? `https://graph.${token.startsWith("EAA") ? "facebook" : "instagram"}.com/v27.0`;
  const clean = (text) => String(text).replaceAll(token, "[token]").replaceAll(account, "{account}");

  async function graph(method, path, params = {}) {
    const url = new URL(base + path);
    const init = { method, headers: { Authorization: `Bearer ${token}` } };
    if (method === "GET") for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    else init.body = new URLSearchParams(params);
    const res = await fetch(url, init);
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = {}; }
    if (!res.ok || json.error) {
      const e = json.error ?? {};
      throw new Error(clean(`${method} ${path}: HTTP ${res.status}, ${e.message ?? text.slice(0, 300)} (code ${e.code ?? "-"}/${e.error_subcode ?? "-"})`));
    }
    return json;
  }
  return { token, account, clean, graph, status: (id) => graph("GET", `/${id}`, { fields: "status_code,status" }) };
}

async function upload() {
  const { video, size, caption, chars, hashtags, thumbOffset, coverUrl, aiLabel } = reel();
  const { token, account, clean, graph, status } = instagram();

  const params = { media_type: "REELS", upload_type: "resumable", caption, share_to_feed: "true" };
  if (aiLabel) params.is_ai_generated = "true";
  if (coverUrl) params.cover_url = coverUrl;
  else if (thumbOffset !== undefined) params.thumb_offset = String(thumbOffset);

  const container = await graph("POST", `/${account}/media`, params);
  if (!container.id || !container.uri) fail(clean(`No upload address came back: ${JSON.stringify(container)}`));
  console.log(`container ${container.id}: created (${chars} characters, ${hashtags} hashtags, AI label ${params.is_ai_generated ? "on" : "off"})`);

  const sent = await fetch(container.uri, {
    method: "POST",
    headers: { Authorization: `OAuth ${token}`, offset: "0", file_size: String(size), "Content-Type": "application/octet-stream" },
    body: readFileSync(video),
  });
  const body = await sent.text();
  if (!sent.ok || !/"success"\s*:\s*true/.test(body)) fail(clean(`The upload failed: HTTP ${sent.status}, ${body.slice(0, 400)}`));
  console.log(`container ${container.id}: ${(size / 1e6).toFixed(1)} MB sent`);

  // Meta suggests waiting up to 5 minutes; a short reel takes well under one.
  for (let i = 0; i < 90; i++) {
    const s = await status(container.id);
    if (s.status_code === "FINISHED") { console.log(`container ${container.id}: FINISHED, ready to publish (it expires in 24 hours)`); return; }
    if (s.status_code !== "IN_PROGRESS") fail(clean(`container ${container.id}: ${s.status_code}, ${s.status ?? "no detail"}`));
    if (i % 3 === 0) console.log(`container ${container.id}: processing…`);
    await sleep(5000);
  }
  fail(`container ${container.id}: still processing after 7.5 minutes. Check again with "status --container ${container.id}".`);
}

async function publish() {
  const id = arg("--container") ?? fail("--container <id> is missing");
  const { account, clean, graph, status } = instagram();
  const s = await status(id);
  if (s.status_code === "PUBLISHED") fail(`container ${id} is already published. Nothing sent.`);
  if (s.status_code !== "FINISHED") fail(clean(`container ${id} is ${s.status_code} (${s.status ?? "no detail"}), not ready. Nothing sent.`));

  const out = await graph("POST", `/${account}/media_publish`, { creation_id: id });
  console.log(`published: media ${out.id}`);
  const fields = "id,permalink,shortcode,media_type,timestamp,caption";
  let media;
  try { media = await graph("GET", `/${out.id}`, { fields: `${fields},is_ai_generated` }); }
  catch { media = await graph("GET", `/${out.id}`, { fields }); }
  console.log(`link: ${media.permalink}`);
  console.log(`AI label: ${media.is_ai_generated === undefined ? "the API did not say" : media.is_ai_generated ? "on" : "off"}`);
  console.log(`caption starts: ${(media.caption ?? "").split("\n")[0]}`);
}

async function containerStatus() {
  const id = arg("--container") ?? fail("--container <id> is missing");
  const { clean, status } = instagram();
  console.log(clean(JSON.stringify(await status(id))));
}

const commands = { schedule, list, cancel, upload, publish, status: containerStatus };
if (!commands[command]) fail("Usage: post-reel.mjs schedule|list|cancel|upload|publish|status (see the top of this file)");
await commands[command]().catch((e) => fail(e.message));
