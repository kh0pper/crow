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

// Step 5: Check external tools
header("External Tool Status");

const tools = [
  { name: "Python (uvx)", cmd: "uvx --version", required: false, note: "Needed for google-workspace and mcp-research" },
  { name: "Git", cmd: "git --version", required: false },
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

header("Setup Complete");
console.log(`
Next steps:
  1. Edit .env with your API keys (see .env.example for details)
  2. Run 'claude' in this directory to start using the platform
  3. The AI will automatically load CLAUDE.md and .mcp.json

MCP servers configured:
  - crow-memory     (built-in)  Persistent memory
  - crow-research   (built-in)  Research pipeline
  - trello          (external)  Requires TRELLO_API_KEY + TRELLO_TOKEN
  - canvas-lms      (external)  Requires CANVAS_API_TOKEN + CANVAS_BASE_URL
  - google-workspace(external)  Requires Google OAuth credentials
  - mcp-research    (external)  Academic search (no keys needed)
  - zotero          (external)  Requires ZOTERO_API_KEY + ZOTERO_USER_ID
`);
