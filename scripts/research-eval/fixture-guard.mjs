/**
 * The research-eval fixture server's start guard. It imports only node built-ins and the
 * protected-path helpers, so it can run before any server code (and so before anything can
 * open a database). fixture-server.mjs calls it first and loads the server stack only after it
 * passes.
 */
import { tmpdir } from "node:os";
import { protectedHit, protectedRoots, realish, realUserCrowDir, within } from "../lib/protected-paths.mjs";

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
