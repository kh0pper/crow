import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import * as store from "../servers/shared/fix-it/store.js";

let dir, db;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "fixit-store-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir },
    stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
  process.env.CROW_DATA_DIR = dir;
  db = createDbClient();
});

after(() => {
  try { db.close(); } catch {}
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
});

test("fix_it_items table exists with UNIQUE(source,dedup_key)", async () => {
  const cols = await db.execute("PRAGMA table_info(fix_it_items)");
  const names = cols.rows.map((r) => r.name);
  for (const c of ["id","source","dedup_key","title","why","severity","remedies","context","status","count","suppressed_until","created_at","updated_at"]) {
    assert.ok(names.includes(c), `missing column ${c}`);
  }
  const idx = await db.execute("PRAGMA index_list(fix_it_items)");
  const uniq = idx.rows.some((r) => Number(r.unique) === 1);
  assert.ok(uniq, "expected a UNIQUE index on fix_it_items");
});

async function clear() { await db.execute("DELETE FROM fix_it_items"); }

const baseItem = {
  source: "remote-exposure",
  dedupKey: "expose:funkwhale:peer-1",
  title: "Your glasses bot tried to use Music, but it isn't shared yet",
  why: "Share it so your other Crow devices can use it.",
  severity: "warn",
  remedies: [{ label: "Allow", actionId: "expose-capability", args: { capability: "funkwhale" }, kind: "instant" }],
  context: { capability: "funkwhale", requestingInstance: "peer-1", toolName: "fw_play" },
};

test("upsertItem inserts once, dedups on repeat, bumps count", async () => {
  await clear();
  const a = await store.upsertItem(db, baseItem);
  assert.equal(a.notify, true);
  const b = await store.upsertItem(db, baseItem);
  assert.equal(b.notify, false);
  assert.equal(b.id, a.id);
  const rows = (await db.execute("SELECT count FROM fix_it_items")).rows;
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].count), 2);
});

test("listPending returns parsed remedies/context, hides suppressed", async () => {
  await clear();
  const { id } = await store.upsertItem(db, baseItem);
  let pending = await store.listPending(db);
  assert.equal(pending.length, 1);
  assert.deepEqual(pending[0].remedies[0].args, { capability: "funkwhale" });
  assert.equal(pending[0].context.requestingInstance, "peer-1");
  await store.dismiss(db, id, 7);
  pending = await store.listPending(db);
  assert.equal(pending.length, 0, "dismissed+suppressed item hidden");
});

test("resolveByKey clears the card; re-detect reopens it (notify true)", async () => {
  await clear();
  const { id } = await store.upsertItem(db, baseItem);
  await store.resolveByKey(db, baseItem.source, baseItem.dedupKey);
  assert.equal((await store.getItem(db, id)).status, "resolved");
  assert.equal((await store.listPending(db)).length, 0);
  const re = await store.upsertItem(db, baseItem);
  assert.equal(re.notify, true, "reopened resolved item notifies again");
  assert.equal((await store.getItem(db, id)).status, "pending");
});

test("dismissed item stays dismissed on re-detect within the window (no reopen)", async () => {
  await clear();
  const { id } = await store.upsertItem(db, baseItem);
  await store.dismiss(db, id, 7);
  const re = await store.upsertItem(db, baseItem);
  assert.equal(re.notify, false);
  assert.equal((await store.getItem(db, id)).status, "dismissed");
});

test("dismissed item resurfaces (reopens to pending, notify) after the suppression window passes", async () => {
  await clear();
  const { id } = await store.upsertItem(db, baseItem);
  await store.dismiss(db, id, 7);
  // Simulate the 7-day suppression window having elapsed.
  await db.execute({ sql: "UPDATE fix_it_items SET suppressed_until = datetime('now','-1 day') WHERE id = ?", args: [id] });
  const re = await store.upsertItem(db, baseItem);
  assert.equal((await store.getItem(db, id)).status, "pending", "expired-dismissed reopens on re-detect");
  assert.equal(re.notify, true, "reopened-from-dismissed notifies");
  assert.equal((await store.listPending(db)).length, 1);
});

test("getItem returns null for missing id", async () => {
  await clear();
  assert.equal(await store.getItem(db, 99999), null);
});
