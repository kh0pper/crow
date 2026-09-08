/**
 * Peer profile — what a contact tells us about themselves (spec 2026-09-08
 * §4.2–§4.4, decision D5).
 *
 * Two contact columns, `peer_display_name` and `peer_avatar`, hold the name
 * and inline picture a PEER sent — in the pairing handshake (both directions)
 * and in the `profile` crow_social message that every full contact receives
 * when the profile changes. They are kept apart from `display_name` /
 * `avatar_url`, which the user typed and which always win on screen
 * (servers/sharing/contact-display.js). Nothing here ever writes those two.
 *
 * The receive rule is contact-only: a profile message is applied when its
 * AUTHENTICATED sender resolves to a FULL (request_status NULL), unblocked
 * contact; a stranger's, a pending request's and a blocked contact's are
 * dropped silently. The broadcast is best effort and idempotent — the next
 * change resends everything, so there is no retry queue.
 */
import { ensureColumn } from "../db.js";
import { findContactByPubkey } from "./pubkey-util.js";
import { sanitizeDisplayName } from "./display-name.js";
import { validateAvatar } from "./avatar.js";
import { emitContactChange } from "./contact-sync.js";

export const PROFILE_SUBTYPE = "profile";
/** A raw dashboard_settings row (NOT in the sync allowlist, never emitted — the profile-heal flag precedent): "1" = the last fan-out did not fully succeed, resend on the next chance. */
export const PROFILE_BROADCAST_PENDING_KEY = "__profile_broadcast_pending";
const HEX_KEY = /^[0-9a-fA-F]{64}(?:[0-9a-fA-F]{2})?$/;

/**
 * Review R2 ruling R2-1: an ESTABLISHED contact is a full row (request_status
 * NULL) OR a message request the user explicitly accepted ('accepted' — it
 * follows the user, syncs, and is listed in Messages). 'pending' is a
 * stranger's unanswered request. Every writer of peer_* and every recipient
 * list uses this one predicate.
 */
export function isEstablishedContact(row) {
  const st = row?.request_status;
  return st === null || st === undefined || st === "accepted";
}

export async function readBroadcastPending(db) {
  try {
    const { rows } = await db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = ?", args: [PROFILE_BROADCAST_PENDING_KEY] });
    return rows?.[0]?.value === "1";
  } catch { return false; }
}

async function writeBroadcastPending(db, pending) {
  try {
    await db.execute({
      sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      args: [PROFILE_BROADCAST_PENDING_KEY, pending ? "1" : "0"],
    });
  } catch (err) {
    // A failed write here (either direction) means the flag can UNDERSTATE
    // reality: if the "1" write fails and the fan-out then partially fails,
    // the later "0" write never runs either, so no row exists and
    // readBroadcastPending falls back to false — one FEWER resend, not one
    // extra, silently dropping the R2-S3 guarantee. Loud on purpose.
    try { console.warn("[sharing] writeBroadcastPending failed:", err?.message); } catch {}
  }
}

/** Runtime guard for existing hosts (init-db only re-runs on a generation bump — the shared_items.mode precedent). Never throws. */
export async function ensurePeerProfileColumns(db) {
  for (const col of ["peer_display_name", "peer_avatar"]) {
    try { await ensureColumn(db, "contacts", col, "TEXT"); }
    catch (err) { try { console.warn(`[sharing] ensureColumn contacts.${col}:`, err?.message); } catch {} }
  }
  // R1-S3: on an existing host this guard is the ONLY path to the columns
  // (no generation bump), and instance-sync caches the column list once per
  // process — so a swallowed failure here must at least be loud.
  try {
    const { rows } = await db.execute({ sql: "PRAGMA table_info(contacts)", args: [] });
    const have = new Set((rows || []).map((r) => r.name));
    if (!have.has("peer_display_name") || !have.has("peer_avatar")) {
      console.error("[sharing] contacts.peer_* columns MISSING after ensureColumn — peer profiles are disabled for this process; run `npm run init-db`");
    }
  } catch { /* an unreadable schema was already warned about above */ }
}

/**
 * The local user's own profile as it goes on the wire: sanitized name,
 * validated picture; null for each when unset, rejected or unreadable. Reads
 * the GLOBAL rows on purpose (Cluster B D6: profile identity is user-level;
 * per-instance overrides of profile_* keys are intentionally inert).
 */
export async function readLocalProfile(db) {
  const out = { displayName: null, avatar: null };
  try {
    if (!db) return out;
    const { rows } = await db.execute({
      sql: "SELECT key, value FROM dashboard_settings WHERE key IN ('profile_display_name', 'profile_avatar_url')",
      args: [],
    });
    for (const r of rows || []) {
      if (r.key === "profile_display_name") out.displayName = sanitizeDisplayName(r.value);
      else if (r.key === "profile_avatar_url") out.avatar = validateAvatar(r.value);
    }
  } catch { /* unreadable settings: nothing goes on the wire */ }
  return out;
}

