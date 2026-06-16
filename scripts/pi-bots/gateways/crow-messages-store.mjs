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
 * True if senderPubkey (x-only) may message botId.
 * Sources: (1) the bot's ACL (default-deny), OR (2) when allowPaired is true,
 * the sender is one of the operator's own paired instances — i.e. a contacts
 * row (which carries the secp key) whose crow_id is a registered crow_instances
 * row (crow_instances itself has no secp key, so we join contacts by crow_id).
 * Fail-closed: any error → false.
 */
export function authorizeSender(db, botId, senderPubkey, allowPaired = false) {
  const pk = xOnly(senderPubkey);
  try {
    const acl = db.prepare("SELECT 1 FROM bot_message_acl WHERE bot_id=? AND sender_pubkey=? LIMIT 1").get(botId, pk);
    if (acl) return true;
    if (allowPaired) {
      // contacts.secp256k1_pubkey is the 66-hex COMPRESSED key (02/03 prefix);
      // events authorize on the 64-hex x-only key. Compare the trailing 64 hex
      // so BOTH y-parities match (a `02`+pk equality test would miss every
      // 03-prefixed contact — ~half of them).
      const paired = db.prepare(
        "SELECT 1 FROM contacts c JOIN crow_instances i ON i.crow_id = c.crow_id "
        + "WHERE substr(c.secp256k1_pubkey, -64) = ? AND c.is_blocked = 0 AND i.status != 'revoked' LIMIT 1"
      ).get(pk);
      if (paired) return true;
    }
  } catch { return false; }
  return false;
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
