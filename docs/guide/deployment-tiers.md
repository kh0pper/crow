---
title: Deployment Tiers
---

# Deployment Tiers

Choosing the right hardware for your Crow deployment. This guide helps you understand what you need based on what you want to run.

## What deployment fits me?

Not every Crow setup needs a beefy server. The core platform (memory, projects, blog) runs comfortably on minimal hardware. Add-ons like Ollama and Immich are where resource needs go up.

Here's an overview of common deployment options:

| Deployment | RAM | Disk | Good For | Limitations |
|---|---|---|---|---|
| **Raspberry Pi Zero/3** | 512MB–1GB | 16–32GB SD | Memory + blog, 1–2 light bundles | No Immich, no Ollama, limited storage |
| **Raspberry Pi 4/5** | 2–8GB | 32GB+ SD/SSD | Most bundles, moderate storage | Ollama only with small models, SSD recommended |
| **Free cloud (Render)** | 512MB | Ephemeral | Memory + blog, remote access | No Docker bundles, storage resets on deploy, sleeps after inactivity |
| **Oracle Free Tier** | 1–24GB | 50–200GB | Full platform with bundles | Network egress limits, ARM architecture |
| **Home server** | 4–32GB | 500GB+ | Everything | Power/network dependent |

## Recommendations

**Starting small?** A Raspberry Pi Zero or free Render instance is enough for memory and blog. You can always scale up later — Crow's SQLite database and file storage are portable.

**Want the full experience?** A Raspberry Pi 4 with 4GB+ RAM or a modest home server gives you room to run all the core features plus several add-ons. Pair it with Tailscale for remote access and you have a capable self-hosted setup.

Here are some rules of thumb:

- **If you're on a Pi Zero or Pi 3**, skip Immich and Ollama entirely. Stick with memory, blog, and lightweight bundles like Obsidian or Home Assistant.
- **If you're on free Render**, use memory and blog only. Storage resets on every deploy, and there's no Docker for running bundles.
- **If you want Ollama**, you need at least 4GB RAM — and that's for small models only. Larger models (13B+) need 8GB or more.
- **If you want Immich**, plan for at least 2GB RAM dedicated to it, plus whatever disk space your photo library needs.
- **SSD strongly recommended** over SD cards for any deployment running storage, Immich, or Nextcloud. SD cards wear out under sustained write loads and are significantly slower for database operations.

## Add-on Resource Requirements

Each add-on has its own resource footprint on top of the base Crow platform. Use this table to plan what your hardware can support:

| Add-on | Min RAM | Min Disk | Notes |
|---|---|---|---|
| **Ollama** | 2GB+ | 5–50GB | Depends on model size. Small models (3B) fit in 2GB; 7B models need 4GB+; 13B+ models need 8GB+ |
| **Nextcloud** | 512MB | 1GB+ | Plus storage space for your files. MariaDB recommended for larger installs |
| **Immich** | 2GB+ | 5GB+ | Plus space for your photo library. Machine learning features need additional RAM |
| **Home Assistant** | 256MB | 500MB | Lightweight. Resource use grows with the number of integrations and automations |
| **Obsidian** | 128MB | Minimal | MCP server only — the vault itself lives on disk. Negligible overhead |

::: tip
The base Crow platform (memory, projects, sharing, blog, gateway) uses roughly 100–200MB of RAM and minimal disk space beyond your data. Most of your resource budget goes to add-ons.
:::

## Checking Your System Resources

Before installing add-ons, check what you have available.

**On Linux or Raspberry Pi:**

```bash
# Available memory
free -h

# Disk space
df -h

# CPU info
lscpu | head -15
```

**On macOS:**

```bash
# Available memory
vm_stat | head -5

# Disk space
df -h /
```

## Warning Signs

If your deployment is struggling, you'll see some common symptoms:

- **Slow AI responses** — The gateway or MCP servers are starved for memory. Check if swap usage is high with `free -h`.
- **OOM kills** — The kernel is terminating processes to free memory. Check with `dmesg | grep -i oom`. This means you're running more than your hardware can support.
- **Database errors or corruption** — Often caused by SD card wear or running out of disk space. Check disk usage and consider migrating to an SSD.
- **Docker containers restarting** — A container hit its memory limit or the system ran out of resources. Check with `docker stats`.

## When to Upgrade

Consider scaling up your deployment if:

- You're consistently using more than 80% of your RAM
- Swap usage is high (more than a few hundred MB)
- You want to add Ollama or Immich but don't have the headroom
- Your SD card is showing signs of wear (filesystem errors, slow writes)
- You've outgrown free-tier cloud limits (sleep timeouts, ephemeral storage)

The migration path is straightforward: back up your `~/.crow/data/` directory, set up Crow on the new hardware, and restore your data. Your database, files, and identity all travel with you.
