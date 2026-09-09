# Ramble — the egg supply overhaul (Phase 3) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eggs stop being free. The auto-minted successor is removed, the shelf auto-promotes into the empty slot, a bird with no eggs at all lays one after sustained care, and a prologue tells a new player who they are — because a new player on a build with no auto-mint and no starter egg has no egg, no bird, and no explanation.

**Architecture:** Minting becomes deliberate. `ensureIncubatingEgg` — today called from four places, two of them pure reads — is renamed `mintIncubatingEgg` and called from exactly two: the starter grant and laying. Every other site reads with `getIncubatingEgg` and tolerates `null`. Auto-promote moves an egg the user already owns; laying is a day-count ledger in the existing `ramble_wallet` under `kind='layday'`, `delta` always `1`, exactly the shape phase 2 proved for hearts. No new table, no schema change.

**Tech Stack:** Node 22 ESM, libsql, Leaflet in the panel client, Node test runner via `scripts/run-suite.mjs`.

**Spec:** `docs/superpowers/specs/2026-09-08-ramble-reward-economy-design.md` — §4 entire (the egg loop), §6.1/§6.4 (ledgers and settings), §7, §8, and phase 3 of §9. Decisions D3 (warmth vanishes), D8 (egg supply), D9 (the floor), D12 (onboarding).

**Phase 2 handoff (read it):** `docs/superpowers/handoffs/2026-09-09-ramble-hearts-phase2-shipped.md` — especially the three lessons, all of which this plan is shaped to avoid repeating.

---

## Kevin's rulings for this phase (2026-09-09, before planning)

| # | Question | Ruling |
|---|---|---|
| K1 | What does a player with an auto-minted egg incubating see on upgrade day? | **Nothing special — build no upgrade-day copy.** Kevin is the only player and intends to **reset to a new game** once phases 3 and 4 are done, specifically so he can experience this as a new player. The live egg is grandfathered silently: it stays, it hatches, no successor follows. **Binding consequence:** the starter-egg grant must be derived from replicated egg data ("has any egg ever existed"), never from a flag that survives a data wipe, and the two prologue flags must be reset-clearable — or the reset will not replay the prologue. |
| K2 | `lay.days` — 14 or 10? | **14**, the spec's number. It is a live setting; retuning is a config change. |
| K3 | Does the prologue ship in this phase? | **Yes, inside phase 3.** A new player on a build with no auto-mint and no starter egg has literally no egg and no way to be told why. The prologue is that player's only entry point — a functional dependency, not decoration. |
| K4 | How legible is laying while eggless? | **Named, with a soft count, in words not a bar.** Phase 3 removes the free egg; a floor you cannot see is not reassurance. The eggless card says how many good days you have had. |
| K5 | What is the incubating egg, given you ARE the bird? | **The next you.** You are whoever is active; the incubating egg is the next self coming; the flock is everyone you have been; laying is you laying it yourself. This is the shipped premise — map phase 1, at the operator's request: *"you are not carrying an egg, you ARE one — an egg that wandered off from its nest."* All copy in this phase is written from inside it. |

---

## Three findings from reading the real code, which reshape the phase

These were found before planning, against the code rather than the spec's description of it. Two contradict the spec. **Do not "fix" them back toward the spec's wording.**

### Finding 1 — the naive null-tolerance change creates a death spiral. This is the important one.

`feedAll` (`bundles/ramble/server/feed.js:42`) gates the **pet feed** on the warmth path's verdict:

```js
const shouldFeedPet = KEYED_TYPES.has(event.type) ? credited === true : true;
// KEYED_TYPES = visit_place, meet_crow, checkin
```

So if `creditWarmth` returns `credited: false` when there is no egg — the obvious way to make it tolerate null — then **visiting a new place, meeting a crow and the daily check-in all stop feeding energy**, exactly while the player is eggless. And laying requires the bird to end the day happy *while eggless*. The naive change makes the floor unreachable: no egg → no energy → never happy → never lays. That is precisely the harshness this design exists to avoid, arriving through a side door.

**Resolution, implemented in Task 2:** `credited` keeps its current meaning — *"this ledger key was new"* — and the ledger row is written whether or not an egg exists. Only the *landing* of warmth is skipped. Warmth genuinely vanishes with no egg (D3 intact, and the key is burned so the same place cannot pay it later), and the pet feed never depends on an egg existing. Task 2 has an executable regression test for exactly this.

### Finding 2 — it is FIVE call sites, not four, and the fifth is UI

The spec's four are correct (`eggState` and `flockState` pure reads, `creditWarmth`, `hatchIfReady`). But a fifth affordance depends on the auto-mint, and its own comment at `bundles/ramble/panel/ramble.js:310` says so:

> *The successor egg is minted the moment one hatches, and the perch swaps to the bird for good — so without this the egg view (and its daily check-in) would be unreachable after the first hatch.*

`paintPerch` sets `perchTarget = "pet"` permanently once a valid bird exists (`static/ramble.js:874`), so the **"Next egg" card is the only route to the egg view after the first hatch**. Hiding it when eggless deletes the daily check-in — phase 1's defect, repeated exactly. **It must change state, never disappear** (Task 8).

### Finding 3 — the spec's starter-egg race protection cannot work

Spec §4.4 says *"Deriving the starter egg's id from the Crow identity makes a simultaneous two-instance first run collapse into a single insert rather than granting two eggs."* `loadOrCreateIdentity` (`servers/sharing/identity.js`) generates a **random 32-byte seed per instance** and derives `crowId` from it — which is exactly how `from_crow_id` distinguishes gift senders. `crowId` is **per-instance, not per-user**, so deriving from it yields two *different* ids on two instances and grants **two** eggs: the outcome it was written to prevent.

A fixed constant id is also wrong: a contact could gift you *their* starter egg and the ids would collide in `ramble_eggs` (`receivedEggStatement` upserts by `egg_id`).

**Resolution, implemented in Task 6:** gate the grant on `SELECT COUNT(*) FROM ramble_eggs = 0` with a random `randomUUID()`, and rely on the **existing** convergence rule. If a genuine simultaneous-first-run race ever happened, `applyRambleEgg`'s "one incubating egg" rule (`servers/sharing/instance-sync.js:721`) keeps the older as incubating and **shelves** the younger with its warmth intact — a spare egg on the shelf, not a duplicate disaster. That machinery is already built and already tested; this phase adds nothing to it.

---

## Global Constraints

- **Base:** `origin/main` @`fa472645`. Worktree `/home/kh0pp/crow-wt-ramble-eggs`, branch `feat/ramble-eggs`, already created. **Never `git checkout` in `~/crow`** — a gateway checkout parked off `main` silently disables fleet auto-update. **Never `cp -a` a worktree** — its `.git` is a pointer file and the copy commits to the real branch.
- **Node/test harness:** `export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH` before any node/npm command. Run tests ONLY as `node scripts/run-suite.mjs tests/<file>.test.js` from the worktree, in the FOREGROUND. **NEVER run bare `node --test`** — it writes to the LIVE production database. Never boot a gateway or MCP server without a scratch `CROW_DATA_DIR`.
- **⚠ The worktree needs `node_modules`.** It is a symlink to the main checkout's: `ln -s /home/kh0pp/crow/node_modules node_modules`. It is already in place. **`git status` shows it as untracked** — `.gitignore`'s trailing-slash `node_modules/` does not match a symlink. This is exactly why every commit in this plan uses positional paths; a bare `git add -A` would commit the symlink.
- **Suite baseline:** **4340 pass / 0 fail at `fa472645`**, measured in this worktree with the symlink in place. The suite must not regress. (A run without `node_modules` reports ~552 failures — that is a missing symlink, not a regression.)
- **No schema change, no migration, no `SCHEMA_GENERATION` bump.** Laying rides `ramble_wallet` (`kind`, `key`, `delta`, `created_at`, `lamport_ts`); prologue flags ride `ramble_settings`. `scripts/init-db.js` is **not modified**. `bundles/ramble/server/init-tables.js` is modified for **a comment only** (Task 3) — its SQL must be byte-identical.
- **Ledgers, not balances (spec §6.1):** a lay-day is an append-only row under a natural idempotent key (the local day). Never store a day count.
- **A `layday` row's `delta` is ALWAYS the integer `1`.** `applyRambleWallet` resolves conflicts with `MAX(delta)`, which is only convergent when the value cannot differ between instances for the same key. Phase 2 shipped a bug here precisely because seed's `delta` was a live setting. **Never write a negative delta** — `MAX(delta)` would resolve `-10`/`-5` to `-5`.
- **You are never simultaneously birdless and eggless.** `hatchIfReady` sets `active_egg_id` on the first hatch and eggless can only occur after a hatch, so the eggless state always has a bird to show. Copy may rely on this; code should still not crash if it is false.
- **Panel client rules, test-enforced:** `bundles/ramble/panel/static/ramble.js` must keep **ZERO backticks** (one truncates the served script; the slip is markdown habit in a code comment), **EXACTLY TWO** engine markup sinks, `textContent` only, and no emoji. `setAttribute`/`removeAttribute`/`className`/Leaflet layer calls are not markup sinks. Build every new node with `createElement` + `textContent`; put new *markup* in the server-rendered shell `panel/ramble.js` and toggle it with `hidden`.
- **Invisible characters:** write any bidi/control character as a `\u` escape, never a raw byte.
- **Commits:** subject-only message, positional paths (`git commit <path> -m "..."`, never `git add -A`), `git add` new files first. **NO AI-attribution trailers of any kind.**
- **Bundle bump:** `bundles/ramble/manifest.json` AND `bundles/ramble/package.json` `0.10.0` -> `0.11.0`; then `npm run build-registry`. Without the bump, `repairInstalledBundleAssets` never refreshes the installed copy on grackle and the deploy silently ships nothing.
- **⚠ There is NO CI gate for guide-doc i18n parity.** `tests/i18n-global-parity.test.js` covers the translation-key mechanism only; nothing diffs `docs/guide/*.md` against `docs/es/guide/*.md`. Phase 2's plan claimed such a gate exists. It does not. Update `docs/es/guide/ramble.md` by hand and check it by hand.
- **`gh` is NOT installed on crow.** Open the PR through the `github` MCP server; poll CI with `curl` against `/commits/<sha>/check-runs` (contexts `suite`, `static-checks`, `audit`).
- **Privacy (spec §2.4, §7):** nothing in this phase may add an egg, a lay-day or a balance to any contact-facing payload. `delivery.js`, `trades.js` and `nostr-map.js` keep their existing wire shapes.

## Deviations from the spec, recorded

1. **The starter-egg id is a random UUID gated on an empty egg table, not derived from the Crow identity.** See Finding 3 — the spec's mechanism is impossible because `crowId` is per-instance. Say this in the PR body so a reviewer reads it as a correction, not drift.
2. **`creditWarmth` still writes its ledger row when there is no egg.** See Finding 1. The spec does not describe the interaction with `feedAll`'s `shouldFeedPet` gate at all; without this, laying is unreachable.
3. **Auto-promote runs lazily on read paths as well as on hatch.** Spec §4.2 says "when the incubating slot empties" without saying who notices. A slot can empty from a sync arrival that no local code path observes, so the read paths carry a *guarded* promote. This is a write during a GET and a reviewer should challenge it — the justification is that it moves an egg the user already owns rather than conjuring one, and Task 3 has a test asserting a read with nothing promotable writes nothing.

---

## File structure

**Create**
- `bundles/ramble/server/egg-locks.js` — `OPEN_SQL`, `isEggLocked`, `lockedEggIds`, moved verbatim from `trades.js`. A leaf module with no imports. **Why it exists:** auto-promote must skip an egg named by an open swap, but `trades.js` imports `startOfLocalDay` from `eggs.js`, so `eggs.js` cannot import `trades.js` without a cycle.
- `tests/ramble-eggs-supply.test.js` — null tolerance, the feed decoupling, auto-promote, convergence.
- `tests/ramble-laying.test.js` — the lay-day ledger and the floor.
- `tests/ramble-prologue.test.js` — the starter grant and the two flags.

