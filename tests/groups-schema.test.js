import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { SCHEMA_GENERATION } from "../servers/shared/schema-version.js";

const tmpDir = mkdtempSync(join(tmpdir(), "crow-p3g-schema-"));
function initDb() {
  execFileSync(process.execPath, ["scripts/init-db.js"],
    { env: { ...process.env, CROW_DATA_DIR: tmpDir }, stdio: "pipe" });
  return createDbClient(join(tmpDir, "crow.db"));
}
const db = initDb();
after(() => rmSync(tmpDir, { recursive: true, force: true }));

test("SCHEMA_GENERATION is stamped on the db", async () => {
  const { rows } = await db.execute("PRAGMA user_version");
  assert.equal(Number(rows[0].user_version), SCHEMA_GENERATION);
});

test("contact_groups has group_uid + lamport_ts", async () => {
  const { rows } = await db.execute("PRAGMA table_info(contact_groups)");
  const cols = new Set(rows.map((r) => r.name));
  assert.ok(cols.has("group_uid"), "group_uid column present");
  assert.ok(cols.has("lamport_ts"), "lamport_ts column present");
});

test("a bare INSERT gets a group_uid via the auto-populate trigger", async () => {
  await db.execute({ sql: "INSERT INTO contact_groups (name) VALUES ('Family')" });
  const { rows } = await db.execute("SELECT group_uid FROM contact_groups WHERE name='Family'");
  assert.match(String(rows[0].group_uid), /^[0-9a-f]{32}$/, "trigger populated a 16-byte hex uid");
});

test("group_uid is UNIQUE-indexed", async () => {
  const uid = "d".repeat(32);
  await db.execute({ sql: "INSERT INTO contact_groups (name, group_uid) VALUES ('A', ?)", args: [uid] });
  await assert.rejects(
    db.execute({ sql: "INSERT INTO contact_groups (name, group_uid) VALUES ('B', ?)", args: [uid] }),
    /UNIQUE|constraint/i,
    "duplicate group_uid rejected",
  );
});

test("C1: re-running init-db does NOT randomblob-fill a pre-existing NULL group_uid", async () => {
  // Simulate a legacy row: force group_uid NULL past the trigger. The migration must
  // LEAVE it NULL — the deterministic uid is assigned by the manager at backfill (Task 4),
  // NOT by init-db (a random per-instance fill is the C1 split-brain bug).
  await db.execute({ sql: "INSERT INTO contact_groups (name, group_uid) VALUES ('Legacy', ?)", args: ["e".repeat(32)] });
  await db.execute("UPDATE contact_groups SET group_uid = NULL WHERE name='Legacy'");
  initDb(); // re-run migrations against the same data dir (idempotent)
  const db2 = createDbClient(join(tmpDir, "crow.db"));
  const { rows } = await db2.execute("SELECT group_uid FROM contact_groups WHERE name='Legacy'");
  assert.equal(rows[0].group_uid, null, "pre-existing NULL uid is NOT filled by init-db (deterministic assignment is the manager's job)");
});

test("the auto-populate trigger + UNIQUE index survive an init-db re-run (idempotent)", async () => {
  initDb();
  const db3 = createDbClient(join(tmpDir, "crow.db"));
  const { rows: trg } = await db3.execute("SELECT name FROM sqlite_master WHERE type='trigger' AND name='contact_groups_group_uid_ai'");
  assert.equal(trg.length, 1, "trigger present after re-run");
  const { rows: idx } = await db3.execute("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_contact_groups_group_uid'");
  assert.equal(idx.length, 1, "UNIQUE index present after re-run");
});
