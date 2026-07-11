# Settings-scope coherence — design (follow-up to Cluster B §6 audit)

Date: 2026-07-11 · Arc: post-Messages-arc follow-up pool, item (1)
Operator decisions (2026-07-11, AskUserQuestion): Approach A approved; ALL keys
per-instance (none promoted to fleet-sync in this PR); auto-update per-tick
enabled re-check INCLUDED; both vestigial dead writes DELETED.
Review: R1 (adversarial, opus) REVISE — 2 MAJOR (D6 manual-check regression;
D2 flag/retry contradiction) + 4 minors, all folded; 13/13 §1 claims
spot-checked HELD. R2 (adversarial, opus) **APPROVE** — all R1 folds
confirmed faithful; 4 precision minors folded (heal uses createDbClient not
syncManager.db; §5.7 fail-open test reframed — getSettings cannot throw;
D4 persistence-key name corrected to blog_theme_mode; §6 notifications/
language checks labeled mixed browser+node-probe).

## 1. Problem

`writeSetting(scope:"global")` silently downgrades any key not in
`SYNC_ALLOWLIST` to a per-instance `dashboard_settings_overrides` row
(settings/registry.js:194-201). Cluster B fixed the three `profile_*` keys by
allowlisting them (user-level data). The §6 audit found the same
write-local/read-global mismatch breaks **12+ more keys** whose readers query
the global `dashboard_settings` table directly — the UI write is invisible to
the behavior it claims to control.

Re-verified at HEAD 066549c7 (5-agent recon, 2026-07-11). All confirmed, some
worse than audited:

| key(s) | writer (→local override) | load-bearing global-direct reader(s) | user-visible failure |
|---|---|---|---|
| auto_update_enabled / auto_update_interval_hours | settings section `updates`, action `save_update_settings` (updates.js:159-160) | gateway auto-update timer `getSettings()` (auto-update.js:39-48, read **boot-only** at :211-227); the section's own render (updates.js:28,53-64) | **Disabling auto-update in the UI is inert** AND the form visually reverts after save. Only `CROW_AUTO_UPDATE=0` env (checked before DB, auto-update.js:205-209) actually disables. |
| notification_prefs | section `notifications`, action `save_notification_prefs` (notifications.js:234) | **the delivery gate** servers/shared/notifications.js:44 (suppresses DB row, bell, web push, ntfy AND email); memory server get (server.js:1376); the section's own render (notifications.js:33) | UI channel toggles never affect delivery. DUAL WRITER: MCP `crow_notification_settings` writes global raw (memory/server.js:1397-1399) and *does* gate delivery → three surfaces (delivery, checkboxes, menu subtitle via override-aware readSettings) can each show a different value. |
| discovery_enabled / discovery_name | section `discovery`, action `update_discovery` (discovery.js:49) | peer API boot/peer-public-api.js:44-56,89-97 (`/discover/profile` 404-gates on it); the section's own render (discovery.js:22-28) | Enabling discovery in the UI never reaches peers (permanent 404 "Discovery not enabled"); form reverts after save; display name reaches peers as null. |
| onboarding_completed_at | onboarding done-step (panels/onboarding.js:207-213) | login redirect gate dashboard/index.js:206-214 | The "already completed → don't re-onboard" skip can never fire. Marginal (guarded by `wasFirstSetup`); the internal re-entry guard (onboarding.js:209) uses readSetting and works. |
| language | section `language`, action `set_language` (language.js:45; co-writes `crow_lang` cookie :46-47) | setup-page.js:65, help-setup.js:23, the section's own render language.js:24 (main chrome index.js:797 uses readSetting — override-aware) | Cookie-mitigated in the saving browser only. Cookie-less client (fresh/incognito/other device): setup + help + dropdown fall to en/Accept-Language while the main chrome shows the saved language — visible inconsistency. |
| blog_* (17 keys: title/tagline/author/listed/theme/theme_*/custom_css/songbook_on_index/podcast_*) | sections `blog` (blog.js:49) + `theme` (theme.js:111,124) | public blog/RSS/sitemap/registry renderer routes/blog-public.js:52-56 + the `blog_listed` registry 404-gate :573; blog MCP server.js:68,411,470,614; songbook routes; `/dashboard/blog` panel :146; the blog section's own render (blog.js:21-24) | UI blog/theme edits never reach the public blog or the MCP tools; the blog form shows MCP edits but hides its own. THREE write conventions coexist: sections→local; `/dashboard/blog` panel `toggle_songbook_index` (panels/blog.js:75) + MCP `crow_blog_settings`/`crow_blog_customize_theme` (blog/server.js:522,541)→global raw. `blog_theme_*` readers split: theme render (theme.js:31) + dashboard layout (index.js:798) are override-aware → a UI theme save makes dashboard chrome and public blog permanently disagree. |
| tts_voice | TTS-profiles compat mirror (sections/llm/tts-profiles.js:24 `mirrorVoice`) | media bundle server (separate stdio process, direct sqlite: bundles/media/server/server.js:676) + media panel routes.js:411,631 (own direct client) | Voice picked in the UI never reaches audio generation; media only sees the one-time boot-migration global row (migrations.js:135) or falls back to `en-US-BrianNeural`. |
| vision_profiles (**new find, outside the audit**) | sections/llm/vision-profiles.js:35 — allowlisted key but `FIRST_WRITE_DEFAULT_SCOPE="local"` (:24) | bot-builder/data-queries.js:104 `loadVisionProfiles` raw global (comment at :99-100 admits it) | Bot Builder's vision-profile picker never sees the operator's profiles; being local, the allowlisted key also silently doesn't sync. Different bug shape: an explicit scope choice + one non-conforming reader. |
| dashboard_theme | theme.js:98 (`set_theme`, live caller layout.js:282) | **none at runtime** (only init-db.js:2296 one-shot legacy migration) | Vestigial dead write producing junk override rows. |
| llm_chat_default_provider_id | llm-settings-migration.js:177 (one-time env-default migration) | **none anywhere** | Vestigial dead write. |

