/**
 * The body of `GET /dashboard/mail/api/accounts`: every connected account as the owner may see it,
 * plus the addresses another live Crow instance holds.
 *
 * The shape carries nothing from the connection settings — no host, no port, no username, no secret,
 * no claim key or hash. It is what the owner typed (a label), the mailbox address, the stored status,
 * when mail last synced, and two derived facts: `unreadCount` and, for an account this Crow may not
 * sync, `heldBy` — the winning instance's name, the same name the "already connected on <name>"
 * sentence carries. A separate function so plan 2's panel can draw the same thing without the HTTP
 * layer.
 *
 * `unreadCount` is one per logical message, not one per row: a Gmail label copy stored in two folders
 * is one unread message (the dedupe `searchLocal` and the thread counts use). A row with no
 * Message-ID counts alone.
 *
 * A `claimed_elsewhere` row whose claim has since cleared (the holder released it, or its instance is
 * gone) answers `heldBy: null`; the supervisor is the one that turns the status back to `active`, so
 * this read never writes.
 */
import { checkClaim, listForeignClaims } from "./claims.js";
import { listAccounts } from "./store/accounts.js";

/** Unread messages per account, grouped into logical messages (account_id + message_id, or the row). */
const UNREAD_SQL = `
  WITH ranked AS (
    SELECT account_id, is_read,
           ROW_NUMBER() OVER (
             PARTITION BY account_id,
               CASE WHEN message_id IS NULL THEN 'row:' || id ELSE 'msg:' || message_id END
             ORDER BY date DESC, id DESC) AS rn
      FROM mail_messages
  )
  SELECT account_id, COUNT(*) AS unread
    FROM ranked
   WHERE rn = 1 AND is_read = 0
   GROUP BY account_id`;

/**
 * @param {object} db the Crow db client
 * @param {{localInstanceId: string}} options this instance's id (the claim winner is computed against it)
 * @returns {Promise<{accounts: object[], elsewhere: {instanceName: string, claimedAt: number|null}[]}>}
 */
export async function accountsOverview(db, { localInstanceId } = {}) {
  const [accounts, unreadRows, elsewhere] = await Promise.all([
    listAccounts(db),
    db.execute({ sql: UNREAD_SQL, args: [] }),
    listForeignClaims(db, { localInstanceId }),
  ]);

  const unread = new Map();
  for (const row of unreadRows.rows) unread.set(String(row.account_id), Number(row.unread ?? 0));

  const out = [];
  for (const account of accounts) {
    let heldBy = null;
    if (account.status === "claimed_elsewhere") {
      const verdict = await checkClaim(db, account.address, { localInstanceId });
      // A blank name is the same fallback the fixed sentence uses.
      if (!verdict.ok) heldBy = verdict.instanceName || "another Crow";
    }
    out.push({
      id: account.id,
      label: account.label,
      address: account.address,
      status: account.status,
      statusDetail: account.statusDetail,
      heldBy,
      localModelsOnly: account.localModelsOnly,
      digestOptIn: account.digestOptIn,
      lastSyncAt: account.lastSyncAt,
      unreadCount: unread.get(account.id) ?? 0,
    });
  }

  return {
    accounts: out,
    elsewhere: elsewhere.map((claim) => ({ instanceName: claim.instanceName, claimedAt: claim.claimedAt })),
  };
}

export default accountsOverview;