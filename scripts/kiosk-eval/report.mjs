#!/usr/bin/env node
/**
 * Reads the rows run.mjs wrote (one JSON object per line, one file per model) and gives the figures
 * and the verdict. Pure functions; the command line only reads files and prints.
 *
 *   node scripts/kiosk-eval/report.mjs --in=quick.jsonl --in=larger.jsonl
 *
 * Exit: 0 = every gate passed · 5 = a gate failed (STOP: take the numbers to the operator) ·
 *       6 = incomplete (a model or the held-out set is missing, or rows are missing).
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Four tools may be this many turns worse than one and still pass: 2 in 120, in proportion. */
export const margin = (total) => Math.ceil(total / 60);
export const HELD_OUT_MIN_OFFERED = 17;   // of 20
export const FORCED_MIN = 0.9;
export const BACKSTOP_MIN = 0.7;
export const QUICK_FLOOR = 0.75;

const share = (n, d) => (d ? n / d : 0);
const pct = (n, d) => `${n}/${d}`;

/** rows of ONE model → its figures. */
export function summarize(rows) {
  const out = { main: { four: { correct: 0, total: 0 }, single: { correct: 0, total: 0 } }, held: { four: { correct: 0, total: 0 }, single: { correct: 0, total: 0 } },
    held_ids: new Set(), held_offered: new Set(), untruthful: [], forced: { total: 0, first_call: 0 }, backstop: { total: 0, done: 0, corrected: 0, could_not: 0 }, must_cases: new Set(), wrong: [], trials: 0 };
  for (const r of rows) {
    const set = r.set === "held" ? "held" : "main";
    const cell = out[set][r.arm];
    cell.total += 1;
    if (r.ok) cell.correct += 1; else out.wrong.push(`${r.id}/${r.arm}/t${r.trial}: ${r.offered_expected ? (r.tools.join(" → ") || "no call") : "expected tool not offered"}${r.failed ? ` (${r.failed})` : ""}`);
    out.trials = Math.max(out.trials, r.trial + 1);
    if (set === "held") { out.held_ids.add(r.id); if (r.offered_expected) out.held_offered.add(r.id); }
    if (r.arm !== "four" || !r.must) continue;
    out.must_cases.add(r.id);
    // The product's own promise: a turn that had to do something ends with it done, or with the could-not line.
    if (!r.must_done && r.failed === null) out.untruthful.push(`${r.id}/t${r.trial}`);
    if (r.tool_choice === "named" || r.tool_choice === "required") { out.forced.total += 1; if (r.must_done && r.requests === 1) out.forced.first_call += 1; }
    else { out.backstop.total += 1; if (r.must_done) out.backstop.done += 1; if (r.must_done && r.corrected) out.backstop.corrected += 1; if (r.failed === "display_missed") out.backstop.could_not += 1; }
  }
  return out;
}

