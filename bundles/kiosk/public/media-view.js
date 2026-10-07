/**
 * The display's one <audio> element. The server holds the session (media.js) and says what to do (`media`); the page
 * reports what the element did (`media_event`). textContent only; URLs are same-origin ticket paths. Rules:
 *  - play() rejecting with AbortError, for an old item, or after the element plays anyway is no failure; NotAllowedError
 *    is a blocked autoplay (chip ▶, a tap starts it). Failures: the `error` event, or no `playing` START_MS after
 *    asking, or `waiting`/`stalled` for STALL_MS (one `error` "stalled").
 *  - The same item again never reassigns src; it applies paused/playing (r7b M3). A pause the page or server asked
 *    for, one during a src change, or a stale one is never the user's.
 *  - An unsent report is kept (latest per item) and flushed after `ready`; a snapshot naming a failed item gets the
 *    failure again.
 */
export const DUCK_FACTOR = 0.15;
export const RESTORE_DELAY_MS = 400;
export const RESTORE_MS = 300;
export const RESTORE_STEP_MS = 30;
export const START_MS = 10_000;
export const STALL_MS = 15_000;
/** F9: offline the chip dims; after this the element stops (≥ server grace + 2 pings). */
export const OFFLINE_CLEAR_MS = 60_000;

/** r7 G7: 0–100 → element gain, 5 dB per 10 (linear steps were inaudible); 0 or muted is silence. */
export const levelOf = (v, muted) => (muted || !(v > 0) ? 0 : Math.min(1, 10 ** ((Math.min(100, v) - 100) / 40)));
const level = levelOf;

