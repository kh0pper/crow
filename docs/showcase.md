---
title: Showcase
---

# Showcase

Real-world Crow deployments and use cases from the community.

## Project Management

Use Crow to manage projects through conversation. Create typed projects, collect sources, take structured notes, and connect external data backends — all through your AI assistant.

**Typical setup:** Crow memory + project servers on a home server, accessed via Claude Code or Claude Desktop. Notes and sources are searchable with full-text search. Data connector projects bridge external databases and APIs.

**Key tools:** `crow_create_project`, `crow_add_source`, `crow_add_note`, `crow_search_sources`, `crow_register_backend`

---

## Academic Research

Use Crow as your research assistant. Create research projects with auto-generated APA citations, verify sources against DOIs and URLs, and generate complete bibliographies — all through conversation.

**Typical setup:** Research-type projects with the project server. Sources are verified and cited automatically. Bibliographies export in standard formats.

**Key tools:** `crow_create_project`, `crow_add_source`, `crow_verify_source`, `crow_generate_bibliography`, `crow_search_sources`

---

## Blogging

Publish a personal blog by talking to your AI. Draft posts, edit them in conversation, publish when ready. Posts are served as clean HTML with RSS feeds, and you can export to Hugo or Jekyll at any time.

**Typical setup:** Full Docker profile with gateway and MinIO. Blog images uploaded to storage, referenced in Markdown posts. Crow's Nest for quick edits.

**Key tools:** `crow_create_post`, `crow_publish_post`, `crow_upload_file`, `crow_export_blog`

---

## Team Collaboration

Share projects and memories with collaborators using P2P sharing. No central server required — data syncs directly between Crow instances using encrypted Hypercore feeds.

**Typical setup:** Two or more Crow users connected via invite codes. Shared projects with read-write access. Nostr messaging for coordination.

**Key tools:** `crow_share`, `crow_inbox`, `crow_send_message`

---

## Personal Knowledge Management

Build a searchable personal knowledge base over time. Store facts, decisions, preferences, and context that your AI remembers across sessions and platforms.

**Typical setup:** Memory server running on a home server or cloud instance. Cross-platform access via Claude, ChatGPT, Gemini, or Cursor. Tailscale for secure remote access.

**Key tools:** `crow_store_memory`, `crow_search_memories`, `crow_recall_by_context`

---

## Submit Your Use Case

Using Crow in an interesting way? Open an issue on [GitHub](https://github.com/kh0pper/crow) with the **Showcase Submission** label and describe your setup. We will add it here.
