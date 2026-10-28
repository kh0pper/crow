/** Comment loop Phase 1, Task 9: the shadow report scores the I-7 exit criteria from the real event log. */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let R, ST, ID, createDbClient, initWorkspaceTables, home;
const T0 = 1_800_000_000_000;
before(async () => {
  home = mkdtempSync(join(tmpdir(), "ws-shadow-"));
  mkdirSync(join(home, "data"), { recursive: true });
  process.env.CROW_HOME = home; process.env.CROW_DATA_DIR = join(home, "data");
  ({ createDbClient } = await import("../servers/db.js"));
  ({ initWorkspaceTables } = await import("../bundles/workspace/server/init-tables.js"));
  R = await import("../bundles/workspace/server/comments/shadow-report.js");
  ST = await import("../bundles/workspace/server/comments/store.js");
  ID = await import("../bundles/workspace/server/comments/identity.js");
});
let n = 0;
async function fresh() {
  const db = createDbClient(join(home, "data", `t${++n}.db`));
  await initWorkspaceTables(db);
  return db;
}
const ev = (db, kind, fileId, detail, at = T0) => ST.logEvent(db, { at, fileId, kind, detail });
const rep = (db, i, { fp = `fp${i}`, pair = `pair${i}`, latency = 500, at = T0 + i } = {}) =>
  ev(db, "live_report", 1, { source: "live", pair, fp, latency_ms: latency }, at);
const scan = (db, i, { fp = `fp${i}`, pair = `pair${i}`, at = T0 + i } = {}) => ev(db, "scan_new", 1, { source: "saved", pair, fp }, at);
const run = (db) => R.shadowReport(db, { sinceMs: 0, nowMs: T0 + 1e6 });

async function pairsOf(db, count, mismatches = 0) {
  for (let i = 0; i < count; i++) { await rep(db, i); await scan(db, i, { fp: i < mismatches ? `other${i}` : `fp${i}` }); }
}

test("30 matched pairs, 30 equal fps → pairs 30, fpMatchPct 100, exit.pairs && exit.fpMatch", async () => {
  const db = await fresh(); await pairsOf(db, 30);
  const r = await run(db);
  assert.equal(r.pairs, 30); assert.equal(r.fpMatchPct, 100);
  assert.ok(r.exit.pairs && r.exit.fpMatch);
});

test("29 pairs → exit.pairs false; one mismatch in 100 → 99 % passes, two → fails", async () => {
  let db = await fresh(); await pairsOf(db, 29);
  assert.equal((await run(db)).exit.pairs, false);
  db = await fresh(); await pairsOf(db, 100, 1);
  let r = await run(db); assert.equal(r.fpMatchPct, 99); assert.equal(r.exit.fpMatch, true);
  db = await fresh(); await pairsOf(db, 100, 2);
  r = await run(db); assert.equal(r.fpMatchPct, 98); assert.equal(r.exit.fpMatch, false);
});

test("a second would_fire for the same fp → refires 1, exit.reopen false", async () => {
  const db = await fresh();
  const d = { source: "saved", pair: "p", fp: "f", reason: ID.VERDICT_REASONS.OWNER_VERIFIED, sole: true, age_s: 5 };
  await ev(db, "would_fire", 1, d, T0); await ev(db, "would_fire", 1, d, T0 + 1);
  const r = await run(db);
  assert.equal(r.refires, 1); assert.equal(r.exit.reopen, false);
});

test("latency p95 from live_report add events only; 3001 ms p95 fails", async () => {
  let db = await fresh();
  for (let i = 0; i < 20; i++) { await rep(db, i, { latency: i === 19 ? 3001 : 100 }); await scan(db, i); }
  await ev(db, "live_report", 1, { source: "live", pair: "x", fp: "chg", latency_ms: null }); // a change: no latency
  let r = await run(db);
  assert.equal(r.latency.p95, 100); assert.equal(r.latency.max, 3001); assert.equal(r.exit.latency, true);
  db = await fresh();
  for (let i = 0; i < 20; i++) { await rep(db, i, { latency: i >= 18 ? 3001 : 100 }); await scan(db, i); }
  r = await run(db);
  assert.equal(r.latency.p95, 3001); assert.equal(r.exit.latency, false);
});

test("no live_report → exit.liveReport false (E8 unanswered)", async () => {
  const db = await fresh(); await scan(db, 1);
  const r = await run(db);
  assert.equal(r.liveReports, 0); assert.equal(r.exit.liveReport, false);
});

test("unresolvedKeys counts unresolved_key events (I-6)", async () => {
  const db = await fresh();
  await ev(db, "unresolved_key", null, { source: "live", hinted: true }); await ev(db, "unresolved_key", null, { source: "live", hinted: false });
  assert.equal((await run(db)).unresolvedKeys, 2);
});

