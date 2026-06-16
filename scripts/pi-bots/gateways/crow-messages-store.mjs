/**
 * Crow Messages gateway store — per-bot authorization + invite tokens, for the
 * pi-bots host (better-sqlite3, synchronous). Pubkeys are x-only 64-hex.
 */
const DEFAULT_RELAYS = ["wss://relay.damus.io", "wss://nos.lol"];

function xOnly(hex) { const h = String(hex || ""); return h.length === 66 ? h.slice(2) : h; }

/** Resolve the instance's configured Nostr relays (mirror nostr.js), else default. */
export function resolveRelays(db) {
  try {
    const rows = db.prepare("SELECT relay_url FROM relay_config WHERE relay_type='nostr' AND enabled=1").all();
    if (rows.length) return rows.map((r) => r.relay_url);
  } catch { /* table may be absent */ }
  return DEFAULT_RELAYS;
}

/**
 * True if senderPubkey (x-only after normalization) is in botId's ACL.
 * Plan 1 = ACL-only (default-deny). The "allow any paired instance" source is a
 * Plan 2 addition (crow_instances has no secp key today — see plan scope note).
 */
export function authorizeSender(db, botId, senderPubkey) {
  const pk = xOnly(senderPubkey);
  const acl = db.prepare("SELECT 1 FROM bot_message_acl WHERE bot_id=? AND sender_pubkey=? LIMIT 1").get(botId, pk);
  return !!acl;
}

/** Validate + consume an invite token (atomic-ish: check then bump uses). */
export function consumeInvite(db, botId, token) {
  const row = db.prepare("SELECT id, max_uses, uses, revoked, expires_at FROM bot_message_invites WHERE bot_id=? AND token=?").get(botId, token);
  if (!row) return false;
  if (Number(row.revoked) === 1) return false;
  if (row.expires_at) {
    const exp = db.prepare("SELECT (datetime('now') > ?) AS expired").get(row.expires_at);
    if (Number(exp.expired) === 1) return false;
  }
  if (row.max_uses != null && Number(row.uses) >= Number(row.max_uses)) return false;
  db.prepare("UPDATE bot_message_invites SET uses = uses + 1 WHERE id=?").run(row.id);
  return true;
}

/** Add/refresh an authorized sender from an accepted invite. */
export function upsertAclFromAccept(db, botId, senderPubkey, crowId, displayName) {
  const pk = xOnly(senderPubkey);
  db.prepare(`INSERT INTO bot_message_acl (bot_id, sender_pubkey, crow_id, display_name, added_via)
              VALUES (?,?,?,?, 'invite')
              ON CONFLICT(bot_id, sender_pubkey) DO UPDATE SET
                crow_id=excluded.crow_id, display_name=excluded.display_name`)
    .run(botId, pk, crowId || null, displayName || null);
}

/**
 * Persistent processed-event dedup. Returns true the FIRST time (bot, event) is
 * seen, false on a repeat — surviving a host restart so a relay's 24h replay
 * doesn't re-run pi turns for already-answered chats. Mark BEFORE running a turn
 * (at-most-once on crash, preferable to a replay storm).
 */
export function markEventSeen(db, botId, eventId) {
  if (!eventId) return false;
  const r = db.prepare("INSERT OR IGNORE INTO bot_message_seen (bot_id, event_id) VALUES (?,?)").run(botId, eventId);
  return r.changes > 0;
}

/** Drop seen-event rows older than `days` (keeps the table bounded). */
export function pruneSeen(db, days = 2) {
  db.prepare("DELETE FROM bot_message_seen WHERE created_at < datetime('now', '-' || ? || ' days')").run(days);
}

export { xOnly, DEFAULT_RELAYS };
