/**
 * Netdata API Routes — Express router for the Crow's Nest panel.
 */

import { Router } from "express";

const NETDATA_URL = () =>
  (process.env.NETDATA_URL || "http://localhost:19999").replace(/\/+$/, "");
const TIMEOUT = 10_000;

async function ndGet(path) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const r = await fetch(`${NETDATA_URL()}${path}`, { signal: ctl.signal });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    const text = await r.text();
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(t);
  }
}

export default function netdataRouter(authMiddleware) {
  const router = Router();

  router.get("/api/netdata/status", authMiddleware, async (_req, res) => {
    try {
      const [info, alarms, charts] = await Promise.all([
        ndGet("/api/v1/info"),
        ndGet("/api/v1/alarms?all=false").catch(() => ({ alarms: {} })),
        ndGet("/api/v1/charts").catch(() => ({ charts: {} })),
      ]);
      res.json({
        version: info.version,
        charts_available: Object.keys(charts.charts || {}).length,
        cores: info.cores_total,
        raised_alarms: Object.keys(alarms.alarms || {}).length,
      });
    } catch (err) {
      res.json({ error: `Cannot reach Netdata: ${err.message}` });
    }
  });

  router.get("/api/netdata/alarms", authMiddleware, async (_req, res) => {
    try {
      const d = await ndGet("/api/v1/alarms?all=false");
      const alarms = Object.entries(d.alarms || {}).map(([id, a]) => ({
        id,
        name: a.name,
        chart: a.chart,
        status: a.status,
        value: a.value,
        units: a.units,
        info: a.info,
      }));
      res.json({ alarms });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  return router;
}
