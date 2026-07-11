# Extensions Page Overhaul + One-Click Collections — Design Spec

- **Date:** 2026-07-11
- **Status:** Draft v1 (pre adversarial review)
- **Queue:** post-arc item 3 (blanket authorization 2026-07-11)
- **Directive:** memory `crow-extensions-page-overhaul-directive` (Kevin, 2026-07-10)

## 1. Context and evidence

Kevin's verbatim intent: the Extensions page's "horizontal scrolling back and forth to see
all extensions in a single row is obnoxious"; the page "feels not well organized"; the
original goal was an iOS App Store / Google Play feel but "it doesn't really feel like
either"; "it is also ugly and needs a visual makeover." Separately: one-click themed
templates (home server, education, research, development) that install/configure a curated
set of extensions.

### Root cause of the horizontal scroll (CDP-diagnosed 2026-07-11)

Live probe (`~/.crow/p4/ext-overhaul/overflow-diag.json`, screenshot
`extensions-current.png`): document scrollWidth 2555 vs clientWidth 1904.

The causal chain:

1. `.ext-tabs` renders **19 category tab pills**, each `flex-shrink:0` + `white-space:nowrap`,
   in a flex row. Its min-content width is ~2251px. Its own `overflow-x:auto` scrolls its
   *content*, but does not stop the min-content width from propagating upward.
2. `.main-content` is a flex item (`flex:1`) of `.dashboard` with **no `min-width:0`**, so
   its automatic minimum size inherits the widest descendant's min-content width → the main
   column lays out at 2315px.
3. `.ext-grid` uses `repeat(auto-fill, minmax(220px,1fr))`, which faithfully fills the
   inflated 2251px container with **9 columns** — producing exactly the "wide row you
   scroll back and forth to read" that Kevin described.

So the bug is a layout-containment bug, not a grid bug; and any page with a wide
non-wrapping descendant can reproduce it (this is a page-wide bug class).

### Current page inventory (audit)

- One flat server-rendered page (`servers/gateway/dashboard/panels/extensions{,.js}`,
  1719 lines across orchestrator/html/css/client/data-queries/api-handlers): search box,
  collapsed "Installed (10)" strip, 19 category tabs, alphabetical auto-fill grid of ~93
  identical cards, collapsible community stores, help card. No hierarchy, no curation, no
  featured section — the "wall of identical cards" is why it doesn't read as a store.
- Registry: 90 official add-ons in `registry/add-ons.json` (23 ai, 15 media, 13
  productivity, 10 infrastructure, then a long tail of 1–4 per category across 14 more
  categories). Types: 77 bundle / 11 mcp-server / 2 skill. `fetchRegistryData()` merges
  remote (`kh0pper/crow-addons` GitHub raw) + local (local wins by id) + community stores.
- Install flow (KEEP — it is solid): detail modal → install modal with env-var form,
  consent-challenge gate for `privileged`/`consent_required` manifests (typed-INSTALL for
  privileged), hardware + GPU-arch gates server-side, background job with polled log,
  automatic gateway self-restart when the bundle ships panels/MCP servers/skills.
- Load-bearing mechanics confirmed by code reading:
  - **Required env vars are NOT enforced at install.** `env_vars` are written if provided,
    else `.env.example` is copied. Many flagship bundles' required vars (JELLYFIN_API_KEY,
    IMMICH_API_KEY, HA_TOKEN…) are only *obtainable after the service boots*, so
    install-now/configure-later is the existing product semantic. `/bundles/api/env`
    exists for post-install reconfiguration.
  - **Install starts containers immediately** (`compose pull` + `up -d`) and finishes with
    `complete_restart` (gateway exit + supervisor restart) when panels/servers/skills were
    added. A naive N-bundle sequence would restart the gateway mid-sequence and kill the
    job runner → batching with ONE deferred restart is mandatory.
  - The install handler is inline in `routes/bundles.js` (~1083–1665) — must be extracted
    to be reusable by a set-installer.
  - CSRF: all `/dashboard` POSTs pass `csrfMiddleware` (double-submit); the existing
    bundles API already works through it, new endpoints inherit the same posture.

## 2. Goals

1. **No horizontal document scroll** on the Extensions page (and kill the page-wide bug
   class at the layout level), at any viewport ≥360px.
2. **App-store information architecture**: featured content, themed collections, browsable
   category groups, visible hierarchy — not a flat alphabetical wall.
3. **Visual makeover** consistent with Crow's design system (Fraunces/DM Sans/JetBrains
   Mono, `--crow-*` tokens, glass-theme overrides), executed with the frontend-design
   skill at build time.
