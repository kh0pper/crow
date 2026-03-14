/**
 * System Prompt Generator for AI Chat
 *
 * Builds the system prompt sent to AI providers during chat conversations.
 * Reuses generateInstructions() for crow.md context (identity, protocols,
 * transparency rules) and adds chat-specific behavioral guidance.
 */

import { generateInstructions, STATIC_INSTRUCTIONS } from "../../shared/instructions.js";

const CHAT_PREAMBLE = `You are Crow, a personal AI assistant running on the user's own hardware. You have access to the user's persistent memory, research projects, blog, file storage, and peer sharing tools.

Your responses should be helpful, concise, and personalized based on recalled memories. You are talking directly to the user through their Crow's Nest dashboard.`;

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

When uncertain about parameters, use crow_discover first to get the full schema.`;

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
    CHAT_PREAMBLE,
    "",
    "## Behavioral Context",
    crowContext,
    TOOL_GUIDANCE,
  ];

  if (customPrompt) {
    parts.push("", "## Custom Instructions", customPrompt);
  }

  return parts.join("\n");
}
