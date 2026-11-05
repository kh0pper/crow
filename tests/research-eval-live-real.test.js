/**
 * research-eval live mode with a REAL pi: the whole path (handleInbound → buildBotWorld → pi →
 * the fixture research server behind the sampling proxy) against the loopback stub model, which
 * replays an authored trajectory as tool calls. It needs pi's dist/cli.js and the pi-lab checkout
 * (PI_CLI / PI_LAB_DIR, or a pi resolvePiCli() can find). This repo has no pi dependency and the CI
 * runners install none, so the file skips there with "pi not installed" — the orchestrator runs it
 * locally before merge, and its result belongs in the PR body.
 *
 * What it proves that the stub-pi tests cannot: pi really starts the fixture server through the
 * override (the start marker + mcpOverridden), offers exactly the 13 granted tools, and the pinned
 * sampling (temperature/top_p/top_k/min_p/seed) is what reaches the model.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolvePiCli } from "../scripts/pi-bots/pi_resolver.mjs";
import { realPiPrereqs } from "../scripts/lib/record-stub-session.mjs";
import { LIFECYCLE_DEFAULTS } from "../scripts/lib/live-pi-driver.mjs";
import { startStubModel } from "../scripts/lib/stub-model-server.mjs";
import { CASES_DIR, caseSetIdentity, loadCases } from "../scripts/research-eval/cases.mjs";
import { loadTrajectory } from "../scripts/research-eval/replay.mjs";
import { EVAL_BOT_ID, evalBotDef, liveRunIdentity, runLiveUnit, stableStringify } from "../scripts/research-eval/live.mjs";
import { makeTemplate } from "../scripts/research-eval/scratch.mjs";
import { SAMPLING, noJudge, seedFor } from "../scripts/research-eval/score.mjs";

const pre = realPiPrereqs();
// No PI_CLI and nothing resolvePiCli() can find is the CI shape; otherwise both env paths must exist.
const skip = !process.env.PI_CLI && !resolvePiCli() ? "pi not installed" : (pre.piCli ? false : pre.reason);
const CASES = loadCases(CASES_DIR);
const caseOf = (id) => CASES.find((c) => c.id === id);
const CASE_SET = caseSetIdentity(CASES_DIR);
const MODEL = "stub-m1";
const sha = (buf) => createHash("sha256").update(buf).digest("hex");

/**
 * An authored trajectory as a startStubModel script: one reply per step, its tool calls named by
 * suffix so the stub does not have to guess the mcp__ prefix. `$project` and `$source:<url>`
 * resolve to the scratch's project id and to 1 (a fresh scratch's first source).
 */
function scriptOf(caseId, name, projectId) {
  const resolve = (v) => {
    if (Array.isArray(v)) return v.map(resolve);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x)]));
    if (v === "$project") return projectId;
    if (typeof v === "string" && v.startsWith("$source:")) return 1;
    return v;
  };
  const { steps } = loadTrajectory(caseId, name);
  return steps.map((s) => {
    if (typeof s.say === "string") return { text: s.say };
    const calls = Array.isArray(s.batch) ? s.batch : [s];
    return { toolCalls: calls.map((c) => ({ nameEndsWith: `__${c.call}`, arguments: resolve(c.args ?? {}) })) };
  });
}

/** One live unit against the stub model; the caller cleans up {stub, template}. */
async function liveUnit({ caseId, name }) {
  const template = await makeTemplate({ botId: EVAL_BOT_ID });
  const stub = await startStubModel({ script: scriptOf(caseId, name, template.projectId) });
  const botDefSha = sha(stableStringify(evalBotDef({ model: MODEL, crowHome: template.home })));
  try {
    const { row } = await runLiveUnit({
      caseDef: caseOf(caseId), rep: 0, arm: `real-pi-${name}`, model: MODEL, baseUrl: stub.baseUrl,
      piCli: pre.piCli, piLab: pre.piLab, prodMaxPi: LIFECYCLE_DEFAULTS.maxPi, turnTimeoutMs: 180_000,
      template, botDefSha, caseSet: CASE_SET,
      identity: liveRunIdentity({ model: MODEL, baseUrl: stub.baseUrl, botDefSha, piSha: "real-pi", skillSha: "skill", caseSet: CASE_SET }),
      judge: noJudge,
    });
    return { row, stub, template };
  } catch (err) {
    await stub.close();
    template.cleanup();
    throw err;
  }
}

test("real pi + stub model: rr12 careful through the fixture server passes a, b and d", { skip, timeout: 900_000 }, async (t) => {
  const { row, stub, template } = await liveUnit({ caseId: "rr12", name: "careful" });
  t.after(async () => { await stub.close(); template.cleanup(); });
  assert.equal(row.ok, true, JSON.stringify(row.evidence));
  assert.equal(row.contaminated, false, String(row.contaminated));
  assert.equal(row.parse_ok, true);
  assert.deepEqual([row.criteria.a, row.criteria.b, row.criteria.d], ["pass", "pass", "pass"], JSON.stringify(row.evidence.reasons));
  assert.equal(row.case_pass, true);
  // The seam's receipt: runLiveUnit aborts the run unless every turn reported the override and the
  // fixture server stamped its start marker for this case, so a row at all is that proof.
  assert.equal(row.sampling_proxy.tools_ok, true);
  assert.equal(row.config.mode, "live");
  assert.equal(row.config.judge, null);
  assert.match(row.config.endpoint_sha, /^[0-9a-f]{64}$/);
  assert.deepEqual(row.config.case_set, CASE_SET);
  // The pinned sampling is what reached the model (the proxy observed it, the row records it).
  assert.deepEqual({ temperature: row.sampling.temperature, top_p: row.sampling.top_p, top_k: row.sampling.top_k, min_p: row.sampling.min_p, seed: row.sampling.seed },
    { ...SAMPLING, seed: seedFor(0) });
  // Exactly the 13 granted tools were offered, on every request.
  const names = new Set(stub.requests.flatMap((b) => (b.tools ?? []).map((x) => x.function.name)));
  const granted = evalBotDef({ model: MODEL, crowHome: template.home }).tools.crow_mcp.map((e) => `mcp__${e.replace("/", "__")}`);
  assert.deepEqual([...names].sort(), [...granted].sort());
  assert.equal(granted.length, 13);
  // completion_tokens comes from the session's usage.output, or is null when pi records none.
  assert.ok(row.completion_tokens === null || Number.isInteger(row.completion_tokens));
});

test("real pi + stub model: a hank-shaped rr01 answer fails a and b", { skip, timeout: 900_000 }, async (t) => {
  const { row, stub, template } = await liveUnit({ caseId: "rr01", name: "hank" });
  t.after(async () => { await stub.close(); template.cleanup(); });
  assert.equal(row.ok, true, JSON.stringify(row.evidence));
  assert.equal(row.parse_ok, true);
  assert.equal(row.criteria.a, "fail");
  assert.equal(row.criteria.b, "fail");
  assert.equal(row.case_pass, false);
  assert.equal(row.sampling_proxy.tools_ok, true);
});