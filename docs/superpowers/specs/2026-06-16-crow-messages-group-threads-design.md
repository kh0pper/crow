# Crow Messages — Phase 3a: Group / Multi-Party Bot Threads

**Date:** 2026-06-16
**Status:** Design approved (brainstorming complete) → ready for writing-plans
**Arc:** Crow Messages gateway. Phases 0/1/2 shipped + deployed (`origin/main a889408`). This is the LAST "Future" phase. See `session-handoff-2026-06-16-crow-messages-phase3-and-docs` and `[[crow-messages-bot-directory-shipped]]`.

## Summary

Today Crow Messages is strictly **1:1** (one sender ↔ one bot). Phase 3 adds **persistent multi-party rooms** that mix **humans and bots uniformly** — "add a bot to a chat like adding a contact." Because the Nostr transport is pairwise-encrypted (kind-4 DMs, no native group channel), a room is synthesized as a **hub-and-spoke fan-out**: one instance *hosts* the room and relays every message to all participants.

### Scope decisions (locked in brainstorming)

| Decision | Choice |
|---|---|
| **Membership** | You + your bots + other humans (Crow contacts), mixed in one room. |
| **Hosting (this phase = 3a)** | **Your instance hosts** rooms you create; participants = your bots + your human/Crow contacts. Symmetric hosting (your bot joining a *remote*-hosted room) is **phase 3b**, a documented fast-follow — same transport, relaxed trust check. |
| **Bot turn-taking** | **Per-room mode toggle**: `addressed` (default — bot replies only when @-mentioned / named) ↔ `always` (bot replies to every human message). |
| **Loop-safety invariant** | Bots react **only to human-authored messages, never to a bot's message.** Structural, not throttled. |
| **Transport** | **Approach A — uniform-participant hub-and-spoke.** Host fans each message out as ordinary 1:1 encrypted DMs to every *other* member (humans and bots identically). A bot is just a participant addressed at its pubkey; local and remote bots are one code path. |

