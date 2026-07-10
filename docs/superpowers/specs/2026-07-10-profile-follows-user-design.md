# Profile follows the user — Cluster B design (F-SETTINGS-1 + F-CONTACT-5)

Date: 2026-07-10 · Arc: Crow Messages usability overhaul, P4 walkthrough Cluster B
Findings: F-SETTINGS-1 [S4-MAJOR] (UI profile save is a silent no-op), F-CONTACT-5
[S4-MAJOR] (shared-identity fleet answers one invite in triplicate with divergent
self-names). Independent of Clusters C/D.

## 1. Problem

`save_profile` (servers/gateway/dashboard/panels/contacts/api-handlers.js:359-365)
writes `profile_display_name` / `profile_avatar_url` / `profile_bio` via
`upsertSetting` → `writeSetting(scope:"global", allowLocalFallback:true)`
(settings/registry.js:262). None of the three keys is in `SYNC_ALLOWLIST`
(settings/sync-allowlist.js), so `writeSetting` silently downgrades the write to a
**local** `dashboard_settings_overrides` row (registry.js:192-210).

Every reader queries the global `dashboard_settings` table directly and can never
see that row:

- `getMyProfile` — contacts/data-queries.js:129 (the profile page re-renders EMPTY
  right after saving);
- `readLocalDisplayName` — servers/sharing/boot.js:39 (the inviter-side
  `handshake_complete` ack name, shipped in #155);
- the acceptor-side `invite_accepted` name — servers/sharing/tools/contacts.js:73.

So the UI save appears to do nothing, and #155's name-in-handshake is inert via the
product UI. Empirically confirmed live 2026-07-10 (p4-findings.md F-SETTINGS-1).

The write site's own comment says the value "is SENT on every handshake and syncs
to all of the user's instances" — the intent was global+synced; the allowlist entry
was never added when the settings-scope refactor introduced the downgrade.
Corroboration: grackle carries **pre-refactor** global rows written 2026-03-22
(`profile_display_name='Kevin Hopper'`, a real `profile_bio`, empty
`profile_avatar_url`) — the profile UI used to write the global table.

**F-CONTACT-5** is the same defect observed fleet-wide: crow, MPA and grackle (one
shared identity, all subscribed on the same key) each independently process an
acceptor's `invite_accepted` and each replies `handshake_complete` carrying **its
own** `dashboard_settings` value — crow='Kevin' (SQL workaround), MPA=unset,
grackle='Kevin Hopper' (the March row). Relay race decides which name the acceptor
stores.

## 2. Non-goals

- No change to Clusters C (F-BLOCK-1) or D (F-HEALTH-2).
- No handshake-ack dedup (see §3 D5).
- No fix for the 12+ *other* keys the audit found broken by the same refactor
  (§6) — dedicated follow-up PR; per-key judgment required.
- No schema change. `SYNC_ALLOWLIST` is code; the heal and re-emit use existing
  tables. **SCHEMA_GENERATION stays 6** (verified: no DDL anywhere in this design).

## 3. Design

### D1 — Sync-allowlist the three profile keys (the root fix)

Add to `SYNC_ALLOWLIST` (sync-allowlist.js) as **explicit entries** (no `profile_*`
prefix — keeps the curated-list posture; a future key named `profile_...` must be
consciously added):

```js
profile_display_name: "Own profile — display name (sent in pairing handshakes)",
profile_avatar_url:   "Own profile — avatar URL",
profile_bio:          "Own profile — bio",
```

Consequences, all mechanical from existing machinery:
- `upsertSetting` now writes the **global** `dashboard_settings` row and emits via
  `emitSettingsSync` → `InstanceSyncManager.emitChange` (registry.js:220). The
  emit-side gate (instance-sync.js:207-211) and apply-side gate
  (instance-sync.js:923, `_applyDashboardSetting`) both key on `isSyncable`, so
  allowlisting enables replication in both directions with no sync-code change.
- All three direct readers become correct **unchanged**.
- F-CONTACT-5 root fix: all instances of a shared identity converge on one name, so
  the triplicate `handshake_complete` acks carry identical `displayName` and the
  acceptor race becomes harmless.

Alternatives considered:
- *(b) effective-value read helper for all three readers* (readSetting): rejected as
  the primary fix — it repairs the local symptom but NOT F-CONTACT-5 (each instance
  would still hold a divergent private value), and profile identity is user-level
  data that should follow the user like contacts/groups do (S7-proven pattern).
- *display_name only*: rejected — avatar/bio saves would remain silent no-ops
  against the same global-reading `getMyProfile`. All three are user-level profile
  fields. Caveat noted: a synced `profile_avatar_url` that points at
  instance-local storage renders broken images on peers — pre-existing class,
  out of scope (noted for the generalization theme).

Security: same trust class as existing synced settings (`ai_profiles` is far more
sensitive). A compromised paired instance could already rewrite synced settings;
display name adds nothing new. **The real defense in depth (R1 MINOR-2):** the
sync-apply path (`_applyDashboardSetting`, instance-sync.js:1067) writes peer
values RAW — the protections are (a) every dashboard render of profile values is
escapeHtml'd (contacts/html.js, components.js formField), and (b) both handshake
readers re-sanitize via `sanitizeDisplayName` at READ time (boot.js:42,
tools/contacts.js:76), so a raw synced value never reaches a handshake or an
unescaped sink. Any future reader of `profile_*` must follow the same rule
(comment at the allowlist entries).

### D2 — `save_profile` clears stranded local overrides

After each `upsertSetting` in `save_profile`, call `deleteLocalSetting(db, key)`
for that key. Rationale: every install that used the profile UI during the broken
era has a stranded `dashboard_settings_overrides` row (crow does, live). Overrides
shadow `readSetting`-based reads forever; clearing on save makes the global row
authoritative from the next user action.

Deliberately **not** changing `writeSetting`'s global branch to clear overrides
globally: sections UI + scope-route interactions for other keys (e.g. a user who
deliberately demoted an allowlisted key to local) would silently lose their
demotion on any global write. Targeted beats global here. The `writeSetting`
docblock (registry.js:181) currently **claims** the global path "clears any local
override" — the code never has (only the scope route does, settings-scope.js:76).
Fix the docblock to match reality.

### D3 — One-shot boot heal for stranded broken-era values

Flag-guarded one-shot (`dashboard_settings` flag row `__profile_override_heal_v1`,
same pattern as `__sync_reemit_allowlist_v1` / `__contacts_backfill_v1`): for each
of the three profile keys, if a local override row exists for this instance:
- override value **non-empty** (after trim) → promote it to the global scope
  (`writeSetting` global — which now emits) and delete the override;
- override value **empty** → delete the override only (never promote `""`).
  Rationale: `save_profile` writes every submitted field, so a broken-era save
  that set only the name may have stranded empty avatar/bio overrides — promoting
  those would blank a peer's real pre-refactor global values (grackle's live bio)
  fleet-wide. Conservative trade: a deliberate broken-era *clear* is not healed;
  the user re-clears via the now-working UI.

