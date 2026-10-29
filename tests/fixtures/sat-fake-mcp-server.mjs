// A tiny stdio MCP server for the satellite MCP host tests (SAT-6). Behaviour comes from env:
//   FAKE_MCP_LOG            append "start <pid>" / "term <pid>" lines (start counting, idle stop)
//   FAKE_MCP_VARIANT        "v1" (default) | "v2" | "huge" (one tool, a 300 KB description)
//   FAKE_MCP_IGNORE_TERM=1  ignore SIGTERM (the host must SIGKILL after the grace)
// Tools (prefixed demo_ like a satellite bundle's):
//   demo_echo {x}           text: JSON {meta, args, node_options, pid}
//   demo_big {bytes}        one text item of `bytes` "x" characters
//   demo_mixed              text + image + resource items (the host keeps text only)
//   demo_slow {ms}          waits, then text "slow done"
//   demo_progress           sends a progress + a log notification, then text "progress done"
//   demo_flood {mb}         writes `mb` MB to stdout with no newline (the host must kill it)
import { appendFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const note = (line) => { if (process.env.FAKE_MCP_LOG) appendFileSync(process.env.FAKE_MCP_LOG, `${line} ${process.pid}\n`); };
note("start");
process.on("SIGTERM", () => {
  note("term");
  if (process.env.FAKE_MCP_IGNORE_TERM === "1") return;
  process.exit(0);
});

const obj = (properties = {}) => ({ type: "object", properties });
const TOOLS = {
  v1: [
    { name: "demo_echo", description: "Echo the call", inputSchema: obj({ x: { type: "string" } }) },
    { name: "demo_big", description: "A big answer", inputSchema: obj({ bytes: { type: "number" } }) },
    { name: "demo_mixed", description: "Mixed content", inputSchema: obj() },
    { name: "demo_slow", description: "Slow", inputSchema: obj({ ms: { type: "number" } }) },
    { name: "demo_progress", description: "Notifies", inputSchema: obj() },
    { name: "demo_flood", description: "Floods stdout", inputSchema: obj({ mb: { type: "number" } }) },
  ],
};
TOOLS.huge = [{ name: "demo_huge", description: "d".repeat(300 * 1024), inputSchema: obj() }];
TOOLS.v2 = [...TOOLS.v1, { name: "demo_new", description: "Added in v2", inputSchema: obj() }];
const tools = TOOLS[process.env.FAKE_MCP_VARIANT || "v1"] || TOOLS.v1;

const server = new Server({ name: "fake-sat-mcp", version: "1.0.0" }, { capabilities: { tools: {}, logging: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
  const { name, arguments: args = {}, _meta: meta = {} } = req.params;
  const text = (t) => ({ content: [{ type: "text", text: t }] });
  switch (name) {
    case "demo_echo":
      return text(JSON.stringify({ meta, args, node_options: process.env.NODE_OPTIONS || null, pid: process.pid }));
    case "demo_big":
      return text("x".repeat(Number(args.bytes) || 0));
    case "demo_mixed":
      return {
        content: [
          { type: "text", text: "kept" },
          { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
          { type: "resource", resource: { uri: "file:///x", text: "r" } },
        ],
      };
    case "demo_slow":
      await new Promise((r) => setTimeout(r, Number(args.ms) || 0));
      return text("slow done");
    case "demo_progress":
      await extra.sendNotification({ method: "notifications/message", params: { level: "info", data: "hello" } });
      if (meta.progressToken !== undefined) {
        await extra.sendNotification({ method: "notifications/progress", params: { progressToken: meta.progressToken, progress: 1, total: 2 } });
      }
      return text("progress done");
    case "demo_flood": {
      const chunk = "z".repeat(64 * 1024);
      for (let i = 0; i < (Number(args.mb) || 1) * 16; i++) {
        if (!process.stdout.write(chunk)) await new Promise((r) => process.stdout.once("drain", r));
      }
      return text("flood done");
    }
    default:
      return { content: [{ type: "text", text: `unknown tool ${name}` }], isError: true };
  }
});
await server.connect(new StdioServerTransport());
