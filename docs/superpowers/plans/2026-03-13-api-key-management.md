# API Key Management & Integration Setup UX — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users paste API keys directly into the setup page or Crow's Nest Settings panel, silently skip integrations that require missing binaries (e.g., `uvx`), and provide per-integration documentation pages.

**Architecture:** New `env-manager.js` handles .env read/write/sanitize with backup. The server registry gains a `requires` field for binary dependencies. The setup page and Settings panel both POST to `/setup/integrations`, which validates via dashboardAuth + CSRF + env var whitelist, then writes to .env, regenerates .mcp.json, and triggers a restart (systemd) or shows a manual-restart message.

**Tech Stack:** Node.js ESM, Express, existing auth middleware (dashboardAuth, CSRF cookies), VitePress (docs)

**Spec:** `docs/superpowers/specs/2026-03-13-api-key-management-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `scripts/server-registry.js` | Modify | Add `requires` field, `checkRequires()` export, update `loadEnv()` to use shared path resolver |
| `scripts/generate-mcp-config.js` | Modify | Skip servers with missing `requires` binaries |
| `servers/gateway/proxy.js` | Modify | Skip spawning servers with missing `requires` |
| `servers/gateway/env-manager.js` | Create | `.env` read/write/sanitize utility with backup and shared path resolver |
| `servers/gateway/integrations.js` | Modify | Add `docsUrl` field, `requires` arrays, export `requiresMissing` status |
| `servers/gateway/setup-page.js` | Modify | Add POST handler, rebuild UI with collapsible cards grouped by category |
| `servers/gateway/dashboard/panels/settings.js` | Modify | Add Integrations section with collapsible card UI |
| `docs/.vitepress/config.ts` | Modify | Add per-integration sidebar entries |
| `docs/integrations/*.md` | Create (13) | Per-integration setup guide pages |

---

## Chunk 1: Backend Foundation

### Task 1: Add `requires` field and `checkRequires()` to server registry

**Files:**
- Modify: `scripts/server-registry.js`

- [ ] **Step 1: Add `requires` arrays to servers that need external binaries**

In `EXTERNAL_SERVERS`, add `requires` to the four `uvx`-dependent servers:

```js
// arxiv entry — add requires: ["uvx"]
{
  name: "arxiv",
  command: "uvx",
  args: ["arxiv-mcp-server"],
  requires: ["uvx"],
  envKeys: [],
  // ...rest unchanged
},
```

Same for `mcp-research`, `google-workspace`, and `zotero` — add `requires: ["uvx"]`.

- [ ] **Step 2: Add `checkRequires()` helper**

Add after the `resolveEnvValue()` function:

```js
import { execFileSync } from "child_process";

/**
 * Check if a server's required binaries are available.
 * Returns true if all binaries are found, false otherwise.
 */
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

- [ ] **Step 3: Verify the module exports parse correctly**

Run: `node -e "import('./scripts/server-registry.js').then(m => { console.log('checkRequires:', typeof m.checkRequires); console.log('arxiv requires:', m.EXTERNAL_SERVERS.find(s => s.name === 'arxiv').requires); })"`
Expected: `checkRequires: function` and `arxiv requires: [ 'uvx' ]`

- [ ] **Step 4: Commit**

```bash
git add scripts/server-registry.js
git commit -m "feat: add requires field and checkRequires() to server registry

Servers that depend on external binaries (uvx) now declare
a requires array. checkRequires() validates binary availability
before config generation or proxy spawning."
```

---

### Task 2: Skip servers with missing `requires` in config generator

**Files:**
- Modify: `scripts/generate-mcp-config.js`

- [ ] **Step 1: Import `checkRequires` and add binary check**

Add `checkRequires` to the import from `./server-registry.js`.

In the loop over `[...CONDITIONAL_SERVERS, ...EXTERNAL_SERVERS]` (line 69), add a binary check after the env key check:

```js
for (const server of [...CONDITIONAL_SERVERS, ...EXTERNAL_SERVERS]) {
  const missingKeys = server.envKeys.filter((key) => !env[key]);

  if (missingKeys.length > 0) {
    skipped.push({ name: server.name, missing: missingKeys });
    continue;
  }

  // Check binary dependencies
  if (!checkRequires(server)) {
    const bins = server.requires.join(", ");
    skipped.push({ name: server.name, missing: [`binary: ${bins}`] });
    continue;
  }

  // ... rest of existing code
}
```

- [ ] **Step 2: Verify config generation skips uvx servers when uvx is missing**

Run: `node scripts/generate-mcp-config.js --dry-run 2>&1 | grep -E "arxiv|mcp-research|Skipped"`
Expected: arxiv and mcp-research appear in "Skipped" list with "binary: uvx" (on machines without uvx installed)

- [ ] **Step 3: Commit**

```bash
git add scripts/generate-mcp-config.js
git commit -m "feat: skip servers with missing binary deps in mcp-config generator"
```

---

### Task 3: Skip servers with missing `requires` in proxy

**Files:**
- Modify: `servers/gateway/proxy.js`

- [ ] **Step 1: Import `checkRequires` and filter in `initProxyServers()`**

Add to imports:

```js
import { checkRequires } from "../../scripts/server-registry.js";
```

Wait — the proxy uses `INTEGRATIONS` from `integrations.js`, not the server registry directly. The `requires` field needs to be on the INTEGRATIONS entries too (Task 5 handles that). For now, let's add the check using a cross-reference.

