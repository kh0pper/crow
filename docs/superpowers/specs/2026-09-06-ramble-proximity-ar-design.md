# Ramble — proximity broadcasts + shared AR overlay (design)

**Status:** design approved in brainstorming 2026-09-06 (Kevin). Ready for writing-plans (phase 1).
**Bundle id:** `ramble`
**Type:** open-source Crow extension (public repo — no credentials in the bundle).
**Seed:** memory `crow-proximity-ar-extension-idea.md`; handoff `docs/superpowers/handoffs/2026-09-05-models-plan1-shipped-sidequest-proximity-ar.md`.

---

## 1. What this is

A Crow extension where users broadcast short status messages bound to their physical
location and leave discoverable **marks** on a shared world, viewed on a **map** and
through a **geo-AR camera** overlay, with a living crow **pet** that feeds on the
sensing substrate and befriends other users' crows over the air. "Snapchat × Pokémon
Go, open source, on the existing Crow stack" — Pwnagotchi-inspired for the pet, with
**none of Pwnagotchi's offensive behavior** (see §9).

**One substrate, three surfaces.** The two features in the seed note (proximity
broadcast, AR overlay) are the same mechanism underneath: a **tag** is content bound
to an **anchor**; a **status broadcast** ("caw") is a short-lived tag anchored to
*you*. Map, AR, and the pet's meals are all queries over tags and anchors.

### Vocabulary
- **mark** — a placed tag (anchored to a place / LAN / beacon / room). May be
  ephemeral or persistent.
- **caw** — a status broadcast: a short-lived tag anchored to the author, presence-only,
  never stored in the world.
- **world** — a query, not an object: "public near geohash X", "contacts", or a named
  group.
- **pet** — the user's crow character, mood-driven, fed by the substrate (§6).

---

## 2. Audience & privacy model (decisions)

- **Audiences:** `public` (open world, strangers discoverable), `contacts` (existing
  Crow contacts), `group:<id>` (private shared overlay). Chosen: an open world **with**
  contact- and group-level gating (Kevin: "B and C with some privacy gating like A").
- **The privacy grid (governs all broadcasting).** A 3×3 matrix of explicit switches:
  rows = audiences (public / contacts / groups), columns = channels (BLE / same-LAN /
  geo). **Every cell off by default.** A channel is used for an audience only if that
  exact cell is on. A master **"I'm visible"** switch sits on top; when off, all
  broadcasting stops instantly and any live caw drops. This is the "open and transparent
  on/off switch" requirement, made literal.
- **Public identity level** (per user, resolves stranger-safety):
  - `rotating` (**default**) — fresh key per session for presence; a stable **world
    pseudonym** signs placed public marks so reporting/blocking works, but it is **not**
    your `crow_id`.
  - `pseudonym` — one stable non-`crow_id` pseudonym.
  - `real` — your actual `crow_id` broadcast in the real world (Kevin explicitly wants
    this available as a user choice).
  - Contacts and groups **always** see the real `crow_id`.
- A stranger who wants to stay in touch uses an explicit **"share an invite"** action
  (reuses the existing invite-code flow); only then is the real identity revealed.

---

## 3. Channels & "nearby" (decisions)

"Nearby" is defined by whichever channels the user opts into per audience — no single
definition (Kevin). Three channels:

| channel | client | range | needs | notes |
|---|---|---|---|---|
| **BLE** | Android app | ~10–30 m | Android location permission (BLE scan) | phone↔phone friend beacon; the "AirDrop-like" one; iOS out of reach |
| **same-LAN** | Android app + the Crow box | "this building" | same Wi-Fi | mDNS, reuses `bundles/knowledge-base/server/lan-discovery.js`; the Crow box can advertise LAN-anchored marks to visitors ("signal over the Wi-Fi router") |
| **geo** | **PWA, no app** | radius query | coarse position | only channel that works without the Android app; privacy is a design choice → coarse-by-default, never stored server-side beyond the ephemeral presence event |

- **Friend beacon** (BLE): the device advertises a **rotating id + chosen public
  persona**, and scans for others. It is our own opt-in advertisement — **not** a covert
  probe.
- BLE + LAN are **device-local**: detection happens on the phone; only the resulting
  event (a mark unlocked, a caw seen) touches the store. They are **not** synced.

### Wi-Fi sensing (scoped safe)
The phone reads the access points it already sees and derives **only**:
1. a **richness count** (how much radio life is around) → feeds the pet (§6);
2. a **room fingerprint** (RSSI signature) → the `fingerprint` anchor for indoor marks.

