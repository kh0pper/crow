# Ramble Flock — home, birds, eggs, nests, trading, AR (design)

**Status:** design approved in brainstorming 2026-09-07 (Kevin), one spec, phased build.
**Bundle:** `ramble` (extends the phase-1 core shipped in PR #308; see
`docs/superpowers/specs/2026-09-06-ramble-proximity-ar-design.md` for the substrate this
builds on: marks/caws, privacy grid, identity levels, Nostr transport, same-user sync).
**Supersedes** in the phase-1 spec: §6's "pet look identical for everyone" rule (dropped,
decision D5), §4's "no collecting / inventory at v1" (reversed, D9), and the phase list in §7
(phases 1b/2/3/4 are re-cut below).
**Mockups:** direction C, "Softened Pop" (served during design from crow `:8451`; tokens in §8).

---

## 0. Decisions (locked)

| # | Decision | Chosen |
|---|---|---|
| D1 | Order of work | Home + pet + egg first; nests + flock; contacts delivery + trading; AR. Phases 2 and 4 do not depend on 3. |
| D2 | What hatches an egg | World activity dominant, daily check-in helps a little (option 3, §2) |
| D3 | Species roster | The lab flock: crow, raven, grackle, magpie, mockingbird, hummingbird, penguin, black swan |
| D4 | Uniqueness | Every hatch rolls a genome (seed); species + seed fully determine the look |
| D5 | Where a unique bird is visible | Everywhere, always (rotating identity included). The phase-1 anti-fingerprint rule is dropped. |
| D6 | Art production | Hybrid: procedural SVG parts engine now; a swappable asset pack can replace parts later without touching the engine |
| D7 | Care loop | Light chores: feed / preen / play once a day each; world activity still feeds; never worse than droopy |
| D8 | Home | World-first: the map is the home, the active bird perches on it, tap the bird for the pet screen; no menu |
| D9 | Collecting | Yes: nests in the world, an egg shelf, a flock of hatched birds; species-found is the only score |
| D10 | Trading | Swaps between contacts as the target; gifts first; strangers must exchange an invite (become contacts) first |
| D11 | AR | Camera overlay now (heading + GPS labels, bird composited); WebXR as an upgrade path that consumes the same anchors |
| D12 | Visual direction | C "Softened Pop": B's outlines and chunky headings, quieter amber/indigo palette, tinted offset shadows, designed dark mode |
| D13 | Private notes | A "Just me" audience (`visibility='private'`) for marks only you see |

---

## 1. Vocabulary

- **bird** — a hatched companion: species + seed (+ care state). **active bird** = the one on the
  map, in the header, in AR, and on your caws.
- **egg** — an unhatched record with warmth. **incubating** egg = the single egg gaining warmth.
- **shelf** — your unhatched eggs. **flock** — your hatched birds.
- **nest** — a deterministic spawn point in the world where an egg can be claimed.
- **genome** — `{ species, seed }`; `seed` is a uint32 minted at hatch, immutable.

---

## 2. Game model

### 2.1 Egg and hatch
- A new instance starts with one **incubating** egg (created on first `initRambleTables` +
  first panel/tool touch if absent).
- Warmth 0–100, hatch at 100. Weights (settings, seeded defaults):

| event | warmth | pet energy (unchanged from phase 1) |
|---|---|---|
| `visit_place` — a geohash-7 cell not credited this ISO week | +20 | +15 |
| `mark_left` — you left a mark | +15 | 0 |
| `unlock_mark` | +10 | +10 |
| `meet_crow` — a remote caw/mark from a bird not met this week | +20 | +20 |
| `checkin` — one per local calendar day | +8 | +5 |
| `chore` (feed/preen/play, each once per day) | 0 | +8 each |
| `quiet_tick` / passive decay | 0 | as phase 1 |

  A walker hatches in a day or two; check-ins alone hatch in ~12 days. Every credit is
  idempotent server-side (cell+week, day, persona+week keys in `ramble_credits`).
- **Hatch**: at ≥100 the server rolls the genome (`species` uniform over D3; `seed` =
  `randomUUID()`-derived uint32), sets `status='hatched'`, `hatched_at`, makes it the active
  bird if there is none, and emits `bus("ramble:hatched", { egg_id })` so the client plays the
  hatch moment (wobble, crack, reveal + species name). The client never supplies a seed.

