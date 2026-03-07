# Cross-Platform Context (crow.md) — Skill

## Description
Manages the crow.md cross-platform behavioral context document. This document defines how Crow behaves across all AI platforms — identity, memory protocols, transparency rules, and more. It's dynamically generated from structured sections in the database, with optional live data injection.

## Trigger Phrases
- "who are you", "what can you do", "introduce yourself"
- "customize behavior", "change how you work", "update your instructions"
- "set up new platform", "configure for ChatGPT", "set up Gemini"
- "crow.md", "cross-platform context", "behavioral context"
- "what are your rules", "how do you work"

---

## Workflows

### Read the Current Context
When the user wants to understand how Crow behaves or see the full context document:

1. Use `crow_get_context` with `include_dynamic: true` and appropriate `platform`
2. Present a summary of the key sections
3. Offer to customize if the user wants changes

### Customize Sections
When the user wants to change how Crow behaves:

1. `crow_list_context_sections` — show all sections with status
2. User picks a section to modify
3. `crow_update_context_section` — update content, title, enabled, or sort order
4. Confirm the change and regenerate to verify

### Add Custom Sections
When the user wants to add project-specific or personal instructions:

1. Discuss what the section should contain
2. `crow_add_context_section` with a descriptive key, title, and content
3. Set `sort_order` to control where it appears (lower = earlier)

### Remove Custom Sections
1. `crow_list_context_sections` to find the section
2. `crow_delete_context_section` — only works for custom sections
3. Protected sections can only be disabled: `crow_update_context_section` with `enabled: false`

### Set Up a New Platform
When the user wants to use Crow from a different AI platform:

1. Generate the context with `crow_get_context` using `platform: "<platform_name>"`
2. For MCP-compatible platforms: point them to the gateway URL and explain the `crow://context` resource
3. For non-MCP platforms: provide the HTTP URL `GET /crow.md?platform=<name>`
4. Store the platform setup in memory for future reference

---

## Protected Sections
These 7 core sections cannot be deleted (only updated or disabled):
- `identity` — Who Crow is and its core purpose
- `memory_protocol` — When and how to store/recall memories
- `research_protocol` — Research project management rules
- `session_protocol` — Session start/during/end behaviors
- `transparency_rules` — How to surface autonomous actions
- `skills_reference` — Capability routing table
- `key_principles` — Core behavioral principles

---

## Access Methods

| Method | URL / Identifier | Auth Required |
|---|---|---|
| MCP Tool | `crow_get_context` | No (local) |
| MCP Resource | `crow://context` | No (local) |
| HTTP Endpoint | `GET /crow.md` | Yes (gateway) |
| HTTP with platform | `GET /crow.md?platform=chatgpt` | Yes (gateway) |
| HTTP static only | `GET /crow.md?dynamic=false` | Yes (gateway) |
