# Ramble names and the Crow profile — world name, "you", pictures that reach contacts, the bird as avatar (design)

**Status:** design approved in brainstorming 2026-09-08 (Kevin), one spec, two plans.
**Builds on:** the Ramble bundle 0.6.0 (phases 1–5 of `docs/superpowers/specs/2026-09-07-ramble-flock-design.md`), the Crow contacts/handshake layer (`servers/sharing/`), the Contacts panel's My profile form (`servers/gateway/dashboard/panels/contacts/`).
**Origin:** after the first Ramble walk Kevin's own mark read "mark by f665c26b" and asked how to set a name and picture. Findings that shaped this: Ramble carries no name on its public wire by design (the rotating persona exists so strangers cannot link marks over time); the Crow display name travels in the pairing handshake but the avatar is a URL that peers' Nests cannot render (the dashboard CSP allows images only from its own origin, its storage server and inline `data:`); the guide's "Settings → Identity" claim is wrong (that page shows the Crow ID and key only).

---

## 0. Decisions (locked)

| # | Decision | Chosen |
|---|---|---|
| D1 | World name vs identity levels | The Ramble world name rides on public marks/caws only at Name level `pseudonym` or `real`; at `rotating` strangers see the short key only (a stable name would link rotating personas). |
| D2 | Same-name strangers | A stranger's label is `<name> · <key4>`; a contact's label is the receiver's saved contact name with no tail (verified by the handshake key). |
| D3 | Own marks | Your own marks and caws (origin `local` or `sync`) read "your mark" / "your caw" everywhere. |
| D4 | Avatar transport | The avatar travels as a small inline image (`data:` URI), never a URL: the browser shrinks an upload to a 128 px square; it rides the pairing handshake both ways, and a profile message (a `crow_social` subtype) goes to every full contact when the profile changes. |
| D5 | Peer vs local | A peer's self-reported name and picture are stored in their own contact columns (`peer_display_name`, `peer_avatar`); a name or picture the user set by hand (`display_name`, `avatar_url`) is never overwritten and wins on screen. |
| D6 | The bird as picture | The profile avatar has a source: `picture` or `bird`. `bird` (offered only when Ramble is installed and a bird has hatched) stores the active bird's portrait, drawn by the bird engine as an SVG `data:` URI, and refreshes it when the active bird changes. |
| D7 | Order of work | Plan A = Ramble-only (§2, §3: world name + "you"). Plan B = the sharing layer (§4, §5: avatar transport, profile message, bird source, contact pictures on Ramble marks) + the docs fix. |

---

## 1. Vocabulary

- **world name** — the Ramble handle a user chooses for strangers (`ramble_settings` key `world.name`). Distinct from the Crow **display name** (`dashboard_settings.profile_display_name`), which contacts see.
- **key4 / key8** — the first 4 / 8 hex characters of a mark's author (x-only persona pubkey).
- **peer fields** — what a contact told us about themselves (`peer_display_name`, `peer_avatar`); **local fields** — what we set for them (`display_name`, `avatar_url`).
- **avatar** — an inline image (`data:image/...;base64,...`) at most `AVATAR_MAX_BYTES = 32768` characters long as stored.

---

## 2. Ramble world name (Plan A)

