/**
 * Ramble egg locks — is this egg spoken for by an open swap?
 *
 * A LEAF module: it imports nothing, deliberately. The rule lived in
 * trades.js, but trades.js imports `startOfLocalDay` from eggs.js, and phase
 * 3's auto-promote (eggs.js) must skip a locked egg — so keeping it there
 * would force an eggs -> trades -> eggs cycle. trades.js re-exports both
 * helpers, so its existing importers (flock.js:22 and tests/ramble-trades
 * .test.js:14 — NOT panel/routes.js, which never imported them) are
 * unchanged and there is still exactly one definition of "locked".
 */

// Verbatim from trades.js:68. An "open" trade is one that still has a claim on
// the egg; changing this set would silently change which eggs are giftable.
export const OPEN_SQL = "state IN ('proposed', 'accepted')";

export async function lockedEggIds(db) {
  const { rows } = await db.execute({
    sql: `SELECT my_egg_id FROM ramble_trades WHERE my_egg_id IS NOT NULL AND ${OPEN_SQL}`,
    args: [],
  });
  return new Set(rows.map((r) => r.my_egg_id));
}

export async function isEggLocked(db, eggId) {
  const { rows } = await db.execute({
    sql: `SELECT 1 FROM ramble_trades WHERE my_egg_id = ? AND ${OPEN_SQL} LIMIT 1`,
    args: [eggId],
  });
  return rows.length > 0;
}