Rejected alternatives: **B** in-process/job-queue relay to local bots (two divergent code paths, re-unified in 3b anyway); **C** shared relay-side group NIPs (NIP-28/29 — depends on relay support we don't control, abandons our default-deny per-participant trust model).

## Data model

**Rooms are built ON the existing `contact_groups`** (which is *not* purely organizational — it already backs `crow_send_group_message`, a one-way `group_message` broadcast). Reusing it keeps ONE "group" concept, reuses `contact_group_members` + the group picker, and lets the legacy broadcast evolve into a real room. A `contact_group` **becomes a room** when it carries a `room_uid`; plain organizational groups (no `room_uid`) are unaffected. Members are just **contacts** (some `is_bot`), preserving *a bot is a contact/participant.* The 1:1 `messages` table is **not** overloaded — room messages get their own table.

**Extend `contact_groups`** (via `addColumnIfMissing` — 3rd arg is the type-clause only):
```
room_uid     TEXT      -- NULL = plain organizational group; non-NULL = a messaging room (stable, shared across instances)
host_crow_id TEXT      -- host instance's crow_id (this instance, in 3a)
mode         TEXT DEFAULT 'addressed'   -- 'addressed' | 'always' (validated in code; CHECK can't be added to an existing table)
```
A partial unique index keeps `room_uid` unique when present: `CREATE UNIQUE INDEX idx_contact_groups_room_uid ON contact_groups(room_uid) WHERE room_uid IS NOT NULL;`

**Reuse `contact_group_members` as-is** for the roster (`group_id`, `contact_id`). Bots are added as `is_bot` contact members.

**New `room_messages` table** (the one genuinely new table — `messages.contact_id` is NOT NULL with 1:1 semantics, so room messages can't live there), keyed by `group_id`:
```sql
CREATE TABLE room_messages (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id          INTEGER NOT NULL REFERENCES contact_groups(id) ON DELETE CASCADE,
  msg_uid           TEXT NOT NULL,         -- origin-assigned, preserved through re-fan; cross-participant dedup key
  sender_contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,  -- NULL = you (the host/operator)
  sender_label      TEXT,                  -- display-name snapshot (resilient if contact later deleted)
  author_kind       TEXT NOT NULL DEFAULT 'human' CHECK (author_kind IN ('human','bot')),
  content           TEXT NOT NULL,
  direction         TEXT NOT NULL CHECK (direction IN ('sent','received')),
  nostr_event_id    TEXT,                  -- transport dedup (per-DM); NULL for host-origin rows
  is_read           INTEGER DEFAULT 0,
  created_at        TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_room_messages_group ON room_messages(group_id, created_at);
CREATE UNIQUE INDEX idx_room_messages_msg_uid ON room_messages(group_id, msg_uid);
```

Supporting points:
- **`room_uid` is the shared key.** Each participating instance has its OWN `contact_groups` row carrying the same `room_uid`: the host creates it at room creation; a participant materializes its local row on `room_join` (and populates `contact_group_members` from the join's `members[]`). All `room_message` envelopes carry `room_uid`; each instance maps it to its local `group_id`.
- **Local bots become `is_bot` contacts on their own host** (derived pubkey via `deriveBotIdentity`), upserted by an idempotent helper `ensureLocalBotContact(botId)` when added to a room — so membership is uniformly `contact_id`.
- **`author_kind` is the loop-safety keystone.** Bots only run a turn on `author_kind='human'` rows; a bot's reply is `author_kind='bot'`, ignored by every bot.
- The host/operator is **implicit** (the room owner), not a member row. Members = the others.
- The legacy `group_message` broadcast subtype stays distinct from the new `room_message` subtype; no behavior change to `crow_send_group_message` in this phase.

## Transport envelope

A new `crow_social` subtype, fanned out as ordinary encrypted 1:1 DMs via `nostrManager.sendMessage(contact, envelope)`:

```jsonc
{ "type": "crow_social", "version": 1, "subtype": "room_message",
  "payload": {
    "room_uid": "…", "room_name": "…", "host_crow_id": "…",
    "msg_uid": "…",                      // origin-assigned, preserved through re-fan; logical dedup key across all recipients
    "author": { "kind": "human"|"bot", "crow_id": "…", "display_name": "…" },
    "text": "…",
    "addressed_to": ["researchbot"],     // HOST-computed exact-name/@mention match against the bot roster
    "ts": "ISO8601"
} }
```

Plus a lightweight `room_join` subtype (host → new member) carrying `{room_uid, room_name, members[]}` so a recipient's client auto-materializes the room thread. `room_leave` is a fast-follow; v1 "leave" = local removal + host stops relaying.

## Data flow

**The host is the relay for *every* message.** Whether a message originates from you (typing), a remote human participant, or a bot, it reaches all other members **only** via the host's fan-out. `msg_uid` is assigned **once by the message's origin node and preserved end-to-end through the re-fan** (so every participant dedups on the same id and the origin sees no echo). The host computes `addressed_to` at **(re-)fan time** for every human-authored message, not only your own.

**A human message into the room:**
1. **You type** in the room thread → gateway writes a `room_messages` row (`direction='sent'`, `author_kind='human'`, `sender_contact_id=NULL`, fresh `msg_uid`), then **fans out** one `room_message` DM to every *other* member contact (humans + bots), each signed by your instance key.
2. **Host computes `addressed_to`** by matching exact bot display-names / `@mentions` against the room's bot roster, so bots don't each re-parse.
3. **A remote human participant** receives the DM → their gateway recognizes `room_message`, dedups on `msg_uid`, writes a `received` row, renders it in their room thread. If *they* reply, their gateway sends a `room_message` (their own new `msg_uid`) **to the host**, which writes a `received` row and re-fans it to all *other* members (excluding the origin) — the same relay path as a bot reply (steps 5–6).
4. **A bot participant** receives the DM at its own pubkey → the **crow-messages adapter** runs a pi turn **only if**: `author.kind==='human'` AND (`mode==='always'` OR the bot is in `addressed_to`). Otherwise it stays silent and stores nothing.

**A bot's reply:**
5. The bot replies addressed **to the host**, as a `room_message` with `author.kind==='bot'`, the same `room_uid`, a new `msg_uid`.
6. The host receives it, writes a `received` row (`author_kind='bot'`), and **re-fans it out** to all *other* members. Because it's bot-authored, **no bot reacts** → loop structurally impossible.

## Authorization & trust

- The bot's trust decision is on the **transport signer** of the DM (the arc's "key on the signed pubkey; claimed fields are labels" principle). The bot derives its own **host-instance pubkey** from its seed and accepts a `room_message` **only if the event signer == its own host instance** (covers all of phase 3a — every bot is local). `author.kind`, `display_name`, `host_crow_id` in the payload are **labels only**, never trusted for authorization.
- A `room_message` from any other signer is **dropped pre-turn** (default-deny, fail-closed), reusing `authorizeSender` semantics.
- **Phase 3b** adds the per-bot ACL / paired-instance path for *remote* bots joining *your* room — same checkpoint, relaxed trust check. Not built now.
- **Consent:** in 3a, room members are your existing *mutual* contacts; a `room_join` notice materializes the thread on their side, and they can leave. (Explicit accept-to-join is a possible 3b refinement.)

## UI surfaces

(In `servers/gateway/dashboard/panels/messages/` — `html.js`, `client.js`, `css.js`, `data-queries.js`, `api-handlers.js`. All strings via the i18n `t(...)` helper, **EN + ES parity**. **CSRF token on every POST form** — the arc's standing rule.)

1. **Create a room** — a new `+` popover item **"New Group"** → dialog: room **name** + **member picker** (multi-select over contacts, bots included and badged, reusing the phase-2 badge + existing contact list). On create: insert room + members, upsert local-bot self-contacts, send each member a `room_join`.
2. **Unified Messages list** — a room renders as a conversation row with a **group glyph**, name, **member count / bot badge**, last-message + unread. The list UNIONs `messages` + `room_messages`, ordered by recency.
3. **Room thread view** — each message shows a **sender label** (humans by name, bots badged); a **header** with room name + member chips + settings (kebab); composer supports **`@`-addressing** (offers the room's bots) as sugar over the host-authoritative `addressed_to`.
4. **Room settings / manage** (host-only in 3a): **add member** (same picker — "add a bot like adding a contact"), **remove member**, **rename**, **leave/delete**, and the **mode toggle** (*Addressed only* ↔ *Always respond*) with a one-line explanation.

## Error handling, safety & edge cases

- **Loop safety:** turns are **event-driven by human input only** — no timer, nothing unattended/autonomous. Bounded at **N-bots × 1 turn per human message**; bot replies never re-trigger. Structurally impossible to loop. (Satisfies the global unattended-loop rule by construction — there is no long-running prod-degrading window here.)
- **Spoofing:** trust is on the transport signer, not payload labels (see Authorization). A forged `room_message` from a non-host signer is dropped before turn logic.
- **Delivery:** fan-out is **N independent best-effort DMs**; the host writes its own `room_messages` row *first* (source of truth), so a failed recipient send doesn't lose the message — failures logged per-recipient.
- **Replay:** idempotent under the 24h relay replay via `msg_uid` UNIQUE + `nostr_event_id` + the bot side's `bot_message_seen`. An offline bot may answer late on replay; dedup prevents a double-answer.
- **Lifecycle:** contact delete → `ON DELETE CASCADE` drops membership; `sender_contact_id ON DELETE SET NULL` keeps history via the `sender_label` snapshot. Mode change applies to subsequent messages. Addressed-mode with nobody addressed = humans-only exchange (intended). Name matching is **exact display-name / explicit `@`** (word-boundary), never substring.

## Testing

Node built-in runner (`node --test --test-force-exit tests/<file>.test.js`):
- **Schema/store:** `ensureLocalBotContact` idempotent; room + member CRUD; `room_messages` `msg_uid` dedup. (New tables via `initTable`; any `addColumnIfMissing` uses the **type-clause-only** 3rd arg.)
- **Fan-out:** host excludes the author, reaches all other members (mock `nostrManager.sendMessage`, assert recipient set).
- **`addressed_to` computation:** exact-name / `@`-mention matching against the bot roster.
- **Bot turn gate (critical safety test):** runs a turn **iff** `author_kind='human'` AND (`always` OR addressed); **ignores bot-authored**; **drops when signer ≠ own host** (fail-closed).
- **Reply + re-fan:** bot replies to host as `author.kind='bot'` with a new `msg_uid`; host writes a `received` row and re-fans **without** re-triggering bots.
- **Dedup:** replayed event / duplicate `msg_uid` → no double store, no double turn.
- **Inbound + UI seam:** `room_join` materializes a thread; unified list UNION ordering; action handlers via the existing `handlePostAction` / `handleContactAction` seam with in-memory libsql.

## Files touched (anticipated)

- `scripts/init-db.js` — 3 new `contact_groups` columns (`addColumnIfMissing`) + partial unique index on `room_uid` + the new `room_messages` table (schema-change deploy: run `CROW_DB_PATH=<path> node scripts/init-db.js` per data dir first, verify, then restart).
- `servers/gateway/dashboard/panels/messages/` — `html.js` / `client.js` / `css.js` / `data-queries.js` / `api-handlers.js` (New Group, room list, room thread, settings).
- `servers/gateway/dashboard/panels/messages/` new module(s) for room store + fan-out (libsql side), mirroring the `crow-messages-admin.js` pattern.
- `servers/sharing/` — room envelope send (a `room_message`/`room_join` sender alongside `rooms.js` social senders) + inbound `room_message`/`room_join` handling in the peer-message path.
- `scripts/pi-bots/gateways/crow-messages.mjs` + `crow-messages-store.mjs` — recognize `room_message`, the turn gate + host-signer trust, reply-to-host. **→ deploy requires a `pibot-gateways@<inst>` restart** (unlike phases 1/2).
- `tests/` — new `*.test.js` files per the Testing section.
- i18n catalogs — EN + ES keys for the new UI.

## Deploy (per the arc's cheat-sheet)

4 gateways (crow `~/.crow` :3001, MPA `~/.crow-mpa` :3006, grackle `~/crow` :3002, black-swan `~/crow` :3001). **Schema-change deploy:** `CROW_DB_PATH=<db> node scripts/init-db.js` per data dir → verify new tables via PRAGMA → restart gateway(s) → **restart `pibot-gateways@<inst>`** (adapter changed). Live-verify cross-instance (a real room with a bot answering), not just "tests pass."

## Out of scope (phase 3b / later)

- Symmetric hosting (your bot joining a remote-hosted room); remote/advertised-directory bots as room members.
- `room_leave` protocol message; explicit accept-to-join consent.
- Bot-to-bot autonomous threads (the operator did **not** select this).
- Per-message read receipts / typing indicators / reactions in rooms.
