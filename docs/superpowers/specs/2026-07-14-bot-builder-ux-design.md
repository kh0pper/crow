# Bot Builder UX overhaul + non-technical tutorial — design spec

**Date:** 2026-07-14 · **Arc item:** 5 (THEME, master plan
`docs/superpowers/plans/2026-07-11-opus-autonomous-arc.md` §4) · **Status:**
**APPROVED** — 3 adversarial rounds (R1 REVISE → R2 REVISE → R3 closure
APPROVE); full record in §7

**Kevin's verbatim ask:** "can we make the bot builder interface easier to use?
maybe make it all more intuitive, and a cleaner interface. i think we also need a
solid tutorial for using the bot builder written for non technical users."

**Beachhead user:** a non-technical public-education admin on a fresh single-click
install. Every decision below is tested against *that* person, per the standing
`fix-the-product-not-the-instance` directive.

---

## 0. Preflight audit (re-verified against main `747e927e`, 2026-07-14)

The June-2026 audit in the master plan, corrected for Item 4's changes:

- Panel = `servers/gateway/dashboard/panels/bot-builder/` — 2,215 lines / 7 files
  (`html.js` list+create+monitor, `editor.js` 998-line tabbed editor,
  `api-handlers.js`, `data-queries.js`, `crow-messages-admin.js`, `css.js`,
  `peer-edit.js`).
- **Create form is now honest (Item 4 PR1):** model optgroups from
  `loadModelOptions(db)` (providers-table-driven), no hardcoded `selected` pin,
  empty state = warn + providers-settings link + disabled submit.
  `defaultDefinition()` throws on falsy model and ships `gateways: []`.
- **Post-create dead-end:** create redirects to `?bot=<id>&tab=ai&saved=1` — the
  new user lands in the raw 9-tab editor with no guidance, no channel, and the
  bot already `enabled=1`.
- **9 equally-weighted tabs** (AI/Models, Tools & Extensions, Gateways,
  Project/Tracker, Skills & Prompt, Permissions/Safety, Triggers, Sessions,
  Review/Deploy). No wizard, templates, or progress cues.
- **Review tab:** good bones (an "effective runtime decision" table computed via
  `model_resolver.mjs`) but the default view is the raw definition JSON `<pre>`
  plus a "Regenerate .mcp.json" button.
- **Jargon is worse than the June audit recorded:** user-facing copy leaks
  internal plan references ("Slice B", "S4", "Phase 3.1", "F4a Layer 2a", "R13",
  "plan §2") plus `pi_bot_defs`, `bridge --inject`, `secp256k1 hex`,
  `mcp-addons.json`, "fail-closed fallback". Section titles include raw table
  names ("Bots (pi_bot_defs)", "Run monitor (bot_sessions — live, 5s)").
- **~19 hardcoded English hint paragraphs** (grown from ~15). **128**
  `botbuilder.*` i18n keys exist (was 103); tabs, labels, buttons, and all
  gateway hints are already keyed EN+ES. Pinned constraint in `editor.js`
  header: inline `<script>` fragments are frozen EN (only `tJs()` confirm
  strings are keyed) — this spec **keeps** that policy.
- **Gateways tab:** 9 types. discord/telegram/slack demand raw tokens + numeric
  platform IDs; **crow-messages is already the friendliest** (share link + QR +
  ACL name list) and needs zero external credentials; companion has one-step
  kiosk creation; glasses needs a paired device; signal is "coming soon"
  (disabled).
- **No delete action exists** — `api-handlers.js` actions are create / toggle /
  toggle_peer_managed / gw_* / regen_mcp / save_*. A bot can only be disabled,
  never removed. Wizard experimentation will mint junk bots users can't clean up.
- **Create is an UPSERT** (`ON CONFLICT(bot_id) DO UPDATE`): submitting an
  existing bot_id silently replaces that bot's entire definition with fresh
  defaults. Silent data loss; must be fixed by this theme.
- **Onboarding wizard's "bot" step** (`panels/onboarding.js`, Item 4 PR2) just
  deep-links to `/dashboard/bot-builder` — the raw panel.
