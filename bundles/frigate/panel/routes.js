/**
 * Frigate panel routes — Express router proxying Frigate REST calls for the Nest panel.
 *
 * JWT Bearer pattern mirrors bundles/actual-budget/panel/routes.js:
 *   login once → cache token → refresh on 401
 *
 * All routes are protected by dashboardAuth. The panel browser-side fetches
 * these paths — NOT the raw :8971 endpoint — so Frigate's JWT never leaves
 * the gateway process.
 *
 * TLS: we assume Frigate is configured with `tls.enabled: false` (our
 * config.yml.example default). See server/frigate-api.js for the
 * re-enable-TLS caveat.
 */

import { Router } from "express";

const FRIGATE_URL = () => (process.env.FRIGATE_URL || "http://localhost:8971").replace(/\/+$/, "");
const FRIGATE_USER = () => process.env.FRIGATE_USER || "";
const FRIGATE_PASSWORD = () => process.env.FRIGATE_PASSWORD || "";

let authToken = null;

async function getToken() {
  if (authToken) return authToken;
  if (!FRIGATE_USER() || !FRIGATE_PASSWORD()) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(`${FRIGATE_URL()}/api/login`, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user: FRIGATE_USER(), password: FRIGATE_PASSWORD() }),
    });
    if (!res.ok) throw new Error("Frigate login failed — check FRIGATE_USER / FRIGATE_PASSWORD");
    const data = await res.json().catch(() => ({}));
    authToken = data.access_token || data.token || null;
    if (!authToken) {
      const setCookie = res.headers.get("set-cookie") || "";
      const match = setCookie.match(/frigate_token=([^;]+)/);
      if (match) authToken = match[1];
    }
    if (!authToken) throw new Error("Frigate /api/login returned no token");
    return authToken;
  } finally {
    clearTimeout(timeout);
  }
}

async function frFetch(path, opts = {}) {
  const token = await getToken();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const headers = { "Content-Type": "application/json", ...opts.headers };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${FRIGATE_URL()}${path}`, { ...opts, signal: controller.signal, headers });
    if (res.status === 401) {
      authToken = null;
      throw new Error("Authentication expired — refresh the page");
    }
    if (!res.ok) throw new Error(`Frigate ${res.status}: ${res.statusText}`);
    return res;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Stream bytes from Frigate to the client (for snapshots + clips).
 * Preserves Content-Type and Content-Length when present.
 */
async function streamFromFrigate(req, res, path) {
  try {
    const upstream = await frFetch(path);
    res.status(upstream.status);
    const ct = upstream.headers.get("content-type");
    if (ct) res.set("content-type", ct);
    const cl = upstream.headers.get("content-length");
    if (cl) res.set("content-length", cl);
    res.set("cache-control", "private, max-age=300");
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.end(buf);
  } catch (err) {
    if (!res.headersSent) res.status(502).json({ error: err.message });
  }
}

/**
 * @param {Function} authMiddleware - Dashboard auth middleware
 * @returns {Router}
 */
export default function frigateRouter(authMiddleware) {
  const router = Router();

  router.get("/api/frigate/cameras", authMiddleware, async (req, res) => {
    try {
      const upstream = await frFetch("/api/config");
      const config = await upstream.json();
      const cameras = Object.entries(config.cameras || {}).map(([name, cam]) => ({
        name,
        enabled: cam.enabled !== false,
        detect_enabled: cam.detect?.enabled !== false,
        width: cam.detect?.width || null,
        height: cam.detect?.height || null,
        tracked_objects: cam.objects?.track || [],
      }));
      res.json({ cameras });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  router.get("/api/frigate/stats", authMiddleware, async (req, res) => {
    try {
      const upstream = await frFetch("/api/stats");
      const stats = await upstream.json();
      res.json(stats);
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  router.get("/api/frigate/events", authMiddleware, async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit, 10) || 20, 200);
      const params = new URLSearchParams({ limit: String(limit) });
      if (req.query.camera) params.set("cameras", String(req.query.camera));
      if (req.query.label) params.set("labels", String(req.query.label));
      if (req.query.has_clip) params.set("has_clip", "1");
      const upstream = await frFetch(`/api/events?${params}`);
      const events = await upstream.json();
      const out = (Array.isArray(events) ? events : []).map((e) => ({
        id: e.id,
        camera: e.camera,
        label: e.label,
        sub_label: e.sub_label || null,
        score: e.top_score ?? e.score ?? null,
        start_time: e.start_time,
        end_time: e.end_time,
        has_snapshot: !!e.has_snapshot,
        has_clip: !!e.has_clip,
      }));
      res.json({ events: out });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  // Thumbnail + clip bytes proxied through the gateway so Frigate's JWT stays server-side.
  router.get("/api/frigate/events/:id/thumbnail.jpg", authMiddleware, (req, res) =>
    streamFromFrigate(req, res, `/api/events/${encodeURIComponent(req.params.id)}/thumbnail.jpg`),
  );
  router.get("/api/frigate/events/:id/snapshot.jpg", authMiddleware, (req, res) =>
    streamFromFrigate(req, res, `/api/events/${encodeURIComponent(req.params.id)}/snapshot.jpg`),
  );
  router.get("/api/frigate/:camera/latest.jpg", authMiddleware, (req, res) =>
    streamFromFrigate(req, res, `/api/${encodeURIComponent(req.params.camera)}/latest.jpg`),
  );

  return router;
}
