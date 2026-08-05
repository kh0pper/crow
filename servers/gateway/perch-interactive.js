/**
 * perch-interactive.js — the interactive session engine (Perch Hub P2, C-13).
 *
 * P1's perch turns are per-turn like gmail: one `handleInbound()`, one pi
 * spawn, one reply, child dead. P2 adds the other half — "spawn as bot": a
 * LONG-LIVED `pi --mode rpc` child wearing a bot's full world (its def, its
 * project space, its .mcp.json, its skills, its permission policy, its
 * per-session tool narrowing), driven turn after turn from the bots lens, able
 * to ask the operator questions mid-turn.
 *
 * This module owns those children. It is the only thing in the gateway that
 * holds one, and it is a PROCESS SINGLETON (`getInteractiveEngine`) — the C-15
 * routes, perch.js's sessions list and index.js's shutdown all address the same
 * engine, because two engines would each think they were under the awake cap.
 *
 * ── The world, borrowed not reinvented ──────────────────────────────────────
 * Every spawn and every wake goes through C-11's `buildBotWorld` +
 * `prepareSpawn`, so an interactive child is assembled by the SAME code that
 * assembles a gmail turn's child — including `PI_BOT_PERMISSION_POLICY`,
 * `--no-approve`, the tool allowlist and the session narrowing. The engine adds
 * exactly one thing: `extraEnv: {PI_BOT_INTERACTIVE: "1"}`, which unlocks
 * pi-lab's ask-user `ctx.ui` path and nothing else (PL-3). A wake REBUILDS the
 * world rather than replaying a cached one — an envelope or narrowing edit made
 * while the session slept must take effect on the next turn, not the next
 * process restart.
 *
 * ── The turn model (r2 CR1/CR2 — both learned the hard way) ─────────────────
 * A turn is one `promptTurn(text, 0)`: no bridge turn budget, because a
 * long-lived child's turn is bounded by this engine's own stall watchdog
 * instead (`PERCH_TURN_STALL_MS`, reset on every child event, PAUSED while an
 * ask_user card is pending — a human thinking is not a stall).
 *   • Aborting a RUNNING turn is exactly what PRODUCES `agent_end`, so an abort
 *     cannot be modelled as "the turn ends now". `engine.abort` sets a flag
 *     BEFORE the RPC abort and the promptTurn continuation completes SILENTLY:
 *     **no `reply` event ever follows an `abort` on the same turn.**
 *   • Aborting with NO active run produces nothing at all, and an ack timeout
 *     may leave an agent loop live. pi's `agent_end` carries no id, so a late
 *     one from an abandoned turn would satisfy the NEXT turn's wait. Any turn
 *     that ends without a clean `agent_end` therefore CLOSES the child
 *     (C-12 carried finding 3) — a wake spawns a fresh one and pi resumes the
 *     session file. The one exception is a PREFLIGHT-REFUSED prompt
 *     (`prompt refused: …`), where no agent loop ever started: that degrades to
 *     an honest SSE error on a still-healthy session.
 *
 * ── Capacity (r1 C8 + r2 CR3) ───────────────────────────────────────────────
 * Awake children are capped (`PERCH_INTERACTIVE_MAX_AWAKE`, default 1) and draw
 * on the same host-wide pi budget as every channel turn (`countLivePi()` vs
 * `LIFECYCLE_DEFAULTS.maxPi`). Checking and then spawning is a TOCTOU (the P1
 * F3 class): the check and the RESERVATION happen in ONE synchronous block with
 * no await between them, so two concurrent spawns/wakes at cap produce exactly
 * one child and one refusal.
 *
 * ── Lifetime ────────────────────────────────────────────────────────────────
 * Idle → hibernate: the child is closed, the `bot_sessions` row and the pi
 * session file survive, and the next message wakes a fresh child with
 * `--session <id>`. Rows are never deleted. While ≥1 child is awake the engine
 * writes `<crowHome>/perch-interactive-leases.json` (atomically, refreshed
 * every 60 s) so the host-global pi reaper (C-14) does not kill a healthy
 * long-lived child for being old.
 *
 * ── Database ────────────────────────────────────────────────────────────────
 * Session rows go through the gateway's own `createDbClient` in the
 * SELECT-then-UPDATE-or-INSERT shape of perch.js `saveNarrowing` — never
 * `ON CONFLICT` (`idx_bot_sessions_bot_thread` is deliberately not unique) and
 * never perch.js `claimTurn` verbatim (its INSERT hardcodes `kind:'perch'`).
 * Metering and audit go through the BRIDGE's own busy-timeout-only connection,
 * exactly as a channel turn does — one path, one price book, one audit shape.
 *
 * IDENTITY NOTE: `sessionId` IS the `gateway_thread_id` (`perchlive-xxxxxxxx`).
 * One identity, so the P1 transcript endpoint — keyed on threadId — is
 * reachable with the same id the interactive routes use.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { createDbClient } from "../db.js";

/** Lease file name under CROW_HOME. Consumed by C-14's reaper exemption. */
export const LEASE_FILENAME = "perch-interactive-leases.json";
/** How long a written lease claims to be valid (3 × the refresh interval). */
const LEASE_TTL_MS = 180_000;
/** How often an awake engine re-stamps its leases. */
const LEASE_REFRESH_MS = 60_000;

