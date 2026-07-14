# Bot Builder UX overhaul + non-technical tutorial — design spec

**Date:** 2026-07-14 · **Arc item:** 5 (THEME, master plan
`docs/superpowers/plans/2026-07-11-opus-autonomous-arc.md` §4) · **Status:** draft
pending adversarial review

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

**State carry:** each Next is a POST; prior answers re-emit as hidden inputs.
No draft rows, no server-side wizard session. Secrets (gateway tokens) travel
only in POST bodies, never query strings (same exposure class as the Gateways
tab, which re-emits saved tokens into password inputs). Every step form carries
`csrfInput(req)`.

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
the `crow-tasks/*` defaults. Permission policy is NOT overlaid: every template
inherits `defaultDefinition()`'s safe defaults (bash deny, external_send
draft_only, self-learning off). `system_prompt` stays EN with a wizard note
that it's editable (it's model-facing text, not UI copy).

### D3 — Shared gateway-fields renderer

Extract the per-type field rendering from `editor.js`'s gateways tab
(`gwFields`/`gwHint` for gmail/discord/telegram/slack/none — the credential/
allowlist forms) into `panels/bot-builder/gateway-fields.js`, parameterized by
`(gwType, gw, lang)`. The Gateways tab and the wizard channel step both call it
— one source of truth, no forked field lists. The device-bound types (glasses,
companion) and crow-messages' management UI (share links, ACL, QR) are NOT
extracted: in the wizard those types render as type selection + an i18n'd
"finish setup on the Gateways tab after creation" note (device pairing and
share links need an existing bot). Save handling stays where it is
(`save_gateways` for the tab; `wizard_create` maps the same field names through
the same normalization helper).

### D4 — Review tab → readiness checklist

The Review tab's default view becomes a checklist table, one row per readiness
item, each with a status icon, plain-language copy (i18n EN+ES), and a link to
the tab that fixes it:

| row | source | states |
|---|---|---|
| Model | `resolveModel(def)` (already computed here) | ✓ resolves (`key`) / ✗ can't run — fix on AI tab |
| Channel | `def.gateways[0]` | ✓ type + one-line detail (address / N allowlisted / device) / ⚠ none — "reachable only from Sessions; add one on Gateways" |
| Tools | selection counts | ✓ N tools (M servers) |
| Skills & prompt | `def.skills`, `def.system_prompt` | ✓ N skills, prompt set / ⚠ no prompt |
| Permissions | `def.permission_policy` | summary line: "bash: deny · external send: draft-only · self-learning: off" |
| Status | `bot.enabled` | ✓ enabled / ⚠ disabled — with the existing toggle button |

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
`pi_bot_defs` row and the bot's `bot_sessions` rows; best-effort (try/catch
per step, since these live in optional bundles/features): removes the bot's
`bot_message_acl` and `bot_message_invites` rows, and unbinds any device whose
`bound_bot_id` matches — devices are a JSON blob in `dashboard_settings` key
`meta_glasses_devices`, so unbinding goes through the `device-store.js`
helpers, never raw SQL. Entry points: a Delete button on the checklist tab
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
joins the public docs base (one exported constant) with a path — no scattered
absolute URLs. The existing `docs/guide/bot-builder.md` stays as the reference
manual; the tutorial cross-links it.

---

## 3. PR seams

Four PRs, each independently shippable, suite-green, and deployable:

- **PR1 — wizard + templates + shared gateway fields.** `wizard.js` (STEP_KEYS,
  step renderers, wizard_create), `templates.js`, `gateway-fields.js`
  extraction (Gateways tab consumes it — behavior-identical, covered by
  `bot-builder-gateway-draft.test.js`), UPSERT→reject fix on plain create,
  list-page CTA + quick-create-into-details, onboarding bot-step retarget,
  i18n EN+ES. Tests: wizard step rendering (derived from STEP_KEYS), slug
  collision, model-empty honesty at step 2, template overlay correctness
  (tools/skills filtering), wizard_create validation + no-clobber, gateway-tab
  parity after extraction.
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
  guided flow as a user: wizard entry → template=personal-assistant → name
  "CDP Test Bot" → model (first offered) → channel crow-messages → create →
  land on checklist with `created=1` → verify checklist rows → delete the bot
  through the new confirm flow → verify gone from list. Then an ES pass:
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
- Frozen-EN inline scripts; wizard introduces no inline JS.
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
