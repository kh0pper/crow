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

/**
 * The comparison is PAIRED: the two arms of one utterance in one trial ran back to back. Four tools
 * are stopped only when they are worse than one beyond chance: a one-sided exact sign test on the
 * pairs where the arms disagree, at SIGN_ALPHA per comparison. There are four comparisons (two models
 * × the 40 and the held-out 20), so the chance that two equal surfaces are stopped is at most 0.10.
 * The point estimates are printed either way.
 */
export const SIGN_ALPHA = 0.025;
/** An absolute floor per model on the four-tool arm's share of correct turns on the 40 (a gate). */
export const FLOORS = Object.freeze({ quick: 0.75, larger: 0.8 });
export const HELD_OUT_MIN_OFFERED = 17;   // of 20
export const FORCED_MIN = 0.9;
export const BACKSTOP_MIN = 0.7;

const LN2 = Math.log(2);
const lfact = (n) => { let s = 0; for (let k = 2; k <= n; k += 1) s += Math.log(k); return s; };
/** One-sided exact sign test: P(at least `worse` of the n = better + worse disagreeing pairs go against four tools | no difference). */
export function signTestP(better, worse) {
  const n = better + worse;
  if (n === 0) return 1;
  const ln = lfact(n);
  let p = 0;
  for (let k = worse; k <= n; k += 1) p += Math.exp(ln - lfact(k) - lfact(n - k) - n * LN2);
  return Math.min(1, p);
}
/** rows of ONE model and one set → the pairs: { pairs, better (four right, single wrong), worse (four wrong, single right) }. */
export function paired(rows, set) {
  const by = new Map();
  for (const r of rows) if ((r.set === "held" ? "held" : "main") === set) {
    const k = `${r.trial}|${r.id}`;
    by.set(k, { ...by.get(k), [r.arm]: r.ok === true });
  }
  let pairs = 0, better = 0, worse = 0;
  for (const v of by.values()) {
    if (typeof v.four !== "boolean" || typeof v.single !== "boolean") continue;
    pairs += 1;
    if (v.four && !v.single) better += 1;
    if (!v.four && v.single) worse += 1;
  }
  return { pairs, better, worse, p: signTestP(better, worse) };
}

const share = (n, d) => (d ? n / d : 0);
const pct = (n, d) => `${n}/${d}`;