**Hard boundaries** (also §9): passive scan only; **no** deauth, injection, or handshake
capture; other people's devices are **never** logged as identities. Room sensing that
could infer people present is a **separate, owner-enabled, visitor-visible** flag per
space (`room_sensing_enabled`).

---

## 4. Data model

Bundle-owned tables in the shared `crow.db` (created idempotently at server start, **no
`SCHEMA_GENERATION` bump** — reader-bundle pattern). Added to `SYNCED_TABLES` with
`emitOrQueue` on every write.

### Tag (`ramble_marks`)
- `id`, `author` (persona key, §2), `created_at`, `expires_at` (nullable = persistent)
- `kind`: `caw` | `mark`
- `anchor` (typed):
  - `geo` — lat/lon + geohash + accuracy
  - `lan` — a **salted** network id (raw BSSID never leaves the device)
  - `beacon` — a rotating advertised id
  - `fingerprint` — room-level Wi-Fi RSSI signature
  - `visual` — **reserved**, opaque payload, for self-hosted surface-anchored AR later
- `visibility`: `public` | `contacts` | `group:<id>`
- `reveal`: `open` | `locked` (locked → content decrypts only within anchor range;
  **default locked for public, open for contacts/groups**)
- `content`: one note (`text`) plus at most one of `photo` (content-hash + media-server
  ref + inline encrypted thumbnail), `sticker` (emoji/marker), `link`
- FTS5 shadow on `text` (memories/glasses_photos trigger idiom).

### Lifetime defaults
- **caws:** default 1 h, max 24 h; gone when visibility flips off; **never stored in the
  world** (presence only).
- **marks:** **ephemeral-by-default (24 h) for public** with an explicit "pin" →
  persistent; **persistent-by-default for contacts/groups** (your own people's marks are
  the ones you revisit).

### Discovery / reveal rules
- The map shows a **locked** mark exists (author persona, kind, teaser, age) from
  anywhere; **content unlocks only within range** of its anchor (near the coord / on the
  LAN / in BLE range / matching the room fingerprint). Once unlocked, it **stays
  unlocked** for that user ("revisit later").
- Enforcement: content encrypted with a key **derived from the anchor** + per-tag secret,
  so a relay/scraper holding the event still cannot read it. v1 is client- + crypto-
  enforced; a self-hosted world server (§8) can add server enforcement later without
  schema change.
- **Actions on an unlocked tag (v1):** react (emoji), reply (threaded, same visibility as
  the tag), report/hide (public). **No** collecting / scores / inventory at v1.

### Persona
- Per-user `public_identity_level` (§2). Resolves the `author` field per audience.

### Pet (`ramble_pet`, one row per user)
- `mood`, `energy`, `last_fed_at`, rolling counters (places visited, marks unlocked,
  crows met this week). Fed by sensing + meetings + unlocks. Never leaves the instance
  except as the visible crow avatar on public presence.

### Other tables
- `ramble_groups` (shared symmetric key + member list; created/joined via the invite
  flow), `ramble_settings` (the privacy grid, master switch, identity level, per-space
  `room_sensing_enabled`), `ramble_blocks` (block/report keyed to a persona).

---

## 5. Transport & sync

