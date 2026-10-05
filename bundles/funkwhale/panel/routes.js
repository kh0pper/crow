/**
 * Funkwhale panel API routes — status, libraries, recent listens, browse,
 * search, and same-origin proxies (stream + artwork) for browser playback.
 */

import { Router } from "express";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Address classification, resolved from the app root so it also works from an installed copy
// (the gateway sets CROW_APP_ROOT; the repo-relative fallback covers running from the checkout).
const appRoot = process.env.CROW_APP_ROOT || join(import.meta.dirname, "..", "..", "..");
const { isPublicIp } = await import(pathToFileURL(join(appRoot, "servers", "shared", "ip-classify.js")).href);

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

export const ARTWORK_MAX_BYTES = 5 * 1024 * 1024;
export const ARTWORK_TIMEOUT_MS = 10_000;
export const ARTWORK_MAX_HOPS = 3;

/** The host names the artwork proxy may reach on a private address: the configured Funkwhale
 * host, plus "localhost" and "127.0.0.1". Matched on URL.hostname exactly as written, never on
 * what a name resolves to. */
function allowedPrivateHosts() {
  let fwHost = null;
  try { fwHost = new URL(URL_BASE()).hostname; } catch {}
  return new Set([fwHost, "localhost", "127.0.0.1"].filter(Boolean));
}

/**
 * Decide whether the artwork proxy may connect to `hostname` (a URL.hostname, so an IPv6 literal
 * arrives bracketed). Resolves the name ONCE, every address family, and returns the answers so the
 * caller connects to exactly what was checked (a second lookup could answer differently: DNS
 * rebinding). An allow-listed host is resolved but not classified; any other host passes only
 * when every answer is a public address. → { ok: true, addresses } | { ok: false, reason }.
 * Exported for tests.
 */
export async function validateHostOrReject(hostname, { lookup = dnsLookup } = {}) {
  const allowListed = allowedPrivateHosts().has(hostname);
  const bare = String(hostname || "").replace(/^\[|\]$/g, "");
  let addresses;
  try {
    addresses = isIP(bare) ? [{ address: bare, family: isIP(bare) }] : await lookup(bare, { all: true });
  } catch {
    return { ok: false, reason: "dns_lookup_failed" };
  }
  if (!Array.isArray(addresses) || addresses.length === 0) return { ok: false, reason: "dns_lookup_failed" };
  if (!allowListed && addresses.some((a) => !isPublicIp(a.address))) return { ok: false, reason: "private_host" };
  return { ok: true, addresses };
}

export class ArtworkRefused extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status; }
}

/** One GET connected to `pinned` (never a fresh lookup). Resolves { redirect } or { contentType, body }. */
function getPinned(u, pinned, { headers, maxBytes, signal }) {
  const mod = u.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.get(u, {
      headers,
      signal,
      lookup: (_h, opts, cb) => (opts && opts.all ? cb(null, [{ address: pinned.address, family: pinned.family }]) : cb(null, pinned.address, pinned.family)),
    }, (res) => {
      const fail = (err) => { res.resume(); req.destroy(); reject(err); };
      const status = res.statusCode;
      if (status >= 300 && status < 400) {
        res.resume();
        if (!res.headers.location) return reject(new ArtworkRefused("redirect_without_location", 502));
        return resolve({ redirect: res.headers.location });
      }
      if (status < 200 || status >= 300) return fail(new ArtworkRefused(`upstream_${status}`, 502));
      const type = String(res.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
      // Images only; SVG is refused because it can carry script on the dashboard's origin.
      if (!type.startsWith("image/") || type === "image/svg+xml") return fail(new ArtworkRefused("not_an_image", 415));
      const declared = Number(res.headers["content-length"]);
      if (Number.isFinite(declared) && declared > maxBytes) return fail(new ArtworkRefused("too_large", 502));
      const parts = [];
      let n = 0;
      res.on("data", (c) => {
        n += c.length;
        if (n > maxBytes) { req.destroy(); reject(new ArtworkRefused("too_large", 502)); } else parts.push(c);
      });
      res.on("end", () => { if (n <= maxBytes) resolve({ contentType: type, body: Buffer.concat(parts) }); });
      res.on("error", (err) => reject(err));
    });
    req.on("error", (err) => reject(err));
  });
}

/**
 * Fetch artwork for the dashboard. Every hop (the first request and each redirect, at most
 * `maxHops` redirects) passes the same rule: http(s) only, host checked by validateHostOrReject,
 * connection pinned to the checked address. The Funkwhale token is sent only to the Funkwhale
 * origin. Images only, at most `maxBytes`, the whole fetch within `timeoutMs`.
 * → { contentType, body: Buffer }; throws ArtworkRefused.
 */
export async function fetchArtwork(src, { lookup = dnsLookup, maxBytes = ARTWORK_MAX_BYTES, timeoutMs = ARTWORK_TIMEOUT_MS, maxHops = ARTWORK_MAX_HOPS, signal } = {}) {
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
  const onAbort = () => ctl.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  let fwOrigin = null;
  try { fwOrigin = new URL(URL_BASE()).origin; } catch {}
  try {
    let u;
    try { u = new URL(src); } catch { throw new ArtworkRefused("invalid_url", 400); }
    for (let hop = 0; ; hop++) {
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new ArtworkRefused("unsupported_scheme", hop ? 502 : 400);
      const check = await validateHostOrReject(u.hostname, { lookup });
      if (!check.ok) throw new ArtworkRefused(check.reason, check.reason === "private_host" ? 403 : 502);
      if (ctl.signal.aborted) throw new ArtworkRefused(timedOut ? "timeout" : "aborted", 504);
      const headers = {};
      if (fwOrigin && u.origin === fwOrigin && TOKEN()) headers.Authorization = `Bearer ${TOKEN()}`;
      const r = await getPinned(u, check.addresses[0], { headers, maxBytes, signal: ctl.signal });
      if (!r.redirect) return r;
      if (hop >= maxHops) throw new ArtworkRefused("too_many_redirects", 502);
      try { u = new URL(r.redirect, u); } catch { throw new ArtworkRefused("bad_redirect", 502); }
    }
  } catch (err) {
    if (err instanceof ArtworkRefused) throw err;
    if (ctl.signal.aborted) throw new ArtworkRefused(timedOut ? "timeout" : "aborted", 504);
    throw new ArtworkRefused("upstream_error", 502);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
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
    if (!src || typeof src !== "string") return res.status(400).json({ error: "src required" });

    const controller = new AbortController();
    req.on("close", () => { try { controller.abort(); } catch {} });

    try {
      const art = await fetchArtwork(src, { signal: controller.signal });
      res.status(200);
      res.setHeader("Content-Type", art.contentType);
      res.setHeader("Content-Length", String(art.body.length));
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "private, max-age=3600");
      res.end(art.body);
    } catch (err) {
      if (err?.code === "aborted") return; // client disconnected
      if (!res.headersSent) res.status(err?.status || 502).json({ error: err?.code || "upstream_error" });
    }
  });

  return router;
}
