import { config, DAY } from "./config.ts";
import { KEEP } from "./db.ts";

/**
 * The privacy notice at /privacy, which Meta asks for before the app can go
 * live. It also serves as the "data deletion instructions" page
 * (/privacy#data-deletion). It is published under your name (IG_USERNAME,
 * OWNER_NAME, OWNER_URL, CONTACT_EMAIL, HOSTING_PROVIDER): read it once it is
 * up, and keep it true to what the code does and to how you run it.
 */

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

export function privacyPage(contactEmail: string): string {
  const days = Math.round(KEEP / DAY);
  const handle = config.username;
  const account = handle ? `the Instagram account @${escape(handle)}` : "this Instagram account";
  const site = config.ownerUrl.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const owner = config.ownerName
    ? `, run by ${escape(config.ownerName)}${site ? ` (<a href="${escape(config.ownerUrl)}">${escape(site)}</a>)` : ""}`
    : "";
  const dm = handle
    ? `a direct message to <a href="https://www.instagram.com/${encodeURIComponent(handle)}/">@${escape(handle)}</a>`
    : "a direct message to this account";
  const contact = contactEmail
    ? `<a href="mailto:${escape(contactEmail)}">${escape(contactEmail)}</a> or ${dm}`
    : dm;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Privacy notice: automatic Instagram messages</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 17px/1.6 system-ui, -apple-system, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1rem; }
  h1 { font-size: 1.6rem; line-height: 1.25; }
  h2 { font-size: 1.1rem; margin-top: 2rem; }
  a { color: inherit; }
</style>
</head>
<body>
<h1>Privacy notice: automatic Instagram messages</h1>
<p>This covers the automatic messages sent by ${account}${owner}.</p>

<h2>What happens</h2>
<p>When you comment a keyword under one of my posts (for example GUIDE), or send me that keyword in a direct message, a small program sends you the link or guide the post promised, through Instagram's official messaging API.</p>

<h2>What it uses</h2>
<p>Your Instagram username, the ID Instagram gives you in our chat, the text of your comment or message, and the time. It uses them only to work out what you asked for and to send it.</p>

<h2>What it keeps</h2>
<p>A record of each request (your username, that ID, the keyword, the time, and whether the message went through) for ${days} days, so you don't get the same message twice and so I can see which posts people asked about. Then it is deleted. The server's logs also show your username and the keyword for a short while. If a message fails to send, I get an alert with your username so I can send it by hand.</p>

<h2>What it doesn't do</h2>
<p>No email lists, no ads, no selling or sharing your data, and no messages you didn't ask for.</p>

<h2>Where it runs</h2>
<p>The program runs on ${escape(config.hosting)} (a hosting provider) and talks to Instagram through Meta's API. Your chat itself stays in Instagram, under Meta's privacy policy, like any other direct message.</p>

<h2 id="data-deletion">Deleting your data, and your rights</h2>
<p>To have your record deleted sooner, or to ask what I hold about you, write to ${contact}. I'll do it and reply within 30 days. You can delete the chat itself in Instagram at any time.</p>
<p>You can also complain to your data protection authority.</p>
</body>
</html>
`;
}
