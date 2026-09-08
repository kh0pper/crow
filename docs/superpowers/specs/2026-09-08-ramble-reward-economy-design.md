# Ramble reward economy — the map, the currencies, the egg loop, accessories (design)

**Status:** design approved in brainstorming 2026-09-08 (Kevin), section by section. One spec, four shipping phases.
**Builds on:** Ramble 0.8.1 (flock design `2026-09-07-ramble-flock-design.md`; names+profile design `2026-09-08-ramble-names-and-profile-design.md`, shipped as PR #325).
**Origin:** after playing, Kevin reported that pressing all three chore buttons in a row finished the day, which "leaves this game not very engaging", and that hatching auto-hands you a replacement egg, which "seems to defeat the purpose" of encouraging people to get out and walk. Investigation found the complaint was sharper than stated: the bird's energy is **entirely cosmetic** — nothing anywhere reads it — so the three chores were not merely unengaging, they were inconsequential. Meanwhile walking already fed the bird more than tapping did (a new place is worth +15 energy against a chore's +8) and the pet page never said so.

---

## 0. Decisions (locked)

| # | Decision | Chosen |
|---|---|---|
| D1 | What the chores are | A **supporting habit around walking**, not a standalone care ritual. Their spacing is therefore not the problem and is not changed. |
| D2 | Energy's stakes | A **soft consequence**: a neglected bird's portrait looks sad **to contacts**. No fail state. Nothing is ever destroyed. Revival items are explicitly dropped — there is nothing to revive from. |
| D3 | Warmth with no egg | It **vanishes**. Warmth is the only quantity in the game that can be wasted; this is deliberate, and auto-promote (D8) is what keeps it rare. |
| D4 | The map | **Fog of war**, three zones (§2). **Public overlay only** — contact and group marks are unaffected, because contacts are geographically spread and requiring a visit to their area would be impractical. |
| D5 | Frontier contents | **Typed beacons**: you can see that a nest is a nest and a mark is a mark, but not what any mark says, until you unlock the cell. |
| D6 | Currencies | **Two tiers**: **bird seed** (common, respawns in unlocked ground, buys accessories) and **heart containers** (rare, raise maximum energy only). The Zelda mapping: rupees buy gear, hearts only extend the bar. |
| D7 | What bird seed buys | **Accessories** — hats, scarves, glasses. Explicitly *not* invented stats: the pet has exactly one number (energy), so a stat system would have had to be created from nothing. |
| D8 | Egg supply | **Nests and gifts**, plus **auto-promote** from the shelf when the incubating slot empties. No pity timer. |
| D9 | The floor | Your **active bird lays an egg** after a sustained period of care while you have no eggs at all. Rarity comes from **demanding conditions, not a dice roll** — the mechanism's job is to be a floor, so it must be dependable for whoever actually needs it. |
| D10 | Accessory visibility | **Contacts only.** Public marks keep the plain rolled bird: a chosen outfit would be a deliberate signature across rotating personas, far stronger than the soft identifier the flock design already concedes. |
| D11 | Wardrobe ownership | **Shared wardrobe, per-bird outfit.** Buy an item once, any bird may wear it, each bird remembers its own. Buying per bird would make purchases disposable and would punish hatching. |
| D12 | Onboarding | **One starter egg, once ever**, given as a narrative gift, with a second tutorial beat when it hatches. |
| D13 | Steps counter | **Deferred to a future version.** See §10. |

---

## 1. Vocabulary

- **cell** — a geohash-7 square, roughly 153 m on a side. Already the unit Ramble uses for "a new place".
- **unlocked** — a cell the user has physically entered (within `CLAIM_RANGE_M`, 75 m). Permanent.
- **frontier** — the band of cells beyond the unlocked edge that is previewed but not owned. Rolling.
- **bird seed** — the common currency. Respawns in unlocked cells.
- **heart container** — the rare currency. Raises maximum energy and does nothing else.
- **warmth** — existing: fills the incubating egg. **energy** — existing: the bird's condition.
- **laying** — the active bird producing an egg after sustained care while the user has none.

---

## 2. The map

### 2.1 Three zones

