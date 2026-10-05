/**
 * The display's one <audio> element. The server holds the media session (media.js) and tells the
 * page what to do with `media` messages; the page reports what the element really did with
 * `media_event`. Text is set with textContent only; the URL is always a same-origin ticket path.
 *
 * Rules (review C1/H1/H7/H8):
 *  - A play() promise that rejects with AbortError (a skip, a pause or a new item while it was
 *    still buffering), or for an item that is no longer current, is not a failure. NotAllowedError
 *    is a blocked autoplay ("blocked": the chip shows ▶ and a tap starts it). A failed stream is
 *    reported only from the element's own `error` event, or by the watchdog.
 *  - The same item again (a reconnect's snapshot) never reassigns src: only volume and paused.
 *  - Watchdog: no `playing` within START_MS of asking to play, or `waiting`/`stalled` for STALL_MS,
 *    reports one `error` with code "stalled".
 *  - A pause the page or the server asked for is never reported back as the user's pause.
 *  - A report the socket could not carry (send() returned false: the network dropped) is kept, the
 *    latest per item, and sent again by flush() after the next `ready`. A failure is also sent again
 *    when the server's snapshot names the same item (it can only do that if it never heard of the
 *    failure), so a chip can never show "playing" over silence after a blip (re-review N3).
 */
export const DUCK_FACTOR = 0.15;
export const RESTORE_DELAY_MS = 400;
export const RESTORE_MS = 300;
export const RESTORE_STEP_MS = 30;
export const START_MS = 10_000;
export const STALL_MS = 15_000;

const level = (v, muted) => (muted ? 0 : Math.max(0, Math.min(1, (Number(v) || 0) / 100)));

/** Ducks to DUCK_FACTOR of the set level at once; restores RESTORE_DELAY_MS after release, over RESTORE_MS in RESTORE_STEP_MS steps. */
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
export function createMediaView({ audio, chip, send, setTimer = setTimeout, clearTimer = clearTimeout, onState = () => {}, onChange = () => {}, t = (k) => k }) {
  const ducker = createDucker(audio, { setTimer, clearTimer });
  let cur = null, quiet = false, held = false, startDog = null, stallDog = null, unsent = null;
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
    if (!cur) { chip.hidden = true; chip.textContent = ""; onChange(); return; }
    chip.hidden = false;
    chip.textContent = `${cur.paused || cur.blocked ? "▶" : "⏸"} ${cur.title}`;
    chip.setAttribute("aria-label", t(cur.paused || cur.blocked ? "media_play" : "media_pause"));
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
      if (err?.name === "NotAllowedError") { clearTimer(startDog); startDog = null; cur.blocked = true; report("blocked"); render(); }
    });
  }
  function quietPause() { if (!audio.paused) { quiet = true; audio.pause(); } }

  audio.addEventListener("playing", () => {
    if (!cur) return;
    clearDogs();
    cur.playing = true; cur.blocked = false; cur.paused = false;
    report("playing"); render();
  });
  audio.addEventListener("pause", () => {
    if (quiet) { quiet = false; return; }
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
    if (!cur) return;
    if (cur.paused || cur.blocked) { cur.blocked = false; start(); send({ type: "media_cmd", do: "resume" }); }
    else send({ type: "media_cmd", do: "pause" });
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
            else if (!m.paused && cur.paused) { cur.paused = false; if (!held) start(); }
            render();
            return;
          }
          clearDogs();
          quiet = false;
          cur = { id: m.id, url: m.url, title: String(m.title || ""), subtitle: String(m.subtitle || ""), source: String(m.source || ""), volume: m.volume, muted: !!m.muted, paused: !!m.paused, playing: false, blocked: false, failed: false };
          audio.src = m.url;
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
    /** After `ready`: send again what the socket could not carry, if it is still about the current item. */
    flush() { const ev = unsent; unsent = null; if (ev && cur && ev.id === cur.id && send(ev) === false) unsent = ev; },
    info: () => (cur ? { title: cur.title, subtitle: cur.subtitle, source: cur.source, paused: cur.paused || cur.blocked, muted: cur.muted } : null),
    current: () => cur?.id || null,
    ducked: () => ducker.ducked(),
  };
}
