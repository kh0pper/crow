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
 *
 * Per-model overrides (Strix Halo runtime profile spec §2.3, D4) live in
 * `state.runtimeOverrides[catalogId]` with the same record shape and the
 * same `validateBinary`. The orchestrator resolves per-model -> host ->
 * catalog release. Unlike the host override there is no env bootstrap.
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
 * Find the `version:` line anywhere in `--version` output (it can land on
 * either stdout or stderr, and may not be the first line — e.g. a blank
 * leading line when stdout was empty and stderr carried the text).
 *
 * Two llama-server version formats are recognized:
 *   - stock release tarballs: `"version: 10068 (abc1234)"` -> `"b10068"`
 *   - modern/dev builds: `"version: 0.2.0-dev (build 405, commit b21e4de74)"`
 *     -> `"0.2.0-dev (build 405, commit b21e4de74)"` (returned verbatim,
 *     since there's no single build-number token to compress it to)
 *
 * With no recognizable `version:` line, falls back to the first non-blank
 * line, trimmed (or `""` if the output is empty/all-blank).
 */
export function parseLlamaServerVersion(output) {
  const lines = String(output || "").split("\n").map((l) => l.trim()).filter(Boolean);
  const versionLine = lines.find((l) => /^version:/i.test(l));
  if (versionLine) {
    const legacy = versionLine.match(/^version:\s*(\d+)\s*\(/i);
    if (legacy) return `b${legacy[1]}`;
    return versionLine.replace(/^version:\s*/i, "").trim();
  }
  return lines[0] || "";
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

// ---------------------------------------------------------------------------
// Per-model overrides (Strix Halo runtime profile spec §2.3, D4)
// ---------------------------------------------------------------------------

// A catalog id ("qwen3.6-35b-a3b") or a provider name ("crow-chat"). The
// leading [A-Za-z0-9] keeps "__proto__"-style keys out of the map.
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;

function assertModelId(catalogId) {
  if (typeof catalogId !== "string" || !MODEL_ID_RE.test(catalogId)) {
    throw new RuntimeOverrideError(
      `a per-model runtime override needs a model id (catalog id or provider name), got ${JSON.stringify(catalogId)}`,
      "BAD_MODEL_ID",
    );
  }
}

function overridesOf(state) {
  const m = state && state.runtimeOverrides;
  return m && typeof m === "object" && !Array.isArray(m) ? m : {};
}

/** The stored per-model override for `catalogId` (source: "state"), or null. Never bootstraps. */
export function getModelRuntimeOverride(dir, catalogId, { loadStateFn = loadState } = {}) {
  if (typeof catalogId !== "string" || !catalogId) return null;
  const map = overridesOf(loadStateFn(dir));
  if (!Object.hasOwn(map, catalogId)) return null;
  const rec = map[catalogId];
  return rec && typeof rec.bin === "string" ? { ...rec, source: "state" } : null;
}

/**
 * Validate `bin` exactly like the host override, then persist
 * `{ bin, label, version, setAt }` under `state.runtimeOverrides[catalogId]`.
 * Throws RuntimeOverrideError (BAD_MODEL_ID / NOT_ABSOLUTE / NOT_EXECUTABLE /
 * VERSION_FAILED) — nothing is persisted in that case. `opts.label` is the
 * optional human label.
 */
export function setModelRuntimeOverride(dir, catalogId, bin, opts = {}) {
  assertModelId(catalogId);
  const { label = null, loadStateFn = loadState, saveStateFn = saveState, now = () => new Date() } = opts;
  const version = validateBinary(bin, opts);
  const record = { bin, label, version, setAt: now().toISOString() };
  const state = loadStateFn(dir);
  state.runtimeOverrides = { ...overridesOf(state), [catalogId]: record };
  saveStateFn(dir, state);
  return record;
}

/** Remove the per-model override for `catalogId`. Returns true iff one was set. */
export function clearModelRuntimeOverride(dir, catalogId, { loadStateFn = loadState, saveStateFn = saveState } = {}) {
  if (typeof catalogId !== "string" || !catalogId) return false;
  const state = loadStateFn(dir);
  const map = { ...overridesOf(state) };
  if (!Object.hasOwn(map, catalogId)) return false;
  delete map[catalogId];
  state.runtimeOverrides = map;
  saveStateFn(dir, state);
  return true;
}

/** A copy of every stored per-model override, keyed by model id. */
export function listModelRuntimeOverrides(dir, { loadStateFn = loadState } = {}) {
  return { ...overridesOf(loadStateFn(dir)) };
}
