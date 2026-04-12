/**
 * Netdata MCP Server
 *
 * Wraps the Netdata agent's HTTP API (/api/v1/*) with a small tool surface
 * focused on the common operator questions: Is the agent alive? What charts
 * are available? What's the current value of <chart>? Any raised alarms?
 *
 * Netdata exposes a huge API (v1 and v2 variants); this bundle intentionally
 * ships a minimal curated set. For deep drill-down the operator opens the
 * web UI at http://localhost:19999.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const NETDATA_URL = () =>
  (process.env.NETDATA_URL || "http://localhost:19999").replace(/\/+$/, "");
const REQUEST_TIMEOUT_MS = 10_000;

async function ndFetch(path) {
  const url = `${NETDATA_URL()}${path}`;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`Netdata ${res.status} ${res.statusText}`);
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  } catch (err) {
    if (err.name === "AbortError") throw new Error(`Request timed out: ${path}`);
    if (err.cause?.code === "ECONNREFUSED" || err.message?.includes("ECONNREFUSED")) {
      throw new Error(`Cannot reach Netdata at ${NETDATA_URL()} — is the container running?`);
    }
    throw err;
  } finally {
    clearTimeout(t);
  }
}

export function createNetdataServer(options = {}) {
  const server = new McpServer(
    { name: "crow-netdata", version: "1.0.0" },
    { instructions: options.instructions },
  );

  // --- netdata_status ---
  server.tool(
    "netdata_status",
    "Netdata agent status: version, hostname, uptime, chart count, raised-alarm count",
    {},
    async () => {
      try {
        const [info, alarms, charts] = await Promise.all([
          ndFetch("/api/v1/info"),
          ndFetch("/api/v1/alarms?all=false").catch(() => ({ alarms: {} })),
          ndFetch("/api/v1/charts").catch(() => ({ charts: {} })),
        ]);
        const raisedCount = Object.keys(alarms.alarms || {}).length;
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              url: NETDATA_URL(),
              version: info.version,
              hostname: info.mirrored_hosts?.[0] || info.hostname,
              container_os: info.container_os_name,
              kernel: info.kernel_name,
              cores: info.cores_total,
              ram_total_bytes: info.ram_total,
              charts_available: Object.keys(charts.charts || {}).length,
              alarms_normal: info.alarms?.normal ?? 0,
              alarms_warning: info.alarms?.warning ?? 0,
              alarms_critical: info.alarms?.critical ?? 0,
              raised_alarms: raisedCount,
            }, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- netdata_charts ---
  server.tool(
    "netdata_charts",
    "List active Netdata charts. Use the returned chart IDs with netdata_query to fetch data points. Optionally filter by substring (e.g., 'cpu', 'docker', 'mem').",
    {
      filter: z.string().max(200).optional().describe("Substring to filter chart IDs (case-insensitive)"),
      limit: z.number().int().min(1).max(200).optional().default(50).describe("Max charts to return"),
    },
    async ({ filter, limit }) => {
      try {
        const data = await ndFetch("/api/v1/charts");
        const needle = (filter || "").toLowerCase();
        const entries = Object.entries(data.charts || {})
          .filter(([id]) => !needle || id.toLowerCase().includes(needle))
          .slice(0, limit)
          .map(([id, chart]) => ({
            id,
            name: chart.name,
            title: chart.title,
            units: chart.units,
            family: chart.family,
            context: chart.context,
            dimensions: Object.keys(chart.dimensions || {}),
          }));
        return {
          content: [{
            type: "text",
            text: entries.length
              ? `${entries.length} chart(s)${filter ? ` matching "${filter}"` : ""}:\n${JSON.stringify(entries, null, 2)}`
              : "No charts matched.",
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- netdata_query ---
  server.tool(
    "netdata_query",
    "Query a single chart's data. Returns the latest value plus a short series (default: last 5 minutes, 10 points). Use netdata_charts to find chart IDs.",
    {
      chart: z.string().min(1).max(200).describe('Chart ID (e.g., "system.cpu", "cgroup_crow-netdata.cpu")'),
      after_seconds: z.number().int().min(1).max(86400).optional().default(300).describe("Look back this many seconds from now (default 300 = 5 min)"),
      points: z.number().int().min(1).max(500).optional().default(10).describe("Number of data points to return (default 10)"),
    },
    async ({ chart, after_seconds, points }) => {
      try {
        const params = new URLSearchParams({
          chart,
          after: String(-after_seconds),
          points: String(points),
          format: "json",
          group: "average",
          options: "jsonwrap,nonzero",
        });
        const data = await ndFetch(`/api/v1/data?${params}`);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              chart,
              labels: data.result?.labels || data.labels,
              latest: data.latest_values,
              view_latest_values: data.view_latest_values,
              min: data.min,
              max: data.max,
              units: data.units,
              points_returned: data.result?.data?.length ?? data.data?.length ?? 0,
              sample: (data.result?.data || data.data || []).slice(0, 5),
            }, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- netdata_alarms ---
  server.tool(
    "netdata_alarms",
    "List Netdata alarms. By default returns only raised (warning/critical) alarms.",
    {
      include_all: z.boolean().optional().default(false).describe("Include normal/clear alarms too (large response)"),
    },
    async ({ include_all }) => {
      try {
        const data = await ndFetch(`/api/v1/alarms?all=${include_all ? "true" : "false"}`);
        const alarms = Object.entries(data.alarms || {}).map(([id, a]) => ({
          id,
          name: a.name,
          chart: a.chart,
          status: a.status,
          value: a.value,
          units: a.units,
          last_status_change: a.last_status_change ? new Date(a.last_status_change * 1000).toISOString() : null,
          info: a.info,
        }));
        return {
          content: [{
            type: "text",
            text: alarms.length
              ? `${alarms.length} alarm(s):\n${JSON.stringify(alarms, null, 2)}`
              : "No alarms raised.",
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  return server;
}
