/**
 * AdGuard Home MCP Server
 *
 * Wraps the /control/* HTTP API (well documented at
 * https://github.com/AdguardTeam/AdGuardHome/wiki/API). Tools intentionally
 * avoid anything destructive by default — toggle_protection requires a
 * confirm literal.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const ADGUARD_URL = () =>
  (process.env.ADGUARD_URL || "http://localhost:3020").replace(/\/+$/, "");
const ADGUARD_USERNAME = () => process.env.ADGUARD_USERNAME || "";
const ADGUARD_PASSWORD = () => process.env.ADGUARD_PASSWORD || "";
const REQUEST_TIMEOUT_MS = 10_000;

function authHeader() {
  const u = ADGUARD_USERNAME();
  const p = ADGUARD_PASSWORD();
  if (!u || !p) return null;
  return "Basic " + Buffer.from(`${u}:${p}`).toString("base64");
}

async function agFetch(path, options = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
  const auth = authHeader();
  try {
    const res = await fetch(`${ADGUARD_URL()}${path}`, {
      ...options,
      signal: ctl.signal,
      headers: {
        "Content-Type": "application/json",
        ...(auth ? { Authorization: auth } : {}),
        ...options.headers,
      },
    });
    const text = await res.text();
    if (res.status === 401 || res.status === 403) {
      throw new Error("Authentication failed — check ADGUARD_USERNAME and ADGUARD_PASSWORD");
    }
    if (!res.ok) throw new Error(`AdGuard API ${res.status}: ${text.slice(0, 300)}`);
    if (!text) return {};
    try { return JSON.parse(text); } catch { return { raw: text }; }
  } catch (err) {
    if (err.name === "AbortError") throw new Error(`Request timed out: ${path}`);
    if (err.cause?.code === "ECONNREFUSED" || err.message?.includes("ECONNREFUSED")) {
      throw new Error(`Cannot reach AdGuard at ${ADGUARD_URL()} — is the container running?`);
    }
    throw err;
  } finally {
    clearTimeout(t);
  }
}

export function createAdguardServer(options = {}) {
  const server = new McpServer(
    { name: "crow-adguard-home", version: "1.0.0" },
    { instructions: options.instructions },
  );

  // --- adguard_status ---
  server.tool(
    "adguard_status",
    "AdGuard Home status: version, protection state, upstream DNS servers, filter count, stats summary",
    {},
    async () => {
      try {
        const [status, stats, filters] = await Promise.all([
          agFetch("/control/status"),
          agFetch("/control/stats").catch(() => ({})),
          agFetch("/control/filtering/status").catch(() => ({})),
        ]);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              url: ADGUARD_URL(),
              version: status.version,
              protection_enabled: status.protection_enabled,
              dns_port: status.dns_port,
              running: status.running,
              upstream_dns: status.dns_addresses,
              num_dns_queries_today: stats.num_dns_queries ?? null,
              num_blocked_filtering_today: stats.num_blocked_filtering ?? null,
              avg_processing_time_ms: stats.avg_processing_time != null ? Math.round(stats.avg_processing_time * 1000) : null,
              filter_lists_enabled: (filters.filters || []).filter((f) => f.enabled).length,
              filter_lists_total: (filters.filters || []).length,
              filter_rules_total: filters.filters?.reduce((sum, f) => sum + (f.rules_count || 0), 0) ?? null,
            }, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- adguard_stats ---
  server.tool(
    "adguard_stats",
    "Query stats: queries, blocked counts, top clients, top domains, top blocked domains (defaults to last 24h window)",
    {},
    async () => {
      try {
        const stats = await agFetch("/control/stats");
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              time_units: stats.time_units,
              num_dns_queries: stats.num_dns_queries,
              num_blocked_filtering: stats.num_blocked_filtering,
              num_replaced_safebrowsing: stats.num_replaced_safebrowsing,
              num_replaced_safesearch: stats.num_replaced_safesearch,
              num_replaced_parental: stats.num_replaced_parental,
              avg_processing_time_sec: stats.avg_processing_time,
              top_queried_domains: (stats.top_queried_domains || []).slice(0, 10),
              top_blocked_domains: (stats.top_blocked_domains || []).slice(0, 10),
              top_clients: (stats.top_clients || []).slice(0, 10),
            }, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- adguard_query_log ---
  server.tool(
    "adguard_query_log",
    "Recent DNS queries. Returns the last N entries with timestamp, client, question, response, and whether it was blocked.",
    {
      limit: z.number().int().min(1).max(500).optional().default(50).describe("Number of recent queries to return (default 50)"),
      search: z.string().max(200).optional().describe("Substring search over domain names"),
    },
    async ({ limit, search }) => {
      try {
        const params = new URLSearchParams({ limit: String(limit) });
        if (search) params.set("search", search);
        const data = await agFetch(`/control/querylog?${params}`);
        const rows = (data.data || []).map((q) => ({
          time: q.time,
          client: q.client,
          question: q.question?.name,
          type: q.question?.type,
          answer: (q.answer || []).slice(0, 3).map((a) => a.value),
          blocked: q.reason && q.reason.startsWith("Filtered") ? q.reason : null,
          elapsed_ms: q.elapsedMs,
        }));
        return {
          content: [{
            type: "text",
            text: rows.length
              ? `${rows.length} recent queries:\n${JSON.stringify(rows, null, 2)}`
              : "No queries in log.",
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  // --- adguard_toggle_protection ---
  server.tool(
    "adguard_toggle_protection",
    "Enable or disable AdGuard Home protection. Disabling stops ALL DNS filtering until re-enabled — clients will resolve via upstream with no blocking.",
    {
      enabled: z.boolean().describe("true to enable protection, false to disable"),
      confirm: z.literal("yes").describe('Must be "yes" to confirm the state change'),
    },
    async ({ enabled }) => {
      try {
        await agFetch("/control/dns_config", {
          method: "POST",
          body: JSON.stringify({ protection_enabled: enabled }),
        });
        return {
          content: [{
            type: "text",
            text: `Protection ${enabled ? "enabled" : "disabled"}. ${enabled ? "" : "ALL DNS queries now resolve through upstream with no filtering."}`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    }
  );

  return server;
}
