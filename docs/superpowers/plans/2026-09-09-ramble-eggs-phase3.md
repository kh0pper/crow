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
| K6 | Review proved the floor is unreachable without walking (decay −40/day vs. a maximum of 29/day from check-in + chores, so 3 banked days and then permanently below the 60 threshold). Retune? | **No — leave it. Laying requires walking.** The point of the game is to go outside, so a floor that still needs movement is on-theme; the housebound player keeps earning seed and hearts. Do not touch decay, chore values, or `lay.days`. **The queued pedometer arc (after phase 4) is the proper fix** — steps feed energy indoors, which is exactly the missing input, so bending the decay curve now would only have to be undone. Say this plainly in the hand-back rather than letting it read as an oversight. |
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
- **⚠ A player CAN be simultaneously birdless and eggless, and it is the most important state in the phase.** An earlier draft of this plan asserted the opposite. It is false: a brand-new player between first load and tapping the prologue's **Go** button has neither, and so does anyone whose `POST /api/ramble/prologue/intro` failed. That window *is* the new-player experience this phase exists to build. Every surface must render it without a phantom egg (see Task 7's `hereArt` and AR fixes) and without a crash.
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
3. **A two-instance fleet can lay two eggs from one lay, and that is accepted.** Both instances eggless, both observing the same happy days, both crossing the threshold before a sync: each writes the same `lay:<local day>` key locally (so `rowsAffected` is 1 on both) and each mints an egg with its own UUID. `applyRambleEgg` then shelves one, so the user ends with one incubating and one spare on the shelf. Making this impossible would need a deterministic egg id derived from the lay day — which reintroduces exactly the cross-user collision that rules a constant id out for the starter egg (a contact who laid on the same date could gift you a colliding row). **Ramble is installed on grackle only**, so this is currently unreachable; the graceful degradation is the existing convergence rule, and the cost of the alternative is a real collision for a hypothetical one. Revisit if a second instance ever installs the bundle.
4. **Auto-promote runs ONLY on hatch — the read paths deliberately do not promote.** Spec §4.2 says "when the incubating slot empties" without saying who notices, and two drafts of this plan had the read paths notice. Both were wrong: a write during a GET races `applyRambleEgg`'s `isUserShelve` carve-out (`instance-sync.js:855-860`), and the attempted mitigation (marking such a promote `'sync'`) launders provenance that `flock.js:126`'s nest shelf cap, `flock.js:253`'s `shelf_count`, `RAMBLE_EGG_REPROMOTE_SQL` and `static/ramble.js:1776` all read. The read-path promote is therefore deleted, and `hatchIfReady` is the only promoter. A draft also promoted from `trades.js`'s closing paths; that was reverted because promoting inside `expireTrades` strands an in-flight `completed` envelope and leaves the user holding **both** eggs — a free-egg race, in the phase built to remove the free egg. What remains uncovered is a gift or a freed swap egg landing while the slot is empty, and that is answered by an **affordance** rather than a promote: the Next-egg card says one is waiting and incubates it in a tap (Task 7). The player's real complaint was never "the slot is empty" — it was having no signal and no way back.

---

## File structure

**Create**
- `bundles/ramble/server/egg-locks.js` — `OPEN_SQL`, `isEggLocked`, `lockedEggIds`, moved verbatim from `trades.js`. A leaf module with no imports. **Why it exists:** auto-promote must skip an egg named by an open swap, but `trades.js` imports `startOfLocalDay` from `eggs.js`, so `eggs.js` cannot import `trades.js` without a cycle.
- `tests/ramble-eggs-supply.test.js` — null tolerance, the feed decoupling, auto-promote, convergence.
- `tests/ramble-laying.test.js` — the lay-day ledger and the floor.
- `tests/ramble-prologue.test.js` — the starter grant and the two flags.
- `tests/ramble-prologue-routes.test.js` — the prologue routes, on their own virgin-db harness (Task 6).

**Modify**
- `bundles/ramble/server/trades.js` — import the three lock symbols from `egg-locks.js` and re-export `isEggLocked`/`lockedEggIds` so existing consumers are untouched. **Task 1 only** — no other task edits this file.
- `bundles/ramble/server/eggs.js` — the bulk: rename, null tolerance, promote, laying, starter grant, prologue flags.
- `bundles/ramble/server/flock.js` — drop the mint from `flockState`; import the locks from the leaf.
- `bundles/ramble/server/pet.js` — call the lay-day recorder after mood is known.
- `bundles/ramble/panel/static/ramble-ar.js` — the AR renderer must not draw a phantom egg (Task 7); `tests/ramble-ar.test.js` extended alongside it. **`bundles/ramble/server/feed.js` is NOT modified** — an early draft had `readPet` carry the egg summary; see Task 6 Step 4 for why that is wrong.
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
 * helpers, so its existing importers (flock.js:22 and tests/ramble-trades
 * .test.js:14 — NOT panel/routes.js, which never imported them) are
 * unchanged and there is still exactly one definition of "locked".
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

// Re-exported so its existing importers (flock.js:22 and
// tests/ramble-trades.test.js:14 — NOT panel/routes.js, which never imported
// them) need no change
// and there is still one definition of "locked".
export { isEggLocked, lockedEggIds };
```

**⚠ `panel/routes.js` does NOT import the lock helpers** — `flock.js:22` and `tests/ramble-trades.test.js:14` are the only importers. Do not write otherwise into the comment.

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
- **Modify (import rename — REQUIRED IN THIS TASK):** `bundles/ramble/server/flock.js`
- Modify (import rename only): `tests/ramble-flock.test.js`, `tests/ramble-trades.test.js`, `tests/ramble-sync.test.js`

**⚠ `flock.js` MUST be renamed here, not in Task 3.** `flock.js:20` imports `ensureIncubatingEgg` **by name** and calls it at `:225`. Renaming the export without touching `flock.js` is a module-load `SyntaxError: does not provide an export named` — which takes down `ramble-flock`, `ramble-panel` (routes → flock) and `ramble-tools` (server.js → flock), i.e. three of the five suites this task's Step 7 requires green. Rename both the import and the call site now; Task 3 Step 5 then deletes the call.
- **Modify (these go RED at THIS task, because `eggState` stops minting):** `tests/ramble-eggs.test.js`, `tests/ramble-panel.test.js`, `tests/ramble-tools.test.js`

**⚠ The nullable egg breaks assertions here, in Task 2 — not in Task 3.** An earlier draft attributed all of them to Task 3 and listed only some. `POST /api/ramble/area` and `GET /api/ramble/egg` no longer mint, so every one of these dereferences a `null`:

| File:line | Assertion |
|---|---|
| `tests/ramble-panel.test.js:470, 482, 500` | `eggBefore.egg.warmth` |
| `tests/ramble-panel.test.js:519-522` | `typeof body.egg.egg_id`, `body.egg.hatch_at === 100` |
| `tests/ramble-panel.test.js:544` | `const { egg } = …; egg.hatch_at === 100000` |
| `tests/ramble-panel.test.js:598` | `typeof body.egg.percent` |
| `tests/ramble-panel.test.js:609` | `after.egg.warmth === before.egg.warmth + 15` |
| `tests/ramble-tools.test.js:132-133, 160, 167, 225` | `payload.egg.percent`, `after.egg.warmth - before.egg.warmth`, `state.egg.percent`, `eggAfter.egg.warmth` |

Give each fixture an explicit egg with `mintIncubatingEgg` — these tests are about warmth accrual, not about egg supply, so an explicit fixture is the right repair rather than weakening the assertion. Add `tests/ramble-panel.test.js:1347` to that list too: it dereferences `(await req("/api/ramble/egg")).json()).egg.egg_id` and so breaks here.

Two that look like they belong here but do NOT: `tests/ramble-panel.test.js:911` asserts the source literal `"eggPercent = pet.egg.percent"`, which only Task 7's `paintPet` rewrite deletes; and the whole flock family (`tests/ramble-tools.test.js:177`, `tests/ramble-panel.test.js:1227/1228/1234/1239`) survives this task, because Task 2 only RENAMES `flock.js`'s mint — `flockState` keeps minting until Task 3 Step 5.

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
  // ⚠ EXACT VALUES, NOT `> 0` OR `>=`. `ramble_pet.energy` DEFAULTS TO 60
  // (init-tables.js:105), so `energy > 0` is true whether or not anything was
  // fed, and `>=` is true when the feed was SKIPPED and the value did not
  // move. An earlier draft of this very test asserted exactly that and would
  // have passed against the death spiral it exists to prevent — phase 2's
  // vacuous-fixture lesson, on the one test that most needed to be sharp.
  // Deltas (pet.js FEED_DELTAS): checkin +5, visit_place +15, meet_crow +20,
  // against the base ceiling of 100.
  const before = await feedAll(db, { type: "checkin" }, { now: T0 });
  assert.equal(await eggCount(db), 0, "feeding must not mint an egg");
  assert.equal(before.pet.energy, 65, "60 + 5: the check-in fed the bird with no egg");

  const place = await feedAll(db, { type: "visit_place", cell: "9vk79ed" }, { now: T0 + 1000 });
  assert.equal(place.pet.energy, 80, "65 + 15: a new place fed the bird");

  const crow = await feedAll(db, { type: "meet_crow", persona: "abc123" }, { now: T0 + 2000 });
  assert.equal(crow.pet.energy, 100, "80 + 20: meeting a crow fed the bird");
  assert.equal(await eggCount(db), 0);
});

test("NEGATIVE CONTROL: a repeat visit_place does not feed, so the test above can fail", async () => {
  // Without this, an implementation that fed unconditionally would also pass
  // the test above. `shouldFeedPet` must still honour the dedup key.
  const db = await freshDb();
  const first = await feedAll(db, { type: "visit_place", cell: "9vk79ed" }, { now: T0 });
  assert.equal(first.pet.energy, 75, "60 + 15");
  const repeat = await feedAll(db, { type: "visit_place", cell: "9vk79ed" }, { now: T0 + 1000 });
  assert.equal(repeat.credited, false, "same cell, same ISO week");
  assert.equal(repeat.pet.energy, 75, "a not-credited keyed event must NOT feed");
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
  bundles/ramble/server/flock.js \
  tests/ramble-eggs.test.js tests/ramble-flock.test.js tests/ramble-trades.test.js tests/ramble-sync.test.js
grep -rn "ensureIncubatingEgg" tests/ bundles/ | grep -v node_modules
```

Expected from the grep: **no hits** — and `bundles/ramble/server/flock.js` is in that `sed` list for the reason above, so do not drop it. (`servers/sharing/instance-sync.js:733` also mentions the old name in a doc comment, but this grep is scoped to `tests/ bundles/` and can never show it. Leave that file alone regardless.)

- [ ] **Step 7: Run the tests**

