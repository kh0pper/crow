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

/**
 * Find the bot's reusable paired-roster invite (unlimited-use, non-expiring,
 * kind='paired-roster', not revoked), or mint one. Returns the token string.
 * One invite suffices: all of the operator's paired instances share one Nostr
 * identity, so a single accept authorizes every sibling.
 */
export async function getOrCreatePairedRosterInvite(db, botId) {
  const { rows } = await db.execute({
    sql: "SELECT token FROM bot_message_invites WHERE bot_id=? AND kind='paired-roster' AND revoked=0 ORDER BY id DESC LIMIT 1",
    args: [botId],
  });
  if (rows.length) return rows[0].token;
  const token = randomBytes(24).toString("base64url");
  await db.execute({
    sql: "INSERT INTO bot_message_invites (bot_id, token, expires_at, max_uses, kind) VALUES (?,?,NULL,NULL,'paired-roster')",
    args: [botId, token],
  });
  return token;
}

/** Bots whose def has a crow-messages gateway with allow_paired_instances=true. */
export async function listAdvertisedBots(db) {
  const { rows } = await db.execute({
    sql: "SELECT bot_id, display_name, definition FROM pi_bot_defs WHERE enabled=1",
    args: [],
  });
  const out = [];
  for (const r of rows) {
    let def;
    try { def = JSON.parse(r.definition || "{}"); } catch { continue; }
    const gw = Array.isArray(def.gateways)
      ? def.gateways.find((g) => g && g.type === "crow-messages" && g.allow_paired_instances === true)
      : null;
    if (!gw) continue;
    out.push({ botId: r.bot_id, displayName: r.display_name || r.bot_id });
  }
  return out;
}

/**
 * Build the advertisement payload served to paired peers. Each entry carries a
 * reusable paired-roster invite code (which embeds the bot's pubkey + relays +
 * name) plus the x-only messaging pubkey for receiver-side dedup. A bot whose
 * identity can't derive (no instance seed) is skipped, not fatal.
 *
 * NOTE: there is intentionally NO top-level `relay_url` (the relays are already
 * embedded in the signed invite_code via generateBotInviteCode, so a separate
 * field would be redundant).
 *
 * `_identityFor`/`_buildInviteCode` are injectable test seams (mirrors the
 * `_setFetchImpl` style elsewhere); production passes neither.
 */
export async function buildAdvertisementPayload(
  db, { instanceId, instanceLabel, _identityFor = botIdentityFor, _buildInviteCode = buildInviteCode } = {}
) {
  const bots = [];
  for (const b of await listAdvertisedBots(db)) {
    try {
      const ident = _identityFor(b.botId); // throws if no identity.json beside crow.db
      const token = await getOrCreatePairedRosterInvite(db, b.botId);
      const inviteCode = await _buildInviteCode(db, b.botId, token);
      bots.push({
        bot_id: b.botId,
        display_name: b.displayName,
        instance_id: instanceId,
        instance_label: instanceLabel,
        messaging_pubkey: xOnly(ident.secp256k1Pubkey),
        invite_code: inviteCode,
      });
    } catch (err) {
      // Skip a bot whose identity can't derive (no instance seed). Log so a
      // surprising DB/identity error leaves a trace rather than vanishing
      // silently (cf. the 2026-06-14 crow.db silent-federation-blackout).
      console.warn(`[crow-messages] advertise skip for bot ${b.botId}:`, err.message);
    }
  }
  return { bots };
}
