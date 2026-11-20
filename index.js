(function () {
  var M = vendetta.metro, C = M.common, React = C.React, Flux = C.FluxDispatcher;
  var st = vendetta.plugin.storage;
  var DEF = { port: "8787", key: "qd", safeText: "", safeWait: "20", maxScout: "240", mapTimeout: "30" };
  Object.keys(DEF).forEach(function (k) { if (st[k] == null) st[k] = DEF[k]; });

  var undo = [];
  var S = null; // current run

  function num(v, d) { var n = parseFloat(v); return isFinite(n) ? n : d; }
  function toast(t) {
    try { vendetta.ui.toasts.showToast(String(t).slice(0, 90), vendetta.ui.assets.getAssetIDByName("ic_info")); } catch (e) {}
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // ---------- helpers ----------
  function imgOf(m) {
    var e = m.embeds || [], i, im, u;
    for (i = 0; i < e.length; i++) {
      im = e[i].image || e[i].thumbnail;
      u = im && (im.url || im.proxy_url || im.proxyURL);
      if (u) return u;
    }
    var a = m.attachments || [];
    for (i = 0; i < a.length; i++) { u = a[i].url || a[i].proxy_url; if (u) return u; }
    return null;
  }
  function sig(m) { var u = imgOf(m); return u ? u.split("?")[0] : null; }

  async function ask(path, m) {
    var body = JSON.parse(JSON.stringify({
      k: st.key, id: m.id, content: m.content || "",
      embeds: m.embeds || [], attachments: m.attachments || []
    }));
    var res = await Promise.race([
      fetch("http://127.0.0.1:" + st.port + path, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
      }),
      sleep(15000).then(function () { throw new Error("timeout"); })
    ]);
    return await res.json();
  }

  function send(R, text) {
    var MA = M.findByProps("sendMessage", "receiveMessage");
    return MA.sendMessage(R.ch, { content: text, tts: false, invalidEmojis: [], validNonShortcutEmojis: [] });
  }

  // wait for the game's next Heist Map message (new or edited) in this channel
  function nextMap(R, ms) {
    return new Promise(function (resolve) {
      var done = false, t;
      function fin(v) {
        if (done) return; done = true; clearTimeout(t);
        Flux.unsubscribe("MESSAGE_CREATE", h); Flux.unsubscribe("MESSAGE_UPDATE", h);
        R.wake = null; resolve(v);
      }
      function h(e) {
        var m = e && e.message;
        if (!m || m.channel_id !== R.ch) return;
        if (m.author ? m.author.id !== R.bot : m.id !== R.mapId) return;
        var s = sig(m);
        if (!s || s === R.last) return;
        fin(m);
      }
      t = setTimeout(function () { fin(null); }, ms);
      R.wake = function () { fin(null); };
      Flux.subscribe("MESSAGE_CREATE", h); Flux.subscribe("MESSAGE_UPDATE", h);
    });
  }

  function stop(R, msg) {
    R.on = false;
    if (R.wake) R.wake();
    if (S === R) S = null;
    if (msg) toast(msg);
  }

  // ---------- the automatic loop: scout -> safe -> flee, holds still while a guard is on the map ----------
  async function run(R, cur) {
    var misses = 0, idle = 0, guardShown = false;
    while (R.on) {
      R.mapId = cur.id; R.last = sig(cur);
      if (R.phase === "scout" && Date.now() - R.t0 > num(st.maxScout, 240) * 1000) {
        R.phase = "flee"; toast("Time is up - fleeing");
      }
      var r;
      try { r = await ask(R.phase === "flee" ? "/flee" : "/scout", cur); }
      catch (e) { stop(R, "Bot not reachable - is flee5.py running?"); return; }
      if (!R.on) return;

      var note = String(r.answer || "");
      var steps = String(r.steps || "").toLowerCase().replace(/[^wasd]/g, "");
      var guard = /guard seen/i.test(note);

      if (guard) {                                   // never move in guard range: send nothing, wait for the next map
        if (!guardShown) { toast("Guard on map - holding still"); guardShown = true; }
      } else if (R.phase === "scout" && !steps && /at the safe/i.test(note)) {
        toast("At the safe - waiting for locksmith");
        if (st.safeText) await send(R, st.safeText);
        var w = num(st.safeWait, 20);
        for (var i = 0; i < w && R.on; i++) await sleep(1000);
        if (!R.on) return;
        R.phase = "flee";
        continue;                                    // plan the way out from the same map
      } else if (steps) {
        guardShown = false; misses = 0;
        await send(R, steps);                        // the only thing ever sent: the wasd moves
      } else if (R.phase === "flee") {
        stop(R, note || "Flee finished"); return;
      } else {
        if (++misses > 3) { stop(R, note || "Nothing left to scout"); return; }
        toast(note);                                 // e.g. locksmith needed / waiting for dynamite
      }

      var nxt = await nextMap(R, num(st.mapTimeout, 30) * 1000);
      if (!R.on) return;
      if (nxt) { cur = nxt; idle = 0; }
      else if (++idle > 3) { stop(R, "No new map - stopped"); return; }
    }
  }

  function start(m) {
    if (S) { stop(S, "Auto-scout stopped"); return; }
    S = { on: true, ch: m.channelId || m.channel_id, bot: m.author && m.author.id,
          phase: "scout", t0: Date.now(), last: null, mapId: m.id, wake: null };
    toast("Auto-scout started");
    run(S, m);
  }

  // ---------- long-press button on the Heist Map ----------
  var Forms = vendetta.ui.components.Forms;
  function makeRow(label, onPress) {
    var AS = M.findByProps("ActionSheetRow");
    var Row = (AS && AS.ActionSheetRow) || null;
    var icon;
    try { if (Row && Row.Icon) icon = React.createElement(Row.Icon, { source: vendetta.ui.assets.getAssetIDByName("ic_search") }); } catch (e) {}
    if (Row) return React.createElement(Row, { label: label, icon: icon, onPress: onPress });
    return React.createElement(Forms.FormRow, { label: label, onPress: onPress });
  }

  var Lazy = M.findByProps("openLazy", "hideActionSheet");
  undo.push(vendetta.patcher.before("openLazy", Lazy, function (args) {
    var component = args[0], key = args[1], ctx = args[2];
    var message = ctx && ctx.message;
    if (key !== "MessageLongPressActionSheet" || !message || !imgOf(message)) return;
    component.then(function (inst) {
      var un = vendetta.patcher.after("default", inst, function (_, comp) {
        React.useEffect(function () { return function () { un(); }; }, []);
        var arr = vendetta.utils.findInReactTree(comp, function (x) {
          return Array.isArray(x) && x.length > 1 && x.some(function (c) { return c && c.props && typeof c.props.label === "string"; });
        });
        if (!arr) return;
        arr.splice(1, 0, makeRow(S ? "Stop auto-scout" : "Auto-scout heist", function () {
          try { Lazy.hideActionSheet(); } catch (e) {}
          start(message);
        }));
      });
    }).catch(function () {});
  }));

  // fallback if the long-press menu changes: /autoscout uses the newest map in the channel
  try {
    var MS = M.findByStoreName("MessageStore");
    undo.push(vendetta.commands.registerCommand({
      name: "autoscout", displayName: "autoscout", description: "Start / stop the heist auto-scout",
      displayDescription: "Start / stop the heist auto-scout", options: [], applicationId: "-1", inputType: 1, type: 1,
      execute: function (args, ctx) {
        if (S) { stop(S, "Auto-scout stopped"); return; }
        var col = MS.getMessages(ctx.channel.id);
        var arr = col._array || (col.toArray && col.toArray()) || [];
        for (var i = arr.length - 1; i >= 0; i--) {
          if (arr[i].author && arr[i].author.bot && imgOf(arr[i])) { start(arr[i]); return; }
        }
        toast("No heist map found in this channel");
      }
    }));
  } catch (e) {}

  // ---------- settings ----------
  function Settings() {
    vendetta.storage.useProxy(st);
    var RN = C.ReactNative;
    function f(title, key) {
      return React.createElement(Forms.FormInput, {
        title: title, value: String(st[key]), placeholder: DEF[key],
        onChange: function (v) { st[key] = v; }
      });
    }
    return React.createElement(RN.ScrollView, null,
      React.createElement(Forms.FormSection, { title: "Heist Auto Scout", titleStyleType: "no_border" },
        f("Bot port (flee5.py LOCAL_PORT)", "port"),
        f("Bot key (flee5.py LOCAL_KEY)", "key"),
        f("Max scouting time, seconds (then flee)", "maxScout"),
        f("Wait at safe, seconds (locksmith + puzzle)", "safeWait"),
        f("Text to send at the safe (empty = nothing)", "safeText"),
        f("Wait for next map, seconds", "mapTimeout")));
  }

  return {
    onLoad: function () {},
    onUnload: function () {
      if (S) stop(S);
      undo.forEach(function (u) { try { u(); } catch (e) {} });
    },
    settings: Settings
  };
})()
