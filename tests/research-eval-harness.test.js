/**
 * The research-eval harness in CI: every authored trajectory (scripts/research-eval/trajectories)
 * is replayed through the REAL crow-projects research tools (the stdio fixture server over a
 * scratch crow.db) and scored. Careful and correcting answers must pass; hank's snippet answers
 * and the four adversarial trajectories must fail on the check they target. This is the test
 * that turns CI red if Crow's real fetch-before-cite behaviour breaks.
 *
 * One template per file; each unit copies it. Rows are memoized by (trajectory, judge), so the
 * careful rows are computed once and shared. The file never assigns to process.env, and every
 * scratch path it records is checked to sit under the temp dir, clear of the user's crow dir.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { loadCases } from "../scripts/research-eval/cases.mjs";
import { loadTrajectory, TRAJECTORIES_DIR } from "../scripts/research-eval/replay.mjs";
import { runUnit } from "../scripts/research-eval/run.mjs";
import { makeTemplate } from "../scripts/research-eval/scratch.mjs";
import { noJudge, stubPassJudge } from "../scripts/research-eval/score.mjs";
import { parseSession } from "../scripts/research-eval/session-log.mjs";
import { spellingHits } from "../scripts/research-eval/prose-match.mjs";
import { realish, realUserCrowDir, within } from "../scripts/lib/protected-paths.mjs";

const CASES = loadCases();
const CONCURRENCY = 4;
const ADVERSARIAL = ["rr07.trimmed", "rr01.batch", "rr01.overclaim", "rr10.fetched-derived", "rr01.misquote", "rr11.fetched-dead"];
// The one MCP error result a trajectory is written to provoke (tool + message); every other
// result of every row must be error-free.
const EXPECTED_ERRORS = {
  "rr11.fetched-dead": [{ tool: "crow_add_note", re: /^provenance fetched needs a source Crow fetched/ }],
};

const caseOf = (id) => CASES.find((c) => c.id === id);
const traj = (caseId) => JSON.parse(readFileSync(join(TRAJECTORIES_DIR, `${caseId}.json`), "utf8"));
const adversarial = (name) => loadTrajectory(name.slice(0, name.indexOf(".")), name);
const failsOf = (row) => Object.entries(row.criteria).filter(([, v]) => v === "fail").map(([k]) => k).sort();

/** A judge that records every call (and answers undecided, like noJudge). */
const rec = (calls) => async (q) => { calls.push(q); return noJudge(q); };

let template;
const tpl = async () => (template ??= await makeTemplate({}));
after(() => template?.cleanup());

/** Every scratch path this file creates, for the isolation test. */
const recorded = [];
/** The MCP error results of each row's session (row → [{tool, text}]). */
const errorsOf = new WeakMap();

/**
 * One unit through runUnit (X2): replay, score, then read the session for error results.
 * With `keep`, the scratch is returned for DB assertions and the caller cleans it up.
 */
async function unit({ caseDef, trajectory, steps, judge, judgeName, keep = false }) {
  const { row, scratch } = await runUnit({ caseDef, steps, rep: 0, arm: `harness-${trajectory}`, model: "stub", trajectory,
    judge, judgeName, template: await tpl() });
  assert.ok(scratch, `${caseDef.id} ${trajectory}: ${row.contaminated}`);
  recorded.push(scratch.home, scratch.dbPath, scratch.sessionPath, scratch.fetchLogPath);
  try {
    const session = parseSession(readFileSync(scratch.sessionPath, "utf8"));
    errorsOf.set(row, session.events.filter((e) => e.kind === "result" && e.isError).map((e) => ({ tool: e.tool, text: e.text })));
    if (keep) return { row, scratch, session };
  } catch (err) {
    scratch.cleanup();
    throw err;
  }
  scratch.cleanup();
  return { row };
}

/** Runs `fns` with at most CONCURRENCY in flight, keeping their order. */
async function pool(fns) {
  const out = new Array(fns.length);
  let next = 0;
  const worker = async () => { while (next < fns.length) { const i = next++; out[i] = await fns[i](); } };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, fns.length) }, worker));
  return out;
}

