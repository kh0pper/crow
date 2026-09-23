#!/usr/bin/env node
// Read-only: on a COPY of a crow.db, what would (1) the reconciler's owned
// asserts change in `host`, and (2) repairProviderHosts change? Each is
// evaluated against the pre-assert state; in the real pass repair sees the
// post-assert row — equivalent today because asserted rows are models.json
// rows and repair's scope excludes nothing they could flip into.
// Usage: provider-host-repair-dryrun.mjs <db-copy> <own-instance-id> <addr,addr,...> [models.json,...]
import { readFileSync } from "node:fs";
import { createDbClient } from "../../servers/db.js";
import { listProvidersAll } from "../../servers/shared/providers-db.js";
import { inferHost, repairHostDecision } from "../../servers/shared/provider-host.js";
import { isLocallyOrchestratable } from "../../servers/shared/locality.js";

const [dbPath, ownInstanceId, addrCsv, modelsCsv = ""] = process.argv.slice(2);
if (!dbPath || !ownInstanceId || !addrCsv) {
  console.error("usage: provider-host-repair-dryrun.mjs <db-copy> <own-instance-id> <addr,...> [models.json,...]");
  process.exit(2);
}
const ownAddrs = new Set(["localhost", "127.0.0.1", "::1", ...addrCsv.split(",")]);
const file = {};
for (const p of modelsCsv.split(",").filter(Boolean)) {
  try { Object.assign(file, JSON.parse(readFileSync(p, "utf8")).providers || {}); } catch (e) { console.error(`skip ${p}: ${e.message}`); }
}
const db = createDbClient(dbPath);
const rows = await listProvidersAll(db);
let a = 0, r = 0;
for (const row of rows) {
  const f = file[row.id];
  if (f && !row.disabled && isLocallyOrchestratable({ baseUrl: f.baseUrl }, ownAddrs)) {
    const h = inferHost(f.baseUrl, f.host, { ownAddrs });
    if (h !== row.host) { a++; console.log(`ASSERT\t${row.id}\t${row.host} -> ${h}`); }
  }
  const next = repairHostDecision(row, { ownInstanceId, ownAddrs });
  if (next !== null) { r++; console.log(`REPAIR\t${row.id}\t${row.host} -> ${next}\t${row.baseUrl}`); }
}
console.log(`assert host changes: ${a}; repairs: ${r}`);
db.close?.();
