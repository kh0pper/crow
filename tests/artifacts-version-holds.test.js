// Crow Artifacts — version holds (D14): a version that was sent to someone, or
// that a link points at, is never pruned while its hold is live. Also the
// addVersion batch seam (R2-11): a caller's row is written with the version or
// not at all.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { markdownBlocks } from "../servers/blog/renderer.js";
import { initArtifactsTables } from "../bundles/artifacts/server/init-tables.js";
import { createLocalBlobStore } from "../bundles/artifacts/server/blob-store.js";
import * as store from "../bundles/artifacts/server/store.js";
import { LIMITS } from "../bundles/artifacts/server/limits.js";

const deps = { markdownBlocks };
const OWNER = { kind: "session" };
const s = {};
const doc = (md) => ({ markdown: md, title: "T" });
const KEPT = LIMITS.versionsKept;          // 20
const LAST = KEPT + 5;                     // 25 versions: pruning is certainly active

before(async () => {
  s.dir = mkdtempSync(join(tmpdir(), "artifacts-holds-"));
  s.db = createDbClient(join(s.dir, "crow.db"));
  await initArtifactsTables(s.db);
  s.blobs = createLocalBlobStore(join(s.dir, "blobs"));
  // A caller's own table, the way the reports bridge has one.
  await s.db.execute({ sql: "CREATE TABLE run_rows (artifact_id TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (artifact_id, n))", args: [] });
});
after(() => { try { s.db.close(); } catch {} rmSync(s.dir, { recursive: true, force: true }); });

const dt = async (mod) => (await s.db.execute({ sql: "SELECT datetime('now',?) AS t", args: [mod] })).rows[0].t;
const versionNs = async (id) => (await s.db.execute({ sql: "SELECT n FROM artifact_versions WHERE artifact_id=? ORDER BY n", args: [id] })).rows.map((r) => Number(r.n));
const currentOf = async (id) => Number((await store.getArtifact(s.db, id)).current_version);

/** One artifact, versions 1..LAST, with an optional hold placed on v3 as soon
 *  as v3 exists (well before pruning could reach it). */
async function fill(title, hold = null) {
  const a = await store.createArtifact(s.db, s.blobs, { title, type: "document", source: doc(`${title} v1`), actor: OWNER }, deps);
  for (let i = 2; i <= LAST; i++) {
    await store.addVersion(s.db, s.blobs, { artifactId: a.id, source: doc(`${title} v${i}`), actor: OWNER }, deps);
    if (i === 3 && hold) await store.holdVersion(s.db, { artifactId: a.id, n: 3, ...hold });
  }
  return a;
}

test("prune never deletes a held version", async () => {
  const a = await fill("Held", { holder: "report-send:1" });
  const ns = await versionNs(a.id);
  assert.equal(ns.length, KEPT, "the unheld versions still prune to the limit");
  assert.ok(ns.includes(3), "v3 is held with no end, so it survives");
  assert.ok(ns.includes(LAST), "the current version is kept");
  assert.ok(!ns.includes(4), "an unheld neighbour of the held version still went");
});

test("an expired hold no longer protects its version", async () => {
  const a = await fill("Expired", { holder: "report-send:2", until: await dt("-1 day") });
  assert.ok(!(await versionNs(a.id)).includes(3), "a hold whose until is in the past protects nothing");
});

test("a hold with a future until protects its version", async () => {
  const a = await fill("Future", { holder: "report-link:3", until: await dt("+1 day") });
  assert.ok((await versionNs(a.id)).includes(3));
  // The same holder's second hold replaces its own row, never adds one.
  await store.holdVersion(s.db, { artifactId: a.id, n: 3, holder: "report-link:3", until: await dt("+2 days") });
  const rows = (await s.db.execute({ sql: "SELECT holder FROM artifact_version_holds WHERE artifact_id=? AND n=3", args: [a.id] })).rows;
  assert.deepEqual(rows.map((r) => r.holder), ["report-link:3"]);
});

/** The stored `until` of one (version, holder) row, or undefined. */
async function storedUntil(id, n, holder) {
  const row = (await s.db.execute({
    sql: "SELECT until FROM artifact_version_holds WHERE artifact_id=? AND n=? AND holder=?",
    args: [id, n, holder],
  })).rows[0];
  return row === undefined ? undefined : row.until;
}

