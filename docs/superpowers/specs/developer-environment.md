# Crow Developer Environment

**Status:** Design
**Date:** 2026-03-14
**Scope:** Advanced setting for building, testing, and publishing add-ons to the Crow ecosystem

## Overview

The Crow Developer Environment is an opt-in mode that surfaces development-specific panels, debug information, and workflow tooling inside the Crow's Nest and gateway. When enabled, developers get hot-reload for panels and skills, a dedicated Developer panel with logs and test results, and a streamlined path from local development to registry submission.

This design covers: (1) how to toggle developer mode, (2) the local development loop for each add-on type, (3) publishing and packaging, (4) sandboxing for third-party code, (5) integration with existing scaffolding tools, and (6) the Developer panel UI.

---

## 1. Developer Mode Toggle

### Setting location

Developer mode is a boolean stored in the `dashboard_settings` table:

```
key: "developer_mode"
value: "true" | "false" (default: "false")
```

The toggle lives in the **Settings** panel under a new "Developer" section, positioned after "Updates" and before "Integrations." It follows the same pattern as existing settings (form POST to `/dashboard/settings`, action `set_developer_mode`).

### What changes when developer mode is on

| Feature | Off (default) | On |
|---------|---------------|-----|
| Developer panel | Hidden from sidebar | Visible at `/dashboard/developer` |
| Panel hot-reload | Off | File watcher on `~/.crow/panels/`, auto-reload on save |
| Skill hot-reload | Off | File watcher on `~/.crow/skills/`, re-index on save |
| Debug overlay | Hidden | Shows MCP tool call latency, memory usage per request |
| Gateway request logging | Standard | Verbose (tool inputs/outputs, timing) |
| Add-on packaging CLI | Available but not surfaced | Linked from Developer panel |
| `X-Crow-Debug` header | Ignored | Returns timing and server metadata in gateway responses |

### Persistence and propagation

The setting persists across gateway restarts via the DB. On startup, the gateway reads `developer_mode` from `dashboard_settings` and sets an in-memory flag (`app.locals.developerMode`). The panel registry checks this flag to decide whether to mount the Developer panel's route. No gateway restart is required to toggle -- the panel registry re-evaluates on each request since external panels are already loaded dynamically.

### Trade-off: restart vs. dynamic toggle

Dynamic toggling avoids the friction of restarting, but means the file watchers must be lazily initialized (start on first Developer panel visit, stop when dev mode is turned off). The alternative -- requiring a restart -- is simpler but breaks the "just flip a switch" experience. We choose lazy initialization because the file watchers are lightweight (chokidar or `fs.watch` on two directories) and the developer audience expects fast iteration.

---

## 2. Local Development Workflow

### 2.1 Panel development

**Current process:** Create a JS file in `~/.crow/panels/`, add its ID to `~/.crow/panels.json`, restart the gateway, check the Crow's Nest.

**Improved process with dev mode:**

1. Developer creates a panel file in `~/.crow/panels/` (or scaffolds one via `npm run create-integration`).
2. Adds the panel ID to `~/.crow/panels.json` (or the scaffolding CLI does it).
3. Opens the Developer panel and clicks "Watch Panels" (or it starts automatically).
4. A file watcher (`fs.watch`) monitors `~/.crow/panels/` for changes.
5. On file change, the panel registry re-imports the modified module using a cache-busting query parameter (`?t=<timestamp>`) on the dynamic `import()` call. This leverages Node's ESM loader behavior where different URLs create separate module instances.
6. The Developer panel shows a toast: "Panel `weather` reloaded" with any import errors.
7. Developer refreshes the panel page in their browser to see the change.

**Why not full browser hot-reload (WebSocket push)?** The Crow's Nest is server-rendered HTML. Adding a WebSocket-based live-reload would require injecting a client-side script into every layout response. This is doable but adds complexity disproportionate to the benefit -- developers are already accustomed to refreshing. We can add WebSocket push as a follow-up if demand exists.

**Error handling:** If a re-imported panel throws during `import()`, the watcher catches the error and:
- Logs it to the Developer panel's error stream
- Keeps the previous working version loaded
- Shows the error inline if the developer navigates to that panel's route

### 2.2 Skill development

Skills are markdown files loaded by Claude on demand. There is no runtime import -- they are read from disk when referenced by the AI.

**Improved process with dev mode:**

