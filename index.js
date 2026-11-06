(function (exports) {
"use strict";
const APP_IDS = ["1554084772618182746", "1554104747273748550"];
const COMMAND_NAME = "Decode";
const ONLY_AUTHOR_ID = "";
const HIDE_SHEET = true;
const MODE = "both";
const DEBUG = true;
const LOCAL_LINK = true;
const LOCAL_URL = "http://127.0.0.1:8787";
const LOCAL_KEY = "qd";
const PREFETCH = true;
const CMD_ID = "";
const CMD_VERSION = "";
const { findByProps, findByStoreName } = vendetta.metro;
const { before, instead } = vendetta.patcher;
const alerts = vendetta.ui.alerts;
let lastAlert = 0;
function say(msg) { try { console.log("[QuickDecode] " + msg); } catch (e) {} }
function alertMsg(msg) {
say(msg);
const now = Date.now();
if (now - lastAlert < 15000) return;
lastAlert = now;
setTimeout(function () {
try { alerts.showConfirmationAlert({ title: "Quick Decode v11", content: msg, confirmText: "OK" }); } catch (e) {}
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
const Flux = (vendetta.metro.common && vendetta.metro.common.FluxDispatcher) || findByProps("dispatch", "subscribe");
const PermConsts = (vendetta.metro.common.constants && vendetta.metro.common.constants.Permissions) ||
(findByProps("Permissions") || {}).Permissions || {};
const ADD_REACT = PermConsts.ADD_REACTIONS;
const unpatches = [];
const lastFired = {};
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
if (CMD_ID) return;
cmdCache = null;
try { store.cmd = null; } catch (e) {}
}
function describe(e) {
const status = e && e.status;
const msg = (e && e.body && e.body.message) || (e && e.message) || "";
return (status ? status + " " : "") + msg;
}
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
} catch (e1) {
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
async function decodeNow(message) {
if (LOCAL_LINK && Date.now() >= localDownUntil) {
const t0 = Date.now();
try {
const r = await localCall("/decode", payload(message), 1500);
if (r && r.ok) { localState = "ok"; say("local decode ok in " + (Date.now() - t0) + " ms: " + r.answer); return; }
say("local decode gave no answer (" + (r && r.answer) + ") -> using Discord");
} catch (e) {
linkDown(e);
say("local link failed (" + (e && e.message) + ") -> using Discord");
}
}
runDecode(message);
}
function fire(message) {
const now = Date.now();
if (lastFired[message.id] && now - lastFired[message.id] < 3000) return;
lastFired[message.id] = now;
say("decoding...");
decodeNow(message);
}
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
if (LOCAL_LINK) setTimeout(function () {
localCall("/ping", null, 2000).then(function (j) { localState = j && j.ok ? "ok" : "no answer"; },
function (e) { localState = "unreachable (" + (e && e.message) + ")"; linkDown(e); });
}, 2000);
if (!cmdCache) setTimeout(function () { getCommand(null, null).then(function () { say("Decode command ready"); }, function () {}); }, 2500);
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
let hookA = false, hookB = false;
const REACT_URL = /\/channels\/(\d+)\/messages\/(\d+)\/reactions\//;
if (MODE === "double" || MODE === "both") {
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
return "Quick Decode v11 loaded (" + MODE + (MODE !== "hold" ? ", double-tap hooks: " + (hookA ? "A" : "-") + (hookB ? "B" : "-") + (spoofOK ? "P" : "-") : "") +
(cmdCache ? ", command cached" : ", command not cached yet") + (LOCAL_LINK ? ", local link: " + localState : "") + ")";
}
say(buildStatus());
if (DEBUG) setTimeout(function () { alertMsg(buildStatus()); }, 6500);
exports.onUnload = function () { unpatches.forEach(function (u) { try { u(); } catch (e) {} }); };
return exports;
})({});
