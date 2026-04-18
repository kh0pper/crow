/**
 * Funkwhale panel API routes — status, libraries, recent listens, browse,
 * search, and same-origin proxies (stream + artwork) for browser playback.
 */

import { Router } from "express";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { lookup as dnsLookup } from "node:dns/promises";

const URL_BASE = () => (process.env.FUNKWHALE_URL || "http://funkwhale-api:5000").replace(/\/+$/, "");
const TOKEN = () => process.env.FUNKWHALE_ACCESS_TOKEN || "";
const HOSTNAME = () => process.env.FUNKWHALE_HOSTNAME || "";
const TIMEOUT = 15_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STREAM_FORMATS = new Set(["mp3", "ogg", "opus"]);

async function fw(path, { noAuth, query } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const qs = query
      ? "?" +
        Object.entries(query)
          .filter(([, v]) => v != null && v !== "")
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
          .join("&")
      : "";
    const headers = {};
    if (!noAuth && TOKEN()) headers.Authorization = `Bearer ${TOKEN()}`;
    const r = await fetch(`${URL_BASE()}${path}${qs}`, { signal: ctl.signal, headers });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    const text = await r.text();
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(t);
  }
}

/** Resolve artwork URL, always returning an absolute URL or null. */
function resolveArtworkUrl(cover) {
  if (!cover) return null;
  const url = cover.urls?.medium_square_crop || cover.urls?.original || null;
  if (!url) return null;
  // Funkwhale sometimes returns relative paths; prefix with base.
  if (/^https?:\/\//i.test(url)) return url;
  return `${URL_BASE()}${url.startsWith("/") ? url : "/" + url}`;
}

/** Clamp page_size into [1, max] and page into [1, ∞). */
function clampPage(req, defaultSize, maxSize) {
  const pageSize = Math.max(1, Math.min(parseInt(req.query.page_size, 10) || defaultSize, maxSize));
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  return { page, page_size: pageSize };
}

/** Check if a host is on the Funkwhale allow-list or must pass private-IP guard. */
async function validateHostOrReject(hostname) {
  let fwHost = null;
  try { fwHost = new URL(URL_BASE()).hostname; } catch {}
  const allow = new Set([fwHost, "localhost", "127.0.0.1"].filter(Boolean));
  if (allow.has(hostname)) return { ok: true };
  try {
    const addr = await dnsLookup(hostname, { family: 4 });
    const [a, b] = addr.address.split(".").map(Number);
    const isPrivate = a === 10
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 169 && b === 254)
      || a === 127
      || (a === 100 && b >= 64 && b <= 127);
    if (isPrivate) return { ok: false, reason: "private_host" };
    return { ok: true };
  } catch {
    return { ok: false, reason: "dns_lookup_failed" };
  }
}

