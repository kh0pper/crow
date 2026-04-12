---
name: matrix-dendrite
description: Matrix homeserver on Dendrite — federated real-time chat with E2EE. Rooms, messages, sync, federation health.
triggers:
  - "matrix"
  - "dendrite"
  - "matrix room"
  - "#room:server"
  - "@user:server"
  - "join matrix"
  - "send matrix message"
  - "e2ee chat"
tools:
  - matrix_status
  - matrix_joined_rooms
  - matrix_create_room
  - matrix_join_room
  - matrix_leave_room
  - matrix_send_message
  - matrix_room_messages
  - matrix_sync
  - matrix_invite_user
  - matrix_register_appservice
  - matrix_federation_health
---

# Matrix on Dendrite — federated real-time chat

Dendrite is a lightweight Go-based Matrix homeserver (vs. Synapse's Python). It speaks the full Matrix v3 client-server API and federates over the Matrix graph. This bundle runs Dendrite + Postgres in two containers on the shared `crow-federation` network.

## Hardware

Gated by F.0's hardware check. Refused on hosts with less than **2 GB effective RAM after committed bundles + 512 MB host reserve**. Recommended 4 GB+; Pi class (4-8 GB total) will get warnings unless you're the only federated bundle installed. Disk grows fast under federated joins — plan for 100 GB+ if you join any major room (Matrix HQ alone is tens of GB of state).

## The federation port decision — pick one

Matrix federation happens on port **8448/tcp**. You have two mutually-exclusive ways to satisfy this:

### Option A: open :8448 on the router

```
caddy_add_matrix_federation_port {
  "domain": "matrix.example.com",
  "upstream_8448": "dendrite:8448"
}
```

Caddy requests a second Let's Encrypt cert for `matrix.example.com:8448` and reverse-proxies into Dendrite. Requires your router/firewall forward 8448/tcp to this host.

### Option B: apex `.well-known/matrix/server` delegation

```
caddy_set_wellknown {
  "domain": "example.com",
  "kind": "matrix-server",
  "opts": { "delegate_to": "matrix.example.com:443" }
}
```

This publishes `/.well-known/matrix/server` on the apex declaring that Matrix federation for `@user:example.com` lives at `matrix.example.com:443`. No :8448 needed — federation rides HTTPS on 443.

**Either works. Not both.** `caddy_add_matrix_federation_port` refuses to run when the same domain already has matrix-server delegation — the F.0 tool enforces this.

Pair whichever path you chose with the client-server proxy:

```
caddy_add_federation_site {
  "domain": "matrix.example.com",
  "upstream": "dendrite:8008",
  "profile": "matrix"
}
```

Verify the whole setup end-to-end with:

```
matrix_federation_health { "server_name": "example.com" }
```

This calls the public Matrix Federation Tester and returns its structured verdict.

## First-run bootstrap

The entrypoint generates a signing key and `dendrite.yaml` on first boot, then prints the registration shared secret to the container log:

```
Registration shared secret: <48-char base64>
```

1. Copy that secret into `.env` as `MATRIX_REGISTRATION_SHARED_SECRET`.
2. Register the admin account:
   ```bash
   docker exec crow-dendrite \
     create-account --config /etc/dendrite/dendrite.yaml \
       --username admin --password '<strong-password>' --admin
   ```
3. Log in to get a client-server access token:
   ```bash
   curl -X POST https://matrix.example.com/_matrix/client/v3/login \
     -H 'Content-Type: application/json' \
     -d '{"type":"m.login.password","user":"admin","password":"<pw>"}'
   ```
4. Paste `access_token` and `user_id` into `.env` as `MATRIX_ACCESS_TOKEN` and `MATRIX_USER_ID`, then restart the MCP server.

## Common workflows

### Create a room

```
matrix_create_room {
  "name": "Project Crow",
  "topic": "Development chat",
  "visibility": "private",
  "preset": "private_chat",
  "invite": ["@alice:matrix.org"]
}
```

### Join a federated room

```
matrix_join_room { "room": "#matrix:matrix.org" }
```

First federation join against a given remote server can take 10+ seconds while Dendrite fetches the room state. Subsequent joins to rooms on that server are fast.

### Send a message

```
matrix_send_message {
  "room": "#crow-dev:example.com",
  "body": "hello, matrix"
}
```

For HTML / formatted messages add `formatted_body` (HTML) alongside `body` (fallback plaintext).

### Read recent history

```
matrix_room_messages { "room": "#crow-dev:example.com", "limit": 20 }
```

Paginate back further by passing the returned `next_from` as the next call's `from`.

### One-shot sync (poll, not stream)

```
matrix_sync {}               # initial (heavy — use sparingly)
matrix_sync { "since": "s42_15_0_1" }   # delta
```

Matrix has a long-polling sync endpoint; `matrix_sync` returns a compact summary (joined-room deltas + invite count + `next_batch`) rather than the full tree. For a real streaming feed use the panel's SSE bridge.

## Encryption

Dendrite supports E2EE, but key material lives in each client (your Element / Fluffychat / etc.). The Crow MCP server does NOT handle encryption keys — it posts plaintext events. For encrypted rooms, you need a dedicated Matrix client with device keys; use Dendrite as the homeserver but let Element handle the ciphertext. Posting an MCP message to an E2EE room will send plaintext (visible only to you on your devices; other members will see an unencrypted event).

## Moderation

Matrix moderation is room-scoped (not instance-scoped like Mastodon/GoToSocial). Admins can ban users from specific rooms via Matrix's standard membership events. Instance-wide federation blocklists (server ACLs) are a room-level feature — ban a remote server from a specific room via `m.room.server_acl` state events.

This bundle does not yet expose moderation verbs; room bans + server ACLs land in a follow-up once the full moderation taxonomy is exercised. For now, use a Matrix client (Element) for moderation actions.

## F.12 appservice prep

`matrix_register_appservice` produces a YAML registration file + write-it-into-dendrite instructions. This is the entry point the F.12.1 matrix-bridges meta-bundle uses to install mautrix-signal / mautrix-telegram / mautrix-whatsapp. You won't typically invoke this directly — install a bridge, and the bridge's post-install calls this tool then restarts Dendrite for you.

## Troubleshooting

- **"Matrix request timed out"** — Dendrite is often slow on first boot (DB migrations + key bootstrap). First-run healthcheck has a 60s grace period. If the timeout persists, check `docker logs crow-dendrite` for signing-key errors.
- **Federation tester says "No address found"** — neither `.well-known/matrix/server` nor `:8448` reachable. Run `matrix_federation_health` again after DNS propagates; give it 2–3 minutes.
- **"Cert for :8448 is staging"** — the F.0 `caddy_cert_health` surfaces this. Matrix peers reject staging certs; wait for real cert issuance.
- **Disk growing fast after joining Matrix HQ** — expected. Matrix backfills room state + media aggressively. Consider unjoining large rooms or purging media via Dendrite admin API (not yet wired as an MCP tool).
