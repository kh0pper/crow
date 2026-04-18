/**
 * System Prompt Generator for AI Chat
 *
 * Builds the system prompt sent to AI providers during chat conversations.
 * Reuses generateInstructions() for crow.md context (identity, protocols,
 * transparency rules) and adds chat-specific behavioral guidance.
 */

import { generateInstructions, STATIC_INSTRUCTIONS } from "../../shared/instructions.js";
import { connectedServers } from "../proxy.js";

function buildPreamble() {
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const timeStr = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZoneName: "short" });

  return `You are Crow, a personal AI assistant running on the user's own hardware. You have access to the user's persistent memory, research projects, blog, file storage, peer sharing tools, and any installed extensions.

Current date and time: ${dateStr}, ${timeStr}

Your responses should be helpful, concise, and personalized based on recalled memories. You are talking directly to the user through their Crow's Nest dashboard.`;
}

const TOOL_GUIDANCE = `
## Tool Usage

You have access to Crow's tools organized by category. Each category tool takes an "action" and "params":

- **crow_memory** — Store, search, recall, and manage persistent memories
  - Start conversations by recalling context: action "recall_by_context", params: { context: "<user's message>" }
  - Store important information: action "store_memory", params: { content, category, importance, tags }

- **crow_projects** — Manage research projects, sources, notes, and bibliographies
  - Create projects: action "create_project", params: { name, description }
  - Add cited sources: action "add_source", params: { title, source_type, url, ... }

- **crow_blog** — Create, edit, and publish blog posts
  - Create drafts: action "create_post", params: { title, content }
  - Publish: action "publish_post", params: { id }

- **crow_sharing** — P2P encrypted sharing and messaging
  - Send messages: action "send_message", params: { contact, message }
  - Check inbox: action "inbox"

- **crow_storage** — Upload and manage files (requires MinIO)
  - Upload: action "upload_file", params: { file_name, data_base64 }
  - List: action "list_files"

- **crow_discover** — Get full parameter schemas for any action
  - List all categories: no params needed
  - List category actions: { category: "memory" }
  - Full schema: { category: "memory", action: "store_memory" }

When uncertain about parameters, use crow_discover first to get the full schema.

- **crow_tools** — Call tools from installed extensions. Use: action = tool name, params = tool parameters.`;

/**
 * Build dynamic addon tool guidance based on connected MCP servers.
 * Includes parameter hints for common tools so the AI doesn't need extra discovery round-trips.
 */
function buildAddonGuidance() {
  if (!connectedServers || connectedServers.size === 0) return "";

  const sections = [];
  for (const [id, entry] of connectedServers) {
    if (entry.status !== "connected" || !entry.tools?.length) continue;

    const toolLines = entry.tools.map((t) => {
      // Build compact parameter hint from schema
      let paramHint = "";
      const schema = t.inputSchema;
      if (schema?.properties) {
        const required = new Set(schema.required || []);
        const params = Object.entries(schema.properties).map(([name, prop]) => {
          const req = required.has(name) ? "" : "?";
          const type = prop.type || "any";
          return `${name}${req}: ${type}`;
        });
        paramHint = params.length ? `{ ${params.join(", ")} }` : "{}";
      }
      return `  - ${t.name}(${paramHint}): ${(t.description || "").substring(0, 120)}`;
    }).join("\n");

    sections.push(`### ${id} (${entry.tools.length} tools)\n${toolLines}`);
  }

  if (sections.length === 0) return "";

  return `
## Installed Extension Tools (via crow_tools)

Call these with crow_tools: { action: "<tool_name>", params: { ... } }

${sections.join("\n\n")}

**Efficiency tip:** The parameter hints above show required and optional params. Call tools directly without discovering schemas first when the params are clear.`;
}

/**
 * Generate the full system prompt for a chat conversation.
 *
 * @param {object} [options]
 * @param {string} [options.customPrompt] - User's custom system prompt (appended)
 * @param {string} [options.deviceId] - Device ID for per-device context
 * @returns {Promise<string>}
 */
export async function generateSystemPrompt(options = {}) {
  const { customPrompt, deviceId } = options;

  // Get condensed crow.md context (identity, protocols, transparency)
  let crowContext;
  try {
    crowContext = await generateInstructions({ routerStyle: true, deviceId });
  } catch {
    crowContext = STATIC_INSTRUCTIONS;
  }

  const parts = [
    buildPreamble(),
    "",
    "## Behavioral Context",
    crowContext,
    TOOL_GUIDANCE,
    buildAddonGuidance(),
  ];

  // When a voice turn originates from a paired meta-glasses device, stamp
  // the device_id into the prompt so the LLM doesn't stop to ask the user
  // for it before calling crow_glasses_* tools. The LLM should pass this
  // value verbatim to any tool that takes a `device_id` parameter.
  if (deviceId) {
    parts.push(
      "",
      "## Active Device",
      `The current voice turn originated from glasses device_id \`${deviceId}\`. ` +
      `Pass this value to any crow_glasses_* tool call that accepts a device_id parameter; ` +
      `do NOT ask the user to confirm or re-enter it.`,
    );
  }

  if (customPrompt) {
    parts.push("", "## Custom Instructions", customPrompt);
  }

  return parts.join("\n");
}
