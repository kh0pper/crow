import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";

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
