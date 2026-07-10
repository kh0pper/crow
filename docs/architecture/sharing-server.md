# Sharing Server

The sharing server (`servers/sharing/`) enables secure peer-to-peer sharing between Crow users. It provides three core capabilities:

1. **Knowledge sharing** — Transfer individual memories, citations, and notes between users
2. **Project collaboration** — Grant ongoing read or read-write access to research projects
3. **Social messaging** — Encrypted conversations via the Nostr protocol

No external accounts or central servers are required. Everything runs on the user's own infrastructure.

> User-facing walkthroughs: [Sharing guide](/guide/sharing) (contacts, invites, messaging) and [Data Sharing guide](/guide/data-sharing) (sharing memories and projects). This page covers internals.

## Architecture

```
┌─────────────────────────────────────────────┐
│  Layer 5: Applications                      │
│  ┌──────────┐ ┌──────────┐ ┌──────────────┐ │
│  │ Knowledge│ │ Project  │ │   Social/    │ │
│  │ Sharing  │ │ Collab   │ │  Messaging   │ │
│  └──────────┘ └──────────┘ └──────────────┘ │
├─────────────────────────────────────────────┤
│  Layer 4: Share Protocol                    │
│  Types: memory | project | source | note |  │
│    kb_article | message | reaction          │
│  Permissions: read | read-write | one-time  │
├─────────────────────────────────────────────┤
│  Layer 3: Data Sync (Hypercore)             │
│  Append-only feeds, eventually consistent   │
│  Each contact pair = paired Hypercore feeds │
├─────────────────────────────────────────────┤
│  Layer 2: Discovery & Transport (Hyperswarm)│
│  DHT peer discovery, NAT holepunching       │
│  Encrypted streams, no central server       │
├─────────────────────────────────────────────┤
│  Layer 1: Identity & Crypto                 │
│  Ed25519 + secp256k1 from shared seed       │
│  Crow ID = short public key fingerprint     │
└─────────────────────────────────────────────┘
```

**Technology split:**
- **Hypercore + Hyperswarm** — Heavy data sync (projects, bulk memories, file assets)
- **Nostr** — Lightweight social (messages, reactions, threads) via free public relays
- **Peer relays** — Opt-in cloud gateways for async delivery of Hypercore data

## Layer 1: Identity

Every Crow installation has a cryptographic identity, generated during `npm run setup`:

- **Master seed**: 32-byte random seed, encrypted at rest with user-chosen passphrase (Argon2id)
- **Ed25519 keypair**: Derived from seed via HKDF — used for Hypercore feeds and peer authentication
- **secp256k1 keypair**: Derived from seed via HKDF — used for Nostr events and encryption
- **Crow ID**: Short, shareable identifier derived from the Ed25519 public key (e.g., `crow:k3x7f9m2q4`)

Identity is stored in `data/identity.json` (gitignored). Backup is via BIP39 mnemonic phrase shown once during setup.

### Identity Management

| Command | Purpose |
|---|---|
| `npm run identity` | Display your Crow ID and public keys |
| `npm run identity:export` | Export encrypted identity for device migration |
| `npm run identity:import` | Import identity on a new device |

## Layer 2: Discovery (Hyperswarm)

Peers find each other through the Hyperswarm distributed hash table (DHT). No central signaling server is needed.

- **Topic**: Deterministic hash of both peers' public keys (sorted) — each contact pair has a unique topic
- **NAT traversal**: Automatic holepunching works behind home routers without port forwarding
- **Authentication**: Every connection starts with a challenge-response exchange using signed nonces

When two peers discover each other on the DHT, Hyperswarm establishes an encrypted duplex stream between them.

## Layer 3: Data Sync (Hypercore)

Shared data flows through Hypercore append-only feeds:

- Each contact relationship has **two feeds** — one per direction
- Feeds are stored locally under the data directory at `peers/<contactId>/out` and `peers/<contactId>/in`
- Entries are signed by the sender and encrypted for the recipient (NaCl box)
- When peers connect via Hyperswarm, Hypercore automatically syncs any missed entries
- **Eventually consistent**: If Alice shares at 2pm and Bob comes online at 8pm, he gets everything he missed