- Assets to reuse: `stepper()/section()/button()/callout()` in
  `shared/components.js` (proven by the onboarding wizard), `.btb-hint` CSS,
  `t()/tJs()` i18n, `docs/guide/bot-builder.md` EN+ES (reference doc, not a
  tutorial), tests `bot-builder-create-honesty/csrf-inputs/gateway-draft.test.js`
  + `onboarding-steps.test.js` (STEP_KEYS-derived pattern).
- Docs site: VitePress, base `/software/crow/`, EN + ES locales, deploy-docs on
  any `docs/**` push to main.

**Item 4 sequencing precondition: satisfied.** Both the create form and the AI
tab derive models from `loadModelOptions(db)`. The wizard reuses exactly that.

---

## 1. Approaches considered

- **A (chosen): server-rendered guided wizard beside the existing editor.**
  A `?new=1&step=N` flow inside the bot-builder panel, reusing the onboarding
  wizard's stepper machinery; templates as a data module; the 9-tab editor
  remains untouched as the "advanced" surface; the Review tab becomes a
  plain-language readiness checklist. Matches codebase idiom (server-rendered,
  minimal JS), reuses proven Item 4 patterns, zero regression risk to power-user
  flows.
- **B (rejected): rework the tabbed editor into a progressive flow.** Reordering
  tabs and gating progression is cheaper but still presents nine surfaces to a
  novice, and any misstep regresses the only power-user editor.
- **C (rejected): client-side JS wizard.** Against panel idiom (no client
  framework, frozen-EN inline-script policy), harder to i18n, more fragile under
  CDP verification.

---

## 2. Design

### D1 — Guided creation wizard

**Route:** `/dashboard/bot-builder?new=1&step=<0..4>` handled inside the existing
panel handler (no new panel registration; session gating and CSRF identical to
the rest of the panel). `STEP_KEYS = ["template", "basics", "model", "channel",
"review"]` exported from the new `wizard.js` module so tests derive positions
(onboarding pattern).

**Steps** (one decision per screen, `stepper()` progress on top, Back/Next nav):

0. **template** — radio cards (no JS): Personal assistant (default), Email
   responder, Discord Q&A, Project manager, Start from scratch. Card copy is
   i18n'd EN+ES (title + one-sentence description + "what you'll need" line,
   e.g. Discord: "You'll need a free Discord bot token — the tutorial shows
   how").
1. **basics** — Display name (required). bot_id is auto-derived
   (slugify: lowercase, `[^a-z0-9_-]+` → `-`, trim dashes; collision → `-2`,
   `-3`, …) and shown as muted helper text ("Internal id: research-scout"),
   editable inside a `<details>` "Advanced" disclosure. No project field —
   linking a project stays on the Tracker tab, surfaced later by the checklist.
2. **model** — the same provider-grouped `<select>` as the create form, built
   from `loadModelOptions(db)`. Zero models ⇒ the step renders the warn +
   providers-settings link and **disables Next** (mirrors Item 4 create-form
   honesty; never a submittable empty select).
3. **channel** — gateway type preselected by the template but changeable; the
   per-type credential fields are rendered by the **shared gateway-fields
   renderer** (D3) — identical fields to the Gateways tab. A "Skip for now"
   action is always present (bot keeps `gateways: []`; the checklist will show
   the gap). Types that need external setup show their one-line "what you'll
   need" hint + tutorial link. `crow-messages` needs no credentials (its
   share-link management stays on the Gateways tab post-create; the wizard just
   selects the type).
4. **review** — plain-language summary (template, name, model, channel) +
   Create button. **No DB row exists until this POST.**

**State machine (explicit — this is a net-new mechanism; the onboarding wizard
contributes only its *components* (`stepper()`, `button()`, `callout()`), not
its navigation, which is stateless GET links and carries nothing):**

- Every step renders ONE form that POSTs back to the wizard route with
  `action="wizard_step"`, all previously-collected fields re-emitted as hidden
  inputs, and **both Back and Next as submit buttons** (`name="nav"`,
  `value="back"|"next"`) — so state survives navigation in either direction,
  including secrets entered at the channel step. No GET deep-link into a middle
  step is supported: a bare GET on `?new=1` (any step param) renders step 0
  fresh.
