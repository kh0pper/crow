# W2-4 — CrowClaw legacy layer retirement

**Date:** 2026-06-11
**Finding:** W2-4 in [`2026-06-10-overhaul-findings.md`](./2026-06-10-overhaul-findings.md). Usage instrumentation completed 2026-06-11: the `crowclaw_*` tables were **never created** on either live DB (`~/.crow`, `~/.crow-mpa`); the bundle is **not installed** on any fleet host; zero log activity in 30 days; zero rows of user data exist. The Bot Builder (F1) superseded it. Per the vision doc (nothing architecturally sacred; unification leads) and the data-absolute rule (no data exists to lose — git history is the code archive), the layer is removed rather than fenced.

## Scope (from the footprint map)

**Delete:**
1. `bundles/crowclaw/` (entire tracked directory, 29 files).
2. `servers/gateway/routes/bot-chat.js` (571-line legacy REST API polling a never-created table) + its mount/import in `servers/gateway/index.js`.
3. `docs/architecture/crowclaw.md`, `docs/platforms/openclaw.md`, `docs/guide/bot-management.md` (the "(Legacy)" pages) + their sidebar entries in `docs/.vitepress/config.ts`.

**Edit:**
4. `servers/gateway/dashboard/panels/messages/data-queries.js` — remove the CrowClaw query block (~lines 67-87) from the unified conversation list; the peer/AI blocks stay.
5. `servers/orchestrator/providers.js` + `providers-db.js` — remove the dead `bundles/crowclaw/.../models.json` SEARCH_PATHS entry.
6. `registry/add-ons.json` — regenerate via `npm run build-registry` after the manifest deletion (never hand-edit).
7. Any surviving cross-references: grep `crowclaw|openclaw|bot-chat` across servers/, scripts/, docs/ (excluding dist + this spec + the findings/specs history) and fix each — e.g. the contrast paragraph in `docs/architecture/bot-builder.md`, links in `docs/guide/bot-builder.md`, README if any.

**Keep:** Bot Builder everything; messages panel (minus the block); `tests/public-projection.test.js` etc. untouched.

## Risks & verification

- The messages panel must still render after the query-block removal (other blocks are independent UNION arms — verify the SQL still parses and the panel renders; check any test covering data-queries).
- `npm run build-registry` must succeed and drop the crowclaw entry; nothing else in the registry may change unexpectedly (diff it).
- Full suite green; gateway boots; `cd docs && npm run build` green (deleted pages must not be linked from surviving pages — VitePress dead-link check enforces).
- Docs: any inbound links to the three deleted pages are removed/redirected in the same commit.
- No DB migration needed (tables never existed); `scripts/init-db.js` has no crowclaw tables (they lived in the bundle's own init) — verify with grep and leave init-db untouched if so.
