/**
 * Models state store + port allocator (Item G, native model runtime).
 *
 * One JSON state file per CROW_HOME (`<dir>/models/state.json`) holding
 * three independent maps keyed by modelId:
 *
 *   - reservations: ephemeral port claims for a locally-spawned model
 *     runtime process (18100-18199), each with an owner {crowHome, pid}
 *     and createdAt so a later boot can tell a live claim from a stale one.
 *   - journal: in-progress model downloads (url/dest/bytesDone/expectedSha/
 *     startedAt) so a killed download can resume instead of restarting.
 *   - registry: models this CROW_HOME has actually installed (file/quant/
 *     catalogId/registeredAt/sizeMb), independent of whether a runtime is
 *     currently running for them. Two optional fields ride the same entry:
 *     `wasLive`/`lastStoppedAt` (Task 13 fix round 1, finding c — see
 *     `registryEntryRuntimeState` below, written by `gpu-orchestrator.js`)
 *     and `source` (e.g. `"hf-browser"` — Task 13 fix round 1, finding 1,
 *     written by `manager.js`'s `registerModel` via its `registryExtra`
 *     param) distinguishing an un-vetted Browse-Hugging-Face registration
 *     from a curated one.
 *
 * `dir` is always injected by the caller — this module never guesses a
 * path itself. Production callers pass `resolveDataDir()` (the same
 * data-dir helper `servers/gateway/index.js` uses, from `servers/db.js`);
 * tests pass an `fs.mkdtempSync` scratch dir. This host runs multiple
 * gateways (primary, MPA, ...) with distinct CROW_HOMEs — a hardcoded
 * `~/.crow/...` here would cross-contaminate their model runtimes.
 *
 * `reconcileOnBoot` is a pure function over its three injected callbacks
 * (`state`, `listProviderRows()`, `isProcessAlive(pid)`) — it never opens
 * the real DB or touches `process` itself, so it's testable without a live
 * gateway.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import net from "node:net";

import { resolveDataDir } from "../../db.js";

export const PORT_RANGE_START = 18100;
export const PORT_RANGE_END = 18199; // inclusive

/**
 * Thrown by allocatePort when every port in the range is reserved or
 * actually bound by something else on the host.
 */
export class PortRangeExhaustedError extends Error {
  constructor(message = `No free port in ${PORT_RANGE_START}-${PORT_RANGE_END}`) {
    super(message);
    this.name = "PortRangeExhaustedError";
    this.code = "PORT_RANGE_EXHAUSTED";
  }
}

function emptyState() {
  return { reservations: {}, journal: {}, registry: {} };
}

/** Path to the state file for a given (injected) CROW_HOME/data dir. */
export function statePath(dir) {
  return join(dir, "models", "state.json");
}

/**
 * Load state from `<dir>/models/state.json`. Missing file or unparsable
 * JSON both resolve to a fresh empty state rather than throwing — a
 * corrupt/absent state file must never block boot.
 */
export function loadState(dir) {
  const path = statePath(dir);
  if (!existsSync(path)) return emptyState();
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    return {
      reservations: (parsed && typeof parsed.reservations === "object" && parsed.reservations) || {},
      journal: (parsed && typeof parsed.journal === "object" && parsed.journal) || {},
      registry: (parsed && typeof parsed.registry === "object" && parsed.registry) || {},
    };
  } catch {
    return emptyState();
  }
}

/**
 * Atomically persist state to `<dir>/models/state.json`: write to a
 * pid+timestamp-suffixed tmp file in the same directory, then rename over
 * the target. Rename is atomic on the same filesystem, so a reader never
 * observes a half-written file.
 */
