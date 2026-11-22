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
const AUTO_SEND = true;
const FILL_DEBUG = true;
const FILL_BOX = true;
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
function lookup(channelId, guildId, pred) {
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
const found = list.find(pred || isDecode);
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
let rawDraftNote = "";
let lastFill = null;
function currentDraft(channelId) {
try {
if (DraftStore && DraftStore.getDraft) {
let v = DraftStore.getDraft(channelId, 0);
rawDraftNote = typeof v + (v && typeof v === "object" ? " " + JSON.stringify(v).slice(0, 80) : ":" + JSON.stringify(v));
if (v && typeof v === "object") v = v.draft !== undefined ? v.draft : (v.text !== undefined ? v.text : (v.content !== undefined ? v.content : ""));
return String(v || "");
}
} catch (e) { rawDraftNote = "error " + (e && e.message); }
return null;
}
function setBox(channelId, text) {
const used = [];
try { if (DraftActions && DraftActions.changeDraft) { DraftActions.changeDraft(channelId, text, 0); used.push("changeDraft"); } } catch (e) { say("changeDraft failed: " + (e && e.message)); }
try { if (Flux && Flux.dispatch) { Flux.dispatch({ type: "DRAFT_CHANGE", channelId: channelId, draft: text, draftType: 0 }); used.push("flux"); } } catch (e) { say("flux draft failed: " + (e && e.message)); }
return used;
}
function probeInput() {
const names = ["insertText", "setText", "setChatInputText", "updateText", "appendText", "setInputText"];
const hit = [];
names.forEach(function (n) { try { if (findByProps(n)) hit.push(n); } catch (e) {} });
return hit.length ? hit.join(",") : "none";
}
const InputCmds = findByProps("setText", "getText");
const setTextArity = InputCmds && InputCmds.setText ? InputCmds.setText.length : 0;
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
// ===== PART 2 =====
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
function fillReport(msg) {
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
runDecode(message);
}
const SHOW_PICTURE = true;
const MENU = true;
const LOOT_ROUNDS = 80;
let lastSheet = null;
const namedCache = {};
async function runNamed(name, message) {
const channelId = message.channel_id;
const channel = ChannelStore.getChannel(channelId);
const guildId = channel && channel.guild_id;
const pred = function (c) { return !!c && c.name === name && c.type === 3 && APP_IDS.indexOf(c.application_id) !== -1; };
let cmd = namedCache[name] || (namedCache[name] = await lookup(channelId, guildId, pred));
try {
await post(cmd, message, channelId, guildId);
} catch (e1) {
delete namedCache[name];
cmd = namedCache[name] = await lookup(channelId, guildId, pred);
await post(cmd, message, channelId, guildId);
}
}
function askChoice(title, labels) {
return new Promise(function (resolve) {
let done = false;
function finish(v) { if (done) return; done = true; resolve(v); }
setTimeout(function () { finish(null); }, 180000);
function show(i) {
try {
if (labels.length === 1) {
alerts.showConfirmationAlert({ title: "Flee: stairs", content: title, confirmText: labels[0], cancelText: "Cancel",
onConfirm: function () { finish(0); }, onCancel: function () { finish(null); } });
} else if (labels.length === 2) {
alerts.showConfirmationAlert({ title: "Flee: which stairs?", content: title, confirmText: labels[0], cancelText: labels[1],
onConfirm: function () { finish(0); }, onCancel: function () { finish(1); } });
} else {
const last = i >= labels.length - 1;
alerts.showConfirmationAlert({ title: "Flee: which stairs? (" + (i + 1) + "/" + labels.length + ")", content: title, confirmText: labels[i],
cancelText: last ? "Cancel" : "Next",
onConfirm: function () { finish(i); }, onCancel: function () { if (last) finish(null); else show(i + 1); } });
}
} catch (e) { finish(null); }
}
setTimeout(function () { show(0); }, 300);
});
}
const FLEE_CHUNK = 5;
const FLEE_ROUNDS = 60;
const FLEE_WAIT = 9000;
const G = (typeof globalThis !== "undefined") ? globalThis : {};
const fleeBusy = {};
const mapWaiters = [];
function isHeistMap(m) {
try {
const t = (m.content || "") + " " + (m.embeds || []).map(function (e) { return (e.rawTitle || e.title || "") + " " + (e.rawDescription || e.description || ""); }).join(" ");
return /heist\s*map/i.test(t);
} catch (e) { return false; }
}
function mentionsMe(m) {
try {
const me = UserStore && UserStore.getCurrentUser && UserStore.getCurrentUser();
if (!me) return true;
const txt = (m.content || "") + " " + (m.embeds || []).map(function (e) { return (e.rawDescription || e.description || "") + " " + (e.rawTitle || e.title || ""); }).join(" ");
return txt.indexOf("<@" + me.id + ">") >= 0 || txt.indexOf("<@!" + me.id + ">") >= 0;
} catch (e) { return true; }
}
function sendText(ch, text) {
try {
if (MessageActions && MessageActions.sendMessage) {
MessageActions.sendMessage(ch, { content: text, tts: false, invalidEmojis: [], validNonShortcutEmojis: [] }, undefined, {});
return true;
}
} catch (e) { say("flee sendMessage failed: " + (e && e.message)); }
try { RestAPI.post({ url: "/channels/" + ch + "/messages", body: { content: text, nonce: nonce(), tts: false } }); return true; } catch (e) { say("flee REST failed: " + (e && e.message)); }
return false;
}
function onMapEvent(ev) {
try {
const m = ev && ev.message;
if (!mapWaiters.length || !m || !m.id || !m.author || !m.author.bot || !isHeistMap(m) || !mentionsMe(m)) return;
for (let i = mapWaiters.length - 1; i >= 0; i--) {
const w = mapWaiters[i];
if (w.ch === m.channel_id && !w.seen[m.id]) { mapWaiters.splice(i, 1); clearTimeout(w.t); w.done(m); }
}
} catch (e) {}
}
function waitForMap(ch, seen, ms) {
return new Promise(function (resolve) {
const w = { ch: ch, seen: seen, done: resolve, t: null };
w.t = setTimeout(function () { const i = mapWaiters.indexOf(w); if (i >= 0) mapWaiters.splice(i, 1); resolve(null); }, ms);
mapWaiters.push(w);
});
}
function latestMap(ch, fallback) {
try {
const msgs = MessageStore.getMessages(ch);
const arr = (msgs && (msgs.toArray ? msgs.toArray() : msgs._array)) || [];
for (let i = arr.length - 1; i >= 0; i--) {
const m = arr[i];
if (m && m.author && m.author.bot && (m.embeds || []).length && isHeistMap(m) && mentionsMe(m)) return m;
}
} catch (e) {}
return fallback;
}
async function fleeNow(message) {
const ch = message.channel_id;
const now = Date.now();
if (fleeBusy[ch] || (G.__qdFleeUntil && now < G.__qdFleeUntil)) { say("flee already running"); return; }
fleeBusy[ch] = true;
G.__qdFleeUntil = now + 600000;
try {
if (!SelectedChannelStore || SelectedChannelStore.getChannelId() !== ch) { alertMsg("Flee: open the heist channel first"); return; }
let cur = latestMap(ch, message);
const seen = {};
seen[cur.id] = 1; seen[message.id] = 1;
let prevLen = 1e9, stuck = 0, choice = null, asks = 0;
for (let round = 0; round < FLEE_ROUNDS; round++) {
if (SelectedChannelStore.getChannelId() !== ch) { say("flee stopped: left the channel"); return; }
let r;
try { r = await localCall("/flee", Object.assign(payload(cur), { buttons: true, choice: choice }), 5000); }
catch (e) { linkDown(e); alertMsg("Flee: bot not reachable (" + (e && e.message) + ")"); return; }
choice = null;
if (r && !r.ok && r.ask && r.ask.length && asks < 4) {
asks++;
if (asks === 1 && SHOW_PICTURE) {
let shown = false;
try { await runNamed("Flee", cur); shown = true; } catch (e) { say("stairs picture failed: " + describe(e)); }
if (shown) { say("flee: stairs picture sent by the bot - pick A / B there, then hold the map again"); return; }
}
const idx = await askChoice(r.answer || "Which stairs go DOWN?", r.ask);
if (idx === null || idx === undefined) { say("flee: stairs question not answered"); return; }
choice = idx;
round--;
continue;
}
if (!r || !r.ok) { alertMsg("Flee: " + ((r && r.answer) || "no answer")); return; }
if (r.send) { sendText(ch, r.send); alertMsg("Flee: " + (r.answer || "") + " - sent \"" + r.send + "\". Tap Flee again when the guard is dead"); return; }
const steps = String(r.steps || "").toLowerCase().replace(/[^wasd]/g, "");
const stairs = /STAIRS/.test(String(r.answer || ""));
if (!steps) { say("flee: nothing to move"); if (round === 0) alertMsg(stairs ? "Flee: " + r.answer : "Flee: you are on the exit - type Flee"); return; }
if (!r.more && steps.length >= prevLen) {
stuck++;
if (stuck >= 2) { alertMsg("Flee: stuck - the moves are not changing your position (wall or locked door?)"); return; }
} else stuck = 0;
prevLen = r.more ? 1e9 : steps.length;
say("flee route (" + steps.length + "): " + steps);
const last = steps.length <= FLEE_CHUNK && !r.more;
const wait = (!last || stairs) ? waitForMap(ch, seen, FLEE_WAIT) : null;
if (!sendText(ch, steps.slice(0, FLEE_CHUNK))) { alertMsg("Flee: could not send"); return; }
if (last && !stairs) return;
const nm = await wait;
if (!nm) { alertMsg("Flee: the bot did not answer with a new map"); return; }
seen[nm.id] = 1;
cur = nm;
if (last && stairs) { prevLen = 1e9; stuck = 0; }
}
alertMsg("Flee: stopped after " + FLEE_ROUNDS + " rounds");
} finally { fleeBusy[ch] = false; G.__qdFleeUntil = 0; }
}
if (Flux && Flux.subscribe) {
try {
Flux.subscribe("MESSAGE_CREATE", onMapEvent);
Flux.subscribe("MESSAGE_UPDATE", onMapEvent);
unpatches.push(function () { try { Flux.unsubscribe("MESSAGE_CREATE", onMapEvent); Flux.unsubscribe("MESSAGE_UPDATE", onMapEvent); } catch (e) {} });
} catch (e) {}
}
async function lootNow(message) {
const ch = message.channel_id;
const now = Date.now();
if (fleeBusy[ch] || (G.__qdFleeUntil && now < G.__qdFleeUntil)) { say("flee/loot already running"); return; }
fleeBusy[ch] = true;
G.__qdFleeUntil = now + 600000;
try {
if (!SelectedChannelStore || SelectedChannelStore.getChannelId() !== ch) { alertMsg("Loot: open the heist channel first"); return; }
let cur = latestMap(ch, message);
const seen = {};
seen[cur.id] = 1; seen[message.id] = 1;
let first = true;
for (let round = 0; round < LOOT_ROUNDS; round++) {
if (SelectedChannelStore.getChannelId() !== ch) { say("loot stopped: left the channel"); return; }
let r;
try { r = await localCall("/loot", Object.assign(payload(cur), { reset: first }), 6000); }
catch (e) { linkDown(e); alertMsg("Loot: bot not reachable (" + (e && e.message) + ")"); return; }
first = false;
if (!r || !r.ok) { alertMsg("Loot: " + ((r && r.answer) || "no answer")); return; }
const steps = String(r.steps || "").toLowerCase().replace(/[^wasd]/g, "");
if (r.done || !steps) { alertMsg("Loot: " + (r.answer || "done")); return; }
say("loot: " + r.answer + " -> " + steps);
const wait = waitForMap(ch, seen, FLEE_WAIT);
if (!sendText(ch, steps.slice(0, FLEE_CHUNK))) { alertMsg("Loot: could not send"); return; }
const nm = await wait;
if (!nm) { alertMsg("Loot: the bot did not answer with a new map"); return; }
seen[nm.id] = 1;
cur = nm;
}
alertMsg("Loot: stopped after " + LOOT_ROUNDS + " rounds");
} finally { fleeBusy[ch] = false; G.__qdFleeUntil = 0; }
}
function openHeistMenu(message) {
const items = [
{ label: "Flee", run: function () { fleeNow(message); } },
{ label: "Auto loot", run: function () { lootNow(message); } },
{ label: "Normal menu", run: function () { try { if (lastSheet) lastSheet.orig.apply(ActionSheet, lastSheet.args); } catch (e) { say("normal menu failed: " + (e && e.message)); } } },
];
function show(i) {
const it = items[i];
const last = i === items.length - 1;
setTimeout(function () {
try {
alerts.showConfirmationAlert({
title: "Heist menu (" + (i + 1) + "/" + items.length + ")",
content: it.label + "?   Tap " + (last ? "Close to leave" : "More for the next option") + ".",
confirmText: it.label,
cancelText: last ? "Close" : "More",
onConfirm: function () { it.run(); },
onCancel: function () { if (!last) show(i + 1); },
});
} catch (e) { say("menu failed: " + (e && e.message)); fleeNow(message); }
}, 150);
}
show(0);
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
function handleMessage(message) {
if (!message || !message.id) return false;
if (message.author && message.author.bot && isHeistMap(message) && mentionsMe(message)) {
if (MENU) openHeistMenu(message); else fleeNow(message);
return true;
}
if (isPuzzle(message) && (MODE === "both" || MODE === "decode")) {
fire(message);
return true;
}
return false;
}
try {
unpatches.push(instead("openLazy", ActionSheet, function (args, orig) {
try {
const key = args[1];
const ctx = args[2] || {};
const message = ctx.message;
if (key === "MessageLongPressActionSheet" && message) {
lastSheet = { orig: orig, args: args };
if (handleMessage(message) && HIDE_SHEET) return;
}
} catch (e) { say("sheet patch error: " + (e && e.message)); }
return orig.apply(this, args);
}));
} catch (e) { say("could not patch ActionSheet: " + (e && e.message)); }
exports.onLoad = function () { say("loaded"); };
exports.onUnload = function () {
unpatches.forEach(function (u) { try { u(); } catch (e) {} });
unpatches.length = 0;
};
Object.defineProperty(exports, "__esModule", { value: true });
return exports;
})({});
  
