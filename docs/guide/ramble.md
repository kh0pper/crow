---
title: Ramble
---

# Ramble

Ramble is a proximity extension: you leave **marks** (notes pinned to a place) and **caws** (short-lived presence pings), and you see the ones other people left near you. It ships as an installable bundle with an MCP server, a dashboard panel with a map, and a Nostr transport that runs inside the gateway. A blue dot with an accuracy ring follows you on the map; **Around you** toggles follow mode (dragging the map turns it off).

Phase 1 is deliberately narrow:

- **Geo only.** The privacy grid has `ble` and `lan` channels, but only `geo` is wired.
- **Contacts and groups travel as DMs.** Marks with visibility `contacts` or `group:<uid>` are sealed for each recipient (NIP-44, one DM per contact) and never touch a public relay in the clear — see below. Gifts and swaps use the same door.
- Public `locked` marks are a **client-side teaser gate, not cryptography.** The content is on the relay in the clear; the panel simply declines to show it until you prove proximity. Do not put a secret in one.

## Privacy

Everything is off by default. Nothing leaves the box until you turn on **both**:

1. the master switch ("I'm visible"), and
2. the specific (audience × channel) cell — for phase 1 that is `public` × `geo`.

Both live on the panel's privacy grid, stored as flat rows in `ramble_settings` (`master`, `grid.<audience>.<channel>`). They are user state, so they replicate across your own instances.

The **public identity level** picks which key signs what you publish:

| Level | What goes on the wire |
|---|---|
| `rotating` (default) | Marks are signed by a stable per-seed world pseudonym; caws get a fresh key each boot, so presence pings are not linkable across restarts. |
| `pseudonym` | Both marks and caws use the stable world pseudonym — consistent identity, no link to your real Crow id. |
| `real` | Your instance's own key and `crow_id`. Anything you publish is attributable to this Crow. |

## How publishing works

Authoring is local and synchronous; the wire is not. A new mark is stored with `publish_state = 'pending'`, and the gateway's transport publishes it on the next drain tick (every 15 s, or immediately when authored in-process).

`publish_state` values:

| Value | Meaning |
|---|---|
| `pending` | Waiting for a drain tick, or the grid gate is closed, or (contacts/group) at least one recipient's DM has not been accepted by a relay yet. |
| `published` | At least one relay accepted the event — or, for a contacts/group mark, every recipient's DM was accepted (a mark with nobody to send to is published at once). |
| `synced` | Written by instance sync from another of your own Crows. |
| `remote` | Received from a relay — someone else's mark. |
| `failed` | Parked after 20 rejected attempts, so one poison row cannot occupy a drain slot forever. |

A `failed` row is terminal until an operator re-arms it:

```sql
UPDATE ramble_marks SET publish_state='pending' WHERE mark_id=?;
```

Deletes are asynchronous too. Deleting a published mark writes a `ramble_tombstones` row; the transport turns it into a NIP-09 kind-5 event on the next tick and removes the tombstone only once a relay accepted it.

## Expiry

Marks and caws carry a TTL, and defaults differ by kind:

- public marks: **24 h**
- caws: **1 h**
- `contacts` / `groups` marks: no expiry

The sweep runs on the same 15 s drain tick. Expired rows are deleted locally and the delete is emitted to instance sync, so your other Crows drop them too. An expired mark **cannot be unlocked** even in the window before the sweep catches it — `ramble_unlock` refuses it.

## Your egg and your bird

Every instance always has one egg incubating. Real-world activity credits **warmth** toward it; once warmth reaches the hatch threshold, the egg hatches into a bird.

| Event | Warmth |
|---|---|
| Visiting a new place | 20 |
| Leaving a mark | 15 |
| Unlocking a mark | 10 |
| Meeting a nearby crow | 20 |
| Checking in | 8 |
| **Hatch threshold** | **100** |

Each event is idempotent per its own key, so repeating the same real-world action never stacks warmth:

