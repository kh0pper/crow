# Ramble Steps — Daily Walking Goal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A daily step goal (default 6,000) whose progress tops up the bird's energy, pays a small seed bonus at the goal, shows contacts only a "walked today" badge, falls back to a one-tap "I walked today" check-in where steps cannot be counted, and sends at most one gentle evening nudge — fed by the Android app's hardware step counter through the existing `window.Crow` bridge.

**Architecture:** The Android app (1.6.0) is a dumb sensor reader: it hands the panel `{counter, elapsed_ms, boot_count, device_id}`. Everything else lives in a new bundle module `bundles/ramble/server/steps.js`: a local per-device baseline table with a compare-and-swap reboot-guarded diff, step counts and daily facts as `ramble_wallet` ledger rows (monotone, so the existing `MAX(delta)` sync merge converges them with no core sync change), and a `settleDay` step that pays energy through `pet.js`'s `feed()`, the seed bonus as a `kind='seed'` row, and a `walked` fact. Core's profile-picture pipeline reads that `walked` fact to draw a badge; a small core boot module ticks the nudge decision and sends through `createNotification`.

**Tech Stack:** Node 24 ESM, `@libsql/client` (unit tests), the bundle's own `createDbClient` (route tests), Express (bundle panel routes), `node:test`, ES5 dual Node/browser engine `bird-svg.cjs`, ES5 panel client (no template literals), Android Java (AGP 8.7, minSdk/targetSdk 34).

**Spec:** `docs/superpowers/specs/2026-10-04-ramble-steps-design.md` (decisions S1–S4, rulings R1–R12). Background: `docs/superpowers/specs/2026-09-08-ramble-reward-economy-design.md` §3, §6.1, §10/D13.

## Global Constraints

- Bundle code change ⇒ `bundles/ramble/manifest.json` **0.13.0 → 0.14.0** and `registry/add-ons.json` regenerated with `npm run build-registry` (CI runs `build-registry --check`). Without the bump the installed copy in `~/.crow/bundles/ramble/` never refreshes.
- **Balances are never stored as balances** (economy spec §6.1). Every new fact is a `ramble_wallet` row whose `delta` is a constant or monotone non-decreasing per key: `steps` `<day>:<device>`, `stepenergy` `<day>`, `walkcheck` `<day>`, `walked` `<day>`, `nudge` `<day>`, and the bonus as `seed` `steps:<day>`. **No core sync change**: `applyRambleWallet`'s MAX/MIN/MAX merge is already correct for them.
- `ramble_step_devices` is **local**: it must never be added to `SYNCED_TABLES` in `servers/sharing/instance-sync.js`. `local.steps.seen_at` is a `local.`-prefixed `ramble_settings` key, which `shouldSyncRow` already drops.
- **No `SCHEMA_GENERATION` bump.** Ramble tables are created only by `bundles/ramble/server/init-tables.js` (`CREATE TABLE IF NOT EXISTS`).
- **Server clock only.** Day = `localDay(now)` from `eggs.js` (server process timezone); the phone's wall clock is never read.
- **Privacy (R11):** step counts never appear in any contact-facing payload. Core's portrait gets a boolean `walked`, nothing else from steps. The push text carries no numbers.
- **R5:** step energy (`feed` type `steps`) never changes `last_fed_at` or the weekly counters. `FEED_DELTAS` is NOT changed (a test deep-equals it).
- **R10:** the Ramble panel stays English (it has no i18n); push text en/es; guide en/es.
- `bundles/ramble/panel/ramble.js` HTML lives **inside a JS template literal**: add no backtick and no `${` except the existing `${icon(...)}` / `${esc(...)}` interpolation forms. `bundles/ramble/panel/static/ramble.js` has **zero backticks** (house rule, file header) — string concatenation only, ES5 (`var`, `function`).
- `hidden` does nothing on an `<svg>` element. The walking card uses `hidden` only on `<div>`/`<button>` (and `#ramble [hidden] { display: none !important; }` already exists in `ramble.css`). The class names `rb-steps`/`rb-step` are ALREADY TAKEN by the "What your bird runs on" list — new ids/classes use the `rb-walk-` prefix.
- Copy register: plain, warm, slightly hushed ("Getting out is worth more than tapping."). No emoji anywhere (icons are inline SVG).
- **Tests never open a db file the router has open with a second SQLite engine** (the 2026-08-04 corruption root cause). Module tests use `@libsql/client` `file::memory:`; route tests use the bundle's own `createDbClient()` closed after each use (`tests/ramble-wardrobe-routes.test.js` pattern).
- Run single files with `npm test -- tests/<file>.test.js` (scratch env). **Never raw `node --test`** — it writes the live crow.db. Full suite: `npm test`.
- Commits: `git commit <paths> -m "..."` with explicit paths, never bare. `git commit <path>` refuses an untracked file, so a task that CREATES a file runs `git add <exactly the new files>` first. Never add the worktree's untracked `node_modules` symlink. No Claude attribution in commit messages. Verify each commit with `git show --stat HEAD`.
- Android: CI does not build the APK. `versionCode 19 → 20`, `versionName "1.5.2" → "1.6.0"`. The release APK is built on crow with the keystore env file and installed by Kevin (Task 11).
- Constants (spec §4.3 defaults): goal 6000 (1,000–30,000); `steps.max.day` 40000; `steps.max.per.min` 250; `steps.devices.per.day` 4; `steps.energy.full` 30; `steps.energy.chunk` 5; `steps.checkin.energy` 15; `steps.goal.seed` 3; `steps.badge.min` 2000; `steps.nudge.hour` 18; `steps.nudge.until` 21; `steps.nudge.below` 50 (percent).

## Review Focus

