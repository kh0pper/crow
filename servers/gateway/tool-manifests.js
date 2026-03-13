/**
 * Static tool manifests for the gateway router.
 *
 * Maps each server to its tool names + parameter summaries.
 * Used by the router to build compressed descriptions without
 * instantiating any servers at startup.
 *
 * Updated manually when tools change (same cadence as CLAUDE.md).
 */

export const TOOL_MANIFESTS = {
  memory: {
    displayName: "Memory",
    description: "Persistent memory: store, search, recall, list, update, delete memories and manage cross-platform context (crow.md)",
    tools: {
      crow_store_memory: { params: "content, category?, context?, tags?, source?, importance?", desc: "Store a memory" },
      crow_search_memories: { params: "query, category?, min_importance?, limit?", desc: "Search memories (FTS5)" },
      crow_recall_by_context: { params: "context, limit?", desc: "Retrieve memories by context" },
      crow_list_memories: { params: "category?, tag?, min_importance?, sort_by?, limit?", desc: "List memories with filters" },
      crow_update_memory: { params: "id, content?, category?, tags?, importance?, context?", desc: "Update a memory" },
      crow_delete_memory: { params: "id", desc: "Delete a memory" },
      crow_memory_stats: { params: "", desc: "Memory statistics" },
      crow_get_context: { params: "include_dynamic?, platform?, device_id?", desc: "Generate crow.md context (device_id for per-device overrides)" },
      crow_update_context_section: { params: "section_key, content?, section_title?, enabled?, sort_order?, device_id?", desc: "Update crow.md section (device_id for per-device override)" },
      crow_add_context_section: { params: "section_key, section_title, content, sort_order?, device_id?", desc: "Add crow.md section (device_id for per-device override)" },
      crow_list_context_sections: { params: "device_id?", desc: "List crow.md sections (device_id to filter)" },
      crow_delete_context_section: { params: "section_key, device_id?", desc: "Delete crow.md section (device_id for per-device override)" },
    },
  },

  projects: {
    displayName: "Projects",
    description: "Project management: create projects, track sources with auto-APA citation, notes, bibliography, data backend connections, and search",
    tools: {
      crow_create_project: { params: "name, description?, type?, tags?", desc: "Create project" },
      crow_list_projects: { params: "status?, type?, limit?, offset?", desc: "List projects" },
      crow_update_project: { params: "id, name?, description?, status?, type?, tags?", desc: "Update project" },
      crow_add_source: { params: "title, source_type, project_id?, backend_id?, url?, authors?, publication_date?, publisher?, doi?, isbn?, abstract?, content_summary?, full_text?, citation_apa?, retrieval_method?, tags?, relevance_score?", desc: "Add source with auto-APA" },
      crow_search_sources: { params: "query, project_id?, source_type?, verified_only?, limit?", desc: "Search sources (FTS5)" },
      crow_get_source: { params: "id", desc: "Get source details" },
      crow_verify_source: { params: "id, verified, notes?", desc: "Mark source verified/unverified" },
      crow_list_sources: { params: "project_id?, backend_id?, source_type?, verified_only?, sort_by?, limit?", desc: "List sources" },
      crow_add_note: { params: "content, note_type?, project_id?, source_id?, title?, tags?", desc: "Add note" },
      crow_search_notes: { params: "query, project_id?, note_type?, limit?", desc: "Search notes" },
      crow_generate_bibliography: { params: "project_id?, tag?, verified_only?", desc: "Generate APA bibliography" },
      crow_project_stats: { params: "", desc: "Project statistics" },
      crow_register_backend: { params: "name, backend_type?, project_id?, connection_ref, tags?", desc: "Register external MCP server as data backend" },
      crow_list_backends: { params: "project_id?, status?", desc: "List data backends" },
      crow_remove_backend: { params: "id", desc: "Remove data backend" },
      crow_backend_schema: { params: "id", desc: "Show backend tools/schema" },
    },
  },

  blog: {
    displayName: "Blog",
    description: "Blogging platform: create, edit, publish, list, search, delete posts, themes, RSS export, peer sharing",
    tools: {
      crow_create_post: { params: "title, content, slug?, excerpt?, author?, tags?, cover_image_key?, visibility?", desc: "Create blog post draft" },
      crow_edit_post: { params: "id, title?, content?, slug?, excerpt?, author?, tags?, cover_image_key?, visibility?", desc: "Update post" },
      crow_publish_post: { params: "id", desc: "Publish post" },
      crow_unpublish_post: { params: "id", desc: "Revert to draft" },
      crow_list_posts: { params: "status?, tag?, search?, limit?", desc: "List posts with filters" },
      crow_get_post: { params: "id?, slug?", desc: "Get post by ID or slug" },
      crow_delete_post: { params: "id", desc: "Delete post" },
      crow_share_post: { params: "id, contact", desc: "Share post with peer" },
      crow_export_blog: { params: "format?", desc: "Export as Hugo/Jekyll" },
      crow_blog_settings: { params: "action, title?, tagline?, author?, theme?", desc: "Get/set blog settings" },
      crow_blog_customize_theme: { params: "css", desc: "Apply custom CSS" },
      crow_blog_stats: { params: "", desc: "Blog statistics" },
    },
  },

  sharing: {
    displayName: "Sharing",
    description: "P2P sharing: invite codes, contacts, encrypted sharing, inbox, Nostr messaging, access revocation",
    tools: {
      crow_generate_invite: { params: "display_name?", desc: "Generate invite code" },
      crow_accept_invite: { params: "invite_code, display_name?", desc: "Accept invite code" },
      crow_list_contacts: { params: "include_blocked?", desc: "List contacts" },
      crow_share: { params: "contact, share_type, item_id, permissions?", desc: "Share item with contact" },
      crow_inbox: { params: "unread_only?, limit?", desc: "Check inbox" },
      crow_send_message: { params: "contact, message", desc: "Send encrypted message" },
      crow_revoke_access: { params: "contact, share_type, item_id", desc: "Revoke shared access" },
      crow_sharing_status: { params: "", desc: "Sharing status" },
    },
  },

  storage: {
    displayName: "Storage",
    description: "S3-compatible file storage: upload (base64 or presigned URL), list, download URLs, delete, quota management",
    tools: {
      crow_upload_file: { params: "file_name, mime_type?, data_base64?, bucket?, reference_type?, reference_id?", desc: "Upload file" },
      crow_list_files: { params: "bucket?, mime_type?, reference_type?, reference_id?, limit?", desc: "List files" },
      crow_get_file_url: { params: "s3_key, expiry?, bucket?", desc: "Get download URL" },
      crow_delete_file: { params: "s3_key, bucket?", desc: "Delete file" },
      crow_storage_stats: { params: "", desc: "Storage statistics" },
    },
  },
};

/**
 * Get all tool names for a given server category.
 * Used by crow-core to build SERVER_TOOL_MAP.
 */
export function getToolNames(category) {
  const manifest = TOOL_MANIFESTS[category];
  if (!manifest) return [];
  return Object.keys(manifest.tools);
}

/**
 * Build a compressed description string for a category tool.
 * Lists all actions with their required/optional params.
 */
export function buildCompressedDescription(category) {
  const manifest = TOOL_MANIFESTS[category];
  if (!manifest) return "";

  const lines = [`${manifest.description}. Actions:`];
  for (const [name, info] of Object.entries(manifest.tools)) {
    const actionName = name.replace(/^crow_/, "");
    lines.push(`- ${actionName}(${info.params}): ${info.desc}`);
  }
  return lines.join("\n");
}