Actually, looking at the architecture more carefully: `proxy.js` uses `INTEGRATIONS` from `integrations.js`. The `requires` check should be done using the integration's own `requires` field (which we'll add in Task 5). Let's add the check in `initProxyServers()`:

In `initProxyServers()`, change the filter line:

```js
const configured = INTEGRATIONS.filter((i) => {
  if (!isIntegrationConfigured(i)) return false;
  // Skip servers with missing binary dependencies
  if (i.requires && i.requires.length > 0) {
    const hasBins = i.requires.every((bin) => {
      try {
        execFileSync(bin, ["--version"], { stdio: "pipe", timeout: 5000 });
        return true;
      } catch {
        return false;
      }
    });
    if (!hasBins) return false;
  }
  return true;
});
```

Add `execFileSync` to the import from `"node:child_process"`:

```js
import { execFileSync } from "node:child_process";
```

- [ ] **Step 2: Also add `requiresMissing` to `getProxyStatus()`**

In `getProxyStatus()`, add a binary check to each integration's status:

```js
export function getProxyStatus() {
  return INTEGRATIONS.map((integration) => {
    const configured = isIntegrationConfigured(integration);

    // Check binary dependencies
    let requiresMissing = false;
    if (integration.requires && integration.requires.length > 0) {
      requiresMissing = !integration.requires.every((bin) => {
        try {
          execFileSync(bin, ["--version"], { stdio: "pipe", timeout: 5000 });
          return true;
        } catch {
          return false;
        }
      });
    }

    const entry = connectedServers.get(integration.id);

    return {
      id: integration.id,
      name: integration.name,
      description: integration.description,
      configured,
      requiresMissing,
      requires: integration.requires || [],
      status: entry?.status || (configured ? "pending" : "not_configured"),
      toolCount: entry?.tools?.length || 0,
      error: entry?.error || null,
      envVars: integration.envVars,
      keyUrl: integration.keyUrl,
      keyInstructions: integration.keyInstructions,
      docsUrl: integration.docsUrl || null,
    };
  });
}
```

- [ ] **Step 3: Verify proxy starts without arXiv error**

This requires a gateway restart to test. Defer to integration testing at the end.

- [ ] **Step 4: Commit**

```bash
git add servers/gateway/proxy.js
git commit -m "feat: skip proxy spawning for servers with missing binary deps

Integrations requiring unavailable binaries (e.g., uvx) are
silently skipped instead of showing ENOENT errors."
```

---

### Task 4: Create env-manager.js

**Files:**
- Create: `servers/gateway/env-manager.js`

- [ ] **Step 1: Create the env-manager module**

```js
/**
 * Env Manager — Read/write/sanitize .env files safely.
 *
 * Single source of truth for .env file path resolution.
 * Creates a .env.bak backup before the first modification.
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync, statSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const APP_ROOT = resolve(__dirname, "../..");

/**
 * Resolve the .env file path.
 * Priority: ~/.crow/.env (if exists) → <app-root>/.env
 */
export function resolveEnvPath() {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (home) {
    const crowEnv = resolve(home, ".crow", ".env");
    if (existsSync(crowEnv)) return crowEnv;
  }
  return resolve(APP_ROOT, ".env");
}

/**
 * Read and parse a .env file.
 * Returns { lines, vars } where vars maps key → { lineIndex, value }.
 */
export function readEnvFile(envPath) {
  if (!existsSync(envPath)) {
    return { lines: [], vars: new Map() };
  }
  const content = readFileSync(envPath, "utf8");
  const lines = content.split("\n");
  const vars = new Map();

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    vars.set(key, { lineIndex: i, value });
  }

  return { lines, vars };
}

/**
 * Strip dangerous characters from env values.
 * Prevents line injection into .env files.
 */
export function sanitizeEnvValue(value) {
  return value.replace(/[\r\n\0]/g, "");
}

/**
 * Create a backup of the .env file before modification.
 * Only creates backup if .env.bak doesn't exist or is older than .env.
 */
function ensureBackup(envPath) {
  const bakPath = envPath + ".bak";
  if (!existsSync(envPath)) return;

  let shouldBackup = false;
  if (!existsSync(bakPath)) {
    shouldBackup = true;
  } else {
    const envStat = statSync(envPath);
    const bakStat = statSync(bakPath);
    if (envStat.mtimeMs > bakStat.mtimeMs) {
      shouldBackup = true;
    }
  }

  if (shouldBackup) {
    copyFileSync(envPath, bakPath);
  }
}

/**
 * Write or update an env var in the .env file.
 * Preserves comments, blank lines, and ordering.
 */
export function writeEnvVar(envPath, key, value) {
  ensureBackup(envPath);

  const sanitized = sanitizeEnvValue(value);
  if (!sanitized) {
    // Empty value = removal
    removeEnvVar(envPath, key);
    return;
  }

  const { lines, vars } = readEnvFile(envPath);
  const entry = vars.get(key);

  if (entry) {
    // Update existing line in-place
    lines[entry.lineIndex] = `${key}=${sanitized}`;
  } else {
    // Append to end
    // If file doesn't end with newline, add one first
    if (lines.length > 0 && lines[lines.length - 1] !== "") {
      lines.push("");
    }
    lines.push(`${key}=${sanitized}`);
  }

  writeFileSync(envPath, lines.join("\n"));
}

/**
 * Remove an env var by commenting it out.
 * Preserves the line for user reference.
 */
export function removeEnvVar(envPath, key) {
  ensureBackup(envPath);

  const { lines, vars } = readEnvFile(envPath);
  const entry = vars.get(key);

  if (!entry) return; // Not found, nothing to do

  // Comment out the line
  lines[entry.lineIndex] = `# ${lines[entry.lineIndex]}`;
  writeFileSync(envPath, lines.join("\n"));
}
```

- [ ] **Step 2: Verify the module loads**

Run: `node -e "import('./servers/gateway/env-manager.js').then(m => console.log(Object.keys(m)))"`
Expected: `[ 'APP_ROOT', 'resolveEnvPath', 'readEnvFile', 'sanitizeEnvValue', 'writeEnvVar', 'removeEnvVar' ]`

- [ ] **Step 3: Commit**

```bash
git add servers/gateway/env-manager.js
git commit -m "feat: add env-manager.js for safe .env read/write