4. **One-click themed collections** (Kevin's four: Home Server, Education, Research,
   Development) installable with a single confirmed click, honest about what happens
   (sequential installs, one final gateway restart, post-install configuration checklist).
5. **First-run discoverability bridge**: onboarding done-step gets a "starter collections"
   card deep-linking to the Extensions collections section.

## 3. Non-goals

- Per-add-on standalone routes/pages, screenshots, ratings, reviews (assets don't exist;
  the detail modal already serves the need). No remote metadata pipeline changes.
- Full first-run wizard integration (choose a template during onboarding) — that is queue
  item 4 (generalization + first-run); it will REUSE the collections + install-set
  machinery this arc builds. This arc only ships the done-step bridge card.
- Rewriting registry categories — display grouping happens via a code-side mapping.
- Community-store UX changes beyond restyling what exists.
- Changing single-bundle install/consent semantics.

## 4. Placement decision (the directive's TBD)

**Split.** Extensions overhaul (this arc) ships: store UX, `featured` curation flag,
collections data model, batched `install-set` API, collection modal, onboarding bridge
card. Queue item 4 ships: first-run wizard integration + installer generalization, reusing
install-set. Rationale: item 4 immediately follows in the pre-approved queue; the shared
foundation (install-set) belongs where the store UI is built; neither blocks the other.

## 5. Design

### D1 — Global overflow containment fix

`.main-content { min-width: 0; }` in `shared/layout.js` (the standard flex-item
containment fix). This kills the propagation path for the whole dashboard, not just
Extensions. Verification: CDP sweep asserting `document.documentElement.scrollWidth <=
clientWidth + 1` on Extensions plus a representative page set (home, Messages, Contacts,
Settings, Bot Builder) at 1920/1366/768/390 widths.

Risk note: `min-width:0` on a flex item only removes the automatic minimum; no dashboard
page legitimately relies on intrinsic-width propagation of the main column (they'd be
horizontally broken today if they did). The CDP sweep is the empirical guard.

### D2 — Information architecture: two views, vertical-only flow

Top-level segmented control (client-side toggle, no new routes):

- **Browse** (default):
  1. Search field (existing behavior, restyled). Searching switches the section layout to
     a flat filtered grid (sections hide while a query is active — same client-side
     filtering mechanism as today).
  2. **Starter collections** — the four themed collection cards (D5/D7). Prominent,
     top-of-page, horizontally wrapping card row (NOT a scroller).
  3. **Featured** — a curated grid of ~6 add-ons (D4), larger cards with accent styling.
  4. **Category-group sections** — the ~7 display groups (D3) as stacked vertical
     sections. Each section shows its add-ons in the existing auto-fill card grid,
     collapsed to the first 2 grid rows with a "Show all (N)" toggle when longer.
     No horizontal scrolling anywhere; group chips row **wraps** (`flex-wrap:wrap`).
- **Installed (N)**: the management view — the current installed-strip content
  (status badge, start/stop/restart, remove, version) always expanded, plus community
  stores management and the help card (they are management concerns, not browsing).

The existing detail modal, install modal, consent gate, uninstall modal, and job polling
are kept as-is functionally and restyled only.

View state and "Show all" expansions are client-side only (no persistence). Deep-link
hashes (no new routes): `#installed` selects the Installed view; `#collections` selects
Browse and scrolls to the Starter-collections section (used by the D9 onboarding bridge).
Hash handling runs on every render so Turbo revisits behave.

### D3 — Category display groups

Code-side mapping (new module `panels/extensions/groups.js`), registry untouched:

| Display group | Registry categories |
|---|---|
| AI & Models | ai |
| Media | media |
| Productivity & Learning | productivity, education |
| Social & Federation | social, federated-social, federated-media, federated-comms |
| Infrastructure & Tools | infrastructure, networking, storage, data, automation |
| Home & Hardware | smart-home, cameras, hardware |
| More | finance, gaming, other + any unknown category (forward-compatible default) |

Unknown/future categories fall into "More" (never dropped). Group chips replace the 19
category tabs: All + 7 groups + Installed-state filter stays in the segmented control.
i18n keys for group labels; counts rendered per group.

### D4 — Featured curation

Optional boolean `featured` on registry entries (add to `manifest.schema.json` as an
optional field; additive, no version bump needed for v2 consumers). Initial curation set
in the local registry (~6: companion, knowledge-base, home-assistant, jellyfin, paperless,
searxng — final set at build time). The remote registry merge already lets local entries
override remote, so featured works even before the remote crow-addons repo learns the
field. Zero featured entries → the Featured section simply doesn't render.

### D5 — Collections data model

New file `registry/collections.json`:

