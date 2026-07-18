// Tests for the A3 runtime migration guard (servers/shared/migration-guard.js)
// and its expected-changes manifest. Includes the static rot-guards that keep
// the manifest honest against scripts/init-db.js and keep the boot-order
// invariant (guard before the first createDbClient) from regressing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

import {
  classify, readSchemaState, snapshotDb, runGuardedInitDb, restoreBackup,
  writeQuarantine, evaluateQuarantine, activeMarker, readMarker,
  repoMarkerPath, dataMarkerPath, readTreeGeneration, resolveGuardDbPath,
  sweepRetention, backupDir, pinBackup, _setAlertChannelsForTest, _testables,
} from "../servers/shared/migration-guard.js";
import {
  EXPECTED_DROPS, EXPECTED_PRUNES, EXPECTED_MOVES, REBUILD_TABLES,
  VOLATILE_TABLES,
} from "../servers/shared/migration-expectations.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

function snap(tables, { objects = [], userVersion = 8, pruneCounts = {} } = {}) {
  const t = {};
  for (const [name, v] of Object.entries(tables)) {
    t[name] = { count: v.count, columns: v.columns || ["id"], sql: v.sql || `CREATE TABLE ${name} (id)` };
  }
  return { tables: t, objects, userVersion, pruneCounts };
}

/* ------------------------------------------------------- classification */

test("classify: increases and unchanged counts pass", () => {
  const a = snap({ foo: { count: 5 }, bar: { count: 0 } });
  const b = snap({ foo: { count: 9 }, bar: { count: 0 } });
  assert.equal(classify(a, b).verdict, "pass");
});

test("classify: undeclared disappeared table is loss; declared drop is excused", () => {
  const a = snap({ foo: { count: 5 }, research_projects: { count: 3 } });
  const b = snap({});
  const r = classify(a, b);
  assert.equal(r.verdict, "loss");
  assert.ok(r.report.losses.some((l) => l.includes("foo")));
  assert.ok(r.report.excused.some((e) => e.includes("research_projects")));
});

test("classify: to-zero above floor is loss; small noise is suspect", () => {
  const a = snap({ big: { count: 50 }, small: { count: 9 } });
  const b = snap({ big: { count: 0 }, small: { count: 7 } });
  const r = classify(a, b);
  assert.equal(r.verdict, "loss");
  assert.ok(r.report.losses.some((l) => l.includes("big")));
  assert.ok(r.report.suspects.some((s) => s.includes("small")));
});

test("classify: >50% and >=floor loss is loss; below either threshold is suspect", () => {
  const a = snap({ t1: { count: 100 }, t2: { count: 100 } });
  const b = snap({ t1: { count: 40 }, t2: { count: 60 } }); // t1 -60 (>50%), t2 -40 (<50%)
  const r = classify(a, b);
  assert.ok(r.report.losses.some((l) => l.includes("t1")));
  assert.ok(r.report.suspects.some((s) => s.includes("t2")));
});

test("classify: volatile tables never fail closed", () => {
  const a = snap({ cross_host_calls: { count: 500 } });
  const b = snap({ cross_host_calls: { count: 0 } });
  const r = classify(a, b);
  assert.equal(r.verdict, "suspect");
});

test("classify: prunes are bounded by the snapshot-A predicate count", () => {
  const a = snap({ schedules: { count: 30 } }, { pruneCounts: { schedules: 10 } });
  const ok = classify(a, snap({ schedules: { count: 20 } }, { pruneCounts: {} }));
  assert.equal(ok.verdict, "pass"); // exactly the predicate count
  const over = classify(a, snap({ schedules: { count: 4 } }, { pruneCounts: {} }));
  assert.equal(over.verdict, "loss"); // 26 lost, only 10 excusable → 16 unexplained > floor + >50%
});

test("classify: moves excuse the source up to the destination gain", () => {
  const a = snap({ dashboard_settings: { count: 40 }, dashboard_settings_overrides: { count: 0 } });
  const moved = snap({ dashboard_settings: { count: 10 }, dashboard_settings_overrides: { count: 30 } });
  assert.equal(classify(a, moved).verdict, "pass");
  const lostToo = snap({ dashboard_settings: { count: 5 }, dashboard_settings_overrides: { count: 30 } });
  // 35 lost, 30 moved → 5 unexplained; dashboard_settings rebuild NOT fired (same sql) → noise band (5 < floor)
  assert.equal(classify(a, lostToo).verdict, "suspect");
});

