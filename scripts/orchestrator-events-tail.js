#!/usr/bin/env node
/**
 * Minimal CLI tail for orchestrator_events.
 *
 * Usage:
 *   node scripts/orchestrator-events-tail.js              # last 50 events
 *   node scripts/orchestrator-events-tail.js --follow     # live tail (poll every 2s)
 *   node scripts/orchestrator-events-tail.js --limit 200
 *   node scripts/orchestrator-events-tail.js --run <id>
 *
 * Phase 5-full observability per plan CR-8 — must ship before Phase 2/4
 * so lifecycle pathologies are debuggable in prod without a full UI.
 */

import { createDbClient } from "../servers/db.js";
import { attachEventLogger, listRecentEvents } from "../servers/orchestrator/events.js";

function parseArgs(argv) {
  const out = { limit: 50, follow: false, runId: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--limit") out.limit = parseInt(argv[++i], 10);
    else if (a === "--follow" || a === "-f") out.follow = true;
    else if (a === "--run") out.runId = argv[++i];
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

function fmt(row) {
  const t = row.at;
  const ev = row.event_type.padEnd(28);
  const p = (row.provider_id || "-").padEnd(22);
  const b = row.bundle_id ? ` [${row.bundle_id}]` : "";
  const r = typeof row.refs === "number" ? ` refs=${row.refs}` : "";
  const d = row.data ? ` ${row.data}` : "";
  return `${t}  ${ev}  ${p}${r}${b}${d}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("orchestrator-events-tail — live view of lifecycle + dispatch events\n");
    console.log("  --limit N       number of rows to display (default 50)");
    console.log("  --follow / -f   live-tail mode (poll every 2s)");
    console.log("  --run <id>      filter to a specific run_id");
    process.exit(0);
  }

  const db = await createDbClient();
  attachEventLogger(db);

  if (args.follow) {
    // Live tail: print latest row on each poll if it's newer than seen
    let lastId = 0;
    // Seed with the most recent ID so we don't flood on startup
    const seed = await listRecentEvents({ limit: 1, runId: args.runId });
    if (seed[0]) lastId = seed[0].id;

    while (true) {
      const rows = await listRecentEvents({ limit: 200, runId: args.runId });
      const fresh = rows.filter((r) => r.id > lastId).sort((a, b) => a.id - b.id);
      for (const r of fresh) {
        console.log(fmt(r));
        if (r.id > lastId) lastId = r.id;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  } else {
    const rows = await listRecentEvents({ limit: args.limit, runId: args.runId });
    // Reverse so oldest is at top when reading like a log
    rows.reverse();
    for (const r of rows) console.log(fmt(r));
  }
}

main().catch((err) => { console.error(`FAIL: ${err.message}`); process.exit(1); });