```json
{
  "version": 1,
  "collections": [
    {
      "id": "home-server",
      "name": "Home Server",
      "description": "Turn Crow into the brain of your home network.",
      "icon": "home",
      "members": ["home-assistant", "jellyfin", "immich", "paperless", "adguard-home", "uptime-kuma", "ntfy"]
    },
    { "id": "education",   "members": ["kolibri", "kavita", "calibre-web", "bookstack", "knowledge-base", "stirling-pdf"] },
    { "id": "research",    "members": ["knowledge-base", "searxng", "miniflux", "wallabag", "linkding", "paperless"] },
    { "id": "development", "members": ["gitea", "uptime-kuma", "browser", "maker-lab", "minio"] }
  ]
}
```

(Names/descriptions/icons elided above for brevity — real file carries them; membership
is draft and gets finalized during build against the hard rules below.)

**Hard membership rules (enforced by a unit test against the real registry):**
- Official registry members only (no community).
- No `privileged` and no `consent_required` manifests — one-click must not weaken the
  consent UX (a collection card can still *link* to such add-ons later; v1 just excludes
  them).
- No GPU-model bundles (host-specific; the model-bundle picker already handles those).
- Every member id must exist in the local registry.

Load path: local file only in v1 (`fetchRegistryData()` gains a `collections` output).
The remote registry may add collections later; merge semantics then are local-wins-by-id,
same as add-ons. Missing/corrupt file → empty collections, section hidden, no crash.

### D6 — Batched set install: `POST /bundles/api/install-set`

Body: `{ collection_id }`. Response: `{ job_id }` (one job for the whole set).

Server behavior:
1. Resolve the collection from the registry loader; 404 unknown id.
2. Re-validate the membership hard rules server-side (defense in depth — a tampered
   collections file cannot smuggle a consent-required bundle past the gate); refuse the
   whole set otherwise.
3. Compute the member plan: for each member, mark `install` / `skip (already installed)`
   / `skip (GPU-incompatible)` / `skip (hardware gate)` — reusing the same gate functions
   the single install uses. The plan is written into the job log up front.
4. Extract the current inline install body (bundles.js ~1083–1665) into
   `runInstallJob(bundleId, envVars, { job, deferRestart })` — the single-install route
   becomes a thin wrapper (`deferRestart:false`), install-set calls it sequentially with
   `deferRestart:true`. Extraction is verbatim-body-move discipline (the F-UPDATE-1
   pattern): no logic edits in the move commit.
5. Sequential execution, **continue-on-error**: a member failure is logged and the set
   proceeds; the job summary lists per-member outcome (installed / skipped-why / failed-why).
6. **One deferred gateway restart at the end** iff any member reported needsRestart.
   Job finishes `complete_restart` (client already knows how to wait out a restart).
7. Job summary includes a **needs-configuration list**: members whose manifests declare
   required env vars with no default, so the UI can render the post-install checklist.
8. Auth/CSRF: same posture as the existing bundles API (dashboard session + double-submit
   CSRF). Never reachable via Funnel (dashboard-gated; no PUBLIC_FUNNEL_PREFIXES change).

Concurrency: there is NO existing global install lock (verified — the only install-path
409 today is "already installed"). A concurrent single install finishing with an
immediate gateway restart would kill a running set mid-sequence. install-set therefore
ADDS a module-level busy gate: while a set job is active, `install`, `uninstall`, and
`install-set` all return 409 ("collection install in progress"). Single installs do NOT
lock each other (existing behavior unchanged — no scope creep).

### D7 — Collection card + modal UX

Collection card: icon, name, one-line description, member count + tiny member-icon strip.
Click → collection modal:

- Member list with live status chips: `Installed ✓` / `Will install` / `Skipped: needs
  NVIDIA GPU` etc. (client renders from the same gate data the cards already embed).
- Honest expectation copy: "Installs N extensions one after another (may take several
  minutes to download), then restarts the Crow gateway once."
- ONE primary button: "Install collection (N)". No env-var wall — install-now/
  configure-later is the existing product semantic (see §1). After completion the modal
  shows the **configuration checklist**: each member needing env values gets a row with a
  "Configure" link opening the existing detail modal/env form. Members already installed
  are simply checked off.
- Progress: reuse `pollJob` (the job log is the live progress feed), then the restart
  waiter.

### D8 — Visual makeover

Executed at build time under the **frontend-design skill**; the spec pins direction, not
pixels: keep Crow's identity (Fraunces display serif for names, DM Sans body, JetBrains
Mono metadata, `--crow-*` tokens, existing dark/glass themes); differentiate tiers
(collections > featured > grid cards) by size/weight/accent rather than new colors;
category-color system stays (it's good); motion stays subtle (existing fadeInUp,
120–200ms transitions); the wall-of-sameness is broken by hierarchy, not decoration.
Mobile: existing responsive breakpoints preserved; sections stack; segmented control and
chips wrap.

