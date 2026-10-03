# Ramble Phase 4 — Accessories, Wardrobe and Shop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bird seed finally buys something: a shared wardrobe of hats, scarves and glasses that any hatched bird can wear, shown on the user's own surfaces and in the profile picture contacts receive (which now also carries the bird's real mood), never on public marks.

**Architecture:** Purchases are `ramble_wallet` ledger rows (`kind='spend'`, one unique key per purchase, negative delta), so ownership and the seed balance are both derived and converge across the user's instances. What a bird wears is one new replicated column on its `ramble_eggs` row (`outfit_json`), layered over the rolled genome by a new engine helper `applyOutfit` so every render site picks it up. Core's profile-picture refresh gains the real mood and the outfit, and its triggers are debounced (coalesced) plus a periodic tick so mood decay and remote outfit changes reach contacts without a broadcast per change.

**Tech Stack:** Node 24 ESM, `@libsql/client`, Express router (bundle panel routes), `node:test`, dependency-free dual Node/browser engine (`bird-svg.cjs`, ES5, no ESM syntax), ES5 panel client.

**Spec:** `docs/superpowers/specs/2026-09-08-ramble-reward-economy-design.md` — §5 (Accessories), §6.1 (ledgers not balances), §6.2/§6.3 (state + migration), §7, §8, §9 phase 4; decisions D2, D7, D10, D11.

## Global Constraints

