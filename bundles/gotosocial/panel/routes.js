/**
 * GoToSocial panel API routes.
 *
 * Dashboard-only endpoints. Read-only — no moderation actions fire here
 * (moderation queue confirmation UI lands with F.11/F.12). All calls hit
 * the GoToSocial API using the configured access token; public endpoints
 * work even without a token.
 */

import { Router } from "express";

const GTS_URL = () => (process.env.GTS_URL || "http://gotosocial:8080").replace(/\/+$/, "");
const GTS_ACCESS_TOKEN = () => process.env.GTS_ACCESS_TOKEN || "";
const TIMEOUT = 10_000;

async function gts(path, { noAuth } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const headers = { Accept: "application/json" };
    if (!noAuth && GTS_ACCESS_TOKEN()) headers.Authorization = `Bearer ${GTS_ACCESS_TOKEN()}`;
    const r = await fetch(`${GTS_URL()}${path}`, { signal: ctl.signal, headers });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    const text = await r.text();
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(t);
  }
}

export default function gotosocialRouter(authMiddleware) {
  const router = Router();

  router.get("/api/gotosocial/status", authMiddleware, async (_req, res) => {
    try {
      const [instance, account, peers] = await Promise.all([
        gts("/api/v1/instance", { noAuth: true }),
        GTS_ACCESS_TOKEN() ? gts("/api/v1/accounts/verify_credentials").catch(() => null) : Promise.resolve(null),
        gts("/api/v1/instance/peers", { noAuth: true }).catch(() => []),
      ]);
      res.json({
        uri: instance.uri,
        title: instance.title,
        version: instance.version,
        stats: instance.stats,
        account: account ? { acct: account.acct, display_name: account.display_name } : null,
        federated_peers: Array.isArray(peers) ? peers.length : null,
        has_token: Boolean(GTS_ACCESS_TOKEN()),
      });
    } catch (err) {
      res.json({ error: `Cannot reach GoToSocial: ${err.message}` });
    }
  });

  router.get("/api/gotosocial/timeline", authMiddleware, async (req, res) => {
    try {
      const source = req.query.source === "home" && GTS_ACCESS_TOKEN() ? "home" : "public";
      const limit = Math.max(1, Math.min(20, Number(req.query.limit) || 10));
      const items = await gts(
        source === "home"
          ? `/api/v1/timelines/home?limit=${limit}`
          : `/api/v1/timelines/public?limit=${limit}`,
        { noAuth: source === "public" },
      );
      const summary = (Array.isArray(items) ? items : []).map((it) => ({
        id: it.id,
        acct: it.account?.acct,
        display_name: it.account?.display_name,
        url: it.url,
        content_excerpt: (it.content || "").replace(/<[^>]+>/g, "").slice(0, 280),
        created_at: it.created_at,
        reblogs: it.reblogs_count,
        favs: it.favourites_count,
      }));
      res.json({ source, count: summary.length, items: summary });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  return router;
}
