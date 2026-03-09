---
name: onboarding-tour
description: First-run tour showing new users what Crow can do
triggers:
  - what can you do
  - what is crow
  - getting started
  - help me get started
  - first time
  - new to crow
tools:
  - crow-memory
---

# Onboarding Tour

## When to Activate

- First interaction with a new user (no memories stored yet)
- User asks "what can you do?" or "what is Crow?"
- User says they're new or asks for help getting started
- `crow_memory_stats` shows 0 memories (fresh install)

## Tour Flow

### 1. Introduction

Greet the user warmly and introduce Crow's core purpose:

> Welcome to Crow! I'm your AI assistant with persistent memory, research tools, and a growing set of integrations. Everything I learn stays with you — across sessions and across platforms.

### 2. Core Capabilities

Walk through the main features:

**Memory** — I remember things across conversations. Tell me your preferences, project context, important facts — I'll recall them next time.

**Research** — I manage structured research projects with proper citations, source tracking, and bibliography generation.

**Blog** — You have a built-in blogging platform. Tell me to write a post and I'll create, publish, and manage it for you. Your blog is available at `/blog`.

**Files** — Upload and manage files with S3-compatible storage. Images for blog posts, documents for research, anything you need to keep.

**Dashboard** — A visual control panel at `/dashboard` for managing messages, blog posts, files, and settings.

**Integrations** — Connect to GitHub, Google Workspace, Slack, Discord, Trello, Notion, Canvas LMS, and more.

**P2P Sharing** — Share memories, research, and blog posts with other Crow users via encrypted peer-to-peer connections.

### 3. Quick Wins

Suggest immediate actions:

- "Tell me your name and I'll remember it"
- "What are you working on? I can set up a research project"
- "Want to write your first blog post?"
- "Check out your dashboard at `/dashboard`"

### 4. Store First Memory

After the tour, store a memory noting this is a new user:

```
crow_store_memory({
  category: "preference",
  content: "New Crow user — completed onboarding tour",
  importance: 7,
  tags: "onboarding, new-user"
})
```

### 5. Performance Tips

If the user has multiple integrations or asks about performance:

- Each integration adds tools that use AI context space — like papers on a desk
- Start with the core servers, add integrations as you need them
- If responses feel slow with many integrations, try the **router endpoint** (`/router/mcp`) — it consolidates all tools into 7 categories
- For local/stdio setups, `crow-core` starts with just memory tools and activates others on demand
- Check `/health` to see how many tools are loaded

## Don't

- Don't overwhelm with every feature — keep it high-level
- Don't push integrations that require API keys — those are advanced setup
- Don't mention technical details (MCP, stdio, gateway) unless asked
- Don't repeat the tour if the user has memories stored (they're not new)
