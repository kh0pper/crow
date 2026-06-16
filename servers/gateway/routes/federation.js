/**
 * Federation router — cross-instance dashboard overview.
 *
 * Mounts HMAC-gated federation routes:
 *   GET /dashboard/overview      — instance overview + tiles + peer roster
 *   GET /dashboard/capabilities  — capability + bot catalog (F4a Layer 1)
 *
 * Returns JSON describing the responding instance + its available tiles
 * (panels + installed bundles). Paired peers call this to populate their
 * per-instance carousel on the unified dashboard.
 *
 * Authenticated via the same HMAC primitive used for bundle cross-host
 * RPC (Authorization bearer + X-Crow-Signature/Timestamp/Nonce/Source).
 * Funnel-blocked automatically — mounted under /dashboard/*, not in
 * PUBLIC_FUNNEL_PREFIXES.
 *
 * Response schema (see plan's Verified Claims + Phase 1):
 *   {
 *     instance: { id, name, hostname, is_home },
 *     tiles: Array<{
 *       id:       string,  // /^[a-z][a-z0-9_-]{0,63}$/
 *       name:     string,
 *       icon:     string,  // key into a known allowlist (unknown → "default")
 *       pathname: string,  // /^\/[a-zA-Z0-9_\-.\/]+$/, no `..`
 *       port:     number|null,
 *       category: "local-panel"|"bundle"|"instance"
 *     }>,
 *     peers: Array<{          // gossip roster: instances THIS node knows about,
 *       id:          string,  // so a fetcher converges to the full mesh (F5).
 *       name:        string|null,
 *       gateway_url: string|null,  // public https URL; the only way to "open" it
 *       hostname:    string|null,
 *       is_home:     boolean,
 *       status:      "active"|"offline"|"paused"
 *     }>,                      // metadata only — NO credentials. Capped at 50.
 *     health: { status: "ok"|"degraded", checkedAt: string }
 *   }
 *
 * The SENDER emits the schema literally. Receivers are expected to
 * re-validate (see Phase 2 overview-cache) — a compromised peer can lie
 * about its tiles. The schema here is a best-effort contract, not a
 * trust boundary.
 */

import { Router } from "express";
import { crossHostVerifyMiddleware } from "../../shared/cross-host-auth.js";
import { getInstance, getOrCreateLocalInstanceId } from "../instance-registry.js";
import { getVisiblePanels } from "../dashboard/panel-registry.js";
import { getLocalCatalog } from "../capability-registry.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { botFederationRouter } from "./bot-federation-routes.js";
import { buildAdvertisementPayload } from "../dashboard/panels/bot-builder/crow-messages-admin.js";

/**
 * Load installed bundles from ~/.crow/installed.json + manifests. Same
 * pattern as panels/nest/data-queries.js — kept local here to avoid a
 * cross-dependency between federation and the nest panel.
 */
