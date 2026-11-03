/**
 * widgets/changed.js — the debounced, content-free "what needs me may have
 * changed" ping (widgets phase 1, Task 3).
 *
 * Both surfaces that show what waits on the owner — the in-Crow widget and the
 * Android home-screen widget — refresh on this event. It carries NOTHING: no
 * title, no text, no click URL, so a locked phone learns only "refresh".
 *
 * Three rules, all load-bearing:
 *
 *   1. Fire-and-forget. notifyWidgetsChanged() schedules and returns; it never
 *      awaits a network send in its caller's path. recordMutation() (a board
 *      write) and deliverNotification() (every notification fan-out) call it,
 *      and neither may be slowed or failed by a push.
 *   2. Debounced, trailing edge. A burst of board changes (a bot moving 20
 *      cards) opens ONE 5 s window on the first call; the send happens when the
 *      window closes and later calls during it are no-ops. That gives at most
 *      one send per 5 s without ever pushing ahead of the change it announces.
 *   3. Never throws, never holds the process open. Every failure is swallowed
 *      and the timer is unref'd, so a gateway shutting down (or a test run)
 *      does not wait for a pending window.
 *
 * Import safety: servers/shared/notifications.js imports this module, and it
 * must stay loadable outside the gateway. The sender is therefore loaded with a
 * LAZY dynamic import inside the timer callback — no gateway module joins the
 * load graph of every process that imports shared/notifications.js.
 */

/** The window length: at most one send per this many ms. */
export const WIDGETS_CHANGED_DEBOUNCE_MS = 5000;

/** The X-Tags value the phone app matches on (see sendNtfySilent). */
export const WIDGETS_CHANGED_TAG = "crow-widgets";

/**
 * The opt-in: the silent push goes out only while this setting is "on". A phone
 * app older than the widget build turns every ntfy message into a notification,
 * and ntfy fills an empty body with "triggered", so an unconditional send would
 * put a blank alert on that phone every few seconds. The app that has the
 * widget switches this on; until then nothing is sent.
 */
export const WIDGETS_PUSH_KEY = "widgets_push";

/** True only for the exact value "on" (anything else, including a read failure, is off). */
export function widgetsPushOn(value) {
  return value === "on";
}

/**
 * The default sender. Dynamic imports so this module costs nothing (and
 * imports nothing gateway-specific) until a window actually closes. A failed
 * setting read is "off".
 */
async function sendNtfySilentLazy(opts) {
  let on = false;
  try {
    const [{ createDbClient }, { readSetting }] = await Promise.all([
      import("../../db.js"),
      import("../dashboard/settings/registry.js"),
    ]);
    const db = createDbClient();
    try { on = widgetsPushOn(await readSetting(db, WIDGETS_PUSH_KEY)); } finally { try { db.close(); } catch { /* closed */ } }
  } catch {
    on = false;
  }
  if (!on) return { ok: false, skipped: true, reason: "widgets_push off" };
  const mod = await import("../push/ntfy.js");
  return mod.sendNtfySilent(opts);
}

// Module state: the open window's timer, and a generation counter that
// invalidates a timer scheduled before a test reset (so a stale callback can
// neither send nor clobber the new window's handle).
let timer = null;
let generation = 0;

/**
 * Tell the widgets something may have changed. Safe to call from anywhere, any
 * number of times: never throws, never awaits, at most one send per window.
 *
 * @param {object} [opts]
 * @param {Function} [opts.send]     send seam (tests): (opts) => Promise|void
 * @param {Function} [opts.now]      clock seam
 * @param {Function} [opts.setTimer] timer seam (tests); its return value is unref'd when possible
 * @returns {{scheduled: boolean, at?: number}} `at` is the window close (ms, clock of `now`)
 */
export function notifyWidgetsChanged({ send = sendNtfySilentLazy, now = Date.now, setTimer = setTimeout } = {}) {
  try {
    // A window is already open — its close sends for everything in it.
    if (timer) return { scheduled: false };

    const openedAt = now();
    const myGeneration = generation;
    const handle = setTimer(() => {
      // A test reset (or a fresh module state) makes this callback a no-op.
      if (myGeneration !== generation) return;
      timer = null;
      try {
        const pending = send({ tag: WIDGETS_CHANGED_TAG });
        // A sender may be async; a rejected send is nobody's business.
        if (pending && typeof pending.catch === "function") pending.catch(() => {});
      } catch {
        // A synchronous throw is swallowed the same way.
      }
    }, WIDGETS_CHANGED_DEBOUNCE_MS);

    timer = handle;
    // Do not keep the event loop (or a short-lived process) alive for this.
    try { handle?.unref?.(); } catch { /* a test seam need not support unref */ }

    return { scheduled: true, at: openedAt + WIDGETS_CHANGED_DEBOUNCE_MS };
  } catch {
    // Scheduling itself failed (a pathological timer seam) — stay silent.
    timer = null;
    return { scheduled: false };
  }
}

/** Test hook: forget the open window and invalidate any timer already scheduled. */
export function _resetWidgetsChangedForTest() {
  generation += 1;
  timer = null;
}