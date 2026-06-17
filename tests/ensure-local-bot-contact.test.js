import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureLocalBotContact } from "../servers/gateway/dashboard/shared/ensure-local-bot-contact.js";

function freshLibsql() {
  const dir = mkdtempSync(join(tmpdir(), "crowroom-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: join(import.meta.dirname, "..") });
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return { dir, db, cleanup() { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}

// Inject a stub identity resolver so the test needs no identity.json on disk.
const stubIdentity = (botId) => ({ crowId: "crow:bot-" + botId, secp256k1Pubkey: "02" + "a".repeat(64), ed25519Pubkey: "b".repeat(64) });

test("creates an is_bot contact with derived pubkeys + pi_bot_defs name; idempotent", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    // The bot's friendly name comes from pi_bot_defs so it aligns with what the
    // adapter checks addressed_to against (Task 7).
    await db.execute({ sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled) VALUES ('bot1','Research Bot','{}',1)", args: [] });
    const id1 = await ensureLocalBotContact(db, "bot1", { _identityFor: stubIdentity });
    assert.ok(id1 > 0);
    const { rows } = await db.execute({ sql: "SELECT crow_id, display_name, is_bot, secp256k1_pubkey, ed25519_pubkey, origin FROM contacts WHERE id = ?", args: [id1] });
    assert.equal(rows[0].crow_id, "crow:bot-bot1");
    assert.equal(Number(rows[0].is_bot), 1);
    assert.equal(rows[0].display_name, "Research Bot", "name sourced from pi_bot_defs");
    assert.equal(rows[0].secp256k1_pubkey, "02" + "a".repeat(64));
    assert.equal(rows[0].ed25519_pubkey, "b".repeat(64), "ed25519 NOT NULL satisfied");
    assert.equal(rows[0].origin, "local-bot", "marked so it is filtered from the 1:1 peer list");
    // Idempotent: same crow_id → same row id, no duplicate.
    const id2 = await ensureLocalBotContact(db, "bot1", { _identityFor: stubIdentity });
    assert.equal(id2, id1);
    const { rows: all } = await db.execute("SELECT COUNT(*) AS n FROM contacts");
    assert.equal(Number(all[0].n), 1);
  } finally { cleanup(); }
});