Handles path resolution (~/.crow/.env vs app-root/.env),
value sanitization, backup before first write, and
preserves file structure when updating vars."
```

---

### Task 5: Update integrations.js with `docsUrl`, `requires`, and category

**Files:**
- Modify: `servers/gateway/integrations.js`

- [ ] **Step 1: Add `docsUrl`, `requires`, and `category` to each integration entry**

Add these fields to each entry in the `INTEGRATIONS` array. Example for GitHub:

```js
{
  id: "github",
  name: "GitHub",
  description: "Repos, issues, pull requests, code search",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-github"],
  envVars: ["GITHUB_PERSONAL_ACCESS_TOKEN"],
  keyUrl: "https://github.com/settings/tokens",
  keyInstructions: "Generate new token (classic) → select scopes: repo, read:org, read:user → copy the token.",
  docsUrl: "https://kh0pper.github.io/software/crow/integrations/github",
  category: "development",
},
```

Full field additions by integration:

| Integration | `docsUrl` suffix | `category` | `requires` |
|---|---|---|---|
| trello | `/integrations/trello` | `productivity` | (none) |
| canvas-lms | `/integrations/canvas-lms` | `productivity` | (none) |
| github | `/integrations/github` | `development` | (none) |
| brave-search | `/integrations/brave-search` | `development` | (none) |
| slack | `/integrations/slack` | `communication` | (none) |
| notion | `/integrations/notion` | `productivity` | (none) |
| discord | `/integrations/discord` | `communication` | (none) |
| microsoft-teams | `/integrations/microsoft-teams` | `communication` | (none) |
| google-workspace | `/integrations/google-workspace` | `productivity` | `["uvx"]` |
| zotero | `/integrations/zotero` | `productivity` | `["uvx"]` |
| arxiv | `/integrations/arxiv` | `productivity` | `["uvx"]` |
| render | `/integrations/render` | `development` | (none) |

All `docsUrl` values use prefix: `https://kh0pper.github.io/software/crow`

Also add entries for mcp-research, Home Assistant, and Obsidian (they exist in the server registry but are missing from INTEGRATIONS):

```js
{
  id: "mcp-research",
  name: "MCP Research",
  description: "Academic search and research tools",
  command: "uvx",
  args: ["mcp-research"],
  envVars: [],
  requires: ["uvx"],
  keyUrl: null,
  keyInstructions: "No setup required — works out of the box.",
  docsUrl: null,
  category: "productivity",
},
{
  id: "home-assistant",
  name: "Home Assistant",
  description: "Smart home device control",
  command: "npx",
  args: ["-y", "hass-mcp"],
  envVars: ["HA_URL", "HA_TOKEN"],
  keyUrl: "https://www.home-assistant.io/docs/authentication/",
  keyInstructions: "Profile → Security → Long-lived access tokens → Create Token. Also set your Home Assistant URL.",
  docsUrl: "https://kh0pper.github.io/software/crow/integrations/home-assistant",
  category: "productivity",
},
{
  id: "obsidian",
  name: "Obsidian",
  description: "Vault search and knowledge base sync",
  command: "npx",
  args: ["-y", "mcp-obsidian"],
  envVars: ["OBSIDIAN_VAULT_PATH"],
  keyUrl: null,
  keyInstructions: "Set the path to your Obsidian vault directory.",
  docsUrl: "https://kh0pper.github.io/software/crow/integrations/obsidian",
  category: "productivity",
},
```

- [ ] **Step 2: Verify module loads with new fields**

Run: `node -e "import('./servers/gateway/integrations.js').then(m => { const gh = m.INTEGRATIONS.find(i => i.id === 'github'); console.log(gh.docsUrl, gh.category); })"`
Expected: `https://kh0pper.github.io/software/crow/integrations/github development`

- [ ] **Step 3: Commit**

```bash
git add servers/gateway/integrations.js
git commit -m "feat: add docsUrl, category, requires to integration registry

Each integration now has a docs link, category for UI grouping,
and optional binary requirements. Added Home Assistant and
Obsidian entries that were missing from the registry."
```

---

## Chunk 2: Setup Page UI + POST Handler

### Task 6: Add POST handler to setup-page.js

**Files:**
- Modify: `servers/gateway/setup-page.js`

- [ ] **Step 1: Add imports for the POST handler**

