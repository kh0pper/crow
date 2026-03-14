# Platform Follow-ups — Design Spec

**Date:** 2026-03-14
**Scope:** 5 items from the deferred/remaining roadmap

---

## 1. Seed Data Update (grackle)

Push updated `research_protocol` crow.md section to grackle's running database via `crow_update_context_section`. Content matches `scripts/init-db.js` (the `research_protocol` contextSection entry, approximately lines 670-694) — adds source verification rules and multi-format citation guidance. No code changes.

## 2. MinIO Cleanup (grackle)

Remove the current native MinIO installation on grackle (PID 1109, port 9000, data at `/mnt/ollama-models/minio-data/`). Stop the process, disable any systemd service, comment out `.env` vars. User will reinstall via Crow Extensions panel.

## 3. Per-Device Context Wiring

Close 3 remaining gaps so `CROW_DEVICE_ID` flows through all transports:

### 3a. Stdio entry points (5 files)

Files: `servers/memory/index.js`, `servers/research/index.js`, `servers/sharing/index.js`, `servers/storage/index.js`, `servers/blog/index.js`

Change: `generateInstructions()` → `generateInstructions({ deviceId: process.env.CROW_DEVICE_ID })`

### 3b. Core server

File: `servers/core/server.js`

Change: `generateInstructions({ dbPath })` → `generateInstructions({ dbPath, deviceId: process.env.CROW_DEVICE_ID })`

### 3c. Gateway `/crow.md` endpoint

File: `servers/gateway/index.js`

Pass `deviceId` (already read from `CROW_DEVICE_ID` at startup) to `generateCrowContext()` in the `GET /crow.md` handler.

### 3d. Docs update

File: `docs/guide/customization.md`

Remove the `::: info PARTIALLY IMPLEMENTED` warning block. Update the per-device context memory file.

## 4. Brand Guidelines & Design Tokens

### 4a. Design tokens file

New file: `servers/gateway/dashboard/shared/design-tokens.js`

Exports CSS custom property definitions as a string function. Both `layout.js` and `blog-public.js` import from it instead of defining their own copies. Single source of truth.

**Token scope:** Union of all tokens from both files. `layout.js` has `--crow-brand-gold` (nav active state); `blog-public.js` has `.theme-serif`. The shared file includes both — unused tokens in a given consumer are harmless CSS custom properties.

**Verification:** After extraction, values must be exact copies. Spot-check the dashboard and blog visually to confirm no styling regressions.

Tokens include: colors (dark/light/serif themes), typography families, spacing scale, border radius, shadows, transitions.

### 4b. Brand guide doc

New file: `docs/guide/brand.md`

Sections:
- Color palette (hex values, usage: when to use accent vs muted vs error)
- Typography (Fraunces for display, DM Sans for body, JetBrains Mono for code)
- Spacing and radius conventions (rem-based scale, border-radius tiers)
- Theme variants (dark default, light, serif for blog)
- SVG assets (crow-hero, feature icons, addon logos)
- Design philosophy ("iridescent corvid" — dark surfaces with indigo accents)

Add to VitePress sidebar under Guides.

## 5. Blog Markdown Toolbar + Edit Form

### 5a. Markdown toolbar

Location: `servers/gateway/dashboard/panels/blog.js`

Vanilla JS toolbar rendered above the content textarea. Buttons:
- **B** (bold) — wraps selection in `**`
- *I* (italic) — wraps selection in `*`
- H (heading dropdown) — inserts `## ` or `### ` prefix
- Link — inserts `[text](url)` template
- Image — inserts `![alt](url)` template
- UL — inserts `- ` prefix
- OL — inserts `1. ` prefix
- Code — wraps selection in backticks (inline) or triple backticks (block, via shift or separate button)
- Quote — inserts `> ` prefix
- HR — inserts `---`

Behavior: If text is selected, wrap it. If no selection, insert template at cursor. Styled with `--crow-*` variables, horizontal button bar, subtle borders.

### 5b. Edit form

New POST action `action: "edit"` in blog panel handler. Updates existing post via `UPDATE blog_posts SET ... WHERE id = ?`. If the post doesn't exist (deleted between load and submit), redirect to `/dashboard/blog` with no error — silent no-op is acceptable here since the user will see the post is gone.

New GET parameter: `/dashboard/blog?edit=<id>` loads the post data and renders the form pre-populated with title, content, tags, visibility, cover image key. When `?edit=<id>` is present, the edit form **replaces** the create form in the "New Post" section (not both visible at once). A "Cancel" link returns to the normal view.

### 5c. Post table edit button

Add "Edit" link to each post row in the table that navigates to `?edit=<id>`.

### 5d. Shared form

Extract the form HTML (title, toolbar, content textarea, preview toggle, tags, visibility, cover image, submit button) into a reusable function. Create form uses it with empty values + "Create Draft" button. Edit form uses it with pre-populated values + "Save Changes" button.

---

## Files Changed

| File | Change |
|------|--------|
| `servers/memory/index.js` | Pass `deviceId` to `generateInstructions()` |
| `servers/research/index.js` | Same |
| `servers/sharing/index.js` | Same |
| `servers/storage/index.js` | Same |
| `servers/blog/index.js` | Same |
| `servers/core/server.js` | Pass `deviceId` to `generateInstructions()` |
| `servers/gateway/index.js` | Pass `deviceId` to `generateCrowContext()` in `/crow.md` |
| `docs/guide/customization.md` | Remove "partially implemented" warning |
| `servers/gateway/dashboard/shared/design-tokens.js` | **New** — shared CSS variable definitions |
| `servers/gateway/dashboard/shared/layout.js` | Import tokens from design-tokens.js |
| `servers/gateway/routes/blog-public.js` | Import tokens from design-tokens.js |
| `docs/guide/brand.md` | **New** — brand guidelines documentation |
| `docs/.vitepress/config.ts` | Add brand guide to sidebar |
| `servers/gateway/dashboard/panels/blog.js` | Add toolbar, edit form, edit button in table |
| `CLAUDE.md` | Document design tokens location |
