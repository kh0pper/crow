# F-HEALTH-1 — Provider-residency health signal (design)

**Date:** 2026-07-09
**Finding:** F-HEALTH-1 [S2-MAJOR, product] in `.superpowers/messages-plan/p4-findings.md`
**Status:** design v3 — R1 + R2 adversarial reviews folded. R2 found no CRITICAL and no MAJOR;
its empirical pass verified every load-bearing claim against the live fleet (see
"Empirical verification").

## Problem

Crow has no health signal covering whether its `alwaysResident` inference providers are
actually resident. On 2026-06-25 grackle's `vllm-cuda-embed` (its `alwaysResident` embed
provider) stopped coming up: an old `llama-server.service` squatted 15.5 / 16 GiB of VRAM,
so vLLM's engine init failed on every container start. Docker's `restart: unless-stopped`
loop retried **57,604 times** over **12 days**. Nothing alerted. Semantic memory and search
embeddings were silently degraded fleet-wide the entire time — the exact failure mode
`gpu-orchestrator.js`'s own header comment warns about.

It was found only because the PR #151 deploy made the orchestrator log its residency
decisions, and a human happened to read the log.

Three things had to line up for the outage to be invisible:

1. `health-signals.js` has signals for disk, storage, agents, peers, updates, backup, sync
   conflicts, logins, exposure, integrations, federation audit, and messages — and nothing
   for provider residency.
2. `gpu-orchestrator.js` only `console.log`s its ensure/skip/failure decisions.
3. `probeReady()` runs exactly once per provider, at gateway boot, inside `ensureResident`.
   **Nothing ever re-polls it.** A provider that dies at 09:00 on day 1 is indistinguishable
   from a healthy one for the rest of the process lifetime.

Item 3 is the root cause. Items 1 and 2 are why it never surfaced.

## Goal

A `providers` nest health signal that goes `warn` when an `alwaysResident` provider **this
machine owns** has been unreachable for longer than a threshold, and that notifies through
the existing health-monitor path (`post-listen.js` → `shouldNotify` 24h dedupe →
`createNotification` → dashboard + ntfy).

## Non-goals (explicitly declined, with reasons)

- **Docker restart-loop counts.** Getting a `RestartCount` needs `docker compose ps
  --format json` to map bundle → container id, then `docker inspect` per container: two
  extra process spawns per unhealthy provider per poll, a hard dependency on the docker CLI
  in a code path that must never throw, and a parse of an unstable JSON shape. The
  *duration* of the outage ("unreachable ≥ 12h") is strictly more actionable than the
  restart count and costs nothing.
- **Self-heal (re-`ensureResident` on a stale provider).** In the grackle incident it would
  have changed nothing — docker was already retrying every few seconds; the blocker was
  VRAM. Calling `ensureResident` from a timer would take the single-flight swap lock and
  block for up to `READINESS_TIMEOUT_MS` (4 min) on every tick of a persistent failure.
  Detection is the fix here.
- **A Fix-it Card.** The remedy is machine-specific (free VRAM, fix the bundle's env, start
  docker) and has no safe one-click action.
- **Flap detection.** See "Known limitations" — a rolling failure-ratio window is the right
  tool and does not belong in this PR.

## Architecture

Three units, each independently testable.

### 1. `servers/gateway/provider-health.js` — zero-import state module

Exact shape of the `servers/sharing/receive-health.js` precedent: **zero imports**, so the
nest signal can read it with a plain static import without dragging the orchestrator's
`child_process` / `providers.js` / `db.js` chain into the dashboard render path (and into
the test suite).

State, per provider name:

```
{ owned, baseUrl, embed, ready, firstOwnedAt, lastReadyAt, lastError, checkedAt }
```

```js
export function setResidencyInitialized()
export function recordResidency(name, { ready, nowMs, baseUrl, embed, error })
export function pruneResidency(declaredNames)   // only for providers no longer DECLARED
export function getProviderHealth()
export function _resetProviderHealth()          // test hook
```

`initialized: false` is the analogue of `receiveWired: null` — "the orchestrator never
ran", render `off`, never a false warn.

State is per-process and resets on gateway restart. That is correct, not a bug: a fresh
boot legitimately gets a fresh warm-up window. The consequence is that a displayed age is
"unreachable for **at least** X", and the copy says so.

#### Sticky ownership (R1-CRITICAL fix)

