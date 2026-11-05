#!/usr/bin/env node
/**
 * Reads the rows run.mjs wrote (one JSON object per line, rows only, no header line) and gives
 * the rates: per case, per arm, per criterion, per error type, and paired comparisons between
 * arms. Pure functions; the command line only reads files and prints.
 *
 *   node scripts/research-eval/report.mjs [--cases=<dir>] <file>.jsonl [<file>.jsonl …]
 *   --cases  the expected case set (that directory's case files); without it, the expected set is
 *            the union of the case ids any arm has
 *
 * It prints rates and, for a live arm whose case set is the tracked measurement set, the
 * operator's gate (§14, set 2026-11-05): (a) ≥ 80%, (b) ≥ 80%, (d) ≥ 95%, each as the mean over
 * the cases where that criterion applies of the per-case pass proportion (operator ruling G), so
 * undecided (b) counts as non-pass. The bars are NEVER applied to harness rows or to a
 * `--cases` set other than `cases/`: those print "gate: not applied" with the reason.
 * Exit: 0 = the figures are complete · 2 = bad usage · 6 = NO VERDICT (a contaminated or
 * malformed row, a duplicate unit, a sampling setting other than the pre-registered one, an
 * (arm, case) of the expected set with fewer than MIN_REPS scored reps (0 included), or scored
 * rep counts that differ within an arm or across arms for a case: the design fixes the reps per
 * case). No gate line is printed when there is a NO VERDICT.
 *
 * Rules fixed before any run (§5, §13 of the design):
 *   - a row's case pass is RECOMPUTED from row.criteria (every value that is not "n/a" is
 *     "pass"); row.case_pass is never read;
 *   - "undecided" (b only) is non-pass, in the headline and in the b rate, and undecided rows are
 *     also listed on their own;
 *   - a contaminated row (row.contaminated set, ok false, or no valid criteria: a transport
 *     failure has criteria null) is never scored; it is counted apart and refuses a verdict;
 *   - an arm's headline is the mean over cases of the per-case pass proportion;
 *   - a criterion rate leaves n/a out of the denominator.
 *
 * Row fields read: arm, case, type, rep, ok, contaminated, criteria {a,b,c,d}, sampling, judge_reason,
 * judge_calls (real judge invocations: the billed count), judge_spans (spans routed to the judge),
 * attempts (live rows: how many tries the unit took), config ({mode, case_set, …} — live gating),
 * and evidence: evidence.reasons {a,b,c,d} (one string per failed check, an addition to the
 * design's §6 row format, from the scorer) gives the failing evidence; a contaminated row's
 * evidence.errors is printed with it.
 */
import { pathToFileURL } from "node:url";
import { SIGN_ALPHA, readRows, signTestP } from "../kiosk-eval/report.mjs";
import { CASES_DIR, caseSetIdentity, loadCases } from "./cases.mjs";
import { SAMPLING, seedFor } from "./score.mjs";

export { SIGN_ALPHA };
export const MIN_REPS = 3;
export const CRITERIA = Object.freeze(["a", "b", "c", "d"]);
/**
 * The operator's pass bars, set 2026-11-05 BEFORE any live run (design §14): an arm may back
 * research bots only at ≥80% on (a), ≥80% on (b) and ≥95% on (d). A gate statistic is not allowed
 * to move after a run, so this table is frozen and dated.
 */
export const GATES = Object.freeze({ set: "2026-11-05", a: 0.80, b: 0.80, d: 0.95 });
/** Float comparisons of two means never land exactly on a bar: compare with this epsilon. */
export const GATE_EPSILON = 1e-9;
export const GATED_CRITERIA = Object.freeze(["a", "b", "d"]);
/** The case types of the starter set (§4); a type outside it gets its own bucket too. */
export const TYPES = Object.freeze(["number", "qualifier", "misattribution", "misquote", "date", "derived", "dead_page", "control"]);
const VALUES = new Set(["pass", "fail", "n/a", "undecided"]);
const WILCOXON_MAX_N = 20;

// signTestP sums logarithms, so an exact 1/8 comes back as 0.12500000000000003; trim the residue.
const tidy = (p) => Number(p.toPrecision(12));
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const rate = (pass, n) => (n ? pass / n : null);

