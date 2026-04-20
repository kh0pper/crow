/**
 * Federation router — cross-instance dashboard overview.
 *
 * Mounts a single HMAC-gated route:
 *   GET /dashboard/overview
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
 *     health: { status: "ok"|"degraded", checkedAt: string }
 *   }
 *
 * The SENDER emits the schema literally. Receivers are expected to
 * re-validate (see Phase 2 overview-cache) — a compromised peer can lie
 * about its tiles. The schema here is a best-effort contract, not a
 * trust boundary.
 */

import { Router } from "express";
import { verifyRequest, auditCrossHostCall } from "../../shared/cross-host-auth.js";
import { getPeerCreds } from "../../shared/peer-credentials.js";
import { getInstance, getOrCreateLocalInstanceId } from "../instance-registry.js";
import { getVisiblePanels } from "../dashboard/panel-registry.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const OVERVIEW_ACTION = "federation.overview";

/**
 * Inbound HMAC verification middleware scoped to federation routes. Mirrors
 * the one in routes/bundles.js but uses `federation.overview` as the audit
 * action instead of `bundle.*`. Non-signed requests pass through to 404 —
 * the router is HMAC-only.
 */
function federationVerifyMiddleware(dbClient) {
  return async (req, res, next) => {
    const sig = req.headers["x-crow-signature"];
    if (!sig) {
      return res.status(401).json({ error: "signature_required" });
    }
    const source = req.headers["x-crow-source"];
    if (!source) {
      return res.status(401).json({ error: "missing_x_crow_source" });
    }
    const creds = getPeerCreds(source);
    if (!creds || !creds.signing_key) {
      await auditCrossHostCall(dbClient, {
        sourceInstanceId: source,
        direction: "inbound",
        action: OVERVIEW_ACTION,
        error: "no_signing_key_for_source",
      });
      return res.status(401).json({ error: "unknown_peer" });
    }

    // Canonical body must match what the signer used. express.json() sets
    // req.body to {} for GETs with no body; treat that as the empty string
    // so signer-side and verifier-side hash the same bytes.
    const isEmptyObj = req.body && typeof req.body === "object"
      && !Array.isArray(req.body) && Object.keys(req.body).length === 0;
    const rawBody = typeof req.body === "string"
      ? req.body
      : (isEmptyObj || !req.body ? "" : JSON.stringify(req.body));
    const result = verifyRequest({
      method: req.method,
      path: req.originalUrl || req.url,
      body: rawBody,
      headers: Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v[0] : v])
      ),
      signingKey: creds.signing_key,
    });

    req.crossHostAuth = result;

    await auditCrossHostCall(dbClient, {
      sourceInstanceId: source,
      direction: "inbound",
      action: OVERVIEW_ACTION,
      hmacValid: result.valid,
      error: result.valid ? null : result.reason,
      timestampSkewMs: result.timestampSkewMs,
    });

    if (!result.valid) {
      return res.status(401).json({ error: result.reason });
    }
    return next();
  };
}

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
 * Factory: returns an Express router with GET /dashboard/overview mounted.
 *
 * @param {object} args
 * @param {() => import("@libsql/client").Client} args.createDbClient
 */
export default function federationRouter({ createDbClient }) {
  const router = Router();
  const dbForAudit = createDbClient();

  // Route path is relative to the `/dashboard` mount point in the parent
  // dashboard router. The external URL is `/dashboard/overview`.
  router.get("/overview", federationVerifyMiddleware(dbForAudit), async (req, res) => {
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

  return router;
}