The first draft recomputed the local set every tick and pruned anything that fell out of
it. That is a **defect that would have re-created the very outage this feature detects**.
Both shipped `alwaysResident` providers bind a **Tailscale IP**, not loopback —
`crow-voice` is `http://100.118.41.122:8011/v1` and `grackle-embed` is
`http://100.121.254.89:9100/v1` — so `isLocallyOrchestratable()` is *conditional on
`tailscale0` being present in `networkInterfaces()` at poll time*. A `tailscaled` restart,
a `tailscale up/down`, or (on grackle, which runs on an mt7921u USB wifi adapter) a link
flap makes the provider momentarily non-local. Prune-on-locality-loss would delete its
outage clock and restart it from zero on the next tick — and if churn recurred faster than
the threshold, the `warn` would **never** fire.

Reviewer A proposed *freezing* the clock while non-local. That is also wrong: if
`tailscale0` is down, the gateway genuinely cannot reach the provider over that IP, so
embeddings really are broken and the operator should hear about it. Freezing hides a true
outage.

The correct model separates two questions:

- **"Am I responsible for this provider?"** — locality, evaluated once. Sticky.
- **"Can I reach it?"** — the probe, evaluated every tick.

So: the first time a declared `alwaysResident` provider passes `isLocallyOrchestratable`,
this process marks it `owned: true` and stamps `firstOwnedAt`. From then on it is probed
every tick **regardless of interface churn**. A peer's provider is never owned and never
probed (trap 1). A deferred provider is not owned until its interface appears, so its clock
starts then, not at boot (trap 2).

Ownership is re-evaluated only when the provider's `baseUrl` **changes** (stored in state
and compared each tick), so an operator repointing a provider at a peer correctly releases
ownership. `pruneResidency` drops only names no longer declared `alwaysResident` in the
config at all.

#### Clock semantics

`lastReadyAt` is stamped on every successful probe. The provider is in outage when

```
!ready && (nowMs - (lastReadyAt ?? firstOwnedAt)) >= threshold
```

Using `lastReadyAt ?? firstOwnedAt` covers the grackle case exactly: a provider that has
**never** answered in this process is clocked from the moment we took ownership of it.

### 2. `gpu-orchestrator.js` — a residency poll that actually re-polls

```js
export function isSafeBundleId(id)                   // PURE — new
export function localAlwaysResident(cfg, ownAddrs)   // PURE, no logging — new
export async function pollResidency({ cfg, ownAddrs, probe, now, composeExists } = {})
export function startResidencyMonitor()              // interval, unref'd, guarded
```

`localAlwaysResident(cfg, ownAddrs)` is a **new pure helper** with no `console.log`.
`alwaysResidentProviders()` keeps its existing signature and its boot-time skip log, and is
reimplemented on top of the helper so `tests/gpu-orchestrator-host-gate.test.js` stays
green. **(R1-MAJOR: log spam.)** The first draft had `pollResidency` call
`alwaysResidentProviders()` every tick; on every real fleet host the skipped set is always
non-empty (crow always skips `grackle-embed`, grackle always skips `crow-voice`), so that
would have written ~720 identical lines/day into the gateway log — a weekly-rotated file on
crow (`/etc/logrotate.d/crow-inference`), journald on grackle. Not unbounded, but needless
noise in the exact log that was used to find the original incident. **(R2 corrected the
"unrotated / forever" claim; the pure-helper decision stands regardless of sink.)**

Each tick, for every provider declared `alwaysResident` in `cfg`:

