/**
 * perch-runtime.js — gateway supervision of the vendored Perch hub
 * (Perch Hub Phase 1, Task C-2).
 *
 * The `perch-hub` bundle ships a vendored pi-lab hub as a plain-Node payload
 * under `CROW_HOME/bundles/perch-hub/payload/`. Rather than asking a host
 * operator to install a systemd unit by hand, the gateway owns the process
 * directly — same deal as `bot-runtime.js`'s Discord child, and on the same
 * generic machinery (`process-supervisor.js`: restart budget, process-group
 * kill, `onTerminal` hook).
 *
 * Start conditions (BOTH required):
 *   - the payload entrypoint `bundles/perch-hub/payload/hub/server.mjs` exists
 *     under CROW_HOME (i.e. the bundle is actually installed), and
 *   - `env.CROW_DISABLE_PERCH !== "1"` — the kill switch, mirroring
 *     `CROW_DISABLE_BOT_RUNTIME`. `scripts/run-suite.mjs` forces it on
 *     suite-wide; tests that need the runtime use the injected seams below.
 * The kill switch is checked FIRST, so an explicitly disabled host reports
 * `reason: "disabled"` even when the payload is present — but `installed` in
 * the status snapshot still tells the truth about what is on disk.
 *
 * Auth: the hub in crow mode reads its bearer from `PERCH_API_TOKEN` rather
 * than `~/.pi/agent/settings.json` (a stranger's box has no pi settings
 * file). This module mints that token once, into `CROW_HOME/perch-token`
 * with mode 0600, and REUSES it on every later init — the extension proxy
 * (C-3) reads the same file lazily per request to inject the header, so a
 * regenerated token would silently break every proxied request until the next
 * gateway restart.
 *
 * Ports are loopback-only and per-instance overridable (`CROW_PERCH_PORT` /
 * `CROW_PERCH_REGISTRY_PORT`, defaults 4210/4211, session pool 4141-4179 —
 * all registered in docs/developers/port-allocation.md). The lab's live
 * `pi-hub.service` on 4200/4201/4101-4139 is deliberately clear of this block.
 *
 * The `spawn` wrapper is not optional decoration: `superviseProcess` spawns
 * with `stdio: ["ignore", "pipe", "pipe"]` (`process-supervisor.js:116`) and
 * never reads those pipes. An error-looping hub would fill the 64 KB pipe
 * buffer and block on write — a stalled child that still looks "running".
 * Draining both streams into the gateway log (prefix `[perch-hub]`) is what
 * keeps that from happening, and doubles as the only visibility we have into
 * the child.
 */
import { spawn as spawnCb } from "node:child_process";
import { randomBytes as cryptoRandomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { superviseProcess as defaultSuperviseProcess, stopSupervised } from "./process-supervisor.js";

/** Bundle id — also the proxy path segment (`/proxy/perch-hub`) and the
 * supervisor key. `bundle-contract.mjs` requires id == dirname, so this is
 * the one true spelling. */
export const PERCH_BUNDLE_ID = "perch-hub";

const DEFAULT_PORT = "4210";
const DEFAULT_REGISTRY_PORT = "4211";
const POOL_START = "4141";
const POOL_END = "4179";

function freshState() {
  return { installed: false, port: null, lastError: null };
}

let state = freshState();
let handle = null;

function payloadDirFor(crowHome) {
  return join(crowHome, "bundles", PERCH_BUNDLE_ID, "payload");
}

/**
 * Attach `data` listeners that forward child output to `log`, one line at a
 * time, prefixed. Exported for tests (and because it is the whole point of
 * the spawn wrapper — see the module header).
 */
export function attachChildLogDrain(child, log) {
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue;
    stream.on("data", (chunk) => {
      const text = chunk.toString();
      for (const line of text.split("\n")) {
        if (line.trim()) log(`[${PERCH_BUNDLE_ID}] ${line.trimEnd()}`);
      }
    });
  }
  return child;
}

/**
 * Read `CROW_HOME/perch-token`, or mint it (32-byte hex, mode 0600) if it is
 * absent or empty. Never regenerates an existing token.
 */
function readOrMintToken(crowHome, randomBytes) {
  const tokenPath = join(crowHome, "perch-token");
  let token = null;
  if (existsSync(tokenPath)) {
    try {
      token = readFileSync(tokenPath, "utf8").trim() || null;
    } catch {
      token = null;
    }
  }
  if (token) return token;
  token = Buffer.from(randomBytes(32)).toString("hex");
  mkdirSync(crowHome, { recursive: true });
  writeFileSync(tokenPath, token, { mode: 0o600 });
  // writeFileSync's `mode` is honored only when it CREATES the file; an
  // existing-but-empty file would keep whatever perms it had.
  try { chmodSync(tokenPath, 0o600); } catch { /* best effort */ }
  return token;
}

/**
 * @param {object} [opts]
 * @param {object} [opts.env] defaults to process.env. Every env read this
 *   module does (CROW_DISABLE_PERCH, CROW_PERCH_PORT,
 *   CROW_PERCH_REGISTRY_PORT) goes through THIS object, and it is also the
 *   base of the child's env — so a test never needs the real process.env to
 *   carry anything.
 * @param {string} [opts.crowHome] defaults to `env.CROW_HOME` (falling back to
 *   `~/.crow`) — never a hardcoded homedir path (#217 class).
 * @param {Function} [opts.superviseProcess] seam, defaults to the real
 *   superviseProcess from process-supervisor.js.
 * @param {Function} [opts.randomBytes] seam for token minting.
 * @param {Function} [opts._spawn] seam for the raw spawn UNDER the log-drain
 *   wrapper (the wrapper itself is always installed).
 * @param {(line:string)=>void} [opts._log] seam for the drained child output.
 * @returns {Promise<{started:boolean, reason?:"disabled"|"not_installed", handle?:object}>}
 */
