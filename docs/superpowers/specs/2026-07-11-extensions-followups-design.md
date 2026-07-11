# Extensions follow-up pool — design v3 (2026-07-11)

Item 1 of `docs/superpowers/plans/2026-07-11-opus-autonomous-arc.md`. Three accepted
follow-ups from the extensions overhaul (PR #173). One branch, one PR:
`fix/extensions-follow-up-pool`.

**v3 folds TWO adversarial Opus review rounds (R1 REVISE: 4C/5I/8m; R2 REVISE: 5C/7I/5m).
Every finding was re-verified against the code and the live host before folding.** The
naive design would have badged Kevin's *working* bundles as unconfigured on day one. See
§Review record.

No schema change ⇒ the §3 auto-update **migration rail does not apply**; a plain merge +
deploy is correct.

## The central design fact (measured, not argued)

A missing `bundles/<id>/.env` does **not** mean "unconfigured" on a real host — it usually
means the bundle isn't gateway-managed-with-config at all. Measured against crow's actual
10 installed bundles:

| rule | would badge |
|---|---|
| naive (`.env` only, badge whenever a required key is empty) | **frigate (1 key), capstone-tracker (12 keys)** — both FALSE |
| **v3** (managed-evidence gate + effective env) | **zero** — every installed bundle is either genuinely configured or not managed-with-config |

`capstone-tracker`'s installed dir contains **only `manifest.json`** (an operator WIP stub);
`frigate`/`motioneye` have no `.env` at all. So `existsSync(bundleDir)` is the **wrong**
gate — it passes for all of them.

**The rule (fail closed — never nag about something we cannot verify):** badge a bundle
only when there is positive evidence the gateway manages its config —
`bundles/<id>/.env` exists **OR** the bundle has an `mcp-addons.json` entry — and a
required key is still empty in its *effective* env. This does not weaken the feature: every
install path that has required keys **writes** a `.env` (user values, or `.env.example`
copied at `bundles.js:1264`), so a genuinely unconfigured install still badges.

---

## 1a — Config state that survives, and finally exists at all

### The problem

After a **collection** install the client shows a NEEDS_CONFIG checklist modal. It is
one-shot: `renderPendingChecklist` (`panels/extensions/client.js:1341`) reads
`sessionStorage["crow_ext_needs_config"]` and `removeItem`s it *before* parsing
(`:1345-1347`). Close the modal without configuring → the checklist is gone until you
reinstall.

And the deeper gap: `NEEDS_CONFIG` is emitted **only** by the `/install-set` job runner
(`routes/bundles.js:1961-1966`). A bundle installed through the single `/install` path
(`:1849`) that requires config gets **no prompt, ever**. For the most common install
path, this affordance is not a fallback — it is the only surface that will ever tell the
user their bundle is unconfigured.

### D1 — Extract to one source of truth (do NOT duplicate)

New module **`servers/gateway/bundles-config.js`** owns: `CROW_HOME`/`BUNDLES_DIR`,
`APP_BUNDLES`, `getManifest`, `resolveEffectiveEnv` (new, see D3), `needsConfigKeys`, and
the **`_setAppBundlesForTest` setter**. `routes/bundles.js` imports these and
**re-exports `needsConfigKeys` and `_setAppBundlesForTest`** (delegating, not
re-declaring).

**This is load-bearing, not stylistic.** `APP_BUNDLES` is a mutable `let`
(`bundles.js:126-129`) precisely so `_setAppBundlesForTest` can repoint it at a scratch
tree — the guard that keeps the E2E suite from installing real bundles on Kevin's host
(`tests/install-set-e2e.test.js:36-39`: *"a prior run of a test in this family actually
installed uptime-kuma on the operator's live host"*). If the new module declares its own
`APP_BUNDLES`, the setter repoints only one of the two roots, the isolation guard is
half-broken, and **no assertion in the suite detects it**. There must be exactly one
`APP_BUNDLES` binding in the codebase.

Existing importers that must keep working unchanged: `tests/bundles-install-set.test.js:3`
(imports `needsConfigKeys` from `routes/bundles.js`), `tests/install-set-e2e.test.js:107,144`
(imports `_setAppBundlesForTest`). Circular-import risk is nil if `bundles-config.js`
imports only node builtins.

### D2 — Manifest source: installed-first, but ONLY for this feature

`getManifest` reads only `APP_BUNDLES` (the repo checkout, `bundles.js:590-597`), while
`resolveManifestHost` (`:191-197`) already prefers the **installed** copy, then the repo.
For config-completeness the installed copy is the right truth (a bundle installed from a
version no longer in the repo would otherwise yield `getManifest → null →
needsConfigKeys → []`, silently hiding the affordance on exactly the stale installs that
need it).

**⚠️ Do NOT change `getManifest` itself.** It has ~18 callers, feeding `validateInstall`
(`:1105`), the hardware gate (`:1139`), `/consent-challenge` (`:1811`), compose
validation, `findDependents` (`:962`), `planInstallSet` (`:1712`). And the reverse
divergence is real on this host **right now**: `~/.crow/bundles/` contains `dozzle`,
`minio`, `romm`, `google-workspace`, `knowledge-base-mcp`, `fed-gov-data`,
`texas-gov-data` — none of them in `installed.json`. Making `getManifest`
installed-first would run consent/hardware/compose validation for a future install of any
of those against a **stale installed manifest** instead of the repo's.

Add a **separate** `getInstalledFirstManifest(id)` (installed → repo fallback), used
**only** by `resolveEffectiveEnv` / `needsConfigKeys`. Leave `getManifest` untouched.

Ordering is fine at the existing call site: `needsConfigKeys(member.id)`
(`bundles.js:1961`) runs **after** `runInstallJob` has `cpSync`'d the source dir
(`:1226-1228`), so the installed manifest exists by then.

Accepted consequence: if an auto-update ships a manifest that adds a new `required` key,
existing installs light up "Needs setup". That is **correct** — the container genuinely
lacks a now-required value — and it is exactly the signal the product cannot show today.

### D3 — Effective env: three sources, plus the managed-evidence gate

`needsConfigKeys` today consults **only** `bundles/<id>/.env`. That is right for the
moment it was written for (immediately post-install, where the runner just wrote the file)
and wrong as a durable signal. Config that actually makes a bundle work lives in up to
three places:

1. **`bundles/<id>/.env`** — docker bundles (compose reads it).
2. **`~/.crow/mcp-addons.json[<id>].env`** — MCP add-ons. `applyEnvToMcpAddons`
   (`bundles.js:672-686`) writes it and its docstring (`:664-670`) is explicit: *"MCP
   children are spawned with { ...process.env, ...(config.env||{}) } from mcp-addons.json
   (proxy.js) — they never read bundles/<id>/.env."*
3. **Ambient `process.env`** — `proxy.js:145` spawns MCP children with `{ ...process.env,
   ...config.env }`, and `applyEnvToMcpAddons` skips blanks precisely so it won't *shadow*
   "a working ambient value". A key supplied via the gateway's own env / systemd
   `Environment=` is effective config that appears in neither file.

`resolveEffectiveEnv(bundleId, manifest, { envOverride } = {})` merges, in precedence
order: `.env` > `mcp-addons.json[<id>].env` > `process.env` (the last two only for bundles
that register an MCP server). A required key is **configured** if its effective value is
non-empty after `trim()`.

**Managed-evidence gate (see "The central design fact"):** compute an affordance at all
only when `.env` exists **or** the bundle has an `mcp-addons.json` entry. Otherwise return
`[]` — we cannot distinguish "unconfigured" from "not managed this way", and a false nag
is worse than a missing one. This is what keeps `capstone-tracker` (manifest-only stub) and
`frigate`/`motioneye` (no `.env`) quiet, and it is what makes the prod badge count zero
today.

**Preserve the `envOverride` seam.** The current signature is
`needsConfigKeys(bundleId, envOverride = null)` and `tests/bundles-install-set.test.js:40,45`
depends on it to inject a parsed env. Keep it, and make it **short-circuit** the
mcp-addons/ambient lookups entirely (an injected env is the whole truth) — otherwise that
unit test's result would depend on whether the *host* happens to have the bundle in
`mcp-addons.json`.

Preserve the existing docstring rule: a key that already has a value — **including an
`.env.example` default** (DB passwords, secret keys) — counts as configured and is never
surfaced; those are consumed at first container boot and changing them later breaks the app
or strands its data. Corollary, accepted and documented: manifest `default`s are copied into
`mcp-addons.json` at install (`bundles.js:1355-1358`, `:1421-1424`), so an MCP bundle whose
required key has a placeholder default will never badge. Do not "fix" this — it is the same
rule.

### D4 — Server-rendered affordance, computed in the panel handler

Compute in **`panels/extensions.js:31`**, which already has `installed` in hand and is
`async`: add `fetchNeedsConfig(installed)` to the panel's `data-queries.js` and pass the
result into `buildExtensionsHTML({ ..., needsConfig = {} })` as a **defaulted** param
(`html.js:148-156` destructures a fixed set; a *required* param would break
`extensions-page-render.test.js`).

**`html.js` stays pure and must never call `needsConfigKeys` itself.**
`tests/extensions-client-contract.test.js:16-17` declares the contract — *"Nothing here
imports routes/bundles.js or data-queries.js, so ~/.crow is never read or written"* —
and computing inside `html.js` would make that unit test read Kevin's real
`~/.crow/bundles/*/.env`.

Render on any card whose list is non-empty (`html.js:303-338`): a **"Needs setup"** badge
(reuse `badge()` from `shared/components.js`, as the status badges do at `html.js:308-310`
— do not invent a class + CSS) plus a Configure button, all attributes `escapeHtml`'d like
their neighbours:

```
<button class="btn btn-sm btn-primary bundle-configure"
        data-id="${escapeHtml(id)}" data-keys="${escapeHtml(keys.join(","))}">
```

The gate is the **managed-evidence** rule of D3, *not* `existsSync(bundleDir)` — that
predicate passes for `capstone-tracker` (manifest-only stub) and would render a permanent
badge wired to a Configure button whose POST writes a `.env` into a directory nothing
reads. (`POST /bundles/api/env` 404s only when the dir is entirely absent,
`bundles.js:2302-2305`.)

**Import discipline (`data-queries.js`):** import `needsConfigKeys` **only** from
`bundles-config.js` — never from `routes/bundles.js`, which would drag express `Router`,
`db.js`, `peer-forward`, `cross-host-auth`, `providers-db` and the settings registry into
the panel data path and knot the import graph (`routes/bundles.js` already imports
`panels/extensions/collections.js` at `:40`).

**`APP_ROOT` depth:** `bundles.js:117` computes `resolve(__dirname, "../../..")` from
`servers/gateway/routes/`. At `servers/gateway/bundles-config.js` the correct expression is
`"../.."` (cf. `servers/gateway/env-manager.js:7`). A literal copy yields
`APP_BUNDLES = /home/kh0pp/bundles` — every install 404s and `planInstallSet` skips every
member. State it in the task brief.

Rejected: a `needs_config` field on `GET /bundles/api/status` (`:1766`). It costs a client
round-trip, and — decisively — `xhostVerify` is mounted **router-wide** (`:1755-1764`), so
that route is a **cross-host peer surface**. Config-completeness of Kevin's bundles has no
business being exposed to peers.

### D5 — 🔒 Key NAMES only, never values

Key names are already public (they're in the manifest's `env_vars`). Values are secrets
(API keys, DB passwords). **No `.env` or `mcp-addons.json` value may reach the browser** —
not in HTML, not in a data attribute, not in a JSON island. The compute layer returns
`string[]` of names; the render layer never sees a value. This is the hard boundary, and
the test for it must exercise the **compute→render seam end to end** (see AC-7) — a
sentinel test that only renders would pass trivially and guard nothing.

### D6 — Reuse the Configure modal, and make the badge actually clear

The button opens the same env-only modal the checklist uses:
`showInstallModal(id, name, envVars, 0, 0, false, /* configureOnly */ true, onSaved)`
(`client.js:88`). `configureOnly` skips the consent fetch (`:113`), the resource warning
(`:250`), and the community banner (`:231`), and routes submit through
`/bundles/api/env` (`:332-380`). Env metadata comes from `ADDON_DATA[id]`, with a
`{ name: key, required: true }` fallback (`:1294-1297`) — so an installed-but-unregistered
bundle degrades gracefully. #173's blank-save guard (`6ba59036`) and the router-wide
`xhostVerify` continue to apply unchanged; no new write path.

**The existing configure flow does NOT reload** — an earlier draft claimed it did, and that
was wrong. The checklist's `onSaved` (`client.js:1305-1318`) only splices the in-memory
list, rewrites sessionStorage, and hides the modal; the `location.reload()` at `:579`
belongs to `pollJob` (the install flow). So on success, **both** entry points must update
the badge themselves.

**The client must not decide whether the bundle is now configured — the server must tell
it.** `submitConfigureOnly` (`client.js:322-341`) guards only the *all-blank* case, and
`if (inp && inp.value)` even accepts whitespace (which `needsConfigKeys` trims away). So
filling 1 of 12 keys returns 200, and a client that clears the badge on any 200 would hide
a still-unconfigured bundle until the next navigation — a silent false "done".

Therefore: **`POST /bundles/api/env` returns the bundle's remaining `needs_config: string[]`**
(re-derived server-side after the write, via the same `needsConfigKeys`). `onSaved(resp)`
then drives the DOM from that response — remove the badge only when `needs_config` is
empty, otherwise update `data-keys` in place. This is server-derived truth, adds no new
read surface, and fixes both entry points at once (including the cross-surface staleness
where a save via the *checklist* would otherwise leave the card's badge stale).

DOM plumbing (record it so nobody reinvents it): the installed card carries
`data-addon-id` (`html.js:302`), reachable as `[data-addon-id="…"]` — **null-safe**, the
card may not exist (e.g. saving from the checklist right after a restart). The card's own
click handler already ignores `.btn` targets (`client.js:1038-1041`), so a `btn`-classed
`.bundle-configure` needs no `stopPropagation`.

No reload — that preserves the checklist's careful restart-safe semantics.

**Known limitation, stated not fixed:** for MCP bundles `/bundles/api/env` returns
`needs_restart: true` (`bundles.js:2331-2336`) and the child keeps its old env until a
gateway restart. Clearing the badge means "configured", not "already live". The existing
restart affordance covers the rest.

### D7 — Leave the sessionStorage checklist's one-shot semantics alone

It still fires post-collection-install as the *proactive* prompt. The card affordance is
the durable, re-derivable surface. Do not change the one-shot consumption — that risks the
reopen-loop #173 closed.

### D8 — i18n

New key (`extensions.needsSetup`) as a flat `{en, es}` entry in `shared/i18n.js`
(cf. `:641`); `extensions.configure` already exists (`client.js:93`). Note the real
fallback behavior: `t()` falls back to `entry.en` before the raw key (`i18n.js:1469-1471`),
so a missing Spanish *value* ships English (not the literal key) — still wrong, still add
both, but don't cite the wrong failure mode in the PR.

### Acceptance criteria (1a)

1. A bundle with an unmet required key shows the affordance on a fresh load with
   **sessionStorage cleared**.
2. It shows for a bundle installed via **single `/install`** (which never emitted a
   checklist) — the regression this really closes.
3. **A functioning MCP add-on configured via `mcp-addons.json` only (no `.env`) shows NO
   affordance** (D3 — the day-one prod bug).
4. **An MCP add-on whose required key is supplied only by ambient `process.env` shows NO
   affordance** (D3 source 3).
5. A bundle with **no managed evidence** (no `.env`, no mcp-addons entry — e.g. a
   manifest-only stub like `capstone-tracker`, or `frigate`) shows **no** affordance, even
   though required keys are "empty". This is the measured prod case.
6. A bundle whose required keys all have values shows no affordance; a bundle with no
   required keys shows no affordance.
7. Clicking Configure opens the env-only modal scoped to exactly the missing keys.
   **Partial save:** filling some-but-not-all keys → the badge REMAINS, with `data-keys`
   narrowed to what's still missing (driven by the route's returned `needs_config`).
   **Full save:** badge removed, no reinstall, no reload. Saving via the *checklist* also
   updates/clears the card's badge.
8. **Security (must actually be able to fail):** in a scratch `CROW_HOME`, fixture a bundle
   with **two** required keys — one holding sentinel `SECRET_SENTINEL_VALUE_9f3a` (in
   `.env` **and** in `mcp-addons.json`), one left **empty**. Drive
   `fetchNeedsConfig → buildExtensionsHTML` and assert **both**: (a) the badge/Configure
   button **is present** for that bundle (proving the render path is live — otherwise the
   sentinel check is vacuous, since a fully-configured bundle renders nothing at all), and
   (b) the sentinel appears **zero** times in the HTML.
9. Honors `CROW_HOME` (a scratch-`CROW_HOME` gateway reports its OWN bundles — the
   `1b28d38a` invariant).
10. Exactly one **binding** of `APP_BUNDLES` exists (assert on the declaration/assignment
    pattern — `^let APP_BUNDLES` / assignment sites — not a bare `grep -c`, since
    `bundles.js` still *references* it in ~6 places), and both pre-existing importers
    (`bundles-install-set.test.js`, `install-set-e2e.test.js`) pass **unchanged**.

Test placement: AC-8 (and the other compute-layer criteria) go in a **new** test file that
sets `CROW_HOME` **before a dynamic import** — both `bundles-config.js` and
`data-queries.js:18` capture `CROW_HOME` at module load (the `install-set-e2e.test.js:105-111`
pattern). Do **not** add them to `extensions-page-render.test.js` or
`extensions-client-contract.test.js`: those declare "nothing here imports routes/bundles.js
or data-queries.js, so ~/.crow is never read" (`:5-7`, `:16-17`), and breaking that makes
them environment-dependent.

**Pre-merge live sanity check (read-only, on prod) — re-run it, don't trust this doc:**
compute what the badge *would* show for crow's real installed bundles. The v3 rule measured
**zero** badges on 2026-07-11 (naive rule: frigate 1, capstone-tracker 12 — both false). Any
bundle Kevin actually uses that reports "needs setup" is a bug, not a finding — stop and fix.

---

## 1b — Onboarding action-card targets (done-step cards ONLY)

### Correctly scoped

- **`deepLink()` (`onboarding.js:33`; callers `:155,:157,:160`) KEEPS `target="_blank"`.**
  These are **mid-tour** steps, and the docstring (`:31-32`) states why: it opens the
  surface in a new tab *so the tour stays open behind it*. Same-tab would navigate the user
  out of the wizard mid-tour. **Out of scope — do not touch.**
- **`renderActionCards()` (`onboarding.js:42`)** renders on the **done** step, after
  `onboarding_completed_at` is persisted (`:213-218`). No tour remains; a new tab for an
  internal dashboard link is just odd UX. **This is the only site in scope.**

All four done-step cards are internal today (`:48,:54,:60,:66` — `/dashboard/memory`,
`/dashboard/bot-builder`, `/dashboard/connect`, `/dashboard/extensions#collections`).

### Design

Extract a **pure classifier** (`isInternalHref(href)` → leading `/`) and use it in
`renderActionCards`: internal hrefs render with no `target`/`rel`; external hrefs
(absolute `http(s)://`) keep `target="_blank" rel="noopener"`. Classify by href so a card
added later by Item 4d gets the right behavior automatically. The external branch is dead
code on day one — unit-test the classifier directly with an external href, since the
renderer cannot exercise it.

### Acceptance criteria (1b)

1. **Behavioral regression guard on the tour** (not a byte-diff): execute the renderer for
   the `integrations` / `bot` / `connect` steps and assert each anchor still carries
   `target="_blank" rel="noopener"`.
2. Execute `renderActionCards` and assert per-card `target` by href class (executed
   renderer — a source regex is not evidence).
3. Every remaining `_blank` still carries `rel="noopener"`.
4. `isInternalHref` unit-tested with both classes, including an external href.
5. CDP: click an internal done-step card → navigates **in the same tab** and lands on the
   surface. This **inverts** assertion 9b in `~/.crow/p4/ext-overhaul/runner-c.mjs` (which
   asserted in the opened tab) — update that recipe in this PR.

---

## 1c — T12 timer pacing → barrier promise

### Design

Replace `_setInstallSetStepDelayForTest` (`bundles.js:156`, consumed at `:1940`) with a
**barrier**: a module-private `let _installSetBarrier = null` + setter; the runner awaits
it **at the top of each member iteration, including the first** — matching the current
seam's placement (`:1940`). ("Between members" would let the first member's install race
the three busy-gate fetches at `install-set-e2e.test.js:181-209`.)

Production default is a **true no-op**: `null` barrier ⇒ the `if (barrier) await barrier`
branch is never entered — no await, no timer. Prove the no-op **by mechanism** (default
asserted via a read-only getter / unentered branch), not by a comment.

The router is mounted **in-process** in the test (`install-set-e2e.test.js:160-163`), so
there is no HTTP boundary to install the barrier across; and `beginInstallSet()` runs
before `res.json()` (`bundles.js:1926-1934`), so `isInstallSetRunning()` is already true
when the first response lands. The determinism is real.

**Resolve placement — getting this wrong hangs the happy path.** The test must resolve the
barrier **immediately after the busy-gate assertions** (`install-set-e2e.test.js:181-209`),
so the runner proceeds and the poll loop (`:213-218`) sees completion. Resolving *only* in
`t.after()` would park the runner while the poll burns its 100×50ms — a 100%-reproducible
failure. Then **also** resolve idempotently in `t.after()` (alongside the existing
`_setRestartHookForTest(null)` teardown, `:153-158`) as the failure story: if an assertion
throws first, `endInstallSet()` in the runner's `finally` (`:1975`) would otherwise never
run and leak the busy flag into the next test.

Confirm `_setInstallSetStepDelayForTest` has no consumer besides `install-set-e2e.test.js`
before deleting it (it does not).

### Acceptance criteria (1c)

1. Zero wall-clock sleeps in the busy-gate section (grep `setTimeout`/`sleep` → zero hits
   in that block).
2. The 409 assertion provably happens mid-flight, not "probably within 450ms".
3. Production path proven to take no barrier by default.
4. Mutation check: break the barrier ordering → a **named** assertion goes red; restore.
5. Barrier resolved unconditionally in `t.after()`.
6. Full suite green (scratch env).

---

## Risk / blast radius

No schema change (no migration rail). No new write path (1a reuses `/bundles/api/env`).
The security boundary is D5, tested end-to-end at the compute→render seam. The one real
regression risk is 1b touching onboarding — bounded by the behavioral tour guard. The one
real *product* risk is D3 (false badges on working add-ons) — bounded by AC-3 plus the
read-only prod sanity check before merge.

Gates: full suite on scratch env; `check-port-allocation.js` error block is exactly the one
known `Port 8090 (capstone-tracker)` line; `build-registry.mjs --check` clean; CDP evidence
in `~/.crow/p4/ext-followups/`.

---

## Review record

**R2 — second adversarial Opus round, verdict REVISE (5 critical, 7 important).** It caught
that three of R1's four "critical" folds were themselves wrong or incomplete — and proved it
by computing the rule against the live host. All folded into v3:

- **R2-C1 — the fold's own pre-merge gate already failed on prod.** The v2 rule would badge
  `capstone-tracker` (12 keys) and `frigate` (1) — both false. `existsSync(bundleDir)` was
  the wrong gate: `capstone-tracker`'s installed dir holds *only* `manifest.json`, so it
  passes, and its Configure button would POST a `.env` into a stub directory nothing reads.
  → Replaced with the **managed-evidence gate**; independently re-measured: **zero** badges
  across crow's 10 installed bundles, while a real unconfigured install still badges.
- **R2-C2 — AC-7 was STILL vacuous.** If the sentinel is the value of the only required key,
  the bundle is configured → no badge renders → "zero occurrences" passes trivially, on an
  implementation that leaks values for every *other* bundle. → AC-8 now fixtures two keys
  (one sentinel-valued, one empty) and asserts the badge **is** present *and* the sentinel
  is absent.
- **R2-C3 — D3 silently dropped the `envOverride` seam** that D1 promised keeps working,
  which would have turned `bundles-install-set.test.js:40` red (it would read the operator's
  real `~/.crow`). → Signature pinned; `envOverride` short-circuits the other sources.
- **R2-C4 — D2's "installed manifest first" leaked into the shared `getManifest`** (~18
  callers: consent, hardware gate, compose validation, `planInstallSet`). And the reverse
  divergence is live — `~/.crow/bundles/` holds 7 bundles absent from `installed.json`, so a
  future install of any of them would have validated against a stale manifest. → Separate
  `getInstalledFirstManifest`, used only by this feature.
