#!/usr/bin/env node

/**
 * Crow AI Platform — .mcp.json Generator
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
import { CORE_SERVERS, CONDITIONAL_SERVERS, EXTERNAL_SERVERS, ROOT, loadEnv, resolveEnvValue } from "./server-registry.js";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const STDOUT = args.includes("--stdout");

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

  // Core servers — always included
  for (const server of CORE_SERVERS) {
    const resolvedEnv = server.mcpEnv ? resolveEnvObj(server.mcpEnv) : {};
    config.mcpServers[server.name] = {
      command: server.command,
      args: resolveArgs(server.args),
      ...(Object.keys(resolvedEnv).length > 0 ? { env: resolvedEnv } : {}),
    };
    included.push(server.name);
  }

  // Conditional core servers + external servers — include only if all envKeys are present
  for (const server of [...CONDITIONAL_SERVERS, ...EXTERNAL_SERVERS]) {
    const missingKeys = server.envKeys.filter((key) => !env[key]);

    if (missingKeys.length > 0) {
      skipped.push({ name: server.name, missing: missingKeys });
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