### 2.2 Genome → look
`bird-svg.js` is a dependency-free plain script (no imports/exports besides a
`window.RambleBird` / `module.exports` dual shim) so the same file runs in Node (header
render, tests) and the browser. `rollGenome(seed, species)` derives from a seeded PRNG:
plumage shade (hue/sat jitter within the species' base palette), belly, eye style (round /
sparkle / sleepy / wink), marking (none / cheeks / starburst / collar / freckles), accessory
(mostly none; bow / leaf / beanie), size and plumpness, tilt. `drawBird(svg, genome, mood)`
renders ~30 SVG primitives; `mood ∈ happy|tired|alarmed` reuses the phase-1 classes. Byte-
identical output for identical inputs is a tested invariant. Parts are looked up by name so
an asset pack (D6) can replace a part's path data without touching the engine.

### 2.3 Care (D7)
Three chores per local day: `feed`, `preen`, `play`. Each first completion of the day adds
energy (+8) and is recorded in `ramble_pet.chores_json = { day, feed, preen, play }`. Missed
days simply let passive decay run (phase-1 model: −10 per 6 h idle, clamped ≥ 0). Mood is
derived from energy as in phase 1. Nothing else happens.

### 2.4 Nests and claiming (D9)
- `nestFor(cell7, isoWeek)`: `h = sha256("ramble-nest-v1:" + cell7 + ":" + isoWeek)`; a nest
  exists when `h[0..4] mod NEST_RATE == 0` (default 24 → ~1 nest per 24 cells); its point is
  the cell's south-west corner plus `h[4..8] / 2^32` of the cell height north and
  `h[8..12] / 2^32` of the cell width east (always inside the cell); its egg-art seed is
  `h[12..16]`. Public salt, no server, same answer on every device.
- Claim: within `withinRange` (75 m) of the nest point → `POST /api/ramble/nests/claim` →
  one egg on the shelf (`status='shelf'`, `found_cell`, `found_week`). Limits: 1 claim per
  local day; shelf cap 5 (claim refused with a friendly reason). Claims are per user
  (`ramble_nest_claims(cell, week)`), never global.
- The client shows nests on the map (egg pin) and in AR; the server exposes
  `GET /api/ramble/nests?cells=…` computing them for the visible cells.

### 2.5 Incubation and the flock
- Exactly one egg has `status='incubating'`. `POST /api/ramble/eggs/:id/incubate` swaps.
- `ramble_pet.active_egg_id` names the active bird; `POST /api/ramble/birds/:id/activate`.
- Flock screen: hatched birds (tap → pet screen for that bird, or activate), the shelf, and
  "8 kinds, N found".

---

## 3. Screens (direction C, light + dark)

- **World (home).** Map centred on you; active bird perched bottom-right with one context
  line ("three new crows near the market today") and a reaction when a new pin arrives;
  visibility chip ("Visible: off") always on screen — tapping opens the privacy grid as a
  sheet; pins: marks (bubbles), locked marks (dashed teasers + walk distance), caws (bird +
  bubble), nests (egg pin). Below: compose card ("Leave something for whoever comes next",
  one-line mark-vs-caw explainer, Who = Everyone / Contacts / Just me, Reveal = Open /
  Locked) and a short Nearby list. Tap the bird → pet screen. AR button on the map.
- **Egg (before first hatch).** The perch shows the egg with a progress ring; tapping opens
  the egg screen: ring + percent, the warmth checklist (new places this week, first mark,
  check-in today), "Go outside", "Check in". The hatch moment plays here or wherever the
  user is when it crosses 100.
- **My bird.** Big bird on a patterned stage; species + trait line; energy meter + mood
  sentence; the three chores as chunky toggles; this-week counters; link to the flock.
- **Flock.** Birds grid (active one marked), egg shelf (incubating one marked; incubate /
  gift / propose swap actions), "8 kinds, N found".
- **AR.** §6.
- **Header crow.** When an active bird exists, the Nest header crow is drawn by
  `bird-svg.js` with the same mood classes; otherwise unchanged.
- **Nest visibility.** Ramble stays a private panel (no Funnel); nothing here changes that.

---

## 4. Wire (Nostr)

- Public marks/caws (kinds 30397/20397 as phase 1) gain `bird: { species, seed }` in the
  JSON content (active bird; omitted when no bird yet). `eventToMark` validates species ∈ D3
  and seed ∈ uint32, else drops `bird` (renders the plain species silhouette). Stored on
  `ramble_marks.bird_species` / `bird_seed`.