export async function initPerchRuntime({
  env = process.env,
  crowHome = env.CROW_HOME || join(homedir(), ".crow"),
  superviseProcess = defaultSuperviseProcess,
  randomBytes = cryptoRandomBytes,
  _spawn = spawnCb,
  _log = (line) => console.log(line),
} = {}) {
  const payloadDir = payloadDirFor(crowHome);
  const serverPath = join(payloadDir, "hub", "server.mjs");
  state.installed = existsSync(serverPath);

  // Kill switch first: an operator (or run-suite) saying "off" outranks a
  // present payload. `installed` above still reports the disk truth.
  if (env.CROW_DISABLE_PERCH === "1") {
    return { started: false, reason: "disabled" };
  }
  if (!state.installed) {
    return { started: false, reason: "not_installed" };
  }

  const token = readOrMintToken(crowHome, randomBytes);
  const port = String(env.CROW_PERCH_PORT || DEFAULT_PORT);
  const registryPort = String(env.CROW_PERCH_REGISTRY_PORT || DEFAULT_REGISTRY_PORT);

  handle = superviseProcess({
    key: PERCH_BUNDLE_ID,
    command: process.execPath,
    args: [serverPath],
    cwd: payloadDir,
    env: {
      ...env,
      PERCH_CROW_MODE: "1",
      // The proxy STRIPS this prefix before the hub sees a request
      // (`pathRewrite` in extension-proxy.js) — it exists so the hub EMITS
      // urls that resolve under the gateway. Never double-prefix.
      PERCH_BASE_PATH: `/proxy/${PERCH_BUNDLE_ID}`,
      PERCH_API_TOKEN: token,
      PI_HUB_PORT: port,
      PI_HUB_REGISTRY_PORT: registryPort,
      PI_HUB_POOL_START: POOL_START,
      PI_HUB_POOL_END: POOL_END,
    },
    alwaysResident: true,
    maxRestarts: 3,
    spawn: (cmd, args, spawnOpts) => attachChildLogDrain(_spawn(cmd, args, spawnOpts), _log),
    onTerminal: (reason) => {
      state.lastError = `terminal: ${reason}`;
    },
  });
  state.port = Number(port);
  state.lastError = null;

  console.log(`[${PERCH_BUNDLE_ID}] supervised hub started on 127.0.0.1:${port} (registry ${registryPort})`);
  return { started: true, handle };
}

/**
 * @returns {{ installed: boolean, running: boolean, state: string,
 *   lastError: string|null, port: number|null }}
 *   Consumed by the Perch nav panel (C-7): `installed:false` renders the gate
 *   card, `running:false` renders "Perch offline" plus `lastError` — never a
 *   dead iframe.
 */
export function perchRuntimeStatus() {
  return {
    installed: state.installed,
    running: !!(handle && handle.live),
    state: handle ? handle.state : "stopped",
    lastError: state.lastError || (handle ? handle.lastError : null),
    port: state.port,
  };
}

/**
 * Stop the supervised hub and RESOLVE once the child has actually exited —
 * the uninstall path (C-3) awaits this (bounded) before `rmSync`-ing the
 * payload dir out from under a live child whose cwd is inside it.
 *
 * @returns {Promise<boolean>} true if a handle was stopped, false if nothing
 *   was running (idempotent).
 */
export async function stopPerchRuntime() {
  if (!handle) return false;
  const h = handle;
  handle = null;
  await stopSupervised(h);
  return true;
}

/**
 * How long either caller of the bounded stop waits for the child to exit
 * before giving up and carrying on. Both the uninstall path (bundles.js) and
 * gateway shutdown (index.js) use it, deliberately: a hub wedged in an
 * uninterruptible state must never hang an uninstall job forever, nor hold the
 * gateway open past its shutdown budget.
 */
export const PERCH_STOP_TIMEOUT_MS = 5000;

/**
 * `stopPerchRuntime()` with a hard wall-clock cap.
 *
 * `handle.stop()` resolves on the child's `exit` event
 * (`process-supervisor.js`), so a child that ignores SIGTERM never resolves
 * it. The caller is told which happened rather than being left to guess.
 *
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs] cap, defaults to PERCH_STOP_TIMEOUT_MS
 * @param {Function} [opts.stopImpl] seam, defaults to stopPerchRuntime
 * @returns {Promise<{stopped:boolean, timedOut:boolean}>}
 */
export async function stopPerchRuntimeBounded({
  timeoutMs = PERCH_STOP_TIMEOUT_MS,
  stopImpl = stopPerchRuntime,
} = {}) {
  let timer = null;
  const TIMED_OUT = Symbol("timed-out");
  const outcome = await Promise.race([
    Promise.resolve().then(stopImpl).catch(() => false),
    new Promise((r) => { timer = setTimeout(() => r(TIMED_OUT), timeoutMs); }),
  ]);
  if (timer) clearTimeout(timer);
  if (outcome === TIMED_OUT) return { stopped: false, timedOut: true };
  return { stopped: outcome === true, timedOut: false };
}

/** Test-only: drop the supervised handle and all module-level state so one
 * test can never leak a running child or a stale lastError into the next. */
export function _resetPerchRuntimeForTest() {
  if (handle) {
    try { handle.stop(); } catch { /* nothing to do on a fake handle */ }
    handle = null;
  }
  state = freshState();
}
