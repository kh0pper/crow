# Ramble steps — a daily walking goal that feeds the bird (design)

**Status:** decisions taken by Kevin 2026-10-04 (below); this document turns them into a buildable design. One phase, one PR, plus one Android app release.
**Builds on:** Ramble 0.13.0 (phase 4 wardrobe, PR #416), the reward economy spec `2026-09-08-ramble-reward-economy-design.md` (§3 "routine sustains you, exploration advances you", §6.1 ledgers not balances, §10/D13 which deferred steps), and the profile-picture pipeline in `servers/sharing/profile-avatar.js` (phase 4: real mood, outfit, coalesced broadcasts).
**Origin:** Kevin, 2026-09-09: "more walking = more self care = happier bird … a lifestyle app for family self care." Queued after phase 4.

---

## 0. Why the 2026-09-08 deferral no longer holds

Spec §10 deferred steps because "the `android/` app is a thin WebView shell with no activity-recognition permission and no health code, so steps would mean a new permission, a hardware sensor or Health Connect, a foreground service, and a native-to-WebView bridge." Checked against the real app (`android/`, package `press.maestro.crow`, 1.5.2):

- The native↔WebView bridge **already ships**: `MainActivity.CrowBridge`, exposed as `window.Crow` (`appVersion`, `launchGlassesPairing`, `setPullToRefresh` — the last one is already used by Ramble's map).
- The app's user agent already carries `CrowAndroid/<version>`; panels already gate native features on `window.Crow` (meta-glasses, Ramble).
- A foreground service is **not needed**. `Sensor.TYPE_STEP_COUNTER` is a hardware counter that accumulates since boot whether or not the app runs. Reading it when the panel opens and diffing against the last reading gives daily steps with no background work.

What is genuinely missing: the `ACTIVITY_RECOGNITION` runtime permission (API 29+; the app is minSdk 34) and a sensor read. Two caveats shape the design: the counter **resets on reboot**, and **not every phone has the sensor**.

The deferral's other argument — that new places measure exploration and cannot be farmed by pacing indoors — still stands and is honoured: steps feed **energy and a small seed bonus only**, never warmth or hearts (§3). Exploration still advances you; walking now sustains you.

---

## 1. Decisions (Kevin, 2026-10-04 — locked)

| # | Decision | Chosen |
|---|---|---|
| S1 | Shape | A **daily step goal**, default **6,000**, adjustable. Progress tops up the bird's energy (and therefore mood) each day. Hitting the goal earns a **small seed bonus**. **Missing days never punish** — nothing is taken away, no streak to break. |
| S2 | Visibility | The owner sees their own progress on the pet page. Flock contacts see **only a "walked today" badge** on the bird — never a count. |
| S3 | Fallback | Players without the Android counter (phone browser, iPhone, a phone without the sensor, permission refused) get a **one-tap "I walked today"** daily check-in. It counts for **mood only** — no seed bonus without a real count. |
| S4 | Nudge | **One gentle nudge** from the bird in the early evening (~18:00 local) if well below goal, **at most one per day**, via Crow push. A setting turns it off; an option skips weekends. |

**Further rulings (Kevin, 2026-10-04, after plan review):** the daily goal's floor is **2,000 steps** (range 2,000–30,000, §4.3); and **open-to-count** — steps are read only when the Ramble panel is opened, with no background reader — is accepted for v1 (background sampling stays in §12).

## 2. Rulings made in this design (not Kevin decisions; each is reversible by a setting or a small change)

| # | Ruling | Why |
|---|---|---|
| R1 | Native code is a **dumb sensor reader**. All arithmetic (baselines, reboot guard, caps, day attribution, energy, bonus) is server-side in the bundle. | The server side is hermetically testable in CI; the APK is not built by CI and has no unit-test harness (no `android/app/src/test`). Keeping the APK thin also means a tuning change never needs a new APK. |
| R2 | Step counts are **ledger rows in `ramble_wallet`** (`kind='steps'`, key `<day>:<device>`, delta = steps credited so far that day). No new replicated table and no core sync change. | A per-device daily count only ever grows, so `applyRambleWallet`'s existing `MAX(delta)` merge is *exactly* right for it: commutative, idempotent, convergent in any order. A new table would need a new apply path in `instance-sync.js` for no gain. |
| R3 | The phone's counter baseline lives in a **local, non-replicated** table `ramble_step_devices` on the instance the phone talks to. | A baseline is one instance's view of one sensor; replicating it would let two instances both diff against it and double-credit. |
| R4 | Steps since the last reading are credited to **the day of the reading**. | The counter carries no timestamps. Steps walked after last night's reading but before midnight land on today. Generous, never punishing (S1), and bounded by the daily cap. Exact attribution would need background sampling — out of scope (§12). |
| R5 | Step energy does **not reset the decay clock** (`last_fed_at`). | Every other feed resets it. Step readings arrive often and in small amounts; if each reset the clock, a bird whose owner opens the app every few hours would never decay at all. Steps add energy; decay keeps its own cadence. |
| R6 | "Walked today" (the badge) = the manual check-in, **or** today's steps reached `min(goal, 2,000)`. | A badge only for meeting a 6,000 goal would show a 5,000-step day as "didn't walk", which reads as a judgement. 2,000 is a real walk. Tunable (`steps.badge.min`). With the 2,000 goal floor the `min` only matters when `steps.badge.min` is raised above the goal. |
| R7 | The seed bonus is a `kind='seed'` row keyed `steps:<day>`. | It then counts in `seedBalance` and in `buyItem`'s affordability check with **no change** to either query (`wardrobe.js` hard-codes `kind IN ('seed', ?)`). The key cannot collide with a pickup key (`<cell>:<window>`, window an integer) — a test pins that `harvestableCells` ignores it. |
| R8 | The nudge is sent only by an instance that is the player's **"steps home"** — one where the player opened the pet page, sent a reading, or checked in within the last 3 days (refreshed whenever the Ramble panel loads walking state on that instance — opening Ramble, returning to it, the pet page, a reading, or a check-in — not only the pet page; build ruling 2026-10-04) (a `local.`-prefixed setting, which instance sync never replicates). A replicated `kind='nudge'` row per day is written **before** sending, so a second home instance that has synced it stays quiet. | Ramble may be installed on more than one of the user's instances; each runs the same timer. The home rule keeps an idle instance from nudging; the day row dedupes the rest. A same-minute race between two active homes can still send two — accepted, bounded at one extra per day. |
| R9 | The nudge only reaches players who **have used walking** (a steps or check-in row in the last 7 days) and is **on by default** for them. | A player who never touched the feature should never get pushed about it. |
| R10 | The Ramble panel stays **English-only** (it has no i18n today — every string in `panel/ramble.js` and `static/ramble.js` is literal English). The **push text is en/es** (read from the dashboard `language` setting) and the **guide is en/es**. | Translating one card of an untranslated panel would be inconsistent; panel localization is a whole-panel job. The push reaches the lock screen outside the panel, so it follows the dashboard language. |
| R11 | Steps replicate to the user's **own** instances (like `ramble_cells`, which is far more sensitive) and **never** to a contact. Contacts receive a boolean, and only as artwork in the profile picture. | Kevin's privacy rule is "counts never leave the owner's instance"; the owner's instances are one user's fleet, which already shares their location history. A test asserts that the portrait inputs carry a boolean and nothing else from steps. |
| R12 | No new MCP tool. | Nothing an assistant needs to do with a step count; the panel and the API cover it. |

---

## 3. How steps fit the economy

The reward economy's four quantities are unchanged. Steps touch only two:

| Quantity | Steps' effect |
|---|---|
| **Energy** | Up to `steps.energy.full` (**30**) per day, linear in progress toward the goal, paid in chunks of `steps.energy.chunk` (**5**) as progress is made. The manual check-in pays `steps.checkin.energy` (**15**). The two never stack: the day's step-energy target is `max(stepTarget, checkedIn ? 15 : 0)`. |
| **Bird seed** | `steps.goal.seed` (**3**) once per day when the counted steps reach the goal. Never for a manual check-in (S3). For scale: seed pickups pay 1 per harvested cell. |
| Warmth | None. Warmth is exploration (spec §3). |
| Heart containers | None. Steps never raise maximum energy; step energy is clamped by the existing heart-derived ceiling (`clampEnergy` with `maxEnergy(db)`), so hearts and steps cannot double-count. |

**Against decay.** Passive decay is −10 per 6 h, about −40/day. A day at goal returns +30, so walking alone keeps a bird near where it was; walking plus any chore or new place lifts it. This is the "routine sustains you" half of §3, made real: a housebound day now has a lever.

**Laying floor.** `feed()` already records a "happy day" for the laying counter (phase 3, `recordHappyDay`). Step energy goes through `feed()`, so a walking day can count toward laying — as the queued-arc memo anticipated. `lay.days` (14) is a live setting; re-check its feel after this ships (§11).

---

## 4. Data model

### 4.1 Replicated ledger rows (`ramble_wallet`, all via the existing `applyRambleWallet` MAX/MIN/MAX merge)

| kind | key | delta | Written by |
|---|---|---|---|
| `steps` | `<YYYY-MM-DD>:<device_id>` | steps credited for that device that day (grows) | a reading |
| `stepenergy` | `<YYYY-MM-DD>` | cumulative energy paid from walking that day (grows) | `settleDay` |
| `walkcheck` | `<YYYY-MM-DD>` | 1 | the manual check-in |
| `walked` | `<YYYY-MM-DD>` | 1 | `settleDay`, when R6 is first satisfied |
| `seed` | `steps:<YYYY-MM-DD>` | `steps.goal.seed` | `settleDay`, when the goal is first met |
| `nudge` | `<YYYY-MM-DD>` | 1 | the nudge scheduler, before sending |

The day is `localDay(now)` from `eggs.js` (the server process's timezone — the same day boundary chores, check-ins and laying already use). `now` is always the **server's** clock; the phone's wall clock is never trusted.

Every one of these is either a constant or monotone non-decreasing per key, which is exactly the class `MAX(delta)` converges for (the warning in `applyRambleWallet` is about *spends*, which these are not).

**Local write rule for `steps`.** Locally a reading **adds** its credit to the row (`delta = delta + credit`); the emitted row carries the full new total, and a peer takes the `MAX`. If the phone switches from instance A to instance B mid-day, B has no baseline for it (R3), takes a baseline on its first reading, and from then on adds on top of the total it already received from A — still monotone, still convergent.

### 4.2 Local tables and settings (never replicated)

```sql
CREATE TABLE IF NOT EXISTS ramble_step_devices (
  device_id    TEXT PRIMARY KEY,
  boot_count   INTEGER,          -- Settings.Global.BOOT_COUNT at the last reading, NULL if unknown
  last_counter INTEGER NOT NULL, -- TYPE_STEP_COUNTER value at the last reading
  last_read_at INTEGER NOT NULL, -- server ms of the last reading
  created_at   INTEGER NOT NULL,
  last_total   INTEGER NOT NULL DEFAULT 0, -- this device's day row right after THIS instance last touched it
  last_day     TEXT                         -- the day that last_total belongs to
);
```

Absent from `SYNCED_TABLES` (an allowlist), so it is local by construction. Additive `CREATE TABLE IF NOT EXISTS` in `init-tables.js`; **no `SCHEMA_GENERATION` bump**.

`local.steps.seen_at` in `ramble_settings` — the R8 "steps home" marker. `local.`-prefixed keys are dropped by `shouldSyncRow` in both directions (ruling R3 of the map phase).

### 4.3 Settings (replicated `ramble_settings`, LWW with the existing `lamport_origin` tie-break)

User-facing: `steps.goal` (default 6000, range 2,000–30,000), `steps.nudge` (`1`/`0`, default on), `steps.nudge.weekends` (`1`/`0`, default on — "nudge me on weekends too").

Tunables (live, defaults in code, following the `nest.rate`/`seed.rate` pattern):

| Key | Default | Governs |
|---|---|---|
| `steps.max.day` | 40000 | Most steps credited per day across all devices |
| `steps.max.per.min` | 250 | Plausibility: most steps credited per minute elapsed since the last reading (or since boot) |
| `steps.devices.per.day` | 4 | Most distinct devices credited per day |
| `steps.energy.full` | 30 | Energy for a day at goal |
| `steps.energy.chunk` | 5 | Smallest step-energy payment (R5's companion: fewer, larger feeds) |
| `steps.checkin.energy` | 15 | Energy for the manual check-in |
| `steps.goal.seed` | 3 | Seed bonus for reaching the goal |
| `steps.badge.min` | 2000 | R6 threshold |
| `steps.nudge.hour` | 18 | Earliest local hour for the nudge |
| `steps.nudge.until` | 21 | Latest local hour (exclusive) — a gateway that boots at 23:00 does not nudge |
| `steps.nudge.below` | 50 | Nudge only if today's steps are below this percent of the goal |

Junk, negative or out-of-range values fall back to the default, as every other Ramble setting does.

---

## 5. Crediting a reading

Input (from the phone, via the panel): `device_id` (8–64 chars `[A-Za-z0-9-]`, a random UUID the app generates once), `counter` (integer 0…10⁸), `elapsed_ms` (`SystemClock.elapsedRealtime()`, integer ≥ 0), `boot_count` (integer ≥ 0 or null). Everything else is ignored. Malformed input is a 400.

Let `bootAt = now − elapsed_ms` (server clock) and `current` = this device's `steps` row for today (0 if absent). Then:

1. **No baseline for this device.**
   - If `bootAt ≥ startOfLocalDay(now)` (the phone booted today), every step on the counter was walked today: raw credit = `counter − current` (another instance may already have counted part of it), over `elapsed_ms`.
   - Otherwise the split between earlier days and today is unknowable: take the baseline, credit **0** ("counting from now" in the panel).
2. **Foreign credit** — `current` is larger than what this instance left in the row (`last_total` if `last_day` is today, else 0). Another of the user's instances counted this phone in between (the phone switched gateways and came back, which the app's "Server settings" shortcut from #405 makes easy). Diffing against this instance's stale baseline would count that range twice, so: take a new baseline, credit **0**. Steps in the gaps between instances are lost — under-count, never double-count.
3. **Reboot** — any of: `boot_count` changed (both known); `counter < last_counter`; `bootAt > last_read_at + 2 min`. The counter now holds only steps since the reboot: raw credit = `counter`, over `elapsed_ms`. Steps between the last reading and the shutdown are lost — documented, unavoidable without background sampling.
4. **Otherwise** raw credit = `counter − last_counter`, over `now − last_read_at`.

Then the caps, in order:

- **Plausibility:** `min(raw, ceil(steps.max.per.min × max(1, minutes)))`. Clamped, not rejected.
- **Device limit:** a device with no `steps` row today is credited 0 once `steps.devices.per.day` devices already have one.
- **Daily cap:** `min(credit, steps.max.day − today's total)`.

**The baseline always advances to the new counter**, even when credit was clamped — excess is discarded, never banked for later. After every reading `last_total`/`last_day` record the row's value.

**Concurrency.** The baseline update is a compare-and-swap (`UPDATE … WHERE device_id = ? AND last_counter = ? AND last_read_at = ?`; for a first reading, `INSERT … ON CONFLICT DO NOTHING`). A reading that loses the race credits nothing. Two readings racing (the panel opening while the page regains visibility) therefore never double-credit.

Today's displayed total is `min(SUM(delta of today's steps rows), steps.max.day)` — after a merge, two instances that each capped locally can exceed the cap in sum; the display and every rule below use the capped value.

## 6. Settling the day

`settleDay(db, {now, emit})` runs after every credited reading, after a check-in, and after a goal change (lowering the goal can complete it):

1. `steps` = today's capped total; `checkedIn` = a `walkcheck` row exists today.
2. **Energy:** `stepTarget = floor(energy.full × min(1, steps / goal))`; `target = max(stepTarget, checkedIn ? checkin.energy : 0)`; `paid` = today's `stepenergy` delta (0 if absent). If `target − paid` is at least `energy.chunk`, or `target` equals `energy.full`, or the check-in alone set the target: CAS the `stepenergy` row from `paid` to `target` (a lost race pays nothing), then `feed(db, {type: "steps", amount: target − paid})`. The ledger is written **before** the feed: a crash between the two under-pays, never over-pays.
3. **Seed bonus:** if `steps ≥ goal` (counted steps only — a check-in never pays seed, S3), `INSERT OR IGNORE` the `seed` row `steps:<day>`.
4. **Badge:** if `checkedIn` or `steps ≥ min(goal, badge.min)`, `INSERT OR IGNORE` the `walked` row; if it is new, the route pokes `ramble:walked-changed` on the bus.

Every new or changed row is emitted (`ramble_wallet`, op `update`).

**Energy and the pet row.** `pet.js`'s `feed()` gains one event type, `steps`, whose delta is `event.amount` (an integer clamped to 0…100) rather than a constant, and which **does not touch `last_fed_at`** (R5) or the weekly counters: step energy never bumps the weekly counters or moves `last_fed_at`, though `feed()`'s normal weekly rollover still applies, as for every feed (build ruling 2026-10-04). Everything else — the heart-derived ceiling, the asymmetric clamp, the emit, `recordHappyDay` — is the existing path.

**Two instances.** If both credit different devices on the same day while out of contact, each pays its own `stepenergy` increment against its own pet row; the pet row is last-writer-wins, so one of the two increments is lost on merge (the existing behaviour for any two concurrent feeds) and `stepenergy` merges to the larger. Under-pay, bounded, never over-pay.

(final review 2026-10-04) One narrow exception: if a peer applies the pet row before the matching `stepenergy` row and a reading is settled in that window, a day's step energy can be paid twice. This is bounded by `steps.energy.full` (30) per day, and rare because the ledger row is emitted before the pet row. Accepted.

## 7. The manual check-in (S3)

`POST /api/ramble/steps/walked` → `INSERT OR IGNORE` a `walkcheck` row for today (emit), then `settleDay`. Idempotent per day. It sets the badge (R6) and pays `steps.checkin.energy` as a floor that counted steps can rise above but never add to. It never pays seed.

The panel offers the button where this device cannot count: no `window.Crow` (browser, iPhone), an app older than 1.6.0, a phone without the sensor, or permission refused — and also while step counting is not yet granted, alongside "Count my steps" (build ruling 2026-10-04). The server accepts it from anywhere — it cannot be used to farm anything a counted day does not already pay.

## 8. The "walked today" badge (S2)

- **Engine:** `bird-svg.cjs` gains `drawWalkBadge()` and `mountWalkBadge(el)` (the markup sink stays in the engine, like `mountBird`) — a small footprint roundel in the lower-right corner of the 200×200 portrait. `drawBird` is untouched (its golden hash stays byte-identical).
- **Pet page:** `GET /api/ramble/pet` gains `walked_today` (boolean); the panel appends the badge to the pet portrait.
- **Contacts:** `profile-avatar.js`'s `readPortrait` gains `walked` — `true` when a `walked` row exists for today (one indexed lookup; core keeps its own `localDay` copy, pinned to `eggs.js`'s by a parity test, as it already does for decay). `renderBirdAvatar` appends `engine.drawWalkBadge()` when `walked` and the engine has it (an older installed engine draws no badge rather than failing). When `walked` is true and the loaded engine lacks `drawWalkBadge`, the refresh skips with "engine-too-old" — no repaint, mirroring the outfit guard — rather than drawing a badge-less picture, so an old-engine instance cannot overwrite a badged picture (build ruling 2026-10-04). The deploy-day engine re-probe (which today only re-loads an engine lacking `applyOutfit`) also re-probes one lacking `drawWalkBadge`, so a single-restart deploy picks the badge up within a minute. `walked` joins the gate's input list, so a change repaints once.
- **Pacing (spec §5.4):** the route pokes `ramble:walked-changed`; `installBirdAvatarHooks` listens to it like `ramble:outfit-changed`, so the badge rides the existing 20 s settle and one broadcast. The badge clears at local midnight through the existing 30-minute tick — it can linger up to 30 minutes into the next day, which is accepted.
- **Not on public marks.** Marks carry the plain rolled bird (D10); the badge is portrait-only.

Privacy note: a badge that appears at 14:20 tells a contact roughly when you walked. The 20 s settle does not hide that. Accepted as the cost of S2; noted in the guide.

## 9. The evening nudge (S4)

**Where it runs.** A core boot module, `servers/gateway/boot/ramble-nudge.js`, started in `feature-mounts.js` when the Ramble bundle is **installed** on the instance (`installedRambleServerDir`) — independent of the Nostr transport. It ticks every 10 minutes, loads the bundle's `server/steps.js` by path (so core never hard-depends on the bundle), and sends through `createNotification` (`servers/shared/notifications.js`), which already fans out to web push and the instance's ntfy topic (#412) and honours the user's notification type preferences.

**Decision** (`nudgeDecision`, in the bundle; pure apart from reads), all must hold:

1. `steps.nudge` is on.
2. Not a weekend, unless `steps.nudge.weekends` is on.
3. The local hour is in `[steps.nudge.hour, steps.nudge.until)`.
4. This instance is the steps home (R8).
5. No `nudge` row today.
6. The player has used walking in the last 7 days (R9).
7. No manual check-in today, and today's steps are below `steps.nudge.below` % of the goal.

Engagement (6) is judged by the rows' **day keys**, not `created_at` (the wallet merge keeps the earliest `created_at` of two instances, so it is not a clock).

**Stale counts.** Steps only arrive when the panel is opened, so at 18:00 the server may simply not have seen a lunchtime walk. When this instance has a step-counter device whose last reading is more than 3 hours old, the nudge uses the **"show me"** wording (below) instead of implying the player has not walked.

Then `markNudged` (`INSERT OR IGNORE` the `nudge` row, emit) and, **only if that insert was new**, send. At-most-once per day per instance by construction.

**The push.** Type `reminder`, source `ramble:steps`, priority `normal`, action URL `/dashboard/ramble`, expires in 6 hours. Text in the bird's voice, in the dashboard language (R10):

| | Variant | Title | Body |
|---|---|---|---|
| en | low | Your bird is by the door | A short walk would cheer you both up. |
| en | unseen | Your bird wants to hear about your day | Open Ramble so it can count today's steps, or take a short walk together. |
| es | low | Tu pájaro te espera en la puerta | Una caminata corta los alegraría a los dos. |
| es | unseen | Tu pájaro quiere saber de tu día | Abre Ramble para que cuente los pasos de hoy, o den juntos una caminata corta. |

No step counts and no goal in the push (lock screens are public).

**Settings.** On the pet page, in a "Goal and reminders" fold of the walking card: the goal (− / + in steps of 500), "An evening nudge if I haven't walked", and "…on weekends too".

## 10. Android bridge (APK 1.6.0, versionCode 20)

**Manifest:** `<uses-permission android:name="android.permission.ACTIVITY_RECOGNITION" />` and `<uses-feature android:name="android.hardware.sensor.stepcounter" android:required="false" />` (the app must still install on phones without the sensor).

**Steps capabilities** (the four operations below; how they are reached is origin-scoped — see **Exposure**, security fix 2026-10-04):

| Method | Returns | Behaviour |
|---|---|---|
| `stepsStatus()` | `"ok"` · `"needs-permission"` · `"denied"` · `"no-sensor"` (sync) | `no-sensor` when `getDefaultSensor(TYPE_STEP_COUNTER)` is null; `denied` only after a refusal that left Android willing to ask again (rationale shown, remembered in `SharedPreferences`) followed by Android no longer offering the rationale ("don't ask again"). A first dialog dismissed by tapping outside also reads as not-granted-without-rationale and must stay `needs-permission`. |
| `requestStepsPermission(id)` | delivers `{status}` | Launches the `ACTIVITY_RECOGNITION` prompt through an `ActivityResultLauncher` registered as a field (so it exists before the activity starts). |
| `readSteps(id)` | delivers `{ok:true, counter, elapsed_ms, boot_count, device_id}` or `{ok:false, reason}` | Registers a one-shot `SensorEventListener`; on-change sensors report their current value on activation, so the first event is the reading. Unregisters on the first event or after a 4 s timeout (`reason:"timeout"`). `reason` is also `no-sensor` / `no-permission`. `boot_count` = `Settings.Global.BOOT_COUNT` (−1 → `null`). `device_id` = a random UUID created once and kept in the app's `SharedPreferences`; never `ANDROID_ID`. |
| `openAppSettings()` | — | Opens this app's system settings page, for the `denied` case. |

**Delivery.** On the port channel every result (including `stepsStatus`) comes back as `{"id", "payload"}` JSON through the frame's own `JavaScriptReplyProxy.postMessage`, and the panel hands it to `window.CrowSteps.deliver(id, payload)`. On the legacy fallback, asynchronous results are delivered on the UI thread by `webView.evaluateJavascript("window.CrowSteps && window.CrowSteps.deliver(<id>, <json>)")`, re-checked against the paired origin at delivery time. `id` must match `^[A-Za-z0-9]{1,32}$` or the call is ignored — it is never interpolated unchecked. The JSON is built with `org.json.JSONObject`.

**Detection in the panel.** `window.CrowStepsPort` present → ask its (async, cached) `stepsStatus`; otherwise `window.Crow` absent → browser (`web`); `stepsStatus()` returning `"unavailable"` → `unpaired` (the app is new but this page is not its paired server, or the legacy gate refused: manual check-in, "counted only on the Crow server this app is paired with"); no `stepsStatus`/`readSteps` → older app (`old-app`, "update the app to count steps"); otherwise use the status.

**Timeouts.** The panel waits up to 5 minutes for a permission answer (a human is deciding) and 8 s for a reading (native gives up at 4 s and reports `timeout`, shown as one quiet status line). A permission answer that arrives late is still caught: the prompt pauses the WebView, and the `visibilitychange` on return repaints the card.

**When the panel reads.** On load, when the page becomes visible again, and when switching to the pet view — at most once a minute, one request in flight. A reading posts to the server, which returns the day's state; the panel then refreshes the pet.

**Exposure (security fix 2026-10-04).** `addJavascriptInterface` exposes `window.Crow` to every page and every frame, and `CrowWebViewClient` keeps the same host on ANY port and other same-tailnet hosts in-app — Nextcloud (:8456, user content), ONLYOFFICE (:8457), Home Assistant, another Crow instance, and any cross-origin iframe. So the steps capabilities are NOT on `window.Crow`. They are scoped to the **paired gateway origin**: the exact scheme + host + port of the saved `gateway_url` (the app has a single gateway URL; there is no LAN/tailnet alternate). `OriginCheck` (pure Java, JVM-tested) normalises scheme/host to lowercase and fills the default port (443/80) before an exact compare.

- **Preferred channel:** `WebViewCompat.addWebMessageListener(webView, "CrowStepsPort", {paired origin}, listener)` when `WebViewFeature.WEB_MESSAGE_LISTENER` is supported (any current WebView; minSdk is 34). WebView injects `window.CrowStepsPort` only into frames on that origin; the listener additionally requires `isMainFrame` AND `sourceOrigin` equal to the paired origin (re-read from preferences on every message), and refuses silently otherwise — no reply, no prompt, no read, no settings intent. Requests are `postMessage(JSON.stringify({op, id}))`; replies go back through the `JavaScriptReplyProxy`, never `evaluateJavascript`. In this mode `window.Crow.stepsStatus()` is a constant `"unavailable"` everywhere, which only tells a panel "new app, not here".
- **Server changes:** the listener is re-registered on every `onResume` when the saved gateway origin changed (the "Server settings" shortcut), so the new origin is trusted and the old one is not.
- **Fallback** (WebView without the feature): the four methods stay on `window.Crow` but each checks the top-level `webView.getUrl()` origin on the UI thread before acting; `stepsStatus()` returns `"unavailable"` when it does not match. This cannot tell an iframe from the main frame (a `@JavascriptInterface` call carries no origin) — accepted only because the feature is expected everywhere at minSdk 34.

The older `window.Crow` methods (`appVersion`, `launchGlassesPairing`, `setPullToRefresh`) keep the any-page exposure; migrating the whole bridge is a follow-up (ANDROID-BRIDGE-ORIGIN).

## 11. Testing

The project rule stands: anything that replicates gets an executable **multi-instance** test; prose review is not enough.

**Hermetic server tests** (`@libsql` in-memory, as the existing ramble module tests do):
- Reading: first reading booted before today = baseline/0; booted today = full counter; plain delta; reboot by `boot_count`; reboot by counter going down; reboot by `bootAt` after the last reading; plausibility clamp; daily cap; device-per-day limit; baseline advances past clamped excess; a lost CAS credits nothing; junk input throws the input error; day attribution across midnight (R4).
- Settle: energy linear in progress and paid in chunks; full at goal; check-in floor never stacks with steps; `last_fed_at` unchanged by step energy (R5); energy clamped by the heart ceiling; seed bonus once a day, never for a check-in only; lowering the goal completes it; badge at `min(goal, badge.min)` and on check-in; `harvestableCells` ignores `steps:<day>` seed rows; `seedBalance` and `buyItem` count the bonus.
- Multi-instance (two in-memory dbs, emits captured and applied through the real `applyRambleWallet`): totals converge in any order; the same device's row merges by MAX; a phone moving between instances mid-day stays monotone; a phone going A → B → A is never counted twice; two instances' energy ledgers merge to the larger; the displayed total respects the cap after a merge; seed/walked/nudge rows dedupe.
- Nudge: each of the seven conditions independently blocks; `markNudged` is at-most-once; the core boot module sends exactly once across repeated ticks, honours a `nudge` row arriving by sync, and never throws out of its timer.

**Route tests** (the bundle's own `createDbClient`, never a second SQLite engine on the same file): `GET /api/ramble/steps`, `POST /api/ramble/steps/reading`, `POST /api/ramble/steps/walked`, `PUT /api/ramble/steps/settings` — happy paths, 400s for junk, emits, the `ramble:walked-changed` poke, `walked_today` on `GET /api/ramble/pet`.

**Core avatar tests:** the badge appears in the portrait when `walked`, the gate repaints once on a change, an engine without `drawWalkBadge` draws no badge without failing, and the portrait inputs carry only a boolean from steps.

**Panel tests** (the existing `extractFunction` pattern): `walkCardState` for all six modes, `stepsLabel`, the markup ids, no backtick or `${` added to the HTML template literal, no backtick in `static/ramble.js`.

**Android:** there is no unit-test harness in the app and CI does not build the APK. `./gradlew assembleDebug --offline` must compile on crow; behaviour is proven by the documented on-device test (Kevin, §12 acceptance).

**Live acceptance (last) — [KEVIN] on his Pixel**, APK 1.6.0, against crow: the permission prompt; a first reading; walk ~200 steps and see the count rise by about that; energy rise; lower the goal to just below today's count (needs 2,000+ steps that day — the goal floor) and see the bonus once; the badge on his portrait as a contact sees it; a nudge on a test evening (by moving `steps.nudge.hour` to the current hour), and none after a check-in; "weekends off" holding on a weekend.

## 12. Not in this design

- **Background sampling** (a periodic WorkManager read, or piggy-backing on `NtfyListenerService`) for exact day attribution and no reboot loss. The obvious follow-up if R4's approximation bothers anyone.
- **Health Connect** (watches, other step sources, iPhone has no equivalent path through a WebView).
- Streaks, weekly goals, leaderboards, sharing counts with anyone.
- Localizing the rest of the Ramble panel (R10).
- Retuning the laying floor — a live-setting change after this ships, not part of it.