1. Skip unless it has a `bundleId` that satisfies `isSafeBundleId` **and**
   `bundles/<bundleId>/docker-compose.yml` exists on disk. **(R1-MAJOR: SSRF surface;
   R2-MINOR: path traversal.)** The `providers` table syncs fleet-wide, and
   `getOwnAddresses()` unconditionally contains `127.0.0.1` / `::1` / `localhost`. Without
   the `bundleId` gate a paired peer could inject a bundle-less row with
   `baseUrl: "http://127.0.0.1:<any-port>/v1"` and turn the new timer into a persistent
   internal-service liveness oracle — a *broader* fetch surface than `acquireProvider` /
   `maybeAcquireLocalProvider`, which both refuse a row with no `bundleId`.

   The existence check alone is not enough: `composeFile()` is
   `join(BUNDLES_DIR, bundleId, "docker-compose.yml")` with **no validation of `bundleId`
   anywhere**, so `bundleId: ".."` resolves to the repo-root `docker-compose.yml`, which
   exists and is tracked — the gate would pass. Hence `isSafeBundleId`: a single path
   segment matching `/^[A-Za-z0-9][A-Za-z0-9._-]*$/`, rejecting `.`, `..`, and anything
   containing `/` or `\`. It is enforced **inside `composeFile()` (throw)**, not only in the
   poll, so it also hardens the pre-existing `bundleUp` / `bundleStop` `spawn` paths that
   feed the same unvalidated value to docker. Failing closed there is safe: every caller
   already runs inside a try/catch.

   Requiring an orchestratable bundle is also just correct: a provider with no compose file
   is not something this machine can bring up, so there is nothing to warn about.
   (`probeReady` sends **no** headers — unlike `probeProvider` in
   `servers/shared/providers.js` — so no `apiKey` is leaked either way. See "Trust
   boundary".)
2. Reset ownership if the stored `baseUrl` differs from the current one.
3. If not yet owned and `isLocallyOrchestratable(p, ownAddrs)` → take ownership.
4. If owned → `probeReady(p.baseUrl)` and `recordResidency(...)`. Otherwise skip silently.

Then `pruneResidency(declaredNames)` where **`declaredNames` is every provider declared
`alwaysResident` in `cfg`, regardless of locality** — *not* `localAlwaysResident`'s output.
Passing the local set would drop a provider the moment its interface flapped, which is the
R1 CRITICAL re-entering through the prune door. Peers' providers are never recorded, so
including them in `declaredNames` is harmless.

`composeExists` is injectable (defaulting to `existsSync(composeFile(id))`) so the poll's
unit tests don't couple to repo layout.

`startResidencyMonitor` runs its own interval (`CROW_PROVIDER_RESIDENCY_POLL_MS`, default
120 s), **independent of `GPU_IDLE_REVERT_MS`**. Folding it into `startIdleRevertTimer`
would make residency monitoring silently die whenever an operator set
`GPU_IDLE_REVERT_MS=0`. Set the poll interval to `0` to disable. The interval is `unref()`d,
guarded by `if (_residencyTimer) return` (mirroring `startIdleRevertTimer`), and guarded by
an in-flight flag so a slow poll cannot stack.

**Arming happens first.** `initOrchestrator` sets `_initialized = true` before any `await`,
so a throw anywhere in its body permanently blocks retry — and the caller only
`.catch()`es and logs (`post-listen.js:194`). If the monitor were wired at the *end*, any
future throw in the ensure loop would leave detection silently disarmed for the process
lifetime: the exact failure class this PR exists to eliminate. So `setResidencyInitialized()`
and `startResidencyMonitor()` are called **immediately after `_initialized = true`, before
anything that can throw**, and the rest of `initOrchestrator`'s body is wrapped in a
try/catch. **(R2-NIT, promoted — it defends the feature's own liveness.)**

A consequence worth stating plainly: the first poll therefore runs *concurrently with* the
boot `ensureResident` loop rather than after it. That is fine and is why the threshold has
margin — the poll stamps `firstOwnedAt` at t≈0 and `ensureResident`'s warm completes within
`READINESS_INITIAL_DELAY_MS + READINESS_TIMEOUT_MS` = 241 s, well inside the 600 s
threshold. (The v2 draft claimed the warm "elapses before the first poll". With
end-of-init wiring that was true but fragile; with early arming it is simply irrelevant.)

The monitor is started **unconditionally**, not "only when providers are declared": a
provider can be added through the LLM settings UI after boot, and a monitor that never
started would never notice. A tick with nothing declared is a no-op over a cached
`loadProviders()` — the idle-revert timer already calls `loadProviders()` on the same
cadence, so this adds no measurable cost.

`pollResidency` is read-only: it calls `probeReady` and nothing else. It never takes the
`_swapInFlight` lock, never starts or stops a container. A throw from `loadProviders()` is
caught and the tick becomes a no-op, leaving prior state intact rather than wiping it.

### 3. `providersSignal(lang, nowFn)` in `health-signals.js`

Reads `getProviderHealth()` and formats. Zero I/O. Declared **`async`** — not because it
awaits anything, but because `collectHealthSignals` builds its array by *eagerly invoking*
each signal and only then wraps the results (`[…, providersSignal(…)].map(p =>
Promise.resolve(p).catch(…))`). A synchronous throw would therefore escape the per-signal
`.catch()` and reject the whole `Promise.all`, taking down **every** signal. `async` turns
any future throw into a catchable rejection. **(R1-NIT, but a real latent trap — the
existing sync `federationAuditSignal` has the same exposure.)**

Registered in `collectHealthSignals`' `Promise.all` beside `messagesSignal`. Issue id is
the stable string `"providers"`, which is all the existing 24h dedupe in
`post-listen.js:215-239` needs.

Severity precedence, mirroring `messagesSignal`:

| Condition | state | severity | value |
|---|---|---|---|
| `initialized === false` | `off` | null | "not started" |
| no owned providers | `off` | null | "none configured" |
| any owned provider in outage (≥ threshold) | `warn` | `warn` | "`{name}` unreachable ≥`{age}`" · or "`{n}` providers unreachable" |
| some not-ready, none past threshold | `ok` | null | "`{n}` resident · `{n}` warming" |
| all ready | `ok` | null | "`{n}` resident" |

Threshold: `CROW_PROVIDER_NOT_READY_WARN_MS`, default **10 minutes**, read at call time so
tests can override it. Worst-case *legitimate* not-ready windows:

- boot ensure: `READINESS_INITIAL_DELAY_MS` (1 s) + `READINESS_TIMEOUT_MS` (240 s) — and
  this elapses *before* the first poll, since the monitor starts at the end of
  `initOrchestrator`.
- deferred resident: `IDLE_CHECK_INTERVAL_MS` (120 s) until `retryDeferredResidents` fires,
  plus a 240 s warm — but the clock starts at *ownership*, i.e. after the interface
  appears, so only the 240 s warm counts.

600 s clears both with >2× margin, and satisfies trap 2's "N > 1 tick" by 5×.

#### Warn copy is derived, not hardcoded

The first draft's `issueLabel` said "embeddings and semantic search are degraded". That is
**wrong on crow**: trap 1 means crow only ever owns `crow-voice`, whose single model has no
`task: "embed"` — it is the fast voice/dispatch model. Only grackle owns an embed provider.
A `crow-voice` outage announcing degraded embeddings would send the operator after the
wrong subsystem. **(R1-MAJOR.)**

So `recordResidency` stores an `embed` boolean (from the orchestrator's existing
`providerHasEmbedModel(p)`), and the signal picks its copy from the down providers:

- any down provider has `embed` → `downIssueEmbed`: new memories, sources and notes aren't
  being embedded; semantic search and recall are degraded.
- otherwise → `downIssue`: features that route to it (voice, chat) fall back or fail.
- more than one down → `downIssueMulti`, naming them.

`actionHref` is `/dashboard/settings?section=llm&tab=health` — verified: `llm.js:30` reads
`?tab=`, and `health` is a real tab id (`llm.js:25`). Note this link is used **only** by the
nest strip (`html.js:212-219`); the health-monitor notification hardcodes
`action_url: "/dashboard/nest"` for every signal (`post-listen.js:248`). That is a
pre-existing convention and this PR does not change it.

## Data flow

```
boot: initOrchestrator()
        ├── _initialized = true
        ├── setResidencyInitialized()
        ├── startResidencyMonitor()  ──┐   (armed FIRST; unconditional; guarded; unref'd)
        │                              │
        └── try {                      │  immediately, then every 120 s
              alwaysResidentProviders(cfg, ownAddrs)  → local names (logs skip line ONCE)
              ensureResident(name) for each           → docker compose up + waitForReady
            } catch { log }            │
                                       ▼
                              pollResidency()
                                 ├── localAlwaysResident(cfg, ownAddrs)   [PURE, no logging]
                                 ├── require isSafeBundleId + compose file on disk
                                 ├── reset ownership if baseUrl changed
                                 ├── take ownership if newly local        (traps 1 + 2)
                                 ├── probeReady(baseUrl) for OWNED providers only
                                 ├── recordResidency(name, {ready, nowMs, baseUrl, embed})
                                 └── pruneResidency(ALL declared alwaysResident names)
                                       │
                                       ▼
                          provider-health.js  (per-process state, zero imports)
                                       │
                    ┌──────────────────┴──────────────────┐
                    ▼                                     ▼
        nest render (30 s cache)              health monitor (15 min)
        collectHealthSignals                  collectHealthSignals
             providersSignal                       → shouldNotify("providers", 24h)
                                                   → createNotification (dashboard + ntfy)
```

Detection latency for a provider that dies at time T: the poll records not-ready within
120 s; the signal turns `warn` at ≈ T+12 min; the next health-monitor cycle (≤ 15 min later)
notifies. Worst case ≈ 27 minutes. Against a 12-day silent outage that is the right end of
the trade-off — and both the threshold and the poll interval are env-tunable.

## Error handling

- `pollResidency` wraps each provider's probe in try/catch; `probeReady` already swallows
  everything and returns `false`. A `loadProviders()` throw makes the tick a no-op.
- `startResidencyMonitor`'s interval callback catches everything. A residency poll must
  never be able to take down the gateway.
- `providersSignal` is `async` and does no I/O; it is additionally wrapped by
  `collectHealthSignals`' per-signal `.catch()` → `state: "off"`.
- **Trap 4:** nothing here touches `shouldRunHealthMonitor`. A `--no-auth` gateway still
  never runs the health monitor and so never notifies. It *will* run `initOrchestrator` and
  therefore the residency poll — as it already runs `initOrchestrator` today — but polling
  is read-only and notification stays gated. `tests/health-monitor-noauth-skip.test.js`
  must stay green untouched.

## Trust boundary

`probeReady` issues an unauthenticated `GET {baseUrl}/models` from the gateway process, and
the `providers` table syncs fleet-wide between paired instances. This PR turns a one-shot
boot probe into a recurring one, so it is worth stating the boundary explicitly:

- A provider is probed only if it is declared `alwaysResident`, **has a `bundleId` whose
  compose file exists in this checkout**, and its `baseUrl` hostname is one of this host's
  own non-virtual interface addresses (or loopback).
- `probeReady` sends no headers, so no `apiKey` can be exfiltrated (contrast `probeProvider`
  in `servers/shared/providers.js:120-124`, which does send `Authorization: Bearer`).
- The residual surface is: a **trusted, already-paired** peer could point one of the two
  shipped bundle ids at `http://127.0.0.1:<port>/v1` and learn whether that port answers,
  every 120 s. Such a peer can already make this host run `docker compose up` on a shipped
  bundle, so this is not a new trust level. Narrowing it further (an allowlist of probe
  ports) is out of scope and would break `crow-voice`'s tailnet-IP `baseUrl`.

## Known limitations (accepted, documented)

- **Flapping providers.** The clock clears on any successful probe. A bundle that answers
  one probe every ~8 minutes and is down the rest of the time never accumulates 10
  continuous unreachable minutes and never warns. The motivating incident was a hard-down
  (VRAM squatted, engine never initialised, 0 successful probes in 12 days) and is caught.
  Catching the flapping class needs a rolling failure-ratio window; that is a separate
  change with its own tuning, and is logged as a follow-up rather than smuggled in here.
- **Co-resident gateways double-notify.** crow (`:3001`) and crow-mpa (`:3006`) run on the
  same machine, share `getOwnAddresses()`, both own `crow-voice`, and both run the health
  monitor into different DBs — so one outage produces two ntfy pushes. This is *already*
  true today for every machine-scoped signal (`disk`, `storage`, `backup`), so `providers`
  is consistent with the existing convention rather than introducing a new problem.
- **24h dedupe on a stable id hides a second provider.** If provider A goes down (notifies)
  and B goes down an hour later while A is still down, `lastMap["providers"]` suppresses B
  for up to 24 h. Every fleet host today owns exactly one `alwaysResident` provider, so this
  is unreachable in practice. (`post-listen.js` already drops the dedupe marker once an
  issue clears, so a resolved-then-recurring outage does re-notify.)
- **A stale hardcoded `baseUrl` is a silence mode.** `models.json` pins `crow-voice` to
  `http://100.118.41.122:8011/v1` and `grackle-embed` to `http://100.121.254.89:9100/v1` —
  the maintainer's current Tailscale IPs. If a host's tailnet IP ever changes (node re-key,
  logout/rejoin, delete-and-re-add), its own provider stops matching `getOwnAddresses()`, is
  never owned, and the signal reads `off` ("none configured") **forever** — while the
  orchestrator has also silently stopped managing it. R2 proposed surfacing an `info` for
  "declared `alwaysResident`, has a local-looking bundle, but not locally orchestratable."
  **Rejected:** that predicate cannot distinguish *my provider whose address changed* from
  *a peer's provider*, and the `host` column is known-untrustworthy (PR #151's comment:
  fleet data violates its invariant). Such an `info` would fire on `grackle-embed` on crow
  and `crow-voice` on grackle, on every tick, forever — design trap 1, exactly what the
  physical-locality gate was added to prevent. The real fix is upstream: shipped defaults
  must not hardcode one lab's IPs. Folded into the generalization + first-run theme below.
