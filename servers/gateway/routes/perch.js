/**
 * Perch Hub — the gateway-side API the bots lens calls (Perch Hub P1, C-5).
 *
 * The lens itself is a page served BY THE VENDORED HUB, reached only through
 * the session-gated extension proxy at `<gateway>/proxy/perch-hub/bots`. The
 * DATA it renders is Crow's, not Perch's, so every fetch it makes is a
 * root-absolute `/dashboard/perch-api/…` URL that lands here, one level above
 * the proxy prefix. This file is the whole of that contract.
 *
 * MOUNT — deliberately `/dashboard/perch-api`, NOT a root `/api/perch`:
 *   (a) the general rate limiter (index.js ~:335) SKIPS `/dashboard`; a root
 *       mount would 429 the lens after a few minutes of ordinary use (200
 *       req / 15 min, and one lens load is already 1 + N fetches);
 *   (b) `/dashboard` carries the repo's real CSRF rail (dashboard/index.js →
 *       shared/csrf.js: cookie `crow_csrf`, header `X-Crow-Csrf`,
 *       constant-time compare). The lens echoes that cookie on every mutating
 *       fetch. There is NO second, bespoke guard here — one rail, or the two
 *       drift;
 *   (c) `/dashboard/*` is funnel-private (PUBLIC_FUNNEL_PREFIXES omits it), so
 *       the network-exposure invariant covers this surface for free —
 *       tests/auth-network.test.js pins the perch paths explicitly.
 * Body parsing is likewise already done: index.js installs a GLOBAL
 * `express.json({limit:"1mb"})`. No per-route parser here — the interactive
 * channel (perch-interactive-api.js) enforces its own message cap.
 *
 * The factory's FIRST statement is `router.use(P, dashboardAuth)` — the
 * bot-board-api.js idiom. It is not redundant with the dashboard router's own
 * gate: it keeps this router self-sufficient wherever it is mounted, and the
 * unauthenticated case is asserted against a REAL route in
 * tests/perch-routes.test.js (proving the middleware in isolation, as C-3
 * does, would NOT prove this surface is closed).
 *
 * Turn model, historical: P1 shipped perch as a per-turn channel like gmail —
 * one `handleInbound()` call per message, made IN-PROCESS (this was NOT the
 * gateway's first in-process handleInbound: the gmail tick has run one since
 * C4 — bot-runtime.js imports `runBridgeTick` from bridge_tick_lib.mjs, which
 * imports `handleInbound` from the bridge directly) so a streaming `sendReply`
 * could push SSE down `POST /bots/:id/turn` / `GET /turns/:turnId/events`.
 * Track 3 Task 16 retired both routes and their turn-map/claim machinery:
 * perch-live (perch-interactive.js, routes/perch-interactive-api.js) is now
 * the only interactive rail, and it spawns its own pi CHILD PROCESSES
 * (startChild) rather than calling handleInbound in-process — but it still
 * checks in against the SAME host-wide pi capacity budget every in-process
 * handleInbound caller does (`countLivePi()` vs `LIFECYCLE_DEFAULTS.maxPi`)
 * and reads the same `PIBOT_*` timeout/env tuning — including the local-model
 * systemd drop-ins, which is why `turnTimeoutMs()` below (still used by
 * `claimIsFresh()` for the generic `bot_sessions` claim-freshness check GET
 * /sessions relies on) reads PIBOT_TURN_TIMEOUT_MS rather than hard-coding
 * the bridge's default.
 *
 * The bridge is imported LAZILY (via `loadBridge()`, used by the tool
 * envelope) so gateway boot stays light.
 */
import { Router } from "express";
import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "../../db.js";
import { jsonError } from "./_error.js";
import { resolveEngineStatus, resolveBotRuntimeStatus } from "../dashboard/panels/bot-builder/engine-gate.js";
import { PI_BUILTIN, remoteInvocationOn } from "../dashboard/panels/bot-builder/data-queries.js";
import { sessionBirdState, foldBirdStates } from "../dashboard/panels/bot-board/data-queries.js";
import { perchAttached } from "../shared/perch-attached.js";
import { getInteractiveEngine } from "../perch-interactive.js";
import { JOB_LOCK_STATUSES } from "./board-lock.js";

/** Mount prefix. Every route below is registered under it, after the auth gate. */
const P = "/dashboard/perch-api";

