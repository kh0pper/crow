/**
 * The CI gate's pure classification of a GitHub check-runs payload (A5), shared by the gateway's
 * auto-update and the satellite's follow-the-primary update (SAT-6). No imports: the satellite
 * agent must not load the gateway's auto-update module (it reaches crow.db).
 */

// The three branch-protection context names (the A1 contract). Other runs
// (deploy-docs, build, image-freshness) never block updates.
export const CI_GATE_CONTEXTS = ["suite", "static-checks", "audit"];

/**
 * Pure classification of a GitHub check-runs payload for the target sha.
 * "unknown" (no named runs — a fork without our CI, or an API oddity) FAILS
 * OPEN in the gateway's auto-update: strangers' forks and non-GitHub
 * deployments must still update; the gate only defends against a KNOWABLY red
 * main. (The satellite accepts only "green".)
 */
export function classifyCheckRuns(payload) {
  const runs = (payload?.check_runs || []).filter((r) => CI_GATE_CONTEXTS.includes(r?.name));
  if (runs.length === 0) return "unknown";
  if (runs.some((r) => r.status !== "completed")) return "pending";
  const ok = ["success", "neutral", "skipped"];
  return runs.every((r) => ok.includes(r.conclusion)) ? "green" : "red";
}
