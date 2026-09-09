# Ramble — heart containers and maximum energy (Phase 2) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Walking new ground occasionally turns up a **heart container**, which permanently raises the bird's maximum energy — so a bigger bar means the bird stays happy far longer between walks, and the ~25 cells a player already unlocked hold hearts they can go back and collect.

**Architecture:** No new table and no schema change. Hearts are rows in the existing `ramble_wallet` ledger under `kind = 'heart'`, which phase 1 already registered at all five sync sites. One new pure module (`hearts.js`) owns placement — a hash of the cell decides, exactly like `nestFor` and `seedFor` — and owns **one availability predicate that both the map and the payout call**, because a heart drawn but not granted is the bug phase 1 shipped and had to fix. Maximum energy is derived from the ledger (`base + hearts x per-heart`, capped), never stored, so it converges for free.

**Tech Stack:** Node 22 ESM, libsql, Leaflet in the panel client, Node test runner via `scripts/run-suite.mjs`.

**Spec:** `docs/superpowers/specs/2026-09-08-ramble-reward-economy-design.md` — §2.3 (spawn rules), §3 (the economy), §6.1/§6.4 (ledgers and settings), §7, §8, and phase 2 of §9. Decisions D6 (two currencies, hearts raise the bar only) and D2 (energy's stakes).

**Phase 1 handoff (read it):** `docs/superpowers/handoffs/2026-09-08-ramble-map-phase1-shipped.md` — in particular the three blocking defects the whole-branch review caught, all three of which this plan is shaped to avoid repeating.

## Kevin's rulings for this phase (2026-09-09, before planning)

| # | Question | Ruling |
|---|---|---|
| K1 | Keep strict phase order, given seed stays earn-only until phase 4? | **Yes.** Phase 2 is hearts. **Do not build a shop, a wardrobe, an accessory catalogue, or any spend path.** Hearts are self-spending: earning one immediately lengthens the bar. |
| K2 | What does a player with ~25 already-unlocked cells get on the day hearts ship? | **Nothing is granted silently.** The hash decides identically for every cell, past or future, so roughly a third of those 25 cells hold a heart — and each one **sits on the map as an uncollected pip until the player walks back to it**. Existing players get destinations, not a number that jumped. |
| K3 | Is a heart visible before you take it? | **Yes in unlocked ground, no in fog.** Wild and retroactive hearts draw as pips. A first-unlock heart cannot be previewed because the cell was fogged, so it arrives as a moment when you walk in. |
| K4 | Also build D2's sad-portrait-to-contacts? | **No.** Out of scope. `servers/sharing/profile-avatar.js` keeps hardcoding mood `"happy"`. D2's delivery vehicle is the avatar broadcast whose pacing requirement (§5.4, coalesce into one broadcast per settled state) belongs to the accessories phase; pulling the portrait forward pulls that requirement forward with it. **Do not touch `servers/sharing/profile-avatar.js`.** |

## Global Constraints

- **Base:** `origin/main` @`200cf834` (rebased after the plan review; the earlier `e089ad4d` baseline was stale). Worktree `/home/kh0pp/crow-wt-ramble-hearts`, branch `feat/ramble-hearts`, already created. **Never `git checkout` in `~/crow`** — a gateway checkout parked off `main` silently disables fleet auto-update. **Never `cp -a` a worktree** — its `.git` is a pointer file and the copy commits to the real branch.
- **Node/test harness:** `export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH` before any node/npm command. Run tests ONLY as `node scripts/run-suite.mjs tests/<file>.test.js` from the worktree, in the FOREGROUND. **NEVER run bare `node --test`** — it writes to the LIVE production database. Never boot a gateway or MCP server without a scratch `CROW_DATA_DIR`.
- **Suite baseline:** **4301 pass / 0 fail at `200cf834`**, measured in this worktree after the rebase. The suite must not regress.
- **No schema change, no migration, no `SCHEMA_GENERATION` bump.** Hearts ride `ramble_wallet` (`kind`, `key`, `delta`, `created_at`, `lamport_ts`), which already exists on every host. `bundles/ramble/server/init-tables.js` and `scripts/init-db.js` are **not modified by this plan**. If a task finds itself editing either file, stop — the design has drifted.
- **Ledgers, not balances (spec §6.1):** every heart is an append-only row under a natural idempotent key. Never store a heart count, and never store maximum energy — both are derived by reading the ledger.
- **A heart row's `delta` is ALWAYS the integer `1`** — a count of containers, never an energy amount. Two reasons, both load-bearing: (a) `applyRambleWallet` in `servers/sharing/instance-sync.js` resolves conflicts with `MAX(delta)`, which is only convergent when the value cannot differ between instances for the same key — phase 1 shipped a bug here precisely because seed's `delta` is the live, mutable `seed.per.pickup`; a constant `1` cannot disagree. (b) Storing energy would freeze `energy.max.per.heart` into history, so retuning that setting would not retune the bar.
- **⚠ Never write a NEGATIVE delta in this phase.** `applyRambleWallet`'s doc comment records why: `MAX(delta)` would resolve a `-10`/`-5` disagreement to `-5`, deducting less. There are no spends in phase 2. Phase 4 must key a spend by the purchase.
- **The map and the payout MUST read the same rule.** A heart drawn on the map that a walk does not grant (or the reverse) is the hazard 0.9.5 had to close when seed became sparse: before it, seed paid in every cell while the map drew pips in one in four. The gate `recordSeedPickup` carries today (`wallet.js`: "The SAME gate the map draws from. Without this the map would be a liar") is that fix. `availableHearts()` (what the map draws) and `recordHeartPickup()` (what a walk grants) therefore both go through the single pure `heartCandidates()`, and Task 2 has an executable test that the two agree cell-for-cell.
  **⚠ But do not over-index on this one.** The three defects phase 1's whole-branch review actually caught were different in kind: a retired UI element that was carrying another affordance, a feature gating on accumulated state with no answer for existing users, and a non-convergent sync apply. Two of them are *an affordance added on one path and not its twin* — which is the failure this plan is most at risk of repeating, not a map/payout split.
- **Fail closed on unlock, on BOTH halves.** A heart is only ever granted in a cell that is already in `ramble_cells` — `recordHeartPickup` checks that itself rather than trusting its caller. **That check alone is not sufficient**, because a cell unlocked months ago passes it no matter how vague today's fix is, and this phase deliberately leaves hearts sitting in exactly such cells. So the route must ALSO pass `recordUnlock`'s own `out.cell`, which `cells.js` sets to `null` when the fix is too vague. Both halves, or a 2 km wifi fix collects a retroactive heart from a cell the user is nowhere near.
- **Every affordance must be added on BOTH paths.** The heart counter is fed by the area response *and* by `GET /api/ramble/pet`, because a player who denies geolocation never posts a fix — `paintPet` already calls `paintSeed(pet.seed)` for exactly this reason. Whenever this plan adds a painter, check whether its seed twin is called from two places.
- **Mood thresholds stay ABSOLUTE at 60 and 30** (`moodFor` in `pet.js` is unchanged). This is the spec's own reading: §4.3 says "a larger maximum energy means more slack before dropping below happy". A percentage threshold would give a bigger bar no benefit at all and would make hearts cosmetic.
- **Sparse features need explicit fixtures, not lucky hashes.** Phase 1's seed sparsity broke ledger tests written against values that happened to hash right. Every behavioural test in this plan sets `heart.rate = 1` (or `heart.wild.rate = 1`) so **every** cell holds a heart and the fixture is whatever you name. Rate itself is covered separately by one statistical test and one pinned regression vector.
- **Replication is EXPLICIT.** `ramble_wallet` is already registered for inbound apply; nothing goes outward unless a writer calls `emit`. `recordHeartPickup` takes `{ now, emit }` and emits after a successful insert, exactly as `recordSeedPickup` does.
- **Privacy (spec §2.4, §7):** hearts derive from the unlocked-cell set, which is a precise permanent record of everywhere the user has been. Nothing in this phase may add a heart, a cell or a balance to any contact-facing payload. Contacts-channel code (`delivery.js`, `trades.js`, `nostr-map.js`) is not touched.
- **Panel client rules, test-enforced:** `bundles/ramble/panel/static/ramble.js` must keep **ZERO backticks** (one truncates the served script; the slip is markdown habit in a code comment), **EXACTLY TWO** engine markup sinks, `textContent` only, and no emoji. `setAttribute`/`removeAttribute`/`className`/Leaflet layer calls are not markup sinks. Build every new node with `createElement` + `textContent`.
- **Invisible characters:** write any bidi/control character as a `\u` escape, never a raw byte.
- **Commits:** subject-only message, positional paths (`git commit <path> -m "..."`, never `git add -A`), `git add` new files first. **NO AI-attribution trailers of any kind.**
- **Bundle bump:** `bundles/ramble/manifest.json` AND `bundles/ramble/package.json` `0.9.5` -> `0.10.0`; then `npm run build-registry`. Without the bump, `repairInstalledBundleAssets` never refreshes the installed copy on grackle and the deploy silently ships nothing.
- **`gh` is NOT installed on crow.** Open the PR through the `github` MCP server; poll CI with `curl` against `/commits/<sha>/check-runs` (contexts `suite`, `static-checks`, `audit`).

## Deviations from the spec, recorded

Two settings the spec does not list are added here. Both follow the precedent of `seed.rate`, which phase 1 shipped as 0.9.5 for exactly this reason, and both are settings rather than constants so balance is a configuration change.

1. **`heart.wild.rate` (default 40).** Spec §6.4 gives `heart.wild.days` (30) as "the minimum gap before a heart may reappear in already-unlocked ground" but gives wild hearts no rarity. Without a rate, **every** unlocked cell yields a wild heart every 30 days: a 300-cell map would pay 10 hearts a month, "rarely" would be false, and the map would be carpeted in hearts — the same complaint that forced seed to become sparse in 0.9.5. At 1-in-40 per 30-day window, 25 cells pay about 0.6 hearts a month and 300 cells about 7.5, which keeps §2.3's deliberate concession (grindable by a heavy walker) without making exploration pointless.
2. **`energy.max.cap` (default 300).** The spec caps nothing. Uncapped, a long-lived map pushes maximum energy high enough that the -10-per-6h decay can never reach the 60 threshold, which makes mood permanent, hearts worthless past a point, and — critically — pre-breaks **phase 3**, whose laying floor is gated on "the bird ends the day happy". 300 is base 100 plus 20 hearts, which is exactly Zelda's 20-heart cap; D6 makes that mapping the frame of the whole currency design.

Both are noted in the PR body so a reviewer reads them as decisions, not drift. The wild arithmetic above assumes **every** unlocked cell stays eligible for a wild heart, including cells whose permanent heart is long gone — which is true only because `heartCandidates` offers both sources rather than short-circuiting on the first (Task 1). If that ever regresses to an `a || b`, these numbers are overstated by a third as well as the mechanic being broken.

**A third number left at the spec's value, with the reasoning recorded.** `heart.rate = 3` means roughly one cleared cell in three shows a pip on upgrade day — denser than seed's one in four, which is odd for the rarer currency, and Deviation 1 argues at length that carpeting is a real failure mode. Three things make it acceptable and it is deliberately not changed: pips only draw at `MIN_CELL_DETAIL_ZOOM` (15) and above, so density is bounded by a walkable viewport rather than by lifetime history; unlike seed, a heart is taken **permanently**, so the carpet clears as it is walked and never returns; and the density on upgrade day is precisely the "destinations, not a number that jumped" that K2 chose. For grackle's ~25 cells it is about 8 pips. **Say the density out loud in the PR** so it is a judgement on the record rather than something a player discovers.

---

## File structure

**Create**
- `bundles/ramble/server/hearts.js` — the whole heart mechanic: placement (`heartFor`, `wildHeartFor`, `heartCandidates`, `wildWindow`), settings (`readHeartSettings`), the ledger half (`availableHearts`, `recordHeartPickup`, `heartsBalance`), and the derived ceiling (`maxEnergy`). Imports only `nests.js` (for `CELL7_RE`) and `anchors.js` (for `decodeGeohash`) — never `pet.js`, which imports *this* module.
- `tests/ramble-hearts.test.js` — placement and settings (pure).
- `tests/ramble-hearts-ledger.test.js` — pickup, availability, the same-rule agreement test, and multi-instance convergence.

**Modify**
- `bundles/ramble/server/pet.js` — clamp against the derived maximum instead of a hardcoded 100; report `energy_max`.
- `bundles/ramble/server/feed.js` — its `readPet` helper must carry the same `energy_max`.
- `bundles/ramble/server/bird-svg.cjs` — `drawHeart()` / `mountHeart()`.
- `bundles/ramble/panel/routes.js` — load `hearts.js` into `mods`; grant on a fix in `POST /api/ramble/area`; heart pips in `GET /api/ramble/zones`; `hearts` on `GET /api/ramble/pet`.
- `bundles/ramble/server/server.js` — the MCP tool `ramble_pet_state` (around line 304) calls `petState` too. It will pick up `energy_max` for free from the spread; give it `hearts` as well, or the tool and the HTTP route disagree about the same pet.
- `bundles/ramble/panel/static/ramble.js` — the heart-pip layer, the counter, the pickup moment, the scaled energy bar, the heart row.
- `bundles/ramble/panel/static/ramble.css` — pip, fallback dot, pop, counter and heart-row rules.
- `bundles/ramble/panel/ramble.js` — the heart chip in the map bar; the heart row on the pet card.
- `tests/ramble-pet.test.js`, `tests/ramble-panel.test.js`, `tests/ramble-bird-svg.test.js`, `tests/ramble-tools.test.js` — extended in the task that changes the behaviour they cover.
- `bundles/ramble/manifest.json`, `bundles/ramble/package.json`, `registry/add-ons.json`.
- `docs/guide/ramble.md`, `docs/es/guide/ramble.md`.

**Explicitly NOT modified:** `bundles/ramble/server/init-tables.js`, `scripts/init-db.js`, `servers/sharing/instance-sync.js`, `servers/shared/sync-stamp.js`, `servers/sharing/profile-avatar.js`, `bundles/ramble/server/delivery.js`, `bundles/ramble/server/trades.js`.

---

## Task 1: `hearts.js` — where a heart is, and the numbers that govern it

**Files:**
- Create: `bundles/ramble/server/hearts.js`
- Create: `tests/ramble-hearts.test.js`

**Interfaces:**
- Consumes: `CELL7_RE` from `bundles/ramble/server/nests.js`; `decodeGeohash` from `bundles/ramble/server/anchors.js`.
- Produces, for Tasks 2-4:
  - `HEART_KIND = "heart"`, `HEART_SALT`, `HEART_WILD_SALT`
  - `HEART_RATE_DEFAULT = 3`, `HEART_WILD_DAYS_DEFAULT = 30`, `HEART_WILD_RATE_DEFAULT = 40`, `ENERGY_MAX_BASE_DEFAULT = 100`, `ENERGY_MAX_PER_HEART_DEFAULT = 10`, `ENERGY_MAX_CAP_DEFAULT = 300`
  - `wildWindow(now, days) -> integer`
  - `heartFor(cell, { rate }) -> { cell, key, source: "first", lat, lon } | null`
  - `wildHeartFor(cell, window, { wildRate }) -> { cell, key, source: "wild", lat, lon } | null`
  - `heartCandidates(cell, window, { rate, wildRate }) -> [candidate]` — **an array in priority order**, permanent heart first, wild second, either or both possibly absent
  - `readHeartSettings(db) -> { rate, wildDays, wildRate, energyBase, perHeart, cap }`

**Why placement is a hash and not a table:** this copies `nestFor` and `seedFor` deliberately. The answer is identical on every one of the user's devices with nothing stored and nothing to sync, and it cannot be re-rolled by leaving a cell and coming back.

- [ ] **Step 1: Write the failing test**

Create `tests/ramble-hearts.test.js`:

```js
/**
 * Spec 2026-09-08 §2.3 and §6.4 — heart container placement.
 *
 * Placement is a hash of the cell, like nestFor and seedFor: identical on
 * every device, nothing stored, and not re-rollable by walking out and back.
 *
 * ⚠ FIXTURES, NOT LUCKY HASHES. Phase 1's sparse seed broke tests that were
 * written against cells which happened to hash right. Every behavioural test
 * below sets rate 1 so EVERY cell holds a heart and the fixture is whatever we
 * name. The rate itself is covered by one statistical test and one pinned
 * vector, which are the only two places a specific hash value matters.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import { decodeGeohash, encodeGeohash } from "../bundles/ramble/server/anchors.js";
import {
  HEART_KIND, HEART_SALT, HEART_WILD_SALT,
  HEART_RATE_DEFAULT, HEART_WILD_DAYS_DEFAULT, HEART_WILD_RATE_DEFAULT,
  ENERGY_MAX_BASE_DEFAULT, ENERGY_MAX_PER_HEART_DEFAULT, ENERGY_MAX_CAP_DEFAULT,
  wildWindow, heartFor, wildHeartFor, heartCandidates, readHeartSettings,
} from "../bundles/ramble/server/hearts.js";

const CELL = "9vk79ed";
const ALL = { rate: 1, wildRate: 1 };   // rate 1: every cell holds one

function inside(cell, spot) {
  const c = decodeGeohash(cell);
  return spot.lat >= c.lat - c.latErr && spot.lat <= c.lat + c.latErr
      && spot.lon >= c.lon - c.lonErr && spot.lon <= c.lon + c.lonErr;
}

test("the defaults are the spec's numbers, plus the two recorded deviations", () => {
  assert.equal(HEART_KIND, "heart");
  assert.equal(HEART_RATE_DEFAULT, 3);
  assert.equal(HEART_WILD_DAYS_DEFAULT, 30);
  assert.equal(HEART_WILD_RATE_DEFAULT, 40);
  assert.equal(ENERGY_MAX_BASE_DEFAULT, 100);
  assert.equal(ENERGY_MAX_PER_HEART_DEFAULT, 10);
  assert.equal(ENERGY_MAX_CAP_DEFAULT, 300);
  assert.notEqual(HEART_SALT, HEART_WILD_SALT, "the two sources must not share a salt");
});

test("heartFor: at rate 1 every valid cell holds one, at a point INSIDE the cell", () => {
  const spot = heartFor(CELL, ALL);
  assert.ok(spot, "rate 1 always hits");
  assert.equal(spot.cell, CELL);
  assert.equal(spot.source, "first");
  assert.equal(spot.key, CELL, "a first heart is keyed by the bare cell");
  assert.ok(inside(CELL, spot), "the pip sits inside its own cell");
  // Not the centre: a row of hearts along a street must not line up.
  const c = decodeGeohash(CELL);
  assert.ok(spot.lat !== c.lat || spot.lon !== c.lon, "hash-placed, not centred");
});

test("heartFor: deterministic, and junk is refused rather than thrown", () => {
  assert.deepEqual(heartFor(CELL, ALL), heartFor(CELL, ALL));
  assert.equal(heartFor("not-a-cell", ALL), null);
  assert.equal(heartFor("", ALL), null);
  assert.equal(heartFor(null, ALL), null);
  // deepEqual, NOT equal: at the default rate both sides may be objects, and
  // `equal` would then compare identity and fail for a reason that has nothing
  // to do with the fallback. This is the file's own lucky-hash warning applied
  // to itself.
  assert.deepEqual(heartFor(CELL, { rate: 0 }), heartFor(CELL, {}), "a junk rate falls back to the default");
});

test("heartFor at the default rate hits roughly one cell in three", () => {
  let hits = 0;
  const total = 3000;
  let n = 0;
  for (let i = 0; i < total; i++) {
    // A spread of real coordinates, not sequential strings: geohash prefixes
    // are not uniform over arbitrary text.
    const lat = -60 + ((i * 7919) % 12000) / 100;
    const lon = -170 + ((i * 6271) % 34000) / 100;
    const cell = encodeGeohash(lat, lon, 7);
    n += 1;
    if (heartFor(cell, { rate: HEART_RATE_DEFAULT })) hits += 1;
  }
  const share = hits / n;
  assert.ok(share > 0.28 && share < 0.39, `expected ~1/3, got ${share}`);
});

test("wildHeartFor: window-scoped, and a DIFFERENT place from the first heart", () => {
  const w = 610;
  const wild = wildHeartFor(CELL, w, ALL);
  assert.ok(wild);
  assert.equal(wild.source, "wild");
  assert.equal(wild.key, CELL + ":" + w, "a wild heart is keyed by cell AND window");
  assert.ok(inside(CELL, wild));
  const first = heartFor(CELL, ALL);
  assert.ok(wild.lat !== first.lat || wild.lon !== first.lon,
    "independent salts: the two sources must not land on the same spot");
  assert.notDeepEqual(wildHeartFor(CELL, w + 1, ALL), wild, "a new window is a new roll");
  assert.equal(wildHeartFor(CELL, "nope", ALL), null);
  assert.equal(wildHeartFor("bad", w, ALL), null);
});

test("wildWindow buckets by whole days and falls back on junk", () => {
  const day = 24 * 3600 * 1000;
  assert.equal(wildWindow(0, 30), 0);
  assert.equal(wildWindow(30 * day - 1, 30), 0);
  assert.equal(wildWindow(30 * day, 30), 1);
  assert.equal(wildWindow(60 * day, 30), 2);
  assert.equal(wildWindow(60 * day, 0), wildWindow(60 * day, HEART_WILD_DAYS_DEFAULT));
  assert.equal(wildWindow(60 * day, "x"), wildWindow(60 * day, HEART_WILD_DAYS_DEFAULT));
});

test("heartCandidates lists BOTH sources, permanent first — it never hides the wild one", () => {
  // ⚠ This is the shape the plan review forced. An `a || b` candidate would
  // short-circuit forever once the permanent heart was taken, so at the default
  // rate one cell in three could never grow a wild heart again — while the code
  // comment promised the opposite.
  const both = heartCandidates(CELL, 610, ALL);
  assert.equal(both.length, 2, "both sources hit at rate 1, and both are offered");
  assert.equal(both[0].source, "first", "the once-ever heart is offered first");
  assert.equal(both[1].source, "wild", "but the regrowing one is still there behind it");
  assert.deepEqual(both[0], heartFor(CELL, ALL));
  assert.deepEqual(both[1], wildHeartFor(CELL, 610, ALL));

  // The huge rates are asserted to miss rather than assumed to, so a surprise
  // hit reads as a precondition failure instead of a confusing shape failure.
  assert.equal(heartFor(CELL, { rate: 999999 }), null, "precondition: no first heart at this rate");
  const onlyWild = heartCandidates(CELL, 610, { rate: 999999, wildRate: 1 });
  assert.deepEqual(onlyWild.map((c) => c.source), ["wild"]);

  assert.equal(wildHeartFor(CELL, 610, { wildRate: 999999 }), null, "precondition: no wild heart either");
  assert.deepEqual(heartCandidates(CELL, 610, { rate: 999999, wildRate: 999999 }), []);
  assert.deepEqual(heartCandidates("bad", 610, ALL), []);
});

test("readHeartSettings reads all six keys, and refuses junk", async () => {
  const db = createClient({ url: "file::memory:" });
  await initRambleTables(db);
  const put = (k, v) => db.execute({
    sql: "INSERT INTO ramble_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    args: [k, v],
  });

  assert.deepEqual(await readHeartSettings(db), {
    rate: 3, wildDays: 30, wildRate: 40, energyBase: 100, perHeart: 10, cap: 300,
  }, "an untouched db reads the defaults");

  await put("heart.rate", "1");
  await put("heart.wild.days", "7");
  await put("heart.wild.rate", "2");
  await put("energy.max.base", "80");
  await put("energy.max.per.heart", "25");
  await put("energy.max.cap", "500");
  assert.deepEqual(await readHeartSettings(db), {
    rate: 1, wildDays: 7, wildRate: 2, energyBase: 80, perHeart: 25, cap: 500,
  });

  for (const k of ["heart.rate", "heart.wild.days", "heart.wild.rate", "energy.max.base", "energy.max.per.heart", "energy.max.cap"]) {
    await put(k, "banana");
  }
  assert.deepEqual(await readHeartSettings(db), {
    rate: 3, wildDays: 30, wildRate: 40, energyBase: 100, perHeart: 10, cap: 300,
  }, "junk everywhere falls all the way back");

  // A cap below the base would clamp a heartless bird's energy DOWN. Refuse it.
  await put("energy.max.base", "100");
  await put("energy.max.cap", "40");
  assert.equal((await readHeartSettings(db)).cap, 100, "the cap is never below the base");
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH
node scripts/run-suite.mjs tests/ramble-hearts.test.js
```

Expected: FAIL — `Cannot find module .../bundles/ramble/server/hearts.js`.

- [ ] **Step 3: Write `bundles/ramble/server/hearts.js`**

```js
/**
 * Heart containers (spec 2026-09-08 §2.3, §3, D6).
 *
 * The rare currency. A heart raises the bird's MAXIMUM energy and does nothing
 * else — the Zelda mapping D6 names: seed buys gear, hearts only extend the
 * bar. There is no spend path in this phase.
 *
 * WHERE A HEART IS is a hash of the cell, copying nestFor and seedFor: the
 * answer is identical on every one of the user's devices with nothing stored
 * and nothing to sync, and it cannot be re-rolled by leaving and coming back.
 * Two independent sources, two independent salts:
 *
 *   - the FIRST heart, keyed by the bare cell, once ever, roughly 1 in
 *     `heart.rate` cells. This is the one a new unlock can surprise you with.
 *   - a WILD heart, keyed `cell:window`, in ground already unlocked, roughly
 *     1 in `heart.wild.rate` cells per `heart.wild.days` window. §2.3 accepts
 *     that this makes maximum energy grindable by a heavy walker: it is not
 *     competitive power, only a longer buffer, and it lets someone who cannot
 *     range far still progress.
 *
 * ⚠ ONE RULE, TWO READERS. `heartCandidates` is the ONLY place that decides
 * whether a cell holds a heart. The map (availableHearts) and the payout
 * (recordHeartPickup) both go through it. Phase 1 shipped a seed layer where
 * the map and the payout disagreed and had to fix it; this module exists in
 * this shape so that cannot happen again.
 *
 * ⚠ A HEART ROW'S `delta` IS ALWAYS 1 — a count of containers, never an
 * energy amount. applyRambleWallet resolves conflicts with MAX(delta), which
 * is only convergent when the value cannot differ between instances for the
 * same key; a constant cannot disagree. Storing energy would also freeze
 * `energy.max.per.heart` into history and make retuning it a no-op.
 */
import { createHash } from "node:crypto";
import { CELL7_RE } from "./nests.js";
import { decodeGeohash } from "./anchors.js";

export const HEART_KIND = "heart";
export const HEART_SALT = "ramble-heart-v1:";
export const HEART_WILD_SALT = "ramble-heart-wild-v1:";

export const HEART_RATE_DEFAULT = 3;
export const HEART_WILD_DAYS_DEFAULT = 30;
export const HEART_WILD_RATE_DEFAULT = 40;
export const ENERGY_MAX_BASE_DEFAULT = 100;
export const ENERGY_MAX_PER_HEART_DEFAULT = 10;
export const ENERGY_MAX_CAP_DEFAULT = 300;

/** Which regrowth window `now` falls in. Same cell, same window = one wild heart. */
export function wildWindow(now, days) {
  const d = Number.isFinite(Number(days)) && Number(days) >= 1 ? Number(days) : HEART_WILD_DAYS_DEFAULT;
  return Math.floor(Number(now) / (d * 24 * 3600 * 1000));
}

/**
 * The shared body: hash `salt + material`, keep 1 in `rate`, and place the
 * result at a hash-derived point INSIDE the cell rather than at its centre, so
 * a street's worth of hearts does not line up like a pegboard.
 */
function place(salt, material, rate, fallbackRate, cell, key, source) {
  if (typeof cell !== "string" || !CELL7_RE.test(cell)) return null;
  const r = Number.isInteger(rate) && rate >= 1 ? rate : fallbackRate;
  const h = createHash("sha256").update(salt + material).digest();
  if (h.readUInt32BE(0) % r !== 0) return null;
  let c;
  try { c = decodeGeohash(cell); } catch { return null; }
  if (!c || !Number.isFinite(c.lat) || !Number.isFinite(c.lon)) return null;
  const fy = h.readUInt32BE(4) / 0x100000000;
  const fx = h.readUInt32BE(8) / 0x100000000;
  return {
    cell, key, source,
    lat: c.lat - c.latErr + fy * 2 * c.latErr,
    lon: c.lon - c.lonErr + fx * 2 * c.lonErr,
  };
}

/** The once-ever heart in this cell, or null. Keyed by the bare cell. */
export function heartFor(cell, { rate = HEART_RATE_DEFAULT } = {}) {
  return place(HEART_SALT, String(cell), rate, HEART_RATE_DEFAULT, cell, String(cell), "first");
}

/** The regrowing heart in this cell in this window, or null. Keyed `cell:window`. */
export function wildHeartFor(cell, window, { wildRate = HEART_WILD_RATE_DEFAULT } = {}) {
  if (!Number.isFinite(Number(window))) return null;
  const w = Number(window);
  return place(HEART_WILD_SALT, String(cell) + ":" + String(w), wildRate, HEART_WILD_RATE_DEFAULT,
    cell, String(cell) + ":" + String(w), "wild");
}

/**
 * THE ONE RULE. Every heart this cell could hold right now, in priority order.
 *
 * The permanent heart is offered first when both hit: it is the rarer of the
 * two and it disappears forever once taken, so handing it over first is
 * strictly better for the player. The wild heart comes round again next window.
 *
 * ⚠ RETURNS BOTH, and deliberately. The obvious `heartFor(...) || wildHeartFor(...)`
 * short-circuits: once a cell's permanent heart is in the ledger, that version
 * keeps returning the taken spot and never consults the wild source, so at the
 * default rate one cell in three would be sterile for wild hearts FOREVER —
 * while this very comment promised it "comes round again". The callers, which
 * are the only things that know what has been taken, pick the first candidate
 * that is still there.
 */
export function heartCandidates(cell, window, { rate = HEART_RATE_DEFAULT, wildRate = HEART_WILD_RATE_DEFAULT } = {}) {
  const out = [];
  const first = heartFor(cell, { rate });
  if (first) out.push(first);
  const wild = wildHeartFor(cell, window, { wildRate });
  if (wild) out.push(wild);
  return out;
}

/** Live settings (spec §6.4 plus the two deviations). Junk or a negative falls back. */
export async function readHeartSettings(db) {
  const out = {
    rate: HEART_RATE_DEFAULT,
    wildDays: HEART_WILD_DAYS_DEFAULT,
    wildRate: HEART_WILD_RATE_DEFAULT,
    energyBase: ENERGY_MAX_BASE_DEFAULT,
    perHeart: ENERGY_MAX_PER_HEART_DEFAULT,
    cap: ENERGY_MAX_CAP_DEFAULT,
  };
  try {
    const { rows } = await db.execute({
      sql: `SELECT key, value FROM ramble_settings WHERE key IN
            ('heart.rate', 'heart.wild.days', 'heart.wild.rate',
             'energy.max.base', 'energy.max.per.heart', 'energy.max.cap')`,
      args: [],
    });
    for (const r of rows || []) {
      const n = parseInt(r.value, 10);
      if (!Number.isInteger(n)) continue;
      if (r.key === "heart.rate" && n >= 1) out.rate = n;
      if (r.key === "heart.wild.days" && n >= 1) out.wildDays = n;
      if (r.key === "heart.wild.rate" && n >= 1) out.wildRate = n;
      if (r.key === "energy.max.base" && n >= 1) out.energyBase = n;
      // >= 1, not >= 0: a zero would make every heart inert while the pet page
      // still counted them, and (with the cap normalized up to the base below)
      // would announce "the bar is as long as it goes" from the very first one.
      if (r.key === "energy.max.per.heart" && n >= 1) out.perHeart = n;
      if (r.key === "energy.max.cap" && n >= 1) out.cap = n;
    }
  } catch { /* defaults */ }
  // A cap below the base would clamp a heartless bird's energy DOWN, which is
  // a punishment no setting in this design is allowed to hand out.
  if (out.cap < out.energyBase) out.cap = out.energyBase;
  return out;
}
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
node scripts/run-suite.mjs tests/ramble-hearts.test.js
```

Expected: PASS, 8 tests. The statistical test was measured at `share = 0.3293` over 3000 cells while this plan was written, comfortably inside the band.

- [ ] **Step 5: Pin the salt with a regression vector**

The statistical test proves the *shape* of the distribution; it would not notice the salt changing. Pin the actual values once.

**⚠ The pin must contain confirmed HITS, and it must pin positions.** A vector of six cells that all miss reduces every assertion to `false === false`, and a `heartFor` that returned `null` unconditionally would sail through it — this plan's first draft shipped exactly that vector, and the review caught it. A pin that records only hit/miss also cannot see a placement change that keeps the pattern but moves every pip off its spot.

Run this generator, which searches for real hits on each salt rather than hoping six named cells happen to have them:

```bash
export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH
node --input-type=module -e '
import { heartFor, wildHeartFor } from "./bundles/ramble/server/hearts.js";
import { encodeGeohash } from "./bundles/ramble/server/anchors.js";
const hits = [], misses = [], wildHits = [], wildMisses = [];
for (let i = 0; i < 4000; i++) {
  const cell = encodeGeohash(-60 + ((i * 7919) % 12000) / 100, -170 + ((i * 6271) % 34000) / 100, 7);
  const f = heartFor(cell, {}), w = wildHeartFor(cell, 610, {});
  if (f && hits.length < 3) hits.push([cell, f.lat, f.lon]);
  if (!f && misses.length < 3) misses.push(cell);
  if (w && wildHits.length < 2) wildHits.push([cell, w.lat, w.lon]);
  if (!w && wildMisses.length < 2) wildMisses.push(cell);
}
console.log(JSON.stringify({ hits, misses, wildHits, wildMisses }, null, 2));'
```

Paste the observed values in, to six decimal places, and confirm before committing that `hits` and `wildHits` are **non-empty** — if either is, the generator found nothing and the pin is worthless:

```js
test("pinned: the default-rate placement never moves", () => {
  // Generated once from the salts in hearts.js. If this fails, someone changed
  // a salt or the hash arithmetic, and every existing player's map moved
  // underneath them. Hits AND misses, positions AND presence: a pin of misses
  // alone passes against a heartFor() that returns null for everything.
  const FIRST_HITS = [
    // <PASTE `hits`: [cell, lat, lon] triples — MUST be non-empty>
  ];
  const FIRST_MISSES = [/* <PASTE `misses`: cell strings> */];
  const WILD_HITS = [
    // <PASTE `wildHits`: [cell, lat, lon] triples — MUST be non-empty>
  ];
  const WILD_MISSES = [/* <PASTE `wildMisses`: cell strings> */];

  assert.ok(FIRST_HITS.length > 0 && WILD_HITS.length > 0, "a pin with no hits pins nothing");
  for (const [cell, lat, lon] of FIRST_HITS) {
    const spot = heartFor(cell, {});
    assert.ok(spot, cell + " must still hold its permanent heart");
    assert.equal(spot.lat.toFixed(6), lat.toFixed(6), cell + " heart moved in latitude");
    assert.equal(spot.lon.toFixed(6), lon.toFixed(6), cell + " heart moved in longitude");
  }
  for (const cell of FIRST_MISSES) assert.equal(heartFor(cell, {}), null, cell + " must still be empty");
  for (const [cell, lat, lon] of WILD_HITS) {
    const spot = wildHeartFor(cell, 610, {});
    assert.ok(spot, cell + " must still hold its wild heart in window 610");
    assert.equal(spot.lat.toFixed(6), lat.toFixed(6), cell + " wild heart moved in latitude");
    assert.equal(spot.lon.toFixed(6), lon.toFixed(6), cell + " wild heart moved in longitude");
  }
  for (const cell of WILD_MISSES) assert.equal(wildHeartFor(cell, 610, {}), null, cell + " must still be empty");
});
```

- [ ] **Step 6: Run it, then run the whole ramble slice**

```bash
node scripts/run-suite.mjs tests/ramble-hearts.test.js
node scripts/run-suite.mjs tests/ramble-wallet.test.js tests/ramble-cells.test.js tests/ramble-nests.test.js
```

Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add bundles/ramble/server/hearts.js tests/ramble-hearts.test.js
git commit bundles/ramble/server/hearts.js tests/ramble-hearts.test.js -m "ramble: where a heart container is, decided by the cell"
git show --stat HEAD
```

---

## Task 2: the ledger half — taking a heart, and what the map may draw

**Files:**
- Modify: `bundles/ramble/server/hearts.js` (append; do not restructure Task 1's code)
- Create: `tests/ramble-hearts-ledger.test.js`

**Interfaces:**
- Consumes: `heartCandidates`, `wildWindow`, `readHeartSettings`, `HEART_KIND`, `CELL7_RE` from Task 1, plus `ramble_wallet` and `ramble_cells` (both already exist on every host), plus `applyRambleWallet` from `servers/sharing/instance-sync.js` for the convergence test.
- Produces, for Tasks 3-4:
  - `recordHeartPickup(db, cell, { now, emit }) -> { picked: boolean, amount: 0 | 1, source?: "first" | "wild" }`
  - `availableHearts(db, cells, { now }) -> [{ cell, key, source, lat, lon }]`
  - `heartsBalance(db) -> integer`
  - `maxEnergy(db) -> integer`

**Three rules this task exists to enforce:**

1. **Same rule, two readers.** `availableHearts` and `recordHeartPickup` both go through `heartCandidates` **and both pick the first candidate that is not already taken**, so a cell whose permanent heart is gone still grows a wild one. Step 1's `same rule` test asserts the two agree cell-for-cell, before and after collection.
2. **Fail closed on unlock.** `recordHeartPickup` verifies the cell is in `ramble_cells` itself. A fix that the `unlock.max.accuracy.m` gate refused must never pay a heart in ground the user did not enter, and the route is not trusted to check.
3. **`delta` is the constant `1`.** Never `perHeart`, never a spend.

**Ruling: a cell holding BOTH a permanent and a wild heart pays them on two successive posts, and that is allowed.** `recordHeartPickup` grants one candidate per call and the panel posts an area every ~75 m of movement, so a player standing in such a cell collects two hearts seconds apart. It needs both sources to hit at once — roughly one cell in 120 at the defaults — and suppressing it would mean per-visit state this design does not have. It reads as a windfall, not a glitch. Do not add a "one heart per visit" guard.

**Why reading every heart row is fine here** (and why `harvestableCells` had to be cleverer for seed): a heart row exists only per heart actually *taken*. Firsts are capped by the player's unlocked-cell count at 1-in-3, and wilds are 1-in-40 per 30-day window. The table's heart slice is the player's lifetime collection — dozens of rows, not the roughly-one-per-cell-per-day the seed ledger accrues.

- [ ] **Step 1: Write the failing test**

Create `tests/ramble-hearts-ledger.test.js`:

```js
/**
 * Spec 2026-09-08 §6.1, §8 — the heart ledger.
 *
 * Hearts are append-only rows in ramble_wallet under kind 'heart'. There is no
 * heart TABLE and no stored balance: the count and the maximum energy derived
 * from it are both read out of the ledger, which is what makes them converge
 * across the user's own instances for free.
 *
 * ⚠ rate 1 throughout, so every cell in a fixture holds a heart and no test
 * depends on a cell that happens to hash lucky (the phase 1 lesson).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import { applyRambleWallet } from "../servers/sharing/instance-sync.js";
import {
  HEART_KIND, heartCandidates, wildWindow,
  recordHeartPickup, availableHearts, heartsBalance, maxEnergy,
} from "../bundles/ramble/server/hearts.js";

const NOW = 1_757_000_000_000;
// Six real, distinct geohash-7 cells, checked with decodeGeohash while this
// was written: Houston, Texas hill country, New York, London, Berlin, Hong
// Kong. At rate 1 every one of them holds a heart, so this fixture is exactly
// what it looks like — no cell here was chosen for hashing lucky.
const CELLS = ["9vk79ed", "9v6m2xt", "dr5regw", "gcpvj0d", "u33dc0e", "wecnrmd"];

// `per` and `cap` are used by the energy tests below; `rate`/`wildRate` are
// pinned per-test so no test depends on a cell that happens to hash lucky.
async function freshDb({ rate = 1, wildRate = 999999, base, per, cap } = {}) {
  const db = createClient({ url: "file::memory:" });
  await initRambleTables(db);
  const put = (k, v) => db.execute({
    sql: "INSERT INTO ramble_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    args: [k, String(v)],
  });
  await put("heart.rate", rate);
  await put("heart.wild.rate", wildRate);
  if (base != null) await put("energy.max.base", base);
  if (per != null) await put("energy.max.per.heart", per);
  if (cap != null) await put("energy.max.cap", cap);
  return db;
}

async function unlock(db, cells, at = NOW) {
  for (const c of cells) {
    await db.execute({
      sql: "INSERT INTO ramble_cells (cell, first_unlocked_at) VALUES (?, ?) ON CONFLICT(cell) DO NOTHING",
      args: [c, at],
    });
  }
}

const walletRows = async (db) =>
  (await db.execute({ sql: "SELECT * FROM ramble_wallet WHERE kind = ? ORDER BY key", args: [HEART_KIND] })).rows;

test("a heart is NEVER granted in a cell that is not unlocked — fail closed", async () => {
  const db = await freshDb();
  const out = await recordHeartPickup(db, CELLS[0], { now: NOW });
  assert.deepEqual(out, { picked: false, amount: 0 });
  assert.equal((await walletRows(db)).length, 0, "no row, so no heart");
  assert.equal(await heartsBalance(db), 0);
});

test("the first pickup writes exactly one row with delta 1, and emits it", async () => {
  const db = await freshDb();
  await unlock(db, [CELLS[0]]);
  const seen = [];
  const emit = (table, op, row) => { seen.push({ table, op, row }); };

  const out = await recordHeartPickup(db, CELLS[0], { now: NOW, emit });
  assert.deepEqual(out, { picked: true, amount: 1, source: "first" });

  const rows = await walletRows(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, CELLS[0], "a first heart is keyed by the bare cell");
  assert.equal(Number(rows[0].delta), 1, "delta is a COUNT of containers, never an energy amount");
  assert.equal(Number(rows[0].created_at), NOW);

  assert.equal(seen.length, 1, "the outbound half: without this the ledger syncs one way only");
  assert.equal(seen[0].table, "ramble_wallet");
  assert.equal(seen[0].op, "insert");
  assert.equal(seen[0].row.kind, HEART_KIND);
  assert.equal(seen[0].row.delta, 1);
});

test("the permanent heart is gone for good — a second visit pays nothing, ever", async () => {
  const db = await freshDb();
  await unlock(db, [CELLS[0]]);
  await recordHeartPickup(db, CELLS[0], { now: NOW });

  assert.deepEqual(await recordHeartPickup(db, CELLS[0], { now: NOW }), { picked: false, amount: 0 });
  const muchLater = NOW + 400 * 24 * 3600 * 1000;
  assert.deepEqual(heartCandidates(CELLS[0], wildWindow(muchLater, 30), { rate: 1, wildRate: 999999 })
    .map((c) => c.source), ["first"], "precondition: the wild source is silent, even 400 days out");
  assert.deepEqual(await recordHeartPickup(db, CELLS[0], { now: muchLater }), { picked: false, amount: 0 });
  assert.equal((await walletRows(db)).length, 1);
});

test("a wild heart regrows: once per window, again in the next", async () => {
  // No first hearts at all, so every hit here is unambiguously a wild one.
  const db = await freshDb({ rate: 999999, wildRate: 1 });
  await unlock(db, [CELLS[0]]);
  const day = 24 * 3600 * 1000;
  // Asserted, not assumed: a surprise first heart at this rate would otherwise
  // fail below as a baffling "source" mismatch.
  assert.deepEqual(heartCandidates(CELLS[0], wildWindow(NOW, 30), { rate: 999999, wildRate: 999999 }), [],
    "precondition: neither source hits at these rates");

  const first = await recordHeartPickup(db, CELLS[0], { now: NOW });
  assert.deepEqual(first, { picked: true, amount: 1, source: "wild" });
  assert.deepEqual(await recordHeartPickup(db, CELLS[0], { now: NOW + day }), { picked: false, amount: 0 },
    "still the same 30-day window");

  const next = await recordHeartPickup(db, CELLS[0], { now: NOW + 31 * day });
  assert.deepEqual(next, { picked: true, amount: 1, source: "wild" });

  const rows = await walletRows(db);
  assert.equal(rows.length, 2);
  for (const r of rows) assert.match(String(r.key), /^[0-9b-hjkmnp-z]{7}:\d+$/, "wild keys carry their window");
});

test("THE SAME RULE: what the map draws is exactly what a walk would grant", async () => {
  // The phase 1 defect, made executable. A heart shown but not granted (or
  // granted but never shown) is the bug that shipped in the seed layer.
  const db = await freshDb();
  await unlock(db, CELLS);

  const drawn = await availableHearts(db, CELLS, { now: NOW });
  assert.equal(drawn.length, CELLS.length, "rate 1: every unlocked cell in the fixture");
  for (const spot of drawn) {
    assert.deepEqual(spot, heartCandidates(spot.cell, wildWindow(NOW, 30), { rate: 1, wildRate: 999999 })[0],
      "the map draws the candidate itself, not a re-derived guess");
  }

  // Take three of them, then assert the two readers STILL agree.
  const taken = CELLS.slice(0, 3);
  for (const c of taken) {
    assert.equal((await recordHeartPickup(db, c, { now: NOW })).picked, true);
  }
  const after = await availableHearts(db, CELLS, { now: NOW });
  assert.deepEqual(after.map((s) => s.cell).sort(), CELLS.slice(3).sort(),
    "a collected heart leaves the map");
  for (const c of taken) {
    assert.equal((await recordHeartPickup(db, c, { now: NOW })).picked, false,
      "and a cell the map no longer draws grants nothing");
  }
  for (const c of CELLS.slice(3)) {
    assert.equal((await recordHeartPickup(db, c, { now: NOW })).picked, true,
      "while every cell the map still draws does grant");
  }
});

test("availableHearts never leaves unlocked ground, and never throws on junk", async () => {
  const db = await freshDb();
  await unlock(db, [CELLS[0]]);
  const asked = [CELLS[0], CELLS[1], "not-a-cell", "", null, 7];
  const drawn = await availableHearts(db, asked, { now: NOW });
  assert.deepEqual(drawn.map((s) => s.cell), [CELLS[0]],
    "a cell the caller has not unlocked is not drawn even when it is asked for");
  assert.deepEqual(await availableHearts(db, [], { now: NOW }), []);
  assert.deepEqual(await availableHearts(db, null, { now: NOW }), []);
});

test("heartsBalance counts containers; maxEnergy derives the bar and honours the cap", async () => {
  const db = await freshDb({ rate: 1, base: 100, per: 10, cap: 130 });
  assert.equal(await heartsBalance(db), 0);
  assert.equal(await maxEnergy(db), 100, "no hearts: the base");

  await unlock(db, CELLS);
  for (const c of CELLS.slice(0, 2)) await recordHeartPickup(db, c, { now: NOW });
  assert.equal(await heartsBalance(db), 2);
  assert.equal(await maxEnergy(db), 120, "base + hearts x per-heart");

  for (const c of CELLS.slice(2)) await recordHeartPickup(db, c, { now: NOW });
  assert.equal(await heartsBalance(db), 6);
  assert.equal(await maxEnergy(db), 130, "the cap holds");
});

test("seed rows are not hearts and hearts are not seed", async () => {
  const db = await freshDb();
  await unlock(db, [CELLS[0]]);
  await db.execute({
    sql: "INSERT INTO ramble_wallet (kind, key, delta, created_at) VALUES ('seed', ?, 5, ?)",
    args: [CELLS[0] + ":1", NOW],
  });
  await recordHeartPickup(db, CELLS[0], { now: NOW });
  assert.equal(await heartsBalance(db), 1, "the seed pile does not inflate the heart count");
});

test("a cell grows a WILD heart after its permanent one is taken", async () => {
  // ⚠ The defect the plan review caught. An `a || b` candidate keeps returning
  // the taken permanent heart and never reaches the wild source, so at the
  // default rate one cell in three would be sterile forever. Both sources hit
  // here (rate 1, wildRate 1), which is the only configuration that can tell
  // the two implementations apart — every other test in this file silences one
  // source to isolate the other, and that is exactly how this hid.
  const db = await freshDb({ rate: 1, wildRate: 1 });
  await unlock(db, [CELLS[0]]);

  const first = await recordHeartPickup(db, CELLS[0], { now: NOW });
  assert.deepEqual(first, { picked: true, amount: 1, source: "first" });

  const wild = await recordHeartPickup(db, CELLS[0], { now: NOW });
  assert.deepEqual(wild, { picked: true, amount: 1, source: "wild" },
    "the wild heart in the same window is still there to take");

  assert.deepEqual(await recordHeartPickup(db, CELLS[0], { now: NOW }), { picked: false, amount: 0 },
    "and now the cell really is empty for this window");

  const day = 24 * 3600 * 1000;
  const nextWindow = await recordHeartPickup(db, CELLS[0], { now: NOW + 31 * day });
  assert.deepEqual(nextWindow, { picked: true, amount: 1, source: "wild" },
    "next window, the wild heart comes round again — as the doc comment promises");

  // And the map agrees at every step, which is the whole point.
  assert.deepEqual(await availableHearts(db, [CELLS[0]], { now: NOW }), []);
  assert.equal((await availableHearts(db, [CELLS[0]], { now: NOW + 62 * day })).length, 1);
});

test("a heart row is worth ONE container even when a heart is worth 25 energy", async () => {
  // The assertion that would actually fail if someone later stored energy in
  // the row. Asserting that MAX(delta) of two identical 1s is 1 proves nothing.
  const db = await freshDb({ rate: 1, per: 25 });
  await unlock(db, [CELLS[0]]);
  await recordHeartPickup(db, CELLS[0], { now: NOW });
  const rows = await walletRows(db);
  assert.equal(Number(rows[0].delta), 1, "delta is a COUNT; the energy per heart lives in a setting");
  assert.equal(await heartsBalance(db), 1);
  assert.equal(await maxEnergy(db), 125, "and the setting is what values it");
});

test("two instances converge on the same heart count whatever order rows arrive in", async () => {
  // Spec §8: anything that replicates needs a multi-instance test, not a
  // single-database one. delta is a constant 1, so MAX(delta) — which phase 1
  // had to fix for seed — is safe here BY CONSTRUCTION. This test is what says
  // so out loud.
  const rows = [
    { kind: HEART_KIND, key: CELLS[0], delta: 1, created_at: NOW },
    { kind: HEART_KIND, key: CELLS[1], delta: 1, created_at: NOW + 10 },
    { kind: HEART_KIND, key: CELLS[2] + ":610", delta: 1, created_at: NOW + 20 },
  ];
  const a = await freshDb();
  const b = await freshDb();
  for (let i = 0; i < rows.length; i++) await applyRambleWallet(a, "insert", rows[i], 10 + i);
  for (let i = rows.length - 1; i >= 0; i--) await applyRambleWallet(b, "insert", rows[i], 10 + i);
  // And a duplicate arriving late on both.
  await applyRambleWallet(a, "insert", rows[0], 99);
  await applyRambleWallet(b, "insert", rows[0], 99);

  assert.equal(await heartsBalance(a), 3);
  assert.equal(await heartsBalance(b), 3);
  assert.equal(await maxEnergy(a), await maxEnergy(b));
  for (const r of await walletRows(a)) assert.equal(Number(r.delta), 1, "no row ever grew");
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH
node scripts/run-suite.mjs tests/ramble-hearts-ledger.test.js
```

Expected: FAIL — `recordHeartPickup is not a function`.

- [ ] **Step 3: Append the ledger half to `bundles/ramble/server/hearts.js`**

```js
/** Mirrors eggs.js's helper: an emit must never be able to fail the write. */
async function safeEmit(emit, table, op, row) {
  if (typeof emit !== "function") return;
  try { await emit(table, op, row); }
  catch (err) { try { console.warn(`[ramble] emit ${table} failed:`, err?.message); } catch {} }
}

/** Every heart key already taken. Bounded by the player's lifetime collection. */
async function takenKeys(db) {
  const { rows } = await db.execute({
    sql: "SELECT key FROM ramble_wallet WHERE kind = ?", args: [HEART_KIND],
  });
  return new Set((rows || []).map((r) => String(r.key)));
}

/**
 * Which of the ASKED cells are unlocked. Bounded by the question, not by the
 * player's history: `SELECT cell FROM ramble_cells` would be a second
 * unbounded full-table scan on every /zones request, and phase 1 already left
 * one of those behind in unlockedCellsNear. The caller has usually filtered to
 * unlocked ground already, but this stays fail-closed rather than trusting it.
 */
async function unlockedAmong(db, cells) {
  const out = new Set();
  // Chunked: a close-zoom viewport over a walked town can ask about more cells
  // than SQLite will bind at once, which is the same limit harvestableCells
  // avoids by matching on a key suffix instead.
  for (let i = 0; i < cells.length; i += 400) {
    const chunk = cells.slice(i, i + 400);
    const marks = chunk.map(() => "?").join(",");
    // eslint-disable-next-line no-await-in-loop
    const { rows } = await db.execute({
      sql: `SELECT cell FROM ramble_cells WHERE cell IN (${marks})`, args: chunk,
    });
    for (const r of rows || []) out.add(String(r.cell));
  }
  return out;
}

/**
 * Take the heart in this cell, if there is one and it is still there.
 *
 * ⚠ FAIL CLOSED. The cell must already be in ramble_cells. A position fix
 * vaguer than `unlock.max.accuracy.m` is refused an unlock, and it must be
 * refused a heart on exactly the same grounds — otherwise a 2 km wifi fix pays
 * out in ground the user never entered. Checked HERE rather than trusted to
 * the caller, because this function is the payout.
 */
export async function recordHeartPickup(db, cell, { now = Date.now(), emit } = {}) {
  const none = { picked: false, amount: 0 };
  if (!db || typeof cell !== "string" || !CELL7_RE.test(cell)) return none;
  try {
    const { rows } = await db.execute({
      sql: "SELECT 1 AS ok FROM ramble_cells WHERE cell = ?", args: [cell],
    });
    if (!rows || rows.length === 0) return none;

    const { rate, wildDays, wildRate } = await readHeartSettings(db);
    // NOT `Number(now) || Date.now()` — that treats `now: 0` as falsy and
    // silently substitutes the real clock (the phase 1 note on this still holds).
    const at = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    // EVERY candidate, in priority order, not just the first: a cell whose
    // permanent heart was collected long ago must still be able to pay out its
    // wild one. The INSERT is the arbiter — whichever key is not yet in the
    // ledger is the one that pays.
    for (const spot of heartCandidates(cell, wildWindow(at, wildDays), { rate, wildRate })) {
      // eslint-disable-next-line no-await-in-loop
      const res = await db.execute({
        sql: `INSERT INTO ramble_wallet (kind, key, delta, created_at) VALUES (?, ?, 1, ?)
              ON CONFLICT(kind, key) DO NOTHING`,
        args: [HEART_KIND, spot.key, at],
      });
      if (Number(res.rowsAffected) === 0) continue;
      // eslint-disable-next-line no-await-in-loop
      await safeEmit(emit, "ramble_wallet", "insert",
        { kind: HEART_KIND, key: spot.key, delta: 1, created_at: at });
      return { picked: true, amount: 1, source: spot.source };
    }
    return none;
  } catch (err) {
    try { console.warn("[ramble] heart pickup failed:", err?.message); } catch {}
    return none;
  }
}

/**
 * Which of these cells still hold a heart to walk to.
 *
 * ⚠ THE SAME RULE THE PAYOUT USES. This goes through heartCandidates and takes
 * the first untaken one, exactly as recordHeartPickup does, and returns the
 * candidate object itself rather than a re-derived position — so the map cannot
 * drift from the payout. That drift is the hazard 0.9.5 closed for seed.
 *
 * Cells the caller has not unlocked are dropped even when they are asked for:
 * a heart in fog would be a preview of ground you have not earned (K3).
 */
export async function availableHearts(db, cells, { now = Date.now() } = {}) {
  const asked = (Array.from(cells || [])).filter((c) => typeof c === "string" && CELL7_RE.test(c));
  if (!db || asked.length === 0) return [];
  try {
    const { rate, wildDays, wildRate } = await readHeartSettings(db);
    const at = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    const window = wildWindow(at, wildDays);
    const unlocked = await unlockedAmong(db, asked);
    const taken = await takenKeys(db);
    const out = [];
    for (const cell of asked) {
      if (!unlocked.has(cell)) continue;
      // The FIRST candidate still standing — the same choice recordHeartPickup
      // makes when it walks the list and lets the INSERT arbitrate.
      const spot = heartCandidates(cell, window, { rate, wildRate }).find((c) => !taken.has(c.key));
      if (spot) out.push(spot);
    }
    return out;
  } catch (err) {
    // A map that cannot say where a heart is should still draw. Never throw.
    try { console.warn("[ramble] availableHearts failed:", err?.message); } catch {}
    return [];
  }
}

/** How many containers the player holds. Every row is worth exactly one. */
export async function heartsBalance(db) {
  try {
    const { rows } = await db.execute({
      sql: "SELECT COALESCE(SUM(delta), 0) AS total FROM ramble_wallet WHERE kind = ?",
      args: [HEART_KIND],
    });
    return Number(rows?.[0]?.total) || 0;
  } catch { return 0; }
}

/**
 * The bird's ceiling: the base plus one step per container, capped.
 *
 * DERIVED, never stored. A stored maximum would be a balance, and §6.1's whole
 * point is that a balance loses increments to last-writer-wins. It also means
 * retuning `energy.max.per.heart` retunes every existing player's bar, which is
 * what makes these numbers settings rather than a redesign.
 */
export async function maxEnergy(db) {
  try {
    const { energyBase, perHeart, cap } = await readHeartSettings(db);
    return Math.min(cap, energyBase + (await heartsBalance(db)) * perHeart);
  } catch { return ENERGY_MAX_BASE_DEFAULT; }
}
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
node scripts/run-suite.mjs tests/ramble-hearts-ledger.test.js
node scripts/run-suite.mjs tests/ramble-hearts.test.js
```

Expected: both PASS.

- [ ] **Step 5: Prove nothing else moved**

```bash
node scripts/run-suite.mjs tests/ramble-wallet.test.js tests/ramble-cells.test.js tests/ramble-cells-sync.test.js tests/ramble-sync.test.js
```

Expected: PASS. `ramble_wallet` gained a second `kind` and nothing else; if a seed test fails here, the change leaked.

- [ ] **Step 6: Commit**

```bash
git add tests/ramble-hearts-ledger.test.js
git commit bundles/ramble/server/hearts.js tests/ramble-hearts-ledger.test.js -m "ramble: taking a heart, and the one rule the map and the payout share"
git show --stat HEAD
```

---

## Task 3: the bar actually gets longer — `pet.js` clamps against the derived maximum

**Files:**
- Modify: `bundles/ramble/server/pet.js`
- Modify: `bundles/ramble/server/feed.js` (its `readPet` helper only)
- Modify: `tests/ramble-pet.test.js` (append cases; change nothing that exists)

**Interfaces:**
- Consumes: `maxEnergy(db)` and `ENERGY_MAX_BASE_DEFAULT` from Task 1/2's `hearts.js`.
- Produces, for Task 4 and the panel: `feed()`, `doChore().pet` and `petState()` all carry `energy_max`; `petFromRow(row, energyMax)` takes a second argument.

**Import direction:** `pet.js` imports `hearts.js`. `hearts.js` must never import `pet.js` — that would be a cycle, the same trap `doChore` already documents about `feed.js`.

**Two rulings this task encodes:**

- **`moodFor` is UNCHANGED — happy at 60, tired at 30, absolute.** Spec §4.3: "a larger maximum energy means more slack before dropping below happy". A percentage threshold would hand a bigger bar no benefit whatsoever and make hearts purely cosmetic — the exact complaint that started this arc.
- **The number shown and the number clamped are the same number.** `petState().energy_max` is what the panel draws the bar against, and it is the identical `maxEnergy(db)` call `feed()` clamps with. Phase 1's lesson, applied to the second surface.

- [ ] **Step 1: Write the failing tests**

Append to `tests/ramble-pet.test.js` (keep the file's existing imports; add `maxEnergy`, and the settings helper if the file has none):

```js
/* --- Phase 2: heart containers raise the ceiling (spec §3, §4.3, D6). --- */

import { maxEnergy } from "../bundles/ramble/server/hearts.js";

const HEART_CELLS = ["9vk79ed", "9v6m2xt", "dr5regw", "gcpvj0d", "u33dc0e", "wecnrmd"];

async function giveHearts(db, n) {
  // Ledger rows directly: this file tests the PET, not the pickup path.
  for (let i = 0; i < n; i++) {
    await db.execute({
      sql: "INSERT INTO ramble_wallet (kind, key, delta, created_at) VALUES ('heart', ?, 1, 0)",
      args: [HEART_CELLS[i % HEART_CELLS.length] + ":pet" + i],
    });
  }
}

test("with no hearts the ceiling is still 100, exactly as before", async () => {
  const db = await freshDb();
  assert.equal(await maxEnergy(db), 100);
  for (let i = 0; i < 12; i++) await feed(db, { type: "meet_crow" }, { now: 1000 });
  const pet = await petState(db, { now: 1000 });
  assert.equal(pet.energy, 100, "the old ceiling holds for a player with no hearts");
  assert.equal(pet.energy_max, 100);
});

test("five hearts raise the ceiling to 150, and feed() fills to it", async () => {
  const db = await freshDb();
  await giveHearts(db, 5);
  assert.equal(await maxEnergy(db), 150);
  for (let i = 0; i < 12; i++) await feed(db, { type: "meet_crow" }, { now: 1000 });
  const pet = await petState(db, { now: 1000 });
  assert.equal(pet.energy, 150, "the bird fills the longer bar");
  assert.equal(pet.energy_max, 150, "and the number drawn is the number clamped");
});

test("mood thresholds stay ABSOLUTE, so a longer bar buys real slack", async () => {
  // Spec §4.3: hearts buy resilience. At max 150, energy 70 is still happy —
  // a percentage threshold would have made it tired and hearts pointless.
  const db = await freshDb();
  await giveHearts(db, 5);
  for (let i = 0; i < 12; i++) await feed(db, { type: "meet_crow" }, { now: 1000 });
  const six = 6 * 60 * 60 * 1000;
  // 150 -> 70 is eight decay intervals; a 100-max bird would be at 20 by now.
  const pet = await petState(db, { now: 1000 + 8 * six });
  assert.equal(pet.energy, 70);
  assert.equal(pet.mood, "happy", "still happy at 70 because 60 is an absolute threshold");
});

test("decay still bottoms out at 0 whatever the ceiling is", async () => {
  const db = await freshDb();
  await giveHearts(db, 20);
  await feed(db, { type: "meet_crow" }, { now: 1000 });
  const year = 365 * 24 * 60 * 60 * 1000;
  const pet = await petState(db, { now: 1000 + year });
  assert.equal(pet.energy, 0);
  assert.equal(pet.mood, "alarmed");
});

test("lowering a setting clamps a bird that is already over the new ceiling, on read", async () => {
  const db = await freshDb();
  await giveHearts(db, 5);
  for (let i = 0; i < 12; i++) await feed(db, { type: "meet_crow" }, { now: 1000 });
  assert.equal((await petState(db, { now: 1000 })).energy, 150);

  await db.execute({
    sql: "INSERT INTO ramble_settings (key, value) VALUES ('energy.max.per.heart', '2') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    args: [],
  });
  const pet = await petState(db, { now: 1000 });
  assert.equal(pet.energy_max, 110);
  assert.equal(pet.energy, 110, "an over-ceiling bird READS as the new bar");
  // ⚠ and is NOT written down. Sync applies ramble_pet before ramble_wallet, so
  // a synced-in 150 would otherwise be truncated to 100 in the window before
  // this instance's heart rows land — an unrecoverable loss. The stored value
  // waits for the ledger; only decay writes.
  const row = (await db.execute({ sql: "SELECT energy FROM ramble_pet WHERE owner = 'self'", args: [] })).rows[0];
  assert.equal(Number(row.energy), 150, "the stored value survives a ceiling that dropped underneath it");

  // Put the setting back and the energy is still there, not lost.
  await db.execute({
    sql: "UPDATE ramble_settings SET value = '10' WHERE key = 'energy.max.per.heart'", args: [],
  });
  assert.equal((await petState(db, { now: 1000 })).energy, 150, "nothing was destroyed on the way");
});

test("every pet shape carries the same energy_max — feed, chore, and the no-op chore", async () => {
  const db = await freshDb();
  await giveHearts(db, 3);
  const fed = await feed(db, { type: "checkin" }, { now: 1000 });
  assert.equal(fed.energy_max, 130);
  const chore = await doChore(db, "feed", { now: 1000 });
  assert.equal(chore.pet.energy_max, 130);
  const repeat = await doChore(db, "feed", { now: 1000 });
  assert.equal(repeat.done, false);
  assert.equal(repeat.pet.energy_max, 130, "the no-op branch must not report a different bar");
});
```

**Note for the implementer:** `tests/ramble-pet.test.js` already defines `freshDb()` (line 22) — an in-memory client with `initRambleTables` run over it, which therefore already has `ramble_wallet` and `ramble_settings`. Reuse it; do not add a second helper. The file's existing imports (`feed`, `petState`, `moodFor`, `FEED_DELTAS`, `doChore`) stay as they are.

- [ ] **Step 2: Run and watch it fail**

```bash
export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH
node scripts/run-suite.mjs tests/ramble-pet.test.js
```

Expected: FAIL — `energy_max` is `undefined`, and the 150 assertions read 100.

- [ ] **Step 3: Make `pet.js` read the ceiling**

Four edits, all inside `bundles/ramble/server/pet.js`:

1. Import at the top, under the existing `localDay` import:

```js
import { maxEnergy, ENERGY_MAX_BASE_DEFAULT } from "./hearts.js";
```

2. Replace `clampEnergy`:

```js
/**
 * The ceiling is DERIVED from the heart ledger (spec §3, D6), so it is passed
 * in rather than read here — every caller has already fetched it once and a
 * second read would risk clamping against a different number than the one the
 * panel is about to draw.
 */
function clampEnergy(v, max) {
  return Math.max(0, Math.min(Number.isFinite(max) ? max : ENERGY_MAX_BASE_DEFAULT, v));
}
```

3. In `feed()`, read the ceiling once and report it. Replace the `const delta` / `const energy` / `const mood` block with:

```js
  const delta = FEED_DELTAS[type];
  const max = await maxEnergy(db);
  const energy = clampEnergy(row.energy + delta, max);
  const mood = moodFor(energy);
```

and add `energy_max: max` to the object `feed()` returns:

```js
  return { owner: "self", mood, energy, energy_max: max, places_week, unlocks_week, crows_week, week_start, last_fed_at };
```

4. In `petState()`, clamp against the ceiling — including when the ceiling has *moved down* under a bird that is already over it, which a settings change can do.

**⚠ Clamp the REPORTED value; persist only what decay changed.** `SYNCED_TABLES` in `servers/sharing/instance-sync.js` applies `ramble_settings` and `ramble_pet` **before** `ramble_wallet`. On a pairing or backfill, a synced pet row at energy 150 lands while this instance still has no heart rows, so `maxEnergy` reads 100 — and if the clamp were persisted, the panel's next poll would write 150 down to 100 permanently. The heart rows arrive moments later and restore the ceiling, but the energy is gone and nothing can bring it back. Persisting only the decay write keeps the stored value intact until the ledger catches up, and the read is clamped either way, so the player never sees an over-long bar:

```js
export async function petState(db, { now = Date.now() } = {}) {
  const row = await ensureRow(db);
  const max = await maxEnergy(db);

  let energy = row.energy;
  let last_fed_at = row.last_fed_at;
  let decayed = false;

  if (last_fed_at != null) {
    const elapsed = now - last_fed_at;
    if (elapsed >= DECAY_INTERVAL_MS) {
      const intervals = Math.floor(elapsed / DECAY_INTERVAL_MS);
      energy = energy - intervals * DECAY_PER_INTERVAL;
      last_fed_at = now;
      decayed = true;
    }
  }
  // Clamped for the CALLER, including a bird sitting above a ceiling that just
  // moved down. Deliberately NOT persisted on its own: sync applies ramble_pet
  // before ramble_wallet, so a synced-in 150 would be written down to 100 in
  // the window before this instance's heart rows arrive, and that loss is
  // permanent. Only decay writes.
  const energyOut = clampEnergy(energy, max);
  const mood = moodFor(energyOut);

  if (decayed) {
    await db.execute({
      sql: "UPDATE ramble_pet SET energy = ?, mood = ?, last_fed_at = ? WHERE owner = 'self'",
      args: [energyOut, mood, last_fed_at],
    });
  }
  energy = energyOut;

  return {
    mood,
    energy,
    energy_max: max,
    places_week: row.places_week,
    unlocks_week: row.unlocks_week,
    crows_week: row.crows_week,
    last_fed_at,
    active_egg_id: row.active_egg_id ?? null,
    chores: readChores(row, now),
  };
}
```

5. `petFromRow` takes the ceiling as a second argument:

```js
export function petFromRow(row, energyMax) {
  if (!row) return null;
  return {
    owner: "self",
    mood: row.mood,
    energy: row.energy,
    energy_max: Number.isFinite(energyMax) ? energyMax : ENERGY_MAX_BASE_DEFAULT,
    places_week: row.places_week,
    unlocks_week: row.unlocks_week,
    crows_week: row.crows_week,
    week_start: row.week_start,
    last_fed_at: row.last_fed_at,
  };
}
```

6. `doChore`'s no-op branch passes it:

```js
  if (chores[kind] === true) {
    return { done: false, chores, pet: petFromRow(row, await maxEnergy(db)) };
  }
```

- [ ] **Step 4: Fix the second `petFromRow` caller in `feed.js`**

`readPet` is the other caller and must report the same ceiling, or a not-credited response would claim a different bar than a credited one:

```js
import { creditWarmth } from "./eggs.js";
import { feed as petFeed, petFromRow } from "./pet.js";
import { maxEnergy } from "./hearts.js";

// ...

async function readPet(db) {
  const { rows } = await db.execute({ sql: "SELECT * FROM ramble_pet WHERE owner = 'self'", args: [] });
  return petFromRow(rows[0] ?? null, await maxEnergy(db));
}
```

- [ ] **Step 5: Run the pet tests, then everything that reads a pet**

```bash
node scripts/run-suite.mjs tests/ramble-pet.test.js
node scripts/run-suite.mjs tests/ramble-feed.test.js tests/ramble-eggs.test.js tests/ramble-flock.test.js tests/ramble-hearts-ledger.test.js
```

Expected: all PASS. If a `ramble-feed` test compares a whole pet object with `deepEqual`, it now needs `energy_max` — add the field to the expectation rather than dropping it from the shape.

- [ ] **Step 6: Commit**

```bash
git commit bundles/ramble/server/pet.js bundles/ramble/server/feed.js tests/ramble-pet.test.js -m "ramble: the energy bar ends where the heart containers say it does"
git show --stat HEAD
```

---

## Task 4: the routes — granting on a walk, drawing on the map, reporting on the pet

**Files:**
- Modify: `bundles/ramble/panel/routes.js`
- Modify: `tests/ramble-panel.test.js` (append cases)

**Interfaces:**
- Consumes: `recordHeartPickup`, `availableHearts`, `heartsBalance`, `maxEnergy` from `hearts.js`.
- Produces, for Tasks 6-7:
  - `POST /api/ramble/area` with a fix gains `heart_picked: 1` and `heart_source: "first" | "wild"` (only when one was taken) plus `hearts`, `energy_max` and `energy_max_cap` (all three only when the post carried `here`).
  - `GET /api/ramble/zones?pips=1` gains `hearts: [{ cell, key, source, lat, lon }]`.
  - `GET /api/ramble/pet` gains `hearts` and `energy_max_cap`; `energy_max` already rides in from `petState`.

**Three things to get exactly right:**

1. **A heart is attempted on EVERY fix, not only on a first unlock.** This is what K2 and K3 buy: a first unlock grants on the spot (the cell was fogged, so it is a surprise), and a cell unlocked months ago whose heart was never taken pays when the player walks back. Seed's `if (!out.unlocked)` guard is a seed rule — do not copy it.
2. **Pass `out.cell`, NOT `cell`.** This is the finding the plan review caught, and it is the difference between a working phase and a broken one. `recordHeartPickup`'s own fail-closed check (`is this cell in ramble_cells?`) protects *new* ground only — a cell unlocked months ago passes it however vague today's fix is, and this phase deliberately leaves hearts sitting in exactly those cells. `recordUnlock` returns `cell: null` when the fix is worse than `unlock.max.accuracy.m` (`cells.js`), so threading `out.cell` through is what actually refuses the payout. Pass the raw `cell` and a single 2 km wifi fix harvests a retroactive heart from a cell the player is nowhere near.
3. **An area post with no `here` must keep its response byte for byte.** An existing test deep-equals it. Every new field rides inside the `here` branch.

- [ ] **Step 1: Write the failing tests**

Append to `tests/ramble-panel.test.js`. The file's idiom, which these tests use verbatim: `req(path, { method, body })` returns a `Response` (it adds `x-test-auth` and JSON headers itself), and `createDbClient()` opens the same scratch database the router is using — the `warmth.hatch_at` test at line 531 is the model for writing a settings row and cleaning it up. There is `walkTo(lat, lon)` too, but do not use it here: it zeroes `warmth.visit_place` and unlocks permanently for the rest of the file.

```js
/* --- Phase 2: heart containers (spec §2.3, §3). --- */

/**
 * ⚠ THIS FILE SHARES ONE SCRATCH DATABASE ACROSS EVERY TEST, so heart counts
 * accumulate as tests run and an unlock is permanent for every test after it.
 * Assert DELTAS, never absolute totals — an absolute assertion here passes
 * alone and fails in the suite, which is exactly the flake shape this repo has
 * hunted before.
 *
 * rate 1 so every cell in these tests holds a heart: no test may depend on a
 * cell that happens to hash lucky (the phase 1 lesson).
 */
async function withHeartSettings(pairs, fn) {
  const db = createDbClient();
  try {
    for (const [k, v] of pairs) {
      // eslint-disable-next-line no-await-in-loop
      await db.execute({
        sql: `INSERT INTO ramble_settings (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        args: [k, v],
      });
    }
    return await fn();
  } finally {
    for (const [k] of pairs) {
      // eslint-disable-next-line no-await-in-loop
      await db.execute({ sql: "DELETE FROM ramble_settings WHERE key = ?", args: [k] });
    }
    db.close();
  }
}

// `warmth.visit_place` is zeroed for the same reason walkTo() zeroes it: this
// file churns hatches and later asserts an incubating egg exists, and three or
// four +20 credits against a hatch_at of 100 is a hatch these tests did not ask
// for.
const HEARTS_ON = [
  ["heart.rate", "1"], ["heart.wild.rate", "999999"],
  ["unlock.max.accuracy.m", "100"], ["warmth.visit_place", "0"],
];
const jsonOf = async (path, opts) => (await req(path, opts)).json();

test("POST /api/ramble/area grants a heart on a first unlock, and reports the new ceiling", async () => {
  await withHeartSettings(HEARTS_ON, async () => {
    const here = { lat: 30.2672, lon: -97.7431, accuracy_m: 20 };
    const before = await jsonOf("/api/ramble/pet");

    const first = await jsonOf("/api/ramble/area", { method: "POST", body: { cells: ["9v6m2xt"], here } });
    assert.equal(first.heart_picked, 1, "the fogged cell had a heart in it");
    assert.equal(first.hearts, before.hearts + 1);
    assert.equal(first.energy_max, before.energy_max + 10, "the bar grew by energy.max.per.heart");

    const again = await jsonOf("/api/ramble/area", { method: "POST", body: { cells: ["9v6m2xt"], here } });
    // Asserted, not assumed, exactly like the ledger tests: this only holds
    // because the wild source is silenced at rate 999999.
    assert.equal(again.heart_picked, undefined, "a permanent heart is taken once, ever");
    assert.equal(again.hearts, first.hearts, "the count still rides on every fix");
    assert.equal(again.energy_max, first.energy_max);
  });
});

test("a fix too vague to unlock is also too vague to pay a heart", async () => {
  await withHeartSettings(HEARTS_ON, async () => {
    const before = (await jsonOf("/api/ramble/pet")).hearts;
    const res = await jsonOf("/api/ramble/area", {
      method: "POST",
      // `cells` is only the active-area list; the cell that matters is derived
      // from `here` (Chicago -> dp3wjzt), which is fresh ground for this file.
      body: { cells: ["dp3wjzt"], here: { lat: 41.8781, lon: -87.6298, accuracy_m: 2000 } },
    });
    assert.equal(res.unlocked, undefined, "no unlock");
    assert.equal(res.heart_picked, undefined, "and therefore no heart");
    assert.equal((await jsonOf("/api/ramble/pet")).hearts, before, "nothing was granted");
  });
});

test("a vague fix cannot harvest a heart from ground unlocked LONG AGO", async () => {
  // ⚠ The one the plan review caught. The in-ramble_cells check passes for an
  // already-unlocked cell no matter how bad today's fix is, so this is the case
  // the "fail closed" claim actually has to survive. Unlock the cell sharply
  // while it holds no heart, then make it hold one, then arrive vaguely.
  const here = { lat: 35.6762, lon: 139.6503 };   // Tokyo: fresh ground for this file
  await withHeartSettings(
    [["heart.rate", "999999"], ["heart.wild.rate", "999999"], ["unlock.max.accuracy.m", "100"], ["warmth.visit_place", "0"]],
    async () => {
      // ⚠ NO `cells: []` — routes.js rejects an empty array with a 400, and a
      // 400 would make the assertions below pass vacuously against the buggy
      // implementation. Omitting `cells` entirely is the supported form: the
      // route falls back to lat/lon, exactly as walkTo() does.
      const sharp = await jsonOf("/api/ramble/area", {
        method: "POST", body: { ...here, here: { ...here, accuracy_m: 10 } },
      });
      assert.ok(sharp.unlocked, "precondition: the cell is unlocked, and held no heart");
    },
  );
  await withHeartSettings(HEARTS_ON, async () => {
    const before = (await jsonOf("/api/ramble/pet")).hearts;
    const vague = await jsonOf("/api/ramble/area", {
      method: "POST", body: { ...here, here: { ...here, accuracy_m: 2000 } },
    });
    assert.equal(vague.heart_picked, undefined,
      "a 2 km fix must not collect the heart now waiting in already-unlocked ground");
    assert.equal((await jsonOf("/api/ramble/pet")).hearts, before, "nothing was granted");
  });
});

test("POST /api/ramble/area WITHOUT `here` keeps its exact historical shape", async () => {
  const res = await jsonOf("/api/ramble/area", { method: "POST", body: { cells: ["9v6m2xt"] } });
  assert.deepEqual(res, { cells: ["9v6m2xt"] },
    "no fix, no currency: panning the map must not report a wallet");
});

test("GET /api/ramble/zones?pips=1 draws hearts only in unlocked ground", async () => {
  // ⚠ A GENUINELY FRESH cell, and a length assertion BEFORE the loop. Two
  // earlier drafts got this wrong: the first reused Austin, whose heart the
  // previous test had already collected, so `hearts` was always [] and the loop
  // never ran; the second reused London, which is HERE_LAT/HERE_LON's own cell
  // (`gcpvj0d`) and is walked twice by the visit_place test — that draft passed
  // only because heartFor("gcpvj0d", {rate: 3}) happens to miss, which is the
  // lucky-hash dependency this plan bans.
  //
  // wecnrmd = 22.2233/114.2283, Hong Kong. No test in this file uses a latitude
  // anywhere near it (they use 10.5, 30.46, 48.8584 and 51.5074).
  await withHeartSettings(HEARTS_ON, async () => {
    const db = createDbClient();
    try {
      await db.execute({
        sql: "INSERT INTO ramble_cells (cell, first_unlocked_at) VALUES ('wecnrmd', 1) ON CONFLICT(cell) DO NOTHING",
        args: [],
      });
    } finally { db.close(); }

    const bbox = "22.21,114.21,22.24,114.25";
    const withPips = await jsonOf("/api/ramble/zones?bbox=" + bbox + "&pips=1");
    assert.ok(Array.isArray(withPips.hearts), "the field is always an array");
    assert.ok(withPips.hearts.some((h) => h.cell === "wecnrmd"),
      "there IS a heart to draw, or this test proves nothing");
    for (const h of withPips.hearts) {
      assert.ok(withPips.unlocked.some((b) =>
        h.lat >= b.south && h.lat <= b.north && h.lon >= b.west && h.lon <= b.east),
        "a heart pip only ever sits in unlocked ground");
    }

    const noPips = await jsonOf("/api/ramble/zones?bbox=" + bbox);
    assert.deepEqual(noPips.hearts, [], "pips are a close-zoom detail; the client asks for them");
  });
});

test("a heart in ground unlocked before this feature existed waits on the map, and pays when walked to", async () => {
  // The K2 case, end to end: a row put straight into ramble_cells (exactly what
  // phase 1's backfill left behind) still has its heart to walk back to.
  await withHeartSettings(HEARTS_ON, async () => {
    const db = createDbClient();
    try {
      await db.execute({
        sql: "INSERT INTO ramble_cells (cell, first_unlocked_at) VALUES ('u33dc0e', 1) ON CONFLICT(cell) DO NOTHING",
        args: [],
      });
    } finally { db.close(); }
    // u33dc0e decodes to 52.5181, 13.4081 (Berlin); this bbox contains it.
    const zones = await jsonOf("/api/ramble/zones?bbox=52.50,13.35,52.54,13.46&pips=1");
    assert.equal(zones.hearts.filter((h) => h.cell === "u33dc0e").length, 1,
      "a cell unlocked before this feature shipped still has its heart waiting");

    // And walking there really does collect the pip the map just drew.
    const before = (await jsonOf("/api/ramble/pet")).hearts;
    const walked = await jsonOf("/api/ramble/area", {
      method: "POST", body: { lat: 52.5181, lon: 13.4081, here: { lat: 52.5181, lon: 13.4081, accuracy_m: 15 } },
    });
    assert.equal(walked.heart_picked, 1, "the pip the map drew is the heart the walk grants");
    assert.equal(walked.hearts, before + 1);
    const after = await jsonOf("/api/ramble/zones?bbox=52.50,13.35,52.54,13.46&pips=1");
    assert.equal(after.hearts.filter((h) => h.cell === "u33dc0e").length, 0, "and the pip is gone");
  });
});

test("GET /api/ramble/pet carries the heart count and the ceiling", async () => {
  const body = await jsonOf("/api/ramble/pet");
  assert.equal(typeof body.hearts, "number");
  assert.equal(typeof body.energy_max, "number");
  assert.equal(body.energy_max, 100 + body.hearts * 10,
    "the ceiling is derived from the count the same response reports");
});
```

**Note for the implementer:** `withHeartSettings` and `jsonOf` are the only new helpers; everything else (`req`, `createDbClient`) already exists in the file. **Do not add a settings HTTP route** — none exists, and this phase must not add one. The cells above were checked against `decodeGeohash` while this plan was written: `9v6m2xt` = 30.4960/-98.0564, `dp3wjzt` = Chicago, `u33dc0e` = 52.5181/13.4081. Note that a POST to `/api/ramble/area` derives the cell it unlocks from `here`, not from the `cells` array — Austin's 30.2672/-97.7431 is `9v6kpvc`.

- [ ] **Step 2: Run and watch it fail**

```bash
node scripts/run-suite.mjs tests/ramble-panel.test.js
```

Expected: FAIL — `heart_picked` and `hearts` are `undefined`, `zones.hearts` is `undefined`.

- [ ] **Step 3: Load `hearts.js` into `mods`**

In `bundles/ramble/panel/routes.js`, `ensureLoaded` builds every module in one `Promise.all`. Add `heartsMod` in **all four** places — the destructuring, the import list, the null-check, and the `mods` object — following `walletMod` exactly:

```js
      const [dbMod, initMod, marksMod, gridMod, personaMod, anchorsMod, appRootMod, petMod, eggsMod, feedMod, flockMod, nestsMod, deliveryMod, tradesMod, aroundMod, zonesMod, cellsMod, walletMod, heartsMod] = await Promise.all([
        // ... existing entries, unchanged ...
        bundleImport("server/wallet.js"),
        bundleImport("server/hearts.js"),
      ]).catch((err) => {
```

```js
      if (!dbMod || !initMod || !marksMod || !gridMod || !personaMod || !anchorsMod || !appRootMod || !petMod ||
          !eggsMod || !feedMod || !flockMod || !nestsMod || !deliveryMod || !tradesMod || !aroundMod || !zonesMod ||
          !cellsMod || !walletMod || !heartsMod) {
```

```js
      mods = { dbMod, initMod, marksMod, gridMod, personaMod, anchorsMod, petMod, eggsMod, feedMod, flockMod, nestsMod, deliveryMod, tradesMod, aroundMod, zonesMod, cellsMod, walletMod, heartsMod, appImport: appRootMod.appImport };
```

- [ ] **Step 4: Grant on a fix in `POST /api/ramble/area`**

Inside the existing `if (here) { ... }` block, after the seed branch:

```js
    let unlockedNow = null;
    let seedPicked = 0;
    let heartPicked = 0;
    let heartSource = null;
    if (here) {
      const cell = mods.anchorsMod.encodeGeohash(here.lat, here.lon, 7);
      await feedActivity({ type: "visit_place", cell });
      const out = await mods.cellsMod.recordUnlock(db, cell, { now: Date.now(), emit, accuracyM: here.accuracy_m });
      if (out.unlocked) unlockedNow = mods.zonesMod.cellBox(out.cell);
      if (!out.unlocked && out.cell) {
        seedPicked = (await mods.walletMod.recordSeedPickup(db, cell, { now: Date.now(), emit })).amount;
      }
      // 2026-09-08 §2.3: hearts are tried on EVERY fix, not only a first
      // unlock. A first unlock grants on the spot (the cell was fogged, so it
      // is a surprise); a cell unlocked long ago whose heart was never taken
      // pays when the player walks back to it, which is what makes the pips on
      // their existing map real destinations.
      //
      // ⚠ `out.cell`, NOT `cell`. recordUnlock nulls its cell when the fix is
      // vaguer than unlock.max.accuracy.m, and that is the ONLY thing standing
      // between a 2 km wifi fix and the heart sitting in a cell unlocked months
      // ago — recordHeartPickup's own in-ramble_cells check passes happily for
      // ground that is already unlocked, which is most of the ground that still
      // holds a heart.
      if (out.cell) {
        const got = await mods.heartsMod.recordHeartPickup(db, out.cell, { now: Date.now(), emit });
        heartPicked = got.amount;
        // The panel says a different line for a once-ever heart and one that
        // regrew, so the source has to survive the trip.
        heartSource = got.source || null;
      }
    }
```

and the response, keeping every new field inside the `here` branch:

```js
    res.json({
      cells,
      ...(unlockedNow ? { unlocked: unlockedNow } : {}),
      ...(seedPicked ? { seed_picked: seedPicked } : {}),
      ...(heartPicked ? { heart_picked: heartPicked, heart_source: heartSource } : {}),
      ...(here ? { seed: await mods.walletMod.seedBalance(db) } : {}),
      ...(here ? {
        hearts: await mods.heartsMod.heartsBalance(db),
        energy_max: await mods.heartsMod.maxEnergy(db),
        // The ceiling's ceiling, so the panel can tell "the bar grew" from
        // "the bar is as long as it goes" and say the right thing (Task 6).
        energy_max_cap: (await mods.heartsMod.readHeartSettings(db)).cap,
      } : {}),
    });
```

- [ ] **Step 5: Draw the pips in `GET /api/ramble/zones`**

In the `pips === "1"` branch, beside the existing seed read:

```js
    let seed = [];
    let hearts = [];
    if (req.query?.pips === "1") {
      seed = await mods.walletMod.harvestableCells(db, out.unlocked.map((b) => b.cell), { now: Date.now() });
      // The SAME rule the payout uses (hearts.js: availableHearts and
      // recordHeartPickup both go through heartCandidates). A heart drawn here
      // that a walk would not grant is the phase 1 seed defect all over again.
      hearts = await mods.heartsMod.availableHearts(db, out.unlocked.map((b) => b.cell), { now: Date.now() });
    }
```

and add `hearts` to the response object beside `seed`.

- [ ] **Step 6: Report on `GET /api/ramble/pet`**

```js
    res.json({
      ...pet,
      bird,
      egg: { percent: egg.egg.percent },
      seed: await mods.walletMod.seedBalance(db),
      hearts: await mods.heartsMod.heartsBalance(db),
      energy_max_cap: (await mods.heartsMod.readHeartSettings(db)).cap,
    });
```

`energy_max` needs nothing here — `petState` already returns it and the spread carries it.

- [ ] **Step 6b: Keep the MCP tool agreeing with the route**

`bundles/ramble/server/server.js` (around line 304) has a second `petState` caller: the `ramble_pet_state` tool. It picks up `energy_max` for free from its spread, but not `hearts`, so the tool and the HTTP route would describe the same pet differently. Import `heartsBalance` alongside the other server-side helpers and add it:

```js
        const [state, bird, egg] = await Promise.all([petState(db), activeBird(db), eggState(db, { now: Date.now() })]);
        return text(JSON.stringify({ ...state, bird, hearts: await heartsBalance(db), egg: { percent: egg.egg.percent } }));
```

and assert it in `tests/ramble-tools.test.js` beside the existing `ramble_pet_state` coverage:

```js
  assert.equal(typeof state.hearts, "number", "the tool reports the same wallet the panel does");
  assert.equal(typeof state.energy_max, "number");
```

- [ ] **Step 7: Run the route tests, then the map slice**

```bash
node scripts/run-suite.mjs tests/ramble-panel.test.js
node scripts/run-suite.mjs tests/ramble-map-gating.test.js tests/ramble-around.test.js tests/ramble-tools.test.js
```

Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git commit bundles/ramble/panel/routes.js bundles/ramble/server/server.js tests/ramble-panel.test.js tests/ramble-tools.test.js -m "ramble: a walk takes the heart, and the map says where the next one is"
git show --stat HEAD
```

---

## Task 5: the heart, drawn

**Files:**
- Modify: `bundles/ramble/server/bird-svg.cjs`
- Modify: `tests/ramble-bird-svg.test.js` (append cases)

**Interfaces:**
- Produces: `drawHeart() -> string` (SVG children for a `0 0 24 24` viewBox) and `mountHeart(el)`, both on the engine's exported object, mirroring `drawSeed`/`mountSeed` exactly.

**Why the engine and not the panel:** `bundles/ramble/panel/static/ramble.js` is capped at exactly two markup sinks. `mountSeed` is how the seed pip gets real art without spending one, because the panel hands Leaflet an `Element` (Leaflet appends it, which is not a sink). The heart takes the same route. The engine file is a `.cjs` UMD module loaded through `createRequire`, and it is also what the server-side bird renderer uses, so it must stay dependency-free.

**Art direction (the writing and the drawing are deliverables, not decoration):** the seed is "an almond husk with a seam and a highlight, warm against a blue-grey map". The heart is its rare counterpart — a small round-shouldered heart in the same warm family but clearly richer than the seed's ochre, with a highlight in the same place so the two read as one set. No gradients, no filters: it renders at 18px on a map and inside a text line on the pet page.

- [ ] **Step 1: Write the failing test**

Append to `tests/ramble-bird-svg.test.js`:

```js
test("drawHeart returns inert SVG children in the seed's own idiom", () => {
  const svg = Bird.drawHeart();
  assert.equal(typeof svg, "string");
  assert.ok(svg.length > 0);
  assert.ok(/<path|<ellipse|<circle/.test(svg), "it is actually drawn, not empty");
  assert.ok(!/<script|onload=|href=/i.test(svg), "engine output is inert");
  // The two invariants the existing drawSeed test asserts, kept: the engine is
  // also rendered server-side, where a CSS custom property resolves to nothing.
  assert.ok(!svg.includes("var(--"), "no custom properties: this also renders outside the panel");
  assert.equal(svg.indexOf("`"), -1, "no backticks");
  assert.equal(Bird.drawHeart(), svg, "deterministic: no randomness in the art");
});

test("mountHeart sets the same 24-unit viewBox the seed pip uses", () => {
  const calls = [];
  const el = {
    setAttribute: (k, v) => calls.push([k, v]),
    set innerHTML(v) { calls.push(["innerHTML", v]); },
  };
  Bird.mountHeart(el);
  assert.deepEqual(calls[0], ["viewBox", "0 0 24 24"], "same box as mountSeed, so the pips match in size");
  assert.equal(calls[1][0], "innerHTML");
  assert.equal(calls[1][1], Bird.drawHeart());
});
```

**Note for the implementer:** `tests/ramble-bird-svg.test.js` binds the engine as `Bird` — the names above are already correct. Mirror the file's existing `drawSeed`/`mountSeed` cases rather than introducing a second style.

- [ ] **Step 2: Run and watch it fail**

```bash
export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH
node scripts/run-suite.mjs tests/ramble-bird-svg.test.js
```

Expected: FAIL — `engine.drawHeart is not a function`.

- [ ] **Step 3: Draw it**

In `bundles/ramble/server/bird-svg.cjs`, directly after `mountSeed`:

```js
  /* The rare counterpart to the seed. Same warm family and the same highlight
   * placement so the two read as one set, but deeper and richer, because this
   * is the thing you go out of your way for. Flat fills only: it renders at
   * 18px on a map and inline in a sentence on the pet page. */
  function drawHeart() {
    return '<path d="M12 20.5 C5.4 15.9 2.8 12.6 2.8 9.2 C2.8 6.4 4.9 4.3 7.5 4.3'
      + ' C9.4 4.3 11 5.3 12 6.9 C13 5.3 14.6 4.3 16.5 4.3 C19.1 4.3 21.2 6.4 21.2 9.2'
      + ' C21.2 12.6 18.6 15.9 12 20.5 Z" fill="#d8556a" stroke="#8f2438" stroke-width="1.6"'
      + ' stroke-linejoin="round"/>'
      + '<ellipse cx="8.4" cy="8.6" rx="1.5" ry="2.2" fill="#fff2f4" opacity="0.55"'
      + ' transform="rotate(-25 8.4 8.6)"/>';
  }
  function mountHeart(el) { el.setAttribute("viewBox", "0 0 24 24"); el.innerHTML = drawHeart(); }
```

and add both to the returned object, beside `drawSeed` and `mountSeed`:

```js
  return { ROSTER: ROSTER, SPECIES: SPECIES, PARTS: PARTS, rollGenome: rollGenome, drawBird: drawBird, drawEgg: drawEgg, drawWalkingEgg: drawWalkingEgg, drawSeed: drawSeed, drawHeart: drawHeart, mountBird: mountBird, mountWalkingEgg: mountWalkingEgg, mountSeed: mountSeed, mountHeart: mountHeart, isValidBird: isValidBird };
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
node scripts/run-suite.mjs tests/ramble-bird-svg.test.js
node scripts/run-suite.mjs tests/ramble-header-bird.test.js tests/ramble-panel.test.js
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git commit bundles/ramble/server/bird-svg.cjs tests/ramble-bird-svg.test.js -m "ramble: a heart container, drawn in the seed's own hand"
git show --stat HEAD
```

---

## Task 6: the map — pips to walk to, a counter, and the moment

**Files:**
- Modify: `bundles/ramble/panel/static/ramble.js`
- Modify: `bundles/ramble/panel/static/ramble.css`
- Modify: `bundles/ramble/panel/ramble.js` (the map bar only)
- Modify: `tests/ramble-panel.test.js` (append served-source assertions)

**Interfaces:**
- Consumes: `hearts` from `GET /api/ramble/zones?pips=1`; `heart_picked` and `hearts` from `POST /api/ramble/area`; `Bird.mountHeart` from Task 5.
- Produces, for Task 7: `paintHearts(n)` updating `#rb-heart-count`.

**⚠ `bundles/ramble/panel/static/ramble.js` rules, test-enforced:** ZERO backticks anywhere in the file **including inside comments** — a single one truncates the served script and the whole panel goes dark. Exactly TWO engine markup sinks (they are already spent on `drawEggSeed` and `nestEggHtml`); this task adds none, because Leaflet appending an `Element` is not a sink. `textContent` only. No emoji.

- [ ] **Step 1: Write the failing test**

Append to `tests/ramble-panel.test.js`, in the block that already asserts on the served static source:

```js
test("the map draws heart pips, counts them, and says something when one is taken", async () => {
  const body = await (await req("/ramble/static/ramble.js")).text();
  assert.ok(body.includes("function paintHeartPips("), "the map shows where a heart is waiting");
  assert.ok(body.includes("function heartIcon()"), "pips carry the engine's heart art");
  assert.ok(body.includes("Bird.mountHeart(svg)"), "drawn by the shared engine, like every other creature part");
  assert.ok(body.includes("rb-heart-dot"), "and a plain dot survives the engine failing to load");
  assert.ok(body.includes("paintHeartPips(out.hearts || [])"), "fed from the server's own list");
  assert.ok(body.includes("out.heart_picked"), "the pickup is consumed from the area response");
  assert.ok(body.includes("function paintHearts("), "the counter is painted from the area response");
  assert.equal(body.split("`").length - 1, 0, "the panel client must contain ZERO backticks");
});

test("heart pips, the fallback dot and the pop all have styles", async () => {
  const css = await (await req("/ramble/static/ramble.css")).text();
  assert.ok(css.includes("#ramble .rb-heart-pip {"));
  assert.ok(css.includes("#ramble .rb-heart-dot {"));
  assert.ok(css.includes("#ramble .rb-hearts {"), "the map-bar counter has a rule");
  assert.ok(css.includes("#ramble .rb-heart-pop {"));
  assert.ok(css.includes("@keyframes rb-heart-rise"));
  // The heart pop joins the EXISTING comma-separated reduced-motion list, so
  // match it as a member of that list rather than as its own rule.
  assert.match(css, /prefers-reduced-motion[\s\S]*#ramble \.rb-heart-pop,[\s\S]*animation: none/,
    "the pop respects reduced motion, like the seed pop already does");
  assert.ok(css.includes("#ramble .rb-heart-pip > svg {"),
    "the pip's svg is SIZED — without this it renders at the CSS default 300x150");
});
```

And **inside the existing** `"panel handler renders the world-first shell, its three views and every asset"` test, beside the line that already asserts `id="rb-seed-count"`:

```js
  assert.ok(sent.includes('id="rb-heart-count"'), "the map bar carries the heart counter");
  assert.ok(sent.indexOf('id="rb-heart-count"') > sent.indexOf('id="rb-seed-count"'),
    "common currency first, rare currency second");
```

**Note for the implementer:** `req(path)` is the file's own helper and returns a `Response`; the existing `ramble.css` and `ramble-ar.js` tests show the `.text()` idiom exactly. The shell is only rendered inside that one existing test — extend it rather than re-rendering the panel a second time.

- [ ] **Step 2: Run and watch it fail**

```bash
node scripts/run-suite.mjs tests/ramble-panel.test.js
```

Expected: FAIL on `paintHeartPips`.

- [ ] **Step 3: The map bar chip**

In `bundles/ramble/panel/ramble.js` (this file IS a template literal, so `${}` is expected here), beside the seed counter:

```js
              <span class="rb-seed" title="Bird seed"><strong id="rb-seed-count">0</strong><span>seed</span></span>
              <span class="rb-hearts" title="Heart containers"><strong id="rb-heart-count">0</strong><span>hearts</span></span>
```

- [ ] **Step 4: The pip layer**

In `bundles/ramble/panel/static/ramble.js`, directly after `paintSeedPips`:

```js
  /* A heart container waiting in ground you have already unlocked: the rare
   * counterpart to a seed pip, and the reason an existing player has somewhere
   * to walk on the day this ships. Not interactive -- you collect it by walking
   * there, exactly like seed.
   *
   * Each pip needs its OWN element: appending an Element MOVES it, so one
   * shared node would leave a single heart hopping between cells. */
  function heartIcon() {
    if (!Bird || typeof Bird.mountHeart !== "function") return null;
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    try { Bird.mountHeart(svg); } catch (e) { return null; }
    var opts = { className: "rb-heart-pip", iconSize: [22, 22], iconAnchor: [11, 11] };
    opts.html = svg;   /* an Element: Leaflet appends, so this is no markup sink */
    return L.divIcon(opts);
  }

  function paintHeartPips(spots) {
    for (var i = 0; i < spots.length; i++) {
      var c = spots[i];
      if (!c || !isFinite(c.lat) || !isFinite(c.lon)) continue;
      var ll = [c.lat, c.lon];
      var icon = heartIcon();
      if (icon) {
        L.marker(ll, { pane: "rb-fog", icon: icon, interactive: false, keyboard: false }).addTo(zoneLayer);
      } else {
        L.circleMarker(ll, {
          pane: "rb-fog", className: "rb-heart-dot", radius: 5, weight: 0,
          fillOpacity: 0.95, interactive: false
        }).addTo(zoneLayer);
      }
    }
  }
```

and in `drawZones`, beside the seed call:

```js
    if (map.getZoom() >= MIN_CELL_DETAIL_ZOOM) {
      paintCells(out.frontier || [], "rb-frontier-cell");
      paintSeedPips(out.seed || []);
      paintHeartPips(out.hearts || []);
    }
```

- [ ] **Step 5: The counter and the moment**

Directly after `paintSeed`:

```js
  /* The heart moment. A heart is rare enough to be worth saying out loud, so
   * this does both: the number pops, and the bird speaks. sayMoment is the only
   * thing that opens the bubble on its own, and an arrival is exactly what it
   * is for. */
  function celebrateHeart(alsoUnlocked, source, atCap) {
    var chip = $("rb-heart-count");
    if (chip && chip.parentNode) {
      var pop = document.createElement("span");
      pop.className = "rb-heart-pop";
      pop.textContent = "+1";
      chip.parentNode.appendChild(pop);
      setTimeout(function () { if (pop.parentNode) pop.parentNode.removeChild(pop); }, 1400);
    }
    /* ONE line, not two. celebrateUnlock has already said "New ground." on a
     * first unlock, and sayMoment holds for 4200ms -- a second call overwrites
     * the first, so the unlock moment would be erased every time a new cell
     * also paid a heart, which is one arrival in three. When both happen, say
     * the thing that covers both. */
    if (atCap) sayMoment("Another heart container. Your bird is as strong as it gets.");
    else if (alsoUnlocked) sayMoment("New ground, and a heart container in it.");
    else if (source === "wild") sayMoment("A heart container, grown here since you last came by.");
    else sayMoment("A heart container. Your bird can hold more now.");
  }

  function paintHearts(n) {
    if (typeof n !== "number") return;
    var el = $("rb-heart-count");
    if (el) el.textContent = String(n);
  }
```

and in the area-response handler. The existing lines are `static/ramble.js:419` (`paintSeed`), `:420` (`celebrateUnlock`) and `:423` (`seed_picked`) — **insert after line 423**, and rewrite that line as shown:

```js
        if (out && typeof out.hearts === "number") paintHearts(out.hearts);
        if (out && out.heart_picked) {
          celebrateHeart(!!out.unlocked, out.heart_source, out.energy_max === out.energy_max_cap);
        }
```

and **restructure the seed line rather than adding a second guarded refresh**. The existing line at `static/ramble.js:423` is:

```js
        if (out && out.seed_picked) { celebrateSeed(out.seed_picked); if (!out.unlocked) refreshZones(); }
```

Walking back into an already-unlocked cell that holds both a regrown seed and a retroactive heart — the K2 case, on upgrade day — would fire `/zones` twice if the heart branch carried its own copy. One refresh, after both:

```js
        if (out && out.seed_picked) celebrateSeed(out.seed_picked);
        if (out && typeof out.hearts === "number") paintHearts(out.hearts);
        if (out && out.heart_picked) {
          celebrateHeart(!!out.unlocked, out.heart_source, out.energy_max === out.energy_max_cap);
        }
        /* One /zones fetch however many pips were just consumed. celebrateUnlock
         * already refreshed on a first unlock, which is what the guard is for. */
        if (out && (out.seed_picked || out.heart_picked) && !out.unlocked) refreshZones();
```

**Why exactly that form.** Taking a heart removes a pip and the pip list comes from `/zones`, so the map does need a refresh — but marks are untouched by a heart, so do **not** call `refreshMarks` (phase 1 shipped a redundant double `refreshMarks` on the unlock path that three adversarial rounds missed; do not add a third). When the pickup rode in on a *first unlock*, `celebrateUnlock` has already called `refreshZones`, so the `!out.unlocked` guard keeps it from firing twice — and it has already spoken, which is why `celebrateHeart` takes the flag and says one combined line rather than silently overwriting "New ground."

**This needs one more field from the server.** `energy_max_cap` is the ceiling's ceiling, so the panel can tell "the bar grew" from "the bar is as long as it goes". Add it beside `energy_max` in the `here` branch of `POST /api/ramble/area` and in `GET /api/ramble/pet` (Task 4), reading `(await mods.heartsMod.readHeartSettings(db)).cap`.

- [ ] **Step 6: The styles**

In `bundles/ramble/panel/static/ramble.css`, beside the seed rules:

**⚠ The pip needs TWO rules, not one.** `mountHeart` sets a `viewBox` but no `width`/`height`, and `L.divIcon`'s `iconSize` sizes the wrapper, not the child — an unsized inline `<svg>` falls back to the CSS default **300x150 px**. The seed pip is two rules for exactly this reason (`ramble.css:883-884`). Copy that shape:

```css
#ramble .rb-heart-pip { display: grid; place-items: center; }
#ramble .rb-heart-pip > svg { width: 20px; height: 20px; filter: drop-shadow(1px 2px 0 var(--rb-shadow-col)); }
#ramble .rb-heart-dot { fill: #d8556a; }
```

`#d8556a` is a literal rather than a token deliberately: the fallback dot exists to stand in for the engine's heart when the engine did not load, so it has to be the engine's own colour. (`--rb-accent-2`, which the seed dot uses, is the seed's ochre.)

The map-bar counter is a **pill**, matching its neighbour — `.rb-seed` at `ramble.css:915` is `position: relative` (that is what anchors the `+N` pop), `display: inline-flex`, with a border and the display font. Read that rule and mirror it, changing only the accent:

```css
#ramble .rb-hearts {
  position: relative;   /* anchors the +1 pop */
  /* ... copy .rb-seed's display/padding/border/font shorthand verbatim ... */
}

#ramble .rb-heart-pop {
  position: absolute; left: 50%; bottom: 100%;
  transform: translateX(-50%);
  font-weight: 700; color: #d8556a; pointer-events: none;
  animation: rb-heart-rise 1.4s ease-out forwards;
}
@keyframes rb-heart-rise {
  from { opacity: 1; transform: translate(-50%, 0); }
  to   { opacity: 0; transform: translate(-50%, -1.6rem); }
}
```

**There is no `--rb-ink` in this stylesheet** — the text token is `--rb-text`. Use the tokens `.rb-seed` actually uses.

**Reduced motion goes in the EXISTING block**, not a new one. `ramble.css:585-596` is one comma-separated selector list ending `#ramble .rb-seed-pop { animation: none; }`; add `#ramble .rb-heart-pop,` to that list. Task 6 Step 1's regex is written to match that form — do not open a second `@media` block to satisfy it.

- [ ] **Step 7: Run the tests**

```bash
node scripts/run-suite.mjs tests/ramble-panel.test.js
node scripts/run-suite.mjs tests/ramble-ar.test.js tests/ramble-stream.test.js
```

Expected: all PASS. If the backtick assertion fails, a comment picked one up — that is the whole reason the assertion exists.

- [ ] **Step 8: Commit**

```bash
git commit bundles/ramble/panel/static/ramble.js bundles/ramble/panel/static/ramble.css bundles/ramble/panel/ramble.js tests/ramble-panel.test.js -m "ramble: hearts on the map, and the bird says so when you find one"
git show --stat HEAD
```

---

## Task 7: the pet page — a bar that grows, and the hearts that grew it

**Files:**
- Modify: `bundles/ramble/panel/ramble.js` (the pet card)
- Modify: `bundles/ramble/panel/static/ramble.js` (the pet painter)
- Modify: `bundles/ramble/panel/static/ramble.css`
- Modify: `tests/ramble-panel.test.js` (append served-source assertions)

**Interfaces:**
- Consumes: `energy_max` and `hearts` from `GET /api/ramble/pet`.

**Two bugs this task exists to not ship:**

1. The bar is currently `width = energy + "%"`, which silently assumes a maximum of 100. With hearts, an energy of 150 would paint a 150% bar and 70 out of 150 would look nearly full. **The bar must be drawn against the same `energy_max` the server clamps with.**
2. **The map-bar heart counter must be painted from HERE too.** `paintPet` already calls `paintSeed(pet.seed)` — that is what keeps the seed counter honest at boot and for a player who denies geolocation, since the area response only carries a wallet when it carried a fix. Add `paintHearts` beside it or a player with three hearts sees the pet page say "3 heart containers" while the map bar reads `0 hearts`. This is phase 1's actual defect #1 in miniature: an affordance added on one path and not its twin.

- [ ] **Step 1: Write the failing test**

Append to `tests/ramble-panel.test.js`:

```js
test("the energy bar is drawn against the server's ceiling, not a hardcoded 100", async () => {
  const body = await (await req("/ramble/static/ramble.js")).text();
  assert.ok(body.includes("pet.energy_max"), "the painter reads the ceiling the server clamped with");
  assert.ok(!body.includes('Math.min(100, energy)) + "%"'), "the old hardcoded-100 bar is gone");
  assert.ok(body.includes("(energy / max) * 100"), "the bar is a fraction of the real ceiling");
  assert.ok(body.includes("function paintHeartRow("), "the pet page shows the containers themselves");
  assert.ok(body.includes("paintHearts(hearts)"),
    "the map-bar counter is painted from the pet read too, not only from a position fix");
});
```

And, again **inside the existing shell test**, beside the pet-card assertions:

```js
  assert.ok(sent.includes('id="rb-energy-max"'), "the bar's ceiling is on the page");
  assert.ok(sent.includes('id="rb-heart-row"'), "and the containers that set it");
```

- [ ] **Step 2: Run and watch it fail**

```bash
node scripts/run-suite.mjs tests/ramble-panel.test.js
```

Expected: FAIL on `pet.energy_max`.

- [ ] **Step 3: The markup**

In `bundles/ramble/panel/ramble.js`, replace the energy card's meter block:

```js
          <section class="rb-card">
            <div class="rb-meter">
              <strong class="rb-meter-label">Energy</strong>
              <span class="rb-meter-bar"><i id="rb-energy-fill"></i></span>
              <strong id="rb-energy-num">&mdash;</strong><span class="rb-meter-of">/ <span id="rb-energy-max">100</span></span>
            </div>
            <p class="rb-hearts-line"><span id="rb-heart-row" class="rb-heart-row"></span><span class="rb-muted rb-fine" id="rb-heart-line"></span></p>
            <p class="rb-muted rb-fine" id="rb-mood-line">Checking on it&hellip;</p>
          </section>
```

- [ ] **Step 4: The painter**

In `bundles/ramble/panel/static/ramble.js`, replace the three energy lines in the pet painter:

```js
    var energy = typeof pet.energy === "number" ? pet.energy : 0;
    /* Against the server's OWN ceiling. Drawing a percentage of a hardcoded 100
     * would paint a 150-energy bird at 150% and a 70-of-150 bird as nearly
     * full: the bar has to read the same number the server clamps with. */
    var max = typeof pet.energy_max === "number" && pet.energy_max > 0 ? pet.energy_max : 100;
    var fill = $("rb-energy-fill");
    if (fill) fill.style.width = Math.max(0, Math.min(100, (energy / max) * 100)) + "%";
    setText($("rb-energy-num"), String(energy));
    setText($("rb-energy-max"), String(max));
    var hearts = typeof pet.hearts === "number" ? pet.hearts : 0;
    paintHeartRow(hearts, max, pet.energy_max_cap);
    /* The map bar too, not only this page: the area response carries a wallet
     * ONLY when it carried a position fix, so a player who denies geolocation
     * would otherwise read 0 hearts on the map forever. paintSeed is called
     * from here for exactly this reason. */
    paintHearts(hearts);
    setText($("rb-mood-line"), MOOD_LINE[pet.mood] || MOOD_LINE.happy);
```

and add the heart row, near `paintHearts`:

```js
  /* The containers themselves, above the bar they lengthened -- the number
   * alone never explained where the extra bar came from. Capped at a row that
   * still fits a phone; past that the sentence carries the count. */
  var HEART_ROW_MAX = 10;

  function paintHeartRow(n, max, cap) {
    var row = $("rb-heart-row");
    if (!row) return;
    while (row.firstChild) row.removeChild(row.firstChild);
    var shown = Math.max(0, Math.min(HEART_ROW_MAX, n));
    for (var i = 0; i < shown; i++) {
      var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("class", "rb-heart-one");
      if (Bird && typeof Bird.mountHeart === "function") {
        try { Bird.mountHeart(svg); } catch (e) { /* cosmetic */ }
      }
      row.appendChild(svg);
    }
    var line = $("rb-heart-line");
    if (!line) return;
    /* At the cap the bar cannot grow again, and saying nothing about that would
     * leave the player collecting pips that change no number they can see. */
    if (typeof cap === "number" && typeof max === "number" && n > 0 && max >= cap) {
      setText(line, n + " heart containers. The bar is as long as it goes.");
    } else if (n <= 0) setText(line, "No heart containers yet. Walk somewhere new.");
    else if (n === 1) setText(line, "One heart container.");
    else setText(line, n + " heart containers.");
  }
```

**⚠ `Bird.mountHeart(svg)` writes `innerHTML` on an SVG element the engine owns — this is the SAME mechanism `mountSeed` and `mountBird` already use everywhere in this file and it does not count against the two markup sinks** (the two are `drawEggSeed` and `nestEggHtml`, which assign engine output to `innerHTML` *in this file*). If the sink-count test fails, you wrote the markup here instead of calling the engine — call the engine.

- [ ] **Step 5: The styles**

```css
#ramble .rb-meter-of { color: var(--rb-muted); font-size: 0.85rem; }
#ramble .rb-hearts-line { display: flex; align-items: center; gap: 0.45rem; margin: 0.35rem 0 0; flex-wrap: wrap; }
#ramble .rb-heart-row { display: inline-flex; gap: 0.15rem; }
#ramble .rb-heart-one { width: 16px; height: 16px; display: block; }
```

- [ ] **Step 6: Run the tests**

```bash
node scripts/run-suite.mjs tests/ramble-panel.test.js
```

Expected: PASS, including the zero-backtick and two-sink assertions.

- [ ] **Step 7: Commit**

```bash
git commit bundles/ramble/panel/ramble.js bundles/ramble/panel/static/ramble.js bundles/ramble/panel/static/ramble.css tests/ramble-panel.test.js -m "ramble: the pet page shows the whole bar, and what lengthened it"
git show --stat HEAD
```

---

## Task 8: the docs, the version, and the registry

**Files:**
- Modify: `docs/guide/ramble.md`, `docs/es/guide/ramble.md`
- Modify: `bundles/ramble/manifest.json`, `bundles/ramble/package.json`
- Modify: `registry/add-ons.json` (generated — do not hand-edit)

**Why the bump is not optional:** the Extensions page installs a bundle by copying it to `~/.crow/bundles/ramble/`, and `repairInstalledBundleAssets` refreshes that copy **only** when the repo manifest version differs from the installed one. Ship `server/hearts.js` without a bump and grackle keeps running 0.9.5 forever while the branch looks deployed. This exact failure already happened once, in Ramble phase 1 of the flock arc.

- [ ] **Step 1: The English guide**

`docs/guide/ramble.md` already carries the map paragraph at line 116 (the `## Nests and the egg shelf` section). Extend it with hearts, in the same plain register:

Add after the bird-seed sentences in that paragraph:

```markdown
Now and then a new place also holds a **heart container**, which permanently lengthens your bird's energy bar — about one place in three the first time you enter it, and much more rarely in ground you have already cleared. Hearts are the only thing that raises the maximum; they buy your bird a longer stretch between walks before it droops, and nothing else. A heart you have not collected shows on the map wherever it is waiting, so places you cleared before hearts existed are worth walking again. You collect one by walking to it, the same way you collect seed.
```

Add to the settings table under `### Nests and shelf`, directly after `seed.per.pickup`:

```markdown
| `heart.rate` | 3 | About one place in this many holds a heart container the first time you enter it (integer ≥ 1). |
| `heart.wild.days` | 30 | How long before a heart may reappear in ground you have already cleared. |
| `heart.wild.rate` | 40 | About one cleared place in this many holds that reappearing heart (integer ≥ 1). |
| `energy.max.base` | 100 | The energy bar's length with no heart containers. |
| `energy.max.per.heart` | 10 | How much each heart container lengthens it. |
| `energy.max.cap` | 300 | The longest the bar can ever get, however many hearts you find. |
```

And extend the replication note near line 237:

```markdown
The map of places you have unlocked, and your seed and heart balances, replicate to your own linked Crows, and they never go to a contact.
```

- [ ] **Step 2: The Spanish guide**

Make the matching edits in `docs/es/guide/ramble.md` — the same paragraph (under `## Nidos y el estante de huevos`), the same table rows under `### Nidos y estante`, and the same replication sentence. Translate the prose properly; do not leave English in the Spanish file. The settings **keys** stay in English (they are literal setting names); only the Effect column is translated. There is a global i18n parity gate in this repo — an English doc change with no Spanish counterpart fails CI.

- [ ] **Step 3: The version bump**

```bash
export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH
sed -i 's/"version": "0.9.5"/"version": "0.10.0"/' bundles/ramble/manifest.json bundles/ramble/package.json
grep -n '"version"' bundles/ramble/manifest.json bundles/ramble/package.json
npm run build-registry
git diff --stat registry/add-ons.json
```

Expected: both files read `0.10.0`, and `registry/add-ons.json` picks the new version up.

- [ ] **Step 4: Verify the docs and the registry gates**

```bash
node scripts/run-suite.mjs tests/ramble-panel.test.js
node scripts/check-port-allocation.js
node scripts/build-registry.mjs --check
```

Expected: all pass. This phase adds no port, so `check-ports` is a formality — run it anyway, since CI does.

- [ ] **Step 5: Commit**

```bash
git commit docs/guide/ramble.md docs/es/guide/ramble.md bundles/ramble/manifest.json bundles/ramble/package.json registry/add-ons.json -m "ramble 0.10.0: heart containers"
git show --stat HEAD
```

---

## Final verification

- [ ] **The whole suite, in the foreground**

```bash
export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH
cd /home/kh0pp/crow-wt-ramble-hearts
npm test 2>&1 | tail -25
```

Expected: **4301 + the new tests**, 0 fail (4301 is the measured baseline at `200cf834`). A drop below 4301 means something was deleted, not fixed.

- [ ] **Confirm no schema change slipped in**

```bash
git diff origin/main --stat -- scripts/init-db.js bundles/ramble/server/init-tables.js servers/sharing/instance-sync.js servers/shared/sync-stamp.js servers/sharing/profile-avatar.js
```

Expected: **empty**. Hearts ride the existing `ramble_wallet`. If any of these files changed, the design drifted and the phase needs re-reading before it goes near a database. If the diff really is empty, `scripts/schema-migration-dryrun.sh` has nothing to say — note that in the PR rather than skipping it silently.

- [ ] **Confirm the panel client rules held**

```bash
grep -c '`' bundles/ramble/panel/static/ramble.js   # must print 0
grep -c 'innerHTML' bundles/ramble/panel/static/ramble.js
```

Expected: zero backticks; the `innerHTML` count unchanged from `origin/main` (`git show origin/main:bundles/ramble/panel/static/ramble.js | grep -c innerHTML`).

- [ ] **Whole-branch adversarial review — NOT OPTIONAL**

Dispatch a fresh reviewer over the **entire branch diff against `origin/main`**, not per-task. In phase 1 this gate caught three blocking defects that eight per-task reviews and four plan-review rounds all missed, and every one of them was an interaction between tasks or between the branch and pre-existing production state. Direct the reviewer at exactly that class:

1. **What did we retire or change that was carrying something else?** (Phase 1 removed a button that was also the only exit from a view.) The energy bar's meaning changed; the pet response shape changed; `petFromRow` grew an argument. Who else reads those?
2. **What does an EXISTING player see at the moment of upgrade?** grackle has ~25 unlocked cells and a live pet row. Walk through the first render after deploy: the bar, the counter, the pips, the numbers. Is anything blank, wrong, or retroactively punishing?
3. **Does anything converge wrongly across the user's own instances?** Every new row is `delta = 1` under a natural key — verify that claim rather than accepting it, and check nothing writes a negative delta or a mutable value.
4. **Do the map and the payout genuinely read the same rule**, on every path, including the AR view and `/around`?
5. **Is any heart, cell or balance now reachable by a contact?**

Fix everything it finds ON THE BRANCH before opening the PR.

- [ ] **Open the PR**

`gh` is not installed. Use the `github` MCP server. Body must state, at minimum:
- Phase 2 of the reward-economy spec; **no shop, no wardrobe, no spend path** (K1).
- **No schema change, no migration, no `SCHEMA_GENERATION` bump** — hearts ride `ramble_wallet`.
- The **two recorded deviations** (`heart.wild.rate`, `energy.max.cap`) with their reasons.
- **K2**: existing players' already-unlocked cells keep their hearts as uncollected pips; nothing is granted silently at upgrade.
- **K4**: D2's sad-portrait-to-contacts is explicitly NOT in this phase.
- That `moodFor` thresholds stay absolute at 60/30, and why.
- Ramble is installed on **grackle only** — crow primary and r4 have no Ramble bundle.

- [ ] **Wait for CI green before merging**

```bash
curl -s https://api.github.com/repos/kh0pper/crow/commits/<sha>/check-runs \
  | python3 -c "import json,sys; [print(r['name'], r['status'], r['conclusion']) for r in json.load(sys.stdin)['check_runs']]"
```

Every run must be `completed` / `success`. Contexts: `suite`, `static-checks`, `audit`. An **empty** check-runs result on a current sha means something is wrong, not that the run is clean — the legacy commit-status API omits Actions entirely and can read green while a check is red.

- [ ] **Deploy**

1. **Read `/home/kh0pp/CROW-SCHEDULE.md` first** and register the window before touching anything.
2. Ramble is installed on **grackle only**. crow primary auto-restarts on the `~/crow` HEAD change and has nothing Ramble-shaped to pick up; r4 needs no action.
3. On grackle: back up the database first (phase 1 kept `/home/kh0pp/crow-db-backup-pre-ramble-090.db`; take the equivalent), then restart the gateway.
4. Verify after the restart:
   - the installed copy refreshed `0.9.5` -> `0.10.0`,
   - `SELECT COUNT(*) FROM ramble_wallet WHERE kind = 'heart'` (expect 0 — nothing is granted at upgrade, by K2),
   - `SELECT COUNT(*) FROM ramble_cells` (expect the existing ~25, unchanged),
   - `PRAGMA integrity_check` is ok,
   - the journal shows `[proxy] addon ramble: connected` with no Ramble errors.
5. Then clear the schedule entry.

- [ ] **Hand back to Kevin**

Say plainly: what shipped, what a player with 25 unlocked cells will see (a map with heart pips waiting, a bar still at 100 until the first one is collected), the phone smoke test that is still outstanding from three arcs now, and anything the whole-branch review found.

---

## Out of scope — do not build these here

- A shop, a wardrobe, an accessory catalogue, prices, or **any spend path** (phase 4, K1).
- Removing the auto-minted successor egg, auto-promote, laying, or the prologue (phase 3).
- D2's sad portrait to contacts, and any change to `servers/sharing/profile-avatar.js` (K4).
- Gating the MCP tool surface. Phase 1 left `ramble_query_world` / `ramble_nests` ungated deliberately; hearts add nothing there and this is not the phase to change it.
- Fixing phase 1's known follow-ups: `unlockedCellsNear`'s full-table read, the seed cooldown's global UTC bucket, the AR view filtering beacons out, spec §2.4's overclaim about surveying a city remotely. All are recorded in the phase 1 handoff and none is made worse by this phase.


---

## Review

**Reviewer:** adversarial staff-engineer pass (Plan subagent), 2026-09-09, against the real code rather than the plan's description of it.

**Verdict:** REVISE — six critical issues, all fixed in this document before execution. The reviewer independently confirmed the architecture is sound (`applyRambleWallet` at `servers/sharing/instance-sync.js:600-617` resolves with `MAX(delta)`, all five sync sites registered, `shouldSyncRow` has no `kind` allowlist, so `kind='heart'` with a constant `delta = 1` is safe), verified the scope discipline holds, and measured the statistical test at `share = 0.3293`.

| # | Issue | Resolution |
|---|---|---|
| 1 | The route passed `cell`, not `out.cell`, so a 2 km wifi fix would collect a retroactive heart from any already-unlocked cell — `recordHeartPickup`'s in-`ramble_cells` check protects new ground only. The plan asserted the opposite twice. | Task 4 passes `out.cell` and explains why the fail-closed check alone is insufficient. New test unlocks sharply with no heart present, then makes the cell hold one, then arrives vaguely. |
| 2 | `heartCandidate` was `heartFor(...) || wildHeartFor(...)`, which short-circuits forever once the permanent heart is taken — at the default rate, one cell in three could never grow a wild heart again, while the doc comment promised it would. | Replaced with `heartCandidates()` returning both sources in priority order; both readers take the first untaken one. New test at `rate: 1, wildRate: 1` — the only configuration that can tell the two implementations apart. |
| 3 | `paintPet` was not calling `paintHearts`, so a player who denies geolocation would see the pet page and the map bar disagree. (Phase 1's real defect #1: an affordance added on one path only.) | Task 7 paints the counter from the pet read as well, mirroring the existing `paintSeed(pet.seed)`, with a source assertion. |
| 4 | The pip CSS was one rule; `mountHeart` sets no width/height and `L.divIcon`'s `iconSize` sizes the wrapper, so the heart would render at the CSS default 300x150. | Two rules, copying `.rb-seed-pip` at `ramble.css:883-884`, plus a test that asserts the `> svg` rule exists. `--rb-ink` (which does not exist) corrected to the tokens `.rb-seed` uses. |
| 5 | The `/zones` heart test reused a cell whose heart the previous test had collected, so `hearts` was always `[]`, the per-pip loop never ran, and an implementation returning `[]` unconditionally passed. | Uses a fresh cell (London, `gcpvj0d`) and asserts `hearts.length >= 1` before iterating; also walks there and asserts the pip is collected and disappears. |
| 6 | The "pinned regression vector" was all misses — the reviewer ran the generator and got `- -` for all six cells — so every assertion reduced to `false === false`. | Generator rewritten to search for confirmed hits on each salt; the pin now records positions to six decimals as well as presence, and asserts the hit lists are non-empty. |

**Suggestions adopted:** `Bird` (not `engine`) in the bird-svg test plus its two dropped invariants; the reduced-motion contradiction resolved in favour of the existing comma-separated block, with the test regex rewritten to match; `deepEqual` for the junk-rate fallback (the lucky-hash trap, in the file that warns about it); `availableHearts` no longer re-scans `ramble_cells` and instead asks only about the cells it was given, chunked against the bind limit; the convergence test replaced with one that would actually fail (`energy.max.per.heart = 25`, assert `delta` is still `1`); `energy.max.cap` given a designed UX rather than only a number; the double `sayMoment` on a first unlock that also pays a heart collapsed into one line; `bundles/ramble/server/server.js`'s `ramble_pet_state` added to the file list so the MCP tool and the HTTP route agree; `warmth.visit_place` suppression carried into the new panel tests; the branch rebased onto `200cf834` and the 4301 baseline re-measured there.

**Correction accepted:** the plan had repeatedly attributed a shipped map/payout defect to phase 1. Phase 1's three blocking defects were a retired UI element carrying another affordance, fog blanking existing users, and a non-convergent sync apply; the map/payout gate was added during 0.9.5's seed-sparsity work, not after a shipped bug. The constraint still stands, but the plan now names the right lesson — and issues 1 and 3 above were both instances of phase 1's *actual* defect pattern, which is why the correction mattered.

**Open questions answered:** a cell does grow a wild heart after its permanent one is taken (issue 2); the cap now has designed copy on both the moment and the pet page (issue 2 in the reviewer's list of questions); `heart.rate` stays at the spec's 3, with the density reasoning recorded above and flagged for the PR.

---

### Second review (2026-09-09)

Re-run after the revision, as the process requires. **Verdict: REVISE** — five of the six fixes confirmed real and complete; one was only half-fixed, and the rewrite introduced three defects of its own. All are now addressed.

| # | Issue | Resolution |
|---|---|---|
| 7 | `cells: []` is a **400** (`routes.js`: `b.cells.length === 0` fails validation), so three of the rewritten panel tests could never pass — and the vague-fix test, the one that proves issue 1's fix, would have passed *vacuously against a 400* if someone deleted its precondition. | All three posts drop `cells` entirely and pass `lat`/`lon`, the supported fallback form `walkTo()` itself uses. |
| 8 | The "fresh" cell chosen for the `/zones` test, `gcpvj0d`, is `HERE_LAT`/`HERE_LON`'s own cell — the visit_place test walks it twice — so the `INSERT` was a no-op and the assertion survived only because `heartFor("gcpvj0d", { rate: 3 })` happens to miss. The lucky-hash dependency this plan bans, reintroduced by the fix for issue 5. | Moved to `wecnrmd` (Hong Kong, 22.2233/114.2283); no test in the file uses a latitude near it. The assertion now names the cell rather than counting. |
| 9 | `petState` persisting a downward clamp loses energy permanently on a sync backfill: `SYNCED_TABLES` applies `ramble_settings` and `ramble_pet` **before** `ramble_wallet`, so a synced-in pet at energy 150 gets written down to 100 in the window before this instance's heart rows arrive. | The clamp is applied to the **reported** value only; the stored value waits for the ledger, and only decay writes. The Task 3 test now asserts the stored 150 survives, and that restoring the setting restores the bar. |
| 10 | `scripts/build-registry.js --check` does not exist — the script is `.mjs`. | Corrected. |

**Suggestions adopted:** the seed and heart branches now share a single `refreshZones()` (walking into a cell holding both a regrown seed and a retroactive heart is the K2 upgrade-day case and would otherwise fetch `/zones` twice); `heart_source` threaded through the response so a regrown heart gets its own line instead of the once-ever heart's; `energy.max.per.heart` tightened to `>= 1`, since a zero makes every heart inert while the page still counts them; the two unasserted `wildRate: 999999` preconditions added, for consistency with the file's own rule; Task 6's insertion point given as a line number (`static/ramble.js:423`, with `celebrateUnlock` at `:420` sitting between the two seed lines).

**Ruling recorded:** a cell holding both a permanent and a wild heart pays both on successive posts. It needs both sources to hit at once (~1 cell in 120 at the defaults), and suppressing it would need per-visit state this design does not have.

**Confirmed by the reviewer, needing no change:** `servers/gateway/dashboard/shared/notifications.js` derives mood with hardcoded 60/30, which is consistent with `moodFor` staying absolute; `opts.html = svg` does not match the markup-sink detector, so `heartIcon` spends neither of the two; `CELL7_LAT_STEP === 2 * latErr` exactly, so a placed heart always falls inside its own `cellBox`; no heart, cell or balance reaches a contact-facing payload; the 400-cell chunk in `unlockedAmong` is well inside SQLite's 32766 bind limit.
