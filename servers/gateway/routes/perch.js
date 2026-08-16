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
 * `express.json({limit:"1mb"})`. No per-route parser. The only input cap that
 * matters is the in-route `.slice(0, MESSAGE_CAP)` on the turn message.
 *
 * The factory's FIRST statement is `router.use(P, dashboardAuth)` — the
 * bot-board-api.js idiom. It is not redundant with the dashboard router's own
 * gate: it keeps this router self-sufficient wherever it is mounted, and the
 * unauthenticated case is asserted against a REAL route in
 * tests/perch-routes.test.js (proving the middleware in isolation, as C-3
 * does, would NOT prove this surface is closed).
 *
 * Turn model: perch is a per-turn channel like gmail, so a turn is one
 * `handleInbound()` call, made IN-PROCESS because only that gives us a
 * streaming `sendReply` to push down SSE. (Board dispatch, by contrast, spawns
 * a detached `--inject` child — routes/bot-board-api.js.)
 *
 * This is NOT the gateway's first in-process handleInbound: the gmail tick has
 * run one since C4 — bot-runtime.js imports `runBridgeTick` from
 * bridge_tick_lib.mjs, which imports `handleInbound` from the bridge directly.
 * What matters is the consequence. Perch turns and gmail tick turns now run in
 * ONE process on ONE event loop; both draw on the same host-wide pi capacity
 * budget (`countLivePi()` vs `LIFECYCLE_DEFAULTS.maxPi`, which is why a perch
 * turn can come back `{action:"deferred"}` because a gmail turn is occupying a
 * slot); and a perch turn therefore inherits exactly the `PIBOT_*` timeout and
 * env tuning a gmail turn gets on this host — including the local-model
 * systemd drop-ins, which is why turnTimeoutMs() reads PIBOT_TURN_TIMEOUT_MS
 * rather than hard-coding the bridge's default.
 *
 * The bridge is imported LAZILY so gateway boot stays light.
 */
import { Router } from "express";
import { randomUUID } from "node:crypto";
import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "../../db.js";
import { jsonError } from "./_error.js";
import { openStream } from "../streams/sse.js";
import { resolveEngineStatus, resolveBotRuntimeStatus } from "../dashboard/panels/bot-builder/engine-gate.js";
import { PI_BUILTIN, remoteInvocationOn } from "../dashboard/panels/bot-builder/data-queries.js";
import { perchAttached } from "../shared/perch-attached.js";
import { getInteractiveEngine } from "../perch-interactive.js";

/** Mount prefix. Every route below is registered under it, after the auth gate. */
const P = "/dashboard/perch-api";

/** Inbound message cap. The global body parser allows 1mb; a turn prompt does not. */
const MESSAGE_CAP = 32_000;

/** How long a finished/abandoned turn stays replayable before GC. Matches the
 * lens's own client-side watchdog (bots-page.mjs streamTurn). */
const TURN_TTL_MS = 15 * 60 * 1000;

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
// in-flight turns (process-local) + their event buffers
// ---------------------------------------------------------------------------

/** `${botId} ${threadId}` for every turn this process is running right now. */
const inFlight = new Set();
/** turnId → {events, done, createdAt, listeners} */
const turns = new Map();

const flightKeyFor = (botId, threadId) => botId + " " + threadId;

/** Test-only: drop every buffered turn and in-flight claim. */
export function _resetPerchTurnsForTest() {
  for (const turn of turns.values()) {
    for (const stream of turn.listeners) { try { stream.close(); } catch { /* already gone */ } }
  }
  turns.clear();
  inFlight.clear();
}

/** Lazy GC — no timers. A gateway with no perch traffic must not hold one. */
function sweepTurns(now = Date.now()) {
  for (const [id, turn] of turns) {
    if (now - turn.createdAt > TURN_TTL_MS) {
      for (const stream of turn.listeners) { try { stream.close(); } catch { /* already gone */ } }
      turns.delete(id);
    }
  }
}

