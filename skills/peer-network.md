# Peer Network Skill — Peer & Relay Management

## Description
Manage your Crow peer network: view and manage contacts, configure relays, check identity information, block/unblock peers, and handle device migration. This skill covers the administrative side of Crow's P2P layer.

## When to Use
- When the user asks about their Crow ID or identity
- When managing contacts (blocking, removing, viewing details)
- When configuring relay servers
- When exporting/importing identity for device migration
- When checking network status or connectivity

## Tools Available
- **crow_sharing_status** — Show Crow ID, connected peers, relay status
- **crow_list_contacts** — List all contacts with status details
- **crow_generate_invite** — Create invite codes
- **crow_accept_invite** — Accept incoming invites
- **crow_revoke_access** — Revoke shared item access

## Workflow: Check Identity & Status
1. User says "what's my Crow ID?", "who am I?", or "network status"
2. Call `crow_sharing_status`
3. Display: Crow ID, number of contacts, connected peers, relay status
4. *[crow: identity — \<crowId\>, \<N\> contacts, \<M\> online]*

## Workflow: Manage Contacts
1. User says "list contacts", "who's online", or "show my peers"
2. Call `crow_list_contacts`
3. Display contacts with: display name, Crow ID, online/offline, last seen
4. For blocked contacts, indicate blocked status

## Workflow: Block/Unblock
1. User says "block \<contact\>" or "unblock \<contact\>"
2. Identify the contact from `crow_list_contacts`
3. Blocking prevents data sync and message delivery
4. Confirm the action to the user

## Workflow: Device Migration
1. User says "export identity", "move to new device", or "backup keys"
2. Guide the user through identity export:
   - Run `npm run identity:export` on the source device
   - Securely transfer the encrypted export file
   - Run `npm run identity:import` on the new device
3. Warn: "Your identity contains private keys. Only transfer over trusted channels."

## Workflow: Relay Configuration
1. User asks about relay setup or wants to add/remove relays
2. Show current relay configuration via `crow_sharing_status`
3. Explain relay types:
   - **Nostr relays** — Public message relays (free, community-operated)
   - **Peer relays** — Optional store-and-forward for offline peer delivery
4. Guide configuration changes

## Safety Numbers
When a new contact is added, a safety number is computed from both parties' public keys. Users should verify this number through an independent channel (in person, phone call) to confirm they're connected to the right person.

## Best Practices
- Regularly check `crow_sharing_status` for connectivity health
- Back up your identity before device changes
- Verify safety numbers with new contacts
- Block contacts who are no longer trusted
- Peer relays are opt-in and only store encrypted blobs