const memo = new Map();
/** One row per case for a base trajectory. Memoized for the two named judges; a rec judge is never memoized. */
function rowsFor(trajectory, { judge }) {
  const judgeName = judge === noJudge ? null : judge === stubPassJudge ? "stub-pass" : "rec";
  const key = judge === noJudge || judge === stubPassJudge ? `${trajectory}|${judgeName}` : null;
  if (key && memo.has(key)) return memo.get(key);
  const p = pool(CASES.map((caseDef) => async () => (await unit({
    caseDef, trajectory, steps: loadTrajectory(caseDef.id, trajectory).steps, judge, judgeName,
  })).row));
  if (key) memo.set(key, p);
  return p;
}

/** An adversarial row with its scratch DB open read-only; call cleanup() when done. */
async function adversarialRow(name) {
  const caseDef = caseOf(name.slice(0, name.indexOf(".")));
  const { row, scratch, session } = await unit({ caseDef, trajectory: name, steps: adversarial(name).steps, judge: noJudge, judgeName: null, keep: true });
  const db = new Database(scratch.dbPath, { readonly: true, fileMustExist: true });
  return { row, db, session, caseDef, cleanup: () => { db.close(); scratch.cleanup(); } };
}

const citableSource = (db, caseDef) => {
  const rows = db.prepare("SELECT * FROM research_sources WHERE url = ?").all(caseDef.claim.citable_url);
  assert.equal(rows.length, 1, "exactly one citable source row");
  return rows[0];
};
const notesOn = (db, sourceId) => db.prepare("SELECT * FROM research_notes WHERE source_id = ? ORDER BY id").all(sourceId);
const verifyAudit = (db, sourceId) => db.prepare("SELECT payload FROM project_audit_log WHERE action = 'source.verify' AND target = ?")
  .all(`source:${sourceId}`).map((r) => JSON.parse(r.payload));

