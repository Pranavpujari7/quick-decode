(function (exports) {
  "use strict";

  // ---------- settings (edit these) ----------
  // Both ids are accepted: a bot's application id is normally the same number as its user id, but if you ever
  // re-created the app the old id may still be listed.  The command that is found decides which one is sent.
  const APP_IDS = ["1554084772618182746", "1554104747273748550"];
  const COMMAND_NAME = "Decode";          // the message command name
  const ONLY_AUTHOR_ID = "";              // optional: Paimon's user id, so only its messages trigger (empty = any bot message with an image)
  const HIDE_SHEET = true;                // close the long-press menu on puzzle messages
  const MODE = "both";                    // "double" = double-tap the puzzle (fastest), "hold" = long-press, "both"
  const DEBUG = true;                     // show one status dialog a few seconds after Discord starts
  const CMD_ID = "";                      // optional: Decode command id (only if auto-lookup fails)
  const CMD_VERSION = "";                 // optional: Decode command version (usually same as id)
  // --------------------------------------------

  const { findByProps, findByStoreName } = vendetta.metro;
  const { before, instead } = vendetta.patcher;
  const alerts = vendetta.ui.alerts;
  let lastAlert = 0;
  function say(msg) { try { console.log("[QuickDecode] " + msg); } catch (e) {} }
  function alertMsg(msg) {                       // dialog instead of a toast (toasts crash this Discord build)
    say(msg);
    const now = Date.now();
    if (now - lastAlert < 15000) return;
    lastAlert = now;
    setTimeout(function () {
      try { alerts.showConfirmationAlert({ title: "Quick Decode", content: msg, confirmText: "OK" }); } catch (e) {}
    }, 400);
  }

  const ActionSheet = findByProps("openLazy", "hideActionSheet");
  const RestAPI = findByProps("getAPIBaseURL", "get");
  const SessionStore = findByProps("getSessionId");
  const Snowflake = findByProps("fromTimestamp");
  const ChannelStore = findByStoreName("ChannelStore");
  const MessageStore = findByStoreName("MessageStore");
  const ReactionActions = findByProps("addReaction", "removeReaction");
  const PermissionStore = findByStoreName("PermissionStore");
  const PermConsts = (vendetta.metro.common.constants && vendetta.metro.common.constants.Permissions) ||
    (findByProps("Permissions") || {}).Permissions || {};
  const ADD_REACT = PermConsts.ADD_REACTIONS;

  const unpatches = [];
  const lastFired = {};

  // ---------- the Decode command: found ONCE, then remembered (also across app restarts) ----------
  // v10: the old version asked Discord for the command list on the first tap (up to 3 requests one after the other)
  // and forgot it after any error.  Now: remembered on disk, looked up in the background at start-up, all lookups
  // run in parallel, and a stale command is refreshed automatically with one instant retry.
  let store = {};
  try { store = vendetta.plugin.storage || {}; } catch (e) {}

  function isDecode(c) {
    return !!c && c.name === COMMAND_NAME && c.type === 3 && APP_IDS.indexOf(c.application_id) !== -1;
  }
  let cmdCache = null;
  try { if (CMD_ID) cmdCache = { id: CMD_ID, version: CMD_VERSION || CMD_ID, name: COMMAND_NAME, type: 3, application_id: APP_IDS[0] };
        else if (isDecode(store.cmd)) cmdCache = store.cmd; } catch (e) {}
  let inflight = null;

  function remember(c) {
    cmdCache = c;
    try { store.cmd = c; } catch (e) {}
  }
  function forget() {
    if (CMD_ID) return;                          // a hand-set id is never thrown away
    cmdCache = null;
    try { store.cmd = null; } catch (e) {}
  }

  function describe(e) {
    const status = e && e.status;
    const msg = (e && e.body && e.body.message) || (e && e.message) || "";
    return (status ? status + " " : "") + msg;
  }

  // ask every command index at the same time, first hit wins
  function lookup(channelId, guildId) {
    const urls = ["/users/@me/application-command-index"];
    if (channelId) urls.unshift("/channels/" + channelId + "/application-command-index");
    if (guildId) urls.push("/guilds/" + guildId + "/application-command-index");
    return new Promise(function (resolve, reject) {
      let left = urls.length, done = false, lastErr = null;
      function settle() { if (--left === 0 && !done) reject(lastErr || new Error("not in command list")); }
      urls.forEach(function (u) {
        let p;
        try { p = RestAPI.get({ url: u }); } catch (e) { lastErr = e; settle(); return; }
        Promise.resolve(p).then(function (res) {
          const list = (res && res.body && res.body.application_commands) || [];
          const found = list.find(isDecode);
          if (found && !done) { done = true; resolve(found); }
          settle();
        }, function (e) { lastErr = e; settle(); });
      });
    });
  }

  function getCommand(channelId, guildId) {
    if (cmdCache) return Promise.resolve(cmdCache);
    if (!inflight) {
      inflight = lookup(channelId, guildId).then(function (c) { remember(c); inflight = null; return c; },
        function (e) { inflight = null; const err = new Error(describe(e) || "not in command list"); err.step = "find"; throw err; });
    }
    return inflight;
  }

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

  function post(cmd, message, channelId, guildId) {
    const body = {
      type: 2,
      application_id: cmd.application_id || APP_IDS[0],
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
    return RestAPI.post({ url: "/interactions", body: body });
  }

  async function runDecode(message) {
    const t0 = Date.now();
    const channelId = message.channel_id;
    const channel = ChannelStore.getChannel(channelId);
    const guildId = channel && channel.guild_id;
    let step = "find";
    try {
      let cmd = await getCommand(channelId, guildId);
      step = "send";
      try {
        await post(cmd, message, channelId, guildId);
      } catch (e1) {                              // stale command id/version? refresh once and try again right away
        forget();
        step = "find";
        cmd = await getCommand(channelId, guildId);
        step = "send";
        await post(cmd, message, channelId, guildId);
      }
      say("decode sent in " + (Date.now() - t0) + " ms");
    } catch (e) {
      forget();
      alertMsg("Quick Decode " + (e && e.step || step) + " failed: " + describe(e));
    }
  }

  // run Decode for a message (shared by double-tap and hold) - only ever on YOUR tap
  function fire(message) {
    const now = Date.now();
    if (lastFired[message.id] && now - lastFired[message.id] < 3000) return;
    lastFired[message.id] = now;
    say("decoding...");
    runDecode(message);
  }

  // find the command in the background right after start-up, so the very first tap is already instant
  if (!cmdCache) setTimeout(function () { getCommand(null, null).then(function () { say("Decode command ready"); }, function () {}); }, 2500);

  // ---- channels where reactions are off: Discord ignores the double-tap, so tell the app reactions are
  //      allowed (client-side only) in channels that currently show a puzzle; our hooks below then catch it ----
  const spoofCache = {};
  function channelHasPuzzle(channelId) {
    const now = Date.now();
    const c = spoofCache[channelId];
    if (c && now - c.t < 8000) return c.v;
    let v = false;
    try {
      const msgs = MessageStore.getMessages(channelId);
      const arr = (msgs && (msgs.toArray ? msgs.toArray() : msgs._array)) || [];
      v = arr.slice(-40).some(isPuzzle);
    } catch (e) {}
    spoofCache[channelId] = { t: now, v: v };
    return v;
  }
  let spoofOK = false;
  if ((MODE === "double" || MODE === "both") && PermissionStore && PermissionStore.can && ADD_REACT !== undefined) {
    try {
      unpatches.push(instead("can", PermissionStore, function (args, orig) {
        const res = orig.apply(this, args);
        if (res) return res;
        try {
          if (args[0] === ADD_REACT && args[1] && args[1].id && channelHasPuzzle(args[1].id)) return true;
        } catch (e) {}
        return res;
      }));
      spoofOK = true;
    } catch (e) {}
  }

  // ---- double-tap: Discord's built-in double-tap adds a reaction, so we catch that ----
  let hookA = false, hookB = false;
  const REACT_URL = /\/channels\/(\d+)\/messages\/(\d+)\/reactions\//;
  if (MODE === "double" || MODE === "both") {
    // A) the reaction action (swallows it before anything shows up)
    if (ReactionActions && MessageStore) {
      try {
        unpatches.push(instead("addReaction", ReactionActions, function (args, orig) {
          try {
            const m = MessageStore.getMessage(args[0], args[1]) || MessageStore.getMessage(args[1], args[0]);
            if (m && isPuzzle(m)) { fire(m); return; }
          } catch (e) {}
          return orig.apply(this, args);
        }));
        hookA = true;
      } catch (e) {}
    }
    // B) fallback: the network call that adds a reaction (works even if the action above is named differently)
    if (RestAPI && MessageStore && RestAPI.put) {
      try {
        unpatches.push(instead("put", RestAPI, function (args, orig) {
          try {
            const url = args[0] && args[0].url;
            const hit = typeof url === "string" && REACT_URL.exec(url);
            if (hit) {
              const m = MessageStore.getMessage(hit[1], hit[2]);
              if (m && isPuzzle(m)) {
                fire(m);
                return Promise.resolve({ ok: true, status: 204, body: {}, headers: {} });
              }
            }
          } catch (e) {}
          return orig.apply(this, args);
        }));
        hookB = true;
      } catch (e) {}
    }
    if (!hookA && !hookB) say("double-tap hook unavailable, using hold");
  }

  // ---- hold (long-press) ----
  if ((MODE === "hold" || MODE === "both" || !(hookA || hookB)) && ActionSheet && RestAPI) {
    unpatches.push(before("openLazy", ActionSheet, function (args) {
      const key = args[1];
      if (key !== "MessageLongPressActionSheet") return;
      const message = args[2] && args[2].message;
      if (!isPuzzle(message)) return;
      fire(message);
      if (HIDE_SHEET) setTimeout(function () { try { ActionSheet.hideActionSheet(); } catch (e) {} }, 120);
    }));
  }

  const status = ("Quick Decode v10 loaded (" + MODE + (MODE !== "hold" ? ", double-tap hooks: " + (hookA ? "A" : "-") + (hookB ? "B" : "-") + (spoofOK ? "P" : "-") : "") + (cmdCache ? ", command cached" : ", command not cached yet") + ")");
  say(status);
  if (DEBUG) setTimeout(function () { alertMsg(status); }, 6000);

  exports.onUnload = function () { unpatches.forEach(function (u) { try { u(); } catch (e) {} }); };
  return exports;
})({});
