/**
 * The eval start guards. They import only node built-ins and the protected-path helpers, so they
 * can run before any server code (and so before anything can open a database). The research-eval
 * fixture server (fixture-guard.mjs re-exports assertEvalEnv) and the live pi driver both call
 * them first and load the server stack only after one passes.
 */
import { tmpdir } from "node:os";
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
 */
export function assertEvalSeam() {
  try {
    assertEvalEnv(process.env);
  } catch (err) {
    const rule = String(err && err.message).replace(/^research-eval fixture server refused: /, "");
    throw new Error(`eval-only seam refused: ${rule}`);
  }
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
      if (d && d.enumerable && "value" in d) out[k] = cloneSpawnOpts(d.value);
    }
    return out;
  }
  return structuredClone(value);
}

/**
 * The check on an eval-only spawn transform's result (bridge.mjs handleInbound,
 * opts.evalSpawnTransform): returns the ONE value the bridge takes from it, the
 * appendSystemPromptFile path, read once from a data descriptor. Refused ("eval spawn transform
 * refused: <rule>") unless `next` is a plain, non-Proxy object whose own keys (Reflect.ownKeys,
 * symbols included) are the clone's, plus appendSystemPromptFile at most, every other key a data
 * property deep-equal to the ORIGINAL's (so a transform that mutated its clone is caught), and a
 * changed path is a string strictly inside the REAL process.env.CROW_HOME. The bridge then
 * builds the spawn options from the original, never from `next`.
 * @param {object} original the PiRpc options the bridge built (never handed to the transform)
 * @param {object} clone cloneSpawnOpts(original), what the transform received
 * @param {unknown} next the transform's result
 * @returns {string|undefined} the appendSystemPromptFile to spawn with
 */
export function checkEvalSpawnOpts(original, clone, next) {
  const refuse = (rule) => { throw new Error(`eval spawn transform refused: ${rule}`); };
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
    if (!isDeepStrictEqual(d.value, original[k])) refuse(`key ${String(k)} was changed`);
  }
  const d = Object.getOwnPropertyDescriptor(next, SPAWN_FILE_KEY);
  if (!d) return original[SPAWN_FILE_KEY];
  if (!("value" in d) || typeof d.value !== "string") refuse(`${SPAWN_FILE_KEY} must be a string data property`);
  const f = d.value; // read once
  if (f === original[SPAWN_FILE_KEY]) return f;
  const home = process.env.CROW_HOME;
  if (typeof home !== "string" || !home) refuse("CROW_HOME is not set");
  if (!f || !strictlyInside(realish(f), realish(home))) refuse(`${SPAWN_FILE_KEY} must be a path strictly inside CROW_HOME`);
  return f;
}
