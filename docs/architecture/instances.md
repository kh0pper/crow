---
title: Instance Architecture
description: Technical deep dive into multi-instance chaining — registry, sync, federation, and conflict resolution.
---

# Instance Architecture

Multi-instance chaining connects separate Crow installations into a unified workspace. This page covers the internal mechanisms: how instances discover each other, sync data, federate tool calls, and resolve conflicts.

For user-facing setup instructions, see the [Multi-Instance Guide](../guide/instances).

## Instance Registry

Each Crow installation maintains a local registry of known instances.

### Database Table

```sql
CREATE TABLE crow_instances (
  id TEXT PRIMARY KEY,            -- UUID
  name TEXT NOT NULL,             -- Human-readable label ("grackle", "black-swan")
  role TEXT NOT NULL,             -- "home" or "satellite"
  gateway_url TEXT,               -- HTTP endpoint (e.g., "http://100.121.254.89:3001")
  public_key TEXT NOT NULL,       -- Ed25519 public key (must match shared identity)
  last_seen INTEGER,              -- Unix timestamp of last successful contact
  status TEXT DEFAULT 'unknown',  -- "online", "syncing", "offline", "unknown"
  created_at INTEGER NOT NULL
);
```

Instances are also tracked in `~/.crow/instances.json` for use by the CLI and startup scripts before the database is available.

### Registration Flow

1. User asks the AI to register an instance (or uses the Nest settings panel)
2. `crow_register_instance` validates the gateway URL with a health check
3. The remote instance's public key is verified against the local identity — both must derive from the same master seed
4. On success, the instance is added to `crow_instances` and `~/.crow/instances.json`

## Core Sync via Hypercore

Data synchronization between instances uses Hypercore append-only feeds, managed by `InstanceSyncManager`.

### InstanceSyncManager

The sync manager runs as part of the gateway process. It:

1. Maintains one outbound Hypercore feed per registered instance
2. Listens for inbound feed connections from remote instances
3. Appends local changes (memory writes, project updates, blog edits) to the outbound feed
4. Applies inbound changes from remote feeds to the local database

### Feed Structure

Each change is appended as a JSON entry:

```json
{
  "type": "memory_insert",
  "table": "memories",
  "row_id": "uuid-here",
  "data": { "content": "...", "category": "project", "importance": 7 },
  "lamport": 42,
  "instance_id": "grackle-uuid",
  "timestamp": 1711000000
}
```

Supported change types: `memory_insert`, `memory_update`, `memory_delete`, `project_update`, `source_insert`, `note_insert`, `blog_update`, `contact_update`, `setting_update`.

### Lamport Timestamps

Each instance maintains a Lamport counter. The counter increments on every local write and advances to `max(local, remote) + 1` on every received change. This establishes **causal ordering** without requiring synchronized clocks.

The `lamport` value is stored alongside every synced row in a `lamport_ts` column, added to tables that participate in sync.

### Conflict Detection

A conflict occurs when two instances modify the same row (same `row_id`) without having seen each other's changes. Detection:

1. On receiving a remote change, compare it against the local row. Equivalent rows (same content after wire-form normalization) are noise-suppressed — only real divergence counts.
2. When two instances genuinely changed the same row without having seen each other's edits, the higher Lamport timestamp wins, and the losing version is preserved in `sync_conflicts`:

```sql
CREATE TABLE sync_conflicts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  winning_instance_id TEXT NOT NULL,
  losing_instance_id TEXT NOT NULL,
  winning_lamport_ts INTEGER NOT NULL,
  losing_lamport_ts INTEGER NOT NULL,
  winning_data TEXT NOT NULL,     -- JSON of the version that was kept
  losing_data TEXT NOT NULL,      -- JSON of the version that was overridden
  op TEXT DEFAULT 'update',       -- 'update', 'delete', or 'insert' (collision)
  resolved INTEGER DEFAULT 0,
  resolved_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
```

No edit is ever silently dropped: every conflict raises a deduplicated high-priority notification that deep-links to **Settings → Sync conflicts**, the recovery view. There the operator can keep the current version, restore the overridden one, or resolve all. Restore is guarded — it re-reads the live row first (stale-snapshot guard), never uses `INSERT OR REPLACE`, refuses `op='insert'` collisions (both versions stay visible as JSON for manual resolution), and refuses `crow_context` rows (composite-key last-write-wins applies there instead). A restored version propagates back to the other instances like any normal edit.

### Sync State

Per-instance sync progress is tracked in `sync_state`:

```sql
CREATE TABLE sync_state (
  instance_id TEXT PRIMARY KEY,
  local_counter INTEGER DEFAULT 0,        -- This instance's Lamport counter (atomic increments)
  last_applied_seq_per_peer TEXT DEFAULT '{}', -- JSON: per-peer feed checkpoints, written per entry
  updated_at TEXT DEFAULT (datetime('now'))
);
```

