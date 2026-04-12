/**
 * Funkwhale panel API routes — status, libraries, recent listens.
 */

import { Router } from "express";

const URL_BASE = () => (process.env.FUNKWHALE_URL || "http://funkwhale-api:5000").replace(/\/+$/, "");
const TOKEN = () => process.env.FUNKWHALE_ACCESS_TOKEN || "";
const HOSTNAME = () => process.env.FUNKWHALE_HOSTNAME || "";
const TIMEOUT = 15_000;

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
      const out = await fw("/api/v1/history/listenings/", { query: { page_size: 10, ordering: "-creation_date" } });
      res.json({
        listens: (out.results || []).map((l) => ({
          ts: l.creation_date,
          track_title: l.track?.title,
          artist: l.track?.artist?.name,
          album: l.track?.album?.title,
        })),
      });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  return router;
}
