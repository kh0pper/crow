#!/usr/bin/env node
/**
 * Register providers from an installed bundle's manifest.json into the
 * `providers` DB table. One-shot; invoked by `scripts/crow` after the
 * bundle-install `cp -r` step (which the HTTP install route does for free
 * via POST /bundles/api/install; this closes the same gap for the CLI path).
 *
 * Failure mode: always exits 0 on recoverable errors (missing manifest,
 * empty crow_instances, DB unavailable) so the outer `crow bundle install`
 * command doesn't fail for the operator. The gateway startup reconciler is
 * the belt-and-suspenders if this step skips for any reason.
 *
 * Usage:
 *   node scripts/crow-register-providers.js <bundle_id>
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

const bundleId = process.argv[2];
if (!bundleId) {
  console.error("Usage: crow-register-providers.js <bundle_id>");
  process.exit(0);
}

const CROW_HOME = process.env.CROW_DATA_DIR || resolve(homedir(), ".crow");
const manifestPath = resolve(CROW_HOME, "bundles", bundleId, "manifest.json");

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch (err) {
  console.log(`[register-providers] Skip ${bundleId}: ${err.message}`);
  process.exit(0);
}

if (!Array.isArray(manifest.providers) || manifest.providers.length === 0) {
  console.log(`[register-providers] ${bundleId}: no providers to register`);
  process.exit(0);
}

// Resolve host IP the same way the HTTP install route does: local → 127.0.0.1;
// remote → look up the paired instance's tailscale_ip. On fresh installs the
// crow_instances table may be empty; getInstance returns null and we fall
// back to 127.0.0.1 (the gateway reconciler will fix up later if needed).
let hostIp = "127.0.0.1";
let providerDb;
try {
  const { createDbClient } = await import("../servers/db.js");
  providerDb = createDbClient();
} catch (err) {
  console.log(`[register-providers] ${bundleId}: DB unavailable (${err.message}); gateway reconciler will retry`);
  process.exit(0);
}

try {
  if (manifest.host && manifest.host !== "local") {
    const { getInstance } = await import("../servers/gateway/instance-registry.js");
    try {
      const peer = await getInstance(providerDb, manifest.host);
      if (peer?.tailscale_ip) hostIp = peer.tailscale_ip;
      else if (peer?.gateway_url) {
        hostIp = peer.gateway_url
          .replace(/^https?:\/\//, "")
          .replace(/:\d+$/, "")
          .replace(/\/.*/, "") || hostIp;
      }
    } catch {
      // crow_instances missing/empty on fresh install — fall through with 127.0.0.1
    }
  }

  const { registerProviderFromManifest } = await import("../servers/orchestrator/providers-db.js");
  const port = manifest.port || 0;
  let registered = 0;
  for (const pdef of manifest.providers) {
    try {
      const r = await registerProviderFromManifest({
        db: providerDb, manifest, providerDef: pdef, port, hostIp,
      });
      console.log(`[register-providers] ${bundleId}: ${pdef.id} → ${r.lamport_ts}`);
      registered++;
    } catch (err) {
      console.log(`[register-providers] ${bundleId}: skip ${pdef.id} (${err.message})`);
    }
  }
  console.log(`[register-providers] ${bundleId}: registered ${registered}/${manifest.providers.length}`);
} catch (err) {
  console.log(`[register-providers] ${bundleId}: ${err.message}`);
}

process.exit(0);