Add at the top of `setup-page.js`:

```js
import { execFileSync } from "node:child_process";
import { INTEGRATIONS } from "./integrations.js";
import { APP_ROOT, resolveEnvPath, writeEnvVar, removeEnvVar, sanitizeEnvValue } from "./env-manager.js";
import { parseCookies } from "./dashboard/auth.js";
```

- [ ] **Step 2: Add body parsing middleware export**

The setup page needs `express.urlencoded()` for form parsing. Since the setup page route is mounted directly in `gateway/index.js` (not through the dashboard router), we need to add body parsing there.

Export a new handler function and add the POST route:

```js
/**
 * Express handler for POST /setup/integrations
 * Requires dashboard authentication.
 * CSRF protection is provided by the SameSite=Strict cookie attribute
 * set on the session cookie (see dashboard/auth.js setSessionCookie()).
 * The crow_csrf cookie exists as a defense-in-depth signal — its presence
 * confirms the request originated from a page that received a session.
 */
export async function setupIntegrationsHandler(req, res) {
  // SameSite=Strict on the session cookie is the primary CSRF protection.
  // This check confirms the csrf cookie was set (defense-in-depth).
  const cookies = parseCookies(req);
  const csrfCookie = cookies.crow_csrf;
  if (!csrfCookie) {
    return res.status(403).json({ error: "Missing session context" });
  }

  const { integration_id, action } = req.body;

  // Validate integration exists
  const integration = INTEGRATIONS.find((i) => i.id === integration_id);
  if (!integration) {
    return res.status(400).json({ error: "Unknown integration" });
  }

  const envPath = resolveEnvPath();

  if (action === "remove") {
    // Remove all env vars for this integration
    for (const envVar of integration.envVars) {
      removeEnvVar(envPath, envVar);
    }
  } else {
    // Save — only accept whitelisted env var names
    for (const envVar of integration.envVars) {
      const value = req.body[envVar];
      if (value !== undefined && value !== "") {
        const sanitized = sanitizeEnvValue(value);
        writeEnvVar(envPath, envVar, sanitized);
      }
    }
  }

  // Regenerate .mcp.json (APP_ROOT is the app install directory, where scripts/ lives)
  try {
    execFileSync("node", ["scripts/generate-mcp-config.js"], {
      cwd: APP_ROOT,
      stdio: "pipe",
      timeout: 10000,
    });
  } catch (e) {
    console.warn("[setup] Failed to regenerate .mcp.json:", e.message);
  }

  // Detect systemd
  const isSystemd = !!process.env.INVOCATION_ID;

  res.json({ ok: true, restarting: isSystemd });

  // If systemd, exit after response flushes (systemd restarts automatically)
  if (isSystemd) {
    setTimeout(() => process.exit(0), 500);
  }
}
```

- [ ] **Step 3: Mount the POST route in gateway/index.js**

In `servers/gateway/index.js`, add the import and route:

```js
import { setupPageHandler, setupIntegrationsHandler } from "./setup-page.js";
```

Add URL-encoded body parsing for `/setup` and mount the POST handler (after the existing `app.get("/setup", ...)` line):

```js
import express from "express"; // already imported
// Add after the existing app.get("/setup", setupPageHandler) line:
app.post("/setup/integrations", express.urlencoded({ extended: false }), dashboardAuth, setupIntegrationsHandler);
```

Also add `dashboardAuth` to the import from `./dashboard/auth.js`:

```js
import { dashboardAuth } from "./dashboard/auth.js";
```

Wait — `dashboardAuth` is already used in `dashboard/index.js`. We need to check if it's importable from the gateway level. Looking at the dashboard router, it imports from `./auth.js` (relative to dashboard/). From gateway/index.js, the import path would be:

```js
import { dashboardAuth } from "./dashboard/auth.js";
```

- [ ] **Step 4: Verify POST handler rejects unauthenticated requests**

This requires a running gateway. Defer to integration testing.

- [ ] **Step 5: Commit**

```bash
git add servers/gateway/setup-page.js servers/gateway/index.js
git commit -m "feat: add POST /setup/integrations endpoint

Accepts API keys via form submission, validates against
dashboardAuth + CSRF, whitelists env var names per integration,
sanitizes values, writes to .env, regenerates .mcp.json,
and triggers systemd restart if applicable."
```

---

### Task 7: Rebuild setup page UI with collapsible cards

**Files:**
- Modify: `servers/gateway/setup-page.js`

- [ ] **Step 1: Replace the "Available — Add API Keys to Enable" section**

Replace the entire `notConfigured` and `instructions` sections (lines 296-343 in the current setup-page.js) with collapsible cards grouped by category. The card UI is only shown for self-hosted installs (not Render/hosted).

The new section replaces lines from `${notConfigured.length > 0 ?` through the closing of the "How to Add an Integration" section.

The replacement HTML generates cards grouped by category. Each integration gets a collapsible card with key input fields (for self-hosted) or current instructions (for Render/hosted).

Key elements:
- Cards grouped under "Productivity", "Communication", "Development & Search" headings
- Each card shows status dot (green if configured, gray if not, yellow if requires missing)
- Clicking a card header expands/collapses it
- Expanded view shows: form with password inputs for each env var, "Get your API key" link, "Setup guide" link, Save/Remove buttons
- Integrations with `requiresMissing: true` show a note instead of inputs
- For Render/hosted deploys: show "Add in Render dashboard" instructions (current behavior)

