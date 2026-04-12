import { Router } from "express";

const LAPI_URL = () =>
  (process.env.CROWDSEC_LAPI_URL || "http://127.0.0.1:8091").replace(/\/+$/, "");
const API_KEY = () => process.env.CROWDSEC_API_KEY || "";
const TIMEOUT = 10_000;

async function lapiGet(path) {
  const key = API_KEY();
  if (!key) {
    throw new Error(
      "CROWDSEC_API_KEY not set. Generate with: docker exec crow-crowdsec cscli bouncers add crow-mcp",
    );
  }
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const r = await fetch(`${LAPI_URL()}${path}`, {
      signal: ctl.signal,
      headers: { "X-Api-Key": key },
    });
    if (r.status === 401 || r.status === 403) throw new Error("LAPI auth failed — regenerate bouncer key");
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    const text = await r.text();
    return text ? JSON.parse(text) : [];
  } finally {
    clearTimeout(t);
  }
}

export default function crowdsecRouter(authMiddleware) {
  const router = Router();

  router.get("/api/crowdsec/status", authMiddleware, async (_req, res) => {
    try {
      const key = API_KEY();
      // Status can partially work without key — at least report LAPI reachability.
      if (!key) {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), TIMEOUT);
        try {
          const r = await fetch(`${LAPI_URL()}/v1/decisions`, { signal: ctl.signal });
          res.json({ reachable: r.status === 401 || r.status === 403 || r.ok, api_key_configured: false, active_decisions: null, alerts_last_24h: null });
        } catch {
          res.json({ reachable: false, api_key_configured: false });
        } finally { clearTimeout(t); }
        return;
      }
      const [decisions, alerts] = await Promise.all([
        lapiGet("/v1/decisions").catch(() => []),
        lapiGet("/v1/alerts?since=24h").catch(() => []),
      ]);
      res.json({
        reachable: true,
        api_key_configured: true,
        active_decisions: Array.isArray(decisions) ? decisions.length : 0,
        alerts_last_24h: Array.isArray(alerts) ? alerts.length : 0,
      });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  router.get("/api/crowdsec/alerts", authMiddleware, async (_req, res) => {
    try {
      const data = await lapiGet("/v1/alerts?since=24h&limit=50");
      const alerts = (Array.isArray(data) ? data : []).map((a) => ({
        id: a.id,
        source_ip: a.source?.ip,
        source_cn: a.source?.cn,
        source_as: a.source?.as_name,
        scenario: a.scenario,
        events_count: a.events_count,
        created_at: a.created_at ? new Date(a.created_at).toISOString() : null,
      }));
      res.json({ alerts });
    } catch (err) { res.json({ error: err.message }); }
  });

  router.get("/api/crowdsec/decisions", authMiddleware, async (_req, res) => {
    try {
      const data = await lapiGet("/v1/decisions");
      const decisions = (Array.isArray(data) ? data : []).map((d) => ({
        id: d.id,
        type: d.type,
        scope: d.scope,
        value: d.value,
        origin: d.origin,
        until: d.until,
      }));
      res.json({ decisions });
    } catch (err) { res.json({ error: err.message }); }
  });

  return router;
}