- **The wizard form carries `data-turbo="false"` (adversarial round 2,
  CRITICAL-A).** `wizard_step` responds 200-with-HTML (a 303 would drop the
  POST body and §D1 forbids secrets in query strings), but the vendored Turbo
  8.0.5 — on by default (`CROW_ENABLE_TURBO=0` is the only opt-out) — treats a
  non-redirect top-level form response as an error ("Form responses must
  redirect to another location") and discards it: the wizard would simply not
  advance on default prod config, and the browser-less scratch suite cannot
  see it. `data-turbo="false"` is the codebase's established escape hatch —
  form-level render-on-POST precedent at `panels/contacts/html.js:119` and
  `shared/peer-invite-ui.js:61/119`, with the CSRF pattern for classic form
  posts documented at `layout.js:420`. The final `wizard_create` stays PRG
  (303 via `redirectAfterPost`) and needs no opt-out (a native-followed 303
  is functionally identical to a Turbo visit here).
- **Where rendering lives (round 2, MINOR-4):** `handleBotBuilderPost` is
  called with only `{ db }` and its header advertises
  redirect-after-POST-only semantics. `wizard_step` rendering therefore
  routes in the panel handler (`bot-builder.js`), which already has
  `layout`/`lang`; `api-handlers.js` keeps its PRG-only contract (only
  `wizard_create` lands there), and its header comment is updated if any
  wizard action touches it.
- No draft rows, no server-side wizard session. Secrets travel only in POST
  bodies, never query strings (same exposure class as the Gateways tab, which
  re-emits saved tokens into password inputs). Every step form carries
  `csrfInput(req)`.
- Refresh mid-wizard triggers the browser's re-submit prompt; harmless — the
  re-POST re-renders the same step and creates nothing (no row exists until
  final create). Accepted and documented.
- **Final create is PRG + conflict-tolerant:** `wizard_create` redirects
  (303) to the checklist on success. If the bot_id already exists at final
  POST (double-click / re-submit race), it redirects to that bot's checklist
  with a neutral "already created" notice instead of an error banner —
  distinct from quick-create's collision error. (The slug was
  collision-suffixed at the basics step, so a final-POST conflict is
  practically always a duplicate submit on this single-operator dashboard.)

**Final create** (`action="wizard_create"`): validates model against
`loadModelOptions` exactly like plain create; applies the template overlay onto
`defaultDefinition()`; **rejects** (does not clobber) an existing bot_id after
suffixing fails; inserts with `enabled=1`; redirects to
`?bot=<id>&tab=review&created=1` — landing on the readiness checklist (D4), not
the raw AI tab.

**Entry points:** (a) list page: the wizard becomes the primary CTA ("Create a
bot" button at the top of the bot list); the existing quick-create form moves
into a `<details>` "Quick create (advanced)" disclosure, unchanged inside (its
honesty tests keep passing). (b) `panels/onboarding.js` bot step deep-link
retargets to `/dashboard/bot-builder?new=1`. (c) empty bot list: "No bots yet"
empty state links straight into the wizard.

**UPSERT fix (applies to plain create too):** plain create's
`ON CONFLICT DO UPDATE` becomes reject-with-banner ("a bot with this id already
exists") — a plain INSERT with the conflict caught. Editing is what the editor
is for; silent full-definition replacement is data loss.

### D2 — Templates (data, not code)

New `panels/bot-builder/templates.js` exporting `BOT_TEMPLATES` — an array of
plain objects consumed by the wizard:

```js
{ id: "personal-assistant",          // i18n: botbuilder.tpl_<id>_title/_desc/_needs
  gwType: "crow-messages",           // channel step preselection ("none" allowed)
  tools:  { pi_builtin: [...], crow_mcp: [...] },  // overlay onto defaultDefinition
  skills: [...],                      // filtered against loadSkills() at apply time
  tracker: "kanban" | "none",
  system_prompt: "..." }              // EN, LLM-facing, user-editable afterward
```

Five templates:

| id | channel | tools beyond default | tracker | prompt theme |
|---|---|---|---|---|
| personal-assistant | crow-messages | + memory search/store | none | helpful generalist |
| email-responder | gmail | default (tasks) | none | polite email triage/drafting |
| discord-qa | discord | default | none | community Q&A |
| project-manager | none | default (tasks-heavy) | kanban | task tracking + status |
| blank | none | default | none | empty |

**Resilience rules:** per-bot MCP servers are minted from the canonical
`~/.pi/agent/mcp.json` (+ `mcp-addons.json`), so tool availability is
install-dependent — therefore template `tools.crow_mcp` entries are **filtered
at apply time against `probeAll()`** (the live probe the Tools tab already
uses), dropping missing servers/tools silently, exactly like `skills` presets
are filtered against `loadSkills()`. A template can never make creation fail.
Concrete names: personal-assistant adds `crow-memory/crow_search_memories`,
`crow-memory/crow_store_memory`, `crow-memory/crow_recall_by_context` on top of
the `crow-tasks/*` defaults.

**Probe semantics (round 1, m1):** filtering happens once, inside
`wizard_create` (not during step renders — template cards are static copy, so
no step blocks on the probe; the 5-min `probeAll()` cache absorbs the cost).
When the canonical `~/.pi/agent/mcp.json` is absent entirely (truly fresh
install), `probeAll()` returns `{_error}` — the filter then drops ALL template
`crow_mcp` additions and keeps only `defaultDefinition()`'s baked preset,
which is exactly what plain create produces today (parity, not a new failure
mode). Creation itself never fails or blocks on probe state. Permission policy is NOT overlaid: every template
inherits `defaultDefinition()`'s safe defaults (bash deny, external_send
draft_only, self-learning off). `system_prompt` stays EN with a wizard note
that it's editable (it's model-facing text, not UI copy).