Checkpoints are written per applied entry (not per batch), so a crash mid-sync never re-applies or skips entries.

On reconnection, sync resumes from the per-peer checkpoint in `last_applied_seq_per_peer` — only new entries are transferred.

## Federation via Gateway Proxy

Federation enables remote tool calls without syncing data. The local gateway proxies MCP requests to a remote gateway.

### Transport

Federation uses `StreamableHTTPClientTransport` from the MCP SDK to connect to the remote gateway's MCP endpoint (`/mcp` or `/router/mcp`). The connection is established on demand when a federated tool call is requested.

### Authentication

Federated requests carry a bearer token in the `Authorization` header. The token is derived from the shared identity:

1. The local instance signs a challenge (current timestamp + target instance ID) with its Ed25519 private key
2. The remote gateway verifies the signature against the known public key from its own `crow_instances` table
3. Tokens are short-lived (5-minute expiry) and regenerated automatically

### Request Flow

```
User asks: "Search all instances for tax notes"
  → Local AI dispatches crow_search_memories locally
  → Local AI dispatches federated search to each registered instance
    → Gateway proxy creates StreamableHTTPClientTransport
    → Sends MCP tool call over HTTP to remote gateway
    → Remote gateway executes tool against its local database
    → Results return over HTTP
  → Local AI merges all results and presents to user
```

### Cached Summaries

To avoid redundant federation calls, the gateway caches lightweight summaries from remote instances:

- Project names and IDs (refreshed hourly)
- Memory category counts (refreshed hourly)
- Instance health status (refreshed every 5 minutes)

Summaries help the AI decide which instances to query for a given request.

## Security

### Identity Verification

All instances in a chain must share the same cryptographic identity (same master seed). This is verified during registration and on every sync/federation connection. An instance with a different identity cannot join the chain.

### Transport Security

- **Hypercore sync**: Encrypted at the Hyperswarm transport layer (Noise protocol)
- **Federation HTTP**: Should run over HTTPS or Tailscale (encrypted tunnel). Bearer tokens prevent unauthorized access even on trusted networks.
- **No public exposure**: Instance registration requires explicit user action. Instances are not discoverable on the public internet.

### Tailnet sync transport (`servers/sharing/tailnet-sync.js`)

Paired instances of the same user replicate over an authenticated WebSocket at `/api/instance-sync/stream`, dialed over Tailscale:

- **Dial address.** A peer row is dialed at its `gateway_url` when that is not on port 443, then at `ws://<tailscale_ip>:<port>` (its learned backend port first, then the standard ports). Port **443 is never dialed** — on crow it is the public Funnel door. At pairing an instance advertises a `gateway_url` for browsers and HTTP peer calls (`CROW_PEER_GATEWAY_URL` if set; else a non-Funnel Serve endpoint proxying to its port, non-443 preferred; else its tailnet IP + backend port) **plus** its `tailscale_ip` and backend `sync_port` — never `CROW_GATEWAY_URL`, the public URL. A row holding only a `:443` URL with no `tailscale_ip` is repaired at boot and from the refresh loop: the URL's MagicDNS host is resolved to its tailnet IP via `tailscale status`. The peer's signed handshake then teaches its backend port; `gateway_url` itself is left as the browser URL.
- **Handshake.** Both sides sign a hello with the shared identity key (the Hyperswarm handshake only ever signs a 32-byte hex challenge, so it cannot be used to sign these messages for someone else). A challenge-response step binds each side's proof to the other side's fresh nonce, and no feed key is sent before it verifies, so a replayed hello gets nothing. Older peers that do not offer it still link; once a peer has completed challenge-response, a handshake from it without one is refused (downgrade guard). Only the operator's local `crow instance pair` clears that pin — never an inbound enroll request, a revoke or a pause.
- **One link per pair.** The lower instance id dials; the other side dials only as a fallback after a grace period, and the accept side refuses a fallback dial (`1013`) while a link or its own dial is up.
- **Half-open links.** Both ends ping every 30 s and terminate a link that has gone two intervals without a pong; the dialer then re-dials.

### Signature Verification

Every Hypercore feed entry is signed by the originating instance's Ed25519 key. The receiving instance verifies signatures before applying changes. Tampered entries are rejected and logged.

## Next Steps

- [Multi-Instance Guide](../guide/instances) — User-facing setup and usage
- [Sharing Server](./sharing-server) — P2P sharing between different users (related but distinct from instance sync)
- [Gateway Architecture](./gateway) — HTTP transport and proxy details
