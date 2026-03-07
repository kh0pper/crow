# Social & Messaging

Send encrypted messages, have threaded conversations, and interact with your contacts — all powered by the Nostr protocol. No accounts, no central servers, no metadata leaks.

## How It Works

Crow uses the **Nostr protocol** for lightweight social features:

- **End-to-end encrypted** — Messages use NIP-44 encryption (ChaCha20-Poly1305)
- **Sender anonymity** — NIP-59 gift wraps hide who is talking to whom on public relays
- **Always async** — Messages persist on relays until your contact fetches them
- **No accounts** — Your Nostr identity is derived from the same Crow keypair — nothing extra to set up

Heavy data (project sharing, bulk memories) uses Hypercore. Lightweight social interactions (messages, reactions) use Nostr. Both share the same Crow ID.

## Sending Messages

Talk to Crow naturally:

> "Send a message to Alice: Hey, did you see the new paper on transformer architectures?"

Crow encrypts the message for Alice's public key, wraps it for anonymity, and publishes it to your configured Nostr relays. Alice's Crow picks it up next time she's online.

### Message examples

| What you say | What happens |
|---|---|
| "Message Alice: Can you review my thesis draft?" | Sends an encrypted DM |
| "Reply to Alice's last message: Sounds good, let's meet Thursday" | Sends a threaded reply |
| "Send Bob the link to that sourdough memory" | Sends a message with a reference |

## Threaded Conversations

Messages can be threaded for organized discussions:

> "Reply to Alice's message about the conference"

Crow finds Alice's most recent message matching that context and creates a threaded reply. Threads keep conversations organized, especially when discussing multiple topics with the same contact.

### Viewing threads

> "Show me my conversation with Alice"
> "Show the thread about the conference"

The `crow_inbox` tool returns messages grouped by thread, with timestamps and read status.

## Checking Messages

Messages arrive automatically when your Crow instance is running. To see what's new:

> "Check my messages"
> "Any new messages from Bob?"
> "Show unread messages"

The `crow_inbox` tool fetches messages from Nostr relays and returns them alongside any Hypercore shares you've received.

## Nostr Relay Configuration

Crow connects to free public Nostr relays by default:

- `wss://relay.damus.io`
- `wss://nos.lol`
- `wss://relay.nostr.band`

### Adding relays

> "Add wss://relay.example.com as a Nostr relay"

More relays = better message delivery reliability. Messages are published to all configured relays, so your contact only needs to share one relay in common with you.

### Removing relays

> "Remove wss://relay.example.com from my relays"

### Viewing relay status

> "Show my Nostr relay status"

The `crow_sharing_status` tool shows all configured relays, their connection status, and last successful sync time.

## Privacy & Security

### What relays can see

Nostr relays are public infrastructure. Without protections, they could see message metadata (who talks to whom, when). Crow mitigates this:

- **NIP-44 encryption** — Message content is always encrypted. Relays see ciphertext only.
- **NIP-59 gift wraps** — Messages are wrapped in an outer envelope with a random throwaway key. The relay sees the wrapper, not your real identity. Your contact unwraps it to find your actual message inside.

### What relays cannot see

- Message content (encrypted)
- Who sent the message (gift-wrapped)
- Your Crow ID or public keys (hidden by wrapper)

### What relays can see

- That *someone* published *something* at a given time
- The approximate size of the encrypted payload
- The throwaway wrapper key (useless for identification)

### Message persistence

Messages persist on relays until fetched. Most public relays retain messages for days to weeks. For guaranteed delivery:

1. Use multiple relays (redundancy)
2. Keep at least one relay in common with each contact
3. Consider running your own relay for maximum control

## Reactions

Respond to shares and messages with reactions:

> "React to Alice's last message with a thumbs up"

Reactions are lightweight Nostr events — they don't clog your Hypercore feeds.

## Comparison: Nostr vs Hypercore

Crow uses both protocols, each for what it does best:

| Feature | Nostr | Hypercore |
|---|---|---|
| **Use case** | Messages, reactions, social | Projects, memories, bulk data |
| **Delivery** | Via public relays (always async) | Direct P2P (or via peer relay) |
| **Persistence** | Relay-dependent (days to weeks) | Permanent (append-only feeds) |
| **Size limit** | Small payloads (text) | Large payloads (files, datasets) |
| **Identity** | secp256k1 key | Ed25519 key |
| **Both derived from** | Same Crow master seed | Same Crow master seed |

You don't need to think about which protocol to use — Crow chooses automatically based on what you're doing.

## Troubleshooting

### Messages not delivering

1. Check relay status: *"Show my Nostr relay status"*
2. Verify you share at least one relay with your contact
3. Try adding a popular relay: *"Add wss://relay.damus.io as a relay"*

### Can't see messages from a contact

1. Verify the contact is connected: *"Show my contacts"*
2. Check your inbox: *"Check my inbox"*
3. The contact may be using relays you're not connected to

### Message delivery is slow

Public relays are free infrastructure and may occasionally be slow. For faster delivery:

1. Add more relays for redundancy
2. Ask your contact which relays they use and add those
3. Consider a dedicated relay for your group