export default function funkwhaleRouter(authMiddleware) {
  const router = Router();

  router.get("/api/funkwhale/status", authMiddleware, async (_req, res) => {
    try {
      const nodeinfo = await fw("/api/v1/instance/nodeinfo/2.0/", { noAuth: true }).catch(() => null);
      const whoami = TOKEN() ? await fw("/api/v1/users/me/").catch(() => null) : null;
      res.json({
        hostname: HOSTNAME(),
        software: nodeinfo?.software?.name || null,
        version: nodeinfo?.software?.version || null,
        federation_enabled: nodeinfo?.metadata?.federation?.enabled ?? null,
        usage_users: nodeinfo?.usage?.users || null,
        whoami: whoami ? { username: whoami.username, is_superuser: whoami.is_superuser } : null,
      });
    } catch (err) {
      res.json({ error: `Cannot reach Funkwhale: ${err.message}` });
    }
  });

  router.get("/api/funkwhale/libraries", authMiddleware, async (_req, res) => {
    try {
      if (!TOKEN()) return res.json({ error: "FUNKWHALE_ACCESS_TOKEN not set" });
      const out = await fw("/api/v1/libraries/", { query: { scope: "me", page_size: 20 } });
      res.json({
        count: out.count,
        libraries: (out.results || []).map((l) => ({
          uuid: l.uuid,
          name: l.name,
          uploads_count: l.uploads_count,
          privacy_level: l.privacy_level,
        })),
      });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  router.get("/api/funkwhale/listens", authMiddleware, async (_req, res) => {
    try {
      if (!TOKEN()) return res.json({ error: "FUNKWHALE_ACCESS_TOKEN not set" });
      const pageSize = Math.max(1, Math.min(parseInt(_req.query.page_size, 10) || 10, 100));
      const out = await fw("/api/v1/history/listenings/", { query: { page_size: pageSize, ordering: "-creation_date" } });
      res.json({
        listens: (out.results || []).map((l) => ({
          ts: l.creation_date,
          track_uuid: l.track?.id,
          track_title: l.track?.title,
          artist: l.track?.artist?.name,
          album: l.track?.album?.title,
          artwork_url: resolveArtworkUrl(l.track?.album?.cover || l.track?.cover),
        })),
      });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  // ---------- Browse endpoints ----------

  router.get("/api/funkwhale/browse/artists", authMiddleware, async (req, res) => {
    try {
      if (!TOKEN()) return res.status(503).json({ error: "FUNKWHALE_ACCESS_TOKEN not set" });
      const { page, page_size } = clampPage(req, 50, 100);
      const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
      const out = await fw("/api/v1/artists/", {
        query: { page, page_size, q, ordering: "name" },
      });
      res.json({
        count: out.count || 0,
        results: (out.results || []).map((a) => ({
          id: a.id,
          name: a.name,
          tracks_count: a.tracks_count,
        })),
      });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  router.get("/api/funkwhale/browse/albums", authMiddleware, async (req, res) => {
    try {
      if (!TOKEN()) return res.status(503).json({ error: "FUNKWHALE_ACCESS_TOKEN not set" });
      const { page, page_size } = clampPage(req, 50, 100);
      const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
      const artist = req.query.artist;
      const out = await fw("/api/v1/albums/", {
        query: { page, page_size, q, artist, ordering: "title" },
      });
      res.json({
        count: out.count || 0,
        results: (out.results || []).map((a) => ({
          id: a.id,
          title: a.title,
          artist: a.artist?.name || null,
          artist_id: a.artist?.id || null,
          artwork_url: resolveArtworkUrl(a.cover),
          tracks_count: a.tracks_count,
          year: a.release_date ? String(a.release_date).slice(0, 4) : null,
        })),
      });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  router.get("/api/funkwhale/browse/tracks", authMiddleware, async (req, res) => {
    try {
      if (!TOKEN()) return res.status(503).json({ error: "FUNKWHALE_ACCESS_TOKEN not set" });
      const { page, page_size } = clampPage(req, 100, 100);
      const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
      const album = req.query.album;
      const out = await fw("/api/v1/tracks/", {
        query: { page, page_size, q, album, ordering: "position" },
      });
      res.json({
        count: out.count || 0,
        results: (out.results || []).map((t) => {
          const m = (t.listen_url || "").match(/\/listen\/([0-9a-f-]+)\//);
          return {
            uuid: m?.[1] || null,
            title: t.title,
            artist: t.artist?.name || null,
            album: t.album?.title || null,
            album_id: t.album?.id || null,
            position: t.position,
            duration: t.duration,
            artwork_url: resolveArtworkUrl(t.album?.cover || t.cover),
          };
        }),
      });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // ---------- Search ----------

  router.get("/api/funkwhale/search", authMiddleware, async (req, res) => {
    try {
      if (!TOKEN()) return res.status(503).json({ error: "FUNKWHALE_ACCESS_TOKEN not set" });
      const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
      if (q.length < 2) {
        return res.json({ artists: [], albums: [], tracks: [] });
      }
      const pageSize = Math.max(1, Math.min(parseInt(req.query.page_size, 10) || 20, 50));
      // Funkwhale's search endpoint is `/api/v1/search` (no trailing slash);
      // the trailing-slash variant 404s. Accepts either `q=` or `query=`.
      const out = await fw("/api/v1/search", { query: { query: q, page_size: pageSize } });
      res.json({
        artists: (out.artists || []).map((a) => ({
          id: a.id,
          name: a.name,
          tracks_count: a.tracks_count,
        })),
        albums: (out.albums || []).map((a) => ({
          id: a.id,
          title: a.title,
          artist: a.artist?.name || null,
          artwork_url: resolveArtworkUrl(a.cover),
        })),
        tracks: (out.tracks || []).map((t) => {
          const m = (t.listen_url || "").match(/\/listen\/([0-9a-f-]+)\//);
          return {
            uuid: m?.[1] || null,
            title: t.title,
            artist: t.artist?.name || null,
            album: t.album?.title || null,
            artwork_url: resolveArtworkUrl(t.album?.cover || t.cover),
          };
        }),
      });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // ---------- Stream proxy (audio) ----------

  router.get("/api/funkwhale/stream/:trackUuid", authMiddleware, async (req, res) => {
    const { trackUuid } = req.params;
    if (!UUID_RE.test(trackUuid)) {
      return res.status(400).json({ error: "invalid trackUuid" });
    }
    const to = typeof req.query.to === "string" ? req.query.to.toLowerCase() : "mp3";
    if (!STREAM_FORMATS.has(to)) {
      return res.status(400).json({ error: "unsupported format" });
    }
    if (!TOKEN()) return res.status(503).json({ error: "FUNKWHALE_ACCESS_TOKEN not set" });

    const upstreamUrl = `${URL_BASE()}/api/v1/listen/${encodeURIComponent(trackUuid)}/?to=${to}`;
    const controller = new AbortController();
    req.on("close", () => { try { controller.abort(); } catch {} });

    try {
      const headers = { Authorization: `Bearer ${TOKEN()}` };
      if (req.headers.range) headers.Range = req.headers.range;
      if (req.headers["if-range"]) headers["If-Range"] = req.headers["if-range"];
      if (req.headers["if-none-match"]) headers["If-None-Match"] = req.headers["if-none-match"];

      const upstream = await fetch(upstreamUrl, {
        headers,
        redirect: "follow",
        signal: controller.signal,
      });

      // Record listen in Funkwhale history (fire-and-forget) on first 200-class
      // response for this track. A Range request may hit this route many times
      // for the same track; only record when the byte range starts at 0.
      // Funkwhale's history endpoint needs the integer track PK, not the UUID —
      // resolve via GET /api/v1/tracks/{uuid}/ first (cheap, cacheable).
      const isFreshPlay = upstream.ok && (!req.headers.range || /^bytes=0-/.test(req.headers.range));
      if (isFreshPlay) {
        fw(`/api/v1/tracks/${encodeURIComponent(trackUuid)}/`)
          .then((meta) => {
            if (!meta?.id) return;
            return fetch(`${URL_BASE()}/api/v1/history/listenings/`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${TOKEN()}`,
              },
              body: JSON.stringify({ track: meta.id }),
            });
          })
          .catch(() => { /* fire-and-forget */ });
      }

      // Ordering: status → headers → body pipeline.
      res.status(upstream.status);
      const passthrough = ["content-type", "content-length", "content-range", "accept-ranges", "etag"];
      for (const h of passthrough) {
        const v = upstream.headers.get(h);
        if (v) res.setHeader(h, v);
      }
      res.setHeader("Cache-Control", "private, max-age=0, no-store");

      if (!upstream.body) { res.end(); return; }
      const body = upstream.body;
      const nodeStream = (typeof body?.getReader === "function") ? Readable.fromWeb(body) : body;
      await pipeline(nodeStream, res, { signal: controller.signal });
    } catch (err) {
      if (err?.name === "AbortError") return; // client disconnected — expected
      if (!res.headersSent) res.status(502).json({ error: err.message });
    }
  });

  // ---------- Artwork proxy (same-origin, dashboard-authed) ----------

  router.get("/api/funkwhale/artwork", authMiddleware, async (req, res) => {
    const src = req.query.src;
    if (!src) return res.status(400).json({ error: "src required" });

    let srcUrl;
    try { srcUrl = new URL(src); } catch { return res.status(400).json({ error: "invalid url" }); }
    if (srcUrl.protocol !== "http:" && srcUrl.protocol !== "https:") {
      return res.status(400).json({ error: "unsupported scheme" });
    }

    const hostCheck = await validateHostOrReject(srcUrl.hostname);
    if (!hostCheck.ok) return res.status(403).json({ error: hostCheck.reason || "host not allowed" });

    // Inject Funkwhale bearer when host matches FUNKWHALE_URL
    const headers = {};
    try {
      if (URL_BASE() && srcUrl.hostname === new URL(URL_BASE()).hostname && TOKEN()) {
        headers.Authorization = `Bearer ${TOKEN()}`;
      }
    } catch {}

    const controller = new AbortController();
    req.on("close", () => { try { controller.abort(); } catch {} });

    try {
      const upstream = await fetch(src, {
        headers,
        redirect: "follow",
        signal: controller.signal,
      });
      if (!upstream.ok || !upstream.body) {
        return res.status(upstream.status || 502).json({ error: `upstream ${upstream.status}` });
      }
      res.status(upstream.status);
      const ct = upstream.headers.get("content-type") || "application/octet-stream";
      const cl = upstream.headers.get("content-length");
      res.setHeader("Content-Type", ct);
      if (cl) res.setHeader("Content-Length", cl);
      res.setHeader("Cache-Control", "private, max-age=3600");

      const body = upstream.body;
      const nodeStream = (typeof body?.getReader === "function") ? Readable.fromWeb(body) : body;
      await pipeline(nodeStream, res, { signal: controller.signal });
    } catch (err) {
      if (err?.name === "AbortError") return;
      if (!res.headersSent) res.status(502).json({ error: err.message });
    }
  });

  return router;
}
