# Developer Program

Crow is an open-source AI platform built on the [Model Context Protocol](https://modelcontextprotocol.io) standard. We welcome contributions from developers who want to extend the platform with new integrations, skills, tools, and deployment bundles.

## What is Crow?

Crow gives AI assistants persistent memory, project management with data backends, encrypted P2P sharing, and 20+ service integrations. It works with Claude, ChatGPT, Gemini, Grok, Cursor, and more. Everything runs on open standards — no vendor lock-in.

## How to Contribute

### MCP Integrations

Connect new external services (Linear, Jira, Todoist, etc.) by adding an MCP server entry and a companion skill file.

→ [Building Integrations](./integrations)

### Skills

Write behavioral prompts that teach the AI new workflows. Skills are markdown files — no code required.

→ [Writing Skills](./skills)

### Core Server Tools

Add new MCP tools to the crow-memory, crow-projects, crow-sharing, crow-storage, or crow-blog servers.

→ [Core Tools](./core-tools)

### Platform Capabilities

Learn about the base infrastructure your add-ons can use: persistent media player, scheduling, web search, storage, P2P sharing, and AI chat.

→ [Platform Capabilities](./platform-capabilities)

### Self-Hosted Bundles

Create Docker Compose configurations with curated integration sets for specific use cases (academic, business, creative).

→ [Bundles](./bundles)

## Quick Start

```bash
git clone https://github.com/kh0pper/crow.git
cd crow
npm run setup
```

Then pick a contribution type above and follow the guide.

## Developer Environment (upcoming)

Crow includes a Developer Environment mode that can be enabled in the Settings panel. When active, it surfaces a dedicated Developer panel in the Crow's Nest with hot-reload for panels and skills, an MCP server test harness, manifest validation, bundle log viewing, and smoke tests for all add-on types. It also provides a packaging CLI (`npm run package-addon`) for creating distributable tarballs ready for registry submission.

The Developer Environment is designed to streamline the full add-on lifecycle: scaffold, develop with live feedback, test, package, and publish — all without leaving the Crow platform.

## Community Directory

Browse existing community contributions and submit your own.

→ [Community Directory](./directory)

## Resources

- [CONTRIBUTING.md](https://github.com/kh0pper/crow/blob/main/CONTRIBUTING.md) — Full contributor guidelines
- [GitHub Issues](https://github.com/kh0pper/crow/issues) — Report bugs and propose ideas
- [Architecture Docs](../architecture/) — System design and server APIs