- **Sticky ownership survives an IP hand-off.** Once owned, a provider is probed until its
  `baseUrl` string changes. If this host's tailnet IP changed *and* Tailscale later recycled
  the old address to a different node, we would keep probing a stranger's `:8011` every
  120 s (no credentials are sent). Narrow — and it can only arise *after* the stale-baseUrl
  blind spot above has already broken orchestration — so it is documented rather than coded
  around. Same upstream fix.
- **Shipped defaults must be reachable.** The "fresh install renders `off`" property holds
  *because* the two shipped `alwaysResident` providers carry the maintainer's Tailscale IPs,
  so `isLocallyOrchestratable` is false on anyone else's box. If the pending
  generalization + first-run theme ever ships a `http://localhost:PORT/v1` always-resident
  default, every install that hasn't started that Docker bundle will warn after 10 minutes.
  That would be the *correct* behavior of this signal reporting a real packaging gap (the
  known "extensions all need Docker that nothing installs" theme) — but the generalization
  work must ship per-install provider discovery, not a shipped localhost default, or it will
  turn this signal into first-run noise. Recorded here as a cross-theme dependency.

## Testing

Copying the shape of `tests/messages-health-signal.test.js` (drive `collectHealthSignals`,
assert on `details`/`issues` by id, inject the clock via `opts.now`).