Rides **Nostr** (already used for Crow messaging — no new relay infra):
- **public marks** → signed events with a **geohash** tag (relay-indexed; "marks near
  geohash X" is native).
- **contacts marks** → gift-wrapped per contact (as messages are today).
- **group marks** → one event encrypted to the shared group key.
- **caws (presence)** → Nostr **ephemeral** events (forwarded, never stored; self-expire).
- **locked content** → encrypted with the anchor-derived key.

**Media (photos):** content-hash addressed. An **optional self-hostable media server**
(Blossom-style, a small later bundle) hosts full-size blobs; a small **encrypted
thumbnail** rides inline; contacts/groups fall back to fetching from the author's
instance when reachable. **Public photo marks require a media server to be configured**
(stated plainly — no silent failure).

**Same-user instance sync:** `ramble_marks` / `ramble_pet` / `ramble_settings` /
`ramble_groups` / `ramble_blocks` go through the Lamport outbox (`emitOrQueue`) and are
added to `SYNCED_TABLES` (`servers/sharing/instance-sync.js`). BLE/LAN detections are
device-local and not synced. **Carry-risk:** forget the allowlist → instance-local
forever.

---

## 6. The pet (Pwnagotchi-inspired) & the character module

Reuses the existing **Tamagotchi crow** (animated SVG in the Nest header,
`servers/gateway/dashboard/shared/notifications.js`, `tamagotchi_enabled` setting) —
Ramble gives it a life. Exposed as **mood + short phrases, never scores**.

- **Feeds on:** radio richness (passive sensing), visiting new places, unlocking marks,
  meeting other crows. Varied day → perky; indoors on a dead network → droop.
- **Friendship:** detecting another crow over any enabled channel → a greeting animation
  + "met N crows this week" (the strongest stranger hook; stays mood-level).
- **Says things:** short context phrases ("three new crows near the market", "quiet here
  today") — a friendly, low-density presence surface.
- **Anti-fingerprint boundary (write into code):** the pet's look is **identical for
  everyone at v1** so it cannot fingerprint a user across sessions. Any future
  accessories/growth stages must not leak into the public persona.

### Character module boundary (built in Ramble, reused by companion-lite)
`server/character/` + a client `pet` module expose **state** (mood, energy, memories) and
a **`feed(event)`** interface, plus attachable capability layers:
- **feed layer** — Ramble v1 wires **only this** (proximity/sensing/meetings → mood).
- **AI-voice layer** — deferred to the companion-lite spec (§7 phase 4).
- **peer-presence layer** — deferred (reimagined, lighter than the OLV Live2D
  avatar-sync).

The character is the seam through which the companion / tamagotchi-crow / half-baked
companion-social features later **converge into one lighter Crow-first character** (see §7).

---

## 7. Scope: four phases (one spec, phased build)

The data model (§4) and privacy grid (§2) are shared and are **not** re-litigated per
phase. writing-plans targets **phase 1** first.

1. **Ramble core** — tag/anchor store; the **geo** channel; **map** + compose + the
   settings grid; Nostr public/contacts/groups; the pet fed by **geo activity**; MCP
   tools. Ships value with **zero Android work**; proves the world.
2. **Proximity channels** — the Android bridge: BLE friend beacon, Wi-Fi sensing + the
   `fingerprint` anchor, LAN/mDNS. Feeds the pet the radio world; enables stranger
   meetings.
3. **AR + media** — geo-AR camera view; the self-hostable media server for photo marks.
4. **Companion-lite (follow-on, Kevin-approved deferral)** — custom kawaii crow art,
   lightweight AI voice/chat via the gateway `/llm/v1` router (+ existing
   `faster-whisper-server` / `kokoro-tts` bundles, **no OLV Docker container**), and the
   reimagined peer-presence social — all on the character module. May later demote the
   heavy Live2D companion to an optional skin.

**Deferred / later:** surface-anchored (WebXR hit-test) AR via the reserved `visual`
anchor + a self-hosted relocalization service; crowd-sourced room fingerprints; an
ESP32/OpenWrt CSI sensor node publishing occupancy/motion into a room anchor (the
"second, side-channel" reading of Wi-Fi shadowing — interesting, not v1); tag
collecting/scores (Pokémon-Go economy).

---

## 8. Bundle architecture

Follows the reader / meta-glasses precedents (`docs/developers/{bundles,creating-panels,
creating-servers}.md`).

- **`bundles/ramble/manifest.json`** — `id: "ramble"` (== dir), surfaces: `server`,
  `panel`, `panelRoutes`, `skills`, `requires.bundles` (nominatim optional for
  reverse-geocode display; minio for media). Registry is generated
  (`npm run build-registry`, CI drift-checked).
- **Server** (`bundles/ramble/server/`): MCP tools `ramble_leave_mark`, `ramble_caw`,
  `ramble_query_world`, `ramble_unlock`, `ramble_pet_state`, `ramble_group_create/join`.
  Resolve the shared **better-sqlite3** client via `server/app-root.js` +
  `appImport("servers/db.js")` — **never** load a second SQLite driver into the gateway
  process (the 2026-08-04 `@libsql` DB-corruption incident). Nostr publish/subscribe glue;
  media refs.
- **Tables** — `server/init-tables.js`, `CREATE TABLE IF NOT EXISTS`, called from
  `server.js`; **no** `scripts/init-db.js` edit, **no** `SCHEMA_GENERATION` bump. FTS5 +
  triggers per the memories idiom.
- **Panel** (`panel/ramble.js` + `panel/routes.js`) — map (**vendored Leaflet** into the
  bundle; the existing copy lives in the out-of-repo `tea-maps` bundle), AR view, compose,
  settings grid, pet surface. Client JS served via `express.static`. **Path-scope panel
  middleware** (`router.use("/api/ramble", auth)`) — an unpathed `router.use(mw)` starves
  later panels and is refused under `STRICT_PANEL_MOUNT=1`. Live "nearby" updates via
  `setupWebSocket` (collected by `panel-registry.js`, called from `boot/post-listen.js`)
  fed by `servers/shared/event-bus.js`. **Never** add the stream/WS path to
  `PUBLIC_FUNNEL_PREFIXES`.
- **Android bridge** — a JS interface (in the `android/` app, WebView shell,
  `press.maestro.crow`) exposing BLE advertise/scan, Wi-Fi environment scan, and mDNS.
  Adds `ACCESS_FINE/COARSE_LOCATION` to `AndroidManifest.xml` (currently absent),
  requested **only** when a BLE cell is first enabled. Camera + geolocation come from the
  browser (no native code).
- **Ports** — gateway-served (panel + stdio MCP): **no new host port** for phases 1–2.
  The phase-3 optional media server takes one from the free API range (candidate **8012**)
  and **must** be added to `docs/developers/port-allocation.md` or `check-ports` (CI)
  fails. (Verify against all three registries at build time — the doc is not
  authoritative; same-port/different-bind collisions pass CI silently.)
- **Device auth** — phones use the existing per-device **bearer token** model
  (`bundles/meta-glasses/server/device-store.js`: store `sha256(token)`, plaintext once at
  pair, `timingSafeEqual`, rotate-on-repair) + the dashboard session for the PWA.
- **Push / live** — Web Push/VAPID + ntfy already exist; SSE/Turbo streams
  (`routes/streams.js` + `event-bus.js`) are the seam for live proximity/presence updates.

### Network-exposure invariant (must hold)
Ramble's routes, panel, MCP, streams/WS are **private**. Never reachable via Tailscale
Funnel; only the existing public-safe prefixes stay public. Touching gateway auth/network
layers → run `tests/auth-network.test.js`.

---

## 9. Safety, consent, open-source framing

- **Pwnagotchi boundary (explicit):** we borrow only the *pet-fed-by-the-radio-world* and
  *peers-befriend-over-the-air* concepts. **No** deauth, **no** packet injection, **no**
  WPA-handshake capture, **no** logging other people's devices as identities. Sensing is
  passive and consensual; the friend beacon is our own opt-in advertisement.
- **Consent surfaces:** every privacy-grid cell off by default; master visible switch;
  coarse geo by default; per-space `room_sensing_enabled` is owner-enabled and
  visitor-visible on the map.
- **Stranger safety:** rotating public persona by default; block/report keyed to persona;
  real identity revealed only via an explicit invite.
- **Open-source framing:** `ramble` is a public-repo bundle — **no credentials** in the
  bundle; relays/media-server/identity all come from the host instance's existing config.

---

## 10. Testing

- Server + tables: `node scripts/run-suite.mjs tests/<file>` (never bare `node --test` —
  it can write the live crow.db). Node 22 rail on PATH.
- Anchor encryption / locked-reveal: unit tests that a locked mark's content is
  unreadable without the anchor-derived key, readable with it.
- Privacy grid: a matrix test that a cell being off blocks that (audience, channel) emit,
  and the master switch drops everything — modeled on the executable, multi-instance gate
  discipline (memory `crow-item-2a-prune-design`).
- Sync: `ramble_marks` replicates only via `emitOrQueue` + `SYNCED_TABLES`; a
  mutual-instance test.
- Auth/network: `tests/auth-network.test.js` if any gateway auth/network layer is touched.
- CI green on the head sha (`suite`/`static-checks`/`audit`, check-runs API) before any
  merge; `main` is branch-protected (enforce_admins).

---

## 11. Open questions for writing-plans (phase 1)

- Exact Nostr event kinds for public marks vs ephemeral caws (custom kind numbers +
  geohash tag convention).
- Anchor-key derivation function specifics (geo precision → key; how "within range"
  tolerance maps to decryptability without leaking exact position).
- Map tile source for vendored Leaflet (self-hosted vs public tiles — public-repo /
  privacy implications).
- Whether phase 1 pet is fed by geo activity alone (proposed: yes) until phase 2 adds the
  radio feed.
