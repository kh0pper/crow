/**
 * Nest Panel — Data Queries
 *
 * Fetches all data needed for the home screen: pinned items, installed bundles,
 * Docker status, DB stats, recent conversations, recent MCP sessions.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";

// Docker status cache
const _dockerCache = new Map();
const DOCKER_CACHE_TTL = 30_000;

function getBundleDockerStatus(bundleId) {
  const cached = _dockerCache.get(bundleId);
  if (cached && Date.now() - cached.timestamp < DOCKER_CACHE_TTL) return cached.status;
  let status = null;
  try {
    const out = execFileSync("docker", ["ps", "--filter", `name=${bundleId}`, "--format", "{{.Status}}"], {
      encoding: "utf-8", timeout: 5000,
    }).trim();
    status = out || null;
  } catch {}
  _dockerCache.set(bundleId, { status, timestamp: Date.now() });
  return status;
}

export async function getNestData(db, lang) {
  // Pinned items
  let pinnedItems = [];
  try {
    const { rows } = await db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = 'nest_pinned_items'", args: [] });
    pinnedItems = rows[0]?.value ? JSON.parse(rows[0].value) : [];
  } catch {}

  // Installed bundles
  let bundles = [];
  const installedPath = join(homedir(), ".crow", "installed.json");
  if (existsSync(installedPath)) {
    try {
      let installed = JSON.parse(readFileSync(installedPath, "utf-8"));
      // Normalize array format to object (bundles.js writes arrays)
      if (Array.isArray(installed)) {
        const obj = {};
        for (const item of installed) if (item.id) obj[item.id] = item;
        installed = obj;
      }
      for (const [id, meta] of Object.entries(installed)) {
        if (meta.type !== "bundle" && meta.type !== "mcp-server") continue;
        let name = id;
        let webUI = null;
        // Try to load manifest from ~/.crow/bundles/ or repo bundles/
        const manifestPaths = [
          join(homedir(), ".crow", "bundles", id, "manifest.json"),
          join(import.meta.dirname, "../../../../../bundles", id, "manifest.json"),
        ];
        for (const mp of manifestPaths) {
          if (existsSync(mp)) {
            try {
              const manifest = JSON.parse(readFileSync(mp, "utf-8"));
              name = manifest.name || id;
              webUI = manifest.webUI || null;
            } catch {}
            break;
          }
        }
        let isRunning = false;
        if (meta.type === "bundle") {
          const status = getBundleDockerStatus(id);
          isRunning = status !== null && status.toLowerCase().startsWith("up");
        }
        bundles.push({ id, name, type: meta.type, isRunning, webUI });
      }
    } catch {}
  }

  // Docker overview
  let dockerInfo = { available: false, total: 0, running: 0, stopped: 0 };
  try {
    const psOut = execFileSync("docker", ["ps", "--format", "json", "--all"], {
      encoding: "utf-8", timeout: 10000,
    });
    const lines = psOut.trim().split("\n").filter(l => l.trim());
    dockerInfo.available = true;
    dockerInfo.total = lines.length;
    for (const line of lines) {
      try {
        const c = JSON.parse(line);
        if (c.State === "running") dockerInfo.running++;
        else dockerInfo.stopped++;
      } catch {}
    }
  } catch {}

  // Database stats
  let dbStats = { memories: 0, projects: 0, sources: 0, posts: 0, contacts: 0, sizeBytes: 0 };
  try {
    const [memR, srcR, projR, conR, blogR, pageCntR, pageSzR] = await Promise.all([
      db.execute("SELECT COUNT(*) as c FROM memories"),
      db.execute("SELECT COUNT(*) as c FROM research_sources"),
      db.execute("SELECT COUNT(*) as c FROM research_projects"),
      db.execute("SELECT COUNT(*) as c FROM contacts"),
      db.execute("SELECT COUNT(*) as c FROM blog_posts"),
      db.execute("PRAGMA page_count"),
      db.execute("PRAGMA page_size"),
    ]);
    dbStats.memories = memR.rows[0]?.c || 0;
    dbStats.sources = srcR.rows[0]?.c || 0;
    dbStats.projects = projR.rows[0]?.c || 0;
    dbStats.contacts = conR.rows[0]?.c || 0;
    dbStats.posts = blogR.rows[0]?.c || 0;
    const pageCount = pageCntR.rows[0]?.page_count || 0;
    const pageSize = pageSzR.rows[0]?.page_size || 4096;
    dbStats.sizeBytes = pageCount * pageSize;
  } catch {}

  // Recent AI conversations (top 5)
  let recentChats = [];
  try {
    const { rows } = await db.execute(`
      SELECT id, title, provider, model, updated_at, created_at
      FROM chat_conversations ORDER BY updated_at DESC LIMIT 5
    `);
    recentChats = rows;
  } catch {}

  // Recent MCP sessions (top 5)
  let recentSessions = [];
  try {
    const { rows } = await db.execute(`
      SELECT id, session_id, transport, server_name, client_info, tool_calls_summary,
             tool_call_count, started_at, ended_at
      FROM mcp_sessions ORDER BY started_at DESC LIMIT 5
    `);
    recentSessions = rows.map(r => ({
      ...r,
      client_info: r.client_info ? JSON.parse(r.client_info) : null,
      tool_calls_summary: r.tool_calls_summary ? JSON.parse(r.tool_calls_summary) : {},
    }));
  } catch {}

  return { pinnedItems, bundles, dockerInfo, dbStats, recentChats, recentSessions };
}
