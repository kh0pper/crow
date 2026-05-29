#!/usr/bin/env node

/**
 * Crow — .mcp.json Generator
 *
 * Generates .mcp.json dynamically from .env, including only servers
 * whose required env vars are set. Core servers are always included.
 *
 * Usage:
 *   node scripts/generate-mcp-config.js            # Generate .mcp.json
 *   node scripts/generate-mcp-config.js --dry-run  # Print without writing
 *   node scripts/generate-mcp-config.js --stdout    # Output JSON to stdout
 */

import { writeFileSync } from "fs";
import { resolve } from "path";
import { CORE_SERVERS, CONDITIONAL_SERVERS, EXTERNAL_SERVERS, COMBINED_SERVER, ROOT, loadEnv, resolveEnvValue, checkRequires } from "./server-registry.js";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const STDOUT = args.includes("--stdout");
const COMBINED = args.includes("--combined");
// --http: instead of spawning per-server stdio MCP processes (each of which
// opens the production crow.db — multiple Claude sessions then pile up WAL
// openers and stale ones wedge the DB with "disk I/O error"), point the client
// at the already-running gateway's /router/mcp over HTTP. Zero per-session DB
// openers; the gateway is the sole owner. Needs CROW_LOCAL_MCP_TOKEN in env/.env
// (a local-MCP bearer token, see docs) and optionally CROW_MCP_URL to target a
// non-default gateway (e.g. grackle's :3002).
const HTTP = args.includes("--http");

function log(msg) {
  if (!STDOUT) console.log(`  ${msg}`);
}

function generate() {
  const env = loadEnv();
  const config = { mcpServers: {} };
  const included = [];
  const skipped = [];

  // Resolve ${VAR} templates in env objects and args arrays
  function resolveEnvObj(envObj) {
    const resolved = {};
    for (const [k, v] of Object.entries(envObj)) {
      resolved[k] = resolveEnvValue(v, env);
    }
    return resolved;
  }
  function resolveArgs(args) {
    return args.map((a) => resolveEnvValue(a, env));
  }

  // Core servers — HTTP (single gateway connection), combined, or individual
  if (HTTP) {
    // One HTTP server to the running gateway's router. No stdio, no per-session
    // DB openers. Token + URL come from env (.env), resolved at generation time;
    // the output .mcp.json is gitignored (per-machine), so the token isn't shared.
    const token = env.CROW_LOCAL_MCP_TOKEN || "";
    const url = env.CROW_MCP_URL || "http://localhost:3001/router/mcp";
    config.mcpServers["crow-core"] = {
      type: "http",
      url,
      headers: { Authorization: `Bearer ${token}` },
    };
    included.push("crow-core (http)");
    if (!token) {
      skipped.push({ name: "crow-core token", missing: ["CROW_LOCAL_MCP_TOKEN"] });
    }
  } else if (COMBINED) {
    // Single crow-core server replaces all individual core servers
    const resolvedEnv = COMBINED_SERVER.mcpEnv ? resolveEnvObj(COMBINED_SERVER.mcpEnv) : {};
    config.mcpServers[COMBINED_SERVER.name] = {
      command: COMBINED_SERVER.command,
      args: resolveArgs(COMBINED_SERVER.args),
      ...(Object.keys(resolvedEnv).length > 0 ? { env: resolvedEnv } : {}),
    };
    included.push(`${COMBINED_SERVER.name} (combined)`);
  } else {
    for (const server of CORE_SERVERS) {
      const resolvedEnv = server.mcpEnv ? resolveEnvObj(server.mcpEnv) : {};
      config.mcpServers[server.name] = {
        command: server.command,
        args: resolveArgs(server.args),
        ...(Object.keys(resolvedEnv).length > 0 ? { env: resolvedEnv } : {}),
      };
      included.push(server.name);
    }
  }

  // Conditional core servers + external servers — include only if all envKeys are present
  for (const server of [...CONDITIONAL_SERVERS, ...EXTERNAL_SERVERS]) {
    // In --http mode the crow-owned servers (e.g. crow-storage) are reached via
    // the gateway router, not spawned as DB-opening stdio processes — skip them.
    if (HTTP && server.name.startsWith("crow-")) continue;
    const missingKeys = server.envKeys.filter((key) => !env[key]);

    if (missingKeys.length > 0) {
      skipped.push({ name: server.name, missing: missingKeys });
      continue;
    }

    // Check binary dependencies
    if (!checkRequires(server)) {
      const bins = server.requires.join(", ");
      skipped.push({ name: server.name, missing: [`binary: ${bins}`] });
      continue;
    }

    const serverArgs = server.mcpArgs || server.args;
    const serverEnv = server.mcpEnv || {};

    config.mcpServers[server.name] = {
      command: server.command,
      args: resolveArgs(serverArgs),
      ...(Object.keys(serverEnv).length > 0 ? { env: resolveEnvObj(serverEnv) } : {}),
    };
    included.push(server.name);
  }

  return { config, included, skipped };
}

// Main
const { config, included, skipped } = generate();
const json = JSON.stringify(config, null, 2);

if (STDOUT) {
  process.stdout.write(json);
  process.exit(0);
}

if (!DRY_RUN) {
  const outPath = resolve(ROOT, ".mcp.json");
  writeFileSync(outPath, json + "\n");
}

log("");
log(`Generated .mcp.json with ${included.length} servers:`);
log(`  Included: ${included.join(", ")}`);
if (skipped.length > 0) {
  log("");
  log(`Skipped ${skipped.length} (missing env vars):`);
  for (const { name, missing } of skipped) {
    log(`  ${name}: needs ${missing.join(", ")}`);
  }
}
log("");

if (DRY_RUN) {
  console.log("--- Generated config (dry run) ---\n");
  console.log(json);
  console.log("\n--- End config ---");
}
