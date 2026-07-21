/**
 * bot-runtime.js — gateway-supervised bot runtime (C4 Task 6).
 *
 * Two long-lived pieces the gateway process now owns directly, instead of
 * requiring a host operator to install systemd units by hand:
 *   - the bridge tick (Gmail-driven bots): an in-process interval calling
 *     `runBridgeTick()` from `scripts/pi-bots/bridge_tick_lib.mjs` (C4 Task 5)
 *     every `PIBOT_BRIDGE_TICK_MS` (default 60000).
 *   - the Discord gateway child: a supervised `discord_gateway.mjs` process
 *     (via `superviseProcess`, C4 Task 1's extraction), started only when at
 *     least one enabled bot declares a discord gateway with a token.
 *
 * Both are gated by the SAME `bot_runtime` feature flag every other pi-bots
 * runner already respects (`runtime-gate.mjs`'s `runtimeGate`/
 * `botRuntimeEnabledSync`) — flipping the dashboard toggle arms/disarms this
 * in-process runtime with NO gateway restart, exactly like the standalone
 * `pibot-bridge.timer`/`pibot-discord.service` units do today. `runtimeGate`
 * needs a SYNC better-sqlite3 connection (it calls `conn.prepare` directly),
 * so this module opens its OWN handle on `botsDbPath()` — post-listen's
 * async `createDbClient` would make the flag read silently return false
 * forever (see runtime-gate.mjs:31,35 and the discord_gateway.mjs:222
 * precedent for the same pattern).
 *
 * Mode resolution, in order (env is an INJECTED param, never read from
 * process.env directly in this function — run-suite.mjs exports
 * CROW_DISABLE_BOT_RUNTIME=1 suite-wide, and tests need to pass a clean env
 * object to exercise gateway mode without that kill switch):
 *   env.CROW_DISABLE_BOT_RUNTIME === "1"  → mode "disabled" (scratch/test kill switch)
 *   env.PIBOT_SUPERVISOR === "external"   → mode "external" (host systemd manages
 *                                           the pibot units directly; log one
 *                                           honest line, do nothing)
 *   else                                  → mode "gateway"
 *
 * Circuit breaker: PIBOT_BREAKER_THRESHOLD (default 3) consecutive tick
 * failures (the tick threw, OR its result carried `errors` with zero
 * successful `handled` turns) opens the breaker for PIBOT_BREAKER_COOLDOWN_MS
 * (default 600000). While open, ticks past the cooldown are attempted as a
 * single half-open trial: success closes the breaker (failures zeroed);
 * failure keeps it open and pushes `retryAt` out another cooldown window.
 * `runtimeGate` stopping the runtime (flag flipped off) RESETS the breaker —
 * stale failure state must not survive a deliberate off/on cycle. The
 * breaker is published to `bot-engine-status.js` via `setBreakerSource()` so
 * the readiness UI and the attach gate see it without importing this module.
 *
 * Discord reconcile: subscribes to the shared event bus's
 * "pibots:defs-changed" event (the same bus `routes/bundles.js`'s
 * `emitJobChanged` uses for `jobs:changed`), debounced 2s so a burst of tab
 * saves collapses into one reconcile. Compares the serialized discord
 * gateway config (token/guild_id/channel_ids/allowlist) across the whole
 * enabled-bot set: a discord bot appearing starts the child, the last one
 * disappearing stops it, and ANY config change restarts it — the child only
 * reads defs at its own startup, so an edited token must not keep the old
 * Discord session alive under the stale credential.
 */
import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";

import bus from "../shared/event-bus.js";
import { botsDbPath } from "../../scripts/pi-bots/instance-paths.mjs";
import { runtimeGate } from "../../scripts/pi-bots/runtime-gate.mjs";
import { runBridgeTick as defaultRunBridgeTick } from "../../scripts/pi-bots/bridge_tick_lib.mjs";
import { superviseProcess as defaultSuperviseProcess } from "./process-supervisor.js";
import { setBreakerSource } from "./bot-engine-status.js";

