/**
 * Upsert one of THIS instance's bots as an is_bot contact, so it can be a uniform
 * room member (phase 3a). The pubkeys are DERIVED (deriveBotIdentity), never stored
 * elsewhere — same anchor the pi-bots adapter subscribes on. The display name is
 * sourced from pi_bot_defs so it MATCHES what the adapter checks addressed_to
 * against (Task 7). Marked origin='local-bot' so the 1:1 peer list filters it out.
 * Idempotent on crow_id. Returns the contact id, or null on any failure (never throws).
 */
import { dirname } from "node:path";
import { loadInstanceSeed, deriveBotIdentity } from "../../../sharing/identity.js";
import { botsDbPath } from "../../../../scripts/pi-bots/instance-paths.mjs";

function defaultIdentityFor(botId) {
  const seed = loadInstanceSeed(dirname(botsDbPath()));
  return deriveBotIdentity(seed, botId); // { crowId, secp256k1Pubkey, ed25519Pubkey, ... }
}

async function resolveBotName(db, botId, override) {
  if (override) return override;
  try {
    const { rows } = await db.execute({ sql: "SELECT display_name FROM pi_bot_defs WHERE bot_id = ?", args: [botId] });
    if (rows[0]?.display_name) return rows[0].display_name;
  } catch { /* table/row may be absent */ }
  return botId;
}

export async function ensureLocalBotContact(db, botId, { displayName = null, _identityFor = defaultIdentityFor } = {}) {
  if (!botId) return null;
  try {
    const ident = _identityFor(botId);
    const crowId = ident.crowId;
    const secp = ident.secp256k1Pubkey;
    const ed = ident.ed25519Pubkey; // contacts.ed25519_pubkey is NOT NULL
    const name = await resolveBotName(db, botId, displayName);
    const { rows } = await db.execute({ sql: "SELECT id FROM contacts WHERE crow_id = ? LIMIT 1", args: [crowId] });
    if (rows.length) {
      await db.execute({
        sql: "UPDATE contacts SET is_bot = 1, display_name = ?, secp256k1_pubkey = ?, ed25519_pubkey = ?, origin = 'local-bot', verified = 0 WHERE id = ?",
        args: [name, secp, ed, rows[0].id],
      });
      return Number(rows[0].id);
    }
    const res = await db.execute({
      sql: "INSERT INTO contacts (crow_id, display_name, is_bot, secp256k1_pubkey, ed25519_pubkey, contact_type, origin) VALUES (?,?,1,?,?, 'crow', 'local-bot')",
      args: [crowId, name, secp, ed],
    });
    return Number(res.lastInsertRowid);
  } catch (err) {
    console.error("[rooms] ensureLocalBotContact failed:", err && err.message);
    return null;
  }
}
