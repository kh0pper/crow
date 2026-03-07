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

import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import { homedir, platform } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
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

function loadEnv() {
  const envPath = resolve(ROOT, ".env");
  const env = {};
  if (existsSync(envPath)) {
    const lines = readFileSync(envPath, "utf8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex === -1) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      const value = trimmed.slice(eqIndex + 1).trim();
      if (value) env[key] = value;
    }
  }
  return env;
}

function resolveEnvValue(template, env) {
  return template.replace(/\$\{(\w+)(?::-(.*?))?\}/g, (_, key, fallback) => {
    return env[key] || fallback || "";
  });
}

function buildConfig(env) {
  const crowRoot = ROOT;
  const dbPath = resolve(crowRoot, env.CROW_DB_PATH || "./data/crow.db");
  const filesPath = env.CROW_FILES_PATH || "/home";

  const config = { mcpServers: {} };
  const missing = [];

  // Custom servers (always included)
  config.mcpServers["crow-memory"] = {
    command: "node",
    args: [resolve(crowRoot, "servers/memory/index.js")],
    env: { CROW_DB_PATH: dbPath }
  };

  config.mcpServers["crow-research"] = {
    command: "node",
    args: [resolve(crowRoot, "servers/research/index.js")],
    env: { CROW_DB_PATH: dbPath }
  };

  // External servers
  const servers = [
    {
      name: "trello",
      command: "npx", args: ["-y", "mcp-server-trello"],
      envKeys: ["TRELLO_API_KEY", "TRELLO_TOKEN"],
      envMap: { TRELLO_API_KEY: "TRELLO_API_KEY", TRELLO_TOKEN: "TRELLO_TOKEN" }
    },
    {
      name: "canvas-lms",
      command: "npx", args: ["-y", "mcp-canvas-lms"],
      envKeys: ["CANVAS_API_TOKEN", "CANVAS_BASE_URL"],
      envMap: { CANVAS_API_TOKEN: "CANVAS_API_TOKEN", CANVAS_BASE_URL: "CANVAS_BASE_URL" }
    },
    {
      name: "google-workspace",
      command: "uvx", args: ["workspace-mcp"],
      envKeys: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
      envMap: { GOOGLE_CLIENT_ID: "GOOGLE_CLIENT_ID", GOOGLE_CLIENT_SECRET: "GOOGLE_CLIENT_SECRET" }
    },
    {
      name: "mcp-research",
      command: "uvx", args: ["mcp-research"],
      envKeys: [], envMap: {}
    },
    {
      name: "zotero",
      command: "uvx", args: ["zotero-mcp"],
      envKeys: ["ZOTERO_API_KEY", "ZOTERO_USER_ID"],
      envMap: { ZOTERO_API_KEY: "ZOTERO_API_KEY", ZOTERO_USER_ID: "ZOTERO_USER_ID" }
    },
    {
      name: "notion",
      command: "npx", args: ["-y", "@notionhq/notion-mcp-server"],
      envKeys: ["NOTION_TOKEN"],
      buildEnv: (e) => ({
        OPENAPI_MCP_HEADERS: JSON.stringify({
          Authorization: `Bearer ${e.NOTION_TOKEN || ""}`,
          "Notion-Version": "2022-06-28"
        })
      })
    },
    {
      name: "slack",
      command: "npx", args: ["-y", "@anthropic/mcp-server-slack"],
      envKeys: ["SLACK_BOT_TOKEN"],
      envMap: { SLACK_BOT_TOKEN: "SLACK_BOT_TOKEN" }
    },
    {
      name: "discord",
      command: "npx", args: ["-y", "mcp-discord"],
      envKeys: ["DISCORD_BOT_TOKEN"],
      envMap: { DISCORD_BOT_TOKEN: "DISCORD_BOT_TOKEN" }
    },
    {
      name: "microsoft-teams",
      command: "npx", args: ["-y", "mcp-server-microsoft-teams"],
      envKeys: ["TEAMS_CLIENT_ID", "TEAMS_CLIENT_SECRET", "TEAMS_TENANT_ID"],
      envMap: { TEAMS_CLIENT_ID: "TEAMS_CLIENT_ID", TEAMS_CLIENT_SECRET: "TEAMS_CLIENT_SECRET", TEAMS_TENANT_ID: "TEAMS_TENANT_ID" }
    },
    {
      name: "github",
      command: "npx", args: ["-y", "@modelcontextprotocol/server-github"],
      envKeys: ["GITHUB_PERSONAL_ACCESS_TOKEN"],
      envMap: { GITHUB_PERSONAL_ACCESS_TOKEN: "GITHUB_PERSONAL_ACCESS_TOKEN" }
    },
    {
      name: "brave-search",
      command: "npx", args: ["-y", "@modelcontextprotocol/server-brave-search"],
      envKeys: ["BRAVE_API_KEY"],
      envMap: { BRAVE_API_KEY: "BRAVE_API_KEY" }
    },
    {
      name: "filesystem",
      command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", filesPath],
      envKeys: [], envMap: {}
    }
  ];

  for (const server of servers) {
    const serverEnv = {};
    const missingKeys = [];

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
      args: server.args,
      ...(Object.keys(serverEnv).length > 0 ? { env: serverEnv } : {})
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