/** The reason a row cannot be scored, or null for a scorable row. */
export function contamination(r) {
  if (r.contaminated) return String(r.contaminated);
  if (r.ok === false) return "ok is false";
  const c = r.criteria;
  if (!c || typeof c !== "object") return "no criteria";
  for (const k of CRITERIA) if (!VALUES.has(c[k])) return `criterion ${k} is ${JSON.stringify(c[k])}`;
  if (c.b !== "undecided" && Object.values(c).includes("undecided")) return "undecided outside b";
  return null;
}

/** Case pass, recomputed: every applicable criterion passed ("undecided" is not a pass). */
export const casePass = (criteria) => CRITERIA.every((k) => criteria[k] === "pass" || criteria[k] === "n/a");

const counts = () => Object.fromEntries(CRITERIA.map((k) => [k, { pass: 0, n: 0 }]));
const tally = (cnt, criteria) => { for (const k of CRITERIA) if (criteria[k] !== "n/a") { cnt[k].n += 1; if (criteria[k] === "pass") cnt[k].pass += 1; } };
const rates = (cnt) => Object.fromEntries(CRITERIA.map((k) => [k, rate(cnt[k].pass, cnt[k].n)]));

/**
 * rows (any number of arms) → { arms: Map<arm, {
 *   cases: Map<case, { type, reps, passes, pass_prop, criteria: {a,b,c,d} rates, criteria_counts, rows }>,
 *   headline, criteria_rates, criteria_counts, undecided_rows: [{case, rep}],
 *   contaminated_rows: [{case, rep, reason}], judge: { calls, spans, uncounted },
 *   live, measurement, retries: { extra, rows },
 *   by_type: { <type>: { cases, headline } } }> }
 * A case's reps count scored rows only; a case with none has pass_prop null and is left out of
 * the headline. judge.calls / judge.spans sum every row's judge_calls / judge_spans (contaminated
 * rows too: a call is paid for whatever became of the row); judge.uncounted = rows without them.
 * live: every row of the arm is a live row (config.mode === "live"); measurement: live AND every
 * row's config.case_set is the tracked measurement set; retries: attempts beyond the first, and
 * how many rows needed one (operator ruling R: the report prints them per arm).
 */
export function summarize(rows) {
  const arms = new Map();
  // The measurement set as it is on disk right now: the gate is applied to this and nothing else.
  const measurement = caseSetIdentity(CASES_DIR);
  const isMeasurement = (id) => !!id && typeof id === "object" && id.sha === measurement.sha && id.dir === measurement.dir;
  for (const r of rows) {
    if (!arms.has(r.arm)) arms.set(r.arm, { cases: new Map(), contaminated_rows: [], undecided_rows: [], cnt: counts(), judge: { calls: 0, spans: 0, uncounted: 0 }, live: true, measurement: true, retries: { extra: 0, rows: 0 } });
    const a = arms.get(r.arm);
    a.live = a.live && !!(r.config && r.config.mode === "live");
    a.measurement = a.measurement && !!(r.config && r.config.mode === "live" && isMeasurement(r.config.case_set));
    const tries = Number.isInteger(r.attempts) && r.attempts > 0 ? r.attempts : 1;
    a.retries.extra += tries - 1;
    if (tries > 1) a.retries.rows += 1;
    if (!a.cases.has(r.case)) a.cases.set(r.case, { type: r.type ?? null, reps: 0, passes: 0, cnt: counts(), rows: [] });
    const c = a.cases.get(r.case);
    if (Number.isInteger(r.judge_calls) && Number.isInteger(r.judge_spans)) { a.judge.calls += r.judge_calls; a.judge.spans += r.judge_spans; }
    else a.judge.uncounted += 1;
    const why = contamination(r);
    if (why) { a.contaminated_rows.push({ case: r.case, rep: r.rep, reason: why }); continue; }
    c.reps += 1;
    c.rows.push(r);
    if (casePass(r.criteria)) c.passes += 1;
    tally(c.cnt, r.criteria);
    tally(a.cnt, r.criteria);
    if (r.criteria.b === "undecided") a.undecided_rows.push({ case: r.case, rep: r.rep });
  }
  const out = new Map();
  for (const [arm, a] of arms) {
    const cases = new Map();
    for (const [id, c] of a.cases) {
      cases.set(id, { type: c.type, reps: c.reps, passes: c.passes, pass_prop: c.reps ? c.passes / c.reps : null, criteria: rates(c.cnt), criteria_counts: c.cnt, rows: c.rows });
    }
    const scored = [...cases.values()].filter((c) => c.reps > 0);
    const by_type = {};
    for (const t of [...TYPES, ...new Set(scored.map((c) => c.type).filter((t) => !TYPES.includes(t)))]) {
      const of = scored.filter((c) => c.type === t);
      by_type[t] = { cases: of.length, headline: mean(of.map((c) => c.pass_prop)) };
    }
    out.set(arm, {
      cases, headline: mean(scored.map((c) => c.pass_prop)), criteria_rates: rates(a.cnt), criteria_counts: a.cnt,
      undecided_rows: a.undecided_rows, contaminated_rows: a.contaminated_rows, judge: a.judge, by_type,
      live: a.live, measurement: a.measurement, retries: a.retries,
    });
  }
  return { arms: out };
}

