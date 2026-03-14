---
title: Deployment Tiers
---

# Deployment Tiers

Crow runs on everything from a $15 Raspberry Pi to a cloud server. This guide helps you choose the right hardware and understand what each option can handle.

## Comparison

| Deployment | RAM | Disk | Good For | Limitations |
|---|---|---|---|---|
| Raspberry Pi Zero/3 | 512MB–1GB | 16–32GB SD | Memory + blog, 1–2 light add-ons | No Immich, no Ollama, limited storage |
| Raspberry Pi 4/5 | 2–8GB | 32GB+ SD/SSD | Most add-ons, moderate storage | Ollama only with small models, SSD recommended |
| Free cloud (Render) | 512MB | Ephemeral | Memory + blog, remote access | No Docker add-ons, storage resets on deploy, sleeps after inactivity |
| Oracle Cloud Free Tier | 1–24GB | 50–200GB | Full platform with add-ons | Network egress limits, ARM architecture |
| Home server | 4–32GB | 500GB+ | Everything | Power/network dependent |

---

## Raspberry Pi Zero / Pi 3

**Best for:** Basic memory and blogging, running on minimal power.

These boards have 512MB–1GB of RAM, which is enough to run the core Crow servers but not much else simultaneously. Stick to memory, projects, blog, and sharing — they're lightweight.

**Add-ons to install:** memory, blog, sharing
**Add-ons to skip:** Immich (requires 2GB+ RAM), Ollama (too slow/large), Nextcloud (heavy)

**Storage:** Use a Class 10 or A1-rated SD card and mount the data directory (`~/.crow/data/`) on an external USB drive if you plan to accumulate files. SD cards wear out under constant database writes — an SSD via USB adapter is strongly preferred for anything beyond light use.

**Network:** Tailscale is the easiest way to access your Pi remotely without opening firewall ports. For a public blog, pair Crow with Caddy as a reverse proxy and a custom domain. If you're monetizing a blog or podcast, use Caddy + a custom domain — Tailscale Funnel is intended for personal/hobby use and is not appropriate for commercial traffic.

---

## Raspberry Pi 4 / Pi 5

**Best for:** Running most of the Crow platform at home, including heavier add-ons.

The Pi 4 and Pi 5 are capable machines. With 4–8GB RAM you can run Immich, Nextcloud, and even Ollama with small models (7B parameter range). The Pi 5 is noticeably faster for on-device AI inference.

**Add-ons to install:** All core add-ons. Ollama works with 7B models on 4GB RAM, larger models on 8GB.
**Add-ons to limit:** Immich works fine but needs dedicated disk space for photos. Don't run multiple heavy add-ons simultaneously on a 2GB model.

**Storage:** An SSD connected via USB 3.0 (or the Pi 5's PCIe slot with an M.2 hat) is strongly recommended over SD. SQLite performs much better on SSD, and the reliability difference for a home server is significant.

**Network:** Same as Pi Zero/3 — Tailscale for remote access, Caddy for a public-facing blog or podcast. Monetized content requires a proper domain and reverse proxy, not Tailscale Funnel.

---

## Free Cloud (Render)

**Best for:** Getting Crow accessible from anywhere without managing hardware.

Render's free tier gives you a persistent web service with 512MB RAM. Crow's memory and blog servers run fine within this budget. The catch: the disk is ephemeral — any files uploaded via the storage server are lost when the instance redeploys. Use an external database (Turso) and external object storage (Backblaze B2 or similar) if you want persistence.

**Add-ons to install:** None — Docker-based add-ons are not available on Render's free tier.

**Storage:** Don't rely on local disk. Set `TURSO_DATABASE_URL` for the database and configure an S3-compatible bucket for file storage.

**Inactivity:** Free Render services sleep after 15 minutes of no requests, adding a cold-start delay. Upgrade to a paid plan to keep it always-on.

**Network:** Render provides a public HTTPS URL out of the box. No Tailscale or Caddy needed for the gateway itself. For a monetized blog, point a custom domain at your Render service.

---

## Oracle Cloud Free Tier

**Best for:** A full Crow deployment with storage and add-ons, at no cost.

Oracle's Always Free tier offers up to 4 ARM cores and 24GB RAM across Ampere instances, plus 50–200GB of block storage. This is the most capable free option. You can run the full platform including Immich, Nextcloud, and Ollama with mid-size models.

**Add-ons to install:** All add-ons are viable. Ollama with 13B models works well on 16GB+ configurations.

**Limitations:** ARM architecture — most Docker images support ARM64, but verify before installing anything unusual. Oracle's network egress is free within the cloud network but charged for outbound internet traffic beyond the free allowance (currently 10TB/month, but verify current limits in your Oracle dashboard).

**Storage:** Block volumes persist across reboots. Attach a volume to `~/.crow/data/` for your database and files.

**Network:** Assign an always-free public IP. Use Caddy as a reverse proxy for HTTPS and custom domains. For monetized blogs or podcasts, configure a proper domain — Tailscale Funnel is not appropriate for this use case.

---

## Home Server

**Best for:** Running everything without cloud dependency, maximum storage and performance.

A home server with 8–32GB RAM can run the full Crow platform plus multiple heavy add-ons simultaneously. This is the best option if you have the hardware and want full control.

**Add-ons to install:** All of them. Ollama with large models (30B+) is viable on 16GB+ machines.

**Storage:** No SD card concerns. Use whatever local drives you have. Consider a separate volume for Immich photos if you plan to use it as a primary photo library.

**Network:** Your home internet upload bandwidth is the limiting factor for external visitors. Use Tailscale for secure remote access from your own devices. For a public blog or podcast with a custom domain, run Caddy on the server and configure port forwarding (or use Cloudflare Tunnel to avoid exposing ports directly). Monetized content requires a stable public URL — Tailscale Funnel is not appropriate for this use case.

**Power and uptime:** Home servers go down with power outages and internet disruptions. Consider a UPS if uptime matters. Crow's data lives in SQLite and survives clean shutdowns gracefully.

---

## Add-on Resource Requirements

| Add-on | Min RAM | Min Disk | Notes |
|---|---|---|---|
| Ollama | 2GB+ | 5–50GB | Small models (3B) fit in 2GB; 7B models need 4GB+; 13B+ models need 8GB+ |
| Nextcloud | 512MB | 1GB+ | Plus storage space for your files |
| Immich | 2GB+ | 5GB+ | Plus space for your photo library; ML features need additional RAM |
| Home Assistant | 256MB | 500MB | Lightweight; grows with number of integrations |
| Obsidian | 128MB | Minimal | MCP server only — vault lives on disk |

::: tip
The base Crow platform (memory, projects, sharing, blog, gateway) uses roughly 100–200MB of RAM and minimal disk space beyond your data. Most of your resource budget goes to add-ons.
:::

## Migrating Between Tiers

The migration path is straightforward: back up your `~/.crow/data/` directory using `npm run backup`, set up Crow on the new hardware, and restore your data with `npm run restore`. Your database, files, and identity all travel with you.
