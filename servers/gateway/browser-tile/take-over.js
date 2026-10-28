/**
 * Live browser tile: the operator's Take over / Hand back (spec 2026-10-27
 * §4.4, §7 items 7 and 14; Rulings B3, B4).
 *
 * The gateway's in-memory record of the operator's holding. It changes ONLY
 * through this controller, which only the take-over routes drive; the lease
 * file's operator holder is never read as proof the operator acted (a bot can
 * write that file, Ruling B4).
 *
 *   idle ──take over──▶ held               (no bot call in flight)
 *   idle ──take over──▶ pending ──▶ held   (a bot call is in flight: switch when
 *                                           it ends, or after 30 s anyway; the
 *                                           still-running call's result then says
 *                                           the operator took it mid-call)
 *   pending | held ──hand back──▶ idle
 *   pending | held ──5 min without a heartbeat──▶ idle (handed back)
 *
 * While pending, the lease carries `pendingOperator`: no NEW bot call starts
 * (the browser MCP guard waits on it like an operator holding); only the calls
 * already in flight finish. Past the 30 s cap with the lease still locked, the
 * request gives up (the next heartbeat answers busy) instead of staying pending.
 *
 * Page hide or navigation never hands back: only the button or that loss does.
 * Every lease write passes forceBreakAfterMs (Ruling B3); a lease error is
 * thrown to the route, which answers "browser busy" — never a hang.
 */
import * as sharedLease from "../../shared/browser-lease.js";

/** Take over waits at most this long for an in-flight bot call (spec §7 item 7). */
export const IN_CALL_WAIT_MS = 30_000;
/** How often a pending take-over re-checks the lease. */
export const PENDING_POLL_MS = 500;
/** The sheet heartbeats every 15 s; this long without one hands the browser back. */
export const HEARTBEAT_LOSS_MS = 5 * 60_000;

/**
 * @param {object} o
 * @param {() => string|null} o.dir       this instance's lease dir, or null (no browser bundle)
 * @param {(held: boolean) => void} o.onHeld  the operator now holds (true) / no longer holds (false)
 * @param {() => number} [o.now]
 * @param {Function} [o.setTimer] / [o.clearTimer]
 * @param {(pid: number) => boolean} [o.isAlive]
 * @param {number} [o.forceBreakAfterMs]
 * @param {(line: string) => void} [o.log]  codes only, never a URL or host
 * @param {object} [o.lease]  the lease module (a test seam)
 */
