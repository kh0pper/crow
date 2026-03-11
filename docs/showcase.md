---
title: Showcase
---

# Showcase

Real-world Crow deployments and use cases from the community.

## Research Workflow

Use Crow as your research assistant. Create projects, collect sources with auto-generated APA citations, take notes linked to sources, and generate bibliographies — all through conversation.

**Typical setup:** Crow memory + project servers on a home server, accessed via Claude Code or Claude Desktop. Sources are verified against DOIs and URLs. Notes are searchable with full-text search.

**Key tools:** `crow_create_project`, `crow_add_source`, `crow_add_note`, `crow_generate_bibliography`, `crow_search_sources`

---

## Blogging

Publish a personal blog by talking to your AI. Draft posts, edit them in conversation, publish when ready. Posts are served as clean HTML with RSS feeds, and you can export to Hugo or Jekyll at any time.

**Typical setup:** Full Docker profile with gateway and MinIO. Blog images uploaded to storage, referenced in Markdown posts. Dashboard for quick edits.

**Key tools:** `crow_create_post`, `crow_publish_post`, `crow_upload_file`, `crow_export_blog`

---

## Team Collaboration

Share research projects and memories with collaborators using P2P sharing. No central server required — data syncs directly between Crow instances using encrypted Hypercore feeds.

**Typical setup:** Two or more Crow users connected via invite codes. Shared research projects with read-write access. Nostr messaging for coordination.

**Key tools:** `crow_share`, `crow_inbox`, `crow_send_message`

---

## Personal Knowledge Management

Build a searchable personal knowledge base over time. Store facts, decisions, preferences, and context that your AI remembers across sessions and platforms.

**Typical setup:** Memory server running on a home server or cloud instance. Cross-platform access via Claude, ChatGPT, Gemini, or Cursor. Tailscale for secure remote access.

**Key tools:** `crow_store_memory`, `crow_search_memories`, `crow_recall_by_context`

---

## Submit Your Use Case

Using Crow in an interesting way? Open an issue on [GitHub](https://github.com/kh0pper/crow) with the **Showcase Submission** label and describe your setup. We will add it here.