const DISCORD_GATEWAY_PATH = fileURLToPath(
  new URL("../../scripts/pi-bots/discord_gateway.mjs", import.meta.url)
);

const DEBOUNCE_MS = 2000;

function defaultDbFactory(path) {
  const d = new Database(path);
  d.pragma("busy_timeout = 10000");
  return d;
}

function freshBreaker() {
  return { open: false, failures: 0, lastError: null, retryAt: null };
}

function freshState() {
  return {
    mode: "disabled",
    bridge: { armed: false, lastTickAt: null, lastResult: null, breaker: freshBreaker() },
    discord: { lastError: null },
  };
}

let state = freshState();

// Runtime-only wiring, torn down/rebuilt by _resetBotRuntimeForTest().
let gateHandle = null;
let ownedConn = null; // the connection WE opened (closed on reset iff we own it)
let discordHandle = null;
let discordRegistry = new Map();
let lastDiscordSignature = null;
let bridgeTimer = null;
let reconcileTimer = null;
let busHandler = null;
let tickInFlight = false;

/** Read enabled bots' discord gateway configs (token/guild/channels/allowlist). */
function discordBotConfigs(conn) {
  let rows = [];
  try {
    rows = conn.prepare("SELECT bot_id, definition FROM pi_bot_defs WHERE enabled=1").all();
  } catch {
    return [];
  }
  const out = [];
  for (const row of rows) {
    let def;
    try { def = JSON.parse(row.definition || "{}"); } catch { continue; }
    const gw = (def.gateways || []).find((g) => g && g.type === "discord" && g.token);
    if (!gw) continue;
    out.push({
      bot_id: row.bot_id,
      token: gw.token,
      guild_id: gw.guild_id || null,
      channel_ids: Array.isArray(gw.channel_ids) ? gw.channel_ids.filter(Boolean) : [],
      allowlist: Array.isArray(gw.allowlist) ? gw.allowlist.filter(Boolean) : [],
    });
  }
  out.sort((a, b) => (a.bot_id < b.bot_id ? -1 : a.bot_id > b.bot_id ? 1 : 0));
  return out;
}

function discordSignature(configs) {
  return JSON.stringify(configs);
}

/**
 * @param {object} [opts]
 * @param {object} [opts.env] defaults to process.env — the ONLY two reads
 *   this module does of it are CROW_DISABLE_BOT_RUNTIME and PIBOT_SUPERVISOR
 *   (mode resolution). Everything else (PIBOT_BRIDGE_TICK_MS,
 *   PIBOT_BREAKER_THRESHOLD, PIBOT_BREAKER_COOLDOWN_MS) is also read from
 *   this SAME injected object, so a test exercising gateway mode never needs
 *   the real process.env to carry them.
 * @param {(path:string) => import("better-sqlite3").Database} [opts._dbFactory]
 *   test seam for the connection this module opens on botsDbPath().
 * @param {import("better-sqlite3").Database} [opts._conn] test seam: use this
 *   connection directly instead of opening one via _dbFactory/botsDbPath().
 *   When provided, _resetBotRuntimeForTest() will NOT close it (the caller
 *   owns its lifetime).
 * @param {Function} [opts._runBridgeTick] test seam, defaults to the real
 *   runBridgeTick from bridge_tick_lib.mjs.
 * @param {Function} [opts._superviseProcess] test seam, defaults to the real
 *   superviseProcess from process-supervisor.js.
 * @param {Function} [opts._setIntervalFn]
 * @param {Function} [opts._clearIntervalFn]
 * @param {Function} [opts._setTimeoutFn]
 * @param {Function} [opts._clearTimeoutFn]
 * @param {import("node:events").EventEmitter} [opts._bus] test seam, defaults
 *   to the shared event bus.
 * @param {number} [opts._pollMs] test seam forwarded as runtimeGate's
 *   pollMs (default 30000) — tests shrink this to observe a flag flip
 *   without a real 30s wait.
 */
