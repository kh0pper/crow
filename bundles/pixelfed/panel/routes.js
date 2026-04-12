/**
 * Pixelfed panel API routes — status + recent home-timeline posts.
 */

import { Router } from "express";

const URL_BASE = () => (process.env.PIXELFED_URL || "http://pixelfed:80").replace(/\/+$/, "");
const TOKEN = () => process.env.PIXELFED_ACCESS_TOKEN || "";
const HOSTNAME = () => process.env.PIXELFED_HOSTNAME || "";
const TIMEOUT = 15_000;

async function pf(path, { query, noAuth } = {}) {
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

export default function pixelfedRouter(authMiddleware) {
  const router = Router();

  router.get("/api/pixelfed/status", authMiddleware, async (_req, res) => {
    try {
      const instance = await pf("/api/v1/instance").catch(() => null);
      const peers = await pf("/api/v1/instance/peers").catch(() => []);
      const account = TOKEN() ? await pf("/api/v1/accounts/verify_credentials").catch(() => null) : null;
      res.json({
        hostname: HOSTNAME(),
        instance: instance ? {
          uri: instance.uri, title: instance.title, version: instance.version, stats: instance.stats,
        } : null,
        federated_peers: Array.isArray(peers) ? peers.length : null,
        authenticated_as: account ? { acct: account.acct, id: account.id } : null,
      });
    } catch (err) {
      res.json({ error: `Cannot reach Pixelfed: ${err.message}` });
    }
  });

  router.get("/api/pixelfed/feed", authMiddleware, async (_req, res) => {
    try {
      if (!TOKEN()) return res.json({ error: "PIXELFED_ACCESS_TOKEN not set" });
      const items = await pf("/api/v1/timelines/home", { query: { limit: 12 } });
      res.json({
        items: (Array.isArray(items) ? items : []).map((p) => ({
          id: p.id,
          acct: p.account?.acct,
          content_excerpt: (p.content || "").replace(/<[^>]+>/g, "").slice(0, 240),
          media_count: (p.media_attachments || []).length,
          visibility: p.visibility,
          favs: p.favourites_count,
          replies: p.replies_count,
        })),
      });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  return router;
}