export function saveState(dir, state) {
  const path = statePath(dir);
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = join(dirname(path), `.state.json.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  writeFileSync(tmpPath, JSON.stringify(state, null, 2), "utf8");
  renameSync(tmpPath, path);
}

/**
 * Bind-test a port on 127.0.0.1: resolves true if a listener could be
 * opened (and immediately closes it), false if the bind failed (in use by
 * something on the host, reserved or not).
 */
function canBind(port) {
  return new Promise((resolvePromise) => {
    const server = net.createServer();
    server.once("error", () => {
      resolvePromise(false);
    });
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolvePromise(true));
    });
  });
}

/**
 * Reserve the lowest free port in 18100-18199 for `modelId`. "Free" means
 * both: not already recorded in `state.reservations`, and actually
 * bindable on 127.0.0.1 right now (a stale reservation could otherwise
 * shadow a port something else on the host is legitimately using, or vice
 * versa a live OS-level bind could go unnoticed by a reservations-only
 * check). Mutates `state.reservations` in place and returns the port.
 *
 * `owner.crowHome` defaults to `resolveDataDir()` (call-time, not a
 * module-load constant, so it reflects whichever CROW_HOME this process
 * is actually running under) and can be overridden for tests.
 */
export async function allocatePort(state, modelId, { crowHome = resolveDataDir(), pid = process.pid } = {}) {
  const reservedPorts = new Set(Object.values(state.reservations).map((r) => r.port));
  for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
    if (reservedPorts.has(port)) continue;
    // eslint-disable-next-line no-await-in-loop -- ports must be probed in
    // ascending order, one at a time; parallelizing would race binds.
    const free = await canBind(port);
    if (!free) continue;
    state.reservations[modelId] = {
      port,
      owner: { crowHome, pid },
      createdAt: new Date().toISOString(),
    };
    return port;
  }
  throw new PortRangeExhaustedError();
}

/** Free modelId's port reservation, if any. No-op if it has none. */
export function releasePort(state, modelId) {
  delete state.reservations[modelId];
}

/**
 * Classify a registry entry's runtime state for the panel (Task 13 fix
 * round 1, finding c — the "reloading after update" state).
 *
 * `live` is whatever `GET /api/models/runtime` (or the panel's SSR
 * equivalent) already determined from the in-process handle snapshot for
 * this process lifetime — this function never touches that itself, it only
 * decides what to say when `live` is false.
 *
 * `entry.wasLive` is set by `gpu-orchestrator.js` the moment a native model
 * actually becomes resident, and cleared back to `false` (with
 * `lastStoppedAt` stamped) the moment it reaches ANY terminal state
 * (explicit stop, sibling swap-out, idle-unload, crash-exhausted) WHILE
 * that same gateway process is still running. That ordering is exactly
 * what makes `wasLive === true` combined with `live === false` mean "this
 * process never got the chance to see it stop" — i.e. the gateway itself
 * restarted out from under a resident model — rather than "the user (or
 * the system) deliberately stopped it," which always clears the marker
 * before any restart could intervene. A model that was never started at
 * all (or was cleanly stopped before the restart) has `wasLive` `false`/
 * absent and correctly reads as plain `"stopped"`.
 *
 * @param {{wasLive?: boolean}|null|undefined} entry - a `state.registry[modelId]` entry
 * @param {boolean} live - true iff this process currently has a live handle for it
 * @returns {"running"|"stopped_after_restart"|"stopped"}
 */
export function registryEntryRuntimeState(entry, live) {
  if (live) return "running";
  if (entry && entry.wasLive === true) return "stopped_after_restart";
  return "stopped";
}

/**
 * Boot-time reconciliation over injected state + callbacks. Pure: takes
 * every fact it needs as an argument and returns a plan; it does not
 * mutate the DB, spawn/kill processes, or touch the filesystem itself.
 * The caller applies the plan (and should saveState after freeing).
 *
 *  - freedReservations: reservations whose owner pid is no longer alive
 *    AND which have no corresponding provider row (a live provider row
 *    means the runtime is still legitimately using that port even though
 *    the reserving pid is gone, e.g. after a re-exec). Freed from
 *    `state.reservations` in place.
 *  - orphanRows: provider rows that reference a modelId with no matching
 *    port reservation — the DB thinks a local runtime is registered but
 *    this CROW_HOME's state has no record of holding a port for it.
 *  - resumableDownloads: every journal entry, since presence in the
 *    journal always means "not yet completed" (a finished download is
 *    removed from the journal by the downloader, not left behind).
 */
export function reconcileOnBoot({ state, listProviderRows, isProcessAlive }) {
  const providerRows = listProviderRows() || [];
  const providerModelIds = new Set(providerRows.map((row) => row.modelId));

  const freedReservations = [];
  for (const [modelId, reservation] of Object.entries(state.reservations)) {
    const ownerAlive = isProcessAlive(reservation.owner?.pid);
    const hasProviderRow = providerModelIds.has(modelId);
    if (!ownerAlive && !hasProviderRow) {
      freedReservations.push({ modelId, ...reservation });
      delete state.reservations[modelId];
    }
  }

  const reservedModelIds = new Set(Object.keys(state.reservations));
  const orphanRows = providerRows.filter((row) => !reservedModelIds.has(row.modelId));

  const resumableDownloads = Object.entries(state.journal).map(([modelId, entry]) => ({
    modelId,
    ...entry,
  }));

  return { freedReservations, orphanRows, resumableDownloads };
}
