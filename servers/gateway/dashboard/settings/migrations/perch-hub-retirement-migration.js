/**
 * perch-hub bundle retirement migration (Track 3, Task 17, spec §6).
 *
 * The board's roost strip + session drawer replaced the standalone perch-hub
 * bundle (vendored hub payload + gateway-supervised child + dashboard panel)
 * in Track 3. A host that had it installed is left with three pieces of
 * filesystem/state debris this migration removes:
 *
 *   - `<CROW_HOME>/bundles/perch-hub/` — the vendored payload directory.
 *   - `<CROW_HOME>/perch-token` — the bearer token perch-runtime.js minted
 *     for the extension-proxy to inject (see the module's own header, now
 *     deleted with it).
 *   - the `perch-hub` entry in `<CROW_HOME>/installed.json`, so the
 *     Extensions panel stops listing a bundle that no longer exists on disk.
 *
 * Invocation pattern matches `theme-keys-migration.js`: not self-registered,
 * dynamically imported and run once at boot from
 * `servers/gateway/boot/admin-api.js`, guarded by its own `dashboard_settings`
 * flag key (deliberately NOT in SYNC_ALLOWLIST — each instance runs its own
 * pass against its own CROW_HOME, same rationale as the LLM/theme migrations'
 * flags). Idempotent: safe to run with the debris present, partially present,
 * or entirely absent, and safe to run twice.
 */

import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readSetting, upsertSetting } from "../registry.js";
import { CROW_HOME } from "../../../bundles-config.js";

const FLAG_KEY = "perch_hub_retirement_migration_v1_done";

/**
 * Entry point. Idempotent. Returns a summary for logging.
 *
 * @param {object} db
 * @param {string} [crowHome] test seam; defaults to the instance's real CROW_HOME.
 */
export async function migratePerchHubRetirement(db, crowHome = CROW_HOME) {
  if (await readSetting(db, FLAG_KEY)) {
    return { skipped: "already_migrated" };
  }

  let removedPayloadDir = false;
  let removedTokenFile = false;
  let removedInstalledEntry = false;

  const payloadDir = join(crowHome, "bundles", "perch-hub");
  if (existsSync(payloadDir)) {
    rmSync(payloadDir, { recursive: true, force: true });
    removedPayloadDir = true;
  }

  const tokenFile = join(crowHome, "perch-token");
  if (existsSync(tokenFile)) {
    rmSync(tokenFile, { force: true });
    removedTokenFile = true;
  }

  const installedPath = join(crowHome, "installed.json");
  if (existsSync(installedPath)) {
    try {
      const installed = JSON.parse(readFileSync(installedPath, "utf8"));
      if (Array.isArray(installed)) {
        const filtered = installed.filter((i) => i?.id !== "perch-hub");
        if (filtered.length !== installed.length) {
          writeFileSync(installedPath, JSON.stringify(filtered, null, 2));
          removedInstalledEntry = true;
        }
      }
    } catch {
      // Unreadable/malformed installed.json — leave it for the operator
      // rather than guessing at a rewrite.
    }
  }

  await upsertSetting(
    db,
    FLAG_KEY,
    JSON.stringify({ at: new Date().toISOString(), version: 1 }),
  );

  return { removedPayloadDir, removedTokenFile, removedInstalledEntry };
}
