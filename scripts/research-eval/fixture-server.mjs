#!/usr/bin/env node
/**
 * The research-eval fixture research server (stdio). It serves the real crow-projects research
 * tools for one case, with the case's canned pages and search results in place of the network.
 * It mirrors servers/research/index.js and adds only the start guard, the case load and the
 * fixture seams.
 *
 * It is never registered (scripts/server-registry.js, .mcp.json) and nothing outside the eval
 * starts it: a test asserts both. The eval harness starts it inside a scratch instance.
 *
 * Why the server stack is imported only after the guard: loading db.js or server.js is the
 * first step toward opening a database. The static imports here are node built-ins and the
 * guard alone (a test checks), so a refused start has loaded no server code and touched no DB.
 *
 * Env (the guard checks the first six; see fixture-guard.mjs):
 *   CROW_RESEARCH_EVAL=1, CROW_HOME (strictly below the temp dir), CROW_DB_PATH and
 *   CROW_RESEARCH_EVAL_FETCH_LOG (strictly inside CROW_HOME), CROW_ACTOR_KIND=bot,
 *   CROW_ACTOR_BOT_ID; CROW_RESEARCH_EVAL_CASE (the case JSON path).
 */
import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertEvalEnv } from "./fixture-guard.mjs";

async function main(env) {
  assertEvalEnv(env);
  if (!env.CROW_RESEARCH_EVAL_FETCH_LOG) throw new Error("research-eval fixture server refused: CROW_RESEARCH_EVAL_FETCH_LOG must be set");
  if (!env.CROW_RESEARCH_EVAL_CASE) throw new Error("research-eval fixture server refused: CROW_RESEARCH_EVAL_CASE must be set");
  const caseDef = JSON.parse(readFileSync(env.CROW_RESEARCH_EVAL_CASE, "utf8"));
  const fetchLogPath = env.CROW_RESEARCH_EVAL_FETCH_LOG;
  const dbPath = env.CROW_DB_PATH;

  // The guard has passed: now the server stack may load.
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { createDbClient, verifyDb } = await import("../../servers/db.js");
  const { generateInstructions } = await import("../../servers/shared/instructions.js");
  const { actorFromEnv } = await import("../../servers/research/actor.js");
  const { createFixtureServer } = await import("./fixture-world.mjs");

  await verifyDb(createDbClient(dbPath));
  const instructions = await generateInstructions({ dbPath, deviceId: env.CROW_DEVICE_ID });
  const server = createFixtureServer(dbPath, caseDef, {
    actor: actorFromEnv(env),
    instructions,
    onFetch: (entry) => appendFileSync(fetchLogPath, JSON.stringify(entry) + "\n"),
  });
  await server.connect(new StdioServerTransport());
}

const isMain = (() => {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();

if (isMain) {
  try {
    await main(process.env);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}
