# Social Skill — Nostr Messaging

## Description
Send and receive encrypted messages with Crow contacts via the Nostr protocol. All messages use NIP-44 encryption (ChaCha20-Poly1305) for end-to-end privacy. Messages are relayed through public Nostr relays — the relay operators cannot read message content.

## When to Use
- When the user mentions "message", "chat", "DM", or "send a message to"
- When checking for new messages from contacts
- When the user asks about unread messages
- When discussing Nostr-specific topics like relays

## Tools Available
- **crow_send_message** — Send an encrypted message to a contact
- **crow_inbox** — Check received messages (also shows shares)
- **crow_list_contacts** — See contacts and their online status
- **crow_sharing_status** — Check relay connections and Crow ID

## Workflow: Send a Message
1. User says "message \<contact\>" or "tell \<contact\> that..."
2. Call `crow_list_contacts` to find the contact
3. Call `crow_send_message` with the contact's Crow ID and message content
4. Report delivery status (which relays accepted the message)
5. *[crow: message sent to \<contact\> via \<N\> relays]*

## Workflow: Check Messages
1. User says "any messages?", "check messages", or "what did \<contact\> say?"
2. Call `crow_inbox` to fetch recent messages
3. Present messages grouped by contact with timestamps
4. Mark messages as read after presenting them

## Workflow: Conversation
1. When the user wants an ongoing conversation with a contact
2. Call `crow_inbox` to show recent message history
3. For each user reply, call `crow_send_message`
4. Store important conversation points in memory with `crow_store_memory`

## Nostr Relays
Messages are sent through Nostr relays. Default relays:
- `wss://relay.damus.io`
- `wss://nos.lol`
- `wss://relay.nostr.band`

Custom relays can be configured via `crow_sharing_status`.

## Safety

Sending messages is irreversible (Nostr relays cannot unsend). See `skills/safety-guardrails.md` Tier 1 for the confirmation protocol.

## Best Practices
- Messages are cached locally for offline access
- Nostr uses secp256k1 keys (separate from Ed25519 sharing keys)
- Both parties must have accepted an invite before messaging works
- Store important messages in memory for cross-session retrieval
- Messages sent to offline contacts are stored on relays until fetched
