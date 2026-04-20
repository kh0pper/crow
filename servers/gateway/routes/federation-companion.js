/**
 * Federation — companion kiosk WM app registry (Phase 3).
 *
 * Mounts one dashboard-scoped route:
 *   GET /dashboard/federation/companion-overview
 *
 * Session-authed (dashboardAuth already runs upstream via index.js). Returns
 * the merged local+federated app registry the companion window-manager
 * (bundles/companion/scripts/crow-wm.js) uses to open apps on any trusted
 * paired instance.
 *
 * Why under /dashboard/* and not /companion/*:
 *   companion-proxy.js mounts a catch-all `app.use("/companion", httpProxy)`
 *   that forwards every /companion/* request to Open-LLM-VTuber. Mounting
 *   here would be intercepted by that proxy unless wired before it — a
 *   fragile ordering dependency. Under /dashboard/* we also get automatic
 *   rejectFunneled coverage for free.
 *
 * Response shape:
 *   {
 *     local: {
 *       static:  Array<{id,name,icon,needs}>,   // WM-only apps (youtube, browser, videocall)
 *       bundles: Array<Tile>                     // local bundle tiles — same schema as federation.js
 *     },
 *     peers: {
 *       <instanceId>: {
 *         name, hostname, status: "ok"|"unavailable", reason?, tiles: Array<Tile>
 *       }
 *     }
 *   }
 *
 * 503 is returned when the local companion bundle is not installed —
 * the WM isn't rendering on this host, so the endpoint is meaningless.
 * Peer data still comes from Phase 2's overview-cache (30s TTL) so there
 * is NO second HMAC round trip per refresh; companions refresh every 60s
 * and usually get a warm cache hit for free.
 *
 * Peer tokens never leave the gateway — overview-cache is the only code
 * path that handles signing.
 */

import { Router } from "express";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { getTrustedInstances } from "../dashboard/panels/nest/data-queries.js";
import { getPeerOverview } from "../dashboard/overview-cache.js";

// Static WM-only apps. These are not bundles — they're frontend shortcuts
// the companion can open on any kiosk host. All peers can do these
// locally, so there's no federation dimension; companion picks the local
// host every time. Kept in lockstep with LAUNCHER_APPS in crow-wm.js:796.
const STATIC_LOCAL_APPS = [
  { id: "youtube",   name: "YouTube",    icon: "media",   needs: "query" },
  { id: "browser",   name: "Browser",    icon: "default", needs: "url"   },
  { id: "videocall", name: "Video Call", icon: "contacts", needs: "contact" },
];

function loadInstalled() {
  const p = join(homedir(), ".crow", "installed.json");
  if (!existsSync(p)) return {};
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8"));
    if (Array.isArray(raw)) {
      const obj = {};
      for (const item of raw) if (item.id) obj[item.id] = item;
      return obj;
    }
    return raw || {};
  } catch { return {}; }
}

function isCompanionInstalled() {
  return Boolean(loadInstalled().companion);
}

/**
 * Build the local bundles list the WM can open. Reuses the same pattern as
 * servers/gateway/routes/federation.js::buildTiles() but kept local here to
 * avoid a circular import (federation.js doesn't export its internals).
 */
function loadLocalBundleTiles() {
  const installed = loadInstalled();
  const tiles = [];
  for (const [id, meta] of Object.entries(installed)) {
    if (meta.type !== "bundle") continue;
    const manifestPaths = [
      join(homedir(), ".crow", "bundles", id, "manifest.json"),
      join(import.meta.dirname, "../../../bundles", id, "manifest.json"),
    ];
    let manifest = null;
    for (const mp of manifestPaths) {
      if (existsSync(mp)) {
        try { manifest = JSON.parse(readFileSync(mp, "utf-8")); } catch {}
        if (manifest) break;
      }
    }
    if (!manifest || !manifest.webUI) continue;
    const isDirect = manifest.webUI.proxyMode === "direct";
    const pathname = isDirect
      ? (manifest.webUI.path || "/")
      : `/proxy/${id}${manifest.webUI.path || "/"}`;
    const port = isDirect ? (manifest.webUI.port || null) : null;
    tiles.push({
      id,
      name: manifest.name || id,
      icon: manifest.icon || "default",
      pathname,
      port,
      category: "bundle",
    });
  }
  return tiles;
}

/**
 * Factory: returns an Express router mounting the companion-overview route.
 *
 * @param {object} args
 * @param {() => import("@libsql/client").Client} args.createDbClient
 */
export default function federationCompanionRouter({ createDbClient }) {
  const router = Router();

  router.get("/federation/companion-overview", async (req, res) => {
    if (!isCompanionInstalled()) {
      return res.status(503).json({ error: "companion_not_installed" });
    }

    const db = createDbClient();
    try {
      const trusted = await getTrustedInstances(db);
      const peerIds = trusted.map(i => i.id);

      // Fan out with allSettled — one flaky peer must not block the whole
      // refresh. 1500ms aggregate budget matches the dashboard nest
      // wrapper; per-peer fetch timeout is 2s inside overview-cache.
      const budget = new Promise((r) => setTimeout(() => r("__budget__"), 1500));
      const fan = Promise.allSettled(peerIds.map(id => getPeerOverview(db, id)));
      const settled = await Promise.race([fan, budget]);

      const peers = {};
      for (let i = 0; i < trusted.length; i++) {
        const inst = trusted[i];
        const r = Array.isArray(settled) ? settled[i] : null;
        const overview = r && r.status === "fulfilled" ? r.value : null;
        if (overview && overview.status === "ok") {
          peers[inst.id] = {
            name: inst.name,
            hostname: inst.hostname,
            status: "ok",
            tiles: overview.tiles,
          };
        } else {
          peers[inst.id] = {
            name: inst.name,
            hostname: inst.hostname,
            status: "unavailable",
            reason: overview?.reason || (Array.isArray(settled) ? "rejected" : "budget_exceeded"),
            tiles: [],
          };
        }
      }

      res.type("application/json").send(JSON.stringify({
        local: {
          static: STATIC_LOCAL_APPS,
          bundles: loadLocalBundleTiles(),
        },
        peers,
      }));
    } catch (err) {
      console.warn("[federation-companion] overview failed:", err.message);
      res.status(500).json({ error: "companion_overview_failed" });
    } finally {
      db.close();
    }
  });

  return router;
}