CONSISTENT — verified, NOT touched: `feature_flags`, `kiosk_mode` (all readers
readSetting/override-first incl. the two raw pi-bots readers),
`remote_managed_bots`, `remote_exposed_tools`, `sso_enabled`,
`meta_glasses_default_project_id`, `mcp_local_token_hash/_created`,
`storage.local.auto_apply_to_bundles` (local both sides); `ai_profiles`,
`tts_profiles`, `stt_profiles`, `nav_*`, `unified_dashboard_enabled`,
`storage.shared.*`, `companion_*`, `meta_glasses_devices`, status/flag rows
(global both sides). Internal `__*` one-shot flags are raw-SQL by design.

## 2. The load-bearing architectural fact

Replication is enforced by `isSyncable` gates at **emit** (`shouldSyncRow`,
servers/sharing/instance-sync.js:207-211 — "dashboard_settings holds only the
global scope … Allowlist gates the key") **and apply** (the inbound-entry
dispatch re-runs `shouldSyncRow` before `_applyDashboardSetting` is ever
reached — instance-sync.js:936, "Defense in depth: drop inbound rows that fail
the local syncability check"; reemit loop :510) — NOT by
which table a row lives in. A global-table row for a non-allowlisted key never
leaves the box. Each instance has its own DB, so for never-synced keys the
global table is already per-instance. The overrides table is only semantically
meaningful for (a) per-instance divergence from a synced fleet value and
(b) intentionally-local keys whose readers all resolve overrides
(`feature_flags` class).

## 3. Non-goals

- No key becomes fleet-synced in this PR (operator decision). Promoting any of
  these later = add to SYNC_ALLOWLIST + reemit flag bump — a deliberate,
  separate product decision per key.
- No change to `feature_flags`/`kiosk_mode`-class keys or their downgrade path.
- No change to the three dual writers (memory/server.js:1397, blog/server.js:522,541,
  panels/blog.js:75): under this design their existing raw global writes become
  the CORRECT convention. (Their raw SQL never emits sync — irrelevant, these
  keys don't sync.)
- No fix for vision_profiles' `FIRST_WRITE_DEFAULT_SCOPE="local"` write default —
  explicit, documented choice in that file, out of scope; only its
  non-conforming reader is fixed (D5).
- No F-UPDATE-1 stash/pop/flock hardening (next PR); D6 only makes the existing
  toggle honest.
- No schema change. **SCHEMA_GENERATION stays 6** (no DDL anywhere; the heal
  flag is a `dashboard_settings` row).
- tts_voice mirror freshness on peers (mirror updates only on local UI actions
  even though tts_profiles sync) — pre-existing, documented, follow-up pool.

## 4. Design

### D1 — `INSTANCE_SCOPE_KEYS`: instance-scope keys write to the global table

New curated export in settings/sync-allowlist.js (co-located with
SYNC_ALLOWLIST so the two lists are reviewed together):

```js
export const INSTANCE_SCOPE_KEYS = {
  auto_update_enabled:         "Auto-update on/off (per install)",
  auto_update_interval_hours:  "Auto-update check interval (per install)",
  notification_prefs:          "Notification type gating (per install)",
  discovery_enabled:           "Peer discovery opt-in (per install)",
  discovery_name:              "Peer discovery display name (per install)",
  onboarding_completed_at:     "Onboarding completion stamp (per install)",
  language:                    "Dashboard language default (per install)",
  "blog_*":                    "Blog config — the blog is hosted per instance",
  tts_voice:                   "Legacy TTS voice mirror (per install)",
};
export function isInstanceScope(key) { /* same matcher shape as isSyncable */ }
```

`writeSetting` (registry.js) global branch becomes:

```js
if (scope === "global" && !isSyncable(key) && !isInstanceScope(key)) {
  // downgrade-to-local (or throw when allowLocalFallback:false) — UNCHANGED
}
// global write:
...INSERT INTO dashboard_settings...
if (isSyncable(key)) await emitSettingsSync("update", { key, value, instance_id: null });
```

The emit is now **explicitly** gated on `isSyncable` rather than relying on the
manager's shouldSyncRow filter — instance-scope writes emit nothing (the
manager gates remain as defense in depth). Consequences, all mechanical:

- Every writer above (all `upsertSetting` callers) starts landing in the global
  table. Every global-direct reader — the auto-update timer, the notification
  delivery gate, the peer discovery API, the public blog, the blog MCP, the
  media bundle (separate processes included) — becomes correct **unchanged**.
- The self-reverting forms (updates, discovery, blog, notifications, language
  dropdown) start persisting visually, because their renders read global.
- The override-aware readers (theme render theme.js:31, dashboard layout
  index.js:798, main-chrome language index.js:797, menu preview
  readSettings("%")) also become correct once D2 clears the stranded overrides
  (no override → global fallback).
- A key must never appear in both lists: enforced by a test asserting zero
  overlap, pattern-aware in both directions (e.g. `blog_*` vs a hypothetical
  future `blog_x` allowlist entry).

Rejected alternative (Approach B): convert ~20 readers across 4 processes to
override-then-global resolution and re-point the 3 dual writers at the
overrides table. 5× the churn (cross-process imports of registry.js — verified
clean but unnecessary), and it expresses "per-instance" through a table whose
purpose is per-instance divergence *from a fleet value* that doesn't exist for
these keys.

### D2 — One-shot boot heal `__instance_scope_heal_v1`

Same pattern as Cluster B's `__profile_override_heal_v1` (profile-heal.js), new
module `servers/gateway/dashboard/settings/instance-scope-heal.js`:

- For every `dashboard_settings_overrides` row of THIS instance
  (`instance_id = getOrCreateLocalInstanceId()`) whose key `isInstanceScope`
  (explicit keys + `blog_*` pattern; SQL enumerates overrides for this
  instance, filter in JS via isInstanceScope):
  - If no global row exists → promote (write global via `writeSetting`, which
    now routes instance keys to the global table), then delete the override.
  - If a global row exists → **newest `updated_at` wins**: promote only when
    `override.updated_at >= global.updated_at` (lexicographic compare is valid:
    both tables' writers use SQLite `datetime('now')` — registry.js:207,218,
    memory/server.js:1397-1399, blog/server.js:522-525,540-543,
    panels/blog.js:74-77, migrations.js:135; R1 verified every writer). Tie →
    override wins (the override is by construction the broken-era UI write
    being healed). **NULL/empty `updated_at` guard (R1 MINOR-1** — both columns
    are nullable `TEXT DEFAULT (datetime('now'))`, init-db.js:1093,1735, so a
    hand-edited/legacy row must not silently lose via `null >= "…"` coercion;
    columns at init-db.js:1094,1736):
    explicit precedence — global ts NULL/empty → override wins; else override
    ts NULL/empty → global wins; else lexicographic. Both-NULL falls into the
    first branch (override wins, consistent with the tie rule). Either way the
    override row is **deleted** — post-D1, overrides for instance-scope keys
    are meaningless and would keep shadowing the override-aware readers (the
    blog_theme_* chrome/public split).
  - Unlike Cluster B there is NO empty-value guard and NO fleet hazard: nothing
    here syncs; promoting `""` is a local, per-instance act (e.g. a cleared
    discovery_name), and the newest-wins rule already arbitrates dual-writer
    history. Clock comparison is safe here for the same reason it was unsafe in
    Cluster B: both rows were written by processes on ONE host sharing one DB.
- Ordering: promote strictly BEFORE delete (crash between the two re-runs
  idempotently: equal values re-promote, then delete). Flag row written LAST,
  raw `INSERT ... ON CONFLICT(key)` / raw SELECT (mirroring
  reemitSyncableSettingsOnce and profile-heal — NOT via upsertSetting, whose
  routing would misfile the flag).
- Placement: the boot one-shot block in servers/gateway/boot/mcp-mounts.js
  (beside healProfileOverridesOnce, :84-89) but **deliberately NOT gated on
  `syncManager`/`feedsDisabled`** — the heal is a pure local-DB transformation
  with zero sync side effects; a `--no-auth` companion gateway sharing the
  primary's DB may run it first with an identical result (same data dir → same
  instance-id → identical override enumeration; verified R2). DB handle: use
  `createDbClient()` (already imported in mcp-mounts.js:17), **NOT
  `syncManager.db`** (R2 minor — a genuinely null syncManager would otherwise
  NPE-and-skip, silently voiding the ungated claim). Value: unlike the profile
  heal, a companion-only or null-syncManager boot still heals (closes the
  "null-syncManager boots never heal" gap for THIS heal class).
