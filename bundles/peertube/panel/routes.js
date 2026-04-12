/**
 * PeerTube panel API routes — status + recent videos.
 */

import { Router } from "express";

const URL_BASE = () => (process.env.PEERTUBE_URL || "http://peertube:9000").replace(/\/+$/, "");
const TOKEN = () => process.env.PEERTUBE_ACCESS_TOKEN || "";
const HOSTNAME = () => process.env.PEERTUBE_WEBSERVER_HOSTNAME || "";
const TIMEOUT = 15_000;

async function pt(path, { query, noAuth } = {}) {
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

export default function peertubeRouter(authMiddleware) {
  const router = Router();

  router.get("/api/peertube/status", authMiddleware, async (_req, res) => {
    try {
      const config = await pt("/api/v1/config", { noAuth: true }).catch(() => null);
      const stats = await pt("/api/v1/server/stats", { noAuth: true }).catch(() => null);
      const me = TOKEN() ? await pt("/api/v1/users/me").catch(() => null) : null;
      res.json({
        hostname: HOSTNAME(),
        instance_name: config?.instance?.name,
        version: config?.serverVersion,
        transcoding_enabled: (config?.transcoding?.enabledResolutions?.length || 0) > 0,
        object_storage: config?.objectStorage || null,
        signup_enabled: config?.signup?.allowed,
        stats: stats ? {
          videos: stats.totalLocalVideos,
          video_views: stats.totalLocalVideoViews,
          instance_following: stats.totalInstanceFollowing,
        } : null,
        authenticated_as: me ? { username: me.username, role: me.role?.label } : null,
      });
    } catch (err) {
      res.json({ error: `Cannot reach PeerTube: ${err.message}` });
    }
  });

  router.get("/api/peertube/videos", authMiddleware, async (_req, res) => {
    try {
      const out = await pt("/api/v1/videos", { query: { count: 12, sort: "-publishedAt", filter: "local" }, noAuth: !TOKEN() });
      res.json({
        videos: (out.data || []).map((v) => ({
          id: v.id,
          uuid: v.uuid,
          name: v.name,
          channel: v.channel?.displayName,
          duration_seconds: v.duration,
          views: v.views,
          likes: v.likes,
        })),
      });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  return router;
}
