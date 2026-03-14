---
name: crow-developer
description: Developer workflow for working on the Crow platform — doc updates, skill sync, quality checklist
triggers:
  - crow development
  - working on crow
  - crow codebase
tools:
  - filesystem
---

# Crow Developer Workflow

## When to Activate

This skill activates automatically when working inside the Crow repository (detected by the presence of CLAUDE.md with Crow-specific content). It applies to all code changes made to the platform.

## The Rule

**Every code change must include documentation updates.** No exceptions.

## Checklist

Before completing any development task, verify:

1. **Identify affected docs** — Which pages in `docs/` describe the feature you changed?
2. **Update docs** — Edit the affected pages to reflect your changes
3. **Update CLAUDE.md** — If you added a server, tool, panel, skill, or npm script
4. **Update skills reference** — If you added or modified a skill:
   - Add to `skills/superpowers.md` trigger table
   - Add to CLAUDE.md Skills Reference
   - Run `npm run sync-skills` to update `docs/skills/index.md`
5. **Update VitePress sidebar** — If you created a new doc page, add it to `docs/.vitepress/config.ts`

## What to Update Where

| Change type | Update in |
|---|---|
| New MCP tool | CLAUDE.md (server description), relevant skill file, relevant docs page |
| New dashboard panel | CLAUDE.md (panels list), `docs/guide/crows-nest.md`, dashboard index.js |
| New skill | CLAUDE.md (Skills Reference), `superpowers.md` (trigger table), `docs/skills/index.md`, `npm run sync-skills` |
| New npm script | CLAUDE.md (Build & Run Commands) |
| New DB table/column | CLAUDE.md (Database section), `scripts/init-db.js` |
| New doc page | `docs/.vitepress/config.ts` (sidebar) |
| New add-on/bundle | CLAUDE.md, `registry/add-ons.json`, `docs/developers/` |

## Common Mistakes

- Adding a skill without a trigger row in `superpowers.md`
- Adding a doc page without updating the VitePress sidebar
- Changing tool parameters without updating the skill that describes them
- Adding a panel without updating `docs/guide/crows-nest.md`