/** Ducks to DUCK_FACTOR at once; restores RESTORE_DELAY_MS after release, over RESTORE_MS. */
export function createDucker(audio, { setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let target = 0.5, ducked = false, timer = null;
  const stop = () => { clearTimer(timer); timer = null; };
  function ramp() {
    const from = audio.volume, steps = Math.round(RESTORE_MS / RESTORE_STEP_MS);
    let i = 0;
    const tick = () => {
      i += 1;
      audio.volume = i >= steps ? target : from + ((target - from) * i) / steps;
      timer = i >= steps ? null : setTimer(tick, RESTORE_STEP_MS);
    };
    timer = setTimer(tick, RESTORE_STEP_MS);
  }
  return {
    duck(on) {
      if (on) { stop(); ducked = true; audio.volume = target * DUCK_FACTOR; return; }
      if (!ducked) return;
      ducked = false;
      stop();
      timer = setTimer(ramp, RESTORE_DELAY_MS);
    },
    setTarget(v) { target = Math.max(0, Math.min(1, v)); if (ducked) audio.volume = target * DUCK_FACTOR; else if (!timer) audio.volume = target; },
    ducked: () => ducked,
  };
}

/**
 * send(obj): a frame to the server. onState(id, state): every reported state (effect time).
 * onChange(): what is shown changed (the now-playing window redraws). t(key): page strings.
 */
export function createMediaView({ audio, chip, send, setTimer = setTimeout, clearTimer = clearTimeout, onState = () => {}, onChange = () => {}, onChipTap = () => {}, t = (k) => k }) {
  const ducker = createDucker(audio, { setTimer, clearTimer });
  let cur = null, quiet = false, held = false, startDog = null, stallDog = null, unsent = null, swapping = false, offline = false, offlineTimer = null;
  const clearDogs = () => { clearTimer(startDog); clearTimer(stallDog); startDog = stallDog = null; };
  function report(state, code) {
    if (!cur) return;
    const ev = { type: "media_event", id: cur.id, state, ...(code ? { code } : {}) };
    // A failure is never replaced by a later state of the same item: it is what the server must hear.
    if (send(ev) === false) { if (!(unsent && unsent.id === cur.id && unsent.state === "error")) unsent = ev; }
    else if (unsent && unsent.id === cur.id && state === "error") unsent = null;
    onState(cur.id, state);
  }
  function fail(code) { if (!cur || cur.failed) return; cur.failed = code; clearDogs(); report("error", code); }
  function render() {
    if (!cur) { chip.hidden = true; chip.textContent = ""; chip.removeAttribute?.("data-offline"); onChange(); return; }
    chip.hidden = false;
    chip.textContent = `${offline ? "…" : cur.paused || cur.blocked ? "▶" : "⏸"} ${cur.title}`;
    chip.setAttribute("aria-label", t(offline ? "media_offline" : cur.blocked ? "media_play" : "media_open"));
    if (offline) chip.setAttribute("data-offline", "1"); else chip.removeAttribute?.("data-offline");
    onChange();
  }
  /** Ask the element to play the current item. Only the element's own events decide what happened. */
  function start() {
    if (!cur) return;
    const id = cur.id;
    clearTimer(startDog);
    startDog = setTimer(() => { if (cur && cur.id === id && !cur.playing) fail("stalled"); }, START_MS);
    let p;
    try { p = audio.play(); } catch (err) { p = Promise.reject(err); }
    Promise.resolve(p).catch((err) => {
      if (!cur || cur.id !== id || err?.name === "AbortError") return;
      if (!audio.paused) return;
      if (err?.name === "NotAllowedError") { clearTimer(startDog); startDog = null; cur.blocked = true; report("blocked"); render(); }
    });
  }
  // The page's own pause: no longer playing (so the start watchdog can still judge a refused resume: review H2).
  function quietPause() { if (cur) cur.playing = false; if (!audio.paused) { quiet = true; audio.pause(); } }

  audio.addEventListener("playing", () => {
    if (!cur) return;
    clearDogs();
    cur.playing = true; cur.blocked = false; cur.paused = false;
    report("playing"); render();
  });
  audio.addEventListener("pause", () => {
    if (quiet) { quiet = false; return; }
    // F4: not the person's pause (see the header).
    if (swapping || !audio.paused) return;
    if (!cur || audio.ended || cur.paused) return;
    cur.paused = true; cur.playing = false; clearDogs();
    report("paused"); render();
  });
  audio.addEventListener("ended", () => { if (!cur) return; clearDogs(); cur.playing = false; report("ended"); });
  audio.addEventListener("error", () => fail("load_failed"));
  const stalled = () => {
    if (!cur || stallDog || cur.paused) return;
    const id = cur.id;
    stallDog = setTimer(() => { stallDog = null; if (cur && cur.id === id) fail("stalled"); }, STALL_MS);
  };
  audio.addEventListener("waiting", stalled);
  audio.addEventListener("stalled", stalled);

  chip.addEventListener("click", () => {
    if (!cur || offline) return;
    // A blocked autoplay needs a tap to start: this is it (the browser counts the tap).
    if (cur.blocked) { cur.blocked = false; start(); send({ type: "media_cmd", do: "resume" }); }
    // F8: otherwise the chip opens the now-playing window, where the controls are.
    onChipTap();
  });

  return {
    apply(m) {
      switch (m.action) {
        case "load": {
          ducker.setTarget(level(m.volume, m.muted));
          if (cur && cur.id === m.id && cur.url === m.url) {
            cur.volume = m.volume; cur.muted = !!m.muted;
            // The server still thinks this item plays: it never heard that it failed. Tell it again.
            if (cur.failed) { if (unsent && unsent.id === cur.id) unsent = null; report("error", cur.failed); render(); return; }
            if (m.paused && !cur.paused) { cur.paused = true; clearDogs(); quietPause(); }
            else if (!m.paused && (cur.paused || cur.blocked || !cur.playing)) { cur.paused = cur.blocked = false; if (!held) start(); }
            render();
            return;
          }
          clearDogs();
          quiet = false;
          cur = { id: m.id, url: m.url, title: String(m.title || ""), subtitle: String(m.subtitle || ""), source: String(m.source || ""), volume: m.volume, muted: !!m.muted, paused: !!m.paused, playing: false, blocked: false, failed: false };
          swapping = true;
          try { audio.src = m.url; } finally { swapping = false; }
          if (!cur.paused && !held) start();
          render();
          return;
        }
        case "play": if (cur && cur.id === m.id) { cur.paused = false; cur.blocked = false; if (!held) start(); render(); } return;
        case "pause": if (cur && cur.id === m.id) { cur.paused = true; cur.playing = false; clearDogs(); quietPause(); render(); } return;
        case "volume": if (cur) { cur.volume = m.volume; cur.muted = !!m.muted; } ducker.setTarget(level(m.volume, m.muted)); onChange(); return;
        case "stop":
          clearDogs();
          cur = null; held = false;
          quietPause(); quiet = false;
          audio.removeAttribute("src");
          try { audio.load(); } catch {}
          render();
          return;
        default:
      }
    },
    /**
     * The display is listening or answering. pauseMode (the display's pause_media_on_listen): pause
     * instead of turning down, and resume only what this paused.
     */
    hold(on, pauseMode = false) {
      if (!pauseMode) { if (held) { held = false; if (cur && !cur.paused) start(); } ducker.duck(on); return; }
      ducker.duck(false);
      if (on && !held) { held = true; if (cur && !cur.paused) quietPause(); }
      else if (!on && held) { held = false; if (cur && !cur.paused) start(); }
    },
    /** F9: the socket closed (true) or is back (false). */
    offline(on) {
      if (on === offline) return;
      offline = on === true;
      clearTimer(offlineTimer); offlineTimer = null;
      if (offline) offlineTimer = setTimer(() => { offlineTimer = null; if (offline && cur) { clearDogs(); cur = null; held = false; quietPause(); quiet = false; audio.removeAttribute("src"); try { audio.load(); } catch {} } render(); }, OFFLINE_CLEAR_MS);
      render();
    },
    /** After `ready`: send again what the socket could not carry, if it is still about the current item. */
    flush() { const ev = unsent; unsent = null; if (ev && cur && ev.id === cur.id && send(ev) === false) unsent = ev; },
    info: () => (cur ? { title: cur.title, subtitle: cur.subtitle, source: cur.source, paused: cur.paused || cur.blocked, muted: cur.muted, offline } : null),
    current: () => cur?.id || null,
    /** r7b M3: one fixed word for the turn's metrics. */
    state: () => (!cur ? "none" : offline ? "offline" : cur.blocked ? "blocked" : cur.paused ? "paused" : cur.playing ? "playing" : "loading"),
    ducked: () => ducker.ducked(),
  };
}
