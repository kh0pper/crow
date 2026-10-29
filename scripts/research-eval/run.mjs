#!/usr/bin/env node
/**
 * The research-eval runner. Each unit is one (case, rep) of one arm: a fresh scratch instance
 * (copied from a run's template), a replayed trajectory through the real fixture research server,
 * then the scorer over the session log, the scratch DB and the fetch log. One JSONL row per unit
 * is appended to --out the moment it exists.
 *
 *   node scripts/research-eval/run.mjs --mode=harness --trajectory=careful --out=$TMPDIR/rr/careful.jsonl
 *     [--arm=harness-<trajectory>] [--model=stub] [--reps=3] [--cases=<dir>] [--concurrency=4]
 *     [--judge=stub-pass] [--resume]
 *   --trajectory  careful | hank | correcting | <case>.<adversarial> (that case only)
 *   --judge       stub-pass is PLUMBING ONLY (every judged sentence passes); omitted = no judge,
 *                 so a judged (b) is undecided
 *   --mode=live   refused: it needs the pi driver (a later plan)
 *
 * A transport failure is retried with a fresh scratch, at most MAX_ATTEMPTS times; after that the
 * row is written as contaminated. Exit 2 = bad usage or live mode, 3 = --out is not empty and
 * --resume was not given.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { MAX_ATTEMPTS, outGuard } from "../lib/eval-run.mjs";
import { CASES_DIR, loadCases } from "./cases.mjs";
import { readEvidence, readFetchLog } from "./evidence.mjs";
import { loadTrajectory, replayTrajectory, trajectoryCase } from "./replay.mjs";
import { makeScratch, makeTemplate, ROOT, SKILL } from "./scratch.mjs";
import { SAMPLING, noJudge, scoreRow, seedFor, stubPassJudge } from "./score.mjs";
import { parseSession } from "./session-log.mjs";

export const LIVE_REFUSAL = "live mode is not built yet: it needs the pi driver (a later plan)";
export const JUDGES = Object.freeze({ "stub-pass": stubPassJudge });

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** skill_sha, server_sha and crow_sha (§6): what the rows were scored against. */
export function provenanceShas(root = ROOT) {
  const skill_sha = sha256(readFileSync(join(root, "skills", `${SKILL}.md`)));
  const files = [
    ...readdirSync(join(root, "servers", "research")).filter((f) => f.endsWith(".js")).map((f) => `servers/research/${f}`),
    "servers/shared/fetch-page.js", "servers/shared/fetch-page-worker.js", "scripts/pi-bots/skill-tools.mjs",
  ].sort();
  const h = createHash("sha256");
  for (const f of files) h.update(`${f}\0`).update(readFileSync(join(root, f))).update("\0");
  let crow_sha = null;
  try { crow_sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null; } catch { /* not a checkout */ }
  return { skill_sha, server_sha: h.digest("hex"), crow_sha };
}

/** The resume key of a row: (arm, case, rep). */
export const rowKey = (arm, caseId, rep) => JSON.stringify([arm, caseId, rep]);

