/**
 * F2 (advertised-contact prune, design §3) — Task 1: the provenance column.
 *
 * contacts.advertised_by_instance_id records a FACT: the instance_id of the peer
 * whose advertised-bot directory this contact was materialized from. It is set at
 * INSERT only. NULL = manual/pasted-invite contact, which is NEVER prunable.
 *
 * Harness mirrors tests/contact-tombstones.test.js: real init-db into a tmpdir
 * (never ~/.crow), then the async createDbClient handle.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { SCHEMA_GENERATION } from "../servers/shared/schema-version.js";

const tmpDir = mkdtempSync(join(tmpdir(), "crow-advby-test-"));
function initDb() {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: tmpDir },
    stdio: "pipe",
  });
}
initDb();
const DB_PATH = join(tmpDir, "crow.db");
after(() => rmSync(tmpDir, { recursive: true, force: true }));

const db = createDbClient(DB_PATH);

test("contacts has an advertised_by_instance_id TEXT column after init-db", async () => {
  const { rows } = await db.execute("PRAGMA table_info(contacts)");
  const col = rows.find((r) => r.name === "advertised_by_instance_id");
  assert.ok(col, "advertised_by_instance_id column present on contacts");
  assert.equal(String(col.type).toUpperCase(), "TEXT");
});

test("the schema generation was bumped for this migration (>= 7) and is stamped on the DB", async () => {
  assert.ok(
    SCHEMA_GENERATION >= 7,
    `SCHEMA_GENERATION must be >= 7 for the advertised_by_instance_id migration, got ${SCHEMA_GENERATION}`,
  );
  const { rows } = await db.execute("PRAGMA user_version");
  assert.equal(Number(rows[0].user_version), SCHEMA_GENERATION);
});

test("advertised_by_instance_id defaults to NULL (manual contact = never prunable)", async () => {
  await db.execute({
    sql: "INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey) VALUES (?,?,?,?)",
    args: ["crow:manual1", "Manual", "e".repeat(64), "s".repeat(66)],
  });
  const { rows } = await db.execute({
    sql: "SELECT advertised_by_instance_id FROM contacts WHERE crow_id = ?",
    args: ["crow:manual1"],
  });
  assert.equal(rows[0].advertised_by_instance_id, null);
});

test("the migration is additive — re-running init-db preserves existing contact rows", async () => {
  await db.execute({
    sql: "INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey) VALUES (?,?,?,?)",
    args: ["crow:survivor", "Survivor", "a".repeat(64), "b".repeat(66)],
  });
  initDb(); // must not throw, must not drop/recreate contacts
  const fresh = createDbClient(DB_PATH);
  const { rows } = await fresh.execute({
    sql: "SELECT display_name, advertised_by_instance_id FROM contacts WHERE crow_id = ?",
    args: ["crow:survivor"],
  });
  assert.equal(rows.length, 1, "pre-existing contact row survived the re-init");
  assert.equal(rows[0].display_name, "Survivor");
  assert.equal(rows[0].advertised_by_instance_id, null, "new column is present and NULL on the migrated row");
});

test("advertised_by_instance_id round-trips the advertising peer's instance_id", async () => {
  await db.execute({
    sql: "INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey, origin, advertised_by_instance_id) VALUES (?,?,?,?,?,?)",
    args: ["crow:advbot", "Bot", "c".repeat(64), "d".repeat(66), "advertised", "inst-grackle-1"],
  });
  const { rows } = await db.execute({
    sql: "SELECT advertised_by_instance_id FROM contacts WHERE crow_id = ?",
    args: ["crow:advbot"],
  });
  assert.equal(rows[0].advertised_by_instance_id, "inst-grackle-1");
});
