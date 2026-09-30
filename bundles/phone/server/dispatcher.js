import * as store from "./store.js";
import { checkNumberPolicy } from "./plan.js";

/** One tick: expire stale plans, advance the live call (pull events,
 *  finalize, deliver) or claim+start the next due call. Safe to run
 *  concurrently with itself only via the store's CAS transitions. */
export function createDispatcher({ db, runner, deps, settings }) {
  let busy = false;

  async function fail(call, outcome, error) {
    if (await store.finalizeCall(db, call.id, { outcome, booking: null, summary: null, error })) await deliverOnce(call.id);
  }

  async function deliverOnce(id) {
    if (!(await store.markDelivered(db, id))) return;
    const c = await store.getCall(db, id);
    await deps.deliver(db, c, deps);
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
      await store.markLive(db, call.id, model.label || model.model);
    } catch (e) { await fail(call, "failed", "runner start failed: " + e.message); }
  }

  async function advanceLive() {
    const live = (await db.execute({ sql: "SELECT id, event_seq FROM phone_calls WHERE status IN ('live','starting') ORDER BY started_at LIMIT 1", args: [] })).rows[0];
    if (!live) return false;
    let r;
    try { r = await runner.events(live.id, live.event_seq); } catch { return true; } // runner down: keep the call, retry next tick
    if (r.events?.length) await store.appendEvents(db, live.id, r.events);
    const result = (r.events || []).find((e) => e.type === "result");
    if (result?.data?.outcome) {
      if (result.data.do_not_call) { const c = await store.getCall(db, live.id); await store.addSuppression(db, c.number_e164, "business asked not to be called"); }
      if (await store.finalizeCall(db, live.id, { outcome: result.data.outcome, booking: result.data.booking || null, summary: result.data.summary || null, error: result.data.error || null })) {
        await deliverOnce(live.id);
      }
    }
    return true;
  }

  return {
    async tick() {
      if (busy) return; busy = true;
      try {
        await store.expirePlans(db);
        const hadLive = await advanceLive();
        if (!hadLive) await startNext();
      } finally { busy = false; }
    },
  };
}