function loadInstalledBundles() {
  const installedPath = join(homedir(), ".crow", "installed.json");
  if (!existsSync(installedPath)) return [];

  let installed;
  try { installed = JSON.parse(readFileSync(installedPath, "utf-8")); }
  catch { return []; }
  if (Array.isArray(installed)) {
    const obj = {};
    for (const item of installed) if (item.id) obj[item.id] = item;
    installed = obj;
  }

  const bundles = [];
  for (const [id, meta] of Object.entries(installed)) {
    if (meta.type !== "bundle") continue;
    let name = id;
    let webUI = null;
    let icon = null;
    let category = null;
    const manifestPaths = [
      join(homedir(), ".crow", "bundles", id, "manifest.json"),
      join(import.meta.dirname, "../../../bundles", id, "manifest.json"),
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
    bundles.push({ id, name, webUI, icon, category });
  }
  return bundles;
}

/**
 * Build the tile list advertised to paired peers. One entry per visible
 * panel + one per installed bundle that exposes a webUI.
 */
function buildTiles() {
  const tiles = [];

  // Visible panels → local-panel tiles
  for (const p of getVisiblePanels()) {
    if (p.id === "nest") continue; // home screen itself — don't advertise as a tile
    tiles.push({
      id: p.id,
      name: p.name || p.id,
      icon: p.icon || p.id || "default",
      pathname: typeof p.route === "string" && p.route.startsWith("/dashboard/")
        ? p.route
        : `/dashboard/${p.id}`,
      port: null,
      category: "local-panel",
    });
  }

  // Installed bundles with webUI → bundle tiles. A bundle with no webUI is
  // purely backend (e.g. an MCP-only add-on); no tile to offer.
  for (const b of loadInstalledBundles()) {
    if (!b.webUI) continue;
    const isDirect = b.webUI.proxyMode === "direct";
    // Subpath-proxied bundles keep the dashboard origin; direct-mode bundles
    // live on their own port. Peers need both pieces to build the URL.
    const pathname = isDirect
      ? (b.webUI.path || "/")
      : `/proxy/${b.id}${b.webUI.path || "/"}`;
    const port = isDirect ? (b.webUI.port || null) : null;
    tiles.push({
      id: b.id,
      name: b.name || b.id,
      icon: b.icon || "default",
      pathname,
      port,
      category: "bundle",
    });
  }

  return tiles;
}

/**
 * Build the gossip roster: every instance THIS node knows about (active /
 * offline / paused, not revoked, not the local-MCP pseudo-instance, not
 * self). A fetching peer merges these into its own carousel so visibility
 * converges to the full mesh regardless of who paired with whom. Metadata
 * only — never any credential. Capped so a misbehaving peer can't bloat
 * the response.
 */
async function buildPeerRoster(db, localId) {
  try {
    const { rows } = await db.execute({
      sql: "SELECT id, name, gateway_url, hostname, is_home, status FROM crow_instances "
        + "WHERE status != 'revoked' AND (crow_id IS NULL OR crow_id != '__local_mcp__') "
        + "AND id != ? ORDER BY is_home DESC, name ASC LIMIT 50",
      args: [localId],
    });
    return rows.map((r) => ({
      id: r.id,
      name: r.name || null,
      gateway_url: r.gateway_url || null,
      hostname: r.hostname || null,
      is_home: r.is_home === 1,
      status: r.status || "active",
    }));
  } catch {
    return [];
  }
}

/**
 * Factory: returns an Express router with GET /dashboard/overview mounted.
 *
 * @param {object} args
 * @param {() => import("@libsql/client").Client} args.createDbClient
 */
export default function federationRouter({ createDbClient }) {
  const router = Router();
  const dbForAudit = createDbClient();

  // HMAC-only gate for every federation route. Required signature (no
  // session path), audit action "federation.overview", and empty bodies
  // canonicalize to "" because the federation signer hashes "" for
  // body-less GETs (see signedHeaders in tests/federation-overview.test.js).
  const federationVerify = crossHostVerifyMiddleware(dbForAudit, {
    optional: false,
    audit: "federation.overview",
    emptyBodyString: "",
  });

  // Same HMAC gate, distinct audit action so paired-roster advertise traffic is
  // distinguishable from overview fetches in cross_host_calls. (Siblings keep
  // their existing label to avoid churn in their audit assertions.)
  const advertisedBotsVerify = crossHostVerifyMiddleware(dbForAudit, {
    optional: false,
    audit: "federation.advertised-bots",
    emptyBodyString: "",
  });

  // Route path is relative to the `/dashboard` mount point in the parent
  // dashboard router. The external URL is `/dashboard/overview`.
  router.get("/overview", federationVerify, async (req, res) => {
    const db = createDbClient();
    try {
      const localId = getOrCreateLocalInstanceId();
      const inst = await getInstance(db, localId);
      const overview = {
        instance: {
          id: localId,
          name: inst?.name || null,
          hostname: inst?.hostname || null,
          is_home: inst?.is_home === 1,
        },
        tiles: buildTiles(),
        peers: await buildPeerRoster(db, localId),
        health: {
          status: "ok",
          checkedAt: new Date().toISOString(),
        },
      };
      res.type("application/json").send(JSON.stringify(overview));
    } catch (err) {
      console.warn("[federation] overview render failed:", err.message);
      res.status(500).json({ error: "overview_render_failed" });
    } finally {
      db.close();
    }
  });

  // F4a Layer 1: capability + bot catalog. Same HMAC gate as /overview, separate
  // endpoint so the hot overview stays lean and this larger payload is pulled
  // lazily (only when the Bot Builder/Board panels render). Funnel-blocked via
  // the /dashboard mount; never add to PUBLIC_FUNNEL_PREFIXES.
  router.get("/capabilities", federationVerify, async (req, res) => {
    const db = createDbClient();
    try {
      const localId = getOrCreateLocalInstanceId();
      const inst = await getInstance(db, localId);
      const catalog = await getLocalCatalog(db, { instanceId: localId, instanceName: inst?.name || null });
      res.type("application/json").send(JSON.stringify({
        instance: { id: localId, name: inst?.name || null },
        capabilities: { tools: catalog.tools, skills: catalog.skills, bots: catalog.bots },
        generatedAt: new Date().toISOString(),
      }));
    } catch (err) {
      console.warn("[federation] capabilities render failed:", err.message);
      res.status(500).json({ error: "capabilities_render_failed" });
    } finally {
      db.close();
    }
  });

  // Roster auto-advertise (Theme 12): the responding instance's bots that have
  // allow_paired_instances=true. Same HMAC gate as /overview; under /dashboard →
  // Funnel-blocked (never add to PUBLIC_FUNNEL_PREFIXES). Each entry carries a
  // reusable paired-roster invite the caller auto-accepts on first message.
  router.get("/advertised-bots", advertisedBotsVerify, async (req, res) => {
    const db = createDbClient();
    try {
      const localId = getOrCreateLocalInstanceId();
      const inst = await getInstance(db, localId);
      const payload = await buildAdvertisementPayload(db, {
        instanceId: localId,
        instanceLabel: inst?.name || inst?.hostname || null,
      });
      res.type("application/json").send(JSON.stringify(payload));
    } catch (err) {
      console.warn("[federation] advertised-bots render failed:", err.message);
      res.status(500).json({ error: "advertised_bots_render_failed" });
    } finally {
      db.close();
    }
  });

  // F4a Layer 3: cross-instance bot edit/run. Same HMAC gate; gate-checked per
  // request by botPeerManageable. Under /dashboard → Funnel-blocked.
  router.use("/", botFederationRouter({ createDbClient, verifyMiddleware: federationVerify }));

  return router;
}