**Modify**
- `bundles/ramble/server/trades.js` — import the three lock symbols from `egg-locks.js` and re-export `isEggLocked`/`lockedEggIds` so existing consumers are untouched.
- `bundles/ramble/server/eggs.js` — the bulk: rename, null tolerance, promote, laying, starter grant, prologue flags.
- `bundles/ramble/server/flock.js` — drop the mint from `flockState`; import the locks from the leaf.
- `bundles/ramble/server/pet.js` — call the lay-day recorder after mood is known.
- `bundles/ramble/server/feed.js` — `readPet` carries the egg summary and lay progress.
- `bundles/ramble/server/init-tables.js` — **comment only** (the `shelf_origin` comment says `'user'` must never be auto-promoted; that rule is the *sync layer's*, and phase 3 adds an app-level promote that deliberately does).
- `bundles/ramble/panel/routes.js` — null-tolerant egg/pet/flock responses; the two prologue routes.
- `bundles/ramble/server/server.js` — `ramble_egg_state` / `ramble_pet_state` MCP tools must agree with the HTTP routes.
- `bundles/ramble/panel/ramble.js` — the eggless states on the egg view and the Next egg card; the prologue overlay markup; the framing copy fixes.
- `bundles/ramble/panel/static/ramble.js` — null-tolerant painters, the prologue, the AR fix, the perch labels.
- `bundles/ramble/panel/static/ramble.css` — prologue overlay and eggless-card rules.
- `tests/ramble-eggs.test.js`, `tests/ramble-flock.test.js`, `tests/ramble-trades.test.js`, `tests/ramble-sync.test.js`, `tests/ramble-panel.test.js`, `tests/ramble-tools.test.js` — updated in the task that changes the behaviour they cover.
- `bundles/ramble/manifest.json`, `bundles/ramble/package.json`, `registry/add-ons.json`.
- `docs/guide/ramble.md`, `docs/es/guide/ramble.md`.

**Explicitly NOT modified:** `scripts/init-db.js`, `servers/sharing/instance-sync.js`, `servers/shared/sync-stamp.js`, `servers/sharing/profile-avatar.js`, `bundles/ramble/server/delivery.js`, `bundles/ramble/server/nostr-map.js`, `bundles/ramble/server/hearts.js`, `bundles/ramble/server/cells.js`.

---

## Task 1: `egg-locks.js` — break the cycle before anything needs it

**Files:**
- Create: `bundles/ramble/server/egg-locks.js`
- Modify: `bundles/ramble/server/trades.js`
- Modify: `bundles/ramble/server/flock.js` (import site only)

**Interfaces:**
- Produces: `OPEN_SQL` (string), `isEggLocked(db, eggId) -> Promise<boolean>`, `lockedEggIds(db) -> Promise<Set<string>>`.
- Consumed by: Task 3 (`eggs.js` auto-promote), and by `trades.js`/`flock.js` unchanged in behaviour.

**Why:** `trades.js` line 32 imports `startOfLocalDay` from `eggs.js`. Task 3 needs the lock predicate inside `eggs.js`. Importing `trades.js` from `eggs.js` would make `eggs -> trades -> eggs`. ESM tolerates some cycles, but a reviewer will and should reject one; a leaf module is the honest fix and keeps a single source of truth for the lock rule.

- [ ] **Step 1: Find the current definitions**

```bash
cd /home/kh0pp/crow-wt-ramble-eggs
grep -n "OPEN_SQL\|isEggLocked\|lockedEggIds" bundles/ramble/server/trades.js bundles/ramble/server/flock.js
```

Record the exact `OPEN_SQL` text — it must move **verbatim**. Changing the open-trade predicate would silently change which eggs are giftable.

- [ ] **Step 2: Create the leaf module**

Create `bundles/ramble/server/egg-locks.js`, pasting the real `OPEN_SQL` from Step 1 in place of the placeholder comment:

```js
/**
 * Ramble egg locks — is this egg spoken for by an open swap?
 *
 * A LEAF module: it imports nothing, deliberately. The rule lived in
 * trades.js, but trades.js imports `startOfLocalDay` from eggs.js, and phase
 * 3's auto-promote (eggs.js) must skip a locked egg — so keeping it there
 * would force an eggs -> trades -> eggs cycle. trades.js re-exports both
 * helpers, so every existing consumer is unchanged and there is still exactly
 * one definition of "locked".
 */

// Verbatim from trades.js:68. An "open" trade is one that still has a claim on
// the egg; changing this set would silently change which eggs are giftable.
export const OPEN_SQL = "state IN ('proposed', 'accepted')";

export async function lockedEggIds(db) {
  const { rows } = await db.execute({
    sql: `SELECT my_egg_id FROM ramble_trades WHERE my_egg_id IS NOT NULL AND ${OPEN_SQL}`,
    args: [],
  });
  return new Set(rows.map((r) => r.my_egg_id));
}

export async function isEggLocked(db, eggId) {
  const { rows } = await db.execute({
    sql: `SELECT 1 FROM ramble_trades WHERE my_egg_id = ? AND ${OPEN_SQL} LIMIT 1`,
    args: [eggId],
  });
  return rows.length > 0;
}
```

- [ ] **Step 3: Point `trades.js` at it and re-export**

In `bundles/ramble/server/trades.js`: delete the local `OPEN_SQL`, `lockedEggIds` and `isEggLocked` definitions, and add to the import block:

```js
import { OPEN_SQL, isEggLocked, lockedEggIds } from "./egg-locks.js";

// Re-exported so existing importers (flock.js, panel/routes.js) need no change
// and there is still one definition of "locked".
export { isEggLocked, lockedEggIds };
```

**⚠ `LOCK_GUARD_SQL` (line 69) and `GIFTABLE_GUARD_SQL` (line 71) sit immediately below the old `OPEN_SQL` and interpolate it at module load.** They stay in `trades.js` untouched — the imported `OPEN_SQL` feeds them exactly as the local const did. Deleting the const without adding the import breaks the module at load, not at test time. Leave every other use of `OPEN_SQL` inside `trades.js` exactly as it was.

- [ ] **Step 4: Point `flock.js` at the leaf directly**

```js
// was: import { isEggLocked, lockedEggIds } from "./trades.js";
import { isEggLocked, lockedEggIds } from "./egg-locks.js";
```

- [ ] **Step 5: Run the affected suites — this task must be behaviour-neutral**

```bash
export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH
cd /home/kh0pp/crow-wt-ramble-eggs
node scripts/run-suite.mjs tests/ramble-trades.test.js
node scripts/run-suite.mjs tests/ramble-flock.test.js
```

Expected: both PASS with the same counts as on `origin/main`. A pure move must change no test.

- [ ] **Step 6: Commit**

```bash
git add bundles/ramble/server/egg-locks.js
git commit bundles/ramble/server/egg-locks.js bundles/ramble/server/trades.js bundles/ramble/server/flock.js \
  -m "ramble: move the egg-lock predicate to a leaf module"
```

---

## Task 2: the egg may be absent — reads stop minting, and the feed stops depending on it

**Files:**
- Modify: `bundles/ramble/server/eggs.js`
- Create: `tests/ramble-eggs-supply.test.js`
- Modify: `tests/ramble-eggs.test.js`, `tests/ramble-flock.test.js`, `tests/ramble-trades.test.js`, `tests/ramble-sync.test.js` (import rename only)

**Interfaces:**
- Produces: `mintIncubatingEgg(db, { now, emit }) -> Promise<row>` (renamed from `ensureIncubatingEgg`, body unchanged), `getIncubatingEgg(db) -> Promise<row|null>` (now exported).
- `eggState(db, { now })` now returns `{ egg: null | {...}, checklist: {...} }`.
- `creditWarmth` return shape is unchanged; its `credited` semantics are preserved deliberately (Finding 1).

**Why the rename:** the whole point of this phase is that minting is now deliberate. A function still called `ensureIncubatingEgg` invites a future caller to re-introduce exactly the bug being removed. Tests use it as a fixture and keep working under the new name.

- [ ] **Step 1: Write the failing tests**

Create `tests/ramble-eggs-supply.test.js`:

```js
/**
 * Spec 2026-09-08 §4.1 — the auto-minted egg is gone, and NOTHING recreates
 * it by being looked at.
 *
 * ⚠ The test that matters most here is "walking still feeds you with no egg".
 * feedAll gates the PET feed on creditWarmth's `credited`, so making
 * creditWarmth report not-credited when there is no egg would stop energy
 * arriving exactly while the player is eggless — and laying (Task 5) needs
 * happy days while eggless. That is a death spiral, not a rough edge.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import {
  mintIncubatingEgg, getIncubatingEgg, eggState, creditWarmth, localDay,
} from "../bundles/ramble/server/eggs.js";
import { feedAll } from "../bundles/ramble/server/feed.js";

const T0 = Date.UTC(2026, 8, 9, 12, 0, 0);

async function freshDb() {
  const db = createClient({ url: ":memory:" });
  await initRambleTables(db);
  return db;
}

async function eggCount(db) {
  const { rows } = await db.execute({ sql: "SELECT count(*) AS n FROM ramble_eggs", args: [] });
  return Number(rows[0].n);
}

test("eggState on a fresh db creates NO egg and reports egg: null", async () => {
  const db = await freshDb();
  const state = await eggState(db, { now: T0 });
  assert.equal(state.egg, null, "no egg exists, so none is reported");
  assert.equal(await eggCount(db), 0, "a pure read must not mint");
  assert.ok(state.checklist, "the checklist still renders with no egg");
});

test("eggState is still a pure read when an egg DOES exist", async () => {
  const db = await freshDb();
  await mintIncubatingEgg(db, { now: T0 });
  const state = await eggState(db, { now: T0 });
  assert.ok(state.egg, "the egg is reported");
  assert.equal(state.egg.warmth, 0);
  assert.equal(state.egg.percent, 0);
  assert.equal(await eggCount(db), 1, "reading twice must not mint a second");
  await eggState(db, { now: T0 });
  assert.equal(await eggCount(db), 1);
});

test("creditWarmth with no egg: the ledger row is written, warmth vanishes (D3)", async () => {
  const db = await freshDb();
  const out = await creditWarmth(db, { type: "visit_place", cell: "9vk79ed" }, { now: T0 });
  assert.equal(out.credited, true, "credited means THE KEY WAS NEW, not that an egg received it");
  assert.equal(out.warmth, 0);
  assert.equal(out.hatched, null);
  assert.equal(await eggCount(db), 0, "crediting warmth must never mint an egg");

  const { rows } = await db.execute({
    sql: "SELECT count(*) AS n FROM ramble_credits WHERE kind = 'visit_place'", args: [],
  });
  assert.equal(Number(rows[0].n), 1, "the key is burned: D3 says the warmth is wasted, not banked");

  // Same place again in the same week is still a no-op.
  const again = await creditWarmth(db, { type: "visit_place", cell: "9vk79ed" }, { now: T0 });
  assert.equal(again.credited, false);
});

test("REGRESSION: walking, meeting a crow and checking in ALL still feed energy with no egg", async () => {
  const db = await freshDb();
  const before = await feedAll(db, { type: "checkin" }, { now: T0 });
  assert.equal(await eggCount(db), 0, "feeding must not mint an egg");
  assert.ok(before.pet, "a pet is always returned");
  assert.ok(before.pet.energy > 0, "the check-in fed the bird even with no egg");

  const place = await feedAll(db, { type: "visit_place", cell: "9vk79ed" }, { now: T0 + 1000 });
  const crow = await feedAll(db, { type: "meet_crow", persona: "abc123" }, { now: T0 + 2000 });
  assert.ok(place.pet.energy >= before.pet.energy, "a new place fed the bird");
  assert.ok(crow.pet.energy >= place.pet.energy, "meeting a crow fed the bird");
  assert.equal(await eggCount(db), 0);
});

test("an unknown or pet-only event is still a pure read with no egg", async () => {
  const db = await freshDb();
  await creditWarmth(db, { type: "chore" }, { now: T0 });
  await creditWarmth(db, { type: "nonsense" }, { now: T0 });
  assert.equal(await eggCount(db), 0);
  const { rows } = await db.execute({ sql: "SELECT count(*) AS n FROM ramble_credits", args: [] });
  assert.equal(Number(rows[0].n), 0, "chore/unknown never touch the ledger");
});

test("getIncubatingEgg is a plain read that returns null rather than throwing", async () => {
  const db = await freshDb();
  assert.equal(await getIncubatingEgg(db), null);
  const egg = await mintIncubatingEgg(db, { now: T0 });
  const read = await getIncubatingEgg(db);
  assert.equal(read.egg_id, egg.egg_id);
});
```

- [ ] **Step 2: Run it to watch it fail**

```bash
export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH
cd /home/kh0pp/crow-wt-ramble-eggs
node scripts/run-suite.mjs tests/ramble-eggs-supply.test.js
```

Expected: FAIL — `mintIncubatingEgg` is not exported.

- [ ] **Step 3: Rename the mint and export the read**

In `bundles/ramble/server/eggs.js`:

```js
/**
 * Insert a fresh incubating egg. THE ONLY MINTING PRIMITIVE — as of phase 3
 * it is called from exactly two places, the starter grant and laying, and
 * both are deliberate acts. It was called `ensureIncubatingEgg` and was
 * invoked from four sites, two of them pure reads (`eggState` on every
 * GET /api/ramble/egg, `flockState` on every flock screen), so merely looking
 * at a screen recreated the egg. Read with `getIncubatingEgg` instead; the
 * name is "mint" so that a future caller has to mean it.
 *
 * The INSERT ... SELECT ... WHERE NOT EXISTS guard (rather than a unique
 * index) makes this race-free within one process on a single SQLite
 * connection: two overlapping calls each attempt the guarded insert, only one
 * succeeds, and both re-select the same egg.
 */
export async function mintIncubatingEgg(db, { now, emit } = {}) {
  // ...body unchanged from ensureIncubatingEgg...
}
```

Change `async function getIncubatingEgg(db)` to `export async function getIncubatingEgg(db)`.

- [ ] **Step 4: Make `eggState` a pure read**

```js
export async function eggState(db, { now } = {}) {
  const egg = await getIncubatingEgg(db);
  const weights = await readWarmthWeights(db);
  const percent = egg && weights.hatch_at > 0
    ? Math.max(0, Math.min(100, Math.round((egg.warmth / weights.hatch_at) * 100)))
    : 0;
  // ...the three checklist queries are unchanged...
  return {
    egg: egg
      ? { egg_id: egg.egg_id, warmth: egg.warmth, hatch_at: weights.hatch_at, percent }
      : null,
    checklist: { new_places_week: newPlacesWeek, first_mark: firstMark, checked_in_today: checkedInToday },
  };
}
```

- [ ] **Step 5: Decouple `creditWarmth` from the egg's existence**

Replace the `const egg = await ensureIncubatingEgg(...)` line and the warmth update that follows:

```js
  // ⚠ NOT a mint. With no egg the ledger row is STILL written and `credited`
  // is still true, because `credited` means "this key was new" and
  // feedAll's `shouldFeedPet` gate reads it: reporting not-credited here
  // would stop new places, crows and check-ins from feeding the bird for as
  // long as the player is eggless — and laying needs happy days while
  // eggless. The warmth itself vanishes (spec D3) and the key is burned, so
  // the same place cannot bank warmth for a later egg.
  const egg = await getIncubatingEgg(db);

  if (key) {
    const { rowsAffected } = await db.execute({
      sql: "INSERT OR IGNORE INTO ramble_credits (kind, key, credited_at) VALUES (?, ?, ?)",
      args: [key.kind, key.key, now],
    });
    if (rowsAffected === 0) {
      const current = await getIncubatingEgg(db);
      return { credited: false, warmth: current ? current.warmth : 0, hatched: null };
    }
  }

  if (!egg) return { credited: true, warmth: 0, hatched: null };

  const weights = await readWarmthWeights(db);
  const delta = weights[event.type] ?? 0;
  const newWarmth = Math.max(0, Math.min(weights.hatch_at, egg.warmth + delta));
  // ...the UPDATE, re-select, emit and hatchIfReady tail are unchanged...
```

Also update `notCredited()` to use `getIncubatingEgg` (it already did, via the private name).

- [ ] **Step 6: Update the four test files' imports**

```bash
cd /home/kh0pp/crow-wt-ramble-eggs
sed -i 's/\bensureIncubatingEgg\b/mintIncubatingEgg/g' \
  tests/ramble-eggs.test.js tests/ramble-flock.test.js tests/ramble-trades.test.js tests/ramble-sync.test.js
grep -rn "ensureIncubatingEgg" tests/ bundles/ | grep -v node_modules
```

Expected from the grep: **no hits**. `servers/sharing/instance-sync.js:726` mentions the old name in a doc comment — leave that file alone; Task 3 fixes the comment in `init-tables.js` only. If the grep shows `instance-sync.js`, that is expected and must NOT be edited.

- [ ] **Step 7: Run the tests**

```bash
node scripts/run-suite.mjs tests/ramble-eggs-supply.test.js
node scripts/run-suite.mjs tests/ramble-eggs.test.js
```

Expected: both PASS. `tests/ramble-eggs.test.js` has a test asserting two `mintIncubatingEgg` calls return the same egg — that still holds.

- [ ] **Step 8: Commit**

```bash
git add tests/ramble-eggs-supply.test.js
git commit bundles/ramble/server/eggs.js tests/ramble-eggs-supply.test.js tests/ramble-eggs.test.js \
  tests/ramble-flock.test.js tests/ramble-trades.test.js tests/ramble-sync.test.js \
  -m "ramble: looking at a screen no longer mints an egg"
```

---

## Task 3: auto-promote — the shelf refills the empty slot

**Files:**
- Modify: `bundles/ramble/server/eggs.js`, `bundles/ramble/server/flock.js`, `bundles/ramble/server/init-tables.js` (comment only)
- Modify: `tests/ramble-eggs-supply.test.js`

**Interfaces:**
- Produces: `promoteFromShelf(db, { now, emit }) -> Promise<row|null>` — promotes the oldest non-locked `shelf`/`received` egg into the incubating slot, or returns null.
- Consumed by: `hatchIfReady` (eggs.js), `eggState`/`flockState`/`petState` read paths (Task 4/6), `panel/routes.js`.

**The ordering rule, which is the whole design:** both instances must pick the **same** egg with no round trip. The order is `created_at ASC, egg_id ASC` — a total order and a pure function of replicated rows, exactly the order `RAMBLE_EGG_REPROMOTE_SQL` already uses for the sync layer's own re-promote.

**⚠ This is NOT the sync layer's re-promote.** `servers/sharing/instance-sync.js:713` deliberately promotes only `shelf_origin = 'sync'` eggs, with a comment that `'user'` eggs "must never be drafted back in". That rule is correct **for sync**, which is a convergence tie-break carrying no user intent. The app-level promote here is a game rule and *does* take user eggs — that is the entire release valve of spec §4.2. **Do not modify `instance-sync.js`.**

- [ ] **Step 1: Write the failing tests**

Append to `tests/ramble-eggs-supply.test.js`:

```js
import { promoteFromShelf, hatchIfReady } from "../bundles/ramble/server/eggs.js";

async function shelveEgg(db, eggId, createdAt, { status = "shelf", origin = "user" } = {}) {
  await db.execute({
    sql: `INSERT INTO ramble_eggs (egg_id, status, shelf_origin, warmth, created_at) VALUES (?, ?, ?, 0, ?)`,
    args: [eggId, status, origin, createdAt],
  });
}

async function statusOf(db, eggId) {
  const { rows } = await db.execute({ sql: "SELECT status, shelf_origin FROM ramble_eggs WHERE egg_id = ?", args: [eggId] });
  return rows[0] ?? null;
}

test("promoteFromShelf takes the OLDEST shelf egg and clears shelf_origin", async () => {
  const db = await freshDb();
  await shelveEgg(db, "younger", T0 + 5000);
  await shelveEgg(db, "older", T0);

  const promoted = await promoteFromShelf(db, { now: T0 + 9000 });
  assert.equal(promoted.egg_id, "older", "oldest created_at wins");
  assert.equal((await statusOf(db, "older")).status, "incubating");
  assert.equal((await statusOf(db, "older")).shelf_origin, null,
    "an incubating egg carries no shelf origin, same as the manual incubate path");
  assert.equal((await statusOf(db, "younger")).status, "shelf", "only one is drafted");
});

test("promoteFromShelf breaks a created_at tie by the lower egg_id, so two instances agree", async () => {
  const db = await freshDb();
  await shelveEgg(db, "bbb", T0);
  await shelveEgg(db, "aaa", T0);
  const promoted = await promoteFromShelf(db, { now: T0 });
  assert.equal(promoted.egg_id, "aaa");
});

test("promoteFromShelf takes a RECEIVED (gifted) egg too", async () => {
  const db = await freshDb();
  await shelveEgg(db, "gift", T0, { status: "received" });
  const promoted = await promoteFromShelf(db, { now: T0 });
  assert.equal(promoted.egg_id, "gift");
});

test("promoteFromShelf SKIPS an egg spoken for by an open swap", async () => {
  const db = await freshDb();
  await shelveEgg(db, "locked-one", T0);
  await shelveEgg(db, "free-one", T0 + 1000);
  // ⚠ 'proposed', not 'offered'. OPEN_SQL is "state IN ('proposed','accepted')",
  // so a made-up state would leave the egg UNLOCKED and this test would be
  // asserting nothing about locking. counterpart/role/expires_at are NOT NULL
  // with no defaults — omitting them fails on the constraint, not the feature.
  await db.execute({
    sql: `INSERT INTO ramble_trades
            (trade_id, counterpart, role, my_egg_id, state, created_at, updated_at, expires_at)
          VALUES ('t1', 'npub-them', 'proposer', 'locked-one', 'proposed', ?, ?, ?)`,
    args: [T0, T0, T0 + 7 * 86400000],
  });
  const promoted = await promoteFromShelf(db, { now: T0 + 2000 });
  assert.equal(promoted.egg_id, "free-one", "an egg promised to a contact is not drafted");
  assert.equal((await statusOf(db, "locked-one")).status, "shelf");
});

test("promoteFromShelf is a NO-OP when the slot is full, and when there is nothing to promote", async () => {
  const db = await freshDb();
  assert.equal(await promoteFromShelf(db, { now: T0 }), null, "empty shelf, empty slot");
  assert.equal(await eggCount(db), 0, "a no-op promote writes NOTHING — this is what makes it safe on a GET");

  const sitting = await mintIncubatingEgg(db, { now: T0 });
  await shelveEgg(db, "waiting", T0 - 5000);
  assert.equal(await promoteFromShelf(db, { now: T0 }), null, "the slot is occupied");
  assert.equal((await statusOf(db, "waiting")).status, "shelf");
  assert.equal((await getIncubatingEgg(db)).egg_id, sitting.egg_id);
});

test("hatching promotes from the shelf instead of minting a successor", async () => {
  const db = await freshDb();
  const egg = await mintIncubatingEgg(db, { now: T0 });
  await shelveEgg(db, "next-you", T0 + 100);
  await db.execute({ sql: "UPDATE ramble_eggs SET warmth = 100 WHERE egg_id = ?", args: [egg.egg_id] });

  const hatched = await hatchIfReady(db, { now: T0 + 1000 });
  assert.ok(hatched, "it hatched");
  assert.equal(await eggCount(db), 2, "NO successor was minted");
  assert.equal((await getIncubatingEgg(db)).egg_id, "next-you", "the shelf refilled the slot");
});

test("hatching with an EMPTY shelf leaves the slot empty — no free egg", async () => {
  const db = await freshDb();
  const egg = await mintIncubatingEgg(db, { now: T0 });
  await db.execute({ sql: "UPDATE ramble_eggs SET warmth = 100 WHERE egg_id = ?", args: [egg.egg_id] });

  const hatched = await hatchIfReady(db, { now: T0 + 1000 });
  assert.ok(hatched);
  assert.equal(await getIncubatingEgg(db), null, "this is the whole phase: no successor appears");
  assert.equal(await eggCount(db), 1);
});

test("two instances promote the SAME egg independently, with no round trip", async () => {
  const a = await freshDb();
  const b = await freshDb();
  for (const db of [a, b]) {
    await shelveEgg(db, "zzz", T0);
    await shelveEgg(db, "aaa", T0);          // same created_at: the tie-break decides
    await shelveEgg(db, "mmm", T0 + 1);
  }
  const pa = await promoteFromShelf(a, { now: T0 + 100 });
  const pb = await promoteFromShelf(b, { now: T0 + 100 });
  assert.equal(pa.egg_id, pb.egg_id, "the order is a pure function of replicated rows");
  assert.equal(pa.egg_id, "aaa");
});
```

- [ ] **Step 2: Run it to watch it fail**

```bash
node scripts/run-suite.mjs tests/ramble-eggs-supply.test.js
```

Expected: FAIL — `promoteFromShelf` is not exported.

- [ ] **Step 3: Implement `promoteFromShelf` in `eggs.js`**

Add the import at the top of `bundles/ramble/server/eggs.js`:

```js
import { lockedEggIds } from "./egg-locks.js";
```

Then:

```js
/**
 * Refill an empty incubating slot from the shelf (spec §4.2). This is the
 * release valve that makes D3 — warmth vanishing when there is no egg —
 * tolerable: the user is only ever eggless when they genuinely have none.
 *
 * Order is `created_at ASC, egg_id ASC`: a TOTAL order and a pure function of
 * rows that replicate, so two instances reach the same answer independently
 * with nothing to exchange and nothing to emit beyond the row itself.
 *
 * ⚠ NOT the same mechanism as `RAMBLE_EGG_REPROMOTE_SQL` in
 * servers/sharing/instance-sync.js, which promotes ONLY `shelf_origin='sync'`
 * eggs and says a 'user' egg "must never be drafted back in". That is correct
 * FOR SYNC: it is a convergence tie-break carrying no user intent, and
 * drafting a deliberately-parked egg on a sync apply would override a choice
 * the user made. This one is a game rule and DOES take user eggs — that is
 * the point of §4.2. Do not unify them.
 *
 * An egg named by an open swap is skipped: it is promised to a contact, and
 * incubating it would let the user spend it twice.
 *
 * Writes NOTHING when the slot is occupied or nothing is promotable, which is
 * what makes it safe to call from a read path.
 */
export async function promoteFromShelf(db, { now, emit } = {}) {
  void now;
  if (await getIncubatingEgg(db)) return null;

  const locked = await lockedEggIds(db);
  const { rows } = await db.execute({
    sql: `SELECT egg_id FROM ramble_eggs
           WHERE status IN ('shelf', 'received')
           ORDER BY created_at ASC, egg_id ASC`,
    args: [],
  });
  const next = rows.find((r) => !locked.has(r.egg_id));
  if (!next) return null;

  // Guarded exactly like mintIncubatingEgg: the "one incubating egg" rule is
  // a query against the table's contents, not a schema constraint, so two
  // overlapping promotes must not both succeed.
  const { rowsAffected } = await db.execute({
    sql: `UPDATE ramble_eggs SET status = 'incubating', shelf_origin = NULL
           WHERE egg_id = ? AND status IN ('shelf', 'received')
             AND NOT EXISTS (SELECT 1 FROM ramble_eggs WHERE status = 'incubating')`,
    args: [next.egg_id],
  });
  if (rowsAffected === 0) return null;

  const promoted = await getIncubatingEgg(db);
  if (promoted) await safeEmit(emit, "ramble_eggs", "update", promoted);
  return promoted;
}
```

- [ ] **Step 4: Rewire `hatchIfReady`**

Replace the successor mint at the end of `hatchIfReady`:

```js
  // Phase 3: the successor egg is NOT minted. The shelf refills the slot if
  // it can; otherwise the player is genuinely eggless and the panel says so.
  await promoteFromShelf(db, { now, emit });

  return hatchedEgg;
```

Delete the now-unused `const nextEgg = ...; void nextEgg;` lines. Update `hatchIfReady`'s doc comment, whose second paragraph describes minting a successor — it must now describe promoting.

- [ ] **Step 5: Stop `flockState` from minting**

In `bundles/ramble/server/flock.js`, delete `await ensureIncubatingEgg(db, { now });` from `flockState` and replace it with:

```js
  // Phase 3: a flock screen is a READ. It used to mint the incubating egg,
  // so opening this view recreated one. It may still promote, because a slot
  // can empty from a sync arrival that no local code path observed — that
  // moves an egg the user already owns rather than conjuring one, and
  // promoteFromShelf writes nothing when there is nothing to promote.
  await promoteFromShelf(db, { now });
```

Update the import: drop `ensureIncubatingEgg`, add `promoteFromShelf`.

- [ ] **Step 6: Correct the stale comment in `init-tables.js` — COMMENT ONLY**

The `shelf_origin` comment currently reads "and it must NEVER be auto-promoted". Phase 3 adds an auto-promote that deliberately does. Leaving it would make a reader conclude the new promote is a bug — the phase 2 lesson about a wrong-but-checkable justification, in reverse. Change that clause to:

```js
  // Phase 2: WHY an egg is on the shelf. 'sync' = a convergence loser (the
  // sync layer may re-promote it when the incubating slot empties); 'user' =
  // the user put it there (claimed from a nest, or swapped out by incubate)
  // and THE SYNC LAYER must never draft it back in. Phase 3's app-level
  // auto-promote (eggs.js promoteFromShelf, spec §4.2) DOES take 'user' eggs
  // deliberately — that is the release valve; the two are different
  // mechanisms with different triggers. Phase 1 only ever shelved convergence
  // losers, so a NULL shelf row on disk is one of those: backfill it to 'sync'
  // (idempotent, and a 'user' row is never NULL so it is never touched).
```

Then prove the SQL did not move:

```bash
git diff bundles/ramble/server/init-tables.js | grep -E "^[+-]" | grep -viE "^[+-]\s*(//|\*|/\*)" | grep -v "^[+-][+-]"
```

Expected: **no output.** Any line here means executable SQL changed and the change must be reverted.

- [ ] **Step 7: Run the tests**

```bash
node scripts/run-suite.mjs tests/ramble-eggs-supply.test.js
node scripts/run-suite.mjs tests/ramble-flock.test.js
node scripts/run-suite.mjs tests/ramble-sync.test.js
```

Expected: all PASS. `tests/ramble-flock.test.js` may have a test asserting a successor appears after a hatch — if so, it is asserting the behaviour this phase removes: update it to assert the slot is empty, and say so in the commit.

- [ ] **Step 8: Commit**

```bash
git commit bundles/ramble/server/eggs.js bundles/ramble/server/flock.js \
  bundles/ramble/server/init-tables.js tests/ramble-eggs-supply.test.js tests/ramble-flock.test.js \
  -m "ramble: the shelf refills the incubating slot, and hatching mints nothing"
```

---

## Task 4: laying — the floor, as a replicated day ledger

**Files:**
- Modify: `bundles/ramble/server/eggs.js`, `bundles/ramble/server/pet.js`
- Create: `tests/ramble-laying.test.js`

**Interfaces:**
- Produces:
  - `LAY_DAYS_DEFAULT = 14`, `LAYDAY_KIND = "layday"`, `LAY_KIND = "lay"`
  - `readLaySettings(db) -> Promise<{ layDays }>`
  - `hasAnyEggAnywhere(db) -> Promise<boolean>` — an incubating, shelf or received egg (a hatched bird is not an egg)
  - `layProgress(db) -> Promise<{ days, needed }>`
  - `recordHappyDay(db, { now, mood, emit }) -> Promise<{ recorded, laid }>`
- Consumed by: `pet.js` (Task 4), `panel/routes.js` (Task 6), the panel (Task 8).

**The reset, without deleting ledger rows:** a lay-day is `ramble_wallet(kind='layday', key=<local day>, delta=1)`. When the bird lays, a `ramble_wallet(kind='lay', key=<local day>, delta=1)` row records it. Progress counts `layday` rows with `created_at` **greater than** the newest `lay` row's `created_at` (all of them if none). Nothing is ever deleted, the count still resets, and both instances derive the same number from the same replicated rows.

- [ ] **Step 1: Write the failing tests**

Create `tests/ramble-laying.test.js`:

```js
/**
 * Spec 2026-09-08 §4.3 — the laying floor.
 *
 * The count accrues ONLY while the user has no eggs at all. Were it always
 * accruing, a player would run dry and lay almost immediately, undercutting
 * nests as the real supply.
 *
 * Rows live in ramble_wallet with delta ALWAYS the literal 1: applyRambleWallet
 * resolves conflicts with MAX(delta), which is only convergent when the value
 * cannot differ between instances for the same key.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import {
  mintIncubatingEgg, getIncubatingEgg, recordHappyDay, layProgress,
  hasAnyEggAnywhere, readLaySettings, LAY_DAYS_DEFAULT,
} from "../bundles/ramble/server/eggs.js";

const DAY = 86400000;
const T0 = Date.UTC(2026, 8, 9, 12, 0, 0);

async function freshDb() {
  const db = createClient({ url: ":memory:" });
  await initRambleTables(db);
  return db;
}
async function eggCount(db) {
  const { rows } = await db.execute({ sql: "SELECT count(*) AS n FROM ramble_eggs", args: [] });
  return Number(rows[0].n);
}
async function setLayDays(db, n) {
  await db.execute({ sql: "INSERT INTO ramble_settings (key, value) VALUES ('lay.days', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", args: [String(n)] });
}

test("the default is the spec's 14", async () => {
  const db = await freshDb();
  assert.equal(LAY_DAYS_DEFAULT, 14);
  assert.deepEqual(await readLaySettings(db), { layDays: 14 });
  await setLayDays(db, 10);
  assert.deepEqual(await readLaySettings(db), { layDays: 10 });
  await setLayDays(db, 0);
  assert.deepEqual(await readLaySettings(db), { layDays: 14 }, "a junk setting falls back");
});

test("hasAnyEggAnywhere counts eggs, not birds", async () => {
  const db = await freshDb();
  assert.equal(await hasAnyEggAnywhere(db), false);
  await mintIncubatingEgg(db, { now: T0 });
  assert.equal(await hasAnyEggAnywhere(db), true);

  const db2 = await freshDb();
  await db2.execute({
    sql: `INSERT INTO ramble_eggs (egg_id, status, species, seed, warmth, created_at, hatched_at)
          VALUES ('bird', 'hatched', 'wren', 7, 100, ?, ?)`, args: [T0, T0],
  });
  assert.equal(await hasAnyEggAnywhere(db2), false, "a hatched bird is not an egg you are warming");
});

test("a happy day accrues ONLY while eggless, and only once per local day", async () => {
  const db = await freshDb();
  const first = await recordHappyDay(db, { now: T0, mood: "happy" });
  assert.equal(first.recorded, true);
  assert.equal((await layProgress(db)).days, 1);

  const again = await recordHappyDay(db, { now: T0 + 3600000, mood: "happy" });
  assert.equal(again.recorded, false, "same local day");
  assert.equal((await layProgress(db)).days, 1);

  await recordHappyDay(db, { now: T0 + DAY, mood: "tired" });
  assert.equal((await layProgress(db)).days, 1, "a tired day does not count");

  await mintIncubatingEgg(db, { now: T0 + 2 * DAY });
  await recordHappyDay(db, { now: T0 + 2 * DAY, mood: "happy" });
  assert.equal((await layProgress(db)).days, 1, "with an egg in hand, nothing accrues");
});

test("days need NOT be consecutive", async () => {
  const db = await freshDb();
  await setLayDays(db, 3);
  await recordHappyDay(db, { now: T0, mood: "happy" });
  await recordHappyDay(db, { now: T0 + DAY, mood: "alarmed" });
  await recordHappyDay(db, { now: T0 + 5 * DAY, mood: "happy" });
  assert.equal((await layProgress(db)).days, 2, "one bad day did not erase the streak");
  assert.equal(await eggCount(db), 0);
});

test("at the threshold the bird lays, and the count resets", async () => {
  const db = await freshDb();
  await setLayDays(db, 3);
  await recordHappyDay(db, { now: T0, mood: "happy" });
  await recordHappyDay(db, { now: T0 + DAY, mood: "happy" });
  assert.equal(await eggCount(db), 0, "not yet");

  const out = await recordHappyDay(db, { now: T0 + 2 * DAY, mood: "happy" });
  assert.equal(out.laid, true);
  assert.equal(await eggCount(db), 1);
  const egg = await getIncubatingEgg(db);
  assert.ok(egg, "the laid egg goes straight into the empty slot");
  assert.equal(egg.warmth, 0);

  assert.equal((await layProgress(db)).days, 0, "the count reset without deleting a single row");
  const { rows } = await db.execute({ sql: "SELECT count(*) AS n FROM ramble_wallet WHERE kind = 'layday'", args: [] });
  assert.equal(Number(rows[0].n), 3, "the ledger is append-only");
});

test("after laying, the count starts again only once the player is eggless again", async () => {
  const db = await freshDb();
  await setLayDays(db, 2);
  await recordHappyDay(db, { now: T0, mood: "happy" });
  await recordHappyDay(db, { now: T0 + DAY, mood: "happy" });
  assert.equal(await eggCount(db), 1);

  await recordHappyDay(db, { now: T0 + 2 * DAY, mood: "happy" });
  assert.equal((await layProgress(db)).days, 0, "holding an egg, nothing accrues");

  await db.execute({ sql: "DELETE FROM ramble_eggs", args: [] });   // stand-in for hatching it away
  await recordHappyDay(db, { now: T0 + 3 * DAY, mood: "happy" });
  assert.equal((await layProgress(db)).days, 1, "eggless again: the counter resumes from zero");
});

test("every layday row carries delta exactly 1, whatever lay.days is set to", async () => {
  const db = await freshDb();
  await setLayDays(db, 25);
  await recordHappyDay(db, { now: T0, mood: "happy" });
  const { rows } = await db.execute({ sql: "SELECT delta FROM ramble_wallet WHERE kind = 'layday'", args: [] });
  assert.equal(Number(rows[0].delta), 1, "MAX(delta) is only convergent on a constant");
});

test("layProgress reports what the panel needs", async () => {
  const db = await freshDb();
  assert.deepEqual(await layProgress(db), { days: 0, needed: 14 });
  await recordHappyDay(db, { now: T0, mood: "happy" });
  assert.deepEqual(await layProgress(db), { days: 1, needed: 14 });
});
```

- [ ] **Step 2: Run it to watch it fail**

```bash
node scripts/run-suite.mjs tests/ramble-laying.test.js
```

Expected: FAIL — none of the laying exports exist.

- [ ] **Step 3: Implement laying in `eggs.js`**

```js
export const LAY_DAYS_DEFAULT = 14;
export const LAYDAY_KIND = "layday";
export const LAY_KIND = "lay";

function intSetting(raw, fallback, min) {
  if (raw == null) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

/** `lay.days` (>= 1, default 14), read live so balance is a config change. */
export async function readLaySettings(db) {
  return { layDays: intSetting(await readSetting(db, "lay.days"), LAY_DAYS_DEFAULT, 1) };
}

/**
 * Does the user hold an egg ANYWHERE — the slot, the shelf, or a gift not yet
 * dealt with? A hatched bird is not an egg: you are not warming it.
 */
export async function hasAnyEggAnywhere(db) {
  const { rows } = await db.execute({
    sql: `SELECT 1 FROM ramble_eggs WHERE status IN ('incubating', 'shelf', 'received') LIMIT 1`,
    args: [],
  });
  return rows.length > 0;
}

/**
 * Happy days banked since the last lay. The count RESETS without deleting a
 * row: `lay` rows mark each laying, and only `layday` rows newer than the most
 * recent one count. Both instances derive the same number from the same
 * replicated rows, and the ledger stays append-only (spec §6.1).
 */
export async function layProgress(db) {
  const { layDays } = await readLaySettings(db);
  const { rows: lastLay } = await db.execute({
    sql: `SELECT MAX(created_at) AS at FROM ramble_wallet WHERE kind = ?`, args: [LAY_KIND],
  });
  const since = Number(lastLay[0]?.at ?? 0) || 0;
  const { rows } = await db.execute({
    sql: `SELECT count(*) AS n FROM ramble_wallet WHERE kind = ? AND created_at > ?`,
    args: [LAYDAY_KIND, since],
  });
  return { days: Number(rows[0]?.n ?? 0), needed: layDays };
}

/**
 * Count today toward laying, and lay if the threshold is reached (spec §4.3).
 *
 * Called from the pet's read and feed paths, so "ends the day happy" is really
 * "was observed happy on this local day". The alternative — judging the last
 * observation of the day — would punish opening the app after a good walk.
 *
 * Accrues ONLY while the user holds no egg anywhere. Were it always accruing,
 * a player would run dry and lay at once, and the floor would become the main
 * supply instead of a backstop.
 *
 * ⚠ delta is the literal 1. See applyRambleWallet's MAX(delta) rule.
 */
export async function recordHappyDay(db, { now = Date.now(), mood, emit } = {}) {
  if (mood !== "happy") return { recorded: false, laid: false };
  if (await hasAnyEggAnywhere(db)) return { recorded: false, laid: false };

  const key = localDay(now);
  const { rowsAffected } = await db.execute({
    sql: `INSERT OR IGNORE INTO ramble_wallet (kind, key, delta, created_at) VALUES (?, ?, 1, ?)`,
    args: [LAYDAY_KIND, key, now],
  });
  if (rowsAffected === 0) return { recorded: false, laid: false };
  await safeEmit(emit, "ramble_wallet", "insert", { kind: LAYDAY_KIND, key, delta: 1, created_at: now });

  const { days, needed } = await layProgress(db);
  if (days < needed) return { recorded: true, laid: false };

  await db.execute({
    sql: `INSERT OR IGNORE INTO ramble_wallet (kind, key, delta, created_at) VALUES (?, ?, 1, ?)`,
    args: [LAY_KIND, key, now],
  });
  await safeEmit(emit, "ramble_wallet", "insert", { kind: LAY_KIND, key, delta: 1, created_at: now });
  await mintIncubatingEgg(db, { now, emit });
  return { recorded: true, laid: true };
}
```

- [ ] **Step 4: Call it from `pet.js`, after the mood is known**

`pet.js` already imports `localDay` from `eggs.js`; extend that import with `recordHappyDay`. In **`petState`**, after decay has been applied and `mood` computed, and after the decay row is persisted:

```js
  // Phase 3 (spec §4.3): a day counts when the bird is OBSERVED happy while
  // wholly eggless. Idempotent per local day, and a no-op the moment the
  // player holds any egg — so this is cheap on every poll.
  await recordHappyDay(db, { now, mood, emit });
```

And in **`feed`**, after `const mood = moodFor(energy);` and the row is written:

```js
  await recordHappyDay(db, { now, mood, emit });
```

Both call sites are needed: a player who walks (feed) and a player who only looks (petState) have both been seen that day, and `paintPet` polls `/api/ramble/pet` on a player who never posts a fix.

- [ ] **Step 5: Run the tests**

```bash
node scripts/run-suite.mjs tests/ramble-laying.test.js
node scripts/run-suite.mjs tests/ramble-pet.test.js
node scripts/run-suite.mjs tests/ramble-eggs-supply.test.js
```

Expected: all PASS. If `tests/ramble-pet.test.js` now fails on an egg count, it is because a happy fresh pet with no egg lays after `lay.days` — check the fixture's clock rather than weakening the mechanism.

- [ ] **Step 6: Commit**

```bash
git add tests/ramble-laying.test.js
git commit bundles/ramble/server/eggs.js bundles/ramble/server/pet.js tests/ramble-laying.test.js \
  -m "ramble: an eggless bird lays after sustained care"
```

---

## Task 5: the starter egg and the two prologue flags

**Files:**
- Modify: `bundles/ramble/server/eggs.js`
- Create: `tests/ramble-prologue.test.js`

**Interfaces:**
- Produces:
  - `PROLOGUE_INTRO_KEY = "prologue.intro.seen"`, `PROLOGUE_HATCH_KEY = "prologue.hatch.seen"`
  - `readPrologue(db) -> Promise<{ intro_seen, hatch_seen, granted }>`
  - `setPrologueSeen(db, which, { emit }) -> Promise<void>` — `which` is `"intro"` or `"hatch"`
  - `grantStarterEgg(db, { now, emit }) -> Promise<row|null>`
- Consumed by: `panel/routes.js` (Task 6), the panel (Task 8).

**⚠ Finding 3 applies here.** Gate on an empty egg table with a random UUID. Do **not** derive the id from `crowId` — it is per-instance, so two instances would produce two different ids and two eggs.

**⚠ K1 applies here.** The grant condition must be readable from replicated egg data alone, so that wiping the game state genuinely replays the prologue. A "starter granted" boolean that survived a wipe would silently make the reset useless.

- [ ] **Step 1: Write the failing tests**

Create `tests/ramble-prologue.test.js`:

```js
/**
 * Spec 2026-09-08 §4.4 — one starter egg, once ever, as a narrative gift.
 *
 * ⚠ The grant condition is "has any egg EVER existed", read from ramble_eggs
 * itself, NOT a flag. Kevin intends to reset his game state to a new game once
 * phases 3 and 4 land, specifically to play the prologue as a new player; a
 * flag that outlived the wipe would silently make that reset useless.
 *
 * ⚠ The spec's own race protection ("derive the id from the Crow identity")
 * cannot work: loadOrCreateIdentity generates a random per-INSTANCE seed, so
 * crowId differs between a user's own Crows and deriving from it would grant
 * TWO eggs. A random uuid plus the existing applyRambleEgg convergence rule
 * (older survives incubating, younger is shelved with its warmth) is the
 * graceful answer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import {
  grantStarterEgg, readPrologue, setPrologueSeen, getIncubatingEgg, mintIncubatingEgg,
} from "../bundles/ramble/server/eggs.js";

const T0 = Date.UTC(2026, 8, 9, 12, 0, 0);

async function freshDb() {
  const db = createClient({ url: ":memory:" });
  await initRambleTables(db);
  return db;
}
async function eggCount(db) {
  const { rows } = await db.execute({ sql: "SELECT count(*) AS n FROM ramble_eggs", args: [] });
  return Number(rows[0].n);
}

test("a fresh player is granted exactly one starter egg, into the slot", async () => {
  const db = await freshDb();
  assert.deepEqual(await readPrologue(db), { intro_seen: false, hatch_seen: false, granted: false });

  const egg = await grantStarterEgg(db, { now: T0 });
  assert.ok(egg, "granted");
  assert.equal(await eggCount(db), 1);
  assert.equal((await getIncubatingEgg(db)).egg_id, egg.egg_id);
  assert.equal(egg.warmth, 0);
  assert.equal((await readPrologue(db)).granted, true);
});

test("the grant is once EVER — a hatched bird still counts as an egg having existed", async () => {
  const db = await freshDb();
  await grantStarterEgg(db, { now: T0 });
  assert.equal(await grantStarterEgg(db, { now: T0 + 1000 }), null, "twice is a no-op");
  assert.equal(await eggCount(db), 1);

  await db.execute({ sql: "UPDATE ramble_eggs SET status = 'hatched', species = 'wren', seed = 7, hatched_at = ?", args: [T0] });
  assert.equal(await grantStarterEgg(db, { now: T0 + 2000 }), null,
    "having hatched and become eggless must NOT re-grant — that would restore the free egg");
  assert.equal(await eggCount(db), 1);
});

test("an existing player who already has an egg is never granted one", async () => {
  const db = await freshDb();
  await mintIncubatingEgg(db, { now: T0 });
  assert.equal(await grantStarterEgg(db, { now: T0 + 1000 }), null);
  assert.equal(await eggCount(db), 1);
});

test("wiping the eggs makes the prologue replayable — K1's reset", async () => {
  const db = await freshDb();
  await grantStarterEgg(db, { now: T0 });
  await setPrologueSeen(db, "intro");
  await setPrologueSeen(db, "hatch");
  assert.deepEqual(await readPrologue(db), { intro_seen: true, hatch_seen: true, granted: true });

  // A game reset clears both the eggs and the two flags.
  await db.execute({ sql: "DELETE FROM ramble_eggs", args: [] });
  await db.execute({ sql: "DELETE FROM ramble_settings WHERE key LIKE 'prologue.%'", args: [] });

  assert.deepEqual(await readPrologue(db), { intro_seen: false, hatch_seen: false, granted: false });
  assert.ok(await grantStarterEgg(db, { now: T0 + 5000 }), "the prologue genuinely replays");
});

test("the two flags are independent and survive as replicated settings", async () => {
  const db = await freshDb();
  await setPrologueSeen(db, "intro");
  assert.deepEqual(await readPrologue(db), { intro_seen: true, hatch_seen: false, granted: false });
  await setPrologueSeen(db, "hatch");
  assert.equal((await readPrologue(db)).hatch_seen, true);

  const { rows } = await db.execute({ sql: "SELECT key FROM ramble_settings WHERE key LIKE 'prologue.%' ORDER BY key", args: [] });
  assert.deepEqual(rows.map((r) => r.key), ["prologue.hatch.seen", "prologue.intro.seen"]);
});

test("setPrologueSeen refuses an unknown beat rather than writing junk", async () => {
  const db = await freshDb();
  await assert.rejects(() => setPrologueSeen(db, "nonsense"));
});
```

- [ ] **Step 2: Run it to watch it fail**

```bash
node scripts/run-suite.mjs tests/ramble-prologue.test.js
```

Expected: FAIL — the prologue exports do not exist.

- [ ] **Step 3: Implement in `eggs.js`**

```js
export const PROLOGUE_INTRO_KEY = "prologue.intro.seen";
export const PROLOGUE_HATCH_KEY = "prologue.hatch.seen";
const PROLOGUE_KEYS = { intro: PROLOGUE_INTRO_KEY, hatch: PROLOGUE_HATCH_KEY };

/**
 * Mirrors grid.js's private writeSetting rather than importing it: eggs.js has
 * no other reason to depend on grid.js, and the SQL is one statement.
 */
async function writeSetting(db, key, value, { emit } = {}) {
  await db.execute({
    sql: `INSERT INTO ramble_settings (key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    args: [key, value],
  });
  await safeEmit(emit, "ramble_settings", "update", { key, value });
}