test("two live reports for one pair from two tabs count as 1 pair and 0 refires", async () => {
  const db = await fresh();
  await rep(db, 1, { at: T0 }); await rep(db, 1, { at: T0 + 1 }); await scan(db, 1);
  const wf = { source: "live", pair: "pair1", fp: "fp1", sole: true, age_s: 1 };
  await ev(db, "would_fire", 1, wf); await ev(db, "would_fire", 1, wf, T0 + 1);
  const r = await run(db);
  assert.equal(r.pairs, 1); assert.equal(r.fpMatchPct, 100); assert.equal(r.refires, 0); assert.equal(r.liveDuplicateFanout, 1);
});

test("a live+saved would_fire of the same fp gives 0 refires", async () => {
  const db = await fresh();
  await ev(db, "would_fire", 1, { source: "live", pair: "p", fp: "f", sole: true });
  await ev(db, "would_fire", 1, { source: "saved", pair: "p", fp: "f", sole: true }, T0 + 5);
  assert.equal((await run(db)).refires, 0);
});

test("a second saved would_fire for the same (file_id, fp) gives refires 1; other file is not a refire", async () => {
  const db = await fresh();
  const d = { source: "saved", pair: "p", fp: "f", sole: true };
  await ev(db, "would_fire", 1, d); await ev(db, "would_fire", 2, d, T0 + 1); await ev(db, "would_fire", 1, d, T0 + 2);
  assert.equal((await run(db)).refires, 1);
});

test("live reports that disagree within a pair count as a mismatch; unverifiedSoleRate and oldWouldFire", async () => {
  const db = await fresh();
  await rep(db, 1, { fp: "a" }); await rep(db, 1, { fp: "b" }); await scan(db, 1, { fp: "a" });
  const R_ = ID.VERDICT_REASONS;
  await ev(db, "unverified", 1, { source: "saved", fp: "u", sole: true, reason: R_.UNVERIFIED_AUTHOR });
  await ev(db, "unverified", 1, { source: "saved", fp: "d", sole: true, reason: R_.DATE_UNKNOWN });
  await ev(db, "would_fire", 1, { source: "saved", fp: "w", sole: true, reason: R_.OWNER_VERIFIED, age_s: 700, snippet: "hi" });
  const r = await run(db);
  assert.equal(r.fpMatchPct, 0); assert.equal(r.unverifiedSoleRate, 0.5);
  assert.equal(r.oldWouldFire.length, 1); assert.equal(r.oldWouldFire[0].snippet, "hi");
  assert.equal((await run(await fresh())).unverifiedSoleRate, null);
});

// ---- final fix wave ---------------------------------------------------------------------------------------------
test("I1: saved refires are keyed by (file_id, pair, hash): an anchored-text edit (new fp, same pair and text) is a refire", async () => {
  const db = await fresh();
  const d = { source: "saved", pair: "p", hash: "h1", reason: ID.VERDICT_REASONS.OWNER_VERIFIED, sole: true, age_s: 5 };
  await ev(db, "would_fire", 1, { ...d, fp: "f1" }); await ev(db, "would_fire", 1, { ...d, fp: "f2" }, T0 + 1);
  let r = await run(db);
  assert.equal(r.refires, 1); assert.equal(r.exit.reopen, false);
  // the same pair with another text (an edit that added a mention) is not a refire; nor is another file
  const db2 = await fresh();
  await ev(db2, "would_fire", 1, { ...d, fp: "f1" }); await ev(db2, "would_fire", 1, { ...d, fp: "f2", hash: "h2" }, T0 + 1);
  await ev(db2, "would_fire", 2, { ...d, fp: "f1" }, T0 + 2);
  r = await run(db2);
  assert.equal(r.refires, 0); assert.equal(r.exit.reopen, true);
});

test("I1: exit.reopen also needs zero old would_fire (spec I-7), with zero refires", async () => {
  const db = await fresh();
  await ev(db, "would_fire", 1, { source: "saved", pair: "p", hash: "h", fp: "f", sole: true, reason: ID.VERDICT_REASONS.OWNER_VERIFIED, age_s: 3600, snippet: "old" });
  const r = await run(db);
  assert.equal(r.refires, 0); assert.equal(r.oldWouldFire.length, 1);
  assert.equal(r.exit.reopen, false);
});

test("M1: latency counts only live reports whose fp a saved scan_new of the same pair also has", async () => {
  const db = await fresh();
  for (let i = 0; i < 5; i++) { await rep(db, i, { latency: 100 }); await scan(db, i); }
  await rep(db, 10, { latency: 9000 }); // never saved
  await rep(db, 11, { latency: 8000 }); await scan(db, 11, { fp: "other" }); // saved with another fp
  const r = await run(db);
  assert.equal(r.latency.max, 100); assert.equal(r.exit.latency, true);
  assert.equal((await run(await fresh())).latency.p95, null);
});
