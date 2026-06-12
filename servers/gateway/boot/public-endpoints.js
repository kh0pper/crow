/**
 * boot/public-endpoints.js — robots.txt, root redirect, room-validate, TURN creds,
 * identity .well-known ×2 (rate-limited), /health, /setup mount, crowMdHandler body.
 *
 * C1: relayDb is created in index.js BEFORE this call and passed in deps so the
 * .well-known handlers (which query identity_attestations) don't close over an
 * undefined variable.
 */

import { createHmac } from "node:crypto";
import rateLimit from "express-rate-limit";
import { setupPageHandler } from "../setup-page.js";
import { generateCrowContext } from "../../memory/crow-context.js";
import { createDbClient } from "../../db.js";
import { getProxyStatus } from "../proxy.js";

// --- Identity page size (used by .well-known handlers) ---
const IDENTITY_PAGE_SIZE = 256;
const identityLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true });

// --- TURN credential limiter ---
const turnCredLimiter = rateLimit({ windowMs: 60 * 1000, max: 10, standardHeaders: true });

export async function mountPublicEndpoints(app, deps) {
  const { relayDb } = deps;

  // --- robots.txt (site-wide, before any router mounts) ---
  app.get("/robots.txt", (req, res) => {
    const gatewayUrl = process.env.CROW_GATEWAY_URL || process.env.RENDER_EXTERNAL_URL;
    let body = `User-agent: *\nDisallow: /\nAllow: /blog/\n`;
    if (gatewayUrl) {
      body += `Sitemap: ${gatewayUrl}/blog/sitemap.xml\n`;
    }
    res.set("Content-Type", "text/plain");
    res.set("Cache-Control", "public, max-age=3600");
    res.send(body);
  });

  // --- Root redirect (convenience for managed hosting users) ---
  app.get("/", (req, res) => res.redirect("/dashboard/nest"));

  // --- Room Token Validation (used by companion for WebSocket auth) ---
  app.get("/api/room/validate", (req, res) => {
    const { validateRoomToken } = deps;
    const { room, token } = req.query;
    if (!room || !token) return res.status(400).json({ valid: false, error: "Missing room or token" });
    const result = validateRoomToken(String(room), String(token));
    if (!result) return res.status(401).json({ valid: false });
    res.json({ valid: true, ...result });
  });

  // --- TURN Credentials (time-limited, HMAC-based for coturn use-auth-secret) ---
  app.get("/api/turn-credentials", turnCredLimiter, (req, res) => {
    const secret = process.env.TURN_SECRET;
    const turnUrl = process.env.TURN_URL || process.env.WEBRTC_TURN_URL;
    if (!secret || !turnUrl) {
      return res.status(404).json({ error: "TURN server not configured" });
    }
    const ttl = 3600; // 1 hour
    const timestamp = Math.floor(Date.now() / 1000) + ttl;
    const username = String(timestamp);
    const credential = createHmac("sha1", secret).update(username).digest("base64");
    res.json({
      urls: turnUrl,
      username,
      credential,
      ttl,
    });
  });

  // --- F.11: Identity Attestation (.well-known endpoints, rate-limited) ---
  // Public, unauthenticated, rate-limited to 60 req/min/IP. Paginated at
  // 256 active attestations per page. Revocations >1 year move to cold
  // storage (not yet implemented — current window retains everything).

  app.get("/.well-known/crow-identity.json", identityLimiter, async (req, res) => {
    try {
      const { loadOrCreateIdentity } = await import("../../sharing/identity.js");
      const identity = loadOrCreateIdentity();
      const cursor = Number(req.query.cursor) || 0;
      const rows = await relayDb.execute({
        sql: `SELECT id, app, external_handle, app_pubkey, sig, version, created_at
              FROM identity_attestations
              WHERE crow_id = ? AND revoked_at IS NULL
              ORDER BY id ASC LIMIT ? OFFSET ?`,
        args: [identity.crowId, IDENTITY_PAGE_SIZE + 1, cursor],
      });
      const hasNext = rows.rows.length > IDENTITY_PAGE_SIZE;
      const page = rows.rows.slice(0, IDENTITY_PAGE_SIZE);
      res.set("Cache-Control", "public, max-age=60");
      res.json({
        version: 1,
        crow_id: identity.crowId,
        root_pubkey: identity.ed25519Pubkey,
        page_size: IDENTITY_PAGE_SIZE,
        cursor,
        next: hasNext ? cursor + IDENTITY_PAGE_SIZE : null,
        active_attestations: page.map(r => ({
          id: Number(r.id),
          app: r.app,
          external_handle: r.external_handle,
          app_pubkey: r.app_pubkey || null,
          sig: r.sig,
          version: Number(r.version),
          created_at: Number(r.created_at),
        })),
        revocation_list_url: "/.well-known/crow-identity-revocations.json",
      });
    } catch (err) {
      res.status(500).json({ error: "identity publication unavailable" });
    }
  });

  app.get("/.well-known/crow-identity-revocations.json", identityLimiter, async (req, res) => {
    try {
      const { loadOrCreateIdentity } = await import("../../sharing/identity.js");
      const identity = loadOrCreateIdentity();
      const cursor = Number(req.query.cursor) || 0;
      const rows = await relayDb.execute({
        sql: `SELECT r.id, r.attestation_id, r.revoked_at, r.reason, r.sig, a.app, a.external_handle, a.version
              FROM identity_attestation_revocations r
              JOIN identity_attestations a ON a.id = r.attestation_id
              WHERE a.crow_id = ?
              ORDER BY r.revoked_at DESC LIMIT ? OFFSET ?`,
        args: [identity.crowId, IDENTITY_PAGE_SIZE + 1, cursor],
      });
      const hasNext = rows.rows.length > IDENTITY_PAGE_SIZE;
      const page = rows.rows.slice(0, IDENTITY_PAGE_SIZE);
      res.set("Cache-Control", "public, max-age=60");
      res.json({
        version: 1,
        crow_id: identity.crowId,
        page_size: IDENTITY_PAGE_SIZE,
        cursor,
        next: hasNext ? cursor + IDENTITY_PAGE_SIZE : null,
        revocations: page.map(r => ({
          attestation_id: Number(r.attestation_id),
          app: r.app,
          external_handle: r.external_handle,
          version: Number(r.version),
          revoked_at: Number(r.revoked_at),
          reason: r.reason || null,
          sig: r.sig,
        })),
      });
    } catch (err) {
      res.status(500).json({ error: "revocation list unavailable" });
    }
  });

  // --- Health Check ---
  app.get("/health", async (req, res) => {
    const proxyStatus = getProxyStatus();
    const connectedTools = proxyStatus.filter((s) => s.status === "connected");
    const servers = ["crow-memory", "crow-projects", "crow-sharing"];

    // Conditionally include storage/blog based on availability
    try {
      const { isAvailable } = await import("../../storage/s3-client.js");
      if (await isAvailable()) servers.push("crow-storage");
    } catch {}
    servers.push("crow-blog");
    // crow-media is now a bundle add-on — its tools appear via proxy when installed

    const externalToolCount = connectedTools.reduce((sum, s) => sum + s.toolCount, 0);
    const coreToolCount = 49; // 12 memory + 12 research + 8 sharing + 5 storage + 12 blog
    const routerDisabled = process.env.CROW_DISABLE_ROUTER === "1";

    res.json({
      status: "ok",
      servers,
      externalServers: connectedTools.map((s) => ({ id: s.id, name: s.name, tools: s.toolCount })),
      toolCounts: {
        core: coreToolCount,
        external: externalToolCount,
        total: coreToolCount + externalToolCount,
        routerMode: routerDisabled ? null : 7,
      },
    });
  });

  // --- Setup Page (no auth — first-run password only, redirects after password set) ---
  app.get("/setup", setupPageHandler);
}

// --- crow.md handler body (the MOUNT stays in index.js at :608 — export the handler) ---
export const crowMdHandler = async (req, res) => {
  const db = createDbClient();
  const platform = req.query.platform || "generic";
  const includeDynamic = req.query.dynamic !== "false";
  try {
    const markdown = await generateCrowContext(db, { includeDynamic, platform, deviceId: process.env.CROW_DEVICE_ID || null });
    res.type("text/markdown").send(markdown);
  } catch (err) {
    console.error("Error generating crow.md:", err);
    res.status(500).send("Error generating crow.md");
  } finally {
    db.close();
  }
};
