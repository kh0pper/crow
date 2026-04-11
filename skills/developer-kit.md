---
name: developer-kit
description: Guide third-party developers through building and submitting Crow extensions to the registry
triggers:
  - developer kit
  - build extension for crow
  - submit add-on
  - create crow extension
  - publish to registry
  - extension SDK
tools:
  - crow-memory
  - filesystem
---

# Developer Kit — Build & Submit Crow Extensions

## When to Activate

- Someone wants to build a new Crow extension (panel, MCP server, skill, or bundle)
- Someone wants to submit an extension to the official Crow registry
- Someone asks about the Crow developer program or extension SDK

**Not this skill:** If the user wants to *install, browse, or remove* an existing extension, use `add-ons.md` instead.

## Phase 1: Plan

Start by helping the developer define what they're building. Ask these questions:

1. **What does your extension do?** Get a clear one-sentence description.
2. **Which type fits?** Use this decision tree:

| Type | Use when | What you get |
|------|----------|--------------|
| `bundle` | Docker services + optional panel/server/skill | Full-stack extension with containers |
| `mcp-server` | Standalone MCP server (API integration, data source) | AI-accessible tools via MCP protocol |
| `skill` | Behavioral prompt only, no code | Workflow guidance for the AI |
| `panel` | Dashboard UI only, no backend | Crow's Nest visual interface |

3. **Naming conventions:**
   - Extension ID: lowercase, hyphens only, max 64 chars (e.g., `my-extension`)
   - Repository name: `crow-<name>` recommended (e.g., `crow-my-extension`)
   - No conflicts with existing add-on IDs (check the Extensions panel or ask)

4. **Category:** Choose one: `ai`, `media`, `productivity`, `storage`, `smart-home`, `networking`, `social`, `gaming`, `data`, `finance`, `infrastructure`, `automation`, `other`

5. **Icon:** Choose one: `brain`, `cloud`, `image`, `book`, `home`, `rss`, `mic`, `music`, `message-circle`, `gamepad`, `archive`, `file-text`, `phone-video`, `bell`, `radio`, `bookmark`, `check-square`, `dollar`, `document`

Store the project context in memory for multi-session development:
```
[crow: storing extension project context — <id>, type: <type>]
```

## Phase 2: Scaffold

Generate the directory structure and `manifest.json` for the chosen type. Offer to create the files.

### Directory structure

```
<extension-id>/
  manifest.json          # Required — metadata and configuration
  LICENSE                # Required for registry submission
  README.md              # Required for registry submission
  panel/<id>.js          # Dashboard panel (if applicable)
  panel/<id>-routes.js   # Express routes for panel API (if needed)
  server/index.js        # MCP server entry (if applicable)
  skills/<id>.md         # Skill file (if applicable)
  docker-compose.yml     # Docker services (bundle type only)
  .env.example           # Environment variable template (if env vars needed)
```

### Manifest templates

Use the correct template based on the chosen type.

#### Bundle (Docker + optional panel/server/skill)

```json
{
  "id": "<id>",
  "name": "<Name>",
  "version": "1.0.0",
  "description": "<one-line description>",
  "type": "bundle",
  "author": "<github-username>",
  "category": "<category>",
  "tags": [],
  "icon": "<icon>",
  "docker": { "composefile": "docker-compose.yml" },
  "panel": "panel/<id>.js",
  "skills": ["skills/<id>.md"],
  "server": {
    "command": "node",
    "args": ["server/index.js"],
    "cwd": "."
  },
  "requires": {
    "env": [],
    "min_ram_mb": 256,
    "min_disk_mb": 100
  },
  "env_vars": [],
  "ports": []
}
```

#### MCP Server

```json
{
  "id": "<id>",
  "name": "<Name>",
  "version": "1.0.0",
  "description": "<one-line description>",
  "type": "mcp-server",
  "author": "<github-username>",
  "category": "<category>",
  "tags": [],
  "icon": "<icon>",
  "server": {
    "command": "node",
    "args": ["server/index.js"],
    "envKeys": []
  },
  "requires": {
    "env": [],
    "min_ram_mb": 128,
    "min_disk_mb": 50
  },
  "env_vars": []
}
```

#### Skill only

