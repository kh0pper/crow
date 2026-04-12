import { Router } from "express";

const ADGUARD_URL = () =>
  (process.env.ADGUARD_URL || "http://localhost:3020").replace(/\/+$/, "");

function authHeader() {
  const u = process.env.ADGUARD_USERNAME || "";
  const p = process.env.ADGUARD_PASSWORD || "";
  if (!u || !p) return null;
  return "Basic " + Buffer.from(`${u}:${p}`).toString("base64");
}

async function agGet(path) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 10_000);
  const auth = authHeader();
  try {
    const r = await fetch(`${ADGUARD_URL()}${path}`, {
      signal: ctl.signal,
      headers: auth ? { Authorization: auth } : {},
    });
    if (r.status === 401 || r.status === 403) throw new Error("Auth failed — check ADGUARD_USERNAME and ADGUARD_PASSWORD");
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    const text = await r.text();
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(t);
  }
}

export default function adguardRouter(authMiddleware) {
  const router = Router();

  router.get("/api/adguard/status", authMiddleware, async (_req, res) => {
    try {
      const [status, stats, filters] = await Promise.all([
        agGet("/control/status"),
        agGet("/control/stats").catch(() => ({})),
        agGet("/control/filtering/status").catch(() => ({})),
      ]);
      res.json({
        version: status.version,
        protection_enabled: status.protection_enabled,
        running: status.running,
        num_dns_queries_today: stats.num_dns_queries ?? null,
        num_blocked_filtering_today: stats.num_blocked_filtering ?? null,
        filter_lists_enabled: (filters.filters || []).filter((f) => f.enabled).length,
        filter_lists_total: (filters.filters || []).length,
        filter_rules_total: filters.filters?.reduce((sum, f) => sum + (f.rules_count || 0), 0) ?? null,
      });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  router.get("/api/adguard/top-blocked", authMiddleware, async (_req, res) => {
    try {
      const stats = await agGet("/control/stats");
      const top = (stats.top_blocked_domains || []).slice(0, 10).map((d) => {
        const [name, count] = Object.entries(d)[0];
        return { name, count };
      });
      res.json({ top_blocked: top });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  return router;
}