1. Developer creates or edits a skill file in `~/.crow/skills/` (user-space) or `skills/` (repo).
2. The file watcher detects the change.
3. The system runs `npm run sync-skills` automatically to update `docs/skills/index.md`.
4. The Developer panel shows: "Skill `pomodoro` updated" with a preview of the frontmatter.
5. Developer can click "Test Skill" to open a prompt template that exercises the skill's trigger patterns.

**Live testing:** The Developer panel provides a "Skill Tester" section that:
- Parses the skill's YAML frontmatter (triggers, tools)
- Lists the trigger phrases defined in `superpowers.md` for that skill
- Shows which MCP tools the skill references and whether they are currently available
- Provides a "Copy test prompt" button that generates a Claude prompt designed to exercise the skill

This is a read-only analysis tool, not a skill execution engine. Actual skill testing still happens through the AI client.

### 2.3 Bundle development

Bundles are Docker Compose configurations with a `manifest.json`.

**Improved process with dev mode:**

1. Developer creates a bundle directory (e.g., `~/.crow/bundles/my-bundle/`) with `manifest.json` and `docker-compose.yml`.
2. The Developer panel's "Bundles" tab lists local bundles with:
   - Manifest validation (required fields, version format, env var completeness)
   - Docker Compose syntax check (`docker compose config` dry-run)
   - Container status (running/stopped/error)
   - Log tail from running containers
3. Developer can start/stop/rebuild containers from the panel (reusing the existing `/dashboard/bundles/api` endpoints).
4. The "Package" button (see Section 3) generates a distributable tarball.

### 2.4 MCP server development

Custom MCP servers follow the factory pattern (`server.js` exports a factory, `index.js` wires stdio transport).

**Improved process with dev mode:**

1. Developer creates their server following the template in `docs/developers/creating-servers.md`.
2. The Developer panel provides a "Server Tester" that:
   - Spawns the server's `index.js` as a child process with stdio transport
   - Sends MCP `initialize` and `tools/list` to verify it starts correctly
   - Displays the tool list with schemas
   - Allows invoking individual tools with JSON input and shows the response
   - Shows stderr output (for debugging)
3. Once validated, the developer registers the server in `~/.crow/mcp-addons.json` (existing mechanism) and the gateway proxies it.

**Resource limits:** The child process is spawned with `{ timeout: 30000 }` for the test harness. Long-running servers are managed by the gateway proxy, which already handles process lifecycle.

---

## 3. Publishing Workflow

### Local to published: the full path

```
Create locally  -->  Test  -->  Validate manifest  -->  Package  -->  Submit
```

### 3.1 Package format

A Crow add-on package is a gzipped tarball (`.tar.gz`) containing:

```
crow-my-addon-1.0.0.tar.gz
  crow-my-addon/
    manifest.json        (required)
    LICENSE              (required)
    README.md            (recommended)
    panel/               (if type includes panel)
    server/              (if type includes mcp-server)
    skills/              (if type includes skill)
    schema/              (optional: init.sql for DB tables)
    docker-compose.yml   (if type is bundle)
```

The tarball root must contain exactly one directory whose name matches the manifest `name` field.

### 3.2 Packaging CLI

A new npm script: `npm run package-addon -- <path-to-addon-dir>`

This script:
1. Reads and validates `manifest.json` (required fields, semver version, component paths exist)
2. Checks that `LICENSE` exists
3. Validates Zod schemas if the add-on includes an MCP server (parses `server.js` for `.tool()` calls -- heuristic, not exhaustive)
4. Strips `node_modules/` and `.git/` from the tarball
5. Outputs `crow-<name>-<version>.tar.gz` in the current directory
6. Prints a summary: name, version, type, component count, tarball size

### 3.3 Versioning

