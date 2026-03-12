# OpenClaw

Connect Crow to [OpenClaw](https://openclaw.ai), the open-source personal AI assistant that runs locally and operates through WhatsApp, Telegram, Discord, Slack, Signal, iMessage, and more.

## Why Use Crow with OpenClaw?

OpenClaw handles the conversational front-end across chat platforms. Crow adds persistent cross-platform memory and structured project management that survive OpenClaw's daily session resets and context compaction.

- **Persistent memory**: OpenClaw's markdown-based memory is session-scoped and lossy — context compaction summarizes or drops older information. Crow's SQLite/FTS5 memory is structured, searchable, and permanent.
- **Cross-platform access**: Memories stored from OpenClaw are instantly available from Claude, ChatGPT, Gemini, Cursor, or any other connected platform.
- **Project pipeline**: Crow adds capabilities OpenClaw doesn't have natively — typed projects (research, data connectors), sources with auto-APA citations, notes, data backends, and bibliography generation.

## Prerequisites

- [OpenClaw](https://openclaw.ai) installed and running
- Crow cloned and set up (`npm run setup`), OR Crow gateway deployed ([Cloud Deploy Guide](../getting-started/cloud-deploy))
- Node.js >= 18

## Option A: Local (stdio) {#local}

Run both Crow and OpenClaw on the same machine. No network or auth needed.

### Setup Steps

1. Clone and set up Crow:
   ```bash
   git clone https://github.com/kh0pper/crow.git
   cd crow
   npm run setup
   ```

2. Add Crow's MCP servers to your OpenClaw configuration (`~/.openclaw/openclaw.json`):
   ```json
   {
     "mcpServers": {
       "crow-memory": {
         "command": "node",
         "args": ["/path/to/crow/servers/memory/index.js"],
         "env": {
           "CROW_DB_PATH": "/path/to/crow/data/crow.db"
         }
       },
       "crow-projects": {
         "command": "node",
         "args": ["/path/to/crow/servers/research/index.js"],
         "env": {
           "CROW_DB_PATH": "/path/to/crow/data/crow.db"
         }
       }
     }
   }
   ```

   Replace `/path/to/crow` with the actual path to your Crow installation.

3. Restart the OpenClaw gateway to load the MCP servers.

## Option B: Remote (HTTP) {#remote}

Connect a local OpenClaw instance to a cloud-deployed Crow gateway. Useful when Crow runs on Render or Railway and OpenClaw runs on your machine.

### Setup Steps

1. Deploy Crow ([Cloud Deploy Guide](../getting-started/cloud-deploy))

2. Add HTTP endpoints to your OpenClaw configuration (`~/.openclaw/openclaw.json`):
   ```json
   {
     "mcpServers": {
       "crow-memory": {
         "url": "https://your-gateway.onrender.com/memory/mcp"
       },
       "crow-projects": {
         "url": "https://your-gateway.onrender.com/projects/mcp"
       },
       "crow-tools": {
         "url": "https://your-gateway.onrender.com/tools/mcp"
       }
     }
   }
   ```

3. OpenClaw uses `@modelcontextprotocol/sdk` natively, so OAuth 2.1 discovery and authorization should work automatically.

## Transport

| Pattern | Transport | Auth |
|---|---|---|
| Local (A) | stdio | None (local process) |
| Remote (B) | Streamable HTTP | OAuth 2.1 |

## Handling Dual Memory Systems

Both OpenClaw and Crow have their own memory systems. This section explains how to use them together without confusion.

### The Problem

OpenClaw stores memory as markdown files (`memory/YYYY-MM-DD.md` daily logs, `MEMORY.md` long-term) and offers `memory_search` for semantic/vector retrieval. Crow stores memory in SQLite with FTS5 full-text search, categories, importance scoring (1–10), and tags. Running both raises the question: which is the source of truth?

### Recommended Strategy: Crow for Long-Term, OpenClaw for Session Context

Think of it as two layers:

| Layer | System | Purpose |
|---|---|---|
| Working memory | OpenClaw (markdown) | Short-term session context, ephemeral notes |
| Long-term memory | Crow (SQLite/FTS5) | Persistent facts, preferences, cross-platform context |

- Use Crow's `crow_store_memory` and `crow_search_memories` for anything that should persist across sessions or be accessible from other platforms.
- Let OpenClaw's built-in memory handle short-term context naturally — it already manages compaction and daily resets.
- **Don't sync the two systems.** Bidirectional sync leads to duplication and conflicts.

### Optional: Create an OpenClaw Skill for Crow Memory

You can create a skill that teaches OpenClaw when and how to use Crow's memory tools. Create `~/.openclaw/skills/crow-memory/SKILL.md`:

```markdown
---
name: crow-memory
description: Use Crow for persistent cross-platform memory
---

## When to Use Crow Memory

Use the `crow_store_memory` tool (not OpenClaw's built-in memory) when:
- The user shares a preference, fact, or decision that should persist long-term
- Information needs to be accessible from other platforms (Claude, ChatGPT, etc.)
- Context is important enough to survive session resets

Use the `crow_search_memories` tool to recall previously stored information,
especially at the start of a new session to restore relevant context.

## At Session Start

Search Crow memory for context relevant to the current conversation:
1. Use `crow_search_memories` with broad terms related to the user's first message
2. Use `crow_recall_by_context` with a description of the current situation

## Before Context Compaction

When context is about to be compacted, save critical information to Crow
using `crow_store_memory` with appropriate category and importance level.

## Categories

Use these categories when storing to Crow:
- `preference` — User likes, dislikes, settings
- `person` — Information about people
- `project` — Project details and decisions
- `decision` — Choices made and reasoning
- `learning` — Things learned or discovered
- `general` — Everything else
```

### What NOT to Do

- Don't build a sync bridge between OpenClaw markdown memory and Crow
- Don't store the same information in both systems
- Don't rely on OpenClaw memory for anything that needs cross-platform persistence

## Cross-Platform Context

Crow automatically delivers behavioral context when OpenClaw connects via MCP — memory protocols, session management, and transparency rules are active from the first message. No manual loading required.

For deeper guidance, MCP prompts are available: `session-start`, `crow-guide`, `research-guide`, `blog-guide`, `sharing-guide`.

**Manual access via MCP tool:**
> "Use the crow_get_context tool"

**Via HTTP** (if gateway is deployed):
```
GET https://your-gateway.onrender.com/crow.md
```

The context includes Crow's identity, memory protocols, transparency rules, and any custom sections you've configured. See the [Cross-Platform Guide](/guide/cross-platform) for details.

## Using Project Tools

With Crow connected, OpenClaw gains access to a full project pipeline:

- **Projects**: Create and manage projects (`crow_create_project`, `crow_list_projects`) with typed workflows (research, data connectors)
- **Sources**: Add sources with auto-generated APA citations (`crow_add_source`, `crow_search_sources`)
- **Notes**: Take notes linked to sources and projects (`crow_add_note`, `crow_search_notes`)
- **Bibliography**: Generate formatted bibliographies (`crow_generate_bibliography`)
- **Data backends**: Register external MCP servers as data sources (`crow_register_backend`, `crow_list_backends`)

Example workflow through any OpenClaw-connected chat:

> "Create a research project about renewable energy policy"
>
> "Add this source: https://example.com/solar-report — it's a web article by Jane Smith published in 2024"
>
> "Generate a bibliography for the renewable energy project"

## P2P Sharing & Collaboration

One of the most powerful capabilities unlocked by pairing OpenClaw with Crow is decentralized, privacy-first collaboration. Crow's sharing layer enables direct peer-to-peer connections between users — no central server required. Combined with OpenClaw's multi-platform chat interface, this means you can share data, collaborate on projects, and message contacts directly from WhatsApp, Telegram, Discord, or any other connected platform.

### Why This Matters

Traditional collaboration tools route everything through a central service. Crow takes a different approach: peers discover each other directly and sync data over encrypted channels. OpenClaw makes this accessible from everyday chat platforms, so you get the convenience of messaging apps with the privacy guarantees of P2P infrastructure.

### Key Capabilities

**Hyperswarm discovery** — Crow instances find each other on the network using DHT-based peer discovery with NAT holepunching. No static IPs, no port forwarding, no coordination server. When you add a contact, Crow handles discovery automatically.

**Encrypted data sync** — Data replicates between peers over Hypercore append-only feeds. These feeds are encrypted and append-only, meaning data can be securely shared without risk of tampering. Sync happens directly between peers whenever both are online.

**Nostr messaging** — Crow supports NIP-44 encrypted messaging between users via Nostr relays. Through OpenClaw, you can send and receive encrypted messages from any chat platform — WhatsApp, Discord, Signal, or wherever your OpenClaw bot lives.

**P2P sharing workflows** — Share memories, projects, sources, and notes with contacts using invite codes. Permissions are granular: `read`, `read-write`, or `one-time` access. Revoke access at any time.

### Getting Started with Sharing

To use P2P sharing through OpenClaw, connect the `crow-sharing` server alongside memory and projects.

**Local (stdio)** — add to your `~/.openclaw/openclaw.json`:
```json
{
  "mcpServers": {
    "crow-sharing": {
      "command": "node",
      "args": ["/path/to/crow/servers/sharing/index.js"],
      "env": {
        "CROW_DB_PATH": "/path/to/crow/data/crow.db"
      }
    }
  }
}
```

**Remote (HTTP)** — add the sharing endpoint:
```json
{
  "mcpServers": {
    "crow-sharing": {
      "url": "https://your-gateway.onrender.com/sharing/mcp"
    }
  }
}
```

### Example Workflows

Through any OpenClaw-connected chat:

> "Generate an invite code for sharing"
>
> "Share my renewable energy project with Alex as read-only"
>
> "Check my inbox for shared items"
>
> "Send a message to Alex: the solar report is updated"
>
> "Revoke Alex's access to the renewable energy project"

### Sharing Tools Reference

| Tool | Purpose |
|---|---|
| `crow_generate_invite` | Create an invite code for a new contact |
| `crow_accept_invite` | Accept an invite code from another user |
| `crow_share` | Share a memory, project, source, or note with a contact |
| `crow_inbox` | View received shares and messages |
| `crow_send_message` | Send an encrypted Nostr message to a contact |
| `crow_list_contacts` | List your connected peers |
| `crow_revoke_access` | Remove a contact's access to shared items |
| `crow_sharing_status` | View sharing status and peer connectivity |

### Privacy Model

All sharing is opt-in and user-initiated. Crow never shares data without explicit action. The architecture ensures:

- **No central server** — Peers connect directly via Hyperswarm. Nostr relays carry encrypted messages but cannot read them.
- **End-to-end encryption** — Messages use NIP-44 encryption. Data sync uses Hypercore's built-in encryption.
- **Granular permissions** — You control exactly what is shared, with whom, and at what access level.
- **Revocable access** — Remove a contact's access at any time.

## Verification

After connecting, test through any OpenClaw-connected chat platform:

1. **Store a memory**:
   > "Store a memory that OpenClaw is connected to Crow"

2. **Verify retrieval**:
   > "Search my memories for 'OpenClaw'"

3. **Cross-platform test** (if Crow is also connected to Claude, ChatGPT, etc.):
   Ask the other platform: "Search my memories for 'OpenClaw'" — the memory should appear.

4. **Project tools**:
   > "List my projects"

## Tips

- Memories stored from OpenClaw are instantly available from Claude, ChatGPT, Gemini, or any other connected platform
- OpenClaw's pre-compaction memory flush is a natural trigger for saving important context to Crow
- Use Crow's importance scoring (1–10) to prioritize what matters — high-importance memories surface first in searches
- `crow_memory_stats` gives a quick overview of your memory database from any platform
- If using Option B (HTTP), ensure your gateway stays healthy — OpenClaw loses memory/project access if the gateway goes down
- Both systems can coexist — let each do what it's best at rather than trying to replace one with the other
