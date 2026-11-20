(function () {
  const { metro, patcher, ui, plugin, utils } = vendetta;
  const { findByProps, findByStoreName } = metro;
  const { React, ReactNative: RN, FluxDispatcher } = metro.common;
  const { showToast } = ui.toasts;
  const { Forms } = ui.components;
  const storage = plugin.storage;

  const DEF = { port: 8787, key: "qd", max: 5, delay: 1200 };
  for (const k in DEF) if (storage[k] === undefined) storage[k] = DEF[k];

  const LazyActionSheet = findByProps("openLazy", "hideActionSheet");
  const MessageActions = findByProps("sendMessage", "receiveMessage");
  const UserStore = findByStoreName("UserStore");
  const MessageStore = findByStoreName("MessageStore");

  // ---------------- state ----------------
  const S = { on: false, busy: false, ch: null, me: null, sent: 0, last: "", note: "idle", deadline: 0, warned: {}, seen: "", ticker: null };
  const subs = new Set();
  const emit = () => subs.forEach((f) => { try { f(); } catch (e) {} });
  const toast = (t) => { try { showToast(String(t).slice(0, 90)); } catch (e) {} };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------------- helpers ----------------
  const hasImage = (m) =>
    (m.embeds || []).some((e) => e.image || e.thumbnail) || (m.attachments || []).some((a) => a.url || a.proxy_url);

  function textOf(m) {
    const o = [m.content || ""];
    for (const e of m.embeds || []) {
      o.push(e.rawTitle || e.title || "", e.rawDescription || e.description || "", (e.author && e.author.name) || "", (e.footer && e.footer.text) || "");
      for (const f of e.fields || []) o.push(f.rawName || f.name || "", f.rawValue || f.value || "");
    }
    return o.join("\n");
  }

  // time left: <t:unix>, embed.timestamp, or "time left 3:45 / 2m 10s" style text
  function parseDeadline(m, t) {
    const now = Date.now();
    let best = 0;
    for (const x of t.matchAll(/<t:(\d{9,11})(?::[a-zA-Z])?>/g)) {
      const ms = +x[1] * 1000;
      if (ms > now && (!best || ms < best)) best = ms;
    }
    if (best) return best;
    for (const e of m.embeds || []) {
      const ms = e.timestamp ? Date.parse(e.timestamp) : 0;
      if (ms > now) return ms;
    }
    for (const line of t.split("\n")) {
      if (!/time|left|remain|ends?|expire|countdown/i.test(line)) continue;
      let s = 0, r;
      if ((r = line.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/))) {
        s = r[3] ? +r[1] * 3600 + +r[2] * 60 + +r[3] : +r[1] * 60 + +r[2];
      } else {
        if ((r = line.match(/(\d+)\s*h/i))) s += +r[1] * 3600;
        if ((r = line.match(/(\d+)\s*m/i))) s += +r[1] * 60;
        if ((r = line.match(/(\d+)\s*s/i))) s += +r[1];
      }
      if (s > 0) return now + s * 1000;
    }
    return 0;
  }

  const slimImg = (p) => (p ? { url: p.url, proxyURL: p.proxyURL || p.proxy_url } : undefined);
  const slim = (e) => ({
    rawTitle: e.rawTitle, rawDescription: e.rawDescription, title: e.title, description: e.description,
    author: e.author ? { name: e.author.name } : undefined,
    footer: e.footer ? { text: e.footer.text } : undefined,
    fields: (e.fields || []).map((f) => ({ rawName: f.rawName, rawValue: f.rawValue, name: f.name, value: f.value })),
    image: slimImg(e.image), thumbnail: slimImg(e.thumbnail),
  });

  async function ask(m) {
    const r = await fetch("http://127.0.0.1:" + storage.port + "/scout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        k: storage.key, n: Math.max(1, Math.min(5, +storage.max || 5)), id: m.id, content: m.content || "",
        embeds: (m.embeds || []).map(slim),
        attachments: (m.attachments || []).map((a) => ({ url: a.url, proxy_url: a.proxy_url, content_type: a.content_type || a.contentType })),
      }),
    });
    return r.json();
  }

  function send(text) {
    MessageActions.sendMessage(S.ch, { content: text, tts: false, invalidEmojis: [], validNonShortcutEmojis: [] });
  }

  // ---------------- scouting loop ----------------
  async function handleMap(m) {
    if (!S.on || S.busy) return;
    const t = textOf(m);
    const key = m.id + "|" + t.length + "|" + ((m.embeds && m.embeds[0] && m.embeds[0].image && m.embeds[0].image.url) || "");
    if (key === S.seen) return;
    S.seen = key;
    S.busy = true;
    try {
      const dl = parseDeadline(m, t);
      if (dl) S.deadline = dl;
      S.note = "planning...";
      emit();
      const r = await ask(m);
      const steps = String(r.steps || "").toLowerCase().replace(/[^wasd]/g, "").slice(0, Math.max(1, Math.min(5, +storage.max || 5)));
      if (steps) {
        await sleep((+storage.delay || 1200) + Math.random() * 500);
        if (!S.on) return;
        send(steps);
        S.sent++;
        S.last = steps;
        S.note = "sent " + steps;
      } else {
        S.note = r.answer || "no moves";
        toast(S.note);
        if (r.done) stop("scout finished");
      }
    } catch (e) {
      stop("bot offline? run: python flee5.py");
    } finally {
      S.busy = false;
      emit();
    }
  }

  function onMsg(ev, updated) {
    if (!S.on) return;
    let m = ev && ev.message;
    if (!m || (ev.channelId || m.channel_id) !== S.ch) return;
    const go = (mm) => {
      if (!mm || (mm.author && mm.author.id === S.me)) return;
      if (hasImage(mm) && /heist map/i.test(textOf(mm))) handleMap(mm);
    };
    if (updated) setTimeout(() => go((MessageStore && MessageStore.getMessage(S.ch, m.id)) || m), 80);
    else go(m);
  }
  const onCreate = (ev) => onMsg(ev, false);
  const onUpdate = (ev) => onMsg(ev, true);

  function tick() {
    if (!S.on) return;
    if (S.deadline) {
      const left = Math.round((S.deadline - Date.now()) / 1000);
      for (const w of [60, 30, 10]) {
        if (left <= w && left > 0 && !S.warned[w]) { S.warned[w] = 1; toast("Scout: " + w + "s left"); }
      }
      if (left <= -3) return stop("time is up");
    }
    emit();
  }

  async function start(message) {
    if (!message || !hasImage(message)) return toast("Hold the Heist Map message");
    try {
      const p = await fetch("http://127.0.0.1:" + storage.port + "/ping");
      if (!(await p.json()).ok) throw 0;
    } catch (e) {
      return toast("Bot not running: python flee5.py");
    }
    const me = UserStore.getCurrentUser();
    Object.assign(S, { on: true, busy: false, ch: message.channel_id, me: me && me.id, sent: 0, last: "", note: "starting", deadline: 0, warned: {}, seen: "" });
    clearInterval(S.ticker);
    S.ticker = setInterval(tick, 1000);
    toast("Scout started");
    handleMap(message);
  }

  function stop(why) {
    S.on = false;
    S.note = why || "stopped";
    clearInterval(S.ticker);
    toast("Scout: " + S.note);
    emit();
  }

  // ---------------- hold a message -> Scout button ----------------
  const unpatches = [];
  unpatches.push(
    patcher.before("openLazy", LazyActionSheet, ([component, key, msg]) => {
      const message = msg && msg.message;
      if (key !== "MessageLongPressActionSheet" || !message) return;
      component.then((instance) => {
        const un = patcher.after("default", instance, (_, comp) => {
          React.useEffect(() => () => { un(); }, []);
          const buttons = utils.findInReactTree(comp, (x) => x && x[0] && x[0].type && x[0].type.name === "ButtonRow");
          if (!buttons || !buttons[0]) return comp;
          if (!S.on && !hasImage(message)) return comp;
          const Row = buttons[0].type;
          buttons.splice(0, 0, React.createElement(Row, {
            key: "scout-auto",
            label: S.on ? "Stop Scout" : "Scout (auto)",
            icon: buttons[0].props && buttons[0].props.icon,
            onPress: () => { LazyActionSheet.hideActionSheet(); S.on ? stop("stopped") : start(message); },
          }));
        });
      });
    })
  );
  FluxDispatcher.subscribe("MESSAGE_CREATE", onCreate);
  FluxDispatcher.subscribe("MESSAGE_UPDATE", onUpdate);

  // ---------------- settings page (live status + time left) ----------------
  const fmt = (s) => (s < 0 ? "0:00" : Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"));
  function Settings() {
    const [, force] = React.useState(0);
    React.useEffect(() => {
      const f = () => force((x) => x + 1);
      subs.add(f);
      return () => subs.delete(f);
    }, []);
    const { FormSection, FormRow, FormInput } = Forms;
    const left = S.deadline ? fmt(Math.round((S.deadline - Date.now()) / 1000)) : "-";
    const input = (title, k) =>
      React.createElement(FormInput, { title, value: String(storage[k]), onChange: (v) => { storage[k] = k === "key" ? v : +v || DEF[k]; } });
    return React.createElement(RN.ScrollView, null,
      React.createElement(FormSection, { title: "Status" },
        React.createElement(FormRow, { label: S.on ? "RUNNING" : "stopped", subLabel: S.note }),
        React.createElement(FormRow, { label: "Time left", subLabel: left }),
        React.createElement(FormRow, { label: "Moves sent", subLabel: S.sent + (S.last ? "   (last: " + S.last + ")" : "") }),
        S.on ? React.createElement(FormRow, { label: "Stop", onPress: () => stop("stopped") }) : null),
      React.createElement(FormSection, { title: "Settings" },
        input("Bot port", "port"), input("Secret key (same as LOCAL_KEY)", "key"),
        input("Max moves per message (1-5)", "max"), input("Delay before sending (ms)", "delay")));
  }

  return {
    onLoad() {},
    onUnload() {
      S.on = false;
      clearInterval(S.ticker);
      unpatches.forEach((u) => u());
      FluxDispatcher.unsubscribe("MESSAGE_CREATE", onCreate);
      FluxDispatcher.unsubscribe("MESSAGE_UPDATE", onUpdate);
    },
    settings: Settings,
  };
})()