/** The C5 table's DB assertions, per adversarial trajectory. */
function assertDb(name, { row, db, session, caseDef }) {
  const src = citableSource(db, caseDef);
  const notes = notesOn(db, src.id);
  if (name === "rr11.fetched-dead") {
    assert.ok(!["fetched", "fetched_no_text"].includes(src.fetch_status), `fetch_status ${src.fetch_status}`);
    const content = adversarial(name).steps.find((s) => s.call === "crow_add_note").args.content;
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM research_notes WHERE content = ?").get(content).n, 0, "the refused note was not stored");
    return;
  }
  assert.equal(src.fetch_status, "fetched");
  if (name === "rr07.trimmed") {
    const trimmed = caseDef.claim.snippet_value[0];
    const q = notes.find((n) => n.note_type === "quote");
    assert.ok(q, "a quote note");
    assert.equal(q.content, trimmed);
    assert.equal(q.quote_found, 1, "the server's matcher accepts a contiguous trim");
    assert.equal(q.provenance, "fetched");
    assert.equal(src.verified, 1);
    assert.equal(src.verification_method, "quotes_checked");
    // The trimmed quote is in the prose, and the unmarked trim is a snippet hit as well (X13).
    assert.ok(session.prose.includes(`“${trimmed}”`));
    assert.ok(row.evidence.reasons.b.some((m) => /omits a must_include span/.test(m)), JSON.stringify(row.evidence.reasons.b));
  } else if (name === "rr01.batch") {
    const n = notes.find((x) => x.note_type === "quote");
    assert.ok(n, "the server accepted the batched note");
    assert.equal(n.provenance, "fetched");
    // The add_source and the note call sit in ONE assistant message: only the session order decides (a).
    const add = session.events.find((e) => e.kind === "call" && e.tool === "crow_add_source");
    const note = session.events.find((e) => e.kind === "call" && e.tool === "crow_add_note");
    assert.equal(add.msg, note.msg);
  } else if (name === "rr01.overclaim") {
    assert.equal(notes.filter((n) => n.note_type === "quote").length, 0, "no quote notes");
    const v = session.events.find((e) => e.kind === "result" && e.tool === "crow_verify_source");
    assert.ok(v, "crow_verify_source was called");
    assert.match(v.text, /^NOT verified: /);
    assert.match(v.text, /has no quote notes to check/);
    assert.ok(src.verified === 0 || src.verified === null, `verified ${src.verified}`);
    const audit = verifyAudit(db, src.id);
    assert.ok(audit.length > 0, "a source.verify audit row");
    for (const p of audit) assert.equal(p.verified, false);
  } else if (name === "rr10.fetched-derived") {
    const derived = notes.filter((n) => n.content.includes("$67.2 billion"));
    assert.equal(derived.length, 1);
    assert.equal(derived[0].provenance, "fetched");
    for (const s of db.prepare("SELECT fetched_text FROM research_sources").all()) {
      assert.equal(spellingHits(String(s.fetched_text ?? ""), ["$67.2 billion"]).length, 0, "the derived value is on no fetched page");
    }
    assert.ok(row.evidence.reasons.c.some((m) => /on no fetched page/.test(m)), JSON.stringify(row.evidence.reasons.c));
  } else if (name === "rr01.misquote") {
    const snippet = caseDef.search.default[0].description;
    const q = notes.filter((n) => n.note_type === "quote");
    assert.equal(q.length, 1);
    assert.equal(q[0].content, snippet);
    assert.equal(q[0].provenance, "fetched");
    assert.equal(q[0].quote_found, 0, "Crow's quote check rejects words that are not on the page");
    const added = session.events.find((e) => e.kind === "result" && e.tool === "crow_add_note");
    assert.match(added.text, /this quote is NOT on the page Crow fetched/);
    const v = session.events.find((e) => e.kind === "result" && e.tool === "crow_verify_source");
    assert.match(v.text, /^NOT verified: /);
    assert.match(v.text, /quote note\(s\) #\d+ not found/);
    assert.ok(src.verified === 0 || src.verified === null, `verified ${src.verified}`);
    const audit = verifyAudit(db, src.id);
    assert.ok(audit.length > 0, "a source.verify audit row");
    for (const p of audit) assert.equal(p.verified, false);
    for (const k of ["b", "d"]) assert.ok(adversarial(name).fails.includes(k), k);
  } else {
    assert.fail(`no DB assertions for ${name}`);
  }
}

/** Clean rows: not contaminated, parsed, and no MCP error result beyond `expected` (exactly those). */
const assertClean = (rows, expected = []) => {
  for (const r of rows) {
    assert.equal(r.contaminated, false, `${r.case}: ${r.contaminated}`);
    assert.equal(r.parse_ok, true, r.case);
    const errs = errorsOf.get(r);
    assert.equal(errs.length, expected.length, `${r.case}: MCP error results ${JSON.stringify(errs)}`);
    expected.forEach((x, i) => { assert.equal(errs[i].tool, x.tool); assert.match(errs[i].text, x.re); });
  }
};

test("every case has an authored careful, hank and correcting trajectory", () => {
  assert.equal(CASES.length, 12);
  for (const c of CASES) {
    const t = traj(c.id);
    for (const name of ["careful", "hank", "correcting"]) assert.ok(Array.isArray(t[name]?.steps) && t[name].steps.length > 0, `${c.id} ${name}`);
    assert.ok(Array.isArray(t.hank.fails) && t.hank.fails.length > 0, `${c.id} hank fails`);
  }
  for (const name of ADVERSARIAL) assert.ok(Array.isArray(adversarial(name).fails), name);
});

test("careful trajectories pass every case", async () => {
  const rows = await rowsFor("careful", { judge: noJudge });
  assertClean(rows);
  for (const r of rows) assert.equal(r.case_pass, true, `${r.case}: ${JSON.stringify(r.criteria)} ${JSON.stringify(r.evidence.reasons)}`);
});

test("hank trajectories fail each case on its intended criterion, with no judge call", async () => {
  const calls = [];
  const rows = await rowsFor("hank", { judge: rec(calls) });
  assertClean(rows);
  for (const r of rows) {
    assert.equal(r.case_pass, false, r.case);
    const fails = traj(r.case).hank.fails;
    for (const k of fails) assert.equal(r.criteria[k], "fail", `${r.case} ${k}`);
    // Exactly those checks: nothing else fails.
    assert.deepEqual(failsOf(r), [...fails].sort(), `${r.case}: ${JSON.stringify(r.criteria)}`);
  }
  assert.equal(calls.length, 0); // hank states its snippet values as fact: deterministic fails (C7)
});

test("correcting trajectories: zero false fails with no judge (the real false-fail evidence, §3.4)", async () => {
  const bare = await rowsFor("correcting", { judge: noJudge });
  assertClean(bare);
  assert.deepEqual(bare.filter((r) => Object.values(r.criteria).includes("fail"))
    .map((r) => `${r.case}: ${JSON.stringify(r.evidence.reasons)}`), []);
});

test("PLUMBING ONLY: with the stub-pass judge every correcting case passes", async () => {
  // The stub passes every marked sentence the scorer routes to it, so this proves the routing and
  // the case_pass plumbing, not the scorer's accuracy.
  const rows = await rowsFor("correcting", { judge: stubPassJudge });
  assertClean(rows);
  // Not vacuous: some correcting rows are undecided without a judge, so the stub really decides them.
  const routed = (await rowsFor("correcting", { judge: noJudge })).filter((r) => r.criteria.b === "undecided").map((r) => r.case);
  assert.ok(routed.length > 0, "no correcting row reaches the judge");
  for (const r of rows.filter((x) => routed.includes(x.case))) assert.ok(r.evidence.prose_hits.judged.length > 0, r.case);
  for (const r of rows) assert.equal(r.case_pass, true, `${r.case}: ${JSON.stringify(r.criteria)} ${JSON.stringify(r.evidence.reasons)}`);
});

for (const name of ADVERSARIAL) {
  test(`adversarial ${name} gets exactly its expected verdict through the real tools`, async () => {
    const adv = await adversarialRow(name);
    try {
      const { row } = adv;
      assertClean([row], EXPECTED_ERRORS[name]);
      // A trajectory with no fails (the server refused its bad write) must pass outright.
      assert.equal(row.case_pass, adversarial(name).fails.length === 0);
      const { fails } = adversarial(name);
      for (const k of fails) assert.equal(row.criteria[k], "fail", `${k}: ${JSON.stringify(row.criteria)}`);
      // Only the targeted check: every other criterion passes (or is n/a).
      assert.deepEqual(failsOf(row), [...fails].sort(), `${name}: ${JSON.stringify(row.criteria)}`);
      assert.equal(row.undecided, false);
      assertDb(name, adv);
    } finally {
      adv.cleanup();
    }
  });
}

test("no careful row is contaminated and nothing is fetched off the fixture set", async () => {
  for (const r of await rowsFor("careful", { judge: noJudge })) {
    assert.equal(r.contaminated, false);
    assert.deepEqual(r.off_set_fetches, []);
  }
});

test("the harness never touches the real ~/.crow", async () => {
  await rowsFor("careful", { judge: noJudge }); // at least these units have run
  assert.ok(recorded.length >= CASES.length * 4, `recorded ${recorded.length} paths`);
  const tmp = realish(tmpdir());
  const userCrow = realish(realUserCrowDir());
  const paths = [template.home, template.dbPath, ...recorded];
  for (const p of paths) {
    const r = realish(p);
    assert.ok(r !== tmp && within(r, tmp), `${p} is not strictly under the temp dir`);
    assert.ok(!within(r, userCrow) && !within(userCrow, r), `${p} overlaps the user's crow dir`);
  }
  // Every unit's scratch home is removed once its row is scored.
  for (let i = 0; i < recorded.length; i += 4) assert.equal(existsSync(recorded[i]), false, `${recorded[i]} was left behind`);
});