| Zone | Definition | What is visible | Persistence |
|---|---|---|---|
| **Unlocked** | Cells entered within 75 m | Marks and caws readable; nests claimable; bird seed grows here | Permanent |
| **Frontier** | A configurable depth of cells beyond the unlocked edge (default 3) | **Typed beacons only** — that a nest, mark or caw exists, never its content | Rolling; moves with the user |
| **Fog** | Everything else | Nothing | — |

The frontier is a *preview*, not a reward. Only ground actually walked becomes permanently unlocked; if the preview persisted, the map would grow at twice the rate the player walks and the fog would retreat faster than it is earned.

### 2.2 Why this resolves the exploration problem

Nests sit in roughly one cell in twenty-four (`NEST_RATE_DEFAULT = 24`). Were nests invisible until entered, finding one would mean walking into about two dozen new cells blind. A frontier three cells deep places roughly 48 cells in view and therefore about two nests, so the player reliably has a destination without any content being given away.

### 2.3 Spawn rules

- **Heart containers derive deterministically from the cell**, copying the existing `nestFor(cell, week)` pattern rather than being stored: a hash of the cell decides, hitting roughly one in three first unlocks. This is unpredictable to the player, identical across their devices, and cannot be re-rolled by leaving and re-entering.
- **Heart containers may also appear rarely in already-unlocked ground**, time-gated. This makes maximum energy technically grindable by a heavy walker who never explores. Accepted deliberately: maximum energy is not competitive power, only a longer buffer before drooping, and this lets someone who cannot range far still progress.
- **Bird seed respawns per unlocked cell on a cooldown** (`seed.respawn.hours`, default 24). Walking a familiar route pays; pacing one cell does not.

### 2.4 Privacy

The unlocked-cell set is a precise, permanent record of everywhere the user has physically been. It is **the most sensitive data this feature creates**.

- It **replicates across the user's own instances**, so the map built on a phone appears on their other machines.
- It **never leaves for a contact**, in the same way nest claims are already local by design.
- Fog additionally *reduces* exposure: a user can only read public marks near where they have actually been, which removes the ability to survey a whole city's marks remotely.

---

## 3. The economy

Four quantities, each with exactly one job.

| Quantity | Earned by | What it does | Behaviour |
|---|---|---|---|
| **Warmth** | New places, meeting crows | Fills the incubating egg | Vanishes with no egg (D3) |
| **Energy** | Walking, chores, check-in | The bird's condition; low means a sad portrait to contacts (D2) | Tops up to a maximum |
| **Bird seed** | Respawns in unlocked ground | Buys accessories | Accumulates |
| **Heart containers** | ~1 in 3 first unlocks; rarely in familiar ground | Raise maximum energy | Accumulates |

The loop in one sentence: **routine sustains you, exploration advances you.** Familiar ground pays seed and tops up energy, so a commute or a regular park loop is never wasted. New ground pays that plus warmth plus a heart container about a third of the time, and is the only route to hatching and to permanent progression.

**Existing energy deltas are unchanged**: meet a crow +20, new place +15, unlock a mark +10, chore +8, check in +5, idle −10.

---

## 4. The egg loop

### 4.1 Sources

1. **Nests** — walk to one, one claim per local day, within 75 m. Unchanged.
2. **Gifts and swaps** from contacts. Unchanged.
3. **Laying** (§4.3).

The **auto-minted successor egg is removed**. This is the largest change to existing behaviour in this spec: `ensureIncubatingEgg` is currently called from four places, **two of which are pure reads** — `eggState` on every `GET /api/ramble/egg` and `flockState` on every flock screen — so merely looking at a screen recreates the egg today. All four callers must tolerate a null egg, and the egg card, the perch ring, the checklist and the AR view all currently assume one exists.

### 4.2 Auto-promote

When the incubating slot empties, the **oldest shelf egg is promoted into it automatically**. The user is therefore only ever eggless when they genuinely have none. Shelf cap stays at 5. This is the release valve that makes D3 (vanishing warmth) tolerable.

### 4.3 Laying

While the user has **no eggs anywhere** (empty slot and empty shelf), each local day their **active** bird ends happy counts one. At the threshold (default 14) the bird lays, and the count resets.