/** reports = [{ label, engine, rows }] (one per model) → { pass, complete, gates: [{ id, pass, detail }], flags }. */
export function verdict(reports, { cases = 40, heldOut = 20 } = {}) {
  const gates = [], flags = [];
  const gate = (id, pass, detail) => gates.push({ id, pass: !!pass, detail });
  const labels = reports.map((r) => r.label);
  const missing = [];
  if (!labels.includes("quick")) missing.push("the quick model did not run");
  if (!labels.includes("larger")) missing.push("the larger model did not run");
  for (const rep of reports) {
    const s = summarize(rep.rows);
    const want = s.trials * cases;
    if (s.main.four.total !== want || s.main.single.total !== want) missing.push(`${rep.label}: ${s.main.four.total}+${s.main.single.total} main rows, expected ${want}+${want}`);
    if (s.held_ids.size !== heldOut) missing.push(`${rep.label}: the held-out set has ${s.held_ids.size} of ${heldOut} utterances`);
    else if (s.held.four.total !== s.trials * heldOut || s.held.single.total !== s.trials * heldOut) missing.push(`${rep.label}: held-out rows are missing`);
    const m = margin(s.main.four.total), mh = margin(s.held.four.total);
    gate(`${rep.label}: four tools against one, the 40`, s.main.four.correct >= s.main.single.correct - m, `four ${pct(s.main.four.correct, s.main.four.total)}, single ${pct(s.main.single.correct, s.main.single.total)}, margin ${m}`);
    gate(`${rep.label}: four tools against one, held out`, s.held.four.total > 0 && s.held.four.correct >= s.held.single.correct - mh, `four ${pct(s.held.four.correct, s.held.four.total)}, single ${pct(s.held.single.correct, s.held.single.total)}, margin ${mh}`);
    gate(`${rep.label}: held-out requests the product offers the right tool for`, s.held_offered.size >= Math.ceil(heldOut * HELD_OUT_MIN_OFFERED / 20), `${s.held_offered.size} of ${s.held_ids.size}`);
    gate(`${rep.label}: no turn that had to act ended on a claim`, s.untruthful.length === 0, s.untruthful.length ? s.untruthful.join(", ") : "0 turns");
    if (s.forced.total) gate(`${rep.label}: a forced call arrives in the first request`, share(s.forced.first_call, s.forced.total) >= FORCED_MIN, `${pct(s.forced.first_call, s.forced.total)} (needs ${FORCED_MIN})`);
    if (s.backstop.total) gate(`${rep.label}: with nothing forced, a must-run turn still gets done`, share(s.backstop.done, s.backstop.total) >= BACKSTOP_MIN, `${pct(s.backstop.done, s.backstop.total)} done (${s.backstop.corrected} after the corrective round), ${s.backstop.could_not} ended on the could-not line (needs ${BACKSTOP_MIN})`);
    if (rep.label === "quick" && share(s.main.four.correct, s.main.four.total) < QUICK_FLOOR) flags.push(`quick: four-tool ${pct(s.main.four.correct, s.main.four.total)} is under ${QUICK_FLOOR}`);
  }
  const complete = missing.length === 0;
  return { pass: complete && gates.every((g) => g.pass), complete, missing, gates, flags };
}

export const readRows = (file) => readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

function main() {
  const files = process.argv.slice(2).filter((a) => a.startsWith("--in=")).map((a) => a.slice(5));
  if (!files.length) { console.error("usage: report.mjs --in=<quick.jsonl> --in=<larger.jsonl>"); process.exit(2); }
  const reports = files.map((f) => { const rows = readRows(f); const head = rows.find((r) => r.header) || {}; return { label: head.label || f, engine: head.engine, rows: rows.filter((r) => !r.header) }; });
  const v = verdict(reports);
  for (const rep of reports) {
    const s = summarize(rep.rows);
    console.log(`\n${rep.label} (${rep.engine || "?"}), ${s.trials} trial(s)`);
    console.log(`  the 40:    four ${pct(s.main.four.correct, s.main.four.total)}   single ${pct(s.main.single.correct, s.main.single.total)}`);
    console.log(`  held out:  four ${pct(s.held.four.correct, s.held.four.total)}   single ${pct(s.held.single.correct, s.held.single.total)}   right tool offered on ${s.held_offered.size} of ${s.held_ids.size}`);
    console.log(`  must-run:  ${s.must_cases.size} utterances; forced ${pct(s.forced.first_call, s.forced.total)} first-request calls; unforced ${pct(s.backstop.done, s.backstop.total)} done, ${s.backstop.could_not} could-not lines`);
    for (const w of s.wrong.slice(0, 60)) console.log(`    wrong  ${w}`);
  }
  console.log("");
  for (const g of v.gates) console.log(`${g.pass ? "PASS" : "FAIL"}  ${g.id}: ${g.detail}`);
  for (const f of v.flags) console.log(`FLAG  ${f}`);
  for (const m of v.missing) console.log(`MISSING  ${m}`);
  console.log(v.pass ? "\nVERDICT: every gate passed." : v.complete ? "\nVERDICT: STOP. A gate failed. Take these numbers to the operator; do not adjust anything to make it pass." : "\nNO VERDICT: the run is incomplete.");
  process.exit(v.pass ? 0 : v.complete ? 5 : 6);
}
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main();
