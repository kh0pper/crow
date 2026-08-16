/**
 * perch-interactive-api.js — Perch Hub P2 (C-15), the "spawn as bot" API.
 *
 * Where perch.js (P1) is a per-turn channel — one `handleInbound()`, one pi
 * spawn, one reply, child dead — this file drives the OTHER half: a
 * long-lived interactive session, owned end-to-end by
 * `servers/gateway/perch-interactive.js`'s process-singleton engine. This
 * router is thin on purpose: every state transition, capacity gate and DB
 * write lives in the engine; the routes below do request parsing, HTTP
 * status mapping, and (for the SSE endpoint) wiring the engine's push events
 * onto a client stream.
 *
 * MOUNT — same rails as P1, for the same reasons (see perch.js's header):
 * `/dashboard/perch-api` again (rate-limit skip + the real CSRF rail +
 * funnel-private), `router.use(P, dashboardAuth)` as the router's FIRST
 * statement, mounted inside dashboard/index.js AFTER csrfMiddleware.
 *
 * Message length cap: same in-route `.slice(0, MESSAGE_CAP)` as perch.js's
 * turn route — the global body parser allows 1mb, a turn prompt does not.
 *
 * Error mapping: `perch-interactive.js`'s public methods throw a
 * `{code, message}` shaped Error (see its `engineError()`) for every refusal.
 * ERROR_MAP below is the ONE place that turns an engine code into an HTTP
 * status + JSON `error` string — every route funnels its catch block through
 * `mapEngineError()` so a new engine refusal only needs one new table row,
 * never a route-by-route special case. `session_stopped` (the engine's own
 * internal code) is deliberately translated to the external body
 * `{error:"stopped"}` — the JSON contract C-16 consumes, not the engine's
 * internal vocabulary.
 */
import { Router } from "express";
import { jsonError } from "./_error.js";
import { openAuthedStream } from "../streams/authed-stream.js";
import { resolveEngineStatus } from "../dashboard/panels/bot-builder/engine-gate.js";
import { createDbClient } from "../../db.js";
import { perchAttached } from "../shared/perch-attached.js";
import { getInteractiveEngine } from "../perch-interactive.js";

/** Mount prefix. Every route below is registered under it, after the auth gate. */
const P = "/dashboard/perch-api";

/** Inbound message cap — same value, same reasoning, as perch.js's MESSAGE_CAP. */
const MESSAGE_CAP = 32_000;

/** engine.code → [httpStatus, external error string]. The external string is
 * usually identical to the engine's code; `session_stopped` is the one
 * deliberate rename (see file header). Codes with no HTTP meaning in this
 * router (engine_required, perch_not_attached — both decided by THIS route
 * before it ever calls the engine) are not listed here. */
const ERROR_MAP = {
  perch_disabled: [503, "perch_disabled"],
  interactive_capacity: [409, "interactive_capacity"],
  pi_capacity: [409, "pi_capacity"],
  turn_in_progress: [409, "turn_in_progress"],
  // D1 (C-19 acceptance): the child died between the reservation and the
  // turn actually starting (a wake that raced a kill, or an already-awake
  // child killed a beat before the message() call reached it). 409, not 500
  // — the session is honestly gone-and-hibernating, not broken; a retry
  // wakes a fresh child.
  pi_gone: [409, "pi_gone"],
  no_such_session: [404, "no_such_session"],
  session_stopped: [410, "stopped"],
  no_such_request: [409, "no_such_request"],
  no_turn: [409, "no_turn"],
  bad_request: [400, "bad_request"],
};

function mapEngineError(res, err) {
  // Object.hasOwn (fix-round F2): a bare `ERROR_MAP[err.code]` is a
  // prototype-chain lookup on an object literal — an err.code of
  // "constructor" would yield a truthy non-array and res.status(undefined)
  // would throw inside an async catch block.
  const code = err && err.code;
  const mapped = code && Object.hasOwn(ERROR_MAP, code) ? ERROR_MAP[code] : null;
  if (mapped) return jsonError(res, mapped[0], mapped[1]);
  return jsonError(res, 500, String((err && err.message) || err));
}

function parseDef(row) {
  try {
    const def = JSON.parse(row.definition || "{}");
    return def && typeof def === "object" ? def : {};
  } catch {
    return {};
  }
}

async function loadBotRow(db, botId) {
  const { rows } = await db.execute({
    sql: "SELECT bot_id, display_name, definition, enabled FROM pi_bot_defs WHERE bot_id=?",
    args: [botId],
  });
  return rows[0] || null;
}

/**
 * @param {Function} dashboardAuth session gate (the SAME middleware the rest
 *   of /dashboard uses, and the SAME instance perch.js is handed).
 * @param {object} [seams]
 * @param {Function|object} [seams.engine] test seam. A FUNCTION is treated as
 *   an accessor and called with no args on every request (the default,
 *   `getInteractiveEngine`, is exactly this shape — the DEFAULT-ACCESSOR
 *   precondition test in tests/perch-interactive-routes.test.js proves it
 *   resolves to a real, fully-wired engine). An OBJECT is used AS the engine
 *   directly — what every fake-engine test below injects, so a turn is never
 *   driven and no pi is ever spawned.
 */
