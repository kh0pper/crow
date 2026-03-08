# Onboarding Skill — First-Run Sharing Setup

## Description
Guide new users through setting up Crow's P2P sharing layer for the first time. Handles identity generation, first contact invitation, and basic orientation to sharing and messaging features.

## When to Use
- On first session when sharing features are requested but no identity exists
- When user explicitly asks to "set up sharing" or "get started with P2P"
- When `crow_sharing_status` returns no identity
- When migrating to a new device

## Workflow: First-Time Setup
1. Detect that no identity exists (via `crow_sharing_status`)
2. Explain what Crow sharing provides:
   - "Crow's sharing layer lets you securely share memories, research, and messages with trusted contacts."
   - "Everything is end-to-end encrypted. No central server can read your data."
3. Generate identity automatically (happens on first tool call)
4. Display the user's new Crow ID
5. Store the setup event in memory: `crow_store_memory` with tag "setup"
6. Offer next steps:
   - "Would you like to invite someone to connect?"
   - "You can also explore your sharing status anytime."

## Workflow: First Contact
1. After identity setup, user wants to connect with someone
2. Call `crow_generate_invite` to create an invite code
3. Explain how to share the code:
   - "Give this code to your contact through a trusted channel — in person, encrypted chat, or phone."
   - "They'll use `crow_accept_invite` on their Crow instance."
4. Explain safety numbers:
   - "After connecting, you'll both see a safety number. Verify it matches to confirm the connection is secure."

## Workflow: Device Migration
1. User says "I'm on a new device" or "import my identity"
2. Guide through import:
   - "On your old device, run `npm run identity:export`"
   - "Transfer the encrypted file to this device"
   - "Then run `npm run identity:import` here"
3. After import, verify identity with `crow_sharing_status`
4. Existing contacts will reconnect automatically via Hyperswarm

## Workflow: Orientation Tour
1. User says "how does sharing work?" or "explain P2P"
2. Provide a concise overview:
   - **Identity** — Your Crow ID is your unique address, derived from cryptographic keys
   - **Contacts** — Add trusted peers via invite codes with safety number verification
   - **Sharing** — Send memories, projects, sources, and notes to contacts
   - **Messaging** — Encrypted chat via Nostr protocol
   - **Offline** — Data syncs automatically when both peers are online
3. Point to relevant skills: `sharing.md`, `social.md`, `peer-network.md`

## Best Practices
- Identity generation is automatic on first sharing tool use
- The passphrase for identity encryption is optional but recommended
- Store the Crow ID in memory for easy reference across sessions
- First-time setup should feel welcoming, not overwhelming — introduce features gradually
