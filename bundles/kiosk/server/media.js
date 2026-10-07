/**
 * The media session: one per display, held on the server so a page reload or a reconnect restores
 * it. Current item, a queue of resolved items, play state, volume. The page plays the audio; this
 * module tells it what to do (media messages) and hears back (media_event). The page is never
 * given an upstream URL: each item gets a display ticket, revoked when the item is replaced or the
 * session ends. Nothing is written to disk and no listening history is kept.
 *
 * A live radio stream that drops after it has played is reloaded (a new ticket, the same station)
 * up to RADIO_RETRIES times with a growing wait before anything is said; a stream that then plays
 * steadily for RADIO_STEADY_MS has its count set back, so an evening of listening survives hiccups.
 */
/**
 * Operator ruling (rev 8b): 0–100 is −50…0 dB on the page (media-view levelOf: 5 dB per 10; 0 = mute). One Louder/Quieter
 * moves VOLUME_MOVE (20 = 10 dB, clearly heard); Quieter stops at VOLUME_FLOOR (10 = −45 dB, still heard) — only an
 * explicit zero or "mute" silences. A spoken level ("volume 50") is that point on the scale (≈ −25 dB). The default is
 * one Louder below full (80 = −10 dB). Levels are stored in steps of VOLUME_STEP.
 */
export const DEFAULT_VOLUME = 80;
export const VOLUME_STEP = 10;
export const VOLUME_MOVE = 20;
export const VOLUME_FLOOR = 10;
/** The scale this build's volume caps are on: −50…0 dB, 5 dB per 10 (the same curve rev 7 marked "db5"). */
export const VOLUME_SCALE = "db5";
/**
 * The operator ruling (rev 7b, M2), re-derived for rev 8b: a stored "Loudest volume" cap moves to the loudest level on
 * this scale that is NOT louder than it was. Unmarked caps were a LINEAR gain (50 = −6 dB → 80 = −10 dB); caps marked
 * "db10" (rev 8, 10 dB per 10: 90 = −10 dB → 80). A cap already on "db5", absent, or not a number → undefined. Below the
 * scale (a db10 cap of 50 or less, scratch only) → 10, the lowest cap the panel stores.
 */
export function migrateMaxVolume(v, scale) {
  const n = Number(v);
  if (v == null || !Number.isFinite(n) || n <= 0 || scale === VOLUME_SCALE) return undefined;
  const db = scale === "db10" ? Math.min(100, n) - 100 : 20 * Math.log10(Math.min(100, n) / 100);
  return Math.min(100, Math.max(10, Math.floor((100 + 2 * db) / 10 + 1e-9) * 10));
}
export const MAX_QUEUE = 50;
export const TITLE_MAX = 80;
export const SESSION_GRACE_MS = 30_000;
export const AUDIO_TICKET_MS = 12 * 60 * 60 * 1000;
export const RADIO_RETRIES = 3;
export const RADIO_BACKOFF_MS = Object.freeze([1000, 3000, 9000]);
export const RADIO_STEADY_MS = 60_000;
export const TOUCH_VERBS = Object.freeze(["pause", "resume", "stop", "next", "previous", "volume_up", "volume_down", "mute", "unmute"]);
const EVENT_STATES = new Set(["playing", "paused", "blocked", "ended", "error"]);

/**
 * A title as it may be spoken, shown and put on the turn's [Display] line: one line, at most
 * TITLE_MAX characters, no control characters, and no square brackets (the turn's context lines
 * are bracketed; a title must not be able to look like one). It is third-party text.
 */
export function cleanTitle(v) {
  let out = "";
  for (const ch of String(v ?? "").slice(0, 400)) {
    const c = ch.codePointAt(0);
    out += c < 32 || (c >= 127 && c < 160) || ch === "[" || ch === "]" || c === 0x2028 || c === 0x2029 ? " " : ch;
  }
  return out.split(" ").filter(Boolean).join(" ").slice(0, TITLE_MAX).trim();
}

/**
 * send(deviceId, msg) → delivered?; onFailed(deviceId, { title, started }): a stream that could not
 * be played, after every retry (one spoken line); onEnded(deviceId): the session is over, whatever
 * ended it (the now-playing window goes with it); onStarted(deviceId): an explicit play has just been
 * loaded (a new queue; not a queue step or a station reload) — the now-playing window may open (F8).
 */