- Per-key failure isolation + retry (**R1 MAJOR-2** — these two goals conflict
  unless failure is tracked explicitly): each key is wrapped in its own
  try/catch (warn, continue), setting `hadFailure = true` in the catch; the
  flag is written **only when `hadFailure` is false**, so a partial failure
  retries every boot until clean. This is a DELIBERATE divergence from the
  profile-heal precedent, which writes its flag unconditionally after the loop
  and therefore never retries (profile-heal.js:70-75) — implementers must not
  "simplify" back to that shape; §5.4(h) mutation-guards it.

### D3 — Scope-route guard

`POST /api/settings/scope` (routes/settings-scope.js) rejects both directions
for instance-scope keys with 403 `code:"InstanceScoped"` and a message saying
the key is per-instance by design. Rationale: a demote would recreate exactly
this bug class (an override shadowing the override-aware readers while the
global-direct majority ignores it); a promote is meaningless (already global,
and must not emit). GET continues to report scope truthfully.

### D4 — Vestigial dead writes deleted (operator-approved)

- theme.js:98: remove the `upsertSetting(db,"dashboard_theme",...)` line. The
  `set_theme` action KEEPS returning `{ok:true}` — shared/layout.js:282 is a
  live caller; theme persistence actually flows through `set_theme_mode` →
  **`blog_theme_mode`** (theme.js:109-114; chrome mode read at
  index.js:801-802 — R2 corrected the key name; `blog_theme_dashboard_mode`
  belongs to the separate `update_theme` action, theme.js:121). Comment notes
  why the action is response-only.