### Share Entry Format

```json
{
  "type": "memory",
  "action": "share",
  "payload": {
    "content": "Sourdough starter needs feeding every 12 hours",
    "category": "cooking",
    "tags": "baking, sourdough"
  },
  "permissions": "read",
  "timestamp": "2026-03-07T14:30:00Z",
  "signature": "<Ed25519 signature>"
}
```

## Layer 4: Share Protocol

### Share Types

| Type | Payload | Sync Model |
|---|---|---|
| `memory` | Single memory entry | One-time or ongoing |
| `project` | Project snapshot bundle (clone mode) | One-shot clone delivery |
| `source` | Research source with citation | One-time |
| `note` | Research note | One-time |
| `kb_article` | Knowledge-base article | One-time |
| `message` | Free-form text (via Nostr) | Nostr relay delivery |
| `reaction` | Response to a share | Nostr event |

### Project clone mode

Sharing a project (`crow_share` with `share_type: "project"`) delivers a **one-shot snapshot bundle**: the project metadata (with a send-side column allowlist — system-specific fields like `workspace_dir` never go on the wire), its sources, notes, audit log, data-backend manifests, and storage manifest. The recipient creates an independent copy with a `-clone-N` slug; further changes on either side do **not** sync. If the contact is offline, the share is queued with `mode='clone'` and a fresh bundle is rebuilt at re-delivery. Subscription mode (live one-way sync) is planned for a follow-on milestone.

### Permission Levels

| Permission | Meaning |
|---|---|
| `read` | Recipient can view but not modify |
| `read-write` | Recipient can add to shared project |
| `one-time` | Data delivered once, then removed from feed |

## Layer 5: Social (Nostr)

Messages and social interactions use the Nostr protocol:

- **NIP-44 encryption** (ChaCha20-Poly1305) for all direct messages
- **NIP-59 gift wraps** for sender anonymity on public relays
- **Public relays** provide async delivery (messages persist on relays until fetched)
- **Default relays** (`DEFAULT_RELAYS` in `servers/sharing/nostr.js`): `wss://relay.damus.io`, `wss://nos.lol`, `wss://relay.primal.net`, and the self-hosted `wss://nostr.crow.maestro.press`. `getConfiguredRelays()` always merges these defaults with any user-configured relays, so the defaults are a floor and one flaky relay is never a single point of failure.

**Self-hosted long-retention relay.** Public relays evict events by age, so a DM sent while the recipient is offline for a long window can be dropped before they reconnect (loss-mode L1). To close this, one default is a self-hosted `nostr-rs-relay` on the maestro.press droplet at `wss://nostr.crow.maestro.press`, configured to retain events long enough to outlast the R5 retry horizon. It is **restricted to `kind:4`** (the only kind Crow uses — all DMs, invites, receipts, group messages, and control envelopes are encrypted kind:4) and write-rate-limited, which bounds abuse on an open-write endpoint.

> **Network-exposure note.** This relay is a **separate service** (its own container behind nginx on maestro.press), *not* a Crow gateway route. It therefore does **not** fall under the gateway's Tailscale-Funnel exposure invariant (which governs dashboard/MCP/private routes on the gateway itself). It is a deliberate, operator-approved public surface that carries only NIP-44-encrypted `kind:4` events the relay cannot read.

The Nostr identity (secp256k1 key) is derived from the same master seed as the Hypercore identity, so users have a single Crow ID for everything.

### Why Nostr for messaging?

- **Async by design**: Messages persist on relays, no need for both peers to be online
- **No accounts**: Identity is just a keypair — matches Crow's self-contained philosophy
- **Lightweight**: Much simpler than running a Matrix server
- **Existing infrastructure**: Free public relays handle message delivery

## Peer Relay System

For Hypercore data (heavier than Nostr messages), async delivery requires a relay when peers are never online simultaneously.

- Any cloud-deployed Crow gateway can **opt-in** as a relay for its contacts
- Relays store encrypted blobs they cannot read (E2E encrypted for the recipient)
- No central relay service — it's mutual aid between peers
- Storage quotas and TTL (30-day default) prevent abuse

### Relay endpoints

