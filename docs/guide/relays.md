# Relays

Relays provide store-and-forward delivery for Crow's peer-to-peer sharing system. When two peers are rarely online at the same time, a relay holds encrypted data until the recipient connects.

## What is a relay?

Crow's sharing system uses two transport layers:

- **Hyperswarm** — Direct peer-to-peer connections for heavy data (project sync, bulk memories, file assets). Requires both peers to be online simultaneously.
- **Nostr relays** — Lightweight messaging (DMs, reactions). Messages persist on public relays until fetched.

A **peer relay** bridges the gap for Hypercore data. It accepts encrypted blobs from a sender, stores them temporarily, and delivers them when the recipient connects. Think of it as a mailbox for your encrypted data.

## Default relay

Crow provides a default relay at `relay.crow.maestro.press` (planned). This relay is available to all Crow users and requires no configuration — new installations will connect to it automatically.

The default relay:

- Stores encrypted blobs for up to 30 days
- Enforces per-contact storage quotas (100 pending blobs, 1MB each)
- Cannot read your data — it only sees encrypted blobs
- Is optional — you can remove it and use only your own relays

## How peer relays work

Any cloud-deployed Crow gateway can act as a relay for its contacts. This is opt-in and mutual — you help your friends, and they help you.

### Enabling relay mode

Ask Crow to enable your gateway as a relay:

> "Enable relay mode for my gateway"

This sets `relay_enabled` in your sharing status. Your gateway will then accept `POST /relay/store` and `GET /relay/fetch` requests from authenticated contacts.

### How delivery works

1. Alice wants to share a memory with Bob, but Bob is offline
2. Alice's Crow encrypts the data for Bob's public key
3. Alice's Crow sends the encrypted blob to a relay that both Alice and Bob trust
4. The relay stores the blob (it cannot decrypt it)
5. When Bob comes online, his Crow fetches pending blobs from the relay
6. Bob's Crow decrypts and processes the data locally

### Authentication

Relays only accept requests from known contacts:

- **Store requests** require an Ed25519 signature from the sender
- **Fetch requests** require an Ed25519 signature plus a recent timestamp (within 5 minutes) to prevent replay attacks

Unknown or blocked contacts are rejected.

## Finding public relays

Currently, relay discovery is manual. You can find relays through:

- **The default relay** at `relay.crow.maestro.press` (available to all users)
- **Friends with cloud-deployed gateways** — Ask your contacts if they run a relay
- **Community lists** — Check the Crow community channels for shared relay addresses

Future versions will support automatic relay discovery via the DHT, allowing Crow to find nearby relays without manual configuration.

## Privacy model

Relays are designed so that operating one reveals minimal information about users:

| What the relay sees | What the relay cannot see |
|---|---|
| Sender's public key | Message content (encrypted) |
| Recipient's public key | File names, memory text, project data |
| Blob size and timestamp | The type of data being shared |
| When blobs are fetched | Conversation content or context |

All shared data is end-to-end encrypted using NaCl box (Curve25519 + XSalsa20 + Poly1305). The relay operator — even if compromised — can only see that encrypted blobs were exchanged between two public keys.

### Relay trust

Adding a relay means trusting it to:

- Store your blobs reliably (not delete them early)
- Deliver them to the correct recipient
- Respect storage quotas and TTL

You do **not** need to trust it with your data's confidentiality — encryption handles that.

## Configuring relays

### Adding a relay

Ask Crow to add a relay:

> "Crow, add relay at wss://my-relay.example"

Or add a friend's gateway as a trusted relay:

> "Add Alice's gateway as a trusted relay: https://alice-crow.onrender.com"

### Removing a relay

> "Remove the relay at wss://old-relay.example"

### Viewing relay status

> "Show my relay configuration"

The `crow_sharing_status` tool displays your current relays, whether relay mode is enabled on your gateway, and pending blob counts.

## Capacity and retention

Relays enforce limits to prevent abuse:

| Limit | Default |
|---|---|
| Maximum blob size | 1 MB |
| Maximum pending blobs per contact | 100 |
| Blob retention (TTL) | 30 days |
| Authentication | Ed25519 signed requests |
| Rate limiting | Configurable per contact per hour |

Expired blobs are cleaned up automatically. If a recipient never fetches their blobs within the TTL, the data is deleted from the relay. The sender's Crow will re-queue delivery next time both peers are online via Hyperswarm.

## Comparison with Nostr relays

Crow uses two different relay systems for different purposes:

| | Peer Relays | Nostr Relays |
|---|---|---|
| **Used for** | Heavy data (projects, memories, files) | Lightweight messages and reactions |
| **Protocol** | HTTP REST (Ed25519 auth) | WebSocket (Nostr protocol) |
| **Encryption** | NaCl box (Curve25519) | NIP-44 (ChaCha20-Poly1305) |
| **Discovery** | Manual configuration (future: DHT) | Public relay lists |
| **Default relays** | `relay.crow.maestro.press` | `relay.damus.io`, `nos.lol`, `relay.nostr.band` |
| **Who runs them** | Crow users with cloud gateways | Nostr community |

Both systems share the same Crow identity. You do not need separate accounts or keys.