Add CSS for the new card elements at the end of the existing `<style>` block:

```css
.integration-card .card-header { cursor: pointer; user-select: none; }
.integration-card .chevron { margin-left: auto; transition: transform 0.2s; font-size: 18px; color: #86868b; }
.integration-card .chevron.open { transform: rotate(90deg); }
.card-body { padding: 12px 16px 16px; border-top: 1px solid #f0f0f0; }
.field { margin-bottom: 12px; }
.field label { display: block; font-size: 12px; font-weight: 600; color: #86868b; margin-bottom: 4px; font-family: 'SF Mono', Menlo, monospace; }
.field input { width: 100%; padding: 8px 12px; border: 1px solid #d2d2d7; border-radius: 8px; font-size: 14px; }
.card-links { font-size: 13px; margin-bottom: 12px; }
.card-links a { color: #007aff; text-decoration: none; }
.card-links a:hover { text-decoration: underline; }
.card-actions { display: flex; gap: 8px; }
.card-actions button { padding: 8px 16px; border: none; border-radius: 8px; font-size: 14px; font-weight: 500; cursor: pointer; }
.card-actions .btn-save { background: #007aff; color: white; }
.card-actions .btn-save:hover { background: #0056b3; }
.card-actions .btn-remove { background: #f5f5f7; color: #ff3b30; }
.card-actions .btn-remove:hover { background: #fee; }
.category-title { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: #86868b; margin: 16px 0 8px; }
.requires-note { color: #ff9f0a; font-size: 13px; padding: 8px 0; }
#restart-banner { position: fixed; top: 0; left: 0; right: 0; background: #34c759; color: white; padding: 12px; text-align: center; font-weight: 500; z-index: 1000; }
```

Add inline JavaScript after the HTML body for card toggling and form submission:

```html
<script>
function toggleCard(header) {
  const body = header.nextElementSibling;
  const chevron = header.querySelector('.chevron');
  if (body.style.display === 'none' || !body.style.display) {
    body.style.display = 'block';
    chevron.classList.add('open');
  } else {
    body.style.display = 'none';
    chevron.classList.remove('open');
  }
}

document.querySelectorAll('.integration-form').forEach(form => {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    const origText = btn.textContent;
    btn.textContent = 'Saving...';
    btn.disabled = true;

    try {
      const resp = await fetch('/setup/integrations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(new FormData(form)),
      });
      const data = await resp.json();
      if (data.ok) {
        if (data.restarting) {
          document.getElementById('restart-banner').style.display = 'block';
          pollHealth();
        } else {
          // Non-systemd: show success, suggest manual restart
          btn.textContent = 'Saved! Restart gateway to apply.';
          setTimeout(() => { btn.textContent = origText; btn.disabled = false; }, 3000);
        }
      } else {
        btn.textContent = data.error || 'Error';
        setTimeout(() => { btn.textContent = origText; btn.disabled = false; }, 3000);
      }
    } catch (err) {
      btn.textContent = 'Error: ' + err.message;
      setTimeout(() => { btn.textContent = origText; btn.disabled = false; }, 3000);
    }
  });
});

function pollHealth() {
  const status = document.getElementById('restart-status');
  let attempts = 0;
  const interval = setInterval(async () => {
    attempts++;
    try {
      const resp = await fetch('/health', { signal: AbortSignal.timeout(2000) });
      if (resp.ok) {
        clearInterval(interval);
        location.reload();
      }
    } catch {
      if (status) status.textContent = 'Waiting for restart... (' + attempts * 2 + 's)';
    }
    if (attempts > 30) {
      clearInterval(interval);
      if (status) status.textContent = 'Gateway may need manual restart.';
    }
  }, 2000);
}
</script>
```

This is a large UI change. The full implementation will build the HTML string dynamically using the `integrations` data from `getProxyStatus()`, grouping by the `category` field.

The approach:
1. Group integrations by category using a helper
2. For each category, render a section title and cards
3. Each card checks `isRender`/`isHosted` — if true, shows "Add in Render dashboard" text instead of input fields
4. Each card checks `requiresMissing` — if true, shows "Requires Python (uvx)" note instead of inputs

- [ ] **Step 2: Verify the page renders**

Run gateway and visit `/setup`. Verify:
- Connected integrations show green dot, expanded shows "Connected" badge
- Unconfigured integrations grouped by category with collapsible cards
- Cards expand/collapse on click
- Password input fields visible for env vars
- "Get your API key" and "Setup guide" links present

- [ ] **Step 3: Commit**

```bash
git add servers/gateway/setup-page.js
git commit -m "feat: collapsible card UI with API key inputs on setup page

Integrations grouped by category (Productivity, Communication,
Development). Each card expands to show key input fields, API key
links, and setup guide links. Form submits via fetch with health
polling for restart."
```

---

## Chunk 3: Crow's Nest Settings Integration

### Task 8: Add Integrations section to Settings panel

**Files:**
- Modify: `servers/gateway/dashboard/panels/settings.js`

- [ ] **Step 1: Add integration save/remove POST actions**

Add two new action handlers in the POST section (after the existing `change_password` handler):