**`tests/provider-health.test.js`** — the state module in isolation:
- fresh state → `initialized:false`, empty providers
- taking ownership stamps `firstOwnedAt` and `owned:true`
- a not-ready observation leaves `lastReadyAt` null; a `ready` observation stamps it
- a second not-ready observation does **not** move `firstOwnedAt` (records outage start)
- `pruneResidency` drops undeclared names and keeps declared ones
- `_resetProviderHealth` restores the initial shape

**`tests/providers-health-signal.test.js`** — the signal:
- not initialized → `off`, no issue
- initialized, zero owned providers (MPA / fresh install / no GPU) → `off`, no issue
- all ready → `ok`, no issue, value counts residents
- unreachable for less than the threshold → `ok`, no issue (the deferred/warm window)
- unreachable for more than the threshold → `warn` issue with id `providers`
- never-ready-since-ownership uses `firstOwnedAt` as the clock origin (the grackle case)
- an `embed` provider down → `downIssueEmbed` copy; a non-embed provider down →
  `downIssue` copy (**the crow-voice mis-copy regression**)
- two providers past the threshold → exactly **one** issue with id `providers`
- `CROW_PROVIDER_NOT_READY_WARN_MS` override is honored
- EN and ES both render, asserting the output **is not equal to the raw i18n key** (`t()`
  returns the key on a miss, `i18n.js:1396`)

