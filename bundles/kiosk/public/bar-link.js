/**
 * Kiosk B3: the page's media goes to the dashboard's player bar. Loaded (dynamic import) only on a session display
 * opened with ?bar=1 inside the dashboard, so a Pi never downloads it.
 *
 * createBarLink() is shaped like the <audio> element media-view drives (src, play() → Promise, pause(), paused,
 * ended, volume, removeAttribute("src"), load(), addEventListener), so ducking, holds and the watchdogs work
 * unchanged. Each call becomes a { crow: "media", v: 1, op, … } message to the parent, which validates it; the
 * parent's element events come back as { crow: "media-event", v: 1, id, type } and are dispatched here. Only
 * messages from the parent window and this origin count (S1), and only about the current item.
 * describe(m) must be called with the server's load message before media-view sets src (it carries the title etc.).
 */
const EVENTS = new Set(["playing", "pause", "ended", "error", "waiting", "stalled"]);
const COMMANDS = new Set(["next", "previous", "stop", "pause", "resume"]);
const abortError = () => { const e = new Error("aborted"); e.name = "AbortError"; return e; };

export function createBarLink({ parent, origin, onCommand = () => {} }) {
  const ls = new Map();
  let described = null, id = null, url = "", vol = 1, pending = [];
  const post = (o) => { try { parent.postMessage({ crow: "media", v: 1, ...o }, origin); } catch { /* the parent is gone */ } };
  const fire = (type) => { for (const fn of ls.get(type) || []) fn({ type }); };
  const settle = (err) => { const p = pending; pending = []; for (const x of p) (err ? x.reject(err) : x.resolve()); };
  const link = {
    paused: true,
    ended: false,
    describe(m) { described = m || null; },
    get src() { return url; },
    set src(v) {
      settle(abortError());
      const d = described;
      url = String(v);
      link.paused = true; link.ended = false;
      if (!d || d.url !== url) { id = null; return; }
      id = d.id;
      post({ op: "load", id, url, title: String(d.title || ""), subtitle: String(d.subtitle || ""), source: String(d.source || ""), live: d.live === true, volume: vol, paused: d.paused === true, has_next: d.has_next === true, has_previous: d.has_previous === true });
    },
    get volume() { return vol; },
    set volume(v) { vol = Math.max(0, Math.min(1, Number(v) || 0)); if (id) post({ op: "volume", id, volume: vol }); },
    play() {
      if (!id) return Promise.reject(abortError());
      return new Promise((resolve, reject) => { pending.push({ resolve, reject }); post({ op: "play", id }); });
    },
    pause() { settle(abortError()); link.paused = true; if (id) post({ op: "pause", id }); },
    removeAttribute(k) {
      if (k !== "src") return;
      settle(abortError());
      if (id) post({ op: "stop", id });
      id = null; url = ""; link.paused = true;
    },
    load() {},
    addEventListener(type, fn) { if (!ls.has(type)) ls.set(type, []); ls.get(type).push(fn); },
    /** window "message" listener. */
    onMessage(e) {
      if (!e || e.source !== parent || e.origin !== origin) return;
      const d = e.data;
      if (!d || typeof d !== "object" || d.crow !== "media-event" || d.v !== 1 || !id || d.id !== id) return;
      if (d.type === "play-result") {
        if (d.ok === true) settle(null);
        else { const err = new Error("play refused"); err.name = typeof d.name === "string" ? d.name.slice(0, 40) : "Error"; settle(err); }
        return;
      }
      if (d.type === "cmd") { if (COMMANDS.has(d.do)) onCommand(d.do); return; }
      if (!EVENTS.has(d.type)) return;
      if (d.type === "playing") { link.paused = false; link.ended = false; settle(null); }
      else if (d.type === "pause") link.paused = true;
      else if (d.type === "ended") { link.paused = true; link.ended = true; }
      fire(d.type);
    },
  };
  return link;
}