/**
 * Most sessions the lens is handed for one bot.
 *
 * bot_sessions only grows: a long-lived gmail bot gets a row per THREAD, and
 * duplicate rows per (bot, thread) are tolerated by design — getSession() takes
 * the newest, which is also why `idx_bot_sessions_bot_thread` is not unique. An
 * uncapped ORDER BY id DESC therefore hands the browser the bot's entire
 * history in a single JSON body. Perch's own on-disk lister caps its home page
 * at 25 (hub/server.mjs) and defaults to 50 (lib/sessions.mjs); this matches
 * that, and the response says when it bit so the lens can be honest.
 */
const SESSIONS_LIMIT = 50;

/** Transcript tail. A live pi session file on this box already exceeds 2 MB,
 * so the cap TAIL-truncates: head-truncation would render the oldest turns and
 * hide today's, which is the opposite of what an observatory is for. */
const TRANSCRIPT_TAIL_LINES = 2000;

/** Hard ceiling on how much of a transcript is ever read into memory. Applied
 * at the READ, so a file of a hundred enormous lines cannot slip past the line
 * cap above. */
const TRANSCRIPT_TAIL_BYTES = 2 * 1024 * 1024;

/** Read at call time, never at import time (#217 class): the bridge's own turn
 * budget is what makes a stale `status='active'` row reclaimable. */
function turnTimeoutMs() {
  return Number(process.env.PIBOT_TURN_TIMEOUT_MS || 600000);
}

// ---------------------------------------------------------------------------
// in-flight turns (process-local)
// ---------------------------------------------------------------------------
//
// Track 3 Task 16 retired the per-turn channel (POST /bots/:id/turn, GET
// /turns/:turnId/events) and the turn-map machinery that went with it
// (sweepTurns, claimTurn, pushTurnEvent, …). `inFlight` and `flightKeyFor`
// survive ONLY because GET /bots/:id/sessions still reads `inFlight.has(...)`
// as half of its `live` badge (see the BADGE CONTRACT comment at the
// emission site) — nothing adds to this set anymore, so that half is always
// false; `claimIsFresh(row)` (below) is what still carries real signal, for
// any channel's fresh `active` claim.

/** `${botId} ${threadId}` — kept only as the key shape GET /sessions checks
 * against `inFlight`, which nothing populates now. */
const inFlight = new Set();

const flightKeyFor = (botId, threadId) => botId + " " + threadId;

// ---------------------------------------------------------------------------
// bots / defs
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// the tool envelope
// ---------------------------------------------------------------------------

/** Lazy bridge import — used by the tool envelope (toolAllowlist). Cached by
 * the ESM loader after the first call. */
function loadBridge() {
  return import("../../../scripts/pi-bots/bridge.mjs");
}

/** Bot Builder's vocabulary for a tool id: builtins are bare names, MCP ids
 * are `mcp__<server>__<tool>` rendered back as the `server/tool` the Tools tab
 * shows, remote servers as their capability. */
function labelFor(id) {
  if (id.startsWith("mcp__crow-remote-")) return "remote · " + id.slice("mcp__crow-remote-".length);
  if (id.startsWith("mcp__")) return id.slice("mcp__".length).replace(/__/g, "/");
  return id;
}

/**
 * The bot's envelope: what Bot Builder (the single writer) grants, split into
 * what is on and what is knowably off.
 *
 * The tool universe has exactly two real sources — there is no catalog listing
 * function to reuse:
 *   1. builtins: PI_BUILTIN (data-queries.js) — a fixed 7, so a builtin the def
 *      does NOT grant is a KNOWN denial and renders locked;
 *   2. mcp + remote ids: derived by toolAllowlist() itself (bridge.mjs) from
 *      the def's own selections, so every one of them is by definition allowed.
 * `subagent` is appended by PiRpc AFTER the allowlist (bridge.mjs ~:141) when
 * the def opts into multi_agent, so it is listed here as narrowable on the same
 * condition — narrowing means "less than the def grants", subagent included.
 * (The bridge additionally requires a capability-listed model at spawn; the
 * envelope reports the def's grant, not the per-turn resolution.)
 */