function markTurnDone(turnId) {
  const turn = turns.get(turnId);
  if (!turn || turn.done) return;
  turn.done = true;
  for (const stream of turn.listeners) { try { stream.close(); } catch { /* already gone */ } }
  turn.listeners.clear();
}

/**
 * Append an event and fan it out to every attached stream. `reply` and `error`
 * are TERMINAL: the first one closes the turn, so a late second one (the
 * bridge already delivered its failure through sendReply, then resolved
 * `{action:"error"}`) can never double-report.
 */
function pushTurnEvent(turnId, event, data) {
  const turn = turns.get(turnId);
  if (!turn || turn.done) return;
  turn.events.push({ event, data });
  for (const stream of turn.listeners) { try { stream.send(event, data); } catch { /* dropped client */ } }
  if (event === "reply" || event === "error") markTurnDone(turnId);
}

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

/** Lazy bridge import — shared by the envelope (toolAllowlist) and the turn
 * (handleInbound). Cached by the ESM loader after the first call. */
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

/**
 * Take the turn claim. One transaction, SELECT-then-UPDATE-or-INSERT expressed
 * as UPDATE-latest + INSERT-if-none (db.batch() wraps both in a single
 * better-sqlite3 transaction), mirroring upsertSession() without ON CONFLICT.
 * The INSERT is what makes a first-ever perch turn possible; the UPDATE is what
 * makes the bridge's own getSession() find and REUSE this row a moment later.
 */
async function claimTurn(db, botId, threadId) {
  await db.batch([
    {
      sql:
        "UPDATE bot_sessions SET status='active', updated_at=datetime('now') " +
        "WHERE id=(SELECT id FROM bot_sessions WHERE bot_id=? AND gateway_thread_id=? ORDER BY id DESC LIMIT 1)",
      args: [botId, threadId],
    },
    {
      sql:
        "INSERT INTO bot_sessions (bot_id,gateway_type,gateway_thread_id,kind,status,control) " +
        "SELECT ?,'perch',?,'perch','active','run' " +
        "WHERE NOT EXISTS (SELECT 1 FROM bot_sessions WHERE bot_id=? AND gateway_thread_id=?)",
      args: [botId, threadId, botId, threadId],
    },
  ]);
}

/**
 * Release the claim — but ONLY if the row is still `active`. Every terminal
 * bridge path already writes its own status (waiting-user / done / error) and
 * must not be overwritten; the paths that DON'T (pi-capacity `deferred`, a
 * pre-flight throw) are exactly the ones that would otherwise leave a fresh
 * `active` row blocking the next message for a full turn budget.
 */
async function releaseClaim(botId, threadId) {
  const db = createDbClient();
  try {
    await db.execute({
      sql:
        "UPDATE bot_sessions SET status='waiting-user', updated_at=datetime('now') " +
        "WHERE status='active' AND id=(SELECT id FROM bot_sessions WHERE bot_id=? AND gateway_thread_id=? ORDER BY id DESC LIMIT 1)",
      args: [botId, threadId],
    });
  } catch { /* best effort: the claim ages out on its own */ } finally {
    try { db.close(); } catch { /* already closed */ }
  }
}

/** Persist a session's narrowing. Same one-transaction shape as claimTurn();
 * the created row is `waiting-user`, never `active` — narrowing a thread that
 * has never run must not read as a turn in progress. */
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
 * @param {Function} [seams.handleInboundImpl] test seam — replaces the lazy
 *   bridge import so a turn can be driven without spawning pi.
 * @param {Function} [seams.loadBridgeImpl] test seam — replaces the lazy import
 *   ITSELF, keeping its timing. `handleInboundImpl` short-circuits before the
 *   import and so resolves in a microtask, which can never interleave with
 *   another request; the real first turn of a gateway's life awaits a genuine
 *   module load. Only this seam reproduces that yield, which is the one window
 *   in which the in-flight guard is racy.
 * @param {Function|object} [seams.interactiveEngine] test seam (P2, C-15) — same
 *   accessor-or-object shape as perch-interactive-api.js's own `engine` seam.
 *   Used ONLY by GET /bots/:id/sessions to read live `state` for kind='perch-live'
 *   rows; every P1 test omits it and never touches the interactive engine at all.
 */