- Days need **not** be consecutive, so one bad day does not erase a fortnight of care.
- The count accrues **only while eggless**. Were it always accruing, a player would run dry and lay almost immediately, undercutting nests as the real supply. Starting the clock when the player runs out is what makes this a floor rather than a faucet.
- **Only the active bird lays.** Otherwise a large flock would make eggs abundant for exactly the players who already have the most, and the fallback would become the main supply.

This mechanism is what gives **heart containers a real purpose**: laying requires sustained happiness, a larger maximum energy means more slack before dropping below happy, so an irregular week is less likely to break the streak. Heart containers buy resilience; resilience buys eggs.

**Default 14, exposed as the setting `lay.days` (§6.4).** 14 means two weeks with no warmth at all for a housebound player; they continue earning seed and hearts throughout, so the game keeps paying, but that one track stops. If it reads as too harsh in play, lowering the setting to 10 is a one-line change, not a redesign.

### 4.4 Onboarding

- **One starter egg, once ever**, granted as a **narrative gift** with a short intro explaining incubation.
- **A second beat when that first egg hatches**, covering pet care and the mechanics.
- Both skippable; both need a dismissal flag.
- **Grant check must be fleet-wide, not per-instance.** Eggs replicate, so the condition is "has any egg ever existed", which the replicated table answers naturally. Deriving the starter egg's id from the Crow identity makes a simultaneous two-instance first run collapse into a single insert rather than granting two eggs.
- This is Ramble's **first narrative content** and sets a voice precedent. Match the panel's existing register — plain, warm, slightly hushed ("Something's stirring in there", "Nobody knows what's inside yet, not even us") — rather than a tutorial box. **The writing is a deliverable, not decoration.**

### 4.5 Chores

