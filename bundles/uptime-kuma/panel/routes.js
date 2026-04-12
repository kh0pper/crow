/**
 * Uptime Kuma API routes for the Crow's Nest panel.
 *
 * Proxies a ping and the Prometheus /metrics endpoint. Only these two
 * endpoints are used because Uptime Kuma's authoritative API is socket.io,
 * which doesn't fit a simple HTTP proxy.
 */

import { Router } from "express";

const BASE_URL = () => (process.env.UPTIMEKUMA_URL || "http://localhost:3007").replace(/\/+$/, "");
const USERNAME = () => process.env.UPTIMEKUMA_USERNAME || "";
const PASSWORD = () => process.env.UPTIMEKUMA_PASSWORD || "";

async function httpGet(path, { auth = false } = {}) {
  const url = BASE_URL() + path;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const headers = {};
    if (auth) {
      const u = USERNAME();
      const p = PASSWORD();
      if (!u || !p) {
        const e = new Error("UPTIMEKUMA_USERNAME and UPTIMEKUMA_PASSWORD must be set in settings");
        e.missingAuth = true;
        throw e;
      }
      headers["Authorization"] = "Basic " + Buffer.from(u + ":" + p).toString("base64");
    }
    const res = await fetch(url, { signal: controller.signal, headers, redirect: "manual" });
    const body = await res.text();
    return { status: res.status, body };
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Uptime Kuma request timed out");
    if (err.message && (err.message.includes("fetch failed") || err.message.includes("ECONNREFUSED"))) {
      throw new Error("Cannot reach Uptime Kuma — is it running?");
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function parsePrometheus(text) {
  const samples = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([A-Za-z_:][A-Za-z0-9_:]*)(?:\{([^}]*)\})?\s+(.+?)(?:\s+\d+)?$/);
    if (!m) continue;
    const [, name, labelStr, valueStr] = m;
    const labels = {};
    if (labelStr) {
      const labelRe = /([A-Za-z_][A-Za-z0-9_]*)="((?:[^"\\]|\\.)*)"/g;
      let lm;
      while ((lm = labelRe.exec(labelStr)) !== null) {
        labels[lm[1]] = lm[2].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      }
    }
    const value = Number(valueStr);
    if (!Number.isNaN(value)) samples.push({ name, labels, value });
  }
  return samples;
}

export default function uptimeKumaRouter(authMiddleware) {
  const router = Router();

  router.get("/api/uptime-kuma/status", authMiddleware, async (req, res) => {
    try {
      const r = await httpGet("/");
      const ok = r.status >= 200 && r.status < 400;
      res.json({ reachable: ok, http_status: r.status, base_url: BASE_URL() });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  router.get("/api/uptime-kuma/monitors", authMiddleware, async (req, res) => {
    try {
      const r = await httpGet("/metrics", { auth: true });
      if (r.status === 401) {
        return res.json({ error: "Authentication failed — check UPTIMEKUMA_USERNAME and UPTIMEKUMA_PASSWORD" });
      }
      if (r.status !== 200) {
        return res.json({ error: "/metrics returned HTTP " + r.status });
      }
      const samples = parsePrometheus(r.body);
      const statusSamples = samples.filter((s) => s.name === "monitor_status");
      const respSamples = samples.filter((s) => s.name === "monitor_response_time");
      const STATUS_LABEL = { 0: "down", 1: "up", 2: "pending", 3: "maintenance" };
      const monitors = statusSamples.map((s) => {
        const resp = respSamples.find((rr) => rr.labels.monitor_name === s.labels.monitor_name && rr.labels.monitor_type === s.labels.monitor_type);
        return {
          name: s.labels.monitor_name || "(unknown)",
          type: s.labels.monitor_type || null,
          url: s.labels.monitor_url || null,
          hostname: s.labels.monitor_hostname || null,
          status: STATUS_LABEL[s.value] || String(s.value),
          response_time_ms: resp ? Math.round(resp.value) : null,
        };
      });
      res.json({ monitors });
    } catch (err) {
      if (err.missingAuth) {
        return res.json({ error: "Set UPTIMEKUMA_USERNAME and UPTIMEKUMA_PASSWORD in settings to see monitor details." });
      }
      res.json({ error: err.message });
    }
  });

  return router;
}
