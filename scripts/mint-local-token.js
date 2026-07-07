#!/usr/bin/env node
/**
 * Mint (or rotate) the local MCP token HEADLESSLY (F-INSTALL-3).
 *
 * The interactive path is the dashboard Connect panel (one-time reveal).
 * This is the no-browser path for appliances/harnesses: only sha256(token)
 * is stored (local-scoped dashboard setting keyed to this instance); the raw
 * value is printed exactly once, to stdout, and never logged elsewhere.
 *
 * Usage:
 *   npm run local-token             # refuses if a token already exists
 *   npm run local-token -- --rotate # replace (existing clients stop working)
 */
import { createDbClient } from "../servers/db.js";
import { generateLocalToken, getLocalTokenMeta } from "../servers/gateway/local-token.js";

const db = createDbClient();
try {
  const meta = await getLocalTokenMeta(db);
  const rotate = process.argv.includes("--rotate");
  if (meta.present && !rotate) {
    console.error(`A local MCP token already exists (created ${meta.createdAt || "unknown"}).`);
    console.error("Re-run with --rotate to replace it — existing MCP clients using it will stop working.");
    // exitCode (not process.exit) so the finally below still closes the db;
    // the process then exits naturally with code 1.
    process.exitCode = 1;
  } else {
    const token = await generateLocalToken(db);
    console.log("Local MCP token (shown ONCE — copy it now):");
    console.log(token);
    console.log("");
    console.log("Use it as an Authorization: Bearer header on any MCP path, e.g. /sharing/mcp.");
    console.log("Manage/rotate later in the dashboard: Connect panel.");
  }
} finally {
  try { db.close(); } catch {}
}
