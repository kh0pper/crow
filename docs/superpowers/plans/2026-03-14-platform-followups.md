# Platform Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete 5 remaining platform items: seed data update, MinIO cleanup, per-device context wiring, brand guidelines + design tokens, and blog markdown toolbar + edit form.

**Architecture:** Ops tasks (seed data, MinIO) are done via SSH/MCP. Per-device context is a wiring fix across 7 files. Design tokens extract duplicated CSS into a shared module. Blog toolbar is vanilla JS added to the existing blog panel.

**Tech Stack:** Node.js, Express, SQLite, vanilla JS/CSS, VitePress

---

## Chunk 1: Ops Tasks + Per-Device Context Wiring

### Task 1: Update seed data on grackle

**Files:**
- None (MCP tool call only)

- [ ] **Step 1: Read the current research_protocol section content from init-db.js**

The updated content is in `scripts/init-db.js`, the `research_protocol` contextSection (key: `research_protocol`). Extract the `content` field value.

- [ ] **Step 2: Call crow_update_context_section to push the update**

Use the `crow_update_context_section` MCP tool with:
- `section_key`: `"research_protocol"`
- `content`: the full updated content string from init-db.js (includes source verification rules and multi-format citation guidance)

- [ ] **Step 3: Verify the update**

Call `crow_get_context` and confirm the `research_protocol` section now includes "Source verification" and "multi-format citation" content.

---

### Task 2: Remove native MinIO on grackle

**Files:**
- None (ops task on grackle via SSH)

- [ ] **Step 1: Check how MinIO is running**

```bash
grackle "ps aux | grep minio"
grackle "systemctl list-units --type=service | grep -i minio"
```

Determine: systemd service, manual process, or other.

- [ ] **Step 2: Stop the MinIO process**

If systemd:
```bash
grackle "echo '<SUDO_PASSWORD>' | sudo -S systemctl stop minio 2>/dev/null; echo '<SUDO_PASSWORD>' | sudo -S systemctl disable minio 2>/dev/null"
```

If manual process:
```bash
grackle "kill 1109"
```

- [ ] **Step 3: Comment out MinIO env vars**

