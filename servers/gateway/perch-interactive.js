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
 * `--session <id>`. Rows are never deleted. A gateway RESTART is the same
 * story writ large: stopAll() parks every row `waiting-user` before closing
 * its child (a row left `active` would read as a live cross-process claim and
 * 409 the next boot's wake), and EVERY public method adopts a perch-live row
 * this process has never held — not just message(). While ≥1 child is awake the engine
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
 *
 * ── Model tracking, control(), options() (Track 3 Task 4) ──────────────────
 * The session record carries the engine's OWN idea of the serving model
 * (`currentModel`/`currentModelParts`), separate from `resolved` (what the
 * last spawn/wake's `prepareSpawn` computed). It is set two ways: a live
 * `model_select` event forwarded from the child (pi's own /model, an
 * auto-fallback, or the echo of our own `control()` switch), or `control()`
 * itself. `startChild` reads it BEFORE `warmModel`/`PiRpc` construction, so a
 * wake after a switch warms and spawns the RIGHT provider and prices the
 * right model from turn 1 — not only after pi re-emits `model_select` on its
 * own. `control()` applies what it can to a LIVE child via `PiRpc.commandSince`
 * (Task 3) and stores what only binds at the next wake (a model switch made
 * while hibernating; permission mode, ALWAYS — pi's permission policy is
 * fixed via env at spawn time, so no live session can adopt a new mode
 * without a wake it did not ask for).
 *
 * RESTART SEMANTICS (named for the reviewer, spec §5.3): `adoptRow` does NOT
 * restore `permissionMode` from anywhere — an adopted session (gateway
 * restart, or a session this process never held) resets to `"guarded"`. This
 * is the fail-safe reading: a restart must never silently resurrect a
 * `"bypass"` session; the drawer shows the (reset) current mode so the
 * operator sees it and can consciously re-widen it.
 *
 * ── Card binding, occupancy, dispatch (Track 3 Task 6) ──────────────────────
 * `spawn({botId, cardId})` binds a session to a board card. `cardClaims`
 * (cardId → sessionId, this engine instance's own state) enforces exclusion
 * SYNCHRONOUSLY, in the same statement run as `reserveSlot()` — no await
 * between the check and the claim, same TOCTOU discipline as capacity. The
 * async `checkCardFree()` is the DB-backed half: it is what a FRESH engine
 * (no in-memory claims yet, a restart) or the dispatch ROUTE (before it ever
 * reaches this engine) relies on. A card claim OUTLIVES hibernation — only
 * `stop()` (or an exit that lands on an already-`stopped` session) releases
 * it, so a card dispatched to a now-sleeping Perch session cannot be
 * re-dispatched out from under it.
 *
 * DISPATCH STARTS THE TURN (review Q1, job-rail analog): `spawn()` stores
 * `s.dispatchBrief` (the card + world context needed to compose the prompt,
 * not the prompt itself — the operator's note is not known until the first
 * `message()` call). The FIRST `message(sid, note)` after a card-bound spawn
 * composes the real prompt as `projectContextBlock` + `cardBriefBlock` + an
 * outputs-dir footer and clears `dispatchBrief`; every later `message()` on
 * that session sends raw text, exactly like a non-card session always has.
 *
 * ATTACH-CARD (Track 3 Task 9): `attachCard(sessionId, cardId)` binds an
 * ALREADY-SPAWNED session to a card — the drawer's own "attach to this card"
 * action, distinct from `spawn({cardId})`'s dispatch-time binding. It does
 * NOT run the async `checkCardFree` DB check itself — the ROUTE runs that
 * (plus card-existence/archived/kind validation) BEFORE calling in, mirroring
 * `spawn()`'s own split between the route/engine occupancy halves. Refused on
 * `session_stopped`.
 *
 * PER-SESSION DIRS: every spawn/wake (`startChild`) mkdirs an `outputsDir`
 * and `uploadsDir` keyed on `sessionId` under the bot's world `sessionDir`,
 * threading `outputsDir` into the child as `extraWritePaths` (Task 3) — the
 * only place the child may write files it wants the operator to see. A later
 * routes task serves both back to the drawer; `snapshot()` exposes both.
 *
 * PER-BOT WORLD-BUILD MUTEX (spec §3.2/I9): `.mcp.json` content varies by
 * jobId, so two in-gateway `buildBotWorld()` calls for the SAME bot (two
 * sessions, or a session racing a card job run in-gateway) would race the
 * write. `worldBuildLocks` (botId → promise chain) serializes them. The
 * cross-process bridge-tick race is pre-existing and explicitly out of scope
 * (spec §9).
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { createDbClient } from "../db.js";
import { jobLockFor } from "./routes/board-lock.js";
import { cardBriefBlock } from "../../scripts/pi-bots/card-brief.mjs";

/** Lease file name under CROW_HOME. Consumed by C-14's reaper exemption. */
export const LEASE_FILENAME = "perch-interactive-leases.json";
/** How long a written lease claims to be valid (3 × the refresh interval). */
const LEASE_TTL_MS = 180_000;
/** How often an awake engine re-stamps its leases. */
const LEASE_REFRESH_MS = 60_000;

const DEFAULT_IDLE_MS = 600_000;
const DEFAULT_STALL_MS = 600_000;
/** Track 3 Task 7 (T3-6 decision): 1 -> 3. Safe-victim eviction (below) makes
 * a saturated awake cap a controlled handover instead of a bare refusal, so
 * the default no longer needs to hold at the most conservative value. The env
 * knob (`PERCH_INTERACTIVE_MAX_AWAKE`) is unchanged — only the fallback when
 * it is unset moves. */
const DEFAULT_MAX_AWAKE = 3;
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

/** Track 3 Task 5: prefix pi-lab's rpc-state-bridge extension puts on a
 * `notify` message to mirror bus state (currently plan-mode) over the
 * extension-UI channel instead of the transcript. */
const CROW_STATE_PREFIX = "crow-state:";

/** Track 3 Task 4: the engine-owned permission vocabulary (bridge.mjs's
 * PiRpc constructor option of the same name) — control() rejects anything
 * outside this set with `bad_request` rather than passing an unknown mode
 * string through to a live spawn. */
const PERMISSION_MODES = new Set(["guarded", "ask", "bypass"]);

/** Track 3 Task 4: pi's ThinkingLevel union (rpc-types.d.ts, pi-coding-agent
 * 0.82.0) — control() validates against this fixed vocabulary so a typo
 * fails fast as `bad_request` instead of round-tripping to the child only to
 * come back as an opaque `command_failed`. */
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

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
  /** sessionId → in-flight adoption promise (fix round 2: single-flight). */
  const adopting = new Map();
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
  // Track 3 Task 8: a turn-end "<bot> replied" push only fires once the turn
  // ran at least this long — a fast reply doesn't need a nudge.
  const notifyMinRunS = () => numEnv("PERCH_NOTIFY_MIN_RUN_S", 30);

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
    const [world, br, life, warm, metering, tracker] = await Promise.all([
      import("../../scripts/pi-bots/bot-world.mjs"),
      import("../../scripts/pi-bots/bridge.mjs"),
      import("../../scripts/pi-bots/pi_lifecycle.mjs"),
      import("../../scripts/pi-bots/warm.mjs"),
      import("../../scripts/pi-bots/metering.mjs"),
      import("../../scripts/pi-bots/tracker.mjs"),
    ]);
    seams = {
      buildBotWorld: world.buildBotWorld,
      prepareSpawn: world.prepareSpawn,
      PiRpc: br.PiRpc,
      warmModel: warm.warmModel,
      countLivePi: life.countLivePi,
      LIFECYCLE_DEFAULTS: life.LIFECYCLE_DEFAULTS,
      // Track 3 Task 6: the dispatch brief's seams — planForCard/
      // projectContextBlock from bridge.mjs (the latter EXPORTED for this),
      // cardStatus/boardVocab straight from tracker.mjs (bridge imports them
      // but never re-exports them, so this module pulls them directly rather
      // than growing bridge.mjs's export surface just to re-forward two names).
      planForCard: br.planForCard,
      projectContextBlock: br.projectContextBlock,
      cardStatus: tracker.cardStatus,
      boardVocab: tracker.boardVocab,
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
      // Track 3 Task 4: the ENGINE's own idea of the serving model, distinct
      // from `resolved` (which prepareSpawn computes fresh every spawn/wake).
      // `currentModelParts` is the {provider, modelId} pair a wake must
      // override onto a freshly-resolved `prep.resolved` BEFORE warmModel and
      // PiRpc construction see it (startChild) — set either by a live
      // `model_select` event from the child or by control() while awake or
      // hibernating. `currentModel` is the same value as the "provider/id" key
      // string snapshot()/stateEvent() report.
      currentModelParts: null,
      currentModel: null,
      // Track 3 Task 4: binds at wake, never applied to a live child (pi's
      // permission policy is fixed via env at spawn time). Reset to
      // "guarded" on every adoptRow (gateway restart) — see adoptRow's
      // comment: this is the fail-safe reading of spec §5.3, a restart must
      // never silently resurrect "bypass".
      permissionMode: "guarded",
      // Track 3 Task 4 carried this field (newSession/snapshot/stateEvent/
      // control()) as a mirrored plan-mode state object|null; Task 5 gives
      // it real behavior — set from the rpc-state-bridge `crow-state:`
      // mirror in onUiRequest, driven the other way by control({planMode}).
      planMode: null,
      pendingUi: null,
      lastError: null,
      turn: null,
      subscribers: new Set(),
      idleTimer: null,
      stallTimer: null,
      // Track 3 Task 6: card binding. `cardId` is the board card this
      // session is dispatched to (null for an ordinary free-chat session).
      // `dispatchBrief` holds the world context (tasksDbPath/projectSpace/
      // projectMembers) a card-bound spawn captured, PENDING until the first
      // message() composes the real prompt from it and clears it back to
      // null — see the module header.
      cardId: null,
      dispatchBrief: null,
      // Per-session dirs (every spawn/wake, not just card-bound ones) — the
      // child's confined write target and upload landing zone. Set by
      // startChild; null until the first spawn/wake completes.
      outputsDir: null,
      uploadsDir: null,
      // World context, refreshed on every startChild (spawn AND wake) so a
      // dispatch brief composed after a wake reflects the CURRENT world, not
      // a stale one from a prior spawn.
      tasksDbPath: null,
      projectSpace: null,
      projectMembers: [],
      // Track 3 Task 7: safe-victim eviction's recency signal — the oldest
      // `lastEventAt` among awake/idle candidates is the eviction victim.
      // Stamped at session-object creation (so a freshly spawned, never-yet-
      // touched session already has a real value instead of null/0, which
      // would otherwise always sort first as "oldest") and re-touched on
      // every child event and every turn end.
      lastEventAt: now(),
      // Track 3 Task 7 fix round 1: cycle()'s own re-entrancy claim — set
      // synchronously (before cycle()'s first await) for the duration of one
      // cycle() call, cleared in a `finally`. A second concurrent cycle() and
      // a concurrent message() both check this and refuse rather than racing
      // the in-flight hibernate()/startChild() pair — see cycle()'s header.
      cycling: false,
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
      // Track 3 Task 4: the engine-tracked model wins over the raw
      // prepareSpawn resolution once one is known (a live model_select or a
      // control() switch), so the lens reports the model actually serving
      // the NEXT turn, not just the one the last spawn/wake resolved to.
      model: s.currentModel || (s.resolved ? s.resolved.key : null),
      permissionMode: s.permissionMode,
      planMode: s.planMode,
      // Track 3 Task 6: a later routes task serves files from BOTH dirs
      // (the drawer's file list + upload target) — the controller ruling is
      // that snapshot() is where it reads them from.
      cardId: s.cardId,
      outputsDir: s.outputsDir,
      uploadsDir: s.uploadsDir,
    };
  }

  function emit(s, event) {
    for (const fn of [...s.subscribers]) {
      try { fn(event); } catch { /* a broken subscriber never breaks a turn */ }
    }
  }

  /**
   * Track 3 Task 8: fire an "attention" notification through the shared
   * notification pipeline (servers/shared/notifications.js). Lazy-imported —
   * this module's bot-engine seams are already lazy (loadSeams), and the
   * notification pipeline is a side channel a turn/ask-card/result must
   * never depend on being loaded eagerly. Reuses this module's own
   * `createDbClient` import. Fire-and-forget from every call site: a
   * notification failure (missing table on a scratch DB, a downstream
   * sender throwing) must never break a turn or an ask card.
   */
  async function pushAttention(opts) {
    try {
      const { createNotification } = await import("../shared/notifications.js");
      await createNotification(createDbClient(), opts);
    } catch (e) {
      log("attention notify failed (non-fatal): " + ((e && e.message) || e));
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
      // Track 3 Task 4: same three additions as snapshot(), same rule.
      model: s.currentModel || (s.resolved ? s.resolved.key : null),
      permissionMode: s.permissionMode,
      planMode: s.planMode,
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
  async function writeRow(s, { status, piSessionDir = null, model = null }, control = "run") {
    const db = createDbClient();
    try {
      await db.batch([
        {
          sql:
            "UPDATE bot_sessions SET kind='perch-live', gateway_type='perch', status=?, control=?, " +
            "card_id=?, project_id=COALESCE(?, project_id), pi_session_dir=COALESCE(?, pi_session_dir), " +
            "model=COALESCE(?, model), updated_at=datetime('now') " +
            "WHERE id=(SELECT id FROM bot_sessions WHERE bot_id=? AND gateway_thread_id=? ORDER BY id DESC LIMIT 1)",
          // Track 3 Task 6: card_id is COALESCE-free — this row is owned
          // entirely by this engine session (never shared with a bridge.mjs
          // chat row), so the engine's own s.cardId (null for a free-chat
          // session) is authoritative on every write, not merely a fallback.
          // Track 3 Task 7: `control` defaults to 'run' — only stopAll's
          // interrupted-mid-turn park passes 'interrupted'; every OTHER write
          // (including this row's own NEXT normal write) resets it to 'run'.
          args: [status, control, s.cardId, s.projectId, piSessionDir, model, s.botId, s.threadId],
        },
        {
          sql:
            "INSERT INTO bot_sessions (bot_id,gateway_type,gateway_thread_id,kind,status,control,card_id,project_id,pi_session_dir,model) " +
            "SELECT ?,'perch',?,'perch-live',?,?,?,?,?,? " +
            "WHERE NOT EXISTS (SELECT 1 FROM bot_sessions WHERE bot_id=? AND gateway_thread_id=?)",
          args: [s.botId, s.threadId, status, control, s.cardId, s.projectId, piSessionDir, model, s.botId, s.threadId],
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
   * (gateway restart, or a session spawned before the last deploy).
   *
   * Fix round 2: adoption is SINGLE-FLIGHT per sessionId. The row read awaits,
   * and round 1 fanned adoption out to all six public methods — so two
   * concurrent first-touches at the same not-yet-resident id would each build
   * their OWN session object and the second `sessions.set` would orphan the
   * first (two children through the one-in-flight guard; a subscriber attached
   * to a dead object). Concurrent callers await the SAME adoption promise —
   * one session object, and one DB read instead of N. */
  function adopt(sessionId) {
    let p = adopting.get(sessionId);
    if (p) return p;
    p = adoptRow(sessionId).finally(() => { adopting.delete(sessionId); });
    adopting.set(sessionId, p);
    return p;
  }

  async function adoptRow(sessionId) {
    const db = createDbClient();
    try {
      const { rows } = await db.execute({
        sql:
          "SELECT id, bot_id, gateway_thread_id, status, model, pi_session_id, project_id, card_id " +
          "FROM bot_sessions WHERE gateway_thread_id=? AND kind='perch-live' ORDER BY id DESC LIMIT 1",
        args: [sessionId],
      });
      const row = rows[0];
      if (!row) return null;
      const s = newSession(String(row.bot_id), String(row.gateway_thread_id));
      s.rowId = Number(row.id);
      s.piSessionId = row.pi_session_id || null;
      s.projectId = row.project_id == null ? null : Number(row.project_id);
      s.cardId = row.card_id == null ? null : Number(row.card_id);
      s.state = row.status === "stopped" ? "stopped" : "hibernating";
      // Track 3 Task 4 (spec §5.3, RESTART SEMANTICS — named for the
      // reviewer): deliberately NOT restoring permissionMode from anywhere.
      // newSession() above already left it at the "guarded" default, and
      // nothing in this row read (or in bot_sessions at all) carries a
      // persisted mode to restore even if we wanted to. This is the
      // fail-safe reading: a gateway restart must never silently resurrect a
      // "bypass" session — the drawer shows the current (reset) mode so the
      // operator can see and consciously re-widen it, rather than the
      // process quietly reinstating a wide-open write policy on its own.
      //
      // Track 3 Task 6: a card claim OUTLIVES hibernation (occupancy rule
      // (c)) — a row adopted here that is still card-bound and not stopped
      // re-registers the in-memory claim directly (cardClaims.set, never
      // claimCard's throw-on-conflict path: this is restoring THIS row's own
      // prior claim from the DB, not contesting a new one).
      if (s.cardId != null && s.state !== "stopped") cardClaims.set(s.cardId, s.sessionId);
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

  /**
   * Safe-victim fallback for `reserveSlot` (Track 3 Task 7, spec §3.3).
   * Tries the plain reservation first; on `interactive_capacity` (the AWAKE
   * cap refusal — `pi_capacity`, the host-wide budget, is never evicted
   * around and rethrows untouched), synchronously picks the oldest-idle
   * evictable session (`state==="awake"`, no `turn`, no `pendingUi` — a
   * pendingUi candidate is never selected, matching hibernate()'s own guard)
   * and hands its slot to `session`.
   *
   * THE HANDOVER is two plain assignments with NO await between them —
   * `victim.state = "hibernating"` then `session.state = "waking"` — exactly
   * reserveSlot's own single-block discipline, extended to cover the evicted
   * slot too. This function is deliberately NOT `async`: the fast path
   * (reserveSlot succeeds, or throws with no eligible victim) returns/throws
   * synchronously, so a caller that never needs eviction pays no extra
   * microtask tick and its OWN "no await between check and reservation" block
   * stays intact. Only the eviction path returns a Promise — the caller must
   * await THAT, and only AFTER the synchronous handover above has already
   * committed (see finishEviction below).
   *
   * CALLER CONTRACT: `session` must already be reachable via `sessions`
   * (spawn adds it to the map BEFORE calling in, precisely so a second
   * concurrent caller's own reserveSlot count sees this reservation the
   * instant the handover flips its state, not only after our async tail
   * resumes — reserveSlot's own `other === session` self-exclusion makes this
   * safe on the fast, no-eviction path too). message()'s wake path calls in
   * with a session already resident from resolveSession, so no extra step is
   * needed there.
   *
   * @returns {Promise|null} a promise the caller must await iff an eviction
   *   was performed (null on the plain, synchronous-only path).
   */
  function reserveWithEviction(S, session) {
    try {
      reserveSlot(S, session);
      return null;
    } catch (e) {
      if (e.code !== "interactive_capacity") throw e;   // pi_capacity, perch_disabled: never evicted around
      let victim = null;
      for (const other of sessions.values()) {
        if (other === session) continue;
        if (other.state !== "awake") continue;
        if (other.turn) continue;
        if (other.pendingUi) continue;
        if (!victim || other.lastEventAt < victim.lastEventAt) victim = other;
      }
      if (!victim) throw e;                              // no eligible victim: rethrow untouched
      // ---- the handover: no await between these two lines ------------
      victim.state = "hibernating";
      session.state = "waking";
      // ------------------------------------------------------------------
      return finishEviction(S, session, victim);
    }
  }

  /** The async tail of an eviction: actually close the victim's child, then
   * re-run the host pi-budget half of the gate — reserveSlot's own
   * `pi_capacity` check ran BEFORE the eviction and could not see the slot
   * the victim's close() is about to free, so it was unrunnable evidence
   * until now. A failure here releases ONLY our own reservation
   * (`session.state`) — the victim stays evicted; it can be woken again like
   * any other hibernating session. */
  async function finishEviction(S, session, victim) {
    await hibernate(victim);
    let reservedNotSpawned = 0;
    for (const other of sessions.values()) {
      if (other === session) continue;
      if (other.state !== "awake" && other.state !== "waking") continue;
      if (!other.pi) reservedNotSpawned += 1;
    }
    const live = S.countLivePi();
    if (live + reservedNotSpawned >= S.LIFECYCLE_DEFAULTS.maxPi) {
      session.state = "hibernating";                     // release our reservation
      throw engineError("pi_capacity");
    }
  }

  // ---- card claims (Track 3 Task 6) -----------------------------------------

  /** cardId (Number) → sessionId currently holding it. This engine INSTANCE's
   * own state, rebuilt lazily by adoptRow — never populated eagerly on
   * construction, so rows claimed before this process existed are covered
   * ONLY by the async `checkCardFree()` DB check below until this process
   * happens to touch that row (adoptRow, on a message/get/subscribe/stop). */
  const cardClaims = new Map();

  /**
   * Synchronous check-then-claim. MUST run in the same statement sequence as
   * `reserveSlot()` — no await between the check and the set (spec §5.1),
   * the same TOCTOU discipline reserveSlot itself documents above. Idempotent
   * for the SAME sessionId (a session re-asserting the claim it already
   * holds is a no-op, never a self-conflict); throws `card_occupied` for any
   * OTHER live session.
   */
  function claimCard(cardId, sessionId) {
    const holder = cardClaims.get(cardId);
    if (holder != null && holder !== sessionId) throw engineError("card_occupied");
    cardClaims.set(cardId, sessionId);
  }

  /** Release, gated on the releasing session actually being the current
   * holder — a superseded session object's own teardown must never steal
   * back a claim a NEWER session (e.g. adoptRow re-registering after a
   * restart) already holds for the same cardId. */
  function releaseCard(cardId, sessionId) {
    if (cardId == null) return;
    if (cardClaims.get(cardId) === sessionId) cardClaims.delete(cardId);
  }

  /**
   * DB-backed occupancy check — the half that covers what this engine
   * instance's in-memory `cardClaims` cannot: rows claimed before this
   * process existed, and (the route's use) a check made before ANY engine
   * call is reached at all. Three independent rails, each throwing
   * `card_occupied`:
   *   (a) any `bot_sessions` row for this card with status='active' (ANY
   *       kind — a live conversational OR job-dispatched turn owns it now);
   *   (b) an unfinished `bot_jobs` row (board-lock.js's job rail — reused,
   *       never re-derived);
   *   (c) any `kind='perch-live'` row for this card with status != 'stopped'
   *       — a HIBERNATING card-bound perch session still owns the card (a
   *       card claim outlives hibernation; see the module header).
   *
   * Track 3 Task 9 fix round 1 (coordinator-reported Important): the
   * attach-card ROUTE calls this BEFORE `eng.attachCard()` — a session
   * re-asserting a card it ALREADY holds hit rail (c) against its OWN row
   * (that row's `gateway_thread_id` IS the calling session's own
   * `sessionId`), 409ing before `attachCard()`'s documented idempotent
   * no-op path was ever reached. `excludeSessionId` skips rail (c) rows
   * whose `gateway_thread_id` matches it — narrowly, only that one rail,
   * only that one session; every OTHER live claimant (including this exact
   * card held by a DIFFERENT session) still 409s. `spawn()`'s own internal
   * pre-check never passes it — a spawn always mints a brand-new sessionId,
   * so it can never collide with its own not-yet-existent row.
   */
  async function checkCardFree(cardId, { excludeSessionId } = {}) {
    const cid = Number(cardId);
    const db = createDbClient();
    try {
      const active = await db.execute({
        sql: "SELECT id FROM bot_sessions WHERE card_id=? AND status='active' LIMIT 1",
        args: [cid],
      });
      if (active.rows[0]) throw engineError("card_occupied");
      const job = await jobLockFor(db, cid);
      if (job) throw engineError("card_occupied");
      const live = await db.execute({
        sql:
          "SELECT id FROM bot_sessions WHERE card_id=? AND kind='perch-live' AND status != 'stopped' " +
          (excludeSessionId != null ? "AND gateway_thread_id != ? " : "") + "LIMIT 1",
        args: excludeSessionId != null ? [cid, String(excludeSessionId)] : [cid],
      });
      if (live.rows[0]) throw engineError("card_occupied");
    } finally {
      try { db.close(); } catch { /* already closed */ }
    }
  }

  // ---- per-bot world-build mutex (Track 3 Task 6, spec §3.2/I9) -------------

  /** botId → promise chain. `.mcp.json` content varies by jobId, so two
   * in-gateway `buildBotWorld()` calls for the SAME bot must never run
   * concurrently — the second waits for the first to settle (success OR
   * failure) before its own build starts. The cross-process bridge-tick race
   * is pre-existing and out of scope (spec §9). */
  const worldBuildLocks = new Map();

  /**
   * Fix round 1 (coordinator-reported Critical): the original literal
   * `prev.then(build)` formula poisoned a bot's queue forever after ONE
   * rejected build — `.then(build)` off a rejected `prev` never calls
   * `build` again, so every LATER spawn for that bot would silently inherit
   * the first failure instead of trying again. A transient buildBotWorld
   * failure (a bad def edit since fixed, a momentary DB hiccup) must not
   * brick a bot's spawns until this process restarts.
   *
   * Fix shape: the promise THIS call returns to its caller (`next`) still
   * carries the real rejection of THIS build — callers must see their own
   * failure, unmasked. The promise STORED as the next caller's `prev`
   * (`tail`) is a never-rejecting shadow of `next` — so a later caller's own
   * `prev.catch(() => {})` always has something to resume from, regardless
   * of whether this build succeeded or failed. Serialization still holds
   * (the next build never starts before this one settles); a failure just
   * stops propagating sideways into someone else's queue position.
   */
  function buildWorldSerialized(S, args) {
    const botId = args.botId;
    const prev = worldBuildLocks.get(botId) || Promise.resolve();
    const next = prev.catch(() => {}).then(() => S.buildBotWorld(args));
    const tail = next.catch(() => {});
    worldBuildLocks.set(botId, tail);
    // Hygiene: bound the map. Once this tail settles, drop the entry IF
    // nothing newer has queued behind it (a newer call would have replaced
    // the map's value with ITS OWN tail already).
    tail.then(() => {
      if (worldBuildLocks.get(botId) === tail) worldBuildLocks.delete(botId);
    });
    return next;
  }

  // ---- child construction --------------------------------------------------

  /**
   * Build the world FRESH, warm the model, construct the child, attach the exit
   * handler, and stamp the row. Shared by spawn (piSessionId null) and wake
   * (piSessionId = the stored pi session, so pi resumes the same transcript).
   */
  async function startChild(S, s) {
    const slog = sessionLog(s);
    // Track 3 Task 6: serialized per-bot — see buildWorldSerialized's comment.
    const world = await buildWorldSerialized(S, {
      botId: s.botId, threadId: s.threadId, gatewayType: "perch", log: slog,
    });
    const prep = await S.prepareSpawn(world, { escalate: false, log: slog });
    s.projectId = world.projectId == null ? null : Number(world.projectId);
    // Track 3 Task 6: refreshed on EVERY startChild (spawn and wake alike),
    // so a dispatch brief composed after a wake reflects the current world.
    s.tasksDbPath = world.tasksDbPath;
    s.projectSpace = world.projectSpace;
    s.projectMembers = world.projectMembers;
    // Track 3 Task 4 (wake fidelity, review finding 8): if the engine tracks a
    // model different from what prepareSpawn just resolved fresh (a live
    // model_select or a control() switch made while this session was awake or
    // hibernating), override prep.resolved BEFORE warmModel/PiRpc see it —
    // otherwise a wake would warm and spawn the WRONG provider and the first
    // turn's metering would price the pre-switch model until pi re-emits its
    // own model_select. This is a plain value override (never a merge of
    // provider/model/key alone would leave `escalated`/`source` stale for the
    // NEW model, but those two fields do not feed metering or spawn args, so
    // leaving them as prepareSpawn resolved them is harmless — only
    // provider/model/key are load-bearing here).
    if (s.currentModelParts &&
        (s.currentModelParts.provider !== prep.resolved.provider ||
         s.currentModelParts.modelId !== prep.resolved.model)) {
      prep.resolved = Object.assign({}, prep.resolved, {
        provider: s.currentModelParts.provider,
        model: s.currentModelParts.modelId,
        key: s.currentModel,
      });
      prep.piRpcOpts = Object.assign({}, prep.piRpcOpts, { resolved: prep.resolved });
    }
    s.resolved = prep.resolved;
    await S.warmModel(prep.resolved.provider, slog);

    // Track 3 Task 6: per-session outputs/uploads dirs — every spawn/wake,
    // not just card-bound ones (a free-chat session gets a workspace too).
    // Keyed on sessionId (stable across hibernate/wake, unlike a per-turn
    // scratch dir) so files the operator uploaded before a hibernation are
    // still there when the bird wakes back up.
    const outputsDir = join(world.sessionDir, "outputs", s.sessionId);
    const uploadsDir = join(world.sessionDir, ".pi", "uploads", s.sessionId);
    mkdirSync(outputsDir, { recursive: true });
    mkdirSync(uploadsDir, { recursive: true });
    s.outputsDir = outputsDir;
    s.uploadsDir = uploadsDir;

    const resume = (world.session && world.session.pi_session_id) || s.piSessionId || null;
    const pi = new S.PiRpc(Object.assign({}, prep.piRpcOpts, {
      piSessionId: resume,
      onEvent: (m) => onChildEvent(s, m),
      // The ONE thing the interactive engine adds to a bot's spawn: pi-lab's
      // ask-user ctx.ui unlock (PL-3). C-12's spawn_env hygiene guarantees a
      // bot def cannot set this itself for a channel turn.
      extraEnv: { PI_BOT_INTERACTIVE: "1" },
      // Track 3 Task 4: permissionMode binds at wake — the session record's
      // current value goes into every spawn/wake's PiRpc opts. Default
      // "guarded" is a byte-identical no-op for a fresh session (mirrors
      // every channel caller, which never sets this option at all).
      permissionMode: s.permissionMode,
      // Track 3 Task 6 (Task 3's extraWritePaths option): the child's ONLY
      // confined write target for deliverables it wants the operator to see.
      extraWritePaths: [outputsDir],
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
    // I-1: the child can die during THIS function's own trailing awaits (an
    // unknown provider, a fresh-install misconfig — anywhere from tens to a
    // few hundred ms). `getState()` above swallows that as a `.catch(() =>
    // null)`, so it does not throw and startChild runs to this tail — but
    // `attachExit` has ALREADY fired by then (its reaction was queued the
    // moment the child exited), parking the session (`s.pi = null`, state →
    // hibernating, lastError set) and calling `writeRow(waiting-user)`.
    // Stamping "awake" unconditionally here would clobber that honest park
    // back to a lie: `message()`'s post-wake `refuseIfPiGone` guard catches
    // this for the WAKE path because it keys off `s.pi`, not `s.state` — but
    // `spawn()` has no such guard and returns `s.state` directly to the
    // caller, so the lie became a real 201 {state:"awake"} with lastError
    // erased, and the freed-then-relied slot's UNCONDITIONAL "awake" stamp
    // wedges reserveSlot()'s count forever (interactive_capacity on every
    // later spawn). Bail before the stamp if this is no longer the current
    // child — attachExit already told the true story.
    if (s.pi !== pi) return pi;
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
      // Track 3 Task 6: a card claim outlives hibernation (occupancy rule
      // (c)) — release it ONLY in the branch where this exit lands on a
      // session already `stopped` (stop() itself already released the claim
      // in the normal case; this is the defensive belt-and-braces twin named
      // in the module header, for an exit that lands after state was marked
      // stopped by some other path).
      if (s.state === "stopped") releaseCard(s.cardId, s.sessionId);
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
    s.lastEventAt = now();                           // Track 3 Task 7: eviction recency
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
      case "model_select":
        onModelSelect(s, m);
        return;
      default:
        // agent_end, message_update, … — not part of the lens vocabulary.
        // Silence is the contract, not an oversight.
    }
  }

  /**
   * Track 3 Task 4: the child (pi's own /model, an auto-fallback, or the
   * response to OUR OWN control() set_model) picked a model. Real event
   * shape (verified): `{type:"model_select", model:{provider, id, …},
   * previousModel, source}` — the Model object has `id`, NOT `modelId`.
   *
   * Dedupe by value: control()'s awake model switch already applies the
   * commandSince RESPONSE (same provider/id pi is about to echo back here as
   * an event) — without this check, every control()-driven switch would emit
   * a second, redundant state+log pair once this event lands moments later.
   */
  function onModelSelect(s, m) {
    const model = m && m.model;
    if (!model || !model.provider || !model.id) return;
    const key = model.provider + "/" + model.id;
    if (s.currentModel === key) return;
    s.currentModelParts = { provider: model.provider, modelId: model.id };
    s.currentModel = key;
    // onTurnEnd's meterTurn({resolved: s.resolved}) prices whatever
    // s.resolved says NOW, not what the turn started on — so the model that
    // actually served the reply is what gets metered.
    s.resolved = Object.assign({}, s.resolved, { provider: model.provider, model: model.id, key });
    emit(s, stateEvent(s));
    emit(s, { type: "log", text: "now on " + key });
  }

  function onUiRequest(s, m) {
    if (ASK_METHODS.has(m.method)) {
      s.pendingUi = cardFrom(m);
      clearStall(s);                                 // paused while a human thinks
      emit(s, { type: "ask_user", ...s.pendingUi });
      armIdle(s);                                    // no-op by design: a pending card blocks it
      // Track 3 Task 8: an ask card (incl. a permission confirm — "confirm"
      // is one of ASK_METHODS) is a blocking event — it ALWAYS pushes,
      // regardless of whether an operator is subscribed live, unlike the
      // turn-end "replied" push below.
      pushAttention({
        type: "attention",
        priority: "high",
        title: s.botId + " needs you",
        body: s.pendingUi.title || s.pendingUi.message || "",
        action_url: "/dashboard/bot-board#bird=" + s.sessionId,
      });
      return;
    }
    if (m.method === "notify") {
      const text = m.message == null ? "" : String(m.message);
      // Track 3 Task 5: pi-lab's rpc-state-bridge extension mirrors the
      // plan-mode bus over this SAME notify channel, prefixed so it never
      // collides with an operator-facing note:
      // `"crow-state:" + JSON.stringify({kind:"plan-mode", state})`. A
      // frame carrying this prefix is engine protocol, never a transcript
      // line — malformed JSON after the prefix is swallowed (never a log
      // line, never a throw), matching a down/stale extension gracefully.
      if (text.startsWith(CROW_STATE_PREFIX)) {
        let parsed;
        try {
          parsed = JSON.parse(text.slice(CROW_STATE_PREFIX.length));
        } catch {
          return;
        }
        if (parsed && parsed.kind === "plan-mode") {
          s.planMode = parsed.state;
          emit(s, { type: "plan_state", state: parsed.state });
        }
        return;
      }
      emit(s, { type: "log", text });
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

  /** Stop the per-turn clocks. Fix round 1 (M-4): this deliberately does NOT
   * clear `s.turn` — the turn stays claimed until its completion path has
   * emitted the reply and trimmed the log, so a fast second message gets an
   * honest `turn_in_progress` instead of interleaving with the tail of turn 1
   * (trimLog's "no waiters pending" caller guarantee, and reply ordering,
   * both depend on it). */
  function stopTurnClocks(s, turn) {
    if (turn.graceTimer != null) { clearTimer(turn.graceTimer); turn.graceTimer = null; }
    clearStall(s);
  }

  async function onTurnEnd(s, turn, end) {
    if (s.turn !== turn) return;                     // superseded / already abandoned
    stopTurnClocks(s, turn);

    if (turn.aborted) {
      // Silent completion: state only. No `reply` event ever follows an abort
      // on the same turn — the mutation-guarded invariant of this engine.
      await writeRow(s, { status: "waiting-user" }).catch(() => {});
      if (s.turn === turn) s.turn = null;
      s.lastEventAt = now();                          // Track 3 Task 7: became idle now
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

    // The invariant is stated over the TURN, not over a pre-await snapshot: an
    // abort that landed during the metering awaits still silences the reply.
    if (!turn.aborted) {
      const replyText = replyTextOf(end);
      emit(s, { type: "reply", text: replyText });
      // Track 3 Task 8: an operator watching the drawer live (any live
      // subscriber) already sees the reply — the push is for someone who
      // is AWAY, and only for a turn that actually took a while.
      if (s.subscribers.size === 0) {
        const ranS = (now() - turn.startedAt) / 1000;
        if (ranS >= notifyMinRunS()) {
          pushAttention({
            type: "attention",
            priority: "normal",
            title: s.botId + " replied",
            body: replyText.slice(0, 140),
            action_url: "/dashboard/bot-board#bird=" + s.sessionId,
          });
        }
      }
    }
    // r2 S7: bound the child's accumulating log now that nothing is waiting on
    // it. trimLog preserves _seq, so the next turn's `since` correlation holds.
    try { if (s.pi) s.pi.trimLog(); } catch { /* non-fatal */ }
    await writeRow(s, { status: "waiting-user", model: s.resolved ? s.resolved.key : null }).catch(() => {});
    // M-4: the turn is released HERE, after reply + trimLog — never at the top.
    if (s.turn === turn) s.turn = null;
    s.lastEventAt = now();                            // Track 3 Task 7: became idle now
    emit(s, stateEvent(s));
    armIdle(s);
  }

  async function onTurnError(s, turn, err) {
    if (s.turn !== turn) return;
    stopTurnClocks(s, turn);
    const message = String((err && err.message) || err);
    s.lastError = message;
    emit(s, { type: "error", text: message });
    await writeRow(s, { status: "waiting-user" }).catch(() => {});

    // A PREFLIGHT refusal never started an agent loop (C-12 (h)): the child is
    // healthy and the session degrades to an honest error. Anything else — an
    // ack timeout above all — may have left a live loop whose late, id-less
    // agent_end would end the NEXT turn, so the child is abandoned.
    // M-3: discriminate on the TYPED code bridge.mjs sets at the throw site,
    // never on the message string.
    if (err && err.code === "prompt_refused") {
      if (s.turn === turn) s.turn = null;            // M-4: released at the end
      emit(s, stateEvent(s));
      armIdle(s);
      return;
    }
    if (s.pi) await abandonChild(s, message);        // clears s.turn itself
    else {
      if (s.turn === turn) s.turn = null;
      emit(s, stateEvent(s));
    }
  }

  /**
   * D1 (C-19 acceptance): the child can die between message()'s reservation
   * and the moment it actually touches `s.pi` — during the wake's own
   * trailing awaits inside startChild, during the already-awake
   * `writeRow(active)`, or during the `getSessionStats()` call right below
   * this guard's second call site. `attachExit` fires off `pi.exited`
   * asynchronously and USUALLY lands first (its reaction was queued the
   * moment the child exited, ahead of whatever message() is still awaiting)
   * — it already parks the row, flips `hibernating` and emits its own error.
   * This guard makes that outcome CERTAIN instead of racing it: without it,
   * `s.pi.getSessionStats()` / `s.pi.promptTurn()` null-deref and the raw
   * TypeError escapes the route as an untyped 500 (probe-wedge.mjs). Same
   * discipline as the wake-failure catch in message() below: drop the turn
   * claim, release the reservation (state → hibernating — the thing
   * reserveSlot() actually counts), refuse with a typed error. Returns true
   * (and the caller throws) iff the child is gone.
   */
  function refuseIfPiGone(s, turn) {
    if (s.pi) return false;
    if (s.turn === turn) s.turn = null;
    if (s.state !== "stopped") s.state = "hibernating";
    const message = s.lastError || "pi exited before the turn could start";
    s.lastError = message;
    writeLeases();
    emit(s, { type: "error", text: message });
    emit(s, stateEvent(s));
    writeRow(s, { status: "waiting-user" }).catch(() => {});
    return true;
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

  async function spawn({ botId, cardId = null }) {
    if (!botId) throw engineError("bad_request");
    const S = await loadSeams();
    const cid = cardId == null ? null : Number(cardId);
    // Async double-check (Track 3 Task 6): DB-backed, ahead of the
    // synchronous claim below — the thing that catches a card claimed by a
    // row this engine instance has never adopted (a fresh process, or
    // another gateway on the same DB). Never a substitute for the
    // synchronous claim: two callers racing THIS process still need the
    // in-memory exclusion below, which no await-laden pre-check can provide.
    if (cid != null) await checkCardFree(cid);
    // ---- one synchronous block: gates + reservation + card claim, no await
    // between any of them (spec §5.1 — the P1 F3 TOCTOU class, extended to
    // the card claim) ----
    const threadId = "perchlive-" + randomUUID().slice(0, 8);
    const s = newSession(String(botId), threadId);
    // Track 3 Task 7: added to `sessions` BEFORE the reservation attempt, not
    // after — reserveWithEviction's eviction path awaits the victim's
    // hibernate() before this call resumes, and a concurrent second caller's
    // own reserveSlot count must see `s` counted (or not) the instant the
    // handover flips its state, never only after our tail resumes.
    // reserveSlot's own `other === session` self-exclusion keeps the plain,
    // no-eviction path byte-identical to before.
    sessions.set(s.sessionId, s);
    try {
      const pending = reserveWithEviction(S, s);
      if (pending) await pending;
      if (cid != null) claimCard(cid, s.sessionId);  // throws card_occupied
      s.cardId = cid;
    } catch (e) {
      s.state = "hibernating";                       // release any reservation we got
      sessions.delete(s.sessionId);
      throw e;
    }
    // ---------------------------------------------------------------------
    try {
      await startChild(S, s);
    } catch (e) {
      sessions.delete(s.sessionId);                  // release the reservation
      if (cid != null) releaseCard(cid, s.sessionId); // …and the card claim
      // I-3 discipline: detach the child BEFORE closing (attachExit's
      // `s.pi !== pi` guard then swallows the expected exit) and never await
      // the close — a child that ignores SIGTERM must not hold the caller.
      const pi = s.pi;
      s.pi = null;
      if (pi) pi.close().catch(() => { /* already dead */ });
      // Fix round 2 rode-along: if startChild already stamped the row `active`
      // (s.rowId is set ONLY by that write), park it — otherwise the failed
      // spawn leaves a phantom `active` ghost that list() reports as
      // hibernating forever and whose fresh claim 409s any wake. Gated on
      // rowId, not on `pi`: writeRow's insert branch would otherwise MINT a
      // row for a spawn that never got far enough to have one.
      if (s.rowId != null) writeRow(s, { status: "waiting-user" }).catch(() => {});
      writeLeases();
      throw e;
    }
    // Track 3 Task 6: dispatch STARTS the work — the brief is stored, not
    // sent. The world context is what startChild just captured on `s`; the
    // operator's note (unknown until the first message() call) is filled in
    // there, at which point this is composed and cleared. See the module
    // header ("DISPATCH STARTS THE TURN").
    if (cid != null) {
      s.dispatchBrief = {
        cardId: cid,
        tasksDbPath: s.tasksDbPath,
        projectSpace: s.projectSpace,
        projectMembers: s.projectMembers,
      };
    }
    emit(s, stateEvent(s));
    armIdle(s);
    return { sessionId: s.sessionId, threadId: s.threadId, state: s.state };
  }

  async function message(sessionId, text, images) {
    const S = await loadSeams();
    const s = await resolveSession(sessionId);
    if (!s) throw engineError("no_such_session");
    // ---- one synchronous block: guards + reservation, no await between ----
    if (s.state === "stopped") throw engineError("session_stopped");
    if (s.turn) throw engineError("turn_in_progress");
    // Track 3 Task 7 fix round 1: a cycle() in flight leaves this session
    // transiently `s.pi === null` mid-hibernate — WITHOUT this check
    // `needsWake` below would read true and message() would try to WAKE a
    // session cycle() is already in the middle of respawning, racing
    // startChild() the same way two concurrent cycle()s used to. Refuse with
    // the same typed code cycle() itself uses for "busy right now".
    if (s.cycling) throw engineError("cycle_busy");
    const needsWake = !s.pi;
    // r1 C8: the wake path re-gates. Track 3 Task 7: reserveWithEviction is
    // itself synchronous up to its own handover — a synchronous throw here
    // (interactive_capacity with no eligible victim, pi_capacity,
    // perch_disabled) propagates BEFORE the turn is ever claimed, exactly
    // like the old bare reserveSlot() call. Only the EVICTION path returns a
    // promise; it is awaited INSIDE the try below (its own post-hibernate
    // pi_capacity re-check can fail AFTER the turn is claimed, so that
    // failure needs the same reservation-release cleanup as any other wake
    // failure).
    const pending = needsWake ? reserveWithEviction(S, s) : null;
    // Track 3 Task 8: startedAt is this turn's own clock reading, distinct
    // from any lastEventAt touch — onTurnEnd diffs against it to decide
    // whether a "<bot> replied" attention push clears PERCH_NOTIFY_MIN_RUN_S.
    const turn = { id: randomUUID(), aborted: false, toolNames: [], statsBefore: null, graceTimer: null, startedAt: now() };
    s.turn = turn;
    // ---------------------------------------------------------------------
    try {
      if (needsWake) {
        if (pending) await pending;
        await assertRowClaimable(s);
        await startChild(S, s);
      } else {
        await writeRow(s, { status: "active", model: s.resolved ? s.resolved.key : null });
      }
    } catch (e) {
      s.turn = null;
      if (needsWake) {
        // I-3: release the reservation UNCONDITIONALLY and FIRST. The old
        // `s.pi ? "awake" : "hibernating"` marked a half-started wake as
        // counted-awake while its child was being torn down — if the close
        // hung, the slot leaked forever (every later spawn threw
        // interactive_capacity). Detach before closing so attachExit treats
        // the exit as expected, and never await the close.
        const pi = s.pi;
        s.pi = null;
        s.state = "hibernating";                     // the reservation is gone NOW
        writeLeases();
        if (pi) {
          pi.close().catch(() => { /* already dead */ });
          // startChild stamped the row 'active' before it failed; park it so
          // the next wake is not 409'd by our own dead claim. Never on
          // turn_in_progress — that claim belongs to ANOTHER process.
          if (!e || e.code !== "turn_in_progress") {
            writeRow(s, { status: "waiting-user" }).catch(() => {});
          }
        }
      }
      throw e;
    }

    clearIdle(s);
    // D1: the child may already be gone (killed the instant before this call
    // landed) — refuse honestly rather than null-deref s.pi below.
    if (refuseIfPiGone(s, turn)) throw engineError("pi_gone");
    turn.statsBefore = await s.pi.getSessionStats().catch(() => null);
    // D1: …or it died WHILE that stats call was in flight.
    if (refuseIfPiGone(s, turn)) throw engineError("pi_gone");
    armStall(s);
    emit(s, stateEvent(s));
    // Track 3 Task 6: the FIRST message() after a card-bound spawn composes
    // the real prompt from the stored dispatch brief — the operator's note
    // (this call's `text`, "" when the dispatch route was given none) becomes
    // cardBriefBlock's userLine, defaulting to "Work this card." unwritten.
    // Every later message() on this session sends raw text (dispatchBrief is
    // cleared here, once) — the exact same path a non-card session always
    // took.
    let promptText = text;
    if (s.dispatchBrief) {
      const brief = s.dispatchBrief;
      const header = S.projectContextBlock(brief.projectSpace, brief.projectMembers);
      promptText = header + "\n\n" + cardBriefBlock({
        cardId: brief.cardId,
        tasksDbPath: brief.tasksDbPath,
        userLine: text || "Work this card.",
        planForCard: S.planForCard,
        cardStatus: S.cardStatus,
        boardVocab: S.boardVocab,
      }) + "\n\nDeliverables you produce as files go in: " + s.outputsDir;
      s.dispatchBrief = null;
    }
    // ms=0: no bridge turn budget. The stall watchdog above is this turn's
    // only clock. Every engine-held promptTurn carries a .catch — a child that
    // dies mid-turn REJECTS it, and an unhandled rejection in the gateway
    // process is a crash, not a log line.
    s.pi.promptTurn(promptText, 0, images)
      .then((end) => onTurnEnd(s, turn, end))
      .catch((e) => onTurnError(s, turn, e))
      .catch(() => {});
    return { turnId: turn.id };
  }

  /**
   * Track 3 Task 13 (controller ruling): steer an IN-FLIGHT turn — fire-and-
   * forget, no waiter, no `s.turn` mutation. Unlike message() this never
   * claims a turn slot and never touches promptTurn: it sends a `steer`
   * frame at the child pi is already running, which queues it into the
   * live loop on its own. Refused honestly rather than silently dropped:
   * `session_stopped` when the session is parked for good, `no_turn` when
   * there is nothing running to steer, `pi_gone` when the child that WAS
   * running the turn has since exited out from under it.
   */
  async function steer(sessionId, text) {
    const s = await resolveSession(sessionId);
    if (!s) throw engineError("no_such_session");
    if (s.state === "stopped") throw engineError("session_stopped");
    if (!s.turn) throw engineError("no_turn");
    const alive = !!(s.pi && s.pi._exitCode == null);
    if (!alive) throw engineError("pi_gone");
    const message = String(text == null ? "" : text);
    s.pi.send({ type: "steer", message });
    emit(s, { type: "log", text: "steered: " + message.slice(0, 200) });
    return { ok: true };
  }

  /**
   * Track 3 Task 7: force a respawn of a session's child so SPAWN-BOUND state
   * (permissionMode, narrowing) binds NOW instead of waiting for the next
   * natural idle-hibernate/wake cycle — every spawn/wake rebuilds the world
   * fresh (startChild's own header note), so closing and immediately
   * re-opening the child is sufficient; nothing here is card- or
   * turn-specific.
   *
   * Refused with `cycle_busy` while a turn is in flight, a card is pending,
   * OR another cycle() is already running on this session — cycling mid-turn
   * would race promptTurn's own completion path, cycling with a pendingUi
   * card would destroy a question a human has not yet answered (hibernate()'s
   * own I5 guard would silently no-op that case anyway, but refusing HERE
   * gives the caller an honest, typed reason rather than a wake that quietly
   * did nothing), and two concurrent cycle()s on ONE session would otherwise
   * both observe `s.pi` already null after the first's `hibernate()` closes
   * it (fix round 1, coordinator-reported): the second sees a "hibernating"
   * session, no-ops its own hibernate(), and spawns a SECOND child — then the
   * first's suspended `startChild` resumes and spawns a THIRD, clobbering
   * `s.pi` and orphaning the second's child as an uncounted leaked process.
   *
   * `s.cycling` is the re-entrancy claim, set in the SAME synchronous
   * prefix as the other cycle_busy guards (before the first await) — the
   * exact idiom `message()`'s own `s.turn` claim and `reserveSlot`'s
   * capacity reservation already use — and released in a `finally` so a
   * mid-flight failure never wedges the session cycle-locked forever.
   * `message()` also checks it (see below): a session is transiently neither
   * "awake" nor cleanly "hibernating" for the DB-claim purposes while a
   * cycle is in flight, and without this check a concurrent `message()`
   * would try to WAKE mid-cycle, racing `startChild` the same way.
   */
  async function cycle(sessionId) {
    const S = await loadSeams();
    const s = await resolveSession(sessionId);
    if (!s) throw engineError("no_such_session");
    if (s.state === "stopped") throw engineError("session_stopped");
    if (s.turn || s.pendingUi || s.cycling) throw engineError("cycle_busy");
    s.cycling = true;                                  // ← the re-entrancy claim
    try {
      await hibernate(s);                              // no-op if already hibernating
      // ---- one synchronous block: reservation, no await between check+flip
      const pending = reserveWithEviction(S, s);
      // -----------------------------------------------------------------
      try {
        if (pending) await pending;
        await assertRowClaimable(s);
        await startChild(S, s);
      } catch (e) {
        // Same I-3 discipline as message()'s wake-failure cleanup: release
        // the reservation unconditionally and first, detach before closing
        // so attachExit treats the exit as expected, never await the close.
        const pi = s.pi;
        s.pi = null;
        s.state = "hibernating";
        writeLeases();
        if (pi) {
          pi.close().catch(() => { /* already dead */ });
          if (!e || e.code !== "turn_in_progress") {
            writeRow(s, { status: "waiting-user" }).catch(() => {});
          }
        }
        throw e;
      }
      emit(s, stateEvent(s));
      armIdle(s);
      return { state: s.state };
    } finally {
      s.cycling = false;
    }
  }

  /**
   * Track 3 Task 4: engine-owned control surface for model / thinking level /
   * permission mode / plan mode. Applies live what it can (an awake child gets
   * a correlated `commandSince` RPC), stores what only binds at the next wake
   * (permission mode always; a model switch while hibernating), and validates
   * up front so a bad value never round-trips to a child that would refuse it
   * with an opaque `command_failed`.
   *
   * Refusal order matches the brief's enumeration: no_such_session →
   * session_stopped → turn_in_progress (model/thinking only — "one clock
   * owner per turn", the same discipline `message()`'s own turn claim
   * enforces) → bad_request (unknown values).
   *
   * @returns {Promise<{applied: object, bindsAtWake: object}>}
   */
  async function control(sessionId, opts = {}) {
    const s = await resolveSession(sessionId);
    if (!s) throw engineError("no_such_session");
    if (s.state === "stopped") throw engineError("session_stopped");

    const hasModel = opts.model != null;
    const hasThinking = opts.thinking != null;
    const hasPermissionMode = opts.permissionMode != null;
    const hasPlanMode = Object.prototype.hasOwnProperty.call(opts, "planMode");

    // Model/thinking/planMode switches share the one child clock a turn
    // already owns (commandSince/promptAckOnly ride the SAME correlated
    // response stream promptTurn does) — refused mid-turn rather than racing
    // it. permissionMode never touches the live child, so it alone is never
    // refused here.
    if ((hasModel || hasThinking || hasPlanMode) && s.turn) throw engineError("turn_in_progress");

    if (hasModel && (!opts.model.provider || !opts.model.modelId)) throw engineError("bad_request");
    if (hasThinking && !THINKING_LEVELS.has(opts.thinking)) throw engineError("bad_request");
    if (hasPermissionMode && !PERMISSION_MODES.has(opts.permissionMode)) throw engineError("bad_request");
    if (hasPlanMode && typeof opts.planMode !== "boolean") throw engineError("bad_request");

    const S = await loadSeams();
    const applied = {};
    const bindsAtWake = {};

    if (hasModel) {
      const { provider, modelId } = opts.model;
      if (s.pi) {
        // Warm BEFORE the switch (spec: pi-lab's local-models starter
        // self-disables when a bot spawns it, so the provider must already be
        // serving before pi's own set_model tries to route to it).
        const slog = sessionLog(s);
        await S.warmModel(provider, slog);
        const res = await s.pi.commandSince({ type: "set_model", provider, modelId });
        const data = (res && res.data) || {};
        const rProvider = data.provider || provider;
        const rId = data.id || modelId;
        const rKey = rProvider + "/" + rId;
        const changed = s.currentModel !== rKey;
        s.currentModelParts = { provider: rProvider, modelId: rId };
        s.currentModel = rKey;
        s.resolved = Object.assign({}, s.resolved, { provider: rProvider, model: rId, key: rKey });
        applied.model = rKey;
        // The child's OWN model_select event for this same switch will also
        // arrive shortly — onModelSelect dedupes on an unchanged value, so
        // this is the only "now on <key>" log line the operator sees.
        if (changed) emit(s, { type: "log", text: "now on " + rKey });
      } else {
        // Hibernating: nothing live to command. Track it for the next wake's
        // startChild override (Task 4 behavior 2) instead.
        const key = provider + "/" + modelId;
        s.currentModelParts = { provider, modelId };
        s.currentModel = key;
        bindsAtWake.model = key;
      }
    }

    if (hasThinking) {
      if (s.pi) {
        await s.pi.commandSince({ type: "set_thinking_level", level: opts.thinking });
        applied.thinking = opts.thinking;
      }
      // Hibernating: no live child to command, and deliberately NO
      // persistence — pi's own session file remembers the thinking level
      // across a `--session` resume with no CLI flag to override it, so
      // there is nothing for THIS engine to bind at the next wake.
    }

    if (hasPermissionMode) {
      // Binds at wake ONLY — pi's permission policy is fixed via env at
      // spawn time (bridge.mjs's PiRpc constructor), so even an awake
      // session's mode change cannot take live effect without a restart the
      // operator did not ask for. Every accepted change still gets a visible
      // system note (spec §4.1.4) so the drawer's "current mode" reads true
      // even though nothing live just happened.
      s.permissionMode = opts.permissionMode;
      bindsAtWake.permissionMode = opts.permissionMode;
      emit(s, { type: "log", text: "permission mode → " + opts.permissionMode });
    }

    if (hasPlanMode) {
      // Track 3 Task 5: plan mode is entirely pi-lab's own extension state —
      // there is nothing to bind at wake (unlike model/permissionMode, a
      // hibernating session has no drawer toggle to disable-and-remember;
      // the operator would just re-open the drawer on wake and see it off).
      // It ALWAYS needs a live child: pi-lab's `/plan` command is handled by
      // the extension layer via a fully-acked prompt (never a real agent
      // turn), so a hibernating session is refused outright rather than
      // silently queued.
      if (!s.pi) throw engineError("not_awake");
      // NEVER bare `/plan` — that's a toggle (pi-lab plan-mode/index.ts) and
      // a footgun against stale drawer state if this call races a manual
      // `/plan` the operator just typed in the TUI. `promptAckOnly` waits
      // only for pi's ack of the prompt, never for agent_end — pi-lab's
      // `/plan` handler is fully synchronous inside the extension layer and
      // never starts an agent loop at all.
      await s.pi.promptAckOnly(opts.planMode ? "/plan on" : "/plan off");
      // The REAL plan-mode state (enabled/executing/todos…) arrives async
      // via the rpc-state-bridge mirror (onUiRequest's `crow-state:` notify)
      // and is what `s.planMode`/snapshot()/stateEvent() report from then on
      // — `applied.planMode` here only echoes the requested on/off intent,
      // confirming the ack succeeded, not the full state object.
      applied.planMode = opts.planMode;
    }

    emit(s, stateEvent(s));
    return { applied, bindsAtWake };
  }

  /**
   * Track 3 Task 4: live model/thinking-level menus for the drawer (Task 8).
   * Wakes are NEVER required just to list — a hibernating session (or one this
   * process has never held; resolveSession adopts) returns null arrays so the
   * caller can disable the pickers instead of spawning a child on a mere GET.
   */
  async function options(sessionId) {
    const s = await resolveSession(sessionId);
    if (!s) throw engineError("no_such_session");
    if (!s.pi) return { models: null, thinkingLevels: null };
    const [modelsRes, levelsRes] = await Promise.all([
      s.pi.commandSince({ type: "get_available_models" }),
      s.pi.commandSince({ type: "get_available_thinking_levels" }),
    ]);
    const models = (modelsRes && modelsRes.data && modelsRes.data.models) || [];
    const thinkingLevels = (levelsRes && levelsRes.data && levelsRes.data.levels) || [];
    return { models, thinkingLevels };
  }

  /** Resolve a session this process holds, or adopt its row (gateway restart).
   * Fix round 1 (I-2): EVERY public method resolves through here — before,
   * only message() adopted, so after a restart list() showed sessions that
   * get/subscribe/stop then refused as no_such_session. */
  async function resolveSession(sessionId) {
    const id = String(sessionId);
    return sessions.get(id) || (await adopt(id));
  }

  async function answer(sessionId, requestId, value) {
    const s = await resolveSession(sessionId);
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
    const s = await resolveSession(sessionId);
    if (!s) throw engineError("no_such_session");
    // I-2: nothing to abort — no in-flight turn and no pending card (the
    // adopted-after-restart hibernating case above all). An honest no-op
    // refusal, never a silent ok and never no_such_session.
    if (!s.turn && !s.pendingUi) throw engineError("no_turn");
    return abortInFlight(s);
  }

  async function stop(sessionId) {
    const s = await resolveSession(sessionId);
    if (!s) throw engineError("no_such_session");
    const pi = s.pi;
    s.pi = null;
    if (s.turn) s.turn.aborted = true;               // a late agent_end stays silent
    s.turn = null;
    clearStall(s);
    clearIdle(s);
    s.pendingUi = null;
    s.state = "stopped";
    // Track 3 Task 6: released on stop() — a stopped session's card is free
    // for a fresh dispatch. This is the primary release path (attachExit's
    // twin above only fires for an exit that lands on an already-stopped
    // session, which stop() itself just produced by nulling s.pi first).
    releaseCard(s.cardId, s.sessionId);
    if (pi) { try { await pi.close(); } catch { /* already dead */ } }
    writeLeases();
    await writeRow(s, { status: "stopped" }).catch(() => {});
    emit(s, stateEvent(s));
    return { ok: true };
  }

  /**
   * Track 3 Task 9: bind an EXISTING (already-spawned, free-chat or
   * previously card-bound) session to a card — the drawer's "attach to this
   * card" action, distinct from `spawn({cardId})`'s dispatch-time binding.
   * Occupancy is the caller's job: the ROUTE runs the same card validation +
   * `checkCardFree` DB check `spawn()`'s dispatch route does, BEFORE ever
   * calling in here — this method only performs the synchronous in-process
   * claim (`claimCard`, same TOCTOU discipline as spawn's card claim: no
   * await between the check and the set) and the row/state write. Refused on
   * `session_stopped` — a stopped session has no future turn to hand the
   * card's work to.
   *
   * Re-attaching to a DIFFERENT card than the one currently held releases the
   * old claim (only after the new one is safely held) so a session is never
   * left owning two cards, and a failed row write rolls the claim back
   * cleanly rather than leaving the in-memory map and the DB row disagreeing.
   */
  async function attachCard(sessionId, cardId) {
    const s = await resolveSession(sessionId);
    if (!s) throw engineError("no_such_session");
    if (s.state === "stopped") throw engineError("session_stopped");
    const cid = Number(cardId);
    const prevCardId = s.cardId;
    if (prevCardId === cid) {
      // Idempotent reassert: the session already holds this exact claim, so
      // there is no claim or row state to churn. (assigned_bot provenance is
      // the ROUTE's job on every call, not this method's — it re-writes that
      // unconditionally regardless of what this returns.)
      return { ok: true, cardId: cid, botId: s.botId };
    }
    claimCard(cid, s.sessionId);                        // throws card_occupied
    s.cardId = cid;
    try {
      await writeRow(s, { status: s.pi ? "active" : "waiting-user" });
    } catch (e) {
      s.cardId = prevCardId;
      releaseCard(cid, s.sessionId);
      throw e;
    }
    if (prevCardId != null) releaseCard(prevCardId, s.sessionId);
    emit(s, stateEvent(s));
    return { ok: true, cardId: cid, botId: s.botId };
  }

  async function subscribe(sessionId, fn) {
    const s = await resolveSession(sessionId);
    if (!s) throw engineError("no_such_session");
    s.subscribers.add(fn);
    try {
      fn(stateEvent(s));
      // Replay the pending question, and ONLY a pending one: stop / abort /
      // hibernate / child exit all clear it, so a late subscriber can never be
      // shown a card no child is waiting on.
      if (s.pendingUi) fn({ type: "ask_user", ...s.pendingUi });
      // Track 3 Task 5: replay the last known plan-mode mirror so a late
      // subscriber's drawer opens already showing plan-mode state instead of
      // waiting for the NEXT bus tick (which may never come if nothing
      // changes).
      if (s.planMode) fn({ type: "plan_state", state: s.planMode });
    } catch { /* a broken subscriber is not our problem */ }
    return () => s.subscribers.delete(fn);
  }

  async function get(sessionId) {
    const s = await resolveSession(sessionId);
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
    // Track 3 Task 7 (spec I5): an assertion-style guard — hibernate must
    // NEVER destroy a session with a pending ask_user card. cycle() refuses
    // first (cycle_busy) and safe-victim eviction never selects a pendingUi
    // candidate, so this should be unreachable from either — it exists for
    // any FUTURE caller that forgets one of those checks: refusing (and
    // logging) is safer than silently killing the child a human is mid-answer
    // to and losing the question with it.
    if (s.pendingUi) {
      log(s.sessionId + ": hibernate refused — a pendingUi card is in flight");
      return;
    }
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
      // Track 3 Task 7: captured BEFORE the existing `s.turn = null` below —
      // reading it AFTER always reads false (a null turn), so the
      // interrupted marker would never fire. This session was genuinely
      // mid-turn when the shutdown interrupted it, distinct from a plain idle
      // park (control stays 'run').
      const hadTurn = !!s.turn;
      if (s.turn) s.turn.aborted = true;
      s.turn = null;
      if (s.state !== "stopped") s.state = "hibernating";
      let timerHandle = null;
      await Promise.race([
        (async () => {
          // I-1: PARK the row FIRST, then close. A row left 'active' with a
          // fresh updated_at reads as a live cross-process claim after a
          // restart — assertRowClaimable would 409 the next gateway's wake
          // for a full turn budget. Best-effort, and written before the close
          // so a child that ignores SIGTERM cannot skip it.
          try {
            await writeRow(s, { status: "waiting-user" }, hadTurn ? "interrupted" : "run");
          } catch { /* best effort */ }
          try { await pi.close(); } catch { /* already dead */ }
        })(),
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
    steer,
    cycle,
    control,
    options,
    answer,
    abort,
    stop,
    subscribe,
    get,
    list,
    stopAll,
    /** Track 3 Task 6: exported so the dispatch ROUTE can 409 a card BEFORE
     * ever reaching spawn() — see the module header. */
    checkCardFree,
    /** Track 3 Task 9: attach an existing session to a card — see its own doc. */
    attachCard,
    /** Precondition-test surface (r1 S10) — also the internal resolver. */
    _loadSeams: loadSeams,
    /** Track 3 Task 7: test-only reach into the internal hibernate() — every
     * LIVE call site (idle timer, safe-victim eviction, cycle()) already
     * guards against a pendingUi target before calling in, so hibernate()'s
     * own assertion-style guard (spec I5) is otherwise unreachable through
     * the public surface. This lets a test prove the guard itself, not just
     * its callers' defensiveness. Takes a sessionId (not the internal record
     * `snapshot()` would return) and resolves it through the SAME resident
     * map every public method uses. */
    _hibernateForTest: async (sessionId) => {
      const s = sessions.get(String(sessionId));
      if (!s) throw engineError("no_such_session");
      return hibernate(s);
    },
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