/**
 * Has ANY egg ever existed on this fleet — including one that has since
 * hatched. Read from ramble_eggs, which replicates, so the answer is the same
 * on every one of the user's Crows and a data wipe genuinely resets it (K1).
 */
async function anyEggEverExisted(db) {
  const { rows } = await db.execute({ sql: "SELECT 1 FROM ramble_eggs LIMIT 1", args: [] });
  return rows.length > 0;
}

export async function readPrologue(db) {
  return {
    intro_seen: (await readSetting(db, PROLOGUE_INTRO_KEY)) === "1",
    hatch_seen: (await readSetting(db, PROLOGUE_HATCH_KEY)) === "1",
    granted: await anyEggEverExisted(db),
  };
}

export async function setPrologueSeen(db, which, { emit } = {}) {
  const key = PROLOGUE_KEYS[which];
  if (!key) throw new Error(`unknown prologue beat: ${which}`);
  await writeSetting(db, key, "1", { emit });
}

/**
 * One starter egg, once ever (spec §4.4, D12), granted as a narrative gift.
 *
 * ⚠ The spec says to derive the id from the Crow identity so a simultaneous
 * two-instance first run collapses into one insert. That cannot work:
 * loadOrCreateIdentity generates a RANDOM PER-INSTANCE seed, so crowId differs
 * between the user's own Crows and deriving from it would grant two eggs — the
 * outcome it was meant to prevent. A fixed constant is worse still: a contact
 * could gift you their starter egg and the ids would collide in the
 * receivedEggStatement upsert.
 *
 * So: a random uuid, gated on the egg table being empty. If a genuine race
 * ever happened, applyRambleEgg's existing "one incubating egg" rule keeps the
 * older and SHELVES the younger with its warmth intact — a spare egg, not a
 * duplicate disaster. That machinery is already built and tested.
 */
