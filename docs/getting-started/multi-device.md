---
title: Multi-Device Quick Start
description: Step-by-step guide to chaining two Crow installations together with shared identity and synced data.
---

# Multi-Device Quick Start

Connect two Crow installations so they share the same identity, sync memories, and can call each other's tools. This walkthrough takes about 15 minutes.

## Prerequisites

- **Two machines** with Crow installed (see [Home Server](./home-server) or [Desktop Install](./desktop-install))
- **Node.js 18+** on both machines
- **Network connectivity** between them — Tailscale recommended (see [Tailscale Setup](./tailscale-setup)), or same LAN

## Step 1: Pick Your Home Instance

Decide which machine is your **home** instance (primary) and which is the **satellite**. The home instance is where your identity was first created.

For this guide, we'll call them `server-a` (home) and `server-b` (satellite).

## Step 2: Export Identity from Home

On `server-a`:

```bash
cd ~/crow
npm run identity:export
```

You'll be prompted for a passphrase to encrypt the export. The command outputs a file path — something like `~/.crow/identity-export.enc`.

Copy the file to `server-b`:

```bash
scp ~/.crow/identity-export.enc user@server-b:~/
```

## Step 3: Import Identity on Satellite

On `server-b`:

```bash
cd ~/crow
npm run identity:import
```

Enter the same passphrase you used during export. This replaces `server-b`'s identity with the shared one.

Verify both machines have the same Crow ID:

```bash
# On server-a
npm run identity

# On server-b
npm run identity
```

The Crow IDs should match.

## Step 4: Initialize the Satellite Database

On `server-b`, if you haven't already:

```bash
npm run init-db
```

## Step 5: Start the Gateway on Both Machines

Each instance needs its gateway running:

```bash
# On server-a
npm run gateway

# On server-b
npm run gateway
```

Note the gateway URLs — by default `http://<ip>:3001`.

## Step 6: Register Instances

On `server-a`, open a Crow session and register the satellite:

```
"Register server-b as a satellite instance at http://<server-b-ip>:3001"
```

On `server-b`, register the home instance:

```
"Register server-a as my home instance at http://<server-a-ip>:3001"
```

::: tip Using Tailscale?
Use Tailscale IPs or MagicDNS names for reliable cross-network connectivity:
```
"Register server-b as a satellite instance at http://server-b:3001"
```
:::

## Step 7: Verify Sync

On either machine:

```
"Show instance status"
```

You should see both instances listed with "online" status. Now test sync:

```
# On server-a
"Remember that multi-device sync is working"

# On server-b (wait a few seconds)
"Search memories for multi-device sync"
```

The memory stored on `server-a` should appear on `server-b`.

## Step 8: Test Federation

Federation lets you call tools on the remote instance:

```
# On server-b
"Search all instances for project notes"
```

This queries both the local database and `server-a`'s database, merging results.

## Troubleshooting

### Instances show "offline"

- Verify both gateways are running: check `http://<ip>:3001/health`
- Check network connectivity: `curl http://<ip>:3001/health` from the other machine
- If using Tailscale, verify both machines are on the same tailnet: `tailscale status`

### Identity mismatch error during registration

- Re-run `npm run identity` on both machines and confirm the Crow IDs match
- If they differ, re-export from the home instance and re-import on the satellite

### Memories not syncing

- Check that both gateways have been running since registration — sync starts when the gateway process connects
- Look at gateway logs for sync errors: restart the gateway with `DEBUG=crow:*` for verbose output
- Verify the instances are registered on both sides (registration is bidirectional)

### Sync conflicts

When two instances edit the same memory offline, a conflict is created. Check the Nest dashboard's Instances panel for pending conflicts and resolve them there.

## Next Steps

- [Multi-Instance Guide](../guide/instances) — Full feature overview
- [Instance Architecture](../architecture/instances) — Sync internals and conflict resolution
- [Tailscale Setup](./tailscale-setup) — Secure your cross-network connections
