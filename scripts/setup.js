#!/usr/bin/env node

/**
 * Crow Setup Script
 *
 * Initializes the database, checks for required dependencies,
 * and validates the configuration.
 */

import { execSync } from "child_process";
import { existsSync, copyFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { CORE_SERVERS, EXTERNAL_SERVERS } from "./server-registry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

function log(msg) {
  console.log(`  ${msg}`);
}

function header(msg) {
  console.log(`\n${"═".repeat(50)}`);
  console.log(`  ${msg}`);
  console.log(`${"═".repeat(50)}`);
}

header("Crow Setup");

// Step 1: Check Node.js version
const nodeVersion = parseInt(process.version.slice(1));
if (nodeVersion < 18) {
  console.error(`Node.js 18+ required. You have ${process.version}`);
  process.exit(1);
}
log(`Node.js ${process.version} - OK`);

// Step 2: Install dependencies
log("Installing npm dependencies...");
try {
  execSync("npm install", { cwd: ROOT, stdio: "inherit" });
} catch {
  console.error("Failed to install dependencies.");
  process.exit(1);
}

// Step 3: Create .env if it doesn't exist
const envPath = resolve(ROOT, ".env");
const envExamplePath = resolve(ROOT, ".env.example");
if (!existsSync(envPath) && existsSync(envExamplePath)) {
  copyFileSync(envExamplePath, envPath);
  log("Created .env from .env.example — fill in your API keys!");
} else if (existsSync(envPath)) {
  log(".env file exists - OK");
}

// Step 4: Ensure ~/.crow/data/ exists and set CROW_DATA_DIR
// This guarantees the database is created in the canonical location,
// not in the repo-local ./data/ directory.
const home = process.env.HOME || process.env.USERPROFILE || "";
const crowDataDir = resolve(home, ".crow", "data");
if (home && !process.env.CROW_DATA_DIR) {
  try {
    const { mkdirSync: mkdir } = await import("fs");
    mkdir(crowDataDir, { recursive: true });
    process.env.CROW_DATA_DIR = crowDataDir;
    log(`Data directory: ${crowDataDir}`);
  } catch {
    log("Warning: Could not create ~/.crow/data/ — using default location.");
  }
}

// Step 5: Migrate data from ./data/ to ~/.crow/data/ (if applicable)
log("Checking data directory...");
try {
  execSync("node scripts/migrate-data-dir.js", {
    cwd: ROOT, stdio: "inherit", env: { ...process.env },
  });
} catch {
  log("Warning: Data directory migration skipped. Run 'npm run migrate-data' manually.");
}

// Step 6: Initialize database
log("Initializing database...");
try {
  execSync("node scripts/init-db.js", {
    cwd: ROOT, stdio: "inherit", env: { ...process.env },
  });
} catch {
  console.error("Failed to initialize database.");
  process.exit(1);
}

// Step 7: Generate .mcp.json
log("Generating .mcp.json...");
try {
  execSync("node scripts/generate-mcp-config.js", { cwd: ROOT, stdio: "inherit" });
} catch {
  log("Warning: Could not generate .mcp.json. Run 'npm run mcp-config' manually.");
}

// Step 8: Check external tools
header("External Tool Status");

const tools = [
  { name: "Python (uvx)", cmd: "uvx --version", required: false, note: "Needed for google-workspace and mcp-research" },
  { name: "Git", cmd: "git --version", required: false },
  { name: "Docker", cmd: "docker --version", required: false, note: "Optional — needed only if using Docker-based MCP servers" },
];

for (const tool of tools) {
  try {
    execSync(tool.cmd, { stdio: "pipe" });
    log(`${tool.name} - INSTALLED`);
  } catch {
    const status = tool.required ? "MISSING (required)" : "NOT FOUND (optional)";
    log(`${tool.name} - ${status}${tool.note ? ` - ${tool.note}` : ""}`);
  }
}

// Step 6: Offer to run the interactive wizard
log("");
log("Want a guided setup? Run: node scripts/wizard.js");
log("Want to generate Claude Desktop config? Run: node scripts/generate-desktop-config.js");

header("Setup Complete");

// Detect deployment type
const isTurso = !!process.env.TURSO_DATABASE_URL;
const isCrowOS = home && existsSync(resolve(home, ".crow", "app", "package.json"));
const isGateway = isTurso || isCrowOS;

// Build dynamic server list from registry
const totalServers = CORE_SERVERS.length + EXTERNAL_SERVERS.length;
const coreList = CORE_SERVERS.map(s => `  - ${s.name.padEnd(18)} ${s.description}`).join("\n");
const categories = { productivity: [], communication: [], development: [] };
for (const s of EXTERNAL_SERVERS) {
  const cat = s.category || "development";
  if (categories[cat]) categories[cat].push(s);
}
const extSections = [
  ["productivity", "External (productivity)"],
  ["communication", "External (communication)"],
  ["development", "External (development & search)"],
].map(([key, label]) => {
  const items = categories[key];
  if (!items || items.length === 0) return "";
  return `  ${label}:\n` + items.map(s => `  - ${s.name.padEnd(18)} ${s.description}`).join("\n");
}).filter(Boolean).join("\n\n");

if (isGateway) {
  console.log(`
What to do next:
  1. Start the gateway:        npm run gateway
  2. View integration status:  http://localhost:3001/setup
  3. Verify everything works:  npm run check

Core servers (memory, projects, sharing, blog) are ready — no API keys needed.
Add integrations later by editing .env, then run: npm run mcp-config
`);
} else {
  console.log(`
What to do next:
  1. Start Claude Code:        claude
  2. Or Claude Desktop:        npm run desktop-config
  3. Verify everything works:  npm run check

Core servers (memory, projects, sharing, blog) are ready — no API keys needed.
Add integrations later by editing .env, then run: npm run mcp-config
`);
}

console.log(`Available MCP servers (${totalServers} total):
  Built-in:
${coreList}

${extSections}

First thing to try after connecting your AI:
  "Remember that today is my first day using Crow"
  "What do you remember?"
`);