const DEFAULT_IDLE_MS = 600_000;
const DEFAULT_STALL_MS = 600_000;
const DEFAULT_MAX_AWAKE = 1;
/** How long an aborted turn may take to produce its `agent_end` before the
 * child is treated as abandoned and closed (C-12 carried finding 3). */
const DEFAULT_ABORT_GRACE_MS = 30_000;
/** Default wall-clock bound for stopAll(), matching PERCH_STOP_TIMEOUT_MS. */
const DEFAULT_STOP_ALL_MS = 5_000;

/** A refusal the C-15 routes map straight onto an HTTP code. */
function engineError(code, extra) {
  const e = new Error(code);
  e.code = code;
  if (extra) Object.assign(e, extra);
  return e;
}

/** Assistant text of one pi message (same rule as PiRpc.assistantText). */
function assistantTextOf(message) {
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return "";
  return message.content.filter((c) => c && c.type === "text").map((c) => c.text).join("");
}

/** The reply text of a completed turn, taken from the agent_end we were handed
 * (never from the child's accumulating log, which trimLog() empties). */
function replyTextOf(end) {
  let out = "";
  for (const m of (end && end.messages) || []) out += assistantTextOf(m);
  return out.trim();
}

/** The four ask_user methods that produce an operator-facing card. Everything
 * else pi's extension UI channel carries is chrome we deliberately ignore. */
const ASK_METHODS = new Set(["select", "input", "confirm", "editor"]);

/**
 * Build a pendingUi card from an `extension_ui_request`.
 *
 * r1 S5: confirm carries `message` and editor carries `prefill`
 * (rpc-types.d.ts) — dropping them renders an empty card in the lens, which is
 * how a "just show title + options" implementation silently loses half the
 * question.
 */
function cardFrom(m) {
  const card = { requestId: m.id, method: m.method, title: m.title == null ? "" : String(m.title) };
  if (Array.isArray(m.options)) card.options = m.options.slice();
  if (m.placeholder != null) card.placeholder = m.placeholder;
  if (m.message != null) card.message = m.message;
  if (m.prefill != null) card.prefill = m.prefill;
  return card;
}

/**
 * @param {object} [opts]
 * @param {object} [opts.env] every env read goes through this object, at CALL
 *   time (#217 class) — so a test never needs the real process.env and a
 *   systemd drop-in retune needs only a restart.
 * @param {string} [opts.crowHome] where the lease file lives.
 * @param {object} [opts.bridge] test seam: `{buildBotWorld, prepareSpawn, PiRpc,
 *   warmModel, countLivePi, LIFECYCLE_DEFAULTS, meterTurn, appendAudit}`.
 *   Default is a LAZY import of bot-world.mjs + bridge.mjs + pi_lifecycle.mjs +
 *   warm.mjs + metering.mjs (the perch.js `loadBridge` idiom — gateway boot
 *   must not pay for the bot engine).
 * @param {Function} [opts.now] injectable clock (lease expiry is testable).
 * @param {Function} [opts.setTimer] injectable timer factory.
 * @param {Function} [opts.clearTimer]
 * @param {Function} [opts.log]
 */
