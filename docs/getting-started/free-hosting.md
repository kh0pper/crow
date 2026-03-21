# Free Hosting Options

Crow can be deployed for free on several platforms. Here's how they compare:

## Comparison

| Option | Compute | RAM | Storage | Always On? | External DB? | Best For |
|---|---|---|---|---|---|---|
| **[Oracle Cloud](./oracle-cloud)** | 1 OCPU (x86) | 1 GB | 47 GB | Yes | No (local SQLite) | Permanent free cloud server |
| **[Home Server](./home-server)** | Varies | 4-32 GB | Unlimited | Yes | No (local SQLite) | Full control, all add-ons |
| **[Desktop Install](./desktop-install)** | Your PC | Your PC | Your PC | While running | No (local SQLite) | Quick start, single machine |
| **[Managed Hosting](./managed-hosting)** | Shared | Shared | Included | Yes | No | Zero maintenance ($15/mo) |
| **Render** *(legacy)* | Shared | 512 MB | Ephemeral | No (sleeps) | N/A | Not recommended |

## Oracle Cloud Free Tier (Recommended)

Oracle's Always Free tier includes a VM.Standard.E2.1.Micro instance — 1 OCPU and 1 GB RAM. It never sleeps, never expires, and uses local SQLite directly on disk (no external database needed).

> [Full Oracle Cloud Setup Guide →](./oracle-cloud)

## Home Server

Run Crow on a Raspberry Pi, old laptop, or any always-on Linux machine. One-command install, full control over your hardware and data.

> [Home Server Guide →](./home-server)

For Raspberry Pi-specific details (flashing, mDNS, hardware table), see the [Raspberry Pi Guide](./raspberry-pi).

## Desktop Install

Run everything locally on your personal computer. Connects directly to Claude Desktop, Claude Code, Cursor, and more. No cloud needed, but only works on that machine.

> [Desktop Install Guide →](./desktop-install)

## Managed Hosting

Skip all infrastructure. $15/mo or $120/yr gets you a pre-configured Crow instance with automatic updates, daily backups, and SSL — no setup required.

> [Managed Hosting Guide →](./managed-hosting)

## Which Should I Choose?

- **Want a permanent free server?** → [Oracle Cloud](./oracle-cloud). Never sleeps, local SQLite, 47 GB disk.
- **Have a Raspberry Pi or old laptop?** → [Home Server](./home-server). Full control, all add-ons supported.
- **Just want to try Crow?** → [Desktop Install](./desktop-install). Clone, setup, connect — done in 5 minutes.
- **Don't want to manage anything?** → [Managed Hosting](./managed-hosting). Zero maintenance, live in minutes.

::: details Legacy: Render (Archived)
The Render + Turso deployment path is no longer supported. Turso cloud database support has been removed from Crow — multi-device sync is now handled by Hypercore P2P replication with local SQLite.

See the [Cloud Deploy (Legacy)](./cloud-deploy) guide for historical reference.
:::
