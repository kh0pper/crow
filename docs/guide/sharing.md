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

## Identity Backup and Device Migration

Your identity is the master seed behind your Crow ID, contacts, and shared data — if the machine dies without a backup, contacts have to re-connect from scratch. There are two ways to make a backup, and both produce the same passphrase-encrypted format:

**From the dashboard:** the first-run wizard's final step (replayable from Settings → Help & Setup → "Download identity backup") has a backup form. Choose a passphrase (minimum 12 characters), confirm it, and the browser downloads `crow-identity-backup.json`.

**From the CLI:**

```bash
# On the old device — prompts for a passphrase, prints a base64 blob:
npm run identity:export
# (non-interactive: npm run identity:export -- -- --passphrase <passphrase>)

# On the new device — prompts for the same passphrase:
npm run identity:import -- <base64-blob>
# (a downloaded crow-identity-backup.json imports the same way:
#  npm run identity:import -- "$(base64 -w0 crow-identity-backup.json)")
```

The backup keeps your Crow ID and public keys in the clear (so the file is identifiable), but the seed itself is encrypted with scrypt (N=16384, r=8, p=1) + AES-256-GCM under your passphrase — the plaintext seed never appears in the file. Without the passphrase the backup cannot be restored, so store both safely.

Restoring **decrypts the backup and writes a plaintext-seed `identity.json`** — the file encryption protects the download, not the disk; the gateway can only boot from a plaintext seed. The import refuses to overwrite an existing `identity.json`. There is deliberately no dashboard restore flow: re-keying a running instance has sync and pairing implications, so restore is a CLI-on-a-fresh-install operation.

Your Crow ID stays the same after a restore. Contacts don't need to re-connect.

## Security Notes

- All shares are **end-to-end encrypted** — only the intended recipient can read them
- Identity **backups** are passphrase-encrypted (scrypt + AES-256-GCM); the on-disk `identity.json` keeps a plaintext seed so the gateway can boot unattended — protect the machine, and keep an encrypted backup
- Invite codes expire after 24 hours and are single-use
- Safety numbers let you verify connections weren't intercepted
- Relays only see encrypted blobs — they cannot read your data
- You can block contacts at any time to stop all communication

## Under the Hood

For the protocol details — identity keys, Hypercore feeds, Nostr encryption, relays — see the [Sharing Server architecture](/architecture/sharing-server).
