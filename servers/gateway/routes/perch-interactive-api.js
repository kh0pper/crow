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
import express, { Router } from "express";
import { realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, sep } from "node:path";
import { jsonError } from "./_error.js";
import { openAuthedStream } from "../streams/authed-stream.js";
import { resolveEngineStatus } from "../dashboard/panels/bot-builder/engine-gate.js";
import { createDbClient } from "../../db.js";
import { perchAttached } from "../shared/perch-attached.js";
import { getInteractiveEngine } from "../perch-interactive.js";
import { tasksDbPath } from "../../../scripts/pi-bots/instance-paths.mjs";
import { updateCard } from "../board/card-service.js";

/** Mount prefix. Every route below is registered under it, after the auth gate. */
const P = "/dashboard/perch-api";

/** Inbound message cap — same value, same reasoning, as perch.js's MESSAGE_CAP. */
const MESSAGE_CAP = 32_000;

/** The instance-global tasks store — cards live ONLY here, never per-project
 * (Track 1 §board-truth). Resolved once at module load, same idiom as
 * bot-board-api.js's own TASKS_DB constant. */
const TASKS_DB = tasksDbPath();

/** Every provenance write this router makes is an operator action from the
 * dashboard — same shape as bot-board-api.js's own DASHBOARD_ACTOR. */
const DASHBOARD_ACTOR = { kind: "human", id: null, jobId: null };

/** POST /interactive/:sid/message images: cap 3 × 2 MB post-decode. */
const IMAGE_MESSAGE_CAP = 3;
const IMAGE_MESSAGE_BYTES_CAP = 2 * 1024 * 1024;

/** POST /interactive/:sid/files: base64 JSON body, cap 5 MB post-decode. */
const UPLOAD_BYTES_CAP = 5 * 1024 * 1024;

/** Extensions the workspace route serves inline (never `attachment`). */
const WORKSPACE_IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

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
  // Track 3 Task 9 additions.
  card_occupied: [409, "card_occupied"],
  no_session_dir: [409, "no_session_dir"],
  cycle_busy: [409, "cycle_busy"],
  // control({planMode}) on a hibernating session (perch-interactive.js's own
  // `if (!s.pi) throw engineError("not_awake")` — plan mode always needs a
  // live child, never queued).
  not_awake: [409, "not_awake"],
  command_failed: [502, "command_failed"],
};

function mapEngineError(res, err) {
  // Track 3 Task 9: card-service errors (fail(msg, code, http) — see
  // servers/gateway/board/card-service.js) carry their OWN http status and a
  // code that is never in ERROR_MAP ("archived", "not_found", "locked", …).
  // Checked FIRST — an err with an explicit `.http` is authoritative over
  // whatever ERROR_MAP might otherwise guess from `.code` alone.
  if (err && Number.isInteger(err.http)) {
    return jsonError(res, err.http, String(err.code || err.message || err));
  }
  // Object.hasOwn (fix-round F2): a bare `ERROR_MAP[err.code]` is a
  // prototype-chain lookup on an object literal — an err.code of
  // "constructor" would yield a truthy non-array and res.status(undefined)
  // would throw inside an async catch block.
  const code = err && err.code;
  const mapped = code && Object.hasOwn(ERROR_MAP, code) ? ERROR_MAP[code] : null;
  if (mapped) return jsonError(res, mapped[0], mapped[1]);
  return jsonError(res, 500, String((err && err.message) || err));
}

/** Same `{code, http}` throw shape card-service's own local `fail()` uses —
 * this router's own route-level validations (card existence, kind, archived)
 * funnel through mapEngineError's `.http`-first branch the same way a
 * card-service throw does, one error path for both origins. */
function routeFail(message, code, http) {
  return Object.assign(new Error(message), { code, http });
}

/** Parse a request body's `card_id` into a strict integer, or null if it is
 * missing/malformed. `Number(null) === 0` is a real footgun here — an
 * explicit `card_id: null` must refuse the same as an omitted field, never
 * silently resolve to card id 0. */
