# Cross-Platform Guide

Crow lets you use **any AI platform** — Claude, ChatGPT, Gemini, Grok, Cursor, and more — while keeping the same persistent memory, research projects, and behavioral context across all of them.

## The Problem

Every AI platform silos your context:

- Start a project in Claude? ChatGPT knows nothing about it.
- Store preferences in ChatGPT? Gemini can't access them.
- Build up context in Cursor? It stays in Cursor.

Every time you switch platforms, you start from zero.

## How Crow Solves It

Crow sits between you and your AI platforms as a shared layer:

```
┌─────────┐  ┌──────────┐  ┌────────┐  ┌────────┐
│  Claude  │  │ ChatGPT  │  │ Gemini │  │ Cursor │
└────┬─────┘  └────┬─────┘  └───┬────┘  └───┬────┘
     │             │             │            │
     └──────┬──────┴──────┬──────┘            │
            │             │                   │
       ┌────▼─────────────▼───────────────────▼────┐
       │           Crow Gateway (HTTP)             │
       │   OAuth 2.1 · Streamable HTTP · SSE       │
       └────────────────┬──────────────────────────┘
                        │
       ┌────────────────▼──────────────────────────┐
       │          Shared SQLite / Turso             │
       │  Memories · Research · Context · crow.md   │
       └───────────────────────────────────────────┘
```

**Three things are shared:**

1. **Memories** — Everything you tell any AI to remember is stored in one database. Ask from any platform, get the same answer.

2. **Research projects** — Sources, notes, citations, and bibliographies are shared. Start research in Claude, continue in ChatGPT.

3. **Behavioral context (crow.md)** — A dynamically-generated document that tells each AI platform how to behave as Crow: identity, memory protocols, transparency rules, and your customizations.

## Quick Start: Platform Hopping

### Step 1: Deploy Crow

Follow the [Cloud Deploy Guide](/getting-started/cloud-deploy) to get your gateway running. You'll get a URL like:
```
https://your-crow.onrender.com
```

### Step 2: Connect Your First Platform

Pick any platform from the [Platforms page](/platforms/) and connect it. For example, [Claude Web](/platforms/claude):

1. Go to claude.ai → Settings → Integrations → Add Custom Integration
2. Paste: `https://your-crow.onrender.com/memory/mcp`
3. Authorize and done.

### Step 3: Store Something

In Claude, say:
> "Remember that my preferred programming language is Python and I'm working on a machine learning project about climate data."

Crow stores this in the shared database.

### Step 4: Connect Another Platform

Connect [ChatGPT](/platforms/chatgpt) using the SSE endpoint:
```
https://your-crow.onrender.com/memory/sse
```

### Step 5: Recall From the Other Platform

In ChatGPT, say:
> "What do you know about my projects?"

ChatGPT, through Crow, recalls the memory you stored from Claude. Same data, different platform.

## crow.md — Shared Behavioral Context

Beyond data, Crow shares **behavioral instructions** across platforms through `crow.md`. This is a dynamically-generated document that defines:

- **Identity**: Who Crow is, what it does
- **Memory protocol**: When and how to store/recall memories
- **Research protocol**: Citation rules, project management
- **Session protocol**: What to do at start/during/end of sessions
- **Transparency rules**: How to surface autonomous actions
- **Skills reference**: Capability routing table
- **Key principles**: Core behavioral rules

### Accessing crow.md

| Method | When to Use |
|---|---|
| `crow_get_context` tool | From any MCP-connected platform |
| `crow://context` resource | MCP resource read |
| `GET /crow.md` | HTTP endpoint (for non-MCP platforms) |
| `GET /crow.md?platform=chatgpt` | Platform-specific formatting |

### Customizing crow.md

You can tailor Crow's behavior to your needs:

```
"Add a custom crow.md section called 'coding_style' that says
I prefer functional programming, TypeScript, and short functions."
```

Crow will store this as a new section, and it will appear in the context document for all platforms.

**Management tools:**
- `crow_list_context_sections` — See all sections
- `crow_update_context_section` — Modify any section
- `crow_add_context_section` — Add custom sections
- `crow_delete_context_section` — Remove custom sections

## Platform-Specific Tips

### Claude → ChatGPT
- Memories are instantly shared — no sync delay
- ChatGPT uses SSE transport (not Streamable HTTP)
- Transparency markers use `[brackets]` instead of *italic*/*bold*

### Claude → Cursor/IDE
- Great for code-focused work with full memory access
- IDE platforms minimize transparency output
- Use `crow_get_context` with `platform: "cursor"` for IDE-optimized context

### Any Platform → Any Platform
- All platforms share the same database
- Memories stored on one are immediately available on another
- Research projects, sources, and notes work the same everywhere
- crow.md ensures consistent behavior across platforms

## Security

- Each platform authenticates independently via OAuth 2.1
- No platform can access another platform's OAuth tokens
- All platforms read/write the same data — that's the point
- You control what's stored and can delete anything anytime