SSH to grackle and comment out the `MINIO_*` and `STORAGE_QUOTA_MB` lines in the Crow `.env` file (don't delete — user will re-enable after bundle install).

- [ ] **Step 4: Verify MinIO is stopped**

```bash
grackle "ss -tlnp | grep 9000; ss -tlnp | grep 9001"
```

Expected: no output (ports freed).

---

### Task 3: Wire deviceId in stdio entry points

**Files:**
- Modify: `servers/memory/index.js:22`
- Modify: `servers/research/index.js:22`
- Modify: `servers/sharing/index.js:23`
- Modify: `servers/storage/index.js:22`
- Modify: `servers/blog/index.js:22`

- [ ] **Step 1: Update all 5 stdio index files**

In each file, change:
```javascript
const instructions = await generateInstructions();
```
to:
```javascript
const instructions = await generateInstructions({ deviceId: process.env.CROW_DEVICE_ID });
```

Files and line numbers:
- `servers/memory/index.js:22`
- `servers/research/index.js:22`
- `servers/sharing/index.js:23`
- `servers/storage/index.js:22`
- `servers/blog/index.js:22`

- [ ] **Step 2: Verify servers start**

```bash
timeout 3 node servers/memory/index.js 2>&1 || true
timeout 3 node servers/research/index.js 2>&1 || true
```

Expected: no errors (clean exit on timeout).

- [ ] **Step 3: Commit**

```bash
git add servers/memory/index.js servers/research/index.js servers/sharing/index.js servers/storage/index.js servers/blog/index.js
git commit -m "Wire CROW_DEVICE_ID in all stdio entry points for per-device context"
```

---

### Task 4: Wire deviceId in core server

**Files:**
- Modify: `servers/core/server.js:53`

- [ ] **Step 1: Update generateInstructions call**

At line 53, change:
```javascript
const instructions = await generateInstructions({ dbPath });
```
to:
```javascript
const instructions = await generateInstructions({ dbPath, deviceId: process.env.CROW_DEVICE_ID });
```

- [ ] **Step 2: Verify core server starts**

```bash
timeout 3 node servers/core/index.js 2>&1 || true
```

- [ ] **Step 3: Commit**

```bash
git add servers/core/server.js
git commit -m "Wire CROW_DEVICE_ID in core server for per-device context"
```

---

### Task 5: Wire deviceId in gateway /crow.md endpoint

**Files:**
- Modify: `servers/gateway/index.js:258`

- [ ] **Step 1: Update generateCrowContext call**

At line 258, the `/crow.md` handler calls:
```javascript
const markdown = await generateCrowContext(db, { includeDynamic, platform });
```

Change to:
```javascript
const markdown = await generateCrowContext(db, { includeDynamic, platform, deviceId });
```

The `deviceId` const is already declared at line 347 (`const deviceId = process.env.CROW_DEVICE_ID || null`). Since the handler is async and only runs after module initialization, `deviceId` is in scope. But line 347 is declared *after* line 257 in the source. Fix: move the `deviceId` declaration to before the handler, or read directly from env inside the handler.

Safest approach — read from env directly in the handler:
```javascript
const markdown = await generateCrowContext(db, { includeDynamic, platform, deviceId: process.env.CROW_DEVICE_ID || null });
```

- [ ] **Step 2: Verify gateway starts**

```bash
timeout 5 node servers/gateway/index.js --no-auth 2>&1 | head -8 || true
```

Expected: "Crow's Nest mounted at /dashboard" with no errors.

- [ ] **Step 3: Commit**

```bash
git add servers/gateway/index.js
git commit -m "Wire CROW_DEVICE_ID in gateway /crow.md endpoint"
```

---

### Task 6: Update customization docs — remove "partially implemented" warning

**Files:**
- Modify: `docs/guide/customization.md:144-146`

- [ ] **Step 1: Remove the info block**

Remove lines 144-146:
```markdown
::: info PARTIALLY IMPLEMENTED
The database schema and MCP tools for per-device context are built and working. You can create, update, and delete device-specific context overrides via the AI tools. However, the gateway does not yet automatically apply `CROW_DEVICE_ID` to merge device-specific context into the MCP instructions — that wiring is still in progress. The Crow's Nest Settings panel does not yet have a "Device Context" UI section.
:::
```

Replace with nothing (just delete the block). The section heading and content below it remain.

- [ ] **Step 2: Update the per-device context memory file**

Update `/home/kh0pp/.claude/projects/-home-kh0pp-crow/memory/project_per_device_context.md` to reflect that wiring is now complete.

- [ ] **Step 3: Commit**

```bash
git add docs/guide/customization.md
git commit -m "Remove 'partially implemented' warning from per-device context docs"
```

---

## Chunk 2: Brand Guidelines & Design Tokens

### Task 7: Create shared design tokens module

**Files:**
- Create: `servers/gateway/dashboard/shared/design-tokens.js`
- Modify: `servers/gateway/dashboard/shared/layout.js:141-176`
- Modify: `servers/gateway/routes/blog-public.js:48-85`

- [ ] **Step 1: Create design-tokens.js**

Create `servers/gateway/dashboard/shared/design-tokens.js` exporting two functions:

```javascript
/**
 * Crow Design Tokens — Single source of truth for CSS custom properties.
 * Used by both the Crow's Nest dashboard (layout.js) and public blog (blog-public.js).
 */

/** Google Fonts import URL */
export const FONT_IMPORT = `@import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,wght@0,400;0,500;0,700;1,400&family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,600;0,9..144,700;1,9..144,400&family=JetBrains+Mono:wght@400;500&display=swap');`;

/** CSS custom property definitions for all themes */
export function designTokensCss() {
  return `
  :root {
    --crow-bg-deep: #0f0f17;
    --crow-bg-surface: #1a1a2e;
    --crow-bg-elevated: #2d2d3d;
    --crow-border: #3d3d4d;
    --crow-text-primary: #fafaf9;
    --crow-text-secondary: #a8a29e;
    --crow-text-muted: #78716c;
    --crow-accent: #6366f1;
    --crow-accent-hover: #818cf8;
    --crow-accent-muted: #2d2854;
    --crow-brand-gold: #fbbf24;
    --crow-success: #22c55e;
    --crow-error: #ef4444;
    --crow-info: #38bdf8;
  }

  .theme-light {
    --crow-bg-deep: #fafaf9;
    --crow-bg-surface: #ffffff;
    --crow-bg-elevated: #f5f5f4;
    --crow-border: #e7e5e4;
    --crow-text-primary: #1c1917;
    --crow-text-secondary: #57534e;
    --crow-text-muted: #a8a29e;
    --crow-accent: #4f46e5;
    --crow-accent-hover: #6366f1;
    --crow-accent-muted: #e0e7ff;
  }

  .theme-serif {
    --crow-body-font: 'Fraunces', serif;
  }`;
}
```

- [ ] **Step 2: Update layout.js to import tokens**

In `servers/gateway/dashboard/shared/layout.js`, add import at top:
```javascript
import { FONT_IMPORT, designTokensCss } from "./design-tokens.js";
```

In the `dashboardCss()` function (around line 142), replace the `@import url(...)` line and the `:root { ... }` block and `.theme-light { ... }` block (lines 143-176) with:
```javascript
  return `<style>
  ${FONT_IMPORT}

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  ${designTokensCss()}
  ...rest of existing CSS unchanged...
```

- [ ] **Step 3: Update blog-public.js to import tokens**

In `servers/gateway/routes/blog-public.js`, add import at top (near line 17):
```javascript
import { FONT_IMPORT, designTokensCss } from "../dashboard/shared/design-tokens.js";
```

In the `designCss()` function (line 48), replace the `@import url(...)`, `:root { ... }`, `.theme-light { ... }`, and `.theme-serif { ... }` blocks (lines 52-85) with:
```javascript
  return `
<style>
  ${FONT_IMPORT}

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  ${designTokensCss()}

  body {
    ...rest unchanged...
```

- [ ] **Step 4: Verify both surfaces work**

```bash
timeout 5 node servers/gateway/index.js --no-auth 2>&1 | head -8 || true
```

Expected: gateway starts with no import errors.

- [ ] **Step 5: Commit**

```bash
git add servers/gateway/dashboard/shared/design-tokens.js servers/gateway/dashboard/shared/layout.js servers/gateway/routes/blog-public.js
git commit -m "Extract design tokens into shared module — single source of truth for CSS variables"
```

---

### Task 8: Create brand guidelines doc

**Files:**
- Create: `docs/guide/brand.md`
- Modify: `docs/.vitepress/config.ts`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Write docs/guide/brand.md**

Create the brand guide with sections:
- Design Philosophy (iridescent corvid — dark surfaces, indigo accents, technological warmth)
- Color Palette (table with token name, hex, dark/light values, usage)
- Typography (Fraunces for display/headings, DM Sans for body, JetBrains Mono for code)
- Spacing & Radius (rem scale, border-radius tiers: 4px small, 8px medium, 12px large)
- Themes (dark default, light, serif for blog reading)
- SVG Assets (crow-hero.svg, icon-*.svg in docs/public/, addon logos in logos.js)
- For Developers (point to design-tokens.js as the single source of truth)

- [ ] **Step 2: Add to VitePress sidebar**

In `docs/.vitepress/config.ts`, add to the Guides section:
```typescript
{ text: 'Brand & Design', link: '/guide/brand' },
```

- [ ] **Step 3: Update CLAUDE.md**

Add a note about `design-tokens.js` location in the server factory pattern section.

- [ ] **Step 4: Commit**

```bash
git add docs/guide/brand.md docs/.vitepress/config.ts CLAUDE.md
git commit -m "Add brand guidelines doc and link design tokens in CLAUDE.md"
```

---

## Chunk 3: Blog Markdown Toolbar + Edit Form

### Task 9: Add edit POST action and edit form loading

**Files:**
- Modify: `servers/gateway/dashboard/panels/blog.js:17-60` (POST handlers)
- Modify: `servers/gateway/dashboard/panels/blog.js:62-117` (GET handler)

- [ ] **Step 1: Add edit POST handler**

After the `action === "delete"` block (line 59), add:

```javascript
if (action === "edit") {
  const { id, title, content, tags, visibility, cover_image_key } = req.body;
  if (!id || !title || !content) {
    return res.redirect("/dashboard/blog");
  }
  const slug = title.toLowerCase().replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-").slice(0, 80);
  await db.execute({
    sql: "UPDATE blog_posts SET title = ?, slug = ?, content = ?, tags = ?, visibility = ?, cover_image_key = ?, updated_at = datetime('now') WHERE id = ?",
    args: [title, slug, content, tags || null, visibility || "private", cover_image_key || null, id],
  });
  return res.redirect("/dashboard/blog");
}
```

- [ ] **Step 2: Add edit form loading on GET**

After the stats section (around line 71), before the post table, add logic to load a post for editing:

```javascript
// Check if editing a post
let editPost = null;
const editId = req.query.edit;
if (editId) {
  const { rows } = await db.execute({
    sql: "SELECT * FROM blog_posts WHERE id = ?",
    args: [parseInt(editId, 10)],
  });
  editPost = rows[0] || null;
}
```

- [ ] **Step 3: Add Edit button to post table rows**

In the post table row generation (around line 108-109), change:
```javascript
return [
  `${thumb}${escapeHtml(p.title)}`,
```
to:
```javascript
return [
  `${thumb}<a href="?edit=${p.id}" style="color:var(--crow-text-primary);text-decoration:none">${escapeHtml(p.title)}</a>`,
```

Also add an explicit Edit button alongside the existing actions (around line 103):
```javascript
const editBtn = `<a href="?edit=${p.id}" class="btn btn-sm btn-secondary">Edit</a>`;
```

And include `editBtn` in the actions column.

- [ ] **Step 4: Update the form section to handle edit mode**

Replace the hardcoded create form with a conditional that uses `editPost` when present:

```javascript
const isEdit = !!editPost;
const formTitle = isEdit ? `Edit: ${escapeHtml(editPost.title)}` : "New Post";
const formAction = isEdit ? "edit" : "create";
const submitLabel = isEdit ? "Save Changes" : "Create Draft";
const cancelLink = isEdit ? `<a href="/dashboard/blog" class="btn btn-secondary" style="margin-left:0.5rem">Cancel</a>` : "";
```

Then use these variables in the form template, adding a hidden `id` field when editing:
```javascript
${isEdit ? `<input type="hidden" name="id" value="${editPost.id}">` : ""}
```

And pre-populate field values from `editPost` when in edit mode.

Note: The spec mentions extracting a reusable form function (5d). Instead, we use inline conditionals in the existing template — this is simpler and avoids a premature abstraction since there's only one form template with two modes.

- [ ] **Step 5: Verify the panel loads**

```bash
timeout 5 node servers/gateway/index.js --no-auth 2>&1 | head -8 || true
```

- [ ] **Step 6: Commit**

```bash
git add servers/gateway/dashboard/panels/blog.js
git commit -m "Add blog post editing — edit button in table, pre-populated form, UPDATE handler"
```

---

### Task 10: Add markdown formatting toolbar

**Files:**
- Modify: `servers/gateway/dashboard/panels/blog.js`

- [ ] **Step 1: Add toolbar HTML above the content textarea**

Between the title field and the content textarea, insert the toolbar:

```html
<div class="md-toolbar" style="display:flex;gap:2px;padding:4px;background:var(--crow-bg-elevated);border:1px solid var(--crow-border);border-bottom:none;border-radius:8px 8px 0 0;flex-wrap:wrap">
  <button type="button" onclick="mdWrap('**','**')" title="Bold" class="md-btn"><b>B</b></button>
  <button type="button" onclick="mdWrap('*','*')" title="Italic" class="md-btn"><i>I</i></button>
  <button type="button" onclick="mdPrefix('## ')" title="Heading 2" class="md-btn">H2</button>
  <button type="button" onclick="mdPrefix('### ')" title="Heading 3" class="md-btn">H3</button>
  <span class="md-sep"></span>
  <button type="button" onclick="mdLink()" title="Link" class="md-btn">Link</button>
  <button type="button" onclick="mdImage()" title="Image" class="md-btn">Img</button>
  <span class="md-sep"></span>
  <button type="button" onclick="mdPrefix('- ')" title="Bullet List" class="md-btn">UL</button>
  <button type="button" onclick="mdPrefix('1. ')" title="Numbered List" class="md-btn">OL</button>
  <button type="button" onclick="mdPrefix('> ')" title="Quote" class="md-btn">&gt;</button>
  <span class="md-sep"></span>
  <button type="button" onclick="mdWrap('\`','\`')" title="Inline Code" class="md-btn"><code>&lt;/&gt;</code></button>
  <button type="button" onclick="mdCodeBlock()" title="Code Block" class="md-btn">```</button>
  <button type="button" onclick="mdInsert('\\n---\\n')" title="Horizontal Rule" class="md-btn">HR</button>
</div>
```

Style the toolbar buttons:
```css
.md-btn { background:transparent; border:1px solid transparent; color:var(--crow-text-secondary); padding:4px 8px; border-radius:4px; cursor:pointer; font-size:0.85rem; font-family:'DM Sans',sans-serif; }
.md-btn:hover { background:var(--crow-bg-surface); border-color:var(--crow-border); color:var(--crow-text-primary); }
.md-sep { width:1px; background:var(--crow-border); margin:2px 4px; }
```

Remove the top border-radius from the textarea so it connects to the toolbar:
```css
textarea[name="content"] { border-radius: 0 0 8px 8px !important; }
```

- [ ] **Step 2: Add toolbar JavaScript**

Add after the existing preview script:

```javascript
function _ta() { return document.querySelector('textarea[name="content"]'); }

function mdWrap(before, after) {
  var ta = _ta(); if (!ta) return;
  var start = ta.selectionStart, end = ta.selectionEnd;
  var selected = ta.value.substring(start, end);
  var replacement = before + (selected || 'text') + after;
  ta.setRangeText(replacement, start, end, 'end');
  if (!selected) { ta.selectionStart = start + before.length; ta.selectionEnd = start + before.length + 4; }
  ta.focus();
}

function mdPrefix(prefix) {
  var ta = _ta(); if (!ta) return;
  var start = ta.selectionStart;
  var lineStart = ta.value.lastIndexOf('\\n', start - 1) + 1;
  ta.setRangeText(prefix, lineStart, lineStart, 'end');
  ta.focus();
}

function mdInsert(text) {
  var ta = _ta(); if (!ta) return;
  ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end');
  ta.focus();
}

function mdLink() {
  var ta = _ta(); if (!ta) return;
  var selected = ta.value.substring(ta.selectionStart, ta.selectionEnd);
  var text = selected || 'link text';
  ta.setRangeText('[' + text + '](url)', ta.selectionStart, ta.selectionEnd, 'end');
  ta.focus();
}

function mdImage() {
  var ta = _ta(); if (!ta) return;
  ta.setRangeText('![alt](url)', ta.selectionStart, ta.selectionEnd, 'end');
  ta.focus();
}

function mdCodeBlock() {
  var ta = _ta(); if (!ta) return;
  var selected = ta.value.substring(ta.selectionStart, ta.selectionEnd);
  ta.setRangeText('\\n```\\n' + (selected || 'code') + '\\n```\\n', ta.selectionStart, ta.selectionEnd, 'end');
  ta.focus();
}
```

- [ ] **Step 3: Verify toolbar renders and functions**

```bash
timeout 5 node servers/gateway/index.js --no-auth 2>&1 | head -8 || true
```

- [ ] **Step 4: Commit**

```bash
git add servers/gateway/dashboard/panels/blog.js
git commit -m "Add markdown formatting toolbar to blog editor"
```

---

### Task 11: Final verification and push

- [ ] **Step 1: Run all servers**

```bash
timeout 3 node servers/memory/index.js 2>&1 || true
timeout 3 node servers/research/index.js 2>&1 || true
timeout 5 node servers/gateway/index.js --no-auth 2>&1 | head -8 || true
```

All should start without errors.

- [ ] **Step 2: Push all commits**

```bash
git push origin main
```

- [ ] **Step 3: Update roadmap memory**

Update `project_remaining_roadmap.md` to reflect completed items.