async function buildEnvelope(db, def) {
  const { toolAllowlist } = await loadBridge();
  const remoteEnabled = await remoteInvocationOn(db);
  const csv = toolAllowlist(def, { remoteEnabled });
  const allowed = csv ? csv.split(",").filter(Boolean) : [];
  if (def.permission_policy && def.permission_policy.multi_agent === true) allowed.push("subagent");
  const allowedSet = new Set(allowed);
  return {
    tools: allowed.map((id) => ({ id, label: labelFor(id), allowed: true })),
    denied: PI_BUILTIN.filter((id) => !allowedSet.has(id)).map((id) => ({ id, label: labelFor(id) })),
    skills: ((def && def.skills) || []).map(String),
    model: (def && def.models && def.models.default) || null,
  };
}

// ---------------------------------------------------------------------------
// session rows: claim / release / narrow
// ---------------------------------------------------------------------------

/**
 * The newest bot_sessions row for a thread, with its age in seconds.
 *
 * ORDER BY id DESC LIMIT 1 mirrors the bridge's getSession() exactly:
 * duplicate rows per (bot, thread) are tolerated BY DESIGN there, which is
 * also why `idx_bot_sessions_bot_thread` is not UNIQUE and why nothing here
 * may use ON CONFLICT (it would throw at prepare() and 500 every request).
 */
async function latestSession(db, botId, threadId) {
  const { rows } = await db.execute({
    sql:
      "SELECT id, kind, status, gateway_type, narrowed_tools, pi_session_dir, pi_session_id, " +
      "(strftime('%s','now') - strftime('%s', updated_at)) AS age_s " +
      "FROM bot_sessions WHERE bot_id=? AND gateway_thread_id=? ORDER BY id DESC LIMIT 1",
    args: [botId, threadId],
  });
  return rows[0] || null;
}

/**
 * Is this existing row a thread perch is allowed to act on?
 *
 * Thread ids arrive from the CALLER (`body.sessionId`, and the `:threadId`
 * path segment), so they can name ANY of the bot's threads — including a live
 * gmail or discord one. Acting on one of those is not a privilege escalation
 * (every caller here is already dashboard-authed) but it is a silent
 * data-integrity failure: a turn would claim that row, the bridge's own
 * getSession() would RESUME it, the perch message would be appended to that
 * conversation's pi session file, and upsertSession() would relabel the row
 * `perch` for good — while the lens badges off gateway_type, so nothing would
 * ever show it.
 *
 * A NULL/empty `gateway_type` is a pre-channel legacy row, not evidence of
 * another channel: those stay usable rather than becoming unreachable. A row
 * that does not exist at all is the ordinary first-turn case.
 */
function foreignChannel(row) {
  return row && row.gateway_type && row.gateway_type !== "perch" ? String(row.gateway_type) : null;
}

/** A row is a live claim while it is `active` AND younger than one turn budget.
 * Older claims are reclaimable, so a gateway that died mid-turn cannot wedge a
 * thread forever. */
function claimIsFresh(row) {
  if (!row || row.status !== "active") return false;
  const age = Number(row.age_s);
  return Number.isFinite(age) && age * 1000 < turnTimeoutMs();
}

/** Persist a session's narrowing. Same one-transaction shape as the retired
 * per-turn claim (UPDATE-latest + INSERT-if-none, db.batch() wrapping both in
 * a single better-sqlite3 transaction — mirrors upsertSession() without
 * ON CONFLICT, since `idx_bot_sessions_bot_thread` is not unique); the created
 * row is `waiting-user`, never `active` — narrowing a thread that has never
 * run must not read as a turn in progress. */
async function saveNarrowing(db, botId, threadId, json) {
  await db.batch([
    {
      sql:
        "UPDATE bot_sessions SET narrowed_tools=?, updated_at=datetime('now') " +
        "WHERE id=(SELECT id FROM bot_sessions WHERE bot_id=? AND gateway_thread_id=? ORDER BY id DESC LIMIT 1)",
      args: [json, botId, threadId],
    },
    {
      sql:
        "INSERT INTO bot_sessions (bot_id,gateway_type,gateway_thread_id,kind,status,control,narrowed_tools) " +
        "SELECT ?,'perch',?,'perch','waiting-user','run',? " +
        "WHERE NOT EXISTS (SELECT 1 FROM bot_sessions WHERE bot_id=? AND gateway_thread_id=?)",
      args: [botId, threadId, json, botId, threadId],
    },
  ]);
}

// ---------------------------------------------------------------------------
// transcripts
// ---------------------------------------------------------------------------