```bash
node scripts/run-suite.mjs tests/ramble-eggs-supply.test.js
node scripts/run-suite.mjs tests/ramble-eggs.test.js
node scripts/run-suite.mjs tests/ramble-panel.test.js
node scripts/run-suite.mjs tests/ramble-tools.test.js
node scripts/run-suite.mjs tests/ramble-feed.test.js
node scripts/run-suite.mjs tests/ramble-trades.test.js
node scripts/run-suite.mjs tests/ramble-flock.test.js
node scripts/run-suite.mjs tests/ramble-sync.test.js
```

Expected: all PASS, after the fixtures in the table above have been given explicit eggs. The last three are the `sed` targets — a rename this task commits but does not re-run would surface a task later, which is exactly the attribution mess this plan has already had to untangle twice. `tests/ramble-eggs.test.js` has a test asserting two `mintIncubatingEgg` calls return the same egg — that still holds. **Do not move on with any of these red**; the suite must be green at the end of every task, not only at the end of the phase.

- [ ] **Step 8: Commit**

```bash
git add tests/ramble-eggs-supply.test.js
git commit bundles/ramble/server/eggs.js tests/ramble-eggs-supply.test.js tests/ramble-eggs.test.js \
  tests/ramble-flock.test.js tests/ramble-trades.test.js tests/ramble-sync.test.js \
  tests/ramble-panel.test.js tests/ramble-tools.test.js bundles/ramble/server/flock.js \
  -m "ramble: looking at a screen no longer mints an egg"
```

---

## Task 3: auto-promote — the shelf refills the empty slot

**Files:**
- Modify: `bundles/ramble/server/eggs.js`, `bundles/ramble/server/flock.js`, `bundles/ramble/server/init-tables.js` (comment only)
- Modify: `tests/ramble-eggs-supply.test.js`
- **Modify (these WILL go red — they assert the behaviour this task removes):** `tests/ramble-eggs.test.js`, `tests/ramble-flock.test.js`, `tests/ramble-tools.test.js`, `tests/ramble-panel.test.js`

**⚠ Task 3 breaks seven existing assertions. They are not "maybe" — each was checked against the code. Rewrite each to assert the NEW contract; do not weaken or delete a test to make it pass:**

| File:line | What it asserts today | What it becomes |
|---|---|---|
| `tests/ramble-eggs.test.js:49` | `[["hatched",1],["incubating",1]]`, titled *"…and starts the next egg"* | `[["hatched",1]]` — no successor. Retitle. |
| `tests/ramble-eggs.test.js:58` | `s.egg.egg_id` after a hatch | `assert.equal(s.egg, null)`. **Then add a positive case** — shelve an egg, let the hatch promote it, credit warmth and assert a non-zero `percent` — or nothing anywhere covers a non-zero percent any more. |
| `tests/ramble-eggs.test.js:71` | `before.egg.warmth` after a hatch | null-guard, or shelve an egg first so one exists |
| `tests/ramble-eggs.test.js:82` | `before.egg.warmth` after a hatch | same |
| `tests/ramble-flock.test.js:150` | *"a successor egg was minted"* | **NOT "the slot is empty"** — the shelf is not empty there. The test parks egg `E` as `'user'` via `incubateEgg`, then `hot` hatches and `promoteFromShelf` draws `E` straight back in, so the count stays 1. Assert `getIncubatingEgg(d).egg_id === E` and retitle to *"the parked egg is promoted back into the slot"*. |
| `tests/ramble-flock.test.js:172` | *"the incubating egg is ensured and listed first"* | mint one explicitly as a fixture, then assert ordering |
| `tests/ramble-tools.test.js:177` | `s.eggs[0].status === "incubating"` off the flock tool | mint a fixture |
| `tests/ramble-panel.test.js:1227, 1228, 1234, 1239` | the flock family — the file header (`:53`) says it "churns hatches and later asserts an incubating egg exists" | give the fixture an explicit egg |

**⚠ These belong HERE, in Task 3, not in Task 2.** A round-3 edit moved them to Task 2 reasoning that "nothing mints from Task 2 onward" — that is false, because Task 2 only RENAMES `flock.js`'s mint; `flockState` keeps minting until Task 3 Step 5 removes it, and every one of these assertions sits downstream of a `GET /api/ramble/flock` or `ramble_flock` call. `tests/ramble-panel.test.js:1347` is different — it dereferences `GET /api/ramble/egg`, so it really does break at Task 2 and is listed there.

`tests/ramble-flock.test.js:174` and `tests/ramble-panel.test.js:1226/1234` were red in a draft where `flockState` promoted on read. It no longer does (see `promoteFromShelf`'s note), so they are unaffected — **verify that rather than assuming it**, since it is the kind of claim this plan has already got wrong twice.

**Interfaces:**
- Produces: `nextPromotable(db) -> Promise<{egg_id}|null>` (a pure read: the egg that would be promoted) and `promoteFromShelf(db, { now, emit }) -> Promise<row|null>` (which uses it and writes).
- Consumed by: **`hatchIfReady` only** — one call site in the whole codebase. No read path calls it (not `eggState`, `flockState`, `petState` or any route), and neither does `trades.js`; see the docstring for why the trade paths use an affordance instead.

**The ordering rule, which is the whole design:** both instances must pick the **same** egg with no round trip. The order is `created_at ASC, egg_id ASC` — a total order and a pure function of replicated rows, exactly the order `RAMBLE_EGG_REPROMOTE_SQL` already uses for the sync layer's own re-promote.

**⚠ This is NOT the sync layer's re-promote.** `servers/sharing/instance-sync.js:713` deliberately promotes only `shelf_origin = 'sync'` eggs, with a comment that `'user'` eggs "must never be drafted back in". That rule is correct **for sync**, which is a convergence tie-break carrying no user intent. The app-level promote here is a game rule and *does* take user eggs — that is the entire release valve of spec §4.2. **Do not modify `instance-sync.js`.**

- [ ] **Step 1: Write the failing tests**

Append to `tests/ramble-eggs-supply.test.js`:

```js
import { promoteFromShelf, nextPromotable, hatchIfReady } from "../bundles/ramble/server/eggs.js";
import { flockState } from "../bundles/ramble/server/flock.js";

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
    "a deliberate promote carries no shelf origin, same as the manual incubate path");
  assert.equal((await statusOf(db, "younger")).status, "shelf", "only one is drafted");
});

test("promoteFromShelf emits, because the user really did move to a new egg", async () => {
  const db = await freshDb();
  await shelveEgg(db, "next", T0);
  const emitted = [];
  await promoteFromShelf(db, { now: T0 + 1000, emit: (t, o, r) => emitted.push([t, o, r.egg_id]) });
  assert.deepEqual(emitted, [["ramble_eggs", "update", "next"]]);
  assert.equal((await statusOf(db, "next")).shelf_origin, null,
    "NULL, never 'sync': relabelling would widen the nest shelf cap (flock.js:126) and make the "
    + "sync layer's own re-promote draftable on an egg the user parked");
});

test("a READ never promotes — flockState and the egg route are pure", async () => {
  const db = await freshDb();
  await shelveEgg(db, "parked", T0);
  await flockState(db, { now: T0 + 1000 });
  assert.equal(await getIncubatingEgg(db), null,
    "a GET must not queue a sync op, and a read-path promote races applyRambleEgg's "
    + "isUserShelve carve-out (instance-sync.js:855)");
  assert.equal((await statusOf(db, "parked")).status, "shelf");
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

test("an EXPIRED but unswept trade still locks its egg — do not 'fix' the predicate", async () => {
  // expireTrades runs on the 15 s drain tick, so there is a window where a
  // lapsed offer is still 'proposed' and its egg stays locked. Once it
  // expires the egg is promotable again, but nothing auto-promotes it — the
  // panel offers it instead (Task 7's "one's waiting on your shelf"). Pinned
  // here so nobody widens OPEN_SQL to "fix" the window.
  const db = await freshDb();
  await shelveEgg(db, "only-one", T0);
  await db.execute({
    sql: `INSERT INTO ramble_trades
            (trade_id, counterpart, role, my_egg_id, state, created_at, updated_at, expires_at)
          VALUES ('t-expired', 'npub-them', 'proposer', 'only-one', 'proposed', ?, ?, ?)`,
    args: [T0, T0, T0 - 1000],           // already past expires_at, not yet swept
  });
  assert.equal(await promoteFromShelf(db, { now: T0 + 5000 }), null);
});

test("nextPromotable answers the same question the promote acts on, and writes nothing", async () => {
  const db = await freshDb();
  assert.equal(await nextPromotable(db), null);
  await shelveEgg(db, "younger", T0 + 5000);
  await shelveEgg(db, "older", T0);

  const peek = await nextPromotable(db);
  assert.equal(peek.egg_id, "older");
  assert.equal((await statusOf(db, "older")).status, "shelf", "a peek must not move it");

  const promoted = await promoteFromShelf(db, { now: T0 + 9000 });
  assert.equal(promoted.egg_id, peek.egg_id, "the card and the promote read ONE rule");
  assert.equal(await nextPromotable(db), null, "the slot is full now");
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
 * Writes NOTHING when the slot is occupied or nothing is promotable.
 *
 * ⚠ CALLED FROM EXACTLY ONE PLACE: `hatchIfReady`. Never from a read path.
 *
 * Two earlier drafts of this plan called it from `eggState`/`flockState` too,
 * so that a slot emptied by a sync arrival would refill without waiting for a
 * hatch. Both were wrong, and the second was wrong in a subtler way than the
 * first:
 *
 *   1. It is a write during a GET, and `applyRambleEgg` carries an explicit
 *      carve-out (instance-sync.js:855-860) refusing to re-promote on a peer's
 *      USER shelve, because the replacement egg's row "follows in the same
 *      drain" — a GET landing in that window drafts the egg the user just
 *      parked, and it then out-ranks their real choice on both machines.
 *   2. The attempted fix — marking such a promote `shelf_origin = 'sync'` so
 *      it ranks below a real choice — LAUNDERS PROVENANCE. `flock.js:126`
 *      counts `status='shelf' AND shelf_origin='user'` for the nest shelf cap
 *      and `flock.js:253` for `shelf_count`; `instance-sync.js:831` rewrites
 *      a demoted egg to `'sync'` unconditionally; and
 *      `RAMBLE_EGG_REPROMOTE_SQL` drafts `'sync'` eggs only. A user egg
 *      relabelled 'sync' therefore stops consuming a shelf slot, is
 *      under-reported to the user, becomes draftable by the very sync rule
 *      the 'user' mark exists to protect it from, and is mislabelled "came
 *      back from another of your Crows" at `static/ramble.js:1776`.
 *
 * Honest inventory of every way the slot can empty, and what covers it:
 *
 *   - a hatch                  -> covered HERE, and this is the main loop
 *   - `incubateEgg` swap       -> never empties the slot (one conditional
 *                                 UPDATE), and it ends in `hatchIfReady`
 *   - gifting / swapping away  -> the incubating egg is not giftable
 *                                 (`GIFTABLE = {shelf, received}`)
 *   - a gift or swap ARRIVING, or a swap expiring/declining and unlocking
 *     the last shelf egg, while the slot is empty
 *                              -> NOT auto-promoted. The egg sits on the
 *                                 shelf and the panel says so, with a button
 *                                 that incubates it in one tap (Task 7).
 *   - a slot emptied by `applyRambleEgg` while the user holds ONLY 'user'
 *     shelf eggs -> same: `RAMBLE_EGG_REPROMOTE_SQL` drafts
 *                   `shelf_origin='sync'` rows only.
 *
 * ⚠ An earlier draft promoted from `trades.js`'s closing paths to auto-cover
 * rows 4 and 5. It was reverted: promoting inside `expireTrades` strands an
 * in-flight `completed` envelope — the hand-over UPDATE (`WHERE status IN
 * ('shelf','received')`) then matches nothing while `receivedEggStatement`
 * still inserts, so the user keeps BOTH eggs. Manufacturing a free-egg race
 * in the phase whose whole purpose is removing the free egg is not a trade
 * worth making, and the underlying complaint was never "the slot is empty" —
 * it was "the player has no signal and no way back". That is an affordance
 * problem, and it is fixed with an affordance.
 */
/**
 * The egg that WOULD be promoted, or null — a pure read, no writes.
 *
 * Extracted so the promote and the panel's "one's waiting on your shelf" card
 * read exactly ONE rule. A card that offers an egg the promote would not take
 * (or the reverse) is the map/payout split this project has already had to
 * close once in phase 1.
 */
export async function nextPromotable(db) {
  if (await getIncubatingEgg(db)) return null;
  const locked = await lockedEggIds(db);
  const { rows } = await db.execute({
    sql: `SELECT egg_id FROM ramble_eggs
           WHERE status IN ('shelf', 'received')
           ORDER BY created_at ASC, egg_id ASC`,
    args: [],
  });
  return rows.find((r) => !locked.has(r.egg_id)) ?? null;
}

export async function promoteFromShelf(db, { now, emit } = {}) {
  void now;
  const next = await nextPromotable(db);
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
  // Phase 3: a flock screen is a READ, and now genuinely is one. It used to
  // mint the incubating egg, so opening this view recreated one. It does NOT
  // promote either: see promoteFromShelf's note on why a write during a GET
  // both races the sync drain and launders shelf_origin provenance.
```

Update the import: drop `ensureIncubatingEgg`. **Do not add `promoteFromShelf`** — `flock.js` no longer needs it.

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
node scripts/run-suite.mjs tests/ramble-eggs.test.js
node scripts/run-suite.mjs tests/ramble-flock.test.js
node scripts/run-suite.mjs tests/ramble-tools.test.js
node scripts/run-suite.mjs tests/ramble-panel.test.js
node scripts/run-suite.mjs tests/ramble-sync.test.js
```

Expected: all PASS, after the seven assertions in the table above have been rewritten. **Do not proceed to Task 4 with any of these red** — a later task's failure is much harder to attribute once several are broken at once.

- [ ] **Step 8: Commit**

```bash
git commit bundles/ramble/server/eggs.js bundles/ramble/server/flock.js \
  bundles/ramble/server/init-tables.js tests/ramble-eggs-supply.test.js \
  tests/ramble-eggs.test.js tests/ramble-flock.test.js tests/ramble-tools.test.js tests/ramble-panel.test.js \
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
  hasAnyEggAnywhere, readLaySettings, LAY_DAYS_DEFAULT, localDay,
} from "../bundles/ramble/server/eggs.js";
import { applyRambleWallet } from "../servers/sharing/instance-sync.js";

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

