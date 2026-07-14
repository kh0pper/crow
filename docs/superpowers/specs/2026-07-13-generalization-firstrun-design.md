# Item 4 — Generalization + first-run experience (design)

**Date:** 2026-07-13 · **Status:** APPROVED FOR BUILD — 3 review rounds complete
(R1 REVISE ×5 MAJOR folded · R2 REVISE ×3 MAJOR folded · R3 closure: 2 localized
edits applied, all folds verified)
**Authorization:** Kevin's standing blanket grant (2026-07-11); planning-session-first
per the master plan (`docs/superpowers/plans/2026-07-11-opus-autonomous-arc.md` §4 Item 4).
**Schema impact: NONE.** No table changes anywhere in this theme — the §3 migration
rail is not triggered. (Re-check per PR; any PR that grows a schema change must run
`scripts/schema-migration-dryrun.sh` first.)

---

## 0. Why (Kevin, verbatim)

> "his own personal preferences hardcoded into what is meant to be a generalized,
> user-customizable app" · install "isn't actually easy for non-technical users."

Beachhead user: a non-technical public-education admin. Standing directive:
`fix-the-product-not-the-instance` — every fix must work for a fresh single-click
install. Confirmed live (S3 walkthrough 2026-07-10): the wizard walks a new user into
creating an agent with zero *working* providers while the model dropdown lists the
maintainer's lab models.

## 1. Preflight rot report (verified against main `acca7f29`, 2026-07-13)

The plan's Item 4 text is from 2026-07-11. Re-verification results:

**Still true:**
- Bot-builder hardcodes all present (paths are under `servers/gateway/dashboard/`):
  `panels/bot-builder/data-queries.js:193` (`defaultDefinition` model fallback),
  `api-handlers.js:35` (create-action model fallback), `html.js:55` (dropdown
  `selected` pin) — all `crow-local/qwen3.6-35b-a3b`.
- `scripts/pi-bots/model_resolver.mjs:39` `LOCAL_FALLBACK = "crow-local/qwen3.6-35b-a3b"`.
- Companion routing defaults (`servers/gateway/routes/llm-router.js:41-42`):
  `crow-voice/qwen3.5-4b` / `crow-chat/qwen3.6-35b-a3b`, env-overridable.
- Onboarding wizard (`panels/onboarding.js`): 5 static steps (welcome → integrations
  → bot → connect → done), orient-and-route, no client JS. No AI-provider step, no
  identity-backup step.
- Identity seed plaintext at `<dataDir>/identity.json`; no product backup surface.

**Rotted / narrower than planned:**
- **4c largely shipped already.** `scripts/crow-install.sh` installs Docker
  unconditionally (step 3, `get.docker.com`), and step 9 handles Tailscale
  extensively (hostname consent, Serve wiring + `CROW_GATEWAY_URL`, cloud-host
  detection for the 443 prompt). Remaining honest gaps: Tailscale itself is never
  *offered* for install (only a docs tip at `:431`); the script is Debian/Ubuntu-only
  with no statement of that; the non-installer path (git clone) and the dashboard
  never surface a missing Docker at the point of use (`routes/bundles.js` has no
  docker-availability check — a `deploys` install just fails raw).
- **F-ONBOARD-4 partially shipped.** `/setup` already has confirm-password with
  server-side match check (`dashboard/index.js:147`) and `minlength="12"`
  (`shared/layout.js:615-616`). Remaining: show-password toggle; no paste-blocking
  exists (good — keep it that way and assert it).