export async function grantStarterEgg(db, { now = Date.now(), emit } = {}) {
  if (await anyEggEverExisted(db)) return null;
  return mintIncubatingEgg(db, { now, emit });
}
```

- [ ] **Step 4: Run the tests**

```bash
node scripts/run-suite.mjs tests/ramble-prologue.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/ramble-prologue.test.js
git commit bundles/ramble/server/eggs.js tests/ramble-prologue.test.js \
  -m "ramble: one starter egg, once ever, and the two prologue flags"
```

---

## Task 6: the routes and the MCP tools speak the new shape

**Files:**
- Modify: `bundles/ramble/panel/routes.js`, `bundles/ramble/server/feed.js`, `bundles/ramble/server/server.js`
- Modify: `tests/ramble-panel.test.js`, `tests/ramble-tools.test.js`

**Interfaces:**
- `GET /api/ramble/egg` -> `{ egg: null | {...}, checklist: {...}, lay: { days, needed } }`
- `GET /api/ramble/pet` -> adds `pet.egg` (`null` or `{ percent, ... }`) and `pet.lay`
- `GET /api/ramble/prologue` -> `{ intro_seen, hatch_seen, granted }`
- `POST /api/ramble/prologue/intro` -> `{ egg: row|null, intro_seen: true }` — grants and flags
- `POST /api/ramble/prologue/hatch` -> `{ hatch_seen: true }`

**⚠ Both prologue POSTs must be idempotent** — the panel fires them from a dismiss button that a double-tap can send twice.

- [ ] **Step 1: Write the failing route tests**

Add to `tests/ramble-panel.test.js` (follow the file's existing harness — a scratch `CROW_DATA_DIR`, never the live db):

```js
test("GET /api/ramble/egg reports egg: null on a fresh install and mints nothing", async () => {
  const r = await get("/api/ramble/egg");
  assert.equal(r.status, 200);
  assert.equal(r.body.egg, null);
  assert.ok(r.body.checklist, "the checklist still renders");
  assert.deepEqual(r.body.lay, { days: 0, needed: 14 });
  const again = await get("/api/ramble/egg");
  assert.equal(again.body.egg, null, "reading twice did not conjure one");
});

