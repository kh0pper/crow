/**
 * The eval start guards. They import only node built-ins and the protected-path helpers, so they
 * can run before any server code (and so before anything can open a database). The research-eval
 * fixture server (fixture-guard.mjs re-exports assertEvalEnv) and the live pi driver both call
 * them first and load the server stack only after one passes.
 */
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize, sep } from "node:path";
import { isDeepStrictEqual, types } from "node:util";
import { protectedHit, protectedRoots, realish, realUserCrowDir, within } from "./protected-paths.mjs";

const strictlyInside = (p, root) => p !== root && within(p, root);

/**
 * Refuse unless the env is clearly a research-eval scratch instance. Throws an Error naming the
 * failed rule; returns nothing when every rule holds.
 * @param {Record<string, string|undefined>} [env]
 * @param {string} [tmp] the temp root a scratch CROW_HOME must sit strictly below
 */
export function assertEvalEnv(env = process.env, tmp = tmpdir()) {
  const e = env || {};
  const refuse = (rule) => { throw new Error(`research-eval fixture server refused: ${rule}`); };

  if (e.CROW_RESEARCH_EVAL !== "1") refuse('CROW_RESEARCH_EVAL must be "1"');

  if (typeof e.CROW_HOME !== "string" || !e.CROW_HOME) refuse("CROW_HOME must be set");
  const home = realish(e.CROW_HOME);
  if (!strictlyInside(home, realish(tmp))) refuse("CROW_HOME must be strictly below the temp dir");

  // The protected roots of both the given env and this process (the suite passes its roots here).
  const roots = [...new Set([...protectedRoots(e), ...protectedRoots(process.env)])];
  if (protectedHit(home, roots)) refuse("CROW_HOME overlaps a protected instance directory");
  const userCrow = realish(realUserCrowDir());
  if (within(home, userCrow) || within(userCrow, home)) refuse("CROW_HOME overlaps the real user's crow dir");

  if (e.CROW_ACTOR_KIND !== "bot") refuse('CROW_ACTOR_KIND must be "bot"');
  if (typeof e.CROW_ACTOR_BOT_ID !== "string" || !e.CROW_ACTOR_BOT_ID) refuse("CROW_ACTOR_BOT_ID must be set");

  if (typeof e.CROW_DB_PATH !== "string" || !e.CROW_DB_PATH) refuse("CROW_DB_PATH must be set");
  if (!strictlyInside(realish(e.CROW_DB_PATH), home)) refuse("CROW_DB_PATH must be strictly inside CROW_HOME");
  if (e.CROW_RESEARCH_EVAL_FETCH_LOG !== undefined && !strictlyInside(realish(String(e.CROW_RESEARCH_EVAL_FETCH_LOG)), home)) {
    refuse("CROW_RESEARCH_EVAL_FETCH_LOG must be strictly inside CROW_HOME");
  }
}

/**
 * The one guard every eval-only seam in shared prod code calls. Takes NO argument: it checks the
 * REAL process.env, so a caller cannot hand it a forged env. Throws "eval-only seam refused: <rule>".
 * Returns the realpath'd CROW_HOME it verified: a seam seals it at guard time and never re-reads
 * env afterwards (code that runs later, such as a transform, could have changed it).
 */
export function assertEvalSeam() {
  try {
    assertEvalEnv(process.env);
  } catch (err) {
    const rule = String(err && err.message).replace(/^research-eval fixture server refused: /, "");
    throw new Error(`eval-only seam refused: ${rule}`);
  }
  return realish(process.env.CROW_HOME);
}

/*
 * The eval-only spawn transform (bridge.mjs handleInbound, opts.evalSpawnTransform). The
 * transform is TRUSTED in-process code: what follows is a shape fence against mistakes, not a
 * sandbox (in-process code can always read files or patch module state). What is checked:
 *  - the PiRpc options: the transform works on a deep clone and the bridge takes back ONE value,
 *    appendSystemPromptFile (an absolute, normalized path strictly inside the home sealed at
 *    guard time); every other key must be unchanged in key set and value, and the spawn is built
 *    from the bridge's own untouched original;
 *  - process.env: its identity (never replaced, never a Proxy) and every key, snapshotted before
 *    the transform and compared after it, with no async gap
 *    between that check and new PiRpc, which builds the spawn env from the live process.env.
 * Accepted residuals: functions in the options are shared by reference (a transform could set
 * properties on one), and the transform can see everything in the options, including secrets in
 * the MCP config and the resolved model. A future seam reusing this pattern (mcpOverrides) must
 * account for both.
 */

