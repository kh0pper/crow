/**
 * The eval start guards. They import only node built-ins and the protected-path helpers, so they
 * can run before any server code (and so before anything can open a database). The research-eval
 * fixture server (fixture-guard.mjs re-exports assertEvalEnv) and the live pi driver both call
 * them first and load the server stack only after one passes.
 */
import { tmpdir } from "node:os";
import { isAbsolute, normalize, sep } from "node:path";
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
 *  - process.env: snapshotted before the transform and compared after it, with no async gap
 *    between that check and new PiRpc, which builds the spawn env from the live process.env.
 * Accepted residuals: functions in the options are shared by reference (a transform could set
 * properties on one), and the transform can see everything in the options, including secrets in
 * the MCP config and the resolved model. A future seam reusing this pattern (mcpOverrides) must
 * account for both.
 */

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

/** A shallow copy of every process.env key, taken before an eval-only transform runs. */
export function snapshotEnv() {
  return { ...process.env };
}

/** Throws unless process.env has exactly the snapshot's keys and values. */
export function checkEnvUnchanged(before) {
  const refuse = (rule) => { throw new Error(`eval spawn transform refused: ${rule}`); };
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