- llm-settings-migration.js:173-179: remove the `llm_chat_default_provider_id`
  upsert block (zero readers repo-wide; migration's other work and its
  done-marking are untouched).
- init-db.js:2296's one-shot legacy migration reader is left alone (historical,
  global-read, fires only when blog_theme_mode is absent).

### D5 — vision_profiles reader conformance

bot-builder/data-queries.js:104 `loadVisionProfiles` switches from raw global
SELECT to `readSetting(db, "vision_profiles")` — the same resolution its three
sibling readers already use (vision-profiles.js:29, meta-glasses
routes.js:264,2424). vision_profiles is allowlisted (user-level), NOT added to
INSTANCE_SCOPE_KEYS; its write-scope default stays as designed.

### D6 — Auto-update disable takes effect without a restart

**Gate the TICK, not `checkForUpdates()` (R1 MAJOR-1).** `checkForUpdates()`
has TWO callers: the timer (auto-update.js:230-233) and the manual "Check for
updates now" button (settings section `updates`, action `check_updates_now`,
updates.js:165-167). A gate inside the function would silently break the
manual button for exactly the operator who disabled automatic updates but
wants to update on demand. Design: extract the timer callback into a
`tickCheck()` that re-reads `auto_update_enabled` via the existing
`getSettings()` and returns early (one log line) when not "true", otherwise
calls `checkForUpdates()`. The manual action keeps calling `checkForUpdates()`
directly, ungated. Fail-open semantics (R2-refined): `getSettings()` cannot
throw — it returns defaults (`auto_update_enabled:"true"`) on any DB error
(auto-update.js:39-52), and that state is indistinguishable from a legitimate
fresh install with no rows, which MUST proceed (auto-update defaults on). So a
DB blip at tick proceeds for that one tick — this briefly re-enables what the
operator disabled, but is consistent with the boot gate's identical defaulting
(:211-216), self-corrects at the next tick, and avoiding it would require
restructuring getSettings' error contract for a marginal case. Accepted,
stated. Boot behavior unchanged (env
`CROW_AUTO_UPDATE` still hard-wins before any DB read at :206; a boot-disabled
timer still never starts). Interval changes still require restart — the UI
already says "Restart gateway to apply new interval". This makes the headline
harm ("disabling auto-update in the UI is inert") CDP-provable
click-to-tick-skip, not click-to-restart-to-skip.

