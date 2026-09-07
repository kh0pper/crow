---
title: Ramble
---

# Ramble

Ramble is a proximity extension: you leave **marks** (notes pinned to a place) and **caws** (short-lived presence pings), and you see the ones other people left near you. It ships as an installable bundle with an MCP server, a dashboard panel with a map, and a Nostr transport that runs inside the gateway.

Phase 1 is deliberately narrow:

- **Geo only.** The privacy grid has `ble` and `lan` channels, but only `geo` is wired.
- **Public wire only.** Marks with visibility `contacts` or `groups` are stored and replicate across your own Crow instances, but they are never published to relays. Contacts/group delivery is phase 1b.
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
| `pending` | Waiting for a drain tick, or the grid gate is closed, or it is a non-public mark (which never publishes in phase 1). |
| `published` | At least one relay accepted the event. |
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

Groups (`ramble_group_create` / `ramble_group_join`) are not in phase 1.

A hatch triggered through these tools never sends a live update to an open dashboard panel — they run over the stdio MCP process, not through the panel's request path, so there is nothing to push a `ramble-hatched` event through. The panel still picks up the new bird on its next refresh (after any action).

## Operating notes

The transport lives in core (`servers/gateway/boot/ramble-transport.js`), not in the bundle, because it must reuse the gateway's one live Nostr manager. It starts on **any gateway that has the ramble bundle directory and a Nostr manager**. Boot prints one of:

```
[ramble] transport started
[ramble] transport not started: no nostrManager (sharing disabled or boot order)
```

The second line means the bundle is installed but nothing will ever be published or received — check that sharing/Nostr is enabled on that instance. No Ramble failure can block gateway boot; every problem is a warning.
