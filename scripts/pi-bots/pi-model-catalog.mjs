// scripts/pi-bots/pi-model-catalog.mjs
/**
 * M2 (spec §11.6): know which provider/model keys pi can use, so a bot turn
 * fails fast with a clear message instead of spawning pi into "Unknown
 * provider". Source: `pi --list-models`, run ASYNCHRONOUSLY (about 1.1 s on
 * crow, and it starts pi's MCP servers) with one shared in-flight promise.
 * Cached 5 minutes in THIS process. The gateway's M1 writes cannot
 * invalidate it; a miss re-lists once instead. A listing that fails never
 * blocks a turn.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolveNodeBin, resolvePiCli } from "./pi_resolver.mjs";

let _cache = null; // { at, keys }
let _inflight = null;
let _warned = false;

export function invalidatePiModelCache() { _cache = null; }

export function parsePiListModels(stdout) {
  const keys = new Set();
  for (const line of String(stdout || "").split("\n").slice(1)) {
    const cols = line.trim().split(/\s{2,}/);
    if (cols.length >= 2 && cols[0] && cols[1]) keys.add(`${cols[0]}/${cols[1]}`);
  }
  return keys;
}

export class PiModelUnavailableError extends Error {
  constructor(message) { super(message); this.name = "PiModelUnavailableError"; this.code = "PI_MODEL_UNAVAILABLE"; }
}

export function listPiModels({
  execFileFn = execFile, nowFn = Date.now, ttlMs = 300_000, force = false,
  resolvePiCliFn = resolvePiCli, resolveNodeBinFn = resolveNodeBin,
} = {}) {
  if (!force && _cache && nowFn() - _cache.at < ttlMs) return Promise.resolve({ ok: true, keys: _cache.keys });
  if (_inflight) return _inflight;
  _inflight = new Promise((resolveP) => {
    let cli;
    try { cli = resolvePiCliFn(); } catch (e) { return resolveP({ ok: false, error: e.message }); }
    if (!cli || !cli.cliPath) return resolveP({ ok: false, error: "pi CLI not found (pi_resolver ladder)" });
    execFileFn(resolveNodeBinFn(), [cli.cliPath, "--list-models"], { encoding: "utf8", timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return resolveP({ ok: false, error: String(stderr || err.message) });
      const keys = parsePiListModels(stdout);
      _cache = { at: nowFn(), keys };
      resolveP({ ok: true, keys });
    });
  }).finally(() => { _inflight = null; });
  return _inflight;
}

/** What pi's models.json declares, without spawning pi (the gateway's M3 marks). */
export function piModelsFileKeys({ path = process.env.PI_MODELS_JSON || `${process.env.HOME || homedir()}/.pi/agent/models.json`, readFileFn = (p) => readFileSync(p, "utf8") } = {}) {
  let j;
  try { j = JSON.parse(readFileFn(path)); } catch { return null; }
  const keys = new Set();
  for (const [pid, p] of Object.entries((j && j.providers) || {})) {
    for (const m of Array.isArray(p?.models) ? p.models : []) if (m && m.id) keys.add(`${pid}/${m.id}`);
  }
  return keys;
}

export async function checkPiModel({ provider, model }, deps = {}) {
  const key = `${provider}/${model}`;
  // Fast path, no spawn: a key pi's models.json declares (every M1 entry and
  // every hand-written one) is usable. Only a key absent from the file (a pi
  // built-in, or a genuinely unknown model) pays for `pi --list-models`.
  const fileKeys = (deps.piKeysFn || piModelsFileKeys)();
  if (fileKeys && fileKeys.has(key)) return { ok: true };
  const l = await listPiModels(deps);
  if (!l.ok) {
    if (!_warned) { _warned = true; console.warn(`[pi-model-catalog] pi --list-models failed, not validating models: ${l.error}`); }
    return { ok: true, unverified: true };
  }
  if (l.keys.has(key)) return { ok: true };
  if (!deps.force) {
    const again = await listPiModels({ ...deps, force: true });
    if (again.ok && again.keys.has(key)) return { ok: true };
  }
  return { ok: false, message: `model "${key}" is not available to the bot engine` };
}
