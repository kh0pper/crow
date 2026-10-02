/**
 * boot/ramble-boot.js — decide whether this gateway runs the Ramble transport.
 *
 * The transport only starts when the Ramble bundle is INSTALLED on this
 * instance (`<CROW_HOME>/bundles/ramble/server` exists). It used to fall back
 * to the repo copy (`bundles/ramble/server`), which every checkout has — so
 * every sharing-enabled gateway ran Ramble whether or not the user installed
 * it. Because all of a user's Crows share one Nostr identity, each of those
 * gateways processed every contact's Ramble DM and wrote game state (warmth,
 * gifts, swaps, and on pre-0.11 code a freshly minted egg) that replicated to
 * the instance that does have Ramble. One writer per install, not one per
 * checkout.
 *
 * Without the bundle installed, the Ramble TABLES are still created from the
 * repo copy: `initRambleTables` is idempotent DDL with no side effects, and a
 * peer that lacks the tables would drop every replicated `ramble_*` op it is
 * sent, leaving it with no history if Ramble is installed there later.
 *
 * Every dependency is injected so the decision is testable without a gateway.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** The installed bundle's server dir, or null when Ramble is not installed here. */
export function installedRambleServerDir(crowHome, exists = existsSync) {
  const dir = join(crowHome, "bundles", "ramble", "server");
  return exists(dir) ? dir : null;
}

/**
 * @param {object} o
 * @param {string} o.crowHome
 * @param {string} o.repoServerDir   repo `bundles/ramble/server` (tables only)
 * @param {object} o.db
 * @param {() => Promise<object>} o.startTransport  called with the installed dir only
 * @param {(dir: string) => Promise<{initRambleTables: Function}>} [o.loadInitTables]
 * @param {(p: string) => boolean} [o.exists]
 * @returns {Promise<{started: boolean, transport?: object, reason?: string}>}
 */
export async function bootRamble({
  crowHome, repoServerDir, db, startTransport,
  loadInitTables = (dir) => import(pathToFileURL(join(dir, "init-tables.js")).href),
  exists = existsSync,
}) {
  const installed = installedRambleServerDir(crowHome, exists);
  if (installed) {
    const transport = await startTransport(installed);
    return { started: true, transport };
  }
  if (repoServerDir && exists(repoServerDir)) {
    const { initRambleTables } = await loadInitTables(repoServerDir);
    await initRambleTables(db);
  }
  return { started: false, reason: "not-installed" };
}
