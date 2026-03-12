# Sharing Skill — P2P Data Sharing

## Description
Share memories, research projects, sources, and notes with trusted contacts via Crow's peer-to-peer sharing layer. All data is end-to-end encrypted using Ed25519 signatures and NaCl box encryption. Sharing works directly between peers over Hyperswarm — no central server required.

## When to Use
- When the user mentions "share", "send to", "give access", or names a contact
- When the user wants to invite someone to connect ("add contact", "invite")
- When checking received shares ("inbox", "what did they send")
- When revoking access to shared content

## Tools Available
The crow-sharing MCP server provides:
- **crow_generate_invite** — Create an invite code for a new contact
- **crow_accept_invite** — Accept an invite and establish a P2P connection
- **crow_list_contacts** — List peers with online/offline status
- **crow_share** — Share a memory, project, source, or note with a contact
- **crow_inbox** — List received shares and messages
- **crow_revoke_access** — Revoke a previously shared item

## Workflow: Invite a Contact
1. User says "invite someone" or "add a contact"
2. Call `crow_generate_invite` to create an invite code
3. Display the invite code and safety instructions:
   - "Share this code with your contact via a trusted channel (in person, encrypted chat)"
   - "The code expires in 24 hours and can only be used once"
4. When the contact accepts, a safety number is computed for verification
5. Store the contact relationship in memory with `crow_store_memory`

## Workflow: Share Content
1. User says "share this with \<contact\>" or "send \<item\> to \<contact\>"
2. Identify the item to share:
   - Memory: use the memory ID from `crow_search_memories`
   - Project: use the project ID from `crow_list_projects`
   - Source: use the source ID from `crow_list_sources`
   - Note: use the note ID from a project
3. Call `crow_list_contacts` to find the contact
4. Call `crow_share` with the item type, ID, contact, and permissions
5. Confirm delivery status to the user
6. *[crow: shared \<type\> "\<title\>" with \<contact\> — \<status\>]*

## Workflow: Check Inbox
1. User says "check inbox", "what did they share", or "any new shares"
2. Call `crow_inbox` to list received items and messages
3. Present shares grouped by contact with timestamps
4. For each share, offer to view the content or store it locally

## Workflow: Revoke Access
1. User says "revoke", "unshare", or "remove access"
2. Call `crow_inbox` or `crow_list_contacts` to identify the share
3. Call `crow_revoke_access` with the share ID
4. Confirm revocation to the user

## Permissions
- **read** — Contact can view the content (default)
- **read-write** — Contact can view and modify
- **one-time** — Content is viewable once, then auto-revoked

## Safety Confirmations

- Before calling `crow_share`: Preview what will be shared — show the item title/name, permission level (read/read-write/one-time), and recipient name. For read-write permissions, explicitly warn that the recipient will be able to modify the shared content.
- Before calling `crow_revoke_access`: Confirm the contact name and what access is being revoked. Warn that the peer's local copy won't be deleted but sync will stop.

## Best Practices
- Always verify the safety number when connecting with a new contact
- Use "one-time" permissions for sensitive content
- Check `crow_sharing_status` to verify your Crow ID and connection status
- Store important sharing events in memory for cross-session context
