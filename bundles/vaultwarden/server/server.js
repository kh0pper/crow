/**
 * Vaultwarden MCP Server
 *
 * Deliberately minimal. Vaultwarden does not expose a "read passwords" API
 * by design — that's what the Bitwarden browser extension and mobile app
 * are for. The tools here only surface operational health:
 *
 *   - vaultwarden_status       Is the server reachable? Build version?
 *   - vaultwarden_user_count   How many accounts exist? (via /admin)
 *   - vaultwarden_backup_info  Size and age of ~/.crow/vaultwarden/data
 *
 * Any tool that could expose secrets is intentionally not provided.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { statSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const VAULTWARDEN_URL = () => (process.env.VAULTWARDEN_URL || "http://localhost:8097").replace(/\/+$/, "");
const ADMIN_TOKEN = () => process.env.VAULTWARDEN_ADMIN_TOKEN || "";

function resolveDataDir() {
  const env = process.env.VAULTWARDEN_DATA_DIR;
  if (env) return env.replace(/^~/, homedir());
  return join(homedir(), ".crow/vaultwarden/data");
}

async function vwFetch(path, options = {}) {
  const url = `${VAULTWARDEN_URL()}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: { "Content-Type": "application/json", ...options.headers },
    });
    return res;
  } catch (err) {
    if (err.name === "AbortError") throw new Error(`Vaultwarden request timed out: ${path}`);
    if (err.message.includes("fetch failed") || err.message.includes("ECONNREFUSED")) {
      throw new Error(`Cannot reach Vaultwarden at ${VAULTWARDEN_URL()} — is the server running?`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function dirStats(dir) {
  if (!existsSync(dir)) return null;
  let total = 0;
  let newest = 0;
  let oldest = Infinity;
  function walk(d) {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      try {
        const s = statSync(p);
        if (e.isDirectory()) walk(p);
        else {
          total += s.size;
          if (s.mtimeMs > newest) newest = s.mtimeMs;
          if (s.mtimeMs < oldest) oldest = s.mtimeMs;
        }
      } catch { /* skip */ }
    }
  }
  walk(dir);
  return { total_bytes: total, newest_mtime: newest, oldest_mtime: oldest === Infinity ? 0 : oldest };
}

export function createVaultwardenServer(options = {}) {
  const server = new McpServer(
    { name: "crow-vaultwarden", version: "1.0.0" },
    { instructions: options.instructions },
  );

  server.tool(
    "vaultwarden_status",
    "Check whether Vaultwarden is reachable and return its build info",
    {},
    async () => {
      try {
        const aliveRes = await vwFetch("/alive");
        if (!aliveRes.ok) {
          return { content: [{ type: "text", text: `Vaultwarden unhealthy: HTTP ${aliveRes.status}` }] };
        }
        let version = null;
        try {
          const r = await vwFetch("/api/config");
          if (r.ok) {
            const data = await r.json();
            version = data?.version || null;
          }
        } catch { /* /api/config may require auth in some versions */ }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              reachable: true,
              url: VAULTWARDEN_URL(),
              version,
            }, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    },
  );

  server.tool(
    "vaultwarden_user_count",
    "Return the number of registered Vaultwarden users. Requires a valid VAULTWARDEN_ADMIN_TOKEN — the admin API does not expose passwords, only account metadata.",
    {},
    async () => {
      try {
        const token = ADMIN_TOKEN();
        if (!token) {
          return { content: [{ type: "text", text: "Error: VAULTWARDEN_ADMIN_TOKEN is not set" }] };
        }
        const res = await vwFetch("/admin/users", {
          headers: { "Authorization": `Bearer ${token}` },
        });
        if (!res.ok) {
          if (res.status === 401 || res.status === 403) {
            return { content: [{ type: "text", text: "Error: admin token rejected — check VAULTWARDEN_ADMIN_TOKEN" }] };
          }
          return { content: [{ type: "text", text: `Error: admin API returned ${res.status}` }] };
        }
        const users = await res.json();
        const list = Array.isArray(users) ? users : [];
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              user_count: list.length,
              accounts: list.map((u) => ({
                email: u.Email || u.email || null,
                disabled: !!(u.Disabled ?? u.disabled),
                two_factor: !!(u.TwoFactorEnabled ?? u.two_factor_enabled),
                last_active: u.LastActive || u.last_active || null,
              })),
            }, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    },
  );

  server.tool(
    "vaultwarden_backup_info",
    "Report the size and modification time of the Vaultwarden data directory (for backup freshness checks). Does NOT read vault contents.",
    {},
    async () => {
      try {
        const dir = resolveDataDir();
        const stats = dirStats(dir);
        if (!stats) {
          return { content: [{ type: "text", text: `Vaultwarden data directory not found at ${dir}` }] };
        }
        const now = Date.now();
        const ageMs = stats.newest_mtime ? now - stats.newest_mtime : 0;
        const ageHours = Math.round(ageMs / 3600000);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              data_dir: dir,
              total_size: formatBytes(stats.total_bytes),
              total_bytes: stats.total_bytes,
              last_modified: stats.newest_mtime ? new Date(stats.newest_mtime).toISOString() : null,
              hours_since_last_write: ageHours,
              hint: "Back up this directory regularly. Losing it means losing every stored credential.",
            }, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    },
  );

  return server;
}
