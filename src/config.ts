import { dirname, join } from "node:path";

/** A number from the environment, or the fallback when it's unset, empty, negative or not a number. */
function number(name: string, fallback: number): number {
  const value = Number(process.env[name] || fallback);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** Settings from the environment (.env.example lists them), read when used so tests can set them first. */
export const config = {
  get port() {
    return Number(process.env.PORT ?? 3000);
  },
  /**
   * Host and API version. Empty means "pick by token" (graph.ts): a system-user
   * token goes to graph.facebook.com, an Instagram-login token to
   * graph.instagram.com. Tests point this at a stand-in server.
   */
  get graphBase() {
    return process.env.IG_GRAPH_BASE ?? "";
  },
  /**
   * How long one call to the API may take, in milliseconds. Tests shorten it.
   * Never more than 30 seconds: the queue takes a send for dead after two
   * minutes (db.ts), and a teaser can be two calls.
   */
  get graphTimeout() {
    return Math.min(30 * SECOND, number("IG_GRAPH_TIMEOUT_MS", 15 * SECOND));
  },
  get seedToken() {
    return process.env.IG_ACCESS_TOKEN ?? "";
  },
  /**
   * The Instagram account's id, shown next to it in Meta's dashboard. Calls go
   * to /{id}/… when it's set; with a system-user token "me" would be the system
   * user, not the account. Without it, calls go to /me/….
   */
  get igUserId() {
    return process.env.IG_USER_ID ?? "";
  },
  get appSecrets() {
    return [process.env.IG_APP_SECRET, process.env.META_APP_SECRET].filter((s): s is string => Boolean(s));
  },
  get verifyToken() {
    return process.env.IG_VERIFY_TOKEN ?? "";
  },
  get adminKey() {
    return process.env.ADMIN_KEY ?? "";
  },
  get contactEmail() {
    return process.env.CONTACT_EMAIL ?? "";
  },
  /** For the privacy notice: the account's handle (no "@"), who runs it, and their site. */
  get username() {
    return (process.env.IG_USERNAME ?? "").trim().replace(/^@/, "");
  },
  get ownerName() {
    return (process.env.OWNER_NAME ?? "").trim();
  },
  get ownerUrl() {
    return (process.env.OWNER_URL ?? "").trim();
  },
  /** Where the bot is hosted, as the privacy notice names it. */
  get hosting() {
    return (process.env.HOSTING_PROVIDER ?? "Railway").trim();
  },
  get dbPath() {
    return process.env.DB_PATH ?? "./data/bot.db";
  },
  get sweepMinutes() {
    return Number(process.env.SWEEP_MINUTES ?? 10);
  },
  /** Reply under each answered comment ("Hey @name, DM sent 📩"). PUBLIC_REPLIES=off turns it off. */
  get publicReplies() {
    return (process.env.PUBLIC_REPLIES ?? "on") !== "off";
  },
  /**
   * How many messages are on their way to Instagram at one time, however many
   * comments arrive at once. 10 at most: with quick answers from Instagram,
   * more than that could pass the 100 messages a second Meta allows.
   */
  get sendConcurrency() {
    return Math.min(10, Math.max(1, Math.floor(number("SEND_CONCURRENCY", 4))));
  },
  /**
   * Teasers (private replies) the bot sends in any 60 minutes; the rest wait
   * their turn. Meta allows 750 an hour per account, so stay under that.
   */
  get privateRepliesPerHour() {
    return Math.floor(number("PRIVATE_REPLIES_PER_HOUR", 700));
  },
  /** Public "DM sent" replies in any 60 minutes; comments past that get their DM without one. 0 means no cap. */
  get publicRepliesPerHour() {
    return Math.floor(number("PUBLIC_REPLIES_PER_HOUR", 0));
  },
  /** Where the videos of scheduled reels wait: a "posts" folder next to the database, unless POSTS_DIR says otherwise. */
  get postsDir() {
    return process.env.POSTS_DIR || join(dirname(this.dbPath), "posts");
  },
  /** How long before its time a scheduled reel is handed to Instagram for processing. 12 hours at most: a container lasts 24. */
  get postLead() {
    return Math.min(12 * HOUR, Math.max(MINUTE, number("POST_LEAD_MINUTES", 15) * MINUTE));
  },
  /** How late a scheduled reel may still go out (the bot was down, Instagram was slow). Later than that it's marked missed instead. */
  get postGrace() {
    return number("POST_GRACE_MINUTES", 60) * MINUTE;
  },
  /** The largest video the bot takes, in bytes. Instagram's limit for a reel is 300 MB; tests lower it. */
  get postMaxBytes() {
    return Math.floor(number("POST_MAX_MB", 300) * 1024 * 1024);
  },
  get telegramToken() {
    return process.env.TELEGRAM_BOT_TOKEN ?? "";
  },
  get telegramChatId() {
    return process.env.TELEGRAM_CHAT_ID ?? "";
  },
};

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