### D7 — Docs

- writeSetting docblock: document the three-way routing (synced / instance /
  local-fallback).
- INSTANCE_SCOPE_KEYS docblock: what qualifies a key (per-install behavior,
  global-direct readers OK, never synced), what disqualifies (user-level data →
  SYNC_ALLOWLIST; intentionally-local per-instance-divergent → readSetting
  readers + local scope), and the promotion path (allowlist + reemit bump).
- One-line comments at the healed families' render sites are NOT added (the
  global read is now simply correct); the D2 module carries the history.

## 5. Tests (TDD; mutation-test every guard)

1. `isInstanceScope`: true for all 9 entries + `blog_title`/`blog_podcast_language`
   (prefix); false for `feature_flags`, `profile_display_name`, `blog` (bare),
   random keys. Zero-overlap assertion between SYNC_ALLOWLIST and
   INSTANCE_SCOPE_KEYS, pattern-aware both directions.
2. writeSetting routing: (a) instance key + scope global → global row, NO
   overrides row, NO emit (spy manager records nothing) — **mutation**:
   removing the isInstanceScope branch must redden the table assertion;
   removing the `isSyncable` emit gate must redden the no-emit assertion;
   (b) allowlisted key → global + emit (unchanged); (c) non-listed key →
   local downgrade (unchanged); (d) `allowLocalFallback:false` on a non-listed
   key still throws NotSyncable, on an instance key succeeds globally.