test("GET /api/ramble/pet carries a null egg and lay progress", async () => {
  const r = await get("/api/ramble/pet");
  assert.equal(r.status, 200);
  assert.equal(r.body.egg, null);
  assert.ok(r.body.lay, "the pet page needs the count for the eggless card");
});

test("POST /api/ramble/prologue/intro grants once and is idempotent", async () => {
  const first = await post("/api/ramble/prologue/intro", {});
  assert.equal(first.status, 200);
  assert.ok(first.body.egg, "the starter egg arrives with the first beat");
  assert.equal(first.body.intro_seen, true);

  const second = await post("/api/ramble/prologue/intro", {});
  assert.equal(second.status, 200);
  assert.equal(second.body.egg, null, "a double-tap grants nothing further");

  const state = await get("/api/ramble/prologue");
  assert.equal(state.body.intro_seen, true);
  assert.equal(state.body.granted, true);

  const egg = await get("/api/ramble/egg");
  assert.ok(egg.body.egg, "and the egg view now has something to show");
});

test("POST /api/ramble/prologue/hatch flags the second beat and is idempotent", async () => {
  assert.equal((await post("/api/ramble/prologue/hatch", {})).status, 200);
  assert.equal((await post("/api/ramble/prologue/hatch", {})).status, 200);
  assert.equal((await get("/api/ramble/prologue")).body.hatch_seen, true);
});
```

- [ ] **Step 2: Run it to watch it fail**

```bash
node scripts/run-suite.mjs tests/ramble-panel.test.js
```

Expected: FAIL — the prologue routes 404 and `lay` is absent.

- [ ] **Step 3: Load the new module surface and add the routes**

In `bundles/ramble/panel/routes.js`, wherever `mods.eggsMod` is assembled, make sure `layProgress`, `readPrologue`, `setPrologueSeen`, `grantStarterEgg` and `promoteFromShelf` are reachable. Then extend the egg route and add the prologue routes:

```js
  router.get("/api/ramble/egg", handle(async (req, res) => {
    // A slot can empty from a sync arrival no local path observed; this moves
    // an egg the user already owns and writes nothing when there is none.
    await mods.eggsMod.promoteFromShelf(db, { now: Date.now(), emit });
    const state = await mods.eggsMod.eggState(db, { now: Date.now() });
    const lay = await mods.eggsMod.layProgress(db);
    res.json({ ...state, lay });
  }));

  router.get("/api/ramble/prologue", handle(async (req, res) => {
    res.json(await mods.eggsMod.readPrologue(db));
  }));

  router.post("/api/ramble/prologue/intro", handle(async (req, res) => {
    const egg = await mods.eggsMod.grantStarterEgg(db, { now: Date.now(), emit });
    await mods.eggsMod.setPrologueSeen(db, "intro", { emit });
    res.json({ egg: egg ? { egg_id: egg.egg_id, warmth: egg.warmth } : null, intro_seen: true });
  }));

  router.post("/api/ramble/prologue/hatch", handle(async (req, res) => {
    await mods.eggsMod.setPrologueSeen(db, "hatch", { emit });
    res.json({ hatch_seen: true });
  }));
