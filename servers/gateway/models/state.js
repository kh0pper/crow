/**
 * Models state store + port allocator (Item G, native model runtime).
 *
 * One JSON state file per CROW_HOME (`<dir>/models/state.json`) holding four
 * independent maps plus one scalar:
 *
 *   - reservations (keyed by PROVIDER id): ephemeral port claims for a
 *     locally-spawned model runtime process (18100-18199), each with an owner
 *     {crowHome, pid} and createdAt so a later boot can tell a live claim from
 *     a stale one.
 *   - journal (keyed by model id): in-progress model downloads (url/dest/
 *     bytesDone/expectedSha/startedAt) so a killed download can resume instead
 *     of restarting.
 *   - registry (keyed `<catalogId>@<quant>` — see `registryKey`): models this
 *     CROW_HOME has actually installed (file/quant/catalogId/registeredAt/
 *     sizeMb/shardFiles/companions), independent of whether a runtime is
 *     currently running for them. The key is what lets two quants of the SAME
 *     catalog model coexist; entries written before that (Item G, keyed by the
 *     bare model id) are re-keyed on every `loadState` by
 *     `migrateRegistryKeys`, so callers resolving an entry from a provider row
 *     must go through `findRegistryEntryForProvider`/`findRegistryEntries`
 *     rather than assuming either key shape. Optional fields ride the same
 *     entry: `wasLive`/`lastStoppedAt` (Task 13 fix round 1, finding c — see
 *     `registryEntryRuntimeState` below, written by `gpu-orchestrator.js`),
 *     `source` (e.g. `"hf-browser"` — Task 13 fix round 1, finding 1, written
 *     by `manager.js`'s `registerModel` via its `registryExtra` param)
 *     distinguishing an un-vetted Browse-Hugging-Face registration from a
 *     curated one, and `path`/`adopted`/`verified` for weights adopted from
 *     disk instead of downloaded.
 *   - conversions (keyed by provider id): a snapshot of the Docker-bundle
 *     provider row a native registration replaced, so an operator can see or
 *     restore what that provider id used to be.
 *   - runtimeOverride: `null`, or `{ bin, version }` naming an operator-chosen
 *     llama-server binary that wins over the catalog's release.
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

// The base is env-overridable as a SUITE-ISOLATION knob only (2026-08-13
// flake hunt: concurrent `npm test` runs bind-probe this range with real
// sockets, and two runs colliding on a hardwired base was a reproduced
// cross-process flake). run-suite.mjs assigns each run its own window;
// production never sets the var. Co-hosted live instances deliberately
// SHARE the fixed default range — cross-instance overlap is resolved by
// the bind probe, and that design is unchanged.
const envRangeStart = Number.parseInt(process.env.CROW_MODELS_PORT_RANGE_START ?? "", 10);
export const PORT_RANGE_START =
  Number.isInteger(envRangeStart) && envRangeStart >= 1024 && envRangeStart <= 65435
    ? envRangeStart
    : 18100;
export const PORT_RANGE_END = PORT_RANGE_START + 99; // inclusive

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
  return { reservations: {}, journal: {}, registry: {}, conversions: {}, runtimeOverride: null };
}

/** Path to the state file for a given (injected) CROW_HOME/data dir. */
export function statePath(dir) {
  return join(dir, "models", "state.json");
}

/**
 * Registry keys were the model id (Item G). This arc keys them
 * `<catalogId>@<quant>` instead, so the same catalog id can carry multiple
 * quants side by side. `registryKey`/`parseRegistryKey` are the two halves
 * of that encoding — `parseRegistryKey` returns `null` for a legacy
 * (no-"@") key so callers can tell old- from new-style keys apart.
 */
export function registryKey(catalogId, quant) {
  return `${catalogId}@${quant}`;
}

export function parseRegistryKey(key) {
  const at = typeof key === "string" ? key.indexOf("@") : -1;
  if (at <= 0 || at === key.length - 1) return null;
  return { catalogId: key.slice(0, at), quant: key.slice(at + 1) };
}

