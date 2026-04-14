#!/usr/bin/env node
/**
 * Phase 1 smoke test: provider health matrix works.
 *
 * Runs healthMatrix() directly against whatever providers are currently
 * registered in models.json. Prints the matrix. Does NOT fail when providers
 * are unreachable — liveness is informational at this stage. Fails only if
 * the loader itself errors or returns a malformed matrix.
 *
 * Usage: node scripts/smoke/providers-health.js
 */

import { healthMatrix } from "../../servers/orchestrator/providers.js";

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

const matrix = await healthMatrix({ timeoutMs: 2000 });

if (!matrix || typeof matrix !== "object") fail("matrix not returned");
if (!matrix.summary || typeof matrix.summary.total !== "number") fail("summary missing or malformed");
if (!matrix.providers || typeof matrix.providers !== "object") fail("providers map missing");

console.log(`source: ${matrix.source}`);
console.log(`summary: ${matrix.summary.ok}/${matrix.summary.total} reachable`);
console.log("---");
for (const [name, r] of Object.entries(matrix.providers)) {
  const tag = r.ok ? "OK " : "DOWN";
  const detail = r.ok
    ? `${r.latencyMs}ms, models=[${(r.models || []).join(",")}]`
    : `${r.error} (${r.latencyMs || "?"}ms)`;
  console.log(`  ${tag}  ${name.padEnd(20)}  ${r.baseUrl}  ${detail}`);
}
console.log("---");
console.log("PASS: matrix loaded and structure valid");
process.exit(0);
