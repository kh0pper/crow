# Relay Protocol

This document describes the technical architecture of Crow's peer relay system — the store-and-forward layer that enables asynchronous delivery of Hypercore data between peers.

## Overview

Crow's sharing system uses Hyperswarm for direct peer-to-peer connections and Hypercore for data replication. Both require peers to be online simultaneously. The relay protocol adds an intermediary that holds encrypted data for offline recipients.

```
Sender                    Relay                     Recipient
  │                         │                          │
  │  POST /relay/store      │                          │
  │  {blob, signature}      │                          │
  │────────────────────────>│                          │
  │                         │  stores encrypted blob   │
  │                         │                          │
  │                         │   GET /relay/fetch       │
  │                         │   {pubkey, signature}    │
  │                         │<─────────────────────────│
  │                         │                          │
  │                         │   {blobs: [...]}         │
  │                         │─────────────────────────>│
  │                         │                          │
  │                         │  deletes delivered blobs │
```

## Store-and-forward model

The relay acts as a temporary mailbox:

1. **Store** — A sender pushes an encrypted blob addressed to a recipient's public key
2. **Hold** — The relay stores the blob until the recipient fetches it or the TTL expires
3. **Forward** — When the recipient connects and authenticates, all pending blobs are delivered
4. **Cleanup** — Delivered blobs are deleted immediately; expired blobs are purged periodically

The relay never decrypts, inspects, or modifies blob contents. It is a dumb pipe with authentication.

## Message format

### Store request

```
POST /relay/store
Content-Type: application/json

{
  "recipient": "<Ed25519 public key hex>",
  "blob": "<encrypted data, base64 or JSON>",
  "signature": "<Ed25519 signature hex>",
  "senderPubkey": "<Ed25519 public key hex>"
}
```

The `signature` covers `JSON.stringify({ recipient, blob })`, proving the sender authored the request.

The `blob` field contains data encrypted with NaCl box (Curve25519 + XSalsa20 + Poly1305) for the recipient's public key. The relay cannot decrypt it.

### Fetch request

```
GET /relay/fetch?pubkey=<hex>&signature=<hex>&timestamp=<ms>
```

The `signature` covers `"<pubkey>:<timestamp>"`. The timestamp must be within 5 minutes of the relay's clock to prevent replay attacks.

### Fetch response

```json
{
  "blobs": [
    {
      "blob": "<encrypted data>",
      "sender": "<sender Ed25519 pubkey hex>",
      "timestamp": 1741782600000
    }
  ],
  "count": 1
}
```

All matching blobs are returned in a single response and deleted from the relay.

## Delivery guarantees

The relay protocol provides **best-effort, eventual delivery**:

- **No guaranteed ordering** — Blobs from multiple senders may arrive in any order
- **At-most-once from relay** — Once fetched, blobs are deleted; the relay does not re-deliver
- **Eventual delivery via Hypercore** — If relay delivery fails (TTL expires, relay goes down), Hypercore syncs the data directly when both peers are online via Hyperswarm
- **No acknowledgment protocol** — The sender does not receive confirmation that the recipient fetched the blob

The relay is an optimization layer, not the primary delivery mechanism. Hypercore's append-only feeds ensure data is never lost — the relay just accelerates delivery when peers have non-overlapping online windows.

### Failure scenarios

| Scenario | Outcome |
|---|---|
| Relay is down when sender stores | Sender retries or waits for Hyperswarm sync |
| Relay is down when recipient fetches | Recipient retries later or waits for Hyperswarm sync |
| Blob expires before fetch (30-day TTL) | Data deleted from relay; Hyperswarm sync handles delivery |
| Relay loses data (crash, disk failure) | No data loss — Hypercore feeds are the source of truth |
| Relay compromised | Attacker sees encrypted blobs but cannot decrypt them |

## Relay discovery

### Current: manual configuration

Relays are configured explicitly by the user:

- Via AI conversation: *"Add relay at https://relay.example.com"*
- Stored in the `relay_config` database table with `relay_type = 'peer'`

Each relay entry includes:

| Field | Description |
|---|---|
| `relay_url` | Full URL of the relay endpoint |
| `relay_type` | `'peer'` for Hypercore relays, `'nostr'` for message relays |
| `enabled` | Whether the relay is active |

### Default relay

New installations are pre-configured with `relay.crow.maestro.press` (planned). Users can remove it or add additional relays.

### Future: automatic discovery via DHT

A planned enhancement will allow Crow to discover relays automatically through the Hyperswarm DHT:

1. Relay operators announce their availability on a well-known DHT topic
2. Crow clients query the topic to find available relays
3. Clients select relays based on latency, capacity, and trust preferences

This is not yet implemented. Current relay discovery is manual only.

## Capacity limits and retention

### Per-relay defaults

| Parameter | Value | Configurable |
|---|---|---|
| Max blob size | 1 MB | Yes (relay operator) |
| Max pending blobs per recipient | 100 | Yes (relay operator) |
| Blob TTL | 30 days | Yes (relay operator) |
| Rate limit | Per contact per hour | Yes (relay operator) |

### Quota enforcement

- **Store requests** that exceed the blob size limit receive `413 Payload Too Large`
- **Store requests** that exceed the per-recipient blob count receive `429 Too Many Requests`
- **Expired blobs** are purged by a periodic cleanup routine (`cleanupExpiredBlobs()`)

### Storage considerations

A relay with 100 contacts, each with 100 pending 1MB blobs, would use approximately 10 GB of storage. In practice, usage is much lower — most blobs are delivered within hours and deleted.

The current implementation uses an in-memory store (`Map`). A production relay should use persistent storage (SQLite or similar) to survive restarts.

## Authentication model

All relay endpoints require Ed25519 signature authentication:

### Store authentication

1. Sender constructs `message = JSON.stringify({ recipient, blob })`
2. Sender signs `message` with their Ed25519 private key
3. Relay verifies the signature against `senderPubkey`
4. Relay checks that `senderPubkey` belongs to a known contact

### Fetch authentication

1. Recipient constructs `message = "<pubkey>:<timestamp>"`
2. Recipient signs `message` with their Ed25519 private key
3. Relay verifies the signature against `pubkey`
4. Relay checks that `timestamp` is within 5 minutes of server time (replay protection)

### Trust model

Relays only serve authenticated contacts. An unknown public key cannot store or fetch blobs. This prevents:

- **Spam** — Anonymous parties cannot fill the relay with junk data
- **Enumeration** — Unauthenticated requests cannot discover which public keys have pending blobs
- **Abuse** — Rate limits are enforced per authenticated contact

## Implementation

The relay is implemented in `servers/sharing/relay.js` and exposes two Express route handlers via `createRelayHandlers()`:

- `store(req, res)` — Validates, authenticates, and stores a blob
- `fetch(req, res)` — Authenticates and returns all pending blobs for the requester

The gateway mounts these at `/relay/store` and `/relay/fetch` when relay mode is enabled.

### Module dependencies

```
servers/sharing/relay.js
  └── servers/sharing/identity.js (verify function for Ed25519 signatures)
```

### Related modules

| Module | Role in relay system |
|---|---|
| `servers/sharing/relay.js` | Store-and-forward logic, Express handlers |
| `servers/sharing/identity.js` | Ed25519 key management, signature verification |
| `servers/sharing/peer-manager.js` | Hyperswarm discovery (direct P2P, no relay) |
| `servers/sharing/sync.js` | Hypercore replication (direct P2P, no relay) |
| `servers/sharing/server.js` | MCP tools including `crow_sharing_status` (relay_enabled toggle) |
