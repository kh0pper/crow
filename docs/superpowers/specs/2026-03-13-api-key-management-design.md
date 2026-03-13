# API Key Management & Integration Setup UX

> Spec for simplifying how users add, change, and remove API keys for external integrations — no terminal or file editing required.

## Problem

Users must manually edit `.env` files to configure integrations. The setup page shows which integrations are available and links to where to get API keys, but provides no way to enter them. This is too advanced for non-technical users. Additionally, arXiv and mcp-research show errors when `uvx` is not installed, confusing users who never asked for those services.

## Goals

1. Users can paste API keys directly into the setup page or Crow's Nest Settings panel
2. Keys are saved to `.env`, config is regenerated, and the gateway auto-restarts
3. Servers that require missing binaries (e.g., `uvx`) are silently skipped
4. Each integration has a dedicated documentation page with step-by-step setup instructions
5. No new dependencies or databases — `.env` remains the single source of truth for keys

## Non-Goals

- Hot-reloading env vars without restart (too complex for the payoff)
- Storing keys in the database (introduces sync issues with `.env`)
- Deep key validation/testing before save (lightweight format hints are acceptable)
- Cloud/Render deployments — those use platform-native env var management (Render dashboard). The key-input UI is disabled when `isRender` or `isHosted` is true.

## Architecture

### Data Flow

```
User pastes key → POST /setup/integrations (requires dashboardAuth) →
  validate integration_id, whitelist env var names →
  read .env → sanitize values (strip \r\n\0) → update key lines → write .env →
  regenerate .mcp.json → respond { ok, restarting } →
  process.exit(0) → systemd (Restart=unless-stopped) restarts gateway →
  page polls /health until 200, then refreshes
```

### Security

