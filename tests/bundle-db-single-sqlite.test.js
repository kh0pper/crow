/**
 * Single-SQLite-per-process invariant for bundle DB factories.
 *
 * 2026-08-04 root cause: bundle code imported @libsql/client (a second
 * SQLite build) into the gateway process alongside better-sqlite3. POSIX
 * fcntl locks never conflict within one PID, so a libsql connection close
 * "won" its last-closer check against the gateway's own connections and
 * unlinked the live crow.db-wal/-shm — splitting WAL generations and
 * corrupting the database (r4 x3, main x4 incidents).
 *
 * Guards:
 *  1. No bundle db factory (or the knowledge-base panel routes, which run
 *     INSIDE the gateway) may STATICALLY import @libsql/client — only a
 *     lazy dynamic import inside an explicit fallback is allowed.
 *  2. In-repo, every bundle factory must resolve the core better-sqlite3
 *     client and round-trip through it without loading @libsql.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const FACTORY_FILES = [
  "bundles/pm-workspace/server/db.js",
  "bundles/knowledge-base/server/db.js",
  "bundles/knowledge-base/panel/routes.js",
  "bundles/maker-lab/server/db.js",
  "bundles/tax/server/db.js",
  "bundles/media/server/db.js",
  "bundles/campaigns/server/db.js",
  "bundles/iptv/server/db.js",
];

test("no static @libsql/client import in bundle db factories or in-gateway panel routes", () => {
  for (const rel of FACTORY_FILES) {
    const src = readFileSync(join(repo, rel), "utf8");
    assert.ok(
      !/^\s*import\s+[^;]*from\s+["']@libsql\/client["']/m.test(src),
      `${rel} must not statically import @libsql/client (second SQLite build in-process unlinks the live WAL)`
    );
  }
});

test("knowledge-base panel routes have no @libsql fallback at all (gateway-resident)", () => {
  const src = readFileSync(join(repo, "bundles/knowledge-base/panel/routes.js"), "utf8");
  assert.ok(
    !/import\s*\(\s*["']@libsql\/client["']\s*\)/.test(src) &&
    !/from\s+["']@libsql\/client["']/.test(src),
    "panel routes run inside the gateway; no libsql import path may exist (comments are fine)"
  );
});

for (const bundle of ["pm-workspace", "knowledge-base", "tax", "media", "campaigns", "iptv"]) {
  test(`${bundle} factory resolves the core client and round-trips in-repo`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), `crow-bundledb-${bundle}-`));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const mod = await import(`../bundles/${bundle}/server/db.js`);
    const db = mod.createDbClient(join(dir, "t.db"));
    await db.execute("CREATE TABLE roundtrip (id INTEGER PRIMARY KEY, v TEXT)");
    await db.execute({ sql: "INSERT INTO roundtrip (v) VALUES (?)", args: ["x"] });
    const r = await db.execute("SELECT count(*) AS c FROM roundtrip");
    assert.equal(Number(r.rows[0].c), 1);
    db.close();
  });
}
