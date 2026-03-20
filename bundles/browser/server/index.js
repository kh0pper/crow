/**
 * Crow Browser MCP Server — stdio entry point.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createBrowserServer } from "./server.js";

const server = createBrowserServer({
  instructions:
    "Crow Browser — automated browser control with stealth, VNC viewing, " +
    "and CDP. Use crow_browser_* tools to navigate, fill forms, click, " +
    "take screenshots, and manage sessions. For CAPTCHA or 2FA, use " +
    "crow_browser_wait_for_user to pause for human intervention via VNC.",
});

const transport = new StdioServerTransport();
await server.connect(transport);