### 2.1 Setting
- `ramble_settings.world.name` (replicated to the user's own instances like every non-`local.` ramble setting). Edited in the Visible sheet, directly under the Name level: a text field labelled "World name" with the hint "Strangers see this on your marks when your name level is pseudonym or real. Contacts always see your Crow name." Saved through the existing `POST /api/ramble/grid` (new optional field `worldName`; `GET /api/ramble/grid` returns it as `worldName`).
- Rules (`sanitizeWorldName`, a pure function in `bundles/ramble/server/grid.js`, applied on save AND on every read from the wire): the `sanitizeDisplayName` steps (strip C0/C1 controls, bidi overrides, collapse whitespace, trim, reject `^(crow|req):`) then a cap of `WORLD_NAME_MAX = 24` characters (truncated, not rejected), and reject a value that is only hex `[0-9a-f]{4,}` (it would imitate a key tail). Empty after sanitizing = unset (`null`).

### 2.2 Wire (Nostr, public kinds 30397/20397)
- `markToEvent` adds `content.name = <world name>` only when the row's `author_level` is `pseudonym` or `real` AND the setting is non-empty (the transport passes the sanitized name once per drain tick, like the bird). At `rotating` nothing is added — the level decides, not the setting.
- `eventToMark` reads `content.name` through `sanitizeWorldName`; anything else becomes `null`. Stored in a new column `ramble_marks.author_name TEXT` (guarded `ensureColumn`, no schema bump). It joins `RAMBLE_MARK_WIRE_COLUMNS` in `servers/sharing/instance-sync.js` so a mark replicated to the user's other instances keeps its name (both sync doors tested).
- Contacts/group marks (`markPayload`) do NOT carry `name`: the receiver names them from its contact row (§3.1). `payloadToMark` ignores a `name` if one arrives.

### 2.3 Privacy
- The world name is opt-in and never sent at `rotating`. Changing the Name level changes what future marks carry; existing published marks are unchanged (Nostr events are immutable; a NIP-09 delete is the only way back, as today).
- The name is display-only: no lookup, no uniqueness, no reservation. D2's key tail is the disambiguator.

---

## 3. Labels (Plan A)

### 3.1 The one label rule
`markLabel(mark)` (panel client) and `labelFor(row, { self, contactName })` (server, for the MCP world query) produce the same text, in this order:
1. own mark (`origin` ∈ `local`, `sync`) → `your mark` / `your caw`;
2. a contact's mark (`contact_name` set by the route from the contact row: local `display_name`, else `peer_display_name`, else the crow_id) → `mark by <contact name>` / `caw by …`;
3. a stranger's mark with `author_name` → `mark by <author_name> · <key4>`;
4. otherwise → `mark by <key8>` (today's behaviour).
Used by: the map popup head, the Nearby list, the AR anchor title for caws (`A caw from …` keeps its shape: `A caw from <contact name>` / `A caw from <author_name> · <key4>` / `A caw`) and `ramble_query_world` (rows gain `label`).

### 3.2 Own marks
`origin = 'sync'` rows are the user's own marks replicated from their other instances; they are "yours" exactly like `local` rows.

---

## 4. Profile pictures that reach contacts (Plan B)

### 4.1 Storage and the form
- `dashboard_settings.profile_avatar_url` keeps its key and now holds a `data:` URI (or stays empty). New key `profile_avatar_source` ∈ `picture` | `bird` (default `picture`). Both are user-level, global-scope settings like the other `profile_*` keys and join `PROFILE_SYNC_KEYS`.
- My profile (Contacts panel): the Avatar URL text field becomes a **Picture** file input plus a preview. The browser draws the chosen image onto a 128×128 canvas (cover-fit), exports JPEG at quality 0.82 (PNG when the source has transparency) and posts the `data:` URI; anything that still exceeds `AVATAR_MAX_BYTES` is refused with a message before posting. This is the Contacts panel's script, not a Ramble client script, so a canvas is fine here; Ramble's camera rule (spec §9 of the Flock design) is untouched.
- A **Use my Ramble bird** radio appears when `GET /api/ramble/pet` answers with a bird (the panel asks at load; a 404 or no bird hides the option). See §5.
- Server-side validation on save (`save_profile`): `avatar` must match `^data:image/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$` and be at most `AVATAR_MAX_BYTES` characters; otherwise 400. Rendering is always through an `<img src>` (never inline SVG), so an SVG avatar cannot run script.

### 4.2 Handshake
- `sendInviteAccepted` (acceptor → inviter) and `handshake_complete` (inviter → acceptor) gain `avatar` beside the existing `displayName` (`servers/sharing/tools/contacts.js`, `servers/sharing/boot.js`). Absent or invalid → ignored; the handshake never fails on it.
- Receivers write the peer fields: `contacts.peer_display_name` (sanitized), `contacts.peer_avatar` (validated). The existing behaviour that wrote the handshake name into `display_name` is kept ONLY for a brand-new contact row (so today's screens keep working); a later profile message never touches `display_name`.

### 4.3 The profile message
- A `crow_social` control envelope with a new subtype — `{ type: "crow_social", subtype: "profile", v: 1, display_name: <string|null>, avatar: <data URI|null> }` — sent through the existing `sendControl` (NIP-44 DM, one per full unblocked non-bot contact with a key) whenever the profile is saved with a changed name/picture/source, and when the bird source refreshes (§5). Best effort, no retry queue: the next change resends everything (idempotent). At most one broadcast per profile save.
- Receiver: the existing `crow_social` dispatch (`onSocialMessage(subtype, payload, senderPubkey)`, reached from `subscribeToContact` after the block check and from `subscribeToIncoming`) gains a `profile` branch that resolves the sender to a FULL contact row by pubkey and otherwise drops the message (contact-only; a stranger's or a pending request's profile never lands), validates and sanitizes, `UPDATE contacts SET peer_display_name = ?, peer_avatar = ? WHERE crow_id = ?`, and emits the contacts sync op so the user's other instances converge.

### 4.4 Schema and sync
- `contacts.peer_display_name TEXT`, `contacts.peer_avatar TEXT` via `addColumnIfMissing` in `scripts/init-db.js` (the guarded path used for `avatar_url` and `is_bot`); `scripts/schema-migration-dryrun.sh` run from the branch before the PR to confirm no `SCHEMA_GENERATION` bump. The columns ride contact-sync's full-row emits; the apply side copies them; outbox-door and apply-door tests. `EXCLUDED_COLUMNS.contacts` unchanged.

### 4.5 Display
- Everywhere a contact's name shows: `display_name || peer_display_name || crow_id`. Everywhere a contact's avatar shows: `avatar_url || peer_avatar || <initial>`. The Contacts panel's contact editor still lets the user set both local fields; clearing a local field falls back to the peer field.
- Ramble: `GET /api/ramble/marks` and `/around` add `contact_avatar` (the same `avatar_url || peer_avatar` value) beside `contact_name` for a contact's remote mark; the popup head shows it as a 24 px `<img>` created with `createElement` (a `src` assignment is not a markup sink; the two-sink rule holds).

### 4.6 Docs
- `docs/guide/contacts.md` "Your profile": the edit surface is Crow's Nest → Contacts → My profile (not Settings → Identity); the picture is uploaded and shrunk; contacts receive it on pairing and on every change; Spanish twin.

---

## 5. The bird as profile picture (Plan B)

- With `profile_avatar_source = bird`, the server renders the active bird's portrait (`bird-svg.cjs` `drawBird(rollGenome(seed, species), "happy")` inside a 200×200 `<svg>`) to a `data:image/svg+xml;base64,` URI and stores it in `profile_avatar_url` (≈ 4 KB, under the cap), then broadcasts the profile message.
- `activateBird` (Ramble) and a hatch that becomes the first active bird call a small core hook (`refreshBirdAvatar(db, managers)`, in `servers/sharing/`) that re-renders and rebroadcasts when the source is `bird`. If Ramble is uninstalled or no bird exists, the source silently falls back to `picture` with the last stored image.
- Ramble marks continue to carry `bird` on the wire as today; a stranger's pin shows the bird, a contact's pin shows the profile avatar (which may be that same bird).

---

## 6. APIs, tools, events

- `GET/POST /api/ramble/grid` gain `worldName`. `GET /api/ramble/marks`, `/around`: rows gain `author_name` (strangers) and `contact_avatar` (contacts); `ramble_query_world` rows gain `author_name` and `label`.
- Contacts panel `save_profile` accepts `avatar` (data URI) and `avatar_source`; new `GET /dashboard/contacts/profile` unchanged in shape plus `avatar_source`.
- New `crow_social` subtype `profile` (§4.3). No new MCP tool. No new Nostr kind.

---

## 7. Safety, privacy, limits

- World names are unverified and display-only (D2 tail). Contact names remain verified by the handshake key.
- Avatars: bounded (`AVATAR_MAX_BYTES`), typed (`data:image/...`), rendered only via `<img>`; a stranger's profile message is dropped; a blocked contact's is dropped by the existing block check.
- Nothing new leaves the device without an existing relationship: the world name goes only to the public relays the user already publishes to, at a level they chose; the avatar goes only to contacts.
- All new inputs bounded (zod `.max`, the regexes above).

---

## 8. Testing

Plan A: `sanitizeWorldName` rules; `markToEvent`/`eventToMark` round-trip at each Name level (name present only at pseudonym/real); `author_name` through both sync doors; the label rule for the four cases (server `labelFor` and, by string pins, the client); the grid route round-trip with a too-long and a hex-only name; docs parity.
Plan B: the avatar validator (types, cap, junk); the handshake payloads carrying `avatar` both ways and ignoring a bad one; the `profile` subtype round-trip through the real contact subscription (accepted from a contact, dropped from a stranger and a blocked contact); the contacts columns through both sync doors; `refreshBirdAvatar` rendering a deterministic SVG data URI under the cap; the My profile form (source switch present only with a bird); Ramble `contact_avatar` on a contact's mark; the migration dry-run; docs parity.

---

## 9. Not in this spec

Verified or unique world names; avatar moderation; a "profile" page for strangers; changing the rotating persona's period; letting strangers see the Crow display name at `real` (rejected in brainstorming in favour of D1).