export function createTakeOver({
  dir, onHeld, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
  isAlive = null, forceBreakAfterMs = 30_000, log = () => {}, lease = sharedLease,
} = {}) {
  let state = "idle";
  let pendingSince = 0;
  let pollTimer = null;
  let lossTimer = null;
  let chain = Promise.resolve();
  let closed = false;
  // The 30 s cap passed and the lease still could not be taken: the next
  // heartbeat answers busy once (the sheet says so) and the state is idle.
  let failed = false;

  function timer(fn, ms) {
    const h = setTimer(fn, ms);
    if (h && typeof h.unref === "function") h.unref();
    return h;
  }
  function opts() {
    const o = { now: now(), forceBreakAfterMs };
    if (typeof isAlive === "function") o.isAlive = isAlive;
    return o;
  }
  const code = (e) => String((e && e.code) || (e && e.name) || "error").slice(0, 40);

  /** One operation at a time: a double tap never takes twice. */
  function serial(fn) {
    const p = chain.then(fn, fn);
    chain = p.catch(() => {});
    return p;
  }

  function clearPoll() { if (pollTimer != null) { clearTimer(pollTimer); pollTimer = null; } }
  function clearLoss() { if (lossTimer != null) { clearTimer(lossTimer); lossTimer = null; } }
  function armLoss() {
    clearLoss();
    if (closed) return;
    lossTimer = timer(function heartbeatLoss() {
      lossTimer = null;
      serial(() => giveBack("loss")).catch((e) => log("browser take-over: heartbeat loss: " + code(e)));
    }, HEARTBEAT_LOSS_MS);
  }

  function becomeHeld() {
    clearPoll();
    state = "held";
    try { onHeld(true); } catch (e) { log("browser take-over: onHeld: " + code(e)); }
  }

  function schedulePoll() {
    clearPoll();
    if (closed) return;
    pollTimer = timer(function takeOverPoll() {
      pollTimer = null;
      serial(pendingTick).catch(() => {});
    }, PENDING_POLL_MS);
  }

  /** The take-over request ends without the browser: drop its flag (best effort; it also expires). */
  async function dropPending(d) {
    if (!d) return;
    try { await lease.clearPendingOperator(d, opts()); } catch (e) { log("browser take-over: clear pending: " + code(e)); }
  }

  /** Pending: the in-flight call ended → take it; 30 s passed → take it anyway. */
  async function pendingTick() {
    if (state !== "pending" || closed) return;
    const d = dir();
    if (!d) { state = "idle"; clearLoss(); return; }
    const capped = now() - pendingSince >= IN_CALL_WAIT_MS;
    try {
      if (capped) {
        await lease.takeOperator(d, opts());
        becomeHeld();
        return;
      }
      const r = await lease.takeOperatorIfIdle(d, opts());
      if (r && r.taken) { becomeHeld(); return; }
    } catch (e) {
      log("browser take-over: pending: " + code(e));
      if (capped) {
        // Past the cap and still no lease (a jammed lock): give up now with
        // the busy answer rather than stay pending until the 5 min loss.
        state = "idle"; failed = true; clearLoss();
        await dropPending(d);
        return;
      }
    }
    schedulePoll();
  }

  /** Hand back (the button) or lose it (5 min without a heartbeat). */
  async function giveBack(why) {
    const was = state;
    clearPoll();
    const d = dir();
    if (was === "pending") await dropPending(d);
    if (was === "held" || was === "idle") {
      // idle: free an operator holding this gateway no longer remembers (a
      // restart). It never turns into "the operator acted" (no onHeld).
      if (d) {
        try {
          await lease.handBack(d, opts());
        } catch (e) {
          // The button: say busy and stay held (try again). The loss: drop it
          // anyway; the file's own 5 min ttl frees it.
          if (why !== "loss") throw e;
          log("browser take-over: hand back: " + code(e));
        }
      }
    }
    state = "idle";
    clearLoss();
    if (was === "held") {
      try { onHeld(false); } catch (e) { log("browser take-over: onHeld: " + code(e)); }
    }
    return { state: "idle" };
  }

  return {
    /**
     * → { state: "held" | "pending" | "no_browser" | "other_bot" }; a lease error throws.
     * allowHolderSession (a link's chat): another bot holding the lease at
     * take time → "other_bot", nothing taken and nothing left pending.
     */
    takeOver({ allowHolderSession } = {}) {
      return serial(async () => {
        const d = dir();
        if (!d) return { state: "no_browser" };
        if (state === "held") {
          await lease.takeOperator(d, opts());   // a renewal
          armLoss();
          return { state: "held" };
        }
        if (state === "pending") { armLoss(); return { state: "pending" }; }
        failed = false;
        const o = opts();
        if (typeof allowHolderSession === "string") o.allowHolderSession = allowHolderSession;
        const r = await lease.takeOperatorIfIdle(d, o);
        if (r && r.reason === "other_bot") return { state: "other_bot" };
        armLoss();
        if (r && r.taken) { becomeHeld(); return { state: "held" }; }
        state = "pending";
        pendingSince = now();
        schedulePoll();
        return { state: "pending" };
      });
    },
    /** → { state: "idle" }; a lease error on the button throws (still held). */
    handBack() { return serial(() => giveBack("button")); },
    /** The sheet is still open. → { state }; idle means the browser went back. */
    heartbeat() {
      return serial(async () => {
        if (state === "idle") {
          if (failed) {
            failed = false;
            throw Object.assign(new Error("take-over gave up"), { code: "ETAKEOVERBUSY" });
          }
          return { state: "idle" };
        }
        armLoss();
        if (state === "held") {
          const d = dir();
          if (d) await lease.heartbeat(d, opts());
        }
        return { state };
      });
    },
    state: () => state,
    close() { closed = true; clearPoll(); clearLoss(); },
  };
}
