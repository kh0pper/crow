#!/usr/bin/env node
/**
 * research-eval live mode: one real model behind a sampling proxy, through the real
 * handleInbound → buildBotWorld → pi path, with the research server's network edges replaced by
 * the case's fixture. This module is the preflight, the per-unit runner, the retry policy, the row
 * and the CLI that run.mjs dispatches to.
 *
 * What is checked before a row can be scored:
 *   - the arm is a direct single-model endpoint (checkEndpoints: no gateway port, no /llm/ or
 *     /proxy/ path, loopback or an --allow-host), and not a lazy loader;
 *   - /models lists exactly the one --model, "loaded" where the server exposes a status
 *     (re-checked before every unit; the sampling proof runs once per run);
 *   - the arm honours seed, top_k and min_p (a control, then three pairs, see proveSampling);
 *   - the MCP override seam ran (every turn reports mcpOverridden ["crow-projects"]);
 *   - every request to the model offered exactly the granted tool set;
 *   - the fixture server wrote its start marker (pid, case id, run id) into the scratch home.
 * The last four are deterministic: they ABORT the run (exit 2), never retry. Only transport
 * trouble is retried — with a fresh scratch and the SAME seed, at most MAX_ATTEMPTS times.
 *
 * Nothing here starts, warms or swaps a model: preflight is a read-only GET plus (once per run)
 * the sampling probe against the endpoint the operator named. As the driver's own header says,
 * this is not a sandbox.
 */
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { MAX_ATTEMPTS, outGuard } from "../lib/eval-run.mjs";
import { FIXTURE_SERVER, FIXTURE_START_MARKER, checkMcpOverrides } from "../lib/eval-guard.mjs";
import { checkEndpoints, DriverRefusal, isLazyLoader, runConversation } from "../lib/live-pi-driver.mjs";
import { realish, realUserCrowDir, within } from "../lib/protected-paths.mjs";
import { skillRequiredTools } from "../pi-bots/skill-tools.mjs";
import { caseSetIdentity, CASES_DIR, loadCases } from "./cases.mjs";
import { readEvidence, readFetchLog } from "./evidence.mjs";
import { doneKeys, provenanceShas, ROW_KEYS, rowKey } from "./run.mjs";
import { makeScratch, makeTemplate, ROOT, SKILL } from "./scratch.mjs";
import { noJudge, SAMPLING, scoreRow, seedFor } from "./score.mjs";
import { startSamplingProxy } from "./sampling-proxy.mjs";
import { parseSession } from "./session-log.mjs";

export const EVAL_BOT_ID = "research-eval";
/** The one fixed system prompt. Its text is hashed into every row's config (bot_def_sha). */
export const EVAL_SYSTEM_PROMPT = "You answer research questions and cite the page you opened for every claim.";
/** Rows carry these beyond the harness shape: the sampling pinned by the proxy, the retries, the proxy's record. */
export const LIVE_ROW_KEYS = Object.freeze([...ROW_KEYS, "sampling_proxy", "attempts", "attempt_reasons"]);
export const UNIT_CAP_MS = 15 * 60 * 1000;
export const TRANSPORT_FAILURE = (n) => `transport failure after ${n} attempts`;

