---
title: Multi-Instance Chaining
description: Connect multiple Crow installations across machines into a unified workspace with synced memory, federated tools, and centralized monitoring.
---

# Multi-Instance Chaining

Run Crow on multiple machines — a home server, a cloud VPS, a Raspberry Pi — and chain them together under a single identity. Memories sync automatically, and you can call tools on any instance from any other.

## Why Chain Instances?

| Benefit | How it helps |
|---------|-------------|
| **Redundancy** | If one instance goes down, your data is safe on the other |
| **Free tier stacking** | Combine Oracle Cloud + Google Cloud always-free instances at zero cost |
| **Project isolation** | Dedicate instances to different workstreams (research on one, data scraping on another) |
| **Geographic distribution** | Place instances in different regions for lower latency |
| **Offline resilience** | Satellites work independently when disconnected, then sync when reconnected |

The simplest chain is two always-free cloud VMs: [Oracle Cloud](../getting-started/oracle-cloud) as home + [Google Cloud](../getting-started/google-cloud) as satellite. See the [Multi-Device Quick Start](../getting-started/multi-device) to set it up in 15 minutes.

## What is an Instance?

An instance is a directory-scoped Crow installation. Each machine (or each project directory) can host its own instance with its own database, MCP servers, and gateway.

Two types:

| Type | Role |
|---|---|
| **Home** | Your primary instance. Holds the authoritative identity and acts as the sync hub. |
| **Satellite** | Secondary instances on other machines. They sync to the home instance and can operate independently when offline. |

You might have a home instance on your server running the full platform, and satellite instances on a laptop for offline work or on a cloud VM for always-on scraping.

## Setting Up

### 1. Install Crow on Both Machines

Each machine needs its own Crow installation. Follow the [Home Server](../getting-started/home-server) or [Desktop Install](../getting-started/desktop-install) guide.

### 2. Share Your Identity

Both instances must use the same cryptographic identity. On your home instance:

```bash
npm run identity:export
```

This produces an encrypted file. Transfer it to the satellite machine and import:

```bash
npm run identity:import
```

Both instances now share the same Crow ID and keypairs.

### 3. Register Instances

On the home instance, register the satellite:

```
"Register my black-swan server as a satellite instance"
```

The AI uses `crow_register_instance` to add the satellite to the instance registry. You need the satellite's gateway URL (e.g., `http://100.64.20.2:3001` via Tailscale).

On the satellite, register the home instance the same way. Both sides need to know about each other.

### Pairing over the network (cross-host credentials)

To give two instances the credentials they use to call each other, pair them with `crow instance pair`:

1. **On the peer** run `node scripts/cli/instance-pair.js --generate-otc`. It prints a one-time code. Add `CROW_ENROLL_ENABLED=1` and `CROW_ENROLL_OTC=<code>` to the peer gateway's environment (the repo `.env` or a systemd drop-in) and restart it.
2. **On this instance** run `node scripts/cli/instance-pair.js --peer-url https://<peer>.<tailnet>.ts.net:<port> --otc <code>`.
3. **On the peer** remove both variables and restart.

The code works once and expires 30 minutes after the peer's gateway first sees it (`CROW_ENROLL_WINDOW_MINUTES`). Enrollment is only reachable over your tailnet or local network, never over Funnel.

Re-pairing an instance the peer already trusts works the same way, as long as this instance still holds its old credentials for the peer (add `--peer-id <peer's instance id>` if the URL you type differs from the address stored for it). If it lost them, or the peer revoked it, the peer's operator first runs `node scripts/cli/instance-pair.js --allow-re-pair <this instance's id>` on the peer; without that the peer answers `409 already_paired` and changes nothing.

### 4. Verify Connectivity

```
"Show me instance status"
```

The Nest dashboard also shows instance health on the Instances panel — green for connected, yellow for syncing, red for unreachable.

## How Sync Works

Instances sync data through **Hypercore** append-only feeds — the same P2P technology used for peer sharing, but between your own machines instead of between different users.

- Each instance maintains a Hypercore feed for outbound changes
- The `InstanceSyncManager` replicates feeds when instances connect
- **Lamport timestamps** establish causal ordering across machines
- Conflicts (simultaneous edits to the same memory) are detected — the most recent edit wins, and the other version is kept safe instead of being discarded

When a conflict happens you get a notification that links to **Settings → Sync conflicts**. There you can review both versions side by side, keep the current one, or restore the overridden one — a restore syncs back out to your other instances like any normal edit.

Sync is **eventually consistent**. When two instances are online and can reach each other (via Tailscale, LAN, or the public internet), changes propagate within seconds. When offline, changes queue locally and sync on reconnection.

### What Syncs

- Memories (with instance scope filtering)
- Projects, sources, and notes
- Blog posts and settings
- Contacts and relay configuration

### What Stays Local

- Identity keys (already shared during setup)
- Gateway sessions and OAuth tokens
- Storage files (S3 objects stay on their local MinIO)

## Federation

Federation lets you call tools on a remote instance as if they were local. When you ask Crow to search memories, it can query both the local database and remote instances simultaneously.

This works through the **gateway proxy**: your local gateway forwards MCP requests to the remote gateway over HTTP, authenticated with bearer tokens derived from your shared identity.

```
"Search all my instances for notes about tax filing"
```

The AI dispatches the search to every registered instance and merges the results.

### When to Use Federation vs. Sync

- **Sync** copies data between instances. Use it when you want the same data available everywhere, even offline.
- **Federation** queries data in place. Use it for large datasets you don't want to replicate, or for tools that only make sense on a specific machine (e.g., home automation on your home server).

## Monitoring in the Nest

The Crow's Nest dashboard includes an **Instances** panel showing:

- All registered instances with connection status
- Last sync timestamp per instance
- Pending conflicts requiring resolution
- Memory and project counts per instance

Access it at your gateway URL under the Instances tab.

## Next Steps

- [Multi-Device Quick Start](../getting-started/multi-device) — Step-by-step setup walkthrough
- [Instance Architecture](../architecture/instances) — Deep dive into sync internals
- [Tailscale Setup](../getting-started/tailscale-setup) — Secure cross-network connectivity