### D9 — Onboarding bridge (first-run discoverability)

The onboarding done-step's "what to try" cards (`panels/onboarding.js`) gain a fourth
card: "Set up a starter collection" → `/dashboard/extensions#collections`. i18n'd. That's
the entire item-3 footprint; the full wizard is item 4.

### D10 — Cross-cutting

- **i18n**: every new user-facing string through `t()` with keys in both language packs
  (`extensions.*` namespace); no hardcoded English (the #165 lesson).
- **Turbo-safety**: keep the established patterns — one-time document listeners behind
  `window.__ext*Bound` flags, per-render listeners attached inside the IIFE.
- **A11y**: segmented control = real buttons with `aria-pressed`; sections are headed
  landmarks; modal focus behavior unchanged.
- **No new ports** (no port-allocation doc change needed); no schema/DB changes; no
  instance-sync surface (nothing here syncs).

## 6. Failure modes

| Failure | Behavior |
|---|---|
| Remote registry unreachable | unchanged (local fallback; existing banner) |
| collections.json missing/corrupt | collections section hidden; page fully functional |
| Collection references unknown id | member skipped with logged notice (client shows it); unit test prevents shipping this state in-repo |
| Member install fails mid-set | logged, set continues, summary shows failed member with reason; user can retry that member individually |
| Gateway restart after set | client restart-waiter (existing) reloads when /health returns |
| Double install-set / single install-or-uninstall during a set | 409 via the NEW set-busy gate (D6); lock released on job finish/failure |
| Tampered collections file smuggles consent-required member | server-side re-validation refuses the set (D6.2) |

## 7. Testing strategy

- **Unit** (node --test): groups mapping (every registry category maps somewhere; unknown
  → More), collections loader (missing/corrupt/valid), membership hard-rules test against
  the real registry + real manifests, install-set planner (skip logic), runInstallJob
  extraction seam (single-install wrapper still passes existing tests).
- **Integration** (scratch CROW_HOME + scratch CROW_DATA_DIR, fully-offline env:
  CROW_AUTO_UPDATE=0, CROW_DISABLE_HEALTH_MONITOR=1, CROW_DISABLE_INSTANCE_SYNC=1,
  CROW_DISABLE_NOSTR=1, never the real .env): install-set over a fixture collection of
  tiny non-Docker members (skill/mcp-server type) → sequential logs, one
  `complete_restart`, installed.json correct; failure-injection member → continue-on-error
  summary.
- **Mutation guards**: each load-bearing gate (server-side membership re-validation,
  deferRestart, continue-on-error) gets a red-then-restored mutation check.
- **CDP (HARD REQUIREMENT, evidence `~/.crow/p4/ext-overhaul/`)**:
  1. Overflow: `scrollWidth <= clientWidth+1` on Extensions at 1920/1366/768/390 + the D1
     regression sweep pages.
  2. Real browser click-through: Browse → collection card → modal → "Install collection"
     on a scratch gateway with a fixture collection → watch job log → restart waiter →
     post-restart page shows members Installed + configuration checklist.
  3. Segmented control, group chips filter, search-overrides-sections, Show-all toggle,
     detail modal open/install path — all as real clicks.
  4. Visual evidence screenshots (before already captured: `extensions-current.png`).
- **Suite**: full `node --test` baseline 1522/1521/0/1 must not regress; merge
  origin/main before final review if main moves.

## 8. Rollout

Single PR (`feat/extensions-overhaul`), rigor pipeline per the blanket grant: this spec →
2-round adversarial Opus review → writing-plans → SDD/TDD subagent tasks with per-task
reviews → mutation guards → final whole-branch Opus review → PR → check-runs → merge →
deploy fleet (crow + MPA restart, grackle bridge-then-gateway, black-swan) → live CDP
verify on prod crow. Deploy risk is low (dashboard-only + one additive route + registry
data); the D1 layout line is the only global touch and carries the CDP sweep.

## 9. Resolved questions

- Placement vs item 4 → split (§4).
- Env-var wall vs one-click → one-click + post-install checklist (matches existing
  install-now/configure-later semantics, §1/D7).
- Consent-required bundles in collections → excluded v1 (D5).
- Mid-set gateway restarts → single deferred restart (D6).
- 19 tabs → 7 wrapped display-group chips (D3).
- Horizontal scroll root cause → `.main-content` containment + no horizontal patterns
  anywhere in the new IA (D1/D2).