```js
if (action === "save_integration") {
  const { integration_id } = req.body;
  const { INTEGRATIONS } = await import("../../integrations.js");
  const { resolveEnvPath, writeEnvVar, sanitizeEnvValue } = await import("../../env-manager.js");

  const integration = INTEGRATIONS.find((i) => i.id === integration_id);
  if (!integration) {
    res.redirect("/dashboard/settings?error=unknown_integration");
    return;
  }

  const envPath = resolveEnvPath();
  for (const envVar of integration.envVars) {
    const value = req.body[envVar];
    if (value !== undefined && value !== "") {
      writeEnvVar(envPath, envVar, sanitizeEnvValue(value));
    }
  }

  // Regenerate .mcp.json
  try {
    const { execFileSync } = await import("node:child_process");
    const { APP_ROOT } = await import("../../env-manager.js");
    execFileSync("node", ["scripts/generate-mcp-config.js"], {
      cwd: APP_ROOT,
      stdio: "pipe",
      timeout: 10000,
    });
  } catch (e) {
    console.warn("[settings] Failed to regenerate .mcp.json:", e.message);
  }

  const isSystemd = !!process.env.INVOCATION_ID;
  res.json({ ok: true, restarting: isSystemd });
  if (isSystemd) {
    setTimeout(() => process.exit(0), 500);
  }
  return;
}

if (action === "remove_integration") {
  const { integration_id } = req.body;
  const { INTEGRATIONS } = await import("../../integrations.js");
  const { resolveEnvPath, removeEnvVar } = await import("../../env-manager.js");

  const integration = INTEGRATIONS.find((i) => i.id === integration_id);
  if (!integration) {
    res.redirect("/dashboard/settings?error=unknown_integration");
    return;
  }

  const envPath = resolveEnvPath();
  for (const envVar of integration.envVars) {
    removeEnvVar(envPath, envVar);
  }

  // Regenerate .mcp.json
  try {
    const { execFileSync } = await import("node:child_process");
    const { APP_ROOT } = await import("../../env-manager.js");
    execFileSync("node", ["scripts/generate-mcp-config.js"], {
      cwd: APP_ROOT,
      stdio: "pipe",
      timeout: 10000,
    });
  } catch (e) {
    console.warn("[settings] Failed to regenerate .mcp.json:", e.message);
  }

  const isSystemd = !!process.env.INVOCATION_ID;
  res.json({ ok: true, restarting: isSystemd });
  if (isSystemd) {
    setTimeout(() => process.exit(0), 500);
  }
  return;
}
```

- [ ] **Step 2: Replace the Integrations section HTML**

Replace the existing `integrationsHtml` section with collapsible card UI. Import the proxy status and build cards similar to the setup page, but using the dashboard's component system (escapeHtml, section, etc.).

The integrations section should appear as the first section in the content (before Identity).

Replace the existing integration rows/table with collapsible cards:

```js
// Build integrations card UI
const { INTEGRATIONS: allIntegrations } = await import("../../integrations.js");
const categories = { productivity: [], communication: [], development: [] };
for (const s of proxyStatus) {
  const integration = allIntegrations.find(i => i.id === s.id);
  const cat = integration?.category || "development";
  if (categories[cat]) categories[cat].push({ ...s, integration });
}

let integrationsCards = '';
const categoryLabels = { productivity: "Productivity", communication: "Communication", development: "Development & Search" };

for (const [catKey, label] of Object.entries(categoryLabels)) {
  const items = categories[catKey];
  if (!items || items.length === 0) continue;

  integrationsCards += `<h4 style="color:var(--crow-text-muted);font-size:0.75rem;text-transform:uppercase;letter-spacing:0.5px;margin:1rem 0 0.5rem">${label}</h4>`;

  for (const s of items) {
    const isConfigured = s.status === "connected" || s.configured;
    const dotColor = s.status === "connected" ? "var(--crow-success)" : s.requiresMissing ? "var(--crow-warning, #ff9f0a)" : "var(--crow-text-muted)";
    const envInputs = (s.integration?.envVars || []).map(v =>
      `<div style="margin-bottom:0.5rem">
        <label style="font-size:0.75rem;color:var(--crow-text-muted);font-family:monospace">${escapeHtml(v)}</label>
        <input type="password" name="${escapeHtml(v)}" placeholder="${isConfigured ? '••••••••' : ''}" autocomplete="off"
          style="width:100%;padding:0.5rem;border:1px solid var(--crow-border);border-radius:6px;background:var(--crow-surface);color:var(--crow-text);font-size:0.85rem">
      </div>`
    ).join('');

    const links = [];
    if (s.keyUrl) links.push(`<a href="${s.keyUrl}" target="_blank" style="color:var(--crow-accent)">Get API key</a>`);
    if (s.docsUrl) links.push(`<a href="${s.docsUrl}" target="_blank" style="color:var(--crow-accent)">Setup guide</a>`);
    const linksHtml = links.length > 0 ? `<div style="font-size:0.8rem;margin-bottom:0.75rem">${links.join(' · ')}</div>` : '';

    integrationsCards += `
    <div style="border:1px solid var(--crow-border);border-radius:8px;margin-bottom:0.5rem;overflow:hidden">
      <div onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display==='none'?'block':'none';this.querySelector('.chv').textContent=this.nextElementSibling.style.display==='none'?'▸':'▾'"
           style="display:flex;align-items:center;gap:0.5rem;padding:0.75rem;cursor:pointer;user-select:none">
        <span style="width:8px;height:8px;border-radius:50%;background:${dotColor};flex-shrink:0"></span>
        <div style="flex:1">
          <div style="font-weight:600;font-size:0.9rem">${escapeHtml(s.name)}</div>
          <div style="font-size:0.75rem;color:var(--crow-text-muted)">${escapeHtml(s.description)}</div>
        </div>
        ${s.status === "connected" ? `<span style="font-size:0.7rem;background:var(--crow-success);color:white;padding:2px 8px;border-radius:4px">Connected</span>` : ''}
        <span class="chv" style="color:var(--crow-text-muted)">▸</span>
      </div>
      <div style="display:none;padding:0.75rem;border-top:1px solid var(--crow-border)">
        ${s.requiresMissing ? `<div style="color:var(--crow-warning, #ff9f0a);font-size:0.85rem;padding:0.5rem 0">Requires Python (uvx) — install Python to enable this integration</div>` :
          s.integration?.envVars.length > 0 ? `
          <form class="settings-integration-form" data-id="${escapeHtml(s.id)}">
            <input type="hidden" name="action" value="save_integration">
            <input type="hidden" name="integration_id" value="${escapeHtml(s.id)}">
            ${envInputs}
            ${linksHtml}
            <div style="display:flex;gap:0.5rem">
              <button type="submit" class="btn btn-primary" style="font-size:0.85rem">Save</button>
              ${isConfigured ? `<button type="button" class="btn btn-secondary" style="font-size:0.85rem;color:var(--crow-error, #ff3b30)" onclick="removeIntegration('${escapeHtml(s.id)}')">Remove</button>` : ''}
            </div>
          </form>` :
          `<div style="font-size:0.85rem;color:var(--crow-text-muted)">No configuration needed — works out of the box.</div>`
        }
      </div>
    </div>`;
  }
}
```

