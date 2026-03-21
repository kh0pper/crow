---
title: Contacts
---

# Contacts

Manage your contacts in Crow — both Crow peers (connected via invite codes) and manual contacts you add yourself.

## Overview

The Contacts panel in the Crow's Nest is your address book. It stores two types of contacts:

- **Crow peers** — Other Crow users you've connected with via invite codes. These contacts have cryptographic identities and can exchange messages, share memories, and sync data.
- **Manual contacts** — People you add by hand. These are standard address book entries without Crow connectivity.

## Adding contacts

### Crow peers (via invite code)

To connect with another Crow user:

1. One person generates an invite code:
   > "Crow, generate an invite code"
2. Share the code with the other person (text, email, etc.)
3. The other person accepts the invite:
   > "Crow, accept invite code ABC123"

Once accepted, both parties appear in each other's Contacts panel with full Crow connectivity.

You can also generate and accept invites from the **Contacts** panel in the Crow's Nest.

### Manual contacts

Add a contact without a Crow connection:

- From the **Contacts** panel, click **Add Contact** and fill in the details
- Or ask your AI:
  > "Crow, add a contact for Maria Lopez — email maria@example.com, phone 555-1234"

Manual contacts are stored locally and do not require the other person to use Crow.

## Contact profiles

Each contact has a profile page with:

- **Display name** and avatar
- **Contact details** — email, phone, notes
- **Activity history** — shared items, messages exchanged (Crow peers only)
- **Notes** — free-form notes you add about the contact
- **Status** — online/offline and last seen (Crow peers only)

To view a contact profile, click their name in the Contacts panel or ask:

> "Crow, show me the contact profile for Maria"

## Groups

Organize contacts into groups for easier filtering and bulk operations.

### Creating a group

> "Crow, create a contact group called 'Research Team'"

Or from the Contacts panel, click **Groups** > **New Group**.

### Assigning contacts to groups

> "Crow, add Maria and Carlos to the Research Team group"

You can also drag contacts into groups from the Contacts panel.

### Filtering by group

Use the group filter in the Contacts panel to view only contacts in a specific group. Groups also work with sharing — you can share items with an entire group at once.

## Your profile

Your own profile is what other Crow peers see when they connect with you.

### Editing your profile

From **Crow's Nest** > **Settings** > **Identity**, you can update:

- **Display name** — the name shown to your peers
- **Avatar** — upload a profile image
- **Bio** — a short description visible to contacts

Or ask your AI:

> "Crow, update my display name to 'Kevin H.'"

## Import and export

### Importing contacts

Crow supports importing contacts from standard formats:

- **vCard (.vcf)** — drag a `.vcf` file onto the Contacts panel, or use the import button
- **CSV** — import a spreadsheet with columns for name, email, phone, etc.

> "Crow, import contacts from my contacts.vcf file"

### Exporting contacts

Export your contacts for backup or use in other apps:

- **vCard (.vcf)** — standard format compatible with most address books
- Export from the Contacts panel via **Export** or ask:

> "Crow, export all my contacts as a vCard file"

::: tip
Crow peer contacts include their Crow ID and public keys in the export. Manual contacts export as standard vCard entries.
:::