- **R2-C5 — D6 would false-clear on a partial save** (fill 1 of 12 keys → 200 → badge
  removed → still-unconfigured bundle looks done). → `/bundles/api/env` now returns the
  re-derived `needs_config`; the client renders server truth instead of guessing.
- **Importants folded:** `APP_ROOT` depth differs at the new module's path (a literal copy
  would point `APP_BUNDLES` at `/home/kh0pp/bundles` and 404 every install); ambient
  `process.env` is a third effective-config source for MCP children (`proxy.js:145`);
  `data-queries.js` must import from `bundles-config.js` only, never `routes/bundles.js`;
  AC-8 needs its own scratch-`CROW_HOME` file (the two existing extension tests *declare*
  they never read `~/.crow`); the 1c barrier must resolve right after the assertions or the
  happy path hangs 100% of the time; manifest defaults copied into `mcp-addons.json` mean
  some MCP bundles can never badge (accepted, documented).
- **Minors:** `t()` falls back to English, not the raw key (my stated failure mode was
  wrong); AC-10's grep must pin the *binding*, not references; reuse `badge()` from
  `shared/components.js`; card DOM lookup must be null-safe.

R2 also confirmed what R1 got right: the single-`APP_BUNDLES` requirement is workable via
ESM live bindings + delegating re-exports; `panels/extensions.js:31` is the correct compute
hook (`installed` is an **object** — iterate `Object.keys`); the install-set ordering is
safe (the installed manifest exists by `:1961`); and the barrier-at-top-of-iteration
placement is right.