- The `POST /setup/integrations` endpoint requires **`dashboardAuth`** (session cookie authentication), not just network allowlist. The user must have logged into the Crow's Nest to modify keys.
- **CSRF protection:** The POST endpoint validates the `crow_csrf` double-submit cookie (same pattern used by existing Crow's Nest forms).
- **Env var whitelist:** Only env var names listed in the integration's `envVars` array are accepted. All other keys in the request body are silently ignored. This prevents injection of arbitrary env vars like `NODE_ENV`, `CROW_DASHBOARD_PUBLIC`, or `PATH`.
- **Value sanitization:** All values are stripped of `\r`, `\n`, and `\0` characters before writing to `.env`, preventing line injection attacks.
- Keys are never exposed in HTML — input fields for configured integrations show `••••••••` placeholder, not the actual value.
- The `.env` file permissions are set to `600` by the installer.
- **Backup:** `env-manager.js` creates a `.env.bak` copy before the first write, so users can recover from mistakes.

### Restart Mechanism

The gateway calls `process.exit(0)` after a 500ms delay (to let the HTTP response flush). The systemd service uses `Restart=unless-stopped` (set by the installer script), which restarts on both clean and error exits. The `RestartSec=5` means the gateway will be back up ~7-8 seconds after the exit.

**Important:** This mechanism depends on `Restart=unless-stopped` or `Restart=always` in the systemd unit. `Restart=on-failure` would NOT restart on a clean exit. The installer configures this correctly.

For non-systemd deployments (Docker, manual), the response includes `{ restarting: false, message: "Keys saved. Restart the gateway manually." }` — detected by checking if `process.env.INVOCATION_ID` is set (systemd sets this).

### `.env` Path Resolution

All consumers use a single resolution function (exported from `env-manager.js`):

1. `~/.crow/.env` (if it exists — Crow OS / installer deployments symlink to this)
2. `<app-root>/.env` (fallback — development / manual installs)

The existing `loadEnv()` in `server-registry.js` will be updated to use this shared resolver instead of hardcoding `resolve(ROOT, ".env")`.

## Components

### 1. Server Registry: `requires` Field

**File:** `scripts/server-registry.js`

Add an optional `requires` array to server entries specifying binary dependencies:

```js
{
  name: "arxiv",
  command: "uvx",
  requires: ["uvx"],
  envKeys: [],
  // ...
}
```

Servers that need `requires`:
- `arxiv` → `["uvx"]`
- `mcp-research` → `["uvx"]`
- `google-workspace` → `["uvx"]`
- `zotero` → `["uvx"]`

Add a shared helper:

```js
import { execFileSync } from "child_process";

export function checkRequires(server) {
  if (!server.requires || server.requires.length === 0) return true;
  return server.requires.every((bin) => {
    try {
      execFileSync(bin, ["--version"], { stdio: "pipe", timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  });
}
```

Note: Uses `execFileSync(bin, ["--version"])` directly rather than `which`, since `which` behavior varies across platforms. If the binary doesn't exist, `execFileSync` throws `ENOENT`.

**Consumers:**
- `scripts/generate-mcp-config.js` — skip servers where `checkRequires()` returns false (add to skip message: "needs uvx")
- `servers/gateway/proxy.js` — skip spawning servers where `checkRequires()` returns false (no error log)
- `servers/gateway/integrations.js` — add `requiresMissing` flag to integration status for the setup page to display appropriately

### 2. Integration Registry: `docsUrl` Field

**File:** `servers/gateway/integrations.js`

Add `docsUrl` to each integration entry pointing to its hosted documentation page:

```js
{
  id: "github",
  // ...existing fields...
  docsUrl: "https://kh0pper.github.io/crow/integrations/github",
}
```

Uses absolute URLs to the hosted docs site so links work regardless of whether the VitePress dev server is running locally.

### 3. `.env` Read/Write Utility

**New file:** `servers/gateway/env-manager.js`

```js
export function resolveEnvPath()                   // Shared .env path resolution (see Architecture section)
export function readEnvFile(envPath)                // → { lines: string[], vars: Map<string, { line, value }> }
export function writeEnvVar(envPath, key, value)    // Updates or appends, preserving structure
export function removeEnvVar(envPath, key)          // Comments out the line (prepends #)
export function sanitizeEnvValue(value)             // Strips \r, \n, \0; rejects if still contains =\n patterns
```

Key behaviors:
- **Backup:** Creates `.env.bak` before the first modification if `.env.bak` doesn't already exist or is older than the current `.env`
- Preserves comments, blank lines, and ordering in the `.env` file
- When updating an existing var, replaces the value in-place
- When adding a new var, appends to the end of the file
- When removing, comments out the line (`# GITHUB_PERSONAL_ACCESS_TOKEN=...`) so users can see what was there
- Never writes empty values — if value is empty string, treats as removal
- **Sanitization:** `sanitizeEnvValue()` strips `\r`, `\n`, `\0` from values (matching the existing pattern in `integrations.js`)
- **No file locking:** Race conditions on concurrent writes are an accepted risk — this is a single-user private server where concurrent settings changes are extremely unlikely

### 4. POST Endpoint: `/setup/integrations`

**File:** `servers/gateway/setup-page.js` (add POST handler alongside existing GET handler)

```
POST /setup/integrations
Content-Type: application/x-www-form-urlencoded

Body:
  integration_id: "github"
  GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_xxxxxxxxxxxx"
  action: "save" | "remove"
```

Handler logic:
1. Verify `dashboardAuth` — redirect to `/dashboard/login` if no valid session
2. Validate `integration_id` exists in the INTEGRATIONS registry — 400 if not
3. **Whitelist check:** Only accept env var keys that are in the integration's `envVars` array. Ignore all other body keys.
4. If `action === "remove"`: call `removeEnvVar()` for each of the integration's `envVars`
5. If `action === "save"`: call `sanitizeEnvValue()` then `writeEnvVar()` for each whitelisted env var
6. Regenerate `.mcp.json` by calling `execFileSync("node", ["scripts/generate-mcp-config.js"])`
7. Detect systemd: `const isSystemd = !!process.env.INVOCATION_ID`
8. Respond with JSON `{ ok: true, restarting: isSystemd }`
9. If systemd: schedule `process.exit(0)` after 500ms (systemd `Restart=unless-stopped` brings it back)

### 5. Setup Page UI Changes

**File:** `servers/gateway/setup-page.js`

Replace the "Available — Add API Keys to Enable" section with collapsible cards grouped by category. The key-input UI is **only shown for self-hosted installs** — when `isRender` or `isHosted` is true, the current "add to Render dashboard" instructions remain.

**Category groups:**
- **Productivity:** Trello, Canvas LMS, Google Workspace, arXiv, mcp-research, Zotero, Notion, Home Assistant, Obsidian
- **Communication:** Slack, Discord, Microsoft Teams
- **Development & Search:** GitHub, Brave Search, Filesystem, Render

**Card structure (collapsed):**
```html
<div class="card integration-card" data-id="github">
  <div class="card-header" onclick="toggleCard(this)">
    <span class="status-dot green|gray"></span>
    <div>
      <div class="card-name">GitHub</div>
      <div class="card-desc">Repos, issues, pull requests, code search</div>
    </div>
    <span class="chevron">▸</span>
  </div>
  <!-- Expanded content hidden by default -->
</div>
```

**Card structure (expanded):**
```html
<div class="card-body" style="display:none">
  <form method="POST" action="/setup/integrations" class="integration-form">
    <input type="hidden" name="integration_id" value="github">
    <input type="hidden" name="action" value="save">
    <div class="field">
      <label>GITHUB_PERSONAL_ACCESS_TOKEN</label>
      <input type="password" name="GITHUB_PERSONAL_ACCESS_TOKEN"
             placeholder="ghp_..." autocomplete="off">
    </div>
    <div class="card-links">
      <a href="https://github.com/settings/tokens" target="_blank">Get your API key</a>
      <span>·</span>
      <a href="https://kh0pper.github.io/crow/integrations/github" target="_blank">Setup guide</a>
    </div>
    <div class="card-actions">
      <button type="submit">Save</button>
      <!-- If configured, also show Remove button -->
    </div>
  </form>
</div>
```

**JavaScript (inline):**
- `toggleCard(el)` — toggles `.card-body` visibility and chevron rotation
- Form submit intercepted with `fetch()`. On success, show "Restarting..." banner and poll `/health` every 2 seconds until it returns 200, then refresh the page. This avoids the fragile fixed-delay approach.

**Restart banner:**
```html
<div id="restart-banner" style="display:none">
  Keys saved! Restarting gateway...
  <span id="restart-status">Waiting for restart...</span>
</div>
```

**Handling missing binaries:**
- Integrations with `requiresMissing: true` show a note: "Requires Python (uvx) — install Python to enable this integration" instead of input fields
- No error card in the Errors section

### 6. Crow's Nest Settings Panel Changes

**File:** `servers/gateway/dashboard/panels/settings.js`

Add an "Integrations" section at the top of the Settings panel (before Theme, Blog, Discovery sections) with the same collapsible card UI.

The Settings panel already handles POST actions via `req.body.action`. Add `action === "save_integration"` and `action === "remove_integration"` cases that delegate to the same env-manager logic.

After save, the response is returned via `fetch()` (same as setup page — no redirect). The panel shows the restart banner and polls `/health` until the gateway is back, then refreshes. This avoids the redirect-during-shutdown race condition.

### 7. Documentation: Per-Integration Guide Pages

**New files in `docs/integrations/`:**

| File | Integration |
|------|-------------|
| `github.md` | GitHub |
| `brave-search.md` | Brave Search |
| `slack.md` | Slack |
| `notion.md` | Notion |
| `trello.md` | Trello |
| `discord.md` | Discord |
| `google-workspace.md` | Google Workspace |
| `canvas-lms.md` | Canvas LMS |
| `microsoft-teams.md` | Microsoft Teams |
| `zotero.md` | Zotero |
| `home-assistant.md` | Home Assistant |
| `obsidian.md` | Obsidian |
| `render.md` | Render |

**Template for each page:**

```markdown
---
title: <Integration Name>
---

# <Integration Name>

<1-2 sentence description of what this integration enables.>

## What You Get

- <Bullet list of capabilities/tools>

## Setup

### Step 1: <Create account / Access settings>
<Specific instructions with UI element names>

### Step 2: <Generate API key>
<Specific instructions including required scopes/permissions>

### Step 3: Add to Crow
Paste your key in the **Crow's Nest** → **Settings** → **Integrations** section,
or on the **Setup** page at `/setup`.

## Required Permissions

| Permission/Scope | Why |
|---|---|
| `repo` | Access repository data |

## Troubleshooting

### <Common issue>
<Solution>
```

**VitePress sidebar:** Update `docs/.vitepress/config.ts` to list individual integration pages under the Integrations section.

## Files Changed

| File | Change |
|------|--------|
| `scripts/server-registry.js` | Add `requires` field, `checkRequires()` helper, update `loadEnv()` to use shared path resolver |
| `scripts/generate-mcp-config.js` | Skip servers with missing `requires` binaries |
| `servers/gateway/proxy.js` | Skip spawning servers with missing `requires` |
| `servers/gateway/integrations.js` | Add `docsUrl` field, `requiresMissing` flag, add `requires` to INTEGRATIONS entries |
| `servers/gateway/env-manager.js` | **New** — `.env` file read/write/sanitize utility with backup |
| `servers/gateway/setup-page.js` | Add POST handler (with dashboardAuth + CSRF), collapsible card UI with key inputs |
| `servers/gateway/dashboard/panels/settings.js` | Add Integrations section with same card UI |
| `docs/.vitepress/config.ts` | Add per-integration sidebar entries |
| `docs/integrations/*.md` | **New** — 13 per-integration guide pages |
| `docs/integrations/index.md` | Add links to individual guide pages |

## Testing

1. Fresh install on black-swan: verify setup page shows collapsible cards, no arXiv error
2. Verify POST endpoint rejects requests without valid dashboard session (returns redirect to login)
3. Verify POST endpoint ignores env var names not in the integration's `envVars` array
4. Verify values with `\r\n` characters are sanitized before writing to `.env`
5. Add a GitHub token via setup page: verify `.env` updated, `.env.bak` created, gateway restarts, GitHub shows green
6. Remove the token via Crow's Nest Settings: verify `.env` updated, integration goes gray
7. Verify `uvx`-dependent integrations show "Requires Python" note instead of error
8. Verify doc links work from both setup page and Settings panel
9. Verify the UI is hidden on Render/hosted deployments (shows platform-specific instructions instead)
10. Verify health polling works — page refreshes only after gateway is back up
