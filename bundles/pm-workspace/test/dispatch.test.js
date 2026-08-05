import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { ensureDispatchTables, dispatch, result, disposition, telemetry } from "../server/dispatch.js";

let db;
before(async () => {
  db = createClient({ url: "file::memory:" });
  await db.execute("CREATE TABLE pi_bot_defs (bot_id TEXT PRIMARY KEY, definition TEXT, enabled INTEGER)");
  await db.execute("INSERT INTO pi_bot_defs VALUES ('t-bot', '{\"models\":{\"default\":\"m1\"}}', 1)");
  await ensureDispatchTables(db);
});

test("dispatch inserts a queued job row and a telemetry row", async () => {
  const r = await dispatch(db, { bot_id: "t-bot", duty: "doc-revision", goal: "Revise X", card_id: 7 });
  assert.ok(r.job_id.startsWith("job-"));
  const job = (await db.execute({ sql: "SELECT * FROM bot_jobs WHERE job_id=?", args: [r.job_id] })).rows[0];
  assert.equal(job.status, "queued");
  assert.match(String(job.goal), /DISPATCH .* duty: doc-revision/);
  const t = (await db.execute({ sql: "SELECT * FROM pm_bot_dispatches WHERE job_id=?", args: [r.job_id] })).rows[0];
  assert.equal(t.duty, "doc-revision");
  assert.equal(t.card_id, 7);
});

test("dispatch refuses an unknown or disabled bot", async () => {
  await assert.rejects(dispatch(db, { bot_id: "nope", duty: "d", goal: "g" }), /unknown or disabled/);
});

test("dispatch always sets deliver_to to the poll literal (review round 1, IMPORTANT 2 — no bypass of the scan gate)", async () => {
  const r = await dispatch(db, { bot_id: "t-bot", duty: "d-poll", goal: "g" });
  const job = (await db.execute({ sql: "SELECT deliver_to FROM bot_jobs WHERE job_id=?", args: [r.job_id] })).rows[0];
  assert.equal(job.deliver_to, JSON.stringify({ kind: "poll" }));
});

test("result on a completed job scans and redacts", async (t) => {
  const r = await dispatch(db, { bot_id: "t-bot", duty: "d2", goal: "g2" });
  await db.execute({ sql: "UPDATE bot_jobs SET status='completed', result=?, started_at=datetime('now') WHERE job_id=?",
    args: ["fine text plus ghp_" + "a".repeat(36), r.job_id] });
  const prev = process.env.PM_SCAN_RULES_FILE;
  process.env.PM_SCAN_RULES_FILE = writeTmpRules();
  t.after(() => {
    if (prev === undefined) delete process.env.PM_SCAN_RULES_FILE;
    else process.env.PM_SCAN_RULES_FILE = prev;
  });
  const out = await result(db, { job_id: r.job_id });
  assert.equal(out.scan_status, "findings");
  assert.ok(!out.result.includes("ghp_" + "a".repeat(36)));
});

test("failed jobs stamp scan_status on the dispatch row, same as completed jobs (review round 1, MINOR 10)", async (t) => {
  stashEnv(t, ["PM_SCAN_RULES_FILE"]);
  const r = await dispatch(db, { bot_id: "t-bot", duty: "d-failed", goal: "g" });
  process.env.PM_SCAN_RULES_FILE = writeTmpRules();
  await db.execute({
    sql: "UPDATE bot_jobs SET status='failed', error=? WHERE job_id=?",
    args: ["boom: leaked ghp_" + "a".repeat(36), r.job_id],
  });

  const out = await result(db, { job_id: r.job_id });
  assert.equal(out.status, "failed");
  assert.equal(out.scan_status, "findings");
  assert.ok(!out.error.includes("ghp_" + "a".repeat(36)));

  const row = (await db.execute({ sql: "SELECT scan_status FROM pm_bot_dispatches WHERE job_id=?", args: [r.job_id] })).rows[0];
  assert.equal(row.scan_status, "findings");
});

test("workspace files with findings are quarantined, not returned as files (review round 1, IMPORTANT 3)", async (t) => {
  stashEnv(t, ["CROW_HOME", "CROW_DB_PATH", "PM_SCAN_RULES_FILE"]);
  const bot_id = "t-bot";
  const r = await dispatch(db, { bot_id, duty: "d-quarantine", goal: "g" });

  const crowHome = mkdtempSync(join(tmpdir(), "crow-home-"));
  const wsDir = join(crowHome, "pi-bots", bot_id);
  mkdirSync(wsDir, { recursive: true });
  const secretFile = join(wsDir, "draft.txt");
  writeFileSync(secretFile, "leaked token ghp_" + "a".repeat(36));
  const cleanFile = join(wsDir, "clean.txt");
  writeFileSync(cleanFile, "nothing sensitive here");

  process.env.CROW_HOME = crowHome;
  delete process.env.CROW_DB_PATH;
  process.env.PM_SCAN_RULES_FILE = writeTmpRules();

  await db.execute({
    sql: "UPDATE bot_jobs SET status='completed', result=?, started_at='2020-01-01T00:00:00.000Z' WHERE job_id=?",
    args: ["clean result text", r.job_id],
  });

  const out = await result(db, { job_id: r.job_id });
  assert.equal(out.scan_status, "findings");
  assert.ok(out.quarantined.includes(secretFile), "flagged file should be quarantined");
  assert.ok(!out.files.includes(secretFile), "flagged file must not appear in files");
  assert.ok(out.files.includes(cleanFile), "clean file should still appear in files");
});