### D3 — Shared gateway-fields renderer

Extract BOTH halves of the gmail/discord/telegram/slack/none gateway handling
into `panels/bot-builder/gateway-fields.js` (adversarial round 1, M2+M3 —
there is no existing normalization helper; it lives inline in the
`save_gateways` branch of `api-handlers.js:181-351`, so it must be pulled out,
not "reused"):

- `renderGatewayFields(gwType, gw, lang)` — the per-type credential/allowlist
  form fields, extracted from `editor.js`'s gateways tab.
- `normalizeGatewayFields(gwType, body)` — the form-body → gateway-record
  mapping, extracted from the `save_gateways` inline branch.

The Gateways tab and the wizard channel step / `wizard_create` both consume
both functions — one source of truth, no forked field lists or mappings. The
device-bound types (glasses, companion) and crow-messages' management UI
(share links, ACL, QR) are NOT extracted: in the wizard those types render as
type selection + an i18n'd "finish setup on the Gateways tab after creation"
note (device pairing and share links need an existing bot).

**Regression guard (round 1, M2):** the existing
`bot-builder-gateway-draft.test.js` exercises only the save handler and only
companion+glasses — it does NOT protect this refactor. PR1 adds a render- and
normalize-parity test covering gmail/discord/telegram/slack/none: fixture
gateway configs rendered through the extracted functions, asserting the field
names/values match the pre-extraction markup (captured as fixtures at
extraction time) and that save→re-render round-trips are lossless.

### D4 — Review tab → readiness checklist

The Review tab's default view becomes a checklist table, one row per readiness
item, each with a status icon, plain-language copy (i18n EN+ES), and a link to
the tab that fixes it:

**Honesty rule for the Model row (adversarial round 1, C1):** `resolveModel()`
NEVER reports failure — it fail-closes to the hardcoded `LOCAL_FALLBACK` key
with `source:"fallback"` and is documented never-throws. A ✓/✗ built on "does
it resolve" is therefore decorative: on a zero-provider fresh install it would
render a green checkmark carrying the exact hardcoded model string Item 4
removed. The row instead validates `def.models.default` against
`loadModelOptions(db)` — the same source of truth as every picker — and
renders the **configured** key, never the fallback key, in the not-ready
state. An executable test asserts a zero-provider definition renders
not-ready.