Add JavaScript for form handling at the end of the content:

```js
const integrationScript = `
<script>
document.querySelectorAll('.settings-integration-form').forEach(form => {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    btn.textContent = 'Saving...'; btn.disabled = true;
    try {
      const resp = await fetch('/dashboard/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(new FormData(form)),
      });
      const data = await resp.json();
      if (data.ok && data.restarting) {
        document.body.insertAdjacentHTML('afterbegin',
          '<div style="position:fixed;top:0;left:0;right:0;background:var(--crow-success);color:white;padding:12px;text-align:center;z-index:9999">Keys saved! Restarting gateway... <span id="rs">Waiting...</span></div>');
        let att = 0;
        const iv = setInterval(async () => {
          att++;
          try { const r = await fetch('/health', {signal: AbortSignal.timeout(2000)}); if (r.ok) { clearInterval(iv); location.reload(); } }
          catch { document.getElementById('rs').textContent = 'Waiting... (' + (att*2) + 's)'; }
          if (att > 30) { clearInterval(iv); document.getElementById('rs').textContent = 'May need manual restart.'; }
        }, 2000);
      } else if (data.ok) {
        btn.textContent = 'Saved! Restart to apply.';
        setTimeout(() => { btn.textContent = 'Save'; btn.disabled = false; }, 3000);
      }
    } catch (err) {
      btn.textContent = 'Error'; setTimeout(() => { btn.textContent = 'Save'; btn.disabled = false; }, 3000);
    }
  });
});

async function removeIntegration(id) {
  if (!confirm('Remove this integration?')) return;
  const resp = await fetch('/dashboard/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ action: 'remove_integration', integration_id: id }),
  });
  const data = await resp.json();
  if (data.ok && data.restarting) { location.reload(); }
  else if (data.ok) { location.reload(); }
}
</script>`;
```

Then update the `content` variable to include integrations first:

```js
const content = `
  ${successMsg}${errorMsg}
  ${stats}
  ${section("Integrations", integrationsCards + integrationScript, { delay: 200 })}
  ${section("Identity", identityHtml, { delay: 250 })}
  ${section("Blog Settings", blogForm, { delay: 300 })}
  ${section("Contact Discovery", discoveryForm, { delay: 350 })}
  ${section("Change Password", passwordForm, { delay: 400 })}
`;
```

- [ ] **Step 3: Verify Settings panel renders with integration cards**

Run gateway, log into Crow's Nest, navigate to Settings. Verify integration cards appear.

- [ ] **Step 4: Commit**

```bash
git add servers/gateway/dashboard/panels/settings.js
git commit -m "feat: add Integrations section to Crow's Nest Settings panel

Collapsible cards for each integration with inline key inputs,
API key links, and setup guide links. Save/remove actions write
to .env and trigger gateway restart."
```

---

## Chunk 4: Documentation

### Task 9: Create per-integration doc pages

**Files:**
- Create: 13 files in `docs/integrations/`

- [ ] **Step 1: Create all 13 integration doc pages**

Create files following the template from the spec. Each page has: title, description, "What You Get" capabilities, step-by-step Setup, Required Permissions table, Troubleshooting section.

Files to create:

1. `docs/integrations/github.md`
2. `docs/integrations/brave-search.md`
3. `docs/integrations/slack.md`
4. `docs/integrations/notion.md`
5. `docs/integrations/trello.md`
6. `docs/integrations/discord.md`
7. `docs/integrations/google-workspace.md`
8. `docs/integrations/canvas-lms.md`
9. `docs/integrations/microsoft-teams.md`
10. `docs/integrations/zotero.md`
11. `docs/integrations/home-assistant.md`
12. `docs/integrations/obsidian.md`
13. `docs/integrations/render.md`