- **4d partially shipped.** The done-step already carries a "try collections" action
  card → `/dashboard/extensions#collections` (Item 1b, PR #174). The remaining ask is
  a real mid-tour starter-kit step, not the card.

**New findings this preflight (not in the plan):**
- **F4-SEED [the root cause]:** the repo ships a **tracked `models.json`** at the
  root containing Kevin's lab topology — 9 providers pointing at his tailnet IPs
  (`100.118.41.122`, `100.121.254.89`). `seedProvidersFromModelsJson`
  (`servers/shared/providers-db.js:84`) seeds every fresh install's `providers` table
  from it (search paths `providers-db.js:36-40` and `servers/shared/providers.js:21-23`:
  repo `models.json` → repo `config/models.json` → `~/.pi/agent/models.json`, merged).
  A fresh install therefore gets phantom providers and the bot-builder dropdown lists
  them "honestly" from the DB. Fixing the three dropdown hardcodes without fixing the
  seed fixes nothing.
- **F4-EMAIL:** `defaultDefinition` (`data-queries.js:209-210`) bakes Kevin's personal
  email into every new bot: gateway `kevin.hopper+<botId>@maestro.press`, allowlist
  `["kevin.hopper1@gmail.com", "kevin.hopper@maestro.press"]`, with
  `triggers.gateway: true` — new bots on any install are born polling for mail routed
  through Kevin's domain.
- **F4-EXPORT-HONESTY:** `exportIdentity` (`servers/sharing/identity.js:438`) prints
  "Encrypted Identity Export" but emits **base64 of the plaintext file**. With the
  default empty passphrase (`loadOrCreateIdentity(passphrase = "")` — the only way
  anything calls it today), the seed is plaintext inside that "encrypted" blob.
  `encryptSeed`/`decryptSeed` primitives exist (`identity.js:56,74`) but nothing
  product-facing uses them.
- **F4-PATHS:** absolute `/home/kh0pp` fallbacks in product code:
  `servers/gateway/routes/streams.js:315` (`CROW_TASKS_DB_PATH ||
  "/home/kh0pp/.crow-mpa/data/tasks.db"`), `servers/gateway/routes/fileview.js:13`
  (allowlist root default `/home/kh0pp`), `scripts/pi-bots/skill_provenance.mjs:20`
  (`const HOME = "/home/kh0pp"`). Plus cosmetic lab leaks: grackle's IP as a
  placeholder (`settings/sections/llm/vision-profiles.js:157`) and a maestro.press
  Gmail-alias hint presented as universal (`shared/i18n.js:783`,
  `botbuilder.gwHintGmail`).
- **Product-level `maestro.press` strings are IN scope to keep:** integration
  `docsUrl`s, `support@maestro.press`, `DEFAULT_INVITE_PAGE_URL` — these are the
  product's real public site/support surfaces, not personal preferences. The
  fresh-install audit needs an explicit allowlist distinguishing the two classes.

## 2. Design

### 2.1 Sub-scope 4a — per-install model/provider discovery

**Decision: kill the shipped lab seed; make every model surface derive from the
`providers` table with honest empty/invalid states.**

Alternatives considered:
- *(rejected)* Keep `models.json` but filter the seed to reachable providers —
  boot-time probing, slow, and still ships Kevin's topology in a public repo.
- *(rejected)* Replace contents with "portable" entries (e.g. `crow-llm →
  localhost:3001/llm/v1`) — circular (the gateway router itself resolves via
  providers) and still a phantom on installs with no local models.
- **(chosen)** Remove the tracked file; per-instance config lives in the already
  supported untracked locations.

Changes:
1. `git rm models.json`; add `/models.json` and `/config/models.json` to
   `.gitignore` (root-anchored — a bare `models.json` pattern would silently
   ignore any future `bundles/*/models.json`);
   ship `models.example.json` (same shape, placeholder host + a `_readme` top-level
   key since JSON has no comments — it also serves as the disaster-recovery template
   that the deleted tracked file used to be). Search paths in `providers-db.js` /
   `providers.js` stay unchanged, so an operator-created repo-root `models.json`
   still works — it just is not shipped or committable. Update the
   `gpu-orchestrator.js:574-581` comment that calls the git-tracked file its
   disaster-recovery fallback (that statement becomes false). Note: the providers-tab
   "Sync bundle providers" button becomes a graceful no-op ("0 synced") on installs
   with no models.json anywhere (`readModelsJson` → empty providers → early return;
   verified) — expected, not a regression.
   **Test consequence (round-2 F-N1, mechanism pinned by round-3):**
   `tests/providers-reconcile-gate.test.js:213,221` hard-asserts a non-empty merged
   models.json with tailnet entries — after the `git rm` this fails on any host
   with no untracked copy, including the §3.1 scratch acceptance env and
   black-swan. There is NO per-test-redirectable search path today:
   `MODELS_JSON_SEARCH_PATHS` (`providers-db.js:36-40`) is a module-level const
   with `HOME` captured at import, and `readModelsJson` /
   `syncProvidersFromModelsJson` expose no injection seam (the test's own header
   says so). PR1 must add a small injectable search-path/entries seam to
   `providers-db.js` (in PR1's blast radius anyway) and point the test at a
   mkdtemp fixture through it, reworking the test's expectation replica
   `mergedModelsJsonEntries()` (`:76-89`, reads the same fixed paths) in lockstep.
   The test MUST NOT write fixtures into the real `config/models.json` or
   `$HOME/.pi/agent/models.json` — both are live operator files on crow/grackle
   (the migration gate below CREATES the former). Suite must be green with and
   without a host models.json.
2. Docs: `docs/` page describing how models/providers get configured (bundle install
   auto-registers; cloud providers via Settings → AI Models → Providers; advanced:
   models.json locations).
3. Bot-builder honesty (create form, `html.js`): no hardcoded `selected`; first
   option selected by default; when `loadModelOptions` returns the empty/error state,
   render the existing warning plus a **disabled** submit and a link to
   `?section=llm&tab=providers` — never a submittable empty dropdown.
4. Create-action guard (`api-handlers.js:35`): reject a create whose `model` is
   empty or not present in `loadModelOptions(db)` with an honest error banner
   (re-render form, message keyed via i18n). No silent fallback.
   The **editor** AI-tab save path (`api-handlers.js:131-140`) deliberately keeps
   warn-but-save (an operator may save a model whose bundle is temporarily disabled;
   blocking would strand editing) — but its warning text lies ("runtime fails closed
   to crow-local"): rewrite it to what actually happens ("saved — runs will fail
   until this model is available on this instance").
5. `defaultDefinition(botId, projectId, model)`: `model` becomes required (caller
   passes the validated key); **`gateways: []`** (F4-EMAIL — no email gateway by
   default; `bridge_tick.mjs:81` and `discord_gateway.mjs:67` both no-op on empty
   gateways, and `triggers.gateway: true` with no gateways is inert; verified).
   ALSO in this function: **drop `spawn_env.PI_PROVIDER` entirely**
   (`data-queries.js:224`). Round-2 traced the consumer: `bridge.mjs:147-152`
   builds the child env with `def.spawn_env` LAST, so a baked `PI_PROVIDER`
   *overrides* the per-turn `PI_PROVIDER: resolved.provider` the resolver just
   computed — today's `"crow-local"` silently shadows it, and baking the creation-
   time provider would go stale on model edits and mismatch escalation turns. The
   bridge already supplies the correct value per turn; the def must not.
   Existing bot defs in DBs are untouched (data, not code).
6. `i18n.js` `botbuilder.gwHintGmail` (EN+ES): rewrite generically ("Gmail polls the
   address you configure on the Gateways tab…") — no maestro.press alias example.
7. Companion `FAST_KEY`/`ESC_KEY` defaults **stay** (`crow-voice`/`crow-chat` are
   real installable Crow model bundles, env-overridable). `model_resolver.mjs`
   `LOCAL_FALLBACK = "crow-local/..."` also stays as the terminal fallback, but be
   honest about what it is: **`crow-local` is pi-coding-agent's provider id** (lives
   in `~/.pi/agent/models.json`, which fresh Crow installs do not have) — no Crow
   bundle registers it. On a fresh install the fallback WILL be hit and WILL be
   unavailable, so the in-scope check is mandatory, not optional: exercise the
   `unavailable` path end-to-end (bot turn against a fresh-style env) and make the
   bridge surface it as a clear user-visible error, not a hang or a cryptic trace.

**Fleet migration (no schema, but working-tree choreography — a HARD pre-merge
gate the executor performs itself, not an operator note):**

Facts this rests on (verified 2026-07-13, round-1 review corrected the first
draft's wrong fallback claim):
- The runtime loader `servers/shared/providers.js:20-23` searches ONLY repo
  `models.json` → repo `config/models.json`, **first file wins, no merge, and it
  does NOT read `~/.pi/agent/models.json`**. It feeds `resolve-profile`'s DB-miss
  fallback, `gpu-orchestrator.js` (`alwaysResident`), and the embeddings loader.
  (`providers-db.js:36-40`, which DOES merge in the pi file, is only the
  seed/sync path.) So `config/models.json` must carry the **FULL** provider set —
  the repo file and the pi file are disjoint sets (repo: `crow-voice/crow-chat/
  crow-dispatch/crow-llm/crow-swap-*/grackle-*`; pi: `crow-local*`, `zai-coding`).
- `scripts/crow-update.sh:33-38` swallows `git pull --ff-only` failures and keeps
  running the old version — a box whose `models.json` is locally MODIFIED (not
  merely present) would silently stop receiving ALL future updates once the
  deleting commit lands.

Pre-merge gate, in order:
1. On crow and grackle (the boxes with local-model dependence):
   `cp ~/crow/models.json ~/crow/config/models.json` (full copy — NOT a delta
   merge). crow's single tree serves both the primary and MPA gateways, so one
   copy covers both instances.
2. On all FOUR boxes: `git status --porcelain models.json` must be EMPTY (an
   unmodified tracked file ff-pulls into deletion cleanly; a modified one wedges
   auto-update per above). Any dirt → resolve before merging.
3. black-swan gets no config copy (no local models; its providers rows are in the
   DB, and with no models.json anywhere the loader/seed/sync paths all no-op
   gracefully — verified). Accepting the loss of its file-level disaster-recovery
   fallback is deliberate; `models.example.json` is the recovery template.

Post-deploy soak adds: `node scripts/smoke/providers-resolve.js` on crow must still
resolve; embeddings, rerank, and gpu-orchestrator journal lines clean on crow +
grackle; auto-update's next tick reports "Up to date" (not a pull failure) on all
four boxes.

### 2.2 Sub-scope 4a-sweep — personal-path/lab-value sweep (F4-PATHS)

Path fallbacks (env still wins everywhere it exists today):
- `streams.js:315`: derive the tasks-DB default from the instance data dir
  (resolveDataDir pattern from PR #180) instead of `/home/kh0pp/.crow-mpa/...`.
- `routes/bot-board-api.js:62,64`: bare `CROW_USER_SKILLS = "/home/kh0pp/.crow/skills"`
  and `HOME = "/home/kh0pp"` → homedir()/env-derived.
- `fileview.js:13`: default allowlist root → `homedir()`.
- Runtime pi-bots bare `/home/kh0pp` constants (same class, round-1 sweep):
  `skill_provenance.mjs:20`, `bridge.mjs:45`, `bridge_tick.mjs:24`,
  `discord_gateway.mjs:37`, `model_resolver.mjs:37`, `tracker.mjs:18`,
  `mcp_writer.mjs:37`, `s0_mcp_probe.mjs:23` → `process.env.HOME || homedir()`.
  ALSO `servers/shared/providers-db.js:35` itself (`process.env.HOME ||
  "/home/kh0pp"` — env wins but the fallback is still Kevin's path; round 2
  caught the first draft citing it as the exemplar). Test scaffolds (`*_e2e.mjs`,
  s2/s4/slicec harnesses) are excluded.
- `scripts/pi-bots/gmail_io.mjs:8,21,24-30` (round-2): a RUNTIME Gmail bridge
  carrying Kevin's personal Google-creds paths (`/home/kh0pp/spring-2026/…`,
  `…/.config/google-workspace-mcp-mpa/…`) and a personal-email allowlist →
  env/config-derived with honest failure when unconfigured.
- `bundles/browser/server/server.js:127` fallback
  `composeFile = "/home/kh0pp/crow/bundles/browser/docker-compose.yml"` and
  `bundles/browser/docker-compose.yml:14` host mount
  `/home/kh0pp/.crow/browser-downloads` → derive from the bundle dir / CROW_HOME
  (the bundle is broken on any non-`/home/kh0pp` install today).

Lab-value leaks:
- `panels/bot-board/client.js:174`: dead "View note" link hardcodes
  `http://10.0.0.39:8080/notes/…` (a lab host) → derive from a setting or drop the
  link when no notes base URL is configured (honest absence over dead link).
- `vision-profiles.js:157` and `settings/sections/shared-storage.js:109`
  placeholders (grackle IP, crow MinIO IP) → neutral `localhost` examples.
- `routes/admin-backup.js:31`: `getInstanceLabel()` regex `/^kevin-(.+)$/` on
  NTFY_TOPIC → generalize (strip a configurable prefix or use the topic verbatim).
- `i18n.js:783` gwHintGmail (already in §2.1 item 6).
- Fix ALL `kh0pp/crow` → `kh0pper/crow` org typos — three sites (verified):
  `bundles/media/server/feed-fetcher.js:9` (user-agent) and the public
  "Powered by" footer links `bundles/knowledge-base/routes/kb-public.js:387`,
  `bundles/media/panel/routes.js:794`. (`content-extractor.js:12` already reads
  `kh0pper/crow` — allowlisted under the org rule, no change.)

Closing sweep: `grep -rniE "kevin|kh0pp|100\.118\.41|100\.121\.254|10\.0\.0\.|dachshund"`
over `servers/ scripts/pi-bots/ registry/ bundles/` (excluding tests, bench, Kevin's
untracked WIP) must return only the documented allowlist (§3.1 step 4 — the SAME
pattern and allowlist; the two checks are one check run twice) or test fixtures.

### 2.3 Sub-scope 4b — onboarding hardening + identity backup

Wizard stays server-rendered orient-and-route (?step=N, no client JS) — the pattern
is load-bearing (refresh/back-safe, i18n'd) and cheap to extend.

**New STEP_KEYS order:** `welcome → ai → integrations → bot → starter → connect →
done` (7 steps; "ai" and "starter" new — starter is §2.4). Panel mechanics are
index-safe (completion keys on `stem === "done"`, clamp derives from
`STEP_KEYS.length`; verified), but **three tests hardcode the 5-step layout by
position** and must be reworked in the same PR: `tests/onboarding.test.js:57,70,132`
(`step < 5` loop, `step:"4"` = done, positional deepLink/callout maps),
`tests/onboarding-links.test.js:58-64,83` (positional mid-tour list),
`tests/onboarding-cards.test.js:28` (`step:"4"` = done). Rework them to derive
positions from the exported STEP_KEYS (export it) rather than re-pinning new
indices.

- **"ai" step (F-ONBOARD-2):** explains that agents need a model provider; states
  honestly that nothing is configured yet when `providers` is empty (server-side
  count → conditional copy); deep-links (existing `deepLink`, target=_blank
  mid-tour semantics preserved) to `?section=llm&tab=providers`. Sits BEFORE "bot".
- **Identity backup (F-ONBOARD-1):** lives on the **done** step (after the tour's
  action verbs, before the action cards) rather than its own step — backup is a
  safety net, not a setup task, and the done step is the one users re-visit.
  Content: the instance crowId, one paragraph on what the identity is and what
  losing it costs, and a **backup form**: passphrase field (required, **minlength
  12** — it protects the master seed offline, so no weaker than the dashboard
  password; `encryptSeed` is scrypt N=16384,r=8,p=1) + confirm → POST
  `/dashboard/onboarding/identity-backup` → responds
  `Content-Disposition: attachment; crow-identity-backup.json` containing the
  `encryptSeed`-encrypted payload (never the plaintext seed; pubkeys/crowId stay
  clear for identification). Implementation note (round-2): panels expose GET
  handlers only — this POST is a separately hand-registered CSRF-protected route
  in `dashboard/index.js` (precedent: login/2fa/fix-it action POSTs at
  `:379-463,629-639`), not part of the panel dispatch. Also linked from Settings →
  Help & Setup so it is reachable post-onboarding.
  `encryptSeed`/`decryptSeed` are currently **module-private** (`identity.js:56,74`)
  — export them (the endpoint, the CLI, and the acceptance round-trip all need
  them).
  - **Restore path — the file encryption protects the DOWNLOAD, not the disk:**
    the gateway host boots only from a **plaintext-seed** `identity.json`
    (`loadInstanceSeed`, `identity.js:230`, throws on `stored.encrypted`), so any
    restore MUST decrypt the backup and write a plaintext-seed identity.json —
    never the encrypted blob as-is. Document `npm run identity:import` in the docs
    page + the backup file carries a `_restore` field naming the command. A
    dashboard restore flow is OUT of scope (re-keying a booted instance has
    sync/pairing implications — sync-layer design work per the 2a lesson;
    follow-up pool).
  - **CLI honesty fix:** `exportIdentity` gains a required `--passphrase` (or
    interactive prompt); output is `encryptSeed`-encrypted and only then labeled
    "Encrypted". `importIdentity` accepts both the legacy plaintext-base64 blob and
    the new encrypted format (sniff by JSON keys), prompts for the passphrase for
    the latter, and in BOTH cases writes a plaintext-seed identity.json (per the
    restore rule above). New format shares the wizard endpoint's payload shape.
- **F-ONBOARD-3:** the "connect" step's copy: replace the dead-end cloud-web callout
  with per-client instructions link (`/dashboard/connect` already renders these —
  the step just needs honest copy; verify the current `onboarding.connectNote`
  text against what /dashboard/connect actually offers and fix the mismatch).
- **F-ONBOARD-4 (setup page):** add a show/hide-password toggle (tiny inline script
  on the login/setup template — the page already ships without client JS; a
  5-line inline `<script>` is acceptable on this auth page, which is outside the
  Turbo shell), applied to setup, login, and reset forms. Do NOT add any paste
  blocking; add a test asserting no `onpaste` handler exists. Confirm-mismatch
  server error already exists; keep.

### 2.4 Sub-scope 4d — first-run starter collections

**"starter" wizard step** (between bot and connect): server-renders the four themed
collections from the same registry data the extensions page uses (name, icon,
description, member count — no live registry fetch beyond what
`panels/extensions/data-queries.js` already caches; reuse its loader), each linking
via `deepLink` to `/dashboard/extensions#collections`. No install-from-wizard (the
extensions page owns install UX, progress, and env-var modals; duplicating that in
a no-JS wizard is scope creep). The done-step "try collections" card stays.

### 2.5 Sub-scope 4c — installer prerequisites (reduced to the verified gaps)

- **Tailscale offer:** when `tailscale` is absent, `ask_yn "Install Tailscale?" Y` →
  official `https://tailscale.com/install.sh` script; then the existing step-9 logic
  runs (it already handles the not-authenticated case with guidance). Headless
  default Y is safe (install ≠ authenticate; no tailnet mutation without
  `tailscale up`).
- **Platform honesty:** header comment + an early uname/apt check: non-Debian/Ubuntu
  → clear message pointing at `docs/getting-started/` manual path (exit 1, no
  half-install). macOS auto-install is explicitly NOT promised.
- **Docker at point of use:** `routes/bundles.js` install path for `deploys` bundles
  checks docker availability first (`docker info` spawn, cached ~60s) → honest 4xx
  with per-OS guidance string the extensions client renders in the existing error
  surface; extensions page shows a passive banner when docker is missing entirely.
  (Fix-it detector considered and rejected for now: fix-it is event-driven at
  chokepoints; a static environment fact fits the render-time banner better.)
- Installer tests: extend the `CROW_INSTALL_SOURCE_ONLY=1` seam tests for the new
  prompt + platform check. A full VM run of `crow-install.sh` is a manual operator
  validation (documented), not a per-PR gate.

## 3. PR seams (order matters)

| PR | Content | Size |
|---|---|---|
| **4-PR1** | F4-SEED + bot-builder honesty + F4-EMAIL + gwHint i18n (§2.1 items 1–6) | M |
| **4-PR2** | Wizard: ai step + starter step + connect copy + setup-page password toggle (§2.3 wizard parts + §2.4) | M |
| **4-PR3** | Identity backup: wizard done-step form + download endpoint + CLI honesty + docs (§2.3 identity parts) | M |
| **4-PR4** | F4-PATHS sweep + placeholder/lab-string cleanup + resolver-unavailable surface (§2.2, §2.1 item 7) | M |
| **4-PR5** | Installer: Tailscale offer + platform gate + docker point-of-use surfacing (§2.5) | S-M |

PR1 first (it defines the fresh-install baseline every later acceptance check runs
against). PR2 before PR3 (both rewrite `onboarding.js` + its i18n block — sequential
keeps the churn reviewable; the done step PR3 extends already exists). PR4/PR5
independent after PR1.

### 3.1 Fresh-install audit — the theme's acceptance vehicle

Scratch env per §2/§3 of the master plan (mkdtemp CROW_HOME/CROW_DATA_DIR, throwaway
clone, orphan-guarded scratch gateway, session minted in scratch DB, CDP via
10.0.0.237):

1. Boot with **no models.json anywhere** → providers table empty; Settings →
   Providers renders honest empty state; bot-builder create form: warning + disabled
   submit; forced POST (curl) with bogus model → rejected, no row.
2. CDP wizard walk: all 7 steps render EN+ES; ai step shows the no-providers copy;
   starter step shows 4 collections; done step backup form downloads a blob;
   assert blob contains crowId AND does NOT contain the plaintext seed (string
   compare against scratch identity.json `seed`); decrypt round-trip with the
   passphrase succeeds (`decryptSeed`).
3. New-bot default: create a bot (after adding a scratch provider row) → definition
   JSON has `gateways: []` and the chosen model; no `kevin` string anywhere in it.
4. **Personal-artifact grep** over (a) the scratch DB dump, (b) every wizard/settings
   page's rendered HTML, (c) the source sweep of §2.2 — all three use the ONE
   pattern `kevin|kh0pp|100\.118\.41|100\.121\.254|10\.0\.0\.|dachshund` (plus
   `maestro\.press` reported-but-allowlistable). Documented allowlist — the ONLY
   permitted matches:
   - `maestro.press` product surfaces: integration docsUrls, `support@maestro.press`,
     `DEFAULT_INVITE_PAGE_URL`;
   - the `kh0pper` GitHub org as the product's code/registry home: `REGISTRY_URL`
     (`panels/extensions/data-queries.js:19`), repo-URL footers in bundle panels,
     bundle/registry `author` fields, install-script clone URLs;
   - maintainer-name mentions in code COMMENTS/docstrings (e.g. `push.js:122`,
     `consulting/server.js:7`, `meta-glasses/server/device-store.js:9`) — comments
     are not product behavior; cosmetic cleanup allowed but not required;
   - `scripts/pi-bots/systemd/*.service` unit files (`User=kh0pp`,
     `/home/kh0pp/crow` paths) — instance-deploy templates by nature; adjudicated
     allowed, with a header comment marking them as operator-edited templates;
   - test fixtures and Kevin's untracked WIP.
   Anything else is a defect. After PR4, bare `kh0pp` (Kevin's local user, vs the
   `kh0pper` org) must appear in RUNTIME code paths zero times; remaining hits
   must all classify under the comment/systemd/test rules above. The §2.2 sweep
   run is the audit artifact: every hit gets a one-line disposition (fixed /
   allowlisted-with-rule) in the PR body.
5. Suite + check-ports + build-registry per §2 gates; mutation checks per guard
   (notably: create-action model guard, docker point-of-use guard, backup-endpoint
   passphrase-required guard).

Per-PR CDP evidence under `~/.crow/p4/item4-<pr>/` (assertions.jsonl + screenshots).
Post-item: full 12-page standing bug-hunt round.

## 4. Non-goals / out of scope

- Dashboard identity **restore** flow (re-keying a booted instance = sync-layer
  design; follow-up pool).
- macOS/Windows installer support (documented manual path only).
- Bot Builder guided-flow overhaul (Item 5; PR1's model honesty is its prerequisite).
- Renaming/removing the companion env-default model keys (portable bundle ids).
- Touching existing bot definitions or providers rows on any live instance.
- pi's own `~/.pi/agent/models.json` (pi-coding-agent's file, not Crow's).

## 5. Decision log (self-interrogation under the standing grant)

- *Why delete models.json rather than genericize?* Any shipped provider entry is a
  lie on someone's box; empty + honest beats plausible + phantom. Kevin's fleet
  keeps DB rows (seed-once) and per-box untracked copies.
- *Why gateways:[] instead of a placeholder address?* A placeholder still implies
  mail routing that does not exist; empty is inert (verified `bridge_tick.mjs:81`)
  and the Gateways tab is the honest place to configure one.
- *Why backup on the done step, not its own step?* Its own step forces a passphrase
  decision mid-tour on users who may skip; done-step placement keeps the tour
  friction-free and survives replay visits. (Reviewer challenge welcome.)
- *Why require a passphrase for backup at all?* An unencrypted download invites
  cloud-synced Downloads-folder seed leaks; `encryptSeed` exists and costs one field.
- *Why no wizard-side install for starter kits?* The extensions page owns install
  jobs/progress/env modals; the wizard is deliberately no-JS.
- *Why is Tailscale-install headless default Y but hostname rename default N?*
  Install is additive and inert until `tailscale up`; rename mutates identity
  (F-INSTALL-7/-11 history).

## 6. Review record

**Round 1 (2026-07-13, fresh Opus subagent, verdict REVISE — all findings verified
against code by the authoring session before folding):**
- MAJOR-1: migration choreography rested on a WRONG fallback claim (`providers.js`
  does not read `~/.pi/agent/models.json`; first-file-wins, no merge; repo/pi
  provider sets are disjoint) and ignored the auto-update pull-wedge failure mode
  (`crow-update.sh:33-38`). → §2.1 migration rewritten as a hard executor-performed
  pre-merge gate with full-copy `config/models.json` and a clean-`git status` check
  on all four boxes.
- MAJOR-2: the acceptance grep and the §2.2 sweep used different patterns, and the
  allowlist omitted the load-bearing `kh0pper` GitHub-org product strings → unified
  pattern + expanded allowlist + the `kh0pp`/`kh0pper` typo fix.
- MAJOR-3: missed hardcodes inside the very surfaces being edited
  (`spawn_env.PI_PROVIDER` in `defaultDefinition`, the editor's lying warn-but-save
  text, `bot-board/client.js:174` lab URL, `bot-board-api.js:62,64`) → §2.1 items
  4-5 and §2.2 expanded.
- MAJOR-4: restore-as-specced would write an unbootable encrypted identity.json
  (`loadInstanceSeed` throws on `encrypted`); `encryptSeed`/`decryptSeed` are not
  exported → restore semantics stated (decrypt-to-plaintext-seed), exports added.
- MAJOR-5: `crow-local` is pi's provider id, not an installable Crow bundle — the
  keep-LOCAL_FALLBACK justification was false → corrected; the unavailable-surface
  check made mandatory (fresh installs hit it).
- MINOR-6/7/8/9: backup passphrase minlength 8→12; the pi-bots bare-path family;
  `admin-backup.js` kevin- prefix + shared-storage placeholder; sync-button no-op
  note. All folded.
- Reviewer verified-correct: `gateways: []` inertness (both channels), CSP allows
  the inline toggle script, funnel/CSRF posture of the backup endpoint, wizard
  step/i18n mechanics, the three bot-builder hardcode sites.

**Round 2 (2026-07-13, second fresh Opus subagent, verdict REVISE — all findings
verified by the authoring session before folding):**
- Confirmed round-1 folds MAJOR-4 (identity: `encryptSeed` enciphers the seed
  buffer only; payload as specced is implementable; `deriveInstanceIdentity`
  round-trips) and MAJOR-5 correct.
- F-N1 (MAJOR): `tests/providers-reconcile-gate.test.js:213,221` hard-asserts a
  non-empty tailnet-bearing models.json — mutually exclusive with the §3.1
  "no models.json anywhere" acceptance env after the `git rm`. → PR1 reworks the
  test with a scratch-path fixture.
- F-N2 (MAJOR): sweep still unreconciled — `gmail_io.mjs` personal creds paths,
  browser bundle broken off `/home/kh0pp`, two more `kh0pp/crow` footer typos,
  `providers-db.js:35` itself (the first draft wrongly cited it as the exemplar),
  plus no adjudication rule for comments/systemd hits. → §2.2 and the §3.1
  allowlist expanded; per-hit disposition required in the PR body.
- F-N3 (MAJOR): baking `spawn_env.PI_PROVIDER` perpetuates a shadow —
  `bridge.mjs:147-152` applies `def.spawn_env` LAST, overriding the per-turn
  resolver value. → drop the key from `defaultDefinition` entirely.
- F-N4: three onboarding tests hardcode 5-step positions → listed in §2.3, rework
  against exported STEP_KEYS. F-N5: `.gitignore` pattern root-anchored. Note:
  backup POST is a hand-registered dashboard route, not a panel handler → stated.

**Round 3 (2026-07-13, third fresh Opus subagent, closure check, verdict REVISE →
two localized edits applied → CLOSED):**
- F-N1's "scratch search path" fix was a footgun as first written: no injection
  seam exists, and a naive fixture would clobber the live `config/models.json` the
  migration gate itself creates. → mechanism pinned in §2.1 (injectable seam +
  mkdtemp fixture + lockstep `mergedModelsJsonEntries` rework + explicit
  do-not-touch list).
- The `kh0pp/crow` typo list wrongly included `content-extractor.js:12` (already
  `kh0pper`) — corrected to the three verified sites (ground-truthed by the
  authoring session, since rounds 1 and 2 disagreed).
- All other folds verified correct; whole-document consistency PASS (PR seams,
  patterns, non-goals, decision log).
