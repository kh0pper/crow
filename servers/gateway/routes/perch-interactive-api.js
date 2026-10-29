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
import {
  realpathSync,
  openSync,
  closeSync,
  fstatSync,
  ftruncateSync,
  writeSync,
  createReadStream,
  readdirSync,
  statSync,
  lstatSync,
  constants as fsConstants,
  existsSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import { jsonError } from "./_error.js";
import { openDeliveredDir, openDeliveredFile, unlinkDelivered } from "../../shared/perch-delivered.js";
import { SHOT_KEEP } from "../browser-tile/shots.js";
import { openAuthedStream } from "../streams/authed-stream.js";
import { resolveEngineStatus } from "../dashboard/panels/bot-builder/engine-gate.js";
import { createDbClient } from "../../db.js";
import { perchAttached } from "../shared/perch-attached.js";
import { getInteractiveEngine } from "../perch-interactive.js";
import { cwdList, cwdRead } from "../perch-files.js";
import { tasksDbPath } from "../../../scripts/pi-bots/instance-paths.mjs";
import { updateCard, getCard } from "../board/card-service.js";
import {
  loadDispatchableCard, parseDef, dispatchCard, assertBotUnblocked, startAfterGive, giveAudit, createTaskForBot,
  DASHBOARD_ACTOR,
} from "../board/give-service.js";
import { lockState } from "./board-lock.js";
import { resolveBoardDef, isTerminal } from "./board-defs.js";
import { ensureItem, assertLiveProject, threadCard } from "../../shared/shell-items.js";
import { acceptResult, decideResult } from "../board/result-service.js";
import { openDecisionsForThread } from "../board/decision-service.js";
import { laneState } from "./shell-api.js";
import { cardDrawerHref, drawerHref } from "../board/card-link.js";
import { buildBriefing, briefingText, briefingRefs, briefingEnabled, sessionSummary, forgetSummary, sessionBriefing, targetRankOf } from "../perch/briefing.js";
import { CONFIRM_OUTCOMES, openDecision } from "../dashboard/panels/board/lanes.js";
import { annotateAvailability } from "../model-availability.js";
import { providerModelListWarm, pickerModels, loadPiProviderNames, referencedModelKeys } from "../perch-model-catalog.js";
import { renderBotMarkdown } from "../../blog/renderer.js";
import { randomBytes } from "node:crypto";
import {
  loadBotRow, loadGiveTarget, getOffer, listOffers, claimOffer, renewLease, releaseClaim,
  settleOffer, findOfferCard, recoverThread, claimOfferNotes, unclaimOfferNotes, offerTag,
} from "../board/offer-service.js";

/** Mount prefix. Every route below is registered under it, after the auth gate. */
const P = "/dashboard/perch-api";

/** Inbound message cap — same value, same reasoning, as perch.js's MESSAGE_CAP. */
const MESSAGE_CAP = 32_000;

/** The instance-global tasks store — cards live ONLY here, never per-project
 * (Track 1 §board-truth). Resolved once at module load, same idiom as
 * bot-board-api.js's own TASKS_DB constant. */
const TASKS_DB = tasksDbPath();

// DASHBOARD_ACTOR lives in board/give-service.js

/** Accept / Ask for a change errors: 409 'already_decided' or 'stale' (anything else someone got
 * to first: a newer result, an archive), 404 'not_found', 400 'bad_request'. */
function resultRouteError(res, err, what) {
  if (err && err.http === 409) return jsonError(res, 409, err.code === "already_decided" ? "already_decided" : "stale");
  if (err && err.http === 404) return jsonError(res, 404, "not_found");
  if (err && err.http === 400) return jsonError(res, 400, "bad_request");
  if (/no such table/i.test(String(err && err.message))) return jsonError(res, 503, "not_migrated");
  console.warn("[perch-interactive-api] " + what + " failed:", err && err.message);
  return jsonError(res, 500, what + " failed");
}

/** POST /interactive/:sid/message images: cap 3 × 2 MB post-decode. */
const IMAGE_MESSAGE_CAP = 3;
const IMAGE_MESSAGE_BYTES_CAP = 2 * 1024 * 1024;

/** POST /interactive/:sid/files: base64 JSON body, cap 5 MB post-decode. */
const UPLOAD_BYTES_CAP = 5 * 1024 * 1024;

/** Extensions the workspace route serves inline (never `attachment`). */
const WORKSPACE_IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

/** Coordinator fix-wave follow-up (C2 residual): the SAME extension set as
 * WORKSPACE_IMAGE_EXTS above, mapped to a mime type — res.sendFile() used to
 * derive Content-Type from the `send`/`mime-types` packages automatically;
 * the fd-based rewrite (C2) dropped that, and the drawer's inline `<img
 * src>` path served an image with NO Content-Type next to the new nosniff
 * header, breaking inline rendering. No new dependency — this reuses
 * exactly the extensions the route already special-cases for the
 * image-inline decision. Anything outside this set (the `attachment` path)
 * gets the standard safe generic default; combined with
 * Content-Disposition: attachment + nosniff, the browser downloads it
 * rather than guessing/rendering it. */
const WORKSPACE_MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

// Test-only barrier (same idiom as routes/bundles.js's own
// _setInstallSetBarrierForTest): lets a test deterministically pause the
// workspace-serve route right after it has finished validating the file
// (open-by-fd + fstat + realpath jail check) and right before it streams —
// to prove a filesystem swap performed DURING that pause cannot change what
// gets served, without sleeping or racing wall-clock timing. Production
// default is null, so `if (_workspaceServeBarrier)` is never entered: no
// await, no timer.
let _workspaceServeBarrier = null;
export function _setWorkspaceServeBarrierForTest(promiseOrNull) {
  _workspaceServeBarrier = promiseOrNull || null;
}

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
  // 2026-10-20: a late answer to a question that expired (pi's dialog timed
  // out, or the turn was parked). Nothing was run; the clients say so.
  request_expired: [409, "request_expired"],
  no_turn: [409, "no_turn"],
  bad_request: [400, "bad_request"],
  // Acceptance F3: a blank steer is a client bug, not a silent 200.
  empty_message: [400, "empty_message"],
  // Track 3 Task 9 additions.
  card_occupied: [409, "card_occupied"],
  no_session_dir: [409, "no_session_dir"],
  // Open-anywhere C1: spawn/control with a cwd that is not an existing
  // directory. The route validates first (400 bad_cwd); buildBotWorld is the
  // belt-and-braces second gate and throws the same typed code.
  bad_cwd: [400, "bad_cwd"],
  // buildBotWorld: a carried-over world link ("Turn on a board") points at a
  // folder that is gone. The message names the link; nothing is busy.
  world_link_broken: [409, "world_link_broken"],
  cycle_busy: [409, "cycle_busy"],
  // control({planMode}) on a hibernating session (perch-interactive.js's own
  // `if (!s.pi) throw engineError("not_awake")` — plan mode always needs a
  // live child, never queued).
  not_awake: [409, "not_awake"],
  command_failed: [502, "command_failed"],
  // rename() on a session with no bot_sessions row yet: there is nothing to
  // write to, and minting a row would leave a phantom for a session that never
  // spawned. 409, not 500 — the refusal is honest and the session is fine.
  not_persisted: [409, "not_persisted"],
  // Strand 2: the session's model cannot take this bot's tool surface. 422,
  // not 409 — nothing is busy or gone; the request can't be served as is.
  // `detail` names the model, both numbers and the ways out.
  tool_budget: [422, "tool_budget"],
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
  // `detail` is the engine's human reason (pi_gone: pi's own exit message,
  // e.g. an unknown provider) so the drawer can say WHY, not just "pi_gone".
  if (mapped) {
    const detail = err && typeof err.detail === "string" && err.detail ? { detail: err.detail.slice(0, 1000) } : undefined;
    return jsonError(res, mapped[0], mapped[1], detail);
  }
  return jsonError(res, 500, String((err && err.message) || err));
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

// loadBotRow and loadGiveTarget ("Give to…" target check) live in board/offer-service.js, which
// a card offer is validated by at offer time (the same rules, one copy).

/** The give routes' wire response stays as before: startAfterGive also reports the
 * started thread id for the voice hand-off, which the HTTP contract never carried. */
function giveResponse({ threadId, ...out }) { return out; }

/** Giving a parent carries its subtree: card-service keeps a child in its
 * parent's project (createCard/updateCard re-inherit it), so a parent moved
 * alone would leave its children on no board anyone renders. Every live
 * (non-archived) descendant moves to `projectId`, one updateCard (one
 * board_mutations row) each — card-service has no transaction primitive, and
 * each write is independently valid. Archived descendants (and anything
 * under them) stay put. Returns how many moved. */
async function moveDescendants(tdb, parentId, projectId) {
  const seen = new Set([parentId]);
  let frontier = [parentId], n = 0;
  while (frontier.length) {
    const { rows } = await tdb.execute({
      sql: `SELECT id FROM tasks_items WHERE parent_id IN (${frontier.map(() => "?").join(",")}) AND board_id IS NULL AND archived_at IS NULL`,
      args: frontier,
    });
    frontier = [];
    for (const r of rows) {
      const id = Number(r.id);
      if (seen.has(id)) continue;
      seen.add(id);
      await updateCard(tdb, id, { project_id: projectId }, DASHBOARD_ACTOR);
      frontier.push(id);
      n++;
    }
  }
  return n;
}

// Test-only barrier (the _setWorkspaceServeBarrierForTest idiom): an async function the offer
// accept awaits right after its claim and before its lease check, so a test can hold an accept
// mid-flight across fake time. Production default null: never entered.
let _offerAcceptBarrier = null;
export function _setOfferAcceptBarrierForTest(fnOrNull) {
  _offerAcceptBarrier = typeof fnOrNull === "function" ? fnOrNull : null;
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
 * @param {Function} [seams.piProviders] what pi can resolve as --provider
 *   (perch-model-catalog.js loadPiProviderNames); null = unknown. Injected by
 *   tests so the picker's runnable check never reads this host's ~/.pi.
 */
/**
 * Stream one verified fd as a workspace download (shared by the outputs-dir
 * path and the delivered-files staging path).
 *
 * M1 (final review, folded into C2): quote-escape the filename before it lands
 * in a header (an embedded `"` could otherwise inject extra header syntax), and
 * pin off MIME sniffing. Coordinator fix-wave follow-up (C2 residual): a real
 * Content-Type (from the verified fd's extname) and Content-Length (from the
 * fstat already taken): inline images need the first to render, every client
 * the second. Streams from the fd (autoClose), never re-opening a path.
 */
function streamWorkspaceFd(res, fd, stat, nameForHeaders) {
  res.set("X-Content-Type-Options", "nosniff");
  const ext = extname(nameForHeaders).toLowerCase();
  res.set("Content-Type", WORKSPACE_MIME_BY_EXT[ext] || "application/octet-stream");
  res.set("Content-Length", String(stat.size));
  if (!WORKSPACE_IMAGE_EXTS.has(ext)) {
    res.set("Content-Disposition", `attachment; filename="${basename(nameForHeaders).replace(/"/g, '\\"')}"`);
  }
  const stream = createReadStream(null, { fd, autoClose: true });
  stream.on("error", () => {
    if (!res.headersSent) jsonError(res, 404, "not_found");
  });
  stream.pipe(res);
}

/** Files the bot sent (copies in the gateway-owned staging dir), for the list. */
function listDelivered(sid) {
  let dfd;
  try {
    dfd = openDeliveredDir(sid);
    const out = [];
    for (const name of readdirSync("/proc/self/fd/" + dfd)) {
      if (name.startsWith(".")) continue;
      let st;
      try { st = lstatSync("/proc/self/fd/" + dfd + "/" + name); } catch { continue; }
      if (st.isSymbolicLink() || !st.isFile()) continue;
      out.push({ name, size: st.size, mtime: Math.round(st.mtimeMs) });
    }
    return out;
  } catch { return []; }
  finally { if (dfd !== undefined) { try { closeSync(dfd); } catch { /* closed */ } } }
}

/** True when a sent file's copy is in the staging dir. */
function deliveredExists(sid, name) {
  let fd;
  try { fd = openDeliveredFile(sid, name); return fstatSync(fd).isFile(); } catch { return false; }
  finally { if (fd !== undefined) { try { closeSync(fd); } catch { /* closed */ } } }
}

export default function perchInteractiveApiRouter(dashboardAuth, { engine = getInteractiveEngine, annotate = annotateAvailability, providerModels = providerModelListWarm, piProviders = loadPiProviderNames, rankBriefingTarget = (db, key) => targetRankOf(db, key) } = {}) {
  /** pi's resolvable providers, or null when that cannot be read — the
   *  picker then marks nothing unrunnable rather than guess. */
  async function piNames(env) {
    try { return (await piProviders(env ? { env } : undefined)) || null; } catch { return null; }
  }
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

  // ---- GET /browse — server-backed directory listing for the launcher's
  // "open anywhere" picker (open-anywhere C1). Directory NAMES + paths only,
  // NEVER file contents, never file entries. Behind the same dashboardAuth as
  // every perch-api route (router.use(P, dashboardAuth) above) and NOT in
  // PUBLIC_FUNNEL_PREFIXES — the network invariant holds: private routes are
  // never funnel-reachable. The dashboard operator IS the machine owner, so
  // this is a picker, not a trust boundary.
  router.get(P + "/browse", (req, res) => {
    try {
      const q = req.query.path;
      const raw = (q == null || q === "") ? homedir() : String(q);
      // Expand a leading ~ (the shell idiom an operator pastes).
      const expanded = raw === "~" ? homedir()
        : raw.startsWith("~/") ? join(homedir(), raw.slice(2))
        : raw;
      // resolve() collapses any `..`/`.` harmlessly; the result is always
      // absolute, so traversal in the query can't escape into a relative read.
      const target = resolve(expanded);
      let real;
      try { real = realpathSync(target); } catch { return jsonError(res, 404, "unreadable"); }
      let entries;
      try { entries = readdirSync(real, { withFileTypes: true }); }
      catch { return jsonError(res, 404, "unreadable"); }
      const dirs = [];
      for (const e of entries) {
        // Keep directories; follow a symlink only when it resolves to a real
        // directory (statSync on the joined path), skipping one that errors or
        // lands on a file — never leak a file entry, never throw on a broken link.
        let isDir = false;
        if (e.isDirectory()) isDir = true;
        else if (e.isSymbolicLink()) {
          try { isDir = statSync(join(real, e.name)).isDirectory(); } catch { isDir = false; }
        }
        if (isDir) dirs.push({ name: e.name, path: join(real, e.name) });
      }
      // Dot-dirs kept but sorted last; alphabetical within each group. Cap 500
      // so a huge home dir can't balloon the response.
      dirs.sort((a, b) => {
        const ad = a.name.startsWith("."), bd = b.name.startsWith(".");
        if (ad !== bd) return ad ? 1 : -1;
        return a.name.localeCompare(b.name);
      });
      // `parent` is derived from the RESOLVED realpath (not the raw input) so
      // `..` navigation out of a symlinked dir doesn't ping-pong.
      res.json({ path: real, parent: dirname(real), dirs: dirs.slice(0, 500) });
    } catch (err) {
      mapEngineError(res, err);
    }
  });

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

      // Open-anywhere C1: an optional { cwd } points the session at an
      // operator-chosen directory. Validate here (the route is the first gate;
      // buildBotWorld is the second) — absolute, existing, a directory — else
      // 400 bad_cwd. An absent/empty cwd means "the bot's default" and is
      // never sent to the engine.
      const body = req.body && typeof req.body === "object" ? req.body : {};
      let cwd = null;
      if (body.cwd != null && body.cwd !== "") {
        const c = String(body.cwd);
        let ok = isAbsolute(c);
        if (ok) { try { ok = statSync(c).isDirectory(); } catch { ok = false; } }
        if (!ok) return jsonError(res, 400, "bad_cwd");
        cwd = c;
      }

      // Shell P1: an optional project_id files the new thread. Validated here,
      // before spawn, so a bad project never costs a session. "unassigned" files
      // it under no project; absent means the bot's own project, but only while
      // that project is live (else the thread starts Unassigned). Only the
      // project rule's own refusals (AclError) are bad_project; any other error
      // falls through to the route's error mapping.
      let projectId = null;
      const given = body.project_id !== undefined && body.project_id !== null && body.project_id !== "";
      if (given) {
        if (body.project_id !== "unassigned") {
          const n = typeof body.project_id === "number" ? body.project_id : (/^[1-9]\d*$/.test(String(body.project_id)) ? Number(body.project_id) : NaN);
          if (!Number.isInteger(n) || n < 1) return jsonError(res, 400, "bad_project");
          try { await assertLiveProject(db, n); } catch (err) {
            if (err && err.name === "AclError") return jsonError(res, 400, "bad_project");
            throw err;
          }
          projectId = n;
        }
      } else if (row && row.project_id != null) {
        // Filing is best effort and must never block the spawn: any failure here is Unassigned.
        try { projectId = (await assertLiveProject(db, Number(row.project_id))).id; }
        catch (err) { if (!(err && err.name === "AclError")) console.warn("[perch] could not check the bot's project:", err.message); }
      }

      // R1.2 PR 4: { briefing: true } asks for the project's briefing. The
      // server rebuilds it from the DB itself; no client text is ever read.
      // Best effort: a failure here starts the session without one.
      // It carries only what the receiving model may see: targetRank is where
      // the bot's model runs (unknown counts as the cloud).
      // briefingRefs: the thread ids it quotes, so a Forget can strip one later.
      let briefing = null, briefingRank = null, refs = [];
      if (body.briefing === true && projectId != null && briefingEnabled()) {
        try {
          briefingRank = await rankBriefingTarget(db, def.models && def.models.default);
          const fragments = await buildBriefing(db, { projectId, targetRank: briefingRank }, { tasksDbPath: TASKS_DB });
          briefing = briefingText(fragments) || null;
          refs = briefing ? briefingRefs(fragments) : [];
        } catch { console.warn("[perch] could not build the briefing"); briefing = null; refs = []; }
      }

      const eng = resolveEngine();
      // The owner's own dashboard: the one place a Perch spawn is the owner's
      // turn (project services, plan decision 1; the engine has no default).
      const result = await eng.spawn(briefing ? { botId, cwd, briefing, briefingRank, briefingRefs: refs, principal: "owner" } : { botId, cwd, principal: "owner" });
      if (result && result.threadId) {
        // The session is already running: a filing failure must not fail the spawn.
        try { await ensureItem(db, "perch_thread", result.threadId, { projectId, setBy: given ? "operator" : "origin" }); }
        catch (err) { console.warn("[perch] could not file the new thread:", err.message); }
      }
      res.status(201).json(result);
    } catch (err) {
      mapEngineError(res, err);
    } finally {
      try { db.close(); } catch { /* already closed */ }
    }
  });

  // ---- GET /bots/:id/models — the launcher's model list, no session needed ----
  // The picker beside "New session" has to offer a model BEFORE the session
  // that would list one exists, and `GET /interactive/:sid/options` cannot
  // help: it is keyed on a session id. This is that list, from the same
  // session-free catalogue options() falls back to (perch-model-catalog.js) —
  // one source, so the launcher and a hibernating session's drawer can never
  // show two different answers about what this instance serves.
  //
  // SAME GATES AS THE SPAWN ROUTE ABOVE, in the same order and for the same
  // reasons: a bot that would 403 on spawn must not be offered a model list.
  // Anything else would let the launcher build a picker for a session it can
  // never start.
  //
  // `default` is the bot's own configured model (definition.models.default,
  // the "provider/id" key model_resolver.mjs reads), so the client can open
  // pre-selected on it and launching stays one tap. It is reported even when
  // no catalogue entry matches it — a default naming a provider row that has
  // since been disabled is a fact the operator should see, not one to hide.
  router.get(P + "/bots/:id/models", async (req, res) => {
    const botId = String(req.params.id);
    const db = createDbClient();
    try {
      const row = await loadBotRow(db, botId);
      if (resolveEngineStatus().state !== "ready") return jsonError(res, 409, "engine_required");
      const def = row ? parseDef(row) : {};
      if (!perchAttached(def)) return jsonError(res, 403, "perch_not_attached");

      // Annotated for the same reason the options route annotates: an
      // unavailable model must be visibly unavailable, never silently
      // selectable (model-availability.js's header).
      // awaited: the catalogue warms a cold provider cache rather than
      // serving the empty list loadProviders() answers on a fresh process.
      const dflt = def.models && typeof def.models.default === "string" && def.models.default
        ? def.models.default : null;
      // The picker view (perch-model-catalog.js pickerModels): grouped
      // network/cloud, one entry per endpoint+model, ordered default-first,
      // and each marked whether pi can spawn on it at all. Every bot's
      // configured keys count as "referenced", so an alias some bot names is
      // the one kept when its siblings collapse into it.
      let referenced = new Set();
      try {
        const { rows } = await db.execute("SELECT definition FROM pi_bot_defs WHERE enabled = 1");
        referenced = referencedModelKeys(rows);
      } catch { /* no bot table is no references, not a failed list */ }
      // The env the bot's pi will actually get: the gateway's plus the bot's
      // own spawn_env (bridge.mjs merges it), which may point pi at another
      // agent dir or carry a provider key (fix round 1 M6).
      const spawnEnv = def.spawn_env && typeof def.spawn_env === "object" ? def.spawn_env : null;
      const models = pickerModels(await annotate(await providerModels()), {
        defaultKey: dflt, referenced,
        pi: await piNames(spawnEnv ? { ...process.env, ...spawnEnv } : null),
      });
      res.json({ models, default: dflt });
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
    // Card offers (redesign P5): the bot learns of a card made from its offer from ONE fixed
    // gateway line ahead of its next turn's prompt, never bot-chosen text. Each offer's line is
    // claimed (note_delivered_at) before it is prefixed, so it goes out once; a turn that never
    // started hands the claim back for the next message. A blank message is left blank, so the
    // engine still refuses it. Best effort: a store error here never blocks the message.
    let notes = { lines: [], claims: [] };
    let ndb = null;
    if (message.trim()) {
      try {
        ndb = createDbClient();
        notes = await claimOfferNotes(ndb, sid);
      } catch (e) {
        console.warn("[perch-interactive-api] offer note claim failed:", e.message);
      }
    }
    try {
      const eng = resolveEngine();
      const text = notes.lines.length ? notes.lines.join("\n") + "\n\n" + message : message;
      // The owner typed it here (the offer lines are fixed gateway text).
      const result = await eng.message(sid, text, images, { principal: "owner" });
      res.status(202).json({ turnId: result.turnId });
    } catch (err) {
      if (notes.claims.length) {
        try { await unclaimOfferNotes(ndb, notes.claims); } catch (e) { console.warn("[perch-interactive-api] offer note unclaim failed:", e.message); }
      }
      mapEngineError(res, err);
    } finally {
      if (ndb) { try { ndb.close(); } catch { /* already closed */ } }
    }
  });

  // ---- POST /interactive/:sid/steer — nudge an IN-FLIGHT turn ----
  // Task 13 (controller ruling): the drawer's composer relabels to this while
  // a turn is running (POST message would 409 turn_in_progress). Same
  // MESSAGE_CAP slice as message() above; refusals fall through mapEngineError
  // (no_turn/pi_gone/session_stopped — see engine.steer()'s own doc).
  router.post(P + "/interactive/:sid/steer", async (req, res) => {
    const sid = String(req.params.sid);
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const message = String(body.message == null ? "" : body.message).slice(0, MESSAGE_CAP);
    try {
      const eng = resolveEngine();
      const result = await eng.steer(sid, message);
      res.json(result);
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
    /* Bot output is markdown. It is rendered HERE, on the server, by
       `renderBotMarkdown` (renderMarkdown's marked + sanitize-html allow-list,
       plus TeX math shown once as source) — the same function the transcript
       endpoint uses, so live and reload match. The client cannot import a server
       module, and must never be handed a markdown parser plus untrusted model
       output. Carried ALONGSIDE the raw text rather than replacing it: a
       frame whose render fails arrives with no `html` and the client falls
       back to textContent, which is exactly today's behaviour.

       On the frame rather than through a per-message endpoint, because that
       would cost a round trip per message on a phone; and every bot message
       already passes through this one function. Message-level streaming means
       every frame carries a COMPLETE message (perch-interactive.js:1257), so
       there is no partial markdown to render and nothing to swap afterwards.

       `text` and `reply` only: `log`, `tool` and `error` are gateway chrome,
       not model prose. */
    const withHtml = (event) => {
      if (!event || (event.type !== "text" && event.type !== "reply")) return event;
      if (typeof event.text !== "string" || !event.text.trim()) return event;
      try {
        const html = renderBotMarkdown(event.text);
        return html ? { ...event, html } : event;
      } catch {
        return event;                                // the client's textContent path
      }
    };
    const forward = (event) => { const e = withHtml(event); stream.send(e.type, e); };

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
    const note = body.note == null ? "" : String(body.note).slice(0, MESSAGE_CAP);
    if (cardId == null) return jsonError(res, 400, "bad_request");

    const db = createDbClient();
    const ctx = { db, tdb: null };
    try {
      const row = await loadBotRow(db, botId);
      const result = await dispatchCard(ctx, { row, getEng: resolveEngine, botId, cardId, note, principal: "owner" });
      res.status(201).json(result);
    } catch (err) {
      mapEngineError(res, err);
    } finally {
      try { db.close(); } catch { /* already closed */ }
      if (ctx.tdb) { try { ctx.tdb.close(); } catch { /* already closed */ } }
    }
  });

  // ---- POST /cards/:id/give — put a card on a bot's board ("Give to…") ----
  // Queue item 20, PR 2. Body {bot_id, start?, note?}. CSRF-railed (this
  // router mounts after csrfMiddleware), session-gated, never public. Steps:
  // the card is a live card (404/400/409 archived), top level (400
  // bad_request for a subtask: it lives in its parent's project), not locked
  // by a session or job (409 locked), the bot can take it (loadGiveTarget:
  // 400 bot_unavailable / 409 no_board), not finished (409 finished:
  // terminal on the target or current board); then ONE updateCard write
  // (project_id + assigned_bot, one board_mutations row, autonomy untouched
  // so it stays gated), the card's live subtree moved with it
  // (moveDescendants), and one card_given audit row (with a children count
  // when any moved); then, only on start:true, the dispatch core — whose
  // engine getter is resolved only once a start can actually run. Single-operator dashboard: no project_members check, the
  // session-authenticated operator owns the box (same as every route here).
  router.post(P + "/cards/:id/give", async (req, res) => {
    const cardId = /^\d+$/.test(String(req.params.id)) ? Number(req.params.id) : null;
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const botId = typeof body.bot_id === "string" && body.bot_id ? body.bot_id : null;
    if (cardId == null || !botId) return jsonError(res, 400, "bad_request");
    const note = body.note == null ? "" : String(body.note).slice(0, MESSAGE_CAP);

    const db = createDbClient();
    const ctx = { db, tdb: null };
    try {
      ctx.tdb = createDbClient(TASKS_DB);
      const cur = await loadDispatchableCard(ctx.tdb, cardId);
      // A subtask lives in its parent's project — give the parent instead.
      if (cur.parent_id != null) return jsonError(res, 400, "bad_request");
      const lock = await lockState(db, cardId);
      if (lock.locked) return jsonError(res, 409, "locked", { rail: lock.rail });
      const row = await loadGiveTarget(db, botId);
      const projectId = Number(row.project_id);
      // A finished card is not a task to give: terminal per the TARGET
      // board's definition or the card's CURRENT one (each the builtin
      // default when the board has none — an unassigned card's case).
      const finished = isTerminal(await resolveBoardDef(ctx.tdb, { projectId }), cur.status)
        || isTerminal(await resolveBoardDef(ctx.tdb, { projectId: cur.project_id }), cur.status);
      if (finished) return jsonError(res, 409, "finished");
      await updateCard(ctx.tdb, cardId, { project_id: projectId, assigned_bot: botId }, DASHBOARD_ACTOR);
      const children = await moveDescendants(ctx.tdb, cardId, projectId);
      await giveAudit(db, row, cardId, { start: body.start === true, ...(children ? { children } : {}) });
      res.json(giveResponse(await startAfterGive(ctx, { row, getEng: resolveEngine, botId, cardId, start: body.start, note, principal: "owner" })));
    } catch (err) {
      mapEngineError(res, err);
    } finally {
      try { db.close(); } catch { /* already closed */ }
      if (ctx.tdb) { try { ctx.tdb.close(); } catch { /* already closed */ } }
    }
  });

  // ---- POST /bots/:id/tasks — a NEW task straight onto a bot's board ----
  // The "Give <Name> a task" dialog's textarea. Body {title, start?, note?}.
  // Same bot gate and same start path as the give route above; the card is
  // born on the bot's project with its assigned_bot (one create row) and
  // the builtin gated autonomy.
  router.post(P + "/bots/:id/tasks", async (req, res) => {
    const botId = String(req.params.id);
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const title = typeof body.title === "string" ? body.title.trim().slice(0, 500) : "";
    if (!title) return jsonError(res, 400, "bad_request");
    const note = body.note == null ? "" : String(body.note).slice(0, MESSAGE_CAP);

    const db = createDbClient();
    const ctx = { db, tdb: null };
    try {
      const { cardId, row } = await createTaskForBot(db, () => (ctx.tdb = createDbClient(TASKS_DB)), botId,
        { title, audit: { start: body.start === true } });
      res.json(giveResponse(await startAfterGive(ctx, { row, getEng: resolveEngine, botId, cardId, start: body.start, note, principal: "owner" })));
    } catch (err) {
      mapEngineError(res, err);
    } finally {
      try { db.close(); } catch { /* already closed */ }
      if (ctx.tdb) { try { ctx.tdb.close(); } catch { /* already closed */ } }
    }
  });

  // ---- GET /interactive/:sid/offers — this chat's card offers (redesign P5) ----
  // Before answering, any of this thread's offers left "accepted, no card" (a crash between the
  // create and the settle) goes through recoverOffer: settled to its tagged card, or reopened once
  // its lease expired. A recovery that cannot run (tasks.db busy) never blocks the read.
  router.get(P + "/interactive/:sid/offers", async (req, res) => {
    const sid = String(req.params.sid);
    const db = createDbClient();
    let tdb = null;
    try {
      try {
        // tasks.db opens only when this thread has a stranded offer (runOfferSweep's rule).
        tdb = await recoverThread(db, () => (tdb = createDbClient(TASKS_DB)), sid);
      } catch (e) {
        console.warn("[perch-interactive-api] offer recovery skipped:", e.message);
      }
      res.json({ offers: await listOffers(db, sid) });
    } catch (err) {
      mapEngineError(res, err);
    } finally {
      try { db.close(); } catch { /* already closed */ }
      if (tdb) { try { tdb.close(); } catch { /* already closed */ } }
    }
  });

  // ---- POST /offers/:id/decide — the operator's one tap on a card offer ----
  // Body {accept: boolean}. CSRF-railed (mounted after csrfMiddleware), session-gated.
  // Decline: one guarded UPDATE. Accept, in order:
  //   1. claim (pending -> accepted + claim_token + a 120 s lease; 409 already_decided on a
  //      second tap or a second device);
  //   1b. the lease check right before the create (0 rows = a sweep or another accept took it
  //      over: 409 already_decided, nothing created);
  //   2. createTaskForBot on the bot's own board, tagged crow-offer-<id>;
  //   3. settle card_id;
  //   4. link the chat (checkCardFree + attachCard writes bot_sessions.card_id) only when the chat
  //      has no card yet and the session is attachable right now; otherwise skip it — the card is
  //      made either way and the chat shows the card note (there is no link-on-wake).
  // A failure in 2 with no card made puts the offer back to pending. A failure once a card exists
  // never resets the offer (C8): recoverOffer settles it on the next read or sweep. Accepting
  // starts no turn and sends no message.
  router.post(P + "/offers/:id/decide", async (req, res) => {
    const offerId = /^\d+$/.test(String(req.params.id)) ? Number(req.params.id) : null;
    const body = req.body && typeof req.body === "object" ? req.body : {};
    if (offerId == null || typeof body.accept !== "boolean") return jsonError(res, 400, "bad_request");

    const db = createDbClient();
    let tdb = null;
    try {
      const offer = await getOffer(db, offerId);
      if (!offer) return jsonError(res, 404, "not_found");
      if (!body.accept) {
        await claimOffer(db, offerId, "declined");
        return res.json({ ok: true, status: "declined" });
      }

      const token = randomBytes(16).toString("hex");
      await claimOffer(db, offerId, "accepted", { claimToken: token });
      if (_offerAcceptBarrier) await _offerAcceptBarrier({ offerId });
      if (!(await renewLease(db, offerId, token))) return jsonError(res, 409, "already_decided");

      tdb = createDbClient(TASKS_DB);
      let cardId, projectId = Number(offer.project_id);
      try {
        const made = await createTaskForBot(db, tdb, String(offer.bot_id), { title: String(offer.title), tags: offerTag(offerId) });
        cardId = made.cardId;
        projectId = Number(made.row.project_id);
      } catch (err) {
        // Did a card get made before the failure (createCard's insert landed, then its mutation
        // row or the audit failed)? Then it is this offer's card. If that can't be told (tasks.db
        // unreadable), the offer stays accepted and the lease + recovery decide it.
        let found;
        if (Number.isInteger(err && err.cardId)) found = err.cardId;
        else { try { found = await findOfferCard(tdb, offerId, offer.bot_id); } catch { found = undefined; } }
        if (found == null) {
          if (found === null) {
            try { await releaseClaim(db, offerId, token); } catch (e) { console.warn("[perch-interactive-api] offer release failed:", e.message); }
          }
          return mapEngineError(res, err);
        }
        console.warn(`[perch-interactive-api] offer ${offerId}: card ${found} was made, then:`, err && err.message);
        cardId = found;
        try {
          const r = (await tdb.execute({ sql: "SELECT project_id FROM tasks_items WHERE id=?", args: [cardId] })).rows[0];
          if (r && r.project_id != null) projectId = Number(r.project_id);
        } catch { /* keep the bot's project as the best answer */ }
      }

      try {
        await settleOffer(db, offerId, cardId, projectId);
      } catch (e) {
        console.warn(`[perch-interactive-api] offer ${offerId}: settle failed (recovery will settle it):`, e.message);
      }

      let attached = false;
      try {
        // A chat that already has a card keeps it: accepting an offer never re-links the chat.
        if ((await threadCard(db, String(offer.thread_id))) != null) throw Object.assign(new Error("chat already has a card"), { code: "has_card" });
        const eng = resolveEngine();
        await eng.checkCardFree(cardId, { excludeSessionId: String(offer.thread_id) });
        await eng.attachCard(String(offer.thread_id), cardId);
        attached = true;
      } catch (e) {
        const code = e && e.code;
        if (code !== "no_such_session" && code !== "session_stopped" && code !== "has_card") {
          console.warn(`[perch-interactive-api] offer ${offerId}: card ${cardId} made, chat not linked:`, (e && e.message) || e);
        }
      }
      res.json({ ok: true, status: "accepted", cardId, projectId, attached });
    } catch (err) {
      mapEngineError(res, err);
    } finally {
      try { db.close(); } catch { /* already closed */ }
      if (tdb) { try { tdb.close(); } catch { /* already closed */ } }
    }
  });

  // ---- GET /interactive/:sid/card — this chat's card, its open result, its questions (P5) ----
  //   { card: { id, title, status, lane, projectId, botId, href } | null,
  //     result: { id, outcome, summaryMd } | null,       the card's NEWEST result, only while recorded
  //     decisions: [{ cardId, question, options: [{ index, label, consequence, recommended }] }] }
  // `card` is threadCard's card with the lane the Board computes (shell-api laneState); a missing or
  // archived card is null. `decisions` are the open decision cards asked FROM this chat
  // ($.decision.source.thread_id, written only from the signed actor.thread), newest 3.
  // The bot whose board shows the card: the card's assigned_bot, else this chat's own bot (the
  // classic board resolves a card only on the selected bot's board). Kept for an older client; the
  // chip's Details now follows `href`, the one "open this card" rule (board/card-link.js
  // cardDrawerHref, Ruling Q14: the card's own project's board bot, never this chat's on another).
  async function cardBotId(db, cardRow, sid) {
    if (cardRow.assigned_bot) return String(cardRow.assigned_bot);
    try {
      const r = (await db.execute({
        sql: "SELECT bot_id FROM bot_sessions WHERE gateway_thread_id=? AND kind='perch-live' ORDER BY id DESC LIMIT 1",
        args: [String(sid)],
      })).rows[0];
      return r && r.bot_id ? String(r.bot_id) : null;
    } catch { return null; }
  }

  router.get(P + "/interactive/:sid/card", async (req, res) => {
    const sid = String(req.params.sid);
    const db = createDbClient();
    let tdb = null;
    try {
      const cardId = await threadCard(db, sid);
      let card = null, result = null, decisions = [];
      if (existsSync(TASKS_DB)) {
        tdb = createDbClient(TASKS_DB);
        if (cardId != null) {
          const st = await laneState(tdb, db, cardId);
          if (st) {
            card = {
              id: Number(st.card.id), title: String(st.card.title ?? ""), status: String(st.card.status),
              lane: st.lane, projectId: st.card.project_id == null ? null : Number(st.card.project_id),
              botId: await cardBotId(db, st.card, sid),
              href: (await cardDrawerHref(db, Number(st.card.id), { tasksDb: tdb })) || drawerHref(st.card.id, null),
            };
            if (st.latestResult && st.latestResult.status === "recorded") {
              const r = (await tdb.execute({
                sql: "SELECT id, outcome, summary_md FROM board_results WHERE id=? AND status='recorded'",
                args: [st.latestResult.id],
              })).rows[0];
              if (r) result = { id: Number(r.id), outcome: String(r.outcome), summaryMd: String(r.summary_md ?? "") };
            }
          }
        }
        try {
          decisions = await openDecisionsForThread(tdb, sid, { limit: 3 });
        } catch (e) {
          if (!/no such (table|column)/i.test(String(e && e.message))) throw e;
        }
      }
      res.json({ card, result, decisions });
    } catch (err) {
      mapEngineError(res, err);
    } finally {
      try { db.close(); } catch { /* already closed */ }
      if (tdb) { try { tdb.close(); } catch { /* already closed */ } }
    }
  });

  // ---- GET /interactive/:sid/briefing — the Briefing card and the summary ----
  // R1.2 PR 4. `briefing` is what the session's child actually received:
  // null with CROW_SESSION_BRIEFING=0, and null when this wake withheld the
  // block (a less private model) or had none. A session whose child has not
  // started in this process (after a restart, before its wake) shows the DB's
  // block, the one its next wake is given when the rank allows.
  // `summary` is the thread's own summary for the sheet's Session tab. Read-only.
  router.get(P + "/interactive/:sid/briefing", async (req, res) => {
    const sid = String(req.params.sid);
    const db = createDbClient();
    try {
      let briefing = null;
      if (briefingEnabled()) {
        let eng = null;
        try { eng = resolveEngine(); } catch { eng = null; }
        const delivered = eng && typeof eng.briefingDelivered === "function" ? eng.briefingDelivered(sid) : undefined;
        if (delivered !== undefined) briefing = delivered || null;
        else {
          // From the DB, the briefing's source of truth (survives a restart).
          const b = await sessionBriefing(db, sid);
          briefing = b ? b.text : null;
        }
      }
      res.json({ briefing, summary: await sessionSummary(db, sid) });
    } catch (err) {
      mapEngineError(res, err);
    } finally {
      try { db.close(); } catch { /* already closed */ }
    }
  });

  // ---- POST /interactive/:sid/forget-summary — Forget (sheet → Session) ----
  // Deletes the summary's memory through the memory-write path (the delete
  // syncs) and clears the row's summary columns. Session-authed + CSRF (the
  // dashboard router's rails, see this router's mount). 404 when there was
  // nothing to forget.
  router.post(P + "/interactive/:sid/forget-summary", async (req, res) => {
    const sid = String(req.params.sid);
    const db = createDbClient();
    try {
      const r = await forgetSummary(db, sid);
      if (!r.forgotten) return jsonError(res, 404, "no_summary");
      res.json({ ok: true });
    } catch (err) {
      mapEngineError(res, err);
    } finally {
      try { db.close(); } catch { /* already closed */ }
    }
  });

  // ---- POST /cards/:id/accept — Accept in the chat: approve the result AND close the card ----
  // Body { result_id, accept_failure? }. result_id is the result the chat SHOWED: acceptResult
  // approves it only while it is the card's newest (newest-in-UPDATE), so a newer report is 409
  // 'stale' and a second tap (or the classic board deciding first) is 409 'already_decided'.
  // Ruling P16: a failure or partial result needs accept_failure: true (409 'confirm_failure'
  // without it, nothing written), the lane route's rule. The outcome checked is the shown result's
  // own, and that is the row the guarded write approves. An open decision on the card is 409
  // 'answer_first' (Ruling P2, R-P5-7), nothing written.
  router.post(P + "/cards/:id/accept", async (req, res) => {
    const b = req.body && typeof req.body === "object" ? req.body : {};
    if (!/^[1-9]\d*$/.test(String(req.params.id)) || !Number.isInteger(b.result_id) || b.result_id < 1) {
      return jsonError(res, 400, "bad_request");
    }
    const id = Number(req.params.id);
    if (!existsSync(TASKS_DB)) return jsonError(res, 404, "not_found");
    let tdb, cdb;
    try {
      tdb = createDbClient(TASKS_DB);
      cdb = createDbClient();
      const row = (await tdb.execute({
        sql: "SELECT outcome FROM board_results WHERE id=? AND item_id=?",
        args: [b.result_id, id],
      })).rows[0];
      if (!row) return jsonError(res, 404, "not_found");
      // Ruling P2 / R-P5-7: an open decision on the card is answered first, as on the Board.
      const card = await getCard(tdb, id);
      if (!card) return jsonError(res, 404, "not_found");
      if (openDecision(card)) return jsonError(res, 409, "answer_first", { reason: "answer_first" });
      if (CONFIRM_OUTCOMES.includes(String(row.outcome)) && b.accept_failure !== true) {
        return jsonError(res, 409, "confirm_failure", { reason: "confirm_failure" });
      }
      const r = await acceptResult(tdb, cdb, id, b.result_id, DASHBOARD_ACTOR, "perch");
      res.json({ ok: true, status: r.status, moved: r.moved === true });
    } catch (err) {
      resultRouteError(res, err, "accept");
    } finally {
      if (tdb) { try { tdb.close(); } catch { /* already closed */ } }
      if (cdb) { try { cdb.close(); } catch { /* already closed */ } }
    }
  });

  // ---- POST /cards/:id/request-change — Ask for a change: reject the shown result, move nothing ----
  // Body { result_id, text } (text 1-4000 characters). The same newest check as Accept, inside the
  // guarded decide (newestOnly), then decided_via 'perch'. The card stays where it is. The client
  // sends `text` to the bot itself, as the operator's own message in this chat.
  router.post(P + "/cards/:id/request-change", async (req, res) => {
    const b = req.body && typeof req.body === "object" ? req.body : {};
    if (!/^[1-9]\d*$/.test(String(req.params.id)) || !Number.isInteger(b.result_id) || b.result_id < 1) {
      return jsonError(res, 400, "bad_request");
    }
    if (typeof b.text !== "string" || !b.text.trim() || b.text.length > 4000) return jsonError(res, 400, "bad_request");
    const id = Number(req.params.id);
    if (!existsSync(TASKS_DB)) return jsonError(res, 404, "not_found");
    let tdb;
    try {
      tdb = createDbClient(TASKS_DB);
      const card = (await tdb.execute({ sql: "SELECT archived_at FROM tasks_items WHERE id=? AND board_id IS NULL", args: [id] })).rows[0];
      if (!card) return jsonError(res, 404, "not_found");
      if (card.archived_at != null) return jsonError(res, 409, "stale");
      const row = (await tdb.execute({ sql: "SELECT id FROM board_results WHERE id=? AND item_id=?", args: [b.result_id, id] })).rows[0];
      if (!row) return jsonError(res, 404, "not_found");
      await decideResult(tdb, id, b.result_id, "rejected", DASHBOARD_ACTOR, "perch", { newestOnly: true });
      res.json({ ok: true });
    } catch (err) {
      resultRouteError(res, err, "request-change");
    } finally {
      if (tdb) { try { tdb.close(); } catch { /* already closed */ } }
    }
  });

  // ---- POST /interactive/:sid/attach-card — bind an existing session to a card ----
  router.post(P + "/interactive/:sid/attach-card", async (req, res) => {
    const sid = String(req.params.sid);
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const cardId = parseCardId(body);
    if (cardId == null) return jsonError(res, 400, "bad_request");

    let tdb, cdb;
    try {
      tdb = createDbClient(TASKS_DB);
      await loadDispatchableCard(tdb, cardId);

      const eng = resolveEngine();
      // The session's bot is checked BEFORE anything is claimed: attachCard
      // claims the card and writes the row, so a late refusal would leave the
      // session bound. A null snap falls through to attachCard's own
      // no_such_session handling.
      const snap = await eng.get(sid);
      if (snap) {
        cdb = createDbClient();
        await assertBotUnblocked(cdb, snap.botId);
      }
      // Fix round 1 (coordinator-reported Important): exclude THIS session's
      // own perch-live row from the occupancy check — otherwise a session
      // re-asserting the card it already holds 409s against itself, and
      // attachCard()'s documented idempotent no-op path is unreachable over
      // HTTP. Every OTHER claimant (a different session, a different card)
      // still 409s — see checkCardFree's own doc.
      await eng.checkCardFree(cardId, { excludeSessionId: sid });
      const result = await eng.attachCard(sid, cardId);

      await updateCard(tdb, cardId, { assigned_bot: result.botId }, DASHBOARD_ACTOR);

      res.json({ ok: true, cardId });
    } catch (err) {
      mapEngineError(res, err);
    } finally {
      if (cdb) { try { cdb.close(); } catch { /* already closed */ } }
      if (tdb) { try { tdb.close(); } catch { /* already closed */ } }
    }
  });

  // ---- POST /interactive/:sid/control — model / thinking / permission / plan mode ----
  // Route bodies use snake_case (permission_mode, plan_mode) — mapped to the
  // engine's camelCase here, the ONE place that translation happens. `model`
  // accepts {provider, id} (the shape options()'s listings hand back) and
  // maps id→modelId for the engine.
  //
  // Fix round 3 R1: an explicit `"model": null` in the body REVOKES the
  // operator's choice (the drawer's "the bot's own model" option) — the next
  // wake re-resolves from the def. Presence is therefore keyed on the key,
  // not on truthiness, the same hasOwnProperty idiom plan_mode already uses;
  // a body without `model` stays untouched, exactly as before.
  router.post(P + "/interactive/:sid/control", async (req, res) => {
    const sid = String(req.params.sid);
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const opts = {};
    if (Object.prototype.hasOwnProperty.call(body, "model")) {
      opts.model = body.model && typeof body.model === "object"
        ? { provider: body.model.provider, modelId: body.model.id }
        : null;
    }
    if (body.thinking != null) opts.thinking = body.thinking;
    if (body.permission_mode != null) opts.permissionMode = body.permission_mode;
    if (Object.prototype.hasOwnProperty.call(body, "plan_mode")) opts.planMode = body.plan_mode;
    // Open-anywhere C1: forward an explicit cwd to control() — the engine
    // validates it (absolute/existing/directory → bad_request) and hibernates
    // an awake child so the next message wakes in the new dir. Keyed on
    // presence, like plan_mode, so a body without cwd leaves it untouched.
    if (Object.prototype.hasOwnProperty.call(body, "cwd")) opts.cwd = body.cwd;
    try {
      const eng = resolveEngine();
      const result = await eng.control(sid, opts);
      res.json(result);
    } catch (err) {
      mapEngineError(res, err);
    }
  });

  // ---- POST /interactive/:sid/rename — name a session, or clear its name ----
  // The operator's report was "there is not a way to rename the sessions".
  // The engine's `perchlive-xxxxxxxx` stays the identity; this is the
  // convenience name rendered beside it. An empty/whitespace body CLEARS the
  // name (the engine's normalizeLabel returns null) — clearing is a real
  // action, and the row falls back to the short id it always had. No
  // confirmation anywhere on this path: renaming is reversible and cheap,
  // unlike /stop.
  //
  // The body cap lives in the ENGINE (LABEL_CAP), not here: the value is
  // written to a row and re-rendered from it, so the one place that can
  // guarantee what is stored is the writer. The route's own slice is only a
  // parser guard against a megabyte of JSON string.
  router.post(P + "/interactive/:sid/rename", async (req, res) => {
    const sid = String(req.params.sid);
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const label = String(body.label == null ? "" : body.label).slice(0, MESSAGE_CAP);
    try {
      const eng = resolveEngine();
      const result = await eng.rename(sid, label);
      res.json(result);
    } catch (err) {
      mapEngineError(res, err);
    }
  });

  // ---- POST /interactive/:sid/archive + /unarchive — roster visibility ----
  // PR-C (audit item 14): archive HIDES a session from the roost's live list
  // without stopping it (a live child keeps running — pi-lab's exact
  // semantics); unarchive brings it back. Both are a pure bot_sessions.
  // archived_at write through the engine's setArchived — no child is touched,
  // no confirmation needed (reversible, like rename). An unknown/never-spawned
  // sid 404s no_such_session via the engine's rowsAffected check.
  router.post(P + "/interactive/:sid/archive", async (req, res) => {
    try {
      const eng = resolveEngine();
      res.json(await eng.setArchived(String(req.params.sid), true));
    } catch (err) {
      mapEngineError(res, err);
    }
  });
  router.post(P + "/interactive/:sid/unarchive", async (req, res) => {
    try {
      const eng = resolveEngine();
      res.json(await eng.setArchived(String(req.params.sid), false));
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
  // Each model carries an `availability` (up | on_demand | unavailable) so the
  // picker can say which choices actually work. Without it a provider row
  // pointing at a windowed endpoint (`crow-dsv4` → 127.0.0.1:8020) is
  // indistinguishable from a serving one, and picking it fails every turn on
  // connection refused.
  //
  // A HIBERNATING session no longer answers `models: null` here: the engine
  // falls back to the session-free provider catalogue (perch-interactive.js's
  // options() doc), so the list annotated below is the child's when there is a
  // child and the instance's otherwise. `thinkingLevels` is still null in that
  // state — control()'s thinking branch does nothing without a child — and a
  // null of either kind is passed through untouched for the drawer to disable
  // that one picker on.
  router.get(P + "/interactive/:sid/options", async (req, res) => {
    try {
      const eng = resolveEngine();
      const result = await eng.options(String(req.params.sid));
      // Same picker view as the launcher's list. A LIVE child's list is pi's
      // own get_available_models, so every entry is one pi resolved
      // (runnableAll); the hibernating fallback is the provider catalogue and
      // gets the real check. The session's current model is "referenced", so
      // the alias it is actually on is the one that survives the dedupe and
      // the drawer can still select it.
      const models = Array.isArray(result && result.models)
        ? pickerModels(await annotate(result.models), {
            referenced: [result.current],
            runnableAll: result.source === "child",
            pi: result.source === "child" ? null : await piNames(),
          })
        : (result && result.models) || null;
      res.json({ ...result, models });
    } catch (err) {
      mapEngineError(res, err);
    }
  });

  // ---- GET /interactive/:sid/commands — the composer's "/" menu feed ----
  // Wave 3: pi's own get_commands registry, relayed by the engine (awake
  // only; a hibernating child answers {commands:[], hibernating:true} and
  // the menu says so instead of faking an empty list). Under the same
  // dashboardAuth as every perch-api route; the engine maps the names, the
  // client renders them with textContent.
  router.get(P + "/interactive/:sid/commands", async (req, res) => {
    try {
      const eng = resolveEngine();
      const out = await eng.commands(String(req.params.sid));
      res.json(out);
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

      // C1 (final review): a prompt-injected pi child can pre-plant
      // <uploadsDir>/<name> as a symlink to an arbitrary path (e.g.
      // ~/.crow/.env, ~/.ssh/authorized_keys) — the OLD plain writeFileSync
      // followed that symlink and wrote attacker-chosen bytes wherever it
      // pointed on the operator's next upload of that filename. O_NOFOLLOW
      // makes the open() itself refuse a terminal symlink component (ELOOP)
      // — a single atomic syscall, no separate lstat-then-open TOCTOU
      // window. A legitimate re-upload of the same filename (the target is
      // an ordinary regular file, not a symlink) still overwrites cleanly.
      let fd;
      try {
        fd = openSync(
          join(snap.uploadsDir, name),
          fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW,
          0o600
        );
      } catch (openErr) {
        if (openErr && openErr.code === "ELOOP") {
          return jsonError(res, 400, "bad_request");
        }
        throw openErr;
      }
      try {
        // Belt-and-suspenders: confirm the fd we actually got is a regular
        // file (O_NOFOLLOW only guards the FINAL path component — this
        // rejects the pathological case of a non-regular target, e.g. a
        // FIFO or device node, planted at that name).
        if (!fstatSync(fd).isFile()) return jsonError(res, 400, "bad_request");
        ftruncateSync(fd, 0);
        writeSync(fd, buf, 0, buf.length, 0);
      } finally {
        try { closeSync(fd); } catch { /* already closed */ }
      }
      // Wave 1: full_path is the on-disk location the client injects into the
      // next message for non-image uploads ("I uploaded files: <path>"), so
      // the bot can actually READ what was uploaded — pi's read tool is not
      // write-jailed and uploadsDir is a real path the child's user owns.
      // The dashboard operator is the machine owner (same posture as
      // /browse), so disclosing the path discloses nothing new.
      res.json({ path: name, full_path: join(snap.uploadsDir, name) });
    } catch (err) {
      mapEngineError(res, err);
    }
  });

  // ---- GET /interactive/:sid/files/list — the Files tab's outputs listing ----
  // Phase D3. A FLAT listing of the session's outputsDir ONLY: never
  // uploadsDir (that direction is upload-only, never re-served), never
  // recursive (the jail is one directory deep by construction), never
  // dotfiles, never symlinks — lstatSync skips a symlink outright AND the
  // size/mtime stat can therefore never be redirected through one (a racing
  // child swapping a listed name for a link to ~/.crow/data/crow.db leaks
  // nothing but a name the download route's own O_NOFOLLOW jail still
  // refuses). There is NO user path input on this endpoint at all, so `..`
  // is not merely refused — it is unrepresentable. Names + size + mtime,
  // newest first, capped: a chatty bot's outputs dir must not balloon the
  // response any more than /browse's 500 cap does.
  router.get(P + "/interactive/:sid/files/list", async (req, res) => {
    const sid = String(req.params.sid);
    try {
      const eng = resolveEngine();
      const snap = await eng.get(sid);
      // Same 404/409 shapes as the workspace download route below.
      if (!snap) return jsonError(res, 404, "no_such_session");
      if (!snap.outputsDir) return jsonError(res, 409, "no_session_dir");
      let entries;
      try {
        entries = readdirSync(snap.outputsDir, { withFileTypes: true });
      } catch {
        return jsonError(res, 404, "not_found");
      }
      const items = [];
      // Files the bot SENT are copied to the gateway-owned staging dir
      // (servers/shared/perch-delivered.js); they belong in this list too.
      for (const it of listDelivered(sid)) items.push(it);
      for (const e of entries) {
        if (e.name.startsWith(".")) continue;              // dotfile: invisible here, as in the jail
        let st;
        try { st = lstatSync(join(snap.outputsDir, e.name)); } catch { continue; }
        if (st.isSymbolicLink() || !st.isFile()) continue;  // symlinks skipped; dirs never recursed
        items.push({ name: e.name, size: st.size, mtime: Math.round(st.mtimeMs) });
      }
      items.sort((a, b) => b.mtime - a.mtime);
      res.json({ items: items.slice(0, 200) });
    } catch (err) {
      mapEngineError(res, err);
    }
  });

  // ---- GET /interactive/:sid/files/history — sent-file cards (PR-E, item 12) ----
  // The reload rail for the chat's inline file cards: one row per crow-file:
  // relay announce this thread has ever made, oldest first (the hub appends in
  // order). servable=1 rows whose STORED file no longer exists in the session's
  // outputsDir drop to servable:false — a dead link is worse than a dim name.
  // Same session-resolution shape as files/list (a hibernating session's
  // snapshot still carries outputsDir). Capped like the list: the transcript
  // itself trims at its own ceiling; the card rail must not balloon.
  router.get(P + "/interactive/:sid/files/history", async (req, res) => {
    const sid = String(req.params.sid);
    try {
      const eng = resolveEngine();
      const snap = await eng.get(sid);
      if (!snap) return jsonError(res, 404, "no_such_session");
      const db = createDbClient();
      try {
        // thread_id IS the sessionId (perch-interactive.js identity note); the
        // bot_id filter keeps a cross-bot thread-id collision from leaking a
        // card the caller has no right to render.
        const botId = String(snap.botId || "");
        // Live browser tile (migration 0014): sent files exclude kind
        // 'browser_shot' and carry id/kind/turn_anchor; the shots come from
        // their own query. A co-hosted instance restarted onto this code
        // before it migrated has neither column — fall back to the old
        // query (every such row is a sent file) rather than 500 the chat.
        let r;
        let hasKind = true;
        try {
          r = await db.execute({
            sql: "SELECT id, kind, turn_anchor, name, stored, mime, size, caption, servable, created_at FROM perch_session_files WHERE bot_id=? AND thread_id=? AND kind != 'browser_shot' ORDER BY id ASC LIMIT 200",
            args: [botId, sid],
          });
        } catch (e) {
          if (!/no such column/i.test(String(e && e.message))) throw e;
          hasKind = false;
          r = await db.execute({
            sql: "SELECT id, name, stored, mime, size, caption, servable, created_at FROM perch_session_files WHERE bot_id=? AND thread_id=? ORDER BY id ASC LIMIT 200",
            args: [botId, sid],
          });
        }
        const items = r.rows.map((row) => {
          const it = {
            id: Number(row.id),
            kind: row.kind == null ? "file" : String(row.kind),
            turn_anchor: row.turn_anchor == null ? null : String(row.turn_anchor),
            name: String(row.name || ""),
            stored: row.stored == null ? null : String(row.stored),
            mime: String(row.mime || "application/octet-stream"),
            size: Number(row.size) || 0,
            caption: String(row.caption || ""),
            servable: !!Number(row.servable),
            created_at: String(row.created_at || ""),
          };
          if (it.servable && !it.stored) { it.servable = false; return it; }
          if (it.servable) {
            // the staging dir first (copies), then the outputs dir (in place)
            if (deliveredExists(sid, it.stored)) return it;
            if (!snap.outputsDir) { it.servable = false; return it; }
            try { it.servable = lstatSync(join(snap.outputsDir, it.stored)).isFile(); } catch { it.servable = false; }
          }
          return it;
        });
        // Browser shots: newest SHOT_KEEP, only the gateway writes this kind,
        // and only from the staging dir (a shot whose file is gone is skipped).
        const browserShots = [];
        if (hasKind) {
          const sr = await db.execute({
            sql: "SELECT id, name, stored, turn_anchor, created_at FROM perch_session_files WHERE bot_id=? AND thread_id=? AND kind='browser_shot' ORDER BY id DESC LIMIT ?",
            args: [botId, sid, SHOT_KEEP],
          });
          for (const row of sr.rows) {
            const stored = row.stored == null ? "" : String(row.stored);
            if (!stored || !deliveredExists(sid, stored)) continue;
            browserShots.push({
              id: Number(row.id),
              name: String(row.name || stored),
              url: P + "/interactive/" + encodeURIComponent(sid) + "/workspace/" + encodeURIComponent(stored),
              turn_anchor: row.turn_anchor == null ? null : String(row.turn_anchor),
              created_at: String(row.created_at || ""),
            });
          }
        }
        res.json({ items, browserShots });
      } finally { try { db.close(); } catch { /* already closed */ } }
    } catch (err) {
      mapEngineError(res, err);
    }
  });

  // ---- DELETE /interactive/:sid/browser-shots/:id — Delete screenshot ----
  // Live browser tile (spec §4.5, §7 item 12). CSRF-railed (this router mounts
  // after csrfMiddleware) and session-gated. Scoped to id AND bot_id AND
  // thread_id AND kind='browser_shot': any other id (another bot's, another
  // thread's, a sent file's) is a 404 and nothing is removed. The file goes
  // first (fd-anchored, never through a symlink), then the row.
  router.delete(P + "/interactive/:sid/browser-shots/:id", async (req, res) => {
    const sid = String(req.params.sid);
    const id = /^[1-9][0-9]{0,15}$/.test(String(req.params.id)) ? Number(req.params.id) : null;
    try {
      const eng = resolveEngine();
      const snap = await eng.get(sid);
      if (!snap) return jsonError(res, 404, "no_such_session");
      if (id == null) return jsonError(res, 404, "not_found");
      const botId = String(snap.botId || "");
      const db = createDbClient();
      try {
        let r;
        try {
          r = await db.execute({
            sql: "SELECT id, stored FROM perch_session_files WHERE id=? AND bot_id=? AND thread_id=? AND kind='browser_shot'",
            args: [id, botId, sid],
          });
        } catch (e) {
          if (/no such column/i.test(String(e && e.message))) return jsonError(res, 404, "not_found");
          throw e;
        }
        const row = r.rows[0];
        if (!row) return jsonError(res, 404, "not_found");
        if (row.stored) unlinkDelivered(sid, String(row.stored));
        await db.execute({
          sql: "DELETE FROM perch_session_files WHERE id=? AND bot_id=? AND thread_id=? AND kind='browser_shot'",
          args: [id, botId, sid],
        });
        res.json({ ok: true });
      } finally { try { db.close(); } catch { /* already closed */ } }
    } catch (err) {
      mapEngineError(res, err);
    }
  });

  // ---- GET /interactive/:sid/browser/frame?after=<seq>&vw=<px> — the live tile ----
  // Live browser tile (spec §4.3). A long poll (≤ 2 s): the newest screencast
  // frame after `seq`, or 204. Only while THIS session holds the browser lease
  // (a lock-free read; atomic rename gives whole files) — otherwise 409
  // not_holder and the tile keeps its last frame dimmed. `vw` is the viewer's
  // width: a phone viewport (≤ 600 px) lets the watcher drop to 1 frame/s at
  // 480 px. A closed request aborts the wait. An unreachable browser is 404
  // no_browser; more than 8 polls per session (32 in all) are 429. Behind dashboardAuth like every
  // perch-api route; never Funnel-reachable.
  router.get(P + "/interactive/:sid/browser/frame", async (req, res) => {
    const sid = String(req.params.sid);
    const ac = new AbortController();
    const gone = () => { if (!res.writableEnded) ac.abort(); };
    req.on("close", gone);
    res.on("close", gone);
    try {
      const eng = resolveEngine();
      const snap = await eng.get(sid);
      if (!snap) return jsonError(res, 404, "no_such_session");
      const watcher = eng.browserWatcher || null;
      if (!watcher || !watcher.enabled()) return jsonError(res, 404, "no_browser");
      if (!(await watcher.isHolder(sid))) return jsonError(res, 409, "not_holder");
      // docker missing, the container down, the port closed: say so, not 204 forever
      if (!(await watcher.available())) return jsonError(res, 404, "no_browser");
      if (ac.signal.aborted) return;
      const afterRaw = String(req.query.after ?? "");
      const after = /^[0-9]{1,15}$/.test(afterRaw) ? Number(afterRaw) : 0;
      const vwRaw = String(req.query.vw ?? "");
      const vw = /^[0-9]{1,5}$/.test(vwRaw) ? Number(vwRaw) : 0;
      const frame = await watcher.frameAfter(sid, after, { timeoutMs: 2000, signal: ac.signal, phone: vw > 0 && vw <= 600 });
      if (ac.signal.aborted || res.writableEnded) return;
      res.set("Cache-Control", "no-store");
      if (!frame) return res.status(204).end();
      res.json({ seq: frame.seq, jpeg: frame.jpegB64, w: frame.w, h: frame.h });
    } catch (err) {
      if (ac.signal.aborted || res.headersSent) return;
      if (err && err.code === "ETOOMANYWAITERS") return jsonError(res, 429, "too_many_polls");
      mapEngineError(res, err);
    }
  });

  // ---- POST /browser/take-over | /browser/hand-back | /browser/heartbeat ----
  // Live browser tile (spec §4.4, §7 items 7 and 14). The operator's holding of
  // this instance's browser: the engine's in-memory record (Ruling B4), never
  // the lease file. Take over answers { state: "held" } or, while a bot call is
  // in flight, { state: "pending" } (it switches when that call ends, or after
  // 30 s). The sheet heartbeats every 15 s; { state: "idle" } means the browser
  // went back (Hand back, or 5 minutes without a heartbeat). A take-over sent
  // from a link ({from:"link", sid}) is 409 no_live_turn unless that chat has a
  // live turn using the browser, or its bot asked for the operator in the last
  // 30 minutes and no other bot holds the browser; another bot holding it at
  // take time (checked under the lease lock) is 409 other_bot. GET /browser/state is the
  // controller's state (the "You have the browser" control). A lease error
  // (a jammed lock, Ruling B3) is 503 browser_busy, never a hang. CSRF-railed
  // (this router mounts after csrfMiddleware), behind dashboardAuth, never
  // Funnel-reachable.
  const takeOverRoute = (op) => async (req, res) => {
    try {
      const eng = resolveEngine();
      const ctl = eng.browserTakeOver;
      if (!ctl) return jsonError(res, 404, "no_browser");
      // From a "?take-over=1" link (a needs-you item): only while that chat
      // has a live turn using the browser. A stale click never grabs it.
      const body = req.body && typeof req.body === "object" ? req.body : {};
      let take;
      if (op === "takeOver" && body.from === "link") {
        const sid = typeof body.sid === "string" ? body.sid.slice(0, 64) : "";
        if (!sid || typeof eng.browserLinkOk !== "function" || !(await eng.browserLinkOk(sid))) {
          return jsonError(res, 409, "no_live_turn");
        }
        // The check above is a lock-free read: the take itself re-decides
        // "another bot holds it" under the lease lock, so a bot that acquires
        // in between keeps its browser (409 other_bot; the sheet says the bot
        // is no longer waiting).
        take = { allowHolderSession: sid };
      }
      const r = await ctl[op](take);
      if (r.state === "no_browser") return jsonError(res, 404, "no_browser");
      if (r.state === "other_bot") return jsonError(res, 409, "other_bot");
      res.set("Cache-Control", "no-store");
      res.json({ state: r.state });
    } catch (err) {
      if (res.headersSent) return;
      console.warn("[perch-interactive-api] browser " + op + ": " + String((err && err.code) || "error").slice(0, 40));
      return jsonError(res, 503, "browser_busy");
    }
  };
  router.post(P + "/browser/take-over", takeOverRoute("takeOver"));
  router.post(P + "/browser/hand-back", takeOverRoute("handBack"));
  router.post(P + "/browser/heartbeat", takeOverRoute("heartbeat"));
  router.get(P + "/browser/state", (req, res) => {
    const ctl = resolveEngine().browserTakeOver;
    if (!ctl) return jsonError(res, 404, "no_browser");
    res.set("Cache-Control", "no-store");
    res.json({ state: ctl.state() });
  });

  // ---- R1.2 PR 5: the embedded app tile, for any desktop (VNC) app ----
  // GET /apps/:app/tile → { id, label, src, takeOver }: an installed desktop
  // app's watch-only noVNC view, and whether Take over is offered (the
  // manifest declares the lease AND the bundle's server reported enforcing it,
  // for the installed version). POST /apps/:app/take-over | hand-back |
  // heartbeat and GET /apps/:app/state are the browser's take-over state
  // machine (browser-tile/take-over.js) for that app: take over re-checks the
  // app against the catalog every time (404 not_desktop for anything else,
  // 409 lease_not_enforced when its lease is not confirmed). Hand back works
  // for any installed desktop app (it can free a holding a restarted gateway
  // forgot); a heartbeat or state for an app never taken here is idle. The
  // browser's own /browser/* routes above are unchanged. Behind dashboardAuth,
  // CSRF-railed like the routes above, never Funnel-reachable.
  const APP_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
  const appIdOf = (req) => { const id = String(req.params.app || ""); return APP_ID.test(id) ? id : null; };
  router.get(P + "/apps/:app/tile", (req, res) => {
    const id = appIdOf(req);
    if (!id) return jsonError(res, 400, "bad_app");
    const eng = resolveEngine();
    const info = eng && typeof eng.appTile === "function" ? eng.appTile(id) : null;
    if (!info) return jsonError(res, 404, "not_desktop");
    res.set("Cache-Control", "no-store");
    res.json({ id: info.id, label: info.label, src: info.src, takeOver: !!info.takeOver });
  });
  const appTakeOverRoute = (op) => async (req, res) => {
    const id = appIdOf(req);
    if (!id) return jsonError(res, 400, "bad_app");
    try {
      const eng = resolveEngine();
      const reg = eng && eng.appTakeOvers;
      if (!reg || typeof eng.appTile !== "function") return jsonError(res, 404, "not_desktop");
      let ctl = reg.get(id);
      if (op === "takeOver") {
        if (!eng.appTile(id)) return jsonError(res, 404, "not_desktop");
        if (typeof eng.appTakeOverOffered !== "function" || !eng.appTakeOverOffered(id)) {
          return jsonError(res, 409, "lease_not_enforced");
        }
        ctl = ctl || reg.get(id, { create: true });
      } else if (!ctl && op === "handBack") {
        if (!eng.appTile(id)) return jsonError(res, 404, "not_desktop");
        // An app nobody took here: free a holding a restarted gateway forgot,
        // but only where a lease directory exists (never create one).
        ctl = reg.get(id, { create: true, ifDirExists: true });
      }
      res.set("Cache-Control", "no-store");
      if (!ctl) {
        if (op === "takeOver") return jsonError(res, 404, "not_desktop");
        return res.json({ state: "idle" });
      }
      if (op === "state") return res.json({ state: ctl.state() });
      const r = await ctl[op]();
      if (r.state === "no_browser") return jsonError(res, 404, "not_desktop");
      if (r.state === "other_bot") return jsonError(res, 409, "other_bot");
      res.json({ state: r.state });
    } catch (err) {
      if (res.headersSent) return;
      console.warn("[perch-interactive-api] app " + op + ": " + String((err && err.code) || "error").slice(0, 40));
      return jsonError(res, 503, "app_busy");
    }
  };
  router.post(P + "/apps/:app/take-over", appTakeOverRoute("takeOver"));
  router.post(P + "/apps/:app/hand-back", appTakeOverRoute("handBack"));
  router.post(P + "/apps/:app/heartbeat", appTakeOverRoute("heartbeat"));
  router.get(P + "/apps/:app/state", appTakeOverRoute("state"));

  // ---- GET /interactive/:sid/cwd/list — read-only cwd browse (PR-B, item 18) ----
  // Lists dirs + files inside the session's OWN cwd, realpath-jailed under it
  // (never the uploadsDir). The Files tab's browser: a picker/viewer, not a
  // trust boundary (open-anywhere decision 1 — dashboard operator = machine
  // owner), but the jail keeps a session's scope honest. Reuses the /browse
  // idiom, scoped to s.cwd. `path` may be empty (the cwd root), relative, or
  // absolute; anything resolving outside the cwd 404s.
  router.get(P + "/interactive/:sid/cwd/list", async (req, res) => {
    const sid = String(req.params.sid);
    try {
      const eng = resolveEngine();
      const snap = await eng.get(sid);
      if (!snap) return jsonError(res, 404, "no_such_session");
      if (!snap.cwd) return jsonError(res, 409, "no_cwd");
      const out = cwdList(snap.cwd, req.query.path, { uploadsDir: snap.uploadsDir });
      if (!out) return jsonError(res, 404, "not_found");
      res.json(out);
    } catch (err) {
      mapEngineError(res, err);
    }
  });

  // ---- GET /interactive/:sid/cwd/read — in-app TEXT viewer (PR-B, item 18) ----
  // Serves a text/plain-ish file under the cwd, capped (CWD_READ_CAP) and
  // fail-closed on type (extension allowlist + NUL guard). A non-text/binary
  // file → 415 unsupported_type; not-found / jail-escape / not-a-regular-file
  // → 404. DOWNLOADS stay outputs-jail-only via the fd-based workspace route
  // below — this viewer never serves the outputs jail and never streams binary.
  router.get(P + "/interactive/:sid/cwd/read", async (req, res) => {
    const sid = String(req.params.sid);
    try {
      const eng = resolveEngine();
      const snap = await eng.get(sid);
      if (!snap) return jsonError(res, 404, "no_such_session");
      if (!snap.cwd) return jsonError(res, 409, "no_cwd");
      const out = cwdRead(snap.cwd, req.query.path, { uploadsDir: snap.uploadsDir });
      if (!out) return jsonError(res, 404, "not_found");
      if (out.error === "unsupported") return jsonError(res, 415, "unsupported_type");
      res.json(out);
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

      // A file the bot SENT: its copy in the gateway-owned staging dir, opened
      // through the anchored root fd (never by a path a bot can swap).
      let fd;
      if (!rel.includes("/")) {
        try { fd = openDeliveredFile(sid, rel); } catch { fd = undefined; }
      }
      if (fd !== undefined) {
        let st;
        try { st = fstatSync(fd); } catch { closeSync(fd); return jsonError(res, 404, "not_found"); }
        if (!st.isFile()) { closeSync(fd); return jsonError(res, 404, "not_found"); }
        return streamWorkspaceFd(res, fd, st, rel);
      }
      if (!snap.outputsDir) return jsonError(res, 409, "no_session_dir");

      let outputsReal;
      try {
        outputsReal = realpathSync(snap.outputsDir);
      } catch {
        return jsonError(res, 404, "not_found");
      }

      // C2 (final review): the OLD code validated with realpathSync/statSync
      // on the PATH STRING, then handed that same string to res.sendFile(),
      // which re-opens it — two separate lookups by path. outputsDir is in
      // the pi child's extraWritePaths, so a racing child could swap the
      // validated file for a symlink to e.g. ~/.crow/data/crow.db or a
      // minted MCP token file in the window between the two, and the
      // authenticated operator would get THAT file streamed back. Fix: a
      // SINGLE open() (O_NOFOLLOW — refuses a symlink at the leaf, closing
      // that half of the window atomically), then every check and the
      // stream itself operate on that ONE file descriptor — a fd is bound
      // to an inode, not a path, so nothing that happens to the path AFTER
      // this open can change what gets read.
      try {
        fd = openSync(join(snap.outputsDir, rel), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      } catch {
        return jsonError(res, 404, "not_found");
      }

      let stat, fdReal;
      try {
        stat = fstatSync(fd);
        // Re-derive the fd's OWN canonical path from the kernel's fd table,
        // never by re-resolving `rel`/the join()'d path string again — that
        // second path-based resolution is exactly the TOCTOU this closes.
        // Also catches a symlinked INTERMEDIATE directory component (the
        // leaf itself isn't a symlink — O_NOFOLLOW already covers that —
        // but a parent dir could be) still landing outside outputsDir.
        fdReal = realpathSync(`/proc/self/fd/${fd}`);
      } catch {
        closeSync(fd);
        return jsonError(res, 404, "not_found");
      }

      if (!stat.isFile() || !fdReal.startsWith(outputsReal + sep)) {
        closeSync(fd);
        return jsonError(res, 404, "not_found");
      }

      // Test-only barrier (see _setWorkspaceServeBarrierForTest) — null in
      // production, so this branch is never entered: no await, no timer.
      if (_workspaceServeBarrier) await _workspaceServeBarrier;

      streamWorkspaceFd(res, fd, stat, fdReal);
    } catch (err) {
      mapEngineError(res, err);
    }
  });

  return router;
}
