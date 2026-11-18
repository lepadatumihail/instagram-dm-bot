#!/usr/bin/env node
// Post a reel to Instagram through Meta's API, in two steps, so nothing is
// public until "publish". It needs IG_ACCESS_TOKEN and IG_USER_ID, the same two
// the bot uses: `railway run` lends them from your deployed bot, or pass your
// local .env with `node --env-file=.env`.
//
//   railway run -- node scripts/post-reel.mjs upload --video reel.mp4 --caption-file caption.txt --thumb-offset 2100
//   railway run -- node scripts/post-reel.mjs publish --container <id from upload>
//   railway run -- node scripts/post-reel.mjs status --container <id>
//
// upload: creates the container and sends the file, then waits for Instagram
//   to finish processing. --thumb-offset is the cover frame in milliseconds;
//   --cover-url takes a JPEG at a public address instead (the API has no other
//   way to take a cover image). --ai-label marks the reel as made with AI.
// publish: makes that container public and prints the link.
// The token is never printed. Meta's docs, read 18 Nov 2026:
// developers.facebook.com/docs/instagram-platform/content-publishing

import { readFileSync, statSync } from "node:fs";

const [, , command, ...rest] = process.argv;
const arg = (name) => { const i = rest.indexOf(name); return i === -1 ? undefined : rest[i + 1]; };
const flag = (name) => rest.includes(name);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const token = process.env.IG_ACCESS_TOKEN;
const account = process.env.IG_USER_ID;
const fail = (message) => { console.error(message); process.exit(1); };
if (!token || !account) fail("IG_ACCESS_TOKEN and IG_USER_ID are not set. Run this through `railway run --` or with `node --env-file=.env`.");

// A system-user token (EAA…) lives on graph.facebook.com; an Instagram-login one on graph.instagram.com.
const BASE = `https://graph.${token.startsWith("EAA") ? "facebook" : "instagram"}.com/v27.0`;
const clean = (text) => String(text).replaceAll(token, "[token]").replaceAll(account, "{account}");

async function graph(method, path, params = {}) {
  const url = new URL(BASE + path);
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

const status = (id) => graph("GET", `/${id}`, { fields: "status_code,status" });

async function upload() {
  const video = arg("--video") ?? fail("--video <file.mp4> is missing");
  const captionFile = arg("--caption-file") ?? fail("--caption-file <file.txt> is missing");
  const caption = readFileSync(captionFile, "utf8").trim();
  const size = statSync(video).size;

  // Meta's limits: 2,200 characters, 30 hashtags, 20 @ tags; 300 MB.
  const chars = [...caption].length;
  const hashtags = (caption.match(/#[\p{L}\p{N}_]+/gu) ?? []).length;
  if (chars > 2200) fail(`The caption is ${chars} characters; Instagram allows 2,200.`);
  if (hashtags > 30) fail(`The caption has ${hashtags} hashtags; Instagram allows 30.`);
  if (size > 300 * 1024 * 1024) fail(`The video is ${(size / 1e6).toFixed(0)} MB; Instagram allows 300 MB.`);

  const params = { media_type: "REELS", upload_type: "resumable", caption, share_to_feed: "true" };
  if (flag("--ai-label")) params.is_ai_generated = "true";
  if (arg("--cover-url")) params.cover_url = arg("--cover-url");
  else if (arg("--thumb-offset")) params.thumb_offset = String(Number(arg("--thumb-offset")));

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
  console.log(`AI label: ${media.is_ai_generated === undefined ? "the API did not say" : media.is_ai_generated ? "on" : "OFF"}`);
  console.log(`caption starts: ${(media.caption ?? "").split("\n")[0]}`);
}

const commands = {
  upload,
  publish,
  status: async () => console.log(clean(JSON.stringify(await status(arg("--container") ?? fail("--container <id> is missing"))))),
};
if (!commands[command]) fail("Usage: post-reel.mjs upload|publish|status (see the top of this file)");
await commands[command]().catch((e) => fail(clean(e.message)));
