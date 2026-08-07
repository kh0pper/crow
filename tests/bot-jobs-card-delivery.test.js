/**
 * deliver_to {kind:"card"} — a finished job writes its outcome back onto the
 * board card that produced it. Without this the board's repointed dispatch
 * would strand every card in 'executing'.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TASKS_DDL = `
  CREATE TABLE tasks_items (
    id INTEGER PRIMARY KEY, title TEXT, status TEXT, stage TEXT,
    assigned_bot TEXT, plan_ref TEXT, project_id INTEGER,
    updated_at TEXT
  );`;

function seedCard(dir, stage = "executing") {
  const p = join(dir, "tasks.db");
  const db = new Database(p);
  db.exec(TASKS_DDL);
  db.prepare("INSERT INTO tasks_items (id,title,status,stage,assigned_bot) VALUES (?,?,?,?,?)")
    .run(120, "Safe rolling updates", "in_progress", stage, "r4-assistant");
  db.close();
  return p;
}
const readCard = (p) => new Database(p).prepare("SELECT stage,status FROM tasks_items WHERE id=120").get();

test("a completed card job moves the card to done", async () => {
  const dir = mkdtempSync(join(tmpdir(), "carddeliver-"));
  try {
    const tasksDbPath = seedCard(dir);
    const mod = await import("../scripts/pi-bots/job_runner.mjs");
    mod.applyCardOutcome({ tasksDbPath, cardId: 120, ok: true });
    assert.deepEqual(readCard(tasksDbPath), { stage: "done", status: "done" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a failed card job blocks the card rather than leaving it executing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "carddeliver-fail-"));
  try {
    const tasksDbPath = seedCard(dir);
    const mod = await import("../scripts/pi-bots/job_runner.mjs");
    mod.applyCardOutcome({ tasksDbPath, cardId: 120, ok: false });
    const row = readCard(tasksDbPath);
    assert.equal(row.stage, "blocked", "a failed job must not leave the card in executing");
    assert.equal(row.status, "pending");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a missing card is a no-op, not a throw", async () => {
  const dir = mkdtempSync(join(tmpdir(), "carddeliver-missing-"));
  try {
    const tasksDbPath = seedCard(dir);
    const mod = await import("../scripts/pi-bots/job_runner.mjs");
    // Delivery runs after the job already succeeded; a deleted card must not
    // turn a completed job into a crashed worker.
    mod.applyCardOutcome({ tasksDbPath, cardId: 999, ok: true });
    assert.deepEqual(readCard(tasksDbPath), { stage: "executing", status: "in_progress" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