**`tests/gpu-orchestrator-residency-poll.test.js`** — the poll, with injected `cfg`,
`ownAddrs`, `probe`, `now`, `composeExists`:
- probes only owned providers — a peer's provider (`grackle-embed` seen from crow's address
  set) is never probed and never recorded **(trap 1)**
- a provider that becomes locally orchestratable on a later tick stamps `firstOwnedAt` at
  that tick, not at boot **(trap 2)**
- **a provider that drops out of the local set (tailscale0 flap) is still probed and its
  outage clock is NOT reset** — the R1-CRITICAL regression test. (The v1 test plan asserted
  the opposite; it would have shipped the bug green.) This test must drive a **full
  `pollResidency` tick including the `pruneResidency` call**, since passing the *local* set
  as `declaredNames` is how the CRITICAL re-enters; a test that stops before prune would
  miss it.
- ownership is released and re-evaluated when `baseUrl` changes
- a provider with no `bundleId`, or whose compose file is absent, is never probed
  **(SSRF gate)**
- `isSafeBundleId` rejects `..`, `.`, `a/b`, `a\b`, `""`; `composeFile("..")` **throws**
  rather than resolving to the repo-root `docker-compose.yml` **(path-traversal gate)**
- `pollResidency` emits no "skipping" log line **(log-spam regression)**
- a probe that throws is recorded as not-ready, and the poll still records the others
- a `loadProviders()` throw leaves prior state intact