/** Pure: the envelope. Nulls are sent as nulls so a cleared name/picture propagates. */
export function buildProfileMessage({ displayName = null, avatar = null } = {}) {
  return JSON.stringify({
    type: "crow_social",
    version: 1,
    subtype: PROFILE_SUBTYPE,
    payload: { v: 1, display_name: sanitizeDisplayName(displayName), avatar: validateAvatar(avatar) },
  });
}

/**
 * Write what a peer told us into ITS contact row. `undefined` leaves a field
 * alone (the handshake may omit either); a string is sanitized/validated;
 * null or a rejected value clears. Emits the contacts sync op (full row) when
 * something actually changed, so the user's other instances converge.
 */
export async function applyPeerProfile(db, contactId, fields = {}) {
  if (!db || contactId == null) return { changed: false, row: null };
  const before = (await db.execute({ sql: "SELECT * FROM contacts WHERE id = ?", args: [contactId] })).rows[0];
  if (!before) return { changed: false, row: null };
  const next = {
    peer_display_name: fields.displayName === undefined ? (before.peer_display_name ?? null) : sanitizeDisplayName(fields.displayName),
    peer_avatar: fields.avatar === undefined ? (before.peer_avatar ?? null) : validateAvatar(fields.avatar),
  };
  if ((before.peer_display_name ?? null) === next.peer_display_name && (before.peer_avatar ?? null) === next.peer_avatar) {
    return { changed: false, row: before };
  }
  await db.execute({
    sql: "UPDATE contacts SET peer_display_name = ?, peer_avatar = ? WHERE id = ?",
    args: [next.peer_display_name, next.peer_avatar, contactId],
  });
  const row = (await db.execute({ sql: "SELECT * FROM contacts WHERE id = ?", args: [contactId] })).rows[0];
  try { await emitContactChange("update", row); } catch { /* sync is best-effort */ }
  return { changed: true, row };
}

/** The `profile` crow_social receiver. Contact-only; never throws (receive path). */
export async function handleProfileMessage(db, payload, senderPubkey) {
  try {
    if (!db || !senderPubkey || !payload || typeof payload !== "object" || Array.isArray(payload)) return { applied: false, reason: "bad-input" };
    const contact = await findContactByPubkey(db, senderPubkey);
    if (!contact) return { applied: false, reason: "stranger" };
    if (!isEstablishedContact(contact)) return { applied: false, reason: "not-established" };
    if (Number(contact.is_blocked) === 1) return { applied: false, reason: "blocked" };
    const has = (k) => Object.prototype.hasOwnProperty.call(payload, k);
    const r = await applyPeerProfile(db, contact.id, {
      displayName: has("display_name") ? payload.display_name : undefined,
      avatar: has("avatar") ? payload.avatar : undefined,
    });
    return { applied: true, changed: r.changed, contactId: contact.id };
  } catch (err) {
    try { console.warn("[sharing] profile message failed:", err?.message); } catch {}
    return { applied: false, reason: "error" };
  }
}

/**
 * Who gets a profile message: established, unblocked, human, keyed contacts.
 * Filtered in JS over a bare SELECT * — never in SQL — so (a) a db that
 * predates is_bot/origin still answers, and (b) the established/blocked
 * checks stay the SAME predicate as handleProfileMessage's receive gate.
 * is_blocked is nullable (init-db: no NOT NULL), so the block check reads it
 * as `Number(r.is_blocked || 0) !== 1` — identical to handleProfileMessage's
 * `Number(contact.is_blocked) === 1` — so a NULL is_blocked row is treated as
 * unblocked on BOTH the send and receive sides.
 */
export async function profileRecipients(db) {
  try {
    const { rows } = await db.execute({ sql: "SELECT * FROM contacts ORDER BY id", args: [] });
    return (rows || []).filter((r) =>
      isEstablishedContact(r) &&
      Number(r.is_blocked || 0) !== 1 &&
      !Number(r.is_bot || 0) &&
      r.origin !== "local-bot" &&
      r.contact_type !== "manual" &&
      HEX_KEY.test(String(r.secp256k1_pubkey || "")));
  } catch { return []; }
}

/**
 * One NIP-44 control DM per recipient, best effort. Returns counts. Records
 * the pending flag: "1" before the fan-out, "0" only after a fan-out with no
 * failure and nothing skipped — so a save made offline is re-sent by the next
 * save or bird refresh even when the profile did not change (R2-S3).
 */
export async function broadcastProfile(db, nostrManager) {
  const out = { sent: 0, failed: 0, skipped: 0 };
  if (!db) { out.skipped = 1; return out; }
  await writeBroadcastPending(db, true);
  if (!nostrManager || typeof nostrManager.sendControl !== "function") { out.skipped = 1; return out; }
  const content = buildProfileMessage(await readLocalProfile(db));
  for (const c of await profileRecipients(db)) {
    try {
      await nostrManager.sendControl({ id: c.id, secp256k1_pubkey: c.secp256k1_pubkey }, content);
      out.sent++;
    } catch (err) {
      out.failed++;
      try { console.warn(`[sharing] profile to ${c.crow_id} failed:`, err?.message); } catch {}
    }
  }
  if (out.failed === 0 && out.skipped === 0) await writeBroadcastPending(db, false);
  return out;
}