export async function initBotRuntime({
  env = process.env,
  _dbFactory = defaultDbFactory,
  _conn = null,
  _runBridgeTick = defaultRunBridgeTick,
  _superviseProcess = defaultSuperviseProcess,
  _setIntervalFn = setInterval,
  _clearIntervalFn = clearInterval,
  _setTimeoutFn = setTimeout,
  _clearTimeoutFn = clearTimeout,
  _bus = bus,
  _pollMs = 30000,
} = {}) {
  if (env.CROW_DISABLE_BOT_RUNTIME === "1") {
    state.mode = "disabled";
    return { mode: "disabled" };
  }
  if (env.PIBOT_SUPERVISOR === "external") {
    state.mode = "external";
    console.log("[bot-runtime] PIBOT_SUPERVISOR=external — host systemd manages the pibot units; gateway bot-runtime does nothing");
    return { mode: "external" };
  }

  state.mode = "gateway";

  const conn = _conn || _dbFactory(botsDbPath());
  if (!_conn) ownedConn = conn;

  const threshold = Number(env.PIBOT_BREAKER_THRESHOLD) || 3;
  const cooldownMs = Number(env.PIBOT_BREAKER_COOLDOWN_MS) || 600000;
  const tickMs = Number(env.PIBOT_BRIDGE_TICK_MS) || 60000;

  setBreakerSource(() => ({ ...state.bridge.breaker }));

  function recordFailure(errMsg) {
    const breaker = state.bridge.breaker;
    breaker.failures = (breaker.failures || 0) + 1;
    breaker.lastError = errMsg || breaker.lastError || null;
    if (breaker.open || breaker.failures >= threshold) {
      breaker.open = true;
      breaker.retryAt = new Date(Date.now() + cooldownMs).toISOString();
    }
  }

  function recordSuccess() {
    state.bridge.breaker = freshBreaker();
  }

  async function tick() {
    if (tickInFlight) return; // non-overlap busy guard
    const breaker = state.bridge.breaker;
    if (breaker.open) {
      const retryAtMs = breaker.retryAt ? Date.parse(breaker.retryAt) : 0;
      if (Date.now() < retryAtMs) return; // still cooling down — skip silently
      // past retryAt: fall through as a half-open trial
    }
    tickInFlight = true;
    try {
      let result;
      try {
        result = await _runBridgeTick({ log: (...a) => console.log("[bot-runtime]", ...a) });
      } catch (e) {
        recordFailure((e && e.message) || String(e));
        return;
      }
      state.bridge.lastTickAt = new Date().toISOString();
      state.bridge.lastResult = result;
      const failed = result && Array.isArray(result.errors) && result.errors.length > 0 && !(result.handled > 0);
      if (failed) {
        recordFailure(result.errors[result.errors.length - 1]);
      } else {
        recordSuccess();
      }
    } finally {
      tickInFlight = false;
    }
  }

  function startBridge() {
    bridgeTimer = _setIntervalFn(tick, tickMs);
    if (bridgeTimer && bridgeTimer.unref) bridgeTimer.unref();
    state.bridge.armed = true;
    console.log(`[bot-runtime] bridge interval armed (${tickMs}ms)`);
  }

  function stopBridge() {
    if (bridgeTimer) { _clearIntervalFn(bridgeTimer); bridgeTimer = null; }
    state.bridge.armed = false;
  }

  function startDiscord() {
    if (discordHandle) return;
    const configs = discordBotConfigs(conn);
    discordHandle = _superviseProcess({
      key: "pibot-discord",
      command: process.execPath,
      args: [DISCORD_GATEWAY_PATH],
      env: process.env,
      maxRestarts: 10,
      idleMinutes: 0,
      registry: discordRegistry,
      onTerminal: (reason) => {
        state.discord.lastError = `terminal: ${reason}`;
      },
    });
    lastDiscordSignature = discordSignature(configs);
    console.log("[bot-runtime] discord child started");
  }

  async function stopDiscord() {
    if (!discordHandle) return;
    const h = discordHandle;
    discordHandle = null;
    await h.stop();
    console.log("[bot-runtime] discord child stopped");
  }

  async function restartDiscord() {
    await stopDiscord();
    startDiscord();
  }

  async function reconcileDiscord() {
    const configs = discordBotConfigs(conn);
    if (configs.length === 0) {
      await stopDiscord();
      return;
    }
    if (!discordHandle) {
      startDiscord();
      return;
    }
    const sig = discordSignature(configs);
    if (sig !== lastDiscordSignature) {
      await restartDiscord();
    }
  }

  function scheduleReconcile() {
    if (reconcileTimer) _clearTimeoutFn(reconcileTimer);
    reconcileTimer = _setTimeoutFn(() => {
      reconcileTimer = null;
      reconcileDiscord().catch((e) => console.warn("[bot-runtime] reconcile error:", e && e.message));
    }, DEBOUNCE_MS);
    if (reconcileTimer && reconcileTimer.unref) reconcileTimer.unref();
  }

  async function start() {
    startBridge();
    if (discordBotConfigs(conn).length > 0) startDiscord();
    busHandler = () => scheduleReconcile();
    _bus.on("pibots:defs-changed", busHandler);
  }

  async function stop() {
    stopBridge();
    if (busHandler) { _bus.off("pibots:defs-changed", busHandler); busHandler = null; }
    if (reconcileTimer) { _clearTimeoutFn(reconcileTimer); reconcileTimer = null; }
    await stopDiscord();
    // A deliberate off/on cycle must never carry stale failure state into
    // the next "on" — reset unconditionally on every stop().
    state.bridge.breaker = freshBreaker();
  }

  gateHandle = runtimeGate(conn, { start, stop, pollMs: _pollMs, logTag: "bot-runtime" });

  return { mode: "gateway" };
}

