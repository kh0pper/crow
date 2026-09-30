import * as store from "./store.js";
import { checkNumberPolicy, OUTCOMES } from "./plan.js";
import { deliverPhoneResult } from "./deliver.js";

const MAX_FAILURES = 30;       // consecutive events() failures (~60s at 2s ticks)
const MAX_MINUTES = 25;
const cap = (v) => (v == null ? null : String(v).slice(0, 200));

function cleanBooking(b) {
  if (!b || typeof b !== "object") return null;
  const price = typeof b.price === "number" && Number.isFinite(b.price) ? b.price : null;
  return { date: cap(b.date), time: cap(b.time), location: cap(b.location), price, confirmation: cap(b.confirmation), notes: cap(b.notes) };
}

/** One tick: expire stale plans, advance the live call (pull events,
 *  finalize), or claim+start the next due call; then sweep undelivered
 *  results (at-least-once). Concurrency safety rests on the store's CAS. */
export function createDispatcher({ db, runner, deps, settings }) {
  let busy = false;
  const failures = new Map();
  const deliver = deps.deliver || deliverPhoneResult;

  async function fail(call, outcome, error) {
    await store.finalizeCall(db, call.id, { outcome, booking: null, summary: null, error });
  }

  async function stopAndFail(id, error) {
    await Promise.resolve().then(() => runner.stop(id)).catch(() => {});
    await fail({ id }, "failed", error);
  }

  async function sweepDeliveries() {
    for (const c of await store.listUndelivered(db, 5)) {
      try {
        await deliver(db, c, deps);
        await store.markDelivered(db, c.id);
      } catch (e) {
        await store.bumpDeliveryAttempt(db, c.id);
        console.warn(`[phone] delivery failed for ${c.id}: ${e.message}`);
      }
    }
  }

  async function startNext() {
    const call = await store.claimNextDue(db);
    if (!call) return;
    const s = settings();
    try {
      checkNumberPolicy(call.number_e164, { ownerNumber: s.ownerNumber, suppressed: await store.suppressedSet(db) });
    } catch (e) { return fail(call, "failed", e.message); }
    if ((await store.callsTodayCount(db)) >= (s.dailyCap ?? 10)) return fail(call, "failed", "daily call cap reached");
    if (await store.recentCallToNumber(db, call.number_e164, 10)) return fail(call, "failed", "called this number less than 10 minutes ago");
    const model = s.model(call);
    if (!model) return fail(call, "not_admissible", "no model allowed for this call (enable a local model, or allow cloud on approval)");
    // Fresh single-use start token bound to the plan hash; the approval token never leaves the gateway.
    const token = await store.issueStartToken(db, call.id);
    if (!token) return fail(call, "failed", "could not issue start token");
    try {
      await runner.start(call, token, model, s.ownerName, s.line);
    } catch (e) { return stopAndFail(call.id, "runner start failed: " + e.message); }
    if (!(await store.markLive(db, call.id, model.label || model.model))) {
      await Promise.resolve().then(() => runner.stop(call.id)).catch(() => {});
      await fail(call, "failed", "call state changed during start");
    }
  }

  async function advanceLive() {
    const live = (await db.execute({
      sql: `SELECT id, event_seq, status, (julianday('now') - julianday(CASE WHEN status='live' THEN started_at ELSE updated_at END)) * 1440 AS age_min
            FROM phone_calls WHERE status IN ('live','starting') ORDER BY started_at LIMIT 1`, args: [] })).rows[0];
    if (!live) return false;
    if (live.age_min != null && live.age_min > MAX_MINUTES) {
      failures.delete(live.id);
      await stopAndFail(live.id, "call exceeded maximum duration");
      return true;
    }
    let r;
    try { r = await runner.events(live.id, live.event_seq); }
    catch {
      const n = (failures.get(live.id) || 0) + 1;
      failures.set(live.id, n);
      if (n >= MAX_FAILURES) { failures.delete(live.id); await stopAndFail(live.id, "runner unreachable"); }
      return true;
    }
    failures.delete(live.id);
    const events = r.events || [];
    const result = events.find((e) => e.type === "result");
    if (result) {
      // Finalize BEFORE advancing event_seq so a crash can never lose the result.
      const d = result.data || {};
      if (!OUTCOMES.includes(d.outcome)) {
        await fail(live, "failed", "invalid outcome from runner");
      } else {
        if (d.do_not_call) { const c = await store.getCall(db, live.id); await store.addSuppression(db, c.number_e164, "business asked not to be called"); }
        await store.finalizeCall(db, live.id, { outcome: d.outcome, booking: cleanBooking(d.booking), summary: cap(d.summary), error: cap(d.error) });
      }
    }
    if (events.length) await store.appendEvents(db, live.id, events);
    if (!result && r.done) await fail(live, "failed", "runner ended without a result");
    return true;
  }

  return {
    async tick() {
      if (busy) return; busy = true;
      try {
        await store.expirePlans(db);
        const hadLive = await advanceLive();
        if (!hadLive) await startNext();
        await sweepDeliveries();
      } finally { busy = false; }
    },
  };
}
