import { alert } from "./alert.ts";
import { createApp, webhooksRead } from "./app.ts";
import { config, DAY, HOUR, MINUTE, SECOND } from "./config.ts";
import { closeDb, kvGet, kvSet, openDb, prune } from "./db.ts";
import { ownAccount } from "./instagram/bot.ts";
import { KEYWORDS } from "./instagram/giveaways.ts";
import { clearLeftovers, postsAtRest, runPosts } from "./instagram/posts.ts";
import { pump, stopQueue } from "./instagram/queue.ts";
import { sweepOnTimer } from "./instagram/sweep.ts";
import { refreshTokenIfDue } from "./instagram/token.ts";

openDb();
// The daily cleanup, also at every start: with a deploy a day its timer would never come round.
prune();

// On the very first start, the sweep only looks at comments from now on.
// Older ones are answered on request: /admin/pending, then /admin/backfill.
if (!kvGet("sweep_since")) kvSet("sweep_since", String(Date.now()));

const server = createApp().listen(config.port, () => {
  console.log(`instagram-dm-bot listening on :${config.port}, ${KEYWORDS.size} keywords`);
});

if (config.seedToken) {
  ownAccount()
    .then((me) => console.log(`Instagram account: @${me.username}`))
    .catch((e) => alert("startup", `couldn't reach Instagram at startup: ${e instanceof Error ? e.message : e}`));
} else {
  console.warn("IG_ACCESS_TOKEN is not set: the bot can't reply until it is.");
}

/** Runs a job on a timer, never two at once, and reports failures. */
function every(ms: number, name: string, job: () => Promise<unknown>) {
  let busy = false;
  return setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await job();
    } catch (e) {
      await alert(name, `${name} failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      busy = false;
    }
  }, ms);
}

const timers = [every(6 * HOUR, "token refresh", refreshTokenIfDue), every(DAY, "cleanup", async () => prune())];
if (config.sweepMinutes > 0 && config.seedToken) {
  timers.push(every(config.sweepMinutes * MINUTE, "sweep", sweepOnTimer));
  // And once right after a start, for the comments that came while the bot was down or restarting.
  setTimeout(() => sweepOnTimer().catch((e) => alert("sweep", `sweep failed: ${e instanceof Error ? e.message : e}`)), 10 * SECOND).unref();
}

// The line of messages (queue.ts): whatever was waiting when the last process
// stopped goes out now, and every few seconds whatever has come due since: a
// retry, room under the hourly limit, the end of a pause.
if (config.seedToken) {
  pump();
  timers.push(every(5 * SECOND, "queue", async () => void pump()));
}

// Scheduled reels (posts.ts): every few seconds, whatever is due moves one step on.
clearLeftovers();
if (config.seedToken) timers.push(every(5 * SECOND, "posts", () => runPosts()));

/** How long the sends in flight get to finish when the process is told to stop. */
const DRAIN = 20 * SECOND;

/**
 * A deploy or a restart sends SIGTERM. The bot stops taking webhooks (Meta
 * delivers again the ones it couldn't), starts no new send, gives the
 * webhooks it has taken a moment to get into the line and the sends in flight
 * a moment to finish, and exits. Whatever is still in line is in the database
 * and goes out after the next start. A scheduled reel in the middle of a step
 * gets the same moment; if that isn't enough, the next start picks it up
 * where the database says it was (posts.ts), and asks Instagram before it
 * publishes anything.
 *
 * Railway kills the process RAILWAY_DEPLOYMENT_DRAINING_SECONDS after SIGTERM,
 * and that is 0 unless set, so the wait is a courtesy and nothing to count
 * on. A teaser that was cut off is taken up again two minutes after; a
 * giveaway that was cut off may have arrived and isn't sent again (db.ts).
 */
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  for (const t of timers) clearInterval(t);
  server.close();
  try {
    await Promise.race([Promise.all([stopQueue(), webhooksRead(), postsAtRest()]), new Promise((resolve) => setTimeout(resolve, DRAIN))]);
    closeDb();
  } finally {
    process.exit(0);
  }
}
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
