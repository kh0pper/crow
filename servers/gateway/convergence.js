// servers/gateway/convergence.js
//
// An instance's job is to converge to the tree, not to pull.
//
// Three gateways (primary, MPA, r4) run from ONE shared ~/crow checkout with
// three separate data dirs. Pulling is a TREE operation — exactly one winner,
// guarded by the checkout-scoped lock in auto-update.js. Migrating and
// restarting are INSTANCE operations that every gateway must perform with its
// own env. Conflating the two is why the lock loser used to skip everything:
// its own migrations and its own restart-into-new-code, forever, because
// co-hosted gateways restart together and their 6h timers are phase-locked.

/**
 * A REGRESSION check, not an absolute one.
 *
 * "Every addon connected" would quarantine a perfectly good sha on any host
 * that already had a broken addon — precisely crow's state Aug 3-5 2026, when
 * `tasks` and `bots-sql-mcp` were down for an unrelated native-ABI reason. The
 * gate must answer "did this update break something?", not "is everything
 * perfect?".
 *
 * An addon that was already unhealthy is ignored. An addon that has vanished
 * from the snapshot entirely counts as `missing`, which IS a regression when it
 * was previously connected.
 *
 * @param {Record<string,string>|null} before pre-convergence snapshot
 * @param {Record<string,string>|null} after  post-restart snapshot
 * @returns {{ok: boolean, regressions: Array<{id: string, was: string, now: string}>}}
 */
export function compareHealth(before, after) {
  const regressions = [];
  for (const [id, was] of Object.entries(before || {})) {
    if (was !== "connected") continue; // already unhealthy — not ours to blame
    const now = (after || {})[id] ?? "missing";
    if (now !== "connected") regressions.push({ id, was, now });
  }
  return { ok: regressions.length === 0, regressions };
}