/**
 * The eval MCP override seam (bridge.mjs handleInbound, opts.mcpOverrides). One reviewed table:
 * the ONLY server block an eval may replace, the ONLY command/args it may name, and the ONLY env
 * keys it may add, each with the rule its value must satisfy. A caller names values; it can never
 * name a different program, a different env key, or a path outside the home assertEvalSeam sealed.
 */
export const FIXTURE_SERVER = join(import.meta.dirname, "..", "research-eval", "fixture-server.mjs");
/** The fixture server writes this file (pid, case id, run id) into CROW_HOME when it starts. */
export const FIXTURE_START_MARKER = "fixture-start.json";
export const EVAL_MCP_OVERRIDES = Object.freeze({
  "crow-projects": Object.freeze({
    args: Object.freeze([FIXTURE_SERVER]),
    // key -> rule: "1" exact | "sealed" (realish === sealedHome) | "path" (absolute, normalized,
    // strictly inside realish(sealedHome)) | "tmpdir" (realish === realish(tmpdir()))
    env: Object.freeze({ CROW_RESEARCH_EVAL: "1", CROW_HOME: "sealed", CROW_RESEARCH_EVAL_CASE: "path",
      CROW_RESEARCH_EVAL_FETCH_LOG: "path", TMPDIR: "tmpdir" }),
    requiredEnv: Object.freeze(["CROW_RESEARCH_EVAL", "CROW_HOME", "CROW_RESEARCH_EVAL_CASE", "CROW_RESEARCH_EVAL_FETCH_LOG"]),
  }),
});

const MCP_OVERRIDE_KEYS = Object.freeze(["command", "args", "env"]);
const sealedOf = (sealedHome, refuse) => {
  if (typeof sealedHome !== "string" || !isAbsolute(sealedHome)) refuse("no sealed home (pass assertEvalSeam()'s result)");
  return realish(sealedHome);
};

/**
 * The value rules of EVAL_MCP_OVERRIDES, applied to one env value. `path` needs realish on both
 * sides (a symlinked scratch dir would otherwise pass a string test and point elsewhere).
 */
function checkEnvValue(rule, v, { home, tmp, name, key, refuse }) {
  if (typeof v !== "string") refuse(`override ${name} env ${key} must be a string`);
  if (rule === "1" && v !== "1") refuse(`override ${name} env ${key} must be "1"`);
  if (rule === "sealed" && realish(v) !== home) refuse(`override ${name} env ${key} must be the sealed home`);
  if (rule === "tmpdir" && realish(v) !== tmp) refuse(`override ${name} env ${key} must be the temp dir`);
  if (rule === "path") {
    if (!isAbsolute(v) || v !== normalize(v) || v.split(sep).includes("..")) refuse(`override ${name} env ${key} must be an absolute, normalized path`);
    if (!strictlyInside(realish(v), home)) refuse(`override ${name} env ${key} must be strictly inside the sealed home`);
  }
}

/**
 * Validates a caller's opts.mcpOverrides against EVAL_MCP_OVERRIDES and returns a frozen plain
 * copy (so the bridge reads the option once, not on every later use). Takes no env and reads
 * none, so a forged env inside the options cannot widen anything. Throws "eval mcp override
 * refused: <rule>".
 * @param {unknown} overrides
 * @param {string} sealedHome assertEvalSeam()'s return value
 */