/** rows of ONE model → its figures. */
export function summarize(rows) {
  const out = { main: { four: { correct: 0, total: 0 }, single: { correct: 0, total: 0 } }, held: { four: { correct: 0, total: 0 }, single: { correct: 0, total: 0 } },
    held_ids: new Set(), held_offered: new Set(), untruthful: [], plain_window: { total: 0, changed: 0 }, skipped: 0, forced: { total: 0, first_call: 0 }, backstop: { total: 0, done: 0, corrected: 0, could_not: 0 }, must_cases: new Set(), wrong: [], trials: 0 };
  for (const r of rows) {
    const set = r.set === "held" ? "held" : "main";
    const cell = out[set][r.arm];
    cell.total += 1;
    if (r.ok) cell.correct += 1; else out.wrong.push(`${r.id}/${r.arm}/t${r.trial}: ${r.offered_expected ? (r.tools.join(" → ") || "no call") : "expected tool not offered"}${r.failed ? ` (${r.failed})` : ""}`);
    out.trials = Math.max(out.trials, r.trial + 1);
    if (r.ran === false) out.skipped += 1;
    if (r.arm === "four" && r.plain && r.window_open) { out.plain_window.total += 1; if (r.changed) out.plain_window.changed += 1; }
    if (set === "held") { out.held_ids.add(r.id); if (r.offered_expected) out.held_offered.add(r.id); }
    // Only a turn that RAN can have ended on a claim or been done: a row where the product never offered the
    // expected tool (ran === false) is a wrong answer and a held-out offer miss, and nothing else.
    if (r.arm !== "four" || !r.must || r.ran === false) continue;
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
  // The "shipped" leg (the display as WM1a ships it: no sources, no items, no media session) is
  // reported, never gated: the gated legs run the fixture display, which is the WM1b surface.
  for (const rep of reports.filter((r) => r.label !== "shipped")) {
    const s = summarize(rep.rows);
    const want = s.trials * cases;
    if (s.main.four.total !== want || s.main.single.total !== want) missing.push(`${rep.label}: ${s.main.four.total}+${s.main.single.total} main rows, expected ${want}+${want}`);
    if (s.held_ids.size !== heldOut) missing.push(`${rep.label}: the held-out set has ${s.held_ids.size} of ${heldOut} utterances`);
    else if (s.held.four.total !== s.trials * heldOut || s.held.single.total !== s.trials * heldOut) missing.push(`${rep.label}: held-out rows are missing`);
    for (const [set, name] of [["main", "the 40"], ["held", "held out"]]) {
      const pr = paired(rep.rows, set), cell = s[set];
      const diff = cell.four.total ? Math.round(((cell.four.correct - cell.single.correct) / cell.four.total) * 1000) / 10 : 0;
      gate(`${rep.label}: four tools against one, ${name} (paired)`, pr.pairs > 0 && !(pr.worse > pr.better && pr.p < SIGN_ALPHA),
        `four ${pct(cell.four.correct, cell.four.total)}, single ${pct(cell.single.correct, cell.single.total)}, difference ${diff > 0 ? "+" : ""}${diff} points; of ${pr.pairs} pairs four was right alone on ${pr.better}, wrong alone on ${pr.worse}; one-sided p = ${pr.p.toFixed(4)} (stop below ${SIGN_ALPHA})`);
    }
    // A plain question asked while a window is open must never change the screen (four-tool arm, every trial).
    gate(`${rep.label}: no plain question with a window open changed the screen`, s.plain_window.changed === 0, `${s.plain_window.changed} of ${s.plain_window.total} turns`);
    if (Object.hasOwn(FLOORS, rep.label)) gate(`${rep.label}: the four-tool arm is right on at least ${FLOORS[rep.label]} of the 40`, share(s.main.four.correct, s.main.four.total) >= FLOORS[rep.label], `${pct(s.main.four.correct, s.main.four.total)}`);
    gate(`${rep.label}: held-out requests the product offers the right tool for`, s.held_offered.size >= Math.ceil(heldOut * HELD_OUT_MIN_OFFERED / 20), `${s.held_offered.size} of ${s.held_ids.size}`);
    gate(`${rep.label}: no turn that had to act ended on a claim`, s.untruthful.length === 0, s.untruthful.length ? s.untruthful.join(", ") : "0 turns");
    if (s.forced.total) gate(`${rep.label}: a forced call arrives in the first request`, share(s.forced.first_call, s.forced.total) >= FORCED_MIN, `${pct(s.forced.first_call, s.forced.total)} (needs ${FORCED_MIN})`);
    if (s.backstop.total) gate(`${rep.label}: with nothing forced, a must-run turn still gets done`, share(s.backstop.done, s.backstop.total) >= BACKSTOP_MIN, `${pct(s.backstop.done, s.backstop.total)} done (${s.backstop.corrected} after the corrective round), ${s.backstop.could_not} ended on the could-not line (needs ${BACKSTOP_MIN})`);
  }
  const complete = missing.length === 0;
  return { pass: complete && gates.every((g) => g.pass), complete, missing, gates, flags };
}

export const readRows = (file) => readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

function main() {
  const files = process.argv.slice(2).filter((a) => a.startsWith("--in=")).map((a) => a.slice(5));
  if (!files.length) { console.error("usage: report.mjs --in=<quick.jsonl> --in=<larger.jsonl>"); process.exit(2); }
  const reports = files.map((f) => { const rows = readRows(f); const head = rows.find((r) => r.header) || {}; return { label: head.label || f, engine: head.engine, run: head.run || null, head: head.head || null, rows: rows.filter((r) => !r.header) }; });
  const v = verdict(reports);
  console.log("The gated figures are measured on a fixture display with three sources, four launcher items and a media session (the surface WM1b ships). The 'shipped' leg, when present, is the display as this release ships it (show and window tools only) and is not gated.");
  for (const rep of reports) {
    const s = summarize(rep.rows);
    console.log(`\n${rep.label} (${rep.engine || "?"}), ${s.trials} trial(s)${rep.label === "shipped" ? " — informational" : ""}${rep.run ? `, run ${rep.run}` : ""}${rep.head ? `, head ${String(rep.head).slice(0, 12)}` : ""}`);
    console.log(`  the 40:    four ${pct(s.main.four.correct, s.main.four.total)}   single ${pct(s.main.single.correct, s.main.single.total)}`);
    console.log(`  held out:  four ${pct(s.held.four.correct, s.held.four.total)}   single ${pct(s.held.single.correct, s.held.single.total)}   right tool offered on ${s.held_offered.size} of ${s.held_ids.size}`);
    console.log(`  rows where no turn ran (the expected tool was not offered, or a no-model path answered): ${s.skipped}`);
    console.log(`  plain questions with a window open that changed the screen anyway: ${s.plain_window.changed} of ${s.plain_window.total} (four-tool arm; gate: 0)`);
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