/** The keys of the rows already in `out` (for --resume). */
export function doneKeys(out) {
  const done = new Set();
  if (!existsSync(out)) return done;
  for (const line of readFileSync(out, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    if (r.arm !== undefined && r.case !== undefined && r.rep !== undefined) done.add(rowKey(r.arm, r.case, r.rep));
  }
  return done;
}

/**
 * One unit: scratch → up to MAX_ATTEMPTS replays (a fresh scratch each) → parse, evidence, score
 * → the row. The scratch of the scored attempt is returned UNCLEANED, so a caller can inspect its
 * DB; the caller cleans it up. Failed attempts are cleaned here.
 * @returns {Promise<{row: object, scratch: object|null}>}
 */
export async function runUnit({ caseDef, steps, rep, arm, model, mode = "harness", trajectory, judge = noJudge, judgeName = null,
  template, shas = provenanceShas(), log = () => {} }) {
  const t0 = Date.now();
  const base = {
    arm, model,
    config: { mode, trajectory, skill: SKILL, judge: judgeName ? { name: judgeName } : null },
    case: caseDef.id, type: caseDef.type, rep,
  };
  const tail = { sampling: { ...SAMPLING, seed: seedFor(rep) }, ...shas };
  const errors = [];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const scratch = await makeScratch({ template });
    let r;
    try {
      const casePath = join(scratch.home, "case.json");
      writeFileSync(casePath, JSON.stringify(caseDef));
      r = await replayTrajectory({ casePath, steps, scratch });
    } catch (err) {
      scratch.cleanup();
      throw err;
    }
    if (!r.ok) {
      errors.push(r.error);
      log(`${caseDef.id} rep ${rep}: transport failure (${r.error}), attempt ${attempt} of ${MAX_ATTEMPTS}`);
      scratch.cleanup();
      continue;
    }
    try {
      const session = parseSession(existsSync(scratch.sessionPath) ? readFileSync(scratch.sessionPath, "utf8") : "");
      const scored = await scoreRow({
        caseDef, session, evidence: readEvidence(scratch.dbPath), fetchLog: readFetchLog(scratch.fetchLogPath),
        granted: scratch.granted, judge,
      });
      const row = {
        ...base, ok: true, parse_ok: session.parse_ok, contaminated: scored.contaminated,
        wall_s: Math.round((Date.now() - t0) / 10) / 100, completion_tokens: null,
        criteria: scored.criteria, case_pass: scored.case_pass, evidence: scored.evidence,
        undecided: scored.undecided, no_prose: scored.no_prose, off_set_fetches: scored.off_set_fetches,
        flagged_unconfirmed: scored.flagged_unconfirmed, ...tail, judge_reason: scored.judge_reason,
        judge_calls: scored.judge_calls, judge_spans: scored.judge_spans,
      };
      return { row: orderRow(row), scratch };
    } catch (err) {
      scratch.cleanup();
      throw err;
    }
  }
  const row = {
    ...base, ok: false, parse_ok: false, contaminated: `transport failure after ${MAX_ATTEMPTS} attempts`,
    wall_s: Math.round((Date.now() - t0) / 10) / 100, completion_tokens: null,
    criteria: null, case_pass: false, evidence: { errors }, undecided: false, no_prose: null, off_set_fetches: [],
    flagged_unconfirmed: [], ...tail, judge_reason: null, judge_calls: 0, judge_spans: 0,
  };
  return { row: orderRow(row), scratch: null };
}

const ROW_KEYS = ["arm", "model", "config", "case", "type", "rep", "ok", "parse_ok", "contaminated", "wall_s", "completion_tokens",
  "criteria", "case_pass", "evidence", "undecided", "no_prose", "off_set_fetches", "flagged_unconfirmed", "sampling",
  "judge_reason", "judge_calls", "judge_spans", "skill_sha", "server_sha", "crow_sha"];
const orderRow = (r) => Object.fromEntries(ROW_KEYS.map((k) => [k, r[k]]));

/**
 * Runs every (case, rep) unit not in `done`, at most `concurrency` at once, from one template,
 * appending each row to `out` as one whole line. A "<case>.<name>" trajectory runs on that case
 * only. `stepsFor(caseDef)` defaults to the trajectory file's steps.
 * @returns {Promise<{rows: number}>}
 */