/**
 * @returns {{ mode: "gateway"|"external"|"disabled",
 *   bridge: { armed: boolean, lastTickAt: string|null, lastResult: object|null,
 *             breaker: { open: boolean, failures: number, lastError: string|null, retryAt: string|null } },
 *   discord: { running: boolean, state: string, restartCount: number, lastError: string|null } }}
 */
export function botRuntimeStatus() {
  return {
    mode: state.mode,
    bridge: {
      armed: state.bridge.armed,
      lastTickAt: state.bridge.lastTickAt,
      lastResult: state.bridge.lastResult,
      breaker: { ...state.bridge.breaker },
    },
    discord: {
      running: !!(discordHandle && discordHandle.live),
      state: discordHandle ? discordHandle.state : "stopped",
      restartCount: discordHandle ? discordHandle.restartCount : 0,
      lastError: state.discord.lastError,
    },
  };
}

/** Test-only: tear down every module-level seam so one test can never leak
 * timers, bus listeners, or breaker state into the next. */
export function _resetBotRuntimeForTest() {
  if (gateHandle) { try { gateHandle.dispose(); } catch {} }
  gateHandle = null;
  if (busHandler) { try { bus.off("pibots:defs-changed", busHandler); } catch {} busHandler = null; }
  if (bridgeTimer) { try { clearInterval(bridgeTimer); } catch {} bridgeTimer = null; }
  if (reconcileTimer) { try { clearTimeout(reconcileTimer); } catch {} reconcileTimer = null; }
  if (discordHandle) { try { discordHandle.stop(); } catch {} discordHandle = null; }
  discordRegistry = new Map();
  lastDiscordSignature = null;
  tickInFlight = false;
  if (ownedConn) { try { ownedConn.close(); } catch {} ownedConn = null; }
  setBreakerSource(null);
  state = freshState();
}
