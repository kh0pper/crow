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
    description: "Persistent memory: store, search, recall, list, update, delete memories, manage cross-platform context (crow.md), schedules, and notifications",
    tools: {
      crow_store_memory: { params: "content, category?, context?, tags?, source?, importance?", desc: "Store a memory" },
      crow_search_memories: { params: "query, category?, min_importance?, limit?", desc: "Search memories (FTS5)" },
      crow_get_memory: { params: "id", desc: "Fetch a single memory by ID (returns JSON payload; used by federated dashboard memory view)" },
      crow_recall_by_context: { params: "context, limit?", desc: "Retrieve memories by context" },
      crow_list_memories: { params: "category?, tag?, min_importance?, sort_by?, limit?", desc: "List memories with filters" },
      crow_update_memory: { params: "id, content?, category?, tags?, importance?, context?", desc: "Update a memory" },
      crow_delete_memory: { params: "id, confirm_token", desc: "Permanently delete a memory (cannot be undone). Returns preview + token on first call; pass token back to execute." },
      crow_memory_stats: { params: "", desc: "Memory statistics" },
      crow_get_context: { params: "include_dynamic?, platform?, device_id?", desc: "Generate crow.md context (device_id for per-device overrides)" },
      crow_update_context_section: { params: "section_key, content?, section_title?, enabled?, sort_order?, device_id?", desc: "Update crow.md section (device_id for per-device override)" },
      crow_add_context_section: { params: "section_key, section_title, content, sort_order?, device_id?", desc: "Add crow.md section (device_id for per-device override)" },
      crow_list_context_sections: { params: "device_id?", desc: "List crow.md sections (device_id to filter)" },
      crow_delete_context_section: { params: "section_key, device_id?", desc: "Delete crow.md section (device_id for per-device override)" },
      crow_create_schedule: { params: "task, cron_expression, description?", desc: "Create scheduled/recurring task" },
      crow_list_schedules: { params: "enabled_only?", desc: "List scheduled tasks" },
      crow_update_schedule: { params: "id, enabled?, task?, cron_expression?, delete?", desc: "Update or delete schedule" },
      crow_check_notifications: { params: "unread_only?, type?, limit?", desc: "Check pending notifications" },
      crow_create_notification: { params: "title, body?, type?, priority?, action_url?, metadata?, expires_in_minutes?", desc: "Create a notification" },
      crow_dismiss_notification: { params: "id, snooze_minutes?", desc: "Dismiss or snooze notification" },
      crow_dismiss_all_notifications: { params: "type?, before?", desc: "Bulk dismiss notifications" },
      crow_notification_settings: { params: "action, types_enabled?", desc: "Get/set notification preferences" },
      crow_deep_recall: { params: "topic, per_source_limit?, include_sources?, project_id?, min_importance?", desc: "Proactive recall: search ALL knowledge sources for topic-relevant context" },
      crow_regenerate_embeddings: { params: "category?, id_list?", desc: "Re-embed memories to fix stale embeddings" },
      crow_dream: { params: "stale_days?, low_importance_threshold?, dry_run?", desc: "Analyze memory health: find stale, contradictory, or redundant memories" },
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
      crow_remove_backend: { params: "id, confirm_token", desc: "Remove data backend registration (cannot be undone). Returns preview + token on first call; pass token back to execute." },
      crow_backend_schema: { params: "id", desc: "Show backend tools/schema" },
      crow_workspace_dir: { params: "project_id", desc: "Returns the absolute filesystem workspace path for a project space" },
      crow_project_get: { params: "project_id", desc: "Get full project-space details: metadata, members, backends, counts, audit" },
      crow_project_capabilities: { params: "project_id, contact_id?", desc: "Return the effective capability set for a member of a project space" },
      crow_list_members: { params: "project_id, include_revoked?", desc: "List active members of a project space with roles and capabilities" },
      crow_add_member: { params: "project_id, contact_id?, role, capabilities?, mode?", desc: "Add or update a member of a project space" },
      crow_remove_member: { params: "project_id, contact_id", desc: "Soft-revoke a member from a project space (sets revoked_at)" },
      crow_audit_log: { params: "project_id, limit?, action?", desc: "Return recent audit log entries for a project space, newest first" },
    },
  },

  blog: {
    displayName: "Blog",
    description: "Blogging platform: create, edit, publish, list, search, delete posts, themes, RSS export, peer sharing",
    tools: {
      crow_create_post: { params: "title, content, slug?, excerpt?, author?, tags?, cover_image_key?, visibility?", desc: "Create blog post draft" },
      crow_edit_post: { params: "id, title?, content?, slug?, excerpt?, author?, tags?, cover_image_key?, visibility?", desc: "Update a blog post by ID. Only provided fields are changed; omitted fields are untouched." },
      crow_publish_post: { params: "id, confirm_token", desc: "Publish post. Returns preview + token on first call; pass token back to execute." },
      crow_unpublish_post: { params: "id", desc: "Revert to draft" },
      crow_list_posts: { params: "status?, tag?, search?, limit?", desc: "List posts with filters" },
      crow_get_post: { params: "id?, slug?", desc: "Get post by ID or slug" },
      crow_delete_post: { params: "id, confirm_token", desc: "Permanently delete a blog post (cannot be undone). Returns preview + token on first call; pass token back to execute." },
      crow_share_post: { params: "id, contact", desc: "Share post with peer" },
      crow_export_blog: { params: "format?", desc: "Export published posts as Hugo or Jekyll markdown with frontmatter" },
      crow_blog_settings: { params: "action, title?, tagline?, author?, theme?", desc: "Get/set blog settings" },
      crow_blog_customize_theme: { params: "css", desc: "Apply custom CSS" },
      crow_blog_stats: { params: "", desc: "Blog statistics" },
      crow_create_song: { params: "title, content, key?, artist?, tags?, audio_key?, visibility?", desc: "Create song (auto-tags songbook, validates ChordPro)" },
      crow_transpose_song: { params: "id, target_key", desc: "Transpose song to new key (non-destructive read)" },
      crow_list_songs: { params: "search?, key?, limit?", desc: "List songbook songs" },
      crow_get_chord_diagram: { params: "chord, instrument?", desc: "Get SVG chord diagram (guitar/piano)" },
      crow_create_setlist: { params: "name, description?, song_ids?, visibility?", desc: "Create setlist" },
      crow_add_to_setlist: { params: "setlist_id, post_id, position?, key_override?, notes?", desc: "Add song to setlist" },
      crow_remove_from_setlist: { params: "setlist_id, post_id", desc: "Remove song from setlist" },
      crow_update_setlist: { params: "id, name?, description?, visibility?, reorder?", desc: "Update setlist metadata or reorder songs" },
      crow_list_setlists: { params: "limit?", desc: "List setlists" },
      crow_get_setlist: { params: "id", desc: "Get setlist with songs" },
      crow_delete_setlist: { params: "id, confirm_token", desc: "Delete setlist (confirm required)" },
    },
  },

  sharing: {
    displayName: "Sharing",
    description: "P2P sharing: invite codes, contacts, encrypted sharing, inbox, Nostr messaging, access revocation",
    tools: {
      crow_generate_invite: { params: "display_name?", desc: "Generate invite code" },
      crow_accept_invite: { params: "invite_code, display_name?", desc: "Accept invite code" },
      crow_generate_short_invite: { params: "", desc: "Generate a short 12-character pairing code to read aloud or type (expires in 10 minutes)" },
      crow_accept_short_invite: { params: "short_code, display_name?", desc: "Accept a short pairing code someone read aloud or typed to you" },
      crow_add_contact: { params: "crow_id, secp256k1_pubkey, ed25519_pubkey?, display_name?", desc: "Repair/add a contact by Crow ID + keys (completes a half-finished handshake without a fresh invite)" },
      crow_accept_bot_invite: { params: "invite_code, display_name?", desc: "Accept a Crow Messages bot invite (adds the bot to Messages + authorizes you)" },
      crow_list_contacts: { params: "include_blocked?", desc: "List contacts" },
      crow_share: { params: "contact, share_type, item_id, permissions?, confirm_token", desc: "Share item with contact. Returns preview + token on first call; pass token back to execute." },
      crow_inbox: { params: "unread_only?, limit?", desc: "Check inbox" },
      crow_send_message: { params: "contact, message", desc: "Send encrypted message via Nostr (cannot be retracted)" },
      crow_revoke_access: { params: "contact, share_type, item_id, confirm_token", desc: "Revoke shared access. Returns preview + token on first call; pass token back to execute." },
      crow_sharing_status: { params: "", desc: "Sharing status" },
      crow_list_instances: { params: "status?", desc: "List registered Crow instances" },
      crow_register_instance: { params: "name, directory?, hostname?, tailscale_ip?, gateway_url?, sync_profile?, topics?, is_home?", desc: "Register a Crow instance" },
      crow_update_instance: { params: "instance_id, name?, gateway_url?, tailscale_ip?, sync_profile?, topics?, is_home?, status?", desc: "Update instance details" },
      crow_revoke_instance: { params: "instance_id, confirm", desc: "Revoke an instance (irreversible)" },
      crow_list_sync_conflicts: { params: "table_name?, unresolved_only?, limit?", desc: "List sync conflicts between instances" },
      crow_room_invite: { params: "contact, host_name?", desc: "Invite contact to companion room via Nostr" },
      crow_room_close: { params: "room_code?", desc: "Close active companion room" },
      crow_voice_memo: { params: "contact, message, sender_name?", desc: "Send text voice memo (recipient's companion speaks it)" },
      crow_react: { params: "contact, emoji", desc: "Send emoji reaction to a contact" },
      crow_create_message_group: { params: "name, members[], color?", desc: "Create a message group with contacts" },
      crow_list_message_groups: { params: "", desc: "List message groups and their members" },
      crow_send_group_message: { params: "group, message", desc: "Send message to all group members (fan-out encrypted DMs)" },
      crow_find_contacts: { params: "email", desc: "Search for Crow users by email hash" },
      crow_set_discoverable: { params: "email, enabled?", desc: "Opt in or out of contact discovery by setting your email hash" },
      crow_discover_relays: { params: "", desc: "List configured relays and discover new ones" },
      crow_add_relay: { params: "url, type", desc: "Add a Nostr or peer relay to your configuration" },
      crow_identity_attest: { params: "app, external_handle, app_pubkey?, confirm", desc: "Create a signed attestation linking a per-app handle to this Crow identity" },
      crow_identity_verify: { params: "crow_id, app, external_handle, max_age_seconds?", desc: "Verify an attestation for a given (crow_id, app, handle) triple" },
      crow_identity_revoke: { params: "attestation_id, reason?, confirm", desc: "Sign a revocation for a previously-published attestation" },
      crow_identity_list: { params: "include_revoked?, app?, limit?", desc: "List attestations for this Crow instance" },
      crow_list_crosspost_transforms: { params: "", desc: "List the available (source, target) transform pairs for crow_crosspost" },
      crow_crosspost: { params: "source_app, source_post_id, source_post, target_app, idempotency_key, trigger?, delay_seconds?, confirm", desc: "Cross-post a status between federated bundles via the transform library" },
      crow_crosspost_cancel: { params: "log_id", desc: "Cancel a queued cross-post before its scheduled_at fires" },
      crow_crosspost_mark_published: { params: "log_id, target_post_id", desc: "Mark a queued cross-post as published (audit-log update only)" },
      crow_list_crossposts: { params: "status?, limit?", desc: "List recent cross-posts with their status" },
    },
  },

  media: {
    displayName: "Media",
    description: "News & podcast hub: subscribe to RSS/Atom/YouTube/Google News, browse feed, search articles, personalized For You, TTS listen, briefings, playlists, smart folders, digests",
    tools: {
      crow_media_add_source: { params: "url?, query?, youtube_channel?, name?, category?, fetch_interval_min?", desc: "Subscribe to feed/channel" },
      crow_media_list_sources: { params: "enabled_only?, category?", desc: "List subscribed sources" },
      crow_media_remove_source: { params: "id, delete_articles?, confirm_token", desc: "Remove source (confirm required)" },
      crow_media_feed: { params: "limit?, offset?, category?, source_id?, unread_only?, starred_only?, sort?", desc: "Browse feed (chronological or for_you)" },
      crow_media_get_article: { params: "id", desc: "Get full article content" },
      crow_media_search: { params: "query, category?, date_from?, limit?, discover_sources?", desc: "Full-text search articles (discover_sources=true for web RSS discovery)" },
      crow_media_article_action: { params: "article_id, action", desc: "Star/save/read/feedback action" },
      crow_media_refresh: { params: "source_id?", desc: "Trigger feed refresh" },
      crow_media_stats: { params: "", desc: "Media statistics overview" },
      crow_media_listen: { params: "article_id, voice?", desc: "Generate/retrieve TTS audio" },
      crow_media_briefing: { params: "topic?, max_articles?, voice?", desc: "Generate news briefing" },
      crow_media_playlist: { params: "action, id?, name?, description?, confirm_token?", desc: "Manage playlists (create/list/rename/delete)" },
      crow_media_playlist_items: { params: "action, playlist_id, item_type?, item_id?, item_ids?", desc: "Manage playlist items (add/remove/reorder/list)" },
      crow_media_smart_folders: { params: "action, id?, name?, description?, query?, limit?, offset?, confirm_token?", desc: "Manage smart folders" },
      crow_media_digest_preview: { params: "smart_folder_id?, limit?", desc: "Preview digest content" },
      crow_media_digest_settings: { params: "schedule?, email?, custom_instructions?, enabled?", desc: "Configure digest delivery" },
      crow_media_schedule_briefing: { params: "cron, topic?, max_articles?, voice?, enabled?", desc: "Schedule automatic briefing generation" },
    },
  },

  consulting: {
    displayName: "Consulting Pipeline",
    description: "Maestro Press consulting prospect tracker: promote/advance orgs through pipeline stages, list pending prospects, write rendered prospectuses to the MPA inbox (systemd path watcher renders to PDF)",
    tools: {
      crow_consulting_promote: { params: "tea_id, stage?, notes?, name?, org_type?, esc_region?, county?", desc: "Promote an org to a pipeline stage (upserts when tea_id not present)" },
      crow_consulting_list_pending: { params: "limit?", desc: "List orgs at stage='prospect' with no pipeline action yet" },
      crow_consulting_write_prospectus: { params: "tea_id, markdown", desc: "Write finished prospectus markdown to the MPA inbox and mark the row generated" },
      crow_consulting_list_by_stage: { params: "stage, limit?", desc: "List consulting rows at a given stage" },
      crow_consulting_get: { params: "tea_id", desc: "Get a single consulting row by tea_id" },
      crow_consulting_stats: { params: "", desc: "Counts per stage + pending-generation count" },
    },
  },

  storage: {
    displayName: "Storage",
    description: "S3-compatible file storage: upload (base64 or presigned URL), list, download URLs, delete, quota management. SDXL background generation for companion avatar.",
    tools: {
      crow_upload_file: { params: "file_name, mime_type?, data_base64?, bucket?, reference_type?, reference_id?", desc: "Upload file" },
      crow_list_files: { params: "bucket?, mime_type?, reference_type?, reference_id?, limit?", desc: "List files" },
      crow_get_file_url: { params: "s3_key, expiry?, bucket?", desc: "Get download URL" },
      crow_delete_file: { params: "s3_key, bucket?, confirm_token", desc: "Permanently delete a file (cannot be undone). Returns preview + token on first call; pass token back to execute." },
      crow_storage_stats: { params: "", desc: "Storage statistics" },
      crow_generate_background: { params: "prompt, negative_prompt?, width?, height?", desc: "Generate SDXL Turbo background (requires SDXL extension)" },
      crow_list_backgrounds: { params: "", desc: "List generated backgrounds in gallery (images + videos)" },
      crow_set_background: { params: "name", desc: "Set gallery item as current companion background" },
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