export async function runRows({ cases, trajectory, reps = 3, arm, model = "stub", judge = noJudge, judgeName = null, out,
  done = new Set(), concurrency = 4, log = () => {}, stepsFor = (c) => loadTrajectory(c.id, trajectory).steps, mode = "harness" }) {
  const only = trajectoryCase(trajectory);
  const chosen = only ? cases.filter((c) => c.id === only) : cases;
  if (only && chosen.length === 0) throw new Error(`trajectory ${trajectory} is for case ${only}, which is not in the case set`);
  const label = arm ?? `harness-${trajectory}`;
  const units = [];
  for (const c of chosen) {
    const steps = stepsFor(c);
    for (let rep = 0; rep < reps; rep += 1) if (!done.has(rowKey(label, c.id, rep))) units.push({ caseDef: c, steps, rep });
  }
  if (units.length === 0) return { rows: 0 };
  mkdirSync(dirname(resolve(out)), { recursive: true });
  const shas = provenanceShas();
  const template = await makeTemplate({});
  let rows = 0;
  let next = 0;
  // On the first error no worker takes a new unit, and the template is removed only after every
  // worker has settled (a unit still in flight copies from it and runs on its workspace_dir).
  let firstError = null;
  const worker = async () => {
    while (!firstError && next < units.length) {
      const u = units[next++];
      let res;
      try {
        res = await runUnit({ ...u, arm: label, model, mode, trajectory, judge, judgeName, template, shas, log });
      } catch (err) {
        firstError ??= err;
        return;
      }
      const { row, scratch } = res;
      const outcome = row.contaminated ? `contaminated (${row.contaminated})` : row.case_pass ? "pass" : "fail";
      try {
        // A run that has failed writes no more rows.
        if (firstError) {
          log(`${row.case} rep ${row.rep}: ${outcome}, dropped (the run failed)`);
          continue;
        }
        appendFileSync(out, JSON.stringify(row) + "\n");
        rows += 1;
        log(`${row.case} rep ${row.rep}: ${outcome}`);
      } catch (err) {
        firstError ??= err;
      } finally {
        scratch?.cleanup();
      }
    }
  };
  await Promise.allSettled(Array.from({ length: Math.max(1, Math.min(concurrency, units.length)) }, worker));
  template.cleanup();
  if (firstError) throw firstError;
  return { rows };
}

export function parseArgs(argv) {
  return Object.fromEntries(argv.filter((a) => a.startsWith("--")).map((a) => {
    const i = a.indexOf("=");
    return i < 0 ? [a.slice(2), "1"] : [a.slice(2, i), a.slice(i + 1)];
  }));
}

const USAGE = "usage: run.mjs --mode=harness --trajectory=careful|hank|correcting|<case>.<adversarial> --out=<file>.jsonl "
  + "[--arm=<label>] [--model=<id>] [--reps=3] [--cases=<dir>] [--concurrency=4] [--judge=stub-pass] [--resume]";

async function main() {
  const arg = parseArgs(process.argv.slice(2));
  const mode = arg.mode || "harness";
  if (mode === "live") { console.error(LIVE_REFUSAL); process.exit(2); }
  if (mode !== "harness") { console.error(`unknown --mode=${mode}\n${USAGE}`); process.exit(2); }
  if (!arg.trajectory || !arg.out) { console.error(USAGE); process.exit(2); }
  if (arg.judge !== undefined && !JUDGES[arg.judge]) { console.error(`unknown --judge=${arg.judge}: only stub-pass exists in harness mode`); process.exit(2); }
  const reps = Number(arg.reps ?? 3);
  const concurrency = Number(arg.concurrency ?? 4);
  if (!Number.isInteger(reps) || reps < 1 || !Number.isInteger(concurrency) || concurrency < 1) { console.error(`--reps and --concurrency must be positive integers\n${USAGE}`); process.exit(2); }
  const resume = arg.resume === "1";
  const og = outGuard(arg.out, resume);
  if (og) { console.error(og); process.exit(3); }
  mkdirSync(dirname(resolve(arg.out)), { recursive: true });
  const res = await runRows({
    cases: loadCases(arg.cases ? resolve(arg.cases) : CASES_DIR), trajectory: arg.trajectory, reps,
    arm: arg.arm, model: arg.model || "stub", judge: arg.judge ? JUDGES[arg.judge] : noJudge, judgeName: arg.judge || null,
    out: arg.out, done: resume ? doneKeys(arg.out) : new Set(), concurrency, log: (m) => console.error(m),
  });
  console.error(`${res.rows} rows written to ${arg.out}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main().catch((err) => { console.error(err.message); process.exit(1); });
