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
  get telegramToken() {
    return process.env.TELEGRAM_BOT_TOKEN ?? "";
  },
  get telegramChatId() {
    return process.env.TELEGRAM_CHAT_ID ?? "";
  },
};

export const MINUTE = 60 * 1000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
