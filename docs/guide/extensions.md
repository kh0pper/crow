---
title: Extensions
---

# Extensions

Crow's functionality can be extended with add-ons installed from the Extensions page. Each extension can include MCP tools, dashboard panels, Docker services, and AI skills.

## Installing Extensions

1. Go to **Extensions** in your Crow's Nest dashboard
2. Browse available extensions by category
3. Click **Install** and configure any required settings (API keys, passwords, etc.)
4. The extension installs automatically — panels appear in the sidebar after a gateway restart

## What Happens on Install

Depending on the extension type:

- **MCP Server** — registers tools accessible to AI chat and Claude Code
- **Bundle** (Docker) — pulls images, starts containers, opens firewall ports
- **Skill** — adds behavioral prompts that guide AI responses
- **Panel** — adds a dashboard page with web UI

Extensions with web UIs are automatically proxied through the gateway (no extra ports to open).

## Removing Extensions

1. Go to **Extensions** in the dashboard
2. Find the installed extension and click **Remove**
3. Containers are stopped, files are removed, firewall ports are closed

## Available Extensions

### AI & Automation
| Extension | Type | Description |
|-----------|------|-------------|
| [Browser Automation](/guide/browser-automation) | Bundle | Stealth browser with VNC, form filling, scraping |
| Ollama | Bundle | Local AI models for embeddings and analysis |
| LocalAI | Bundle | OpenAI-compatible local inference |
| OpenClaw | Bundle | Discord/Telegram/WhatsApp AI bot |
| [CrowClaw](/guide/bot-management) | MCP Server | Bot management — create, deploy, and manage AI bots from the dashboard. BYOAI auto-config, Messages integration, skill deployment. |

### Finance
| Extension | Type | Description |
|-----------|------|-------------|
| [Tax Filing Assistant](/guide/tax-filing) | MCP Server | Federal tax preparation with PDF ingestion |

### Media
| Extension | Type | Description |
|-----------|------|-------------|
| Media Hub | MCP Server | RSS feeds, YouTube, podcasts, TTS, email digests |
| Podcast | Skill | Podcast publishing with iTunes RSS |
| Songbook | Skill | ChordPro charts, transposition, setlists |

### Storage & Productivity
| Extension | Type | Description |
|-----------|------|-------------|
| File Storage (MinIO) | Bundle | S3-compatible file storage |
| Nextcloud | Bundle | File sync via WebDAV |
| Obsidian Vault | MCP Server | Read and search Obsidian notes |

### Smart Home & Gaming
| Extension | Type | Description |
|-----------|------|-------------|
| Home Assistant | MCP Server | Control lights, switches, sensors |
| RoMM | Bundle | Retro game library and emulator |

### Networking
| Extension | Type | Description |
|-----------|------|-------------|
| Tailscale | Bundle | VPN access from any device |

## Extension Web UIs

Some extensions provide web interfaces (VNC viewer, MinIO console, etc.). These are accessed in two ways:

### Proxy Mode (default)
The extension UI is proxied through the Crow gateway at `/proxy/<id>/`. No extra ports or firewall rules needed. Works for simple apps (VNC/noVNC).

**Example**: `/proxy/browser/vnc.html`

### Direct Mode
For SPA apps (React, Vue) that can't work behind a subpath proxy. The extension port is opened in the firewall and served via Tailscale HTTPS.

**Example**: `https://your-machine.ts.net:9001/` (MinIO console)

This is configured automatically during installation — ports are opened and Tailscale HTTPS is set up.

## For Developers

See the [Creating Add-ons](/developers/creating-addons) guide to build your own extensions.
