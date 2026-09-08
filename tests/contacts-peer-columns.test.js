/**
 * Spec 2026-09-08 §4.4: the two peer-profile columns are ADDITIVE and land
 * with no SCHEMA_GENERATION bump — init-db adds them for fresh installs (this
 * file), sharing init adds them for existing hosts (tests/peer-profile.test.js).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";

function runInitDb(dir) {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
}

test("init-db adds contacts.peer_display_name and contacts.peer_avatar (TEXT), idempotently, without a generation bump", async () => {
  const dir = mkdtempSync(join(tmpdir(), "peer-cols-"));
  try {
    runInitDb(dir);
    const db = createClient({ url: "file:" + join(dir, "crow.db") });
    try {
      await db.execute("INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey) VALUES ('crow:keep', 'Keep', '', '')");
      const uvBefore = Number((await db.execute("PRAGMA user_version")).rows[0].user_version);
      runInitDb(dir); // a second run must not error, duplicate or drop
      const { rows } = await db.execute("PRAGMA table_info(contacts)");
      for (const c of ["peer_display_name", "peer_avatar"]) {
        const cols = rows.filter((r) => r.name === c);
        assert.equal(cols.length, 1, `${c} present exactly once`);
        assert.equal(String(cols[0].type).toUpperCase(), "TEXT");
        assert.equal(Number(cols[0].notnull), 0, `${c} nullable`);
      }
      assert.equal(Number((await db.execute("SELECT COUNT(*) AS n FROM contacts")).rows[0].n), 1, "rows survive a re-run");
      assert.equal(Number((await db.execute("PRAGMA user_version")).rows[0].user_version), uvBefore, "no generation bump for an additive column");
    } finally { try { db.close(); } catch {} }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
