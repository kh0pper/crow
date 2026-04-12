/**
 * WriteFreely panel API routes — read-only status + recent posts.
 */

import { Router } from "express";

const WF_URL = () => (process.env.WF_URL || "http://writefreely:8080").replace(/\/+$/, "");
const WF_TOKEN = () => process.env.WF_ACCESS_TOKEN || "";
const WF_COLL = () => process.env.WF_COLLECTION_ALIAS || "";
const TIMEOUT = 10_000;

async function wf(path, { noAuth } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const headers = { Accept: "application/json" };
    if (!noAuth && WF_TOKEN()) headers.Authorization = `Token ${WF_TOKEN()}`;
    const r = await fetch(`${WF_URL()}${path}`, { signal: ctl.signal, headers });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    const text = await r.text();
    if (!text) return {};
    const parsed = JSON.parse(text);
    return parsed?.data !== undefined && parsed?.code ? parsed.data : parsed;
  } finally {
    clearTimeout(t);
  }
}

export default function writefreelyRouter(authMiddleware) {
  const router = Router();

  router.get("/api/writefreely/status", authMiddleware, async (_req, res) => {
    try {
      const me = WF_TOKEN() ? await wf("/api/me").catch(() => null) : null;
      const colls = WF_TOKEN() ? await wf("/api/me/collections").catch(() => []) : [];
      res.json({
        instance_url: WF_URL(),
        has_token: Boolean(WF_TOKEN()),
        authenticated_as: me?.username || null,
        collections: Array.isArray(colls) ? colls.map((c) => ({ alias: c.alias, title: c.title, posts: c.total_posts })) : [],
        default_collection: WF_COLL() || null,
      });
    } catch (err) {
      res.json({ error: `Cannot reach WriteFreely: ${err.message}` });
    }
  });

  router.get("/api/writefreely/recent", authMiddleware, async (req, res) => {
    try {
      const coll = (req.query.collection || WF_COLL() || "").toString();
      if (!coll) return res.json({ error: "collection alias required" });
      const data = await wf(`/api/collections/${encodeURIComponent(coll)}/posts?page=1`, { noAuth: true });
      const posts = data?.posts || data || [];
      res.json({
        collection: coll,
        posts: (Array.isArray(posts) ? posts : []).slice(0, 10).map((p) => ({
          id: p.id,
          slug: p.slug,
          title: p.title || "(untitled)",
          created: p.created,
          views: p.views,
          url: `${WF_URL()}/${coll}/${p.slug}`,
        })),
      });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  return router;
}
