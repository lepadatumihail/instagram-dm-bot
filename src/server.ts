import { alert } from "./alert.ts";
import { createApp } from "./app.ts";
import { config, DAY, HOUR, MINUTE } from "./config.ts";
import { closeDb, kvGet, kvSet, openDb, prune } from "./db.ts";
import { ownAccount } from "./instagram/bot.ts";
import { KEYWORDS } from "./instagram/giveaways.ts";
import { sweep } from "./instagram/sweep.ts";
import { refreshTokenIfDue } from "./instagram/token.ts";

openDb();

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
if (config.sweepMinutes > 0 && config.seedToken) timers.push(every(config.sweepMinutes * MINUTE, "sweep", sweep));

function stop() {
  for (const t of timers) clearInterval(t);
  server.close(() => {
    closeDb();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