/* ------------------------------------------------------- multi-instance
 * Spec §8: "every currency ledger replicates, so both need multi-instance
 * tests, not single-database ones." A sync defect already cost this project
 * real data; prose review is not sufficient here. The pattern below follows
 * tests/ramble-cells-sync.test.js.
 */

test("MULTI-INSTANCE: a peer's layday rows converge to the same count", async () => {
  const a = await freshDb();
  const b = await freshDb();
  await setLayDays(a, 5); await setLayDays(b, 5);

  const rows = [];
  const emit = (table, op, row) => { if (table === "ramble_wallet") rows.push(row); };
  await recordHappyDay(a, { now: T0, mood: "happy", emit });
  await recordHappyDay(a, { now: T0 + DAY, mood: "happy", emit });

  for (const r of rows) await applyRambleWallet(b, "insert", r, 1);
  assert.equal((await layProgress(b)).days, 2, "b sees a's days");
  assert.equal((await layProgress(a)).days, 2, "and a is unchanged");
});

test("MULTI-INSTANCE: created_at going BACKWARDS on apply must not change the count", async () => {
  // applyRambleWallet does created_at = MIN(local, incoming). This is exactly
  // why layProgress orders by `key` and not by `created_at`: an apply can move
  // a row's timestamp across the reset boundary, and clock skew between the
  // user's own machines is enough to do it.
  const db = await freshDb();
  await setLayDays(db, 99);
  await recordHappyDay(db, { now: T0, mood: "happy" });
  await recordHappyDay(db, { now: T0 + DAY, mood: "happy" });
  const before = (await layProgress(db)).days;

  await applyRambleWallet(db, "insert",
    { kind: "layday", key: localDay(T0 + DAY), delta: 1, created_at: 0 }, 9);

  assert.equal((await layProgress(db)).days, before,
    "a rewritten created_at must not move a day in or out of the count");
});

