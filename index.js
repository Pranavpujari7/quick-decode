(function (exports) {
  "use strict";

  // ---------- settings (edit these) ----------
  const APP_ID = "1554104747273748550";   // your bot's application id
  const COMMAND_NAME = "Decode";          // the message command name
  const ONLY_AUTHOR_ID = "";              // optional: Paimon's user id, so only its messages trigger (empty = any bot message with an image)
  const HIDE_SHEET = true;                // close the long-press menu on puzzle messages
  const MODE = "both";                    // "double" = double-tap the puzzle, "hold" = long-press, "both"
  const DOUBLE_TAP_MS = 350;              // max gap between the two taps
  const DEBUG = true;                     // show small toasts so we can see what the plugin is doing
  const CMD_ID = "";                      // optional: Decode command id (only if auto-lookup fails)
  const CMD_VERSION = "";                 // optional: Decode command version (usually same as id)
  // --------------------------------------------

  const { findByProps, findByStoreName, findByName } = vendetta.metro;
  const { before, instead } = vendetta.patcher;
  const { showToast } = vendetta.ui.toasts;

  const ActionSheet = findByProps("openLazy", "hideActionSheet");
  const RestAPI = findByProps("getAPIBaseURL", "get");
  const SessionStore = findByProps("getSessionId");
  const Snowflake = findByProps("fromTimestamp");
  const ChannelStore = findByStoreName("ChannelStore");
  const MessageStore = findByStoreName("MessageStore");
  const ReactionActions = findByProps("addReaction", "removeReaction");

  const unpatches = [];
  const lastFired = {};
  let cmdCache = null;

  function nonce() {
    try { return String(Snowflake.fromTimestamp(Date.now())); }
    catch (e) { return String(Date.now() - 1420070400000) + String(Math.floor(Math.random() * 1e7)); }
  }

  function isPuzzle(message) {
    if (!message || !message.author || !message.author.bot) return false;
    if (ONLY_AUTHOR_ID && message.author.id !== ONLY_AUTHOR_ID) return false;
    return ((message.embeds || []).length > 0) ||
           ((message.attachments || []).length > 0) ||
           ((message.components || []).length > 0);
  }

  function describe(e) {
    const status = e && e.status;
    const msg = (e && e.body && e.body.message) || (e && e.message) || "";
    return (status ? status + " " : "") + msg;
  }

  async function getCommand(channelId, guildId) {
    if (CMD_ID) {
      return { id: CMD_ID, version: CMD_VERSION || CMD_ID, name: COMMAND_NAME, type: 3, application_id: APP_ID };
    }
    if (cmdCache) return cmdCache;
    const urls = ["/channels/" + channelId + "/application-command-index"];
    if (guildId) urls.push("/guilds/" + guildId + "/application-command-index");
    urls.push("/users/@me/application-command-index");
    let lastErr = null;
    for (let i = 0; i < urls.length; i++) {
      try {
        const res = await RestAPI.get({ url: urls[i] });
        const list = (res.body && res.body.application_commands) || [];
        const found = list.find(function (c) {
          return c.application_id === APP_ID && c.name === COMMAND_NAME && c.type === 3;
        });
        if (found) { cmdCache = found; return found; }
      } catch (e) { lastErr = e; }
    }
    const err = new Error(lastErr ? describe(lastErr) : "not in command list");
    err.step = "find";
    throw err;
  }

  async function runDecode(message) {
    const channelId = message.channel_id;
    const channel = ChannelStore.getChannel(channelId);
    const guildId = channel && channel.guild_id;
    let step = "find";
    try {
      const cmd = await getCommand(channelId, guildId);
      step = "send";
      const body = {
        type: 2,
        application_id: APP_ID,
        channel_id: channelId,
        session_id: SessionStore.getSessionId(),
        nonce: nonce(),
        data: {
          version: cmd.version,
          id: cmd.id,
          name: cmd.name,
          type: 3,
          target_id: message.id,
          application_command: cmd,
        },
        analytics_location: "context_menu",
      };
      if (guildId) body.guild_id = guildId;
      await RestAPI.post({ url: "/interactions", body: body });
    } catch (e) {
      cmdCache = null;
      showToast("Quick Decode " + (e && e.step || step) + " failed: " + describe(e));
    }
  }

  // run Decode for a message (shared by double-tap and hold)
  function fire(message) {
    const now = Date.now();
    if (lastFired[message.id] && now - lastFired[message.id] < 3000) return;
    lastFired[message.id] = now;
    if (DEBUG) showToast("Quick Decode: decoding...");
    runDecode(message);
  }

  // ---- double-tap: Discord's built-in double-tap adds a reaction, so we catch that ----
  let doubleOK = false;
  if ((MODE === "double" || MODE === "both") && ReactionActions && MessageStore) {
    try {
      unpatches.push(instead("addReaction", ReactionActions, function (args, orig) {
        try {
          const m = MessageStore.getMessage(args[0], args[1]) || MessageStore.getMessage(args[1], args[0]);
          if (m && isPuzzle(m)) { fire(m); return; }      // swallow the reaction, decode instead
        } catch (e) {}
        return orig.apply(this, args);
      }));
      doubleOK = true;
    } catch (e) { doubleOK = false; }
  }
  if ((MODE === "double" || MODE === "both") && !doubleOK) showToast("Quick Decode: double-tap hook unavailable, using hold");

  // ---- hold (long-press) ----
  if ((MODE === "hold" || MODE === "both" || !doubleOK) && ActionSheet && RestAPI) {
    unpatches.push(before("openLazy", ActionSheet, function (args) {
      const key = args[1];
      if (key !== "MessageLongPressActionSheet") return;
      const message = args[2] && args[2].message;
      if (!isPuzzle(message)) return;
      fire(message);
      if (HIDE_SHEET) setTimeout(function () { try { ActionSheet.hideActionSheet(); } catch (e) {} }, 120);
    }));
  }

  if (DEBUG) showToast("Quick Decode v6 loaded (" + MODE + (MODE !== "hold" ? ", double-tap " + (doubleOK ? "hooked" : "OFF") : "") + ")");

  exports.onUnload = function () { unpatches.forEach(function (u) { try { u(); } catch (e) {} }); };
  return exports;
})({});