**Regression:** `tests/health-monitor-noauth-skip.test.js`, `tests/health-signals.test.js`,
`tests/health-monitor-dedupe.test.js`, `tests/gpu-orchestrator-host-gate.test.js`,
`tests/gpu-warm-resolve.test.js` all stay green. Full suite baseline: **1216 pass / 0 fail /
1 skip** via `node --test tests/*.test.js`.

## i18n

EN + ES for 11 keys:
`signals.providers.{label,notStarted,off,resident,warming,down,downMulti,downIssue,downIssueEmbed,downIssueMulti,action}`.

## Files

| File | Change |
|---|---|
| `servers/gateway/provider-health.js` | **new** — zero-import state module |
| `servers/gateway/gpu-orchestrator.js` | `isSafeBundleId` (pure, enforced in `composeFile`), `localAlwaysResident` (pure), `pollResidency`, `startResidencyMonitor`, early-arm in `initOrchestrator` |
| `servers/gateway/dashboard/panels/nest/health-signals.js` | `providersSignal` + register in `collectHealthSignals` |
| `servers/gateway/dashboard/shared/i18n.js` | 11 keys × EN/ES |
| `tests/provider-health.test.js` | **new** |
| `tests/providers-health-signal.test.js` | **new** |
| `tests/gpu-orchestrator-residency-poll.test.js` | **new** |

No new host ports → `check-ports` is path-filtered and reports 0-applicable. No DB schema
change → no `SCHEMA_GEN` bump.

## R1 review disposition

| Finding | Severity | Disposition |
|---|---|---|
| `pruneResidency` wipes the outage clock on a tailscale0 flap | CRITICAL | **Fixed** — sticky ownership; prune only on config removal. Reviewer's "freeze the clock" rejected (it hides a true unreachability); we keep probing instead. |
| Test plan enshrined the prune-wipe as correct | CRITICAL-adj | **Fixed** — test inverted. |
| Warn copy hardcodes "embeddings degraded" but crow owns a non-embed provider | MAJOR | **Fixed** — copy derived from `providerHasEmbedModel`. |
| `pollResidency` re-emits the skip log every 120 s | MAJOR | **Fixed** — pure `localAlwaysResident` helper; `alwaysResidentProviders` keeps the boot log. |
| Recurring probe of a synced, attacker-settable `baseUrl` (SSRF/beacon) | MAJOR | **Fixed** — require `bundleId` + compose file on disk; trust boundary documented. `apiKey` confirmed not sent. |
| Shipped-localhost-default would warn on every fresh install | MAJOR | **Documented** — cross-theme dependency on generalization/first-run. No shipped default is localhost today. |
| Co-resident gateways double-notify | MINOR | **Accepted** — already true for `disk`/`storage`/`backup`; consistent with convention. |
| 24h dedupe on stable id hides a 2nd provider | MINOR | **Accepted** — unreachable today (1 owned provider per host); documented. |
| Clock clears on a single lucky probe → flapping never warns | MINOR | **Accepted** — documented as a limitation; ratio window is a separate change. |
| Sync throw escapes the per-signal `.catch()` | NIT | **Fixed** — `providersSignal` is `async`. |
| `startResidencyMonitor` needs its own idempotency guard | NIT | **Fixed**. |
| Notification `action_url` ignores `actionHref`; tab should be `&tab=health` | NIT | **Fixed** (href) / **documented** (pre-existing `action_url` convention). |
| `t()` returns the raw key on a miss | NIT | **Fixed** — i18n test asserts output ≠ key. |

## Empirical verification (R2, against the live fleet — black-swan untouched)

Every load-bearing claim was checked on the running systems, not just read in source.

