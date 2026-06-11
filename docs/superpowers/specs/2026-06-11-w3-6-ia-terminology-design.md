# W3-6 — IA & terminology coherence (nav regroup around the spine; "agent" as the generic noun)

**Date:** 2026-06-11
**Finding:** W3-6 in [`2026-06-10-overhaul-findings.md`](./2026-06-10-overhaul-findings.md); rubric: vision doc (IA coherent with the dual-use spine; accessibility-first naming).

## Decisions

1. **Terminology:** the public docs (F7) already use "agent" as the generic noun and "Bot Builder"/"Bot Board" as feature proper nouns ("Agents (Bot Builder)"). The UI adopts the same rule: generic UI copy says **agent** ("Set up an agent", "your agents"); the proper nouns **Bot Builder** and **Bot Board** are unchanged (no doc-wide rename, no route changes, no pi_bot_* internal renames). EN + ES strings both updated (es: "agente").
2. **Nav groups** (current: Core/Content/Media/Education/Tools/System with Media+Education EMPTY): new defaults aligned to the spine:

| Group id | Name (en / es) | Panels |
|---|---|---|
| `home` | Home / Inicio | nest |
| `agents` | Agents / Agentes | bot-builder, bot-board, skills, orchestrator |
| `connections` | Connections / Conexiones | connect, contacts, messages, fediverse |
| `workspace` | Workspace / Espacio de trabajo | memory, projects, blog, files, extensions |
| `system` | System / Sistema (collapsed) | settings, design-system |

3. **CATEGORY_TO_GROUP remap** (for auto-assigned/third-party panels): core→workspace, content→workspace, media→workspace, education→workspace, ai→agents, social→connections, connections→connections, federated-social→connections, federated-media→connections, federated-comms→connections, cameras→workspace, productivity/finance/infrastructure/automation→workspace, system→system.

## Migration (the load-bearing part — nav config is DB-persisted per instance)

`nav_groups` + `nav_panel_assignments` live in `dashboard_settings`, seeded once. An idempotent JS migration in `scripts/init-db.js` (after the existing migrations):
- If stored `nav_groups` deep-matches the OLD defaults on (id, name) pairs — ignoring `collapsed` flags — replace both keys with the NEW defaults (user never customized → safe).
- If customized: leave `nav_groups` alone, BUT remap any `nav_panel_assignments` value pointing at a group id that no longer exists in the stored groups… (not applicable when groups are user-kept — their old ids still exist). Additionally verify `resolveNavGroups`' behavior for an assignment→missing-group (read the fallback; if panels would vanish, fix the fallback to auto-assign instead).
- Seeded-fresh installs just get the new defaults via `DEFAULT_NAV_GROUPS`.

## Group-name localization

Group names are stored as literals in the DB (ES users currently see English groups). The renderer (`shared/layout.js` nav build) should translate by id when a key exists: `t("nav.group." + group.id)` falling back to the stored name. Add the 5 `nav.group.*` keys (en+es) to `shared/i18n.js`.

## Terminology sweep scope

`grep -rni "\bbot\b"` over `servers/gateway/dashboard/` UI-string surfaces (i18n.js values, onboarding copy, panel headings/labels/empty-states) — change GENERIC uses to "agent"/"agente"; leave proper nouns (Bot Builder, Bot Board), code identifiers, routes, and internal tables untouched. Settings sections mentioning "Bot Runtime" keep the proper-noun framing ("Agent runtime (Bot Builder)" acceptable if a natural fit; do not force).

## Testing / verification

- New `tests/nav-migration.test.js`: temp DB seeded with OLD defaults → migration swaps to new; customized groups → untouched; fresh DB → new defaults; no panel orphaned (every registered panel id resolves to a rendered group via assignment or category fallback).
- Full suite green; gateway boots; dashboard renders (manual smoke post-deploy: nav shows 5 groups, ES locale shows translated names).
- No route changes — deep links unaffected.
