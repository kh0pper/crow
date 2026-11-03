/**
 * The card's "new recipient" hint (spec §12.3 item 4): which addresses in a staged draft the
 * operator has never written to.
 *
 * Crow has no email contact store of its own — `contacts` is the Nostr/peer table (its `email`
 * column is the only address it carries) — so an address counts as KNOWN when either says so:
 *   - it is on a `contacts` row, or
 *   - Gmail's `in:sent to:<addr>` search finds a message (the draft's own account, one result).
 * Everything else is a new recipient.
 *
 * It is a quiet hint, never a gate. The two "no answer" cases are kept apart, because the caller
 * caches one and retries the other:
 *   - `[]`  a real answer: every address is known, nothing is new. Cached as `"[]"` on the row.
 *   - a non-empty list of the new addresses. Cached the same way.
 *   - `null`  the answer cannot be told (no client, a failed search). Nothing is written, so the
 *     next read asks again. Caching it would freeze a Gmail outage into "no new recipients".
 *
 * No address is ever logged: this module writes nothing anywhere.
 */
import { parseAddressList } from "./canonical.js";

/** One Gmail search per address, so a 40-recipient draft cannot become 40 queries on every read. */
export const NEW_RECIPIENT_MAX = 20;

/**
 * The addresses in `snapshot` that are new (lower-cased, sorted), `[]` when none is new, or `null`
 * when that cannot be told. `gmail` is a Gmail client (gmail-client.js's `createGmailClient`);
 * without one there is nothing to ask, so the answer is "cannot tell".
 *
 * @returns {Promise<string[]|null>}
 */
export async function newRecipients(db, snapshot, { gmail = null } = {}) {
  if (!gmail || typeof gmail.hasSentTo !== "function") return null;
  const addresses = [...new Set([
    ...parseAddressList(snapshot?.to),
    ...parseAddressList(snapshot?.cc),
    ...parseAddressList(snapshot?.bcc),
  ])].sort().slice(0, NEW_RECIPIENT_MAX);

  const out = [];
  for (const address of addresses) {
    if (await isKnownContact(db, address)) continue;
    let written;
    try {
      written = await gmail.hasSentTo(address);
    } catch {
      // A failed search (auth, rate, network) is "cannot tell": answer with no hint at all rather
      // than mark half the list "new" because Gmail was busy.
      return null;
    }
    if (!written) out.push(address);
  }
  return out;
}

/**
 * Is this address on a `contacts` row? The table's `email` column is added by init-db's migration
 * (older databases may not carry it yet); a missing column or a locked table means "no contact
 * store", not a known contact.
 */
async function isKnownContact(db, address) {
  try {
    const { rows } = await db.execute({
      sql: "SELECT 1 AS hit FROM contacts WHERE lower(email) = ? LIMIT 1",
      args: [address],
    });
    return rows.length > 0;
  } catch {
    return false;
  }
}