```json
{
  "id": "<id>",
  "name": "<Name>",
  "version": "1.0.0",
  "description": "<one-line description>",
  "type": "skill",
  "author": "<github-username>",
  "category": "<category>",
  "tags": [],
  "icon": "<icon>",
  "skills": ["skills/<id>.md"],
  "requires": { "env": [], "min_ram_mb": 0, "min_disk_mb": 1 },
  "env_vars": []
}
```

#### Panel only

```json
{
  "id": "<id>",
  "name": "<Name>",
  "version": "1.0.0",
  "description": "<one-line description>",
  "type": "panel",
  "author": "<github-username>",
  "category": "<category>",
  "tags": [],
  "icon": "<icon>",
  "panel": "panel/<id>.js",
  "requires": { "env": [], "min_ram_mb": 0, "min_disk_mb": 5 },
  "env_vars": []
}
```

### Environment variables

If the extension needs API keys or configuration, define them in `env_vars`:

```json
"env_vars": [
  {
    "name": "MY_API_KEY",
    "description": "API key from the service dashboard",
    "required": true,
    "secret": true,
    "default": ""
  }
]
```

Also list required env var names in `requires.env` so the installer can check them.

## Phase 3: Develop

### Panel development (CRITICAL rules)

Panels are copied to `~/.crow/panels/` when installed. This means relative imports break because the file is no longer in its original directory. Follow these rules without exception:

**1. NEVER use static ESM imports for shared modules**

```js
// WRONG — breaks when installed
import { escapeHtml } from "../../shared/components.js";
```

**2. ALWAYS use dynamic imports with appRoot**

```js
export default {
  id: "<id>",
  name: "<Name>",
  icon: "default",
  route: "/dashboard/<id>",
  navOrder: 50,

  async handler(req, res, { db, layout, lang, appRoot }) {
    const { pathToFileURL } = await import("node:url");
    const { join } = await import("node:path");

    // Import shared components via appRoot
    const componentsPath = join(appRoot, "servers/gateway/dashboard/shared/components.js");
    const { escapeHtml, section, badge, dataTable, formatDate } = await import(pathToFileURL(componentsPath).href);

    // Build your panel content
    const content = section("My Panel", "<p>Hello from my extension!</p>");
    return layout({ title: "<Name>", content });
  },
};
```

**3. Handler signature must include `appRoot`**

```js
async handler(req, res, { db, layout, lang, appRoot })
```

The `appRoot` parameter resolves to the Crow installation root. Use it for all cross-module imports.

**4. Pass shared components via context, not module-level variables**

```js
// Helper functions receive shared components as arguments
async function renderTab(db, { escapeHtml, section, dataTable }) {
  // Use components here
  return section("Data", dataTable(["Column"], []));
}
```

**5. Support both dark and light themes**

Use CSS custom properties from the Crow design system. The shared components (`section`, `dataTable`, `badge`, etc.) handle theming automatically. For custom styles, use:
- `var(--bg-primary)`, `var(--bg-secondary)` for backgrounds
- `var(--text-primary)`, `var(--text-secondary)` for text
- `var(--border-color)` for borders
- `var(--accent)` for accent color

### MCP server development

**Factory pattern (required):**

```js
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function createMyServer(dbPath, options = {}) {
  const server = new McpServer(
    { name: "my-server", version: "1.0.0" },
    { instructions: options.instructions }
  );

  server.tool("my_tool", "Description of what this tool does", {
    param: z.string().max(500).describe("Parameter description"),
  }, async ({ param }) => {
    // Tool implementation
    return { content: [{ type: "text", text: "Result" }] };
  });

  return server;
}
```

**Key rules:**
- Export a factory function, not a server instance
- All Zod string schemas must include `.max()` constraints to prevent abuse
- Include `@modelcontextprotocol/sdk` and `zod` in your `package.json`
- The factory accepts `(dbPath?, options?)` where `options.instructions` is the MCP instructions string

**Entry point (`server/index.js`):**

```js
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMyServer } from "./server.js";

const server = createMyServer();
const transport = new StdioServerTransport();
await server.connect(transport);
```

### Skill file development

```yaml
---
name: my-skill
description: What this skill helps the AI do
triggers:
  - english trigger phrase 1
  - english trigger phrase 2
tools:
  - tool-server-name
---

# My Skill — Title

## When to Activate

- Condition 1
- Condition 2

## Workflows

### Workflow Name

1. Step one
2. Step two
3. Step three
```

