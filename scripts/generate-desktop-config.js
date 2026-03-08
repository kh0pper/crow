#!/usr/bin/env node

/**
 * Crow AI Platform — Claude Desktop Config Generator
 *
 * Generates a claude_desktop_config.json file with all Crow MCP servers
 * configured for Claude Desktop. Detects OS and installs to the correct path.
 *
 * Usage:
 *   node scripts/generate-desktop-config.js            # Generate and install
 *   node scripts/generate-desktop-config.js --dry-run  # Print config without installing
 *   node scripts/generate-desktop-config.js --stdout    # Output JSON to stdout
 */

import { writeFileSync, existsSync, copyFileSync, mkdirSync } from "fs";
import { resolve, dirname, join } from "path";
import { homedir, platform } from "os";
import { CORE_SERVERS, CONDITIONAL_SERVERS, EXTERNAL_SERVERS, ROOT, loadEnv } from "./server-registry.js";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const STDOUT = args.includes("--stdout");

function log(msg) {
  if (!STDOUT) console.log(`  ${msg}`);
}

function getConfigPath() {
  const home = homedir();
  switch (platform()) {
    case "darwin":
      return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
    case "win32":
      return join(process.env.APPDATA || join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
    default: // linux
      return join(home, ".config", "Claude", "claude_desktop_config.json");
  }
}

function buildConfig(env) {
  const dbPath = resolve(ROOT, env.CROW_DB_PATH || "./data/crow.db");
  const filesPath = env.CROW_FILES_PATH || "/home";

  const config = { mcpServers: {} };
  const missing = [];

  // Core servers (always included, with absolute paths for desktop)
  for (const server of CORE_SERVERS) {
    config.mcpServers[server.name] = {
      command: server.command,
      args: [resolve(ROOT, server.args[0])],
      env: { CROW_DB_PATH: dbPath },
    };
  }

  // Conditional core + external servers
  for (const server of [...CONDITIONAL_SERVERS, ...EXTERNAL_SERVERS]) {
    const serverEnv = {};
    const missingKeys = [];

    // Build desktop args — handle filesystem path injection
    let desktopArgs = [...server.args];
    if (server.name === "filesystem") {
      desktopArgs.push(filesPath);
    } else if (server.name === "render" && env.RENDER_API_KEY) {
      desktopArgs.push("--header", `Authorization: Bearer ${env.RENDER_API_KEY}`);
    }

    if (server.buildEnv) {
      Object.assign(serverEnv, server.buildEnv(env));
    } else if (server.envMap) {
      for (const [envKey, configKey] of Object.entries(server.envMap)) {
        if (env[envKey]) {
          serverEnv[configKey] = env[envKey];
        } else {
          missingKeys.push(envKey);
        }
      }
    }

    if (missingKeys.length > 0) {
      missing.push({ server: server.name, keys: missingKeys });
    }

    config.mcpServers[server.name] = {
      command: server.command,
      args: desktopArgs,
      ...(Object.keys(serverEnv).length > 0 ? { env: serverEnv } : {}),
    };
  }

  return { config, missing };
}

// Main
if (!STDOUT) {
  console.log("\n" + "=".repeat(50));
  console.log("  Crow AI Platform — Desktop Config Generator");
  console.log("=".repeat(50));
}

const env = loadEnv();
const { config, missing } = buildConfig(env);
const json = JSON.stringify(config, null, 2);

if (STDOUT) {
  process.stdout.write(json);
  process.exit(0);
}

if (missing.length > 0) {
  log("");
  log("Warning: Some API keys are not set in .env:");
  for (const { server, keys } of missing) {
    log(`  ${server}: ${keys.join(", ")}`);
  }
  log("These servers will be included but may not work until keys are added.");
  log("");
}

if (DRY_RUN) {
  console.log("\n--- Generated config (dry run) ---\n");
  console.log(json);
  console.log("\n--- End config ---\n");
  const configPath = getConfigPath();
  log(`Would install to: ${configPath}`);
  process.exit(0);
}

const configPath = getConfigPath();
const configDir = dirname(configPath);

// Create directory if needed
if (!existsSync(configDir)) {
  mkdirSync(configDir, { recursive: true });
  log(`Created directory: ${configDir}`);
}

// Backup existing config
if (existsSync(configPath)) {
  const backupPath = configPath + ".backup." + Date.now();
  copyFileSync(configPath, backupPath);
  log(`Backed up existing config to: ${backupPath}`);
}

// Write new config
writeFileSync(configPath, json + "\n");
log(`Config written to: ${configPath}`);
log(`Configured ${Object.keys(config.mcpServers).length} MCP servers.`);
log("");
log("Restart Claude Desktop to apply changes.");