const STORE_FORMAT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

test("an epoch-ms until is normalised and a future one protects its version", async () => {
  const until = Date.now() + 24 * 60 * 60 * 1000;
  const a = await fill("Epoch future", { holder: "report-send:7", until });
  const stored = await storedUntil(a.id, 3, "report-send:7");
  assert.match(stored, STORE_FORMAT, `stored as the store's own datetime text: ${stored}`);
  assert.ok((await versionNs(a.id)).includes(3), "the epoch-ms hold protects its version");
});

test("an epoch-ms until in the past protects nothing", async () => {
  const a = await fill("Epoch past", { holder: "report-send:8", until: Date.now() - 24 * 60 * 60 * 1000 });
  assert.ok(!(await versionNs(a.id)).includes(3));
});

test("a numeric-string until is read as epoch ms", async () => {
  const until = String(Date.now() - 24 * 60 * 60 * 1000);
  const a = await fill("Numeric string", { holder: "report-send:9", until });
  assert.ok(!(await versionNs(a.id)).includes(3), "the numeric string was an epoch ms, not a year");
  assert.match(await storedUntil(a.id, 3, "report-send:9"), STORE_FORMAT);
});

test("an ISO until is normalised to the store's format and a future one protects", async () => {
  const until = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const a = await fill("ISO future", { holder: "report-link:9", until });
  const stored = await storedUntil(a.id, 3, "report-link:9");
  assert.equal(stored, until.slice(0, 19).replace("T", " "), "normalised to YYYY-MM-DD HH:MM:SS UTC");
  assert.ok((await versionNs(a.id)).includes(3));
});

test("an until SQLite cannot read is a bad_request", async () => {
  const a = await fill("Garbage until");
  for (const until of ["not a time", "next tuesday", ""]) {
    await assert.rejects(store.holdVersion(s.db, { artifactId: a.id, n: LAST, holder: "report-send:10", until }),
      (e) => e.code === "bad_request" && /not a valid time/.test(e.message), `until=${JSON.stringify(until)}`);
  }
  assert.equal(await storedUntil(a.id, LAST, "report-send:10"), undefined, "a refused until writes no row");
});

test("holdVersion returns the normalised until, and null when there is no end", async () => {
  const a = await fill("Returned until");
  const held = await store.holdVersion(s.db, { artifactId: a.id, n: LAST, holder: "report-send:11" });
  assert.equal(held.until, null);
  assert.equal(await storedUntil(a.id, LAST, "report-send:11"), null);
  const iso = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const timed = await store.holdVersion(s.db, { artifactId: a.id, n: LAST - 1, holder: "report-send:12", until: iso });
  assert.match(timed.until, STORE_FORMAT);
  assert.equal(timed.until, await storedUntil(a.id, LAST - 1, "report-send:12"), "the return value is what was stored");
});

test("releaseHolds frees a holder's versions to prune", async () => {
  const a = await fill("Released", { holder: "report-send:4" });
  assert.ok((await versionNs(a.id)).includes(3));
  assert.equal(await store.releaseHolds(s.db, { holder: "report-send:4" }), 1);
  assert.equal(await store.releaseHolds(s.db, { holder: "report-send:4" }), 0, "a second release is a no-op");
  const next = await store.addVersion(s.db, s.blobs, { artifactId: a.id, source: doc("Released v26"), actor: OWNER }, deps);
  assert.equal(next.n, LAST + 1);
  const ns = await versionNs(a.id);
  assert.ok(!ns.includes(3), "with the hold gone the version prunes like any other");
  assert.equal(ns.length, KEPT);
});

test("releaseVersionHold drops one row and leaves other holders alone", async () => {
  const a = await fill("Two holders");
  await store.holdVersion(s.db, { artifactId: a.id, n: 10, holder: "report-send:5" });
  await store.holdVersion(s.db, { artifactId: a.id, n: 10, holder: "report-link:5" });
  assert.equal(await store.releaseVersionHold(s.db, { artifactId: a.id, n: 10, holder: "report-link:5" }), 1);
  const rows = (await s.db.execute({ sql: "SELECT holder FROM artifact_version_holds WHERE artifact_id=? AND n=10", args: [a.id] })).rows.map((r) => r.holder);
  assert.deepEqual(rows, ["report-send:5"]);
});