function parseCardId(body) {
  if (body.card_id == null) return null;
  const n = Number(body.card_id);
  return Number.isInteger(n) ? n : null;
}

/** Load a card's row for dispatch/attach-card validation: exists, is a CARD
 * (`board_id IS NULL` — Track 3 review Q2: dispatch/attach are cards-only),
 * and is not archived. Throws a routeFail() the catch block already knows
 * how to map: not_found→404, bad_request→400 (a custom-board ITEM id),
 * archived→409. */
async function loadDispatchableCard(tdb, cardId) {
  const row = (await tdb.execute({
    sql: "SELECT id, board_id, archived_at FROM tasks_items WHERE id=?",
    args: [cardId],
  })).rows[0];
  if (!row) throw routeFail("card not found", "not_found", 404);
  if (row.board_id != null) throw routeFail("not a card", "bad_request", 400);
  if (row.archived_at != null) throw routeFail("card is archived", "archived", 409);
  return row;
}

/** POST /interactive/:sid/message + /bots/:id/dispatch's turn-1 note both
 * carry an optional `images` array — normalizes `{mime, data_b64}` wire
 * objects into pi's own ImageContent shape (`{type:"image", data, mimeType}`
 * — see scripts/pi-bots/gateways/base.mjs downloadImages()) and drops (never
 * throws on) anything malformed or over cap, same best-effort discipline
 * downloadImages itself uses for a bad attachment. */