| Endpoint | Purpose |
|---|---|
| `POST /relay/store` | Store an encrypted blob for a contact |
| `GET /relay/fetch` | Retrieve pending blobs |

Both endpoints require authentication (signed request with sender's Ed25519 key).

## MCP Tools

The server registers **33 tools**, organized into nine modules under `servers/sharing/tools/`:

| Module | Tools |
|---|---|
| `contacts.js` | `crow_generate_invite`, `crow_accept_invite`, `crow_list_contacts` |
| `share-inbox.js` | `crow_share` (memories, projects, sources, notes, KB articles), `crow_inbox` |
| `messaging.js` | `crow_send_message`, `crow_create_message_group`, `crow_list_message_groups`, `crow_send_group_message` |
| `sharing-admin.js` | `crow_revoke_access`, `crow_sharing_status` |
| `discovery.js` | `crow_find_contacts`, `crow_set_discoverable` |
| `instances.js` | `crow_discover_relays`, `crow_add_relay`, `crow_list_instances`, `crow_register_instance`, `crow_update_instance`, `crow_revoke_instance`, `crow_list_sync_conflicts` |
| `rooms-social.js` | `crow_room_invite`, `crow_room_close`, `crow_voice_memo`, `crow_react` |
| `identity.js` | `crow_identity_attest`, `crow_identity_verify`, `crow_identity_revoke`, `crow_identity_list` |
| `crosspost.js` | `crow_list_crosspost_transforms`, `crow_crosspost`, `crow_crosspost_cancel`, `crow_crosspost_mark_published`, `crow_list_crossposts` |

## Security Model

### Encryption

- All shared data is end-to-end encrypted using NaCl box (Curve25519 + XSalsa20 + Poly1305)
- Nostr messages use NIP-44 (ChaCha20-Poly1305)
- Identity seed encrypted at rest with Argon2id-derived key

### Invite Security

- Invite codes are **single-use** and expire after 24 hours
- Codes include HMAC to prevent tampering
- After handshake, both sides display a **safety number** (hash of shared secret) for out-of-band verification

### Relay Security

- Relays only accept requests signed by known contacts
- Pending-blob quota: at most 100 stored blobs per contact
- Storage quotas: configurable max storage per contact
- Blobs expire after TTL (30-day default)

### Contact Management

- Contacts can be blocked, which stops all replication and messaging
- Blocked contacts cannot re-invite (stored in blocklist)
- Key rotation notifies all contacts of new keys

#### Deleting a contact

Deletion is a **hard delete**, and it is destructive: `messages.contact_id` is
`NOT NULL REFERENCES contacts(id) ON DELETE CASCADE`, and foreign keys **are** enforced
(`better-sqlite3` sets `foreign_keys=ON` on every connection), so removing a contact
permanently removes the conversation with them, plus their shared items, group memberships and
project memberships. The Contacts panel therefore gates the delete behind a confirmation
interstitial that lists the exact counts and offers **Block** — which is reversible and
non-destructive — as the alternative. Prefer Block for "stop hearing from this person"; Delete
means "remove this entry from my address book."

Deletion propagates to the user's other instances (contacts follow the user, Phase 3).

**Tombstones.** `contact_tombstones` (crow_id, lamport_ts, deleted_at) makes a delete durable.
Without one, a peer that was offline during the delete would emit an `update` on its next sync,
and `_applyContact`'s upsert would resurrect the contact fleet-wide — a delete that resurrects
is worse than no delete. The rule in `_applyContact` (design §D3.1):

- A **live local row** proves a local path re-created the contact, so a coexisting tombstone is
  stale and is cleared.
- A **delete** writes a tombstone only when it is *authoritative* (no local row, or it wins
  Lamport LWW). The destructive row removal keeps the `lamportTs > localTs` guard — a stale
  delete must never wipe a live contact, because the cascade would take its DM history with it.
- A standing tombstone **drops a concurrent `update`** (delete wins) and drops a stale `insert`
  replay. Only an `insert` above the tombstone's lamport re-adds the contact, and it **applies
  before it clears** (feeds lock per remote instance, so a concurrent reader must see either the
  tombstone or the row, never neither).

Because the applier can only tell a genuine re-add from a stale rename by the op,
`upsertFullContact` emits `insert` from *every* outcome (merge/promote/create) when it clears a
local tombstone. Without that, the ordinary re-pair path — which takes the promote branch and
would emit `update` — would be dropped by every peer, diverging the fleet permanently.

Tombstones are local state: never synced, never pruned (a retention window would reopen
resurrection for any instance offline longer than the window). They are never written for
`req:` ids, which never sync.

**Replay hygiene.** `processed_control_events` records the `event.id` of every handled
`invite_accepted`. The R5 retry loop republishes the byte-identical signed event for up to ~60h,
so after a deletion a stale retry would otherwise silently re-add the contact. A recorded id
skips the contact upsert but **still sends the `handshake_complete` ack**, which stops the
peer's retry loop. This is keyed on the event id, never on wall clocks: `deleted_at` and
`created_at` come from different machines with no NTP guarantee, and comparing them would
silently refuse honest re-pairs from a slow-clocked peer. It also closes a pre-existing gap —
plain invite codes carry no `inviteId`, so they previously had no replay protection at all.

Deleting a contact does **not** block them. A later DM lands in the Requests inbox as a fresh
`req:` row. Blocking is the tool for silencing someone.

#### Display names in the handshake

`invite_accepted` and `handshake_complete` each carry an optional `displayName`, taken from the
sender's `profile_display_name`. Omitted entirely when unset — the receiver then falls back to
the raw crowId, exactly as before. It is applied only over a placeholder name, so a remote name
never overwrites one the user typed.

The value is **remote-attacker-controlled** and renders in the dashboard, so every ingress
(both handshake handlers *and* the instance-sync apply path — a signature proves same-key, not
honest content) runs `sanitizeDisplayName()`: strips control characters and NUL, strips Unicode
bidi overrides/isolates, collapses whitespace, rejects `crow:`/`req:` identity-string
impersonation, and caps at 64 code points.

## Database Tables

The sharing server adds these tables to the shared SQLite database:

| Table | Purpose |
|---|---|
| `contacts` | Peer identities, public keys, relay status, last seen |
| `contact_tombstones` | Local, never-synced record of deleted contacts; makes a delete durable against resurrection by an offline peer |
| `processed_control_events` | Handled control-event ids (e.g. `invite_accepted`) so a replayed retry cannot re-add a deleted contact |
| `shared_items` | Tracking of sent/received shares with permissions; the `mode` column marks queued project clones (`mode='clone'`) so re-delivery rebuilds a fresh bundle |
| `messages` | Local cache of Nostr messages with read status |
| `relay_config` | Configured Nostr relays and peer relays |
| `relay_blobs` | Encrypted store-and-forward blobs held for offline recipients (TTL-expired) |
| `sync_conflicts` | Multi-instance sync conflicts awaiting review (see [Instance Sync](./instances.md)) |

## Module Structure

```
servers/sharing/
├── server.js          → createSharingServer() orchestrator: builds shared context,
│                        registers the 9 tool modules in a frozen order
├── index.js           → Stdio transport wrapper
├── boot.js            → Startup wiring: pending-share queue re-delivery, feed init
├── managers.js        → Singleton ownership of peer/sync/relay managers
├── identity.js        → Key generation, Crow ID, invite codes, encryption
├── peer-manager.js    → Hyperswarm discovery, connection management
├── sync.js            → Hypercore feed management, replication
├── instance-sync.js   → Multi-instance replication (see instances.md)
├── sync-conflict-resolve.js → Conflict restore flow for the Settings recovery view
├── clone-bundle.js    → Project clone-bundle build (send-side column allowlist)
├── rooms.js           → Shared room lifecycle
├── bot-relay.js       → Bot-to-bot message relay
├── tailnet-sync.js    → Tailnet-transport instance sync
├── secret-box.js      → NaCl box encryption helpers
├── nostr.js           → Nostr events, NIP-44 encryption, relay comms
├── relay.js           → Peer relay opt-in, store-and-forward
└── tools/             → 9 modules registering the 33 MCP tools (table above)
```

The gateway imports `createSharingServer()` and wires it to HTTP transport at `/sharing/mcp` and `/sharing/sse`, following the same pattern as the memory and project servers.
