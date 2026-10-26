(function (exports) {
  "use strict";

  // ---------- settings (edit these) ----------
  const APP_ID = "1554104747273748550";   // your bot's application id
  const COMMAND_NAME = "Decode";          // the message command name
  const ONLY_AUTHOR_ID = "";              // optional: Paimon's user id, so only its messages trigger (empty = any bot message with an image)
  const HIDE_SHEET = true;                // close the long-press menu on puzzle messages
  const MODE = "double";                  // "double" = double-tap the puzzle, "hold" = long-press, "both"
  const DOUBLE_TAP_MS = 350;              // max gap between the two taps
  const DEBUG = true;                     // show small toasts so we can see what the plugin is doing
  const CMD_ID = "";                      // optional: Decode command id (only if auto-lookup fails)
  const CMD_VERSION = "";                 // optional: Decode command version (usually same as id)
  // --------------------------------------------

  const { findByProps, findByStoreName, findByName } = vendetta.metro;
  const { before, after } = vendetta.patcher;
  const React = vendetta.metro.common.React;
  const { showToast } = vendetta.ui.toasts;

  const ActionSheet = findByProps("openLazy", "hideActionSheet");
  const RestAPI = findByProps("getAPIBaseURL", "get");
  const SessionStore = findByProps("getSessionId");
  const Snowflake = findByProps("fromTimestamp");
  const ChannelStore = findByStoreName("ChannelStore");

  const unpatches = [];
  const lastFired = {};
  const lastTap = {};
  let tapNoted = false;
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

  // ---- double-tap: wrap the message row's press handler ----
  const PRESS_KEYS = ["onPress", "onTapMessage", "onPressMessage", "onTap"];

  function findPress(node, depth) {
    if (!node || typeof node !== "object" || depth > 4) return null;
    const props = node.props;
    if (props && typeof props === "object") {
      for (let i = 0; i < PRESS_KEYS.length; i++) {
        if (typeof props[PRESS_KEYS[i]] === "function") return { node: node, key: PRESS_KEYS[i] };
      }
      const kids = props.children;
      const list = Array.isArray(kids) ? kids : (kids ? [kids] : []);
      for (let j = 0; j < list.length; j++) {
        const r = findPress(list[j], depth + 1);
        if (r) return r;
      }
    }
    return null;
  }

  function onTap(message) {
    const now = Date.now();
    const prev = lastTap[message.id] || 0;
    lastTap[message.id] = now;
    if (now - prev < DOUBLE_TAP_MS) {
      lastTap[message.id] = 0;
      fire(message);
    }
  }

  function wrapRow(row, message) {
    const hit = findPress(row, 0);
    const make = function (orig) {
      if (orig && orig.__qd) return orig;
      const w = function () {
        try { onTap(message); } catch (e) {}
        return orig ? orig.apply(this, arguments) : undefined;
      };
      w.__qd = true;
      return w;
    };
    if (hit) {
      if (DEBUG && !tapNoted) { tapNoted = true; showToast("Quick Decode: tap hook on " + hit.key); }
      const wrapped = make(hit.node.props[hit.key]);
      if (hit.node === row) {
        const patch = {}; patch[hit.key] = wrapped;
        return React.cloneElement(row, patch);
      }
      try { hit.node.props[hit.key] = wrapped; } catch (e) {
        try { hit.node.props = Object.assign({}, hit.node.props, (function () { const o = {}; o[hit.key] = wrapped; return o; })()); } catch (e2) {}
      }
      return row;
    }
    if (DEBUG && !tapNoted) {
      tapNoted = true;
      showToast("Quick Decode: no press handler. row keys: " + Object.keys((row && row.props) || {}).slice(0, 12).join(","));
    }
    return row;
  }

  let doubleOK = false;
  if (MODE === "double" || MODE === "both") {
    try {
      const RowManager = findByName("RowManager");
      if (RowManager && RowManager.prototype && RowManager.prototype.generate) {
        unpatches.push(after("generate", RowManager.prototype, function (args, row) {
          const data = args[0];
          if (!data || !data.message || !row || !isPuzzle(data.message)) return;
          return wrapRow(row, data.message);
        }));
        doubleOK = true;
      }
    } catch (e) { doubleOK = false; }
    if (!doubleOK) showToast("Quick Decode: double-tap hook unavailable, using hold");
  }

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

  exports.onUnload = function () { unpatches.forEach(function (u) { try { u(); } catch (e) {} }); };
  return exports;
})({});
