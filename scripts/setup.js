#!/usr/bin/env node

/**
 * Crow AI Platform Setup Script
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

header("Crow AI Platform Setup");

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

// Step 4: Initialize database
log("Initializing database...");
try {
  execSync("node scripts/init-db.js", { cwd: ROOT, stdio: "inherit" });
} catch {
  console.error("Failed to initialize database.");
  process.exit(1);
}

// Step 5: Generate .mcp.json
log("Generating .mcp.json...");
try {
  execSync("node scripts/generate-mcp-config.js", { cwd: ROOT, stdio: "inherit" });
} catch {
  log("Warning: Could not generate .mcp.json. Run 'npm run mcp-config' manually.");
}

// Step 6: Check external tools
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

console.log(`
Next steps:
  1. Edit .env with your API keys (see .env.example for details)
     Or run 'node scripts/wizard.js' for guided setup
  2. Run 'npm run mcp-config' to regenerate .mcp.json after editing .env
  3. Run 'claude' in this directory to start using the platform
  4. The AI will automatically load CLAUDE.md and .mcp.json

For Claude Desktop users:
  Run 'node scripts/generate-desktop-config.js' to auto-configure

Available MCP servers (${totalServers} total):
  Built-in:
${coreList}

${extSections}
`);
