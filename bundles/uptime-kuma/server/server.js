/**
 * Uptime Kuma MCP Server
 *
 * Uptime Kuma's primary API is socket.io-based, which doesn't fit cleanly
 * in an MCP tool contract. This server ships two tools that work against
 * endpoints Uptime Kuma exposes over plain HTTP:
 *
 *   - uptimekuma_status: pings the web UI to confirm the server is reachable
 *     (works without any credentials).
 *   - uptimekuma_metrics: fetches the Prometheus /metrics endpoint using
 *     basic auth with the admin credentials configured in .env. Returns a
 *     parsed summary of monitor counts and up/down status.
 *
 * Monitor creation, pause/resume, and detail lookups require the socket.io
 * API — use the web UI for those actions, or wire up the third-party
 * `uptime-kuma-api` Python package in a future enhancement.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const BASE_URL = () => (process.env.UPTIMEKUMA_URL || "http://localhost:3007").replace(/\/+$/, "");
const USERNAME = () => process.env.UPTIMEKUMA_USERNAME || "";
const PASSWORD = () => process.env.UPTIMEKUMA_PASSWORD || "";

async function httpGet(path, { auth = false } = {}) {
  const url = `${BASE_URL()}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const headers = {};
    if (auth) {
      const u = USERNAME();
      const p = PASSWORD();
      if (!u || !p) {
        throw new Error("UPTIMEKUMA_USERNAME and UPTIMEKUMA_PASSWORD must be set to call this endpoint");
      }
      headers["Authorization"] = "Basic " + Buffer.from(u + ":" + p).toString("base64");
    }
    const res = await fetch(url, { signal: controller.signal, headers, redirect: "manual" });
    const body = await res.text();
    return { status: res.status, body };
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Uptime Kuma request timed out after 10s: " + path);
    if (err.message.includes("fetch failed") || err.message.includes("ECONNREFUSED")) {
      throw new Error("Cannot reach Uptime Kuma at " + BASE_URL() + " — is the container running?");
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Parse Prometheus text format into a flat array of { name, labels, value }.
 */
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

export function createUptimeKumaServer(options = {}) {
  const server = new McpServer(
    { name: "crow-uptime-kuma", version: "1.0.0" },
    { instructions: options.instructions },
  );

  server.tool(
    "uptimekuma_status",
    "Check whether Uptime Kuma is reachable on the configured URL. Returns the HTTP status of the entry page and the base URL. No credentials required.",
    {},
    async () => {
      try {
        const res = await httpGet("/");
        const ok = res.status >= 200 && res.status < 400;
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              reachable: ok,
              http_status: res.status,
              base_url: BASE_URL(),
              note: ok
                ? "Uptime Kuma is responding. Use the web UI for monitor configuration."
                : "Uptime Kuma responded with an unexpected status.",
            }, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: "Error: " + err.message }] };
      }
    }
  );

  server.tool(
    "uptimekuma_metrics",
    "Fetch Uptime Kuma's Prometheus /metrics endpoint with basic auth and summarize monitor up/down counts, per-monitor status, and average response times. Requires UPTIMEKUMA_USERNAME and UPTIMEKUMA_PASSWORD (admin login).",
    {
      detail: z.enum(["summary", "monitors"]).optional().default("summary")
        .describe("'summary' returns counts only; 'monitors' returns per-monitor rows"),
    },
    async ({ detail }) => {
      try {
        const res = await httpGet("/metrics", { auth: true });
        if (res.status === 401) {
          return { content: [{ type: "text", text: "Error: Uptime Kuma rejected the basic-auth credentials. Check UPTIMEKUMA_USERNAME and UPTIMEKUMA_PASSWORD." }] };
        }
        if (res.status !== 200) {
          return { content: [{ type: "text", text: "Error: /metrics returned HTTP " + res.status }] };
        }
        const samples = parsePrometheus(res.body);

        const statusSamples = samples.filter((s) => s.name === "monitor_status");
        const respSamples = samples.filter((s) => s.name === "monitor_response_time");

        const STATUS_LABEL = { 0: "down", 1: "up", 2: "pending", 3: "maintenance" };
        const monitors = statusSamples.map((s) => {
          const resp = respSamples.find((r) => r.labels.monitor_name === s.labels.monitor_name && r.labels.monitor_type === s.labels.monitor_type);
          return {
            name: s.labels.monitor_name || "(unknown)",
            type: s.labels.monitor_type || null,
            url: s.labels.monitor_url || null,
            hostname: s.labels.monitor_hostname || null,
            status: STATUS_LABEL[s.value] || String(s.value),
            response_time_ms: resp ? Math.round(resp.value) : null,
          };
        });

        const counts = monitors.reduce((acc, m) => {
          acc[m.status] = (acc[m.status] || 0) + 1;
          return acc;
        }, {});

        const payload = {
          total_monitors: monitors.length,
          counts,
        };
        if (detail === "monitors") payload.monitors = monitors;

        return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: "Error: " + err.message }] };
      }
    }
  );

  return server;
}