test("classify: fired strict rebuild losing rows is loss even below thresholds", () => {
  const a = snap({ research_sources: { count: 100, sql: "CREATE TABLE research_sources (old)" } });
  const b = snap({ research_sources: { count: 97, sql: "CREATE TABLE research_sources (new)" } });
  const r = classify(a, b);
  assert.equal(r.verdict, "loss");
});

test("classify: fired dedup-tolerant rebuild losing rows is suspect", () => {
  const a = snap({ crow_context: { count: 100, sql: "CREATE TABLE crow_context (old)" } });
  const b = snap({ crow_context: { count: 97, sql: "CREATE TABLE crow_context (new)" } });
  assert.equal(classify(a, b).verdict, "suspect");
});

test("classify: unfired rebuild-table decrease is concurrent noise, not loss", () => {
  const a = snap({ research_sources: { count: 100, sql: "CREATE TABLE research_sources (x)" } });
  const b = snap({ research_sources: { count: 97, sql: "CREATE TABLE research_sources (x)" } });
  assert.equal(classify(a, b).verdict, "suspect");
});

test("classify: fired rebuild losing a column is loss", () => {
  const a = snap({ research_sources: { count: 10, columns: ["id", "title", "doi"], sql: "v1" } });
  const b = snap({ research_sources: { count: 10, columns: ["id", "title"], sql: "v2" } });
  const r = classify(a, b);
  assert.equal(r.verdict, "loss");
  assert.ok(r.report.losses.some((l) => l.includes("doi")));
});

test("classify: expected object removals excused, others suspect", () => {
  const a = snap({ t: { count: 1 } }, {
    objects: [
      { o: "trigger:tr_rp_to_ps_ins", tbl_name: "research_projects" },
      { o: "index:idx_something_else", tbl_name: "t" },
    ],
  });
  const b = snap({ t: { count: 1 } }, { objects: [] });
  const r = classify(a, b);
  assert.equal(r.verdict, "suspect");
  assert.ok(r.report.excused.some((e) => e.includes("tr_rp_to_ps_ins")));
  assert.ok(r.report.suspects.some((s) => s.includes("idx_something_else")));
});

/* ------------------------------------------------------------- markers */

test("quarantine: attempts key on the generation pair and cap at 3", () => {
  const dir = mkdtempSync(join(tmpdir(), "mg-marker-"));
  const dbPath = join(dir, "data", "crow.db");
  mkdirSync(dirname(dbPath), { recursive: true });
  const args = { appRoot: dir, dbPath, sha: "aaa", fromGeneration: 8, toGeneration: 9, report: {} };

  const m1 = writeQuarantine(args);
  assert.equal(m1.attempts, 1);
  // blocked while head == quarantined sha
  assert.equal(evaluateQuarantine({ appRoot: dir, dbPath, originHeadSha: "aaa" }).blocked, true);
  // head moved → cleared
  const ev = evaluateQuarantine({ appRoot: dir, dbPath, originHeadSha: "bbb" });
  assert.equal(ev.blocked, false);
  assert.equal(ev.cleared, true);
  assert.equal(activeMarker(repoMarkerPath(dir)), null); // cleared ≠ active

  // same pair re-quarantines with attempts carried forward
  const m2 = writeQuarantine({ ...args, sha: "bbb" });
  assert.equal(m2.attempts, 2);
  const m3attempts = writeQuarantine({ ...args, sha: "ccc" }).attempts;
  assert.equal(m3attempts, 3);
  // at the cap, a moved head no longer clears
  const blockedAtCap = evaluateQuarantine({ appRoot: dir, dbPath, originHeadSha: "ddd" });
  assert.equal(blockedAtCap.blocked, true);

  // a DIFFERENT crossing starts fresh
  const other = writeQuarantine({ ...args, fromGeneration: 9, toGeneration: 10, sha: "eee" });
  assert.equal(other.attempts, 1);
  rmSync(dir, { recursive: true, force: true });
});

/* ---------------------------------------------------- static rot-guards */