/**
 * Two-sided exact Wilcoxon signed-rank p over paired differences: zeros dropped, average ranks
 * for tied |d|, every one of the 2^n sign assignments counted (n ≤ 20). 1 when n = 0.
 * |d| is quantized to 1e-9 first, so float noise (2/3 - 1/3 against 1/3 - 0) neither breaks a
 * tie nor keeps a zero.
 */
export function wilcoxonSignedRankP(diffs) {
  const q = (x) => Math.round(Math.abs(x) * 1e9);
  const d = diffs.filter((x) => q(x) !== 0);
  const n = d.length;
  if (n === 0) return 1;
  if (n > WILCOXON_MAX_N) throw new Error(`wilcoxonSignedRankP: exact enumeration is for n ≤ ${WILCOXON_MAX_N}, got ${n}`);
  const order = d.map((x, i) => ({ abs: q(x), i })).sort((x, y) => x.abs - y.abs);
  const rank2 = new Array(n); // twice the average rank, an integer
  for (let s = 0; s < n;) {
    let e = s;
    while (e + 1 < n && order[e + 1].abs === order[s].abs) e += 1;
    for (let k = s; k <= e; k += 1) rank2[order[k].i] = s + e + 2;
    s = e + 1;
  }
  const total = rank2.reduce((s, r) => s + r, 0);
  const obs = d.reduce((s, x, i) => s + (x > 0 ? rank2[i] : 0), 0);
  // dist[w] = the number of sign assignments whose positive doubled-rank sum is w.
  let dist = new Array(total + 1).fill(0);
  dist[0] = 1;
  for (const r of rank2) {
    const next = dist.slice();
    for (let w = 0; w + r <= total; w += 1) if (dist[w]) next[w + r] += dist[w];
    dist = next;
  }
  const far = Math.abs(2 * obs - total);
  let hits = 0;
  for (let w = 0; w <= total; w += 1) if (dist[w] && Math.abs(2 * w - total) >= far) hits += dist[w];
  return Math.min(1, hits / 2 ** n);
}

/** Two-sided exact McNemar p on b and c, the discordant counts. */
export const mcnemarP = (b, c) => Math.min(1, tidy(2 * signTestP(Math.min(b, c), Math.max(b, c))));

/**
 * Paired BY CASE (§5) on the per-case pass proportion, over the cases both arms scored.
 * better = cases where A's proportion is higher; sign_p = P(A better than B by chance), one-sided;
 * sign_p_reverse the other way; McNemar on per-case majority verdicts (proportion > 0.5);
 * inconclusive when neither one-sided sign test reaches SIGN_ALPHA (a small set has low power, so
 * that is "inconclusive", never "equal").
 */