- Bundle code change ⇒ `bundles/ramble/manifest.json` version bump: **0.12.1 → 0.13.0**, and `registry/add-ons.json` regenerated with `npm run build-registry` (CI runs `build-registry --check`).
- **Balances must not be stored as balances** (spec §6.1). A spend is a ledger row. A spend row MUST be keyed uniquely per purchase, never by something coarse, because `applyRambleWallet` resolves a key conflict with `MAX(delta)` (servers/sharing/instance-sync.js comment "PHASE 2, READ THIS BEFORE ADDING SPENDING").
- **D10 — accessories are contacts-only.** Public marks keep the plain rolled bird. `activeBird()` (eggs.js), which mark authoring uses, MUST NOT gain an outfit. `GET /api/ramble/bird/:species/:seed.svg` (used for other people's pins) stays plain.
- **D11 — shared wardrobe, per-bird outfit.** Buy once; any bird may wear it; each bird remembers its own outfit.
- **§5.4 — broadcast pacing is a requirement:** outfit changes and mood threshold crossings must coalesce into at most one profile broadcast per settled state, on a short delay.
- **§5.5 — surface:** the shop/wardrobe is a SHEET reached from the pet view, not a fifth top-level view.
- **§6.3 — migration:** additive, guarded `ensureColumn`, **no `SCHEMA_GENERATION` bump**. Ramble tables are created by `bundles/ramble/server/init-tables.js` only (they are not in `scripts/init-db.js`).
- **D2 (folded into this phase by Kevin's phase-2 ruling, which deferred it precisely because it "drags §5.4's broadcast coalescing forward"):** a neglected bird's portrait looks sad to contacts — the profile picture uses the real mood (`happy` ≥ 60, `tired` ≥ 30, else `alarmed`), not a hardcoded `"happy"`.
- Engine `bird-svg.cjs`: dependency-free, classic script, **no ESM syntax** (a test enforces it), ES5 only. A bird with no outfit must draw **byte-identically** to today.
- `bundles/ramble/panel/ramble.js` (the HTML) and `servers/gateway/dashboard/shared/notifications.js` (lines ~1000–1237) are **inside JS template literals — never write a backtick or `${` in code you add there** except as the existing `${icon(...)}` / `${esc(...)}` template interpolations in ramble.js's HTML.
- `hidden` does nothing on an `<svg>` element (it is an HTMLElement property). Do not rely on hiding an svg.
- Copy register: plain, warm, slightly hushed (existing lines: "Something's stirring in there", "Getting out is worth more than tapping."). The player IS the bird (pet page uses first person: "How you're doing", "The next you").
- Accessory prices live in the catalogue (`wardrobe.js`), not in settings (spec §6.4 last line).
- Commits: always `git commit <paths> -m "..."` with explicit paths (never a bare `git commit` after `git add`); the worktree carries an untracked `node_modules` symlink that must never be committed. No Claude attribution in commit messages.
- Tests: run single files with `npm test -- tests/<file>.test.js` (scratch env; NEVER raw `node --test`, which writes the live crow.db). Full suite: `npm test`.

## Review Focus

1. **Two of the user's instances buy while out of contact.** Expect: each local buy is refused unless the local balance covers it; after sync both instances show the SAME balance and owned set in any arrival order; the balance may legitimately go negative (two instances each spent the same seed) and the shop must show it without breaking and refuse further buys. Same item bought on both: owned once, charged twice — accepted and documented. (Task 2 + Task 4 tests.)
2. **A bird whose rolled genome already has a hat wears a bought hat, then takes it off.** Expect: the bought hat replaces the rolled one while worn; taking it off restores the ROLLED hat (not bare); public marks and the per-pin bird route still draw the rolled bird throughout. (Task 1 + Task 3 tests.)
3. **An outfit row arrives at an instance whose `ramble_eggs` table predates the column** (core upgraded, bundle copy older; or a sync apply landing before the bundle's `initRambleTables` ran). Expect: the apply succeeds and the outfit is stored, never a thrown apply. (Task 4 test.)
4. **Rapid try-ons, and a mood threshold crossed while nobody has the app open.** Expect: four outfit changes inside the settle window produce exactly ONE broadcast carrying the final state; a decay-driven mood change reaches the profile picture on the periodic tick with no user action; an unchanged portrait never re-broadcasts. (Task 6 tests.)
5. **A malformed or future `outfit_json`** (hand-edited, truncated JSON, a value from a newer version such as `{"glasses":"monocle"}`, a non-object, `__proto__` keys). Expect: unknown slots/values are dropped, rendering never throws, the API never 500s. (Task 1 + Task 3 + Task 6 tests.)

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `bundles/ramble/server/bird-svg.cjs` | Modify | `OUTFIT_SLOTS`, `applyOutfit(g, outfit)`, scarf + glasses artwork in `drawBird` |
| `bundles/ramble/server/wardrobe.js` | Create | Catalogue, `parseOutfit`, purchase ledger (`buyItem`, `ownedItems`), wearing (`wearItem`, `birdOutfit`), `wardrobeState` |
| `bundles/ramble/server/wallet.js` | Modify | `seedBalance` subtracts spends (`kind IN ('seed','spend')`); export `SPEND_KIND` |
| `bundles/ramble/server/init-tables.js` | Modify | guarded `ramble_eggs.outfit_json TEXT` |
| `bundles/ramble/server/flock.js` | Modify | `flockState` birds carry `outfit` |
| `bundles/ramble/server/pet.js` | Modify | export `DECAY_INTERVAL_MS`, `DECAY_PER_INTERVAL` (parity test target) |
| `servers/sharing/instance-sync.js` | Modify | `outfit_json` in `RAMBLE_EGG_WIRE_COLUMNS`; lazy guarded column before an egg apply |
| `bundles/ramble/panel/routes.js` | Modify | `wardrobeMod`; `GET /api/ramble/wardrobe`, `POST /api/ramble/wardrobe/buy`, `POST /api/ramble/birds/:id/outfit`; `bird.outfit` on `GET /api/ramble/pet`; poke `ramble:outfit-changed` |
| `servers/sharing/profile-avatar.js` | Modify | `portraitMood`, `readPortrait`; mood + outfit in `renderBirdAvatar`; debounced triggers + periodic tick in `installBirdAvatarHooks` |
| `bundles/ramble/panel/ramble.js` | Modify | Wardrobe button on the pet view + `#rb-wardrobe-sheet` HTML |
| `bundles/ramble/panel/static/ramble.js` | Modify | `birdGenome` helper at every own-bird site; wardrobe sheet logic incl. pure `wardrobeRowState` |
| `bundles/ramble/panel/static/ramble-ar.js` | Modify | own bird in AR wears its outfit |
| `bundles/ramble/panel/static/ramble.css` | Modify | wardrobe sheet styles |
| `servers/gateway/dashboard/shared/notifications.js` | Modify | header perch bird wears its outfit |
| `docs/guide/ramble.md`, `docs/es/guide/ramble.md` | Modify | "Wardrobe" section, mood-in-portrait note |
| `bundles/ramble/manifest.json`, `registry/add-ons.json` | Modify | 0.13.0 |
| Tests | Create/Modify | `tests/ramble-bird-svg.test.js`, `tests/ramble-wardrobe.test.js`, `tests/ramble-wardrobe-sync.test.js`, `tests/ramble-wardrobe-routes.test.js`, `tests/profile-avatar-bird.test.js`, `tests/ramble-panel.test.js` |

---

### Task 1: Engine — outfit slots, `applyOutfit`, scarf and glasses artwork

**Files:**
- Modify: `bundles/ramble/server/bird-svg.cjs`
- Test: `tests/ramble-bird-svg.test.js`

**Interfaces:**
- Produces: `RambleBird.OUTFIT_SLOTS` = `{ hat: ["bow","leaf","beanie"], scarf: ["knit","stripe"], glasses: ["round","shades"] }`; `RambleBird.applyOutfit(genome, outfit) -> genome` (a NEW object; never mutates its input; only known slot+value pairs are applied; `outfit` may be null/undefined/anything). `drawBird` draws `g.scarf` and `g.glasses` when they hold a known value.

- [ ] **Step 1: Write the failing tests** — append to `tests/ramble-bird-svg.test.js`:

```js
import { createHash } from "node:crypto";

// Golden hash of drawBird over every species x 4 seeds x 3 moods, computed
// from the engine on origin/main @09ae235f BEFORE this task. An outfit-less
// bird must draw byte-identically forever: public marks render it.
const GOLDEN_PLAIN = "548d1335887eb44323fddd71128c77ce2cddcb2ebed5066bbfbf76b735ba09e7";
test("a bird with no outfit draws byte-identically to the pre-wardrobe engine", () => {
  let s = "";
  for (const sp of Bird.ROSTER) for (const seed of [1, 7, 123456, 4294967295]) for (const m of ["happy", "tired", "alarmed"]) {
    s += Bird.drawBird(Bird.rollGenome(seed, sp), m);
  }
  assert.equal(createHash("sha256").update(s).digest("hex"), GOLDEN_PLAIN);
  // and applyOutfit with nothing to apply is also a no-op on the drawing
  const g = Bird.rollGenome(7, "magpie");
  assert.equal(Bird.drawBird(Bird.applyOutfit(g, {})), Bird.drawBird(g));
  assert.equal(Bird.drawBird(Bird.applyOutfit(g, null)), Bird.drawBird(g));
});

test("OUTFIT_SLOTS is the catalogue's art vocabulary", () => {
  assert.deepEqual(Bird.OUTFIT_SLOTS, { hat: ["bow", "leaf", "beanie"], scarf: ["knit", "stripe"], glasses: ["round", "shades"] });
});

test("applyOutfit layers over the rolled genome without mutating it", () => {
  const rolled = Bird.rollGenome(1, "crow"); // crow seed 1 rolls a bow
  assert.equal(rolled.hat, "bow");
  const before = JSON.stringify(rolled);
  const worn = Bird.applyOutfit(rolled, { hat: "beanie", scarf: "knit", glasses: "shades" });
  assert.equal(JSON.stringify(rolled), before, "input untouched");
  assert.equal(worn.hat, "beanie");
  assert.equal(worn.scarf, "knit");
  assert.equal(worn.glasses, "shades");
  assert.equal(worn.seed, rolled.seed);
  // Taking the hat off = no hat key in the outfit = the ROLLED hat comes back.
  assert.equal(Bird.applyOutfit(rolled, { scarf: "knit" }).hat, "bow");
});

test("applyOutfit drops unknown slots, unknown values and junk — never throws", () => {
  const g = Bird.rollGenome(2, "crow"); // crow seed 2 rolls no hat
  for (const junk of [undefined, null, 42, "hat", [], { hat: "monocle" }, { glasses: "monocle" }, { wings: "big" }, { hat: 7 }, JSON.parse('{"__proto__":{"hat":"bow"}}')]) {
    const out = Bird.applyOutfit(g, junk);
    assert.equal(out.hat, g.hat, JSON.stringify(junk));
    assert.equal(out.scarf, undefined);
    assert.equal(out.glasses, undefined);
    assert.equal(Bird.drawBird(out), Bird.drawBird(g));
  }
  assert.equal(({}).hat, undefined, "no prototype pollution");
});

test("every scarf and glasses value draws, differently, and the value text never reaches the SVG", () => {
  const g = Bird.rollGenome(2, "crow");
  const plain = Bird.drawBird(g);
  const seen = new Set([plain]);
  for (const slot of ["scarf", "glasses"]) for (const v of Bird.OUTFIT_SLOTS[slot]) {
    const svg = Bird.drawBird(Bird.applyOutfit(g, { [slot]: v }));
    assert.ok(!seen.has(svg), `${slot}=${v} changes the drawing`);
    seen.add(svg);
    for (const mood of ["happy", "tired", "alarmed"]) assert.ok(Bird.drawBird(Bird.applyOutfit(g, { [slot]: v }), mood).startsWith("<g"));
  }
  for (const v of Bird.OUTFIT_SLOTS.hat) {
    assert.ok(Bird.drawBird(Bird.applyOutfit(g, { hat: v })) !== plain, `hat=${v} draws`);
  }
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- tests/ramble-bird-svg.test.js`
Expected: the golden test PASSES (nothing changed yet — this proves the hash is right); the other four FAIL (`Bird.applyOutfit is not a function` / `OUTFIT_SLOTS` undefined).

- [ ] **Step 3: Implement** — in `bird-svg.cjs`:

After the `HATS` line add:
```js
  /* What can be WORN (phase 4, spec §5). The hat values are the existing
   * rolled-hat vocabulary; scarf and glasses are new slots a rolled genome
   * never has, so a bird with no outfit draws exactly as it always did. */
  var OUTFIT_SLOTS = { hat: ["bow","leaf","beanie"], scarf: ["knit","stripe"], glasses: ["round","shades"] };
```

Before `function drawBird` add:
```js
  /* Layer what a bird is wearing over its rolled genome. A NEW object: the
   * rolled genome is identity, never edited. Only known slot+value pairs are
   * copied, iterating OUR slot table (never the input's keys), so junk, a
   * future value from a newer version, or a __proto__ key is simply ignored.
   * No hat in the outfit = the rolled hat stays. */
  function applyOutfit(g, outfit) {
    var out = {}, k;
    for (k in g) if (Object.prototype.hasOwnProperty.call(g, k)) out[k] = g[k];
    if (!outfit || typeof outfit !== "object") return out;
    for (k in OUTFIT_SLOTS) {
      if (!Object.prototype.hasOwnProperty.call(OUTFIT_SLOTS, k)) continue;
      if (!Object.prototype.hasOwnProperty.call(outfit, k)) continue;
      var v = outfit[k];
      if (typeof v === "string" && OUTFIT_SLOTS[k].indexOf(v) >= 0) out[k] = v;
    }
    return out;
  }
```

Inside `drawBird`, after the `hat` block and before `var crest`:
```js
    /* Scarf and glasses: drawn only for a known value, and the value is only
     * ever COMPARED, never written into the markup. */
    var scarf = "";
    if (g.scarf === "knit" || g.scarf === "stripe") {
      var dash = g.scarf === "stripe" ? ' stroke-dasharray="6 5"' : "";
      scarf = '<path d="M' + n(cx - 28) + ' ' + n(cy - 26) + ' q 28 13 56 0" stroke="' + g.accent + '" stroke-width="10" fill="none" stroke-linecap="round"/>' +
        (g.scarf === "stripe" ? '<path d="M' + n(cx - 28) + ' ' + n(cy - 26) + ' q 28 13 56 0" stroke="#fff" stroke-width="10" fill="none"' + dash + ' opacity=".55"/>' : "") +
        '<path d="M' + n(cx - 16) + ' ' + n(cy - 22) + ' l -7 24 l 10 -2 z" fill="' + g.accent + '"/>';
    }
    var glasses = "";
    if (g.glasses === "round" || g.glasses === "shades") {
      glasses = '<g stroke="#1a1a1a" stroke-width="2.6" stroke-linecap="round">' +
        '<circle cx="' + n(ex) + '" cy="' + n(ey) + '" r="10.5" fill="' + (g.glasses === "shades" ? "#1a1a1a" : "none") + '"' + (g.glasses === "shades" ? ' fill-opacity=".88"' : "") + '/>' +
        '<path d="M' + n(ex - 10.5) + ' ' + n(ey - 1) + ' L' + n(ex - 27) + ' ' + n(ey - 4) + '" fill="none"/></g>' +
        (g.glasses === "shades" ? '<path d="M' + n(ex - 4) + ' ' + n(ey - 5) + ' l 5 -2" stroke="#fff" stroke-width="2" stroke-linecap="round" opacity=".7"/>' : "");
    }
```

Change the final concatenation `crest + hat + marks + cheeks + eye + beak + alarm` to `crest + hat + marks + scarf + cheeks + eye + glasses + beak + alarm`.

Add `OUTFIT_SLOTS: OUTFIT_SLOTS, applyOutfit: applyOutfit` to the returned API object.

- [ ] **Step 4: Run to verify they pass**

Run: `npm test -- tests/ramble-bird-svg.test.js`
Expected: all PASS, including the pre-existing "no ESM syntax" test and the golden hash.

- [ ] **Step 5: Commit**

```bash
git commit bundles/ramble/server/bird-svg.cjs tests/ramble-bird-svg.test.js -m "feat(ramble): outfit slots + applyOutfit + scarf/glasses art in the bird engine"
```

---

### Task 2: The wardrobe ledger — catalogue, buying, a balance that subtracts spends

**Files:**
- Create: `bundles/ramble/server/wardrobe.js`
- Modify: `bundles/ramble/server/wallet.js` (`seedBalance`, export `SPEND_KIND`)
- Test: `tests/ramble-wardrobe.test.js` (create)

**Interfaces:**
- Consumes: `seedBalance(db)` and `SEED_KIND` from `wallet.js`; `OUTFIT_SLOTS` from `bird-svg.cjs` (via `createRequire`, as `flock.js` does).
- Produces (`wardrobe.js`):
  - `ACCESSORIES: Array<{ id: string, slot: "hat"|"scarf"|"glasses", value: string, name: string, price: number }>`
  - `itemById(id) -> item | null`
  - `ownedItems(db) -> Promise<Set<string>>` (item ids)
  - `buyItem(db, itemId, { now, emit, purchaseId }) -> Promise<{ ok: true, item, balance } | { ok: false, reason: "unknown-item"|"owned"|"short", balance }>`
- Produces (`wallet.js`): `export const SPEND_KIND = "spend"`; `seedBalance(db)` = `SUM(delta)` over `kind IN ('seed','spend')`.

Ledger shape: a purchase is ONE row `{ kind: "spend", key: "<itemId>:<purchaseId>", delta: -price, created_at }`, `purchaseId` a fresh `randomUUID()` (overridable for tests). The key is unique per purchase so `applyRambleWallet`'s `MAX(delta)` never arbitrates money.

- [ ] **Step 1: Write the failing tests** — `tests/ramble-wardrobe.test.js`:

```js
/**
 * Spec 2026-09-08 §5, §6.1 — the wardrobe ledger. A purchase is a spend row
 * in ramble_wallet keyed uniquely per purchase; ownership and the seed
 * balance are both DERIVED, never stored.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import { seedBalance, SPEND_KIND } from "../bundles/ramble/server/wallet.js";
import { ACCESSORIES, itemById, ownedItems, buyItem } from "../bundles/ramble/server/wardrobe.js";
import { createRequire } from "node:module";
const Bird = createRequire(import.meta.url)("../bundles/ramble/server/bird-svg.cjs");

const NOW = 1_760_000_000_000;
async function freshDb(seed = 0) {
  const db = createClient({ url: "file::memory:" });
  await initRambleTables(db);
  if (seed) {
    await db.execute({ sql: "INSERT INTO ramble_wallet (kind, key, delta, created_at) VALUES ('seed', 'grant:test', ?, ?)", args: [seed, NOW] });
  }
  return db;
}

test("the catalogue: unique ids, every slot/value is drawable, every price a positive integer", () => {
  const ids = new Set();
  for (const it of ACCESSORIES) {
    assert.ok(!ids.has(it.id), `duplicate ${it.id}`); ids.add(it.id);
    assert.equal(it.id, `${it.slot}.${it.value}`);
    assert.ok(Bird.OUTFIT_SLOTS[it.slot].includes(it.value), `${it.id} has art`);
    assert.ok(Number.isInteger(it.price) && it.price > 0);
    assert.ok(typeof it.name === "string" && it.name.length > 0);
  }
  for (const slot of Object.keys(Bird.OUTFIT_SLOTS)) for (const v of Bird.OUTFIT_SLOTS[slot]) {
    assert.ok(itemById(`${slot}.${v}`), `every drawable ${slot}.${v} is for sale`);
  }
  assert.equal(itemById("hat.monocle"), null);
  assert.equal(itemById("__proto__"), null);
});

test("buying writes ONE spend row keyed per purchase, emits it, and the balance drops", async () => {
  const db = await freshDb(50);
  const emitted = [];
  const out = await buyItem(db, "hat.beanie", { now: NOW, purchaseId: "p1", emit: async (t, op, row) => emitted.push({ t, op, row }) });
  const price = itemById("hat.beanie").price;
  assert.equal(out.ok, true);
  assert.equal(out.balance, 50 - price);
  assert.equal(await seedBalance(db), 50 - price, "seedBalance subtracts spends");
  const { rows } = await db.execute("SELECT kind, key, delta, created_at FROM ramble_wallet WHERE kind = 'spend'");
  assert.deepEqual(rows.map((r) => ({ ...r })), [{ kind: SPEND_KIND, key: "hat.beanie:p1", delta: -price, created_at: NOW }]);
  assert.deepEqual(emitted, [{ t: "ramble_wallet", op: "insert", row: { kind: "spend", key: "hat.beanie:p1", delta: -price, created_at: NOW } }]);
  assert.deepEqual([...await ownedItems(db)], ["hat.beanie"]);
});

test("refusals: unknown item, already owned, not enough seed — nothing written, nothing emitted", async () => {
  const db = await freshDb(10);
  const emitted = [];
  const emit = async (...a) => emitted.push(a);
  assert.deepEqual(await buyItem(db, "hat.monocle", { now: NOW, emit }), { ok: false, reason: "unknown-item", balance: 10 });
  const pricey = ACCESSORIES.find((i) => i.price > 10);
  assert.deepEqual(await buyItem(db, pricey.id, { now: NOW, emit }), { ok: false, reason: "short", balance: 10 });
  const cheap = ACCESSORIES.find((i) => i.price <= 10);
  assert.equal((await buyItem(db, cheap.id, { now: NOW, emit, purchaseId: "a" })).ok, true);
  const again = await buyItem(db, cheap.id, { now: NOW, emit, purchaseId: "b" });
  assert.equal(again.ok, false);
  assert.equal(again.reason, "owned");
  assert.equal(emitted.length, 1, "only the one real purchase emitted");
});

test("exactly-enough seed buys; a double tap (two concurrent buys) charges once", async () => {
  const item = itemById("hat.bow");
  const db = await freshDb(item.price);
  const [a, b] = await Promise.all([
    buyItem(db, item.id, { now: NOW, purchaseId: "x" }),
    buyItem(db, item.id, { now: NOW, purchaseId: "y" }),
  ]);
  assert.equal([a, b].filter((r) => r.ok).length, 1, "one wins");
  assert.equal(await seedBalance(db), 0);
  const { rows } = await db.execute("SELECT count(*) AS n FROM ramble_wallet WHERE kind = 'spend'");
  assert.equal(Number(rows[0].n), 1);
});

test("a negative balance (two instances spent the same seed) refuses further buys and owned items stay owned", async () => {
  const db = await freshDb(0);
  await db.execute({ sql: "INSERT INTO ramble_wallet (kind, key, delta, created_at) VALUES ('spend', 'hat.bow:p1', -8, ?)", args: [NOW] });
  assert.equal(await seedBalance(db), -8);
  assert.ok((await ownedItems(db)).has("hat.bow"));
  assert.equal((await buyItem(db, "hat.leaf", { now: NOW })).reason, "short");
});

test("ownedItems ignores spend rows for items no longer (or not yet) in this catalogue", async () => {
  const db = await freshDb(0);
  await db.execute({ sql: "INSERT INTO ramble_wallet (kind, key, delta, created_at) VALUES ('spend', 'glasses.monocle:p9', -40, ?)", args: [NOW] });
  assert.deepEqual([...await ownedItems(db)], [], "unknown to this version: not wearable here");
  assert.equal(await seedBalance(db), -40, "but the seed it cost is still spent");
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- tests/ramble-wardrobe.test.js`
Expected: FAIL — `Cannot find module .../wardrobe.js`.

- [ ] **Step 3: Implement**

In `wallet.js`, below `export const SEED_SALT`:
```js
/** Phase 4: a purchase. One row per purchase, negative delta (spec §6.1). */
export const SPEND_KIND = "spend";
```
and replace `seedBalance`:
```js
/** The derived balance: every earn minus every spend. Spends are their own
 * kind so nothing that counts seed PICKUPS (harvestableCells' suffix match)
 * ever sees them. Can be negative — two of the user's instances may each have
 * spent the same seed while out of contact; that is the truth, so show it. */
export async function seedBalance(db) {
  try {
    const { rows } = await db.execute({
      sql: "SELECT COALESCE(SUM(delta), 0) AS total FROM ramble_wallet WHERE kind IN (?, ?)",
      args: [SEED_KIND, SPEND_KIND],
    });
    return Number(rows?.[0]?.total) || 0;
  } catch { return 0; }
}
```

Create `bundles/ramble/server/wardrobe.js`:
```js
/**
 * The wardrobe (spec 2026-09-08 §5, decisions D7, D10, D11).
 *
 * Bird seed buys accessories. A purchase is a SPEND row in the replicated
 * ramble_wallet ledger, keyed `<itemId>:<purchaseId>` — unique per purchase,
 * because applyRambleWallet settles a key conflict with MAX(delta), which must
 * never arbitrate money (see its comment). Ownership is DERIVED from those
 * rows, so the wardrobe follows the user across their own instances for free.
 *
 * Shared wardrobe, per-bird outfit (D11): buy once, any bird may wear it, and
 * each bird's outfit lives on its own ramble_eggs row (outfit_json).
 *
 * Contacts-only (D10): an outfit reaches contacts through the profile picture
 * and NOTHING else. eggs.js activeBird() — what public marks are authored from
 * — deliberately never carries it.
 */
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { seedBalance, SPEND_KIND } from "./wallet.js";

const require = createRequire(import.meta.url);
const { OUTFIT_SLOTS } = require("./bird-svg.cjs");

/** Prices are in bird seed. Seed is ~1 per harvested cell (seed.rate 4, a day
 * to regrow), so a first hat is a couple of days of ordinary walking. */
export const ACCESSORIES = Object.freeze([
  { id: "hat.bow", slot: "hat", value: "bow", name: "Bow", price: 8 },
  { id: "hat.leaf", slot: "hat", value: "leaf", name: "Leaf", price: 8 },
  { id: "hat.beanie", slot: "hat", value: "beanie", name: "Beanie", price: 12 },
  { id: "scarf.knit", slot: "scarf", value: "knit", name: "Knitted scarf", price: 15 },
  { id: "scarf.stripe", slot: "scarf", value: "stripe", name: "Striped scarf", price: 20 },
  { id: "glasses.round", slot: "glasses", value: "round", name: "Round glasses", price: 20 },
  { id: "glasses.shades", slot: "glasses", value: "shades", name: "Shades", price: 25 },
].map((it) => Object.freeze(it)));

const BY_ID = new Map(ACCESSORIES.map((it) => [it.id, it]));

export function itemById(id) {
  return typeof id === "string" && BY_ID.has(id) ? BY_ID.get(id) : null;
}

async function safeEmit(emit, table, op, row) {
  if (typeof emit !== "function") return;
  try { await emit(table, op, row); }
  catch (err) { try { console.warn(`[ramble] emit ${table} failed:`, err?.message); } catch {} }
}

/** Item ids the user owns, derived from spend rows. Unknown ids (another
 * version's catalogue) are skipped: not wearable here, still paid for. */
export async function ownedItems(db) {
  const out = new Set();
  try {
    const { rows } = await db.execute({ sql: "SELECT key FROM ramble_wallet WHERE kind = ?", args: [SPEND_KIND] });
    for (const r of rows || []) {
      const key = String(r.key || "");
      const cut = key.lastIndexOf(":");
      const id = cut > 0 ? key.slice(0, cut) : "";
      if (BY_ID.has(id)) out.add(id);
    }
  } catch { /* nothing owned */ }
  return out;
}

/**
 * Buy one item. ONE conditional INSERT decides it — not owned yet AND the
 * derived balance covers the price — so a double tap cannot charge twice and
 * a check-then-write race cannot overdraw. Only a real purchase emits.
 */
export async function buyItem(db, itemId, { now = Date.now(), emit, purchaseId } = {}) {
  const item = itemById(itemId);
  if (!item) return { ok: false, reason: "unknown-item", balance: await seedBalance(db) };
  const prefix = item.id + ":";
  const key = prefix + (typeof purchaseId === "string" && purchaseId ? purchaseId : randomUUID());
  const at = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const res = await db.execute({
    sql: `INSERT INTO ramble_wallet (kind, key, delta, created_at)
          SELECT ?, ?, ?, ?
           WHERE NOT EXISTS (SELECT 1 FROM ramble_wallet WHERE kind = ? AND substr(key, 1, ?) = ?)
             AND (SELECT COALESCE(SUM(delta), 0) FROM ramble_wallet WHERE kind IN ('seed', ?)) >= ?
          ON CONFLICT(kind, key) DO NOTHING`,
    args: [SPEND_KIND, key, -item.price, at, SPEND_KIND, prefix.length, prefix, SPEND_KIND, item.price],
  });
  const balance = await seedBalance(db);
  if (Number(res.rowsAffected) === 0) {
    return { ok: false, reason: (await ownedItems(db)).has(item.id) ? "owned" : "short", balance };
  }
  await safeEmit(emit, "ramble_wallet", "insert", { kind: SPEND_KIND, key, delta: -item.price, created_at: at });
  return { ok: true, item, balance };
}
```
(`OUTFIT_SLOTS` is imported now and used in Task 3; if the linter complains about an unused import in this task, leave it — Task 3 consumes it in the same file.)

- [ ] **Step 4: Run to verify they pass**

Run: `npm test -- tests/ramble-wardrobe.test.js tests/ramble-wallet.test.js tests/ramble-hearts-ledger.test.js`
Expected: all PASS (wallet/hearts suites prove `seedBalance` still counts pickups).

- [ ] **Step 5: Commit**

```bash
git commit bundles/ramble/server/wardrobe.js bundles/ramble/server/wallet.js tests/ramble-wardrobe.test.js -m "feat(ramble): wardrobe catalogue + per-purchase spend ledger; seed balance subtracts spends"
```

---

### Task 3: Wearing — `outfit_json` on the bird row, `wearItem`, outfit in the flock

**Files:**
- Modify: `bundles/ramble/server/init-tables.js` (guarded column)
- Modify: `bundles/ramble/server/wardrobe.js` (add `parseOutfit`, `birdOutfit`, `wearItem`, `wardrobeState`)
- Modify: `bundles/ramble/server/flock.js` (`flockState` birds carry `outfit`)
- Test: `tests/ramble-wardrobe.test.js` (extend)

**Interfaces:**
- Consumes: `ACCESSORIES`, `itemById`, `ownedItems`, `seedBalance` (Task 2); `OUTFIT_SLOTS` (Task 1).
- Produces:
  - `parseOutfit(json: string|null|undefined) -> { hat?: string, scarf?: string, glasses?: string }` — always a plain object, only known slot/value pairs, never throws.
  - `birdOutfit(db, eggId) -> Promise<object>` (parsed; `{}` when none / missing column).
  - `wearItem(db, eggId, slot, itemId|null, { emit }) -> Promise<{ ok: true, outfit } | { ok: false, reason: "not-found"|"not-a-bird"|"bad-slot"|"unknown-item"|"wrong-slot"|"not-owned" }>` — `itemId === null` takes that slot off. Writes `outfit_json` (`NULL` when the outfit becomes empty) and emits the FULL egg row (`SELECT *`) as `("ramble_eggs","update",row)`.
  - `wardrobeState(db) -> Promise<{ seed: number, items: Array<{id,slot,value,name,price,owned}>, active: { egg_id, species, seed, outfit } | null }>`.
  - `flockState(...).birds[i].outfit` (parsed object).

- [ ] **Step 1: Write the failing tests** — append to `tests/ramble-wardrobe.test.js`:

```js
import { parseOutfit, birdOutfit, wearItem, wardrobeState } from "../bundles/ramble/server/wardrobe.js";
import { flockState } from "../bundles/ramble/server/flock.js";
import { activeBird } from "../bundles/ramble/server/eggs.js";

async function hatched(db, eggId, { species = "crow", seed = 1, active = false } = {}) {
  await db.execute({ sql: "INSERT INTO ramble_eggs (egg_id, status, warmth, species, seed, created_at, hatched_at) VALUES (?, 'hatched', 100, ?, ?, 1, 2)", args: [eggId, species, seed] });
  if (active) await db.execute({ sql: "INSERT INTO ramble_pet (owner, active_egg_id) VALUES ('self', ?) ON CONFLICT(owner) DO UPDATE SET active_egg_id = excluded.active_egg_id", args: [eggId] });
}

test("parseOutfit: only known slot/value pairs, a plain object, never throws", () => {
  assert.deepEqual(parseOutfit('{"hat":"bow","scarf":"knit","glasses":"shades"}'), { hat: "bow", scarf: "knit", glasses: "shades" });
  for (const junk of [null, undefined, "", "{", "[]", "42", '"hat"', '{"hat":"monocle"}', '{"wings":"big"}', '{"hat":7}', '{"__proto__":{"hat":"bow"}}']) {
    assert.deepEqual(parseOutfit(junk), {}, String(junk));
  }
  assert.deepEqual(parseOutfit('{"hat":"bow","glasses":"monocle"}'), { hat: "bow" }, "a future value is dropped, the rest kept");
});

test("the column exists after init and is idempotent", async () => {
  const db = await freshDb();
  await initRambleTables(db);
  const { rows } = await db.execute("PRAGMA table_info(ramble_eggs)");
  assert.ok(rows.some((r) => r.name === "outfit_json"));
});

test("wearing: owned item on a hatched bird; full row emitted; per-bird; take off restores", async () => {
  const db = await freshDb(100);
  await hatched(db, "b1", { active: true });
  await hatched(db, "b2", { seed: 2 });
  await buyItem(db, "hat.beanie", { now: NOW });
  await buyItem(db, "scarf.knit", { now: NOW });
  const emitted = [];
  const emit = async (t, op, row) => emitted.push({ t, op, row });

  let out = await wearItem(db, "b1", "hat", "hat.beanie", { emit });
  assert.deepEqual(out, { ok: true, outfit: { hat: "beanie" } });
  out = await wearItem(db, "b1", "scarf", "scarf.knit", { emit });
  assert.deepEqual(out.outfit, { hat: "beanie", scarf: "knit" });
  assert.equal(emitted.length, 2);
  assert.equal(emitted[1].t, "ramble_eggs");
  assert.equal(emitted[1].op, "update");
  assert.equal(emitted[1].row.egg_id, "b1");
  assert.equal(emitted[1].row.status, "hatched", "the FULL row rides the wire");
  assert.deepEqual(JSON.parse(emitted[1].row.outfit_json), { hat: "beanie", scarf: "knit" });

  // D11: the same item on another bird, each remembers its own.
  assert.equal((await wearItem(db, "b2", "hat", "hat.beanie", { emit })).ok, true);
  assert.deepEqual(await birdOutfit(db, "b2"), { hat: "beanie" });
  out = await wearItem(db, "b1", "hat", null, { emit });
  assert.deepEqual(out.outfit, { scarf: "knit" });
  assert.deepEqual(await birdOutfit(db, "b2"), { hat: "beanie" }, "b2 untouched");
  await wearItem(db, "b1", "scarf", null, { emit });
  const { rows } = await db.execute("SELECT outfit_json FROM ramble_eggs WHERE egg_id = 'b1'");
  assert.equal(rows[0].outfit_json, null, "an empty outfit is NULL, not '{}'");
});

test("wearing refusals", async () => {
  const db = await freshDb(100);
  await hatched(db, "b1");
  await db.execute("INSERT INTO ramble_eggs (egg_id, status, warmth, created_at) VALUES ('e1', 'incubating', 3, 1)");
  await buyItem(db, "hat.bow", { now: NOW });
  const r = (eggId, slot, item) => wearItem(db, eggId, slot, item, {});
  assert.equal((await r("nope", "hat", "hat.bow")).reason, "not-found");
  assert.equal((await r("e1", "hat", "hat.bow")).reason, "not-a-bird");
  assert.equal((await r("b1", "wings", "hat.bow")).reason, "bad-slot");
  assert.equal((await r("b1", "__proto__", "hat.bow")).reason, "bad-slot");
  assert.equal((await r("b1", "hat", "hat.monocle")).reason, "unknown-item");
  assert.equal((await r("b1", "scarf", "hat.bow")).reason, "wrong-slot");
  assert.equal((await r("b1", "hat", "hat.leaf")).reason, "not-owned");
});

test("D10: activeBird (what public marks are authored from) never carries an outfit", async () => {
  const db = await freshDb(100);
  await hatched(db, "b1", { species: "magpie", seed: 4242, active: true });
  await buyItem(db, "glasses.shades", { now: NOW });
  await wearItem(db, "b1", "glasses", "glasses.shades", {});
  assert.deepEqual({ ...(await activeBird(db)) }, { egg_id: "b1", species: "magpie", seed: 4242 });
});

test("wardrobeState and flockState carry the outfit; a corrupt outfit_json reads as {}", async () => {
  const db = await freshDb(30);
  await hatched(db, "b1", { active: true });
  await hatched(db, "b2", { seed: 2 });
  await buyItem(db, "hat.bow", { now: NOW });
  await wearItem(db, "b1", "hat", "hat.bow", {});
  await db.execute("UPDATE ramble_eggs SET outfit_json = '{broken' WHERE egg_id = 'b2'");
  const w = await wardrobeState(db);
  assert.equal(w.seed, 30 - itemById("hat.bow").price);
  assert.equal(w.items.length, ACCESSORIES.length);
  assert.equal(w.items.find((i) => i.id === "hat.bow").owned, true);
  assert.equal(w.items.find((i) => i.id === "hat.leaf").owned, false);
  assert.deepEqual(w.active, { egg_id: "b1", species: "crow", seed: 1, outfit: { hat: "bow" } });
  const f = await flockState(db, { now: NOW });
  assert.deepEqual(f.birds.find((b) => b.egg_id === "b1").outfit, { hat: "bow" });
  assert.deepEqual(f.birds.find((b) => b.egg_id === "b2").outfit, {});
});

test("wardrobeState with no hatched bird: active is null, the shop still lists", async () => {
  const db = await freshDb(5);
  const w = await wardrobeState(db);
  assert.equal(w.active, null);
  assert.equal(w.seed, 5);
  assert.equal(w.items.length, ACCESSORIES.length);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- tests/ramble-wardrobe.test.js`
Expected: FAIL — `parseOutfit` / `wearItem` not exported; column missing.

- [ ] **Step 3: Implement**

`init-tables.js`, directly after the `shelf_origin` backfill `db.execute(...)`:
```js
  // Phase 4 (spec 2026-09-08 §5, §6.2): what a hatched bird is wearing, as a
  // JSON object of slot -> value (bird-svg.cjs OUTFIT_SLOTS), NULL for nothing.
  // A column on the bird row, which already replicates, so an outfit follows
  // its bird to the user's other instances (core's applyRambleEgg also adds
  // this column lazily, for a core newer than this bundle copy). Contacts-only
  // (D10): it is never put on a mark.
  await ensureColumn(db, "ramble_eggs", "outfit_json", "TEXT");
```

`wardrobe.js`, append:
```js
/** A stored outfit -> a plain object of KNOWN slot/value pairs. Never throws. */
export function parseOutfit(json) {
  const out = {};
  if (typeof json !== "string" || json === "") return out;
  let raw;
  try { raw = JSON.parse(json); } catch { return out; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const slot of Object.keys(OUTFIT_SLOTS)) {
    if (!Object.prototype.hasOwnProperty.call(raw, slot)) continue;
    const v = raw[slot];
    if (typeof v === "string" && OUTFIT_SLOTS[slot].includes(v)) out[slot] = v;
  }
  return out;
}

async function getEgg(db, eggId) {
  const { rows } = await db.execute({ sql: "SELECT * FROM ramble_eggs WHERE egg_id = ?", args: [eggId] });
  return rows[0] ?? null;
}

export async function birdOutfit(db, eggId) {
  try {
    const { rows } = await db.execute({ sql: "SELECT outfit_json FROM ramble_eggs WHERE egg_id = ?", args: [eggId] });
    return parseOutfit(rows[0]?.outfit_json ?? null);
  } catch { return {}; }
}

/** Put an owned item on a hatched bird, or (itemId null) take a slot off. */
export async function wearItem(db, eggId, slot, itemId, { emit } = {}) {
  if (typeof slot !== "string" || !Object.prototype.hasOwnProperty.call(OUTFIT_SLOTS, slot)) return { ok: false, reason: "bad-slot" };
  const egg = await getEgg(db, eggId);
  if (!egg) return { ok: false, reason: "not-found" };
  if (egg.status !== "hatched" || egg.species == null || egg.seed == null) return { ok: false, reason: "not-a-bird" };
  const outfit = parseOutfit(egg.outfit_json ?? null);
  if (itemId === null) {
    delete outfit[slot];
  } else {
    const item = itemById(itemId);
    if (!item) return { ok: false, reason: "unknown-item" };
    if (item.slot !== slot) return { ok: false, reason: "wrong-slot" };
    if (!(await ownedItems(db)).has(item.id)) return { ok: false, reason: "not-owned" };
    outfit[slot] = item.value;
  }
  const json = Object.keys(outfit).length ? JSON.stringify(outfit) : null;
  await db.execute({ sql: "UPDATE ramble_eggs SET outfit_json = ? WHERE egg_id = ?", args: [json, eggId] });
  await safeEmit(emit, "ramble_eggs", "update", await getEgg(db, eggId));
  return { ok: true, outfit };
}

/** The shop sheet's one read. `active` is the bird you are, with its outfit. */
export async function wardrobeState(db) {
  const owned = await ownedItems(db);
  let active = null;
  try {
    const { rows } = await db.execute({
      sql: `SELECT e.egg_id, e.species, e.seed, e.outfit_json FROM ramble_pet p
            JOIN ramble_eggs e ON e.egg_id = p.active_egg_id
            WHERE p.owner = 'self' AND e.status = 'hatched' AND e.species IS NOT NULL AND e.seed IS NOT NULL LIMIT 1`,
      args: [],
    });
    const r = rows[0];
    if (r) active = { egg_id: r.egg_id, species: r.species, seed: Number(r.seed), outfit: parseOutfit(r.outfit_json ?? null) };
  } catch { active = null; }
  return {
    seed: await seedBalance(db),
    items: ACCESSORIES.map((it) => ({ ...it, owned: owned.has(it.id) })),
    active,
  };
}
```

`flock.js`: add `import { parseOutfit } from "./wardrobe.js";` and in `flockState`'s `birds` map add `outfit: parseOutfit(r.outfit_json ?? null)` to the object literal.

- [ ] **Step 4: Run to verify they pass**

Run: `npm test -- tests/ramble-wardrobe.test.js tests/ramble-flock.test.js tests/ramble-tables.test.js tests/ramble-eggs.test.js`
Expected: all PASS. If `ramble-flock.test.js` deep-equals a bird object, add `outfit: {}` to that expectation (that is the new documented shape) and note it in the commit message.

- [ ] **Step 5: Commit**

```bash
git commit bundles/ramble/server/init-tables.js bundles/ramble/server/wardrobe.js bundles/ramble/server/flock.js tests/ramble-wardrobe.test.js -m "feat(ramble): wear owned accessories — outfit_json on the bird row, per-bird, full-row emit"
```
(add `tests/ramble-flock.test.js` to the path list only if Step 4 required editing it.)

---

### Task 4: Replication — outfits ride the egg row, spends converge (core)

**Files:**
- Modify: `servers/sharing/instance-sync.js`
- Test: `tests/ramble-wardrobe-sync.test.js` (create)

**Interfaces:**
- Consumes: `applyRambleWallet(db, op, row, lamportTs)` and `applyRambleEgg(db, op, row, lamportTs, origin)` (existing exports); `buyItem`, `wearItem`, `ownedItems`, `birdOutfit` (Tasks 2–3); `seedBalance`.
- Produces: `RAMBLE_EGG_WIRE_COLUMNS` includes `"outfit_json"` (LWW on the envelope via the default `excluded.<col>` set clause); `applyRambleEgg` ensures the `outfit_json` column exists (memoised per db handle) before its INSERT.

- [ ] **Step 1: Write the failing tests** — `tests/ramble-wardrobe-sync.test.js`:

```js
/**
 * Spec 2026-09-08 §8: anything that replicates gets an executable,
 * MULTI-INSTANCE test. Two in-memory dbs stand in for two of the user's
 * instances; each instance's emits are captured and applied to the other.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { initRambleTables } from "../bundles/ramble/server/init-tables.js";
import { applyRambleWallet, applyRambleEgg } from "../servers/sharing/instance-sync.js";
import { seedBalance } from "../bundles/ramble/server/wallet.js";
import { buyItem, wearItem, ownedItems, birdOutfit, itemById } from "../bundles/ramble/server/wardrobe.js";

const NOW = 1_760_000_000_000;
async function instance(seed) {
  const db = createClient({ url: "file::memory:" });
  await initRambleTables(db);
  // The SAME earn on both sides, as if it had already synced.
  await db.execute({ sql: "INSERT INTO ramble_wallet (kind, key, delta, created_at) VALUES ('seed', 'c:1', ?, ?)", args: [seed, NOW] });
  const ops = [];
  return { db, ops, emit: async (table, op, row) => ops.push({ table, op, row }) };
}
let lamport = 100;
async function deliver(ops, to) {
  for (const { table, op, row } of ops) {
    if (table === "ramble_wallet") await applyRambleWallet(to, op, row, ++lamport);
    else if (table === "ramble_eggs") await applyRambleEgg(to, op, row, ++lamport, "peer");
  }
}

test("a purchase on A reaches B: same balance, same wardrobe", async () => {
  const A = await instance(40), B = await instance(40);
  await buyItem(A.db, "hat.beanie", { now: NOW, emit: A.emit });
  await deliver(A.ops, B.db);
  assert.equal(await seedBalance(B.db), 40 - itemById("hat.beanie").price);
  assert.deepEqual([...await ownedItems(B.db)], ["hat.beanie"]);
});

test("offline on both: different items, any arrival order, identical result (possibly negative)", async () => {
  for (const order of ["AB", "BA"]) {
    const A = await instance(20), B = await instance(20);
    assert.equal((await buyItem(A.db, "scarf.knit", { now: NOW, emit: A.emit })).ok, true);   // 15
    assert.equal((await buyItem(B.db, "glasses.round", { now: NOW, emit: B.emit })).ok, true); // 20
    if (order === "AB") { await deliver(A.ops, B.db); await deliver(B.ops, A.db); }
    else { await deliver(B.ops, A.db); await deliver(A.ops, B.db); }
    const want = 20 - 15 - 20;
    assert.equal(await seedBalance(A.db), want, order);
    assert.equal(await seedBalance(B.db), want, order);
    assert.deepEqual([...await ownedItems(A.db)].sort(), ["glasses.round", "scarf.knit"]);
    assert.deepEqual([...await ownedItems(B.db)].sort(), ["glasses.round", "scarf.knit"]);
    assert.equal((await buyItem(A.db, "hat.bow", { now: NOW })).reason, "short", "a negative balance buys nothing");
  }
});

test("offline on both: the SAME item — owned once, charged twice, both sides agree (accepted, documented)", async () => {
  const A = await instance(30), B = await instance(30);
  await buyItem(A.db, "hat.bow", { now: NOW, emit: A.emit });
  await buyItem(B.db, "hat.bow", { now: NOW, emit: B.emit });
  await deliver(A.ops, B.db); await deliver(B.ops, A.db);
  assert.equal(await seedBalance(A.db), 30 - 16);
  assert.equal(await seedBalance(B.db), 30 - 16);
  assert.deepEqual([...await ownedItems(A.db)], ["hat.bow"]);
});

test("re-delivering the same spend is idempotent (replay cannot inflate or deflate)", async () => {
  const A = await instance(30), B = await instance(30);
  await buyItem(A.db, "hat.bow", { now: NOW, emit: A.emit });
  await deliver(A.ops, B.db); await deliver(A.ops, B.db);
  assert.equal(await seedBalance(B.db), 22);
});

test("an outfit change on A reaches B's copy of the bird", async () => {
  const A = await instance(50), B = await instance(50);
  for (const { db } of [A, B]) {
    await db.execute("INSERT INTO ramble_eggs (egg_id, status, warmth, species, seed, created_at, hatched_at) VALUES ('b1', 'hatched', 100, 'crow', 1, 1, 2)");
  }
  await buyItem(A.db, "glasses.shades", { now: NOW, emit: A.emit });
  await wearItem(A.db, "b1", "glasses", "glasses.shades", { emit: A.emit });
  await deliver(A.ops, B.db);
  assert.deepEqual(await birdOutfit(B.db, "b1"), { glasses: "shades" });
  // Taking it off travels too (the row carries outfit_json: null).
  A.ops.length = 0;
  await wearItem(A.db, "b1", "glasses", null, { emit: A.emit });
  await deliver(A.ops, B.db);
  assert.deepEqual(await birdOutfit(B.db, "b1"), {});
  const { rows } = await B.db.execute("SELECT status, species, seed FROM ramble_eggs WHERE egg_id = 'b1'");
  assert.deepEqual({ ...rows[0] }, { status: "hatched", species: "crow", seed: 1 }, "the bird itself is untouched");
});

test("an outfit row reaching an instance whose ramble_eggs predates the column applies, column and all", async () => {
  const old = createClient({ url: "file::memory:" });
  await old.execute(`CREATE TABLE ramble_eggs (
    egg_id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'shelf', warmth INTEGER NOT NULL DEFAULT 0,
    species TEXT, seed INTEGER, found_cell TEXT, found_week TEXT, from_crow_id TEXT,
    created_at INTEGER NOT NULL, hatched_at INTEGER, lamport_ts INTEGER DEFAULT 0, shelf_origin TEXT, lamport_origin TEXT)`);
  await applyRambleEgg(old, "update", {
    egg_id: "b1", status: "hatched", warmth: 100, species: "crow", seed: 1, found_cell: null, found_week: null,
    from_crow_id: null, created_at: 1, hatched_at: 2, shelf_origin: null, outfit_json: '{"hat":"leaf"}',
  }, 500, "peer");
  const { rows } = await old.execute("SELECT outfit_json FROM ramble_eggs WHERE egg_id = 'b1'");
  assert.equal(rows[0].outfit_json, '{"hat":"leaf"}');
});

test("a sparse egg row with no outfit_json key leaves a worn outfit alone", async () => {
  const B = await instance(0);
  await B.db.execute(`INSERT INTO ramble_eggs (egg_id, status, warmth, species, seed, created_at, hatched_at, outfit_json)
                      VALUES ('b1', 'hatched', 100, 'crow', 1, 1, 2, '{"hat":"bow"}')`);
  await applyRambleEgg(B.db, "update", { egg_id: "b1", status: "hatched", warmth: 100 }, 900, "peer");
  assert.deepEqual(await birdOutfit(B.db, "b1"), { hat: "bow" });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- tests/ramble-wardrobe-sync.test.js`
Expected: the wallet tests PASS already (spend rows are plain ledger rows — this proves the ledger needed no core change); "an outfit change on A reaches B" FAILS (`outfit_json` not a wire column → `{}`), "predates the column" FAILS.

- [ ] **Step 3: Implement** in `servers/sharing/instance-sync.js`:

Append `"outfit_json"` to `RAMBLE_EGG_WIRE_COLUMNS` (after `"shelf_origin"`), with this comment above the array's closing line:
```js
  // Phase 4 (spec 2026-09-08 §5, D11): what a hatched bird is wearing. Plain
  // last-writer-wins on the envelope (the default set clause) — an outfit is
  // the user's latest choice, nothing to merge. Contacts never receive egg
  // rows, so this replicates to the user's OWN instances only (D10).
  "outfit_json",
```

Above `export async function applyRambleEgg` add:
```js
/**
 * Guarded, additive `ramble_eggs.outfit_json TEXT` — the bundle's init-tables
 * adds it, but a core newer than the installed bundle copy can be handed an
 * outfit row first, and an INSERT naming a missing column would throw the
 * whole apply. Same shape as ensureLamportOriginColumn. Memoised per db.
 */
const _eggOutfitColumnReady = new WeakSet();
async function ensureRambleEggOutfitColumn(db) {
  if (_eggOutfitColumnReady.has(db)) return;
  try {
    const { rows } = await db.execute(`PRAGMA table_info(ramble_eggs)`);
    if (rows.length === 0) return;
    if (!rows.some((r) => r.name === "outfit_json")) {
      try { await db.execute(`ALTER TABLE ramble_eggs ADD COLUMN outfit_json TEXT`); }
      catch (err) { if (!/duplicate column/i.test(String(err?.message))) throw err; }
    }
    _eggOutfitColumnReady.add(db);
  } catch { /* the apply below fails loudly on its own if the table is unusable */ }
}
```
and call `await ensureRambleEggOutfitColumn(db);` as the first statement after `if (!row || !row.egg_id) return;` in `applyRambleEgg`.

- [ ] **Step 4: Run to verify they pass**

Run: `npm test -- tests/ramble-wardrobe-sync.test.js tests/ramble-sync.test.js tests/ramble-lamport-tie.test.js tests/ramble-eggs-receipt.test.js`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git commit servers/sharing/instance-sync.js tests/ramble-wardrobe-sync.test.js -m "feat(sync): outfit_json rides the ramble egg row; lazy guarded column; multi-instance wardrobe tests"
```

---

### Task 5: Routes — the wardrobe API and the outfit on the pet read

**Files:**
- Modify: `bundles/ramble/panel/routes.js`
- Test: `tests/ramble-wardrobe-routes.test.js` (create)

**Interfaces:**
- Consumes: `wardrobeState`, `buyItem`, `wearItem`, `birdOutfit` (Tasks 2–3).
- Produces (HTTP, dashboard-authenticated like every `/api/ramble/*` route):
  - `GET /api/ramble/wardrobe` → `200 wardrobeState(db)`.
  - `POST /api/ramble/wardrobe/buy { item }` → `200 { ok: true, item: id, seed }`; `400 { error }` for a non-string/unknown item; `409 { error: "owned"|"short", seed }`.
  - `POST /api/ramble/birds/:id/outfit { slot, item }` (`item` a string id or `null`) → `200 { outfit }`; `400` bad slot / unknown item / wrong slot; `404` not-found; `409` not-a-bird / not-owned. On success pokes bus event `ramble:outfit-changed` with `{ egg_id }`.
  - `GET /api/ramble/pet` → `bird` becomes `{ egg_id, species, seed, outfit }` when a bird exists (still `null` otherwise).

- [ ] **Step 1: Write the failing tests** — `tests/ramble-wardrobe-routes.test.js`. Use the harness shape of `tests/ramble-egg-null-read.test.js` (scratch `CROW_DATA_DIR`, `CROW_APP_ROOT = REPO_ROOT`, dynamic `import("../bundles/ramble/panel/routes.js?t=...")`, `rambleRouter(auth, { emit })`, express on port 0):

```js
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import bus from "../servers/shared/event-bus.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dir, "..");
let SCRATCH, server, base, db, saved;
const emitted = [];
const H = { "x-test-auth": "1", "content-type": "application/json" };
const get = (p) => fetch(base + p, { headers: H });
const post = (p, body) => fetch(base + p, { method: "POST", headers: H, body: JSON.stringify(body) });

before(async () => {
  SCRATCH = mkdtempSync(join(tmpdir(), "ramble-wardrobe-routes-"));
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
  assert.equal((await get("/api/ramble/wardrobe")).status, 200, "first request creates + inits the scratch db");
  // Resolve the db file the router created exactly as ramble-egg-null-read.test.js does
  // (read bundles/ramble/server/db.js createDbClient's path rule; with CROW_DATA_DIR set
  // and CROW_DB_PATH unset it is join(SCRATCH, "crow.db")).
  db = createClient({ url: "file:" + join(SCRATCH, "crow.db") });
  await db.execute("INSERT INTO ramble_wallet (kind, key, delta, created_at) VALUES ('seed', 'grant', 30, 1)");
  await db.execute("INSERT INTO ramble_eggs (egg_id, status, warmth, species, seed, created_at, hatched_at) VALUES ('b1', 'hatched', 100, 'crow', 1, 1, 2)");
  await db.execute("INSERT INTO ramble_eggs (egg_id, status, warmth, created_at) VALUES ('e1', 'incubating', 3, 3)");
  await db.execute("INSERT INTO ramble_pet (owner, active_egg_id) VALUES ('self', 'b1') ON CONFLICT(owner) DO UPDATE SET active_egg_id = 'b1'");
});
after(async () => {
  server?.close(); try { db?.close(); } catch {}
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(SCRATCH, { recursive: true, force: true });
});

test("GET /api/ramble/wardrobe: the catalogue, the balance, the bird you are", async () => {
  const w = await (await get("/api/ramble/wardrobe")).json();
  assert.equal(w.seed, 30);
  assert.ok(w.items.length >= 7);
  assert.deepEqual(w.active, { egg_id: "b1", species: "crow", seed: 1, outfit: {} });
});

test("buy: 200 then 409 owned; 409 short; 400 junk", async () => {
  let r = await post("/api/ramble/wardrobe/buy", { item: "hat.beanie" });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, item: "hat.beanie", seed: 18 });
  assert.ok(emitted.some((e) => e.table === "ramble_wallet" && e.row.kind === "spend"));
  r = await post("/api/ramble/wardrobe/buy", { item: "hat.beanie" });
  assert.equal(r.status, 409); assert.equal((await r.json()).error, "owned");
  r = await post("/api/ramble/wardrobe/buy", { item: "glasses.shades" });
  assert.equal(r.status, 409); assert.equal((await r.json()).error, "short");
  for (const body of [{}, { item: 7 }, { item: "hat.monocle" }, { item: "x".repeat(500) }]) {
    assert.equal((await post("/api/ramble/wardrobe/buy", body)).status, 400, JSON.stringify(body).slice(0, 40));
  }
});

test("outfit: wear, poke the bus, show on GET /api/ramble/pet; refusals map to statuses", async () => {
  const pokes = [];
  const listener = (p) => pokes.push(p);
  bus.on("ramble:outfit-changed", listener);
  try {
    let r = await post("/api/ramble/birds/b1/outfit", { slot: "hat", item: "hat.beanie" });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { outfit: { hat: "beanie" } });
    assert.deepEqual(pokes, [{ egg_id: "b1" }]);
    const pet = await (await get("/api/ramble/pet")).json();
    assert.deepEqual(pet.bird, { egg_id: "b1", species: "crow", seed: 1, outfit: { hat: "beanie" } });
    r = await post("/api/ramble/birds/b1/outfit", { slot: "hat", item: null });
    assert.deepEqual(await r.json(), { outfit: {} });

    const cases = [
      ["/api/ramble/birds/b1/outfit", { slot: "wings", item: "hat.bow" }, 400],
      ["/api/ramble/birds/b1/outfit", { slot: "hat", item: "hat.monocle" }, 400],
      ["/api/ramble/birds/b1/outfit", { slot: "scarf", item: "hat.beanie" }, 400],
      ["/api/ramble/birds/b1/outfit", { slot: "hat" }, 400],
      ["/api/ramble/birds/nope/outfit", { slot: "hat", item: "hat.beanie" }, 404],
      ["/api/ramble/birds/e1/outfit", { slot: "hat", item: "hat.beanie" }, 409],
      ["/api/ramble/birds/b1/outfit", { slot: "hat", item: "hat.leaf" }, 409],
      ["/api/ramble/birds/" + "x".repeat(200) + "/outfit", { slot: "hat", item: "hat.beanie" }, 400],
    ];
    for (const [p, body, status] of cases) assert.equal((await post(p, body)).status, status, `${p} ${JSON.stringify(body)}`);
    assert.equal(pokes.length, 2, "only successful changes poke");
  } finally { bus.off("ramble:outfit-changed", listener); }
});

test("the per-pin bird route stays PLAIN (D10) whatever the bird is wearing", async () => {
  await post("/api/ramble/birds/b1/outfit", { slot: "hat", item: "hat.beanie" });
  const svg = await (await get("/api/ramble/bird/crow/1.svg")).text();
  const { createRequire } = await import("node:module");
  const Bird = createRequire(import.meta.url)("../bundles/ramble/server/bird-svg.cjs");
  assert.ok(svg.includes(Bird.drawBird(Bird.rollGenome(1, "crow"), undefined)));
});
```

Note for the implementer: read `bundles/ramble/server/db.js` `createDbClient` and confirm the db file path the router uses under this env; if it is not `join(SCRATCH, "crow.db")`, use the path it actually resolves (do not guess — print it once).

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- tests/ramble-wardrobe-routes.test.js`
Expected: FAIL — 404s on `/api/ramble/wardrobe`.

- [ ] **Step 3: Implement** in `routes.js`:

1. Add `wardrobeMod` to the `Promise.all` destructuring (append `bundleImport("server/wardrobe.js")` as the last element and `wardrobeMod` as the last name), add `!wardrobeMod` to the null check, and add `wardrobeMod` to the `mods = { ... }` object.
2. Add `const ITEM_ID_RE = /^[a-z]{1,16}\.[a-z]{1,16}$/;` beside the other validation regexes.
3. In `GET /api/ramble/pet`, replace `bird,` in the `res.json` with:
```js
      // Phase 4: the outfit rides HERE (the panel + header perch read it), and
      // deliberately NOT on activeBird(), which mark authoring uses (D10).
      bird: bird ? { egg_id: bird.egg_id, species: bird.species, seed: Number(bird.seed), outfit: await mods.wardrobeMod.birdOutfit(db, bird.egg_id) } : null,
```
4. After the `POST /api/ramble/birds/:id/activate` route add:
```js
  // --- phase 4: the wardrobe (spec 2026-09-08 §5) ---------------------------
  router.get("/api/ramble/wardrobe", handle(async (req, res) => {
    res.json(await mods.wardrobeMod.wardrobeState(db));
  }));

  router.post("/api/ramble/wardrobe/buy", handle(async (req, res) => {
    const item = (req.body || {}).item;
    if (typeof item !== "string" || !ITEM_ID_RE.test(item) || !mods.wardrobeMod.itemById(item)) bad("item must be a catalogue id");
    const out = await mods.wardrobeMod.buyItem(db, item, { now: Date.now(), emit });
    if (!out.ok) return res.status(409).json({ error: out.reason, seed: out.balance });
    res.json({ ok: true, item: out.item.id, seed: out.balance });
  }));

  router.post("/api/ramble/birds/:id/outfit", handle(async (req, res) => {
    if (!EGG_ID_RE.test(req.params.id)) bad("invalid egg id");
    const b = req.body || {};
    if (typeof b.slot !== "string" || !/^[a-z]{1,16}$/.test(b.slot)) bad("slot is required");
    if (!Object.prototype.hasOwnProperty.call(b, "item")) bad("item is required (an id, or null to take it off)");
    if (b.item !== null && (typeof b.item !== "string" || !ITEM_ID_RE.test(b.item))) bad("item must be a catalogue id or null");
    const out = await mods.wardrobeMod.wearItem(db, req.params.id, b.slot, b.item, { emit });
    if (!out.ok) {
      const status = out.reason === "not-found" ? 404 : (out.reason === "not-a-bird" || out.reason === "not-owned") ? 409 : 400;
      return res.status(status).json({ error: out.reason });
    }
    // Core coalesces this into at most one profile-picture broadcast per
    // settled outfit (servers/sharing/profile-avatar.js, spec §5.4).
    poke("ramble:outfit-changed", { egg_id: req.params.id });
    res.json({ outfit: out.outfit });
  }));
```

- [ ] **Step 4: Run to verify they pass**

Run: `npm test -- tests/ramble-wardrobe-routes.test.js tests/ramble-egg-null-read.test.js tests/ramble-panel.test.js`
Expected: all PASS. If an existing test deep-equals `GET /api/ramble/pet`'s `bird`, update it to the new `{ egg_id, species, seed, outfit }` shape and say so in the commit message.

- [ ] **Step 5: Commit**

```bash
git commit bundles/ramble/panel/routes.js tests/ramble-wardrobe-routes.test.js -m "feat(ramble): wardrobe routes — shop, buy, wear; outfit on the pet read; poke ramble:outfit-changed"
```

---

### Task 6: The profile picture — real mood, the outfit, coalesced broadcasts (core)

**Files:**
- Modify: `servers/sharing/profile-avatar.js`
- Modify: `bundles/ramble/server/pet.js` (export the two decay constants)
- Test: `tests/profile-avatar-bird.test.js` (extend + adjust two install calls)

**Interfaces:**
- Consumes: engine `applyOutfit` IF the loaded engine has it (an older installed engine draws the plain bird — skew-safe); `readActiveBird(db)` (unchanged shape `{egg_id, species, seed}`).
- Produces:
  - `pet.js`: `export const DECAY_INTERVAL_MS`, `export const DECAY_PER_INTERVAL` (values unchanged: 6 h, 10).
  - `profile-avatar.js`:
    - `portraitMood(energy, lastFedAt, now) -> "happy"|"tired"|"alarmed"` — the same decay `petState` applies on read (no write).
    - `readPortrait(db, { now }) -> Promise<{ egg_id, species, seed, mood, outfit } | null>`; never throws; `outfit` is the raw parsed object or `null` (the engine validates it).
    - `renderBirdAvatar(bird, engine)` — `bird.mood` (default `"happy"`) and `bird.outfit` (default none) now honoured.
    - `renderActiveBirdAvatar(db, { now })` uses `readPortrait`.
    - `installBirdAvatarHooks(managers, { emitter, settleMs = AVATAR_SETTLE_MS, tickMs = AVATAR_TICK_MS })`: boot repaint immediate; `ramble:hatched`, `ramble:bird-activated`, `ramble:outfit-changed` and the periodic tick each (re)arm ONE debounce timer of `settleMs`; when it fires, one serialized `refreshBirdAvatar`. `AVATAR_SETTLE_MS = 20_000`, `AVATAR_TICK_MS = 30 * 60_000`, both exported. Timers are `unref()`ed. `__resetBirdAvatarHooksForTest` also clears both timers.

Why a tick: energy decays with time and nothing emits an event for it, and an outfit changed on ANOTHER instance arrives by sync apply, which has no bus. The refresh is idempotent (an unchanged portrait never re-broadcasts), so a tick costs one SVG render.

- [ ] **Step 1: Write the failing tests** — in `tests/profile-avatar-bird.test.js`:

(a) Change the two existing `installBirdAvatarHooks(...)` calls in the tests "a hatch or an activation on the bus refreshes; installs once" and "two triggers landing in the same tick serialize" to pass `{ emitter, settleMs: 0, tickMs: 0 }` (both calls in the first test). Their assertions are unchanged — they now prove the debounce path still delivers every real change.

(b) Extend the import list with `portraitMood, readPortrait, AVATAR_SETTLE_MS, AVATAR_TICK_MS`, add `import { moodFor, DECAY_INTERVAL_MS, DECAY_PER_INTERVAL } from "../bundles/ramble/server/pet.js";`, and append:

```js
test("portraitMood is exactly pet.js's decay-on-read + moodFor (core keeps its own copy for skew; this pins them together)", () => {
  assert.equal(DECAY_INTERVAL_MS, 6 * 60 * 60 * 1000);
  assert.equal(DECAY_PER_INTERVAL, 10);
  const T = 1_760_000_000_000;
  for (const energy of [0, 29, 30, 59, 60, 61, 100, 250]) for (const k of [0, 1, 2, 3, 7]) {
    const expected = moodFor(Math.max(0, energy - k * DECAY_PER_INTERVAL));
    assert.equal(portraitMood(energy, T, T + k * DECAY_INTERVAL_MS + 1), expected, `${energy}/${k}`);
  }
  assert.equal(portraitMood(10, null, T), "alarmed", "never fed = no decay, mood from energy");
  assert.equal(portraitMood("junk", null, T), "happy", "junk energy reads as the default bird, never throws");
});

test("readPortrait: mood from the pet row with decay, outfit from the bird row; tolerates a missing outfit column", async () => {
  const db = createClient({ url: "file::memory:" });
  await plantBird(db, { eggId: "b1", species: "crow", seed: 2 });
  const T = 1_760_000_000_000;
  await db.execute({ sql: "UPDATE ramble_pet SET energy = 65, last_fed_at = ? WHERE owner = 'self'", args: [T] });
  assert.equal((await readPortrait(db, { now: T })).mood, "happy");
  assert.equal((await readPortrait(db, { now: T + DECAY_INTERVAL_MS })).mood, "tired", "one decay step crosses 60");
  await db.execute(`UPDATE ramble_eggs SET outfit_json = '{"scarf":"knit"}' WHERE egg_id = 'b1'`);
  assert.deepEqual((await readPortrait(db, { now: T })).outfit, { scarf: "knit" });
  await db.execute(`UPDATE ramble_eggs SET outfit_json = '{broken' WHERE egg_id = 'b1'`);
  assert.equal((await readPortrait(db, { now: T })).outfit, null, "corrupt = no outfit, no throw");
  await db.execute("ALTER TABLE ramble_eggs DROP COLUMN outfit_json");
  const p = await readPortrait(db, { now: T });
  assert.equal(p.species, "crow");
  assert.equal(p.outfit, null, "an older bundle's table still gives a portrait");
});

test("renderBirdAvatar honours mood and outfit; the defaults are byte-identical to the old portrait", () => {
  const plain = renderBirdAvatar({ species: "crow", seed: 2 });
  assert.equal(renderBirdAvatar({ species: "crow", seed: 2, mood: "happy", outfit: null }), plain);
  assert.equal(renderBirdAvatar({ species: "crow", seed: 2, mood: "nonsense" }), plain, "unknown mood = happy");
  assert.notEqual(renderBirdAvatar({ species: "crow", seed: 2, mood: "alarmed" }), plain, "D2: a neglected bird looks it");
  assert.notEqual(renderBirdAvatar({ species: "crow", seed: 2, outfit: { glasses: "round" } }), plain);
  assert.equal(renderBirdAvatar({ species: "crow", seed: 2, outfit: { glasses: "monocle" } }), plain, "unknown value ignored");
  const oldEngine = { rollGenome: loadBirdEngine().rollGenome, drawBird: loadBirdEngine().drawBird };
  assert.equal(renderBirdAvatar({ species: "crow", seed: 2, outfit: { glasses: "round" } }, oldEngine), plain, "an engine without applyOutfit draws the plain bird, never throws");
});

test("§5.4 coalescing: four try-ons inside the settle window = ONE broadcast of the final outfit", async () => {
  __resetBirdAvatarHooksForTest();
  const { db, cleanup } = freshDb();
  try {
    await seedContact(db);
    await plantBird(db, { eggId: "b1", species: "crow", seed: 2 });
    await putSetting(db, "profile_avatar_source", "bird");
    const sent = [];
    const emitter = new EventEmitter();
    installBirdAvatarHooks(mgrsWith(db, sent), { emitter, settleMs: 150, tickMs: 0 });
    await settle(db, "profile_avatar_url", renderBirdAvatar({ species: "crow", seed: 2 }));
    assert.equal(sent.length, 1, "boot repaint");
    for (const hat of ["bow", "leaf", "beanie", "leaf"]) {
      await db.execute({ sql: "UPDATE ramble_eggs SET outfit_json = ? WHERE egg_id = 'b1'", args: [JSON.stringify({ hat })] });
      emitter.emit("ramble:outfit-changed", { egg_id: "b1" });
      await new Promise((r) => setTimeout(r, 30));
    }
    assert.equal(sent.length, 1, "nothing sent while still trying things on");
    const final = renderBirdAvatar({ species: "crow", seed: 2, outfit: { hat: "leaf" } });
    await settle(db, "profile_avatar_url", final);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(sent.length, 2, "exactly one broadcast for the settled outfit");
    assert.equal(JSON.parse(sent[1].content).payload.avatar, final);
  } finally { __resetBirdAvatarHooksForTest(); cleanup(); }
});

test("the tick: a decay-driven mood change reaches the picture with no event; an unchanged portrait never re-sends", async () => {
  __resetBirdAvatarHooksForTest();
  const { db, cleanup } = freshDb();
  try {
    await seedContact(db);
    await plantBird(db, { eggId: "b1", species: "crow", seed: 2 });
    await putSetting(db, "profile_avatar_source", "bird");
    const sent = [];
    installBirdAvatarHooks(mgrsWith(db, sent), { emitter: new EventEmitter(), settleMs: 0, tickMs: 60 });
    await settle(db, "profile_avatar_url", renderBirdAvatar({ species: "crow", seed: 2 }));
    await new Promise((r) => setTimeout(r, 250)); // several ticks, nothing changed
    assert.equal(sent.length, 1, "idle ticks broadcast nothing");
    // Fed a day ago from 61: four decay steps -> 21 -> alarmed.
    await db.execute({ sql: "UPDATE ramble_pet SET energy = 61, last_fed_at = ? WHERE owner = 'self'", args: [Date.now() - 4 * DECAY_INTERVAL_MS - 1000] });
    const sad = renderBirdAvatar({ species: "crow", seed: 2, mood: "alarmed" });
    await settle(db, "profile_avatar_url", sad);
    assert.equal(await setting(db, "profile_avatar_url"), sad);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(sent.length, 2, "one broadcast for the crossing, then quiet");
  } finally { __resetBirdAvatarHooksForTest(); cleanup(); }
});

test("defaults: a short settle and a half-hourly tick", () => {
  assert.equal(AVATAR_SETTLE_MS, 20_000);
  assert.equal(AVATAR_TICK_MS, 30 * 60_000);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- tests/profile-avatar-bird.test.js`
Expected: FAIL — missing exports (`portraitMood`, `readPortrait`, `DECAY_INTERVAL_MS`, ...).

- [ ] **Step 3: Implement**

`pet.js`: change `const DECAY_INTERVAL_MS` / `const DECAY_PER_INTERVAL` to `export const` (values unchanged).

`profile-avatar.js` — update the header comment's "the 'happy' portrait" wording to say the portrait carries the real mood (D2) and the outfit (spec §5.3), and that triggers are coalesced (§5.4). Then:

```js
/* Core's own copy of pet.js's decay-on-read and moodFor — core never imports
 * a bundle module at runtime (an installed copy may be older or absent).
 * tests/profile-avatar-bird.test.js pins these to pet.js's exports. */
const DECAY_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DECAY_PER_INTERVAL = 10;
const MOODS = new Set(["happy", "tired", "alarmed"]);
export const AVATAR_SETTLE_MS = 20_000;
export const AVATAR_TICK_MS = 30 * 60_000;

export function portraitMood(energy, lastFedAt, now = Date.now()) {
  let e = Number(energy);
  if (!Number.isFinite(e)) return "happy";
  const fed = Number(lastFedAt);
  if (lastFedAt != null && Number.isFinite(fed) && now - fed >= DECAY_INTERVAL_MS) {
    e = Math.max(0, e - Math.floor((now - fed) / DECAY_INTERVAL_MS) * DECAY_PER_INTERVAL);
  }
  return e >= 60 ? "happy" : e >= 30 ? "tired" : "alarmed";
}

/** The active bird as it should look to contacts: mood + outfit. Never throws. */
export async function readPortrait(db, { now = Date.now() } = {}) {
  const bird = await readActiveBird(db);
  if (!bird) return null;
  let mood = "happy";
  try {
    const { rows } = await db.execute({ sql: "SELECT energy, last_fed_at FROM ramble_pet WHERE owner = 'self'", args: [] });
    if (rows[0]) mood = portraitMood(rows[0].energy, rows[0].last_fed_at, now);
  } catch { /* default bird */ }
  let outfit = null;
  try {
    // Its own query: on an older bundle's table the column is absent, and that
    // must cost the outfit, never the whole portrait.
    const { rows } = await db.execute({ sql: "SELECT outfit_json FROM ramble_eggs WHERE egg_id = ?", args: [bird.egg_id] });
    const raw = rows[0]?.outfit_json;
    if (typeof raw === "string" && raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) outfit = parsed;
    }
  } catch { outfit = null; }
  return { ...bird, mood, outfit };
}
```

Replace `renderBirdAvatar`'s body:
```js
export function renderBirdAvatar(bird, engine = loadBirdEngine()) {
  if (!bird || !engine) return null;
  try {
    let genome = engine.rollGenome(bird.seed, bird.species);
    // applyOutfit validates against its own slot table; an older installed
    // engine without it simply draws the plain bird.
    if (bird.outfit && typeof engine.applyOutfit === "function") genome = engine.applyOutfit(genome, bird.outfit);
    const mood = MOODS.has(bird.mood) ? bird.mood : "happy";
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">'
      + engine.drawBird(genome, mood) + "</svg>";
    return validateAvatar("data:image/svg+xml;base64," + Buffer.from(svg, "utf8").toString("base64"));
  } catch { return null; }
}

export async function renderActiveBirdAvatar(db, { now = Date.now() } = {}) {
  return renderBirdAvatar(await readPortrait(db, { now }));
}
```

Replace `installBirdAvatarHooks` and the reset:
```js
let _hooksInstalled = false;
let _settleTimer = null;
let _tickTimer = null;
/**
 * Once per process. §5.4: outfits and mood both feed the picture, and every
 * change re-broadcasts to every contact — so triggers are COALESCED. Each
 * trigger (re)arms one settle timer; only when it fires does a refresh run,
 * so trying on four hats sends one picture. The refresh itself stays
 * serialized (the promise chain, fix round 1 Finding 2) and idempotent (an
 * unchanged portrait never re-sends). The tick covers what has no event:
 * energy decay crossing a mood threshold, and an outfit changed on another
 * instance arriving by sync apply.
 */
export function installBirdAvatarHooks(managers, { emitter = bus, settleMs = AVATAR_SETTLE_MS, tickMs = AVATAR_TICK_MS } = {}) {
  if (_hooksInstalled) return false;
  _hooksInstalled = true;
  let inflight = Promise.resolve();
  const run = () => { inflight = inflight.then(() => refreshBirdAvatar(managers?.db, managers)).catch(() => {}); };
  const schedule = () => {
    if (_settleTimer) clearTimeout(_settleTimer);
    _settleTimer = setTimeout(() => { _settleTimer = null; run(); }, Math.max(0, Number(settleMs) || 0));
    _settleTimer.unref?.();
  };
  emitter.on("ramble:hatched", schedule);
  emitter.on("ramble:bird-activated", schedule);
  emitter.on("ramble:outfit-changed", schedule);
  if (Number(tickMs) > 0) {
    _tickTimer = setInterval(schedule, Number(tickMs));
    _tickTimer.unref?.();
  }
  // R1-Q2: the bird may have changed while this gateway was down — one
  // idempotent repaint at boot, not debounced.
  run();
  return true;
}
export function __resetBirdAvatarHooksForTest() {
  _hooksInstalled = false; _engine = undefined;
  if (_settleTimer) { clearTimeout(_settleTimer); _settleTimer = null; }
  if (_tickTimer) { clearInterval(_tickTimer); _tickTimer = null; }
}
```

`refreshBirdAvatar` calls `renderActiveBirdAvatar(db)` — leave that call as is (it now takes the real mood/outfit).

- [ ] **Step 4: Run to verify they pass**

Run: `npm test -- tests/profile-avatar-bird.test.js tests/ramble-pet.test.js tests/peer-profile.test.js tests/profile-avatar-form.test.js`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git commit servers/sharing/profile-avatar.js bundles/ramble/server/pet.js tests/profile-avatar-bird.test.js -m "feat(profile): the bird portrait carries real mood (D2) + outfit; coalesced triggers + periodic tick (spec §5.4)"
```

---

### Task 7: The panel — wardrobe sheet, and every own-bird surface wears the outfit

**Files:**
- Modify: `bundles/ramble/panel/ramble.js` (HTML template — no new backticks)
- Modify: `bundles/ramble/panel/static/ramble.js`
- Modify: `bundles/ramble/panel/static/ramble-ar.js`
- Modify: `bundles/ramble/panel/static/ramble.css`
- Modify: `servers/gateway/dashboard/shared/notifications.js` (inside a template literal — no backticks, no `${`)
- Test: `tests/ramble-panel.test.js` (extend)

**Interfaces:**
- Consumes: `GET /api/ramble/wardrobe`, `POST /api/ramble/wardrobe/buy`, `POST /api/ramble/birds/:id/outfit`, `GET /api/ramble/pet` `bird.outfit`, `GET /api/ramble/flock` `birds[i].outfit` (Tasks 3, 5); engine `applyOutfit` (Task 1).
- Produces (static ramble.js, pure and extractable for tests):
  - `birdGenome(engine, bird) -> genome | null` — `rollGenome(bird.seed, bird.species)` then `applyOutfit(g, bird.outfit)` when both exist; null on any engine complaint.
  - `wardrobeRowState(item, worn, balance, hasBird) -> { action: "buy"|"wear"|"off", label: string, disabled: boolean }`.

Surfaces (spec §5.3) that must wear the outfit: the pet page bird (`paintPet`), the flock grid (`birdTile`), the map "you" marker (`hereArt`), the AR bird (`arBirdState` → ramble-ar.js `paintBird`), the header perch (notifications.js `refreshRambleBird`/`_drawRambleBird`). Surfaces that must stay PLAIN: public/contact mark pins (`ramble.js` ~646 `mark.bird_seed`), the hatch reveal (~2101, a fresh bird has no outfit).

- [ ] **Step 1: Write the failing tests** — append to `tests/ramble-panel.test.js` (reuse its existing `extractFunction` helper and its `src` loading of `bundles/ramble/panel/static/ramble.js`; load the panel HTML the same way the file's other HTML tests do):

```js
test("birdGenome: the rolled bird plus its outfit; plain without one; null on junk", () => {
  const src = readFileSync(join(REPO_ROOT_FOR_PANEL, "bundles/ramble/panel/static/ramble.js"), "utf8");
  const fnSrc = extractFunction(src, "birdGenome");
  assert.ok(fnSrc, "birdGenome must be defined and extractable");
  const birdGenome = new Function(fnSrc + "\nreturn birdGenome;")();
  const Bird = createRequire(import.meta.url)("../bundles/ramble/server/bird-svg.cjs");
  const rolled = Bird.rollGenome(1, "crow");
  assert.deepEqual(birdGenome(Bird, { species: "crow", seed: 1 }), rolled);
  assert.deepEqual(birdGenome(Bird, { species: "crow", seed: 1, outfit: {} }), rolled);
  assert.equal(birdGenome(Bird, { species: "crow", seed: 1, outfit: { hat: "beanie", glasses: "round" } }).glasses, "round");
  assert.equal(birdGenome(Bird, { species: "dodo", seed: 1 }), null);
  assert.equal(birdGenome(null, { species: "crow", seed: 1 }), null);
  const oldEngine = { rollGenome: Bird.rollGenome };
  assert.deepEqual(birdGenome(oldEngine, { species: "crow", seed: 1, outfit: { hat: "beanie" } }), rolled, "older engine: plain bird");
});

test("wardrobeRowState: buy / wear / take off, and when each is disabled", () => {
  const src = readFileSync(join(REPO_ROOT_FOR_PANEL, "bundles/ramble/panel/static/ramble.js"), "utf8");
  const wardrobeRowState = new Function(extractFunction(src, "wardrobeRowState") + "\nreturn wardrobeRowState;")();
  const item = { id: "hat.bow", slot: "hat", value: "bow", name: "Bow", price: 8, owned: false };
  assert.deepEqual(wardrobeRowState(item, false, 8, true), { action: "buy", label: "Buy for 8 seed", disabled: false });
  assert.deepEqual(wardrobeRowState(item, false, 7, true), { action: "buy", label: "Buy for 8 seed", disabled: true });
  assert.deepEqual(wardrobeRowState(item, false, -3, true).disabled, true, "a negative balance buys nothing");
  assert.deepEqual(wardrobeRowState(item, false, 50, false).disabled, false, "you can shop before anything hatches");
  const owned = { ...item, owned: true };
  assert.deepEqual(wardrobeRowState(owned, false, 0, true), { action: "wear", label: "Wear", disabled: false });
  assert.deepEqual(wardrobeRowState(owned, true, 0, true), { action: "off", label: "Take off", disabled: false });
  assert.equal(wardrobeRowState(owned, false, 0, false).disabled, true, "nothing to dress yet");
});

test("every OWN-bird render site goes through birdGenome; mark pins and the hatch reveal stay plain", () => {
  const src = readFileSync(join(REPO_ROOT_FOR_PANEL, "bundles/ramble/panel/static/ramble.js"), "utf8");
  for (const fn of ["paintPet", "birdTile", "hereArt"]) {
    const body = extractFunction(src, fn);
    assert.ok(body, fn);
    assert.ok(body.includes("birdGenome("), `${fn} dresses the bird`);
    assert.ok(!/Bird\.rollGenome\(/.test(body), `${fn} has no undressed roll left`);
  }
  assert.ok(extractFunction(src, "arBirdState").includes("outfit"), "the AR bird carries its outfit");
  const ar = readFileSync(join(REPO_ROOT_FOR_PANEL, "bundles/ramble/panel/static/ramble-ar.js"), "utf8");
  const paint = extractFunction(ar, "paintBird");
  assert.ok(paint.includes("applyOutfit"), "AR applies the outfit");
  assert.ok(paint.includes("outfit"), "and keys its redraw cache on it");
});

test("the wardrobe is a sheet off the pet view (spec §5.5), says who can see it, and adds no backtick to the template", () => {
  const html = readFileSync(join(REPO_ROOT_FOR_PANEL, "bundles/ramble/panel/ramble.js"), "utf8");
  assert.ok(html.includes('id="rb-open-wardrobe"'));
  assert.ok(html.includes('id="rb-wardrobe-sheet"'));
  assert.ok(/Contacts see what you have on/.test(html));
  assert.ok(/Strangers on the map never do/.test(html));
  assert.ok(!/data-view="wardrobe"|data-for="wardrobe"/.test(html), "not a fifth view");
});

test("the header perch dresses the bird and adds no backtick inside its template literal", () => {
  const src = readFileSync(join(REPO_ROOT_FOR_PANEL, "servers/gateway/dashboard/shared/notifications.js"), "utf8");
  const start = src.indexOf("function _drawRambleBird");
  const end = src.indexOf("// ── end ramble bird integration ──");
  const block = src.slice(start, end);
  assert.ok(block.includes("applyOutfit"), "the header perch wears the outfit");
  assert.ok(!block.includes("`") && !block.includes("${"), "no template syntax inside the template literal");
  // The module must still parse (a stray backtick would break the whole dashboard).
  return import("../servers/gateway/dashboard/shared/notifications.js");
});
```

(`REPO_ROOT_FOR_PANEL`, `readFileSync`, `join`, `createRequire`: reuse whatever the test file already imports/defines for its repo root and file reads; add only the imports that are missing. Do not duplicate `extractFunction`.)

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- tests/ramble-panel.test.js`
Expected: the five new tests FAIL; all pre-existing tests PASS.

- [ ] **Step 3: Implement**

**3a. `bundles/ramble/panel/static/ramble.js`** — add near the top-level helpers (after `setHidden`):
```js
  /* Phase 4: YOUR bird as it looks today — the rolled genome with what it is
   * wearing layered over it. Every own-bird surface goes through here; mark
   * pins and the hatch reveal deliberately do not (spec D10: strangers only
   * ever see the plain rolled bird). An older engine without applyOutfit
   * draws the plain bird. */
  function birdGenome(engine, bird) {
    if (!engine || !bird) return null;
    var g;
    try { g = engine.rollGenome(bird.seed, bird.species); } catch (e) { return null; }
    if (bird.outfit && typeof engine.applyOutfit === "function") {
      try { g = engine.applyOutfit(g, bird.outfit); } catch (e) { /* plain bird */ }
    }
    return g;
  }
```
Then:
- `hereArt`: replace `Bird.mountBird(svg, Bird.rollGenome(lastPet.bird.seed, lastPet.bird.species), ...)` with `var hg = birdGenome(Bird, lastPet.bird); if (hg) Bird.mountBird(svg, hg, (lastPet && lastPet.mood) || "happy");`.
- `paintPet`: replace `try { genome = Bird.rollGenome(bird.seed, bird.species); } catch (e) { genome = null; }` with `genome = birdGenome(Bird, bird);`. Keep the traits line reading `genome.hat` (it now shows the worn hat).
- `birdTile`: replace `Bird.mountBird(svg, Bird.rollGenome(bird.seed, bird.species), "happy")` with `var tg = birdGenome(Bird, bird); if (tg) Bird.mountBird(svg, tg, "happy");`.
- `arBirdState`: return `{ species: bird.species, seed: bird.seed, mood: lastPet.mood || "happy", outfit: bird.outfit || null }`.

Add the wardrobe block after `refreshPet` and its chore listeners:
```js
  /* ------------------------------------------------------------- wardrobe */

  /* Pure: what an item's row button does right now. Shopping needs no bird;
   * wearing does. A balance can be negative (two of your Crows spent the same
   * seed while apart) and then buys nothing. */
  function wardrobeRowState(item, worn, balance, hasBird) {
    if (!item.owned) return { action: "buy", label: "Buy for " + item.price + " seed", disabled: !(balance >= item.price) };
    if (worn) return { action: "off", label: "Take off", disabled: !hasBird };
    return { action: "wear", label: "Wear", disabled: !hasBird };
  }

  var wardrobeSheet = $("rb-wardrobe-sheet");
  var wardrobeLast = null;

  function paintWardrobe(w) {
    wardrobeLast = w;
    var list = $("rb-wardrobe-list");
    if (!w || !list) return;
    setText($("rb-wardrobe-seed"), String(w.seed));
    var me = $("rb-wardrobe-bird");
    var active = w.active;
    if (me) {
      var g = active ? birdGenome(Bird, active) : null;
      if (g) { try { Bird.mountBird(me, g, (lastPet && lastPet.mood) || "happy"); } catch (e) { /* cosmetic */ } }
      else me.textContent = "";
    }
    setText($("rb-wardrobe-nobird"), active ? "" : "Nothing has hatched yet. You can shop now and dress up once you do.");
    list.textContent = "";
    (w.items || []).forEach(function (item) {
      var worn = !!(active && active.outfit && active.outfit[item.slot] === item.value);
      var st = wardrobeRowState(item, worn, w.seed, !!active);
      var row = document.createElement("div");
      row.className = "rb-step rb-wardrobe-row" + (worn ? " is-worn" : "");
      var txt = document.createElement("div");
      txt.className = "rb-step-txt";
      var name = document.createElement("strong");
      name.textContent = item.name;
      txt.appendChild(name);
      var sub = document.createElement("span");
      sub.className = "rb-muted rb-fine";
      sub.textContent = worn ? "wearing it" : (item.owned ? "yours" : item.price + " seed");
      txt.appendChild(sub);
      row.appendChild(txt);
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "rb-btn rb-btn-ghost";
      btn.textContent = st.label;
      btn.disabled = st.disabled;
      btn.addEventListener("click", function () { wardrobeAct(st.action, item, active, btn); });
      row.appendChild(btn);
      list.appendChild(row);
    });
  }

  function refreshWardrobe() {
    return jsonFetch("/api/ramble/wardrobe").then(paintWardrobe)
      .catch(function (err) { setText($("rb-wardrobe-status"), err.message); });
  }

  function wardrobeAct(action, item, active, btn) {
    btn.disabled = true;
    var req = action === "buy"
      ? jsonFetch("/api/ramble/wardrobe/buy", { method: "POST", body: { item: item.id } })
      : jsonFetch("/api/ramble/birds/" + encodeURIComponent(active.egg_id) + "/outfit",
          { method: "POST", body: { slot: item.slot, item: action === "off" ? null : item.id } });
    req.then(function () {
      setText($("rb-wardrobe-status"), action === "buy" ? "It's yours." : (action === "off" ? "Taken off." : "Looking good."));
      return Promise.all([refreshWardrobe(), refreshPet()]);
    }).catch(function (err) {
      setText($("rb-wardrobe-status"), err.message);
      btn.disabled = false;
    });
  }

  function openWardrobe(open) {
    if (!wardrobeSheet) return;
    setHidden(wardrobeSheet, !open);
    if (open) { setText($("rb-wardrobe-status"), ""); refreshWardrobe(); }
  }
  var openWardrobeBtn = $("rb-open-wardrobe");
  if (openWardrobeBtn) openWardrobeBtn.addEventListener("click", function () { openWardrobe(true); });
  var closeWardrobeBtn = $("rb-wardrobe-close");
  if (closeWardrobeBtn) closeWardrobeBtn.addEventListener("click", function () { openWardrobe(false); });
  if (wardrobeSheet) wardrobeSheet.addEventListener("click", function (ev) { if (ev.target === wardrobeSheet) openWardrobe(false); });
  document.addEventListener("keydown", function (ev) {
    if (ev.key === "Escape" && wardrobeSheet && !wardrobeSheet.hidden) openWardrobe(false);
  });
```
(`wardrobeLast` is kept for debugging parity with `lastPet`; if a linter flags it unused, remove it.)

Check `jsonFetch`'s error contract: if a 409 body `{ error: "short" }` surfaces as `err.message === "short"`, map the two refusal codes to copy before `setText`: `"short"` → `"Not enough seed yet."`, `"owned"` → `"You already have that."`, `"not-owned"` → `"Buy it first."`. Read `jsonFetch` (static ramble.js ~line 59) and implement the mapping in `wardrobeAct`'s catch only for those codes.

**3b. `bundles/ramble/panel/ramble.js`** (HTML) — in the pet view, immediately before `<button class="rb-btn" id="rb-my-flock" ...>`:
```html
          <button class="rb-btn rb-btn-ghost" id="rb-open-wardrobe" type="button">Wardrobe</button>
```
and, after the `rb-pick-sheet` block's closing `</div>`:
```html
        <!-- ─────────────────────────────── the wardrobe (phase 4, spec §5.5) -->
        <!-- A sheet off the pet view, not a fifth view. -->
        <div class="rb-sheet" id="rb-wardrobe-sheet" hidden>
          <div class="rb-sheet-panel" role="dialog" aria-modal="true" aria-labelledby="rb-wardrobe-title">
            <div class="rb-sheet-head">
              <h3 class="rb-h" id="rb-wardrobe-title">Wardrobe</h3>
              <button class="rb-icon-btn" id="rb-wardrobe-close" type="button" aria-label="Close">${icon("close")}</button>
            </div>
            <svg id="rb-wardrobe-bird" class="rb-bird rb-wardrobe-bird" viewBox="0 0 200 200" role="img" aria-label="You, as you look today"></svg>
            <p class="rb-muted rb-fine" id="rb-wardrobe-nobird"></p>
            <p class="rb-fine"><strong id="rb-wardrobe-seed">0</strong> bird seed</p>
            <p class="rb-muted rb-fine">Buy something once and any of your birds can wear it. Contacts see what you have on. Strangers on the map never do.</p>
            <div class="rb-steps" id="rb-wardrobe-list"></div>
            <p class="rb-muted rb-fine" id="rb-wardrobe-status"></p>
          </div>
        </div>
```

**3c. `ramble-ar.js` `paintBird`** — change the key and the mount:
```js
      var outfitKey = bird.outfit ? JSON.stringify(bird.outfit) : "";
      var key = bird.species + ":" + bird.seed + ":" + (bird.mood || "happy") + ":" + outfitKey;
      if (key === birdKey) return;
      birdKey = key;
      try {
        var g = engine.rollGenome(bird.seed, bird.species);
        if (bird.outfit && typeof engine.applyOutfit === "function") g = engine.applyOutfit(g, bird.outfit);
        engine.mountBird(e.bird, g, bird.mood || "happy");
      } catch (err) { /* cosmetic */ }
```

**3d. `ramble.css`** — append:
```css
#ramble .rb-wardrobe-bird { width: 112px; height: 112px; display: block; margin: 4px auto 0; }
#ramble .rb-wardrobe-row { display: flex; align-items: center; gap: 10px; }
#ramble .rb-wardrobe-row .rb-step-txt { flex: 1; min-width: 0; }
#ramble .rb-wardrobe-row.is-worn strong { color: var(--rb-accent, currentColor); }
```
(Check `ramble.css` for the panel's real accent token name and use it instead of `--rb-accent` if it differs.)

**3e. `notifications.js`** (inside the template literal: single quotes, ES5, no backticks, no `${`):
- `_drawRambleBird(species, seed, mood)` → `_drawRambleBird(species, seed, mood, outfit)`, and the draw line becomes:
```js
      var g = RambleBird.rollGenome(seed, species);
      if (outfit && typeof RambleBird.applyOutfit === 'function') g = RambleBird.applyOutfit(g, outfit);
      inner.innerHTML = RambleBird.drawBird(g, mood);
```
- Declare `var _rambleBirdOutfit = null;` beside `_rambleBirdMood`.
- In `refreshRambleBird`: `var outfit = data.bird.outfit || null; var outfitKey = outfit ? JSON.stringify(outfit) : '';`; extend the early-return comparison with `&& outfitKey === _rambleBirdOutfit`; pass `outfit` to `_drawRambleBird`; set `_rambleBirdOutfit = outfitKey;` with the other three.

- [ ] **Step 4: Run to verify they pass**

Run: `npm test -- tests/ramble-panel.test.js tests/ramble-header-bird.test.js tests/ramble-ar.test.js`
Expected: all PASS.

Then load the real page once to confirm it parses and the sheet opens: `node servers/gateway/index.js --no-auth` is NOT safe on crow (it would bind real ports next to prod). Instead run `node -e "import('./bundles/ramble/panel/ramble.js').then(m=>console.log(typeof m.default))"` and `node --check bundles/ramble/panel/static/ramble.js && node --check bundles/ramble/panel/static/ramble-ar.js`. Expected: `function` and no syntax errors.

- [ ] **Step 5: Commit**

```bash
git commit bundles/ramble/panel/ramble.js bundles/ramble/panel/static/ramble.js bundles/ramble/panel/static/ramble-ar.js bundles/ramble/panel/static/ramble.css servers/gateway/dashboard/shared/notifications.js tests/ramble-panel.test.js -m "feat(ramble): wardrobe sheet off the pet view; pet, flock, map marker, AR and header perch wear the outfit"
```

---

### Task 8: Docs, version, registry, full gates

**Files:**
- Modify: `docs/guide/ramble.md`, `docs/es/guide/ramble.md`
- Modify: `bundles/ramble/manifest.json` (0.12.1 → 0.13.0), `registry/add-ons.json` (regenerated)

**Interfaces:** none new.

- [ ] **Step 1: Docs.** In `docs/guide/ramble.md`, add a `## Wardrobe` section directly after `## Your flock`:

```markdown
## Wardrobe

Bird seed buys things to wear: hats (bow, leaf, beanie), scarves (knitted, striped) and glasses (round, shades). Open **Wardrobe** from your bird's page. Buy something once and any of your birds can wear it; each bird remembers its own outfit, so switching birds switches clothes. Taking a hat off brings back whatever hat the bird hatched with.

What you wear shows on your bird's page, your flock, your marker on the map, the AR view, the bird in the dashboard header, and your **profile picture** if you use your bird as one — which is how contacts see it. **Strangers never do:** public marks always carry the plain bird you hatched, because a chosen outfit would tie your rotating map identities together.

Your profile picture also shows how you are doing. A bird left without walks or chores looks tired, then rattled, to your contacts — nothing worse than that ever happens. Changes to the picture are gathered up and sent once things settle (about twenty seconds after your last change), and a quiet stretch is noticed within half an hour, so trying on four hats sends your contacts one picture, not four.

Purchases are recorded the same way seed pickups are, as a ledger on each of your Crows that syncs between them. If two of your Crows buy while out of touch with each other, both purchases stand once they reconnect, and your balance can briefly read below zero; it climbs back as you collect seed, and nothing can be bought until it does.

| Item | Price (seed) |
|---|---|
| Bow, Leaf | 8 |
| Beanie | 12 |
| Knitted scarf | 15 |
| Striped scarf, Round glasses | 20 |
| Shades | 25 |

API: `GET /api/ramble/wardrobe`, `POST /api/ramble/wardrobe/buy { item }`, `POST /api/ramble/birds/:id/outfit { slot, item | null }`.
```

In `docs/es/guide/ramble.md`, add the equivalent `## Vestuario` section after `## Tu bandada`:

```markdown
## Vestuario

El alpiste compra cosas para ponerte: sombreros (lazo, hoja, gorro), bufandas (de punto, de rayas) y gafas (redondas, de sol). Abre **Vestuario** desde la página de tu pájaro. Compra algo una vez y cualquiera de tus pájaros puede llevarlo; cada pájaro recuerda su propio atuendo, así que cambiar de pájaro cambia la ropa. Quitarte un sombrero devuelve el sombrero con el que nació el pájaro.

Lo que llevas se ve en la página de tu pájaro, tu bandada, tu marcador en el mapa, la vista AR, el pájaro de la cabecera del panel y tu **foto de perfil** si usas tu pájaro como foto — así es como lo ven tus contactos. **Los desconocidos nunca lo ven:** las marcas públicas siempre llevan el pájaro tal como nació, porque un atuendo elegido uniría tus identidades rotativas del mapa.

Tu foto de perfil también muestra cómo estás. Un pájaro sin paseos ni tareas se ve cansado y luego agitado ante tus contactos — nunca pasa nada peor. Los cambios de la foto se agrupan y se envían cuando todo se calma (unos veinte segundos después del último cambio), y un rato de inactividad se nota en menos de media hora, así que probarte cuatro sombreros envía a tus contactos una sola foto, no cuatro.

Las compras se registran igual que el alpiste recogido, como un libro de cuentas en cada uno de tus Crows que se sincroniza entre ellos. Si dos de tus Crows compran mientras están desconectados entre sí, ambas compras cuentan al reconectarse y tu saldo puede quedar por un momento por debajo de cero; vuelve a subir al recoger alpiste, y no se puede comprar nada hasta entonces.

| Artículo | Precio (alpiste) |
|---|---|
| Lazo, Hoja | 8 |
| Gorro | 12 |
| Bufanda de punto | 15 |
| Bufanda de rayas, Gafas redondas | 20 |
| Gafas de sol | 25 |

API: `GET /api/ramble/wardrobe`, `POST /api/ramble/wardrobe/buy { item }`, `POST /api/ramble/birds/:id/outfit { slot, item | null }`.
```

Check how the ES guide names bird seed elsewhere (`grep -n -i "alpiste\|semilla" docs/es/guide/ramble.md`) and use THAT term consistently in place of "alpiste" if it differs. Wrap any bare `<placeholder>` tokens in backticks (Deploy Docs was red once for that, commit e345ce9f).

- [ ] **Step 2: Version + registry**

```bash
sed -i 's/"version": "0.12.1"/"version": "0.13.0"/' bundles/ramble/manifest.json
npm run build-registry
git diff --stat registry/add-ons.json bundles/ramble/manifest.json
```
Expected: exactly the ramble version line changes in each file (if `build-registry` rewrites anything else, stop and investigate before committing).

- [ ] **Step 3: Full gates**

```bash
npm test 2>&1 | tail -15
node scripts/check-port-allocation.js
node scripts/build-registry.mjs --check
```
Expected: suite `fail 0` with a pass count above the pre-branch baseline (record both numbers in the PR body; run the baseline on `origin/main` in a scratch worktree if not already known); port check and registry check exit 0. A failure in `tests/sync-stamp.test.js:174` (known pre-existing concurrent-first-boot flake) must be re-run alone and in the full suite once more; report it either way.

No `SCHEMA_GENERATION` bump in this branch: confirm with `git diff origin/main -- scripts/init-db.js | grep -c SCHEMA_GENERATION` → `0`.

- [ ] **Step 4: Commit**

```bash
git commit docs/guide/ramble.md docs/es/guide/ramble.md bundles/ramble/manifest.json registry/add-ons.json -m "docs(ramble): the wardrobe + mood in the portrait; ramble 0.13.0"
```

---

## Self-Review

1. **Spec coverage** — §5.1/5.2 engine override: Task 1. §5.3 ownership (D11) + visibility (all listed surfaces; D10 plain marks): Tasks 3, 5, 7 (+ D10 tests in Tasks 3 and 5). §5.4 coalescing: Task 6. §5.5 sheet: Task 7. §6.1 spend ledger keyed per purchase: Task 2. §6.2 wardrobe (derived) + worn columns on bird rows: Tasks 2–3. §6.3 guarded column, no schema bump: Tasks 3, 4, 8. §6.4 prices in catalogue: Task 2. §7 bounded inputs: Task 5 validation. §8 multi-instance tests + accessory rendering at every site + coalescing: Tasks 4, 6, 7. D2 sad portrait: Task 6.
2. **Placeholders** — none; two implementer checks are explicit lookups with a stated fallback (db path in Task 5, `jsonFetch` error contract in Task 7, CSS accent token, ES term for seed).
3. **Type consistency** — `outfit` is always a plain `{slot: value}` object server-side (`parseOutfit`), `null`-or-object in core `readPortrait` (engine validates); item ids `slot.value`; `buyItem` → `{ok, reason, balance}`, route maps `balance` → `seed`.
4. **Review Focus** — each line has its test: (1) Task 2 negative-balance + Task 4 offline tests; (2) Task 1 rolled-hat restore + Task 3 D10 + Task 5 plain pin route; (3) Task 4 old-table test; (4) Task 6 coalescing + tick tests; (5) Task 1 junk, Task 3 `parseOutfit`/corrupt, Task 6 corrupt/missing column.
