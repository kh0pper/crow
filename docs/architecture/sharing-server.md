# Sharing Server

The sharing server (`servers/sharing/`) enables secure peer-to-peer sharing between Crow users. It provides three core capabilities:

1. **Knowledge sharing** — Transfer individual memories, citations, and notes between users
2. **Project collaboration** — Grant ongoing read or read-write access to research projects
3. **Social messaging** — Encrypted conversations via the Nostr protocol

No external accounts or central servers are required. Everything runs on the user's own infrastructure.

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
│         message | reaction                  │
│  Permissions: read | read-write | one-time  │
├─────────────────────────────────────────────┤
│  Layer 3: Data Sync (Hypercore)             │
│  Append-only feeds, eventually consistent   │
│  Each contact pair = paired Hypercore feeds  │
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
- Feeds are stored locally in `data/peers/<contactId>/`
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
| `project` | Research project + metadata | Ongoing feed sync |
| `source` | Research source with citation | One-time |
| `note` | Research note | One-time |
| `message` | Free-form text (via Nostr) | Nostr relay delivery |
| `reaction` | Response to a share | Nostr event |

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
- **Free public relays** provide guaranteed async delivery (messages persist on relays until fetched)
- Default relays: `wss://relay.damus.io`, `wss://nos.lol`, `wss://relay.nostr.band`

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

| Tool | Description |
|---|---|
| `crow_generate_invite` | Create an invite code for a new contact |
| `crow_accept_invite` | Accept invite and complete peer handshake |
| `crow_list_contacts` | List connected peers with online status |
| `crow_share` | Share a memory, project, source, or note |
| `crow_inbox` | Check received shares and messages |
| `crow_send_message` | Send encrypted message to a contact |
| `crow_revoke_access` | Revoke a previously shared project |
| `crow_sharing_status` | Show Crow ID, peer count, relay status |

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
- Rate limiting: configurable max requests per contact per hour
- Storage quotas: configurable max storage per contact
- Blobs expire after TTL (30-day default)

### Contact Management

- Contacts can be blocked, which stops all replication and messaging
- Blocked contacts cannot re-invite (stored in blocklist)
- Key rotation notifies all contacts of new keys

## Database Tables

The sharing server adds four tables to the shared SQLite database:

| Table | Purpose |
|---|---|
| `contacts` | Peer identities, public keys, relay status, last seen |
| `shared_items` | Tracking of sent/received shares with permissions |
| `messages` | Local cache of Nostr messages with read status |
| `relay_config` | Configured Nostr relays and peer relays |

## Module Structure

```
servers/sharing/
├── server.js          → createSharingServer() factory with all MCP tools
├── index.js           → Stdio transport wrapper
├── identity.js        → Key generation, Crow ID, invite codes, encryption
├── peer-manager.js    → Hyperswarm discovery, connection management
├── sync.js            → Hypercore feed management, replication
├── nostr.js           → Nostr events, NIP-44 encryption, relay comms
└── relay.js           → Peer relay opt-in, store-and-forward
```

The gateway imports `createSharingServer()` and wires it to HTTP transport at `/sharing/mcp` and `/sharing/sse`, following the same pattern as the memory and project servers.