function normalizeMessageImages(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out = [];
  for (const item of raw.slice(0, IMAGE_MESSAGE_CAP)) {
    if (!item || typeof item !== "object") continue;
    const mime = typeof item.mime === "string" ? item.mime : "";
    const b64 = typeof item.data_b64 === "string" ? item.data_b64 : "";
    if (!mime || !b64) continue;
    let buf;
    try { buf = Buffer.from(b64, "base64"); } catch { continue; }
    if (!buf.length || buf.length > IMAGE_MESSAGE_BYTES_CAP) continue;
    out.push({ type: "image", data: buf.toString("base64"), mimeType: mime });
  }
  return out.length ? out : undefined;
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

  // Route-scoped parser for the TWO routes on this router whose bodies can
  // legitimately exceed the gateway's global 1mb JSON limit (index.js's
  // `_jsonParser` skips both exact paths — `_hasOwnParser` — for the same
  // reason /llm gets its own 10mb parser): a 5MB post-decode base64 file
  // upload is ~6.7MB of JSON text, and 3 × 2MB post-decode message images are
  // ~8.4MB — both need real headroom over the default limit, so both share
  // one 10mb parser (matching /llm's own precedent).
  router.use(P + "/interactive/:sid/files", express.json({ limit: "10mb" }));
  router.use(P + "/interactive/:sid/message", express.json({ limit: "10mb" }));

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
    // Track 3 Task 9: images the drawer attached via POST .../files, sent on
    // the NEXT message (see normalizeMessageImages' doc — pi's own
    // ImageContent shape, threaded verbatim to promptTurn).
    const images = normalizeMessageImages(body.images);
    try {
      const eng = resolveEngine();
      const result = await eng.message(sid, message, images);
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

  // ---- POST /bots/:id/dispatch — spawn a session bound to a card ----
  // Same engine/perch-attach gate as POST /bots/:id/interactive above (mirror
  // :119-142), plus card validation (exists, a CARD not a custom-board ITEM,
  // not archived), occupancy (checkCardFree), and — once spawn() succeeds —
  // the assigned_bot provenance write and a fire-and-forget turn 1 carrying
  // the operator's note.
  router.post(P + "/bots/:id/dispatch", async (req, res) => {
    const botId = String(req.params.id);
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const cardId = parseCardId(body);
    const note = body.note == null ? "" : String(body.note);
    if (cardId == null) return jsonError(res, 400, "bad_request");

    const db = createDbClient();
    let tdb;
    try {
      const row = await loadBotRow(db, botId);
      if (resolveEngineStatus().state !== "ready") return jsonError(res, 409, "engine_required");
      const def = row ? parseDef(row) : {};
      if (!perchAttached(def)) return jsonError(res, 403, "perch_not_attached");

      tdb = createDbClient(TASKS_DB);
      await loadDispatchableCard(tdb, cardId);

      const eng = resolveEngine();
      await eng.checkCardFree(cardId);
      const result = await eng.spawn({ botId, cardId });

      // Provenance: the assigned_bot write goes through the SAME service
      // updateCard()/board_update_item's route uses (bot-board-api.js's own
      // DASHBOARD_ACTOR idiom) — one code path, one recordMutation shape.
      await updateCard(tdb, cardId, { assigned_bot: botId }, DASHBOARD_ACTOR);

      // Fire-and-forget: dispatch STARTS the turn (spawn() already composed
      // and stored s.dispatchBrief; THIS message() call is what triggers it
      // to fire — see perch-interactive.js's own header note). Never awaited
      // — the route responds as soon as the session exists, not once the
      // agent turn finishes.
      eng.message(result.sessionId, note).catch(() => {});

      res.status(201).json(result);
    } catch (err) {
      mapEngineError(res, err);
    } finally {
      try { db.close(); } catch { /* already closed */ }
      if (tdb) { try { tdb.close(); } catch { /* already closed */ } }
    }
  });

  // ---- POST /interactive/:sid/attach-card — bind an existing session to a card ----
  router.post(P + "/interactive/:sid/attach-card", async (req, res) => {
    const sid = String(req.params.sid);
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const cardId = parseCardId(body);
    if (cardId == null) return jsonError(res, 400, "bad_request");

    let tdb;
    try {
      tdb = createDbClient(TASKS_DB);
      await loadDispatchableCard(tdb, cardId);

      const eng = resolveEngine();
      await eng.checkCardFree(cardId);
      const result = await eng.attachCard(sid, cardId);

      await updateCard(tdb, cardId, { assigned_bot: result.botId }, DASHBOARD_ACTOR);

      res.json({ ok: true, cardId });
    } catch (err) {
      mapEngineError(res, err);
    } finally {
      if (tdb) { try { tdb.close(); } catch { /* already closed */ } }
    }
  });

  // ---- POST /interactive/:sid/control — model / thinking / permission / plan mode ----
  // Route bodies use snake_case (permission_mode, plan_mode) — mapped to the
  // engine's camelCase here, the ONE place that translation happens. `model`
  // accepts {provider, id} (the shape options()'s listings hand back) and
  // maps id→modelId for the engine.
  router.post(P + "/interactive/:sid/control", async (req, res) => {
    const sid = String(req.params.sid);
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const opts = {};
    if (body.model != null && typeof body.model === "object") {
      opts.model = { provider: body.model.provider, modelId: body.model.id };
    }
    if (body.thinking != null) opts.thinking = body.thinking;
    if (body.permission_mode != null) opts.permissionMode = body.permission_mode;
    if (Object.prototype.hasOwnProperty.call(body, "plan_mode")) opts.planMode = body.plan_mode;
    try {
      const eng = resolveEngine();
      const result = await eng.control(sid, opts);
      res.json(result);
    } catch (err) {
      mapEngineError(res, err);
    }
  });

  // ---- POST /interactive/:sid/cycle — force a respawn ----
  router.post(P + "/interactive/:sid/cycle", async (req, res) => {
    try {
      const eng = resolveEngine();
      const result = await eng.cycle(String(req.params.sid));
      res.json(result);
    } catch (err) {
      mapEngineError(res, err);
    }
  });

  // ---- GET /interactive/:sid/options — live model / thinking-level menus ----
  router.get(P + "/interactive/:sid/options", async (req, res) => {
    try {
      const eng = resolveEngine();
      const result = await eng.options(String(req.params.sid));
      res.json(result);
    } catch (err) {
      mapEngineError(res, err);
    }
  });

  // ---- POST /interactive/:sid/files — upload into the session's uploads dir ----
  // base64 JSON body (no new dependency — multipart would need one): {name,
  // data_b64}, cap 5 MB post-decode. `name` is basename()'d and any leading
  // "." (empty, ".", "..", or a real dotfile name) is refused — the upload
  // target is always a flat file directly under the session's uploadsDir,
  // never a caller-chosen subpath.
  router.post(P + "/interactive/:sid/files", async (req, res) => {
    const sid = String(req.params.sid);
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const name = basename(typeof body.name === "string" ? body.name : "");
    if (!name || name.startsWith(".")) return jsonError(res, 400, "bad_request");
    const b64 = typeof body.data_b64 === "string" ? body.data_b64 : "";
    if (!b64) return jsonError(res, 400, "bad_request");
    let buf;
    try { buf = Buffer.from(b64, "base64"); } catch { return jsonError(res, 400, "bad_request"); }
    if (!buf.length || buf.length > UPLOAD_BYTES_CAP) return jsonError(res, 400, "bad_request");
    try {
      const eng = resolveEngine();
      const snap = await eng.get(sid);
      if (!snap) return jsonError(res, 404, "no_such_session");
      if (!snap.uploadsDir) return jsonError(res, 409, "no_session_dir");
      writeFileSync(join(snap.uploadsDir, name), buf);
      res.json({ path: name });
    } catch (err) {
      mapEngineError(res, err);
    }
  });

  // ---- GET /interactive/:sid/workspace/* — confined file serving ----
  // Serves ONLY files a child wrote to its OWN outputsDir (never uploadsDir —
  // that direction is upload-only, never re-served). realpath-jailed per the
  // brief's own pinned formula: any dotfile PATH SEGMENT is refused BEFORE
  // resolution (so a real dotfile can never even reach realpathSync, let
  // alone a traversal attempt through one); the resolved real path must sit
  // STRICTLY under the outputsDir's own real path (the `+ sep` is what turns
  // this into "strictly under", not "starts with the same string prefix" —
  // it is also what makes a bare directory request 404 on its own, with no
  // separate isFile() branch needed for THAT case: `outputsReal` never starts
  // with `outputsReal + sep`). No directory listing: any resolved path that
  // is not a regular file 404s. `Content-Disposition: attachment` on every
  // extension except the image set the drawer inlines.
  router.get(P + "/interactive/:sid/workspace/*", async (req, res) => {
    const sid = String(req.params.sid);
    const rel = req.params[0] || "";
    try {
      if (rel.split("/").some((seg) => seg.startsWith("."))) return jsonError(res, 404, "not_found");

      const eng = resolveEngine();
      const snap = await eng.get(sid);
      if (!snap) return jsonError(res, 404, "no_such_session");
      if (!snap.outputsDir) return jsonError(res, 409, "no_session_dir");

      let outputsReal, resolved;
      try {
        outputsReal = realpathSync(snap.outputsDir);
        resolved = realpathSync(join(snap.outputsDir, rel));
      } catch {
        return jsonError(res, 404, "not_found");
      }
      if (!resolved.startsWith(outputsReal + sep)) return jsonError(res, 404, "not_found");

      let stat;
      try { stat = statSync(resolved); } catch { return jsonError(res, 404, "not_found"); }
      if (!stat.isFile()) return jsonError(res, 404, "not_found");

      if (!WORKSPACE_IMAGE_EXTS.has(extname(resolved).toLowerCase())) {
        res.set("Content-Disposition", "attachment; filename=\"" + basename(resolved) + "\"");
      }
      // Explicit callback (rather than Express's default next(err) on
      // failure): a race between the statSync above and this read (the file
      // vanishing under us) must still 404 through THIS route's JSON
      // contract, never fall through to the app's generic HTML error page.
      res.sendFile(resolved, (err) => {
        if (err && !res.headersSent) jsonError(res, 404, "not_found");
      });
    } catch (err) {
      mapEngineError(res, err);
    }
  });

  return router;
}