- **Visiting a place** credits once per geohash-7 cell per ISO week, and only from your real position (`here`, from the browser's geolocation) — panning the map to a new cell never credits.
- **Checking in** credits once per local calendar day.
- **Meeting a crow** credits once per (persona, ISO week) pair.
- **Leaving a mark** and **unlocking a mark** have no repeat key — every one is credited.

Meeting crows is additionally capped at **5 credits per local calendar day** (`MEET_CROW_DAILY_CAP` in `bundles/ramble/server/eggs.js`) — a persona is just a pubkey anyone can mint, so without that ceiling a flood of spoofed personas could force hatch after hatch; meetings past the cap credit nothing and leave no ledger row.

When warmth reaches the hatch threshold, a species and a seed are rolled server-side (`crypto.randomInt`, never `Math.random`, so the roll can't be predicted or replayed); the bird's look is unique to that seed. A new egg starts incubating immediately.

Your active bird rides on your **public** caws and marks — the wire JSON carries `bird: { species, seed }` so other people see it on your pins. Contacts and "Just me" marks never reach the Nostr wire (see below), so the bird is omitted from the **wire** only: those rows still store `bird_species` / `bird_seed` locally and replicate, bird and all, to your own linked instances.

Once a bird has hatched, the Nest header crow becomes it: its face reflects the pet's energy (see Chores), while the "!" alert badge is unrelated and still means host health, not pet mood.

Render any bird from its species and seed with:

```
GET /api/ramble/bird/:species/:seed.svg?mood=happy|tired|alarmed
```

Dashboard-authenticated, returns `image/svg+xml`, cached privately for a day. An unknown species or a malformed/unknown seed answers `400`.

## Chores

Three chores — **feed**, **preen**, **play** — are yours to do once each per local day. Each completion gives the pet +8 energy; none of them touch the egg's warmth.

`POST /api/ramble/pet/chore { kind: "feed" | "preen" | "play" }` completes one. A repeat for a kind already done today is a no-op (`done: false`); either way the response carries the pet's current state.

## Nests and the egg shelf

Nests are spawn points in the world. Each ISO week, every geohash-7 cell (about 150 m square) either has a nest or not, decided by a public formula — `sha256("ramble-nest-v1:" + cell + ":" + week)`, a nest when the first 32 bits mod `nest.rate` (default 24) is 0 — so everyone sees the same nests with no server involved and nothing about people is revealed. The map shows them as egg pins once you zoom in (zoom 15 or closer), fetched from `GET /api/ramble/nests?bbox=south,west,north,east`.

Walk within **75 m** of a nest and tap **Take the egg** (`POST /api/ramble/nests/claim`): a new egg lands on your **shelf** (unhatched, warmth 0, marked with the cell and week it was found in). Limits: **one claim per local day** and a **shelf cap of 5** (`shelf.cap`); both refusals come back as a friendly reason, not an error. Claiming the same nest twice returns the same egg. A claim credits **no** warmth and feeds **no** energy — the egg is the reward. Claims are recorded per instance (`ramble_nest_claims`) and never replicate; the egg itself does.

Exactly one egg incubates at a time. From the **Flock** screen you can **incubate** any shelf egg (`POST /api/ramble/eggs/:id/incubate`); the one it replaces goes to the shelf keeping its warmth. Instance sync distinguishes an egg *you* parked (`shelf_origin = 'user'`) from one the sync layer shelved while reconciling two instances (`'sync'`): only the latter is ever pulled back into the incubating slot automatically.

## Your flock

Every hatched bird stays in your flock. The Flock screen (`GET /api/ramble/flock`) lists them with the **active** one tagged — that is the bird on your map, in the Nest header and on your public caws — and tapping another bird activates it (`POST /api/ramble/birds/:id/activate`). The score is species found out of the 8 kinds; a second bird of a kind you already have is still a bird, just not a new kind.

## Contacts and groups

A mark for **Contacts** goes to every full contact (unblocked, not a bot, not a pending request) as one NIP-44 DM each, signed by this instance's key — the same door every Crow DM uses. A mark for a **Group** goes to the members of that contact group (`group:<group_uid>`, the groups from the Contacts panel; the Ramble panel only shows the Group audience when you have one). The DM's only tag is the recipient; the mark's text, place and bird are ciphertext. Nothing about a contacts or group mark reaches a relay in the clear.

Delivery is queued, not immediate: authoring writes one `ramble_outbox` row per recipient, and the gateway transport sends them on its drain tick (every 15 s, or at once when you author from the panel). A contacts mark is gated by the privacy grid like a public one — the `contacts` (or `groups`) × `geo` cell and the master switch must be on, or it waits in the queue. The row flips to `published` once every recipient's DM has been accepted by a relay (or dropped because that contact is gone). A recipient stores it as a persistent contacts mark, named after the contact, and it counts as meeting their bird for warmth.

A contact's marks are bounded by retention: you keep the newest 50 from each contact and older ones are pruned as new ones arrive (their `created_at` comes from the sender, so a per-day cap would be their clock to game). Blocking stays the hard stop.

Contacts delivery is contact-only in both directions: a DM of this kind from someone who is not a contact is discarded and never becomes a message request. A stranger's pin on your map offers **Share an invite**, which opens the Contacts panel — become contacts first, then trade.

The queue is per instance: only the Crow you authored on sends a mark, a gift or an offer. All your Crows share one Nostr identity, so each of them receives what a contact sends and applies it; the rows then agree through instance sync. A swap step a contact answers is completed on each of your Crows, and each sends the confirmation — the contact simply ignores the copies.

## Gifts and swaps

Any unhatched egg on your shelf — claimed from a nest or received from someone — can be **gifted** to a contact (`POST /api/ramble/eggs/:id/gift { crow_id }`, tool `ramble_gift_egg`). The egg leaves your shelf as `gifted` and arrives on theirs as `received`, still unhatched: the wire carries only `{ egg_id, warmth, found_cell, found_week }`, never a species or seed — whoever hatches it rolls the bird. A received egg shows "A gift · from <name>" and can be incubated, gifted on, or offered in a swap. Received eggs do not use one of the five nest-claim spots. A gift delivered twice is stored once; an egg you gave away that comes back to you simply returns to your shelf.

A **swap** is an offer of one of your eggs for one of theirs (`POST /api/ramble/trades { egg_id, crow_id }`, tool `ramble_propose_swap`). The contact sees the offer on their Flock screen and answers with an egg of their choice (**Accept**, `POST /api/ramble/trades/:id/accept { egg_id }`) or **Decline**; you can **Withdraw** an unanswered offer. Eggs change hands only when the swap completes — on each side, atomically — and an egg named by an open offer is locked (it cannot be incubated, gifted or offered again until the offer closes). Offers lapse after seven days on each side; a lapsed offer releases the egg. If your answer arrives after the offer lapsed on their side, they reply with a decline and your egg is released. Accept and decline are panel actions (there is no MCP tool for them).

Everything here is contact-only and encrypted, and bounded: a contact can have at most 20 open offers with you and give you at most 20 eggs a day; anything past that is ignored. An offer, an answer or a completion that names an egg you still hold is ignored. There is no market, no ledger of value and no scarcity: if the two sides disagree at the very moment an offer lapses, the worst case is a duplicated egg, never a lost one. Meeting a contact through a mark counts toward warmth the same way meeting a stranger does (per key, per week).

## The AR view

Tap **Look around** on the map to open the AR view: the rear camera fills the screen and every mark, caw and nest within about 500 m gets a label placed by direction and distance. Labels within 35° of where you face sit on the picture, nearer ones lower and larger; the rest park at the left or right edge with an arrow, stacked by distance. Locked marks are dashed labels with a walking distance measured to their cell centre (they carry no exact position, same as on the map). Tapping any label opens the same actions as its map pin — unlock, take the egg, read the text, share an invite. Your active bird sits at the bottom, hops when a label comes into view, and says what is nearest. A caw that only carries its coarse publish cell is listed as "somewhere in this area" and never given a direction. Within 75 m of a nest its label turns gold and shows the egg itself; tap it for the sheet, press **Take the egg**, and the label, the pin and the button pulse while your position is checked, then the egg flies down toward your bird when it is yours (the map pin pops the same way).

Position comes from `watchPosition`; heading from `deviceorientationabsolute` (Safari reports `webkitCompassHeading` on the plain event, and iOS asks once for motion access from the button tap). No fix, no camera or no compass falls back to the **radar strip** — a bearing ring (north up, or heading up when there is a compass) and a distance list — so the screen is never blank; the first open explains the limits (compass accuracy, the iOS prompt, no surface placement, the camera stays on the phone). The camera picture never leaves the device: the view is client-side rendering with no capture, canvas or upload, and the stream stops when you close the view or switch away from the tab (it restarts when you come back).

The panel fetches `GET /api/ramble/around?lat=&lon=&radius_m=` (radius 50–1000 m, default 500): marks as stored (a locked mark as its cell-centre teaser, a contact's mark named), each with `distance_m`, plus this week's nests, nearest first. The panel lists what the map lists (public, contacts and your own "Just me" marks). It refreshes after you move 50 m, once a minute, when you close a tapped label, and on every live event. It is a read and credits nothing. The view needs a secure context: open the Nest over its HTTPS Tailscale Serve address, not a raw-IP `http://` URL, or the browser refuses the camera and the compass and you get the radar strip.

## Just me marks

`visibility: "private"` marks are for you alone: they never leave the instance over Nostr, so no relay or contact ever sees them. Unlike public and contacts marks, they're **persistent by default** (no TTL) and **open by default** (no proximity gate).

"Just me" still means *you*, everywhere: a private mark replicates to your own linked instances via instance sync, so it follows you across your Crows — it just never crosses onto the Nostr wire. On the map, a private mark carries a "Just me" tag.

## Map tiles

The map never talks to a tile host directly. It loads `/ramble/tiles/{z}/{x}/{y}.png`, a same-origin, dashboard-authenticated proxy, so the tile provider never sees your browser or your session. The upstream is the `ramble_settings` key `tile_url`; the default is OpenStreetMap (`https://tile.openstreetmap.org/{z}/{x}/{y}.png`). The attribution line under the map comes from `tile_attribution`.

There is **no UI for either yet** — set them with SQL against `crow.db`:

```sql
INSERT INTO ramble_settings (key, value) VALUES ('tile_url', 'https://tiles.example.org/{z}/{x}/{y}.png')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;
```

The proxy only accepts an `http(s)` template containing `{z}`, `{x}` and `{y}`, and only serves image responses.

## Configuration

| Env var | Default | Effect |
|---|---|---|
| `RAMBLE_DEFAULT_GEOHASH_PRECISION` | `5` | Geohash precision of the cell tag published with each mark (5 ≈ a 4.9 km cell). Clamped to 1–12. Lower is coarser and more private. |

### Warmth weights

Every weight from the table above is also a `ramble_settings` override, read live on every credit — no restart needed. An override must be a non-negative integer; `hatch_at` must additionally be `>= 1` (anything lower would hatch every fresh, zero-warmth egg on read). A missing, non-numeric, or out-of-range override falls back to the default.

| Key | Default |
|---|---|
| `warmth.visit_place` | 20 |
| `warmth.mark_left` | 15 |
| `warmth.unlock_mark` | 10 |
| `warmth.meet_crow` | 20 |
| `warmth.checkin` | 8 |
| `warmth.hatch_at` | 100 |

### Nests and shelf

| Key | Default | Effect |
|---|---|---|
| `nest.rate` | 24 | About one nest per this many geohash-7 cells per week (integer ≥ 1). Replicates with your settings, so your own instances agree; it is an operator knob, and a changed rate no longer matches other people's nests. |
| `shelf.cap` | 5 | How many unhatched eggs the shelf holds (integer ≥ 0; 0 turns claiming off). |

## MCP tools

| Tool | Purpose |
|---|---|
| `ramble_leave_mark` | Leave a mark at a location. |
| `ramble_caw` | Broadcast a short-lived public presence marker. |
| `ramble_query_world` | List nearby marks and caws in the cell containing a location. |
| `ramble_unlock` | Unlock a locked mark by proving proximity to its anchor. |
| `ramble_pet_state` | The companion pet's mood, energy, weekly counters, active bird, and egg progress. |
| `ramble_egg_state` | The incubating egg's warmth progress and hatch checklist. |
| `ramble_checkin` | Record today's check-in, crediting warmth toward the egg. |
| `ramble_chore` | Complete a daily chore (`feed`, `preen`, or `play`) for the companion pet. |
| `ramble_block` | Block a persona by x-only pubkey and purge its stored marks. |
| `ramble_unblock` | Remove a persona from the block list. |
| `ramble_flock` | Your flock: birds, the shelf, the incubating egg, species found. |
| `ramble_nests` | Nests near a location this week, nearest first, with your claims marked. |
| `ramble_claim_nest` | Claim the nest you are standing at (or a named cell within 75 m) for a shelf egg. |
| `ramble_gift_egg` | Gift an unhatched shelf egg to a contact (queued as one encrypted DM). |
| `ramble_propose_swap` | Offer a shelf egg to a contact for one of theirs; they choose what to give back. |

Group audiences are the contact groups from the Contacts panel (`visibility: "group:<group_uid>"`); there are no ramble-specific group tools. `ramble_leave_mark` reports `recipients` for a contacts or group mark.

A hatch triggered through these tools never sends a live update to an open dashboard panel — they run over the stdio MCP process, not through the panel's request path, so there is nothing to push a `ramble-hatched` event through. The panel still picks up the new bird on its next refresh (after any action).

## Operating notes

The transport lives in core (`servers/gateway/boot/ramble-transport.js`), not in the bundle, because it must reuse the gateway's one live Nostr manager. It starts on **any gateway that has the ramble bundle directory and a Nostr manager**. Boot prints one of:

```
[ramble] transport started
[ramble] transport not started: no nostrManager (sharing disabled or boot order)
```

The second line means the bundle is installed but nothing will ever be published or received — check that sharing/Nostr is enabled on that instance. No Ramble failure can block gateway boot; every problem is a warning.

The one-claim-per-day limit and the shelf cap are checked per instance (claims do not replicate), so a user with two Crows can claim once per day on each.

The cap only gates claims. Incubating an egg the sync layer had parked (`shelf_origin='sync'`) moves the egg it replaces to your own shelf without anything leaving, so the shelf can briefly read `6 of 5`; it settles as you hatch.

Two instances can disagree for one sync cycle about which egg incubates: if you swap eggs on one Crow while the other is still crediting warmth to the old egg, the older egg wins on both sides and your swap is undone (consistently). Swap again once both are in sync.

Contacts delivery, gifts and swaps need every gateway on the new code: a gateway running phase 2 stores a ramble envelope as a chat message. Restart all of them before anyone sends. The transport logs `dropping <kind> delivery to <crow_id>: not a deliverable contact` when a queued recipient was deleted or blocked, and `gave up after 20 attempts` when no relay accepts a DM. During a rolling restart, a gateway still on phase 2 silently drops incoming `ramble_trades` sync ops (an unknown table advances its checkpoint without applying); a swap row emitted in that window reaches that Crow only when a later op touches the same trade. Restart all gateways back-to-back to keep the window to seconds.

The AR view is client-only: the gateway sees `GET /api/ramble/around` and nothing else new. A phone that shows "Radar · no compass" on Android usually has no `deviceorientationabsolute` support in that browser; "Radar · no camera" on any device means the permission was refused or the page is not a secure context. A caw published at a geohash precision of 4 or less (a non-default `RAMBLE_DEFAULT_GEOHASH_PRECISION` on the sender) is shown on the map but not in the AR view.
