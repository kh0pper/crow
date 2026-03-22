---
name: extension-dev
description: Develop, test, and publish Crow extensions (bundles, panels, MCP servers, skills)
triggers:
  - build extension
  - create bundle
  - develop panel
  - new add-on for crow
  - publish extension
tools:
  - crow-memory
  - filesystem
---

# Extension Development Workflow

## When to Activate

- Building a new Crow extension, bundle, panel, or MCP server
- Modifying an existing extension
- Publishing an extension to the registry

**This skill covers extension-specific development.** For the general quality checklist (docs, CLAUDE.md, superpowers.md updates), follow `crow-developer.md` after development is complete.

**Not this skill:** If the user wants to *install, browse, or remove* an existing extension, use `add-ons.md` instead.

## Phase 1: Scaffold

### Choose a type

| Type | Use when | Directory |
|------|----------|-----------|
| `bundle` | Docker services + optional panel/server/skill | `bundles/<id>/` |
| `mcp-server` | Standalone MCP server + optional panel/skill | `bundles/<id>/` |
| `skill` | Behavioral prompt only, no code | `skills/<id>.md` |
| `panel` | Dashboard panel only, no backend | `bundles/<id>/` |

### Create directory structure

```
bundles/<id>/
  manifest.json          # Required — metadata
  panel/<id>.js           # Dashboard panel (if applicable)
  panel/<id>-routes.js    # Express routes for panel API (if needed)
  server/index.js         # MCP server entry (if applicable)
  skills/<id>.md          # Skill file (if applicable)
  docker-compose.yml      # Docker services (bundle type only)
```

### Write manifest.json

Use the template for your type. **Critical:** `manifest.panel` MUST be a string path (e.g., `"panel/<id>.js"`), never an object.

#### Bundle with panel + server

```json
{
  "id": "my-extension",
  "name": "My Extension",
  "version": "1.0.0",
  "description": "Short description for the Extensions panel",
  "type": "bundle",
  "author": "Crow",
  "category": "productivity",
  "tags": ["relevant", "search", "terms"],
  "icon": "book",
  "panel": "panel/my-extension.js",
  "skills": ["skills/my-extension.md"],
  "server": {
    "command": "node",
    "args": ["server/index.js"],
    "cwd": "."
  },
  "requires": {
    "env": [],
    "min_ram_mb": 128,
    "min_disk_mb": 100
  },
  "env_vars": []
}
```

#### MCP server only

```json
{
  "id": "my-server",
  "name": "My Server",
  "version": "1.0.0",
  "description": "Short description",
  "type": "mcp-server",
  "author": "Crow",
  "category": "productivity",
  "tags": ["relevant", "terms"],
  "icon": "brain",
  "server": {
    "command": "node",
    "args": ["server/index.js"],
    "envKeys": ["MY_API_KEY"]
  },
  "requires": {
    "env": ["MY_API_KEY"],
    "min_ram_mb": 128,
    "min_disk_mb": 50
  },
  "env_vars": [
    { "name": "MY_API_KEY", "description": "API key for the service", "required": true, "secret": true }
  ]
}
```

#### Skill only

```json
{
  "id": "my-skill",
  "name": "My Skill",
  "version": "1.0.0",
  "description": "Short description",
  "type": "skill",
  "author": "Crow",
  "category": "productivity",
  "tags": ["relevant", "terms"],
  "icon": "book",
  "skills": ["skills/my-skill.md"],
  "requires": { "env": [], "min_ram_mb": 0, "min_disk_mb": 1 },
  "env_vars": []
}
```

## Phase 2: Develop

### Panel Rules (CRITICAL)

Panels are copied to `~/.crow/panels/` when installed. Relative imports break because the file is no longer in the repo tree. Follow these rules without exception:

**1. NEVER use static ESM imports for gateway shared modules**

```js
// WRONG — breaks when installed
import { escapeHtml } from "../../../../servers/gateway/dashboard/shared/components.js";
```

**2. ALWAYS use dynamic imports with appRoot**