3. End-to-end write→read per family (integration, real schema):
   `save_update_settings`-equivalent upsert → auto-update `getSettings()` sees
   it; UI-style notification_prefs save → `createNotification` suppresses a
   disabled type; discovery save → peer-public-api profile route flips 404→200
   with display_name; blog_title save → blog-public `getBlogSettings` reflects
   it; language save → setup-page `dbLang` resolves without cookie; onboarding
   completion → login-gate query sees it.
4. Heal: (a) override-only → promoted + override deleted + flag done:N;
   (b) second run no-op — **mutation**: dropping the flag check reddens;
   (c) override newer than global → override value wins; (d) global newer →
   global preserved AND override still deleted — **mutation**: dropping the
   updated_at comparison reddens (d); (e) no overrides → flag set, nothing
   written; (f) `blog_*` pattern keys healed; (g) non-instance-scope overrides
   (feature_flags, a profile key) are UNTOUCHED — **mutation**: relaxing the
   isInstanceScope filter reddens; (h) one key's error does not abort the
   others AND leaves the flag UNWRITTEN (retry next boot) — **mutation**:
   writing the flag unconditionally (the profile-heal shape) reddens;
   (i) heal runs without a sync manager (null/feedsDisabled) — asserts the
   deliberate ungated posture; (j) NULL-updated_at precedence: global-ts-NULL →
   override wins; override-ts-NULL → global wins — **mutation**: dropping the
   NULL guard reddens.
5. Scope-route: POST promote AND demote on an instance key → 403 InstanceScoped
   — **mutation**: removing the guard reddens; allowlisted + plain keys behave
   as before; GET unaffected.
6. D5: loadVisionProfiles returns a local-scoped vision_profiles row (red
   pre-fix, green post).
7. D6: with a global `auto_update_enabled='false'`, the TICK path skips without
   fetching — **mutation**: removing the tick re-check reddens — while a
   direct/manual `checkForUpdates()` invocation with the same DB state STILL
   runs (the R1 MAJOR-1 regression made red-able); with 'true' the tick
   proceeds. Fail-open case (R2 reframe — `getSettings()` cannot throw): on a
   broken/unavailable DB it returns defaults → the tick PROCEEDS (assert via a
   db stub that errors; not via a throw, which is unreachable). Env
   kill-switch precedence test unchanged.
8. D4: `set_theme` action still returns ok and writes NOTHING anywhere;
   llm migration writes no llm_chat_default_provider_id row; both migrations'
   existing suites stay green.
9. Full suite ≥ current baseline (re-baseline main in a clean worktree first —
   1397/1/1 expected; the 1 fail is the pre-existing rookery registry drift,
   possibly fixed by then); gateway boots clean; `--no-auth` boot runs the heal.

## 6. Verification beyond the suite (HARD REQ: browser-click, CDP)

Scratch pair per the Cluster-A recipe (distinct host IPs 10.0.0.237 vs
100.118.41.122, `CROW_AUTO_UPDATE=0` NOT set on the instance under test for the
auto-update scenario — use a scratch data dir + short interval,
`CROW_DISABLE_HEALTH_MONITOR=1`, real minted sessions; drivers at
~/.crow/p4/cluster-a-evidence/):