export function compareArms(summary, armA, armB) {
  const A = summary.arms.get(armA), B = summary.arms.get(armB);
  if (!A || !B) throw new Error(`compareArms: no arm ${!A ? armA : armB}`);
  const diffs = [];
  let better = 0, worse = 0, ties = 0, aOnly = 0, bOnly = 0;
  for (const [id, ca] of A.cases) {
    const cb = B.cases.get(id);
    if (ca.pass_prop === null || !cb || cb.pass_prop === null) continue;
    const diff = ca.pass_prop - cb.pass_prop;
    diffs.push(diff);
    if (diff > 0) better += 1; else if (diff < 0) worse += 1; else ties += 1;
    const ma = ca.pass_prop > 0.5, mb = cb.pass_prop > 0.5;
    if (ma && !mb) aOnly += 1;
    if (!ma && mb) bOnly += 1;
  }
  const sign_p = tidy(signTestP(worse, better));
  const sign_p_reverse = tidy(signTestP(better, worse));
  return {
    pairs: diffs.length, better, worse, ties, sign_p, sign_p_reverse, wilcoxon_p: wilcoxonSignedRankP(diffs),
    majority: { a_only: aOnly, b_only: bOnly }, mcnemar_p: mcnemarP(aOnly, bOnly),
    inconclusive: sign_p >= SIGN_ALPHA && sign_p_reverse >= SIGN_ALPHA,
  };
}

const unit = (r) => `${r.arm}/${r.case}/rep ${r.rep}`;

/**
 * Why no verdict can be given, one line each: a contaminated or malformed row (or a header or
 * other non-row line), a duplicate (arm, case, rep), a sampling setting other than the
 * pre-registered one, every (arm, case) of the expected set with fewer than MIN_REPS scored reps
 * (0 included: an arm missing a case gets a line), and scored rep counts that differ within an arm
 * or across arms for one case. The expected set is `cases` (ids) when given, plus every case id
 * any arm has.
 */
export function refusals(rows, { cases = [] } = {}) {
  const out = [];
  const seen = new Set();
  const reps = new Map();
  for (const r of rows) {
    if (typeof r?.arm !== "string" || typeof r.case !== "string" || !Number.isInteger(r.rep)) {
      out.push(`not a row (a row file holds rows only, no header): ${JSON.stringify(r).slice(0, 120)}`);
      continue;
    }
    const key = JSON.stringify([r.arm, r.case, r.rep]);
    if (seen.has(key)) { out.push(`duplicate row: ${unit(r)}`); continue; }
    seen.add(key);
    const k = JSON.stringify([r.arm, r.case]);
    if (!reps.has(k)) reps.set(k, 0);
    const why = contamination(r);
    if (why) { out.push(`contaminated: ${unit(r)}: ${why}`); continue; }
    const s = r.sampling ?? {};
    const want = { ...SAMPLING, seed: seedFor(r.rep) };
    if (Object.keys(want).some((f) => s[f] !== want[f])) out.push(`sampling differs from the pre-registered setting: ${unit(r)}: ${JSON.stringify(s)}`);
    reps.set(k, reps.get(k) + 1);
  }
  const arms = [...new Set([...reps.keys()].map((k) => JSON.parse(k)[0]))].sort();
  const ids = [...new Set([...cases, ...[...reps.keys()].map((k) => JSON.parse(k)[1])])].sort();
  const n = (arm, id) => reps.get(JSON.stringify([arm, id])) ?? 0;
  for (const arm of arms) for (const id of ids) {
    if (n(arm, id) < MIN_REPS) out.push(`fewer than ${MIN_REPS} scored reps: ${arm}/${id} has ${n(arm, id)}`);
  }
  // A missing (0) count already has its line above; only the scored counts are compared.
  const unequal = (list) => new Set(list.map(([, k]) => k).filter((k) => k > 0)).size > 1;
  for (const arm of arms) {
    const list = ids.map((id) => [id, n(arm, id)]);
    if (unequal(list)) out.push(`unequal scored reps in arm ${arm}: ${list.map(([id, k]) => `${id} ${k}`).join(", ")}`);
  }
  for (const id of ids) {
    const list = arms.map((arm) => [arm, n(arm, id)]);
    if (unequal(list)) out.push(`unequal scored reps for case ${id} across arms: ${list.map(([arm, k]) => `${arm} ${k}`).join(", ")}`);
  }
  return out;
}

const pc = (x) => (x === null ? "-" : `${Math.round(x * 1000) / 10}%`);
const p4 = (x) => x.toFixed(4);
const mark = { pass: "P", fail: "F", "n/a": "-", undecided: "U" };

/**
 * The gate statistic for one criterion (operator ruling G): the mean, over the cases where the
 * criterion applies, of that case's criterion pass proportion — never a pooled rate, which would
 * weight a case with fewer applicable reps more heavily. A case where the criterion is n/a in
 * every rep leaves the mean. Undecided (b) is non-pass because the per-case proportion counts
 * only "pass".
 * @returns {{value: number|null, cases: number}}
 */
