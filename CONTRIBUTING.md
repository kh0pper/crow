# Contributing to Crow

Thank you for your interest in contributing to Crow! This guide covers everything you need to get started.

## Ways to Contribute

### 1. Add-ons (Easiest way to extend Crow)
Create dashboard panels, MCP server integrations, or skill files that users install with one command: "install the X add-on." Add-ons are the primary way to extend Crow.

**Types:** Dashboard panels, MCP servers, skill files, Docker bundles.

**Guide:** [Creating Add-ons](https://kh0pper.github.io/crow/developers/creating-addons) | [Add-on Registry](https://kh0pper.github.io/crow/developers/addon-registry)

### 2. Skills (No code required)
Create new behavioral prompts that teach the AI workflows. Skills are markdown files — no code required.

**Guide:** [Writing Skills](https://kh0pper.github.io/crow/developers/skills)

### 3. MCP Integrations (Core registry)
Add support for new external services (e.g., Linear, Jira, Todoist) to the core server registry.

**Guide:** [Building Integrations](https://kh0pper.github.io/crow/developers/integrations)

### 4. Core Server Tools
Add new MCP tools to crow-memory, crow-research, crow-sharing, crow-storage, or crow-blog servers.

**Guide:** [Core Tools](https://kh0pper.github.io/crow/developers/core-tools)

### 5. Dashboard Panels
Build custom panels for the Crow dashboard. See the panel template in `templates/dashboard-panel.js`.

**Guide:** [Creating Panels](https://kh0pper.github.io/crow/developers/creating-panels)

### 6. Self-Hosted Bundles
Create Docker Compose configurations with curated integration sets or self-hosting add-ons (Ollama, Nextcloud, Immich, etc.). See `bundles/` for examples.

**Guide:** [Bundles](https://kh0pper.github.io/crow/developers/bundles)

## Development Setup

```bash
git clone https://github.com/kh0pper/crow.git
cd crow
npm run setup          # Install dependencies + initialize database
```

### Running Servers

```bash
node servers/memory/index.js    # crow-memory (stdio)
node servers/research/index.js  # crow-research (stdio)
node servers/sharing/index.js   # crow-sharing (stdio)
node servers/gateway/index.js --no-auth  # HTTP gateway (dev mode)
```

### Database

SQLite via `@libsql/client`. Schema in `scripts/init-db.js`. Re-initialize with:

```bash
npm run init-db
```

## Code Conventions

- **ESM modules** — `import`/`export`, no CommonJS
- **Zod schemas** — All MCP tool parameters use Zod with `.max()` constraints
- **FTS safety** — Use `sanitizeFtsQuery()` from `servers/db.js` for FTS5 MATCH queries
- **LIKE safety** — Use `escapeLikePattern()` from `servers/db.js` for LIKE queries
- **No test framework** — Verify servers start without errors: `node servers/<name>/index.js`
- **Server factory pattern** — Tool logic in `server.js`, transport wiring in `index.js`

## Pull Request Process

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/your-feature`
3. Make your changes following the conventions above
4. Test: verify affected servers start without errors
5. Submit a PR using the pull request template

## Submitting Ideas

Not ready to code? Open an issue:
- [Add-on Submission](https://github.com/kh0pper/crow/issues/new?template=addon-submission.md)
- [Integration Request](https://github.com/kh0pper/crow/issues/new?template=integration-request.md)
- [Skill Proposal](https://github.com/kh0pper/crow/issues/new?template=skill-proposal.md)
- [Bug Report](https://github.com/kh0pper/crow/issues/new?template=bug-report.md)

## Community

- [Developer Docs](https://kh0pper.github.io/crow/developers/)
- [Community Directory](https://kh0pper.github.io/crow/developers/directory)