| Claim | Observed | Verdict |
|---|---|---|
| `bundles/<bundleId>/docker-compose.yml` exists on the owning host | `vllm-rocm-qwen35-4b` present on crow; `vllm-cuda-embed` present on grackle; both git-tracked, `bundles/` not gitignored. All prod gateways run from `/home/kh0pp/crow`, so `BUNDLES_DIR` resolves. | **Confirmed** — the gate does not disable the feature where it matters. |
| DB `baseUrl` == `models.json` `baseUrl` | Identical byte-for-byte for both providers, in all three DBs. `config/models.json` does not exist. | **Confirmed** — a DB↔models.json cache flip cannot churn sticky ownership. |
| crow owns only `crow-voice`; grackle owns only `grackle-embed` | Confirmed by evaluating `isLocallyOrchestratable` against each host's real `ip -o addr`. | **Confirmed** — trap 1 holds. |
| crow-mpa co-owns `crow-voice` | Yes — same machine, same `getOwnAddresses()`, cwd `/home/kh0pp/crow`. | **Confirmed** — the documented double-notify limitation is real, and consistent with `disk`/`storage`/`backup`. |
| Both providers reachable right now | `crow-voice :8011` → 200; `grackle-embed :9100` → 200. | **Confirmed** — the signal renders `ok` on deploy, not `warn`. |
| Restart counts are a poor signal | grackle's `vllm-cuda-embed`: `RestartCount 57604` **while `state=running (healthy)`** and answering 200. Docker doesn't reset the counter until the container is recreated. | **Confirmed** — strong empirical support for choosing outage *duration* over restart count. |
| `--no-auth` companion runs on grackle | Two gateway processes live; both call `initOrchestrator`, both will poll (read-only); only the auth one runs the health monitor. | **Confirmed** — trap 4 behavior is exactly as designed. |
| gateway log is unrotated | **False.** crow rotates weekly (`/etc/logrotate.d/crow-inference`, `rotate 4`, `compress`, `copytruncate`); grackle has no such file and logs to journald. | **Corrected in prose.** The pure-helper decision stands on "needless noise in the incident-diagnosis log", not unboundedness. |

## R2 review disposition

| Finding | Severity | Disposition |
|---|---|---|
| Path traversal: unvalidated `bundleId: ".."` resolves to the tracked repo-root `docker-compose.yml`, passing the new compose-exists gate | MINOR | **Fixed** — `isSafeBundleId`, enforced inside `composeFile()` so it also hardens the pre-existing `bundleUp`/`bundleStop` spawn paths. |
| `_initialized = true` before the wiring: a throw disarms detection for the process lifetime, un-retriably | NIT → **promoted** | **Fixed** — `setResidencyInitialized()` + `startResidencyMonitor()` moved ahead of anything that can throw; body wrapped in try/catch. |
| `pruneResidency(declaredNames)` must receive the FULL declared set, not the local set | test gap | **Fixed** — made explicit in the design; the flap regression test now drives a full tick including prune. |
| `composeExists` not injectable → poll tests couple to repo layout | test gap | **Fixed** — injectable, defaulting to `existsSync(composeFile(id))`. |
| "First poll fires immediately" is misleading (monitor started after a serial ≤240 s×N ensure loop) | NIT | **Resolved by the early-arm fix** — the first poll now genuinely runs at t≈0, concurrently with the ensure loop. Threshold margin re-derived. |
| Stale hardcoded tailnet-IP `baseUrl` → provider never owned → signal `off` forever | MINOR | **Documented as a blind spot.** Reviewer's `info`-signal fix **rejected**: the predicate cannot separate "my provider, changed address" from "a peer's provider", so it would fire on every peer's provider forever — design trap 1. Real fix is upstream (generalization theme: no shipped IP defaults). |
| Sticky ownership + recycled tailnet IP → probe a stranger's port forever | MINOR | **Documented.** Reachable only *after* the blind spot above has already broken orchestration; no credentials are sent. Same upstream fix. |
| Log-spam rationale factually wrong (file is rotated on crow; absent on grackle) | MINOR | **Prose corrected.** Decision unchanged. |
| `wifi flap` is a weaker trigger than a `tailscaled` restart (tailscale0 /32 survives a link blip) | NIT | **Prose acknowledged** — sticky ownership is correct either way; a link blip fails the *probe*, which is precisely the "keep probing, don't reset the clock" path. |
| `seedProvidersFromModelsJson` doesn't write `gpu_policy`; the boot reconciler backfills it | pre-existing | **Out of scope, noted.** Equally disables the existing `ensureResident`; both live DBs have `gpu_policy` populated today. |