export function createInteractiveEngine({
  env = process.env,
  crowHome = env.CROW_HOME || join(homedir(), ".crow"),
  bridge = null,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  log = (m) => console.log("[perch-interactive] " + m),
} = {}) {
  /** sessionId (= gateway_thread_id) → session record. */
  const sessions = new Map();
  let seams = null;
  let leaseTimer = null;

  // ---- env knobs, all read at call time -----------------------------------
  const numEnv = (key, dflt) => {
    const n = Number(env[key]);
    return Number.isFinite(n) && n > 0 ? n : dflt;
  };
  const idleMs = () => numEnv("PERCH_INTERACTIVE_IDLE_MS", DEFAULT_IDLE_MS);
  const stallMs = () => numEnv("PERCH_TURN_STALL_MS", DEFAULT_STALL_MS);
  const abortGraceMs = () => numEnv("PERCH_ABORT_GRACE_MS", DEFAULT_ABORT_GRACE_MS);
  const maxAwake = () => numEnv("PERCH_INTERACTIVE_MAX_AWAKE", DEFAULT_MAX_AWAKE);
  const turnTimeoutMs = () => numEnv("PIBOT_TURN_TIMEOUT_MS", 600_000);
  const disabled = () => env.CROW_DISABLE_PERCH === "1";

  // ---- seams ---------------------------------------------------------------

  /**
   * Resolve the bot-engine surface once, lazily. Exposed as `_loadSeams` so a
   * precondition test can prove every module path and export name resolves
   * without spawning anything (r1 S10) — the failure mode this guards against
   * is a renamed export that only bites the first real spawn on a live box.
   */
  async function loadSeams() {
    if (seams) return seams;
    if (bridge) {
      seams = bridge;
      return seams;
    }
    const [world, br, life, warm, metering] = await Promise.all([
      import("../../scripts/pi-bots/bot-world.mjs"),
      import("../../scripts/pi-bots/bridge.mjs"),
      import("../../scripts/pi-bots/pi_lifecycle.mjs"),
      import("../../scripts/pi-bots/warm.mjs"),
      import("../../scripts/pi-bots/metering.mjs"),
    ]);
    seams = {
      buildBotWorld: world.buildBotWorld,
      prepareSpawn: world.prepareSpawn,
      PiRpc: br.PiRpc,
      warmModel: warm.warmModel,
      countLivePi: life.countLivePi,
      LIFECYCLE_DEFAULTS: life.LIFECYCLE_DEFAULTS,
      // Metering wants a better-sqlite3 connection opened busy_timeout-ONLY
      // (metering.mjs's header: createDbClient would WAL-flip the prod crow.db
      // out from under the bridge). Use the bridge's own db()/CROW_DB, exactly
      // as handleInbound does.
      meterTurn: async (args) => {
        const conn = br.db(br.CROW_DB);
        try {
          return await metering.meterBotTurn({ conn, ...args });
        } finally {
          try { conn.close(); } catch { /* already closed */ }
        }
      },
      appendAudit: (projectId, o) => br.appendAuditBridge(projectId, o),
    };
    return seams;
  }

  // ---- session records -----------------------------------------------------

  function newSession(botId, threadId) {
    return {
      sessionId: threadId,
      botId,
      threadId,
      rowId: null,
      // "no child, not counted". The counted `waking` state is set by
      // reserveSlot() and ONLY by it — so the reservation is a real state
      // flip, not a side effect of landing in the sessions map.
      state: "hibernating",
      pi: null,
      piSessionId: null,
      projectId: null,
      resolved: null,
      pendingUi: null,
      lastError: null,
      turn: null,
      subscribers: new Set(),
      idleTimer: null,
      stallTimer: null,
    };
  }

  function snapshot(s) {
    return {
      sessionId: s.sessionId,
      botId: s.botId,
      threadId: s.threadId,
      rowId: s.rowId,
      state: s.state,
      pendingUi: s.pendingUi,
      lastError: s.lastError,
      model: s.resolved ? s.resolved.key : null,
    };
  }

  function emit(s, event) {
    for (const fn of [...s.subscribers]) {
      try { fn(event); } catch { /* a broken subscriber never breaks a turn */ }
    }
  }

  function stateEvent(s) {
    return {
      type: "state",
      sessionId: s.sessionId,
      botId: s.botId,
      threadId: s.threadId,
      state: s.state,
      lastError: s.lastError || null,
      pendingUi: s.pendingUi || null,
    };
  }

  /** A per-session log that reaches both the gateway log and the lens. */
  function sessionLog(s) {
    return (m) => {
      const text = String(m == null ? "" : m);
      log(s.sessionId + ": " + text);
      emit(s, { type: "log", text });
    };
  }

  // ---- timers --------------------------------------------------------------

  function timer(fn, ms) {
    const h = setTimer(fn, ms);
    // Never hold the process open on an engine timer — shutdown is
    // gracefulShutdown's job, not a 60 s lease refresh's.
    if (h && typeof h.unref === "function") h.unref();
    return h;
  }

  function clearIdle(s) {
    if (s.idleTimer != null) { clearTimer(s.idleTimer); s.idleTimer = null; }
  }
  function clearStall(s) {
    if (s.stallTimer != null) { clearTimer(s.stallTimer); s.stallTimer = null; }
  }

  /**
   * Arm the idle-hibernation countdown, if the session is eligible.
   *
   * Both refusals are load-bearing:
   *   • an in-flight turn owns the session (the stall watchdog covers it);
   *   • an UNANSWERED ask_user card must never be destroyed by hibernation —
   *     hibernating would kill the child that is waiting for the answer and
   *     lose the question with it. A card can legitimately arrive outside a
   *     turn (pi's extension host emits when it likes), so this is not implied
   *     by the turn check.
   */
  function armIdle(s) {
    clearIdle(s);
    if (!s.pi || s.state !== "awake") return;
    if (s.turn) return;
    if (s.pendingUi) return;
    s.idleTimer = timer(() => { hibernate(s).catch(() => {}); }, idleMs());
  }

  /** Arm the per-turn stall watchdog. Paused (not armed) while a card is
   * pending — a human thinking is not a stalled agent. */
  function armStall(s) {
    clearStall(s);
    if (!s.turn || !s.pi || s.pendingUi) return;
    const turn = s.turn;
    s.stallTimer = timer(() => { onStall(s, turn); }, stallMs());
  }

  function onStall(s, turn) {
    if (s.turn !== turn || turn.aborted) return;
    s.lastError = "turn stalled";
    emit(s, { type: "error", text: "turn stalled" });
    // A single tool silent past the window IS aborted — named operator-facing
    // policy (r2 S12), documented in the perch-hub developer docs.
    abortInFlight(s).catch(() => {});
  }

  // ---- lease file ----------------------------------------------------------

  /**
   * Atomically (tmp + rename) restate every awake child's lease. Written on
   * spawn, on every close, and every 60 s while at least one child is awake;
   * the last close writes an EMPTY lease set rather than leaving a stale pid
   * that would exempt somebody else's process from the reaper.
   */
  function writeLeases() {
    const leases = {};
    let anyAwake = false;
    for (const s of sessions.values()) {
      const pid = s.pi && s.pi.proc && s.pi.proc.pid;
      if (!pid) continue;
      anyAwake = true;
      leases[String(pid)] = { sessionId: s.sessionId, expiresAt: now() + LEASE_TTL_MS };
    }
    const file = join(crowHome, LEASE_FILENAME);
    const tmp = file + ".tmp-" + process.pid;
    try {
      mkdirSync(crowHome, { recursive: true });
      writeFileSync(tmp, JSON.stringify({ version: 1, leases }), { mode: 0o600 });
      renameSync(tmp, file);
    } catch (e) {
      log("lease write failed (non-fatal): " + ((e && e.message) || e));
    }
    if (anyAwake) armLeaseRefresh();
    else stopLeaseRefresh();
  }

  function armLeaseRefresh() {
    if (leaseTimer != null) return;
    leaseTimer = timer(function refresh() {
      leaseTimer = null;
      writeLeases();
    }, LEASE_REFRESH_MS);
  }

  function stopLeaseRefresh() {
    if (leaseTimer != null) { clearTimer(leaseTimer); leaseTimer = null; }
  }

  // ---- session rows --------------------------------------------------------

  /**
   * Write this session's row: UPDATE the newest row for (bot, thread) if one
   * exists, else INSERT. One db.batch() = one better-sqlite3 transaction; the
   * shape is perch.js `saveNarrowing`'s, NOT `claimTurn`'s (which hardcodes
   * kind='perch') and never ON CONFLICT (the index is not unique).
   */
  async function writeRow(s, { status, piSessionDir = null, model = null }) {
    const db = createDbClient();
    try {
      await db.batch([
        {
          sql:
            "UPDATE bot_sessions SET kind='perch-live', gateway_type='perch', status=?, control='run', " +
            "project_id=COALESCE(?, project_id), pi_session_dir=COALESCE(?, pi_session_dir), " +
            "model=COALESCE(?, model), updated_at=datetime('now') " +
            "WHERE id=(SELECT id FROM bot_sessions WHERE bot_id=? AND gateway_thread_id=? ORDER BY id DESC LIMIT 1)",
          args: [status, s.projectId, piSessionDir, model, s.botId, s.threadId],
        },
        {
          sql:
            "INSERT INTO bot_sessions (bot_id,gateway_type,gateway_thread_id,kind,status,control,project_id,pi_session_dir,model) " +
            "SELECT ?,'perch',?,'perch-live',?,'run',?,?,? " +
            "WHERE NOT EXISTS (SELECT 1 FROM bot_sessions WHERE bot_id=? AND gateway_thread_id=?)",
          args: [s.botId, s.threadId, status, s.projectId, piSessionDir, model, s.botId, s.threadId],
        },
      ]);
      const { rows } = await db.execute({
        sql: "SELECT id FROM bot_sessions WHERE bot_id=? AND gateway_thread_id=? ORDER BY id DESC LIMIT 1",
        args: [s.botId, s.threadId],
      });
      if (rows[0]) s.rowId = Number(rows[0].id);
    } finally {
      try { db.close(); } catch { /* already closed */ }
    }
  }

  /** Persist the pi session id the child reported (the resume handle, and what
   * the P1 transcript endpoint globs the session file by). */
  async function writePiSessionId(s) {
    if (!s.piSessionId) return;
    const db = createDbClient();
    try {
      await db.execute({
        sql: "UPDATE bot_sessions SET pi_session_id=?, updated_at=datetime('now') WHERE id=?",
        args: [s.piSessionId, s.rowId],
      });
    } catch { /* the row is re-stamped on the next turn */ } finally {
      try { db.close(); } catch { /* already closed */ }
    }
  }

  /**
   * Cross-process claim check, applied ONLY on the wake path.
   *
   * An awake session's own row sits at `status='active'` for as long as we hold
   * the child, so re-checking it on every message would 409 ourselves. On a
   * wake the child is not ours yet, and a fresh `active` claim means another
   * process (a restarted gateway, a second instance) is mid-turn on this
   * thread; stale claims age out after one turn budget, so a crashed gateway
   * cannot wedge a thread forever. Same rule as perch.js claimIsFresh().
   */
  async function assertRowClaimable(s) {
    const db = createDbClient();
    try {
      const { rows } = await db.execute({
        sql:
          "SELECT status, (strftime('%s','now') - strftime('%s', updated_at)) AS age_s " +
          "FROM bot_sessions WHERE bot_id=? AND gateway_thread_id=? ORDER BY id DESC LIMIT 1",
        args: [s.botId, s.threadId],
      });
      const row = rows[0];
      if (!row || row.status !== "active") return;
      const age = Number(row.age_s);
      if (Number.isFinite(age) && age * 1000 < turnTimeoutMs()) throw engineError("turn_in_progress");
    } finally {
      try { db.close(); } catch { /* already closed */ }
    }
  }

  /** Adopt a hibernating perch-live row this process does not hold in memory
   * (gateway restart, or a session spawned before the last deploy). */
  async function adopt(sessionId) {
    const db = createDbClient();
    try {
      const { rows } = await db.execute({
        sql:
          "SELECT id, bot_id, gateway_thread_id, status, model, pi_session_id, project_id " +
          "FROM bot_sessions WHERE gateway_thread_id=? AND kind='perch-live' ORDER BY id DESC LIMIT 1",
        args: [sessionId],
      });
      const row = rows[0];
      if (!row) return null;
      const s = newSession(String(row.bot_id), String(row.gateway_thread_id));
      s.rowId = Number(row.id);
      s.piSessionId = row.pi_session_id || null;
      s.projectId = row.project_id == null ? null : Number(row.project_id);
      s.state = row.status === "stopped" ? "stopped" : "hibernating";
      sessions.set(s.sessionId, s);
      return s;
    } catch {
      return null;
    } finally {
      try { db.close(); } catch { /* already closed */ }
    }
  }

  // ---- capacity ------------------------------------------------------------

  /**
   * The whole gate, in ONE synchronous statement sequence: check, then RESERVE
   * by flipping the session to the counted `waking` state. Nothing may await
   * between the two halves — that window is precisely the TOCTOU two concurrent
   * spawns walk through (r2 CR3; the P1 F3 class).
   *
   * The caller has already resolved the seams (an await), so `countLivePi()` is
   * a synchronous ps scan here.
   */
  function reserveSlot(S, session) {
    if (disabled()) throw engineError("perch_disabled");
    let counted = 0;
    let reservedNotSpawned = 0;
    for (const other of sessions.values()) {
      if (other === session) continue;
      if (other.state !== "awake" && other.state !== "waking") continue;
      counted += 1;
      if (!other.pi) reservedNotSpawned += 1;
    }
    if (counted >= maxAwake()) throw engineError("interactive_capacity");
    const live = S.countLivePi();
    if (live + reservedNotSpawned >= S.LIFECYCLE_DEFAULTS.maxPi) throw engineError("pi_capacity");
    session.state = "waking";                 // ← the reservation itself
  }

  // ---- child construction --------------------------------------------------

  /**
   * Build the world FRESH, warm the model, construct the child, attach the exit
   * handler, and stamp the row. Shared by spawn (piSessionId null) and wake
   * (piSessionId = the stored pi session, so pi resumes the same transcript).
   */
  async function startChild(S, s) {
    const slog = sessionLog(s);
    const world = await S.buildBotWorld({
      botId: s.botId, threadId: s.threadId, gatewayType: "perch", log: slog,
    });
    const prep = await S.prepareSpawn(world, { escalate: false, log: slog });
    s.projectId = world.projectId == null ? null : Number(world.projectId);
    s.resolved = prep.resolved;
    await S.warmModel(prep.resolved.provider, slog);

    const resume = (world.session && world.session.pi_session_id) || s.piSessionId || null;
    const pi = new S.PiRpc(Object.assign({}, prep.piRpcOpts, {
      piSessionId: resume,
      onEvent: (m) => onChildEvent(s, m),
      // The ONE thing the interactive engine adds to a bot's spawn: pi-lab's
      // ask-user ctx.ui unlock (PL-3). C-12's spawn_env hygiene guarantees a
      // bot def cannot set this itself for a channel turn.
      extraEnv: { PI_BOT_INTERACTIVE: "1" },
    }));
    s.pi = pi;
    s.piSessionId = resume;
    attachExit(s, pi);

    await writeRow(s, {
      status: "active",
      // r1 C6: without pi_session_dir the transcript endpoint's
      // resolveTranscriptFile(row.pi_session_dir, …) 404s and the resume pane
      // is dead.
      piSessionDir: world.sessionDir + "/sessions",
      model: prep.resolved.key,
    });

    const st = await pi.getState().catch(() => null);
    const reported = st && st.data && st.data.sessionId;
    if (reported) {
      s.piSessionId = String(reported);
      await writePiSessionId(s);
    }
    s.state = "awake";
    s.lastError = null;
    writeLeases();
    return pi;
  }

  /**
   * An unexpected exit (crash, OOM, the reaper). Every EXPECTED close clears
   * `s.pi` first, so reaching here means nobody asked for this.
   */
  function attachExit(s, pi) {
    pi.exited.then(() => {
      if (s.pi !== pi) return;                       // an expected close
      s.pi = null;
      s.turn = null;
      clearStall(s);
      clearIdle(s);
      s.pendingUi = null;                            // r1 S4
      let message = "pi exited unexpectedly";
      try {
        if (typeof pi._exitError === "function") message = pi._exitError("responding").message;
      } catch { /* keep the generic message */ }
      s.lastError = message;
      if (s.state !== "stopped") s.state = "hibernating";
      writeLeases();
      emit(s, { type: "error", text: message });
      emit(s, stateEvent(s));
      writeRow(s, { status: "waiting-user" }).catch(() => {});
    }).catch(() => {});
  }

  // ---- child event forwarding (the curation contract) ----------------------

  /**
   * Every parsed stdout message from the child, synchronously.
   *
   * `agent_end` is deliberately NOT turned into a `reply` here: the turn
   * completion path owns that, because an ABORTED turn's agent_end must be
   * silent (r2 CR2) and a `willRetry` agent_end is not a turn end at all
   * (C-12 filters it inside promptTurn).
   */
  function onChildEvent(s, m) {
    if (!m || typeof m !== "object") return;
    touchStall(s);
    switch (m.type) {
      case "tool_execution_start":
        emit(s, { type: "tool", name: m.toolName, phase: "start", isError: false });
        return;
      case "tool_execution_end":
        if (s.turn && m.toolName) s.turn.toolNames.push(m.toolName);
        emit(s, { type: "tool", name: m.toolName, phase: "end", isError: !!m.isError });
        return;
      case "message_end": {
        // Message-level streaming; delta-level is a recorded non-goal.
        const text = assistantTextOf(m.message);
        if (text) emit(s, { type: "text", text });
        return;
      }
      case "extension_ui_request":
        onUiRequest(s, m);
        return;
      default:
        // agent_end, message_update, model_select, … — not part of the lens
        // vocabulary. Silence is the contract, not an oversight.
    }
  }

  function onUiRequest(s, m) {
    if (ASK_METHODS.has(m.method)) {
      s.pendingUi = cardFrom(m);
      clearStall(s);                                 // paused while a human thinks
      emit(s, { type: "ask_user", ...s.pendingUi });
      armIdle(s);                                    // no-op by design: a pending card blocks it
      return;
    }
    if (m.method === "notify") {
      emit(s, { type: "log", text: m.message == null ? "" : String(m.message) });
      return;
    }
    // setStatus | setWidget | setTitle | set_editor_text — TUI chrome, ignored.
  }

  /** Reset the stall watchdog on child activity (never while a card pends). */
  function touchStall(s) {
    if (!s.turn || s.pendingUi) return;
    armStall(s);
  }

  // ---- turn completion -----------------------------------------------------

  function finishTurn(s, turn) {
    if (turn.graceTimer != null) { clearTimer(turn.graceTimer); turn.graceTimer = null; }
    if (s.turn === turn) s.turn = null;
    clearStall(s);
  }

  async function onTurnEnd(s, turn, end) {
    if (s.turn !== turn) return;                     // superseded / already abandoned
    finishTurn(s, turn);

    if (turn.aborted) {
      // Silent completion: state only. No `reply` event ever follows an abort
      // on the same turn — the mutation-guarded invariant of this engine.
      await writeRow(s, { status: "waiting-user" }).catch(() => {});
      emit(s, stateEvent(s));
      armIdle(s);
      return;
    }

    const S = await loadSeams();
    const statsAfter = s.pi ? await s.pi.getSessionStats().catch(() => null) : null;
    // r2 CR6: every other bot turn meters AND audits (bridge handleInbound,
    // job_runner). An interactive turn is a bot turn.
    try {
      await S.meterTurn({
        statsBefore: turn.statsBefore && turn.statsBefore.data,
        statsAfter: statsAfter && statsAfter.data,
        resolved: s.resolved,
        surface: "bot",
        requestId: s.piSessionId,
        log: (m) => log(m),
      });
    } catch (e) {
      log("metering failed (non-fatal): " + ((e && e.message) || e));
    }
    try {
      S.appendAudit(s.projectId, {
        actor_type: "bot",
        actor_id: s.botId,
        action: "bot.invoke",
        target: "thread:" + s.threadId,
        payload: {
          action: "interactive",
          tool_calls: turn.toolNames.length,
          tool_names: turn.toolNames.slice(),
          model: s.resolved ? s.resolved.key : null,
          escalated: s.resolved && s.resolved.escalated ? 1 : 0,
          session_id: s.rowId,
        },
      });
    } catch (e) {
      log("audit failed (non-fatal): " + ((e && e.message) || e));
    }

    emit(s, { type: "reply", text: replyTextOf(end) });
    // r2 S7: bound the child's accumulating log now that nothing is waiting on
    // it. trimLog preserves _seq, so the next turn's `since` correlation holds.
    try { if (s.pi) s.pi.trimLog(); } catch { /* non-fatal */ }
    await writeRow(s, { status: "waiting-user", model: s.resolved ? s.resolved.key : null }).catch(() => {});
    emit(s, stateEvent(s));
    armIdle(s);
  }

  async function onTurnError(s, turn, err) {
    if (s.turn !== turn) return;
    finishTurn(s, turn);
    const message = String((err && err.message) || err);
    s.lastError = message;
    emit(s, { type: "error", text: message });
    await writeRow(s, { status: "waiting-user" }).catch(() => {});

    // A PREFLIGHT refusal never started an agent loop (C-12 (h)): the child is
    // healthy and the session degrades to an honest error. Anything else — an
    // ack timeout above all — may have left a live loop whose late, id-less
    // agent_end would end the NEXT turn, so the child is abandoned.
    if (/^prompt refused:/.test(message)) {
      emit(s, stateEvent(s));
      armIdle(s);
      return;
    }
    if (s.pi) await abandonChild(s, message);
    else emit(s, stateEvent(s));
  }

  /**
   * Close a child we can no longer trust and park the session (C-12 carried
   * finding 3). The pi session file survives, so the next message wakes a fresh
   * child that resumes the same transcript.
   */
  async function abandonChild(s, reason) {
    const pi = s.pi;
    s.pi = null;
    s.turn = null;
    clearStall(s);
    clearIdle(s);
    s.pendingUi = null;
    if (s.state !== "stopped") s.state = "hibernating";
    if (reason) s.lastError = reason;
    if (pi) { try { await pi.close(); } catch { /* already dead */ } }
    writeLeases();
    await writeRow(s, { status: "waiting-user" }).catch(() => {});
    emit(s, stateEvent(s));
  }

  // ---- public surface ------------------------------------------------------

  async function spawn({ botId }) {
    if (!botId) throw engineError("bad_request");
    const S = await loadSeams();
    // ---- one synchronous block: gates + reservation, no await between ----
    const threadId = "perchlive-" + randomUUID().slice(0, 8);
    const s = newSession(String(botId), threadId);
    reserveSlot(S, s);
    sessions.set(s.sessionId, s);
    // ---------------------------------------------------------------------
    try {
      await startChild(S, s);
    } catch (e) {
      sessions.delete(s.sessionId);                  // release the reservation
      if (s.pi) { try { await s.pi.close(); } catch { /* nothing to reap */ } }
      writeLeases();
      throw e;
    }
    emit(s, stateEvent(s));
    armIdle(s);
    return { sessionId: s.sessionId, threadId: s.threadId, state: s.state };
  }

  async function message(sessionId, text) {
    const S = await loadSeams();
    let s = sessions.get(String(sessionId));
    if (!s) s = await adopt(String(sessionId));
    if (!s) throw engineError("no_such_session");
    // ---- one synchronous block: guards + reservation, no await between ----
    if (s.state === "stopped") throw engineError("session_stopped");
    if (s.turn) throw engineError("turn_in_progress");
    const needsWake = !s.pi;
    if (needsWake) reserveSlot(S, s);                // r1 C8: the wake path re-gates
    const turn = { id: randomUUID(), aborted: false, toolNames: [], statsBefore: null, graceTimer: null };
    s.turn = turn;
    // ---------------------------------------------------------------------
    try {
      if (needsWake) {
        await assertRowClaimable(s);
        await startChild(S, s);
      } else {
        await writeRow(s, { status: "active", model: s.resolved ? s.resolved.key : null });
      }
    } catch (e) {
      s.turn = null;
      if (needsWake) {
        s.state = s.pi ? "awake" : "hibernating";    // release the reservation
        if (s.pi) { try { await s.pi.close(); } catch { /* nothing to reap */ } s.pi = null; }
        writeLeases();
      }
      throw e;
    }

    clearIdle(s);
    turn.statsBefore = await s.pi.getSessionStats().catch(() => null);
    armStall(s);
    emit(s, stateEvent(s));
    // ms=0: no bridge turn budget. The stall watchdog above is this turn's
    // only clock. Every engine-held promptTurn carries a .catch — a child that
    // dies mid-turn REJECTS it, and an unhandled rejection in the gateway
    // process is a crash, not a log line.
    s.pi.promptTurn(text, 0)
      .then((end) => onTurnEnd(s, turn, end))
      .catch((e) => onTurnError(s, turn, e))
      .catch(() => {});
    return { turnId: turn.id };
  }

  function answer(sessionId, requestId, value) {
    const s = sessions.get(String(sessionId));
    if (!s) throw engineError("no_such_session");
    const card = s.pendingUi;
    // Liveness BEFORE send (r1 S4): a dead child must yield a 409-shaped
    // no_such_request, never PiRpc's raw _exitError as a 500.
    const alive = !!(s.pi && s.pi._exitCode == null);
    if (!card || card.requestId !== requestId || !alive) throw engineError("no_such_request");
    const payload = { type: "extension_ui_response", id: requestId };
    if (value && value.cancelled) {
      // PL-3's third edit resolves the tool as "Question cancelled" — the C2
      // hang is closed at the source, so a cancel is a real answer.
      payload.cancelled = true;
    } else if (card.method === "confirm") {
      payload.confirmed = !!(value && value.confirmed);
    } else {
      payload.value = String(value && value.value != null ? value.value : "");
    }
    s.pi.send(payload);
    s.pendingUi = null;
    armStall(s);                                     // watchdog resumes
    armIdle(s);
    emit(s, stateEvent(s));
    return { ok: true };
  }

  /**
   * Abort the in-flight turn (operator button or stall watchdog). The flag is
   * set BEFORE the RPC abort so the promptTurn continuation — which an abort of
   * a RUNNING turn will produce — completes silently. If no agent_end arrives
   * within the grace window (abort with no active run emits NOTHING), the child
   * is abandoned rather than reused.
   */
  async function abortInFlight(s) {
    const turn = s.turn;
    clearStall(s);
    s.pendingUi = null;                              // r1 S4
    if (turn) {
      turn.aborted = true;
      turn.graceTimer = timer(() => {
        if (s.turn === turn) abandonChild(s, "aborted turn produced no agent_end — child closed").catch(() => {});
      }, abortGraceMs());
    }
    emit(s, stateEvent(s));
    if (s.pi && turn) { try { await s.pi.abortSince(); } catch { /* best effort */ } }
    if (!turn) armIdle(s);
    return { ok: true };
  }

  async function abort(sessionId) {
    const s = sessions.get(String(sessionId));
    if (!s) throw engineError("no_such_session");
    return abortInFlight(s);
  }

  async function stop(sessionId) {
    const s = sessions.get(String(sessionId));
    if (!s) throw engineError("no_such_session");
    const pi = s.pi;
    s.pi = null;
    if (s.turn) s.turn.aborted = true;               // a late agent_end stays silent
    s.turn = null;
    clearStall(s);
    clearIdle(s);
    s.pendingUi = null;
    s.state = "stopped";
    if (pi) { try { await pi.close(); } catch { /* already dead */ } }
    writeLeases();
    await writeRow(s, { status: "stopped" }).catch(() => {});
    emit(s, stateEvent(s));
    return { ok: true };
  }

  function subscribe(sessionId, fn) {
    const s = sessions.get(String(sessionId));
    if (!s) throw engineError("no_such_session");
    s.subscribers.add(fn);
    try {
      fn(stateEvent(s));
      // Replay the pending question, and ONLY a pending one: stop / abort /
      // hibernate / child exit all clear it, so a late subscriber can never be
      // shown a card no child is waiting on.
      if (s.pendingUi) fn({ type: "ask_user", ...s.pendingUi });
    } catch { /* a broken subscriber is not our problem */ }
    return () => s.subscribers.delete(fn);
  }

  function get(sessionId) {
    const s = sessions.get(String(sessionId));
    return s ? snapshot(s) : null;
  }

  /** Every session this process holds, plus the perch-live rows it does not
   * (a previous gateway's sessions — hibernating by construction, since their
   * children died with that process). */
  async function list() {
    const out = [...sessions.values()].map(snapshot);
    const known = new Set(out.map((o) => o.sessionId));
    const db = createDbClient();
    try {
      const { rows } = await db.execute({
        sql:
          "SELECT id, bot_id, gateway_thread_id, status, model FROM bot_sessions " +
          "WHERE kind='perch-live' ORDER BY id DESC LIMIT 100",
        args: [],
      });
      for (const r of rows) {
        const id = String(r.gateway_thread_id);
        if (known.has(id)) continue;
        known.add(id);
        out.push({
          sessionId: id,
          botId: String(r.bot_id),
          threadId: id,
          rowId: Number(r.id),
          state: r.status === "stopped" ? "stopped" : "hibernating",
          pendingUi: null,
          lastError: null,
          model: r.model || null,
        });
      }
    } catch { /* the in-memory answer is still true */ } finally {
      try { db.close(); } catch { /* already closed */ }
    }
    return out;
  }

  /** Hibernate: close the child, keep the row. */
  async function hibernate(s) {
    if (!s.pi) return;
    const pi = s.pi;
    s.pi = null;
    clearIdle(s);
    clearStall(s);
    s.pendingUi = null;
    s.state = "hibernating";
    try { await pi.close(); } catch { /* already dead */ }
    writeLeases();
    await writeRow(s, { status: "waiting-user" }).catch(() => {});
    emit(s, stateEvent(s));
  }

  /**
   * Kill every child, bounded. Wired into gracefulShutdown and the
   * CROW_DISABLE_PERCH / uninstall path. Children die; rows persist — that is
   * hibernation, not deletion, so the next boot can wake them.
   *
   * The bound is REAL wall-clock (never the injected test clock): a child
   * ignoring SIGTERM must not hold the gateway's shutdown open.
   */
  async function stopAll({ timeoutMs = DEFAULT_STOP_ALL_MS } = {}) {
    stopLeaseRefresh();
    const live = [...sessions.values()].filter((s) => s.pi);
    await Promise.all(live.map(async (s) => {
      const pi = s.pi;
      s.pi = null;
      clearIdle(s);
      clearStall(s);
      s.pendingUi = null;
      if (s.turn) s.turn.aborted = true;
      s.turn = null;
      if (s.state !== "stopped") s.state = "hibernating";
      let timerHandle = null;
      await Promise.race([
        Promise.resolve().then(() => pi.close()).catch(() => {}),
        new Promise((r) => { timerHandle = setTimeout(r, timeoutMs); }),
      ]);
      if (timerHandle) clearTimeout(timerHandle);
    }));
    writeLeases();
    return { stopped: live.length };
  }

  return {
    spawn,
    message,
    answer,
    abort,
    stop,
    subscribe,
    get,
    list,
    stopAll,
    /** Precondition-test surface (r1 S10) — also the internal resolver. */
    _loadSeams: loadSeams,
  };
}

// ---------------------------------------------------------------------------
// the process singleton (r1 S6)
// ---------------------------------------------------------------------------

let singleton = null;

/**
 * The ONE engine this process has. The router, perch.js's sessions list and
 * index.js's shutdown all share it — two engines would each believe they were
 * under the awake cap, and each would write the other's pids out of the lease
 * file.
 *
 * @param {{createIfMissing?: boolean}} [opts] shutdown passes
 *   `createIfMissing:false`: a gateway that never ran an interactive session
 *   must not mint an engine (and a lease file) on its way out.
 */
export function getInteractiveEngine({ createIfMissing = true } = {}) {
  if (!singleton && createIfMissing) singleton = createInteractiveEngine();
  return singleton;
}

/** Test-only: drop the singleton so one test can never leak an engine (or a
 * live child) into the next. */
export function _resetInteractiveEngineForTest() {
  singleton = null;
}