```js
// CORRECT — works everywhere
export default {
  id: "my-panel",
  name: "My Panel",
  icon: "default",
  route: "/dashboard/my-panel",
  navOrder: 50,

  async handler(req, res, { db, layout, lang, appRoot }) {
    const { pathToFileURL } = await import("node:url");
    const { join } = await import("node:path");
    const { existsSync } = await import("node:fs");

    // Import shared components via appRoot
    const componentsPath = join(appRoot, "servers/gateway/dashboard/shared/components.js");
    const { escapeHtml, section, badge, dataTable, formatDate } = await import(pathToFileURL(componentsPath).href);

    // Resolve bundle server directory (installed vs repo)
    const installedServerDir = join(process.env.HOME || "", ".crow", "bundles", "my-panel", "server");
    const repoServerDir = join(appRoot, "bundles", "my-panel", "server");
    const bundleServerDir = existsSync(installedServerDir) ? installedServerDir : repoServerDir;

    async function importBundleModule(name) {
      return import(pathToFileURL(join(bundleServerDir, name)).href);
    }

    // If helper functions need shared components, pass them as context
    const ctx = { escapeHtml, section, badge, dataTable, formatDate, importBundleModule };
    const tabContent = await renderTab(db, ctx);

    return layout({ title: "My Panel", content: tabContent });
  },
};

// Helper functions receive shared components via context object
async function renderTab(db, { escapeHtml, section, dataTable }) {
  // Use components here
  return section("Data", dataTable(["Col"], []));
}
```

**3. Handler signature must include `appRoot`**

```js
async handler(req, res, { db, layout, lang, appRoot })
```

The `appRoot` parameter resolves to the Crow repo root directory. Use it for all cross-module imports.

### MCP Server Rules

- Use the server factory pattern: export `createXxxServer(dbPath?, options?)` returning `McpServer`
- The server must resolve `@modelcontextprotocol/sdk`. Options:
  - Include a `package.json` with the dependency (installer runs `npm install`)
  - Or import from the gateway's `node_modules` using `appRoot` resolution
- All Zod string schemas should include `.max()` constraints

### Skill File Rules

- YAML frontmatter: `name`, `description`, `triggers` (list), `tools` (list)
- Include both EN and ES trigger phrases in the trigger table
- Reference MCP tool names the skill uses

## Phase 3: Test Locally

### Server

```bash
node bundles/<id>/server/index.js
# Should start without errors (Ctrl-C to stop)
```

### Panel

```bash
# Copy panel to installed location
cp bundles/<id>/panel/<id>.js ~/.crow/panels/

# Add to panels.json if not already listed
# (check with: cat ~/.crow/panels.json)

# Restart the gateway
# Then verify at /dashboard/<id> in the Crow's Nest
```

### Full lifecycle test

1. Install from the Extensions panel in the Crow's Nest
2. Verify panel appears in sidebar and loads correctly
3. Test core functionality (forms, queries, interactions)
4. Uninstall from Extensions panel
5. Reinstall — verify clean install works

## Phase 4: Publish

### Register (follow crow-developer checklist)

1. Add entry to `registry/add-ons.json`
2. Update CLAUDE.md — Skills Reference, any new DB tables or tools
3. Add trigger row to `skills/superpowers.md` (EN + ES)
4. Run `npm run sync-skills` to regenerate `docs/skills/index.md`
5. Update relevant docs pages

### Push to crow-addons repo

The Extensions panel fetches from the remote GitHub registry. Without this step, the extension is invisible to users.

```bash
cd ~/crow-addons
git pull origin main

# Add/update the entry in registry.json
# Copy crow-addon.json to <id>/ subdirectory if needed

git add -A
git commit -m "Add <id> extension"
git push origin main
```

Wait ~5 minutes for GitHub CDN cache to clear.

### Deploy

1. Commit and push changes to the crow repo
2. Restart the gateway on all instances where Crow runs
3. Pull the latest code on remote instances first

### Verify end-to-end

1. Open the Extensions panel — the new extension should appear
2. Install it
3. Confirm panel appears in sidebar (if applicable)
4. Test core functionality
5. Uninstall and reinstall to verify clean lifecycle

## Common Mistakes

| Mistake | Consequence | Prevention |
|---------|-------------|------------|
| Static ESM imports in panel | Panel crashes when installed to `~/.crow/panels/` | Use dynamic imports with `appRoot` |
| `manifest.panel` as object | Install crashes: "path must be string" | Always use string: `"panel/<id>.js"` |
| Forgot crow-addons repo sync | Extension invisible in Extensions panel | Always push to crow-addons after crow repo |
| Forgot gateway restart | Old code still running, changes don't take effect | Restart after any server/panel/route change |
| Panel missing `appRoot` in handler | Can't resolve shared components | Use full signature: `{ db, layout, lang, appRoot }` |
| Helper functions use module-level imports | Imports resolved at wrong path | Pass shared components via context object |
| MCP server missing dependencies | Server fails to start: "Cannot find package" | Include package.json or symlink node_modules |
| No EN + ES triggers in superpowers.md | Skill won't activate for Spanish-speaking users | Always add both language triggers |