| row | source | states |
|---|---|---|
| Model | `def.models.default` ∈ `loadModelOptions(db)` keys | ✓ ready (`configured key`) / ✗ "the configured model isn't available on this instance — fix on AI tab" (shows the configured key or "none set"; never `LOCAL_FALLBACK`) |
| Channel | `def.gateways[0]` + per-type required fields | ✓ type + one-line detail / ⚠ incomplete — "this bot can't receive messages yet; finish setup on Gateways" / ⚠ none — "reachable only from Sessions; add one on Gateways" |
| Tools | selection counts | ✓ N tools (M servers) |
| Skills & prompt | `def.skills`, `def.system_prompt` | ✓ N skills, prompt set / ⚠ no prompt |
| Permissions | `def.permission_policy` | summary line: "bash: deny · external send: draft-only · self-learning: off" |
| Status | `bot.enabled` | ✓ enabled / ⚠ disabled — with the existing toggle button |

**Honesty rule for the Channel row (round 2, MAJOR-B — the C1 class,
generalized):** a *present* gateway is not a *working* gateway. The gmail
bridge polls only gateways with a non-empty `address` (`bridge_tick.mjs:85`)
and the sender wall fails **closed** (`bridge_tick.mjs:124`) — so the
email-responder template (the beachhead persona's likeliest pick) with a blank
address or empty allowlist is silently deaf. The Channel row is ✓ only when
the type's **required fields are non-empty**; the per-type required-field
lists live in `gateway-fields.js` (the same module that renders and
normalizes them — one source of truth): gmail requires `address` +
non-empty `allowlist`; discord/telegram require `token`; slack requires
`bot_token` + `app_token`; crow-messages and none have no requirements.
Anything missing ⇒ ⚠ with the specific gap named. The executable checklist
test covers gmail-empty-allowlist ⇒ not-ready alongside the zero-provider
model case.

Below the checklist, a `<details>` **"Advanced (raw definition)"** disclosure
holds everything the tab shows today: the effective-decision table, the JSON
`<pre>`, `serversForBot` line, and the Regenerate-.mcp.json button. Nothing is
removed; it's re-layered. `?created=1` adds a success callout ("Your bot is
ready — here's what it can do and what's left").

### D5 — Delete a bot (blast-radius confirm)

New actions in `api-handlers.js`, following the contacts-deletion pattern
(PR #155): `action="delete"` renders a confirmation page listing the blast
radius — N `bot_sessions` rows (deleted), gateway type (connection removed),
bound devices if any (unbound), crow-messages ACL/invite rows if any (deleted),
and a note that the workspace directory on disk is **kept**. `action=
"delete_confirm"` (CSRF + explicit hidden bot_id) then: deletes the
`pi_bot_defs` row and the bot's `bot_sessions`, `bot_message_seen` (dedup —
stale rows would make a *recreated* same-id bot silently ignore messages), and
`bot_skill_events` rows; removes the bot_id from the `remote_managed_bots`
settings JSON list; best-effort (try/catch per step, since these live in
optional bundles/features): removes the bot's `bot_message_acl` and
`bot_message_invites` rows, and unbinds any device whose `bound_bot_id`
matches — devices are a JSON blob in `dashboard_settings` key
`meta_glasses_devices`, so unbinding goes through the `device-store.js`
helpers, never raw SQL. Also deleted: the bot's `contacts` row
(`origin='local-bot'`) — via direct SQL, because the `contact-delete.js`
helper deliberately refuses local-bot rows ("recreated at boot"), which no
longer holds once the def is gone (round 2, MINOR-1). (**Cascade correction, PR #191 review M1** — this passage
previously claimed "no FK cascades exist anywhere here," which is false for
the contacts row: the bot_id-keyed tables have no cascades, but
`contacts(id)` has ON DELETE CASCADE children — `messages`, `shared_items`,
`message_retry_queue`, `contact_group_members` — so deleting the local-bot
contact also deletes the user's DM history with the bot and its group
memberships. Decision: the cascade proceeds, consistent with contact
deletion (PR #155), and the confirm page discloses the message +
group-membership counts in the blast radius. For the bot_id-keyed tables the
cleanup list above IS the integrity mechanism; executable tests assert
recreate-after-delete gets a clean slate AND the disclosed cascade. **Scope of that guarantee** (round
2, MINOR-2): the pi-bridge + messages + device surfaces listed here. The
dormant MPA-orchestrator tables (`bot_conversations`, `bot_registry`,
`bot_preferences`, `bot_runs`) are never populated for `pi_bot_defs` bots and
are out of scope; the test asserts against the in-scope tables only.) Entry points: a Delete button on the checklist tab
(Advanced section) and on the list page row. Live sessions: if any session is
`active`/`waiting-user`, the confirm page says the bridge will orphan them and
recommends stopping first (non-blocking — the reaper in `pi_lifecycle.mjs`
already handles orphans).

### D6 — De-jargon + i18n sweep

Rewrite the ~19 hardcoded English hint paragraphs in plain language, keyed
EN+ES. Rules:

- Internal plan references (Slice B, S4, F4a, R13, Phase 3.1, "plan §2") move
  to code comments; user copy explains the *behavior*, not the provenance.
- Raw table/file names leave user copy: "Bots (pi_bot_defs)" → "Your bots";
  "Run monitor (bot_sessions — live, 5s)" → "Recent activity (live)";
  "Send via bridge --inject" → "Send to bot". Technical identifiers stay only
  inside the Advanced disclosure (D4) and `<code>` spans where they name a
  thing the user actually types.
- Consistent noun: **bot** everywhere ("Create an agent" → "Create a bot").
- The frozen-EN inline-`<script>` policy is retained; user-visible strings
  emitted *by* scripts keep using the existing `tJs()` escape hatch where
  already wired, and no new inline-script strings are introduced (the wizard
  needs no client JS).
- All new wizard/template/checklist/delete strings ship EN+ES from day one.
  Expected key growth: ~128 → ~210 `botbuilder.*` keys.
- **Parity guard (round 1, M5):** no botbuilder-wide i18n parity test exists
  today, and `t()` falls back `entry[lang] || entry.en || key` — so an
  en-present/es-missing key renders *English* in Spanish mode, invisible to
  any "no bare key leakage" CDP check. PR3 adds
  `tests/bot-builder-i18n-parity.test.js`: for every `botbuilder.*` key, `es`
  is present AND `es !== en`, with an explicit named-exceptions list for
  intentionally identical strings (e.g. "Gmail"). The CDP ES pass remains as a
  rendering smoke check, not the parity guard.

### D7 — Non-technical tutorial (EN+ES)

`docs/guide/bot-builder-tutorial.md` + `docs/es/guide/bot-builder-tutorial.md`:
"Your first bot" — a walkthrough of the guided flow in second person, written
for someone who has never heard "MCP" or "gateway": pick a template → name it →
pick a model (with a short "no models yet?" detour to providers) → connect a
channel → understand the checklist → talk to your bot → clean up (delete).
Appendices per channel with exact click-paths for getting credentials (Discord
bot token, Telegram BotFather, Slack app tokens, Gmail alias+allowlist) and a
"which channel should I pick?" table (crow-messages = no credentials, works
immediately). VitePress sidebar entries in both locales. The dashboard links to
it from the wizard's template step and the list page ("New to bots? Read the
tutorial") via a `docsUrl(path)` helper added to `shared/components.js` that
joins the public docs base with a path — no scattered absolute URLs. The base
constant is `https://maestro.press/software/crow/` (round 2, MINOR-3: that is
the canonical public docs host per README and the VitePress og:image;
`base: '/software/crow/'` in the VitePress config is only the path prefix — a
github.io URL would be a dead link). The existing `docs/guide/bot-builder.md` stays as the reference
manual; the tutorial cross-links it.

---

## 3. PR seams

Four PRs, each independently shippable, suite-green, and deployable:

- **PR1 — wizard + templates + shared gateway fields.** `wizard.js` (STEP_KEYS,
  step renderers, wizard_create), `templates.js`, `gateway-fields.js`
  extraction (render + normalize per §D3 — the existing
  `bot-builder-gateway-draft.test.js` does NOT cover this; the new parity
  tests are part of this PR), UPSERT→reject fix on plain create, list-page
  CTA + quick-create-into-details, onboarding bot-step retarget, i18n EN+ES.
  Tests: wizard step rendering (derived from STEP_KEYS), slug collision,
  model-empty honesty at step 2, template overlay correctness (tools/skills
  filtering incl. the `{_error}` drop-all case), wizard_create validation +
  no-clobber + conflict-redirect, gateway render/normalize parity
  (gmail/discord/telegram/slack/none).
- **PR2 — readiness checklist + delete.** Review-tab re-layering (checklist +
  Advanced disclosure), `created=1` callout, post-create redirect (wizard
  already targets it; plain create redirect also moves to `tab=review`),
  delete + delete_confirm with blast radius. Tests: checklist states (model
  unresolvable, no gateway, disabled bot), advanced content preserved, delete
  removes rows + best-effort cleanups are try/catch-guarded, CSRF on both
  delete actions.
- **PR3 — de-jargon + i18n sweep.** The ~19 hint rewrites + section titles +
  monitor/session copy, EN+ES keys, internal-ref scrub. Tests: extend the
  existing i18n parity checks; assert no `pi_bot_defs`/plan-ref strings render
  on the list page and editor tabs outside Advanced/`<code>`.
- **PR4 — tutorial.** Both locale docs, sidebar entries, `docsUrl()` helper +
  dashboard links. deploy-docs must go green on the docs push (poll full sha).

Order: PR1 → PR2 → PR3 → PR4. Each PR: adversarial code review (arc rigor
pipeline), scratch-env suite vs baseline 1866/3/0, fleet deploy + soak per the
runbook, then the next.

## 4. Verification

- **Suite** on scratch env only (`CROW_HOME=$T CROW_DATA_DIR=$T/data
  CROW_DISABLE_NOSTR=1 CROW_DISABLE_INSTANCE_SYNC=1`); baseline 1866 pass /
  3 known fails / 0 skips — any 4th failure is ours.
- **CDP acceptance gate (after PR2 deploys):** on prod crow, drive the FULL
  guided flow as a user **with Turbo ON (prod default)**: wizard entry →
  template=personal-assistant → name "CDP Test Bot" → model (first offered) →
  **exercise Back at least once mid-flow and confirm entered values survive**
  → channel crow-messages → create → land on checklist with `created=1` →
  verify checklist rows (incl. labelled radio cards / stepper `aria-current`
  for the a11y spot-check, round 2 MINOR-5) → delete the bot through the new
  confirm flow → verify gone from list. Then an ES pass:
  `crow_lang=es`, render all 5 wizard steps + checklist, assert no bare EN key
  leakage (reuse `checks.mjs`). Evidence `~/.crow/p4/item5-cdp/`; session
  minted per recipe and revoked after. CDP rules apply (LAN IP, delete cookies
  first, vary query params vs Turbo no-ops).
- **Post-item bug-hunt round** (standing directive): full 15-page round + the
  5 wizard steps, after the theme ships.

## 5. Invariants & standing rules

- No hardcoded model/provider anywhere new — everything model-shaped derives
  from `loadModelOptions(db)` / `resolveModel`. `CROW_MODELS_JSON=""` scratch
  gateways must render the wizard's empty states, not crash.
- Templates must work on a fresh install with zero extensions (core tools
  only; skills filtered at apply).
- No schema changes anywhere in this theme (all state fits existing tables).
  If that ever changes: the schema-bump rail gate is mandatory.
- Frozen-EN inline scripts; wizard introduces no inline JS **and its step
  forms opt out of Turbo Drive (`data-turbo="false"`)** — render-on-POST is
  incompatible with Turbo's must-redirect rule for top-level form
  submissions.
- Positional-path commits; mutation-check guards; no Claude attribution; all
  arc §3 rules.

## 6. Out of scope (recorded, not built)

- Gateway credential *acquisition* flows (OAuth dances, token validation
  pings) — the tutorial documents manual acquisition; validation is a future
  Fix-it-card candidate.
- Editing wizard (re-running the wizard on an existing bot).
- Voice-channel (glasses/companion) full setup inside the wizard — deferred to
  the Gateways tab by design (needs device pairing).
- Live "test your bot" chat embedded in the checklist — candidate follow-up;
  crow-messages bots are testable from the Messages page today.
- Follow-up pool items from the handoff (bridge NODE nvm-pin etc.) stay
  unqueued.

---

## 7. Review record

**Round 1 (2026-07-14, fresh Opus subagent, adversarial):** verdict REVISE.
Findings, all verified against code and folded in above:
- **C1 (critical):** D4 Model row was built on `resolveModel()`, which
  fail-closes to the hardcoded `LOCAL_FALLBACK` and never reports failure — the
  row would have shown a false green with the exact hardcoded model string
  Item 4 removed, on the exact beachhead persona (zero-provider fresh
  install). Fixed: validate against `loadModelOptions(db)`; never render the
  fallback key; executable zero-provider test required. (§D4)
- **M1:** the POST-carry wizard state machine was mis-sold as "proven by
  onboarding" (onboarding nav is stateless GET). Fixed: explicit state machine
  — Back/Next as submit buttons in one form, no GET deep-links, refresh
  semantics, conflict-tolerant PRG final create. (§D1)
- **M2/M3:** the named regression guard (`bot-builder-gateway-draft.test.js`)
  doesn't cover the extraction, and the "same normalization helper" didn't
  exist. Fixed: extraction now covers render + normalize; parity tests added
  to PR1 scope. (§D3)
- **M4:** delete missed `bot_message_seen` (recreate-same-id bots would
  silently ignore messages), `bot_skill_events`, `remote_managed_bots`.
  Fixed. (§D5)
- **M5:** ES parity had no real guard (`t()` en-fallback defeats bare-key
  checks). Fixed: dedicated parity test in PR3. (§D6)
- **m1:** probe latency/absent-canonical semantics pinned. (§D2)
- Verified sound by the reviewer: UPSERT→reject (no caller depends on
  create-as-upsert), delete is bridge-safe (tick loop re-queries
  `WHERE enabled=1`; run monitor doesn't join `pi_bot_defs`), components
  reuse, checklist won't crash on fresh installs.

**Round 2 (2026-07-14, fresh Opus subagent, adversarial):** verified all five
round-1 fixes hold against the code (C1 replacement `loadModelOptions` is
DB-only, never throws, `{error, opts:[]}` on empty; M3 extraction signature
confirmed pure `(gwType, body)` for the scoped types; M4 tables confirmed on
main crow.db; M5 premise confirmed at `i18n.js:1529`). Verdict REVISE on two
new findings, both verified and folded in:
- **CRITICAL-A:** Turbo Drive (default-on) rejects non-redirect top-level form
  responses, so `wizard_step`'s render-on-POST would silently not advance on
  prod default config — invisible to the browser-less suite. Fixed:
  `data-turbo="false"` on wizard step forms (§D1, §5); CDP gate must exercise
  Back/Next with Turbo ON (§4).
- **MAJOR-B:** the Channel row's presence-only ✓ recreated the C1 false-green
  class for the beachhead persona's likeliest template: a gmail gateway with
  empty address/allowlist is silently deaf (fail-closed wall,
  `bridge_tick.mjs:85,124`). Fixed: per-type required-field readiness sourced
  from `gateway-fields.js` (§D4) + executable test.
- Minors folded: delete also removes the bot's `origin='local-bot'` contacts
  row via direct SQL (the contact-delete helper refuses local-bot rows);
  clean-slate guarantee explicitly scoped vs dormant MPA-orchestrator tables;
  `docsUrl` base pinned to `https://maestro.press/software/crow/`;
  `wizard_step` rendering routed in `bot-builder.js` (POST handler only gets
  `{db}`); a11y spot-check added to the CDP gate.
- Non-issues confirmed: `buildBotMcp` warns (never fails) on absent servers;
  csrf/honesty tests unaffected by the `<details>` wrapper; no key-count test
  breaks on i18n growth.

**Round 3 (2026-07-14, fresh Opus subagent, closure check):** **APPROVE.**
Verified against code: `data-turbo="false"` genuinely bypasses Turbo's form
interception (`submissionIsNavigatable` → `elementIsNavigatable` walk in the
vendored turbo-8.0.5), with existing form-level precedent
(`contacts/html.js:119`, `peer-invite-ui.js`); the per-type required-field
lists exactly match the adapters' gates — gmail's allowlist is fail-CLOSED
(`gmailSenderAllowed`) while discord/telegram/slack's `passesAllowlist` is
fail-OPEN on empty, so requiring allowlist only for gmail produces neither
false-greens nor false-reds; `contacts` has no FTS shadow or delete triggers,
so §D5's direct SQL is safe; docsUrl base confirmed against README. No
contradictions introduced by any fix. Citation polish applied (§D1).
