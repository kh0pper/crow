# Crow

[![Tests](https://github.com/kh0pper/crow/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/kh0pper/crow/actions/workflows/test.yml)

Crow is a modular, agentic framework and MCP platform that integrates with the services and AI tools you already use — run on hardware you own, with local or cloud models. It brings persistent memory, research, agents, P2P sharing, and a full self-hosted app ecosystem into one private interface that your AI clients can reach natively.

Built on the open [Model Context Protocol](https://modelcontextprotocol.io) standard. Published by [Maestro Press](https://maestro.press) | [Product Page](https://maestro.press/software/crow-overview/) | [Docs](https://maestro.press/software/crow/)

## Use it two ways — or both at once

As an **agentic framework**, build and run your own agents (the Bot Builder) over email, Discord, and voice — local and operator-gated. As an **MCP platform**, connect Crow to the AI client you already pay for (Claude Code, claude.ai, Cursor, opencode) as a native MCP server.

**It rides your existing subscription as a first-class connector — the supported extension point, not a third-party harness you run instead of your client.**

Both halves share the same memory, projects, files, and capabilities. Build an agent that runs autonomously on email, and your AI client in Claude Code still reaches the same memories that agent built up. That is the design: one system of record, two modes of access.

Crow is open source — developers can build integrations, skills, tools, panels, and bundles for it.

## Your AI, your devices, your data

Your data stays on infrastructure you control. Pair Crow with a **local model** (Ollama or any OpenAI-compatible endpoint on your own machine) and nothing leaves your network; connect a **cloud assistant** (Claude, ChatGPT, Gemini, and others) and only what you choose to send that provider goes out, on your terms. Either way, the system of record is yours.

Privacy is honest here, not absolute marketing. The choice between local and cloud is yours, model by model and use case by use case. Crow supports both without forcing the decision.

## Build and run your own agents

This is the agentic-framework side of Crow. The **Bot Builder** is the spine of Crow's agentic side. An agent (a "bot") is a persona plus the skills, tools, gateways, and permissions you give it, all configured from the dashboard with no config files to hand-edit.

- **Compose an agent**: Give it a name and personality, pick its model, attach skills, and select exactly which tools it can use (Crow's own memory/projects/blog/storage tools, plus any installed extension's tools).
- **Put it on a channel (gateways)**: The same agent can answer **email** (Gmail), chat on **Discord**, or run hands-free on **Meta Ray-Ban glasses** as a fast voice assistant. One agent, the channels you choose.
- **Scoped and permissioned by default**: Each agent only sees the tools you grant it. A `permission_policy` governs what it may do without asking: confirm-before-acting, deny outright, or downgrade outbound sends and publishes to drafts. Voice turns enforce the same policy on the underlying action, not just the surface tool name.
- **Opt-in self-authoring**: If you turn it on (it is off by default), an agent can *draft* a new skill for itself into a confined staging area. Nothing takes effect until you review the text and approve it in the dashboard. Agents cannot grant themselves tools or loosen their own permissions: skills are prompt text only.

Unlike hosted, auto-authoring bot platforms, Crow keeps the engine on your hardware with an operator-approval gate in front of anything an agent writes for itself.

> **[Bot Builder Guide](https://maestro.press/software/crow/guide/bot-builder)** · **[Architecture](https://maestro.press/software/crow/architecture/bot-builder)** · **[Meta Glasses](https://maestro.press/software/crow/guide/meta-glasses)**

## What Crow does

| Capability | What you get |
|---|---|
| **Persistent memory** | Your assistant remembers across sessions and platforms. Full-text search, categories, importance scoring, automatic recall. |
| **Projects & research** | Typed project workflows, multi-format citations (APA, MLA, Chicago), bibliographies, and source verification. Every claim links to a stored source. |
| **Agents (Bot Builder)** | Build personas, attach tools and skills, and run them over Gmail, Discord, or voice. Scoped, permissioned, operator-approved. |
| **Encrypted P2P sharing** | Share memories, projects, and messages directly between Crow users. End-to-end encrypted, no central server, no accounts. |
| **Blog & publishing** | Markdown blog with RSS/Atom feeds, themes, and public URLs. Publish by telling your AI. |
| **File storage** | S3-compatible storage with quotas and presigned URLs. |
| **20+ integrations** | GitHub, Slack, Notion, Gmail, Trello, Discord, Google Workspace, and more, proxied through one authenticated gateway. |
| **Self-hosting add-ons** | Ollama, Nextcloud, Immich, Home Assistant, Jellyfin, and more, installable by asking your AI. |
| **Multi-instance** | Run Crow on several devices and sync the pieces that should travel with you. |

## P2P Sharing & Multi-Instance

Crow is the first AI platform with built-in encrypted peer-to-peer sharing. No cloud middleman, no accounts to create, just your Crow ID.

Crow spans your devices, pulling multiple instances into one private interface — access and control all of your connected instances from the open-source Android app, an installable iPhone web app (no App Store needed), or from the dashboard in any browser.

- **Share memories and projects**: Send a memory or an entire project space to a friend's Crow, encrypted end-to-end.
- **Collaborate on project spaces**: Project spaces have members, roles (owner / editor / viewer / guest), and per-member capability overrides. Clone-share delivers a one-shot snapshot today; live one-way subscription is a planned follow-on.
- **Encrypted messaging**: Send messages between Crow users via the Nostr protocol with full sender anonymity.
- **Works offline**: Shares queue up and deliver when both peers are online. Peer relays handle async delivery.
- **Zero trust**: No central server sees your data. Invite codes, safety numbers, and NaCl encryption throughout.

> *"Clone my project to Alice as a viewer"* and that is it. Crow handles the cryptography, discovery, and bundle assembly.

Learn more: **[Sharing Guide](https://maestro.press/software/crow/guide/sharing)** · **[Architecture](https://maestro.press/software/crow/architecture/sharing-server)**

## Crow for your field

The same framework points in very specific directions depending on what you do. Each cut below describes capabilities Crow ships today.

- **Education**: A private AI workspace for students, teachers, and researchers. Crow remembers your work across sessions, manages sources with real citations and bibliographies, and connects to course tools and public datasets. Built for FERPA-sensitive settings, your data stays on infrastructure you control.
- **Law**: A self-hosted agentic assistant for legal work: matter organization, document research, and citation tracking, with privileged material kept on hardware you own. No third-party AI vendor sees the file.
- **Home entertainment**: Turn a home server into an agentic hub for your media. Voice-controlled music and video across your devices, even your glasses, drawing on your own library. Your collection, your rules, nothing tracking your habits.
- **Enterprise**: A self-hosted agentic platform for teams that handle regulated data. Build internal assistants, connect the tools your team already uses, and keep every byte inside your own network, with operator-approval gates on anything an agent does.

## As an MCP Platform

Crow connects to the AI clients you already use as a native MCP server — not a middleware layer, not a plugin harness. Install once, and your AI client reaches Crow's full capability surface through the protocol it was built for.

### Works With

| Claude | ChatGPT | Gemini | Grok | Cursor | Windsurf | Cline | Claude Code |
|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| Web, Mobile, Desktop | Apps/Connectors | CLI, AI Studio | Remote MCP | IDE | IDE | VS Code | CLI |

## Crow's Nest

Server-rendered web UI with Dark Editorial design. Password-protected, session-based auth. Built-in panels for the Bot Builder, Messages, Blog, Files, Extensions, and Settings. Third-party panels can be installed from `~/.crow/panels/`.

> **[Crow's Nest Guide](https://maestro.press/software/crow/guide/crows-nest)** · **[Architecture](https://maestro.press/software/crow/architecture/dashboard)**

## AI Chat Gateway (BYOAI)

Use the Crow's Nest as a chat frontend with your own AI provider: OpenAI, Anthropic, Google, Ollama, or any OpenAI-compatible endpoint. Tool calling routes through Crow's MCP servers, so your AI can reach memories, projects, and files during conversations. No API keys leave your server.

> **[Chat Architecture](https://maestro.press/software/crow/architecture/gateway#chat-api)**

## Quick Start

For a guided setup instead of the CLI flows below: the first-run wizard and the connect wizard (Settings → Connections) walk you through initial setup and connecting your first AI client — no config files required.

### Managed Hosting

A pre-configured Crow instance with no setup and no maintenance.

> **[Get managed hosting →](https://maestro.press/hosting/)**

### Oracle Cloud Free Tier (Recommended Free)

A permanent free server that never sleeps, with local SQLite and no external database needed.

1. Create a free [Oracle Cloud](https://cloud.oracle.com) account
2. Launch an Always Free VM.Standard.E2.1.Micro instance (Ubuntu 22.04)
3. Install Crow + Tailscale, create a systemd service
4. Connect from any AI platform

→ **[Full Oracle Cloud guide](https://maestro.press/software/crow/getting-started/oracle-cloud)**

### Desktop (Claude Desktop)

```bash
git clone https://github.com/kh0pper/crow.git && cd crow
npm run setup
npm run desktop-config  # Copy output to Claude Desktop config
```

→ **[Desktop setup guide](https://maestro.press/software/crow/getting-started/desktop-setup)**

### Developer (Claude Code)

```bash
cd crow
npm run setup
claude  # Loads .mcp.json + CLAUDE.md automatically
```

→ **[Claude Code guide](https://maestro.press/software/crow/platforms/claude-code)**

### Raspberry Pi / Self-Hosted (Crow OS)

```bash
curl -fsSL https://raw.githubusercontent.com/kh0pper/crow/main/scripts/crow-install.sh | bash
crow status
```

Installs Crow as a persistent service with the `crow` CLI for managing bundles and updates. Supports Raspberry Pi, Debian, and Ubuntu.

→ **[Full setup guide](https://maestro.press/software/crow/getting-started/full-setup)**

More paths (Google Cloud, Docker, full self-host) — [full getting-started guide](https://maestro.press/software/crow/getting-started/).

## Crow OS & Self-Hosting

Crow is also an all-in-one self-hosted home server. Install apps from an app store — file sync, photos, smart home, media, local AI — the way you would on any home server. The difference: because every app installs as a bundle, what you self-host is not just an app, it is a capability your agents and AI clients can use.

A **bundle** is the unit of capability: a service plus its MCP tools plus its skills. Install it once and it is available everywhere you use Crow — your agents, your connected AI clients, and the dashboard (Crow's Nest).

Crow OS turns a Raspberry Pi or any Debian machine into a personal AI server. The `crow` CLI manages the platform and installable add-on bundles:

- **`crow status`**: Platform health, identity, and resource usage
- **`crow bundle install <id>`**: Install add-ons like Ollama, Nextcloud, or Immich
- **`crow bundle start/stop/remove`**: Lifecycle management for bundle containers

Self-hosting add-ons include local AI (Ollama), file sync (Nextcloud), photo management (Immich), smart home (Home Assistant), and knowledge management (Obsidian).

→ **[Crow OS Installer](scripts/crow-install.sh)** · **[Add-on Registry](registry/add-ons.json)**

## Developer Program

Crow is open source, and developers are welcome — build integrations, skills, core tools, panels, and self-hosting bundles for the ecosystem.

- **MCP Integrations**: Connect new services (Linear, Jira, Todoist, etc.)
- **Skills**: Write behavioral prompts that teach the AI new workflows (no code required)
- **Core Tools**: Add MCP tools to crow-memory, crow-projects, crow-sharing, crow-storage, or crow-blog
- **Self-Hosted Bundles**: Create Docker Compose configs for specific use cases

→ **[Developer Docs](https://maestro.press/software/crow/developers/)** · **[Community Directory](https://maestro.press/software/crow/developers/directory)** · **[CONTRIBUTING.md](CONTRIBUTING.md)**

## Documentation

Full documentation at **[maestro.press/software/crow](https://maestro.press/software/crow/)**

- [Bot Builder](https://maestro.press/software/crow/guide/bot-builder): Build agents with personas, tools, skills, gateways, and permissions
- [Meta Glasses](https://maestro.press/software/crow/guide/meta-glasses): Run an agent hands-free on Ray-Ban Meta glasses
- [Managed Hosting](https://maestro.press/hosting/): Pre-configured Crow instance, no setup required
- [Platform Guides](https://maestro.press/software/crow/platforms/): Setup for Claude, ChatGPT, Gemini, Grok, Cursor, Windsurf, Cline
- [Integrations](https://maestro.press/software/crow/integrations/): All 20+ services with API key setup instructions
- [Sharing & Social](https://maestro.press/software/crow/guide/sharing): P2P encrypted sharing, messaging, and collaboration
- [Storage](https://maestro.press/software/crow/guide/storage): S3-compatible file storage with quotas and presigned URLs
- [Blog](https://maestro.press/software/crow/guide/blog): AI-driven publishing with themes, RSS, and public sharing
- [Crow's Nest](https://maestro.press/software/crow/guide/crows-nest): Web UI with panels for the Bot Builder, messages, files, blog, and extensions
- [Architecture](https://maestro.press/software/crow/architecture/): System design, server APIs, gateway details
- [Skills](https://maestro.press/software/crow/skills/): Behavioral prompts for AI workflows
- [Security](SECURITY.md): API key safety, deployment security, and what to do if a key leaks
- [Troubleshooting](https://maestro.press/software/crow/troubleshooting)

## License

MIT