test("holdVersion on a missing version throws not_found", async () => {
  const a = await fill("Missing", { holder: "report-send:6" });
  await assert.rejects(store.holdVersion(s.db, { artifactId: a.id, n: 999, holder: "report-send:6" }), (e) => e.code === "not_found");
  await assert.rejects(store.holdVersion(s.db, { artifactId: "art_nope", n: 1, holder: "report-send:6" }), (e) => e.code === "not_found");
  await assert.rejects(store.holdVersion(s.db, { artifactId: a.id, n: 3, holder: "" }), (e) => e.code === "bad_request");
  await assert.rejects(store.holdVersion(s.db, { artifactId: a.id, n: 3, holder: "x".repeat(201) }), (e) => e.code === "bad_request");
});

test("addVersion without extraStatements behaves as before", async () => {
  const a = await store.createArtifact(s.db, s.blobs, { title: "Plain", type: "document", source: doc("plain one"), actor: OWNER }, deps);
  const v = await store.addVersion(s.db, s.blobs, { artifactId: a.id, source: doc("plain two"), actor: OWNER, baseVersion: 1 }, deps);
  assert.deepEqual([v.n, v.state], [2, "current"]);
  assert.equal(await currentOf(a.id), 2);
  assert.equal((await s.db.execute({ sql: "SELECT COUNT(*) AS c FROM run_rows WHERE artifact_id=?", args: [a.id] })).rows[0].c, 0);
});

test("addVersion writes the caller's row in the same batch", async () => {
  const a = await store.createArtifact(s.db, s.blobs, { title: "Batched", type: "document", source: doc("batched one"), actor: OWNER }, deps);
  const v = await store.addVersion(s.db, s.blobs, {
    artifactId: a.id, source: doc("batched two"), actor: OWNER,
    extraStatements: (n) => [{ sql: "INSERT INTO run_rows (artifact_id, n) VALUES (?,?)", args: [a.id, n] }],
  }, deps);
  assert.deepEqual([v.n, v.state], [2, "current"]);
  assert.deepEqual((await s.db.execute({ sql: "SELECT n FROM run_rows WHERE artifact_id=?", args: [a.id] })).rows.map((r) => Number(r.n)), [2]);
});

test("a failing extra statement rolls the version back and leaves no orphan blob", async () => {
  const a = await store.createArtifact(s.db, s.blobs, { title: "Rollback", type: "document", source: doc("rollback one"), actor: OWNER }, deps);
  const before = { current: await currentOf(a.id), count: (await versionNs(a.id)).length, blobs: (await s.blobs.keys()).length };
  await assert.rejects(store.addVersion(s.db, s.blobs, {
    artifactId: a.id, source: doc("rollback two that must not survive"), actor: OWNER,
    extraStatements: (n) => [{ sql: "INSERT INTO no_such_report_table (artifact_id, n) VALUES (?,?)", args: [a.id, n] }],
  }, deps), (e) => /no such table/i.test(String(e.message)));
  assert.equal(await currentOf(a.id), before.current, "current_version is unchanged");
  assert.equal((await versionNs(a.id)).length, before.count, "no version row remains");
  assert.equal((await s.blobs.keys()).length, before.blobs, "the blob written for it was collected");
  assert.equal((await s.db.execute({ sql: "SELECT COUNT(*) AS c FROM run_rows WHERE artifact_id=?", args: [a.id] })).rows[0].c, 0);
});

test("an extraStatements callback that throws leaves no version and no orphan blob", async () => {
  const a = await store.createArtifact(s.db, s.blobs, { title: "Thrower", type: "document", source: doc("thrower one"), actor: OWNER }, deps);
  const before = { current: await currentOf(a.id), count: (await versionNs(a.id)).length, blobs: (await s.blobs.keys()).length };
  const boom = Object.assign(new Error("the caller's own code broke"), { code: "caller_bug" });
  await assert.rejects(store.addVersion(s.db, s.blobs, {
    artifactId: a.id, source: doc("thrower two that must not survive"), actor: OWNER,
    extraStatements: () => { throw boom; },
  }, deps), (e) => e === boom, "the callback's own error is what surfaces");
  assert.equal(await currentOf(a.id), before.current, "current_version is unchanged");
  assert.equal((await versionNs(a.id)).length, before.count, "no version row remains");
  assert.equal((await s.blobs.keys()).length, before.blobs, "the blob written for the version was collected");
});