**R1 — first adversarial Opus round, verdict REVISE (4 critical, 5 important).** Verified
and folded (several later corrected by R2, above):

- **C1 (critical)** — the extraction would have split `APP_BUNDLES`, half-breaking the test
  isolation guard that exists because a prior test *actually installed a bundle on Kevin's
  live host*. → D1 now mandates a single binding + delegating re-exports.
- **C2 (critical)** — "compute in the panel's data path" was ambiguous; computing inside
  `html.js` would make a pure unit test read the real `~/.crow`. → D4 names
  `panels/extensions.js:31` as the only correct hook, with a defaulted param.
- **C3 (critical)** — the sentinel security test was vacuous: once the layering is right,
  `html.js` structurally cannot emit a value, so a render-only test guards nothing. → AC-7
  now drives compute→render.
- **C4 (critical)** — an `installed.json` entry whose dir is gone would show a permanent
  badge wired to a Configure button that always 404s. → D4 gates on `existsSync`.
- **I1 (important)** — v1 wrongly claimed the configure flow reloads. It does not; the badge
  would never clear. → D6 removes the badge from the DOM on save, from **both** entry points
  (which also fixes cross-surface staleness, I2).
- **I3 (important)** — **the day-one prod bug:** MCP add-ons keep their real env in
  `mcp-addons.json`, never in `bundles/<id>/.env`, so working add-ons would have been badged
  "Needs setup" across Kevin's fleet. → D3 resolves *effective* env; AC-3 + a read-only prod
  check guard it.
- **I4 (important)** — manifest source was unspecified (repo vs installed). → D2 picks the
  installed copy, per the `resolveManifestHost` precedent.
- **I5 (important)** — barrier placement ("between members" would have raced the busy-gate
  assertions) and a missing failure story. → 1c fixed: top of each iteration incl. the first;
  unconditional resolve in `t.after()`.
- **Minors** folded: `renderActionCards` is at `:42` not `:74`; the external-href branch is
  dead on day one so the classifier is extracted and unit-tested; the byte-unchanged
  assertion replaced with a behavioral tour guard; i18n en+es (a missing key ships the raw
  key as UI text); `escapeHtml` on the new attributes; the `xhostVerify` peer-surface reason
  for rejecting the status-route option is now recorded.