/**
 * Re-key every legacy (Item G) registry entry that carries both
 * `catalogId` and `quant` to `<catalogId>@<quant>`. Entries that already
 * use the new key form, or that lack one of those two fields (e.g.
 * hf-browser rows registered before this arc), keep their existing key.
 * Pure (returns a new object) and idempotent — running it twice over its
 * own output is a no-op.
 */
export function migrateRegistryKeys(registry) {
  const out = {};
  for (const [key, entry] of Object.entries(registry || {})) {
    const legacy =
      parseRegistryKey(key) === null &&
      entry &&
      typeof entry.catalogId === "string" &&
      typeof entry.quant === "string";
    const newKey = legacy ? registryKey(entry.catalogId, entry.quant) : key;
    if (newKey in out) {
      // Two entries claim the same key (a legacy entry alongside an already
      // migrated one, most likely). First writer wins; say so rather than
      // dropping an install silently.
      console.warn(`[models/state] registry migration: dropping duplicate entry "${key}" — "${newKey}" is already taken`);
      continue;
    }
    out[newKey] = entry;
  }
  return out;
}

/**
 * Load state from `<dir>/models/state.json`. Missing file or unparsable
 * JSON both resolve to a fresh empty state rather than throwing — a
 * corrupt/absent state file must never block boot. Legacy registry keys
 * are migrated to `<catalogId>@<quant>` on every load (see
 * `migrateRegistryKeys`); the migration is idempotent, so re-loading an
 * already-migrated file is a no-op.
 */
export function loadState(dir) {
  const path = statePath(dir);
  if (!existsSync(path)) return emptyState();
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    const obj = (k) => (parsed && typeof parsed[k] === "object" && parsed[k]) || {};
    return {
      reservations: obj("reservations"),
      journal: obj("journal"),
      registry: migrateRegistryKeys(obj("registry")),
      conversions: obj("conversions"),
      runtimeOverride:
        parsed && parsed.runtimeOverride && typeof parsed.runtimeOverride === "object"
          ? parsed.runtimeOverride
          : null,
    };
  } catch {
    return emptyState();
  }
}

/**
 * Every registry entry for a given catalog id, across all its installed
 * quants — including a legacy (pre-migration, or fields-incomplete)
 * entry keyed by the bare catalog id itself.
 *
 * @returns {{key: string, entry: object}[]}
 */
export function findRegistryEntries(state, catalogId) {
  const out = [];
  for (const [key, entry] of Object.entries(state?.registry || {})) {
    const parsed = parseRegistryKey(key);
    if ((parsed && parsed.catalogId === catalogId) || (!parsed && key === catalogId)) {
      out.push({ key, entry });
    }
  }
  return out;
}

/**
 * Resolve a provider row's `gpuPolicy.{catalogId,quant}` to its registry
 * entry, or `null` if either field is missing or no entry matches.
 *
 * @returns {{key: string, entry: object} | null}
 */
export function findRegistryEntryForProvider(state, provider) {
  const gp = provider?.gpuPolicy || {};
  if (typeof gp.catalogId !== "string" || typeof gp.quant !== "string") return null;
  const key = registryKey(gp.catalogId, gp.quant);
  const entry = state?.registry?.[key];
  return entry ? { key, entry } : null;
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
 *
 * `canBind` (the probe function) defaults to the module's real bind-test
 * and can be overridden for tests. This matters because `node --test` runs
 * separate test files as concurrent processes: another file's real
 * `allocatePort` call can transiently hold 127.0.0.1:<port> in this same
 * 18100-18199 range at the exact moment this call probes it, so a test
 * asserting an *exact* returned port must stub this out to be hermetic.
 */
export async function allocatePort(
  state,
  modelId,
  { crowHome = resolveDataDir(), pid = process.pid, canBind: canBindFn = canBind } = {}
) {
  const reservedPorts = new Set(Object.values(state.reservations).map((r) => r.port));
  for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
    if (reservedPorts.has(port)) continue;
    // eslint-disable-next-line no-await-in-loop -- ports must be probed in
    // ascending order, one at a time; parallelizing would race binds.
    const free = await canBindFn(port);
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
