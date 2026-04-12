/**
 * Mastodon panel API routes — status + home timeline.
 */

import { Router } from "express";

const URL_BASE = () => (process.env.MASTODON_URL || "http://mastodon-web:3000").replace(/\/+$/, "");
const TOKEN = () => process.env.MASTODON_ACCESS_TOKEN || "";
const LOCAL_DOMAIN = () => process.env.MASTODON_LOCAL_DOMAIN || "";
const TIMEOUT = 15_000;

async function md(path, { query, noAuth } = {}) {
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

export default function mastodonRouter(authMiddleware) {
  const router = Router();

  router.get("/api/mastodon/status", authMiddleware, async (_req, res) => {
    try {
      const instance = await md("/api/v2/instance", { noAuth: true }).catch(() => md("/api/v1/instance", { noAuth: true }).catch(() => null));
      const peers = await md("/api/v1/instance/peers").catch(() => []);
      const account = TOKEN() ? await md("/api/v1/accounts/verify_credentials").catch(() => null) : null;
      res.json({
        local_domain: LOCAL_DOMAIN(),
        title: instance?.title,
        version: instance?.version,
        users: instance?.usage?.users?.active_month ?? instance?.stats?.user_count,
        statuses: instance?.stats?.status_count,
        domains: instance?.stats?.domain_count,
        registrations_open: instance?.registrations?.enabled ?? instance?.registrations,
        federated_peers: Array.isArray(peers) ? peers.length : null,
        authenticated_as: account ? { acct: account.acct, id: account.id } : null,
      });
    } catch (err) {
      res.json({ error: `Cannot reach Mastodon: ${err.message}` });
    }
  });

  router.get("/api/mastodon/feed", authMiddleware, async (_req, res) => {
    try {
      if (!TOKEN()) return res.json({ error: "MASTODON_ACCESS_TOKEN not set" });
      const items = await md("/api/v1/timelines/home", { query: { limit: 12 } });
      res.json({
        items: (Array.isArray(items) ? items : []).map((p) => ({
          id: p.id,
          acct: p.account?.acct,
          content_excerpt: (p.content || "").replace(/<[^>]+>/g, "").slice(0, 240),
          media_count: (p.media_attachments || []).length,
          visibility: p.visibility,
          favs: p.favourites_count,
          replies: p.replies_count,
          reblogs: p.reblogs_count,
        })),
      });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  return router;
}
