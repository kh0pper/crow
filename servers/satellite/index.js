#!/usr/bin/env node
/**
 * Satellite Crow agent entry (SAT-3, spec §6.1). Started with CROW_PROFILE=satellite and
 * CROW_HOME=$SAT_HOME. Start guards first (exit 78, one plain line), then satellite.db, the
 * satellite key and the listener. Once listening, an unpaired agent prints a pairing code on the
 * console (never argv, never any other log); the last boot line is `listening on <host>:<port>`.
 */
import { bootGuardMessage, GUARD_EXIT_CODE } from "./guards.js";
import { resolveSatHome, resolveBind, startAgent } from "./agent.js";
import { pairCodeLines } from "./pairing.js";

process.umask(0o077);

let bind;
try {
  bind = resolveBind(process.env);
} catch (err) {
  console.error(`refusing to start: ${err.message}`);
  process.exit(GUARD_EXIT_CODE);
}
const satHome = resolveSatHome(process.env);
const refusal = bootGuardMessage({ env: process.env, satHome, host: bind.host });
if (refusal) {
  console.error(refusal);
  process.exit(GUARD_EXIT_CODE);
}
process.env.CROW_HOME = satHome; // every later resolver agrees on SAT_HOME

const agent = await startAgent({ env: process.env });
if (agent.isPaired()) {
  console.log("Paired; pairing routes are off");
} else {
  for (const line of pairCodeLines(agent.issuePairCode(), agent.satelliteId)) console.log(line);
}
// Last boot line: the readiness signal (tests and the installer wait for it).
console.log(`listening on ${agent.host}:${agent.port}`);

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  try { await agent.close(); } finally { process.exit(0); }
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
