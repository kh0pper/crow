/**
 * The generic sync appliers (_applyInsert / _applyUpdate) build column names
 * from the incoming wire row's KEYS. Only values are bound, so every key must
 * be checked before SQL is built: a plain identifier that names a real column
 * of a SYNCED_TABLES table. A bad key rejects the whole entry, nothing applied.
 *
 * Real init-db.js schema in a tmp dir; one shared identity (as instance-sync.test.js).
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { InstanceSyncManager } from "../servers/sharing/instance-sync.js";

const tmpDir = mkdtempSync(join(tmpdir(), "crow-isync-ident-"));
execFileSync(process.execPath, ["scripts/init-db.js"], {
  env: { ...process.env, CROW_DATA_DIR: tmpDir },
  stdio: "pipe",
});
const db = createDbClient(join(tmpDir, "crow.db"));
after(() => { db.close(); rmSync(tmpDir, { recursive: true, force: true }); });

const IDENTITY = { ed25519Priv: Buffer.alloc(32, 0xAB), ed25519Pubkey: "00".repeat(32) };
const mgr = new InstanceSyncManager(IDENTITY, db, "aaaaaaaa-0000-0000-0000-0000000000a1");
const REMOTE = "bbbbbbbb-0000-0000-0000-0000000000b2";

const one = async (sql, args = []) => (await db.execute({ sql, args })).rows[0];
const count = async (sql, args = []) => Number((await one(sql, args)).n);
const memoriesExists = async () =>
  (await count("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='memories'")) === 1;

// Silence (and capture) the rejection log so assertions can see it fired.
async function capturingErrors(fn) {
  const orig = console.error;
  const lines = [];
  console.error = (...a) => { lines.push(a.join(" ")); };
  try { await fn(); } finally { console.error = orig; }
  return lines;
}

async function seedMemory(id, content) {
  await db.execute({
    sql: "INSERT INTO memories (id, category, content) VALUES (?, 'general', ?)",
    args: [id, content],
  });
}

test("insert: a key carrying SQL is rejected with no side effect", async () => {
  const before = await count("SELECT COUNT(*) AS n FROM memories");
  const logs = await capturingErrors(async () => {
    await assert.doesNotReject(() => mgr._applyInsert("memories", {
      id: 7001, category: "general", content: "x",
      "id) VALUES (1); DROP TABLE memories; --": "boom",
    }, 5, REMOTE));
    // Single-statement form: on an unguarded applier this writes a row whose
    // content comes from the key text, not from any bound value.
    await assert.doesNotReject(() => mgr._applyInsert("memories", {
      id: 7002,
      "content, category, lamport_ts) VALUES (?, 'from-key', ?, ?) --": "general",
    }, 5, REMOTE));
  });
  assert.ok(await memoriesExists(), "memories table still exists");
  assert.equal(await count("SELECT COUNT(*) AS n FROM memories"), before, "nothing inserted");
  assert.equal(await count("SELECT COUNT(*) AS n FROM memories WHERE content = 'from-key'"), 0);
  assert.equal(logs.filter((l) => l.includes("REJECTED inbound insert on memories")).length, 2, logs.join("\n"));
});

test("update: a key carrying SQL is rejected with no side effect", async () => {
  await seedMemory(7101, "original");
  const logs = await capturingErrors(async () => {
    await assert.doesNotReject(() => mgr._applyUpdate("memories", {
      id: 7101, "id) VALUES (1); DROP TABLE memories; --": "boom",
    }, 9));
    // Single-statement form: unguarded, this rewrites content from the key text.
    await assert.doesNotReject(() => mgr._applyUpdate("memories", {
      id: 7101, "content = 'from-key', tags": "t", importance: 9,
    }, 9));
  });
  assert.ok(await memoriesExists(), "memories table still exists");
  const row = await one("SELECT content, tags, importance FROM memories WHERE id = 7101");
  assert.equal(row.content, "original");
  assert.equal(row.tags, null, "no partial apply of the valid keys");
  assert.equal(Number(row.importance), 5, "no partial apply of the valid keys");
  assert.equal(logs.filter((l) => l.includes("REJECTED inbound update on memories")).length, 2, logs.join("\n"));
});

test("keys with quotes or spaces are rejected (insert and update)", async () => {
  await seedMemory(7201, "original");
  for (const bad of ['tags"', 'ta"gs', "tags ", "my tags", "tags'", "tags;"]) {
    await capturingErrors(async () => {
      await assert.doesNotReject(() => mgr._applyInsert("memories",
        { id: 7202, category: "general", content: "new", [bad]: "v" }, 5, REMOTE), `insert ${bad}`);
      await assert.doesNotReject(() => mgr._applyUpdate("memories",
        { id: 7201, content: "changed", [bad]: "v" }, 9), `update ${bad}`);
    });
  }
  assert.equal(await count("SELECT COUNT(*) AS n FROM memories WHERE id = 7202"), 0);
  assert.equal((await one("SELECT content FROM memories WHERE id = 7201")).content, "original");
});

test("a valid entry still applies (insert then update)", async () => {
  await mgr._applyInsert("memories", { id: 7301, category: "general", content: "hello", tags: "a" }, 5, REMOTE);
  let row = await one("SELECT content, tags, lamport_ts, instance_id FROM memories WHERE id = 7301");
  assert.equal(row.content, "hello");
  assert.equal(row.tags, "a");
  assert.equal(Number(row.lamport_ts), 5);
  assert.equal(row.instance_id, REMOTE);

  await mgr._applyUpdate("memories", { id: 7301, content: "hello again", importance: 8 }, 6);
  row = await one("SELECT content, importance, lamport_ts FROM memories WHERE id = 7301");
  assert.equal(row.content, "hello again");
  assert.equal(Number(row.importance), 8);
  assert.equal(Number(row.lamport_ts), 6);
});

test("an unknown but well-formed column rejects the whole entry, without throwing", async () => {
  await seedMemory(7401, "original");
  const logs = await capturingErrors(async () => {
    await assert.doesNotReject(() => mgr._applyInsert("memories",
      { id: 7402, category: "general", content: "new", column_from_newer_peer: 1 }, 5, REMOTE));
    await assert.doesNotReject(() => mgr._applyUpdate("memories",
      { id: 7401, content: "changed", column_from_newer_peer: 1 }, 9));
  });
  assert.equal(await count("SELECT COUNT(*) AS n FROM memories WHERE id = 7402"), 0);
  assert.equal((await one("SELECT content FROM memories WHERE id = 7401")).content, "original");
  assert.ok(logs.some((l) => l.includes("unknown column") && l.includes("column_from_newer_peer")), logs.join("\n"));
});

test("a column added after the cache was filled is picked up", async () => {
  await mgr._applyInsert("memories", { id: 7501, category: "general", content: "c" }, 5, REMOTE); // fills cache
  await db.execute({ sql: "ALTER TABLE memories ADD COLUMN late_col TEXT", args: [] });
  await mgr._applyUpdate("memories", { id: 7501, late_col: "ok" }, 6);
  assert.equal((await one("SELECT late_col FROM memories WHERE id = 7501")).late_col, "ok");
});

test("a table outside SYNCED_TABLES is refused by the appliers themselves", async () => {
  const before = await count("SELECT COUNT(*) AS n FROM sync_conflicts");
  await capturingErrors(async () => {
    await assert.doesNotReject(() => mgr._applyInsert("sync_conflicts", { id: 99999, table_name: "x" }, 5, REMOTE));
  });
  assert.equal(await count("SELECT COUNT(*) AS n FROM sync_conflicts"), before);
});