**Rules:**
- YAML frontmatter is required: `name`, `description`, `triggers`, `tools`
- Include trigger phrases that cover the main use cases
- Reference the MCP tool server names this skill uses
- Write clear step-by-step workflows the AI can follow

## Phase 4: Test

### Pre-submission checklist

Run through this before submitting:

- [ ] **Manifest is valid JSON** with all required fields (id, name, description, type, version, author, category)
- [ ] **`manifest.panel` is a string path** (e.g., `"panel/my-ext.js"`), never an object
- [ ] **No hardcoded secrets** or credentials anywhere in the code
- [ ] **README.md** with setup instructions and usage examples
- [ ] **LICENSE** file included

### Type-specific tests

**MCP server:**
```bash
# Should start without errors (Ctrl-C to stop)
node server/index.js
```

**Panel:** Copy to the installed location and verify it loads:
```bash
# Copy panel file
cp panel/<id>.js ~/.crow/panels/

# Add to panels.json (create if needed)
# ~/.crow/panels.json should contain: ["<id>"]

# Restart the Crow gateway, then check /dashboard/<id>
```

**Bundle (Docker):**
```bash
# Validate compose file
docker compose config

# Start services
docker compose up -d

# Check logs for errors
docker compose logs
```

**Skill:** Load the skill in a Crow session and verify the trigger phrases activate it correctly.

### Full lifecycle test

1. Install the extension via the Crow's Nest Extensions panel (or the `add-ons.md` workflow)
2. Verify it appears correctly (panel in sidebar, server starts, skill loads)
3. Test core functionality
4. Uninstall
5. Reinstall from scratch to confirm clean lifecycle

## Phase 5: Submit to the Registry

### 1. Prepare your repository

Push your extension to a **public GitHub repository**. Required files:
- `manifest.json`
- `LICENSE` (MIT, Apache-2.0, or similar open-source license)
- `README.md` with setup instructions

### 2. Tag a release

```bash
git tag v1.0.0
git push origin v1.0.0
```

The tag must match the `version` field in your manifest.

### 3. Generate a checksum

```bash
curl -L -o addon.tar.gz https://github.com/<you>/<repo>/archive/v1.0.0.tar.gz
sha256sum addon.tar.gz
```

Save the SHA-256 hash. It will be used to verify download integrity.

### 4. Open a submission issue

Go to the Crow repository and open an issue using the **Add-on Submission** template. Include:

- **Add-on name and ID**
- **Type** (bundle / mcp-server / skill / panel)
- **Repository URL**
- **Version and commit SHA**
- **SHA-256 checksum**
- **Description** of what it does and why it's useful
- **Screenshots** if it includes a panel

### 5. Review process

A maintainer reviews your submission for:

- **Security** — No hardcoded secrets, no network calls without user consent, no file system access outside `~/.crow/`
- **Quality** — Follows Crow conventions (factory pattern, Zod constraints, dynamic imports)
- **Completeness** — Has manifest, license, and documentation
- **Functionality** — Works when installed on a fresh Crow instance

Typical turnaround: **72 hours**. If changes are needed, you'll get feedback on the issue.

### 6. After approval

The maintainer adds your extension to the official registry. It becomes discoverable by all Crow users through the Extensions panel.

To update your extension later: push changes, tag a new version, and open a new submission issue with the updated checksum.

## Common Mistakes

| Mistake | What happens | Prevention |
|---------|-------------|------------|
| Static ESM imports in panel | Panel crashes when installed to `~/.crow/panels/` | Use dynamic imports with `appRoot` |
| `manifest.panel` as object | Install crashes with "path must be string" | Always use a string path: `"panel/<id>.js"` |
| Missing `appRoot` in handler | Can't resolve shared components | Use full signature: `{ db, layout, lang, appRoot }` |
| Helper functions use module-level imports | Imports resolve to wrong path after install | Pass shared components via context object |
| No `.max()` on Zod strings | Potential abuse via oversized inputs | Add `.max()` to every string schema |
| Hardcoded file paths | Breaks on different Crow installations | Use `appRoot` and `~/.crow/` conventions |
| Missing LICENSE | Submission rejected | Include MIT, Apache-2.0, or similar |
| Tag doesn't match manifest version | Checksum verification fails | Keep `git tag` and `manifest.version` in sync |
| Panel only works in dark theme | Looks broken for light-theme users | Use CSS custom properties, test both themes |
