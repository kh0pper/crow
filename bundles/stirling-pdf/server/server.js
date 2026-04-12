/**
 * Stirling PDF MCP Server
 *
 * Stirling PDF has no documented REST API — all of its document operations
 * run client-side in the browser. This server exposes a minimal surface so
 * an AI agent can check whether the Stirling container is up and point a
 * user at the web UI for the actual work.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const BASE_URL = () => (process.env.STIRLING_URL || "http://localhost:8092").replace(/\/+$/, "");

export function createStirlingServer(options = {}) {
  const server = new McpServer(
    { name: "crow-stirling-pdf", version: "1.0.0" },
    { instructions: options.instructions },
  );

  server.tool(
    "stirling_status",
    "Check whether the Stirling PDF container is reachable. Returns the HTTP status of the home page and the configured URL.",
    {},
    async () => {
      const url = BASE_URL();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      try {
        // /login is publicly reachable; / returns 401 when auth is enabled.
        const res = await fetch(url + "/login", { signal: controller.signal, redirect: "manual" });
        const ok = res.status >= 200 && res.status < 400;
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              reachable: ok,
              http_status: res.status,
              base_url: url,
            }, null, 2),
          }],
        };
      } catch (err) {
        const msg = err.name === "AbortError"
          ? "Stirling PDF request timed out after 10s"
          : (err.message || String(err));
        return { content: [{ type: "text", text: "Error: " + msg }] };
      } finally {
        clearTimeout(timeout);
      }
    }
  );

  server.tool(
    "stirling_web_url",
    "Return the Stirling PDF web UI URL for the user to open in a browser. Stirling's operations (merge, split, OCR, convert, etc.) run in-browser; the AI cannot invoke them directly.",
    {},
    async () => {
      const url = BASE_URL();
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            url,
            note: "Open this URL in your browser to use Stirling PDF. Operations run client-side; there is no automation API to call from here.",
          }, null, 2),
        }],
      };
    }
  );

  return server;
}
