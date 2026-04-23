#!/usr/bin/env node
/**
 * run-pipeline-subprocess — one-shot subprocess that executes a single
 * orchestrator team to completion and writes the JSON result to stdout.
 *
 * Why a subprocess? MPA's long-lived gateway process has wedged libsql
 * state (see servers/sharing/peer-pull-sync.js:9-17). Every fresh libsql
 * client opened inside that process fails on write with
 * SQLITE_IOERR_SHORT_READ, so the whole orchestration has to run in a
 * clean child Node process.
 *
 * Invocation modes:
 *
 *   # From the parent gateway (stdin mode, preferred — avoids argv size
 *   # limits on long goal strings):
 *   node scripts/run-pipeline-subprocess.mjs --from-stdin
 *   # ... writes `{"goal":"…","presetName":"…"}` to stdin
 *
 *   # From a human shell (argv mode, for manual dry runs):
 *   node scripts/run-pipeline-subprocess.mjs <pipeline-name>
 *   # ... looks up pipelines[<pipeline-name>] and uses its goal + preset
 *
 * Environment passthrough (inherits from parent or set explicitly for
 * manual runs): CROW_DATA_DIR, CROW_DB_PATH, CROW_GATEWAY_URL, NTFY_TOPIC,
 * NTFY_PORT, NTFY_AUTH_TOKEN, CROW_ORCHESTRATOR_PROVIDER,
 * CROW_ORCHESTRATOR_MODEL.
 *
 * The child intentionally does NOT re-read CROW_PIPELINE_SUBPROCESS — it's
 * already the subprocess; calling runOrchestrationStandalone directly avoids
 * infinite recursion.
 *
 * Stdout (last line): {"status":"completed"|"failed","result"?:"...","error"?:"..."}
 * Exit codes: 0 on status=completed, 1 on status=failed or thrown error, 2 on bad args.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function readStdin() {
  try {
    return readFileSync(0, "utf-8");
  } catch {
    return "";
  }
}

async function resolveInvocation() {
  const args = process.argv.slice(2);

  if (args[0] === "--from-stdin") {
    const raw = readStdin().trim();
    if (!raw) {
      process.stderr.write("--from-stdin expects JSON {goal, presetName} on stdin\n");
      process.exit(2);
    }
    const parsed = JSON.parse(raw);
    if (!parsed.goal || !parsed.presetName) {
      process.stderr.write("stdin JSON missing goal or presetName\n");
      process.exit(2);
    }
    return { goal: parsed.goal, presetName: parsed.presetName };
  }

  const pipelineName = args[0];
  if (!pipelineName) {
    process.stderr.write(
      "usage:\n" +
      "  run-pipeline-subprocess.mjs <pipeline-name>         (argv mode — human dry runs)\n" +
      "  run-pipeline-subprocess.mjs --from-stdin            (stdin mode — gateway dispatch)\n"
    );
    process.exit(2);
  }

  const { pipelines } = await import(resolve(__dirname, "../servers/orchestrator/pipelines.js"));
  const pipeline = pipelines[pipelineName];
  if (!pipeline) {
    process.stderr.write(
      `Unknown pipeline: "${pipelineName}". Available: ${Object.keys(pipelines).join(", ")}\n`
    );
    process.exit(2);
  }
  return { goal: pipeline.goal, presetName: pipeline.preset };
}

async function main() {
  const { goal, presetName } = await resolveInvocation();
  const { substituteGoalPlaceholders } = await import(
    resolve(__dirname, "../servers/orchestrator/pipeline-vars.js")
  );
  const expandedGoal = substituteGoalPlaceholders(goal);
  const { runOrchestrationStandalone } = await import(
    resolve(__dirname, "../servers/orchestrator/server.js")
  );
  const result = await runOrchestrationStandalone(expandedGoal, presetName, { connectedServers: null });
  emit(result);
  process.exit(result.status === "failed" ? 1 : 0);
}

main().catch((err) => {
  emit({ status: "failed", error: err?.message || String(err) });
  process.exit(1);
});