- A non-empty override wins over any existing global row: the override is by
  construction the user's **latest** intent (it can only have been written by the
  broken-era `save_profile`; post-refactor override > pre-refactor global by
  construction of the bug — no clock comparison needed).
- Flag-guarded so a **deliberate** post-upgrade local demotion (possible once the
  keys are allowlisted, via POST /api/settings/scope) is never clobbered by a later
  boot. (Note: local overrides of profile keys have no effect anyway — readers are
  global-direct, D6 — but the heal must still not eat them.)
- **Ordering (R1 MAJOR-1):** `setSettingsSyncManager(syncManager)` is currently
  wired at mcp-mounts.js:105 — AFTER the reemit call at :73 — so a heal placed
  before the reemit would emit into a null manager (registry.js:129 early-return)
  and its "writeSetting emit covers it" fallback would be dead code. Fix: move
  `setSettingsSyncManager(syncManager)` ABOVE the heal/reemit block (nothing
  between :73 and :105 needs it late — the contacts/groups backfills call
  `syncManager.emitChange` directly), then run the heal, then
  `reemitSyncableSettingsOnce()`. The heal's `writeSetting` emit is then real, so
  correctness no longer depends on the two one-shot flags staying coupled.
- **Gating (R1 MINOR-5):** the heal runs inside the same guarded block that owns
  `syncManager` (i.e. only when instance-sync is actually initialized) — a
  `--no-auth` companion gateway sharing the primary's DB must not race the flag
  write or double-run the heal.
- Fix-the-product rationale: a user who typed their name into the silently-broken
  UI gets it restored (and syncing, and in handshakes) at upgrade with no re-save.

### D4 — Re-emit flag bump v1 → v2

