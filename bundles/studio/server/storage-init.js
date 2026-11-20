/**
 * Studio's Crow storage bootstrap — its own module, so the decision can be exercised without
 * loading the song engine (the MCP server pulls the whole editor graph, `yjs` included).
 *
 * The spawning process already decided this for a bot turn (scripts/pi-bots/mcp_writer.mjs
 * pipes only the OPENED settings, never the seed):
 *
 *   "hydrated" — this instance's opened Shared Storage settings are in this process's env;
 *   "off"      — a file-delivery config could not carry them: NO shared storage at all.
 *
 * Both skip identity.json entirely (servers/storage/s3-client.js adoptHostStorage). null means
 * an OWNER's own spawn: the s3-client opens the sealed settings from the DB itself, which is
 * the only place that reads the identity — this bundle's server code contains no seed
 * reference at all (tests/bot-seed-import-guard.test.js).
 *
 * A failure here must never stop the server: edits still work, and a render reports the
 * storage problem its own way.
 */
import { appImport } from "./app-root.js";

/**
 * @param {{db?: object|null}} [opts] this process's crow.db client (the owner path needs it)
 * @returns {Promise<object|null>} the s3-client module, or null when there is no storage
 */
export async function openStorageModule({ db = null } = {}) {
  try {
    const storage = await appImport("servers/storage/s3-client.js");
    const hostStorage = typeof storage.adoptHostStorage === "function" ? storage.adoptHostStorage() : null;
    if (hostStorage) return hostStorage === "hydrated" ? storage : null;
    if (typeof storage.useDbStorageConfigFromInstance === "function" && db) {
      await storage.useDbStorageConfigFromInstance(db);
    }
    return storage;
  } catch {
    return null;
  }
}