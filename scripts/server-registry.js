#!/usr/bin/env node

/**
 * Crow — Shared Server Registry
 *
 * Single source of truth for all MCP server definitions.
 * Used by generate-mcp-config.js, generate-desktop-config.js, and setup.js.
 */

import { execFileSync } from "child_process";
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(__dirname, "..");

/**
 * Load .env file and return key-value pairs.
 * Skips empty values, comments, and lines without '='.
 */
export function loadEnv() {
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

/**
 * Resolve ${VAR} and ${VAR:-default} template syntax using env values.
 */
export function resolveEnvValue(template, env) {
  return template.replace(/\$\{(\w+)(?::-(.*?))?\}/g, (_, key, fallback) => {
    return env[key] || fallback || "";
  });
}

/**
 * Check if a server's required binaries are available.
 * Returns true if all binaries are found, false otherwise.
 */
export function checkRequires(server) {
  if (!server.requires || server.requires.length === 0) return true;
  return server.requires.every((bin) => {
    try {
      execFileSync(bin, ["--version"], { stdio: "pipe", timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Core servers — always included in every config.
 * These use relative paths in .mcp.json and absolute paths in desktop config.
 */
export const CORE_SERVERS = [
  {
    name: "crow-memory",
    command: "node",
    args: ["servers/memory/index.js"],
    description: "Persistent memory",
    envKeys: [],
    mcpEnv: { CROW_DB_PATH: "${CROW_DB_PATH:-./data/crow.db}" },
  },
  {
    name: "crow-projects",
    command: "node",
    args: ["servers/research/index.js"],
    description: "Project management & research pipeline",
    envKeys: [],
    mcpEnv: { CROW_DB_PATH: "${CROW_DB_PATH:-./data/crow.db}" },
  },
  {
    name: "crow-sharing",
    command: "node",
    args: ["servers/sharing/index.js"],
    description: "P2P sharing",
    envKeys: [],
    mcpEnv: { CROW_DB_PATH: "${CROW_DB_PATH:-./data/crow.db}" },
  },
  {
    name: "crow-blog",
    command: "node",
    args: ["servers/blog/index.js"],
    description: "Blogging platform",
    envKeys: [],
    mcpEnv: { CROW_DB_PATH: "${CROW_DB_PATH:-./data/crow.db}" },
  },
  {
    name: "crow-media",
    command: "node",
    args: ["servers/media/index.js"],
    description: "News aggregation & media hub",
    envKeys: [],
    mcpEnv: { CROW_DB_PATH: "${CROW_DB_PATH:-./data/crow.db}" },
  },
];

/**
 * Combined core server — alternative to individual core servers.
 * Uses on-demand activation to reduce context window usage.
 * Generated when --combined flag is passed to generate-mcp-config.js.
 */
export const COMBINED_SERVER = {
  name: "crow-core",
  command: "node",
  args: ["servers/core/index.js"],
  description: "Combined server with on-demand activation (15 startup tools vs 49+)",
  envKeys: [],
  mcpEnv: { CROW_DB_PATH: "${CROW_DB_PATH:-./data/crow.db}" },
};

/**
 * Conditional core servers — included only when their env vars are set.
 * These are Crow's own servers that require external services.
 */
export const CONDITIONAL_SERVERS = [
  {
    name: "crow-storage",
    command: "node",
    args: ["servers/storage/index.js"],
    description: "S3-compatible file storage (requires MinIO)",
    envKeys: ["MINIO_ENDPOINT"],
    mcpEnv: {
      CROW_DB_PATH: "${CROW_DB_PATH:-./data/crow.db}",
      MINIO_ENDPOINT: "${MINIO_ENDPOINT}",
      MINIO_PORT: "${MINIO_PORT:-9000}",
      MINIO_ROOT_USER: "${MINIO_ROOT_USER:-crowadmin}",
      MINIO_ROOT_PASSWORD: "${MINIO_ROOT_PASSWORD}",
      MINIO_USE_SSL: "${MINIO_USE_SSL:-false}",
    },
    category: "storage",
  },
];

/**
 * External servers — included conditionally based on envKeys.
 *
 * Fields:
 *   name        - server name in config
 *   command     - executable (npx, uvx, etc.)
 *   args        - base args for desktop config
 *   envKeys     - required env vars (empty = always included)
 *   envMap      - env var mapping for desktop config { CONFIG_KEY: ENV_KEY }
 *   buildEnv    - custom env builder for desktop config (overrides envMap)
 *   mcpEnv      - env block for .mcp.json (template syntax)
 *   mcpArgs     - args override for .mcp.json (if different from desktop)
 *   description - human-readable description
 *   category    - "productivity" | "communication" | "development"
 */
export const EXTERNAL_SERVERS = [
  {
    name: "trello",
    command: "npx",
    args: ["-y", "mcp-server-trello"],
    envKeys: ["TRELLO_API_KEY", "TRELLO_TOKEN"],
    envMap: { TRELLO_API_KEY: "TRELLO_API_KEY", TRELLO_TOKEN: "TRELLO_TOKEN" },
    mcpEnv: { TRELLO_API_KEY: "${TRELLO_API_KEY}", TRELLO_TOKEN: "${TRELLO_TOKEN}" },
    description: "Requires TRELLO_API_KEY + TRELLO_TOKEN",
    category: "productivity",
  },
  {
    name: "canvas-lms",
    command: "npx",
    args: ["-y", "mcp-canvas-lms"],
    envKeys: ["CANVAS_API_TOKEN", "CANVAS_BASE_URL"],
    envMap: { CANVAS_API_TOKEN: "CANVAS_API_TOKEN", CANVAS_BASE_URL: "CANVAS_BASE_URL" },
    mcpEnv: { CANVAS_API_TOKEN: "${CANVAS_API_TOKEN}", CANVAS_BASE_URL: "${CANVAS_BASE_URL}" },
    description: "Requires CANVAS_API_TOKEN + CANVAS_BASE_URL",
    category: "productivity",
  },
  {
    name: "google-workspace",
    command: "uvx",
    args: ["workspace-mcp"],
    envKeys: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
    requires: ["uvx"],
    envMap: { GOOGLE_CLIENT_ID: "GOOGLE_CLIENT_ID", GOOGLE_CLIENT_SECRET: "GOOGLE_CLIENT_SECRET" },
    mcpEnv: { GOOGLE_CLIENT_ID: "${GOOGLE_CLIENT_ID}", GOOGLE_CLIENT_SECRET: "${GOOGLE_CLIENT_SECRET}" },
    description: "Requires Google OAuth credentials (includes Google Chat)",
    category: "productivity",
  },
  {
    name: "arxiv",
    command: "uvx",
    args: ["arxiv-mcp-server"],
    envKeys: ["CROW_ENABLE_ARXIV"],
    requires: ["uvx"],
    envMap: {},
    mcpEnv: {},
    description: "Academic paper search (set CROW_ENABLE_ARXIV=1)",
    category: "productivity",
  },
  {
    name: "mcp-research",
    command: "uvx",
    args: ["mcp-research"],
    envKeys: ["CROW_ENABLE_MCP_RESEARCH"],
    requires: ["uvx"],
    envMap: {},
    mcpEnv: {},
    description: "Academic search (set CROW_ENABLE_MCP_RESEARCH=1)",
    category: "productivity",
  },
  {
    name: "zotero",
    command: "uvx",
    args: ["zotero-mcp"],
    envKeys: ["ZOTERO_API_KEY", "ZOTERO_USER_ID"],
    requires: ["uvx"],
    envMap: { ZOTERO_API_KEY: "ZOTERO_API_KEY", ZOTERO_USER_ID: "ZOTERO_USER_ID" },
    mcpEnv: { ZOTERO_API_KEY: "${ZOTERO_API_KEY}", ZOTERO_USER_ID: "${ZOTERO_USER_ID}" },
    description: "Requires ZOTERO_API_KEY + ZOTERO_USER_ID",
    category: "productivity",
  },
  {
    name: "notion",
    command: "npx",
    args: ["-y", "@notionhq/notion-mcp-server"],
    envKeys: ["NOTION_TOKEN"],
    buildEnv: (e) => ({
      OPENAPI_MCP_HEADERS: JSON.stringify({
        Authorization: `Bearer ${e.NOTION_TOKEN || ""}`,
        "Notion-Version": "2022-06-28",
      }),
    }),
    mcpEnv: {
      OPENAPI_MCP_HEADERS: '{"Authorization": "Bearer ${NOTION_TOKEN}", "Notion-Version": "2022-06-28"}',
    },
    description: "Requires NOTION_TOKEN",
    category: "productivity",
  },
  {
    name: "slack",
    command: "npx",
    args: ["-y", "@anthropic/mcp-server-slack"],
    envKeys: ["SLACK_BOT_TOKEN"],
    envMap: { SLACK_BOT_TOKEN: "SLACK_BOT_TOKEN" },
    mcpEnv: { SLACK_BOT_TOKEN: "${SLACK_BOT_TOKEN}" },
    description: "Requires SLACK_BOT_TOKEN",
    category: "communication",
  },
  {
    name: "discord",
    command: "npx",
    args: ["-y", "mcp-discord"],
    envKeys: ["DISCORD_BOT_TOKEN"],
    envMap: { DISCORD_BOT_TOKEN: "DISCORD_BOT_TOKEN" },
    mcpEnv: { DISCORD_BOT_TOKEN: "${DISCORD_BOT_TOKEN}" },
    description: "Requires DISCORD_BOT_TOKEN",
    category: "communication",
  },
  {
    name: "microsoft-teams",
    command: "npx",
    args: ["-y", "mcp-server-microsoft-teams"],
    envKeys: ["TEAMS_CLIENT_ID", "TEAMS_CLIENT_SECRET", "TEAMS_TENANT_ID"],
    envMap: { TEAMS_CLIENT_ID: "TEAMS_CLIENT_ID", TEAMS_CLIENT_SECRET: "TEAMS_CLIENT_SECRET", TEAMS_TENANT_ID: "TEAMS_TENANT_ID" },
    mcpEnv: { TEAMS_CLIENT_ID: "${TEAMS_CLIENT_ID}", TEAMS_CLIENT_SECRET: "${TEAMS_CLIENT_SECRET}", TEAMS_TENANT_ID: "${TEAMS_TENANT_ID}" },
    description: "Requires Azure AD credentials (experimental)",
    category: "communication",
  },
  {
    name: "github",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    envKeys: ["GITHUB_PERSONAL_ACCESS_TOKEN"],
    envMap: { GITHUB_PERSONAL_ACCESS_TOKEN: "GITHUB_PERSONAL_ACCESS_TOKEN" },
    mcpEnv: { GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_PERSONAL_ACCESS_TOKEN}" },
    description: "Requires GITHUB_PERSONAL_ACCESS_TOKEN",
    category: "development",
  },
  {
    name: "brave-search",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-brave-search"],
    envKeys: ["BRAVE_API_KEY"],
    envMap: { BRAVE_API_KEY: "BRAVE_API_KEY" },
    mcpEnv: { BRAVE_API_KEY: "${BRAVE_API_KEY}" },
    description: "Requires BRAVE_API_KEY",
    category: "development",
  },
  {
    name: "filesystem",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem"],
    envKeys: [],
    envMap: {},
    mcpArgs: ["-y", "@modelcontextprotocol/server-filesystem", "${CROW_FILES_PATH:-/home}"],
    description: "Local file access (no keys needed)",
    category: "development",
  },
  {
    name: "home-assistant",
    command: "npx",
    args: ["-y", "hass-mcp"],
    envKeys: ["HA_URL", "HA_TOKEN"],
    envMap: { HA_URL: "HA_URL", HA_TOKEN: "HA_TOKEN" },
    mcpEnv: { HA_URL: "${HA_URL}", HA_TOKEN: "${HA_TOKEN}" },
    description: "Requires HA_URL + HA_TOKEN",
    category: "productivity",
  },
  {
    name: "obsidian",
    command: "npx",
    args: ["-y", "mcp-obsidian"],
    envKeys: ["OBSIDIAN_VAULT_PATH"],
    envMap: { OBSIDIAN_VAULT_PATH: "OBSIDIAN_VAULT_PATH" },
    mcpEnv: { OBSIDIAN_VAULT_PATH: "${OBSIDIAN_VAULT_PATH}" },
    description: "Requires OBSIDIAN_VAULT_PATH",
    category: "productivity",
  },
  {
    name: "render",
    command: "npx",
    args: ["-y", "mcp-remote", "https://mcp.render.com/mcp"],
    envKeys: ["RENDER_API_KEY"],
    envMap: { RENDER_API_KEY: "RENDER_API_KEY" },
    mcpArgs: ["-y", "mcp-remote", "https://mcp.render.com/mcp", "--header", "Authorization: Bearer ${RENDER_API_KEY}"],
    mcpEnv: { RENDER_API_KEY: "${RENDER_API_KEY}" },
    description: "Requires RENDER_API_KEY",
    category: "development",
  },
];