1. **The phone reboots mid-day, or reports no `boot_count`, or the counter goes backwards.** Expect: never a negative credit, never a re-credit of steps already counted, the baseline always ends at the new counter, and the steps since the reboot are counted. (Task 1 tests: reboot by boot_count, by counter-down, by boot time; "baseline advances past clamped excess".)
2. **The panel fires two readings at once** (load + visibility change, a double tap) **or a phone moves between two of the user's instances mid-day — and back.** Expect: no double credit on one instance (compare-and-swap), a first reading on the second instance does not re-add what the first already synced, a return to the first instance re-baselines instead of re-counting the second's range (foreign-credit guard), totals stay monotone and capped after merge, and the seed bonus pays once. (Task 1 concurrent test; Task 3 multi-instance tests.)
3. **A player who cannot count steps** — browser, iPhone, the 1.5.x app, a phone without the sensor, permission refused twice. Expect: the card explains why in one line, offers "I walked today", never throws, and never shows a "Count my steps" button that cannot work. (Task 7 `walkCardState` + `nativeStepsMode` tests.)
4. **Nudge edges:** the gateway restarts inside the evening window, weekends-off on a Saturday, a check-in after the nudge was sent, a second instance with Ramble installed, a player who never used walking, reminders turned off in notification preferences. Expect: at most one nudge per day, none when off/weekend/not-engaged/on-track/not-home, and the core timer never throws. (Task 6 tests; the type-preference gate is `createNotification`'s own and is exercised by sending type `reminder`.)
5. **Junk from the client or a hand-edited setting** — a fractional/negative/huge counter, a non-string device id, `elapsed_ms` as a string, `steps.goal = "abc"`, a goal of 999 via the API. Expect: 400 from the API, defaults from the settings reader, never a 500 or a NaN in the ledger. (Task 1 parse tests; Task 2 settings tests; Task 4 route 400s.)

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `bundles/ramble/server/steps.js` | Create | Settings, reading credit (baseline/reboot/caps/CAS), `settleDay`, check-in, state, settings writes, steps-home marker, nudge decision + text |
| `bundles/ramble/server/init-tables.js` | Modify | local `ramble_step_devices` table |
| `bundles/ramble/server/pet.js` | Modify | `feed()` accepts type `steps` with a bounded `amount`; no `last_fed_at`/counter change for it |
| `bundles/ramble/server/bird-svg.cjs` | Modify | `drawWalkBadge()` (exported); `drawBird` untouched |
| `bundles/ramble/panel/routes.js` | Modify | `stepsMod`; `GET /api/ramble/steps`, `POST /api/ramble/steps/reading`, `POST /api/ramble/steps/walked`, `PUT /api/ramble/steps/settings`; `walked_today` on `GET /api/ramble/pet`; poke `ramble:walked-changed` |
| `servers/sharing/profile-avatar.js` | Modify | `portraitDay`; `walked` in `readPortrait`; badge in `renderBirdAvatar`; `walked` in the gate inputs; listen to `ramble:walked-changed` |
| `servers/gateway/boot/ramble-nudge.js` | Create | `startRambleNudge` — 10-minute tick, loads the installed bundle's `steps.js` by path, sends via an injected `notify` |
| `servers/gateway/boot/feature-mounts.js` | Modify | start the nudge when Ramble is installed (independent of the Nostr transport) |
| `bundles/ramble/panel/ramble.js` | Modify | the walking card on the pet view; one line in "What your bird runs on" |
| `bundles/ramble/panel/static/ramble.js` | Modify | native bridge wrapper, `nativeStepsMode`, `walkCardState`, `stepsLabel`, `paintWalk`, `refreshWalk`, wiring; badge on the pet portrait |
| `bundles/ramble/panel/static/ramble.css` | Modify | walking card styles |
| `android/app/src/main/AndroidManifest.xml` | Modify | `ACTIVITY_RECOGNITION`, optional `sensor.stepcounter` feature |
| `android/app/src/main/java/press/maestro/crow/MainActivity.java` | Modify | `stepsStatus`, `requestStepsPermission`, `readSteps`, `openAppSettings` on `CrowBridge` |
| `android/app/build.gradle` | Modify | versionCode 20, versionName 1.6.0 |
| `docs/guide/ramble.md`, `docs/es/guide/ramble.md` | Modify | "Walking" / "Caminar" section |
| `docs/superpowers/specs/2026-09-08-ramble-reward-economy-design.md` | Modify | D13 + §10 point at the new spec |
| `bundles/ramble/manifest.json`, `registry/add-ons.json` | Modify | 0.14.0 |
| Tests | Create/Modify | `tests/ramble-steps.test.js`, `tests/ramble-steps-sync.test.js`, `tests/ramble-steps-routes.test.js`, `tests/ramble-steps-nudge.test.js`, `tests/profile-avatar-bird.test.js`, `tests/ramble-bird-svg.test.js`, `tests/ramble-panel.test.js` |

**Branch:** implementation continues in this worktree on a new branch, so spec + plan ride the implementation PR:

```bash
cd ~/crow-wt-ramble-steps && git fetch -q origin && git switch -c feat/ramble-steps
git rebase origin/main   # only if main moved; resolve nothing by hand without reading it
npm test 2>&1 | tail -6  # record the BASELINE pass count for the PR body
```

---

### Task 1: Crediting a reading — local baselines, the reboot guard, caps

**Files:**
- Create: `bundles/ramble/server/steps.js`
- Modify: `bundles/ramble/server/init-tables.js` (after the `ramble_wallet` CREATE)
- Test: `tests/ramble-steps.test.js` (create)

**Interfaces:**
- Consumes: `localDay(ms)`, `startOfLocalDay(ms)` from `eggs.js`.
- Produces (exported from `steps.js`): kind constants `STEPS_KIND="steps"`, `STEP_ENERGY_KIND="stepenergy"`, `WALKED_KIND="walked"`, `WALK_CHECKIN_KIND="walkcheck"`, `NUDGE_KIND="nudge"`, `STEP_SEED_PREFIX="steps:"`, `HOME_KEY="local.steps.seen_at"`; `STEPS_DEFAULTS` (frozen object: `goal, maxDay, maxPerMin, devicesPerDay, energyFull, energyChunk, checkinEnergy, goalSeed, badgeMin, nudge, nudgeWeekends, nudgeHour, nudgeUntil, nudgeBelow`); `GOAL_MIN=1000`, `GOAL_MAX=30000`; `class StepsInputError extends Error` (`name === "StepsInputError"`); `parseReading(obj) → {device_id, counter, elapsed_ms, boot_count|null}` (throws `StepsInputError`); `readStepSettings(db) → settings object shaped like STEPS_DEFAULTS`; `stepsToday(db, now, settings?) → number` (capped); `recordStepReading(db, reading, {now, emit}) → {credited, reason, clamped, day}` where `reason ∈ "baseline"|"booted-today"|"foreign"|"reboot"|"delta"|"raced"|"device-limit"`; internal helpers `safeEmit`, `rowDelta`, `insertOnce`, `casDelta` (used by Tasks 2 and 6).

- [ ] **Step 1: Write the failing tests** — create `tests/ramble-steps.test.js`:

```js
/**
 * Spec 2026-10-04 §5 — crediting a step-counter reading. The phone hands us a
 * hardware counter that accumulates since boot; the server keeps a LOCAL
 * baseline per device and credits the difference, guarding reboots, clamping
 * implausible jumps, capping the day, and never crediting twice.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import { startOfLocalDay, localDay } from "../bundles/ramble/server/eggs.js";
import {
  recordStepReading, stepsToday, parseReading, readStepSettings, StepsInputError,
  STEPS_KIND, STEPS_DEFAULTS,
} from "../bundles/ramble/server/steps.js";

// A fixed local day; AT(h, m) is that day at h:m local time.
const DAY0 = startOfLocalDay(Date.UTC(2026, 9, 5, 18));
const AT = (h, m = 0) => DAY0 + h * 3_600_000 + m * 60_000;
const H = 3_600_000;
const DEV = "11111111-2222-3333-4444-555555555555";
const DEV2 = "99999999-8888-7777-6666-555555555555";

async function freshDb() {
  const db = createClient({ url: "file::memory:" });
  await initRambleTables(db);
  return db;
}
const read = (db, r, now, extra = {}) =>
  recordStepReading(db, { device_id: DEV, boot_count: 7, ...r }, { now, ...extra });
const setSetting = (db, key, value) => db.execute({
  sql: "INSERT INTO ramble_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  args: [key, String(value)],
});
async function baseline(db, id = DEV) {
  const { rows } = await db.execute({ sql: "SELECT * FROM ramble_step_devices WHERE device_id = ?", args: [id] });
  return rows[0] ? { counter: Number(rows[0].last_counter), at: Number(rows[0].last_read_at), boot: rows[0].boot_count } : null;
}

test("ramble_step_devices exists and is LOCAL (never in instance sync)", async () => {
  const db = await freshDb();
  await db.execute("SELECT device_id, boot_count, last_counter, last_read_at, created_at, last_total, last_day FROM ramble_step_devices");
  const { SYNCED_TABLES } = await import("../servers/sharing/instance-sync.js");
  assert.ok(!SYNCED_TABLES.includes("ramble_step_devices"));
});

test("first reading from a phone booted BEFORE today takes a baseline and credits nothing", async () => {
  const db = await freshDb();
  const out = await read(db, { counter: 50_000, elapsed_ms: 20 * H }, AT(10));
  assert.deepEqual(out, { credited: 0, reason: "baseline", clamped: false, day: localDay(AT(10)) });
  assert.equal(await stepsToday(db, AT(10)), 0);
  assert.deepEqual(await baseline(db), { counter: 50_000, at: AT(10), boot: 7 });
});

test("first reading from a phone booted TODAY credits the whole counter", async () => {
  const db = await freshDb();
  const out = await read(db, { counter: 3_000, elapsed_ms: 2 * H }, AT(10));
  assert.equal(out.credited, 3_000);
  assert.equal(out.reason, "booted-today");
  assert.equal(await stepsToday(db, AT(10)), 3_000);
});

test("a plain delta credits the difference since the last reading", async () => {
  const db = await freshDb();
  await read(db, { counter: 50_000, elapsed_ms: 20 * H }, AT(10));
  const out = await read(db, { counter: 52_000, elapsed_ms: 21 * H }, AT(11));
  assert.equal(out.credited, 2_000);
  assert.equal(out.reason, "delta");
  assert.equal(await stepsToday(db, AT(11)), 2_000);
});

test("reboot detected by boot_count: the new counter is all new steps", async () => {
  const db = await freshDb();
  await read(db, { counter: 50_000, elapsed_ms: 20 * H }, AT(9));
  const out = await read(db, { counter: 1_500, elapsed_ms: 1 * H, boot_count: 8 }, AT(12));
  assert.equal(out.reason, "reboot");
  assert.equal(out.credited, 1_500);
  assert.equal((await baseline(db)).boot, 8);
});

test("reboot detected by the counter going DOWN when boot_count is unknown", async () => {
  const db = await freshDb();
  await read(db, { counter: 50_000, elapsed_ms: 20 * H, boot_count: null }, AT(9));
  const out = await read(db, { counter: 900, elapsed_ms: 1 * H, boot_count: null }, AT(12));
  assert.equal(out.reason, "reboot");
  assert.equal(out.credited, 900);
});

test("reboot detected by boot TIME: booted after the last reading even though the counter is higher", async () => {
  const db = await freshDb();
  await read(db, { counter: 100, elapsed_ms: 20 * H, boot_count: null }, AT(9));
  // Rebooted at 13:00 and walked 4,000 since: 4,000 > 100, but it is not a delta of 3,900.
  const out = await read(db, { counter: 4_000, elapsed_ms: 2 * H, boot_count: null }, AT(15));
  assert.equal(out.reason, "reboot");
  assert.equal(out.credited, 4_000);
});

test("plausibility: an impossible jump is clamped to steps.max.per.min x minutes, and the excess is DISCARDED", async () => {
  const db = await freshDb();
  await read(db, { counter: 0, elapsed_ms: 20 * H }, AT(10));
  const out = await read(db, { counter: 20_000, elapsed_ms: 20 * H + 10 * 60_000 }, AT(10, 10));
  assert.equal(out.credited, 250 * 10);
  assert.equal(out.clamped, true);
  assert.equal((await baseline(db)).counter, 20_000, "the baseline still advances");
  const next = await read(db, { counter: 20_100, elapsed_ms: 20 * H + 20 * 60_000 }, AT(10, 20));
  assert.equal(next.credited, 100, "nothing banked from the clamp");
});

test("the daily cap holds across devices", async () => {
  const db = await freshDb();
  await setSetting(db, "steps.max.day", 5_000);
  await read(db, { counter: 4_000, elapsed_ms: 3 * H }, AT(10));
  const out = await recordStepReading(db, { device_id: DEV2, counter: 4_000, elapsed_ms: 3 * H, boot_count: 1 }, { now: AT(10) });
  assert.equal(out.credited, 1_000);
  assert.equal(out.clamped, true);
  assert.equal(await stepsToday(db, AT(10)), 5_000);
});

test("device limit: a device beyond steps.devices.per.day is credited nothing", async () => {
  const db = await freshDb();
  await setSetting(db, "steps.devices.per.day", 1);
  await read(db, { counter: 1_000, elapsed_ms: 1 * H }, AT(10));
  const out = await recordStepReading(db, { device_id: DEV2, counter: 1_000, elapsed_ms: 1 * H, boot_count: 1 }, { now: AT(10) });
  assert.deepEqual([out.credited, out.reason], [0, "device-limit"]);
});

test("two readings racing never double-credit (compare-and-swap on the baseline)", async () => {
  const db = await freshDb();
  await read(db, { counter: 50_000, elapsed_ms: 20 * H }, AT(10));
  const [a, b] = await Promise.all([
    read(db, { counter: 51_000, elapsed_ms: 21 * H }, AT(11)),
    read(db, { counter: 51_000, elapsed_ms: 21 * H }, AT(11)),
  ]);
  assert.equal(a.credited + b.credited, 1_000);
  assert.equal(await stepsToday(db, AT(11)), 1_000);
});

test("R4: steps since last night's reading land on the day of the reading", async () => {
  const db = await freshDb();
  await read(db, { counter: 1_000, elapsed_ms: 30 * H }, AT(-3)); // 21:00 the previous day
  const out = await read(db, { counter: 4_000, elapsed_ms: 41 * H }, AT(8));
  assert.equal(out.credited, 3_000);
  assert.equal(await stepsToday(db, AT(8)), 3_000);
  assert.equal(await stepsToday(db, AT(-3)), 0);
});

test("the emitted row carries the full running total for that device and day", async () => {
  const db = await freshDb();
  const ops = [];
  const emit = async (table, op, row) => ops.push({ table, op, row });
  await read(db, { counter: 1_000, elapsed_ms: 1 * H }, AT(10), { emit });
  await read(db, { counter: 1_600, elapsed_ms: 1 * H + 30 * 60_000 }, AT(10, 30), { emit });
  const rows = ops.filter((o) => o.table === "ramble_wallet" && o.row.kind === STEPS_KIND);
  assert.deepEqual(rows.map((o) => [o.op, o.row.key, o.row.delta]), [
    ["update", `${localDay(AT(10))}:${DEV}`, 1_000],
    ["update", `${localDay(AT(10))}:${DEV}`, 1_600],
  ]);
});

test("parseReading rejects junk with StepsInputError", () => {
  const ok = { device_id: DEV, counter: 1, elapsed_ms: 1, boot_count: null };
  assert.deepEqual(parseReading(ok), ok);
  assert.deepEqual(parseReading({ device_id: DEV, counter: 1, elapsed_ms: 1 }), ok, "boot_count is optional");
  for (const bad of [
    null, {}, { ...ok, device_id: "short" }, { ...ok, device_id: 12345678 }, { ...ok, device_id: "x".repeat(65) },
    { ...ok, device_id: "has spaces in it" }, { ...ok, counter: -1 }, { ...ok, counter: 1.5 },
    { ...ok, counter: 100_000_001 }, { ...ok, counter: "5" }, { ...ok, elapsed_ms: "1" }, { ...ok, elapsed_ms: -1 },
    { ...ok, boot_count: -2 }, { ...ok, boot_count: 1.2 },
  ]) {
    assert.throws(() => parseReading(bad), (e) => e instanceof StepsInputError, JSON.stringify(bad));
  }
});

test("readStepSettings: defaults, valid overrides, junk falls back", async () => {
  const db = await freshDb();
  assert.deepEqual(await readStepSettings(db), { ...STEPS_DEFAULTS });
  await setSetting(db, "steps.goal", "8000");
  await setSetting(db, "steps.max.day", "abc");
  await setSetting(db, "steps.badge.min", "0");
  await setSetting(db, "steps.nudge", "0");
  await setSetting(db, "steps.nudge.weekends", "maybe");
  const s = await readStepSettings(db);
  assert.equal(s.goal, 8000);
  assert.equal(s.maxDay, STEPS_DEFAULTS.maxDay);
  assert.equal(s.badgeMin, STEPS_DEFAULTS.badgeMin, "0 is below the floor");
  assert.equal(s.nudge, false);
  assert.equal(s.nudgeWeekends, true);
  await setSetting(db, "steps.goal", "999");
  assert.equal((await readStepSettings(db)).goal, 6000, "below GOAL_MIN");
});
```

Check first that `SYNCED_TABLES` is exported from `servers/sharing/instance-sync.js` (`grep -n "export const SYNCED_TABLES\|export { SYNCED_TABLES\|SYNCED_TABLES" servers/sharing/instance-sync.js | head -3`). If it is not exported, replace that assertion with a source check: `assert.ok(!readFileSync("servers/sharing/instance-sync.js", "utf8").includes('"ramble_step_devices"'))` (import `readFileSync` from `node:fs`).

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- tests/ramble-steps.test.js`
Expected: FAIL — `Cannot find module '../bundles/ramble/server/steps.js'`.

- [ ] **Step 3: Add the local table** — in `bundles/ramble/server/init-tables.js`, directly after the `ramble_wallet` `initTable(...)` call:

```js
  // Steps (spec 2026-10-04 §4.2): the phone's hardware counter baseline, one
  // row per device. LOCAL by design and absent from instance-sync's
  // SYNCED_TABLES: a baseline is one instance's view of one sensor, and two
  // instances diffing against a shared one would double-credit. The steps
  // themselves replicate as ramble_wallet rows (kind 'steps').
  await initTable(db, "ramble_step_devices", `
    CREATE TABLE IF NOT EXISTS ramble_step_devices (
      device_id TEXT PRIMARY KEY,
      boot_count INTEGER,
      last_counter INTEGER NOT NULL,
      last_read_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      last_total INTEGER NOT NULL DEFAULT 0,
      last_day TEXT
    );`);
```

(`last_total`/`last_day` are in the CREATE because the table is new in this release — no guarded `ensureColumn` is needed.)

- [ ] **Step 4: Create `bundles/ramble/server/steps.js`**

```js
/**
 * Ramble steps (spec 2026-10-04-ramble-steps-design.md).
 *
 * The Android app reads the phone's hardware step counter (it accumulates
 * since boot) and hands us {device_id, counter, elapsed_ms, boot_count}. All
 * arithmetic is here (R1): a LOCAL per-device baseline (ramble_step_devices),
 * a reboot guard, plausibility and daily caps, and ledger rows in
 * ramble_wallet for everything that replicates.
 *
 * ⚠ EVERY ROW THIS MODULE WRITES TO ramble_wallet IS A CONSTANT OR GROWS.
 * applyRambleWallet merges a key conflict with MAX(delta), which converges
 * exactly for that class. Never write a shrinking or negative delta here.
 *
 * ⚠ PRIVACY (R11): step counts replicate to the user's OWN instances only.
 * Nothing here may feed a contact-facing payload except the boolean `walked`
 * fact, which core turns into artwork.
 */
import { localDay, startOfLocalDay } from "./eggs.js";

export const STEPS_KIND = "steps";               // key `<day>:<device>`, delta = steps credited that day (grows)
export const STEP_ENERGY_KIND = "stepenergy";    // key `<day>`, delta = energy paid from walking that day (grows)
export const WALKED_KIND = "walked";             // key `<day>`, delta 1 — the contacts badge
export const WALK_CHECKIN_KIND = "walkcheck";    // key `<day>`, delta 1 — "I walked today"
export const NUDGE_KIND = "nudge";               // key `<day>`, delta 1 — the evening nudge was sent
export const STEP_SEED_PREFIX = "steps:";        // kind 'seed', key `steps:<day>` — the goal bonus (R7)
export const HOME_KEY = "local.steps.seen_at";   // R8; `local.` keys never replicate

export const GOAL_MIN = 1000;
export const GOAL_MAX = 30000;
export const STEPS_DEFAULTS = Object.freeze({
  goal: 6000,
  maxDay: 40000,
  maxPerMin: 250,
  devicesPerDay: 4,
  energyFull: 30,
  energyChunk: 5,
  checkinEnergy: 15,
  goalSeed: 3,
  badgeMin: 2000,
  nudge: true,
  nudgeWeekends: true,
  nudgeHour: 18,
  nudgeUntil: 21,
  nudgeBelow: 50,
});

/** key -> [field, min, max] for the integer settings (spec §4.3). */
const INT_SETTINGS = {
  "steps.goal": ["goal", GOAL_MIN, GOAL_MAX],
  "steps.max.day": ["maxDay", 1000, 200000],
  "steps.max.per.min": ["maxPerMin", 60, 1000],
  "steps.devices.per.day": ["devicesPerDay", 1, 16],
  "steps.energy.full": ["energyFull", 0, 100],
  "steps.energy.chunk": ["energyChunk", 1, 100],
  "steps.checkin.energy": ["checkinEnergy", 0, 100],
  "steps.goal.seed": ["goalSeed", 0, 100],
  "steps.badge.min": ["badgeMin", 1, 200000],
  "steps.nudge.hour": ["nudgeHour", 0, 23],
  "steps.nudge.until": ["nudgeUntil", 1, 24],
  "steps.nudge.below": ["nudgeBelow", 0, 100],
};
const BOOL_SETTINGS = { "steps.nudge": "nudge", "steps.nudge.weekends": "nudgeWeekends" };

const DEVICE_RE = /^[A-Za-z0-9-]{8,64}$/;
const COUNTER_MAX = 100_000_000;
const ELAPSED_MAX = 10 * 365 * 24 * 3600 * 1000;
/** A boot estimated this long after the last reading is a reboot (network + clock slop). */
const BOOT_SLACK_MS = 2 * 60 * 1000;

export class StepsInputError extends Error {
  constructor(message) { super(message); this.name = "StepsInputError"; }
}

/** Validate a reading from the client. Only these four fields are ever read. */
export function parseReading(r) {
  if (!r || typeof r !== "object") throw new StepsInputError("a reading is required");
  if (typeof r.device_id !== "string" || !DEVICE_RE.test(r.device_id)) {
    throw new StepsInputError("device_id must be 8-64 letters, digits or dashes");
  }
  if (!Number.isInteger(r.counter) || r.counter < 0 || r.counter > COUNTER_MAX) {
    throw new StepsInputError("counter must be a whole number from 0 to 100000000");
  }
  if (!Number.isInteger(r.elapsed_ms) || r.elapsed_ms < 0 || r.elapsed_ms > ELAPSED_MAX) {
    throw new StepsInputError("elapsed_ms must be a whole number of milliseconds since boot");
  }
  let boot = null;
  if (r.boot_count !== undefined && r.boot_count !== null) {
    if (!Number.isInteger(r.boot_count) || r.boot_count < 0) throw new StepsInputError("boot_count must be a whole number or null");
    boot = r.boot_count;
  }
  return { device_id: r.device_id, counter: r.counter, elapsed_ms: r.elapsed_ms, boot_count: boot };
}

/** Live settings, each falling back to its default on junk or out-of-range values. */
export async function readStepSettings(db) {
  const out = { ...STEPS_DEFAULTS };
  try {
    const keys = [...Object.keys(INT_SETTINGS), ...Object.keys(BOOL_SETTINGS)];
    const { rows } = await db.execute({
      sql: `SELECT key, value FROM ramble_settings WHERE key IN (${keys.map(() => "?").join(", ")})`,
      args: keys,
    });
    for (const r of rows || []) {
      const key = String(r.key);
      if (Object.hasOwn(INT_SETTINGS, key)) {
        const [field, lo, hi] = INT_SETTINGS[key];
        const n = Number(r.value);
        if (Number.isInteger(n) && n >= lo && n <= hi) out[field] = n;
      } else if (Object.hasOwn(BOOL_SETTINGS, key)) {
        if (r.value === "1" || r.value === "0") out[BOOL_SETTINGS[key]] = r.value === "1";
      }
    }
  } catch { /* defaults */ }
  return out;
}

/** Mirrors eggs.js/wallet.js: an emit must never be able to fail the write. */
export async function safeEmit(emit, table, op, row) {
  if (typeof emit !== "function") return;
  try { await emit(table, op, row); }
  catch (err) { try { console.warn(`[ramble steps] emit ${table} failed:`, err?.message); } catch {} }
}

/** The delta stored under (kind, key), or null when there is no row. */
export async function rowDelta(db, kind, key) {
  const { rows } = await db.execute({ sql: "SELECT delta FROM ramble_wallet WHERE kind = ? AND key = ?", args: [kind, key] });
  return rows.length ? Number(rows[0].delta) : null;
}

/** Insert a fact once. True only for the call that created it (which also emits). */
export async function insertOnce(db, kind, key, delta, now, emit) {
  const res = await db.execute({
    sql: "INSERT INTO ramble_wallet (kind, key, delta, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(kind, key) DO NOTHING",
    args: [kind, key, delta, now],
  });
  if (Number(res.rowsAffected) !== 1) return false;
  await safeEmit(emit, "ramble_wallet", "update", { kind, key, delta, created_at: now });
  return true;
}

/**
 * Compare-and-swap a growing row from `from` (null = absent) to `to`. False
 * when somebody else (a concurrent request, or a sync apply) moved it first —
 * the caller then pays nothing, which can only ever under-pay.
 */
export async function casDelta(db, kind, key, from, to, now, emit) {
  const res = from === null
    ? await db.execute({
      sql: "INSERT INTO ramble_wallet (kind, key, delta, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(kind, key) DO NOTHING",
      args: [kind, key, to, now],
    })
    : await db.execute({
      sql: "UPDATE ramble_wallet SET delta = ? WHERE kind = ? AND key = ? AND delta = ?",
      args: [to, kind, key, from],
    });
  if (Number(res.rowsAffected) !== 1) return false;
  const { rows } = await db.execute({ sql: "SELECT created_at FROM ramble_wallet WHERE kind = ? AND key = ?", args: [kind, key] });
  await safeEmit(emit, "ramble_wallet", "update", { kind, key, delta: to, created_at: Number(rows[0]?.created_at ?? now) });
  return true;
}

async function rawStepsForDay(db, day) {
  const { rows } = await db.execute({
    sql: "SELECT COALESCE(SUM(delta), 0) AS n FROM ramble_wallet WHERE kind = ? AND key LIKE ?",
    args: [STEPS_KIND, day + ":%"],
  });
  return Number(rows[0]?.n) || 0;
}

/**
 * Today's steps across every device, CAPPED at steps.max.day. Two instances
 * that each capped locally can exceed the cap in sum after a merge; every
 * reader goes through this, so nothing downstream ever sees more than the cap.
 */
export async function stepsToday(db, now, settings) {
  const s = settings || await readStepSettings(db);
  return Math.min(await rawStepsForDay(db, localDay(now)), s.maxDay);
}

/**
 * Credit one reading (spec §5). The baseline is claimed with a compare-and-
 * swap BEFORE anything is credited, so of two racing readings exactly one
 * credits. The baseline always advances to the new counter — clamped excess
 * is discarded, never banked.
 *
 * ⚠ FOREIGN CREDIT GUARD. `last_total`/`last_day` remember what this
 * device's row for the day held right after THIS instance last touched it. If
 * the row has since grown, another of the user's instances credited the same
 * phone in between (the phone switched gateways and came back): diffing
 * against our stale baseline would count that range twice. Re-baseline and
 * credit nothing — this can only under-count.
 */
export async function recordStepReading(db, reading, { now = Date.now(), emit } = {}) {
  const r = parseReading(reading);
  const s = await readStepSettings(db);
  const day = localDay(now);
  const key = `${day}:${r.device_id}`;
  const bootAt = now - r.elapsed_ms;

  const { rows } = await db.execute({
    sql: "SELECT boot_count, last_counter, last_read_at, last_total, last_day FROM ramble_step_devices WHERE device_id = ?",
    args: [r.device_id],
  });
  const prev = rows[0]
    ? {
      boot_count: rows[0].boot_count == null ? null : Number(rows[0].boot_count),
      last_counter: Number(rows[0].last_counter),
      last_read_at: Number(rows[0].last_read_at),
      last_total: Number(rows[0].last_total) || 0,
      last_day: rows[0].last_day == null ? null : String(rows[0].last_day),
    }
    : null;
  const current = (await rowDelta(db, STEPS_KIND, key)) ?? 0;

  let raw;
  let overMs;
  let reason;
  if (!prev) {
    if (bootAt >= startOfLocalDay(now)) {
      // Every step on the counter was walked today. Another of the user's
      // instances may already have credited some of them (the phone moved
      // here mid-day, spec §4.1): only the part it has not seen is new.
      raw = r.counter - current;
      overMs = r.elapsed_ms;
      reason = "booted-today";
    } else {
      raw = 0;
      overMs = 0;
      reason = "baseline";
    }
  } else if (current > (prev.last_day === day ? prev.last_total : 0)) {
    raw = 0;
    overMs = 0;
    reason = "foreign";
  } else if ((r.boot_count !== null && prev.boot_count !== null && r.boot_count !== prev.boot_count)
    || r.counter < prev.last_counter
    || bootAt > prev.last_read_at + BOOT_SLACK_MS) {
    raw = r.counter;
    overMs = r.elapsed_ms;
    reason = "reboot";
  } else {
    raw = r.counter - prev.last_counter;
    overMs = Math.max(0, now - prev.last_read_at);
    reason = "delta";
  }

  const claim = prev
    ? await db.execute({
      sql: `UPDATE ramble_step_devices SET boot_count = ?, last_counter = ?, last_read_at = ?
            WHERE device_id = ? AND last_counter = ? AND last_read_at = ?`,
      args: [r.boot_count, r.counter, now, r.device_id, prev.last_counter, prev.last_read_at],
    })
    : await db.execute({
      sql: `INSERT INTO ramble_step_devices (device_id, boot_count, last_counter, last_read_at, created_at)
            VALUES (?, ?, ?, ?, ?) ON CONFLICT(device_id) DO NOTHING`,
      args: [r.device_id, r.boot_count, r.counter, now, now],
    });
  if (Number(claim.rowsAffected) !== 1) return { credited: 0, reason: "raced", clamped: false, day };

  let credit = Math.max(0, raw);
  let clamped = false;
  const allowed = Math.ceil(s.maxPerMin * Math.max(1, overMs / 60000));
  if (credit > allowed) { credit = allowed; clamped = true; }

  if (credit > 0 && current === 0 && (await rowDelta(db, STEPS_KIND, key)) === null) {
    const { rows: d } = await db.execute({
      sql: "SELECT count(*) AS n FROM ramble_wallet WHERE kind = ? AND key LIKE ?",
      args: [STEPS_KIND, day + ":%"],
    });
    if (Number(d[0]?.n) >= s.devicesPerDay) { credit = 0; reason = "device-limit"; }
  }
  if (credit > 0) {
    const room = Math.max(0, s.maxDay - await rawStepsForDay(db, day));
    if (credit > room) { credit = room; clamped = true; }
  }
  let total = current;
  if (credit > 0) {
    // Locally ADD; the emitted row carries the full total, and a peer takes MAX.
    await db.execute({
      sql: `INSERT INTO ramble_wallet (kind, key, delta, created_at) VALUES (?, ?, ?, ?)
            ON CONFLICT(kind, key) DO UPDATE SET delta = ramble_wallet.delta + excluded.delta`,
      args: [STEPS_KIND, key, credit, now],
    });
    const { rows: w } = await db.execute({
      sql: "SELECT delta, created_at FROM ramble_wallet WHERE kind = ? AND key = ?",
      args: [STEPS_KIND, key],
    });
    total = Number(w[0].delta);
    await safeEmit(emit, "ramble_wallet", "update", {
      kind: STEPS_KIND, key, delta: total, created_at: Number(w[0].created_at),
    });
  }
  // Remember what the row held after OUR turn (the foreign-credit guard above).
  await db.execute({
    sql: "UPDATE ramble_step_devices SET last_total = ?, last_day = ? WHERE device_id = ?",
    args: [total, day, r.device_id],
  });
  return { credited: credit, reason, clamped, day };
}
```

- [ ] **Step 5: Run to verify pass**

Run: `npm test -- tests/ramble-steps.test.js`
Expected: PASS, 15 tests. Also run `npm test -- tests/ramble-tables.test.js` (it may enumerate tables; if it asserts an exact table list, add `ramble_step_devices` to that expectation and include the file in the commit).

- [ ] **Step 6: Commit**

```bash
git add bundles/ramble/server/steps.js tests/ramble-steps.test.js
git commit bundles/ramble/server/steps.js bundles/ramble/server/init-tables.js tests/ramble-steps.test.js -m "feat(ramble): steps — credit a step-counter reading against a local per-device baseline (reboot guard, caps, CAS)"
git show --stat HEAD
```

---

### Task 2: Settling the day — energy, the seed bonus, the badge fact, the check-in, settings

**Files:**
- Modify: `bundles/ramble/server/pet.js` (`feed`)
- Modify: `bundles/ramble/server/steps.js` (append)
- Test: `tests/ramble-steps.test.js` (append)

**Interfaces:**
- Consumes: Task 1 exports; `feed(db, event, {now, emit})` from `pet.js`; `SEED_KIND`, `seedBalance`, `harvestableCells` from `wallet.js`.
- Produces: `pet.js` `feed` accepts `{type: "steps", amount}`; `STEPS_FEED_MAX = 100` exported from `pet.js`. From `steps.js`: `settleDay(db, {now, emit}) → {day, steps, energyPaid, seedBonus, walked, walkedNew}`; `recordWalkCheckin(db, {now, emit}) → {already, day, steps, energyPaid, seedBonus, walked, walkedNew}`; `stepsState(db, {now}) → {day, goal, steps, progress, goal_met, checked_in, walked, energy_today, energy_full, seed_today, goal_seed, counted_devices, settings: {goal, nudge, nudge_weekends}}`; `walkedToday(db, {now}) → boolean`; `writeStepSettings(db, patch, {now, emit}) → {...stepsState, settled}` (patch keys `goal` integer, `nudge` boolean, `nudge_weekends` boolean; throws `StepsInputError`); `touchHome(db, {now})`.

- [ ] **Step 1: Write the failing tests** — append to `tests/ramble-steps.test.js` (add the imports to the existing import lines at the top):

```js
// add to imports:
//   import { feed, petState } from "../bundles/ramble/server/pet.js";
//   import { seedBalance, harvestableCells } from "../bundles/ramble/server/wallet.js";
//   and from steps.js also: settleDay, recordWalkCheckin, stepsState, walkedToday, writeStepSettings,
//   touchHome, STEP_ENERGY_KIND, WALKED_KIND, HOME_KEY

async function petRow(db) {
  const { rows } = await db.execute("SELECT energy, last_fed_at, places_week FROM ramble_pet WHERE owner = 'self'");
  return { energy: Number(rows[0].energy), last_fed_at: rows[0].last_fed_at == null ? null : Number(rows[0].last_fed_at), places_week: Number(rows[0].places_week) };
}
async function seedPet(db, energy, lastFedAt) {
  await db.execute({
    sql: "INSERT INTO ramble_pet (owner, energy, last_fed_at) VALUES ('self', ?, ?) ON CONFLICT(owner) DO UPDATE SET energy = excluded.energy, last_fed_at = excluded.last_fed_at",
    args: [energy, lastFedAt],
  });
}
/** Put `n` steps on today's ledger for a second device, bypassing the sensor maths. */
const plantSteps = (db, now, n, dev = DEV2) => db.execute({
  sql: "INSERT INTO ramble_wallet (kind, key, delta, created_at) VALUES ('steps', ?, ?, ?) ON CONFLICT(kind, key) DO UPDATE SET delta = excluded.delta",
  args: [`${localDay(now)}:${dev}`, n, now],
});

test("feed({type:'steps'}) adds a bounded amount and never touches last_fed_at or the weekly counters (R5)", async () => {
  const db = await freshDb();
  await seedPet(db, 40, AT(6));
  await feed(db, { type: "steps", amount: 7 }, { now: AT(9) });
  assert.deepEqual(await petRow(db), { energy: 47, last_fed_at: AT(6), places_week: 0 });
  await feed(db, { type: "steps", amount: -5 }, { now: AT(9) });
  await feed(db, { type: "steps", amount: "junk" }, { now: AT(9) });
  await feed(db, { type: "steps", amount: 2.5 }, { now: AT(9) });
  assert.equal((await petRow(db)).energy, 47, "junk amounts pay nothing");
  await feed(db, { type: "steps", amount: 1e9 }, { now: AT(9) });
  assert.equal((await petRow(db)).energy, 100, "bounded, then clamped by the heart ceiling");
  await assert.rejects(() => feed(db, { type: "stepz" }, { now: AT(9) }), /unknown pet feed event type/);
});

test("energy grows with progress in chunks, reaches energy.full at the goal, and stops there", async () => {
  const db = await freshDb();
  await seedPet(db, 50, AT(6));
  await plantSteps(db, AT(9), 1_000);
  let out = await settleDay(db, { now: AT(9) });
  assert.equal(out.energyPaid, 5, "floor(30 * 1000/6000) = 5, one chunk");
  await plantSteps(db, AT(10), 1_500);
  out = await settleDay(db, { now: AT(10) });
  assert.equal(out.energyPaid, 0, "target 7: an increment of 2 is under the chunk");
  await plantSteps(db, AT(12), 6_500);
  out = await settleDay(db, { now: AT(12) });
  assert.equal(out.energyPaid, 25);
  await plantSteps(db, AT(14), 9_000);
  out = await settleDay(db, { now: AT(14) });
  assert.equal(out.energyPaid, 0, "never past energy.full");
  assert.deepEqual(await petRow(db), { energy: 80, last_fed_at: AT(6), places_week: 0 });
  assert.equal(Number((await db.execute({ sql: "SELECT delta FROM ramble_wallet WHERE kind = ? AND key = ?", args: [STEP_ENERGY_KIND, localDay(AT(14))] })).rows[0].delta), 30);
});

test("the check-in pays a floor that counted steps rise above but never add to, and never pays seed", async () => {
  const db = await freshDb();
  await seedPet(db, 20, AT(6));
  let out = await recordWalkCheckin(db, { now: AT(9) });
  assert.deepEqual([out.already, out.energyPaid, out.seedBonus, out.walked, out.walkedNew], [false, 15, 0, true, true]);
  out = await recordWalkCheckin(db, { now: AT(9, 5) });
  assert.deepEqual([out.already, out.energyPaid, out.walkedNew], [true, 0, false]);
  await plantSteps(db, AT(10), 3_000);   // step target 15 = the floor
  assert.equal((await settleDay(db, { now: AT(10) })).energyPaid, 0);
  await plantSteps(db, AT(11), 4_000);   // step target 20
  assert.equal((await settleDay(db, { now: AT(11) })).energyPaid, 5);
  assert.equal(await seedBalance(db), 0, "a check-in alone never pays seed (S3)");
  await plantSteps(db, AT(12), 6_000);
  out = await settleDay(db, { now: AT(12) });
  assert.deepEqual([out.energyPaid, out.seedBonus], [10, 3]);
  assert.equal((await petRow(db)).energy, 50);
});

test("the seed bonus pays once a day; lowering the goal under today's steps completes it", async () => {
  const db = await freshDb();
  await plantSteps(db, AT(10), 4_000);
  assert.equal((await settleDay(db, { now: AT(10) })).seedBonus, 0);
  const st = await writeStepSettings(db, { goal: 4_000 }, { now: AT(10) });
  assert.equal(st.goal_met, true);
  assert.equal(st.settled.seedBonus, 3);
  assert.equal((await writeStepSettings(db, { goal: 3_500 }, { now: AT(10) })).settled.seedBonus, 0, "once a day");
  assert.equal(await seedBalance(db), 3);
});

test("the bonus row counts toward the balance and is never mistaken for harvestable seed", async () => {
  const db = await freshDb();
  const cells = ["9vg4e2s", "9vg4e2t", "9vg4e2u", "9vg4e2v", "9vg4e2w", "9vg4e2x", "9vg4e2y", "9vg4e2z"];
  const before = await harvestableCells(db, cells, { now: AT(10) });
  await plantSteps(db, AT(10), 7_000);
  await settleDay(db, { now: AT(10) });
  assert.equal(await seedBalance(db), 3);
  assert.deepEqual(await harvestableCells(db, cells, { now: AT(10) }), before);
});

test("the badge: min(goal, badge.min) counted steps, or a check-in; the new-fact flag fires once", async () => {
  const db = await freshDb();
  await plantSteps(db, AT(10), 1_999);
  assert.equal((await settleDay(db, { now: AT(10) })).walked, false);
  assert.equal(await walkedToday(db, { now: AT(10) }), false);
  await plantSteps(db, AT(11), 2_000);
  let out = await settleDay(db, { now: AT(11) });
  assert.deepEqual([out.walked, out.walkedNew], [true, true]);
  out = await settleDay(db, { now: AT(11, 5) });
  assert.deepEqual([out.walked, out.walkedNew], [true, false]);
  assert.equal(await walkedToday(db, { now: AT(11) }), true);
  assert.equal(await walkedToday(db, { now: AT(11) + 24 * H }), false, "tomorrow starts unwalked");
  const db2 = await freshDb();
  await writeStepSettings(db2, { goal: 1_500 }, { now: AT(10) });
  await plantSteps(db2, AT(10), 1_500);
  assert.equal((await settleDay(db2, { now: AT(10) })).walked, true, "a goal under 2,000 is its own badge line");
});

test("step energy is clamped by the heart-derived ceiling", async () => {
  const db = await freshDb();
  await seedPet(db, 95, AT(6));
  await plantSteps(db, AT(12), 6_000);
  await settleDay(db, { now: AT(12) });
  assert.equal((await petRow(db)).energy, 100);
});

test("stepsState reports the day without writing anything", async () => {
  const db = await freshDb();
  await plantSteps(db, AT(10), 3_000);
  const st = await stepsState(db, { now: AT(10) });
  assert.deepEqual(st, {
    day: localDay(AT(10)), goal: 6000, steps: 3000, progress: 0.5, goal_met: false,
    checked_in: false, walked: false, energy_today: 0, energy_full: 30, seed_today: 0, goal_seed: 3,
    counted_devices: 1, settings: { goal: 6000, nudge: true, nudge_weekends: true },
  });
  assert.equal((await db.execute("SELECT count(*) AS n FROM ramble_wallet WHERE kind != 'steps'")).rows[0].n, 0);
});

test("writeStepSettings validates, persists, and emits each setting", async () => {
  const db = await freshDb();
  const ops = [];
  const emit = async (table, op, row) => ops.push({ table, op, row });
  for (const bad of [{}, { goal: 999 }, { goal: 30_001 }, { goal: 6000.5 }, { goal: "6000" }, { nudge: "yes" }, { nudge_weekends: 1 }, null]) {
    await assert.rejects(() => writeStepSettings(db, bad, { now: AT(10), emit }), (e) => e.name === "StepsInputError", JSON.stringify(bad));
  }
  const st = await writeStepSettings(db, { goal: 7_500, nudge: false, nudge_weekends: false }, { now: AT(10), emit });
  assert.deepEqual(st.settings, { goal: 7500, nudge: false, nudge_weekends: false });
  assert.deepEqual(ops.filter((o) => o.table === "ramble_settings").map((o) => [o.row.key, o.row.value]),
    [["steps.goal", "7500"], ["steps.nudge", "0"], ["steps.nudge.weekends", "0"]]);
});

test("touchHome writes the local-only steps-home marker without emitting", async () => {
  const db = await freshDb();
  await touchHome(db, { now: AT(10) });
  const { rows } = await db.execute({ sql: "SELECT value FROM ramble_settings WHERE key = ?", args: [HOME_KEY] });
  assert.equal(Number(rows[0].value), AT(10));
  assert.ok(HOME_KEY.startsWith("local."), "instance sync drops local. keys in both directions");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- tests/ramble-steps.test.js`
Expected: FAIL — `settleDay` is not exported; the feed test fails with `unknown pet feed event type: steps`.

- [ ] **Step 3: `pet.js` — accept `steps`**

Add below `FEED_DELTAS` (do NOT add a key to `FEED_DELTAS`; `tests/ramble-pet.test.js` deep-equals it):

```js
/**
 * Spec 2026-10-04 §6: step energy is the one feed whose size varies, so it is
 * not in FEED_DELTAS. Its amount is bounded here, and it never moves
 * `last_fed_at` (R5): readings arrive often, and if each reset the decay clock
 * a bird whose owner opens the app every few hours would never droop at all.
 */
export const STEPS_FEED_MAX = 100;
function stepsAmount(a) {
  const n = Number(a);
  return Number.isInteger(n) ? Math.max(0, Math.min(STEPS_FEED_MAX, n)) : 0;
}
```

In `feed()`, replace the type check and the two lines that use the delta:

```js
  const type = event && event.type;
  const isSteps = type === "steps";
  if (!isSteps && !Object.prototype.hasOwnProperty.call(FEED_DELTAS, type)) {
    throw new Error(`unknown pet feed event type: ${type}`);
  }
```

```js
  const delta = isSteps ? stepsAmount(event.amount) : FEED_DELTAS[type];
```

```js
  const last_fed_at = delta > 0 && !isSteps ? now : row.last_fed_at;
```

(`COUNTER_COLUMN` has no `steps` entry, so the weekly counters are already untouched.)

- [ ] **Step 4: Append to `steps.js`**

Add to the imports at the top of `steps.js`:

```js
import { feed as petFeed } from "./pet.js";
import { SEED_KIND } from "./wallet.js";
```

Append:

```js
/**
 * Settle today (spec §6): pay step energy in chunks up to the day's target,
 * the seed bonus once the counted steps reach the goal, and the `walked` fact
 * once R6 holds. Runs after a credited reading, a check-in, or a goal change.
 * The energy ledger is written BEFORE the feed, by compare-and-swap: a lost
 * race or a crash between the two can only under-pay.
 */
export async function settleDay(db, { now = Date.now(), emit } = {}) {
  const s = await readStepSettings(db);
  const day = localDay(now);
  const steps = await stepsToday(db, now, s);
  const checkedIn = (await rowDelta(db, WALK_CHECKIN_KIND, day)) !== null;

  const stepTarget = Math.floor(s.energyFull * Math.min(1, steps / s.goal));
  const floor = checkedIn ? s.checkinEnergy : 0;
  const target = Math.max(stepTarget, floor);
  const paid = await rowDelta(db, STEP_ENERGY_KIND, day);
  const inc = target - (paid ?? 0);
  let energyPaid = 0;
  if (inc > 0 && (inc >= s.energyChunk || target >= s.energyFull || target === floor)) {
    if (await casDelta(db, STEP_ENERGY_KIND, day, paid, target, now, emit)) {
      await petFeed(db, { type: "steps", amount: inc }, { now, emit });
      energyPaid = inc;
    }
  }

  let seedBonus = 0;
  if (steps >= s.goal && s.goalSeed > 0
    && await insertOnce(db, SEED_KIND, STEP_SEED_PREFIX + day, s.goalSeed, now, emit)) {
    seedBonus = s.goalSeed;
  }

  const walked = checkedIn || steps >= Math.min(s.goal, s.badgeMin);
  const walkedNew = walked ? await insertOnce(db, WALKED_KIND, day, 1, now, emit) : false;
  return { day, steps, energyPaid, seedBonus, walked: walked || (await rowDelta(db, WALKED_KIND, day)) !== null, walkedNew };
}

/** "I walked today" (spec §7): idempotent per day; mood only, never seed. */
export async function recordWalkCheckin(db, { now = Date.now(), emit } = {}) {
  const fresh = await insertOnce(db, WALK_CHECKIN_KIND, localDay(now), 1, now, emit);
  const settled = await settleDay(db, { now, emit });
  return { already: !fresh, ...settled };
}

export async function walkedToday(db, { now = Date.now() } = {}) {
  return (await rowDelta(db, WALKED_KIND, localDay(now))) !== null;
}

/** The day as the panel shows it. Read-only. */
export async function stepsState(db, { now = Date.now() } = {}) {
  const s = await readStepSettings(db);
  const day = localDay(now);
  const steps = await stepsToday(db, now, s);
  const { rows } = await db.execute({
    sql: `SELECT kind, delta FROM ramble_wallet
          WHERE (kind IN (?, ?, ?) AND key = ?) OR (kind = ? AND key = ?)`,
    args: [WALK_CHECKIN_KIND, WALKED_KIND, STEP_ENERGY_KIND, day, SEED_KIND, STEP_SEED_PREFIX + day],
  });
  const of = (kind) => rows.find((r) => r.kind === kind);
  const { rows: dev } = await db.execute({
    sql: "SELECT count(*) AS n FROM ramble_wallet WHERE kind = ? AND key LIKE ?",
    args: [STEPS_KIND, day + ":%"],
  });
  return {
    day,
    goal: s.goal,
    steps,
    progress: Math.min(1, steps / s.goal),
    goal_met: steps >= s.goal,
    checked_in: !!of(WALK_CHECKIN_KIND),
    walked: !!of(WALKED_KIND),
    energy_today: Number(of(STEP_ENERGY_KIND)?.delta ?? 0),
    energy_full: s.energyFull,
    seed_today: Number(of(SEED_KIND)?.delta ?? 0),
    goal_seed: s.goalSeed,
    counted_devices: Number(dev[0]?.n ?? 0),
    settings: { goal: s.goal, nudge: s.nudge, nudge_weekends: s.nudgeWeekends },
  };
}

/** The three user-facing settings. Replicated LWW via ramble_settings. */
export async function writeStepSettings(db, patch, { now = Date.now(), emit } = {}) {
  if (!patch || typeof patch !== "object") throw new StepsInputError("settings must be an object");
  const writes = [];
  if (patch.goal !== undefined) {
    if (!Number.isInteger(patch.goal) || patch.goal < GOAL_MIN || patch.goal > GOAL_MAX) {
      throw new StepsInputError(`goal must be a whole number from ${GOAL_MIN} to ${GOAL_MAX}`);
    }
    writes.push(["steps.goal", String(patch.goal)]);
  }
  for (const [field, key] of [["nudge", "steps.nudge"], ["nudge_weekends", "steps.nudge.weekends"]]) {
    if (patch[field] === undefined) continue;
    if (typeof patch[field] !== "boolean") throw new StepsInputError(`${field} must be true or false`);
    writes.push([key, patch[field] ? "1" : "0"]);
  }
  if (!writes.length) throw new StepsInputError("nothing to change");
  for (const [key, value] of writes) {
    // eslint-disable-next-line no-await-in-loop
    await db.execute({
      sql: `INSERT INTO ramble_settings (key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      args: [key, value],
    });
    // eslint-disable-next-line no-await-in-loop
    await safeEmit(emit, "ramble_settings", "update", { key, value });
  }
  const settled = await settleDay(db, { now, emit });
  return { ...(await stepsState(db, { now })), settled };
}

/** R8: this instance is where the player walks from. Local key, never emitted. */
export async function touchHome(db, { now = Date.now() } = {}) {
  try {
    await db.execute({
      sql: `INSERT INTO ramble_settings (key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      args: [HOME_KEY, String(now)],
    });
  } catch { /* a marker, never worth failing a request over */ }
}
```

Note the `settleDay` `walked` return: `true` when R6 holds OR a `walked` row already exists (it may have arrived by sync).

- [ ] **Step 5: Run to verify pass**

Run: `npm test -- tests/ramble-steps.test.js tests/ramble-pet.test.js tests/ramble-feed.test.js tests/ramble-wallet.test.js`
Expected: PASS (all).

- [ ] **Step 6: Commit**

```bash
git commit bundles/ramble/server/pet.js bundles/ramble/server/steps.js tests/ramble-steps.test.js -m "feat(ramble): steps — settle the day (chunked energy, goal seed bonus, walked fact), check-in, state, settings"
git show --stat HEAD
```

---

### Task 3: Multi-instance convergence (executable, no core change)

**Files:**
- Test: `tests/ramble-steps-sync.test.js` (create)

**Interfaces:**
- Consumes: Task 1–2 exports; `applyRambleWallet(db, op, row, lamportTs)` from `servers/sharing/instance-sync.js`; `seedBalance` from `wallet.js`.
- Produces: nothing new — this task proves R2 (no core sync change is needed). If any test here fails because of `applyRambleWallet`, STOP and report: the design assumed its MAX merge is sufficient.

- [ ] **Step 1: Write the tests** — create `tests/ramble-steps-sync.test.js`:

```js
/**
 * Spec 2026-10-04 §4.1, §11: steps replicate as monotone ramble_wallet rows,
 * merged by the EXISTING applyRambleWallet (MAX delta). Two in-memory dbs
 * stand in for two of the user's instances; each one's emits are captured and
 * applied to the other, in both orders.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import { applyRambleWallet } from "../servers/sharing/instance-sync.js";
import { startOfLocalDay } from "../bundles/ramble/server/eggs.js";
import { seedBalance } from "../bundles/ramble/server/wallet.js";
import {
  recordStepReading, settleDay, stepsToday, stepsState, recordWalkCheckin,
} from "../bundles/ramble/server/steps.js";

const DAY0 = startOfLocalDay(Date.UTC(2026, 9, 5, 18));
const AT = (h, m = 0) => DAY0 + h * 3_600_000 + m * 60_000;
const H = 3_600_000;
const P1 = "aaaaaaaa-0000-0000-0000-000000000001";
const P2 = "bbbbbbbb-0000-0000-0000-000000000002";

async function instance() {
  const db = createClient({ url: "file::memory:" });
  await initRambleTables(db);
  await db.execute("INSERT INTO ramble_pet (owner, energy) VALUES ('self', 40)");
  const ops = [];
  return { db, ops, emit: async (table, op, row) => ops.push({ table, op, row: { ...row } }) };
}
let lamport = 1000;
/** Apply (and drain) `from`'s captured wallet ops to `to`, optionally reversed. */
async function deliver(from, to, { reverse = false } = {}) {
  const ops = from.ops.splice(0);
  if (reverse) ops.reverse();
  for (const { table, op, row } of ops) {
    if (table === "ramble_wallet") await applyRambleWallet(to.db, op, row, ++lamport);
  }
}
async function readAndSettle(inst, r, now) {
  const out = await recordStepReading(inst.db, { boot_count: 1, ...r }, { now, emit: inst.emit });
  if (out.credited > 0) await settleDay(inst.db, { now, emit: inst.emit });
  return out;
}
const setBoth = async (A, B, key, value) => {
  for (const { db } of [A, B]) {
    await db.execute({ sql: "INSERT INTO ramble_settings (key, value) VALUES (?, ?)", args: [key, String(value)] });
  }
};

for (const reverse of [false, true]) {
  test(`one phone on A, delivered to B (${reverse ? "reversed" : "in order"}): same total, same balance, same badge`, async () => {
    const A = await instance(), B = await instance();
    await readAndSettle(A, { device_id: P1, counter: 3_000, elapsed_ms: 2 * H }, AT(10));
    await readAndSettle(A, { device_id: P1, counter: 7_000, elapsed_ms: 4 * H }, AT(12));
    await deliver(A, B, { reverse });
    assert.equal(await stepsToday(B.db, AT(12)), 7_000);
    assert.equal(await seedBalance(B.db), 3);
    const st = await stepsState(B.db, { now: AT(12) });
    assert.deepEqual([st.walked, st.goal_met, st.energy_today], [true, true, 30]);
  });
}

test("a phone that moves from A to B mid-day: B does not re-add what A already synced, and stays monotone", async () => {
  const A = await instance(), B = await instance();
  await readAndSettle(A, { device_id: P1, counter: 2_000, elapsed_ms: 2 * H }, AT(10));
  await deliver(A, B);
  // Same boot, the phone now talks to B. B has no baseline for it; it booted today.
  const out = await readAndSettle(B, { device_id: P1, counter: 2_600, elapsed_ms: 3 * H }, AT(11));
  assert.equal(out.credited, 600, "only what A had not seen");
  assert.equal(await stepsToday(B.db, AT(11)), 2_600);
  await deliver(B, A);
  assert.equal(await stepsToday(A.db, AT(11)), 2_600, "MAX, not a sum");
});

test("A -> B -> A: a phone that returns to A after B credited it is NOT counted twice (foreign-credit guard)", async () => {
  const A = await instance(), B = await instance();
  await readAndSettle(A, { device_id: P1, counter: 50_000, elapsed_ms: 20 * H }, AT(9));   // A baseline
  await readAndSettle(A, { device_id: P1, counter: 52_000, elapsed_ms: 21 * H }, AT(10));  // A: 2,000
  await deliver(A, B);
  await readAndSettle(B, { device_id: P1, counter: 52_500, elapsed_ms: 22 * H }, AT(11));  // B baseline
  await readAndSettle(B, { device_id: P1, counter: 53_000, elapsed_ms: 23 * H }, AT(12));  // B: 2,500
  await deliver(B, A);
  const back = await readAndSettle(A, { device_id: P1, counter: 53_500, elapsed_ms: 24 * H }, AT(13));
  assert.deepEqual([back.credited, back.reason], [0, "foreign"], "A's baseline is stale: re-baseline, credit nothing");
  assert.equal(await stepsToday(A.db, AT(13)), 2_500, "never more than the steps actually seen (true walk: 3,500; the gaps are lost, never doubled)");
  const next = await readAndSettle(A, { device_id: P1, counter: 54_000, elapsed_ms: 25 * H }, AT(14));
  assert.equal(next.credited, 500, "and from the new baseline A counts normally again");
  await deliver(A, B);
  assert.equal(await stepsToday(B.db, AT(14)), 3_000);
});

test("a phone that moves to B after booting BEFORE today: B takes a baseline and A's count stands", async () => {
  const A = await instance(), B = await instance();
  await readAndSettle(A, { device_id: P1, counter: 50_000, elapsed_ms: 20 * H }, AT(9));
  await readAndSettle(A, { device_id: P1, counter: 52_000, elapsed_ms: 21 * H }, AT(10));
  await deliver(A, B);
  const out = await readAndSettle(B, { device_id: P1, counter: 52_500, elapsed_ms: 22 * H }, AT(11));
  assert.equal(out.reason, "baseline");
  assert.equal(await stepsToday(B.db, AT(11)), 2_000);
  await readAndSettle(B, { device_id: P1, counter: 53_000, elapsed_ms: 23 * H }, AT(12));
  assert.equal(await stepsToday(B.db, AT(12)), 2_500, "B adds on top of the synced total");
});

test("two phones on two instances: totals add, the cap holds after merge, the bonus pays once", async () => {
  const A = await instance(), B = await instance();
  await setBoth(A, B, "steps.max.day", 5_000);
  await readAndSettle(A, { device_id: P1, counter: 4_000, elapsed_ms: 3 * H }, AT(10));
  await readAndSettle(B, { device_id: P2, counter: 4_000, elapsed_ms: 3 * H }, AT(10));
  await deliver(A, B);
  await deliver(B, A);
  for (const I of [A, B]) {
    assert.equal(await stepsToday(I.db, AT(10)), 5_000, "capped on read after a merge");
  }
  // Neither met the 6,000 goal alone; together (capped) they still do not.
  assert.equal(await seedBalance(A.db), 0);
  await setBoth(A, B, "steps.goal", 5_000);
  await settleDay(A.db, { now: AT(10), emit: A.emit });
  await settleDay(B.db, { now: AT(10), emit: B.emit });
  await deliver(A, B);
  await deliver(B, A);
  assert.equal(await seedBalance(A.db), 3, "same key on both sides: one bonus");
  assert.equal(await seedBalance(B.db), 3);
});

test("energy ledgers merge to the larger, and a later settle does not pay the difference twice", async () => {
  const A = await instance(), B = await instance();
  await readAndSettle(A, { device_id: P1, counter: 6_000, elapsed_ms: 3 * H }, AT(10)); // paid 30
  await recordWalkCheckin(B.db, { now: AT(10), emit: B.emit });                          // paid 15
  await deliver(A, B);
  await deliver(B, A);
  for (const I of [A, B]) {
    const st = await stepsState(I.db, { now: AT(10) });
    assert.equal(st.energy_today, 30);
    assert.equal((await settleDay(I.db, { now: AT(10, 5), emit: I.emit })).energyPaid, 0);
  }
});

test("walked and check-in facts dedupe across instances", async () => {
  const A = await instance(), B = await instance();
  await recordWalkCheckin(A.db, { now: AT(9), emit: A.emit });
  await recordWalkCheckin(B.db, { now: AT(10), emit: B.emit });
  await deliver(A, B);
  await deliver(B, A);
  for (const I of [A, B]) {
    const { rows } = await I.db.execute("SELECT kind, key, delta, created_at FROM ramble_wallet WHERE kind IN ('walkcheck', 'walked') ORDER BY kind");
    assert.deepEqual(rows.map((r) => [r.kind, Number(r.delta), Number(r.created_at)]), [["walkcheck", 1, AT(9)], ["walked", 1, AT(9)]]);
  }
});
```

- [ ] **Step 2: Run**

Run: `npm test -- tests/ramble-steps-sync.test.js`
Expected: PASS (8 tests) against Task 1–2 code with no change to `instance-sync.js`. If a test fails, fix the bundle code (not `applyRambleWallet`) unless the failure proves R2 wrong — then stop and report.

- [ ] **Step 3: Commit**

```bash
git add tests/ramble-steps-sync.test.js
git commit tests/ramble-steps-sync.test.js -m "test(ramble): steps converge across the user's instances through the existing wallet merge"
git show --stat HEAD
```

---

### Task 4: Routes

**Files:**
- Modify: `bundles/ramble/panel/routes.js` (`ensureLoaded` module list; `GET /api/ramble/pet`; new routes after the wardrobe routes)
- Test: `tests/ramble-steps-routes.test.js` (create)

**Interfaces:**
- Consumes: Task 1–2 exports (`recordStepReading`, `settleDay`, `recordWalkCheckin`, `stepsState`, `walkedToday`, `writeStepSettings`, `touchHome`, `StepsInputError` by `err.name`).
- Produces (HTTP): `GET /api/ramble/steps` → `stepsState`; `POST /api/ramble/steps/reading` body `{device_id, counter, elapsed_ms, boot_count}` → `{reading: {credited, reason, clamped, day}, ...stepsState}`; `POST /api/ramble/steps/walked` → `{already, ...stepsState}`; `PUT /api/ramble/steps/settings` body subset of `{goal, nudge, nudge_weekends}` → `stepsState`; `GET /api/ramble/pet` gains `walked_today: boolean`. Bus event `ramble:walked-changed` (payload `{day}`) when a `walked` fact is first written by a request.

- [ ] **Step 1: Write the failing tests** — create `tests/ramble-steps-routes.test.js`:

```js
/**
 * Spec 2026-10-04 §5–§7: the walking API on the ramble panel router, mounted
 * the way the gateway mounts it (stub dashboardAuth, real loopback socket).
 * One SQLite engine per file: the bundle's own createDbClient, closed per use.
 * The router uses the real clock, so a run straddling local midnight could
 * flake (the test and the server would disagree on "today"); accepted —
 * the arithmetic is pinned with frozen clocks in tests/ramble-steps.test.js.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import bus from "../servers/shared/event-bus.js";
import { localDay } from "../bundles/ramble/server/eggs.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dir, "..");
let SCRATCH, server, base, saved, createDbClient;
async function withDb(fn) { const db = createDbClient(); try { return await fn(db); } finally { db.close(); } }
const emitted = [];
const pokes = [];
const onWalked = (p) => pokes.push(p);
const H = { "x-test-auth": "1", "content-type": "application/json" };
const get = (p) => fetch(base + p, { headers: H });
const send = (method, p, body) => fetch(base + p, { method, headers: H, body: JSON.stringify(body) });
const DEV = "cccccccc-1111-2222-3333-444444444444";

before(async () => {
  SCRATCH = mkdtempSync(join(tmpdir(), "ramble-steps-routes-"));
  saved = { CROW_APP_ROOT: process.env.CROW_APP_ROOT, CROW_DATA_DIR: process.env.CROW_DATA_DIR, CROW_DB_PATH: process.env.CROW_DB_PATH };
  process.env.CROW_APP_ROOT = REPO_ROOT;
  process.env.CROW_DATA_DIR = SCRATCH;
  delete process.env.CROW_DB_PATH;
  const { default: rambleRouter } = await import(`../bundles/ramble/panel/routes.js?t=${Date.now()}`);
  const app = express();
  app.use(rambleRouter((req, res, next) => (req.headers["x-test-auth"] ? next() : res.status(401).end()), {
    emit: async (table, op, row) => emitted.push({ table, op, row }),
  }));
  server = app.listen(0);
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
  bus.on("ramble:walked-changed", onWalked);
  assert.equal((await get("/api/ramble/steps")).status, 200, "first request creates + inits the scratch db");
  ({ createDbClient } = await import("../bundles/ramble/server/db.js"));
});
after(async () => {
  bus.off("ramble:walked-changed", onWalked);
  server?.close();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(SCRATCH, { recursive: true, force: true });
});

test("auth: the walking API sits behind dashboardAuth", async () => {
  assert.equal((await fetch(base + "/api/ramble/steps")).status, 401);
});

test("GET /api/ramble/steps: the day, and the steps-home marker is touched", async () => {
  const st = await (await get("/api/ramble/steps")).json();
  assert.deepEqual([st.goal, st.steps, st.walked, st.settings.nudge], [6000, 0, false, true]);
  const seen = await withDb(async (db) => (await db.execute("SELECT value FROM ramble_settings WHERE key = 'local.steps.seen_at'")).rows[0]?.value);
  assert.ok(Number(seen) > 0);
});

test("POST /api/ramble/steps/reading: a phone booted a second ago is credited and the row is emitted", async () => {
  const r = await send("POST", "/api/ramble/steps/reading", { device_id: DEV, counter: 100, elapsed_ms: 1000, boot_count: 3 });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.reading.credited, 100);
  assert.equal(body.steps, 100);
  assert.ok(emitted.some((e) => e.table === "ramble_wallet" && e.row.kind === "steps" && e.row.delta === 100));
});

test("POST /api/ramble/steps/reading: junk is a 400, never a 500", async () => {
  for (const body of [
    {}, { device_id: "x", counter: 1, elapsed_ms: 1 }, { device_id: DEV, counter: -1, elapsed_ms: 1 },
    { device_id: DEV, counter: 1.5, elapsed_ms: 1 }, { device_id: DEV, counter: 1, elapsed_ms: "1" },
    { device_id: DEV, counter: 1, elapsed_ms: 1, boot_count: "two" },
  ]) {
    assert.equal((await send("POST", "/api/ramble/steps/reading", body)).status, 400, JSON.stringify(body));
  }
});

test("POST /api/ramble/steps/walked: idempotent, mood not seed, pokes the badge once, shows on the pet", async () => {
  const before = pokes.length;
  let r = await send("POST", "/api/ramble/steps/walked", {});
  assert.equal(r.status, 200);
  let body = await r.json();
  assert.deepEqual([body.already, body.checked_in, body.walked, body.seed_today], [false, true, true, 0]);
  r = await send("POST", "/api/ramble/steps/walked", {});
  body = await r.json();
  assert.equal(body.already, true);
  assert.equal(pokes.length - before, 1, "one poke for the new fact");
  const pet = await (await get("/api/ramble/pet")).json();
  assert.equal(pet.walked_today, true);
});

test("PUT /api/ramble/steps/settings: validates, persists, emits; lowering the goal under today's steps completes it", async () => {
  for (const body of [{}, { goal: 999 }, { goal: 6000.5 }, { goal: "6000" }, { nudge: "yes" }]) {
    assert.equal((await send("PUT", "/api/ramble/steps/settings", body)).status, 400, JSON.stringify(body));
  }
  await withDb((db) => db.execute({
    sql: "INSERT INTO ramble_wallet (kind, key, delta, created_at) VALUES ('steps', ?, 1500, ?)",
    args: [`${localDay(Date.now())}:dddddddd-0000-0000-0000-000000000000`, Date.now()],
  }));
  const r = await send("PUT", "/api/ramble/steps/settings", { goal: 1000, nudge: false });
  assert.equal(r.status, 200);
  const st = await r.json();
  assert.deepEqual([st.goal, st.goal_met, st.seed_today, st.settings.nudge], [1000, true, 3, false]);
  assert.ok(emitted.some((e) => e.table === "ramble_settings" && e.row.key === "steps.goal" && e.row.value === "1000"));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- tests/ramble-steps-routes.test.js`
Expected: FAIL — `GET /api/ramble/steps` is a 404.

- [ ] **Step 3: Load the module** — in `ensureLoaded` (`bundles/ramble/panel/routes.js`):
  - append `stepsMod` to the destructuring list after `wardrobeMod`, and `bundleImport("server/steps.js"),` after `bundleImport("server/wardrobe.js"),`;
  - append `|| !stepsMod` to the availability check (after `!wardrobeMod`);
  - append `stepsMod` to the `mods = { ... }` object (after `wardrobeMod`).

- [ ] **Step 4: `walked_today` on the pet read** — in `GET /api/ramble/pet`'s `res.json({...})`, add after `energy_max_cap: ...`:

```js
      // Spec 2026-10-04 §8: the pet page draws the "walked today" badge.
      walked_today: await mods.stepsMod.walkedToday(db, { now }),
```

- [ ] **Step 5: The walking routes** — add after the `POST /api/ramble/birds/:id/outfit` route:

```js
  // --- walking (spec 2026-10-04) ------------------------------------------
  //
  // The phone's counter arrives through the panel (the Android app's
  // window.Crow bridge); every number is decided in server/steps.js.

  /** steps.js throws StepsInputError for bad input: that is a 400, not a 500. */
  function stepsInput(err) {
    if (err && err.name === "StepsInputError") bad(err.message);
    throw err;
  }

  router.get("/api/ramble/steps", handle(async (req, res) => {
    const now = Date.now();
    await mods.stepsMod.touchHome(db, { now });
    res.json(await mods.stepsMod.stepsState(db, { now }));
  }));

  router.post("/api/ramble/steps/reading", handle(async (req, res) => {
    const now = Date.now();
    let reading;
    try { reading = await mods.stepsMod.recordStepReading(db, req.body || {}, { now, emit }); }
    catch (err) { stepsInput(err); }
    await mods.stepsMod.touchHome(db, { now });
    if (reading.credited > 0) {
      const settled = await mods.stepsMod.settleDay(db, { now, emit });
      // Core repaints the profile picture, coalesced (profile-avatar.js).
      if (settled.walkedNew) poke("ramble:walked-changed", { day: settled.day });
    }
    res.json({ reading, ...(await mods.stepsMod.stepsState(db, { now })) });
  }));

  router.post("/api/ramble/steps/walked", handle(async (req, res) => {
    const now = Date.now();
    const out = await mods.stepsMod.recordWalkCheckin(db, { now, emit });
    await mods.stepsMod.touchHome(db, { now });
    if (out.walkedNew) poke("ramble:walked-changed", { day: out.day });
    res.json({ already: out.already, ...(await mods.stepsMod.stepsState(db, { now })) });
  }));

  router.put("/api/ramble/steps/settings", handle(async (req, res) => {
    const now = Date.now();
    let out;
    try { out = await mods.stepsMod.writeStepSettings(db, req.body || {}, { now, emit }); }
    catch (err) { stepsInput(err); }
    if (out.settled && out.settled.walkedNew) poke("ramble:walked-changed", { day: out.settled.day });
    const { settled, ...state } = out;
    res.json(state);
  }));
```

`express.json()` is already mounted for `/api/ramble`, so `PUT` bodies parse. Check `router.use("/api/ramble", dashboardAuth)` covers PUT (it is method-agnostic — `router.use`).

- [ ] **Step 6: Run to verify pass**

Run: `npm test -- tests/ramble-steps-routes.test.js tests/ramble-panel.test.js tests/ramble-wardrobe-routes.test.js`
Expected: PASS. If `tests/ramble-panel.test.js` deep-equals the whole `GET /api/ramble/pet` body anywhere, add `walked_today: false` to that expectation and include the file in the commit.

- [ ] **Step 7: Commit**

```bash
git add tests/ramble-steps-routes.test.js
git commit bundles/ramble/panel/routes.js tests/ramble-steps-routes.test.js -m "feat(ramble): walking API — reading, check-in, settings, walked_today on the pet"
git show --stat HEAD
```

---

### Task 5: The "walked today" badge — engine, pet portrait data, contacts' profile picture (core)

**Files:**
- Modify: `bundles/ramble/server/bird-svg.cjs` (add `drawWalkBadge`, export it)
- Modify: `servers/sharing/profile-avatar.js`
- Test: `tests/ramble-bird-svg.test.js` (append), `tests/profile-avatar-bird.test.js` (append)

**Interfaces:**
- Consumes: the `walked` ledger fact (kind `walked`, key `YYYY-MM-DD`) written by Task 2; bus event `ramble:walked-changed` from Task 4.
- Produces: `RambleBird.drawWalkBadge() → string`, `RambleBird.mountWalkBadge(el)` (appends it to a mounted portrait) (an SVG `<g class="rb-walk-badge">…</g>` positioned for the 200×200 portrait viewBox). `profile-avatar.js`: `export function portraitDay(ms) → "YYYY-MM-DD"`; `readPortrait` returns `{egg_id, species, seed, mood, outfit, walked}`; `renderBirdAvatar` draws the badge when `bird.walked === true` and the engine has `drawWalkBadge`.

- [ ] **Step 1: Write the failing engine test** — append to `tests/ramble-bird-svg.test.js` (it already loads the engine; reuse its `Bird` binding — check the file's top for the name and use that):

```js
test("drawWalkBadge: a small self-contained group inside the 200x200 portrait; drawBird is untouched", () => {
  const badge = Bird.drawWalkBadge();
  assert.ok(badge.startsWith('<g class="rb-walk-badge"'));
  assert.ok(badge.endsWith("</g>"));
  assert.ok(!/<script|on[a-z]+=|href/i.test(badge), "inert markup only");
  assert.ok(badge.length < 1200, "cheap enough to ride every portrait");
  const m = badge.match(/translate\((\d+) (\d+)\)/);
  assert.ok(m && Number(m[1]) + 40 <= 200 && Number(m[2]) + 40 <= 200, "fits the viewBox");
  const el = { innerHTML: "<g>bird</g>" };
  Bird.mountWalkBadge(el);
  assert.equal(el.innerHTML, "<g>bird</g>" + badge, "appends, never replaces the bird");
});
```

(The existing golden-hash test over `drawBird` must still pass unchanged — that is the "drawBird untouched" proof.)

- [ ] **Step 2: Write the failing core tests** — append to `tests/profile-avatar-bird.test.js` (add `portraitDay` to the import from `../servers/sharing/profile-avatar.js`, and `import { localDay } from "../bundles/ramble/server/eggs.js";`):

```js
const putWallet = (db, kind, key, delta = 1) => db.execute({
  sql: "INSERT INTO ramble_wallet (kind, key, delta, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(kind, key) DO NOTHING",
  args: [kind, key, delta, Date.now()],
});

test("portraitDay is exactly eggs.js's localDay (core keeps its own copy; this pins them)", () => {
  for (const t of [0, 1_760_000_000_000, 1_760_000_000_000 + 13 * 3_600_000, Date.UTC(2026, 11, 31, 23, 59), Date.UTC(2027, 2, 14, 7, 30)]) {
    assert.equal(portraitDay(t), localDay(t), String(t));
  }
});

test("readPortrait: walked comes ONLY from today's walked fact — a boolean, never a count", async () => {
  const db = createClient({ url: "file::memory:" });
  await plantBird(db, { eggId: "b1", species: "crow", seed: 2 });
  const now = Date.now();
  assert.equal((await readPortrait(db, { now })).walked, false);
  await putWallet(db, "walked", portraitDay(now - 86_400_000));
  assert.equal((await readPortrait(db, { now })).walked, false, "yesterday's walk is not today's badge");
  await putWallet(db, "steps", portraitDay(now) + ":eeeeeeee-0000-0000-0000-000000000000", 7777);
  let p = await readPortrait(db, { now });
  assert.equal(p.walked, false, "a step count alone never reaches the portrait");
  assert.ok(!JSON.stringify(p).includes("7777"));
  await putWallet(db, "walked", portraitDay(now));
  p = await readPortrait(db, { now });
  assert.equal(p.walked, true);
  assert.deepEqual(Object.keys(p).sort(), ["egg_id", "mood", "outfit", "seed", "species", "walked"]);
});

test("renderBirdAvatar: the badge only when walked, only with an engine that can draw it", () => {
  const full = loadBirdEngine();
  const plain = renderBirdAvatar({ species: "crow", seed: 2 });
  const walked = renderBirdAvatar({ species: "crow", seed: 2, walked: true });
  assert.notEqual(walked, plain);
  assert.ok(Buffer.from(walked.split(",")[1], "base64").toString("utf8").includes(full.drawWalkBadge()));
  assert.equal(renderBirdAvatar({ species: "crow", seed: 2, walked: "yes" }), plain, "strictly boolean");
  const oldEngine = { rollGenome: full.rollGenome, drawBird: full.drawBird, applyOutfit: full.applyOutfit };
  assert.equal(renderBirdAvatar({ species: "crow", seed: 2, walked: true }, oldEngine), plain, "an engine without the badge draws the plain bird");
});

test("gate: a walked flip repaints once; an unchanged day does not", async () => {
  const { db, cleanup } = freshDb();
  try {
    await seedContact(db);
    await plantBird(db, { eggId: "b1", species: "crow", seed: 2 });
    await putSetting(db, "profile_avatar_source", "bird");
    const sent = [];
    const m = mgrsWith(db, sent);
    assert.equal((await refreshBirdAvatar(db, m, { gate: true })).reason, "rendered");
    await putWallet(db, "walked", portraitDay(Date.now()));
    assert.equal((await refreshBirdAvatar(db, m, { gate: true })).reason, "rendered");
    assert.equal(await setting(db, "profile_avatar_url"), renderBirdAvatar({ species: "crow", seed: 2, walked: true }));
    assert.deepEqual(await refreshBirdAvatar(db, m, { gate: true }), { changed: false, reason: "inputs-same" });
    assert.equal(sent.length, 2);
  } finally { __resetBirdAvatarHooksForTest(); cleanup(); }
});

test("deploy day: a cached 0.13 engine (applyOutfit, no badge) is re-probed and picks up drawWalkBadge", async () => {
  __resetBirdAvatarHooksForTest();
  const dir = mkdtempSync(join(tmpdir(), "bird-engine-"));
  const prev = process.env.CROW_HOME;
  try {
    process.env.CROW_HOME = dir;
    const target = join(dir, "bundles", "ramble", "server", "bird-svg.cjs");
    mkdirSync(dirname(target), { recursive: true });
    // An "0.13" engine: the real one without the badge.
    writeFileSync(target, "const real = require(" + JSON.stringify(REPO_ENGINE) + "); module.exports = { rollGenome: real.rollGenome, drawBird: real.drawBird, applyOutfit: real.applyOutfit };");
    const T = 1_760_000_000_000;
    const old = loadBirdEngine({ now: T });
    assert.equal(typeof old.drawWalkBadge, "undefined");
    writeFileSync(target, readFileSync(REPO_ENGINE, "utf8")); // bundle repair copies 0.14 in
    assert.equal(loadBirdEngine({ now: T + 1000 }), old, "within the minute: still cached");
    const fresh = loadBirdEngine({ now: T + 61_000 });
    assert.equal(typeof fresh.drawWalkBadge, "function", "re-probed after one restart, no second restart needed");
    assert.equal(loadBirdEngine({ now: T + 200_000 }), fresh);
  } finally {
    if (prev === undefined) delete process.env.CROW_HOME; else process.env.CROW_HOME = prev;
    __resetBirdAvatarHooksForTest();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("installBirdAvatarHooks: ramble:walked-changed is a coalesced trigger like an outfit change", async () => {
  __resetBirdAvatarHooksForTest();
  const { db, cleanup } = freshDb();
  try {
    await seedContact(db);
    await plantBird(db, { eggId: "b1", species: "crow", seed: 2 });
    await putSetting(db, "profile_avatar_source", "bird");
    const sent = [];
    const emitter = new EventEmitter();
    installBirdAvatarHooks(mgrsWith(db, sent), { emitter, settleMs: 200, tickMs: 0 });
    await settle(db, "profile_avatar_url", renderBirdAvatar({ species: "crow", seed: 2 }));
    assert.equal(sent.length, 1, "boot repaint");
    await putWallet(db, "walked", portraitDay(Date.now()));
    emitter.emit("ramble:walked-changed", { day: portraitDay(Date.now()) });
    emitter.emit("ramble:walked-changed", { day: portraitDay(Date.now()) });
    const badged = renderBirdAvatar({ species: "crow", seed: 2, walked: true });
    await settle(db, "profile_avatar_url", badged);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(sent.length, 2, "one broadcast for the badge");
  } finally { __resetBirdAvatarHooksForTest(); cleanup(); }
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npm test -- tests/ramble-bird-svg.test.js tests/profile-avatar-bird.test.js`
Expected: FAIL — `Bird.drawWalkBadge is not a function`; `portraitDay` is not exported.

- [ ] **Step 4: The engine** — in `bundles/ramble/server/bird-svg.cjs`, add after `mountHeart` (ES5, no ESM syntax):

```js
  /* "Walked today" (spec 2026-10-04 §8): two footprints on a cream roundel in
   * the portrait's lower-right corner. A separate group, NOT part of drawBird,
   * so every existing portrait stays byte-identical and an engine that lacks
   * this simply draws no badge. Same ink as the egg's feet family. */
  function drawWalkBadge() {
    return '<g class="rb-walk-badge" transform="translate(152 152)">'
      + '<circle cx="18" cy="18" r="18" fill="#fff8e6" stroke="#2b2350" stroke-width="3"/>'
      + '<ellipse cx="12.5" cy="21" rx="4.2" ry="6.4" fill="#2b2350" transform="rotate(-14 12.5 21)"/>'
      + '<circle cx="11" cy="11.2" r="2.1" fill="#2b2350"/>'
      + '<ellipse cx="23.5" cy="17" rx="4.2" ry="6.4" fill="#2b2350" transform="rotate(14 23.5 17)"/>'
      + '<circle cx="25" cy="7.2" r="2.1" fill="#2b2350"/>'
      + '</g>';
  }
```

plus its mount helper (the markup sink stays inside the engine, like `mountBird`, so the panel's sink-count test is unchanged):

```js
  /* Appends the badge to an already-mounted portrait (call after mountBird). */
  function mountWalkBadge(el) { el.innerHTML = el.innerHTML + drawWalkBadge(); }
```

and add `drawWalkBadge: drawWalkBadge, mountWalkBadge: mountWalkBadge` to the returned API object (the `return { ROSTER: ROSTER, ... }` line).

- [ ] **Step 5: Core** — in `servers/sharing/profile-avatar.js`:

Add after `portraitMood`:

```js
/**
 * eggs.js's localDay, copied: core never imports the bundle (an installed copy
 * may be older or absent). tests/profile-avatar-bird.test.js pins the two.
 */
export function portraitDay(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
```

In `readPortrait`, before the `return`:

```js
  // Spec 2026-10-04 §8 / R11: contacts get ONE boolean from walking — the
  // `walked` fact the bundle writes — never a count.
  let walked = false;
  try {
    const { rows } = await db.execute({
      sql: "SELECT 1 FROM ramble_wallet WHERE kind = 'walked' AND key = ? LIMIT 1",
      args: [portraitDay(now)],
    });
    walked = rows.length > 0;
  } catch { walked = false; }
```

and change its return to `return { ...bird, mood, outfit, walked };`.

In `renderBirdAvatar`, replace the `const svg = ...` statement:

```js
    // An older installed engine has no badge: it draws the plain bird.
    const badge = bird.walked === true && typeof engine.drawWalkBadge === "function" ? engine.drawWalkBadge() : "";
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">'
      + engine.drawBird(genome, mood) + badge + "</svg>";
```

In `refreshBirdAvatar`, change the gate inputs line to:

```js
    const inputs = JSON.stringify([bird.species, bird.seed, bird.mood, bird.outfit || {}, bird.walked === true]);
```

In `loadBirdEngine`, widen the deploy-day re-probe so a cached 0.13 engine (which HAS `applyOutfit` but lacks the badge) is also re-probed — otherwise a normal single-restart deploy (auto-update) caches the old installed engine before bundle repair copies 0.14.0 in, and the badge never reaches contacts until a second restart:

```js
    const stale = _engine && (typeof _engine.applyOutfit !== "function" || typeof _engine.drawWalkBadge !== "function")
      && now - _engineProbedAt >= ENGINE_REPROBE_MS;
```

and extend the comment above `ENGINE_REPROBE_MS` to say "an engine without applyOutfit or drawWalkBadge".

In `installBirdAvatarHooks`, add next to the other `emitter.on` lines:

```js
  emitter.on("ramble:walked-changed", onEvent);
```

Update the doc comment above `installBirdAvatarHooks` to say the tick also clears the badge after local midnight (within one tick).

- [ ] **Step 6: Run to verify pass**

Run: `npm test -- tests/ramble-bird-svg.test.js tests/profile-avatar-bird.test.js tests/ramble-header-bird.test.js`
Expected: PASS, including the pre-existing golden-hash and "defaults are byte-identical" tests.

- [ ] **Step 7: Commit**

```bash
git commit bundles/ramble/server/bird-svg.cjs servers/sharing/profile-avatar.js tests/ramble-bird-svg.test.js tests/profile-avatar-bird.test.js -m "feat(ramble,sharing): the walked-today badge — engine art, a boolean in the portrait inputs, coalesced repaint"
git show --stat HEAD
```

---

### Task 6: The evening nudge — decision (bundle) + scheduler (core)

**Files:**
- Modify: `bundles/ramble/server/steps.js` (append)
- Create: `servers/gateway/boot/ramble-nudge.js`
- Modify: `servers/gateway/boot/feature-mounts.js` (after the Ramble transport block, before `// --- Mount AI Chat Routes ---`)
- Test: `tests/ramble-steps-nudge.test.js` (create)

**Interfaces:**
- Consumes: Task 1–2 exports; `installedRambleServerDir(crowHome)` from `servers/gateway/boot/ramble-boot.js`; `createNotification(db, opts)` from `servers/shared/notifications.js`; `readSetting(db, key)` from `servers/gateway/dashboard/settings/registry.js`; `emitOrQueue` from `servers/shared/sync-emit.js`.
- Produces: `steps.js`: `nudgeDecision(db, {now}) → {send: boolean, reason, day?, variant?: "low"|"unseen"}`; `STALE_READING_MS` (3 h) with `reason ∈ "off"|"weekend"|"hour"|"not-home"|"already"|"not-engaged"|"walked"|"on-track"|"due"`; `markNudged(db, day, {now, emit}) → boolean`; `NUDGE_TEXT` (`{en|es: {low|unseen: {title, body}}}`), `nudgeText(lang, variant = "low") → {title, body}`; `HOME_WINDOW_MS`, `ENGAGED_WINDOW_MS`. `ramble-nudge.js`: `NUDGE_TICK_MS = 600000`; `startRambleNudge({db, serverDir, notify, emit, readLang, intervalMs, clock, load, autoStart}) → {tick(): Promise<{sent, reason}>, stop()}`.

- [ ] **Step 1: Write the failing tests** — create `tests/ramble-steps-nudge.test.js`:

```js
/**
 * Spec 2026-10-04 §9: one gentle evening nudge, at most once a day, only to a
 * player who walks with Ramble, only from their "steps home" instance.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import { applyRambleWallet } from "../servers/sharing/instance-sync.js";
import { localDay, startOfLocalDay } from "../bundles/ramble/server/eggs.js";
import * as steps from "../bundles/ramble/server/steps.js";
import { startRambleNudge, NUDGE_TICK_MS } from "../servers/gateway/boot/ramble-nudge.js";

const { nudgeDecision, markNudged, nudgeText, NUDGE_TEXT, touchHome, recordWalkCheckin, HOME_WINDOW_MS } = steps;
const H = 3_600_000;
// A local Wednesday and the Saturday after it, whatever the test machine's timezone.
function localDayOf(weekday) {
  let t = startOfLocalDay(Date.UTC(2026, 9, 7, 12));
  while (new Date(t).getDay() !== weekday) t = startOfLocalDay(t + 26 * H);
  return t;
}
const WED = localDayOf(3);
const SAT = localDayOf(6);
const at = (day, h, m = 0) => day + h * H + m * 60_000;

async function engagedDb(day = WED) {
  const db = createClient({ url: "file::memory:" });
  await initRambleTables(db);
  // Walked yesterday (engaged), opened the pet page this morning (home), nothing yet today.
  await db.execute({
    sql: "INSERT INTO ramble_wallet (kind, key, delta, created_at) VALUES ('steps', ?, 4000, ?)",
    args: [`${localDay(day - 12 * H)}:aaaaaaaa-0000-0000-0000-000000000001`, day - 12 * H],
  });
  await touchHome(db, { now: at(day, 8) });
  return db;
}
const set = (db, key, value) => db.execute({ sql: "INSERT INTO ramble_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", args: [key, String(value)] });

test("due at 18:00 on a weekday for an engaged player at home who has not walked", async () => {
  const db = await engagedDb();
  assert.deepEqual(await nudgeDecision(db, { now: at(WED, 18, 5) }), { send: true, reason: "due", day: localDay(at(WED, 18)), variant: "low" });
});

test("a counter player whose last reading is hours old gets the 'show me' nudge, never 'you haven't walked'", async () => {
  const db = await engagedDb();
  await db.execute({
    sql: "INSERT INTO ramble_step_devices (device_id, boot_count, last_counter, last_read_at, created_at) VALUES ('aaaaaaaa-0000-0000-0000-000000000001', 1, 100, ?, ?)",
    args: [at(WED, 12), at(WED, 12)],
  });
  assert.equal((await nudgeDecision(db, { now: at(WED, 18, 5) })).variant, "unseen", "6 h since the last reading");
  await db.execute({ sql: "UPDATE ramble_step_devices SET last_read_at = ?", args: [at(WED, 17)] });
  assert.equal((await nudgeDecision(db, { now: at(WED, 18, 5) })).variant, "low", "a fresh reading: the count is real");
});

test("each condition blocks on its own", async () => {
  let db = await engagedDb();
  assert.equal((await nudgeDecision(db, { now: at(WED, 17, 59) })).reason, "hour");
  assert.equal((await nudgeDecision(db, { now: at(WED, 21, 0) })).reason, "hour", "a gateway booting late stays quiet");
  await set(db, "steps.nudge", "0");
  assert.equal((await nudgeDecision(db, { now: at(WED, 18, 5) })).reason, "off");

  db = await engagedDb(SAT);
  assert.equal((await nudgeDecision(db, { now: at(SAT, 18, 5) })).send, true, "weekends on by default");
  await set(db, "steps.nudge.weekends", "0");
  assert.equal((await nudgeDecision(db, { now: at(SAT, 18, 5) })).reason, "weekend");

  db = await engagedDb();
  await set(db, steps.HOME_KEY, String(at(WED, 18) - HOME_WINDOW_MS - 1));
  assert.equal((await nudgeDecision(db, { now: at(WED, 18, 5) })).reason, "not-home");

  db = createClient({ url: "file::memory:" });
  await initRambleTables(db);
  await touchHome(db, { now: at(WED, 8) });
  assert.equal((await nudgeDecision(db, { now: at(WED, 18, 5) })).reason, "not-engaged");

  db = await engagedDb();
  await recordWalkCheckin(db, { now: at(WED, 12) });
  assert.equal((await nudgeDecision(db, { now: at(WED, 18, 5) })).reason, "walked");

  db = await engagedDb();
  await db.execute({ sql: "INSERT INTO ramble_wallet (kind, key, delta, created_at) VALUES ('steps', ?, 3000, ?)", args: [`${localDay(at(WED, 12))}:aaaaaaaa-0000-0000-0000-000000000001`, at(WED, 12)] });
  assert.equal((await nudgeDecision(db, { now: at(WED, 18, 5) })).reason, "on-track", "half the goal is on track");
});

test("markNudged is at-most-once, and a nudge row arriving by sync silences this instance", async () => {
  const A = await engagedDb(), B = await engagedDb();
  const ops = [];
  const day = localDay(at(WED, 18));
  assert.equal(await markNudged(A, day, { now: at(WED, 18, 1), emit: async (t, o, r) => ops.push({ t, o, r }) }), true);
  assert.equal(await markNudged(A, day, { now: at(WED, 18, 2) }), false);
  assert.equal((await nudgeDecision(A, { now: at(WED, 18, 15) })).reason, "already");
  for (const { o, r } of ops) await applyRambleWallet(B, o, r, 5000);
  assert.equal((await nudgeDecision(B, { now: at(WED, 18, 15) })).reason, "already");
});

test("nudgeText: en and es, both variants, no numbers, unknowns fall back", () => {
  assert.deepEqual(Object.keys(NUDGE_TEXT).sort(), ["en", "es"]);
  for (const lang of ["en", "es"]) {
    for (const variant of ["low", "unseen"]) {
      const t = nudgeText(lang, variant);
      assert.ok(t.title.length > 0 && t.body.length > 0);
      assert.ok(!/\d/.test(t.title + t.body), "lock screens are public: no counts");
    }
    assert.notEqual(nudgeText(lang, "unseen").body, nudgeText(lang, "low").body);
  }
  assert.notEqual(nudgeText("es").title, nudgeText("en").title);
  assert.deepEqual(nudgeText("fr"), nudgeText("en", "low"));
  assert.deepEqual(nudgeText("__proto__"), nudgeText("en"));
  assert.deepEqual(nudgeText("en", "constructor"), nudgeText("en", "low"));
});

test("startRambleNudge: sends once across repeated ticks, in the dashboard language, as a reminder", async () => {
  const db = await engagedDb();
  const sent = [];
  let now = at(WED, 18, 5);
  const n = startRambleNudge({
    db, serverDir: "unused", autoStart: false, clock: () => now,
    load: async () => steps,
    notify: async (d, opts) => { sent.push(opts); return { id: 1 }; },
    readLang: async () => "es",
  });
  assert.deepEqual(await n.tick(), { sent: true, reason: "due" });
  now += 10 * 60_000;
  assert.deepEqual(await n.tick(), { sent: false, reason: "already" });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    title: nudgeText("es").title, body: nudgeText("es").body, type: "reminder", source: "ramble:steps",
    priority: "normal", action_url: "/dashboard/ramble", expires_in_minutes: 360,
  });
  n.stop();
});

test("startRambleNudge: never throws out of a tick — a missing bundle module, a failing notify, a busy tick", async () => {
  const warn = console.warn; console.warn = () => {};
  try {
    const missing = startRambleNudge({ db: null, serverDir: "/nope", autoStart: false, load: async () => { throw new Error("no module"); }, notify: async () => {} });
    assert.deepEqual(await missing.tick(), { sent: false, reason: "no-module" });
    assert.deepEqual(await missing.tick(), { sent: false, reason: "no-module" }, "and keeps saying so quietly");
    const db = await engagedDb();
    const failing = startRambleNudge({ db, serverDir: "x", autoStart: false, clock: () => at(WED, 18, 5), load: async () => steps, notify: async () => { throw new Error("push down"); } });
    assert.deepEqual(await failing.tick(), { sent: false, reason: "error" });
    let release;
    const gate = new Promise((r) => { release = r; });
    const slow = startRambleNudge({ db: await engagedDb(), serverDir: "x", autoStart: false, clock: () => at(WED, 18, 5), load: async () => { await gate; return steps; }, notify: async () => {} });
    const first = slow.tick();
    assert.deepEqual(await slow.tick(), { sent: false, reason: "busy" });
    release();
    await first;
  } finally { console.warn = warn; }
  assert.equal(NUDGE_TICK_MS, 600_000);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- tests/ramble-steps-nudge.test.js`
Expected: FAIL — `Cannot find module '../servers/gateway/boot/ramble-nudge.js'`.

- [ ] **Step 3: Append the decision to `steps.js`**

```js
export const HOME_WINDOW_MS = 3 * 24 * 3600 * 1000;
export const ENGAGED_WINDOW_MS = 7 * 24 * 3600 * 1000;

/** A counter reading older than this means the server may simply not have SEEN today's walk. */
export const STALE_READING_MS = 3 * 3600 * 1000;

/**
 * The bird's voice. No numbers: a lock screen is public. (R10: en/es.)
 * `low`    — the count is fresh and really is under half the goal.
 * `unseen` — this player counts steps with the app, but no reading has
 *            arrived for hours: they may well have walked. Ask to be shown,
 *            never imply they did not walk (S1: never punish).
 */
export const NUDGE_TEXT = Object.freeze({
  en: Object.freeze({
    low: Object.freeze({ title: "Your bird is by the door", body: "A short walk would cheer you both up." }),
    unseen: Object.freeze({ title: "Your bird wants to hear about your day", body: "Open Ramble so it can count today's steps, or take a short walk together." }),
  }),
  es: Object.freeze({
    low: Object.freeze({ title: "Tu pájaro te espera en la puerta", body: "Una caminata corta los alegraría a los dos." }),
    unseen: Object.freeze({ title: "Tu pájaro quiere saber de tu día", body: "Abre Ramble para que cuente los pasos de hoy, o den juntos una caminata corta." }),
  }),
});
export function nudgeText(lang, variant = "low") {
  const set = Object.hasOwn(NUDGE_TEXT, lang) ? NUDGE_TEXT[lang] : NUDGE_TEXT.en;
  return Object.hasOwn(set, variant) ? set[variant] : set.low;
}

/**
 * Should THIS instance nudge now (spec §9)? Every condition must hold; the
 * first that fails is the reason. Read-only.
 */
export async function nudgeDecision(db, { now = Date.now() } = {}) {
  const s = await readStepSettings(db);
  if (!s.nudge) return { send: false, reason: "off" };
  const d = new Date(now);
  const dow = d.getDay();
  if (!s.nudgeWeekends && (dow === 0 || dow === 6)) return { send: false, reason: "weekend" };
  const hour = d.getHours();
  if (hour < s.nudgeHour || hour >= s.nudgeUntil) return { send: false, reason: "hour" };
  const { rows: home } = await db.execute({ sql: "SELECT value FROM ramble_settings WHERE key = ?", args: [HOME_KEY] });
  const seen = Number(home[0]?.value);
  if (!Number.isFinite(seen) || now - seen > HOME_WINDOW_MS) return { send: false, reason: "not-home" };
  const day = localDay(now);
  if ((await rowDelta(db, NUDGE_KIND, day)) !== null) return { send: false, reason: "already" };
  // Engagement by the DAY KEY, not created_at: applyRambleWallet merges
  // created_at to the MIN of two instances' values, so it is not a reliable
  // clock (eggs.js warns against ordering by it). Keys are YYYY-MM-DD[:dev],
  // so a string compare against the window's first day is exact.
  const since = localDay(now - ENGAGED_WINDOW_MS);
  const { rows: used } = await db.execute({
    sql: "SELECT 1 FROM ramble_wallet WHERE kind IN (?, ?) AND key >= ? LIMIT 1",
    args: [STEPS_KIND, WALK_CHECKIN_KIND, since],
  });
  if (!used.length) return { send: false, reason: "not-engaged" };
  if ((await rowDelta(db, WALK_CHECKIN_KIND, day)) !== null) return { send: false, reason: "walked" };
  const steps = await stepsToday(db, now, s);
  if (steps * 100 >= s.goal * s.nudgeBelow) return { send: false, reason: "on-track" };
  // Steps only arrive when the panel is opened. A counter player whose last
  // reading on THIS instance is hours old may have walked plenty: ask to be
  // shown rather than say "you haven't walked".
  const { rows: dev } = await db.execute({ sql: "SELECT MAX(last_read_at) AS t FROM ramble_step_devices", args: [] });
  const lastRead = Number(dev[0]?.t);
  const variant = Number.isFinite(lastRead) && lastRead > 0 && now - lastRead > STALE_READING_MS ? "unseen" : "low";
  return { send: true, reason: "due", day, variant };
}

/** Claim today's nudge BEFORE sending. True only for the claim that created the row. */
export async function markNudged(db, day, { now = Date.now(), emit } = {}) {
  return insertOnce(db, NUDGE_KIND, day, 1, now, emit);
}
```

- [ ] **Step 4: Create `servers/gateway/boot/ramble-nudge.js`**

```js
/**
 * boot/ramble-nudge.js — the Ramble evening walk nudge (spec
 * 2026-10-04-ramble-steps-design.md §9).
 *
 * Core, not bundle, because it needs a timer in the long-lived gateway and the
 * gateway's notification fan-out (createNotification -> web push + this
 * instance's ntfy topic). The DECISION lives in the installed bundle's
 * server/steps.js, imported by path so core never hard-depends on a bundle
 * that may be absent or older. Started only where Ramble is INSTALLED.
 *
 * At most one nudge per day per instance by construction: markNudged() writes
 * the replicated `nudge` row BEFORE the send and only the call that created it
 * sends. Nothing here may throw out of the timer.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const NUDGE_TICK_MS = 10 * 60 * 1000;

export function startRambleNudge({
  db,
  serverDir,
  notify,
  emit,
  readLang = async () => "en",
  intervalMs = NUDGE_TICK_MS,
  clock = () => Date.now(),
  load = (dir) => import(pathToFileURL(join(dir, "steps.js")).href),
  autoStart = true,
}) {
  let mod = null;
  let busy = false;
  let warnedLoad = false;
  let timer = null;

  async function tick() {
    if (busy) return { sent: false, reason: "busy" };
    busy = true;
    try {
      if (!mod) {
        try { mod = await load(serverDir); }
        catch (err) {
          // An installed bundle older than 0.14.0 has no steps.js: say so once.
          if (!warnedLoad) { warnedLoad = true; try { console.warn("[ramble] walk nudge: steps module unavailable:", err?.message ?? err); } catch {} }
          return { sent: false, reason: "no-module" };
        }
      }
      const now = clock();
      const d = await mod.nudgeDecision(db, { now });
      if (!d.send) return { sent: false, reason: d.reason };
      if (!(await mod.markNudged(db, d.day, { now, emit }))) return { sent: false, reason: "already" };
      let lang = "en";
      try { lang = (await readLang(db)) || "en"; } catch { lang = "en"; }
      const { title, body } = mod.nudgeText(lang, d.variant || "low");
      await notify(db, {
        title, body, type: "reminder", source: "ramble:steps", priority: "normal",
        action_url: "/dashboard/ramble", expires_in_minutes: 360,
      });
      return { sent: true, reason: "due" };
    } catch (err) {
      try { console.warn("[ramble] walk nudge tick failed:", err?.message ?? err); } catch {}
      return { sent: false, reason: "error" };
    } finally {
      busy = false;
    }
  }

  if (autoStart) {
    timer = setInterval(() => { tick().catch(() => {}); }, intervalMs);
    timer.unref?.();
  }
  return {
    tick,
    stop() { if (timer) { clearInterval(timer); timer = null; } },
  };
}
```

- [ ] **Step 5: Wire it in `feature-mounts.js`** — directly after the Ramble transport `try { ... } catch (err) { console.warn("[ramble] transport not started:" ... }` block and before `// --- Mount AI Chat Routes ---`:

```js
  // --- Ramble evening walk nudge (spec 2026-10-04 §9) ---
  // Independent of the Nostr transport: a Crow with sharing off still nudges.
  // Only where the Ramble bundle is INSTALLED (same rule as the transport).
  try {
    const { join } = await import("node:path");
    const { homedir } = await import("node:os");
    const crowHome = process.env.CROW_HOME || join(homedir(), ".crow");
    const { installedRambleServerDir } = await import("./ramble-boot.js");
    const serverDir = installedRambleServerDir(crowHome);
    const { getManagersOrNull, getInstanceSyncManager } = await import("../../sharing/managers.js");
    const mgrs = getManagersOrNull();
    if (serverDir && mgrs?.db) {
      const { startRambleNudge } = await import("./ramble-nudge.js");
      const { createNotification } = await import("../../shared/notifications.js");
      const { emitOrQueue } = await import("../../shared/sync-emit.js");
      const { readSetting } = await import("../dashboard/settings/registry.js");
      const emit = (table, op, row) =>
        emitOrQueue(getInstanceSyncManager(), mgrs.db, table, op, row).catch(() => {});
      app.locals.rambleNudge = startRambleNudge({
        db: mgrs.db,
        serverDir,
        notify: createNotification,
        emit,
        readLang: (db) => readSetting(db, "language"),
      });
      console.log("[ramble] walk nudge scheduler started");
    }
  } catch (err) {
    console.warn("[ramble] walk nudge not started:", err?.message ?? err);
  }
```

Before writing, confirm the three relative paths resolve from `servers/gateway/boot/`: `ls servers/shared/notifications.js servers/shared/sync-emit.js servers/gateway/dashboard/settings/registry.js`. Confirm `app` is the express app variable in scope at that point of `feature-mounts.js` (the transport block above uses `app.locals.rambleTransport`).

- [ ] **Step 6: Run to verify pass**

Run: `npm test -- tests/ramble-steps-nudge.test.js tests/ramble-boot.test.js tests/ramble-steps.test.js`
Then the boot smoke: `node servers/gateway/index.js --no-auth` in a scratch env is NOT safe on crow (it would bind the live port and DB). Instead rely on the suite plus `node --check servers/gateway/boot/feature-mounts.js servers/gateway/boot/ramble-nudge.js`.
Expected: PASS; `node --check` prints nothing.

- [ ] **Step 7: Commit**

```bash
git add servers/gateway/boot/ramble-nudge.js tests/ramble-steps-nudge.test.js
git commit bundles/ramble/server/steps.js servers/gateway/boot/ramble-nudge.js servers/gateway/boot/feature-mounts.js tests/ramble-steps-nudge.test.js -m "feat(ramble): one gentle evening walk nudge — bundle decision, core scheduler, at most once a day"
git show --stat HEAD
```

---

### Task 7: The panel — walking card, bridge wrapper, badge on the pet

**Files:**
- Modify: `bundles/ramble/panel/ramble.js` (pet view markup + one "runs on" line)
- Modify: `bundles/ramble/panel/static/ramble.js` (walking block right after `jsonFetch`; `showView`; `paintPet`)
- Modify: `bundles/ramble/panel/static/ramble.css`
- Test: `tests/ramble-panel.test.js` (append)

**Interfaces:**
- Consumes: Task 4 HTTP API; Task 5 `Bird.mountWalkBadge`; Task 8's native bridge contract — `window.Crow.stepsStatus() → "ok"|"needs-permission"|"denied"|"no-sensor"`, `window.Crow.requestStepsPermission(id)`, `window.Crow.readSteps(id)`, `window.Crow.openAppSettings()`, results delivered as `window.CrowSteps.deliver(id, payload)`.
- Produces: global `window.CrowSteps.deliver(id, payload)`; pure functions `nativeStepsMode()`, `stepsLabel(n)`, `walkCardState(mode, state)` (extractable by `extractFunction`).

- [ ] **Step 1: Write the failing tests** — append to `tests/ramble-panel.test.js` (it already defines `extractFunction`, `REPO_ROOT_FOR_PANEL`, `readFileSync`, `join`):

```js
const STATIC_SRC = () => readFileSync(join(REPO_ROOT_FOR_PANEL, "bundles/ramble/panel/static/ramble.js"), "utf8");

test("walking: nativeStepsMode tells the browser, an old app and every app state apart", () => {
  const src = extractFunction(STATIC_SRC(), "nativeStepsMode");
  const mode = (win) => new Function("window", src + "\nreturn nativeStepsMode();")(win);
  assert.equal(mode({}), "web");
  assert.equal(mode({ Crow: { appVersion() { return "1.5.2"; } } }), "old-app");
  for (const st of ["ok", "needs-permission", "denied", "no-sensor"]) {
    const want = st === "ok" ? "counter" : st === "needs-permission" ? "permission" : st;
    assert.equal(mode({ Crow: { readSteps() {}, stepsStatus() { return st; } } }), want);
  }
  assert.equal(mode({ Crow: { readSteps() {}, stepsStatus() { throw new Error("bridge gone"); } } }), "old-app");
  assert.equal(mode({ Crow: { readSteps() {}, stepsStatus() { return "weird"; } } }), "no-sensor");
});

test("walking: stepsLabel groups thousands and never shows junk", () => {
  const stepsLabel = new Function(extractFunction(STATIC_SRC(), "stepsLabel") + "\nreturn stepsLabel;")();
  assert.deepEqual([0, 999, 1000, 6000, 12345, 40000].map(stepsLabel), ["0", "999", "1,000", "6,000", "12,345", "40,000"]);
  assert.deepEqual([-5, NaN, undefined, "x", 1.9].map(stepsLabel), ["0", "0", "0", "0", "1"]);
});

test("walking: walkCardState — what each kind of player sees", () => {
  const src = STATIC_SRC();
  const walkCardState = new Function(extractFunction(src, "stepsLabel") + "\n" + extractFunction(src, "walkCardState") + "\nreturn walkCardState;")();
  const day = { goal: 6000, steps: 0, checked_in: false, goal_met: false, seed_today: 0 };
  let v = walkCardState("counter", { ...day, steps: 2400 });
  assert.deepEqual([v.showMeter, v.pct, v.allow, v.manual, v.settings], [true, 40, false, false, false]);
  assert.equal(v.line, "3,600 to go today.");
  v = walkCardState("counter", { ...day, steps: 0 });
  assert.match(v.line, /^Counting from now/);
  v = walkCardState("counter", { ...day, steps: 6100, goal_met: true, seed_today: 3 });
  assert.deepEqual([v.pct, v.line], [100, "Goal reached. Your bird is glowing (+3 seed)."]);
  v = walkCardState("permission", day);
  assert.deepEqual([v.allow, v.manual, v.settings, v.showMeter], [true, true, false, false]);
  v = walkCardState("denied", day);
  assert.deepEqual([v.allow, v.manual, v.settings], [false, true, true]);
  for (const m of ["no-sensor", "old-app", "web"]) {
    v = walkCardState(m, day);
    assert.deepEqual([v.allow, v.manual, v.settings, v.showMeter], [false, true, false, false], m);
    assert.ok(v.line.length > 0, m);
  }
  v = walkCardState("web", { ...day, steps: 3000 });
  assert.equal(v.showMeter, true, "steps counted on another device today still show");
  v = walkCardState("web", { ...day, checked_in: true });
  assert.deepEqual([v.manualDone, v.line], [true, "Marked as walked today. Your bird noticed."]);
  v = walkCardState("counter", null);
  assert.equal(v.showMeter, true, "no state yet: draws an empty meter, never throws");
});

test("walking: the card is on the pet view, says contacts never see a count, and adds no template syntax", () => {
  const html = readFileSync(join(REPO_ROOT_FOR_PANEL, "bundles/ramble/panel/ramble.js"), "utf8");
  const start = html.indexOf('<section class="rb-card" id="rb-walk">');
  assert.ok(start > html.indexOf('data-for="pet"'), "inside the pet view");
  const block = html.slice(start, html.indexOf("</section>", start));
  for (const id of ["rb-walk-meter", "rb-walk-fill", "rb-walk-num", "rb-walk-goal", "rb-walk-line", "rb-walk-allow",
    "rb-walk-open-settings", "rb-walk-checkin", "rb-walk-prefs", "rb-walk-goal-down", "rb-walk-goal-val", "rb-walk-goal-up",
    "rb-walk-nudge", "rb-walk-weekends", "rb-walk-status"]) {
    assert.ok(block.includes(`id="${id}"`), id);
  }
  assert.ok(/never your step count/.test(block));
  assert.ok(!block.includes("`") && !block.includes("${"), "no template syntax in the template literal");
  assert.ok(!/<svg[^>]*\shidden/.test(block), "hidden is dead on <svg>");
  assert.ok(/Walk toward your goal/.test(html), "the runs-on list names walking");
});

test("walking: static/ramble.js still has zero backticks and exposes the bridge callback", () => {
  const src = STATIC_SRC();
  assert.equal((src.match(/`/g) || []).length, 0);
  assert.ok(src.includes("window.CrowSteps.deliver = function"));
  assert.ok(/if \(name === "pet"\) refreshWalk\(false\);/.test(src), "switching to the pet reads steps");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test -- tests/ramble-panel.test.js`
Expected: FAIL — `extractFunction` returns null for `nativeStepsMode`; the markup ids are missing.

- [ ] **Step 3: Markup** — in `bundles/ramble/panel/ramble.js`, in the pet view, insert directly AFTER the "Today" chores `</section>` and BEFORE `<details class="rb-card rb-fold" id="rb-runs-on" open>`:

```html
          <section class="rb-card" id="rb-walk">
            <p class="rb-eyebrow">Walking</p>
            <div class="rb-meter" id="rb-walk-meter" hidden>
              <strong class="rb-meter-label">Steps</strong>
              <span class="rb-meter-bar"><i id="rb-walk-fill"></i></span>
              <strong id="rb-walk-num">0</strong><span class="rb-meter-of">/ <span id="rb-walk-goal">6,000</span></span>
            </div>
            <p class="rb-muted rb-fine" id="rb-walk-line">A walk a day keeps your bird bright.</p>
            <div class="rb-row rb-walk-actions">
              <button class="rb-btn" id="rb-walk-allow" type="button" hidden>Count my steps</button>
              <button class="rb-btn rb-btn-ghost" id="rb-walk-open-settings" type="button" hidden>Open Android settings</button>
              <button class="rb-btn" id="rb-walk-checkin" type="button" hidden>I walked today</button>
            </div>
            <p class="rb-muted rb-fine">Contacts see a little &ldquo;walked today&rdquo; mark on your bird &mdash; never your step count.</p>
            <details class="rb-fold" id="rb-walk-prefs">
              <summary class="rb-fine rb-fold-sum">Goal and reminders</summary>
              <div class="rb-row rb-walk-goal-row">
                <button class="rb-btn rb-btn-ghost" id="rb-walk-goal-down" type="button" aria-label="Lower the daily goal">&minus;</button>
                <strong id="rb-walk-goal-val">6,000</strong><span class="rb-muted rb-fine">steps a day</span>
                <button class="rb-btn rb-btn-ghost" id="rb-walk-goal-up" type="button" aria-label="Raise the daily goal">+</button>
              </div>
              <label class="rb-fine rb-walk-toggle"><input type="checkbox" id="rb-walk-nudge"> An evening nudge if I haven&rsquo;t walked</label>
              <label class="rb-fine rb-walk-toggle"><input type="checkbox" id="rb-walk-weekends"> &hellip;on weekends too</label>
            </details>
            <p class="rb-muted rb-fine" id="rb-walk-status"></p>
          </section>
```

In the "What your bird runs on" list, insert a new first `rb-step` (before "Meet another crow"):

```html
              <div class="rb-step">
                <span class="rb-step-n">+30</span>
                <div class="rb-step-txt"><strong>Walk toward your goal</strong><span class="rb-muted rb-fine">a little as you go, all of it at your daily goal</span></div>
              </div>
```

- [ ] **Step 4: Client** — in `bundles/ramble/panel/static/ramble.js`:

(a) Update the header comment's innerHTML sentence to: "The one innerHTML path is the engine's own mount helpers (RambleBird.mountBird, RambleBird.mountWalkBadge), which write markup this page's own engine generated -- never anybody's text." The markup-sink count test (`tests/ramble-panel.test.js` ~line 858, exactly two sinks) and the "no `.hidden =` anywhere" test (~line 867) must stay green: this block uses `setHidden(el, on)` (defined near the top of the file) for every show/hide and adds NO `.innerHTML =` of its own — the badge goes in through the engine's `mountWalkBadge`, exactly as the bird goes in through `mountBird`.

(b) Insert this block immediately AFTER the closing `}` of `function jsonFetch(...)` (so its `var`s are initialised before any view switch can call `refreshWalk`):

```js
  /* -------------------------------------------------------------- walking
   * Spec 2026-10-04. Inside the Crow Android app (1.6.0+) window.Crow can read
   * the phone's hardware step counter; the server does all the arithmetic.
   * Everywhere else the card offers a one-tap "I walked today". */

  var walkReqs = {};
  var walkSeq = 0;
  var walkLastRead = 0;
  var walkInFlight = null;
  var walkState = null;
  window.CrowSteps = window.CrowSteps || {};
  window.CrowSteps.deliver = function (id, payload) {
    var cb = walkReqs[id];
    if (!cb) return;
    delete walkReqs[id];
    cb(payload);
  };

  function nativeStepsMode() {
    var c = window.Crow;
    if (!c) return "web";
    if (typeof c.readSteps !== "function" || typeof c.stepsStatus !== "function") return "old-app";
    var st = "";
    try { st = String(c.stepsStatus()); } catch (e) { return "old-app"; }
    if (st === "ok") return "counter";
    if (st === "needs-permission") return "permission";
    if (st === "denied") return "denied";
    return "no-sensor";
  }

  function stepsLabel(n) {
    var v = Math.floor(Number(n));
    if (!isFinite(v) || v < 0) v = 0;
    return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  function walkCardState(mode, st) {
    var s = st || {};
    var goal = Number(s.goal) > 0 ? Number(s.goal) : 6000;
    var steps = Math.max(0, Number(s.steps) || 0);
    var out = { showMeter: false, pct: 0, allow: false, settings: false, manual: false, manualDone: !!s.checked_in, line: "" };
    if (mode === "counter" || steps > 0) {
      out.showMeter = true;
      out.pct = Math.min(100, Math.round(steps * 100 / goal));
    }
    if (mode === "counter") {
      if (s.goal_met) out.line = "Goal reached. Your bird is glowing" + (Number(s.seed_today) > 0 ? " (+" + Number(s.seed_today) + " seed)." : ".");
      else if (steps === 0) out.line = "Counting from now. A walk a day keeps your bird bright.";
      else out.line = stepsLabel(goal - steps) + " to go today.";
    } else if (mode === "permission") {
      out.allow = true; out.manual = true;
      out.line = "Let Crow count your steps, and your walks feed your bird.";
    } else if (mode === "denied") {
      out.settings = true; out.manual = true;
      out.line = "Step counting is off. Allow Physical activity for Crow in Android settings, or tap when you’ve walked.";
    } else if (mode === "no-sensor") {
      out.manual = true;
      out.line = "This phone can’t count steps. Tap when you’ve been out walking.";
    } else if (mode === "old-app") {
      out.manual = true;
      out.line = "Update the Crow app to count steps. Until then, tap when you’ve walked.";
    } else {
      out.manual = true;
      out.line = "Steps are counted in the Crow Android app. Here, tap when you’ve walked.";
    }
    if (out.manual && out.manualDone) out.line = "Marked as walked today. Your bird noticed.";
    return out;
  }

  /* The permission prompt waits on a human, so it gets minutes, not seconds;
   * a read gets 8 s (native gives up at 4 s). A late delivery after a timeout
   * is dropped, and the visibilitychange repaint (the prompt pauses the
   * WebView) catches the outcome anyway. */
  function callNative(method, timeoutMs) {
    return new Promise(function (resolve) {
      var id = "s" + (++walkSeq);
      var settled = false;
      walkReqs[id] = function (p) { settled = true; resolve(p || null); };
      setTimeout(function () {
        if (settled) return;
        delete walkReqs[id];
        resolve({ ok: false, reason: "timeout" });
      }, timeoutMs || 8000);
      try { window.Crow[method](id); }
      catch (e) { delete walkReqs[id]; settled = true; resolve({ ok: false, reason: "bridge" }); }
    });
  }

  function paintWalk(st) {
    if (!st) return;
    walkState = st;
    var v = walkCardState(nativeStepsMode(), st);
    setHidden($("rb-walk-meter"), !v.showMeter);
    var fill = $("rb-walk-fill");
    if (fill) fill.style.width = v.pct + "%";
    setText($("rb-walk-num"), stepsLabel(st.steps));
    setText($("rb-walk-goal"), stepsLabel(st.goal));
    setText($("rb-walk-goal-val"), stepsLabel(st.goal));
    setText($("rb-walk-line"), v.line);
    setHidden($("rb-walk-allow"), !v.allow);
    setHidden($("rb-walk-open-settings"), !v.settings);
    var check = $("rb-walk-checkin");
    setHidden(check, !v.manual);
    if (check) {
      check.disabled = v.manualDone;
      check.textContent = v.manualDone ? "Walked today" : "I walked today";
    }
    var prefs = st.settings || {};
    var nudge = $("rb-walk-nudge");
    if (nudge) nudge.checked = prefs.nudge !== false;
    var weekends = $("rb-walk-weekends");
    if (weekends) { weekends.checked = prefs.nudge_weekends !== false; weekends.disabled = prefs.nudge === false; }
  }

  /** Read the counter (at most once a minute, one at a time) and send it; resolves with the day or null. */
  function sendStepReading(force) {
    if (nativeStepsMode() !== "counter") return Promise.resolve(null);
    if (!force && Date.now() - walkLastRead < 60000) return Promise.resolve(null);
    walkLastRead = Date.now();
    return callNative("readSteps").then(function (p) {
      if (!p || !p.ok) {
        /* Some phones deliver the first sensor event late; say so, quietly. */
        if (p && p.reason === "timeout") setText($("rb-walk-status"), "Couldn\u2019t read the step counter just now. It will try again.");
        return null;
      }
      setText($("rb-walk-status"), "");
      return jsonFetch("/api/ramble/steps/reading", {
        method: "POST",
        body: { device_id: p.device_id, counter: p.counter, elapsed_ms: p.elapsed_ms, boot_count: p.boot_count },
      });
    });
  }

  function refreshWalk(force) {
    if (walkInFlight) return walkInFlight;
    walkInFlight = sendStepReading(force)
      .catch(function () { return null; })
      .then(function (st) {
        if (st && st.reading && st.reading.credited > 0) refreshPet();
        return st || jsonFetch("/api/ramble/steps");
      })
      .then(paintWalk)
      .catch(function () { /* walking is a bonus, never a broken page */ })
      .then(function () { walkInFlight = null; });
    return walkInFlight;
  }

  function saveWalkSettings(patch) {
    setText($("rb-walk-status"), "");
    return jsonFetch("/api/ramble/steps/settings", { method: "PUT", body: patch })
      .then(function (st) { paintWalk(st); return refreshPet(); })
      .catch(function (err) { setText($("rb-walk-status"), err.message); });
  }

  function nudgeGoal(by) {
    var goal = (walkState && Number(walkState.goal)) || 6000;
    var next = Math.max(1000, Math.min(30000, goal + by));
    if (next !== goal) saveWalkSettings({ goal: next });
  }

  (function wireWalk() {
    var allow = $("rb-walk-allow");
    if (allow) allow.addEventListener("click", function () {
      allow.disabled = true;
      callNative("requestStepsPermission", 5 * 60 * 1000)
        .then(function () { return refreshWalk(true); })
        .then(function () { allow.disabled = false; });
    });
    var open = $("rb-walk-open-settings");
    if (open) open.addEventListener("click", function () {
      try { if (window.Crow && typeof window.Crow.openAppSettings === "function") window.Crow.openAppSettings(); }
      catch (e) { /* nothing to open */ }
    });
    var check = $("rb-walk-checkin");
    if (check) check.addEventListener("click", function () {
      check.disabled = true;
      jsonFetch("/api/ramble/steps/walked", { method: "POST", body: {} })
        .then(function (st) { paintWalk(st); return refreshPet(); })
        .catch(function (err) { setText($("rb-walk-status"), err.message); check.disabled = false; });
    });
    var down = $("rb-walk-goal-down");
    if (down) down.addEventListener("click", function () { nudgeGoal(-500); });
    var up = $("rb-walk-goal-up");
    if (up) up.addEventListener("click", function () { nudgeGoal(500); });
    var nudge = $("rb-walk-nudge");
    if (nudge) nudge.addEventListener("change", function () { saveWalkSettings({ nudge: !!nudge.checked }); });
    var weekends = $("rb-walk-weekends");
    if (weekends) weekends.addEventListener("change", function () { saveWalkSettings({ nudge_weekends: !!weekends.checked }); });
    document.addEventListener("visibilitychange", function () { if (!document.hidden) refreshWalk(false); });
  })();
```

`$`, `setText` and `refreshPet` are function declarations elsewhere in the same scope (hoisted). Confirm `$` is a function declaration in this file (`grep -n 'function \$' bundles/ramble/panel/static/ramble.js`); if it is a `var $ = ...` defined BELOW `jsonFetch`, move the `wireWalk` IIFE call (only the IIFE, not the function declarations) to the bottom of the file, just before the existing `refreshPet()` boot call.

(c) In `showView(name)`, add after the existing `if (name === "egg") refreshEgg();` line:

```js
    if (name === "pet") refreshWalk(false);
```

(d) Boot read: in the startup block near the end of the file, directly after the line `refreshEgg().then(refreshPet);` (~line 2701 — NOT the bare `refreshPet();` inside `openAr`), add `refreshWalk(true);`.

(e) Badge on the pet portrait — in `paintPet`, replace the `mountBird` line:

```js
        try {
          Bird.mountBird(petBird, genome, pet.mood || "happy");
          /* Spec 2026-10-04 §8: the same badge contacts see. Engine markup only. */
          if (pet.walked_today === true && typeof Bird.mountWalkBadge === "function") Bird.mountWalkBadge(petBird);
        } catch (e) { /* cosmetic */ }
```

- [ ] **Step 5: CSS** — append to `bundles/ramble/panel/static/ramble.css`:

```css
/* Walking card (spec 2026-10-04). */
#ramble .rb-walk-actions { flex-wrap: wrap; margin-top: 8px; }
#ramble .rb-walk-goal-row { margin-top: 8px; }
#ramble #rb-walk-goal-val { min-width: 4.5em; text-align: center; }
#ramble .rb-walk-toggle { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
#ramble .rb-walk-toggle input { width: 18px; height: 18px; }
```

- [ ] **Step 6: Run to verify pass**

Run: `npm test -- tests/ramble-panel.test.js`
Expected: PASS (all, including the pre-existing panel tests).

- [ ] **Step 7: Commit**

```bash
git commit bundles/ramble/panel/ramble.js bundles/ramble/panel/static/ramble.js bundles/ramble/panel/static/ramble.css tests/ramble-panel.test.js -m "feat(ramble): walking card on the pet view — counter via the Android bridge, I-walked-today fallback, goal + nudge settings, badge on the portrait"
git show --stat HEAD
```

---

### Task 8: Android — the step bridge (APK 1.6.0)

**Files:**
- Modify: `android/app/src/main/AndroidManifest.xml`
- Modify: `android/app/src/main/java/press/maestro/crow/MainActivity.java`
- Modify: `android/app/build.gradle`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: the bridge contract Task 7 consumes (see Task 7 Interfaces); results delivered by `window.CrowSteps && window.CrowSteps.deliver(id, json)`; reading payload `{ok:true, counter:long, elapsed_ms:long, boot_count:int|null, device_id:string}` or `{ok:false, reason:"no-sensor"|"no-permission"|"timeout"|"error"}`; permission payload `{status}`.

There is no Android unit-test harness (`android/app/src/test` does not exist) and CI does not build the APK. The proof for this task is (1) a clean compile on crow and (2) the on-device checklist in Task 12. Native code stays a dumb reader (R1) — no arithmetic here.

- [ ] **Step 1: Baseline compile BEFORE editing** (surfaces toolchain problems before they can be blamed on the change). A worktree has no `android/local.properties` (gitignored) and `ANDROID_HOME` is unset on crow, so copy the main checkout's file first — it is never committed:

```bash
cp ~/crow/android/local.properties ~/crow-wt-ramble-steps/android/local.properties
cd ~/crow-wt-ramble-steps/android && ./gradlew assembleDebug --offline 2>&1 | tail -5
```
Expected: `BUILD SUCCESSFUL`. If it fails for a reason unrelated to this branch (dependency cache, SDK), STOP and report — do not edit build files to work around it.

- [ ] **Step 2: Manifest** — in `AndroidManifest.xml`, after the `WAKE_LOCK` permission line:

```xml
    <!-- Ramble walking (spec 2026-10-04): the hardware step counter. Runtime
         permission on API 29+; the app asks only when the player taps
         "Count my steps". -->
    <uses-permission android:name="android.permission.ACTIVITY_RECOGNITION" />
```

and after the existing `<uses-feature ... bluetooth_le ... />` line:

```xml
    <uses-feature android:name="android.hardware.sensor.stepcounter" android:required="false" />
```

- [ ] **Step 3: `MainActivity.java`** — imports (add alongside the existing ones):

```java
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;

import org.json.JSONObject;

import java.util.UUID;
import java.util.regex.Pattern;
```

Fields (with the other `private static final` constants and fields at the top of the class):

```java
    // Ramble walking (spec 2026-10-04 §10). Native is a dumb reader: it never
    // does step arithmetic — the gateway does (baselines, reboots, caps).
    private static final String KEY_STEPS_DEVICE_ID = "steps_device_id";
    private static final String KEY_STEPS_RATIONALE_SEEN = "steps_rationale_seen";
    private static final Pattern STEPS_REQ_ID = Pattern.compile("^[A-Za-z0-9]{1,32}$");
    private static final long STEPS_READ_TIMEOUT_MS = 4000L;
    private String pendingStepsPermId;

    private final ActivityResultLauncher<String> stepsPermissionLauncher =
            registerForActivityResult(new ActivityResultContracts.RequestPermission(), granted -> {
                // A refusal after which Android would still prompt (rationale = true)
                // is remembered: only a LATER "not granted + no rationale" is a
                // permanent "denied". A dismissed dialog (tap outside / back) on the
                // very first ask also reads not-granted + no rationale, and must stay
                // "needs-permission".
                if (!granted && shouldShowRequestPermissionRationale(Manifest.permission.ACTIVITY_RECOGNITION)) {
                    getSharedPreferences(PREFS_NAME, MODE_PRIVATE).edit().putBoolean(KEY_STEPS_RATIONALE_SEEN, true).apply();
                }
                String id = pendingStepsPermId;
                pendingStepsPermId = null;
                if (id == null) return;
                try {
                    JSONObject o = new JSONObject();
                    o.put("status", stepsStatusString());
                    deliverSteps(id, o);
                } catch (Exception ignored) { }
            });
```

Methods on `MainActivity` (place them after `requestLocationPermission`):

```java
    private boolean hasStepCounter() {
        SensorManager sm = (SensorManager) getSystemService(SENSOR_SERVICE);
        return sm != null && sm.getDefaultSensor(Sensor.TYPE_STEP_COUNTER) != null;
    }

    private boolean hasActivityPermission() {
        return ContextCompat.checkSelfPermission(this, Manifest.permission.ACTIVITY_RECOGNITION)
                == PackageManager.PERMISSION_GRANTED;
    }

    /**
     * "ok" | "needs-permission" | "denied" | "no-sensor". "denied" only once the
     * user has refused at least once with Android still willing to ask
     * (rationale seen) AND Android has now stopped offering the rationale — i.e.
     * "don't ask again". Before that, a dismissed dialog is still askable.
     */
    String stepsStatusString() {
        if (!hasStepCounter()) return "no-sensor";
        if (hasActivityPermission()) return "ok";
        boolean rationaleSeen = getSharedPreferences(PREFS_NAME, MODE_PRIVATE).getBoolean(KEY_STEPS_RATIONALE_SEEN, false);
        if (rationaleSeen && !shouldShowRequestPermissionRationale(Manifest.permission.ACTIVITY_RECOGNITION)) return "denied";
        return "needs-permission";
    }

    /** A random id made once per install. Never ANDROID_ID. */
    private String stepsDeviceId() {
        SharedPreferences p = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        String id = p.getString(KEY_STEPS_DEVICE_ID, null);
        if (id == null || id.isEmpty()) {
            id = UUID.randomUUID().toString();
            p.edit().putString(KEY_STEPS_DEVICE_ID, id).apply();
        }
        return id;
    }

    /** Hand a result to the panel. The id is re-validated; the JSON is built by org.json. */
    private void deliverSteps(String id, JSONObject payload) {
        if (id == null || !STEPS_REQ_ID.matcher(id).matches()) return;
        final String js = "window.CrowSteps&&window.CrowSteps.deliver(" + JSONObject.quote(id) + "," + payload.toString() + ")";
        runOnUiThread(() -> { if (webView != null) webView.evaluateJavascript(js, null); });
    }

    private void deliverStepsError(String id, String reason) {
        try {
            JSONObject o = new JSONObject();
            o.put("ok", false);
            o.put("reason", reason);
            deliverSteps(id, o);
        } catch (Exception ignored) { }
    }

    /**
     * One-shot read. TYPE_STEP_COUNTER is an on-change sensor, which reports its
     * current value when a listener is registered, so the first event IS the
     * reading. Unregister on that event or after the timeout, whichever is first.
     */
    private void readStepsOnce(String id) {
        if (!hasStepCounter()) { deliverStepsError(id, "no-sensor"); return; }
        if (!hasActivityPermission()) { deliverStepsError(id, "no-permission"); return; }
        final SensorManager sm = (SensorManager) getSystemService(SENSOR_SERVICE);
        final Sensor sensor = sm.getDefaultSensor(Sensor.TYPE_STEP_COUNTER);
        final Handler main = new Handler(Looper.getMainLooper());
        final boolean[] done = { false };
        final SensorEventListener[] holder = new SensorEventListener[1];
        final Runnable timeout = () -> {
            if (done[0]) return;
            done[0] = true;
            sm.unregisterListener(holder[0]);
            deliverStepsError(id, "timeout");
        };
        holder[0] = new SensorEventListener() {
            @Override
            public void onSensorChanged(SensorEvent event) {
                if (done[0]) return;
                done[0] = true;
                main.removeCallbacks(timeout);
                sm.unregisterListener(this);
                try {
                    JSONObject o = new JSONObject();
                    o.put("ok", true);
                    o.put("counter", (long) event.values[0]);
                    o.put("elapsed_ms", SystemClock.elapsedRealtime());
                    int boot = Settings.Global.getInt(getContentResolver(), Settings.Global.BOOT_COUNT, -1);
                    o.put("boot_count", boot >= 0 ? (Object) Integer.valueOf(boot) : JSONObject.NULL);
                    o.put("device_id", stepsDeviceId());
                    deliverSteps(id, o);
                } catch (Exception e) {
                    deliverStepsError(id, "error");
                }
            }

            @Override
            public void onAccuracyChanged(Sensor s, int accuracy) { }
        };
        sm.registerListener(holder[0], sensor, SensorManager.SENSOR_DELAY_NORMAL, main);
        main.postDelayed(timeout, STEPS_READ_TIMEOUT_MS);
    }
```

Bridge methods — add inside `public class CrowBridge { ... }` after `setPullToRefresh`:

```java
        /** Ramble walking: "ok" | "needs-permission" | "denied" | "no-sensor". */
        @JavascriptInterface
        public String stepsStatus() {
            return stepsStatusString();
        }

        /** Ask for ACTIVITY_RECOGNITION; delivers {status} to window.CrowSteps.deliver(id, ...). */
        @JavascriptInterface
        public void requestStepsPermission(String id) {
            if (id == null || !STEPS_REQ_ID.matcher(id).matches()) return;
            runOnUiThread(() -> {
                if (hasActivityPermission() || !hasStepCounter()) {
                    try {
                        JSONObject o = new JSONObject();
                        o.put("status", stepsStatusString());
                        deliverSteps(id, o);
                    } catch (Exception ignored) { }
                    return;
                }
                pendingStepsPermId = id;
                stepsPermissionLauncher.launch(Manifest.permission.ACTIVITY_RECOGNITION);
            });
        }

        /** Read the step counter once; delivers the reading to window.CrowSteps.deliver(id, ...). */
        @JavascriptInterface
        public void readSteps(String id) {
            if (id == null || !STEPS_REQ_ID.matcher(id).matches()) return;
            runOnUiThread(() -> readStepsOnce(id));
        }

        /** For the "denied" case: this app's system settings page. */
        @JavascriptInterface
        public void openAppSettings() {
            runOnUiThread(() -> {
                Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        Uri.fromParts("package", getPackageName(), null));
                startActivity(i);
            });
        }
```

(`SystemClock`, `SharedPreferences`, `Intent`, `Uri`, `Manifest`, `PackageManager`, `ContextCompat`, `ActivityResultLauncher`, `ActivityResultContracts` are already imported. If the compiler reports `Settings` as ambiguous, qualify the uses as `android.provider.Settings`.)

- [ ] **Step 4: Version** — `android/app/build.gradle`: `versionCode 19` → `versionCode 20`, `versionName "1.5.2"` → `versionName "1.6.0"`.

- [ ] **Step 5: Compile**

```bash
cd ~/crow-wt-ramble-steps/android && ./gradlew assembleDebug --offline 2>&1 | tail -5
grep -c "ACTIVITY_RECOGNITION" app/src/main/AndroidManifest.xml
```
Expected: `BUILD SUCCESSFUL`; `1`. (The debug APK is a compile proof only; Kevin gets the RELEASE build in Task 11.)

- [ ] **Step 6: Commit** (`android/app/build/` is build output — never commit it; check `git status --short android/` shows only the three files)

```bash
git commit android/app/src/main/AndroidManifest.xml android/app/src/main/java/press/maestro/crow/MainActivity.java android/app/build.gradle -m "feat(android): step-counter bridge for Ramble walking — stepsStatus/requestStepsPermission/readSteps/openAppSettings; 1.6.0"
git show --stat HEAD
```

---

### Task 9: Docs, the old spec's pointer, version, registry, full gates

**Files:**
- Modify: `docs/guide/ramble.md`, `docs/es/guide/ramble.md`
- Modify: `docs/superpowers/specs/2026-09-08-ramble-reward-economy-design.md`
- Modify: `bundles/ramble/manifest.json`, `registry/add-ons.json`

**Interfaces:** none new.

- [ ] **Step 1: Guide (en)** — in `docs/guide/ramble.md`, add directly after the `## Chores` section (before `## Nests and the egg shelf`):

```markdown
## Walking

Set a daily step goal on the pet page (6,000 to start; anywhere from 1,000 to 30,000). Walking toward it tops up your bird's energy as you go — up to +30 a day at the goal — and reaching it pays 3 bird seed. A day you miss costs nothing.

- **In the Crow Android app (1.6.0 or later)** tap **Count my steps** once and allow *Physical activity*. The app reads the phone's own step counter whenever you open Ramble; nothing runs in the background. The first day may start at zero ("counting from now") unless the phone was restarted today.
- **Anywhere else** (a phone browser, an iPhone, a phone without a step counter) tap **I walked today**. It cheers your bird up (+15) but pays no seed, since there is no count behind it.

**Who sees what.** Your step count stays on your own Crows. Contacts see only a small "walked today" mark on your bird's profile picture — never a number. The mark appears when you check in or pass 2,000 steps (or your goal, if it is lower), and clears after midnight. Because it appears when you walk, it does say roughly *when* you walked.

**The evening nudge.** If you have been walking with Ramble this week and by 6 pm you are under half your goal, your bird sends one gentle reminder through Crow notifications. Never more than one a day. Turn it off, or keep weekends quiet, under **Goal and reminders** on the walking card.

API: `GET /api/ramble/steps`, `POST /api/ramble/steps/reading { device_id, counter, elapsed_ms, boot_count }`, `POST /api/ramble/steps/walked`, `PUT /api/ramble/steps/settings { goal?, nudge?, nudge_weekends? }`.
```

Add to the `## Configuration` section's settings table (match its existing column layout) one row per tunable from Global Constraints (`steps.goal`, `steps.max.day`, `steps.max.per.min`, `steps.devices.per.day`, `steps.energy.full`, `steps.energy.chunk`, `steps.checkin.energy`, `steps.goal.seed`, `steps.badge.min`, `steps.nudge`, `steps.nudge.weekends`, `steps.nudge.hour`, `steps.nudge.until`, `steps.nudge.below`) with its default and a one-line meaning taken from spec §4.3. Read the section first (`sed -n '/^## Configuration/,/^## MCP tools/p' docs/guide/ramble.md`); if it is not a table, follow its actual format.

- [ ] **Step 2: Guide (es)** — in `docs/es/guide/ramble.md`, after `## Tareas` (before `## Nidos y el estante de huevos`):

```markdown
## Caminar

En la página de tu pájaro puedes fijar una meta diaria de pasos (6.000 para empezar; entre 1.000 y 30.000). Caminar hacia ella le va dando energía a tu pájaro — hasta +30 al día al llegar a la meta — y alcanzarla da 3 de alpiste. Un día sin caminar no cuesta nada.

- **En la app de Crow para Android (1.6.0 o posterior)** toca **Contar mis pasos** una vez y permite *Actividad física*. La app lee el contador de pasos del propio teléfono cada vez que abres Ramble; nada funciona en segundo plano. El primer día puede empezar en cero ("contando desde ahora") salvo que el teléfono se haya reiniciado ese día.
- **En cualquier otro lugar** (el navegador del teléfono, un iPhone, un teléfono sin contador de pasos) toca **Caminé hoy**. Alegra a tu pájaro (+15) pero no da alpiste, porque no hay un conteo detrás.

**Quién ve qué.** Tu número de pasos se queda en tus propios Crows. Tus contactos solo ven una pequeña marca de "caminó hoy" en la foto de perfil de tu pájaro — nunca un número. La marca aparece cuando marcas que caminaste o pasas de 2.000 pasos (o de tu meta, si es menor), y se borra después de medianoche. Como aparece cuando caminas, sí indica más o menos *cuándo* caminaste.

**El aviso de la tarde.** Si esta semana has caminado con Ramble y a las 6 de la tarde vas por debajo de la mitad de tu meta, tu pájaro envía un recordatorio amable por las notificaciones de Crow. Nunca más de uno al día. Puedes desactivarlo, o dejar los fines de semana tranquilos, en **Meta y recordatorios** de la tarjeta de caminar.

API: `GET /api/ramble/steps`, `POST /api/ramble/steps/reading { device_id, counter, elapsed_ms, boot_count }`, `POST /api/ramble/steps/walked`, `PUT /api/ramble/steps/settings { goal?, nudge?, nudge_weekends? }`.
```

(The panel buttons are English (R10); the Spanish guide names them in Spanish with the English label the player will actually see in parentheses only if that is how the existing ES guide treats panel labels — check `grep -n "Vestuario" -A12 docs/es/guide/ramble.md` and follow its convention exactly.) Mirror the Configuration rows in Spanish.

- [ ] **Step 3: The old spec points forward** — in `docs/superpowers/specs/2026-09-08-ramble-reward-economy-design.md`:
  - D13 row: change "**Deferred to a future version.** See §10." to "**Deferred here; designed 2026-10-04** in `2026-10-04-ramble-steps-design.md` (§0 there corrects the technical reasons below)."
  - §10 first bullet: append " **Superseded 2026-10-04:** the app already ships the native↔WebView bridge, and `TYPE_STEP_COUNTER` needs no foreground service — see `2026-10-04-ramble-steps-design.md` §0."

- [ ] **Step 4: Version + registry**

```bash
sed -i 's/"version": "0.13.0"/"version": "0.14.0"/' bundles/ramble/manifest.json
npm run build-registry
git diff --stat registry/add-ons.json bundles/ramble/manifest.json
```
Expected: exactly the ramble version line changes in each file. If `build-registry` rewrites anything else, stop and investigate.

- [ ] **Step 5: Full gates**

```bash
npm test 2>&1 | tail -15
node scripts/check-port-allocation.js
node scripts/build-registry.mjs --check
git diff origin/main -- scripts/init-db.js | grep -c SCHEMA_GENERATION
git diff origin/main -- servers/sharing/instance-sync.js | wc -l
```
Expected: suite `fail 0`, pass count = baseline + the new tests (record both in the PR body); port and registry checks exit 0; `0` SCHEMA_GENERATION lines; `0` lines of `instance-sync.js` diff (R2 — no core sync change). A failure in `tests/sync-stamp.test.js:174` (known pre-existing concurrent-first-boot flake) is re-run alone and in the full suite once more and reported either way. `deploy-docs.yml` runs only on pushes to `main`, so the PR's check-runs will NOT build the docs — build them locally, required: `cd docs && npm run build 2>&1 | tail -5` → success. Bare `<placeholder>` tokens outside backticks have broken the Deploy Docs job before (commit e345ce9f).

- [ ] **Step 6: Commit**

```bash
git commit docs/guide/ramble.md docs/es/guide/ramble.md docs/superpowers/specs/2026-09-08-ramble-reward-economy-design.md bundles/ramble/manifest.json registry/add-ons.json -m "docs(ramble): walking — guide en/es, economy spec points to the steps design; ramble 0.14.0"
git show --stat HEAD
```

---

### Task 10: PR, CI, merge, deploy to crow

**Files:** none (git + deploy).

**Interfaces:** none.

The standing post-arc grant (2026-07-11) covers merge + deploy for improvement-queue items; CI must be green first (branch protection `enforce_admins=true`). `gh` is NOT installed on crow — use the github MCP server (`mcp__github__create_pull_request`, `mcp__github__get_pull_request_status`, `mcp__github__merge_pull_request`).

- [ ] **Step 1: Push**

```bash
cd ~/crow-wt-ramble-steps && git fetch -q origin && git pull --rebase origin main && npm test 2>&1 | tail -4
git push -u origin feat/ramble-steps
```

- [ ] **Step 2: Open the PR** (owner `kh0pper`, repo `crow`, base `main`, head `feat/ramble-steps`). Title: `feat(ramble): walking — daily step goal feeds the bird; walked-today badge; I-walked-today fallback; evening nudge; Android step bridge 1.6.0`. Body: the spec path; S1–S4 and R1–R12 in one line each; the suite numbers (baseline → new); "no SCHEMA_GENERATION bump, no instance-sync.js change (R2)"; "ramble 0.13.0 → 0.14.0"; "APK 1.6.0 must be built and installed by the operator (Task 11) — CI does not build it; the server side degrades to the manual check-in for 1.5.x"; the Review Focus list. No Claude attribution.

- [ ] **Step 3: CI** — query `https://api.github.com/repos/kh0pper/crow/commits/<head sha>/check-runs` until every run (`suite`, `static-checks`, `audit`, docs if present) is `completed`/`success`. An empty list on the current sha means something is wrong, not "pending forever". Red → fix on the branch, re-push, re-check.

- [ ] **Step 4: Merge** (squash, matching the repo's history style) once all check-runs are green.

- [ ] **Step 5: Deploy to crow** (Ramble is installed on **crow**). First read `~/CROW-SCHEDULE.md`: if a reservation window is active, wait for it to end — a gateway restart during a window is not allowed.

```bash
cd ~/crow && git branch --show-current     # MUST print main; if not, stop (auto-update rule)
git pull --ff-only origin main
sqlite3 ~/.crow/data/crow.db ".backup '/home/kh0pp/.crow/data/crow.db.pre-ramble-0.14.0'"
sudo systemctl restart crow-gateway
sleep 20
grep '"version"' ~/.crow/bundles/ramble/manifest.json
```
Expected: `"version": "0.14.0"`. Phase 4 needed a SECOND restart because the first boot refreshed the installed copy after the routes had already loaded the old one. Task 5 makes the portrait engine re-probe itself, but the panel routes still import the bundle once per process, so restart once more for this deploy (fleet auto-update on other hosts is covered by Task 5's re-probe for the badge and by the next routine restart for the routes):

```bash
sudo systemctl restart crow-gateway && sleep 20
journalctl -u crow-gateway --since "2 min ago" --no-pager | grep -E "\[ramble\]" | tail -8
sqlite3 ~/.crow/data/crow.db "SELECT name FROM sqlite_master WHERE name = 'ramble_step_devices';"
cd ~/crow && git branch --show-current
```
Expected: `[ramble] walk nudge scheduler started` and `[ramble] transport started` in the journal; `ramble_step_devices` printed; still on `main`. Confirm `auto_update_last_result` is not "Skipped": `sqlite3 ~/.crow/data/crow.db "SELECT value FROM dashboard_settings WHERE key = 'auto_update_last_result';"`.

---

### Task 11: [OPERATOR] Build the release APK 1.6.0 · [KEVIN] install it

**Files:** none committed.

CI does not build the APK. #405 (1.5.2) shipped the same way: the code change merged, then the signed release build was made on crow and installed on Kevin's phone. The release keystore and its passwords live in `~/.crow/android-keystore/` on crow; **never print the env file's values** and never paste them anywhere.

- [ ] **Step 1: [OPERATOR] Build** (from the merged `main`, in a clean checkout — not the worktree):

```bash
cd ~/crow/android && git -C ~/crow log -1 --oneline
( set -a; . ~/.crow/android-keystore/crow-release.env; set +a; ./gradlew clean assembleRelease --offline ) 2>&1 | tail -5
~/Android/Sdk/build-tools/34.0.0/aapt2 dump badging app/build/outputs/apk/release/app-release.apk | grep -E "versionCode|versionName|debuggable|ACTIVITY_RECOGNITION"
~/Android/Sdk/build-tools/34.0.0/apksigner verify --print-certs app/build/outputs/apk/release/app-release.apk | grep -i "SHA-256"
```
Expected: `BUILD SUCCESSFUL`; `versionCode='20' versionName='1.6.0'`; a `uses-permission: name='android.permission.ACTIVITY_RECOGNITION'` line; NO `application-debuggable` line; a SHA-256 cert digest — record it in the PR as a comment. If `apksigner` shows a different signer than the 1.5.2 build Kevin has installed, an in-place upgrade will fail: STOP and ask Kevin (uninstalling loses the app's saved gateway URL and pairing state).

- [ ] **Step 2: [KEVIN] Install on the Pixel.** Either (a) USB/wireless debugging: `adb devices` shows the phone, then `adb install -r ~/crow/android/app/build/outputs/apk/release/app-release.apk` — `Success` expected; `INSTALL_FAILED_UPDATE_INCOMPATIBLE` means a signer mismatch: do NOT uninstall, stop and decide with the operator; or (b) copy the APK somewhere the phone can fetch it (e.g. `~/files-main/` over the `[crow-home]` share) and open it on the phone. Afterwards the app's Settings screen or `window.Crow.appVersion()` reports `1.6.0`.

---

### Task 12: [KEVIN] Live acceptance on the Pixel (last)

**Files:** none.

Each line is pass/fail; record results as a PR comment. The operator can watch `journalctl -u crow-gateway -f | grep -i ramble` and query the ledger read-only: `sqlite3 ~/.crow/data/crow.db "SELECT kind, key, delta FROM ramble_wallet WHERE kind IN ('steps','stepenergy','walked','walkcheck','nudge') OR key LIKE 'steps:%' ORDER BY created_at DESC LIMIT 12;"`.

- [ ] **A1 Permission.** Open Ramble → My bird. The walking card says "Let Crow count your steps…" with **Count my steps** and **I walked today**. Tap **Count my steps** → Android's *Physical activity* prompt → Allow. The card switches to the step meter; the manual button disappears.
- [ ] **A2 First reading.** The meter shows a number: either today's steps (if the phone was restarted today) or 0 with "Counting from now." A `steps` row does or does not appear accordingly; a `ramble_step_devices` row exists.
- [ ] **A3 Walk.** Note the count, walk about 200 steps (count them roughly), reopen Ramble (or switch away and back to the pet view after a minute). The count rises by roughly that amount (±20%). Energy rises in chunks of 5 once progress crosses each 1/6 of the goal.
- [ ] **A4 Goal + bonus + badge.** Open **Goal and reminders**, lower the goal (−) until it is just under today's count. The line reads "Goal reached… (+3 seed)", the seed balance rises by 3 once (repeat − : no second bonus), and the badge appears on the pet portrait. Within ~30 s the profile picture as a contact sees it shows the footprint mark (check from another Crow that has Kevin as a contact, e.g. the Dayane instance's contact list, or ask a contact). Raise the goal back to 6,000.
- [ ] **A5 Nudge.** Preferred: a real weekday evening. If by 18:00 Kevin is under half his goal and has not checked in, within 10 minutes exactly one notification arrives (ntfy) — "Your bird is by the door" if the panel was opened in the last 3 hours, otherwise "Your bird wants to hear about your day". No second one that evening. Only if a same-day check is needed: register the step in `~/CROW-SCHEDULE.md`, then ONE statement against the live db (`sqlite3 ~/.crow/data/crow.db "INSERT INTO ramble_settings (key, value) VALUES ('steps.nudge.hour', strftime('%H','now','localtime')+0) ON CONFLICT(key) DO UPDATE SET value = excluded.value;"`), observe, and remove it the same way (`... "DELETE FROM ramble_settings WHERE key = 'steps.nudge.hour';"`) — deleting restores the default only because this write was never emitted to the other instances.
- [ ] **A6 Off switches.** With "An evening nudge if I haven't walked" unticked, no nudge the next evening. With "…on weekends too" unticked, none on Saturday.
- [ ] **A7 Fallback.** Open Ramble in the phone's browser (not the app): the card offers only **I walked today** with the "Steps are counted in the Crow Android app" line; tapping it marks the day and cheers the bird; no seed changes.

Acceptance passes when A1–A4 and A7 pass and A5–A6 pass on their first evening/weekend. Any failure → a fix PR (bundle changes need another manifest bump), not a hand-edit of the installed copy.

---

## Self-Review

1. **Spec coverage** — §0 deferral correction: Task 9 Step 3. S1 goal/energy/bonus/no-punish: Tasks 1–2 (+ panel Task 7). S2 own progress + boolean badge: Tasks 2, 5, 7. S3 manual check-in: Tasks 2, 4, 7. S4 nudge + settings: Tasks 2 (settings), 6, 7. R1 dumb native: Task 8. R2 wallet rows, no core sync change: Tasks 1–3, gate in Task 9 Step 5. R3 local baseline: Task 1. R4 day attribution: Task 1 test. R5 decay clock: Task 2. R6 badge rule: Task 2. R7 bonus as seed row: Task 2 tests (balance + harvestable). R8 steps home + nudge row: Tasks 2 (`touchHome`), 4 (routes touch it), 6. R9 engaged-only: Task 6. R10 i18n split: Task 6 (`NUDGE_TEXT`), Task 9 (guides). R11 privacy: Task 5 tests (boolean only). R12 no MCP tool: nothing added. §8 badge pacing via the coalesced hook: Task 5. §10 bridge + detection + read cadence: Tasks 7–8. §11 testing: every task; Android = compile + Task 12. Deploy + APK: Tasks 10–11.
2. **Placeholders** — none. Implementer lookups are explicit with a fallback: `SYNCED_TABLES` export (Task 1), `ramble-tables`/`ramble-panel` exact-shape expectations (Tasks 1, 4), `$` declaration placement (Task 7), the engine binding name in `ramble-bird-svg.test.js` (Task 5), the guide's Configuration format and ES label convention (Task 9), docs CI job (Task 9).
3. **Type consistency** — `recordStepReading → {credited, reason, clamped, day}` (Tasks 1, 3, 4, 7); `settleDay → {day, steps, energyPaid, seedBonus, walked, walkedNew}` (Tasks 2, 3, 4); `stepsState` shape identical in Tasks 2, 4, 7; `writeStepSettings → {...stepsState, settled}` and the route strips `settled` (Task 4); bridge method names and payloads identical in Tasks 7 and 8; bus event `ramble:walked-changed` in Tasks 4 and 5; kinds/keys per Global Constraints everywhere; `portraitDay` ≡ `localDay` pinned (Task 5).
4. **Review Focus** — (1) Task 1 reboot ×3 + clamp-discard tests; (2) Task 1 race test + Task 3 phone-moves, A→B→A, two-phones and cap tests; (3) Task 7 `nativeStepsMode` + `walkCardState` tests (all six modes, throwing bridge); (4) Task 6 per-condition, at-most-once, synced-row, busy/failing/missing-module tests; (5) Task 1 `parseReading` + `readStepSettings` junk, Task 2 `writeStepSettings` junk, Task 4 route 400s.