```

Keep the existing `GET /api/ramble/egg` handler's other behaviour (auth, error handling) exactly as it was — copy the surrounding shape from the file rather than the sketch above.

- [ ] **Step 4: Carry the egg summary and lay progress on the pet read**

In `bundles/ramble/server/feed.js`, `readPet` already returns the pet row shape the panel uses. Extend it so the pet response carries a **nullable** egg summary and the lay count — `paintPet` reads `pet.egg.percent` today and must not throw on `null`:

```js
  const eggSummary = await eggState(db, { now });
  const lay = await layProgress(db);
  return {
    ...pet,
    // null when the player is genuinely eggless. paintPet must not assume one.
    egg: eggSummary.egg ? { ...eggSummary.egg } : null,
    lay,
  };
```

Import `eggState` and `layProgress` from `./eggs.js` in `feed.js`.

- [ ] **Step 5: Keep the MCP tools in step with the HTTP routes**

In `bundles/ramble/server/server.js`, the `ramble_egg_state` and `ramble_pet_state` tools call the same functions. They pick up `egg: null` and `lay` for free from the spread — **verify that by reading the code**, and if either tool destructures `egg` or assumes it, fix it there. A tool and a route that disagree about the same egg is the defect phase 2 caught late.

- [ ] **Step 6: Run the tests**

```bash
node scripts/run-suite.mjs tests/ramble-panel.test.js
node scripts/run-suite.mjs tests/ramble-tools.test.js
```

Expected: both PASS.

- [ ] **Step 7: Commit**

```bash
git commit bundles/ramble/panel/routes.js bundles/ramble/server/feed.js bundles/ramble/server/server.js \
  tests/ramble-panel.test.js tests/ramble-tools.test.js \
  -m "ramble: the routes answer for a player with no egg"
