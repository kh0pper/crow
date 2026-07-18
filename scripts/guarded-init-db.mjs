#!/usr/bin/env node
/**
 * guarded-init-db.mjs — run init-db through the A3 migration guard.
 *
 * The production way to apply migrations by hand: pre-migration backup +
 * post-migration loss classification + restore-and-quarantine on
 * high-confidence loss. Used by scripts/install.sh (existing-install branch)
 * and scripts/crow-update.sh; operators can run it directly.
 *
 * `npm run init-db` stays the BARE seam (scratch envs, tests, dev); prefer
 * this wrapper on any database you care about.
 *
 * Exit codes: 0 = pass/fresh/suspect/unreadable (fail open), 2 = loss
 * (restored + quarantined), 3 = refused (active quarantine marker).
 */

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDataDir } from "../servers/db.js";
import {
  activeMarker, dataMarkerPath, readTreeGeneration, repoMarkerPath,
  resolveGuardDbPath, runGuardedInitDb,
} from "../servers/shared/migration-guard.js";

const appRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const dbPath = resolveGuardDbPath(resolveDataDir);

const marker = activeMarker(dataMarkerPath(dbPath)) || activeMarker(repoMarkerPath(appRoot));
if (marker) {
  console.error(
    `REFUSED: migration gen ${marker.fromGeneration}->${marker.toGeneration} (sha ${marker.sha}) is quarantined — ` +
    `it damaged data on a previous run. Delete these files to override:\n  ${dataMarkerPath(dbPath)}\n  ${repoMarkerPath(appRoot)}`
  );
  process.exit(3);
}

let sha = null;
try {
  sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: appRoot, timeout: 10000 }).toString().trim();
} catch {}

const res = await runGuardedInitDb({
  dbPath,
  appRoot,
  sha,
  newGeneration: readTreeGeneration(appRoot),
});

console.log(`[guarded-init-db] verdict: ${res.verdict}` + (res.backupPath ? ` (backup: ${res.backupPath})` : ""));
if (res.report && (res.report.losses.length || res.report.suspects.length)) {
  for (const l of res.report.losses) console.error(`  LOSS: ${l}`);
  for (const s of res.report.suspects) console.warn(`  suspect: ${s}`);
}
if (res.verdict === "loss") {
  if (res.restored) {
    console.error(`Database restored from backup; migration quarantined. Evidence: ${res.evidence}`);
    console.error("Restart any Crow-connected processes (gateway, MCP servers, bots) now.");
  } else {
    console.error("Migration quarantined but automatic restore was NOT possible.");
    console.error(res.backupPath
      ? `Restore manually: stop the gateway, then copy ${res.backupPath} over the database.`
      : "No backup was available — check disk space and docs/developers/db-recovery.md.");
  }
  process.exit(2);
}
if (res.initDbExit !== 0) {
  console.error(`init-db exited ${res.initDbExit} — schema may be incomplete; see output above.`);
  process.exit(res.initDbExit || 1);
}