test("NULL started_at falls back to created_at so the workspace scan still runs (review round 1, IMPORTANT 4)", async (t) => {
  stashEnv(t, ["CROW_HOME", "CROW_DB_PATH", "PM_SCAN_RULES_FILE"]);
  const bot_id = "t-bot";
  const r = await dispatch(db, { bot_id, duty: "d-null-started", goal: "g" });
  // started_at is left NULL (never set); created_at is stamped by the DDL default.
  await db.execute({
    sql: "UPDATE bot_jobs SET status='completed', result=? WHERE job_id=?",
    args: ["clean result text", r.job_id],
  });
  const job = (await db.execute({ sql: "SELECT started_at, created_at FROM bot_jobs WHERE job_id=?", args: [r.job_id] })).rows[0];
  assert.equal(job.started_at, null);
  assert.ok(job.created_at);

  const crowHome = mkdtempSync(join(tmpdir(), "crow-home-"));
  const wsDir = join(crowHome, "pi-bots", bot_id);
  mkdirSync(wsDir, { recursive: true });
  const secretFile = join(wsDir, "late.txt");
  writeFileSync(secretFile, "token ghp_" + "a".repeat(36));

  process.env.CROW_HOME = crowHome;
  delete process.env.CROW_DB_PATH;
  process.env.PM_SCAN_RULES_FILE = writeTmpRules();

  const out = await result(db, { job_id: r.job_id });
  assert.equal(out.scan_status, "findings");
  assert.ok(out.quarantined.includes(secretFile), "workspace scan must run off created_at when started_at is NULL");
});

test("workspace root follows CROW_DB_PATH parity with instance-paths.mjs when set (review round 1, IMPORTANT 5)", async (t) => {
  stashEnv(t, ["CROW_HOME", "CROW_DB_PATH", "PM_SCAN_RULES_FILE"]);
  const bot_id = "t-bot";
  const r = await dispatch(db, { bot_id, duty: "d-db-path", goal: "g" });

  const instanceRoot = mkdtempSync(join(tmpdir(), "instance-"));
  const dataDir = join(instanceRoot, "data");
  mkdirSync(dataDir, { recursive: true });
  const dbPath = join(dataDir, "crow.db");
  writeFileSync(dbPath, ""); // dispatch.js only reads the PATH, never opens this file
  const wsDir = join(instanceRoot, "pi-bots", bot_id); // sibling of the data dir, per instance-paths.mjs
  mkdirSync(wsDir, { recursive: true });
  const secretFile = join(wsDir, "draft.txt");
  writeFileSync(secretFile, "token ghp_" + "a".repeat(36));

  process.env.CROW_DB_PATH = dbPath;
  delete process.env.CROW_HOME; // CROW_DB_PATH must win even without CROW_HOME set
  process.env.PM_SCAN_RULES_FILE = writeTmpRules();

  await db.execute({
    sql: "UPDATE bot_jobs SET status='completed', result=?, started_at='2020-01-01T00:00:00.000Z' WHERE job_id=?",
    args: ["clean result text", r.job_id],
  });

  const out = await result(db, { job_id: r.job_id });
  assert.equal(out.scan_status, "findings");
  assert.ok(out.quarantined.includes(secretFile));
});

test("disposition + telemetry math (edit counts as a miss)", async () => {
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await dispatch(db, { bot_id: "t-bot", duty: "d3", goal: "g" })).job_id);
  await disposition(db, { job_id: ids[0], disposition: "accepted" });
  await disposition(db, { job_id: ids[1], disposition: "edited" });
  await disposition(db, { job_id: ids[2], disposition: "rejected" });
  const s = await telemetry(db, {});
  assert.equal(s.decided, 3);
  assert.equal(s.accepted, 1);
  assert.ok(Math.abs(s.accept_rate - 1 / 3) < 1e-9);
  assert.ok(s.per_bot["t-bot"]);
  assert.equal(s.per_bot["t-bot"].decided, 3);
});

import { writeFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
function writeTmpRules() {
  const p = join(mkdtempSync(join(tmpdir(), "rules-")), "r.json");
  writeFileSync(p, JSON.stringify({ rules: [{ name: "github-token", pattern: "ghp_[A-Za-z0-9]{36}" }] }));
  return p;
}

// Restores a set of env vars to their pre-test values via t.after, whether
// they were set, unset, or overwritten mid-test.
function stashEnv(t, keys) {
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  t.after(() => {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  });
}