```

---

## Task 7: the five eggless surfaces

**Files:**
- Modify: `bundles/ramble/panel/ramble.js`, `bundles/ramble/panel/static/ramble.js`, `bundles/ramble/panel/static/ramble.css`
- Modify: `tests/ramble-panel.test.js`

**⚠ Finding 2 governs this task.** The **Next egg card must never be hidden** — it is the only route to the egg view and its daily check-in once a bird exists. It changes state.

**Copy, under K5 ("the next you"):**

| Surface | With an egg | With none |
|---|---|---|
| Egg view line | unchanged | "No one on the way just now." |
| Egg view sub-line | unchanged | "Nests hold them. So do friends." |
| Next egg card | percent + ring | "Nothing warming just now." + the lay line |
| Lay line, 0 days | — | "Keep yourself happy and you'll manage one yourself, in time." |
| Lay line, N days | — | "You've had N good days — keep it up and you'll manage one yourself." |
| Perch status line | "Your egg is N% warm." | omit the sentence entirely |
| AR view | egg art | the egg element hidden |

- [ ] **Step 1: Write the failing panel-source tests**

Add to `tests/ramble-panel.test.js`:

```js
test("the Next egg card is never hidden — it is the only route to the check-in", () => {
  const src = readFileSync("bundles/ramble/panel/static/ramble.js", "utf8");
  assert.ok(!/setHidden\(\s*\$\("rb-pet-nextegg"\)/.test(src),
    "hiding it would delete the daily check-in for an eggless player (phase 1's defect)");
  assert.ok(src.includes("rb-nextegg-empty"), "it changes state instead");
});

test("the eggless copy is present and written from inside the premise", () => {
  const src = readFileSync("bundles/ramble/panel/static/ramble.js", "utf8");
  assert.ok(src.includes("No one on the way just now."));
  assert.ok(src.includes("Nothing warming just now."));
  assert.ok(src.includes("good days"), "K4: the soft count is named");
});

test("the AR view hides the egg rather than drawing a phantom seed-0 one", () => {
  const src = readFileSync("bundles/ramble/panel/static/ramble.js", "utf8");
  const ar = src.slice(src.indexOf("function startAr()"), src.indexOf("function closeAr()"));
  assert.ok(/setHidden\(\s*\$\("rb-ar-egg"\)/.test(ar),
    "seedFromEggId(null) is 0, so an unguarded draw shows an egg that does not exist");
});

test("the panel client still obeys its rules", () => {
  const src = readFileSync("bundles/ramble/panel/static/ramble.js", "utf8");
  assert.equal((src.match(/`/g) || []).length, 0, "ZERO backticks: one truncates the served script");
  assert.equal((src.match(/innerHTML/g) || []).length, 2, "EXACTLY two markup sinks");
});
```

- [ ] **Step 2: Run it to watch it fail**

```bash
node scripts/run-suite.mjs tests/ramble-panel.test.js
```

Expected: FAIL on the eggless-copy and AR assertions.

- [ ] **Step 3: Add the eggless markup to the server-rendered shell**

New *markup* goes in `bundles/ramble/panel/ramble.js`, not the client — that is how the sink count stays at two. Inside `#rb-pet-nextegg`, after the existing `.rb-row`, add:

```html
            <p class="rb-muted rb-fine" id="rb-nextegg-empty" hidden>Nothing warming just now.</p>
            <p class="rb-muted rb-fine" id="rb-nextegg-lay" hidden></p>
```

And on the egg view, after `#rb-egg-line`, add:

```html
            <p class="rb-muted rb-fine" id="rb-egg-empty" hidden>Nests hold them. So do friends.</p>
```

- [ ] **Step 4: Make the painters null-tolerant**

In `bundles/ramble/panel/static/ramble.js`, `paintEgg`:

```js
  function paintEgg(state) {
    if (!state || hatchLock) return;
    var egg = state.egg;                      /* NULL when genuinely eggless */
    var list = state.checklist || {};

    var has = !!egg;
    eggPercent = has && typeof egg.percent === "number" ? egg.percent : 0;
    eggSeedId = has ? egg.egg_id : null;

    setRing($("rb-egg-ring"), eggPercent);
    setText($("rb-egg-percent"), has ? Math.round(eggPercent) + "%" : "—");
    setText($("rb-egg-line"), has
      ? "warmth " + (egg.warmth || 0) + " of " + (egg.hatch_at || 0) +
        " · it warms every time you get somewhere new"
      : "No one on the way just now.");
    setHidden($("rb-egg-empty"), has);

    var art = $("rb-egg-art");
    if (art) { setHidden(art, !has); if (has) drawEggArt(art, egg.egg_id); }
    /* ...the rest of the function is unchanged... */
  }
```

`paintPet`, replacing the Next egg block:

```js
    /* The next you, and the ONLY route back to the egg view (and its daily
     * check-in) once the perch belongs to a hatched bird. It changes state
     * when there is no egg; it is never hidden. */
    var nextEgg = pet.egg || null;
    var hasNext = !!nextEgg;
    var nextPct = hasNext && typeof nextEgg.percent === "number" ? nextEgg.percent : 0;
    if (hasNext) { eggPercent = nextPct; eggSeedId = nextEgg.egg_id; }
    else { eggPercent = 0; eggSeedId = null; }

    setRing($("rb-nextegg-ring"), nextPct);
    setText($("rb-nextegg-percent"), hasNext ? Math.round(nextPct) + "%" : "—");
    var nextArt = $("rb-nextegg-art");
    if (nextArt) { setHidden(nextArt, !hasNext); if (hasNext) drawEggArt(nextArt, nextEgg.egg_id); }
    setHidden($("rb-nextegg-empty"), hasNext);

    var lay = pet.lay || null;
    var layEl = $("rb-nextegg-lay");
    if (layEl) {
      setHidden(layEl, hasNext || !lay);
      if (!hasNext && lay) {
        setText(layEl, lay.days > 0
          ? "You've had " + lay.days + " good " + (lay.days === 1 ? "day" : "days") +
            " — keep it up and you'll manage one yourself."
          : "Keep yourself happy and you'll manage one yourself, in time.");
      }
    }
```

`statusLine`, dropping the warmth sentence when there is nothing to warm:

```js
    if (perchTarget === "egg") {
      /* No egg at all: say nothing about warmth rather than claiming 0%. */
      line = eggSeedId ? "Your egg is " + Math.round(eggPercent) + "% warm." : "Quiet around here right now.";
    } else if (lastMarks.length === 0) {
```

`startAr`, guarding the draw:

```js
    /* seedFromEggId(null) is 0, so an unguarded call draws a phantom egg that
     * does not exist. Hide the element instead. */
    var arEgg = $("rb-ar-egg");
    setHidden(arEgg, !eggSeedId);
    if (eggSeedId) drawEggArt(arEgg, eggSeedId);
```

The framing fix (K5), in `paintHereArt` and `paintPerchGo`:

```js
      el.setAttribute("aria-label", "You");        /* was "You, and your bird" / "You, and your egg" */
```
```js
    go.textContent = "You";                        /* was "Your bird" / "Your egg" */
```

- [ ] **Step 5: Style the eggless card**

Append to `bundles/ramble/panel/static/ramble.css` — follow the file's existing token usage; do not invent variables:

```css
#rb-nextegg-empty,
#rb-nextegg-lay,
#rb-egg-empty { margin-top: 6px; }
```

- [ ] **Step 6: Run the tests**

```bash
node scripts/run-suite.mjs tests/ramble-panel.test.js
```

Expected: PASS, including the zero-backticks and exactly-two-sinks assertions.

- [ ] **Step 7: Commit**

```bash
git commit bundles/ramble/panel/ramble.js bundles/ramble/panel/static/ramble.js \
  bundles/ramble/panel/static/ramble.css tests/ramble-panel.test.js \
  -m "ramble: the panel answers for a player with no egg"
```

---

## Task 8: the prologue

**Files:**
- Modify: `bundles/ramble/panel/ramble.js`, `bundles/ramble/panel/static/ramble.js`, `bundles/ramble/panel/static/ramble.css`
- Modify: `tests/ramble-panel.test.js`

**The copy, approved 2026-09-09.** Written from inside the premise (K5): you ARE the egg. Match the panel's register — plain, warm, slightly hushed. **The writing is a deliverable, not decoration (§4.4).** Use they/them for the bird, as the rest of the panel does.

**Beat one** — shown when `intro_seen` is false AND `granted` is false:

> You are an egg.
>
> You wandered off from your nest. Nobody is coming to look for you — that's alright. It happens more than you'd think.
>
> Nobody knows what's inside you yet. Not even you.
>
> Go somewhere. That's how eggs get warm.

Button: **Go**

**Beat two** — shown when a hatch has just been revealed AND `hatch_seen` is false:

> You're out. A {species} — the only one rolled quite like you.
>
> You live on what you do: new streets, new faces, the small daily things. Keep moving and you stay bright. Go still long enough and you droop.
>
> That's all that happens. Nothing here is ever lost.

Button: **Have a look at yourself**

The last line is load-bearing: it states D2's no-fail-state promise in the game's own voice, which is the one thing a new player most needs told and which otherwise lives only in a guide doc.

- [ ] **Step 1: Write the failing tests**

Add to `tests/ramble-panel.test.js`:

```js
test("both prologue beats are present, in the game's voice", () => {
  const shell = readFileSync("bundles/ramble/panel/ramble.js", "utf8");
  assert.ok(shell.includes("You are an egg."));
  assert.ok(shell.includes("wandered off from your nest"));
  assert.ok(shell.includes("Nobody knows what&rsquo;s inside you yet") ||
            shell.includes("Nobody knows what's inside you yet"));
  assert.ok(shell.includes("Nothing here is ever lost."),
    "the no-fail-state promise lives in the game, not only in the docs");
  assert.ok(shell.includes("rb-prologue"), "the overlay exists in the server-rendered shell");
});

test("the prologue is skippable and both beats dismiss", () => {
  const src = readFileSync("bundles/ramble/panel/static/ramble.js", "utf8");
  assert.ok(src.includes("/api/ramble/prologue/intro"));
  assert.ok(src.includes("/api/ramble/prologue/hatch"));
});
```

- [ ] **Step 2: Run it to watch it fail**

```bash
node scripts/run-suite.mjs tests/ramble-panel.test.js
```

Expected: FAIL — no prologue markup.

- [ ] **Step 3: Add the overlay to the shell**

In `bundles/ramble/panel/ramble.js`, near the other overlays, add — note `&rsquo;` for apostrophes, matching the file's existing entity style, and no emoji:

```html
        <!-- ─────────────────────────────────────────────── the prologue -->
        <!-- Ramble's first narrative content (spec §4.4). Written from inside
             the premise: you ARE the egg. Skippable; both beats set a flag
             that replicates, and a game-state wipe clears them so the
             prologue genuinely replays. -->
        <div class="rb-prologue" id="rb-prologue" hidden>
          <div class="rb-prologue-card">
            <div id="rb-prologue-intro" hidden>
              <p class="rb-prologue-lead">You are an egg.</p>
              <p>You wandered off from your nest. Nobody is coming to look for you &mdash; that&rsquo;s alright. It happens more than you&rsquo;d think.</p>
              <p>Nobody knows what&rsquo;s inside you yet. Not even you.</p>
              <p>Go somewhere. That&rsquo;s how eggs get warm.</p>
              <button class="rb-btn" id="rb-prologue-go" type="button">Go</button>
            </div>
            <div id="rb-prologue-hatch" hidden>
              <p class="rb-prologue-lead" id="rb-prologue-hatch-lead">You&rsquo;re out.</p>
              <p>You live on what you do: new streets, new faces, the small daily things. Keep moving and you stay bright. Go still long enough and you droop.</p>
              <p>That&rsquo;s all that happens. Nothing here is ever lost.</p>
              <button class="rb-btn" id="rb-prologue-seen" type="button">Have a look at yourself</button>
            </div>
          </div>
        </div>
```

- [ ] **Step 4: Wire it in the client**

In `bundles/ramble/panel/static/ramble.js` — `textContent` only, no backticks:

```js
  /* ------------------------------------------------------------ prologue */

  function showPrologue(which) {
    var root = $("rb-prologue");
    if (!root) return;
    setHidden($("rb-prologue-intro"), which !== "intro");
    setHidden($("rb-prologue-hatch"), which !== "hatch");
    setHidden(root, false);
  }

  function hidePrologue() { setHidden($("rb-prologue"), true); }

  /* Beat one is for a player who has never had an egg at all. Both the button
   * and a dismissal grant it, so skipping the words never costs the egg. */
  function maybeIntro() {
    return jsonFetch("/api/ramble/prologue").then(function (p) {
      if (p && !p.intro_seen && !p.granted) showPrologue("intro");
    }).catch(function () { /* the prologue is never load-bearing */ });
  }

  var goBtn = $("rb-prologue-go");
  if (goBtn) goBtn.addEventListener("click", function () {
    hidePrologue();
    jsonFetch("/api/ramble/prologue/intro", { method: "POST", body: {} })
      .then(function () { refreshEgg(); refreshPet(); })
      .catch(function () { /* the next load retries */ });
  });

  /* Beat two rides the existing hatch reveal: the bird is already on screen,
   * so this names what just happened rather than interrupting it. */
  function maybeHatchBeat(bird) {
    jsonFetch("/api/ramble/prologue").then(function (p) {
      if (!p || p.hatch_seen) return;
      var lead = $("rb-prologue-hatch-lead");
      if (lead && bird && bird.species) {
        setText(lead, "You're out. A " + bird.species + " — the only one rolled quite like you.");
      }
      showPrologue("hatch");
    }).catch(function () { /* cosmetic */ });
  }

  var seenBtn = $("rb-prologue-seen");
  if (seenBtn) seenBtn.addEventListener("click", function () {
    hidePrologue();
    jsonFetch("/api/ramble/prologue/hatch", { method: "POST", body: {} })
      .then(function () { showView("pet"); })
      .catch(function () { /* the next load retries */ });
  });
```

Call `maybeIntro()` once from the panel's existing start-up sequence, beside the other first-load fetches. Call `maybeHatchBeat(hatched)` from wherever the hatch reveal is dismissed, passing the hatched bird — grep for `hatchLock` to find that path and hook the existing dismissal rather than adding a second one.

- [ ] **Step 5: Style the overlay**

Append to `ramble.css`, reusing the tokens the panel's other overlays use — read one and copy its variables rather than inventing any:

```css
.rb-prologue { position: fixed; inset: 0; z-index: 60; display: grid; place-items: center;
  background: rgba(0, 0, 0, 0.55); padding: 24px; }
.rb-prologue-card { max-width: 30rem; border-radius: 14px; padding: 22px 20px;
  background: var(--rb-card); color: var(--rb-fg); box-shadow: 0 10px 40px rgba(0, 0, 0, 0.35); }
.rb-prologue-card p { margin: 0 0 12px; line-height: 1.5; }
.rb-prologue-lead { font-size: 1.15rem; font-weight: 600; }
@media (prefers-reduced-motion: no-preference) {
  .rb-prologue { animation: rb-fade-in 240ms ease-out; }
}
```

If `--rb-card` / `--rb-fg` / `rb-fade-in` do not exist in the file, substitute the real token and keyframe names it already defines. **Check before writing.**

- [ ] **Step 6: Run the tests**

```bash
node scripts/run-suite.mjs tests/ramble-panel.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git commit bundles/ramble/panel/ramble.js bundles/ramble/panel/static/ramble.js \
  bundles/ramble/panel/static/ramble.css tests/ramble-panel.test.js \
  -m "ramble: the prologue, in the game's own voice"
```

---

## Task 9: the docs, the version and the registry

**Files:**
- Modify: `docs/guide/ramble.md`, `docs/es/guide/ramble.md`, `bundles/ramble/manifest.json`, `bundles/ramble/package.json`, `registry/add-ons.json`

- [ ] **Step 1: Rewrite the guide's egg section**

`docs/guide/ramble.md` opens its egg section with **"Every instance always has one egg incubating."** That is exactly what this phase makes false. Replace that paragraph with the new supply, and add the settings row:

```markdown
## Your egg and your bird

You are the egg. Real-world activity credits **warmth** toward it; at the hatch threshold you hatch
into a bird, and the incubating egg after that is the **next you**.

Eggs come from three places, and none of them is free:

- **Nests** — walk to one on the map, one claim per local day, within 75 m.
- **Gifts and swaps** from contacts.
- **Laying** — while you hold no egg at all, every local day you end happy counts one. At
  `lay.days` (default 14) you lay one yourself. Days need not be consecutive, and the count only
  runs while you are eggless, so this is a floor rather than a faucet.

When the incubating slot empties, the oldest egg on your shelf is promoted into it automatically —
so you are only ever eggless when you genuinely have none. **Warmth earned with no egg at all
vanishes**; that is deliberate, and auto-promote is what keeps it rare.

| Setting | Default | Governs |
|---|---|---|
| `lay.days` | 14 | Happy days while eggless before you lay one yourself |
```

- [ ] **Step 2: Mirror it in Spanish, by hand**

**⚠ There is NO CI gate for guide-doc i18n parity** — `tests/i18n-global-parity.test.js` covers the translation-key mechanism only, and nothing diffs `docs/guide/` against `docs/es/guide/`. Phase 2's plan wrongly claimed otherwise and parity had to be done by hand. Update `docs/es/guide/ramble.md` to match, then verify by eye:

```bash
diff <(grep -c '^' docs/guide/ramble.md) <(grep -c '^' docs/es/guide/ramble.md) || true
grep -n "lay.days" docs/guide/ramble.md docs/es/guide/ramble.md
```

Both files must mention `lay.days`, and neither may still claim an egg always exists.

- [ ] **Step 3: Bump the version in BOTH files and rebuild the registry**

```bash
export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH
cd /home/kh0pp/crow-wt-ramble-eggs
sed -i 's/"version": "0\.10\.0"/"version": "0.11.0"/' bundles/ramble/manifest.json bundles/ramble/package.json
grep -n '"version"' bundles/ramble/manifest.json bundles/ramble/package.json
npm run build-registry
git diff --stat registry/add-ons.json
```

Both must read `0.11.0`. **Without the bump `repairInstalledBundleAssets` never refreshes grackle's installed copy and the deploy silently ships nothing.**

- [ ] **Step 4: Commit**

```bash
git commit docs/guide/ramble.md docs/es/guide/ramble.md \
  bundles/ramble/manifest.json bundles/ramble/package.json registry/add-ons.json \
  -m "ramble 0.11.0: eggs are earned"
```

---

## Final verification

- [ ] **The whole suite, in the foreground**

```bash
export PATH=/home/kh0pp/.nvm/versions/node/v22.23.1/bin:$PATH
cd /home/kh0pp/crow-wt-ramble-eggs
npm test 2>&1 | tail -25
```

Expected: **4340 + the new tests**, 0 fail. A drop below 4340 means something was deleted, not fixed. **If the run reports ~552 failures, `node_modules` is missing** — re-create the symlink; it is not a regression.

- [ ] **Confirm no schema change slipped in**

```bash
git diff origin/main --stat -- scripts/init-db.js servers/sharing/instance-sync.js \
  servers/shared/sync-stamp.js servers/sharing/profile-avatar.js
```

Expected: **empty**. And for `init-tables.js`, prove the change was comment-only:

```bash
git diff origin/main bundles/ramble/server/init-tables.js | grep -E "^[+-]" | grep -viE "^[+-]\s*(//|\*|/\*)" | grep -v "^[+-][+-]"
```

Expected: **no output**. If either check fails the design drifted; stop before going near a database. If both are clean, `scripts/schema-migration-dryrun.sh` has nothing to say — note that in the PR rather than skipping it silently.

- [ ] **Confirm nothing mints an egg by accident any more**

```bash
grep -rn "mintIncubatingEgg" bundles/ | grep -v node_modules
```

Expected: the definition, plus **exactly two** call sites — `grantStarterEgg` and `recordHappyDay`, both in `eggs.js`. Any third caller is the bug this phase exists to remove.

- [ ] **Confirm the panel client rules held**

```bash
grep -c '`' bundles/ramble/panel/static/ramble.js    # must print 0
grep -c 'innerHTML' bundles/ramble/panel/static/ramble.js
git show origin/main:bundles/ramble/panel/static/ramble.js | grep -c innerHTML
```

Zero backticks; the two `innerHTML` counts must match.

- [ ] **Whole-branch adversarial review — NOT OPTIONAL**

Dispatch a **fresh** reviewer over the entire branch diff against `origin/main`, not per-task. In phase 1 this gate caught three blocking defects that eight per-task reviews and four plan-review rounds all missed. **Do not hand the reviewer this plan's code as ground truth** — when a plan carries complete code, the per-task reviews are checking the plan, so this is the only independent check. Point it at the diff and the spec. Direct it at exactly this class:

1. **What did we remove that was carrying something else?** The auto-minted egg was carrying the Next egg card, the perch's status line, the AR egg, and the egg view's daily check-in. Enumerate every affordance, not just the ones this plan named. Is the check-in still reachable for an eggless player who denies geolocation?
2. **Is there any path that still mints an egg implicitly?** Including sync applies, gift/trade receipt, and the MCP tools.
3. **Does anything converge wrongly across the user's own instances?** Auto-promote must pick the same egg on both with no round trip; every `layday` row must be `delta = 1`; nothing may write a negative delta.
4. **Can a player get permanently stuck with no egg and no route to one?** Walk the eggless state end to end: energy still arrives, happy days accrue, laying fires, the panel says what is happening.
5. **What does a player mid-flight see?** grackle has a live auto-minted egg and a live pet row. Nothing may be blank, wrong, or retroactively punishing.
6. **Is any egg, lay-day or balance now reachable by a contact?**

Fix everything it finds ON THE BRANCH before opening the PR. **Re-review every fix round** — three of phase 2's round-2 findings were in code written to fix round 1.

- [ ] **Open the PR**

`gh` is not installed. Use the `github` MCP server. The body must state, at minimum:
- Phase 3 of the reward-economy spec — **the risky phase**, and why the four parts ship together.
- **No schema change, no migration, no `SCHEMA_GENERATION` bump** — laying rides `ramble_wallet`, prologue flags ride `ramble_settings`.
- **Finding 1**: `feedAll` gates the pet feed on `credited`, so warmth and energy had to be decoupled or laying would be unreachable.
- **Finding 3 / Deviation 1**: the spec's starter-egg race protection is impossible because `crowId` is per-instance; a random uuid plus the existing convergence rule replaces it.
- **Deviation 3**: auto-promote runs on read paths, and why that is not the same defect as auto-minting.
- **K1**: the grant is derived from replicated egg data so a game-state reset replays the prologue.
- **K5**: all copy is written from "you ARE the egg; the incubating egg is the next you".
- Ramble is installed on **grackle only** — crow primary and r4 have no Ramble bundle.

- [ ] **Wait for CI green before merging**

```bash
curl -s https://api.github.com/repos/kh0pper/crow/commits/<sha>/check-runs \
  | python3 -c "import json,sys; [print(r['name'], r['status'], r['conclusion']) for r in json.load(sys.stdin)['check_runs']]"
```

Every run must be `completed` / `success`. Contexts: `suite`, `static-checks`, `audit`. An **empty** result on a current sha means something is wrong, not that the run is clean.

- [ ] **Deploy**

1. **Read `/home/kh0pp/CROW-SCHEDULE.md` first.** Note the Wednesday GPU benchmark chain holds crow 17:00 → 06:55; this deploy targets **grackle** and starts no model, so it does not conflict — but re-read rather than trusting this line.
2. Ramble is installed on **grackle only**. crow primary auto-restarts on the `~/crow` HEAD change and has nothing Ramble-shaped to pick up; r4 needs no action.
3. On grackle, resolve the database before touching it — **it is `~/crow/data/crow.db`, NOT `~/.crow/crow.db`** (that file is 0 bytes); bundles still install under `~/.crow/bundles/`:
   ```bash
   sudo lsof -p $(pgrep -f 'servers/gateway') | grep '\.db'
   ```
4. Back it up, then restart the gateway.
5. Verify after the restart:
   - the installed copy refreshed `0.10.0` -> `0.11.0` and `server/egg-locks.js` is present,
   - `SELECT status, count(*) FROM ramble_eggs GROUP BY status` — the live incubating egg is still there (K1: grandfathered, untouched),
   - `SELECT count(*) FROM ramble_wallet WHERE kind IN ('layday','lay')` — expect 0,
   - `SELECT count(*) FROM ramble_cells` — expect the existing 27, unchanged,
   - `PRAGMA integrity_check` is ok,
   - the journal shows `[proxy] addon ramble: connected` with no Ramble errors.
6. Clear the schedule entry if one was registered.

- [ ] **Hand back to Kevin**

Say plainly: what shipped; that his current egg is grandfathered and will be the last one that arrives on its own; that after it hatches the slot stays empty unless the shelf has one; what the eggless card will say; that the prologue will not fire for him until the game-state reset, and what that reset needs to clear (`ramble_eggs` and the two `prologue.%` settings rows); the phone smoke test still outstanding from phase 2 (walk to one of the 14 heart pips); and anything the whole-branch review found.

---

## Out of scope — do not build these here

- The **game-state reset** itself. Kevin wants it "once these phases are complete" (after phase 4), and no reset affordance exists in Ramble today. This phase only guarantees a reset would *work* — the grant reads replicated egg data and the flags are ordinary settings rows.
- A shop, a wardrobe, an accessory catalogue, or any spend path (phase 4).
- The **pedometer / steps arc** (queued after phase 4, 2026-09-09). It would add an energy source and therefore make happy days easier, retuning this phase's floor — `lay.days` is a live setting, so that is a config change, not a redesign.
- D2's sad portrait to contacts, and any change to `servers/sharing/profile-avatar.js`.
- Sweeping the pet page's leftover keeper framing ("Still an egg", "My bird", the chore card). This phase fixes the framing only on surfaces it already rewrites; the rest is a copy pass of its own.
- Fixing phase 1 and 2's known follow-ups: `unlockedCellsNear`'s full-table read, the seed cooldown's global UTC bucket, the AR view carrying no hearts or seed, `.rb-mapbar` wrapping on a phone. None is made worse by this phase.