export function gateStatistic(arm, key) {
  const per = [];
  for (const c of arm.cases.values()) {
    const cnt = c.criteria_counts?.[key];
    if (!cnt || !cnt.n) continue;
    per.push(cnt.pass / cnt.n);
  }
  return { value: per.length ? per.reduce((s, x) => s + x, 0) / per.length : null, cases: per.length };
}

/**
 * The §14 gate for one arm: PASS when (a) ≥ 0.80, (b) ≥ 0.80 and (d) ≥ 0.95 by the statistic above,
 * compared with an epsilon (float means never land exactly on a bar). `undecided` reports how many
 * judge-routed spans were counted as non-pass, which the GATE line prints (ruling D+J).
 * @returns {{pass: boolean, stats: {a,b,d: {value, cases}}, undecided: {spans, rows}}}
 */
export function gateVerdict(arm) {
  const stats = {};
  let pass = true;
  for (const k of GATED_CRITERIA) {
    stats[k] = gateStatistic(arm, k);
    const v = stats[k].value;
    if (v === null || v < GATES[k] - GATE_EPSILON) pass = false;
  }
  let spans = 0;
  let rows = 0;
  for (const c of arm.cases.values()) {
    for (const r of c.rows) {
      if (r.criteria.b !== "undecided") continue;
      rows += 1;
      spans += Number.isInteger(r.judge_spans) && r.judge_spans > 0 ? r.judge_spans : 1;
    }
  }
  return { pass, stats, undecided: { spans, rows } };
}

/** The GATE line, or the reason no gate applies to this arm. */
export function gateLine(arm, summary, refuseCount) {
  if (!arm.live) return "gate: not applied (harness rows)";
  if (!arm.measurement) return "gate: not applied (not the measurement set)";
  if (refuseCount > 0) return "gate: not applied (a refusal below blocks a verdict)";
  const v = gateVerdict(arm);
  const fmt = (k) => `${k} ${pc(v.stats[k].value)} ≥${Math.round(GATES[k] * 100)}`;
  return `GATE ${summary}: ${v.pass ? "PASS" : "FAIL"} (${GATED_CRITERIA.map(fmt).join(", ")}; bars set ${GATES.set}; `
    + `${v.undecided.spans} undecided span${v.undecided.spans === 1 ? "" : "s"} in ${v.undecided.rows} row${v.undecided.rows === 1 ? "" : "s"} counted as non-pass)`;
}

/** One line of failing evidence for a scored row: the first reason under each failed criterion. */
function failLine(r) {
  const parts = [];
  for (const k of CRITERIA) {
    if (r.criteria[k] === "fail") parts.push(`${k}: ${r.evidence?.reasons?.[k]?.[0] ?? (k === "b" && r.judge_reason ? `judge: ${r.judge_reason}` : "no reason recorded")}`);
    if (r.criteria[k] === "undecided") parts.push(`${k}: undecided${r.judge_reason ? ` (${r.judge_reason})` : ""}`);
  }
  return parts.join(" | ");
}

/** The printed report (lines), from rows; pure. `refusalsIn` is the CLI's refusal list (it uses
 *  the report's own expected set); render recomputes one when it is not given. */