/**
 * Resolve the pi session file for a row.
 *
 * On disk the files are `<ISO-timestamp>_<uuid>.jsonl` inside
 * `bot_sessions.pi_session_dir`, while `pi_session_id` is the BARE uuid — so
 * this is a glob on the suffix, never `join(dir, id + ".jsonl")` (that always
 * 404s). The browser never supplies a path: both halves come from the row.
 */
function resolveTranscriptFile(dir, sessionId) {
  if (!dir || !sessionId) return null;
  let names;
  try { names = readdirSync(dir); } catch { return null; }
  const suffix = "_" + sessionId + ".jsonl";
  const hits = names.filter((n) => n.endsWith(suffix)).sort();
  return hits.length ? join(dir, hits[hits.length - 1]) : null;
}

/**
 * Read at most the trailing TRANSCRIPT_TAIL_BYTES of a file.
 *
 * The line cap alone does NOT bound memory: 100 lines of 50 KB sail past
 * `length > TRANSCRIPT_TAIL_LINES` as a 5 MB slurp, held twice over by
 * readFileSync + split. pi session files are large by nature (one on this box
 * already exceeds 2 MB) and a single entry can be enormous, so the bound has
 * to be applied at the read, not after it.
 *
 * Returns the decoded tail and whether the head was left on disk. When it was,
 * the first line in the window is almost certainly a fragment — of a line and
 * possibly of a UTF-8 sequence — so it is dropped rather than half-parsed.
 */
function readTailBytes(file, maxBytes) {
  const size = statSync(file).size;
  const start = size > maxBytes ? size - maxBytes : 0;
  const fd = openSync(file, "r");
  let text;
  try {
    const buf = Buffer.allocUnsafe(size - start);
    let off = 0;
    while (off < buf.length) {
      const n = readSync(fd, buf, off, buf.length - off, start + off);
      if (n <= 0) break; // truncated under us mid-read; take what we got
      off += n;
    }
    text = buf.toString("utf8", 0, off);
  } finally {
    try { closeSync(fd); } catch { /* already gone */ }
  }
  if (start === 0) return { text, headDropped: false };
  const nl = text.indexOf("\n");
  return { text: nl === -1 ? "" : text.slice(nl + 1), headDropped: true };
}

/**
 * Parse the tail of a pi session file. Lines are a `type`-discriminated JSON
 * union (session | model_change | thinking_level_change | message | …);
 * they are returned AS-IS so the lens stays forward-compatible, and
 * unparseable lines are skipped silently (a half-written last line is normal
 * while a turn is running).
 *
 * `omitted` is an exact count of dropped entries when the whole file was read,
 * and `null` when the byte cap bit — the head is never read, so the number is
 * genuinely unknown and reporting 0 would be a lie. The lens words the notice
 * without a count in that case.
 */
function readTranscript(file) {
  const { text, headDropped } = readTailBytes(file, TRANSCRIPT_TAIL_BYTES);
  const all = text.split("\n").filter((l) => l.trim());
  const kept = all.length > TRANSCRIPT_TAIL_LINES ? all.slice(-TRANSCRIPT_TAIL_LINES) : all;
  const events = [];
  for (const line of kept) {
    try { events.push(JSON.parse(line)); } catch { /* skip: not our business to guess */ }
  }
  return {
    events,
    truncated: headDropped || kept.length < all.length,
    omitted: headDropped ? null : all.length - kept.length,
  };
}

// ---------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------

/**
 * @param {Function} dashboardAuth session gate (the SAME middleware the rest of
 *   /dashboard uses)
 * @param {object} [seams]
 * @param {Function|object} [seams.interactiveEngine] test seam (P2, C-15) — same
 *   accessor-or-object shape as perch-interactive-api.js's own `engine` seam.
 *   Used by GET /roost and GET /bots/:id/sessions (the latter to read live
 *   `state` for kind='perch-live' rows); tests that never touch the
 *   interactive engine simply omit it.
 */
