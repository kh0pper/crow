/**
 * Crow Messages gateway — admin (libsql) side, for the gateway/UI process.
 *
 * The pi-bots adapter reads bot_message_acl/bot_message_invites via better-sqlite3
 * (crow-messages-store.mjs); this is the write/manage counterpart the dashboard
 * uses via libsql (db.execute). Same crow.db file — single-statement writes.
 *
 * Identity is derived (never stored): the gateway's own instance seed
 * (loadInstanceSeed(dirname(botsDbPath()))) + the bot id → deriveBotIdentity.
 */
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import {
  loadInstanceSeed, deriveBotIdentity, generateBotInviteCode,
} from "../../../../sharing/identity.js";
import { botsDbPath } from "../../../../../scripts/pi-bots/instance-paths.mjs";

const DEFAULT_RELAYS = ["wss://relay.damus.io", "wss://nos.lol"];

/** x-only normalize: a 66-hex compressed secp key → 64-hex. */
export function xOnly(hex) { const h = String(hex || ""); return h.length === 66 ? h.slice(2) : h; }

/**
 * Derive this instance's identity for the given bot (pure; nothing stored).
 * Seed source = loadInstanceSeed(dirname(botsDbPath())) — the SAME anchor the
 * pi-bots adapter uses (crow-messages.mjs:75), so the editor's crow_id and the
 * adapter's subscription key are guaranteed identical. Read-only: throws (not
 * creates) if no identity.json exists beside the crow.db.
 */
export function botIdentityFor(botId) {
  const seed = loadInstanceSeed(dirname(botsDbPath()));
  return deriveBotIdentity(seed, botId);
}

/** Instance-configured Nostr relays (libsql), else defaults. Mirrors store.resolveRelays. */
export async function resolveRelays(db) {
  try {
    const { rows } = await db.execute({
      sql: "SELECT relay_url FROM relay_config WHERE relay_type='nostr' AND enabled=1", args: [],
    });
    if (rows.length) return rows.map((r) => r.relay_url);
  } catch { /* table may be absent */ }
  return DEFAULT_RELAYS;
}

/** Mint a fresh invite token row. Returns the token string. */
export async function mintInvite(db, botId, { expiresAt = null, maxUses = null } = {}) {
  const token = randomBytes(24).toString("base64url");
  await db.execute({
    sql: "INSERT INTO bot_message_invites (bot_id, token, expires_at, max_uses) VALUES (?,?,?,?)",
    args: [botId, token, expiresAt, maxUses],
  });
  return token;
}

/** Latest non-revoked, non-expired invite for a bot, or null. */
export async function getActiveInvite(db, botId) {
  const { rows } = await db.execute({
    sql: "SELECT id, token, expires_at, max_uses, uses, revoked, created_at FROM bot_message_invites "
       + "WHERE bot_id=? AND revoked=0 AND (expires_at IS NULL OR expires_at > datetime('now')) "
       + "ORDER BY id DESC LIMIT 1",
    args: [botId],
  });
  return rows[0] || null;
}

/** Revoke every prior token for the bot, then mint a fresh one. Returns the new token. */
export async function rotateInvite(db, botId, opts = {}) {
  await db.execute({ sql: "UPDATE bot_message_invites SET revoked=1 WHERE bot_id=?", args: [botId] });
  return mintInvite(db, botId, opts);
}

/** All ACL rows for a bot (the "Who can message" list). */
export async function listAcl(db, botId) {
  const { rows } = await db.execute({
    sql: "SELECT id, sender_pubkey, crow_id, display_name, added_via, created_at "
       + "FROM bot_message_acl WHERE bot_id=? ORDER BY created_at ASC",
    args: [botId],
  });
  return rows;
}

/** Remove one authorized sender (by x-only pubkey). */
export async function removeAcl(db, botId, senderPubkey) {
  await db.execute({
    sql: "DELETE FROM bot_message_acl WHERE bot_id=? AND sender_pubkey=?",
    args: [botId, xOnly(senderPubkey)],
  });
}

/** Manually authorize a sender (Advanced add-by-pubkey). Idempotent on (bot, pubkey). */
export async function addManualAcl(db, botId, senderPubkey, crowId = null, displayName = null) {
  await db.execute({
    sql: "INSERT INTO bot_message_acl (bot_id, sender_pubkey, crow_id, display_name, added_via) "
       + "VALUES (?,?,?,?, 'manual') "
       + "ON CONFLICT(bot_id, sender_pubkey) DO UPDATE SET crow_id=excluded.crow_id, display_name=excluded.display_name",
    args: [botId, xOnly(senderPubkey), crowId, displayName],
  });
}

/** The bot's human display name (for friendly invite labels), or null. */
export async function displayNameFor(db, botId) {
  try {
    const { rows } = await db.execute({ sql: "SELECT display_name FROM pi_bot_defs WHERE bot_id=?", args: [botId] });
    return rows[0]?.display_name || null;
  } catch { return null; }
}

/** Build the shareable, ed25519-signed invite code for (bot, token). Carries the
 *  bot's display name so the recipient sees a friendly label, not the crow: id. */
export async function buildInviteCode(db, botId, token) {
  const botIdentity = botIdentityFor(botId);
  const relays = await resolveRelays(db);
  const name = await displayNameFor(db, botId);
  return generateBotInviteCode(botIdentity, token, relays, name);
}
