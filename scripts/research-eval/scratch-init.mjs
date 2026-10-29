#!/usr/bin/env node
/**
 * Child entry for scratch.mjs: builds one scratch instance's crow.db. Started with the scratch
 * env (scratchEnv) as its own environment, it refuses anything that is not a research-eval
 * scratch (assertEvalEnv), runs init-db, brings the research tables to the provenance and
 * note-withdrawal shape (the same rail the research server runs at construction), and creates
 * the one research project. All of it happens in this one process.
 *
 *   node scripts/research-eval/scratch-init.mjs <result.json>
 *
 * The result ({"projectId": <n>}) goes to the file named by the argument, never to stdout:
 * init-db logs to stdout.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { assertEvalEnv } from "./fixture-guard.mjs";
import { realish, within } from "../lib/protected-paths.mjs";

const env = process.env;
try {
  assertEvalEnv(env);
  const resultPath = process.argv[2];
  if (!resultPath) throw new Error("usage: scratch-init.mjs <result.json>");
  const home = realish(env.CROW_HOME);
  const out = realish(resultPath);
  if (out === home || !within(out, home)) throw new Error("the result file must be inside CROW_HOME");
  if (!env.CROW_DATA_DIR || !within(realish(env.CROW_DATA_DIR), home)) throw new Error("CROW_DATA_DIR must be inside CROW_HOME");
  mkdirSync(env.CROW_DATA_DIR, { recursive: true });

  // The guard has passed: the DB stack may load. init-db builds the DB from this env on import.
  await import("../init-db.js");
  const { ensureProvenanceSchema, ensureWithdrawalSchema } = await import("../../servers/research/ensure-schema.js");
  for (const [name, ensure] of [["provenance", ensureProvenanceSchema], ["note withdrawal", ensureWithdrawalSchema]]) {
    const r = ensure(env.CROW_DB_PATH);
    if (!r.ready) throw new Error(`the ${name} schema is not ready (${r.state}: ${r.reason})`);
  }
  const { createDbClient } = await import("../../servers/db.js");
  const { createProjectSpace } = await import("../../servers/shared/project-spaces.js");
  const db = createDbClient(env.CROW_DB_PATH);
  let projectId;
  try {
    ({ id: projectId } = await createProjectSpace(db, { name: "research eval", type: "research" }));
  } finally {
    db.close();
  }
  writeFileSync(resultPath, JSON.stringify({ projectId }) + "\n");
  process.exit(0);
} catch (err) {
  console.error(`research-eval scratch-init: ${err.message}`);
  process.exit(1);
}