export function render(rows, { refusalsIn = null } = {}) {
  const s = summarize(rows.filter((r) => typeof r?.arm === "string"));
  const refused = refusalsIn ?? refusals(rows.filter((r) => typeof r?.arm === "string"));
  const L = [];
  L.push(`Rates, plus the pre-registered gate for a live arm on the tracked measurement set (bars: a and b ≥${Math.round(GATES.a * 100)}%, d ≥${Math.round(GATES.d * 100)}%, set ${GATES.set}). Undecided (U) counts as non-pass.`);
  L.push("\nPer case (a b c d per rep; P pass, F fail, U undecided, - n/a):");
  for (const [arm, a] of s.arms) {
    for (const [id, c] of a.cases) {
      const reps = c.rows.slice().sort((x, y) => x.rep - y.rep);
      L.push(`  ${arm}  ${id} (${c.type ?? "?"})  pass ${c.passes}/${c.reps}  ${reps.map((r) => `r${r.rep} ${CRITERIA.map((k) => mark[r.criteria[k]]).join("")}`).join("  ")}`);
      for (const r of reps) { const f = failLine(r); if (f) L.push(`      r${r.rep}: ${f}`); }
    }
    for (const x of a.contaminated_rows) L.push(`  ${arm}  ${x.case}  r${x.rep} CONTAMINATED: ${x.reason}`);
  }
  L.push("\nPer arm:");
  for (const [arm, a] of s.arms) {
    const cr = CRITERIA.map((k) => `${k} ${pc(a.criteria_rates[k])} (${a.criteria_counts[k].pass}/${a.criteria_counts[k].n})`).join("  ");
    L.push(`  ${arm}: headline ${pc(a.headline)} over ${[...a.cases.values()].filter((c) => c.reps).length} cases;  ${cr}`);
    L.push(`    judge calls: ${a.judge.calls};  spans routed to the judge: ${a.judge.spans}${a.judge.uncounted ? ` (${a.judge.uncounted} rows carry no count)` : ""};  contaminated rows: ${a.contaminated_rows.length};  undecided rows: ${a.undecided_rows.length}`);
    L.push(`    retries: ${a.retries.extra} extra attempt${a.retries.extra === 1 ? "" : "s"} on ${a.retries.rows} row${a.retries.rows === 1 ? "" : "s"}`);
    L.push(`    by type: ${Object.entries(a.by_type).map(([t, v]) => `${t} ${pc(v.headline)} (${v.cases})`).join(", ")}`);
    L.push(`    ${gateLine(a, arm, refused.length)}`);
  }
  L.push("\nUndecided rows (non-pass for b):");
  let any = false;
  for (const [arm, a] of s.arms) for (const u of a.undecided_rows) { any = true; L.push(`  ${arm}/${u.case}/rep ${u.rep}`); }
  if (!any) L.push("  none");
  L.push("\nPaired comparisons (by case, on pass proportion):");
  const names = [...s.arms.keys()].sort();
  if (names.length < 2) L.push("  only one arm");
  for (let i = 0; i < names.length; i += 1) for (let j = i + 1; j < names.length; j += 1) {
    const c = compareArms(s, names[i], names[j]);
    L.push(`  ${names[i]} vs ${names[j]}: ${c.pairs} cases; ${names[i]} higher on ${c.better}, lower on ${c.worse}, tied ${c.ties}; `
      + `sign p ${p4(c.sign_p)} (${names[i]} better) / ${p4(c.sign_p_reverse)} (${names[j]} better); Wilcoxon p ${p4(c.wilcoxon_p)}; `
      + `McNemar p ${p4(c.mcnemar_p)} (majority pass ${c.majority.a_only} vs ${c.majority.b_only})${c.inconclusive ? `; INCONCLUSIVE (neither sign p < ${SIGN_ALPHA})` : ""}`);
  }
  return L;
}

function main() {
  const argv = process.argv.slice(2);
  const files = argv.filter((a) => !a.startsWith("--"));
  const usage = "usage: report.mjs [--cases=<dir>] <rows>.jsonl [<rows>.jsonl …]";
  const flags = argv.filter((a) => a.startsWith("--"));
  if (!files.length || flags.some((a) => !a.startsWith("--cases="))) { console.error(usage); process.exit(2); }
  let expected = [];
  const dir = flags.find((a) => a.startsWith("--cases="))?.slice(8);
  if (dir !== undefined) {
    try { expected = loadCases(dir || CASES_DIR).map((c) => c.id); } catch (err) { console.error(`--cases=${dir}: ${err.message}`); process.exit(2); }
  }
  const rows = [];
  const unreadable = [];
  for (const f of files) {
    try { rows.push(...readRows(f)); } catch (err) { unreadable.push(`unreadable file ${f}: ${err.message}`); }
  }
  const refuse = [...unreadable, ...refusals(rows, { cases: expected })];
  for (const line of render(rows, { refusalsIn: refuse })) console.log(line);
  if (refuse.length) {
    console.log("\nRefusals:");
    for (const r of refuse) console.log(`  ${r}`);
    console.log("\nNO VERDICT");
    process.exit(6);
  }
  process.exit(0);
}
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main();