All add-ons use [semver](https://semver.org/):
- MAJOR: Breaking changes to the add-on's tools, schema, or behavior
- MINOR: New features, additional tools, backward-compatible schema changes
- PATCH: Bug fixes, documentation, cosmetic changes

The manifest `version` field is the single source of truth. The packaging CLI rejects non-semver strings.

### 3.4 Submission process

**Option A: Official registry (PR-based)**

1. Developer opens a PR to `kh0pper/crow-addons` adding their add-on entry to `registry.json`
2. PR includes: the `registry.json` entry, a link to the source repository, and a brief description
3. Reviewer checks: manifest validity, security concerns (no credential harvesting, no arbitrary exec), resource requirements accuracy
4. On merge, the add-on appears in the Extensions panel for all users

**Option B: Community store (self-hosted)**

1. Developer creates a GitHub repo with a `registry.json` following the same schema as the official registry
2. Optionally adds a `crow-store.json` with store metadata (name, description, maintainer)
3. Users add the store URL via the Extensions panel's "Community Stores" section (already implemented)
4. Add-ons from community stores show a "Community" badge (already implemented)

**Trade-off:** The PR-based model provides review and trust signals but creates a bottleneck. Community stores are permissionless but shift the trust burden to users. Both paths coexist -- the official registry is curated, community stores are open.

### 3.5 Manifest validation rules

The packaging CLI and the Developer panel both run these checks:

| Field | Rule |
|-------|------|
| `name` | Required, lowercase, hyphens and alphanumeric only, 3-64 chars |
| `version` | Required, valid semver |
| `type` | Required, one of: `panel`, `mcp-server`, `skill`, `bundle` |
| `description` | Required, 10-200 characters |
| `author` | Required, non-empty |
| `license` | Required, valid SPDX identifier |
| `components` | Required, at least one entry, each with `type` and `entry` |
| `components[].entry` | File must exist relative to manifest directory |
| `envVars[].name` | Uppercase with underscores, no spaces |
| `crow.minVersion` | If present, valid semver |

---

## 4. Sandboxing Considerations

### 4.1 Third-party panels

Panels are server-side Node.js code that runs inside the gateway process. This is the highest-trust surface in the add-on system.

**Current situation:** External panels are loaded via dynamic `import()` and execute in the same V8 isolate as the gateway. A malicious panel has full access to the process, filesystem, and database.

**Mitigation layers (prioritized by effort/impact):**

1. **Review gate (immediate, zero implementation):** The official registry requires PR review. Community stores show a prominent warning badge (already implemented). This is the primary defense.

2. **CSP headers (low effort, meaningful defense):** Add `Content-Security-Policy` headers to all dashboard responses. Panels cannot inject external scripts or exfiltrate data via image/fetch to arbitrary origins. This does not protect against server-side abuse but limits what a compromised panel can do client-side.

3. **Panel API surface restriction (medium effort):** Instead of passing the raw `db` handle to panel handlers, provide a scoped API object that only exposes read operations on specific tables. Panels that need writes must declare them in the manifest and the user must approve during installation. This is a meaningful improvement but requires refactoring the handler signature.

4. **Process isolation (high effort, future):** Run each external panel in a separate worker thread or child process, communicating via message passing. This provides real isolation but adds latency and complexity. Not recommended for v1.

**Recommendation for v1:** Layers 1 and 2. The trust model is: official add-ons are reviewed, community add-ons are "install at your own risk" with visible warnings. This matches the model used by VS Code extensions, browser extensions (before sandboxing), and npm packages.

### 4.2 MCP server isolation

MCP servers already run as separate processes (spawned by the gateway's proxy layer or via stdio). This provides natural process-level isolation.

**Additional measures:**

- **Resource limits:** The gateway proxy should set `maxBuffer` on child process stdio (already done: 10MB default). For dev mode testing, the 30-second timeout prevents runaway servers.
- **Environment scoping:** When spawning an add-on MCP server, only pass the env vars declared in its manifest, plus PATH and NODE_PATH. Do not leak the gateway's full `process.env`.
- **Filesystem access:** No sandboxing at the FS level in v1. MCP servers can read/write anywhere the user can. This is consistent with how Claude Code, Cursor, and other MCP hosts work -- the MCP spec does not define a sandboxing layer.
- **Future: seccomp/landlock (Linux):** For Crow OS deployments on dedicated hardware, consider using Linux security modules to restrict MCP server syscalls. This is out of scope for v1 but worth noting in the architecture.

### 4.3 Skill safety

Skills are markdown files read by the AI. They cannot execute code directly. The risk is social engineering: a malicious skill could instruct the AI to exfiltrate data, delete files, or call dangerous tools.

**Mitigations:**

- **Safety guardrails skill:** The existing `safety-guardrails.md` skill defines universal checkpoints for destructive, resource-intensive, and network actions. This applies regardless of which skill triggered the action.
- **Review for official registry:** Skills submitted to the official registry are reviewed for social engineering patterns.
- **No dynamic skill loading from network:** Skills must be installed to disk. The AI cannot be instructed to fetch and load a skill from a URL at runtime.

---

## 5. Integration with Existing Tools

### 5.1 Scaffolding CLI (`scripts/create-integration.js`)

The existing CLI generates code snippets for new integrations (external MCP servers). It outputs text to the console but does not create files.

**Changes for dev mode:**

- Add a `--write` flag that creates the files directly instead of printing snippets. Specifically:
  - Creates `~/.crow/skills/<id>.md` with the skill template
  - Adds the server entry to `~/.crow/mcp-addons.json`
  - Updates `~/.crow/panels.json` if a panel is included
  - Generates a `manifest.json` in a new directory under `~/.crow/dev/<id>/`
- Add add-on type selection: the current CLI only scaffolds `mcp-server` integrations. Extend it to offer `panel`, `skill`, `bundle`, or `bundle` (multi-component) options.
- The Developer panel links to this CLI with a "Scaffold New Add-on" button that shows the command to run.

### 5.2 Gateway panel loader hot-reload

The existing `panel-registry.js` loads external panels once at startup via `loadExternalPanels()`. For hot-reload:

- Add a `reloadPanel(id)` export that re-imports a single panel file with cache busting
- Add a `watchPanels()` export that starts `fs.watch` on `~/.crow/panels/` and calls `reloadPanel` on change
- The gateway calls `watchPanels()` only when `developer_mode` is `"true"` in the DB
- When dev mode is toggled off, call `unwatchPanels()` to close the watcher

The `fs.watch` approach is chosen over `chokidar` to avoid adding a dependency. `fs.watch` is sufficient for single-directory watching and works on Linux (inotify), macOS (kqueue), and Windows.

### 5.3 Developer panel in the Crow's Nest

The Developer panel is a built-in panel (lives in `servers/gateway/dashboard/panels/developer.js`) that is conditionally registered based on the `developer_mode` setting. It is not a third-party panel -- it ships with Crow but is hidden by default.

Registration in `servers/gateway/dashboard/index.js`:

```js
// After registering other panels
if (developerMode) {
  const devPanel = await import("./panels/developer.js");
  registerPanel(devPanel.default);
}
```

---

## 6. Developer Panel Design

### Panel structure

The Developer panel uses a tab-based layout (similar to the Messages panel's AI Chat / Peer Messages tabs):

**Tabs:** Overview | Panels | Skills | Servers | Bundles | Logs

### 6.1 Overview tab

Displays at-a-glance status:

- **Stat cards:** Loaded add-ons (total), panels (count), skills (count), MCP servers (count), bundles (count)
- **Quick actions:** "Scaffold New Add-on" (shows CLI command), "Package Add-on" (shows CLI command), "Open Registry Submission Guide" (link)
- **Recent activity:** Last 10 file change events from the watchers (timestamp, file, action)

### 6.2 Panels tab

Lists all external panels from `~/.crow/panels/`:

| Column | Content |
|--------|---------|
| Name | Panel name from manifest |
| ID | Panel ID |
| Status | Loaded / Error / Not in panels.json |
| Last modified | File mtime |
| Actions | Reload, View errors, Open panel |

Below the table:
- **Error log:** If any panel failed to load, show the error message and stack trace
- **Watcher status:** "Watching `~/.crow/panels/` for changes" with a toggle

### 6.3 Skills tab

Lists skills from `~/.crow/skills/` and `skills/`:

| Column | Content |
|--------|---------|
| Name | From YAML frontmatter |
| Source | User (`~/.crow/skills/`) or Built-in (`skills/`) |
| Triggers | From superpowers.md trigger table |
| Tools referenced | Parsed from skill body |

Below the table:
- **Skill tester:** Select a skill, see its trigger phrases, copy a test prompt
- **Validation:** Warns if a skill references tools that are not currently available

### 6.4 Servers tab

Lists MCP servers from `~/.crow/mcp-addons.json`:

| Column | Content |
|--------|---------|
| Name | Server name |
| Command | Spawn command |
| Status | Running (via proxy) / Stopped / Error |
| Tools | Count from last `tools/list` call |
| Actions | Test, View tools, Restart |

**Server tester:** Select a server, click "Test." The panel spawns it as a child process, sends `initialize` + `tools/list`, and displays:
- Tool list with parameter schemas
- A JSON input field per tool for manual invocation
- Response output (formatted JSON)
- stderr output

### 6.5 Bundles tab

Lists bundles from `~/.crow/bundles/`:

| Column | Content |
|--------|---------|
| Name | From manifest |
| Status | Running / Stopped / Not installed |
| Containers | Count and state |
| Actions | Start, Stop, Rebuild, View logs, Package |

**Manifest validator:** Shows pass/fail for each validation rule from Section 3.5.

**Docker log viewer:** Streams the last 100 lines of container logs via `docker compose logs --tail 100`.

### 6.6 Logs tab

Aggregated log view across all developer activity:

- Panel reload events
- Skill file changes
- Server test results
- Bundle container events
- Gateway debug output (when dev mode enables verbose logging)

Logs are stored in memory (ring buffer, last 500 entries) and cleared on gateway restart. No database persistence -- these are transient development logs.

### 6.7 Performance profiling

The Overview tab includes a "Performance" section (collapsed by default) showing:

- **Gateway memory:** `process.memoryUsage()` -- RSS, heap used, heap total
- **Per-server memory:** For MCP servers running as child processes, show RSS from `ps` (sampled every 30 seconds)
- **Request timing:** Average response time for the last 100 gateway requests, broken down by route prefix (`/memory/`, `/research/`, `/sharing/`, `/storage/`, `/blog/`, `/router/`)
- **DB query count:** Total queries since gateway start, with a breakdown by table

This data is collected only when dev mode is active. The overhead is minimal: `process.memoryUsage()` is synchronous, child process RSS is sampled infrequently, and request timing uses middleware that records `Date.now()` at request start/end.

### 6.8 Integration test framework

The Developer panel does not include a full test runner (that belongs in the developer's own CI). Instead, it provides **smoke tests** -- automated checks that validate an add-on works in the Crow environment:

For panels:
- Can be imported without errors
- Exports required fields (id, name, route, handler)
- Handler returns a non-empty string when called with mock req/res/layout

For MCP servers:
- Starts without errors
- Responds to `initialize`
- Returns at least one tool from `tools/list`
- Each tool has a valid Zod schema (parseable)

For skills:
- Has valid YAML frontmatter
- Referenced tools exist in the current tool set
- Trigger phrases are present in superpowers.md

For bundles:
- `manifest.json` passes all validation rules
- `docker-compose.yml` is valid (`docker compose config`)
- All declared env vars have descriptions

These smoke tests run on demand (click "Run Tests" in the relevant tab) and display pass/fail with details.

---

## 7. File Layout Summary

New files this design introduces:

```
servers/gateway/dashboard/panels/developer.js   — Developer panel (conditionally registered)
scripts/package-addon.js                        — Add-on packaging CLI
scripts/validate-manifest.js                    — Manifest validation (shared by CLI and panel)
```

Modified files:

```
servers/gateway/dashboard/panel-registry.js     — Add reloadPanel(), watchPanels(), unwatchPanels()
servers/gateway/dashboard/index.js              — Conditional developer panel registration
servers/gateway/dashboard/panels/settings.js    — Add "Developer" section with toggle
scripts/create-integration.js                   — Add --write flag, add-on type selection
```

---

## 8. Implementation Phases

### Phase 1: Foundation
- Developer mode toggle in Settings panel
- Developer panel with Overview and Logs tabs
- Panel hot-reload via `fs.watch`

### Phase 2: Testing tools
- Server tester (spawn + initialize + tools/list + invoke)
- Skill tester (frontmatter parser, trigger lookup, test prompt generator)
- Manifest validator
- Smoke tests for all add-on types

### Phase 3: Packaging and publishing
- `npm run package-addon` CLI
- Bundle tab with Docker log viewer
- Scaffolding CLI enhancements (`--write` flag, type selection)

### Phase 4: Profiling and polish
- Performance section (memory, timing, DB queries)
- CSP headers for dashboard responses
- Environment scoping for MCP server child processes

---

## 9. Open Questions

1. **Should the Developer panel be accessible without the Crow's Nest password when accessed from localhost?** This would ease development on the same machine but weakens the auth boundary. Leaning no -- use the same auth as all other panels.

2. **Should we support remote panel development (edit on laptop, reload on Crow OS device)?** This would require exposing the file watcher over the network or supporting a "push to device" workflow. Deferred -- developers can use SSH/rsync for now.

3. **What is the maximum reasonable add-on tarball size?** The registry should set a limit. Candidates: 10MB (excludes Docker images, which are pulled separately), 50MB (allows bundled assets). Leaning 10MB -- Docker images are never included in tarballs, and large assets should use crow-storage.