Rename `reemitSyncableSettingsOnce`'s `FLAG_KEY` to `__sync_reemit_allowlist_v2`
(instance-sync.js:471). The v1 flag is `done:` on every fleet instance (crow live:
`done:9`), so **pre-existing global rows** for the newly-allowlisted keys
(grackle's March name + bio; any pre-refactor install in the wild) would otherwise
never replicate until the next manual save. The re-emit is idempotent on the apply
side (`_applyDashboardSetting` skips stale-lamport and unchanged-value rows) and
small (re-emits only allowlisted keys, ~a dozen rows).

**Empty-value guard (R1 MAJOR-2):** the re-emit loop SKIPS profile keys whose
global value is empty/whitespace. Without this, any instance holding an
empty-string global `profile_bio`/`profile_avatar_url` row (grackle has an empty
avatar row live) could win the lamport race and blank a peer's real value —
exactly the data (grackle's March bio) the deploy plan promises to preserve. The
asymmetry is deliberate: the re-emit is a *historical reconciliation* where an
empty row is indistinguishable from "never set", while a **live** save of `""`
(D2 path) still emits — a deliberate clear propagates.

**LWW characterization (R1 MINOR-1):** each re-emit gets a fresh per-instance
lamport from `_nextLamport`, so divergent values resolve to whichever instance
holds the higher sync counter — a function of sync history, not boot order; an
equal-counter tie is non-commutative ("incoming wins", instance-sync.js:1054) and
can transiently swap values. Accepted: same conflict class the settings sync
already carries, bounded, and the deploy plan's operator save settles it
deterministically. The v1 flag row remains as a harmless orphan.

**Deploy-together constraint (R1 noted):** an old-code peer silently DROPS a
profile sync row (shouldSyncRow gate, instance-sync.js:925) and still advances its
checkpoint — it will not re-read that entry after upgrading. crow/MPA/grackle must
deploy together; a late upgrader needs one fresh source-side save. Re-emitting
`storage.shared.*` rows with fresh lamports also re-fires `_scheduleStorageReset()`
on peers at the deploy boot (R1 MINOR-4) — a one-time storage-client reconnect
blip, noted in the deploy plan.

### D5 — No handshake-ack dedup (F-CONTACT-5 optional half — rejected, YAGNI)

Multi-instance `handshake_complete` acks stay. They are idempotent
(`markDelivered` + name applied only over a placeholder, boot.js:297) and, post-D1,
identical in content **in steady state** (R1 MINOR-3: during the ~3s window after a
rename the three acks can diverge, and the acceptor's first non-placeholder
application is permanent — narrow, cosmetic, acceptor can rename; documented, not
engineered around). Deduping would require cross-instance coordination on the
receive path for zero user-visible gain. Documented here as the deliberate
disposition of the finding's "optionally dedupe" clause.

### D6 — Readers stay global-direct

`getMyProfile`, `readLocalDisplayName`, and the acceptor-side read keep querying
`dashboard_settings` directly. Post-D1 the global row IS the value; user-level
identity should not vary per instance, so ignoring per-instance overrides is the
*correct* semantic, not an accident. Documented via a short comment at each read
site.

## 4. Tests (TDD; mutation-test every guard)

1. `isSyncable("profile_display_name"|"profile_avatar_url"|"profile_bio")` → true;
   an unrelated `profile_zzz` → false (explicit-entry posture).
2. Write-scope integration: `save_profile`-equivalent `upsertSetting` on a profile
   key lands in `dashboard_settings` (not overrides) and emits a
   `dashboard_settings` sync change with `instance_id:null`.
3. D2: a stranded override + a save → override row gone, global row set.
4. D3 heal: (a) override-only state → promoted to global + override deleted + flag
   `done`; (b) second run is a no-op (flag) — **mutation test**: removing the flag
   check must redden this; (c) override + pre-existing global → override value
   wins; (d) no overrides → flag still set, nothing written; (e) promoted value is
   emitted (or picked up by re-emit when ordered before it); (f) **empty-string
   override → deleted, NOT promoted, existing global untouched** — **mutation
   test**: dropping the non-empty guard must redden this on the global-value
   assertion (the fleet-blanking hazard made explicit).
5. D4: with the new allowlist, `reemitSyncableSettingsOnce` under the v2 flag
   re-emits an existing global `profile_display_name` row exactly once —
   **mutation test**: reverting FLAG_KEY to v1 with a `done:` v1 row present must
   redden this.
5b. D4 empty-value guard: an empty-string global `profile_bio`/`profile_avatar_url`
   row is NOT re-emitted while a non-empty one is — **mutation test**: dropping the
   guard must redden this (the fleet-blanking hazard made explicit).
5c. D3/D4 ordering: `setSettingsSyncManager` is wired before the heal runs — a
   heal promotion with the manager wired emits a `dashboard_settings` change
   (asserts MAJOR-1's fix; reddens if the wiring moves back below the block).
6. End-to-end read path: after a UI-style save, `readLocalDisplayName` (boot.js)
   and the tools/contacts.js acceptor read return the saved, sanitized name
   (extends tests/handshake-display-name.test.js).
7. Apply side: `_applyDashboardSetting` accepts a peer's `profile_display_name`
   row (allowlist gate) and a non-allowlisted key is still rejected.
8. Full suite ≥ baseline 1376/0/1; gateway boots clean.

## 5. Verification beyond the suite (HARD REQ: browser-click)

- **CDP scratch pair** (Cluster-A recipe: distinct host IPs 10.0.0.237 vs
  100.118.41.122, `CROW_AUTO_UPDATE=0`, `CROW_DISABLE_HEALTH_MONITOR=1`, real
  sessions): drive the real profile form save in the browser → the page re-renders
  showing the saved name/bio (the exact F-SETTINGS-1 symptom), DB shows the global
  row, override cleared.
- **Post-deploy prod reconciliation** (this closes the lab's live divergence and IS
  the product-path heal): deploy fleet → boots run D3+D4 → CDP product-path save
  `display_name='Kevin'` on crow → verify grackle+MPA converge (~3s), grackle's
  March bio has propagated fleet-wide, each instance's
  `SELECT value FROM dashboard_settings WHERE key='profile_display_name'` returns
  'Kevin', crow's stale override is gone. ('Kevin' = Kevin's most recent intent,
  set 2026-07-10; trivially changeable via the now-working UI — flagged at the PR
  gate.)
- Black Swan pairing (crow contact 11) untouched; a live re-handshake is NOT
  required — the name-carry mechanism was live-proven in the walkthrough; what was
  broken was only the value's source.

## 6. Audit outcome (F-SETTINGS-1 mandate): the bug class is much bigger

Repo-wide audit of every `upsertSetting` caller (2026-07-10, this session): the
same write-local/read-global mismatch breaks **12+ more keys**. NOT fixed in this
PR — each needs per-key judgment (a blanket `upsertSetting`→global revert would
break `feature_flags`, whose local scope is intentional and consistently read via
`readSetting`). Queued as a dedicated **"settings-scope coherence"** follow-up PR.

| key | broken reader(s) | impact |
|---|---|---|
| onboarding_completed_at | dashboard/index.js:207 | login redirect keeps routing to /onboarding |
| notification_prefs | shared/notifications.js:44, memory/server.js:1376 (+dual global writer :1398) | UI notification toggles don't affect delivery |
| discovery_enabled / discovery_name | boot/peer-public-api.js:45,54,90 | enabling discovery in UI never reaches the peer API |
| blog_title/tagline/author/listed (+blog_theme_*) | servers/blog/server.js:68,411,470,614; routes/blog-public.js:573 (+dual writer blog/server.js:522) | gateway blog settings never reach the public blog / MCP server |
| auto_update_enabled / auto_update_interval_hours | scripts→gateway auto-update.js:41→:213,:224 | **disabling auto-update in the UI is inert** — ship with F-UPDATE-1 |
| tts_voice | bundles/media/server.js:676, media/panel/routes.js:411,631 (+dual writer migrations.js:135) | media TTS uses stale voice |
| language | setup-page.js:65, help-setup.js:23 | mitigated by crow_lang cookie |
| dashboard_theme, llm_chat_default_provider_id | none found | write-only/vestigial — confirm in follow-up |

CONSISTENT (no action): feature_flags, kiosk_mode, migration flags — all readers
use `readSetting`.

## 7. Risks / review focus

- D4 LWW nondeterminism between divergent pre-existing rows (crow 'Kevin' vs
  grackle 'Kevin Hopper') until the operator's next save — accepted, bounded, and
  the deploy plan performs that save.
- D3 must never run per-boot without the flag (would clobber deliberate future
  demotions) — mutation-tested.
- Synced avatar URL may reference instance-local storage — cosmetic, pre-existing
  class, documented.
- `save_profile` writes `""` (not delete) for cleared fields — post-D1 an empty
  string syncs and blanks peers' values: that is the correct "clear everywhere"
  semantic.
