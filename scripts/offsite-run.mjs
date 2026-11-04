#!/usr/bin/env node
/**
 * crow's off-site backup job entry point (SAT-8, spec §12.3): what the two systemd timers run.
 *
 *   node scripts/offsite-run.mjs upload    # encrypt tonight's crow.db backup → the satellite vault
 *   node scripts/offsite-run.mjs verify    # read the newest vault file back and check it
 *
 * The timers are TEMPLATES under scripts/systemd/ — nothing installs or enables them. Deploy does,
 * after the owner has a keychain export holding the off-site key.
 *
 * Prints one JSON line (the job result) plus a short human line; never the key. Exit 0 for a
 * success or a deliberate skip (nothing to do — e.g. no server paired), 1 for a failure, 2 for a
 * usage error. A failure also raises the dashboard notification itself (see satellites/offsite.js).
 *
 * SIGTERM/SIGINT remove this run's scratch directory before exiting: a verify killed mid-flight
 * must not leave the decrypted crow.db in the temp dir (see installScratchCleanupOnSignal).
 */
import { createDbClient } from "../servers/db.js";
import { installScratchCleanupOnSignal, runOffsiteUpload, runOffsiteVerify } from "../servers/gateway/satellites/offsite.js";

const USAGE = "usage: node scripts/offsite-run.mjs upload|verify";

installScratchCleanupOnSignal();

function human(job, result) {
  if (result.ok && job === "upload") {
    const removed = Array.isArray(result.removed) && result.removed.length ? `, pruned ${result.removed.length} old cop${result.removed.length === 1 ? "y" : "ies"}` : "";
    return `off-site upload ok: ${result.name} (${result.size} bytes), the server reports the same size and sha256${removed}`;
  }
  if (result.ok && job === "verify") {
    return `off-site verify ok: ${result.name} decrypts, integrity_check is ok, ${result.memories} memories (${result.live_memories} live)`;
  }
  const why = result.code === "no_satellite" ? "no server is paired"
    : result.code === "no_backup" ? "no local crow.db backup to send yet"
      : result.code === "stale_backup" ? "the newest local backup is over a day old — has the nightly backup stopped?"
        : `not ok: ${result.code}`;
  return `off-site ${job} did not run to completion — ${why}`;
}

async function main(argv) {
  const job = argv[0];
  if (job !== "upload" && job !== "verify") {
    console.error(USAGE);
    return 2;
  }
  const db = createDbClient();
  try {
    const result = job === "upload" ? await runOffsiteUpload({ db }) : await runOffsiteVerify({ db });
    console.log(JSON.stringify(result));
    console.log(human(job, result));
    // A skip (no server paired, nothing to send) is not a failure: there is nothing to fix.
    if (result.ok || result.code === "no_satellite" || result.code === "no_backup") return 0;
    return 1;
  } finally {
    try { db.close(); } catch { /* already closed */ }
  }
}

main(process.argv.slice(2)).then((code) => process.exit(code)).catch((err) => {
  console.error(`off-site job failed: ${err?.message || err}`);
  process.exit(1);
});