- **Updates**: real click Disable + Save → form re-renders showing Disabled
  (was: reverts); DB global row `auto_update_enabled='false'`, no override; the
  next tick logs the skip (timer check — the operator's named hard req).
- **Discovery**: real click Enable + name + Save → form persists; `GET
  /discover/profile` flips 404→200 carrying the name.
- **Blog**: edit blog_title via the settings form → form persists; public
  `/blog` renders the new title.
- **Notifications** (mixed: browser click + node probe — R2 framing): uncheck a
  type + Save in the browser → checkboxes persist; then a NODE PROBE against
  the scratch DB asserts `createNotification` of that type returns null (the
  gate is server-side, servers/shared/notifications.js:44 — not observable in
  the DOM; alternatively observe the bell not populating).
- **Language** (mixed — R2 framing): save Español (authed click) → in a FRESH
  CDP browser context WITHOUT the crow_lang cookie, the pre-auth readers
  (setup/help pages) and the authed language dropdown (minted session, no
  cookie) render Spanish.
- **Heal**: boot a scratch gateway on a DB seeded with broken-era overrides
  (incl. one where global is newer — dual-writer case) → log shows promotions,
  overrides table empty for instance keys, flag done.

Post-deploy prod (fleet: crow, MPA, grackle, black-swan):
- Snapshot `SELECT key,value FROM dashboard_settings WHERE key LIKE 'blog_%'`
  on grackle BEFORE deploy; after the heal boot, values byte-identical unless a
  NEWER stranded override legitimately won (report any diff before calling it
  done — grackle's live public blog must not change unexpectedly).
- Verify heal log + flag row on each instance; overrides table has no
  instance-scope keys left.
- Crow: Updates form now persists a save (the live F-SETTINGS-1-class symptom).
- No profile regression (allowlist path untouched): profile_display_name still
  'Kevin' fleet-wide.
- Per the pinned harness lesson: before any live E2E, `fuser ~/.crow/data/crow.db`
  and kill this session's stale stdio MCP subprocesses.

## 7. Risks / review focus

- **Newest-wins heal vs dual writers**: the only keys with real global-row
  history are notification_prefs (MCP), blog_* (MCP + panel), tts_voice (boot
  migration). A stale override losing to a newer MCP write is the designed
  outcome; the reverse (override wins) restores the user's latest UI intent.
  Review the tie rule and the lexicographic-compare premise (both writers use
  datetime('now') UTC).
- **Behavior flips at deploy**: healed values become live — e.g. a long-ignored
  "auto-update disabled" override starts actually disabling auto-update on that
  instance; a stranded discovery_enabled=true starts answering `/discover/profile`.
  This is the point of the fix, but the deploy checklist must enumerate what
  each prod instance's stranded overrides WILL activate (query them pre-deploy).
- **Override-aware readers change value post-heal** (blog_theme_* chrome,
  language main chrome, menu preview): they flip from the override to the
  global row — i.e. the dashboard converges to what the public blog was already
  showing. Visible, intended, called out in the deploy plan.
- **`emitSettingsSync` now explicitly gated on isSyncable** inside writeSetting:
  confirm no caller depended on the (filtered) emit call for non-allowlisted
  keys (it was always dropped by shouldSyncRow — dead in effect).
- The heal deliberately runs on `--no-auth` companion gateways (shared DB,
  idempotent, no sync side effects) — the inverse of the profile heal's gate;
  reviewers should check this asymmetry is stated and tested, not accidental.
- The heal is racy against a SIMULTANEOUS live MCP write in the boot window
  (R1 MINOR-2: e.g. `crow_notification_settings` firing exactly while the heal
  compares timestamps → the fresh global write can lose to an older override).
  Boot-window-narrow, value-restorable via the same tool, accepted; not
  engineered around.
- D3 is pure hardening, NOT a UI breaking change (R1 MINOR-3): the scope
  toggle UI renders interactive radios only for `isSyncable` keys
  (shared/scope-toggle.js:22-27) and its only callers are the four allowlisted
  profile sections — no UI path can POST a scope change for an instance-scope
  key. The 403 guards hand-crafted requests; the client handler surfaces
  `data.error` if one is ever made.
- The §1 blog key enumeration is illustrative, not load-bearing (R1 MINOR-4):
  the `blog_*` prefix also captures the bare legacy `blog_theme` settings key
  (benign — instance-scope treatment is correct for it) and any future blog_
  key; non-settings identifiers that merely start with "blog_" (table/tool
  names) have no dashboard_settings rows and are unaffected.