/** A deterministic seam failure or an exhausted box: the run stops (exit 2), nothing is retried. */
export class LiveAbort extends Error {
  constructor(message) { super(message); this.name = "LiveAbort"; }
}
/** The arm's /models check failed: exit 4 ("preflight refused"). */
export class PreflightRefused extends Error {
  constructor(message) { super(message); this.name = "PreflightRefused"; }
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const clip = (s, n = 300) => { const t = String(s ?? ""); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const elapsed = (t0) => Math.round((Date.now() - t0) / 10) / 100;

/** JSON with sorted keys, so two equal configs hash alike regardless of insertion order. */
export function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

// ---------------------------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------------------------

/** The arm's URL check (pure, no request): a direct single-model endpoint, never a gateway. */
export function checkArmEndpoint({ baseUrl, model, allowHosts = [], gatewayPorts = [] }) {
  checkEndpoints({ providers: { arm: { baseUrl, models: [{ id: model }] } } }, { allowHosts, gatewayPorts });
  if (isLazyLoader(null, baseUrl)) {
    throw new DriverRefusal("live pi driver refused: the arm's base URL is a model loader (ollama, llama-swap and friends), not a resident model server");
  }
}

/** The `status` a /models entry carries, lowercased, or null when it carries none. */
function entryStatus(entry) {
  const s = entry?.status;
  if (s === undefined || s === null) return null;
  if (typeof s === "string") return s.toLowerCase();
  if (typeof s === "object" && typeof s.value === "string") return s.value.toLowerCase();
  return "unknown";
}

/**
 * The read-only /models check. Refuses anything but exactly one entry, equal to --model, with
 * "loaded" where the server exposes a status: a residency claim from a router-mode server that
 * lists unloaded models is not a measurement.
 * @returns {Promise<object>} the model entry
 */
export async function preflightModels({ baseUrl, model, timeoutMs = 5_000, fetchImpl = fetch } = {}) {
  const refuse = (rule) => { throw new PreflightRefused(`preflight refused: ${rule}`); };
  if (typeof model !== "string" || !model) refuse("--model is required");
  const url = `${String(baseUrl).replace(/\/+$/, "")}/models`;
  let res;
  try {
    res = await fetchImpl(url, { method: "GET", headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    refuse(`${url} is unreachable (${clip(err && err.message, 120)})`);
  }
  if (!res || res.status !== 200) refuse(`${url} returned ${res ? res.status : "no response"}, not 200`);
  let body;
  try { body = await res.json(); } catch { refuse(`${url} did not return JSON`); }
  const data = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : null;
  if (data === null) refuse(`${url} carries no data[] list`);
  if (data.length !== 1) refuse(`${url} lists ${data.length} models; a live arm must be a single-model server`);
  const entry = data[0] || {};
  if (entry.id !== model) refuse(`${url} lists ${JSON.stringify(entry.id)}, not --model ${JSON.stringify(model)}`);
  const status = entryStatus(entry);
  if (status !== null && status !== "loaded") {
    refuse(`${url} reports status ${JSON.stringify(status)} for ${model}; an unloaded model is not an arm`);
  }
  return entry;
}

/**
 * The probe's prompt: high entropy on purpose. A sampler without the pins must be able to vary on
 * it, which is the control the three pin checks below rest on.
 */
export const PROBE_PROMPT = "Write one random English word.";
export const PROBE_MAX_TOKENS = 16;
/** Four seeds for the control; the first two are reused by the pin pairs. */
export const PROBE_SEEDS = Object.freeze([1000, 1001, 1002, 1003]);
/** The probe's base: everything that could greedy-fy the sampler is disabled, so only the field under test can. */
const PROBE_BASE = Object.freeze({ temperature: 1, top_p: 1, top_k: 0, min_p: 0 });

/**
 * The completion text of one probe reply: `message.content` AND `message.reasoning_content`, because
 * a thinking model puts its first tokens in reasoning_content and leaves content empty. (The legacy
 * `choice.text` of the completions route is read too.)
 */
function probeText(choice) {
  const m = choice && choice.message && typeof choice.message === "object" ? choice.message : {};
  const parts = [];
  if (typeof choice?.text === "string") parts.push(choice.text);
  if (typeof m.content === "string") parts.push(m.content);
  if (typeof m.reasoning_content === "string") parts.push(m.reasoning_content);
  return parts.join("\n");
}

/**
 * Proves the arm's server honours seed, top_k and min_p — the three pinned settings that
 * llama-server's OpenAI-compatible /v1/chat/completions takes in the request body (its docs list
 * top_k, min_p and seed among the sampler params). No /props read or doc quote can prove that a
 * *request* field is honoured, so the probe asks the model itself. Four steps, in this order:
 *   control: a high-entropy prompt ("write one random word"), temperature 1, top_p 1, top_k 0,
 *            min_p 0, 16 tokens and FOUR different seeds. At least two of the four must differ.
 *            Without this an equal pair proves nothing: a server that ignores every field but is
 *            deterministic (greedy, or a fixed server seed) returns the same text for any two
 *            requests, and the pin checks below would pass on an arm that pins nothing.
 *   seed:    the same request twice (same seed)               → same text ⇒ the seed reaches the sampler
 *   top_k:   top_k=1, two DIFFERENT seeds                     → same text ⇒ top_k is applied (k=1 is greedy)
 *   min_p:   min_p=1, two different seeds, top_k 0            → same text ⇒ min_p is applied (min_p=1
 *            keeps only the most likely token, so the RNG cannot change the pick)
 * Every request carries temperature 1 and top_p 1, so neither can greedy-fy a pair on its own, and
 * the output is content + reasoning_content (a thinking-only reply is read, not skipped).
 * What it does NOT prove: that intermediate top_k/min_p values are honoured, or anything about
 * top_p. The sampling itself is pre-registered (score.mjs SAMPLING); this is a floor.
 * @returns {Promise<{seed: true, top_k: true, min_p: true, requests: number}>}
 */
export async function proveSampling({ baseUrl, model, timeoutMs = 60_000, fetchImpl = fetch } = {}) {
  const refuse = (rule) => { throw new PreflightRefused(`preflight refused: ${rule}`); };
  const url = `${String(baseUrl).replace(/\/+$/, "")}/chat/completions`;
  let requests = 0;
  const ask = async (extra) => {
    requests += 1;
    let res;
    try {
      res = await fetchImpl(url, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, messages: [{ role: "user", content: PROBE_PROMPT }], max_tokens: PROBE_MAX_TOKENS,
          ...PROBE_BASE, stream: false, ...extra }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      refuse(`the sampling probe could not reach ${url} (${clip(err && err.message, 120)})`);
    }
    if (!res || res.status !== 200) refuse(`the sampling probe got ${res ? res.status : "no response"} from ${url}, not 200`);
    let body;
    try { body = await res.json(); } catch { refuse("the sampling probe got a non-JSON reply"); }
    const choice = Array.isArray(body?.choices) ? body.choices[0] : null;
    if (!choice) refuse("the sampling probe got no choices[] back");
    return probeText(choice);
  };
  // The control FIRST: without the pins the arm must be able to vary at all.
  const control = [];
  for (const seed of PROBE_SEEDS) control.push(await ask({ seed }));
  if (control.every((t) => t === "")) {
    refuse("the sampling probe read an empty completion every time (content and reasoning_content were both empty)");
  }
  if (new Set(control).size < 2) refuse("cannot prove sampling: the arm is deterministic without the pins");
  // Then the three pins, on the same high-entropy prompt.
  const pair = async (name, a, b) => {
    const [x, y] = [await ask(a), await ask(b)];
    if (x !== y) refuse(`${name} is not honoured: two requests that can only differ by the seed returned different completions`);
  };
  await pair("seed", { seed: PROBE_SEEDS[0] }, { seed: PROBE_SEEDS[0] });
  await pair("top_k", { top_k: 1, seed: PROBE_SEEDS[0] }, { top_k: 1, seed: PROBE_SEEDS[1] });
  await pair("min_p", { min_p: 1, seed: PROBE_SEEDS[0] }, { min_p: 1, seed: PROBE_SEEDS[1] });
  return { seed: true, top_k: true, min_p: true, requests };
}

// ---------------------------------------------------------------------------------------------
// The bot def and the MCP override
// ---------------------------------------------------------------------------------------------

/**
 * The eval bot def, built per run inside a scratch home: the skill's 13 crow-projects tools, no pi
 * builtin, no bash, no paths, no project. The skill stays selected so its text is inlined as in
 * prod; the bridge's withSkillTools adds no duplicate. `crowHome` must be a scratch, never a real
 * instance: skillRequiredTools reads it for a skill override and for the off switch.
 */
export function evalBotDef({ provider = "arm", model, crowHome, repoSkillsDir = join(ROOT, "skills"), systemPrompt = EVAL_SYSTEM_PROMPT } = {}) {
  return {
    id: EVAL_BOT_ID,
    display_name: "Research Eval",
    system_prompt: systemPrompt,
    models: { default: `${provider}/${model}` },
    skills: [SKILL],
    tools: { pi_builtin: [], crow_mcp: skillRequiredTools(SKILL, { crowHome, repoSkillsDir }) },
    permission_policy: { bash: "deny", write_paths: [], read_paths: [], multi_agent: false, skill_learning: "off" },
  };
}

/**
 * One provider's model entry for the driver's models.json: `--pi-model`'s extra fields go UNDER the
 * id, never over it. A pi-model file that carried its own `id` would otherwise point the run at a
 * model the proxy refuses (fail-safe, but the wrong way round), so the id is spread last.
 */
export function armModelEntry(model, piModel = null) {
  return { ...(piModel || {}), id: model };
}

/** The exact tool names pi must offer: `server/tool` → mcp__server__tool. */
export const expectedToolNames = (granted) => granted.map((t) => `mcp__${t.replace("/", "__")}`);

/**
 * The override the seam accepts: the fixture server in place of servers/research/index.js for this
 * scratch and this case. Validated here (the parent) with the same check the child runs, so a bad
 * override costs no scratch.
 */
export function liveMcpOverrides(scratch, casePath) {
  const overrides = {
    "crow-projects": {
      command: process.execPath,
      args: [FIXTURE_SERVER],
      env: {
        CROW_RESEARCH_EVAL: "1",
        CROW_HOME: scratch.home,
        CROW_RESEARCH_EVAL_CASE: casePath,
        CROW_RESEARCH_EVAL_FETCH_LOG: scratch.fetchLogPath,
        TMPDIR: tmpdir(),
      },
    },
  };
  checkMcpOverrides(overrides, realish(scratch.home));
  return overrides;
}

/** The fixture server's start marker for this scratch, or null. */
export function readStartMarker(home) {
  try {
    const o = JSON.parse(readFileSync(join(home, FIXTURE_START_MARKER), "utf8"));
    return o && typeof o === "object" ? o : null;
  } catch { return null; }
}

/** The sum of every assistant message's usage.output in a pi session log; null when none carries one. */
export function completionTokensOf(jsonl) {
  let total = 0;
  let any = false;
  for (const line of String(jsonl ?? "").split("\n")) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const m = o && o.type === "message" ? o.message : null;
    if (!m || m.role !== "assistant") continue;
    const out = m.usage && typeof m.usage.output === "number" ? m.usage.output : null;
    if (out === null) continue;
    any = true;
    total += out;
  }
  return any ? total : null;
}

// ---------------------------------------------------------------------------------------------
// Retry policy (operator ruling R)
// ---------------------------------------------------------------------------------------------

// Transport only: a connection error, a 5xx, survivors, or a missing session. A turn timeout, a
// context overflow and a 4xx status are scored or flagged and never re-rolled. The 4xx pattern
// matches a status phrase only: a bare 443 in "ECONNRESET … :443" is transport, not a client error.
const TRANSPORT_RE = /connection error|ECONNREFUSED|ECONNRESET|EPIPE|socket hang up|fetch failed|status 5\d\d|HTTP 5\d\d|survivors\b|survived the thread|cannot find the pi session file/i;
const NEVER_RETRY_RE = /exceeded \d+ ms|context (length|window)|too many tokens|maximum context|status 4\d\d|HTTP 4\d\d/i;

/** True when a run failure is a transport problem the ruling allows re-rolling. */
export function retryableFailure(reason) {
  const why = String(reason ?? "");
  if (!why) return false;
  if (NEVER_RETRY_RE.test(why)) return false;
  return TRANSPORT_RE.test(why);
}

/** A run-wide stop rather than a row: the box is full, or the wall cap fired. */
const stopReasonOf = (reason) => {
  const why = String(reason ?? "");
  if (/prod pi capacity/.test(why)) return "capacity";
  if (/conversation exceeded wallMs/.test(why)) return "wall";
  return null;
};

// ---------------------------------------------------------------------------------------------
// One unit
// ---------------------------------------------------------------------------------------------

const orderLiveRow = (r) => Object.fromEntries(LIVE_ROW_KEYS.map((k) => [k, r[k]]));

function contaminatedRow({ base, tail, why, reason = null, t0, attempts, attemptReasons, sampling = null, samplingProxy = null }) {
  return {
    ...base, ok: false, parse_ok: false, contaminated: why,
    wall_s: elapsed(t0), completion_tokens: null, criteria: null, case_pass: false,
    evidence: { errors: [clip(why, 300), ...(reason ? [clip(reason, 600)] : [])] },
    undecided: false, no_prose: null, off_set_fetches: [], flagged_unconfirmed: [],
    sampling, judge_reason: null, judge_calls: 0, judge_spans: 0,
    sampling_proxy: samplingProxy ?? { requests: 0, overrode_keys: [], tools_ok: null },
    attempts, attempt_reasons: [...attemptReasons], ...tail,
  };
}

/** The deterministic seam checks: any failure aborts the run (exit 2), never retried. */
export function abortOnSeamFailure({ r, summary, scratch, caseDef, events }) {
  const runId = (events ?? []).find((e) => e && e.runId)?.runId ?? null;
  // Without a run id the fixture identity cannot be checked at all: a stale server's marker would
  // pass. That is a seam failure, not something to shrug at.
  if (runId === null) throw new LiveAbort("no driver event carried a run id, so the fixture server's start marker cannot be tied to this run");
  for (const th of r.threads) {
    for (const t of th.turns) {
      const got = t.mcpOverridden;
      if (!Array.isArray(got) || got.length !== 1 || got[0] !== "crow-projects") {
        throw new LiveAbort(`the MCP override did not reach pi: turn ${t.turn} of ${th.id} reported mcpOverridden ${JSON.stringify(got)} (the real research server may have run)`);
      }
    }
  }
  if (summary.tools_ok !== true) {
    throw new LiveAbort("the tools offered to the model were not exactly the granted set (a pi builtin or another surface reached the model)");
  }
  const marker = readStartMarker(scratch.home);
  if (marker === null) throw new LiveAbort(`the fixture server wrote no start marker (${FIXTURE_START_MARKER}) in the scratch home`);
  if (marker.case !== caseDef.id) throw new LiveAbort(`the fixture start marker names case ${JSON.stringify(marker.case)}, not ${caseDef.id}`);
  if (marker.run_id !== runId) throw new LiveAbort(`the fixture start marker names run ${JSON.stringify(marker.run_id)}, not this run (a stale server wrote it)`);
}

async function scoredRow({ caseDef, scratch, r, judge, base, tail, config, pinned, summary, attempts, attemptReasons, t0 }) {
  const sessionPath = r.threads[0]?.sessionPaths?.[0] ?? null;
  if (!sessionPath) throw new LiveAbort("the driver reported no session file for a completed turn");
  const raw = readFileSync(sessionPath, "utf8");
  const session = parseSession(raw);
  const scored = await scoreRow({
    caseDef, session, evidence: readEvidence(scratch.dbPath), fetchLog: readFetchLog(scratch.fetchLogPath),
    granted: scratch.granted, judge,
  });
  config.pi_lab_sha = r.meta?.packages?.[0]?.sha ?? null;
  return {
    ...base, ok: true, parse_ok: session.parse_ok, contaminated: scored.contaminated,
    wall_s: elapsed(t0), completion_tokens: completionTokensOf(raw),
    criteria: scored.criteria, case_pass: scored.case_pass, evidence: scored.evidence,
    undecided: scored.undecided, no_prose: scored.no_prose, off_set_fetches: scored.off_set_fetches,
    flagged_unconfirmed: scored.flagged_unconfirmed,
    sampling: pinned, judge_reason: scored.judge_reason, judge_calls: scored.judge_calls, judge_spans: scored.judge_spans,
    sampling_proxy: { requests: summary.requests, overrode_keys: summary.overrode_keys, tools_ok: summary.tools_ok },
    attempts, attempt_reasons: [...attemptReasons], ...tail,
  };
}

/**
 * One (arm, case, rep) row: fresh scratch → sampling proxy → runConversation → the seam checks →
 * score. Transport failures are retried (fresh scratch, same seed, at most MAX_ATTEMPTS); a seam
 * failure throws LiveAbort; a failed /models check throws PreflightRefused. The scratch and the
 * proxy are always cleaned up before this returns.
 * @returns {Promise<{row: object, stop: string|null}>}
 */
export async function runLiveUnit({
  caseDef, rep, arm, model, baseUrl, allowHosts = [], piCli, piLab, prodMaxPi, turnTimeoutMs = UNIT_CAP_MS,
  template, piModel = null, caseSet, identity, botDefSha, judge = noJudge, judgeName = null, sessionsDir = null,
  unitCapMs = UNIT_CAP_MS, parentEnv = process.env, log = () => {},
}) {
  const t0 = Date.now();
  const attemptReasons = [];
  const config = {
    mode: "live", trajectory: null, skill: SKILL, gateway: "eval", bot_def_sha: botDefSha,
    judge: judgeName ? { name: judgeName, provider: null, model: null, spot_checked: null } : null,
    pi_lab_sha: null, endpoint_sha: sha256(`${baseUrl}\0${model}`),
    case_set: caseSet, run: identity,
  };
  const base = { arm, model, config, case: caseDef.id, type: caseDef.type, rep };
  const tail = provenanceShas(ROOT);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    // Before every unit: the endpoint must still list exactly this one loaded model. Nothing has
    // been sent for this unit yet, and no scratch exists yet.
    await preflightModels({ baseUrl, model });
    const scratch = await makeScratch({ template });
    let proxy = null;
    try {
      const casePath = join(scratch.home, "case.json");
      writeFileSync(casePath, JSON.stringify(caseDef));
      const overrides = liveMcpOverrides(scratch, casePath);
      const botDef = evalBotDef({ model, crowHome: scratch.home });
      if (JSON.stringify(botDef.tools.crow_mcp) !== JSON.stringify(scratch.granted)) {
        throw new LiveAbort("the bot def's grant and the scratch's skill grant disagree");
      }
      proxy = await startSamplingProxy({ upstream: baseUrl, model, rep, expectedTools: expectedToolNames(botDef.tools.crow_mcp) });
      const models = { providers: { arm: { baseUrl: proxy.baseUrl, api: "openai-completions", apiKey: "none", models: [armModelEntry(model, piModel)] } } };
      const events = [];
      const r = await runConversation({
        botDef, models, scratchHome: scratch.home,
        threads: [{ id: `${caseDef.id}-r${rep}`, turns: [{ text: caseDef.prompt }] }],
        allowServers: ["crow-projects"], allowSkills: [SKILL], piPackages: [piLab], gatewayType: "eval",
        piCli, turnTimeoutMs, wallMs: Math.max(1_000, Math.min(unitCapMs, turnTimeoutMs + 60_000)),
        prodMaxPi, mcpOverrides: overrides, parentEnv,
        log: (e) => { events.push(e); log(e); },
      });
      const summary = proxy.summary();
      const pinned = proxy.pinnedSampling();
      // A failed run is classified first (a failure is never measured). Only a run that reports
      // success is checked for having measured anything, and for the seam's deterministic facts.
      if (r.ok !== true) {
        const why = String(r.contaminated ?? "the run failed");
        if (retryableFailure(why)) {
          // Same seed (the rep does not change), fresh scratch, at most MAX_ATTEMPTS.
          attemptReasons.push(why);
          if (attempt < MAX_ATTEMPTS) {
            log(`${caseDef.id} rep ${rep}: transport failure (${clip(why, 160)}), attempt ${attempt} of ${MAX_ATTEMPTS}`);
            continue;
          }
          break; // every attempt was transport: the row after the loop says so
        }
        const stop = stopReasonOf(why);
        if (stop === "capacity") throw new LiveAbort(`prod pi capacity: the box has no free pi slot (${clip(why, 160)})`);
        const row = contaminatedRow({ base, tail, why, reason: r.reason, t0, attempts: attempt, attemptReasons, sampling: pinned, samplingProxy: summary });
        if (sessionsDir) copySession(r, sessionsDir, caseDef, rep);
        return { row: orderLiveRow(row), stop };
      }
      if (summary.requests === 0) {
        // A successful turn that never asked the model for anything measured nothing. Honest, and
        // not transport: re-rolling it would only hide it.
        return { row: orderLiveRow(contaminatedRow({ base, tail, why: "no model request passed the sampling proxy", t0, attempts: attempt, attemptReasons })), stop: null };
      }
      abortOnSeamFailure({ r, summary, scratch, caseDef, events });
      if (sessionsDir) copySession(r, sessionsDir, caseDef, rep);
      const row = await scoredRow({ caseDef, scratch, r, judge, base, tail, config, pinned, summary, attempts: attempt, attemptReasons, t0 });
      return { row: orderLiveRow(row), stop: null };
    } finally {
      if (proxy) await proxy.close();
      scratch.cleanup();
    }
  }
  // Every attempt was transport trouble: the row says so and names each earlier reason.
  const row = contaminatedRow({ base, tail, why: TRANSPORT_FAILURE(MAX_ATTEMPTS), t0, attempts: MAX_ATTEMPTS, attemptReasons });
  return { row: orderLiveRow(row), stop: null };
}

/** Copies the unit's pi session JSONL out (the judge spot check needs it); refuses an unsafe dir. */
function copySession(r, sessionsDir, caseDef, rep) {
  const from = r.threads[0]?.sessionPaths?.[0];
  if (!from) return;
  mkdirSync(sessionsDir, { recursive: true });
  copyFileSync(from, join(sessionsDir, `${caseDef.id}-r${rep}.jsonl`));
}

// ---------------------------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------------------------

/**
 * The config every row of one invocation carries, and the identity --resume compares. A resume
 * that changes the model, endpoint, the pi model entry, bot def, pi, pi-lab, skill, judge, sampling
 * or case set is refused: two configs' rows are not one run.
 */
export function liveRunIdentity({ model, baseUrl, botDefSha, piSha, piLabSha = null, skillSha, judgeName = null, piModel = null, caseSet }) {
  const parts = {
    model, endpoint_sha: sha256(`${baseUrl}\0${model}`), bot_def_sha: botDefSha, pi_sha: piSha, pi_lab_sha: piLabSha,
    skill_sha: skillSha, judge: judgeName ?? null, pi_model: piModel ?? null, sampling: { ...SAMPLING, seed_base: seedFor(0) }, case_set: caseSet,
  };
  return { ...parts, key: sha256(stableStringify(parts)) };
}

/** A row file's config identity, from its first row; null when there is none yet. */
export function existingRunKey(out) {
  let text;
  try { text = readFileSync(out, "utf8"); } catch { return null; }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { const o = JSON.parse(line); if (o && o.config && o.config.run) return o.config.run; } catch { /* skip */ }
  }
  return null;
}

/**
 * Runs every (case, rep) not in `done`, one at a time (Q4: one slot in a registered window).
 * @returns {Promise<{rows: number, stop: string|null}>} stop "window" or "wall" ends the run
 */
export async function runLiveRows({
  cases, arm, model, baseUrl, allowHosts = [], piCli, piLab, prodMaxPi, reps = 3, out, done = new Set(), template,
  caseSet, identity, botDefSha, piModel = null, turnTimeoutMs = UNIT_CAP_MS, unitCapMs = UNIT_CAP_MS, deadline = null,
  sessionsDir = null, judge = noJudge, judgeName = null, parentEnv = process.env, log = () => {},
}) {
  const units = [];
  for (const c of cases) for (let rep = 0; rep < reps; rep += 1) if (!done.has(rowKey(arm, c.id, rep))) units.push({ caseDef: c, rep });
  if (!units.length) return { rows: 0, stop: null };
  mkdirSync(dirname(resolve(out)), { recursive: true });
  let rows = 0;
  for (const u of units) {
    // Do not start a unit that cannot finish inside the window.
    if (deadline !== null && deadline !== undefined && deadline - Date.now() < Math.min(unitCapMs, turnTimeoutMs + 60_000)) {
      log(`window end reached: ${units.length - rows} unit(s) not run (--resume continues)`);
      return { rows, stop: "window" };
    }
    const { row, stop } = await runLiveUnit({
      ...u, arm, model, baseUrl, allowHosts, piCli, piLab, prodMaxPi, turnTimeoutMs, template, piModel,
      caseSet, identity, botDefSha, sessionsDir, judge, judgeName, unitCapMs, parentEnv, log,
    });
    appendFileSync(out, JSON.stringify(row) + "\n");
    rows += 1;
    const outcome = row.contaminated ? `contaminated (${row.contaminated})` : row.case_pass ? "pass" : "fail";
    log(`${row.case} rep ${row.rep}: ${outcome}${row.attempts > 1 ? ` after ${row.attempts} attempts` : ""}`);
    if (stop === "wall") return { rows, stop: "wall" };
  }
  return { rows, stop: null };
}

// ---------------------------------------------------------------------------------------------
// The CLI (run.mjs --mode=live dispatches here)
// ---------------------------------------------------------------------------------------------

export const LIVE_USAGE = "usage: run.mjs --mode=live --arm=<label> --base-url=<direct endpoint>/v1 --model=<id> --out=<file>.jsonl\n"
  + "  --pi-cli=<abs pi dist/cli.js> --pi-lab=<abs pi-lab checkout> --prod-max-pi=<n> --no-judge --window-end=<ISO>\n"
  + "  [--allow-host=<host:port>[,<host:port>]] [--pi-model=<file.json>] [--reps=3] [--cases=<dir>]\n"
  + "  [--turn-min=15] [--wall-min=240] [--sessions-dir=<dir>] [--resume]";
export const NO_JUDGE_YET = "a cloud judge is not wired yet (ruling 2026-11-05)";

const list = (v) => String(v ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const dirInside = (p, root) => within(realish(p), realish(root)) || within(realish(root), realish(p));

/** Where a run may not write: the repo checkout (public hygiene) or the real user's crow dir. */
function refuseOutputPath(label, p) {
  if (typeof p !== "string" || !p) throw new DriverRefusal(`live pi driver refused: ${label} is required`);
  if (dirInside(p, ROOT)) throw new DriverRefusal(`live pi driver refused: ${label} must not be inside the repo checkout`);
  if (dirInside(p, realUserCrowDir())) throw new DriverRefusal(`live pi driver refused: ${label} must not be inside the real user's crow dir`);
}

/**
 * The whole live run. Returns the process exit code: 2 usage or a DriverRefusal, 3 outGuard,
 * 4 preflight refused, 5 the wall cap or the window end was reached.
 */
export async function runLive(arg, { log = (m) => console.error(m) } = {}) {
  const say = (m) => { try { log(m); } catch { /* a logging hook never breaks a run */ } };
  const usage = (msg) => { say(msg); say(LIVE_USAGE); return 2; };
  if (arg["judge-config"] !== undefined) { say(NO_JUDGE_YET); return 2; }
  if (arg["no-judge"] !== "1") return usage("live mode needs an explicit --no-judge: the first run is strict, judge-routed spans count as non-pass (ruling 2026-11-05)");
  const required = ["arm", "base-url", "model", "out", "pi-cli", "pi-lab", "prod-max-pi", "window-end"];
  const missing = required.filter((k) => arg[k] === undefined || arg[k] === "");
  if (missing.length) return usage(`live mode needs ${missing.map((k) => `--${k}`).join(", ")}`);
  if (arg.concurrency !== undefined && Number(arg.concurrency) !== 1) return usage("live mode runs one unit at a time: --concurrency must be 1");
  const reps = Number(arg.reps ?? 3);
  if (!Number.isInteger(reps) || reps < 1) return usage("--reps must be a positive integer");
  const turnMin = Number(arg["turn-min"] ?? 15);
  const wallMin = Number(arg["wall-min"] ?? 240);
  if (!Number.isFinite(turnMin) || turnMin <= 0 || !Number.isFinite(wallMin) || wallMin <= 0) return usage("--turn-min and --wall-min must be positive numbers");
  const prodMaxPi = Number(arg["prod-max-pi"]);
  if (!Number.isInteger(prodMaxPi) || prodMaxPi < 2) return usage("--prod-max-pi must be an integer >= 2 (read it from the prod gateway unit)");
  const windowEnd = Date.parse(arg["window-end"]);
  if (!Number.isFinite(windowEnd)) return usage("--window-end must be an ISO timestamp");
  if (windowEnd <= Date.now()) return usage("--window-end is in the past: a live run happens inside a registered window");
  const resume = arg.resume === "1";
  const casesDir = arg.cases ? resolve(arg.cases) : CASES_DIR;
  const allowHosts = list(arg["allow-host"]);
  const baseUrl = String(arg["base-url"]);
  const model = String(arg.model);
  const arm = String(arg.arm);
  const sessionsDir = arg["sessions-dir"] ? resolve(arg["sessions-dir"]) : null;
  const turnTimeoutMs = Math.round(turnMin * 60_000);

  try {
    refuseOutputPath("--out", arg.out);
    if (sessionsDir) refuseOutputPath("--sessions-dir", sessionsDir);
    checkArmEndpoint({ baseUrl, model, allowHosts });
  } catch (err) {
    if (err instanceof DriverRefusal) { say(err.message); return 2; }
    throw err;
  }
  for (const [label, p] of [["--pi-cli", arg["pi-cli"]], ["--pi-lab", arg["pi-lab"]]]) {
    if (!isAbsolute(p) || !existsSync(p) || (!statSync(p).isFile() && !statSync(p).isDirectory())) {
      say(`live mode needs ${label} to be an existing absolute path`);
      return 2;
    }
  }
  const og = outGuard(arg.out, resume);
  if (og) { say(og); return 3; }

  let cases;
  let caseSet;
  try {
    cases = loadCases(casesDir);
    caseSet = caseSetIdentity(casesDir);
  } catch (err) { say(`--cases=${casesDir}: ${err.message}`); return 2; }

  let piModel = null;
  if (arg["pi-model"]) {
    try { piModel = JSON.parse(readFileSync(resolve(arg["pi-model"]), "utf8")); } catch (err) { say(`--pi-model: ${err.message}`); return 2; }
    if (!piModel || typeof piModel !== "object" || Array.isArray(piModel)) { say("--pi-model must hold one JSON object (the pi model entry's extra fields)"); return 2; }
  }

  let template;
  try {
    template = await makeTemplate({ botId: EVAL_BOT_ID });
  } catch (err) { say(`cannot build a scratch template: ${err.message}`); return 1; }

  let code = 0;
  try {
    // Built inside a scratch home (never a real instance) so the def's grant is the tracked set.
    const botDefSha = sha256(stableStringify(evalBotDef({ model, crowHome: template.home })));
    const shas = provenanceShas(ROOT);
    const identity = liveRunIdentity({ model, baseUrl, botDefSha, piSha: sha256(readFileSync(resolve(arg["pi-cli"]))), skillSha: shas.skill_sha, piModel, caseSet });
    if (resume) {
      const prev = existingRunKey(arg.out);
      // pi_lab_sha is only known after a conversation runs, so the key compares everything else.
      if (prev && prev.key !== identity.key) {
        say("--resume refused: this invocation's model, endpoint, pi model entry, bot def, pi, skill, sampling or case set differs from the rows already in the file");
        return 2;
      }
    }
    // Once per run: the arm must list the one model as loaded, and honour the pinned sampling.
    try {
      await preflightModels({ baseUrl, model });
      const proof = await proveSampling({ baseUrl, model });
      say(`sampling proof: the arm varies without the pins, and seed, top_k and min_p are honoured (${proof.requests} requests)`);
    } catch (err) {
      say(err instanceof PreflightRefused ? err.message : `preflight refused: ${clip(err && err.message, 200)}`);
      return 4;
    }
    const res = await runLiveRows({
      cases, arm, model, baseUrl, allowHosts, piCli: resolve(arg["pi-cli"]), piLab: resolve(arg["pi-lab"]), prodMaxPi,
      reps, out: arg.out, done: resume ? doneKeys(arg.out) : new Set(), template, caseSet, identity, botDefSha,
      piModel, turnTimeoutMs, unitCapMs: turnTimeoutMs, deadline: Math.min(Date.now() + Math.round(wallMin * 60_000), windowEnd),
      sessionsDir, judge: noJudge, judgeName: null, log: say,
    });
    say(`${res.rows} rows written to ${arg.out}`);
    if (res.stop) code = 5;
  } catch (err) {
    if (err instanceof DriverRefusal || err instanceof LiveAbort) { say(err.message); code = 2; }
    else if (err instanceof PreflightRefused) { say(err.message); code = 4; }
    else { say(`live run failed: ${err && err.message ? err.message : err}`); code = 1; }
  } finally {
    template.cleanup();
  }
  return code;
}