Each page follows this structure:

```markdown
---
title: <Integration Name>
---

# <Integration Name>

<1-2 sentence description>

## What You Get

- <Capability 1>
- <Capability 2>

## Setup

### Step 1: <Create account / Access settings>
<Instructions with specific UI element names>

### Step 2: <Generate API key>
<Instructions with required scopes/permissions>

### Step 3: Add to Crow
Paste your key in **Crow's Nest** → **Settings** → **Integrations**,
or on the **Setup** page at `/setup`.

## Required Permissions

| Permission/Scope | Why |
|---|---|
| `scope_name` | Description |

## Troubleshooting

### <Common issue>
<Solution>
```

- [ ] **Step 2: Update docs/integrations/index.md**

Add a section with links to individual guide pages after the existing table:

```markdown
## Setup Guides

Detailed step-by-step setup instructions for each integration:

- [GitHub](./github) — Personal access tokens, required scopes
- [Brave Search](./brave-search) — Free API key signup
- [Slack](./slack) — Bot token, OAuth scopes, workspace installation
- [Notion](./notion) — Internal integration setup, page sharing
- [Trello](./trello) — Power-Up API key and token
- [Discord](./discord) — Bot token, message content intent
- [Google Workspace](./google-workspace) — OAuth credentials, API enablement
- [Canvas LMS](./canvas-lms) — Access token, institution URL
- [Microsoft Teams](./microsoft-teams) — Azure AD app registration
- [Zotero](./zotero) — API key and user ID
- [Home Assistant](./home-assistant) — Long-lived access token
- [Obsidian](./obsidian) — Vault path configuration
- [Render](./render) — API key for deployment management
```

- [ ] **Step 3: Commit**

```bash
git add docs/integrations/
git commit -m "docs: add per-integration setup guide pages

13 detailed guides with step-by-step instructions for obtaining
and configuring API keys for each external integration."
```

---

### Task 10: Update VitePress sidebar

**Files:**
- Modify: `docs/.vitepress/config.ts`

- [ ] **Step 1: Add individual integration pages to the sidebar**

Replace the Integrations sidebar section:

```ts
{
  text: 'Integrations',
  items: [
    { text: 'All Integrations', link: '/integrations/' },
    { text: 'GitHub', link: '/integrations/github' },
    { text: 'Brave Search', link: '/integrations/brave-search' },
    { text: 'Slack', link: '/integrations/slack' },
    { text: 'Notion', link: '/integrations/notion' },
    { text: 'Trello', link: '/integrations/trello' },
    { text: 'Discord', link: '/integrations/discord' },
    { text: 'Google Workspace', link: '/integrations/google-workspace' },
    { text: 'Canvas LMS', link: '/integrations/canvas-lms' },
    { text: 'Microsoft Teams', link: '/integrations/microsoft-teams' },
    { text: 'Zotero', link: '/integrations/zotero' },
    { text: 'Home Assistant', link: '/integrations/home-assistant' },
    { text: 'Obsidian', link: '/integrations/obsidian' },
    { text: 'Render', link: '/integrations/render' },
  ],
},
```

- [ ] **Step 2: Commit**

```bash
git add docs/.vitepress/config.ts
git commit -m "docs: add per-integration pages to VitePress sidebar"
```

---

## Chunk 5: Integration Testing

### Task 11: End-to-end verification on black-swan

- [ ] **Step 1: Pull changes to black-swan**

```bash
ssh ubuntu@100.90.185.114 "cd ~/.crow/app && git pull"
```

- [ ] **Step 2: Restart gateway and verify setup page**

```bash
ssh ubuntu@100.90.185.114 "sudo systemctl restart crow-gateway"
```

Visit `http://100.90.185.114:3001/setup`. Verify:
- No arXiv error (uvx is not installed on black-swan)
- Collapsible cards grouped by category
- Cards expand on click
- Input fields visible for each integration
- "Get your API key" and "Setup guide" links work

- [ ] **Step 3: Test POST endpoint without auth**

```bash
curl -X POST http://100.90.185.114:3001/setup/integrations \
  -d "integration_id=github&GITHUB_PERSONAL_ACCESS_TOKEN=test123"
```

Expected: Redirect to `/dashboard/login` (unauthenticated)

- [ ] **Step 4: Test password setup + login flow**

1. Visit `/setup`, set password
2. Log into Crow's Nest
3. Navigate to Settings
4. Verify Integrations section appears with collapsible cards

- [ ] **Step 5: Test saving a key from Settings panel**

1. Expand GitHub card
2. Paste a test token
3. Click Save
4. Verify `.env` is updated on disk:

```bash
ssh ubuntu@100.90.185.114 "grep GITHUB ~/.crow/.env"
```

- [ ] **Step 6: Test removing a key**

1. Click Remove on the GitHub card
2. Verify `.env` shows the variable commented out:

```bash
ssh ubuntu@100.90.185.114 "grep GITHUB ~/.crow/.env"
```
Expected: `# GITHUB_PERSONAL_ACCESS_TOKEN=test123`

- [ ] **Step 7: Verify .env.bak was created**

```bash
ssh ubuntu@100.90.185.114 "ls -la ~/.crow/.env*"
```
Expected: Both `.env` and `.env.bak` present
