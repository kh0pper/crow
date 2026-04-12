/**
 * Lemmy panel API routes — status, communities, hot posts.
 */

import { Router } from "express";

const URL_BASE = () => (process.env.LEMMY_URL || "http://lemmy:8536").replace(/\/+$/, "");
const JWT = () => process.env.LEMMY_JWT || "";
const HOSTNAME = () => process.env.LEMMY_HOSTNAME || "";
const TIMEOUT = 15_000;

async function lem(path, { query, noAuth } = {}) {
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
    if (!noAuth && JWT()) headers.Authorization = `Bearer ${JWT()}`;
    const r = await fetch(`${URL_BASE()}${path}${qs}`, { signal: ctl.signal, headers });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    const text = await r.text();
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(t);
  }
}

export default function lemmyRouter(authMiddleware) {
  const router = Router();

  router.get("/api/lemmy/status", authMiddleware, async (_req, res) => {
    try {
      const site = await lem("/api/v3/site", { noAuth: !JWT() });
      res.json({
        hostname: HOSTNAME(),
        version: site.version,
        site_name: site.site_view?.site?.name,
        users: site.site_view?.counts?.users,
        posts: site.site_view?.counts?.posts,
        communities: site.site_view?.counts?.communities,
        federation_enabled: site.site_view?.local_site?.federation_enabled,
        registration_mode: site.site_view?.local_site?.registration_mode,
        my_user: site.my_user?.local_user_view?.person?.name,
      });
    } catch (err) {
      res.json({ error: `Cannot reach Lemmy: ${err.message}` });
    }
  });

  router.get("/api/lemmy/communities", authMiddleware, async (_req, res) => {
    try {
      const out = await lem("/api/v3/community/list", { query: { type_: "Local", sort: "Active", limit: 15 }, noAuth: !JWT() });
      res.json({
        communities: (out.communities || []).map((c) => ({
          id: c.community.id,
          name: c.community.name,
          title: c.community.title,
          subscribers: c.counts?.subscribers,
          posts: c.counts?.posts,
        })),
      });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  router.get("/api/lemmy/posts", authMiddleware, async (_req, res) => {
    try {
      const out = await lem("/api/v3/post/list", { query: { type_: "Local", sort: "Hot", limit: 12 }, noAuth: !JWT() });
      res.json({
        posts: (out.posts || []).map((p) => ({
          id: p.post?.id,
          name: p.post?.name,
          community: p.community?.name,
          creator: p.creator?.name,
          score: p.counts?.score,
          comments: p.counts?.comments,
        })),
      });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  return router;
}