export function createMediaStore({ now = Date.now, tickets, send, onFailed = () => {}, onEnded = () => {}, onStarted = () => {}, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const devs = new Map();
  const dev = (id) => { let d = devs.get(id); if (!d) { d = { queue: [], index: -1, item: null, state: "idle", volume: DEFAULT_VOLUME, muted: false, seq: 0, lost: null, origin: null, retries: 0, retry: null }; devs.set(id, d); } return d; };
  const live = (id) => { const d = devs.get(id); return d && d.item ? d : null; };
  /** One Quieter from v: VOLUME_MOVE down, never below VOLUME_FLOOR (a level already at or under it stays). */
  const quieter = (v) => { const cur = Number(v) || 0; return cur <= VOLUME_FLOOR ? cur : Math.max(VOLUME_FLOOR, cur - VOLUME_MOVE); };
  const step = (v, max = 100) => Math.max(0, Math.min(Math.min(100, Math.max(VOLUME_STEP, max)), Math.round(v / VOLUME_STEP) * VOLUME_STEP));
  const loadMsg = (d, extra = {}) => ({ type: "media", action: "load", id: d.item.id, form: "audio", url: d.item.path, title: d.item.title, subtitle: d.item.subtitle, source: d.item.source, volume: d.volume, muted: d.muted, ...extra });
  const isRadio = (d) => d.item.source === "radio";
  function unload(d) {
    if (d.retry) { clearTimer(d.retry); d.retry = null; }
    if (d.item) { tickets.revoke(d.item.ticket); d.item = null; }
  }
  function end(id, d) {
    const had = !!d.item;
    unload(d);
    d.queue = []; d.index = -1; d.state = "idle"; d.origin = null; d.retries = 0;
    send(id, { type: "media", action: "stop" });
    if (had) { try { onEnded(id); } catch { /* a hook must not break the session */ } }
  }
  function load(id, d, i, { again = false, paused = false } = {}) {
    const started = again && d.item ? d.item.started : false;
    unload(d);
    if (!again) d.retries = 0;
    const p = d.queue[i];
    d.index = i;
    const t = tickets.mint({ deviceId: id, kind: "stream", resource: p.upstream, ttlMs: AUDIO_TICKET_MS });
    d.item = { id: `m${++d.seq}`, ticket: t.id, path: t.path, title: cleanTitle(p.title), subtitle: cleanTitle(p.subtitle), source: cleanTitle(p.source).slice(0, 16), started, blocked: false, playingSince: null };
    d.state = paused ? "paused" : "loading";
    send(id, loadMsg(d, paused ? { paused: true } : {}));
    return d.item;
  }
  function fail(id, d) {
    const item = d.item;
    end(id, d);
    try { onFailed(id, { title: item.title, started: item.started }); } catch { /* see onEnded */ }
  }
  /** A station that dropped after it had played: wait, then load it again. Past the last retry it is a failure. */
  function retryRadio(id, d) {
    if (d.item.playingSince != null && now() - d.item.playingSince >= RADIO_STEADY_MS) d.retries = 0;
    if (d.retries >= RADIO_RETRIES) { fail(id, d); return; }
    const wait = RADIO_BACKOFF_MS[d.retries];
    d.retries += 1;
    tickets.revoke(d.item.ticket);                 // the dead stream's ticket goes now; the item stays so the session is still "this station"
    d.item.playingSince = null;
    d.retry = setTimer(() => {
      d.retry = null;
      if (live(id) !== d) return;
      if (d.state === "paused") return;            // paused meanwhile: resume() loads a live stream anyway
      load(id, d, d.index, { again: true });
    }, wait);
    d.retry?.unref?.();
  }
  const api = {
    /**
     * An explicit request to play: replace the queue and start its first item. origin = { source, candidateId }
     * (what was asked for, so asking again can be told apart from asking for something else).
     * Sound comes back: mute is cleared and a volume of zero returns to the default.
     */
    play(id, playables, { maxVolume = 100, origin = null } = {}) {
      const d = dev(id);
      const queue = (Array.isArray(playables) ? playables : []).filter((p) => p && p.upstream).slice(0, MAX_QUEUE);
      if (!queue.length) { if (d.item) end(id, d); return null; }
      d.queue = queue;
      d.origin = origin && origin.source != null && origin.candidateId != null ? { source: String(origin.source), candidateId: String(origin.candidateId) } : null;
      d.muted = false;
      d.volume = step(d.volume === 0 ? DEFAULT_VOLUME : d.volume, maxVolume);
      const item = load(id, d, 0);
      // F8: an explicit play has started (after the page was told to load it). The hook must not break the session.
      try { onStarted(id); } catch { /* see onEnded */ }
      return item;
    },
    active: (id) => !!live(id),
    /** r7 G9 evidence: the session's state as one fixed word ("none" | "loading" | "playing" | "paused" | "blocked"). */
    stateOf: (id) => { const d = live(id); return !d ? "none" : d.item.blocked ? "blocked" : d.state === "paused" ? "paused" : d.state === "loading" ? "loading" : "playing"; },
    current: (id) => { const d = live(id); return d ? { title: d.item.title, subtitle: d.item.subtitle, source: d.item.source, state: d.state === "paused" ? "paused" : "playing", volume: d.volume, muted: d.muted } : null; },
    /** Is this exactly what was asked for last time, and is it still going? */
    isCurrent: (id, origin) => { const d = live(id); return !!d && !!d.origin && !!origin && d.origin.source === String(origin.source) && d.origin.candidateId === String(origin.candidateId); },
    queueLength: (id) => devs.get(id)?.queue.length || 0,
    // r7 G9 / r7b M3: "already" sends the WHOLE current item again (the page applies a same-item load without restarting
    // it; a page that disagrees — ▶ while the server thought it played, the reverse, another item, or none — is put right).
    pause(id) { const d = live(id); if (!d) return null; if (d.state === "paused") { send(id, loadMsg(d, { paused: true })); return "already"; } d.state = "paused"; send(id, { type: "media", action: "pause", id: d.item.id }); return "paused"; },
    resume(id) {
      const d = live(id);
      if (!d) return null;
      if (d.state !== "paused") { send(id, loadMsg(d)); return "already"; }
      // A station is live: resuming means now, not where the buffer stopped. (An autoplay that was only blocked just starts.)
      if (isRadio(d) && !d.item.blocked) { load(id, d, d.index, { again: true }); return "playing"; }
      d.state = "playing"; d.item.blocked = false;
      send(id, { type: "media", action: "play", id: d.item.id });
      return "playing";
    },
    stop(id) { const d = live(id); if (!d) return null; end(id, d); return "stopped"; },
    next(id) { const d = live(id); if (!d) return null; if (d.index + 1 >= d.queue.length) return "end"; load(id, d, d.index + 1); return "playing"; },
    previous(id) { const d = live(id); if (!d) return null; if (d.index < 1) return "end"; load(id, d, d.index - 1); return "playing"; },
    /** The level one Quieter gives from the current one (play.js uses the same rule). */
    quieterLevel: (id) => quieter(live(id)?.volume),
    /** → the new volume, or null with no session. Changing the level un-mutes. */
    volume(id, { delta, set }, maxVolume = 100) {
      const d = live(id); if (!d) return null;
      d.volume = step(Number.isFinite(set) ? set : d.volume + (Number.isFinite(delta) ? delta : 0), maxVolume);
      d.muted = false;
      send(id, { type: "media", action: "volume", volume: d.volume, muted: false });
      return d.volume;
    },
    /** → "muted" | "unmuted" | "already" | null. */
    mute(id, on) {
      const d = live(id); if (!d) return null;
      if (d.muted === (on === true)) return "already";
      d.muted = on === true;
      send(id, { type: "media", action: "volume", volume: d.volume, muted: d.muted });
      return d.muted ? "muted" : "unmuted";
    },
    /** "Playing: Morning Mix (radio)." for the turn context; "" with no session. */
    describe(id) { const d = live(id); return d ? `${d.state === "paused" ? "Paused" : "Playing"}: ${d.item.title}${d.item.source ? ` (${d.item.source})` : ""}.` : ""; },
    /** What a page that has just said hello needs to be in step: the current item, or null (the caller then sends a stop). */
    snapshot(id) { const d = live(id); return d ? loadMsg(d, { paused: d.state === "paused" }) : null; },
    /** media_event from the page. Only the current item's events count. */
    onEvent(id, ev) {
      const d = live(id);
      if (!d || !ev || ev.id !== d.item.id || !EVENT_STATES.has(ev.state)) return;
      if (d.retry) return;                                        // already waiting to reload this station
      if (ev.state === "playing") { d.state = "playing"; d.item.started = true; d.item.blocked = false; d.item.playingSince ??= now(); return; }
      if (ev.state === "paused") { d.state = "paused"; return; }  // paused on the device itself
      if (ev.state === "blocked") { d.state = "paused"; d.item.blocked = true; return; }   // the browser wants a tap first: not a failure
      if (isRadio(d) && d.item.started) { retryRadio(id, d); return; }   // ended or error: a live stream does not end
      if (ev.state === "ended" && !isRadio(d)) { if (d.index + 1 < d.queue.length) load(id, d, d.index + 1); else end(id, d); return; }
      // An error (or a station that ended before it ever played): the next queued item is tried; with none, one spoken line.
      if (d.index + 1 < d.queue.length) { load(id, d, d.index + 1); return; }
      fail(id, d);
    },
    /** media_cmd from a touch control: the same verbs as voice, nothing else. */
    command(id, msg, device) {
      const verb = msg && typeof msg.do === "string" ? msg.do : "";
      if (!TOUCH_VERBS.includes(verb)) return;
      const max = Number(device?.kiosk_settings?.max_volume) || 100;
      if (verb === "volume_up") api.volume(id, { delta: VOLUME_MOVE }, max);
      else if (verb === "volume_down") api.volume(id, { set: quieter(live(id)?.volume) }, max);
      else if (verb === "mute") api.mute(id, true);
      else if (verb === "unmute") api.mute(id, false);
      else api[verb](id);
    },
    /** The page went away: the session lasts SESSION_GRACE_MS without it (a phone's network blip reconnects well inside it). */
    sessionLost(id) { const d = live(id); if (!d) return; clearTimer(d.lost); d.lost = setTimer(() => { d.lost = null; const cur = live(id); if (cur) end(id, cur); }, SESSION_GRACE_MS); d.lost?.unref?.(); },
    sessionBack(id) { const d = devs.get(id); if (d?.lost) { clearTimer(d.lost); d.lost = null; } },
    /** Unpair, or a dashboard session display that is gone for good: everything of this display ends. */
    closeDevice(id) { const d = devs.get(id); if (d) { clearTimer(d.lost); d.lost = null; if (d.item) end(id, d); devs.delete(id); } tickets.revokeDevice(id); },
  };
  return api;
}