test("MULTI-INSTANCE: a peer's lay row resets this instance's count too", async () => {
  const db = await freshDb();
  await setLayDays(db, 99);
  await recordHappyDay(db, { now: T0, mood: "happy" });
  await recordHappyDay(db, { now: T0 + DAY, mood: "happy" });
  assert.equal((await layProgress(db)).days, 2);

  // The peer laid on the later day.
  await applyRambleWallet(db, "insert",
    { kind: "lay", key: localDay(T0 + DAY), delta: 1, created_at: T0 + DAY }, 5);

  assert.equal((await layProgress(db)).days, 0,
    "both instances agree the count is spent, with nothing deleted");
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
 * row: `lay` rows mark each laying, and only `layday` rows AFTER the most
 * recent one count. The ledger stays append-only (spec §6.1).
 *
 * ⚠ ORDERED BY `key`, NEVER BY `created_at`. Both are tempting; only one
 * converges. `applyRambleWallet` resolves a conflict with
 * `created_at = MIN(local, incoming)` (instance-sync.js:620), so a sync apply
 * can move a row's timestamp BACKWARDS — across the reset boundary, in either
 * direction — and clock skew between the user's machines is enough to do it
 * on its own. `key` is the local day (`YYYY-MM-DD`), it is half the primary
 * key, it sorts lexically in true date order, and `applyRambleWallet` never
 * rewrites it. Comparing keys therefore yields the same number on every
 * instance from the same rows. It also excludes the lay-day itself, which is
 * correct: the day you laid is spent.
 */
export async function layProgress(db) {
  const { layDays } = await readLaySettings(db);
  const { rows } = await db.execute({
    sql: `SELECT count(*) AS n FROM ramble_wallet
           WHERE kind = ?
             AND key > COALESCE((SELECT MAX(key) FROM ramble_wallet WHERE kind = ?), '')`,
    args: [LAYDAY_KIND, LAY_KIND],
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
 *
 * ⚠ Called ONLY from the write paths (`feed`, and `doChore` through it) —
 * never from `petState`. `pet.js:18` records the invariant: "petState's
 * decay-on-read write never emits, because a GET must never queue a sync op",
 * and `petState` has no `emit` in scope to pass. A day is therefore earned by
 * DOING something — a walk, a chore, a check-in — not by opening the app,
 * which is also the truer reading of §4.3's "sustained care".
 *
 * ⚠ Laying REQUIRES real movement, and that is a design consequence, not an
 * oversight. Decay is 10 per 6 h (-40/day); the most a player who never posts
 * a location fix can earn is checkin 5 + 3 chores x 8 = 29/day. From the
 * default 60 they bank three happy days and then fall below the 60 threshold
 * for good. Do NOT write, in a comment or a doc, that chores and the check-in
 * alone can reach `lay.days`. They cannot.
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

  // ⚠ The mint is gated on the `lay` row being NEW. Without checking
  // rowsAffected the dedup key just written would be decorative, and two
  // overlapping calls would each mint an egg.
  const { rowsAffected: laidNow } = await db.execute({
    sql: `INSERT OR IGNORE INTO ramble_wallet (kind, key, delta, created_at) VALUES (?, ?, 1, ?)`,
    args: [LAY_KIND, key, now],
  });
  if (laidNow === 0) return { recorded: true, laid: false };

  await safeEmit(emit, "ramble_wallet", "insert", { kind: LAY_KIND, key, delta: 1, created_at: now });
  await mintIncubatingEgg(db, { now, emit });
  return { recorded: true, laid: true };
}
```

- [ ] **Step 4: Call it from `pet.js`'s WRITE path only**

`pet.js` already imports `localDay` from `eggs.js`; extend that import with `recordHappyDay`. In **`feed`** only, after `const mood = moodFor(energy);` and the pet row has been written:

```js
  // Phase 3 (spec §4.3): a day counts when the bird is happy while wholly
  // eggless. Idempotent per local day, and a no-op the moment the player
  // holds any egg. `doChore` reaches this through feed(), so chores and the
  // daily check-in both count.
  await recordHappyDay(db, { now, mood, emit });
```

**⚠ Do NOT also call it from `petState`.** Three reasons, and the first is fatal on its own:

1. `petState(db, { now = Date.now() } = {})` has **no `emit` in scope** (`pet.js:223`). The call would be a `ReferenceError` on every `GET /api/ramble/pet` and every `ramble_pet_state` MCP call — for every player, egg or not.
2. `pet.js:13-21` documents the invariant it would break: *"`petState`'s decay-on-read write never emits, because a GET must never queue a sync op."* Neither caller passes an `emit` (`routes.js` calls `petState(db, { now })`; `server.js:305` calls `petState(db)`), so even adding the parameter would silently produce lay-days that never replicate.
3. It is the better game rule anyway: a day is earned by **doing** something, not by opening the app — the truer reading of §4.3's "sustained care".

**⚠ Do not repeat the claim that a geolocation-denying player can still reach the floor.** An earlier draft said so and it is arithmetically false: decay is 10 per 6 h (−40/day) against a maximum of `checkin 5 + 3 × chore 8 = 29/day`, so from the default 60 such a player banks **three** happy days and then sits below the 60 threshold permanently. Removing the `petState` call did not cause this — `petState` computes mood after decay and before the day's feeds, so including it would have been strictly worse. **Laying requires real movement.** Flagged for Kevin in the hand-back as a design consequence of §4.3 meeting the existing decay curve.

- [ ] **Step 5: Run the tests**

```bash
node scripts/run-suite.mjs tests/ramble-laying.test.js
node scripts/run-suite.mjs tests/ramble-pet.test.js
node scripts/run-suite.mjs tests/ramble-feed.test.js
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
  // Object.hasOwn, not a truthiness check: PROLOGUE_KEYS is a plain literal,
  // so `setPrologueSeen(db, "constructor")` would otherwise return a function
  // and bind it into the SQL args instead of throwing.
  const key = Object.hasOwn(PROLOGUE_KEYS, which) ? PROLOGUE_KEYS[which] : null;
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
- Modify: `bundles/ramble/panel/routes.js`, `bundles/ramble/server/server.js`
- **Create: `tests/ramble-prologue-routes.test.js`** (see Step 1 — it cannot live in `ramble-panel.test.js`)
- Modify: `tests/ramble-panel.test.js`, `tests/ramble-tools.test.js`
- **NOT modified: `bundles/ramble/server/feed.js`** — see Step 4.

**Interfaces:**
- `GET /api/ramble/egg` -> `{ egg: null | {...}, checklist: {...}, lay: { days, needed }, shelf_waiting: eggId|null }`
- `GET /api/ramble/pet` -> adds `pet.egg` (`null` or `{ percent, ... }`), `pet.lay`, and `pet.shelf_waiting` (an `egg_id` or null)
- `GET /api/ramble/prologue` -> `{ intro_seen, hatch_seen, granted }`
- `POST /api/ramble/prologue/intro` -> `{ egg: row|null, intro_seen: true }` — grants and flags
- `POST /api/ramble/prologue/hatch` -> `{ hatch_seen: true }`
- `POST /api/ramble/egg/checkin` -> `{ credited, warmth, hatched, egg }` — `egg` is new: a boolean saying whether one is incubating after the credit (Task 7's copy branches on it)

**⚠ Both prologue POSTs must be idempotent** — the panel fires them from a dismiss button that a double-tap can send twice.

- [ ] **Step 1: Write the failing route tests**

**⚠ These four tests CANNOT go in `tests/ramble-panel.test.js`'s shared harness.** That file creates ONE scratch `CROW_DATA_DIR` and one db at `:28-36` for the whole file and runs in declaration order, so by the time these ran: `grantStarterEgg` would return `null` (an egg already exists from the nest claim at `:1186`), `egg: null` would be false, and `lay.days` would already be ≥ 1 because `POST /api/ramble/area` at `:458` feeds a fresh pet 60 → 75 → happy while eggless and therefore writes a `layday` row.

Put them in a **new file `tests/ramble-prologue-routes.test.js`**.

**⚠ A per-test `createClient` handle is NOT achievable — do not try.** `rambleRouter(dashboardAuth, options)` (`routes.js:176`) takes only an injected `emit`; the db is created inside the closure at `:230` via `mods.dbMod.createDbClient()`, which resolves `CROW_DB_PATH` → `CROW_DATA_DIR/crow.db` (`server/db.js:124`) and is then memoized for the router's lifetime. There is no seam to hand it an in-memory client.

What these tests actually need is not per-test isolation but **one virgin db**, which the existing harness gives for free. Copy that file's harness, which is spread across four places, not one range: `:17-27` (node imports, `REPO_ROOT`, `SCRATCH`), `:29-46` (`mkdtemp`, `CROW_APP_ROOT`/`CROW_DATA_DIR`, the dynamic `import()` of `routes.js`), `:109-118` (router → express app → `listen` → `once(server, "listening")`), `:161` (`req()`), and **`:146-153` (`after()` — close the server, restore env, `rmSync` the scratch dir)**. The `after()` block is not optional: without it the new file leaks a listening socket and a temp directory. Keep one db for the file and rely on declaration order: tests 1 and 2 assert `egg: null` on a virgin db, test 3 grants, test 4 is order-independent. Nothing on these four routes mints, and none of them feeds — `recordHappyDay` is called only from `pet.js:feed` — so no `layday` row can appear either.

(If genuine per-test isolation is ever needed it takes a fresh `CROW_DB_PATH` **plus** a fresh `rambleRouter()` and app per test, not a client handle.)

Sketch of the assertions (adapt to the harness you build):

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
node scripts/run-suite.mjs tests/ramble-prologue-routes.test.js
```

Expected: FAIL — the prologue routes 404 and `lay` is absent.

- [ ] **Step 3: Load the new module surface and add the routes**

`mods.eggsMod` is a namespace import (`routes.js:227`), so every new `eggs.js` export — `layProgress`, `readPrologue`, `setPrologueSeen`, `grantStarterEgg`, `getIncubatingEgg` — is reachable with no import change. **`promoteFromShelf` is deliberately NOT in that list: no route calls it.** Then extend the egg route and add the prologue routes:

```js
  router.get("/api/ramble/egg", handle(async (req, res) => {
    // No promote here. A GET must never queue a sync op, and see
    // promoteFromShelf's note: a read-path promote both races the drain and
    // launders shelf_origin. hatchIfReady is the only local emptier.
    const state = await mods.eggsMod.eggState(db, { now: Date.now() });
    const lay = await mods.eggsMod.layProgress(db);
    const waiting = await mods.eggsMod.nextPromotable(db);
    res.json({ ...state, lay, shelf_waiting: waiting ? waiting.egg_id : null });
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

**And the check-in route must say whether an egg exists**, or Task 7's honest confirmation copy has nothing to branch on (the handler sees only `{ credited, warmth, hatched }`, and `eggSeedId` is stale until `refreshEgg()` runs afterwards). In the existing `POST /api/ramble/egg/checkin` handler (`routes.js:845-849`), add one field to the response:

```js
      // Read AFTER feedAll deliberately: a check-in that hatches the last egg
      // with an empty shelf reports false, and "nothing to warm yet" is then
      // the true statement about what comes next.
      egg: !!(await mods.eggsMod.getIncubatingEgg(db)),
```

Keep the existing `GET /api/ramble/egg` handler's other behaviour (auth, error handling) exactly as it was — copy the surrounding shape from the file rather than the sketch above.

- [ ] **Step 4: Fix `GET /api/ramble/pet`, which 500s for every eggless player**

**⚠ This is the single highest-severity line in the phase.** `bundles/ramble/panel/routes.js:816` currently reads:

```js
      egg: { percent: egg.egg.percent },
```

where `egg` is `await mods.eggsMod.eggState(db, { now })` (line 812). The moment Task 2 makes `eggState` return `egg: null`, that dereference throws, `handle()` turns it into a 500, and the **pet view dies entirely** — which is the only view an eggless player with a bird can reach from the perch. Replace lines 812-820's egg line with:

```js
    const eggSummary = await mods.eggsMod.eggState(db, { now });
    const lay = await mods.eggsMod.layProgress(db);
    // The egg sitting on the shelf that a tap would incubate, or null. Nothing
    // auto-promotes it (see promoteFromShelf's note), so the card offers it.
    const waiting = await mods.eggsMod.nextPromotable(db);
    res.json({
      ...pet,
      bird,
      // null when genuinely eggless — paintPet must not assume one exists.
      egg: eggSummary.egg ?? null,
      shelf_waiting: waiting ? waiting.egg_id : null,
      lay,
      seed: await mods.walletMod.seedBalance(db),
      hearts: await mods.heartsMod.heartsBalance(db),
      energy_max_cap: (await mods.heartsMod.readHeartSettings(db)).cap,
    });
```

**⚠ Do NOT touch `readPet` in `bundles/ramble/server/feed.js`.** An earlier draft of this plan directed the change there, wrongly: `readPet` is private to `feedAll` and is used only on its not-credited branch (`feed.js:48`) — nothing on the `/api/ramble/pet` path calls it, so editing it would leave line 816 unpatched. Worse, adding keys to `readPet` breaks a green test: `tests/ramble-feed.test.js:68` asserts `Object.keys(repeat.pet)` equals `Object.keys(first.pet)`, where `first.pet` comes from `petFeed` and `repeat.pet` from `readPet`. Adding `egg`/`lay` to one and not the other is exactly the divergence that test exists to catch.

- [ ] **Step 5: Fix the MCP tool, which breaks the same way**

`bundles/ramble/server/server.js:305-306` **explicitly dereferences** `egg.egg.percent` — it does not pick the new shape up "for free from the spread". Note the local there is called `egg`, **not** `eggSummary` as in the route, and `layProgress` is not imported (`:30` reads `import { eggState, activeBird, isoWeek } from "./eggs.js";`). So:

```js
// :30 — extend the import
import { eggState, activeBird, isoWeek, layProgress } from "./eggs.js";

// :306 — ramble_pet_state
return text(JSON.stringify({
  ...state, bird, hearts: await heartsBalance(db),
  egg: egg.egg ?? null,
  lay: await layProgress(db),
}));
```

**And `ramble_egg_state` at `:319`** still returns `{ egg, checklist }` with no `lay`, so the tool and `GET /api/ramble/egg` would disagree — the exact divergence this step exists to prevent. Add `lay` there too.

A tool and a route that disagree about the same egg is the defect phase 2 caught late. After patching, grep for any other dereference of `.egg.` that assumes non-null:

```bash
grep -rn "\.egg\.\(percent\|warmth\|egg_id\|hatch_at\)" bundles/ramble/ | grep -v node_modules
```

Every hit must be null-guarded or provably reached only when an egg exists.

- [ ] **Step 6: Run the tests**

```bash
node scripts/run-suite.mjs tests/ramble-prologue-routes.test.js
node scripts/run-suite.mjs tests/ramble-panel.test.js
node scripts/run-suite.mjs tests/ramble-tools.test.js
```

Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add tests/ramble-prologue-routes.test.js
git commit bundles/ramble/panel/routes.js bundles/ramble/server/server.js \
  tests/ramble-prologue-routes.test.js tests/ramble-panel.test.js tests/ramble-tools.test.js \
  -m "ramble: the routes answer for a player with no egg"
```

---

## Task 7: the five eggless surfaces

**Files:**
- Modify: `bundles/ramble/panel/ramble.js`, `bundles/ramble/panel/static/ramble.js`, `bundles/ramble/panel/static/ramble-ar.js`, `bundles/ramble/panel/static/ramble.css`
- Modify: `tests/ramble-panel.test.js`, `tests/ramble-ar.test.js`

**⚠ Finding 2 governs this task.** The **Next egg card must never be hidden** — it is the only route to the egg view and its daily check-in once a bird exists. It changes state.

**Copy, under K5 ("the next you"):**

| Surface | With an egg | With none |
|---|---|---|
| Egg view line | unchanged | "No one on the way just now." |
| Egg view sub-line | unchanged | "Nests hold them. So do friends." |
| Next egg card, nothing anywhere | percent + ring | "Nothing warming just now." + the lay line |
| Next egg card, **one waiting on the shelf** | — | "One's waiting on your shelf." + a **Warm it** button — the lay line is hidden, because you are not eggless |
| Lay line, 0 days | — | "Keep yourself happy and you'll manage one yourself, in time." |
| Lay line, N days | — | "You've had N good days — keep it up and you'll manage one yourself." |
| Perch status line | "Your egg is N% warm." | omit the sentence entirely |
| AR view | egg art | the egg element hidden |
| Check-in confirmation | "Checked in. That is today's warmth." | "Checked in. Nothing to warm yet — but it counted." |
| Map marker | walking egg | plain dot when there is no bird AND no egg |

**S2 — the check-in must stop lying.** `static/ramble.js:1244` says *"Checked in. That is today's warmth."* With no egg, `credited` is true but the warmth vanished (D3). K4 requires the eggless state to be legible, and this is the one screen that would actively contradict it. Branch the message on whether an egg exists.

**The Warm it button** reuses the shipped incubate endpoint — do not invent one. `static/ramble.js:1796` already has `incubate(egg, btn)` posting to `/api/ramble/eggs/<id>/incubate`; declare `var lastWaitingEggId = null;` beside the other module vars and wire the button to it:

```js
  var warmBtn = $("rb-nextegg-warm");
  if (warmBtn) warmBtn.addEventListener("click", function () {
    if (!lastWaitingEggId) return;
    incubate({ egg_id: lastWaitingEggId }, warmBtn);
  });
```

`incubate` takes an object with `egg_id` and a button, and already refreshes on success.

**S3 — the perch door keeps an affordance.** An earlier draft relabelled both the marker's `aria-label` and the world view's GPS-independent button to bare `"You"`. That is inside K5 but strips the button of any sense of where it goes. Use `"How you're doing"` for the button and `"You"` for the marker's `aria-label`.

- [ ] **Step 1: Write the failing panel-source tests**

Add to `tests/ramble-panel.test.js`:

```js
test("the Next egg card is never hidden — it is the only route to the check-in", () => {
  const src = readFileSync("bundles/ramble/panel/static/ramble.js", "utf8");
  assert.ok(!/setHidden\(\s*\$\("rb-pet-nextegg"\)/.test(src),
    "hiding it would delete the daily check-in for an eggless player (phase 1's defect)");
  assert.ok(src.includes("rb-nextegg-empty"), "it changes state instead");
});

test("a shelf egg waiting for an empty slot is offered, not hidden", () => {
  const shell = readFileSync("bundles/ramble/panel/ramble.js", "utf8");
  assert.ok(shell.includes("waiting on your shelf"));
  assert.ok(shell.includes('id="rb-nextegg-warm"'), "and a one-tap way to act on it");

  const src = readFileSync("bundles/ramble/panel/static/ramble.js", "utf8");
  assert.ok(src.includes("lastWaitingEggId"), "wired to the shipped incubate endpoint");
  // The lay line must not claim you are eggless while an egg sits on the shelf.
  assert.ok(/setHidden\(\$\("rb-nextegg-lay"\)|!!waiting/.test(src));
});

test("the eggless copy is present and written from inside the premise", () => {
  // ⚠ TWO FILES. Static copy lives in the server-rendered shell; only strings
  // the client BUILDS live in the client. An earlier draft asserted both
  // against the client, and asserted a "good days" literal the client never
  // contains — it is concatenated around a pluralised day/days.
  const shell = readFileSync("bundles/ramble/panel/ramble.js", "utf8");
  assert.ok(shell.includes("Nothing warming just now."));
  assert.ok(shell.includes("Nests hold them. So do friends."));

  const src = readFileSync("bundles/ramble/panel/static/ramble.js", "utf8");
  assert.ok(src.includes("No one on the way just now."));
  assert.ok(src.includes("keep it up and you'll manage one yourself"), "K4: the soft count is named");
  assert.ok(src.includes('" good "'), "pluralised around the count");
});

test("the AR renderer hides the egg when there is neither bird nor egg", () => {
  // In the RENDERER, not startAr: ramble-ar.js repaints every frame and would
  // otherwise un-hide the egg whenever there is no valid bird.
  const src = readFileSync("bundles/ramble/panel/static/ramble-ar.js", "utf8");
  assert.ok(/setHidden\(e\.egg,\s*valid\s*\|\|\s*!.*hasEgg/.test(src),
    "seedFromEggId(null) is 0, so an unguarded frame shows an egg that does not exist");
});

test("the map marker does not draw a phantom egg for a player who has neither", () => {
  const src = readFileSync("bundles/ramble/panel/static/ramble.js", "utf8");
  const fn = src.slice(src.indexOf("function hereArt()"), src.indexOf("function paintHereArt()"));
  assert.ok(/else if \(eggSeedId\)/.test(fn),
    "hereArt must fall through to the plain dot when there is no bird and no egg");
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
            <p class="rb-muted rb-fine" id="rb-nextegg-waiting" hidden>One&rsquo;s waiting on your shelf.</p>
            <button class="rb-btn rb-btn-ghost" id="rb-nextegg-warm" type="button" hidden>Warm it</button>
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

    /* Nothing auto-promotes a shelf egg into an empty slot (see the server's
     * promoteFromShelf note), so offer it here rather than leaving the player
     * with no signal and no way back. It also means they are NOT eggless, so
     * the lay line must not claim they are. */
    var waiting = pet.shelf_waiting || null;
    setHidden($("rb-nextegg-waiting"), hasNext || !waiting);
    setHidden($("rb-nextegg-warm"), hasNext || !waiting);
    lastWaitingEggId = waiting;

    var lay = pet.lay || null;
    var layEl = $("rb-nextegg-lay");
    if (layEl) {
      setHidden(layEl, hasNext || !lay || !!waiting);
      if (!hasNext && lay && !waiting) {
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

**The sixth surface — your own map marker.** `hereArt()` at `static/ramble.js:236-241` draws the walking egg whenever `perchTarget !== "pet"`, and `seedFromEggId(null)` returns `0`, so a player with no egg *and* no bird gets a phantom seed-0 egg walking around as their location marker. Guard it:

```js
      } else if (eggSeedId) {
        /* The WALKING egg — legs and all. You are not carrying it, you are it. */
        svg.setAttribute("class", "rb-here-egg");
        svg.setAttribute("viewBox", "0 0 120 168");
        drawWalkingEggSeed(svg, seedFromEggId(eggSeedId));
      } else {
        /* No bird and no egg — the window between a first load and the
         * prologue's Go button. seedFromEggId(null) is 0, so drawing here
         * would show a phantom egg that does not exist. Return null and let
         * hereIcon draw its documented plain dot (static/ramble.js:219-222). */
        return null;
      }
```

**⚠ `paintHereArt` must also stop skipping the repaint.** It currently reads:

```js
  var art = hereArt();
  if (art) hereDot.setIcon(hereIcon(art));
```

A `null` skips `setIcon` **entirely**, so the marker keeps whatever icon it last had — only the initial creation (`:301`) ever reaches `hereIcon`'s fallback. A player who becomes eggless while still birdless would keep the phantom walking egg on the map, which is the whole defect. Make it unconditional:

```js
  /* Unconditional: hereIcon(null) is the documented plain-dot path, and
   * skipping setIcon here would leave a stale egg on the map forever. */
  hereDot.setIcon(hereIcon(hereArt()));
```

**The AR view (`rb-ar-egg`) must be fixed in the RENDERER, not in `startAr`.** `ramble-ar.js:378` runs `if (e.egg) setHidden(e.egg, valid);` on every frame, where `valid` means "a valid bird exists" — so it *un-hides* the egg whenever there is no bird, overriding anything `startAr` set within one animation frame. Add `bundles/ramble/panel/static/ramble-ar.js` to this task's files and thread a `hasEgg` flag onto the render frame:

**⚠ `frame` is NOT in `paintBird`'s scope** — `paintBird(bird)` is a local at `ramble-ar.js:375`; `frame` belongs to `render(state)` at `:400-402` and is passed in as `paintBird(frame.bird)` at `:435`. Referencing `frame.hasEgg` inside `paintBird` throws on every AR frame. Three exact edits:

```js
// 1. static/ramble.js:2125 — the panel supplies the flag
   arSession.render({ anchors: anchors, pose: arPose, bird: arBirdState(),
                      camera: arCamera, hasEgg: !!eggSeedId });

// 2. static/ramble-ar.js:228 — carry it onto the frame, beside `bird`
   bird: s.bird || null,
   hasEgg: !!s.hasEgg,          // also update the state contract comment at :8

// 3. static/ramble-ar.js:375 and :435 — take it as an argument
   function paintBird(bird, hasEgg) {
     var valid = !!(engine && bird && /* …unchanged… */);
     if (e.bird) setHidden(e.bird, !valid);
     // Phase 3: with no bird AND no egg there is nothing to draw. Without the
     // hasEgg term this un-hides a phantom seed-0 egg on every frame.
     if (e.egg) setHidden(e.egg, valid || !hasEgg);
     /* …rest unchanged… */
   }
   // :435
   paintBird(frame.bird, frame.hasEgg);
```

**`tests/ramble-ar.test.js:245` goes red and must be updated:** it calls `session.render({ anchors, pose: pose(null), bird: null })` and then asserts `els.egg.hasAttribute("hidden") === false`. With no `hasEgg` on the state that is now hidden. Pass `hasEgg: true` there, and add a new case with `bird: null, hasEgg: false` asserting the egg IS hidden. **Do not assert the presence of a line in `startAr`** — an earlier draft of this plan did exactly that, and the assertion passed against a fix that the renderer immediately undid.

The framing fix (K5), in `paintHereArt` and `paintPerchGo`:

```js
      el.setAttribute("aria-label", "You");        /* was "You, and your bird" / "You, and your egg" */
```
```js
    go.textContent = "How you're doing";           /* was "Your bird" / "Your egg" */
```

And the check-in confirmation at `static/ramble.js:1243-1246` (S2). **⚠ There is no `hasEgg` in scope there** — the handler branches on `out.credited`, and `POST /api/ramble/egg/checkin` answers `{ credited, warmth, hatched }` with no egg, while `eggSeedId` is still stale because `refreshEgg()` runs afterwards at `:1250`. So the route must say. Add `egg` to the check-in response in Task 6:

```js
  // routes.js, POST /api/ramble/egg/checkin — add to the res.json body:
      egg: !!(await mods.eggsMod.getIncubatingEgg(db)),
```

and list it in Task 6's interfaces as `POST /api/ramble/egg/checkin -> { credited, warmth, hatched, egg }`. Then the client can branch honestly:

**⚠ Keep the not-credited branch.** Today's code is a two-way branch and the second arm still matters — replacing it with a test on `out.egg` alone would make a second same-day tap read "Checked in. That is today's warmth.", a fresh lie on the screen this change exists to stop lying on. It becomes three-way:

```js
      /* Three arms, not two. With no egg the credit was real but the warmth
       * had nowhere to land (D3), and a repeat tap is neither. */
      setText($("rb-egg-status"),
        !(out && out.credited) ? "Already checked in today — go somewhere instead."
        : out.egg ? "Checked in. That is today's warmth."
        : "Checked in. Nothing to warm yet — but it counted.");
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
node scripts/run-suite.mjs tests/ramble-ar.test.js
```

Expected: both PASS, including the zero-backticks and exactly-two-sinks assertions.

- [ ] **Step 7: Commit**

**⚠ Both AR files must be in the commit.** An earlier draft listed them in Files but omitted them here, and this plan forbids `git add -A`, so the AR fix would simply never have been committed.

```bash
git commit bundles/ramble/panel/ramble.js bundles/ramble/panel/static/ramble.js \
  bundles/ramble/panel/static/ramble-ar.js bundles/ramble/panel/static/ramble.css \
  tests/ramble-panel.test.js tests/ramble-ar.test.js \
  -m "ramble: the panel answers for a player with no egg"
```

**⚠ If you made the check-in route edit while working this task** (its instruction appears above, but it belongs to Task 6), commit `bundles/ramble/panel/routes.js` with it — otherwise the copy branches on a field the route never sends:

```bash
git commit bundles/ramble/panel/routes.js -m "ramble: the check-in says whether there is an egg"
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

Call `maybeIntro()` once from the panel's existing start-up sequence, beside the other first-load fetches.

**The hatch beat's hook point, precisely** — an earlier draft said "grep for `hatchLock`", which points at the wrong function. `clearHatch()` takes no argument, has no access to the hatched bird (`shownHatch` holds a string key, not `{species, seed}`), and fires on *any* view change, so hooking it would show the beat at random moments with no species name. Hook the **`rb-meet-bird` button handler** instead, and stash the bird in a module var when the hatch is handled:

```js
  var lastHatched = null;          /* set by handleHatched, read by the beat */
```

In `handleHatched(h)`, add `lastHatched = h;`. Then in the `rb-meet-bird` click handler, after its existing work, call `maybeHatchBeat(lastHatched)`.

**If the player closes the tab after seeing beat one but before tapping Go**, `intro_seen` and `granted` are both still false, so `maybeIntro()` shows it again on the next load — intended. The egg arrives only when they engage, and there is exactly one button, so there is no dismissal path that skips the grant.

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

- [ ] **Step 1b: Fix the SECOND false sentence, which is easy to miss**

`docs/guide/ramble.md:88` ends with **"A new egg starts incubating immediately."** — falsified by this phase just as line 68 is. Replace that clause with:

```markdown
the bird's look is unique to that seed. If an egg is waiting on your shelf it moves into the slot; otherwise nothing new starts, and the next one has to be found, given, or laid.
```

The Spanish mirror at `docs/es/guide/ramble.md:88` ends with **"Un huevo nuevo empieza a incubar de inmediato."** and needs the same correction:

```markdown
el aspecto del pájaro es único para esa semilla. Si tienes un huevo esperando en la repisa, pasa al hueco; si no, no empieza nada nuevo, y el siguiente hay que encontrarlo, recibirlo o ponerlo.
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

Expected: **0 fail**, and a total of roughly 4340 plus the new tests.

**⚠ Do not use "≥ 4340" as a mechanical gate.** Task 3 legitimately rewrites seven existing assertions (see its table), which changes what is counted; a naive floor would either fire spuriously or hide a real deletion. The honest check is: **every test file this branch touched must be named in the PR body with what changed and why**, and the only assertions that changed meaning are the ones in Task 3's table. Any *other* count movement is unexplained and must be chased.

**If the run reports ~552 failures, `node_modules` is missing** — re-create the symlink; it is not a regression.

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
grep -rn "mintIncubatingEgg(" bundles/ | grep -v node_modules | grep -v "^\s*\*"
```

Expected: the definition, plus **exactly two** call sites — `grantStarterEgg` and `recordHappyDay`, both in `eggs.js`. Any third caller is the bug this phase exists to remove. (Match on `mintIncubatingEgg(` with a trailing paren and filter comment lines: this plan writes the bare name into several doc comments, so an unfiltered `grep -rn "mintIncubatingEgg"` fires spuriously.)

- [ ] **Confirm the panel client rules held**

```bash
node scripts/run-suite.mjs tests/ramble-panel.test.js
```

The backtick and markup-sink invariants are **already enforced** by that file (the sink check at `tests/ramble-panel.test.js:776-779` strips comments and matches `/\.innerHTML\s*=|\bhtml:\s/g`, asserting 2). Do **not** add a raw `grep -c innerHTML` gate: the file contains the literal string `innerHTML` exactly twice today — once in the header comment at line 7 and once in the real sink at line 859 — while the *second* real sink is `html: nestEggHtml(` and contains no `innerHTML` at all. A raw grep reads 2 for the wrong reasons and would not notice a third real sink.

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
- **Deviation 4**: auto-promote runs ONLY on hatch and the trade-closing writes — never on a read path — and why a read-path promote both races the sync drain and launders `shelf_origin`.
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

**Say the laying floor's real reach out loud (K6).** Laying requires walking: without location fixes a player banks three happy days and then sits below the happy threshold for good, so the floor protects an irregular walker, not a housebound one. That is the accepted design, and the queued pedometer arc is what will change it.

Then: what shipped; that his current egg is grandfathered and will be the last one that arrives on its own; that after it hatches the slot stays empty unless the shelf has one; what the eggless card will say; the phone smoke test still outstanding from phase 2 (walk to one of the 14 heart pips); and anything the whole-branch review found.

**The game-state reset needs more than two tables — spell it out.** The prologue will not fire for Kevin until he resets, and clearing only `ramble_eggs` plus the `prologue.%` settings would start the "new game" with a full energy bar, a dangling `active_egg_id`, and a part-finished lay count. The full set is:

```sql
DELETE FROM ramble_eggs;                                  -- every egg and bird
DELETE FROM ramble_pet;                                   -- energy, mood, chores, active_egg_id, weekly counters
DELETE FROM ramble_credits;                               -- the warmth no-double-count ledger
DELETE FROM ramble_wallet WHERE kind IN ('layday','lay'); -- the lay count (KEEP seed and heart rows unless he wants those reset too)
DELETE FROM ramble_settings WHERE key LIKE 'prologue.%';  -- both dismissal flags
```

**⚠ And it must be done fleet-wide, or it undoes itself.** `ramble_eggs`, `ramble_pet`, `ramble_settings` and `ramble_wallet` are all in `SYNCED_TABLES`, so wiping one instance while another holds the rows means the next drain re-populates it. Ramble is currently installed on **grackle only**, so today this is a single-machine operation — but say so, because that stops being true the moment a second instance installs the bundle. Ask before running it; this is destructive and it is his save file.

---

## Out of scope — do not build these here

- The **game-state reset** itself. Kevin wants it "once these phases are complete" (after phase 4), and no reset affordance exists in Ramble today. This phase only guarantees a reset would *work* — the grant reads replicated egg data and the flags are ordinary settings rows.
- A shop, a wardrobe, an accessory catalogue, or any spend path (phase 4).
- The **pedometer / steps arc** (queued after phase 4, 2026-09-09). It would add an energy source and therefore make happy days easier, retuning this phase's floor — `lay.days` is a live setting, so that is a config change, not a redesign.
- D2's sad portrait to contacts, and any change to `servers/sharing/profile-avatar.js`.
- Sweeping the pet page's leftover keeper framing ("Still an egg", "My bird", the chore card). This phase fixes the framing only on surfaces it already rewrites; the rest is a copy pass of its own.
- Fixing phase 1 and 2's known follow-ups: `unlockedCellsNear`'s full-table read, the seed cooldown's global UTC bucket, the AR view carrying no hearts or seed, `.rb-mapbar` wrapping on a phone. None is made worse by this phase.

---

## Review

**Reviewer:** adversarial staff-engineer pass (Plan subagent), 2026-09-09, against the real code rather than the plan's description of it.

**Verdict: REVISE** — nine critical issues. The architecture and all three Findings were independently confirmed correct; the failures were all *mechanical accuracy*. Every issue is fixed in this document.

| # | Issue | Resolution |
|---|---|---|
| C1 | `GET /api/ramble/pet` would 500 for every eggless player: `routes.js:816` is `egg: { percent: egg.egg.percent }`. The plan patched `feed.js`'s `readPet` instead, which is private to `feedAll` and **is not on that code path at all** — so the real line would have stayed unpatched. This is the pet view, the only view an eggless player can reach from the perch. | Task 6 Step 4 now edits `routes.js:812-820` directly. |
| C2 | Editing `readPet` would break a green test the plan never listed: `tests/ramble-feed.test.js:68` asserts `Object.keys(repeat.pet)` equals `Object.keys(first.pet)`, and only `readPet` feeds one side. | `readPet` is now explicitly not touched, with the reason recorded so it is not "helpfully" changed later. |
| C3 | `recordHappyDay(db, { now, mood, emit })` inside `petState` is a **`ReferenceError`** — `petState(db, { now })` has no `emit` in scope — and `pet.js:18` documents "a GET must never queue a sync op". Neither caller passes an emit, so even adding the parameter would produce lay-days that never replicate. | The `petState` call site is removed entirely. Days are earned on the write path (`feed`, and `doChore` through it), which is also the truer reading of §4.3's "sustained care". A geolocation-denying player still banks days via chores and the check-in. |
| C4a | **`layProgress` did not converge.** `applyRambleWallet` does `created_at = MIN(local, incoming)` (`instance-sync.js:620`), so a sync apply can move a row's timestamp backwards across the reset boundary; clock skew between the user's own machines does it too. | Ordering moved to `key` (the `YYYY-MM-DD` local day) — half the primary key, lexically date-ordered, and never rewritten by the apply. Three multi-instance tests added, including one that applies a `created_at: 0` row and asserts the count does not move. |
| C4b | The mint ran unconditionally after `INSERT OR IGNORE` on the `lay` row, so the dedup key it had just written was decorative. | Gated on `rowsAffected === 1`. The remaining cross-instance case (two eggless instances crossing the threshold before a sync) is recorded as **Deviation 3** and accepted: it yields one spare shelf egg via the existing convergence rule, and the alternative — a deterministic egg id — reintroduces the cross-user collision that rules out a constant id for the starter egg. |
| C5 | Task 3 left the suite red and listed **none** of the four test files it breaks. Seven specific assertions, verified by grep, not hypothesised. | Task 3 now lists `ramble-eggs`, `ramble-flock`, `ramble-tools` and `ramble-panel`, carries a line-by-line table of what each assertion becomes, runs all of them in Step 7, and commits them. |
| C6 | **The plan's flagship regression test was vacuous.** `ramble_pet.energy` DEFAULTS TO 60 (`init-tables.js:105`), so `energy > 0` holds whether or not anything was fed, and the two `>=` comparisons hold when the feed is skipped — the test passed against the exact death spiral it existed to prevent. Phase 2's vacuous-fixture lesson, on the one test that most needed to be sharp. | Exact values: `60 → 65 → 80 → 100` with `assert.equal`, plus a negative control proving a repeat `visit_place` does not feed (without which an unconditionally-feeding implementation would also pass). |
| C7 | A **sixth** egg surface, missed: `hereArt()` (`static/ramble.js:236-241`) draws the walking egg from `seedFromEggId(null)` → seed 0, so a player with neither bird nor egg gets a phantom egg as their own map marker. And the plan's Global Constraint "you are never simultaneously birdless and eggless" is **false on the build this phase creates** — that is precisely the new-player window between first load and tapping **Go**. | `hereArt` falls through to the plain dot; the constraint is corrected and now flags that state as the most important one in the phase. |
| C8 | The AR fix was **dead on arrival**: `ramble-ar.js:378` runs `if (e.egg) setHidden(e.egg, valid)` every frame and un-hides the egg whenever there is no valid bird, overriding `startAr` within one frame. `ramble-ar.js` was not even in the file list. Worse, the accompanying test asserted the *presence of the ineffective line* — passing against a wrong implementation. | The guard moves into `paintBird` with a `hasEgg` term on the render frame; `ramble-ar.js` and `tests/ramble-ar.test.js` join Task 7; the test now asserts the renderer's behaviour. |
| C9 | Promote-on-read could **silently undo a deliberate `incubate` made on another instance**. `applyRambleEgg` carries an explicit carve-out (`instance-sync.js:855-860`) refusing to re-promote on a peer's user-shelve because the replacement row "follows in the same drain"; a GET landing in that window promoted the parked egg, set `shelf_origin = NULL` (the *top* convergence class), **and emitted** — beating the user's real choice on both machines. The two call sites also disagreed about `emit`. | `promoteFromShelf` gains an explicit `speculative` mode: read paths mark `shelf_origin = 'sync'` (which ranks below any NULL-origin egg) and **never emit**; only the hatch path clears the origin and emits. Both modes are tested. Deviation 4 rewritten to argue the real hazard rather than the irrelevant one. |

**Suggestions adopted:** the raw `grep -c innerHTML` gate dropped in favour of the existing comment-stripping check at `tests/ramble-panel.test.js:776-779` (the literal string appears twice for the wrong reasons — a header comment and one real sink — while the second real sink is `html:` and contains no `innerHTML`); the check-in confirmation no longer tells an eggless player "that is today's warmth" when the warmth vanished; the perch door reads "How you're doing" rather than a bare "You", keeping the affordance; `docs/guide/ramble.md:88` and its Spanish mirror added to Task 9 ("A new egg starts incubating immediately." is falsified just as line 68 is); the false claim that `panel/routes.js` imports the lock helpers corrected before it could ship in a comment (`flock.js` is the only importer); Task 8's hatch-beat hook specified as the `rb-meet-bird` handler with a `lastHatched` module var, since `clearHatch()` takes no argument, holds only a string key, and fires on any view change; a pinned test for the expired-but-unswept trade window; the full fleet-wide game-state reset enumerated for the hand-back, since clearing only eggs and flags would start the "new game" with a full energy bar and a part-finished lay count.

**Baseline gate softened, deliberately (reviewer Q5).** "A drop below 4340 means something was deleted" would misfire once Task 3 legitimately rewrites seven assertions. The gate is now: 0 fail, and every touched test file named in the PR with what changed — the only assertions permitted to change meaning are the ones in Task 3's table.

**Confirmed by the reviewer, needing no change:** Finding 1 is real (`feed.js:42`, `KEYED_TYPES` at `:14`) and chore/mark paths are genuinely unaffected — `chore` is not in `ACCEPTED_TYPES` and reaches `pet.js:feed` directly, while `mark_left`/`unlock_mark` are unkeyed so `shouldFeedPet` is unconditionally true. `ensureIncubatingEgg` has exactly the four claimed call sites, and nothing in `instance-sync.js`, `trades.js`, `delivery.js`, `claimNest` or `server.js` mints. Finding 2's quoted comment is real (`panel/ramble.js:311-313`) and the Next-egg card genuinely is the only route to the check-in. Finding 3 is real (`identity.js:136` — `randomBytes(32)` per instance). Task 3's trade fixtures are schema-valid and `OPEN_SQL` really is `"state IN ('proposed','accepted')"`. The `delta = 1` discipline matches `hearts.js`. The `eggs -> trades -> eggs` cycle Task 1 breaks is real and `flock.js:22` is the only external importer. Same-instance concurrent double-lay is already impossible via `INSERT OR IGNORE`. Privacy holds — no egg, lay-day or balance reaches a contact-facing payload. No schema change is needed. `mods.eggsMod` is a namespace import, so new exports are reachable automatically.

---

### Second review (2026-09-09), scoped to round 1's fixes

**Verdict: REVISE.** C1/C2, C4a, C4b and C6 were confirmed genuinely and precisely correct. But **the fixes to C5, C7, C8 and C9 each introduced new defects**, and C3's fix left behind a justification that is arithmetically false — the phase 2 pattern exactly, on the revised passages.

| # | Issue | Resolution |
|---|---|---|
| N1 | Task 7's copy test asserted `"Nothing warming just now."` against the CLIENT (Task 7 puts it in the server shell) and a `"good days"` literal the client never contains — it is concatenated around a pluralised `day`/`days`. Two of three assertions would fail. | Split across the two files; asserts the real literals. |
| N2 | **The C8 AR fix was a `ReferenceError`.** `frame` is a local of `render(state)` (`ramble-ar.js:400`), not of `paintBird(bird)` (`:375`) — `frame.hasEgg` throws on every AR frame. "Set `hasEgg` where the frame is built" was also not actionable. | Three exact edits given: `static/ramble.js:2125` supplies the flag, `ramble-ar.js:228` carries it onto the frame, `:375`/`:435` pass it as an argument. |
| N3 | The AR files were in Task 7's Files list but **not in its commit**, and the plan forbids `git add -A` — so the fix would never have been committed. `tests/ramble-ar.test.js` was never run either. | Both added to the commit and to Step 6. |
| N4 | `tests/ramble-ar.test.js:245` renders `bird: null` and asserts the egg is NOT hidden; with `hasEgg` absent it becomes hidden and the test goes red. Unlisted. | Listed, with `hasEgg: true` there plus a new no-bird-no-egg case. |
| N5 | **C7's fix did not work on a repaint.** `paintHereArt` does `if (art) hereDot.setIcon(...)`, so a `null` skips `setIcon` entirely and the marker keeps its last icon — only first paint reaches `hereIcon`'s plain-dot fallback. A player who became eggless while birdless would keep the phantom egg. | `setIcon` made unconditional; `hereIcon(null)` is the documented plain-dot path. |
| N6 | Task 3's prescribed rewrite for `tests/ramble-flock.test.js:150` was wrong: the shelf is NOT empty there, so after the hatch `promoteFromShelf` draws the parked egg back and the count stays 1. Following the table literally fails. | Corrected to assert the parked egg is promoted back. |
| N7 | `tests/ramble-flock.test.js:174` broke because the C9 fix made `flockState` promote on read. | Moot — the read-path promote is deleted entirely (N11). Flagged to be re-verified rather than assumed. |
| N8 | The C5 table **misattributed the breakage to Task 3**; most of it lands at Task 2, where `eggState` stops minting — and Task 2 listed neither `ramble-panel` nor `ramble-tools`. Twelve further red assertions enumerated. The suite would have been red from Task 2 through Task 6, the precise failure C5 was raised about. | The Task 2 table now carries them, with the files, the Step 7 runs and the commit. |
| N9 | Task 6's four new route tests **cannot pass in `tests/ramble-panel.test.js`**: it shares one db across the file in declaration order, so an egg already exists (nest claim at `:1186`), and `POST /api/ramble/area` at `:458` already banked a `layday` row (fresh pet 60 → 75 → happy while eggless). | Moved to a new `tests/ramble-prologue-routes.test.js` with a per-test scratch db. |
| N10 | Task 6 Step 5's `server.js` snippet used the route's variable name (`eggSummary`; the local there is `egg`) and called `layProgress`, which is not imported at `server.js:30`. `ramble_egg_state` at `:319` was also left without `lay`, so the tool and the route would disagree — the divergence the step exists to prevent. | Real names, the import, and `lay` on both tools. |
| N11 | **The C9 fix laundered provenance.** Marking a read-path promote `shelf_origin='sync'` ranks it correctly, but `flock.js:126` counts `'user'` shelf eggs for the nest cap, `flock.js:253` for `shelf_count`, `instance-sync.js:831` rewrites demotions to `'sync'` unconditionally, `RAMBLE_EGG_REPROMOTE_SQL` drafts `'sync'` only, and `static/ramble.js:1776` labels `'sync'` as "came back from another of your Crows". A user egg relabelled 'sync' silently widens the shelf cap, is under-reported, becomes draftable by the very rule the 'user' mark protects it from, and is mislabelled. | **The read-path promote is DELETED.** Following the reviewer's closing question: once `'user'` eggs are excluded the only speculative case left is a `'sync'` egg, which `RAMBLE_EGG_REPROMOTE_SQL` already refills in the same apply batch — so the write during a GET buys nothing. `promoteFromShelf` is now single-mode and called from `hatchIfReady` alone. Deviation 4 rewritten. This is a simplification the review produced, not a patch. |
| N12 | **C3's justification was arithmetically false.** "A player who denies geolocation can still bank days" — decay is 10 per 6 h (−40/day) against a maximum of `checkin 5 + 3 × chore 8 = 29/day`, so from the default 60 they bank three happy days and then sit below the threshold permanently. | The claim is deleted from both places and replaced with the arithmetic and an explicit "laying requires real movement". **Raised with Kevin as a design question**, not silently accepted — see below. |
| N13 | S2's check-in copy branched on a `hasEgg` that does not exist: the handler sees `{ credited, warmth, hatched }` and `eggSeedId` is stale until `refreshEgg()` runs afterwards. | The check-in route now returns `egg`, listed in Task 6's interfaces. |

**Suggestions adopted:** `tests/ramble-eggs.test.js:58`'s rewrite would have left nothing anywhere asserting a non-zero `percent` — a positive case is now required alongside it; `ramble_egg_state` carries `lay`; `PROLOGUE_KEYS` uses `Object.hasOwn`, since a plain literal makes `setPrologueSeen(db, "constructor")` bind a function into the SQL args instead of throwing; the final-verification grep matches `mintIncubatingEgg(` and filters comment lines, because this plan writes the bare name into several doc comments and the unfiltered grep fires spuriously.

**Recorded for a future second instance (reviewer suggestion 1):** Deviation 3 accepts two eggs per lay on a two-instance fleet. A deterministic id *is* available without the cross-user collision that rules out a constant — derive it from `lay:<day>` plus a per-user random salt written once into `ramble_settings`, which replicates (unlike `crowId`). Accepting remains right for now: Ramble is on grackle only, and the spare lands as `shelf_origin='sync'`, so it does not even consume the nest shelf cap. The salt is recorded so a second instance is a cheap change rather than a redesign.

**Confirmed correct in round 2, not to be revisited:** the `routes.js:812-820` replacement (every field exactly once, `mods.eggsMod` is a namespace import so `layProgress` is reachable, no other nullable-egg dereference survives in `routes.js`); `readPet` genuinely private to `feedAll` and off the pet path; `feed` has `emit` in scope and `doChore` reaches it; `layProgress`'s key-ordered SQL (TEXT `MAX(key)` over `YYYY-MM-DD` is chronological, `COALESCE(…, '')` includes everything when no lay exists, and the threshold day is counted before the `lay` row is written and excluded after — no off-by-one); the multi-instance tests would genuinely fail the `created_at` implementation they rule out; C4b cannot fail to lay; every number in the C6 energy test (default 60, ceiling 100 with no hearts, deltas 5/15/20, and no decay possible between the timestamps used); the check-in does route through `pet.js:feed`; a pet at the ceiling still records a day; `'sync'` genuinely ranks below NULL in `applyRambleEgg`; no re-shelve loop exists and `hatchIfReady` handles a `'sync'`-origin incubating egg; Task 9's quoted doc lines are verbatim in both languages; and all four hard constraints hold.

---

### Third review (2026-09-09), scoped to round 2's fixes

**Verdict: REVISE.** Round 2's fixes were materially better — the AR line references, the `hereIcon`/`paintHereArt` analysis, the `flock.test.js:150` re-derivation, the `server.js` names and all twelve N8 line numbers were verified exact. But three were incomplete enough to stop execution, and the N11 deletion left a claim that was wrong about game behaviour.

| # | Issue | Resolution |
|---|---|---|
| T1 | **Task 2 broke `flock.js` at module load.** `flock.js:20` imports `ensureIncubatingEgg` **by name**; Task 2 renamed the export but did not list, edit or commit `flock.js` — a `SyntaxError` taking down three of the five suites Task 2's own Step 7 requires green. Its verification grep also mis-stated the expected output and cited `instance-sync.js:726` (really `:733`) inside a grep scoped to `tests/ bundles/`, where it can never appear. | `flock.js` added to Task 2's Files, `sed` list and commit; the grep note corrected. |
| T2 | The new `tests/ramble-prologue-routes.test.js` was **orphaned** — absent from the Files list, both run-steps, the `git add` and the commit. With `git add -A` forbidden, N3's failure mode reproduced verbatim. | Wired into all five places, and into the global File-structure list. |
| T3 | **N9's harness was not executable.** `rambleRouter` takes only an injected `emit`; the db is built inside the closure by `createDbClient()` from `CROW_DATA_DIR` and memoized, so no `createClient` handle can be passed in. | Replaced with the achievable thing: copy `ramble-panel.test.js:28-44`'s mkdtemp harness and rely on one virgin db plus declaration order — none of these four routes mints or feeds. The per-test alternative (fresh `CROW_DB_PATH` **and** a fresh router+app) is written down rather than implied. |
| T4 | N13's check-in fix was split across two tasks and landed in neither: the route edit was described in Task 7 but belongs to Task 6, was absent from Task 6's interfaces, and Task 7's commit omits `routes.js`. **And the client snippet dropped the not-credited arm**, so a second same-day tap would read "Checked in. That is today's warmth." — a fresh lie on the screen the change exists to stop lying on. | The route edit now has a home and an interface line in Task 6; the client branch is three-way; Task 7 carries a fallback commit if the edit is made there. |
| T5 | Task 6 Step 3 still told the implementer to make `promoteFromShelf` reachable from the routes — the exact invitation N11 removed — and the PR-body checklist still promised "auto-promote runs on read paths", mis-numbered as Deviation 3. As written the PR body would state a falsehood about the branch. | Both corrected. |
| T6 | **Deviation 4's "costs one case" was false, and the gap is a deadlock.** With the read-path promote gone, nothing calls `promoteFromShelf` after a trade closes. A user who offers their only shelf egg in a swap and then hatches is left with an empty slot, **laying also blocked** (`hasAnyEggAnywhere` counts the locked egg), and warmth vanishing — recoverable only by noticing and tapping "incubate". The expired-trade test's "harmless… until the sweep" comment described round-1 behaviour that N11 removed. | New **Task 3 Step 5b**: `receiveTrade`, `declineSwap` and `expireTrades` call `promoteFromShelf`. These are writes, so none of N11's drain-race or provenance objections apply, and `trades.js` already imports from `eggs.js` (`:32`) so there is no cycle. The docstring now carries an honest inventory of every emptier, including the one genuinely uncovered case (a slot emptied by `applyRambleEgg` while only `'user'` shelf eggs remain — unreachable on a one-instance fleet). |

**Secondary fixes applied:** the `flockState` import in `tests/ramble-eggs-supply.test.js` (lost when an earlier edit script aborted before writing — the reviewer caught it); the stale global File-structure entry claiming `feed.js`'s `readPet` carries the egg summary, which Task 6 explicitly forbids; `ramble-ar.js`, `ramble-ar.test.js` and `ramble-prologue-routes.test.js` added to that list; Task 1's comment naming `panel/routes.js` as an importer of the lock helpers when `flock.js:22` and `tests/ramble-trades.test.js:14` are the only ones — the same false-claim class as round 1's S7, caught a second time; `tests/ramble-feed.test.js` added to Task 4's run; and the `ramble-tools:177` / `ramble-panel:1227` rows moved out of Task 3's table into Task 2, where they actually break, along with `:1228`, `:1234`, `:1239` and `:1347`, all repaired at once by minting one egg in each harness's setup.

**Kevin's ruling K6, recorded during this round.** The reviewer proved the laying floor is unreachable without walking. Kevin's decision: **leave it — laying requires walking**, do not retune decay, chore values or `lay.days`, and let the queued pedometer arc (after phase 4) supply the missing indoor energy input rather than bending the curve now. The hand-back must say this plainly so it does not read as an oversight.

**Confirmed correct in round 3:** all four AR line references and the state-contract comment at `ramble-ar.js:8`; the proposed AR test regex matches the proposed code; `tests/ramble-ar.test.js:245`/`:242` are exactly the assertions affected and `:218` is not; `hereIcon(null)` genuinely yields the plain dot and unconditional `setIcon` causes no churn or lost aria-label; the `flock.test.js:150` re-derivation; every `server.js` name and line; the N1 two-file split; all twelve N8 line references (spot-checked 12 of 12); that gifts and swaps provably cannot empty the incubating slot; and all four hard constraints, with `init-tables.js`'s comment sitting below every line the plan cites so no reference moves.

**Line-number drift noted, cosmetic, not corrected in the task tables:** `tests/ramble-eggs.test.js` `:49→:50`, `:71→:73`, `:82→:84`; `flock.js:126→:125`; `init-tables.js:105→:104`; `tests/ramble-flock.test.js:174→:173`. Implementers should grep for the quoted assertion text rather than trusting a line number — which is the right habit anyway on a branch that rewrites these files.

---

### Fourth review (2026-09-09), scoped to round 3's fixes

**Verdict: REVISE**, and all five criticals landed on **one** fix — round 3's Task 3 Step 5b, the `trades.js` promote. T1, T2, T3, T4 and T5 were each verified genuinely fixed. The reviewer also walked all nine tasks and confirmed the suite is green at the end of every one of them except Task 3.

**Step 5b is reverted, not repaired.** Its five defects were: `trades.js` was never added to Task 3's Files or its commit (the never-committed-edit failure, for the third round running); `receiveTrade` has no single "end" — it is an `if/return` chain whose textual tail is the `'expired'` no-op path, so the prescribed call would have run on nothing; it took `tests/ramble-trades.test.js` and `tests/ramble-transport.test.js` red across ten assertions, and `ramble-transport.test.js` appears **nowhere** in this plan; plain gifts go through `receiveGift`, not `receiveTrade`, so the docstring's claim that gifts were covered was false; and — decisively — **promoting inside `expireTrades` strands an in-flight `completed` envelope**: the hand-over `UPDATE … WHERE status IN ('shelf','received')` then matches nothing while `receivedEggStatement` still inserts, so the user keeps **both** eggs.

Manufacturing a free-egg race in the phase built to remove the free egg is not a trade worth making. And the underlying complaint was never "the slot is empty" — it was that the player had **no signal and no way back**. That is an affordance problem, so it now gets an affordance:

- `nextPromotable(db)` is extracted as a pure read, and `promoteFromShelf` uses it — so the card and the promote read exactly **one** rule, with a test asserting they agree. (This is the map/payout discipline phase 1 had to learn.)
- `GET /api/ramble/egg` and `GET /api/ramble/pet` carry `shelf_waiting`.
- The Next-egg card says **"One's waiting on your shelf."** with a **Warm it** button wired to the already-shipped `incubate()` / `POST /api/ramble/eggs/:id/incubate` — no new endpoint.
- The lay line is suppressed while an egg waits, because the player is not eggless and it must not say they are.

`promoteFromShelf` is once again called from exactly one place, `hatchIfReady`, which is what its docstring and interface block always claimed.

**Round 4's secondaries, all applied:** Task 2 Step 7 now re-runs the three `sed`-touched suites it commits; the flock-family assertions (`ramble-tools:177`, `ramble-panel:1227/1228/1234/1239`) moved **back** to Task 3, because round 3's move to Task 2 rested on "nothing mints from Task 2 onward" and that is false — Task 2 only renames `flock.js`'s mint, and `flockState` keeps minting until Task 3 Step 5 (`ramble-panel:1347` genuinely does break at Task 2 and stays there); Task 1's re-export comment corrected for the **third** time, having been flagged in rounds 1, 3 and 4 while sitting three lines above the warning that corrects it; `tests/ramble-ar.test.js` added to the global File-structure list; the two divergent spellings of the check-in `egg` line collapsed to one; the AR `render({…})` snippet's leading-comma syntax error fixed and its fields spelled out; and T3's harness citation corrected from a single wrong range to the four real ones, including the `after()` teardown without which the new test file leaks a socket and a temp dir.

**Confirmed fixed in round 4:** T1 (`flock.js` in Task 2's Files, `sed` list and commit — and Task 2 legitimately ends green with `flock.js` still minting, since the purity test arrives in Task 3); T2 (the new test file wired into all five places); T3 (the "declaration order is enough" reasoning verified true — none of the four routes mints or feeds, and `recordHappyDay` is reachable only from `pet.js:feed`); T4 (route edit homed in Task 6 with an interface line; `$("rb-egg-status")` and `out` verified correct; the three-way branch preserves the not-credited arm); T5 (no stale invitation, correct deviation number). Also re-verified: `routes.js:816`, `server.js:30/306/319`, the `eggs.js` and `pet.js` line cites, `hereArt`/`paintHereArt`, and that `egg-locks.js` trips neither `bundle-server-deps` nor `bundle-contract`.

**Superseded:** the round-3 record's T6 row describes Step 5b as the resolution. It is not — Step 5b was reverted here. Read this section, not that row.