export function checkMcpOverrides(overrides, sealedHome) {
  const refuse = (rule) => { throw new Error(`eval mcp override refused: ${rule}`); };
  const home = sealedOf(sealedHome, refuse);
  const tmp = realish(tmpdir());
  if (types.isProxy(overrides)) refuse("the overrides must not be a Proxy");
  if (!isPlain(overrides)) refuse("the overrides must be a plain object");
  const names = Reflect.ownKeys(overrides);
  if (names.length !== 1) refuse(`exactly one server override is allowed (got ${names.length})`);
  const name = names[0];
  if (typeof name !== "string" || !Object.hasOwn(EVAL_MCP_OVERRIDES, name)) refuse(`server ${String(name)} may not be overridden`);
  const spec = EVAL_MCP_OVERRIDES[name];
  const entry = overrides[name];
  if (types.isProxy(entry)) refuse(`override ${name} must not be a Proxy`);
  if (!isPlain(entry)) refuse(`override ${name} must be a plain object`);
  for (const k of Reflect.ownKeys(entry)) if (!MCP_OVERRIDE_KEYS.includes(k)) refuse(`override ${name} has an unknown key ${String(k)}`);
  if (typeof entry.command !== "string") refuse(`override ${name} command must be a string`);
  if (entry.command !== process.execPath) refuse(`override ${name} command must be this node (${process.execPath})`);
  if (types.isProxy(entry.args) || !Array.isArray(entry.args)) refuse(`override ${name} args must be an array`);
  if (!isDeepStrictEqual([...entry.args], [...spec.args])) refuse(`override ${name} args must be exactly the fixture server`);
  if (types.isProxy(entry.env) || !isPlain(entry.env)) refuse(`override ${name} env must be a plain object`);
  const env = {};
  for (const k of Reflect.ownKeys(entry.env)) {
    if (typeof k !== "string" || !Object.hasOwn(spec.env, k)) refuse(`override ${name} env key ${String(k)} is not allowed`);
    const v = entry.env[k];
    if (typeof v !== "string") refuse(`override ${name} env ${k} must be a string`);
    env[k] = v;
  }
  for (const k of spec.requiredEnv) if (!Object.hasOwn(env, k)) refuse(`override ${name} env is missing ${k}`);
  for (const [k, rule] of Object.entries(spec.env)) if (Object.hasOwn(env, k)) checkEnvValue(rule, env[k], { home, tmp, name, key: k, refuse });
  return Object.freeze({ [name]: Object.freeze({ command: entry.command, args: Object.freeze([...spec.args]), env: Object.freeze(env) }) });
}

/**
 * Returns a NEW mcp config with exactly the named block's command/args replaced and the checked
 * env keys merged on top of its env. Every other block, and every other key of that block, is
 * deep-equal to the input (asserted by comparing all blocks). The input is never mutated.
 * Refused: a null config with no mcpServers, a missing/url/disabled target, a target whose
 * CROW_DB_PATH is not strictly inside the sealed home, a target carrying the search key, and any
 * result that changed a block count other than one.
 * @returns {{config: object, changed: string[]}}
 */
export function applyMcpOverrides(mcpConfig, checked, sealedHome) {
  const refuse = (rule) => { throw new Error(`eval mcp override refused: ${rule}`); };
  const home = sealedOf(sealedHome, refuse);
  if (mcpConfig === null || mcpConfig === undefined) refuse("the mcp config is missing");
  if (typeof mcpConfig !== "object" || Array.isArray(mcpConfig) || types.isProxy(mcpConfig)) refuse("the mcp config must be a plain object");
  const servers = mcpConfig.mcpServers;
  if (servers === null || typeof servers !== "object" || Array.isArray(servers) || types.isProxy(servers)) refuse("the mcp config has no mcpServers object");
  const names = Object.keys(checked || {});
  if (names.length !== 1) refuse("exactly one override is applied at a time");
  const name = names[0];
  const block = servers[name];
  if (block === null || typeof block !== "object" || Array.isArray(block) || types.isProxy(block)) refuse(`block ${name} is missing`);
  if (block.url !== undefined) refuse(`block ${name} is a url block`);
  if (block.disabled) refuse(`block ${name} is disabled`);
  const dbPath = block.env && block.env.CROW_DB_PATH;
  if (typeof dbPath !== "string" || !strictlyInside(realish(dbPath), home)) refuse(`block ${name} CROW_DB_PATH is not strictly inside CROW_HOME`);
  if (block.env && Object.hasOwn(block.env, "BRAVE_API_KEY")) refuse(`block ${name} carries BRAVE_API_KEY`);
  const next = cloneSpawnOpts(servers);
  const entry = checked[name];
  next[name] = { ...next[name], command: entry.command, args: [...entry.args], env: { ...(next[name].env || {}), ...entry.env } };
  // One block, and only the target: a second changed block means the override did more than it says.
  const changed = Object.keys(next).filter((k) => !isDeepStrictEqual(next[k], servers[k]));
  if (changed.length !== 1 || changed[0] !== name) refuse(`exactly one block must change (changed: ${changed.join(", ") || "none"})`);
  return { config: { ...cloneSpawnOpts(mcpConfig), mcpServers: next }, changed: [name] };
}