- **Contacts delivery (phase 3).** Audience `contacts` → one NIP-44 event per contact
  (`kind 4`-style DM payload the existing `NostrManager` contact subscription already
  receives), payload `{ type: "ramble.mark", v: 1, mark: <wire row incl. bird> }`. Audience
  `group:<id>` → fan-out to each member the same way (the phase-1 "group shared key" is
  dropped). Receive: the contact-subscription decrypt path recognizes `type` starting with
  `ramble.` and routes to `insertRemoteMark` (contacts marks are persistent; no `expiration`).
  Nothing about a contacts/group mark reaches a relay in the clear.
- **Gifts / swaps (phase 3).** `{ type: "ramble.egg", v: 1, egg: { egg_id, warmth,
  found_cell, found_week } }` (never species/seed — unhatched) and
  `{ type: "ramble.trade", v: 1, trade: { trade_id, state, my_egg_id, want_egg_id } }`.
  Idempotent by `egg_id` / `trade_id`.
- `local.session_id`, own-echo, blocks, expiration, tombstones: unchanged from phase 1.

---

## 5. Data

New / changed tables (bundle-owned, `CREATE TABLE IF NOT EXISTS` + guarded `ALTER`s, no
`SCHEMA_GENERATION` bump; every replicated table carries `lamport_ts`):

- `ramble_eggs (egg_id TEXT PK, status TEXT incubating|shelf|hatched|gifted|received,
  warmth INTEGER, species TEXT, seed INTEGER, found_cell TEXT, found_week TEXT,
  from_crow_id TEXT, created_at, hatched_at, lamport_ts)` — **replicated** (natural key
  `egg_id`).
- `ramble_pet` gains `active_egg_id TEXT, chores_json TEXT, lamport_ts` — **replicated**
  (natural key `owner`).
- `ramble_credits (kind TEXT, key TEXT, credited_at INTEGER, PRIMARY KEY (kind, key))` —
  idempotency ledger for warmth/energy credits (cell+week, day, persona+week). Local.
- `ramble_nest_claims (cell TEXT, week TEXT, egg_id TEXT, PRIMARY KEY (cell, week))` — local.
- `ramble_trades (trade_id TEXT PK, counterpart TEXT, my_egg_id, their_egg_id, state TEXT
  proposed|accepted|completed|expired|declined, created_at, updated_at, lamport_ts)` —
  replicated (phase 3).
- `ramble_marks` gains `bird_species TEXT, bird_seed INTEGER` (wire columns; excluded from
  nothing; nullable).
- Settings (in `ramble_settings`, replicated): `warmth.<event>` weights, `nest.rate`,
  `shelf.cap`, `tile_url` etc. as phase 1.

Sync: add `ramble_eggs`, `ramble_pet`, `ramble_trades` to `SYNCED_TABLES` with natural-key
apply handlers modelled on the phase-1 ones (LWW on the envelope lamport; `origin`-style
bookkeeping is not needed for these tables). `stampSql` gains by-key branches for them.

---

## 6. AR mode (D11)

- Full-screen view over `getUserMedia({ video: { facingMode: "environment" } })`.
  Pose = GPS (`watchPosition`) + heading (`deviceorientationabsolute` / `webkitCompassHeading`
  fallback). Each anchor (marks, caws, nests within ~500 m) → bearing + distance →
  horizontal position by bearing offset from heading (±FOV/2 ≈ 35° visible, others parked
  at the edge with an arrow), vertical position and scale by distance. Locked marks = dashed
  teasers + distance; tapping a label = same actions as a pin. Active bird composited bottom
  centre, reacts when a label enters view, speaks its context line.
- Fallback: no camera or no compass → "radar strip" (bearing ring + distance list), never a
  blank screen. Limits stated in-UI on first open.
- Component contract: `renderAr({ anchors, pose, bird })` with no knowledge of the map; a
  future WebXR renderer implements the same contract and adds surface placement. Anchors
  keep lat/lon/accuracy exactly as stored today.

---

## 7. APIs, tools, events

