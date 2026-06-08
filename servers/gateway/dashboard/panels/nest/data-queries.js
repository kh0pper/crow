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
import { getPeerCreds } from "../../../../shared/peer-credentials.js";
import { getOrCreateLocalInstanceId } from "../../../instance-registry.js";
import { readSetting } from "../../settings/registry.js";

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

/**
 * Fetch all data the nest panel needs to render.
 *
 * @param {object} db    libsql client
 * @param {string} lang  user language
 * @param {object} [opts] Optional — unified-dashboard extensions (Phase 2)
 * @param {Array<object>} [opts.trustedInstances] Trusted peers (trusted=1,
 *   status IN ('active','offline')), ORDER BY is_home DESC, name ASC. When
 *   present and non-empty, the renderer builds the per-instance carousel.
 * @param {Array<object>} [opts.peerOverviews] Overview envelopes from
 *   `overview-cache.js::getPeerOverview` — one per trusted peer, in the
 *   same order as `trustedInstances`. Each entry is either a success
 *   `{status: "ok", instance, tiles, ...}` or a sentinel
 *   `{status: "unavailable", reason}`.
 */
export async function getNestData(db, lang, opts = {}) {
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
        if (meta.type !== "bundle") continue;
        let name = id;
        let webUI = null;
        let icon = null;
        let category = null;
        const installedAt = meta.installedAt || null;
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
              icon = manifest.icon || null;
              category = manifest.category || null;
            } catch {}
            break;
          }
        }
        const status = getBundleDockerStatus(id);
        const isRunning = status !== null && status.toLowerCase().startsWith("up");
        bundles.push({ id, name, type: meta.type, isRunning, webUI, icon, category, installedAt });
      }
      bundles.sort((a, b) => new Date(a.installedAt || 0) - new Date(b.installedAt || 0));
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
      db.execute("SELECT COUNT(*) as c FROM research_projects WHERE (type IS NULL OR type != 'learner_profile')"),
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

  // Registered instances
  let instances = [];
  try {
    const { rows } = await db.execute(
      // Exclude the local-MCP access pseudo-instance (crow_id='__local_mcp__'):
      // it's a bearer-token holder so local Claude sessions can reach the
      // gateway's HTTP MCP endpoint instead of spawning their own DB-opening
      // stdio servers — not a real peer, shouldn't render as a tile.
      "SELECT * FROM crow_instances WHERE status != 'revoked' AND (crow_id IS NULL OR crow_id != '__local_mcp__') ORDER BY is_home DESC, name ASC"
    );
    instances = rows;
  } catch {}

  // Unified-dashboard (Phase 2) extensions. Handler wrapper fetches peer
  // overviews in parallel upstream; we just thread them through. The
  // `instances` field (legacy) stays untouched for the non-unified path.
  const trustedInstances = Array.isArray(opts.trustedInstances) ? opts.trustedInstances : [];
  const peerOverviews = Array.isArray(opts.peerOverviews) ? opts.peerOverviews : [];

  // Full-mesh visibility (F5): fold gossip-discovered instances (from each
  // trusted peer's roster) into the carousel set as link-only sections. Kept
  // index-aligned: append to both arrays in the same order.
  let localInstanceId = "";
  try { localInstanceId = getOrCreateLocalInstanceId(); } catch {}
  const { discoveredInstances, discoveredOverviews } = mergeDiscoveredPeers(
    trustedInstances, peerOverviews, localInstanceId
  );
  const allTrustedInstances = [...trustedInstances, ...discoveredInstances];
  const allPeerOverviews = [...peerOverviews, ...discoveredOverviews];

  // Cross-instance SSO eligibility. Decorate every instance row (both the
  // legacy `instances` list and the unified `trustedInstances` list — they are
  // distinct arrays) with `paired` = a shared signing key exists for it. The
  // renderer routes a tile through /dashboard/sso/launch only when SSO is on
  // AND the row is trusted AND paired AND has a gateway_url.
  let ssoEnabled = false;
  try { ssoEnabled = (await readSetting(db, "sso_enabled")) === "true"; } catch {}
  const withPaired = (arr) => arr.map((r) => ({ ...r, paired: !!(getPeerCreds(r.id)?.signing_key) }));

  return {
    pinnedItems, bundles, dockerInfo, dbStats, recentChats, recentSessions,
    instances: withPaired(instances),
    trustedInstances: withPaired(allTrustedInstances),
    peerOverviews: allPeerOverviews,
    ssoEnabled,
  };
}

/**
 * Query trusted paired instances. Used by the handler wrapper in
 * dashboard/index.js to drive the Phase 2 carousel. Kept separate from the
 * legacy `instances` query so single-instance behavior remains untouched.
 *
 * Filter: `trusted = 1 AND status IN ('active','offline')`. Revoked or
 * untrusted rows never surface, independent of overview-cache behavior.
 */
export async function getTrustedInstances(db) {
  try {
    const { rows } = await db.execute(
      "SELECT * FROM crow_instances WHERE trusted = 1 AND status IN ('active','offline') ORDER BY is_home DESC, name ASC"
    );
    return rows;
  } catch {
    return [];
  }
}

/**
 * Full-mesh visibility (F5). Each trusted peer's overview carries a gossip
 * `peers` roster (the instances IT knows about). Merge any roster entry this
 * node doesn't already render — not self, not an already-trusted peer, not a
 * duplicate — into the carousel as a link-only "discovered" instance. We
 * never have credentials for these, so they get no tile fetch and no SSO:
 * just an "open" link to their gateway_url. This is what makes every node
 * converge to the full mesh regardless of who paired with whom.
 *
 * Pure function (no I/O) so it's unit-testable. Returns parallel arrays that
 * the caller appends to trustedInstances / peerOverviews (kept index-aligned).
 *
 * @param {Array<{id:string}>} trustedInstances
 * @param {Array<{status:string, peers?:Array}>} peerOverviews
 * @param {string} localId
 * @returns {{ discoveredInstances: Array, discoveredOverviews: Array }}
 */
export function mergeDiscoveredPeers(trustedInstances, peerOverviews, localId) {
  const known = new Set([localId, ...(trustedInstances || []).map((i) => i?.id).filter(Boolean)]);
  const seen = new Set();
  const discoveredInstances = [];
  const discoveredOverviews = [];
  for (const ov of peerOverviews || []) {
    if (!ov || ov.status !== "ok" || !Array.isArray(ov.peers)) continue;
    for (const pr of ov.peers) {
      if (!pr || !pr.id || !pr.gateway_url) continue;
      if (known.has(pr.id) || seen.has(pr.id)) continue;
      seen.add(pr.id);
      discoveredInstances.push({
        id: pr.id,
        name: pr.name || null,
        gateway_url: pr.gateway_url,
        hostname: pr.hostname || null,
        is_home: pr.is_home ? 1 : 0,
        status: "active",
        discovered: true,
      });
      discoveredOverviews.push({ instanceId: pr.id, status: "discovered", tiles: [], reason: "gossip" });
    }
  }
  return { discoveredInstances, discoveredOverviews };
}
