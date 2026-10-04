/** Kiosk MCP tools (spec §4.1): reach live sessions through loopback /api/kiosk/internal with the announce token. */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// Port order matches servers/gateway/index.js (PORT first): a host can set both to
// different values (grackle: bridge CROW_GATEWAY_PORT=3004, gateway PORT=3002).
export function createKioskServer({
  fetchImpl = fetch,
  baseUrl = `http://127.0.0.1:${process.env.PORT || process.env.CROW_GATEWAY_PORT || 3001}`,
  tokenPath = join(process.env.CROW_HOME || join(homedir(), ".crow"), "kiosk-announce-token"),
} = {}) {
  const server = new McpServer({ name: "crow-kiosk", version: "0.1.0" });
  async function call(method, path, body) {
    let token;
    try { token = readFileSync(tokenPath, "utf8").trim(); } catch { return { error: "kiosk announce token missing — restart the Crow gateway" }; }
    try {
      const r = await fetchImpl(baseUrl + path, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10_000) });
      const j = await r.json().catch(() => ({}));
      return r.ok ? j : { error: j.error || `HTTP ${r.status}` };
    } catch (err) { return { error: err.message }; }
  }
  const out = (o) => ({ content: [{ type: "text", text: JSON.stringify(o) }], ...(o?.error ? { isError: true } : {}) });
  server.tool("crow_kiosk_list_displays", "List the paired kiosk displays and whether each is connected.", {}, async () => out(await call("GET", "/api/kiosk/internal/displays")));
  server.tool("crow_kiosk_announce", "Show a short message on kiosk displays and speak it (speak:false to only show it). display = a display name or id; omit for every display.",
    { display: z.string().max(64).optional(), text: z.string().min(1).max(500), speak: z.boolean().optional() },
    async (a) => out(await call("POST", "/api/kiosk/internal/announce", a)));
  server.tool("crow_kiosk_show", "Open a content window on kiosk displays. In body, || starts a new paragraph and lines starting '- ' become a list.",
    { display: z.string().max(64).optional(), title: z.string().min(1).max(80), body: z.string().min(1).max(4000) },
    async (a) => out(await call("POST", "/api/kiosk/internal/show", a)));
  return server;
}
