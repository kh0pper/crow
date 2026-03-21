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

1. On receiving a remote change, check if the local row has a `lamport_ts` greater than the remote change's `lamport` but the local change was not caused by a prior version of the remote change
2. If so, insert into `sync_conflicts`:

```sql
CREATE TABLE sync_conflicts (
  id TEXT PRIMARY KEY,
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  local_data TEXT NOT NULL,       -- JSON of local version
  remote_data TEXT NOT NULL,      -- JSON of remote version
  local_lamport INTEGER NOT NULL,
  remote_lamport INTEGER NOT NULL,
  remote_instance_id TEXT NOT NULL,
  resolved INTEGER DEFAULT 0,
  resolution TEXT,                -- "local", "remote", or "merge"
  created_at INTEGER NOT NULL
);
```

Conflicts are surfaced in the Nest dashboard and can be resolved by the user choosing local, remote, or a manual merge.

### Sync State

Per-instance sync progress is tracked in `sync_state`:

```sql
CREATE TABLE sync_state (
  instance_id TEXT PRIMARY KEY,
  last_seq INTEGER DEFAULT 0,     -- Last processed Hypercore sequence number
  last_lamport INTEGER DEFAULT 0, -- Highest Lamport timestamp seen from this instance
  last_sync INTEGER,              -- Unix timestamp of last successful sync
  FOREIGN KEY (instance_id) REFERENCES crow_instances(id)
);
```

On reconnection, sync resumes from `last_seq` — only new entries are transferred.

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

### Signature Verification

Every Hypercore feed entry is signed by the originating instance's Ed25519 key. The receiving instance verifies signatures before applying changes. Tampered entries are rejected and logged.

## Next Steps

- [Multi-Instance Guide](../guide/instances) — User-facing setup and usage
- [Sharing Server](./sharing-server) — P2P sharing between different users (related but distinct from instance sync)
- [Gateway Architecture](./gateway) — HTTP transport and proxy details
