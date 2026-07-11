# Bug-hunt squash round 1 — design (BH-1/2/3/5a)

Date: 2026-07-11 · Source: drive-as-user CDP bug-hunt (standing directive),
evidence `~/.crow/p4/bughunt-20260711/` (122 checks, 60+ screenshots).
Scope: the four small, fully-root-caused findings. EXCLUDED (own work items,
filed in the pool): BH-4 maker-lab bundle vs dropped research_projects table
(bundle migration + data archaeology — Bluebird×5 dupes in project_spaces);
BH-5b the providers/crow-local sync loop root cause (per-instance-volatile
`models` field in a fleet-synced row — same modeling wart family as F-10's
`host`; needs its own design); BH-6 meta-glasses 15s 404 poll (cosmetic).

## F1 (BH-3, MAJOR) — Settings > Identity permanently "Identity not available"

`sections/identity.js:17-18,27-28` imports `getOrCreateIdentity` from
`servers/sharing/identity.js`, which exports only `loadOrCreateIdentity`
(:119). Destructuring yields undefined → TypeError on call → caught →
placeholder rendered on EVERY request since the import was written.
Fix: import and call `loadOrCreateIdentity` at both sites (it is sync;
existing `await` is harmless). Test: render the section against a scratch
data dir → output contains a crow: id, NOT the unavailable placeholder —
red pre-fix. Mutation: reverting the name reddens.

## F2 (BH-1/2, MINOR) — raw i18n keys for two section labels

`settings.section.unifiedDashboard` (unified-dashboard.js:18) and
`settings.section.sharedStorage` (shared-storage.js:62) are absent from
shared/i18n.js (verified: 0 hits) → menu label, page heading, and breadcrumb
render the raw key. Fix: add both entries EN+ES beside the sibling
`settings.section.*` block (~:1097):
`unifiedDashboard: en "Unified Dashboard" / es "Panel unificado"`,
`sharedStorage: en "Shared Storage" / es "Almacenamiento compartido"`.
Test: extend the existing i18n coverage test pattern (or a direct t() assert
for all four values, en+es); a DOM-level raw-key regression test is the CDP
re-check, not node.

## F3 (BH-5a, MAJOR-UI-half) — unresolved sync-conflicts query unbounded

`sections/sync-conflicts.js:202-207`: unresolved SELECT has no LIMIT (the
resolved one has LIMIT 25). With 211 live rows (and climbing daily via
BH-5b) the page grows unboundedly. Fix: `LIMIT 200`, plus an honest count —
a `SELECT COUNT(*)` drives a "showing first 200 of N" line when N > 200
(never a silent truncation; the render already shows per-row cards, add the
notice above the list, i18n EN+ES: `settings.syncConflicts.showingFirst`).
Test: seed 205 unresolved rows → render lists 200 + the notice with N=205;
seed 5 → no notice. Mutation: dropping the LIMIT reddens the 200-count
assert; dropping the notice reddens the notice assert.

## Non-goals
BH-5b root cause (no change to what emits providers rows or how conflicts
are detected); BH-4; BH-6; Extensions overflow (queued overhaul). No schema
change. NO SCHEMA_GENERATION bump.

## Verification beyond suite
CDP re-run of the three page checks on the deployed instance: Identity shows
the crow: id; both section labels human-readable EN; sync-conflicts page
caps at 200 with the honest notice. (Same driver dir, new script.)

## Risks / review focus
- loadOrCreateIdentity() with default passphrase "" — confirm that matches
  how the sharing server derives the SAME identity this instance uses (the
  section must display the real id, not derive a different one). Check
  sharing boot's own call (:421 uses no-arg loadOrCreateIdentity()).
- LIMIT 200: interaction with the resolve-all/bulk actions on that page if
  any exist (verify what actions the section offers — resolving must not be
  silently scoped to the visible 200 without saying so).