export default function perchInteractiveApiRouter(dashboardAuth, { engine = getInteractiveEngine } = {}) {
  const router = Router();

  // FIRST statement: auth-gate the whole prefix (perch.js / bot-board-api idiom).
  router.use(P, dashboardAuth);

  function resolveEngine() {
    return typeof engine === "function" ? engine() : engine;
  }

  // ---- POST /bots/:id/interactive — spawn a long-lived session ----
  router.post(P + "/bots/:id/interactive", async (req, res) => {
    const botId = String(req.params.id);
    const db = createDbClient();
    try {
      const row = await loadBotRow(db, botId);
      // Engine first: it is the instance-wide condition (perch.js's own
      // ordering — see its POST /turn). A missing bot row is folded into the
      // attach check below rather than a separate 404: parseDef(null-ish row)
      // yields {} and perchAttached({}) is false by construction, which is
      // the exact external shape C-16 consumes (no distinct unknown_bot case
      // in the documented interface).
      if (resolveEngineStatus().state !== "ready") return jsonError(res, 409, "engine_required");
      const def = row ? parseDef(row) : {};
      if (!perchAttached(def)) return jsonError(res, 403, "perch_not_attached");

      const eng = resolveEngine();
      const result = await eng.spawn({ botId });
      res.status(201).json(result);
    } catch (err) {
      mapEngineError(res, err);
    } finally {
      try { db.close(); } catch { /* already closed */ }
    }
  });

  // ---- POST /interactive/:sid/message — drive one turn ----
  router.post(P + "/interactive/:sid/message", async (req, res) => {
    const sid = String(req.params.sid);
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const message = String(body.message == null ? "" : body.message).slice(0, MESSAGE_CAP);
    try {
      const eng = resolveEngine();
      const result = await eng.message(sid, message);
      res.status(202).json({ turnId: result.turnId });
    } catch (err) {
      mapEngineError(res, err);
    }
  });

  // ---- GET /interactive/:sid/events — persistent SSE ----
  // PRIMITIVE PINNED (r2 CR4): openAuthedStream, not the bare openStream perch.js's
  // per-turn SSE uses — a spawned session outlives one turn, so it needs the
  // periodic session re-check (a logged-out operator's stream must close) and
  // the 30s keepalive that carries it across a hibernation-length idle gap.
  router.get(P + "/interactive/:sid/events", async (req, res) => {
    const sid = String(req.params.sid);
    const eng = resolveEngine();
    let existing;
    try {
      existing = await eng.get(sid);
    } catch (err) {
      return mapEngineError(res, err);
    }
    if (!existing) return jsonError(res, 404, "no_such_session");

    const stream = openAuthedStream(req, res);
    if (!stream) return; // SSE cap reached — openAuthedStream already sent 503

    // Single-line JSON data frames (P1 C-5 #3 idiom): `send()` JSON.stringifies
    // non-string data, which never emits a raw newline, so every `state | text |
    // tool | ask_user | log | reply | error` event is exactly one `data:` line.
    // engine.subscribe() itself replays the current state (and a pending
    // ask_user card, if any) synchronously into this callback before it
    // resolves — the "on connect, replay" contract lives THERE, once, so
    // every subscriber (this route, and any future one) gets it for free.
    const forward = (event) => stream.send(event.type, event);

    // Register the close handler BEFORE the subscribe await (fix-round F1): a
    // client abort DURING that await (subscribe→resolveSession→adoptRow does a
    // real DB read) fires 'close' immediately — if the listener were bound
    // after, it would never be added and the engine subscriber would leak for
    // the life of the process. `teardown` is idempotent (unsubscribe is
    // nulled before it's called), so the late-reconcile below can never
    // double-unsubscribe with the close handler.
    let unsubscribe = null;
    let gone = false;
    const teardown = () => {
      gone = true;
      const u = unsubscribe;
      unsubscribe = null;
      if (u) { try { u(); } catch { /* already gone */ } }
    };
    res.on("close", teardown);
    try {
      unsubscribe = await eng.subscribe(sid, forward);
    } catch {
      // The session vanished between get() and subscribe() (e.g. a concurrent
      // stopAll during shutdown) — close cleanly rather than leave an SSE
      // stream open with nothing ever going to feed it.
      stream.close();
      return;
    }
    // Late-unsubscribe reconcile: the client vanished while subscribe() was in
    // flight — 'close' already fired with unsubscribe still null, so run the
    // teardown again now that we finally hold the real unsubscribe.
    if (gone) teardown();
  });

  // ---- POST /interactive/:sid/answer — resolve a pending ask_user card ----
  router.post(P + "/interactive/:sid/answer", async (req, res) => {
    const sid = String(req.params.sid);
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const requestId = body.requestId == null ? "" : String(body.requestId);
    try {
      const eng = resolveEngine();
      const result = await eng.answer(sid, requestId, body);
      res.json(result);
    } catch (err) {
      // S4: a dead child must yield a 409-shaped no_such_request, never a raw
      // 500 — engine.answer() already enforces liveness before it ever calls
      // pi.send(), so every throw here is a real ERROR_MAP code.
      mapEngineError(res, err);
    }
  });

  // ---- POST /interactive/:sid/abort — abort the in-flight turn ----
  router.post(P + "/interactive/:sid/abort", async (req, res) => {
    try {
      const eng = resolveEngine();
      const result = await eng.abort(String(req.params.sid));
      res.json(result);
    } catch (err) {
      mapEngineError(res, err);
    }
  });

  // ---- POST /interactive/:sid/stop — close the child, park the row ----
  router.post(P + "/interactive/:sid/stop", async (req, res) => {
    try {
      const eng = resolveEngine();
      const result = await eng.stop(String(req.params.sid));
      res.json(result);
    } catch (err) {
      mapEngineError(res, err);
    }
  });

  return router;
}
