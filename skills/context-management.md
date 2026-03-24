---
name: context-management
description: Self-monitor context usage and suggest optimization when many tools are active
triggers:
  - too many tools
  - context is full
  - running slow
  - optimize context
  - reduce tools
tools:
  - crow-memory
---

# Context Management

## When to Activate

- User mentions slow responses or degraded quality
- User asks about context limits or tool counts
- You detect many integrations are connected (check via /health endpoint)
- User asks how to optimize their setup

## Self-Monitoring

When you notice conversation quality degrading or context getting tight:

1. **Check tool count** — If connected via gateway, the `/health` endpoint shows `toolCounts` with `core`, `external`, and `total` counts
2. **Assess the situation** — More than 30 tools is where context pressure starts. More than 50 is significant.
3. **Suggest optimization** — Based on how the user connects:

## Recommendations

### Gateway users (HTTP)
Suggest switching to the **router endpoint** (`/router/mcp`):
- Reduces ~49 core tools to 7 category tools
- Each category tool (crow_memory, crow_projects, etc.) accepts an `action` parameter
- Use `crow_discover` to look up full parameter schemas when needed
- External tools route through `crow_tools`

### Local/stdio users (Claude Code, Cursor)
Suggest switching to **crow-core** (`servers/core/index.js`):
- Starts with 15 tools (memory + 3 management) instead of 49+
- Use `crow_activate_server("research")` to enable servers on demand
- Use `crow_deactivate_server("research")` when done to free context
- Generate config: `npm run mcp-config -- --combined`

### General tips
- Disable integrations you're not actively using
- External integrations add 5-20+ tools each
- The router's `crow_discover` tool lets you look up exact parameter schemas without loading them all upfront

## Setting Up Writing Rules

Users can define writing rules that Crow follows across all platforms — chat, email, documents, and any other writing context.

Rules are stored in the `writing_style` context section, which is always loaded at conversation start. This means Crow applies them automatically without the user needing to repeat themselves.

### Adding rules

Users can set rules via natural language:

- "Crow, add a writing rule: never use em dashes"
- "Crow, writing rule: keep emails under 3 paragraphs"
- "Crow, add a rule: use Oxford commas"

Save these to the `writing_style` context using `crow_memory`. Users can also add or edit rules directly through the **Skills panel** in Crow's Nest.

### Example rules

- **Banned words/patterns** — "Never use 'utilize', 'leverage', or 'synergy'"
- **Preferred tone** — "Keep tone conversational but not casual"
- **Context-specific rules** — "In work emails, always include a clear ask. In personal messages, keep it brief."
- **Formatting preferences** — "Use bullet points instead of numbered lists when order doesn't matter"

### Applying rules

When writing or editing text, check the `writing_style` context and apply all active rules. If a user's request conflicts with a stored rule, follow the user's immediate instruction — but don't change the stored rule unless they ask.

## Don't

- Don't suggest optimization unprompted unless quality is visibly degrading
- Don't be alarmist — most users are fine with default settings
- Don't recommend the router to users who only use 1-2 servers
