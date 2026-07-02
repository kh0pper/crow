/**
 * Shared secp256k1 pubkey normalization + contact lookup helpers (L6
 * message-requests groundwork).
 *
 * Nostr events carry a 32-byte x-only pubkey (64 hex chars) as
 * `event.pubkey`; `contacts.secp256k1_pubkey` stores the 33-byte
 * compressed form collected at contact-add time (66 hex chars, `02`/`03`
 * prefix). Any pubkey match across these two representations MUST
 * normalize to the trailing 64 hex chars, lowercased — mirrors the
 * existing ad-hoc pattern at
 * servers/gateway/dashboard/panels/messages/data-queries.js:171.
 */

/**
 * Normalize a secp256k1 pubkey (64-hex x-only, or 66-hex 02/03-prefixed
 * compressed) to its trailing-64-hex lowercase form. Never throws —
 * null/undefined/short input just produces a short/garbage string that
 * won't match any stored key.
 */
export function normalizePubkey(pk) {
  try {
    return String(pk).slice(-64).toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Look up a contacts row by secp256k1 pubkey, matching on the trailing
 * 64 hex chars so a 66-hex compressed key and its 64-hex x-only tail
 * resolve to the same contact. Returns the row or null. Never throws
 * (bad/missing db, null/short pk, or a query error all resolve to null).
 */
export async function findContactByPubkey(db, pk) {
  try {
    const normalized = normalizePubkey(pk);
    if (!normalized) return null;
    const { rows } = await db.execute({
      sql: "SELECT * FROM contacts WHERE lower(substr(secp256k1_pubkey,-64)) = ?",
      args: [normalized],
    });
    return rows && rows.length > 0 ? rows[0] : null;
  } catch {
    return null;
  }
}
