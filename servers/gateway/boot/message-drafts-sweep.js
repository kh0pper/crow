/**
 * boot/message-drafts-sweep.js — the boot pass over Crow Messages' saved drafts.
 *
 * A draft send takes the row from `open` to `sending` and then hands the text to a transport. If this
 * process dies in between (a crash, a systemd restart, a power cut) nobody ever moves the row on, and
 * the person is left with a draft that can never be sent or edited again: every write the composer
 * makes is a compare-and-set on `open`. Nothing else in the gateway can tell "still delivering" from
 * "delivering in a process that no longer exists", which is why the repair is a boot pass — a `sending`
 * row that has outlived a few minutes, seen from a process that has just started, is a row whose
 * sender is gone.
 *
 * That first sentence is also why this runs exactly ONCE, at boot, and never on an interval: a sweep
 * in the middle of a running process cannot tell a stuck row from a send that is still in flight (here,
 * or in another gateway sharing the same crow.db), and reopening one of those leaves the draft open
 * with text that has already gone out — the next tap sends it twice.
 *
 * The store owns the transition (`sweepStuckSends`, servers/gateway/messages/drafts-store.js): back to
 * `open` with `send_interrupted` and one `reopened` audit row, or — when the conversation gained a
 * newer open draft meanwhile — parked as `failed` with a `parked` audit row, and the same bus event
 * every other draft write pokes so an open panel redraws. This module is only the wiring — one db
 * client, opened and closed here, `NEVER throws`, so a boot sweep can never cascade into an outage —
 * plus the seam a test injects its own clock, factory and log through.
 */

/**
 * Run one stuck-send sweep.
 *
 * @param {{dbFactory?: () => object, now?: Function|number, olderThanMs?: number, log?: Function}} [opts]
 *   `dbFactory` mints the crow.db client (defaults to the gateway's `createDbClient`, closed here);
 *   `now` and `olderThanMs` are the store's own seams, and `log` is where a row the store could not
 *   move is reported (one bad row never stops the pass).
 * @returns {Promise<{reopened: number, parked: number}>} what the store changed
 */
export async function runStuckDraftSweep({ dbFactory, now, olderThanMs, log = (m) => console.log(m) } = {}) {
  let db = null;
  try {
    const { sweepStuckSends } = await import("../messages/drafts-store.js");
    if (typeof dbFactory !== "function") {
      const { createDbClient } = await import("../../db.js");
      db = createDbClient();
    } else {
      db = dbFactory();
    }
    const result = await sweepStuckSends(db, { now, olderThanMs, log });
    if (result.reopened > 0 || result.parked > 0) {
      log(`[message-drafts] reopened ${result.reopened} interrupted send(s)` +
        (result.parked > 0 ? `, parked ${result.parked} whose conversation has a newer draft` : ""));
    }
    return result;
  } catch (err) {
    log(`[message-drafts] stuck-send sweep skipped: ${err?.message || err}`);
    return { reopened: 0, parked: 0 };
  } finally {
    try {
      db?.close?.();
    } catch {
      // A stuck close must not fail the boot path.
    }
  }
}

export default runStuckDraftSweep;