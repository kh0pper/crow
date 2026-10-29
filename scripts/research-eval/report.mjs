#!/usr/bin/env node
/**
 * Reads the rows run.mjs wrote (one JSON object per line, rows only, no header line) and gives
 * the rates: per case, per arm, per criterion, per error type, and paired comparisons between
 * arms. Pure functions; the command line only reads files and prints.
 *
 *   node scripts/research-eval/report.mjs <file>.jsonl [<file>.jsonl …]
 *
 * It prints rates only, never a gate verdict: the pass bars are the operator's, set before the
 * first live run and recorded outside this repo. Exit: 0 = the figures are complete · 2 = bad
 * usage · 6 = NO VERDICT (a contaminated or malformed row, a duplicate unit, a sampling setting
 * other than the pre-registered one, or an (arm, case) with fewer than MIN_REPS scored reps).
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
 * and evidence: evidence.reasons {a,b,c,d} (one string per failed check, an addition to the
 * design's §6 row format, from the scorer) gives the failing evidence; evidence.prose_hits.judged
 * gives the spans sent to the judge; a contaminated row's evidence.errors is printed with it.
 */
import { pathToFileURL } from "node:url";
import { SIGN_ALPHA, readRows, signTestP } from "../kiosk-eval/report.mjs";
import { SAMPLING, seedFor } from "./score.mjs";

export { SIGN_ALPHA };
export const MIN_REPS = 3;
export const CRITERIA = Object.freeze(["a", "b", "c", "d"]);
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
 *   cases: Map<case, { type, reps, passes, pass_prop, criteria: {a,b,c,d} rates, rows }>,
 *   headline, criteria_rates, criteria_counts, undecided_rows: [{case, rep}],
 *   contaminated_rows: [{case, rep, reason}], judge: { rows, spans },
 *   by_type: { <type>: { cases, headline } } }> }
 * A case's reps count scored rows only; a case with none has pass_prop null and is left out of
 * the headline. judge.rows = scored rows that reached the judge (judge_reason set); judge.spans =
 * the spans those rows sent, an upper bound on calls (a fail verdict stops a row's calls).
 */
export function summarize(rows) {
  const arms = new Map();
  for (const r of rows) {
    if (!arms.has(r.arm)) arms.set(r.arm, { cases: new Map(), contaminated_rows: [], undecided_rows: [], cnt: counts(), judge: { rows: 0, spans: 0 } });
    const a = arms.get(r.arm);
    if (!a.cases.has(r.case)) a.cases.set(r.case, { type: r.type ?? null, reps: 0, passes: 0, cnt: counts(), rows: [] });
    const c = a.cases.get(r.case);
    const why = contamination(r);
    if (why) { a.contaminated_rows.push({ case: r.case, rep: r.rep, reason: why }); continue; }
    c.reps += 1;
    c.rows.push(r);
    if (casePass(r.criteria)) c.passes += 1;
    tally(c.cnt, r.criteria);
    tally(a.cnt, r.criteria);
    if (r.criteria.b === "undecided") a.undecided_rows.push({ case: r.case, rep: r.rep });
    if (r.judge_reason != null) { a.judge.rows += 1; a.judge.spans += r.evidence?.prose_hits?.judged?.length ?? 0; }
  }
  const out = new Map();
  for (const [arm, a] of arms) {
    const cases = new Map();
    for (const [id, c] of a.cases) {
      cases.set(id, { type: c.type, reps: c.reps, passes: c.passes, pass_prop: c.reps ? c.passes / c.reps : null, criteria: rates(c.cnt), rows: c.rows });
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
    });
  }
  return { arms: out };
}

/**
 * Two-sided exact Wilcoxon signed-rank p over paired differences: zeros dropped, average ranks
 * for tied |d|, every one of the 2^n sign assignments counted (n ≤ 20). 1 when n = 0.
 */
export function wilcoxonSignedRankP(diffs) {
  const d = diffs.filter((x) => x !== 0);
  const n = d.length;
  if (n === 0) return 1;
  if (n > WILCOXON_MAX_N) throw new Error(`wilcoxonSignedRankP: exact enumeration is for n ≤ ${WILCOXON_MAX_N}, got ${n}`);
  const order = d.map((x, i) => ({ abs: Math.abs(x), i })).sort((x, y) => x.abs - y.abs);
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
 * pre-registered one, and every (arm, case) with fewer than MIN_REPS scored reps.
 */
export function refusals(rows) {
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
  for (const [k, n] of reps) {
    if (n >= MIN_REPS) continue;
    const [arm, id] = JSON.parse(k);
    out.push(`fewer than ${MIN_REPS} scored reps: ${arm}/${id} has ${n}`);
  }
  return out;
}

const pc = (x) => (x === null ? "-" : `${Math.round(x * 1000) / 10}%`);
const p4 = (x) => x.toFixed(4);
const mark = { pass: "P", fail: "F", "n/a": "-", undecided: "U" };

/** One line of failing evidence for a scored row: the first reason under each failed criterion. */
function failLine(r) {
  const parts = [];
  for (const k of CRITERIA) {
    if (r.criteria[k] === "fail") parts.push(`${k}: ${r.evidence?.reasons?.[k]?.[0] ?? (k === "b" && r.judge_reason ? `judge: ${r.judge_reason}` : "no reason recorded")}`);
    if (r.criteria[k] === "undecided") parts.push(`${k}: undecided${r.judge_reason ? ` (${r.judge_reason})` : ""}`);
  }
  return parts.join(" | ");
}

/** The printed report (lines), from rows; pure. */
export function render(rows) {
  const s = summarize(rows.filter((r) => typeof r?.arm === "string"));
  const L = [];
  L.push("Rates only: no pass bar is applied here (the bars are pre-registered separately). Undecided (U) counts as non-pass.");
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
    L.push(`    judge: ${a.judge.rows} rows reached it, ${a.judge.spans} spans sent (at most that many calls);  contaminated rows: ${a.contaminated_rows.length};  undecided rows: ${a.undecided_rows.length}`);
    L.push(`    by type: ${Object.entries(a.by_type).map(([t, v]) => `${t} ${pc(v.headline)} (${v.cases})`).join(", ")}`);
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
  const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (!files.length) { console.error("usage: report.mjs <rows>.jsonl [<rows>.jsonl …]"); process.exit(2); }
  const rows = [];
  const unreadable = [];
  for (const f of files) {
    try { rows.push(...readRows(f)); } catch (err) { unreadable.push(`unreadable file ${f}: ${err.message}`); }
  }
  for (const line of render(rows)) console.log(line);
  const refuse = [...unreadable, ...refusals(rows)];
  if (refuse.length) {
    console.log("\nRefusals:");
    for (const r of refuse) console.log(`  ${r}`);
    console.log("\nNO VERDICT");
    process.exit(6);
  }
  process.exit(0);
}
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main();
