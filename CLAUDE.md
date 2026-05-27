# CLAUDE.md

Index for working on this repo. Load-bearing rules inline; deep reference is in `docs/`.

## Working with this repo

- **Always commit with a positional path arg**: `git commit <path> -m "..."`, not `git add <path> && git commit -m "..."`. Parallel Claude sessions modify the working tree concurrently; `git add` then a bare `git commit` will sweep in unrelated WIP. Verify with `git show --stat HEAD` after every commit. (See `~/.claude/CLAUDE.md` Learnings 2026-04-14.)
- **Always `git pull --rebase` before pushing a branch** — parallel sessions commonly push to `main` between your fetch and your push.
- **Tests**: no test framework. Verify a server starts cleanly with `node servers/<name>/index.js` (ctrl-C to exit) or `node servers/gateway/index.js --no-auth` for the gateway. Gateway tests live at `servers/gateway/__tests__/`.

## Network exposure invariant

The Crow's Nest dashboard and all private routes (MCP, AI chat, storage, push, instance sync) **must never** be reachable via Tailscale Funnel. Only `/blog`, `/robots.txt`, `/sitemap.xml`, `/.well-known/`, `/favicon.ico`, and `/manifest.json` are public-safe.

Enforced in three layers:
1. Server-side middleware in `servers/gateway/index.js` rejects any request carrying `Tailscale-Funnel-Request` unless the path matches `PUBLIC_FUNNEL_PREFIXES` or `CROW_DASHBOARD_PUBLIC=true`.
2. `isAllowedNetwork()` in `servers/gateway/dashboard/auth.js`.
3. Funnel config — never map `/`; use `tailscale funnel --set-path=/blog`.

If you touch any of these, run `tests/auth-network.test.js`.

## Maintaining CLAUDE.md vs crow.md

| | CLAUDE.md (this file) | crow.md |
|---|---|---|
| Audience | Developers building/extending Crow | The AI operating as Crow |
| Lives in | Git | `crow_context` DB table |
| Updated by | Editing the file directly | `crow_update_context_section` MCP tool |
| Contains | Build rules, architecture pointers, invariants | Identity, memory protocol, session protocol, transparency rules |

When the AI behavior (formatting, routing) changes → `crow.md` only. When the codebase shape (a new server, a new DB column, a new build command) changes → CLAUDE.md.

## Where to find things

- **Build / scripts**: `package.json`, `docker-compose.yml`, `scripts/`.
- **Architecture per server**: `docs/architecture/{memory,research,sharing,storage,blog,gateway,dashboard,orchestrator}-server.md`.
- **DB schema (source of truth)**: `scripts/init-db.js`. FTS5 triggers are inline; if you change a table that has an FTS shadow (`memories`, `sources`, `blog_posts`, `kb_articles`), update the virtual table + insert/update/delete triggers in the same place.
- **Dashboard / Turbo Drive / Turbo Streams**: `docs/architecture/dashboard.md`. Vendored Turbo at `servers/gateway/public/vendor/turbo-8.0.5.umd.js` (pinned). Opt out with systemd drop-in env `CROW_ENABLE_TURBO=0`.
- **MCP config**: `.mcp.json` is generated — run `npm run mcp-config` after editing `.env`. Registry at `scripts/server-registry.js`. Use `npm run mcp-config -- --combined` for a single `crow-core` entry.
- **Tool router (context reduction)**: gateway exposes 7 category tools at `/router/mcp` instead of 49+. Disable with `CROW_DISABLE_ROUTER=1`. See `servers/gateway/router.js`.
- **MCP instructions field**: every server delivers a condensed crow.md via `generateInstructions()` in `servers/shared/instructions.js`. Generated once at startup.
- **Context scope overrides (device_id, project_id)**: handled by `mergeScopedSections()` in `servers/memory/crow-context.js`. Four scope levels, four partial unique indexes in `scripts/init-db.js`.
- **Skills**: source markdown in `skills/`; auto-generated index at `docs/skills/index.md` (rebuild with `npm run sync-skills`).
- **Add-ons / bundles / panels**: `docs/developers/{creating-addons,creating-servers,creating-panels,bundles}.md`. Registry at `registry/add-ons.json`. Installed bundles tracked in `~/.crow/installed.json`.
- **Extending checklists**: `docs/developers/` has the step-by-step for adding a new MCP tool, external MCP server, skill, bundle, panel, or settings section.

## Project spaces (Phase 1 redesign, 2026-05-26)

The legacy `research_projects` table is being phased out. New project work writes to `project_spaces` (one row per shareable space with slug, workspace_dir, storage_prefix, tasks_db_uri, etc.). A forward trigger keeps the two in sync during the transition. Membership / ACL lives in `project_members` (role + per-member capability overrides). Mutation events append to `project_audit_log`. Helper at `servers/shared/project-acl.js`.

## Bot Builder (pi-bots)

`scripts/pi-bots/` runs Gmail-driven bots through `@earendil-works/pi-coding-agent`. Bridge spawns pi per-turn (`--mode rpc`), reads inbound mail, drives pi, sends pi's reply text back. Per-turn timeouts from env (`PIBOT_PROMPT_ACK_TIMEOUT_MS`, `PIBOT_TURN_TIMEOUT_MS`) — local-model deployments tune these via systemd drop-in. Pi is spawned `detached:true` so `close()` can SIGTERM its whole process group (otherwise MCP children leak). Concurrency + age + RSS reaper in `pi_lifecycle.mjs`.

## Documentation Site

`docs/` is VitePress. `cd docs && npm run dev` to run locally. `docs/.vitepress/config.ts` for sidebar/nav.