/**
 * The one path an overridden config may be written to (file delivery): absolute, normalized,
 * strictly inside the home sealed at guard time. Refused otherwise.
 */
export function checkOverridePath(p, sealedHome) {
  const refuse = (rule) => { throw new Error(`eval mcp override refused: ${rule}`); };
  const home = sealedOf(sealedHome, refuse);
  if (typeof p !== "string" || !isAbsolute(p) || p !== normalize(p) || p.split(sep).includes("..")) refuse("the config path must be an absolute, normalized path");
  if (!strictlyInside(realish(p), home)) refuse("the config path must be strictly inside CROW_HOME");
  return p;
}

const SPAWN_FILE_KEY = "appendSystemPromptFile";
const isPlain = (o) => o !== null && typeof o === "object" && !Array.isArray(o) && [Object.prototype, null].includes(Object.getPrototypeOf(o));

/**
 * A deep copy of a spawn's PiRpc options for an eval-only transform to work on: plain objects
 * and arrays copied (own string and symbol keys, data values only), functions and primitives by
 * reference, anything else through structuredClone. The bridge keeps the original untouched and
 * never uses the transform's object (checkEvalSpawnOpts).
 */
export function cloneSpawnOpts(value) {
  if (value === null || typeof value !== "object") return value; // primitives and functions
  if (Array.isArray(value)) return value.map((v) => cloneSpawnOpts(v));
  if (isPlain(value)) {
    const out = Object.getPrototypeOf(value) === null ? Object.create(null) : {};
    for (const k of Reflect.ownKeys(value)) {
      const d = Object.getOwnPropertyDescriptor(value, k);
      // defineProperty, never assignment: an own "__proto__" key must stay a key.
      if (d && d.enumerable && "value" in d) Object.defineProperty(out, k, { value: cloneSpawnOpts(d.value), enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  // A class instance loses its prototype here, so the check refuses it even unchanged and names
  // that case (nonPlainNote). Built-ins structuredClone keeps exactly (a Map, a Date) still pass.
  return structuredClone(value);
}

/** True when `v` holds a value cloneSpawnOpts cannot copy faithfully (not plain data or a function). */
function holdsNonPlain(v, seen = new Set()) {
  if (v === null || typeof v !== "object") return false;
  if (seen.has(v)) return false;
  seen.add(v);
  if (Array.isArray(v)) return v.some((x) => holdsNonPlain(x, seen));
  if (!isPlain(v)) return true;
  return Reflect.ownKeys(v).some((k) => holdsNonPlain(v[k], seen));
}
const nonPlainNote = (v) => (holdsNonPlain(v) ? " (it holds a non-plain value, such as a class instance, that the clone may not keep: refused even when unchanged)" : "");

/**
 * Taken before an eval-only transform runs: the process.env object itself (its identity: in
 * Node, process.env is assignable) and a shallow copy of every key.
 */
export function snapshotEnv() {
  return { ref: process.env, values: { ...process.env } };
}

/**
 * Throws unless process.env is still the very same, non-Proxy object (a reassigned or proxied env
 * could show the snapshot one view and the spawn another), with exactly the snapshot's keys and
 * values.
 */
export function checkEnvUnchanged(snapshot) {
  const refuse = (rule) => { throw new Error(`eval spawn transform refused: ${rule}`); };
  if (process.env !== snapshot.ref) refuse("process.env was replaced");
  if (types.isProxy(process.env)) refuse("process.env is a Proxy");
  const before = snapshot.values;
  const now = { ...process.env };
  for (const k of Object.keys(before)) {
    if (!Object.hasOwn(now, k)) refuse(`process.env.${k} was removed`);
    if (now[k] !== before[k]) refuse(`process.env.${k} was changed`);
  }
  for (const k of Object.keys(now)) if (!Object.hasOwn(before, k)) refuse(`process.env.${k} was added`);
}

/** The spawn options: the original, plus appendSystemPromptFile only when there is one. */
export function evalSpawnOpts(original, f) {
  return f === undefined ? Object.assign({}, original) : Object.assign({}, original, { [SPAWN_FILE_KEY]: f });
}

/**
 * The check on an eval-only spawn transform's result (bridge.mjs handleInbound,
 * opts.evalSpawnTransform): returns the ONE value the bridge takes from it, the
 * appendSystemPromptFile path, read once from a data descriptor. Refused ("eval spawn transform
 * refused: <rule>") unless `next` is a plain, non-Proxy object whose own keys (Reflect.ownKeys,
 * symbols included) are the clone's, plus appendSystemPromptFile at most, every other key a data
 * property deep-equal to the ORIGINAL's (so a transform that mutated its clone is caught), and a
 * changed path is an absolute, normalized string strictly inside `sealedHome` (the home
 * assertEvalSeam verified; env is never re-read here). The bridge then builds the spawn options
 * from the original, never from `next`. A shape fence, not a sandbox (see above).
 * @param {object} original the PiRpc options the bridge built (never handed to the transform)
 * @param {object} clone cloneSpawnOpts(original), what the transform received
 * @param {unknown} next the transform's result
 * @param {string} sealedHome assertEvalSeam()'s return value
 * @returns {string|undefined} the appendSystemPromptFile to spawn with
 */
export function checkEvalSpawnOpts(original, clone, next, sealedHome) {
  const refuse = (rule) => { throw new Error(`eval spawn transform refused: ${rule}`); };
  if (typeof sealedHome !== "string" || !isAbsolute(sealedHome)) refuse("no sealed home (pass assertEvalSeam()'s result)");
  if (types.isProxy(next)) refuse("the result must not be a Proxy");
  if (!isPlain(next)) refuse("the result must be a plain object");
  const want = new Set(Reflect.ownKeys(clone));
  const got = Reflect.ownKeys(next);
  for (const k of want) if (!got.includes(k)) refuse(`key ${String(k)} was removed`);
  for (const k of got) {
    if (k === SPAWN_FILE_KEY) continue;
    if (!want.has(k)) refuse(`key ${String(k)} was added`);
    const d = Object.getOwnPropertyDescriptor(next, k);
    if (!d || !("value" in d)) refuse(`key ${String(k)} must be a data property`);
    if (!isDeepStrictEqual(d.value, original[k])) refuse(`key ${String(k)} was changed${nonPlainNote(original[k])}`);
  }
  const d = Object.getOwnPropertyDescriptor(next, SPAWN_FILE_KEY);
  if (!d) return original[SPAWN_FILE_KEY];
  if (!("value" in d) || typeof d.value !== "string") refuse(`${SPAWN_FILE_KEY} must be a string data property`);
  const f = d.value; // read once
  if (f === original[SPAWN_FILE_KEY]) return f;
  // pi resolves a relative path against its own cwd, not ours: absolute and normalized only.
  if (!isAbsolute(f) || f !== normalize(f) || f.split(sep).includes("..")) refuse(`${SPAWN_FILE_KEY} must be an absolute, normalized path`);
  if (!strictlyInside(realish(f), sealedHome)) refuse(`${SPAWN_FILE_KEY} must be a path strictly inside CROW_HOME`);
  return f;
}
