# Sharing

Share memories, projects, and notes securely with other Crow users. Everything is end-to-end encrypted — no central server sees your data.

## Prerequisites

- Crow installed and set up (`npm run setup`)
- Your Crow ID (displayed during setup, or run `npm run identity`)

## Your Crow ID

Every Crow installation has a unique identity, generated during setup:

```
Your Crow ID: crow:k3x7f9m2q4
```

This is your public identifier — share it with friends so they can connect with you. It's derived from your cryptographic public key and cannot be changed (but you can rotate keys if compromised).

To view your Crow ID at any time:

```bash
npm run identity
```

Or ask Crow: *"What's my Crow ID?"* — the `crow_sharing_status` tool will show it.

## Connecting with Friends

Sharing requires a one-time connection handshake between two Crow users.

### Step 1: Generate an invite

Ask Crow to create an invite:

> "Generate an invite code for my friend Alice"

Crow creates a code like `AXFK-9M2Q-T4PL-V8KN` that contains your public keys.

### Step 2: Send the invite

Send the code to your friend through any channel — text message, email, QR code, Signal, etc. The code itself doesn't contain sensitive data, just your public keys.

### Step 3: Your friend accepts

Your friend tells their Crow:

> "Accept invite AXFK-9M2Q-T4PL-V8KN from Bob"

### Step 4: Verify the safety number

After connecting, both sides see a **safety number** — a short hash derived from both public keys. Compare this out-of-band (e.g., in person or via a trusted channel) to confirm no one intercepted the handshake:

```
Safety number: 4829-7153-0926
```

If both sides see the same number, you're securely connected.

## Sharing Memories

Once connected, sharing is simple:

> "Share my sourdough memory with Alice"

Crow looks up the memory, encrypts it for Alice's public key, and queues it for delivery. If Alice is online, it delivers immediately via Hyperswarm. If she's offline, it delivers next time both peers are online.

### Share types

| What you say | What happens |
|---|---|
| "Share my sourdough memory with Alice" | Sends a single memory |
| "Share my thesis project with Bob, read-only" | Grants ongoing read access to a project |
| "Share source 3 from my thesis with Alice" | Sends a single project source |
| "Share the meeting notes with Bob" | Sends a single note |

### Permission levels

- **Read** — Recipient can view but not modify (default)
- **Read-write** — Recipient can add to a shared project (sources, notes)
- **One-time** — Data delivered once, then removed from the sync feed

## Sharing Projects

Project sharing is more powerful than single-item sharing. When you share a project:

1. All sources, notes, and bibliography are included
2. The share stays in sync — new items you add appear for your collaborator
3. With **read-write** access, collaborators can add their own sources and notes

> "Share my thesis project with Alice, read-write"

Alice's Crow will notify her:

> "Bob shared the project 'Thesis Research' with you (read-write access)"

Changes sync automatically whenever both peers are online.

## Checking Your Inbox

Ask Crow to check for received shares and messages:

> "Check my inbox"

Or be more specific:

> "Do I have any unread shares?"
> "Show me messages from Alice"

The `crow_inbox` tool returns all pending shares and messages, with timestamps and read status.

## Managing Permissions

### Revoking access

> "Revoke Alice's access to my thesis project"

This stops syncing the project feed. Alice keeps her local copy of what was already shared, but won't receive future updates.

### Viewing active shares

> "What am I sharing with Bob?"

Shows all active shares with permissions and status.

## Relay Configuration

If you and a contact are rarely online at the same time, data sharing can be slow. Peer relays solve this.

### Using a relay

If a friend runs a cloud-deployed Crow gateway, they can act as a relay:

> "Add Alice's gateway as a trusted relay: https://alice-crow-server"

The relay stores encrypted data (it can't read your content) and forwards it when your contact connects.

### Becoming a relay

If your Crow gateway is cloud-deployed (always online), you can volunteer as a relay for your contacts:

> "Enable relay mode for my gateway"

This is opt-in and only serves your existing contacts.

## Device Migration

Moving Crow to a new device? Export your identity:

```bash
# On the old device:
npm run identity:export
# Saves encrypted archive to data/identity-export.enc

# On the new device:
npm run identity:import
# Prompts for passphrase, restores identity
```

Your Crow ID stays the same. Contacts don't need to re-connect.

## Security Notes

- All shares are **end-to-end encrypted** — only the intended recipient can read them
- Your identity seed is encrypted at rest with your passphrase
- Invite codes expire after 24 hours and are single-use
- Safety numbers let you verify connections weren't intercepted
- Relays only see encrypted blobs — they cannot read your data
- You can block contacts at any time to stop all communication
