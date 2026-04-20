/**
 * Resolve the "best" companion host to use for the kiosk-toggle shortcut.
 *
 * Resolution order:
 *   1. LOCAL — companion bundle installed + docker container "up" on this host.
 *      Returns a loopback-relative URL ("https://<current-origin>:12393/").
 *   2. PEER — companion tile present in any trusted peer's cached overview.
 *      Returns the peer's own URL, same URL a tile click would produce.
 *   3. NONE — hide the kiosk button entirely.
 *
 * The resolver is ASYNC because the peer check reads from the in-memory
 * overview-cache (which may have inflight promises) and may need to query
 * trusted peers. But it's designed to be cheap:
 *   - Local check is sync under the hood (docker ps with 3s timeout).
 *   - Peer check only inspects entries that are already cached — never fires
 *     a fresh HMAC fetch. The nest panel wrapper + companion federation
 *     endpoint already prime the cache; this is a consumer, not a fetcher.
 *
 * Call surface:
 *   await resolveCompanionTarget({ db, origin }) →
 *     { available: bool, url: string|null, host: "local"|"<peerId>"|null, name: string|null }
 *
 * `origin` is the external hostname (Host header or equivalent) — we hand
 * it to the client as-is so the iframe loads the companion on the SAME host
 * the browser used (avoids mixed-content + cookie boundaries).
 *
 * Rendered output is safe to plug straight into inline JS with escapeHtml;
 * URL is built from validated pieces (peer's gateway_url from the LOCAL DB
 * row, never peer-advertised).
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { getTrustedInstances } from "./panels/nest/data-queries.js";
import { getPeerOverview } from "./overview-cache.js";

function isLocalCompanionRunning() {
  try {
    const installedPath = resolve(homedir(), ".crow", "installed.json");
    if (!existsSync(installedPath)) return false;
    const installed = JSON.parse(readFileSync(installedPath, "utf-8"));
    const list = Array.isArray(installed) ? installed : Object.values(installed);
    if (!list.some(e => e.id === "companion")) return false;
    const status = execFileSync("docker", ["ps", "--filter", "name=crow-companion", "--format", "{{.Status}}"], {
      encoding: "utf-8", timeout: 3000,
    }).trim();
    return status.toLowerCase().startsWith("up");
  } catch {
    return false;
  }
}

/**
 * Build the companion URL for the kiosk iframe.
 *
 * For LOCAL: we use the browser's origin hostname so Tailscale Serve / HTTPS
 * boundaries are preserved. Port 12393 is the companion bundle's direct port
 * (from bundles/companion/manifest.json).
 *
 * For PEERS: gateway_url + the tile's port (12393). We MUST use gateway_url
 * as the base because the bare hostname is often wrong (see the 2026-04-20
 * debug session — one peer had hostname="crow" which doesn't resolve).
 */
function buildLocalCompanionUrl(origin) {
  const host = String(origin || "").split(":")[0].replace(/[^a-zA-Z0-9._-]/g, "");
  if (!host) return null;
  return `https://${host}:12393/`;
}

function buildPeerCompanionUrl(gatewayUrl, port) {
  if (!gatewayUrl) return null;
  try {
    const u = new URL(gatewayUrl);
    if (port) u.port = String(port);
    u.pathname = "/";
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

function findCompanionTileInOverview(overview) {
  if (!overview || overview.status !== "ok" || !Array.isArray(overview.tiles)) return null;
  return overview.tiles.find(t => t.id === "companion") || null;
}

/**
 * @param {object} args
 * @param {import("@libsql/client").Client} args.db
 * @param {string} [args.origin]  The browser-facing host (req headers.host)
 * @returns {Promise<{ available: boolean, url: string|null, host: string|null, name: string|null }>}
 */
export async function resolveCompanionTarget({ db, origin } = {}) {
  // Prefer local — same-origin iframe, no cross-peer auth friction, no
  // mixed-content risk.
  if (isLocalCompanionRunning()) {
    return {
      available: true,
      url: buildLocalCompanionUrl(origin),
      host: "local",
      name: null,
    };
  }

  // Fall back to any trusted peer that has the companion tile in its cached
  // overview. First-match wins; if you want to change priority (e.g.
  // always prefer a specific peer), sort `trusted` before the loop.
  try {
    const trusted = await getTrustedInstances(db);
    for (const inst of trusted) {
      let overview;
      try {
        overview = await getPeerOverview(db, inst.id);
      } catch {
        continue;
      }
      const tile = findCompanionTileInOverview(overview);
      if (!tile) continue;
      const url = buildPeerCompanionUrl(inst.gateway_url, tile.port || 12393);
      if (!url) continue;
      return {
        available: true,
        url,
        host: inst.id,
        name: inst.name || null,
      };
    }
  } catch { /* fall through to unavailable */ }

  return { available: false, url: null, host: null, name: null };
}