Panel routes (all under the existing path-scoped `dashboardAuth`):
`GET /api/ramble/egg` (incubating egg + checklist), `POST /api/ramble/egg/checkin`,
`POST /api/ramble/pet/chore { kind }`, `GET /api/ramble/pet` (extended: bird, active egg),
`GET /api/ramble/flock`, `POST /api/ramble/eggs/:id/incubate`, `POST /api/ramble/birds/:id/activate`,
`GET /api/ramble/nests?cells=`, `POST /api/ramble/nests/claim { cell, week, lat, lon }`,
`GET /api/ramble/bird/:species/:seed.svg` (server render for the header / previews),
phase 3: `POST /api/ramble/eggs/:id/gift { crow_id }`, `POST /api/ramble/trades` /
`/:id/accept` / `/:id/decline`. MCP tools mirror: `ramble_egg_state`, `ramble_checkin`,
`ramble_chore`, `ramble_flock`, `ramble_claim_nest`, `ramble_gift_egg`, `ramble_propose_swap`.
Bus: `ramble:hatched`, `ramble:nest-claimed`, `ramble:trade` (phase 3) join `ramble:nearby`
on the SSE channel as named events.

`feed(db, event)` fans out: warmth to the incubating egg (with the credits ledger), energy
to the pet, counters as phase 1. All existing hooks (transport receive, unlock, area) and
the new ones (mark left, check-in, chore, claim) call the one function.

---

## 8. Visual direction C (tokens)

Light: bg `#f7f5ef`, surface `#fffdf8`, surface-2 `#efeae0`, text `#24273a`, muted `#6a6e85`,
line `#2a2d3e`, accent `#f7c948` (ink `#24273a`), accent-2 `#5b7cff`, accent-3 `#ff7a9c`,
radius 20/13, shadow `4px 4px 0 #2a2d3e`, card/button/chip border `2.5px solid line`.
Dark: bg `#151827`, surface `#1e2236`, surface-2 `#272c45`, text `#f1f0f8`, muted `#aeb2cc`,
line `#c9cbe0`, shadow `4px 4px 0 #4a5080`, accent `#ffd166`, accent-2 `#8c9bff`.
Type: "Baloo 2" (display) + "Nunito" (body) via Google Fonts (the dashboard CSP already
allows `fonts.googleapis.com` / `fonts.gstatic.com`) with system fallbacks.
Map: OSM tiles through the phase-1 proxy; pins/bubbles per the mockup. Icons: inline SVG,
never emoji. Dark mode follows the Nest theme attribute.

---

## 9. Safety, privacy, limits

- D5 accepted knowingly: a unique bird is a soft identifier across sessions even under the
  rotating identity. The privacy grid, master switch and coarse caws are unchanged; a user
  who wants no identifier can keep `Visible` off.
- Nests reveal nothing about people (deterministic from cell+week). Claims are local.
- Gifts/swaps are contact-only and encrypted; no market, no scarcity ledger, no value.
- Camera frames never leave the device (AR is client-only rendering).
- All new inputs bounded (zod `.max`, enums for species/status/kinds); seeds are server-minted.

---

## 10. Testing

Genome determinism (same inputs → byte-identical SVG; different seeds differ); hatch
arithmetic, thresholds, idempotent credits (cell/week, day, persona/week); chores once per
day; nest determinism (`nestFor` same on two "devices", rate honoured); claim limits; sync
round-trips (outbox door + apply door) for eggs/pet/trades; wire round-trip with `bird` and
rejection of a bad bird; contacts delivery encrypt/decrypt round-trip through the existing
contact subscription path (phase 3); trade state machine incl. expiry; panel routes over a
live loopback server; header script still parses with a bird present; AR component with a
synthetic pose (label positions, fallback when no heading). Full suite green; no host
state touched.

---

## 11. Phases (each = its own plan + PR)

1. **Home + bird + egg + hatch** — §2.1–2.3, §3 world/egg/pet, §5 eggs+pet+credits, §4 `bird`
   on public wire, header crow, "Just me" audience, direction C panel rewrite.
2. **Nests + flock** — §2.4–2.5, §3 flock screen, nest pins, claims.
3. **Contacts delivery + gifts + swaps** — §4 contacts/group fan-out and receive, `ramble_trades`,
   gift then swap flows, "share invite" on met-crow.
4. **AR** — §6.

Not in this spec: BLE / same-LAN / Wi-Fi sensing (still the original phase 2), photo marks +
media server, companion-lite voice, strangers trading without an invite, WebXR itself.