export default function perchApiRouter(dashboardAuth, { handleInboundImpl = null, loadBridgeImpl = loadBridge, interactiveEngine = getInteractiveEngine } = {}) {
  const router = Router();

  // FIRST statement: auth-gate the whole prefix (bot-board-api.js idiom).
  router.use(P, dashboardAuth);

  function resolveInteractiveEngine() {
    return typeof interactiveEngine === "function" ? interactiveEngine() : interactiveEngine;
  }

  async function resolveHandleInbound() {
    if (handleInboundImpl) return handleInboundImpl;
    return (await loadBridgeImpl()).handleInbound;
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
      // armed to service this bot's OTHER channels. A perch turn never needs
      // it (it runs in-process here), which is exactly why the lens shows it.
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

  // ---- GET /bots/:id/sessions — every session, every channel ----
  router.get(P + "/bots/:id/sessions", async (req, res) => {
    const botId = String(req.params.id);
    const db = createDbClient();
    try {
      const { rows } = await db.execute({
        sql:
          "SELECT id, kind, gateway_type, gateway_thread_id, status, card_id, plan_path, " +
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

  // ---- POST /bots/:id/turn — the conversation channel ----
  router.post(P + "/bots/:id/turn", async (req, res) => {
    const botId = String(req.params.id);
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const db = createDbClient();
    // Two separate undo obligations, both held only until the turn is LAUNCHED,
    // after which its own .finally() owns them: `held` is the in-flight memory
    // guard (taken before any await, see below), `claimed` is the DB row claim.
    let claimed = null;
    let held = null;
    try {
      const row = await loadBotRow(db, botId);
      if (!row) return jsonError(res, 404, "unknown_bot");
      // Engine first: it is the instance-wide condition, and the lens has a
      // distinct honest sentence for it.
      if (resolveEngineStatus().state !== "ready") return jsonError(res, 409, "engine_required");
      const def = parseDef(row);
      if (!perchAttached(def)) return jsonError(res, 403, "perch_not_attached");

      const message = String(body.message == null ? "" : body.message).slice(0, MESSAGE_CAP);
      if (!message.trim()) return jsonError(res, 400, "empty_message");

      const threadId = body.sessionId ? String(body.sessionId) : "perch-" + randomUUID().slice(0, 8);
      const flightKey = flightKeyFor(botId, threadId);
      // Gmail gets one-turn-per-thread serialization from its tick; perch has
      // no tick, so it enforces its own — two pi processes resuming ONE session
      // file corrupts the transcript. Memory guard for this process, DB claim
      // for the case where a restart landed mid-turn.
      //
      // The memory guard is checked and TAKEN in the same synchronous run, with
      // no await between: every await below (the session read, the lazy bridge
      // import, the DB claim) is a yield point at which a second request for
      // this thread would otherwise walk straight through a check that has
      // already passed. The bridge import is a real module load on a gateway's
      // first turn, so that window is not hypothetical.
      if (inFlight.has(flightKey)) return jsonError(res, 409, "turn_in_progress");
      inFlight.add(flightKey);
      held = flightKey;

      const existing = await latestSession(db, botId, threadId);
      // Perch turns run on perch threads and on brand-new ones. Never on
      // another channel's — see foreignChannel().
      const foreign = foreignChannel(existing);
      if (foreign) {
        inFlight.delete(held); held = null;
        return jsonError(res, 400, "not_a_perch_session", { gateway_type: foreign });
      }
      // P2 (C-15): a kind='perch-live' row is an interactive session, not a
      // per-turn chat thread — its gateway_type is 'perch' (not foreign), so
      // foreignChannel() above does not catch it. Without this refusal a
      // per-turn POST would claimTurn the row out from under the interactive
      // engine and spawn a SECOND pi against that same session file.
      if (existing && existing.kind === "perch-live") {
        inFlight.delete(held); held = null;
        return jsonError(res, 400, "not_a_perch_session", { kind: "perch-live" });
      }
      if (claimIsFresh(existing)) {
        inFlight.delete(held); held = null;
        return jsonError(res, 409, "turn_in_progress");
      }

      const handleInbound = await resolveHandleInbound();
      await claimTurn(db, botId, threadId);
      claimed = { flightKey, threadId };

      sweepTurns();
      const turnId = randomUUID();
      turns.set(turnId, { events: [], done: false, createdAt: Date.now(), listeners: new Set() });

      handleInbound({
        bot_id: botId,
        gateway_type: "perch",
        gateway_thread_id: threadId,
        // Ignored by today's bridge (opts are read by named field); C-6 plumbs
        // it through to the session row. Passing it now means C-6 is a bridge
        // change only.
        kind: "perch",
        user_message: message,
        sendReply: async (text) => pushTurnEvent(turnId, "reply", { text: String(text == null ? "" : text) }),
        // `log` is a PLAIN string, unlike reply/error: the lens writes it
        // straight into the pending line as raw `e.data` (it JSON-parses only
        // the terminal events), so a {text:…} wrapper would render as a JSON
        // blob. Newlines are collapsed because a bare "\n" inside an SSE data
        // payload would split the frame.
        log: (m) => pushTurnEvent(turnId, "log", String(m == null ? "" : m).replace(/[\r\n]+/g, " ").slice(0, 300)),
      }).then((result) => {
        // handleInbound's RESOLVED value is the contract, not the rejection:
        //  • {action:"deferred"} — pi was at capacity, sendReply was NEVER
        //    called and the gmail tick would retry. Perch has no tick, so the
        //    turn ends here and must say so.
        //  • {action:"error"} — the failure was already delivered through
        //    sendReply, so the terminal event exists; only mark it done.
        if (result && result.action === "deferred") {
          pushTurnEvent(turnId, "error", { text: "the bot engine is busy — try again in a moment" });
        }
        markTurnDone(turnId);
      }).catch((err) => {
        // Pre-flight throws only (unknown bot, unreadable def, …).
        pushTurnEvent(turnId, "error", { text: String((err && err.message) || err) });
        markTurnDone(turnId);
      }).finally(() => {
        inFlight.delete(flightKey);
        releaseClaim(botId, threadId);
      });
      // The turn is running: it owns both undo obligations now, and the catch
      // below must not release what a live turn is still holding.
      held = null;
      claimed = null;

      res.status(202).json({ turnId, sessionId: threadId });
    } catch (err) {
      if (claimed) releaseClaim(botId, claimed.threadId);
      if (held) inFlight.delete(held);
      jsonError(res, 500, String((err && err.message) || err));
    } finally {
      try { db.close(); } catch { /* already closed */ }
    }
  });

  // ---- GET /turns/:turnId/events — SSE; terminal event is reply or error ----
  router.get(P + "/turns/:turnId/events", (req, res) => {
    sweepTurns();
    const turn = turns.get(String(req.params.turnId));
    if (!turn) return jsonError(res, 404, "unknown_turn");
    const stream = openStream(res);
    if (!stream) return; // SSE cap reached — openStream already sent 503
    for (const e of turn.events) stream.send(e.event, e.data);
    if (turn.done) return stream.close();
    turn.listeners.add(stream);
    res.on("close", () => turn.listeners.delete(stream));
  });

  // ---- POST /bots/:id/sessions/:threadId/narrow — narrow only, never widen ----
  router.post(P + "/bots/:id/sessions/:threadId/narrow", async (req, res) => {
    const botId = String(req.params.id);
    // Keyed by gateway_thread_id, NOT the numeric row id: the turn flow only
    // ever knows thread ids, and a narrowing has to apply to the row the NEXT
    // turn will resume.
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