test("rot-guard: every destructive statement in init-db is declared in the manifest (and vice versa)", () => {
  const src = readFileSync(join(REPO_ROOT, "scripts", "init-db.js"), "utf8");

  // Literal DROP TABLEs (name must be terminated by ; or a quote — skips the
  // template-literal generic rebuild and prose in comments).
  const dropNames = [...src.matchAll(/DROP TABLE (?:IF EXISTS )?([a-zA-Z_][a-zA-Z0-9_]*)\s*[;"'`]/g)].map((m) => m[1]);
  assert.ok(dropNames.length >= 6, `expected ≥6 literal drops, saw ${dropNames}`);
  const declared = new Set([...EXPECTED_DROPS, ...Object.keys(REBUILD_TABLES)]);
  for (const n of dropNames) {
    assert.ok(declared.has(n), `init-db drops table '${n}' but the manifest does not declare it — add it to migration-expectations.js`);
  }

  // Generic rebuild: every TABLE_SPECS key must be declared as a rebuild table.
  const specsBlock = src.match(/const TABLE_SPECS = \{([\s\S]*?)\n {2}\};/);
  assert.ok(specsBlock, "TABLE_SPECS block not found in init-db.js — update the rot-guard scanner");
  const specKeys = [...specsBlock[1].matchAll(/^ {4}([a-zA-Z_][a-zA-Z0-9_]*): \{/gm)].map((m) => m[1]);
  assert.ok(specKeys.length >= 3, `expected ≥3 TABLE_SPECS keys, saw ${specKeys}`);
  for (const k of specKeys) {
    assert.ok(REBUILD_TABLES[k], `TABLE_SPECS rebuild '${k}' is not declared in REBUILD_TABLES`);
  }

  // DELETE FROMs must be declared prunes, with predicates that still match.
  const deleteNames = [...src.matchAll(/DELETE FROM ([a-zA-Z_][a-zA-Z0-9_]*)/g)].map((m) => m[1]);
  const pruneTables = EXPECTED_PRUNES.map((p) => p.table);
  for (const n of deleteNames) {
    assert.ok(pruneTables.includes(n), `init-db deletes from '${n}' but EXPECTED_PRUNES does not declare it`);
  }
  for (const p of EXPECTED_PRUNES) {
    assert.ok(deleteNames.includes(p.table), `EXPECTED_PRUNES declares '${p.table}' but init-db no longer deletes from it — remove the stale entry`);
    assert.ok(src.includes(p.predicate), `EXPECTED_PRUNES predicate for '${p.table}' no longer matches init-db source — keep them in sync`);
  }

  // Reverse: stale drop declarations.
  for (const n of EXPECTED_DROPS) {
    assert.ok(dropNames.includes(n), `EXPECTED_DROPS declares '${n}' but init-db no longer drops it — remove the stale entry`);
  }
  for (const k of Object.keys(REBUILD_TABLES)) {
    assert.ok(dropNames.includes(k) || specKeys.includes(k), `REBUILD_TABLES declares '${k}' but init-db has no rebuild for it`);
  }
  // Moves: destination table must exist in init-db DDL.
  for (const m of EXPECTED_MOVES) {
    assert.ok(src.includes(m.to), `EXPECTED_MOVES destination '${m.to}' not found in init-db`);
  }
  // Volatile list mentions only real tables.
  for (const v of VOLATILE_TABLES) {
    assert.ok(src.includes(v), `VOLATILE_TABLES entry '${v}' not found in init-db — is the table name right?`);
  }
});

test("rot-guard: readTreeGeneration parses the real schema-version.js", () => {
  const gen = readTreeGeneration(REPO_ROOT);
  assert.ok(Number.isInteger(gen) && gen >= 8, `parsed generation ${gen}`);
});

test("rot-guard: boot gate precedes the first createDbClient call in index.js", () => {
  const src = readFileSync(join(REPO_ROOT, "servers", "gateway", "index.js"), "utf8");
  const gate = src.indexOf("runGuardedInitDb");
  const oauth = src.indexOf("await initOAuthTables()");
  const firstClient = src.indexOf("createDbClient()");
  assert.ok(gate > 0 && oauth > 0 && firstClient > 0);
  assert.ok(gate < oauth, "schema gate must run before initOAuthTables (R2-2: keeper pins the pre-restore inode)");
  assert.ok(gate < firstClient, "schema gate must run before the first createDbClient()");
});

/* --------------------------------------------------------- integration */

function makeFixtureDb(dbPath, { victimRows = 20 } = {}) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE memories (id INTEGER PRIMARY KEY, content TEXT);
    CREATE TABLE dashboard_settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE crow_context (id INTEGER PRIMARY KEY, section TEXT);
    CREATE TABLE test_data (id INTEGER PRIMARY KEY, payload TEXT);
  `);
  const ins = db.prepare("INSERT INTO test_data (payload) VALUES (?)");
  for (let i = 0; i < victimRows; i++) ins.run(`row-${i}`);
  db.pragma("user_version = 8");
  db.close();
}

function stubAlerts() {
  const calls = [];
  _setAlertChannelsForTest({
    sendNtfyNotification: async (p) => calls.push(["ntfy", p]),
    sendEmailNotification: async (p) => calls.push(["email", p]),
  });
  return calls;
}

const copyBackup = async (src, dest) => {
  const db = new Database(src, { readonly: true });
  try { await db.backup(dest); } finally { db.close(); }
};

test("integration: destructive migration → backup, restore, quarantine, alert", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "mg-int-"));
  t.after(() => { _setAlertChannelsForTest(null); rmSync(dir, { recursive: true, force: true }); });
  const dbPath = join(dir, "data", "crow.db");
  makeFixtureDb(dbPath);
  const alerts = stubAlerts();

  const destructive = async () => {
    const db = new Database(dbPath);
    db.exec("DROP TABLE test_data");
    db.pragma("user_version = 9");
    db.close();
    return { code: 0 };
  };

  const res = await runGuardedInitDb({
    dbPath, appRoot: dir, sha: "badsha", newGeneration: 9,
    log: () => {}, runInitDb: destructive, performBackupFn: copyBackup,
  });

  assert.equal(res.verdict, "loss");
  assert.ok(existsSync(res.backupPath), "backup file exists");
  assert.ok(existsSync(res.backupPath + ".pin"), "backup pinned");
  assert.ok(res.evidence && existsSync(res.evidence), "damaged evidence kept");
  // Restored DB has the victim table back, full row count, old generation.
  const db = new Database(dbPath, { readonly: true });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM test_data").get().n, 20);
  assert.equal(db.pragma("user_version", { simple: true }), 8);
  db.close();
  // Markers at both levels, attempts=1.
  const marker = activeMarker(dataMarkerPath(dbPath));
  assert.ok(marker && marker.sha === "badsha" && marker.attempts === 1);
  assert.ok(activeMarker(repoMarkerPath(dir)));
  // Loud alert went through both DB-free channels.
  assert.ok(alerts.some(([ch, p]) => ch === "ntfy" && /quarantined/.test(p.title)));
  assert.ok(alerts.some(([ch]) => ch === "email"));
  // The updater refuses this sha.
  assert.equal(evaluateQuarantine({ appRoot: dir, dbPath, originHeadSha: "badsha" }).blocked, true);
});

test("integration: legitimate additive migration passes with zero findings", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "mg-add-"));
  t.after(() => { _setAlertChannelsForTest(null); rmSync(dir, { recursive: true, force: true }); });
  const dbPath = join(dir, "data", "crow.db");
  makeFixtureDb(dbPath);
  const alerts = stubAlerts();

  const additive = async () => {
    const db = new Database(dbPath);
    db.exec("CREATE TABLE new_feature (id INTEGER PRIMARY KEY); ALTER TABLE test_data ADD COLUMN extra TEXT");
    db.pragma("user_version = 9");
    db.close();
    return { code: 0 };
  };

  const res = await runGuardedInitDb({
    dbPath, appRoot: dir, sha: "goodsha", newGeneration: 9,
    log: () => {}, runInitDb: additive, performBackupFn: copyBackup,
  });
  assert.equal(res.verdict, "pass");
  assert.equal(alerts.length, 0, "no alerts on a clean migration");
  assert.equal(activeMarker(dataMarkerPath(dbPath)), null);
  // DB kept the migrated state (no restore).
  const db = new Database(dbPath, { readonly: true });
  assert.equal(db.pragma("user_version", { simple: true }), 9);
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name='new_feature'").get());
  db.close();
});

test("integration: fresh and missing DBs run unguarded", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "mg-fresh-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "data", "crow.db");
  let ran = 0;
  const res = await runGuardedInitDb({
    dbPath, appRoot: dir, newGeneration: 9, log: () => {},
    runInitDb: async () => { ran += 1; return { code: 0 }; },
    performBackupFn: copyBackup,
  });
  assert.equal(res.verdict, "fresh");
  assert.equal(ran, 1);
});

test("readSchemaState: raw detection matches fixture", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "mg-state-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "crow.db");
  makeFixtureDb(dbPath);
  const s = readSchemaState(dbPath);
  assert.deepEqual(
    { exists: s.exists, coreTableCount: s.coreTableCount, userVersion: s.userVersion, readable: s.readable },
    { exists: true, coreTableCount: 3, userVersion: 8, readable: true },
  );
  assert.equal(readSchemaState(join(dir, "nope.db")).exists, false);
});

test("retention: keeps last 3, pinned exempt, damaged capped at 2", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "mg-ret-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "crow.db");
  writeFileSync(dbPath, "x");
  const bdir = backupDir(dbPath);
  mkdirSync(bdir, { recursive: true });
  const now = Date.now();
  for (let i = 0; i < 6; i++) {
    const f = join(bdir, `crow-pre-g8-to-g9-t${i}.db`);
    writeFileSync(f, "backup");
    utimesSync(f, new Date(now - i * 1000), new Date(now - i * 1000));
  }
  pinBackup(join(bdir, "crow-pre-g8-to-g9-t5.db")); // oldest, pinned
  for (let i = 0; i < 4; i++) {
    const f = join(dir, `crow.db.damaged-t${i}`);
    writeFileSync(f, "damaged");
    utimesSync(f, new Date(now - i * 1000), new Date(now - i * 1000));
  }
  sweepRetention(dbPath);
  const left = readdirSync(bdir).filter((f) => f.endsWith(".db"));
  assert.equal(left.length, 4, `3 recent + 1 pinned, saw ${left}`); // t0,t1,t2 + pinned t5
  assert.ok(left.includes("crow-pre-g8-to-g9-t5.db"));
  const damagedLeft = readdirSync(dir).filter((f) => f.includes(".damaged-"));
  assert.equal(damagedLeft.length, 2);
});

/* ------------------------------------------- final-review regression fixes */

test("takeBackup: unwritable backup dir fails OPEN (no throw, no-backup alert), never crashes the guard", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "mg-nobk-"));
  t.after(() => { _setAlertChannelsForTest(null); rmSync(dir, { recursive: true, force: true }); });
  const dbPath = join(dir, "data", "crow.db");
  makeFixtureDb(dbPath);
  // A regular FILE where the backups dir must go → mkdirSync throws ENOTDIR.
  writeFileSync(join(dir, "data", "backups"), "not a directory");
  const alerts = stubAlerts();
  const res = await runGuardedInitDb({
    dbPath, appRoot: dir, newGeneration: 9, log: () => {},
    runInitDb: async () => ({ code: 0 }), performBackupFn: copyBackup,
  });
  assert.equal(res.verdict, "pass");
  assert.ok(alerts.some(([, p]) => /without a safety backup/.test(p.title)), "no-backup alert fired");
});

test("restoreBackup: failed copy self-heals — damaged file renamed back, dbPath never missing", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "mg-heal-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "crow.db");
  writeFileSync(dbPath, "damaged-content");
  assert.throws(() => restoreBackup(dbPath, join(dir, "no-such-backup.db")), /restore copy failed/);
  assert.ok(existsSync(dbPath), "dbPath must not be left missing");
  assert.equal(readFileSync(dbPath, "utf8"), "damaged-content");
});

test("loss without a usable backup reports restored:false and dbPresent:true", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "mg-lossnb-"));
  t.after(() => { _setAlertChannelsForTest(null); rmSync(dir, { recursive: true, force: true }); });
  const dbPath = join(dir, "data", "crow.db");
  makeFixtureDb(dbPath);
  writeFileSync(join(dir, "data", "backups"), "not a directory"); // backup impossible
  stubAlerts();
  const res = await runGuardedInitDb({
    dbPath, appRoot: dir, sha: "bad", newGeneration: 9, log: () => {},
    runInitDb: async () => {
      const db = new Database(dbPath);
      db.exec("DROP TABLE test_data");
      db.close();
      return { code: 0 };
    },
    performBackupFn: copyBackup,
  });
  assert.equal(res.verdict, "loss");
  assert.equal(res.restored, false);
  assert.equal(res.dbPresent, true);
  assert.ok(activeMarker(dataMarkerPath(dbPath)), "still quarantined");
});
