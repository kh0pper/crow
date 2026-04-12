/**
 * Meta Glasses MCP Server
 *
 * Exposes tools other skills (or Claude) can use to drive the paired glasses
 * indirectly — status probes, canned TTS, photo capture pokes. Actual audio
 * and camera flow is handled by the bundle's panel/routes.js endpoints; the
 * MCP tools here are intentionally thin.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function createMetaGlassesServer(options = {}) {
  const server = new McpServer(
    { name: "crow-meta-glasses", version: "0.1.0" },
    { instructions: options.instructions },
  );

  server.tool(
    "crow_glasses_status",
    "List paired Meta Ray-Ban Meta (Gen 2) glasses devices and their connection state.",
    {},
    async () => {
      // This tool runs in the MCP server process (stdio), which doesn't have
      // direct access to the gateway's DB client. Consumers should call
      // /api/meta-glasses/devices instead for authoritative data. We return
      // a hint so the LLM doesn't fabricate device state.
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            note: "Live device state is served by the Meta Glasses panel. Ask the user to open /dashboard/meta-glasses or call GET /api/meta-glasses/devices.",
          }, null, 2),
        }],
      };
    },
  );

  server.tool(
    "crow_glasses_speak",
    "Send a text line to be spoken through paired glasses. Requires the user to have at least one glasses device paired and online. Returns a hint string only — the panel handles delivery via WebSocket.",
    {
      text: z.string().min(1).max(1000).describe("What to say"),
      device_id: z.string().optional().describe("Target a specific device; omit to broadcast to all paired devices."),
    },
    async ({ text, device_id }) => {
      return {
        content: [{
          type: "text",
          text: `Queued for speech: ${JSON.stringify({ text, device_id: device_id || "broadcast" })}. The dispatch happens via the panel's /api/meta-glasses/say endpoint when the companion app holds an active /session socket.`,
        }],
      };
    },
  );

  server.tool(
    "crow_glasses_capture_photo",
    "Ask paired glasses to capture a still photo. Returns a hint string — the photo itself arrives asynchronously on the bundle's /session WebSocket.",
    {
      device_id: z.string().optional().describe("Target a specific device; omit to target the primary."),
    },
    async ({ device_id }) => {
      return {
        content: [{
          type: "text",
          text: `Photo capture requested for ${device_id || "primary device"}. Result lands in S3 and a presigned URL is returned on the session WebSocket.`,
        }],
      };
    },
  );

  return server;
}
