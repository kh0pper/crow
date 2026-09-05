/**
 * Host-local llama-server runtime override (Task 6, models-core launch
 * roles arc).
 *
 * Lets an operator point Crow's native model runtime at a llama-server
 * binary other than the built-in one (e.g. a ROCm build, or a build with
 * extra ops) — persisted in `state.runtimeOverride` (see
 * `servers/gateway/models/state.js`) so it survives a gateway restart.
 *
 * `setRuntimeOverride` validates the binary before ever persisting it:
 *   1. the path must be absolute (a relative path would resolve
 *      differently depending on the spawning process's cwd);
 *   2. it must be marked executable for this process (X_OK);
 *   3. `<bin> --version` must actually run and exit 0.
 *
 * Controller ruling (2026-09-05): llama-server prints its version line
 * (`version: 10068 (abc1234)`) on STDERR, and `execFileSync` returns only
 * stdout on success (and throws on non-zero exit), which can't observe
 * stderr on the success path. `spawnSync` returns both streams
 * unconditionally regardless of exit code, so validation uses a
 * `spawnSyncImpl` seam (default `spawnSync`) instead of the brief's
 * original `execFileSyncImpl` seam.
 *
 * `getRuntimeOverride` bootstraps a first-boot override from
 * `env.CROW_LLAMA_SERVER_BIN` exactly once: if state has no stored record
 * and the env var is set, it validates + persists that binary and returns
 * it (source: "env"); a stored record always wins over the env var once
 * one exists (source: "state"). A bootstrap that fails validation is
 * swallowed — an operator's stale/wrong env var must never crash boot.
 */

import { accessSync, constants } from "node:fs";
import { spawnSync } from "node:child_process";
import { isAbsolute } from "node:path";
import { loadState, saveState } from "./state.js";

export class RuntimeOverrideError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "RuntimeOverrideError";
    this.code = code;
    Object.assign(this, details);
  }
}

/**
 * `"version: 10068 (abc1234)\nbuilt with cc\n"` -> `"b10068"`.
 * Unrecognized output falls back to its first line, trimmed.
 */
export function parseLlamaServerVersion(output) {
  const text = String(output || "");
  const m = text.match(/version:\s*(\d+)/i);
  if (m) return `b${m[1]}`;
  return (text.split("\n")[0] || "").trim();
}

function validateBinary(bin, { accessSyncImpl = accessSync, spawnSyncImpl = spawnSync } = {}) {
  if (typeof bin !== "string" || !isAbsolute(bin)) {
    throw new RuntimeOverrideError(`runtime override must be an absolute path, got ${JSON.stringify(bin)}`, "NOT_ABSOLUTE");
  }
  try {
    accessSyncImpl(bin, constants.X_OK);
  } catch (err) {
    throw new RuntimeOverrideError(`${bin} is not an executable file (${err.message})`, "NOT_EXECUTABLE", { bin });
  }
  const result = spawnSyncImpl(bin, ["--version"], {
    timeout: 10_000,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    const reason = result.error ? result.error.message : `exit ${result.status}`;
    throw new RuntimeOverrideError(`${bin} --version failed: ${reason}`, "VERSION_FAILED", { bin });
  }
  return parseLlamaServerVersion(`${String(result.stdout || "")}\n${String(result.stderr || "")}`);
}

/**
 * Validate `bin` (absolute, executable, `--version` succeeds), then
 * persist `{ bin, label, version, setAt }` to `state.runtimeOverride` and
 * return that record. Throws `RuntimeOverrideError` on any validation
 * failure — nothing is persisted in that case.
 */
export function setRuntimeOverride(dir, { bin, label = null }, opts = {}) {
  const { loadStateFn = loadState, saveStateFn = saveState, now = () => new Date() } = opts;
  const version = validateBinary(bin, opts);
  const record = { bin, label, version, setAt: now().toISOString() };
  const state = loadStateFn(dir);
  state.runtimeOverride = record;
  saveStateFn(dir, state);
  return record;
}

/** Remove the stored override, if any. Returns true iff one was set. */
export function clearRuntimeOverride(dir, { loadStateFn = loadState, saveStateFn = saveState } = {}) {
  const state = loadStateFn(dir);
  const had = !!state.runtimeOverride;
  state.runtimeOverride = null;
  saveStateFn(dir, state);
  return had;
}

/**
 * Resolve the effective runtime override, or `null` if none is set.
 * A stored record (source: "state") always wins; otherwise this bootstraps
 * from `env.CROW_LLAMA_SERVER_BIN` once (persisting it, source: "env") —
 * silently ignoring a bootstrap value that fails validation.
 */
export function getRuntimeOverride(dir, opts = {}) {
  const { env = process.env, loadStateFn = loadState } = opts;
  const stored = loadStateFn(dir).runtimeOverride;
  if (stored && typeof stored.bin === "string") return { ...stored, source: "state" };
  const envBin = env.CROW_LLAMA_SERVER_BIN;
  if (!envBin) return null;
  try {
    return { ...setRuntimeOverride(dir, { bin: envBin, label: "CROW_LLAMA_SERVER_BIN" }, opts), source: "env" };
  } catch {
    return null; // an invalid env bootstrap is ignored, never fatal at boot
  }
}
