#!/usr/bin/env node

/**
 * Crow Health Check — npm run check
 *
 * Verifies database, config, and integration status.
 * Designed to answer: "Is Crow ready to use?"
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const green = (s) => `\x1b[32m✓\x1b[0m ${s}`;
const red = (s) => `\x1b[31m✗\x1b[0m ${s}`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

console.log(`\nCrow Health Check`);
console.log(`${"═".repeat(50)}`);

// --- Pre-setup safety: check if node_modules exists ---

let loadEnv, CORE_SERVERS, EXTERNAL_SERVERS, CONDITIONAL_SERVERS, createDbClient, resolveDataDir;
try {
  ({ loadEnv, CORE_SERVERS, EXTERNAL_SERVERS, CONDITIONAL_SERVERS } = await import("./server-registry.js"));
  ({ createDbClient, resolveDataDir } = await import("../servers/db.js"));
} catch (err) {
  if (err.code === "ERR_MODULE_NOT_FOUND") {
    console.log(`  ${red("Dependencies not installed.")}`);
    console.log(`\n  Run 'npm run setup' first.\n`);
    process.exit(1);
  }
  throw err;
}

// --- Load env ---

const env = loadEnv();

// --- Check database ---

let dbStatus = null;
let memoryCount = 0;

try {
  // Temporarily set env vars so createDbClient picks them up
  if (env.CROW_DB_PATH) process.env.CROW_DB_PATH = env.CROW_DB_PATH;

  const db = createDbClient();
  const result = await db.execute("SELECT count(*) as cnt FROM memories");
  memoryCount = result.rows[0].cnt;
  dbStatus = "ok";
  db.close();
} catch (err) {
  if (/SQLITE_CANTOPEN|unable to open database/i.test(err.message)) {
    dbStatus = "missing";
  } else if (/no such table/i.test(err.message)) {
    dbStatus = "no-schema";
  } else {
    dbStatus = "error";
  }
}

if (dbStatus === "ok") {
  const suffix = memoryCount > 0 ? ` (${memoryCount} memor${memoryCount === 1 ? "y" : "ies"} stored)` : "";
  console.log(`  ${green(`Database:      initialized${suffix}`)}`);
} else if (dbStatus === "missing") {
  console.log(`  ${red("Database:      not found")}`);
} else if (dbStatus === "no-schema") {
  console.log(`  ${red("Database:      not initialized (tables missing)")}`);
} else {
  console.log(`  ${red("Database:      error connecting")}`);
}

// --- Data directory migration hint ---

const legacyDataDir = resolve(ROOT, "data", "crow.db");
const home = process.env.HOME || process.env.USERPROFILE || "";
const crowHomeData = home ? resolve(home, ".crow", "data") : null;

if (existsSync(legacyDataDir) && crowHomeData && !existsSync(crowHomeData)) {
  console.log(`  ${dim("  Hint: data/ exists but ~/.crow/data/ does not. Run 'npm run migrate-data' to migrate.")}`);
}

// --- Check .mcp.json ---

const mcpPath = resolve(ROOT, ".mcp.json");
if (existsSync(mcpPath)) {
  try {
    const mcpConfig = JSON.parse(readFileSync(mcpPath, "utf8"));
    const serverNames = Object.keys(mcpConfig.mcpServers || {});
    const coreNames = CORE_SERVERS.map((s) => s.name);
    const coreCount = serverNames.filter((n) => coreNames.includes(n)).length;
    const extCount = serverNames.length - coreCount;
    const parts = [];
    if (coreCount > 0) parts.push(`${coreCount} core`);
    if (extCount > 0) parts.push(`${extCount} external`);
    console.log(`  ${green(`Config:        .mcp.json (${parts.join(" + ")} servers)`)}`);
  } catch {
    console.log(`  ${red("Config:        .mcp.json exists but couldn't be parsed")}`);
  }
} else {
  console.log(`  ${red("Config:        .mcp.json not found — run 'npm run mcp-config'")}`);
}

console.log();

// --- Core servers ---

const coreList = CORE_SERVERS.map((s) => s.name.replace("crow-", "")).join(", ");
console.log(`  Core servers:  ${coreList} ${dim("(ready — no config needed)")}`);

// --- Storage (conditional) ---

const storageServer = CONDITIONAL_SERVERS.find((s) => s.name === "crow-storage");
if (storageServer) {
  const storageConfigured = storageServer.envKeys.every((k) => !!env[k]);
  if (storageConfigured) {
    console.log(`  Storage:       ${green("configured")}`);
  } else {
    console.log(`  Storage:       ${dim("not configured (needs MinIO — see .env)")}`);
  }
}

// --- External integrations ---

const configured = [];
const notConfigured = [];

for (const s of EXTERNAL_SERVERS) {
  if (s.envKeys.length === 0) continue; // always-on servers (arxiv, filesystem, etc.)
  const ready = s.envKeys.every((k) => !!env[k]);
  if (ready) {
    configured.push(s.name);
  } else {
    notConfigured.push(s.name);
  }
}

if (configured.length > 0) {
  console.log(`  Integrations:  ${configured.join(", ")} ${dim("(configured)")}`);
}
if (notConfigured.length > 0) {
  console.log(`  Not configured: ${notConfigured.join(", ")} ${dim("(optional — add API keys to .env)")}`);
}

// --- Final summary ---

console.log();

if (dbStatus === "ok") {
  console.log(`  Everything looks good. Start your AI client to begin.`);
  console.log();
  console.log(`  First thing to try:`);
  console.log(`    ${dim('"Remember that my favorite color is blue"')}`);
  console.log(`    ${dim('"What do you remember about me?"')}`);
} else if (dbStatus === "missing" || dbStatus === "no-schema") {
  if (dbStatus === "missing") {
    console.log(`  Run 'npm run setup' first, then try again.`);
  } else {
    console.log(`  Run 'npm run init-db' first, then try again.`);
  }
} else {
  console.log(`  Something went wrong. Try 'npm run setup' to reinitialize.`);
}

console.log();