export default function perchApiRouter(dashboardAuth, { interactiveEngine = getInteractiveEngine } = {}) {
  const router = Router();

  // FIRST statement: auth-gate the whole prefix (bot-board-api.js idiom).
  router.use(P, dashboardAuth);

  function resolveInteractiveEngine() {
    return typeof interactiveEngine === "function" ? interactiveEngine() : interactiveEngine;
  }

  // /roost (below) must never conjure a live engine into existence just by
  // being polled — a gateway that has never spawned an interactive session
  // has to fail soft to "no live birds", never spin one up as a side effect
  // of a read. The shared `interactiveEngine` seam above defaults to the bare
  // `getInteractiveEngine` reference (createIfMissing:true, same as every
  // other perch-interactive route on this router), so this resolver calls it
  // with `{createIfMissing:false}` ONLY when nothing has overridden the seam;
  // a test's injected function (or object) is used exactly as given.
  function resolveRoostEngine() {
    if (interactiveEngine === getInteractiveEngine) return getInteractiveEngine({ createIfMissing: false });
    return typeof interactiveEngine === "function" ? interactiveEngine() : interactiveEngine;
  }

  // ---- GET /bots — every bot on the instance, plus attach + engine state ----
  router.get(P + "/bots", async (req, res) => {
    const db = createDbClient();
    try {
      const { rows } = await db.execute({
        sql: "SELECT bot_id, display_name, definition, enabled FROM pi_bot_defs ORDER BY bot_id",
        args: [],
      });
      const engine = resolveEngineStatus();
      // Instance-wide truth, reported per card: whether the bot runtime is
      // armed to service this bot's OTHER channels. Perch-live spawns its own
      // pi child directly through the interactive engine and never needs the
      // runtime armed, which is exactly why the lens shows this separately.
      let armed = false;
      try { armed = !!resolveBotRuntimeStatus().bridge.armed; } catch { armed = false; }
      const bots = rows.map((row) => {
        const def = parseDef(row);
        return {
          id: row.bot_id,
          name: row.display_name || row.bot_id,
          perch_attached: perchAttached(def),
          engine: { state: engine.state },
          runtime_on: armed && Number(row.enabled) === 1,
        };
      });
      res.json({ bots });
    } catch (err) {
      jsonError(res, 500, String((err && err.message) || err));
    } finally {
      try { db.close(); } catch { /* already closed */ }
    }
  });

  // ---- GET /roost — the roost strip's bird state (Track 3 Task 11, spec §3.2/§5.6) ----
  //
  // One query for every bot def, one `eng.list()` call, one bot_sessions
  // query for card_id/control — never a per-bot loop. The engine is the
  // truth for awake/pending state; the bot_sessions query fills in card_id
  // and control, which `eng.list()`'s DB-fallback entries (a prior process's
  // hibernating rows) do not carry. `occupiedCardIds` is the Send-out
  // card-picker's source of truth (review finding 15): hibernating claims
  // deliberately don't LOCK (§5.1), so the DOM's lock badges alone cannot
  // tell the picker which cards would 409 a dispatch.
  router.get(P + "/roost", async (req, res) => {
    const db = createDbClient();
    try {
      const { rows } = await db.execute({
        sql: "SELECT bot_id, display_name, definition FROM pi_bot_defs ORDER BY bot_id",
        args: [],
      });

      const engine = resolveRoostEngine();
      let sessions = [];
      if (engine) {
        try { sessions = await engine.list(); } catch { sessions = []; }
      }

      // card_id + control for every LIVE perch-live row (excludes 'stopped':
      // a stopped session holds no card and the strip never shows it as
      // occupying one). This is the query that backfills what eng.list()'s
      // DB-fallback entries leave out.
      const rowById = new Map();
      try {
        const { rows: sessRows } = await db.execute({
          sql: "SELECT gateway_thread_id, card_id, control FROM bot_sessions WHERE kind='perch-live' AND status != 'stopped'",
          args: [],
        });
        for (const r of sessRows) rowById.set(String(r.gateway_thread_id), r);
      } catch {
        // bot_sessions absent (primary gateway) — every session's card_id/
        // control below stays whatever the engine snapshot itself carried.
      }

      const sessionsByBot = new Map();
      for (const s of sessions) {
        const list = sessionsByBot.get(s.botId);
        if (list) list.push(s); else sessionsByBot.set(s.botId, [s]);
      }

      // occupiedCardIds: cards a fresh dispatch/attach-card would 409 on —
      // every non-stopped perch-live claim (the query above) UNION every
      // active job-rail lock (jobLockFor's own status set, board-lock.js).
      const occupied = new Set();
      for (const r of rowById.values()) {
        if (r.card_id != null) occupied.add(Number(r.card_id));
      }
      try {
        const statuses = [...JOB_LOCK_STATUSES];
        const ph = statuses.map(() => "?").join(",");
        const { rows: jobRows } = await db.execute({
          sql: `SELECT DISTINCT card_id FROM bot_jobs WHERE status IN (${ph}) AND card_id IS NOT NULL`,
          args: statuses,
        });
        for (const r of jobRows) occupied.add(Number(r.card_id));
      } catch {
        // bot_jobs absent (primary gateway) — the job rail holds nothing.
      }

      const birds = rows.map((row) => {
        const def = parseDef(row);
        const attached = perchAttached(def);
        const botSessions = sessionsByBot.get(row.bot_id) || [];
        const sessionOut = botSessions.map((s) => {
          const dbRow = rowById.get(String(s.sessionId));
          const cardId = dbRow && dbRow.card_id != null
            ? Number(dbRow.card_id)
            : (s.cardId != null ? Number(s.cardId) : null);
          return {
            sessionId: s.sessionId,
            state: s.state,
            cardId,
            pendingUi: !!s.pendingUi,
            control: dbRow ? dbRow.control : null,
          };
        });
        // spec §3.2 priority fold: waiting-on-you > working > hibernating >
        // idle, EXCEPT a bot with no complete perch gateway record is always
        // "observing" (§3.1) — it can never hold a live session to begin with.
        const state = !attached
          ? "observing"
          : (foldBirdStates(botSessions.map(sessionBirdState)) || "idle");
        return {
          id: row.bot_id,
          name: row.display_name || row.bot_id,
          perch_attached: attached,
          state,
          sessions: sessionOut,
        };
      });

      res.json({ birds, occupiedCardIds: [...occupied] });
    } catch (err) {
      jsonError(res, 500, String((err && err.message) || err));
    } finally {
      try { db.close(); } catch { /* already closed */ }
    }
  });

  // ---- GET /bots/:id/sessions — every session, every channel ----
  router.get(P + "/bots/:id/sessions", async (req, res) => {
    const botId = String(req.params.id);
    const db = createDbClient();
    try {
      const { rows } = await db.execute({
        sql:
          "SELECT id, kind, gateway_type, gateway_thread_id, status, control, card_id, plan_path, " +
          "narrowed_tools, datetime(updated_at) AS updated_at, " +
          "(strftime('%s','now') - strftime('%s', updated_at)) AS age_s " +
          // One past the cap: the extra row is how we know there IS more,
          // without a second COUNT(*) over the same growing table.
          "FROM bot_sessions WHERE bot_id=? ORDER BY id DESC LIMIT ?",
        args: [botId, SESSIONS_LIMIT + 1],
      });
      const truncated = rows.length > SESSIONS_LIMIT;
      const kept = truncated ? rows.slice(0, SESSIONS_LIMIT) : rows;
      const sessions = await Promise.all(kept.map(async (row) => {
        const out = {
          id: row.id,
          kind: row.kind,
          gateway_type: row.gateway_type,
          gateway_thread_id: row.gateway_thread_id,
          status: row.status,
          // Track 3 Task 9: exposed so the drawer can distinguish a plain
          // idle park ('run') from a shutdown that interrupted a mid-turn
          // session ('interrupted') — Task 13's interrupted-note UI reads
          // this field. Present for every row/kind, not just perch-live.
          control: row.control,
          card_id: row.card_id,
          plan_path: row.plan_path,
          updated_at: row.updated_at,
          // Live = a turn this process is running right now, OR any channel's
          // fresh `active` claim (a gmail turn runs in the bridge process and
          // is invisible to the in-flight set — reporting only ours would lie).
          //
          // BADGE CONTRACT (P2, r2 S10b): this flag reads FALSE for an
          // awake-idle interactive session (no fresh claim, no in-flight
          // per-turn guard — the engine holds the child, not a claim row).
          // For kind='perch-live' rows the lens keys its badge off `state`
          // below and IGNORES `live` entirely; `live` stays defined here only
          // because every OTHER kind still depends on it.
          live: inFlight.has(flightKeyFor(botId, String(row.gateway_thread_id))) || claimIsFresh(row),
          // REQUIRED by the lens: the envelope endpoint is per-BOT, so this row
          // is the only place the controls pane can learn a SESSION's saved
          // narrowing. Emitted as the stored JSON text; the client accepts an
          // array or a JSON string.
          narrowed_tools: row.narrowed_tools == null ? null : row.narrowed_tools,
        };
        // P2 (C-15): kind='perch-live' rows additionally carry `state` —
        // "awake"|"hibernating"|"stopped" — the interactive engine's own
        // truth when this process holds (or can adopt) the session, else
        // derived from the row's own status. engine.get() is ASYNC (it may
        // adopt the row from the DB), hence Promise.all over the row map.
        if (row.kind === "perch-live") {
          let state = row.status === "stopped" ? "stopped" : "hibernating";
          try {
            const snap = await resolveInteractiveEngine().get(String(row.gateway_thread_id));
            if (snap) state = snap.state;
          } catch { /* fall back to the row-derived state above */ }
          out.state = state;
        }
        return out;
      }));
      res.json({ sessions, truncated, limit: SESSIONS_LIMIT });
    } catch (err) {
      jsonError(res, 500, String((err && err.message) || err));
    } finally {
      try { db.close(); } catch { /* already closed */ }
    }
  });

  // ---- GET /bots/:id/envelope — what Bot Builder grants ----
  router.get(P + "/bots/:id/envelope", async (req, res) => {
    const botId = String(req.params.id);
    const db = createDbClient();
    try {
      const row = await loadBotRow(db, botId);
      if (!row) return jsonError(res, 404, "unknown_bot");
      res.json(await buildEnvelope(db, parseDef(row)));
    } catch (err) {
      jsonError(res, 500, String((err && err.message) || err));
    } finally {
      try { db.close(); } catch { /* already closed */ }
    }
  });

  // ---- GET /bots/:id/sessions/:threadId/transcript ----
  router.get(P + "/bots/:id/sessions/:threadId/transcript", async (req, res) => {
    const botId = String(req.params.id);
    const threadId = String(req.params.threadId);
    const db = createDbClient();
    try {
      const row = await latestSession(db, botId, threadId);
      const file = row ? resolveTranscriptFile(row.pi_session_dir, row.pi_session_id) : null;
      if (!file) return jsonError(res, 404, "no_transcript");
      res.json(readTranscript(file));
    } catch (err) {
      jsonError(res, 500, String((err && err.message) || err));
    } finally {
      try { db.close(); } catch { /* already closed */ }
    }
  });

  // ---- POST /bots/:id/sessions/:threadId/narrow — narrow only, never widen ----
  router.post(P + "/bots/:id/sessions/:threadId/narrow", async (req, res) => {
    const botId = String(req.params.id);
    // Keyed by gateway_thread_id, NOT the numeric row id: the lens only ever
    // knows thread ids, and a narrowing has to apply to the row the NEXT
    // message will resume.
    const threadId = String(req.params.threadId);
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const db = createDbClient();
    try {
      const row = await loadBotRow(db, botId);
      if (!row) return jsonError(res, 404, "unknown_bot");
      const list = body.disabled_tools;
      if (!Array.isArray(list) || list.some((t) => typeof t !== "string")) {
        return jsonError(res, 400, "bad_request");
      }
      // P1 scopes narrowing to PERCH sessions. The thread id is caller-supplied
      // (foreignChannel()), the lens draws a session row for every channel, and
      // the bridge reads narrowed_tools on all of them — so without this an
      // operator could permanently strip a tool from a production gmail thread
      // from inside Perch, invisibly to Bot Builder, which is the single writer
      // of the envelope. Cross-channel narrowing is a Phase-2 question: it
      // needs a Bot Builder surface that shows the narrowing first.
      const foreign = foreignChannel(await latestSession(db, botId, threadId));
      if (foreign) return jsonError(res, 400, "not_a_perch_session", { gateway_type: foreign });
      const envelope = await buildEnvelope(db, parseDef(row));
      const allowed = new Set(envelope.tools.map((t) => t.id));
      // Perch narrows; Bot Builder widens. Anything outside the def's own grant
      // — unknown id, or one the def denies — is a widening attempt.
      const offending = [...new Set(list.filter((id) => !allowed.has(id)))];
      if (offending.length) return jsonError(res, 400, "widening_rejected", { offending });
      await saveNarrowing(db, botId, threadId, JSON.stringify([...new Set(list)]));
      res.json({ ok: true });
    } catch (err) {
      jsonError(res, 500, String((err && err.message) || err));
    } finally {
      try { db.close(); } catch { /* already closed */ }
    }
  });

  return router;
}