**Unchanged: three a day, freely tappable.** The hollowness Kevin reported was never the timing — it was that the taps did not matter and the pet page hid everything that did. Both are now addressed: the page names what feeds the bird (shipped, PR #327), and sustained happiness is what makes a bird lay. A timing gate would add schedule-checking for no gain.

---

## 5. Accessories

### 5.1 What exists already

`bundles/ramble/server/bird-svg.cjs` **already has a hat system**: a genome slot rolled from the hatch seed, three shapes (`bow`, `leaf`, `beanie`) plus `none`, each with draw code that tints to the bird's accent colour. Today the hat is random and immutable.

### 5.2 How wearing works

An owned accessory is an **override layered over the rolled genome**. `drawBird(genome, mood)` takes a genome object, so passing a modified genome makes every render site pick the outfit up **with no change to the drawing engine**. Scarves and glasses are new artwork and new genome slots and do require engine additions.

### 5.3 Ownership and visibility

- **Shared wardrobe, per-bird outfit** (D11).
- Visible on: the pet page, the flock grid, the perch, and **the profile picture**, which is what carries it to contacts.
- **Not** on public marks (D10).

### 5.4 Broadcast pacing — a requirement, not a nicety

The profile picture already re-broadcasts to every contact whenever it changes (shipped in PR #325). Once **both** outfits and mood feed that picture, trying on four hats would send four fan-outs, and every mood threshold crossing (energy 60 and 30) would send another. The design **must coalesce** avatar changes into at most one broadcast per settled state, on a short delay, rather than one per change.

### 5.5 Surface

The shop and wardrobe live in a **sheet reached from the pet view**, not a fifth top-level view. The panel's four views (world, egg, pet, flock) are deliberately shallow and accessories are a pet concern.

---

## 6. Data model and sync

### 6.1 The load-bearing rule: ledgers, not balances

**Balances must not be stored as balances.** If a user picks up seed on two instances, each writes a new total, sync resolves last-writer-wins, and increments are silently lost. The codebase already solved this for warmth: `ramble_credits` is a deduplicated ledger keyed `(kind, key)` and the total is derived from it.

Therefore **seed pickups, heart pickups, spends, and the laying day-count are all ledger rows**, each with a natural idempotent key:

| Event | Key |
|---|---|
| Seed pickup | cell + harvest window |
| Heart pickup | cell (first unlock) or cell + window (familiar ground) |
| Spend | purchase id |
| Laying day | local day |

This is the difference between a currency that survives the user's fleet and one that quietly leaks.

### 6.2 New state

- **One row per unlocked cell**: cell, first unlocked at, seed harvest state, heart taken state.
- **Wardrobe**: owned accessories, user level.
- **Worn items**: columns on the bird rows, which already replicate, so outfits follow a bird for free.
- **Ledger rows** per §6.1.
- **Two prologue dismissal flags.**

### 6.4 Tunable settings

Every number in this spec is a live setting with a default, following the existing `nest.rate` / `shelf.cap` pattern, so balance is changed by configuration rather than by a code change. None of these is a playtest guess baked into logic.

| Setting | Default | Governs |
|---|---|---|
| `frontier.depth` | 3 cells | How far the preview reaches past the unlocked edge (§2.1) |
| `heart.rate` | 3 | Roughly one heart container per this many first unlocks (§2.3) |
| `heart.wild.days` | 30 | Minimum gap before a heart may reappear in already-unlocked ground (§2.3) |
| `seed.respawn.hours` | 24 | Per-cell cooldown before bird seed regrows (§2.3) |
| `seed.per.pickup` | 1 | Seed granted per harvested cell |
| `lay.days` | 14 | Happy days while eggless before the active bird lays (§4.3) |
| `energy.max.base` | 100 | Starting maximum energy |
| `energy.max.per.heart` | 10 | Maximum energy added per heart container |

Accessory prices live in the accessory catalogue rather than in settings, since each item carries its own cost.

### 6.3 Migration

All additive. Follow the guarded-column pattern used by the profile-avatar work: `addColumnIfMissing` in `scripts/init-db.js` for fresh installs plus a guarded `ensureColumn` at runtime for existing hosts, with **no `SCHEMA_GENERATION` bump**. Run `scripts/schema-migration-dryrun.sh` from the branch against copies of all three live databases before each phase's PR.

---

## 7. Safety, privacy, limits

- The unlocked-cell set replicates to the user's own instances only, never to a contact (§2.4).
- Accessories are contacts-only, preserving the rotating persona's unlinkability (D10).
- Fog reduces public-mark exposure rather than increasing it (§2.4).
- No fail state; nothing in this spec destroys player progress except warmth, deliberately (D3).
- All new inputs bounded; currencies derived from deduplicated ledgers cannot be inflated by replay.

---

## 8. Testing

**This project treats prose review as insufficient for anything that replicates and requires executable, multi-instance tests.** That rule exists because a sync defect already cost this project real data. The cell map and every currency ledger replicate, so both need multi-instance tests, not single-database ones.

Beyond that: deterministic heart placement from a cell hash; frontier depth and beacon typing; that a beacon never leaks mark content; auto-promote on an emptying slot; the laying counter accruing only while eggless and surviving non-consecutive days; the starter-egg grant being fleet-wide and race-safe; accessory override rendering at every site; broadcast coalescing; and that all four `ensureIncubatingEgg` callers tolerate a null egg.

---

## 9. Phasing

Every phase before the risky one is purely additive, so that by the time the free egg is removed, walking already pays in three other currencies.

1. **The map.** Fog, frontier, unlocking, bird seed pickups, the cell table. Removes nothing. The biggest change in how the game feels.
2. **Heart containers and maximum energy.** Also pure addition.
3. **The egg supply overhaul.** Removing the auto-minted egg, auto-promote, laying, and the prologue — these only make sense together, since removing the free egg without the laying floor is exactly the harshness the design exists to avoid. **The risky phase, deliberately late.**
4. **Accessories, wardrobe and shop.**

Each phase is its own implementation plan, PR and deploy.

---

## 10. Not in this spec

- **A steps counter (D13).** The browser cannot do it: there is no web standard, and inferring steps from accelerometer events only works while the page is foregrounded. The repo's `android/` app is a thin WebView shell with no activity-recognition permission and no health code, so steps would mean a new permission, a hardware sensor or Health Connect, a foreground service, and a native-to-WebView bridge. Ramble also already measures the better signal: new places by cell, which is exploration rather than effort and cannot be farmed by pacing indoors. Revisit as an Android-shell feature alongside the place counter, not replacing it.
- **AR photo challenges** — a separate design (contacts-only), already scoped in outline.
- Trading currencies between users; a marketplace; any competitive or leaderboard mechanic.
- Stat systems beyond maximum energy.
- Changing the rotating-persona privacy model.
