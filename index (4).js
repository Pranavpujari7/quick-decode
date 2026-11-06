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
  const LOCAL_LINK = true;                // v11: hand puzzles straight to the bot on THIS phone (no Discord round trip). Falls back to Discord by itself
  const LOCAL_URL = "http://127.0.0.1:8787";   // must match LOCAL_PORT in the bot file
  const LOCAL_KEY = "qd";                 // must match LOCAL_KEY in the bot file
  const AUTO_SEND = true;                 // v16: right after YOUR double-tap/hold, post the bot's answer as a message (one message per puzzle). false = only fill the box
  const FILL_DEBUG = true;                // v13 TEMPORARY: after every tap show a dialog saying exactly what the box-fill did (set to false once it works)
  const FILL_BOX = true;                  // v12: after a LOCAL decode, put the answer into the message box (it NEVER sends - you press send). false = off
  const PREFETCH = true;                  // v11: when a puzzle addressed to YOU appears in the channel you are looking at, tell the bot so it downloads the image now
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
  const SelectedChannelStore = findByStoreName("SelectedChannelStore");
  const UserStore = findByStoreName("UserStore");
  const MessageActions = findByProps("sendMessage", "receiveMessage");
  const DraftStore = findByStoreName("DraftStore");
  const DraftActions = findByProps("changeDraft");
  const Flux = (vendetta.metro.common && vendetta.metro.common.FluxDispatcher) || findByProps("dispatch", "subscribe");
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

  // ---------- v11: LOCAL LINK - plugin -> bot, both on this phone ----------
  // Discord round trip (tap -> Discord -> bot) and the image download are the two slow parts.  The plugin already holds
  // the message, so it hands it straight to the bot over 127.0.0.1; the bot may already have the image (prefetch).
  // If the link is down / blocked / gives no answer, everything falls back to the normal Discord command below.
  let localDownUntil = 0;
  let localState = "not tested yet";
  function img(p) { return p ? { url: p.url || "", proxy_url: p.proxyURL || p.proxy_url || "" } : null; }
  function payload(m) {
    return {
      k: LOCAL_KEY,
      id: m.id,
      content: m.content || "",
      embeds: (m.embeds || []).map(function (e) {
        return {
          title: e.rawTitle || e.title || "",
          description: e.rawDescription || e.description || "",
          author: e.author ? { name: e.author.name || "" } : null,
          footer: e.footer ? { text: e.footer.text || "" } : null,
          fields: (e.fields || []).map(function (f) { return { name: f.rawName || f.name || "", value: f.rawValue || f.value || "" }; }),
          image: img(e.image),
          thumbnail: img(e.thumbnail),
        };
      }),
      attachments: (m.attachments || []).map(function (a) {
        return { url: a.url, proxy_url: a.proxyURL || a.proxy_url, content_type: a.content_type || a.contentType };
      }),
    };
  }
  function localCall(path, body, ms) {
    return new Promise(function (resolve, reject) {
      const t = setTimeout(function () { reject(new Error("timeout")); }, ms);
      let p;
      try {
        p = body ? fetch(LOCAL_URL + path, { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(body) })
                 : fetch(LOCAL_URL + path);
      } catch (e) { clearTimeout(t); reject(e); return; }
      p.then(function (r) { return r.json(); }).then(function (j) { clearTimeout(t); resolve(j); },
                                                   function (e) { clearTimeout(t); reject(e); });
    });
  }
  function linkDown(e) { if (!e || e.message !== "timeout") localDownUntil = Date.now() + 20000; }

  // ---------- v12: put the answer into the message box (NEVER sends) ----------
  // Only when ALL of these hold: it was a local decode with an answer, you are looking at the channel the puzzle is in,
  // and the box is empty (so it never overwrites what you typed).  Anything unexpected -> it does nothing.
  // These are idempotent "set the draft" calls (not "insert"), so running more than one can never duplicate the text.
  let rawDraftNote = "";
  let lastFill = null;                           // {ch, text} of our own last fill, so a repeat tap may replace it (never your own typing)
  function currentDraft(channelId) {
    try {
      if (DraftStore && DraftStore.getDraft) {
        let v = DraftStore.getDraft(channelId, 0);
        rawDraftNote = typeof v + (v && typeof v === "object" ? " " + JSON.stringify(v).slice(0, 80) : ":" + JSON.stringify(v));
        if (v && typeof v === "object") v = v.draft !== undefined ? v.draft : (v.text !== undefined ? v.text : (v.content !== undefined ? v.content : ""));
        return String(v || "");
      }
    } catch (e) { rawDraftNote = "error " + (e && e.message); }
    return null;                                  // unknown
  }
  function setBox(channelId, text) {
    const used = [];
    try { if (DraftActions && DraftActions.changeDraft) { DraftActions.changeDraft(channelId, text, 0); used.push("changeDraft"); } } catch (e) { say("changeDraft failed: " + (e && e.message)); }
    try { if (Flux && Flux.dispatch) { Flux.dispatch({ type: "DRAFT_CHANGE", channelId: channelId, draft: text, draftType: 0 }); used.push("flux"); } } catch (e) { say("flux draft failed: " + (e && e.message)); }
    return used;
  }
  // which "put text into the input" helpers exist in this Discord build (only looked up for the diagnostic dialog)
  function probeInput() {
    const names = ["insertText", "setText", "setChatInputText", "updateText", "appendText", "setInputText"];
    const hit = [];
    names.forEach(function (n) { try { if (findByProps(n)) hit.push(n); } catch (e) {} });
    return hit.length ? hit.join(",") : "none";
  }
  // v15: the on-screen box is driven by native commands (focus, blur, getText, flushText, setText(ref, text) ...).  They need a
  // handle to the box, which we pick up passively whenever Discord itself calls one of them (tapping the box, opening a channel...).
  const InputCmds = findByProps("setText", "getText");
  const setTextArity = InputCmds && InputCmds.setText ? InputCmds.setText.length : 0;     // read BEFORE patching: the patch wrapper reports 0
  let inputRef = null, refVia = "", seenSig = "", inCall = false;
  if (InputCmds) {
    ["focus", "blur", "getText", "flushText", "setText", "setSelectedRange", "backspace"].forEach(function (name) {
      if (typeof InputCmds[name] !== "function") return;
      try {
        unpatches.push(before(name, InputCmds, function (args) {
          if (inCall) return;
          const a = args && args[0];
          if (a && (typeof a === "object" || typeof a === "number")) { inputRef = a; refVia = name; }
          if (name === "setText" && !seenSig) seenSig = Array.prototype.map.call(args, function (x) { return typeof x; }).join(",");
        }));
      } catch (e) {}
    });
  }
  function pushToInput(text) {
    try {
      if (!InputCmds || typeof InputCmds.setText !== "function") return "no setText helper";
      const sig = seenSig ? " Discord's own setText calls look like (" + seenSig + ")." : "";
      const arity = setTextArity;
      if (arity <= 1) { inCall = true; try { InputCmds.setText(text); } finally { inCall = false; } return "called setText(text)." + sig; }
      if (!inputRef) return "no handle to the box yet - tap the message box once, then double-tap the puzzle again." + sig;
      inCall = true;
      try {
        InputCmds.setText(inputRef, text);
        if (typeof InputCmds.flushText === "function") InputCmds.flushText(inputRef);
      } finally { inCall = false; }
      return "called setText(handle, text)+flushText; handle is a " + typeof inputRef + " taken from " + refVia + "." + sig;
    } catch (e) { inCall = false; return "setText failed: " + (e && e.message); }
  }
  function fillReport(msg) {                      // v13 diagnostic: a dialog right after the tap (bypasses the 15 s limit)
    say("box fill: " + msg);
    if (!FILL_DEBUG) return;
    setTimeout(function () {
      try { alerts.showConfirmationAlert({ title: "Quick Decode box fill", content: msg, confirmText: "OK" }); } catch (e) {}
    }, 300);
  }
  function fillBox(message, answer) {
    if (!FILL_BOX) return;
    try {
      const text = String(answer || "").replace(/\s+/g, " ").trim();
      if (!text || text.length > 200) { fillReport("skipped: empty or too long answer"); return; }
      const ch = message.channel_id;
      const viewing = SelectedChannelStore && SelectedChannelStore.getChannelId();
      if (!SelectedChannelStore || viewing !== ch) { fillReport("skipped: not looking at that channel (viewing " + viewing + ", puzzle in " + ch + ")"); return; }
      const draft = currentDraft(ch);
      if (draft === null) { fillReport("skipped: cannot read the box (DraftStore missing)"); return; }
      if (draft.trim() !== "" && !(lastFill && lastFill.ch === ch && lastFill.text === draft)) { fillReport("skipped: the box already has text. getDraft gave " + rawDraftNote); return; }
      const used = setBox(ch, text);
      if (!used.length) { fillReport("no way to set the draft found (changeDraft/flux missing). input helpers: " + probeInput()); return; }
      lastFill = { ch: ch, text: text };
      const inputNote = pushToInput(text);
      const after = currentDraft(ch);
      fillReport("set the draft via " + used.join("+") + " to \"" + text + "\". Store now reads: " + JSON.stringify(after) +
        (after === text ? " (store took it)" : " (store did NOT take it)") + ". Input: " + inputNote);
    } catch (e) { fillReport("failed: " + (e && e.message)); }
  }

  // ---------- v16: send the answer (only after YOUR double-tap/hold, only after a local decode that returned an answer) ----------
  // Limits: one message per puzzle message, only in the channel the puzzle is in and only while you are looking at it, only a short
  // answer text.  It uses Discord's own send function (the same one the send button uses); the REST call is the fallback.
  const sentFor = {};
  function sendAnswer(message, answer) {
    try {
      const text = String(answer || "").replace(/\s+/g, " ").trim();
      if (!text || text.length > 80) { say("not sent: empty or too long answer"); return false; }
      if (sentFor[message.id]) { say("not sent: already answered this puzzle"); return false; }
      const ch = message.channel_id;
      if (!SelectedChannelStore || SelectedChannelStore.getChannelId() !== ch) { say("not sent: not looking at the puzzle channel"); return false; }
      let how = "";
      try {
        if (MessageActions && MessageActions.sendMessage) {
          MessageActions.sendMessage(ch, { content: text, tts: false, invalidEmojis: [], validNonShortcutEmojis: [] }, undefined, {});
          how = "sendMessage";
        }
      } catch (e) { how = ""; say("sendMessage failed: " + (e && e.message)); }
      if (!how) {
        RestAPI.post({ url: "/channels/" + ch + "/messages", body: { content: text, nonce: nonce(), tts: false } });
        how = "REST";
      }
      sentFor[message.id] = 1;
      say("answer sent via " + how + ": " + text);
      return true;
    } catch (e) { say("send failed: " + (e && e.message)); return false; }
  }

  async function decodeNow(message) {
    if (LOCAL_LINK && Date.now() >= localDownUntil) {
      const t0 = Date.now();
      try {
        const r = await localCall("/decode", payload(message), 1500);
        if (r && r.ok) { localState = "ok"; say("local decode ok in " + (Date.now() - t0) + " ms: " + r.answer); if (AUTO_SEND) sendAnswer(message, r.answer); else fillBox(message, r.answer); return; }
        say("local decode gave no answer (" + (r && r.answer) + ") -> using Discord");
        if (FILL_BOX) fillReport("not filled: the bot gave no answer over the local link (" + (r && r.answer) + "), so Discord was used instead");
      } catch (e) {
        linkDown(e);
        say("local link failed (" + (e && e.message) + ") -> using Discord");
        if (FILL_BOX) fillReport("not filled: local link failed (" + (e && e.message) + "), so Discord was used instead");
      }
    } else if (LOCAL_LINK && FILL_BOX) {
      fillReport("not filled: local link is marked down for another " + Math.ceil((localDownUntil - Date.now()) / 1000) + " s, so Discord was used instead");
    }
    runDecode(message);                         // fallback: the normal Decode command through Discord
  }

  // run Decode for a message (shared by double-tap and hold) - only ever on YOUR tap
  function fire(message) {
    const now = Date.now();
    if (lastFired[message.id] && now - lastFired[message.id] < 3000) return;
    lastFired[message.id] = now;
    say("decoding...");
    decodeNow(message);
  }

  // ---- prefetch: a puzzle addressed to you shows up in the channel you are looking at -> bot downloads the image now.
  //      Nothing is sent to Discord and nothing is answered; the bot only gets the image ready for your tap. ----
  const preSeen = {};
  function onNewMessage(ev) {
    try {
      const m = ev && ev.message;
      if (!m || !m.id || preSeen[m.id] || !m.author || !m.author.bot) return;
      if (ONLY_AUTHOR_ID && m.author.id !== ONLY_AUTHOR_ID) return;
      if (!((m.embeds || []).length || (m.attachments || []).length)) return;
      if (SelectedChannelStore && m.channel_id !== SelectedChannelStore.getChannelId()) return;
      const me = UserStore && UserStore.getCurrentUser && UserStore.getCurrentUser();
      if (me) {
        const txt = (m.content || "") + " " + (m.embeds || []).map(function (e) { return (e.rawDescription || e.description || "") + " " + (e.rawTitle || e.title || ""); }).join(" ");
        if (txt.indexOf("<@" + me.id + ">") < 0 && txt.indexOf("<@!" + me.id + ">") < 0) return;
      }
      if (Date.now() < localDownUntil) return;
      preSeen[m.id] = 1;
      localCall("/pre", payload(m), 1500).then(function () { localState = "ok"; }, linkDown);
    } catch (e) {}
  }
  if (LOCAL_LINK && PREFETCH && Flux && Flux.subscribe) {
    try {
      Flux.subscribe("MESSAGE_CREATE", onNewMessage);
      Flux.subscribe("MESSAGE_UPDATE", onNewMessage);
      unpatches.push(function () { try { Flux.unsubscribe("MESSAGE_CREATE", onNewMessage); Flux.unsubscribe("MESSAGE_UPDATE", onNewMessage); } catch (e) {} });
    } catch (e) {}
  }
  if (LOCAL_LINK) setTimeout(function () {                      // is the bot reachable from inside Discord? (some builds block plain http)
    localCall("/ping", null, 2000).then(function (j) { localState = j && j.ok ? "ok" : "no answer"; },
                                        function (e) { localState = "unreachable (" + (e && e.message) + ")"; linkDown(e); });
  }, 2000);

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

  function buildStatus() {
    return "Quick Decode v16 loaded (" + MODE + (MODE !== "hold" ? ", double-tap hooks: " + (hookA ? "A" : "-") + (hookB ? "B" : "-") + (spoofOK ? "P" : "-") : "") +
      (cmdCache ? ", command cached" : ", command not cached yet") + (LOCAL_LINK ? ", local link: " + localState : "") +
      (AUTO_SEND ? ", auto-send: ON (" + (MessageActions && MessageActions.sendMessage ? "sendMessage ok" : "sendMessage MISSING, REST fallback") + ")" : "") + (FILL_BOX ? ", box fill: draftStore " + (DraftStore && DraftStore.getDraft ? "ok" : "MISSING") + ", changeDraft " + (DraftActions && DraftActions.changeDraft ? "ok" : "MISSING") + ", flux " + (Flux && Flux.dispatch ? "ok" : "MISSING") : "") + ")";
  }
  say(buildStatus());
  if (DEBUG) setTimeout(function () { alertMsg(buildStatus()); }, 6500);

  exports.onUnload = function () { unpatches.forEach(function (u) { try { u(); } catch (e) {} }); };
  return exports;
})({});
