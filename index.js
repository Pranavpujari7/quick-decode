(function (exports) {
  "use strict";

  // ---------- settings (edit these) ----------
  const APP_ID = "1554104747273748550";   // your bot's application id
  const COMMAND_NAME = "Decode";          // the message command name
  const ONLY_AUTHOR_ID = "";              // optional: Paimon's user id, so only its messages trigger (empty = any bot message with an image)
  const HIDE_SHEET = true;                // close the long-press menu on puzzle messages
  // --------------------------------------------

  const { findByProps, findByStoreName } = vendetta.metro;
  const { before } = vendetta.patcher;
  const { showToast } = vendetta.ui.toasts;

  const ActionSheet = findByProps("openLazy", "hideActionSheet");
  const RestAPI = findByProps("getAPIBaseURL", "get");
  const SessionStore = findByProps("getSessionId");
  const Snowflake = findByProps("fromTimestamp");
  const ChannelStore = findByStoreName("ChannelStore");

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
    const hasEmbedImg = (message.embeds || []).some(function (e) { return e && (e.image || e.thumbnail); });
    const hasAttach = (message.attachments || []).length > 0;
    return hasEmbedImg || hasAttach;
  }

  async function getCommand(channelId, guildId) {
    if (cmdCache) return cmdCache;
    const url = guildId
      ? "/channels/" + channelId + "/application-command-index"
      : "/users/@me/application-command-index";
    const res = await RestAPI.get({ url: url });
    const list = (res.body && res.body.application_commands) || [];
    cmdCache = list.find(function (c) {
      return c.application_id === APP_ID && c.name === COMMAND_NAME && c.type === 3;
    });
    return cmdCache;
  }

  async function runDecode(message) {
    const channelId = message.channel_id;
    const channel = ChannelStore.getChannel(channelId);
    const guildId = channel && channel.guild_id;
    try {
      const cmd = await getCommand(channelId, guildId);
      if (!cmd) { showToast("Quick Decode: Decode command not found"); return; }
      const body = {
        type: 2,
        application_id: APP_ID,
        channel_id: channelId,
        session_id: SessionStore.getSessionId(),
        nonce: nonce(),
        data: { version: cmd.version, id: cmd.id, name: cmd.name, type: 3, target_id: message.id },
        analytics_location: "context_menu",
      };
      if (guildId) body.guild_id = guildId;
      await RestAPI.post({ url: "/interactions", body: body });
    } catch (e) {
      cmdCache = null;
      showToast("Quick Decode failed: " + (e && (e.message || e.status) || "error"));
    }
  }

  if (ActionSheet && RestAPI) {
    unpatches.push(before("openLazy", ActionSheet, function (args) {
      const key = args[1];
      const message = args[2] && args[2].message;
      if (key !== "MessageLongPressActionSheet" || !isPuzzle(message)) return;
      const now = Date.now();
      if (lastFired[message.id] && now - lastFired[message.id] < 3000) return;
      lastFired[message.id] = now;
      runDecode(message);
      if (HIDE_SHEET) setTimeout(function () { try { ActionSheet.hideActionSheet(); } catch (e) {} }, 120);
    }));
  } else {
    showToast("Quick Decode: could not hook the menu");
  }

  exports.onUnload = function () { unpatches.forEach(function (u) { try { u(); } catch (e) {} }); };
  return exports;
})({});
