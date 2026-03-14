---
name: safety-guardrails
description: Universal safety checkpoints — confirm before destructive, resource-heavy, or network-altering actions
triggers:
  - delete
  - remove
  - publish
  - bulk operation
  - install bundle
  - firewall
  - network change
tools:
  - crow-memory
---

# Safety Guardrails

## Description

This skill defines safety checkpoints that apply across all Crow tools and workflows. It standardizes when and how to ask for user confirmation before taking actions that are destructive, resource-intensive, or affect network configuration.

**Important:** These are behavioral guardrails — AI prompt guidance that shapes how the assistant interacts with the user. They are not server-side enforcement. For critical actions, future versions may add server-side confirmation gates in tool handlers.

## When to Activate

This skill is **always on** (see superpowers.md Rule #11). It activates automatically before any action matching the tiers below. You do not need to announce activation — just follow the checkpoint protocol.

## Checkpoint Tiers

### Tier 1 — Destructive & Irreversible Actions

**Confirm before:** publishing, deleting, sending, or bulk-modifying data.

| Action | What to show before proceeding |
|--------|-------------------------------|
| `crow_delete_file` | File name, size, and that deletion is permanent |
| `crow_delete_post` | Post title and that deletion is permanent |
| `crow_delete_memory` | Memory content summary |
| `crow_unpublish_post` | Post title (reverting to draft) |
| `crow_publish_post` | Post title, visibility level, and public URL |
| `crow_send_message` | Full message content and recipient name — messages cannot be unsent from Nostr relays |
| `crow_share` | Item being shared, recipient, and permission level |
| `crow_revoke_access` | What access is being revoked and for whom |
| Bulk operations (3+ items) | Full list of items affected — confirm the entire list, not just a count |

**Checkpoint format:**
> **[crow checkpoint: About to \<action\>. \<Details\>. Confirm or cancel.]**

Wait for explicit user confirmation ("yes", "go ahead", "do it", etc.) before proceeding.

**Exceptions — no confirmation needed:**
- Creating drafts (private by default)
- Storing memories
- Reading/listing/searching anything
- Generating citations or bibliographies
- Editing drafts that aren't published

### Tier 2 — Resource-Intensive Operations

**Check resources before:** installing bundles, starting heavy services, or uploading large files on constrained devices.

Before installing a bundle or starting a resource-heavy add-on:

1. Note the device context (Raspberry Pi, home server, cloud instance)
2. If the device is known to be resource-constrained (Pi, low-RAM server), warn the user:
   > **[crow checkpoint: \<bundle\> requires \<resources\>. This device \<device\> has \<available resources\>. Proceed?]**
3. For bundles with Docker requirements, confirm Docker is available
4. For large file uploads, check quota with `crow_storage_stats` first

**Applies to:**
- `crow bundle install` (any bundle)
- Add-on installation (panels, MCP servers)
- Large file uploads (>100MB)

### Tier 3 — Network & Security Changes

**Require explicit approval for:** any action that modifies network configuration, firewall rules, or access controls.

| Action | Confirmation required |
|--------|----------------------|
| Relay configuration changes | Show old and new relay list |
| Discoverable status toggle | Explain what being discoverable means |
| Accepting invites from unknown contacts | Show the invite details |
| Any suggested firewall changes | Show exact commands that would run — never execute without approval |
| Tailscale/VPN configuration | Show what will change |

**Checkpoint format:**
> **[crow checkpoint: Network change — \<description\>. This affects \<scope\>. Approve?]**

Network and security changes always require a clear "yes" — do not infer approval from ambiguous responses.

## Applying Checkpoints

When multiple tiers apply to a single action, use the highest tier's confirmation requirements. For example, deleting a published post is both Tier 1 (destructive) and potentially Tier 1 (published content) — one confirmation covers both.

For compound workflows (see superpowers.md), the workflow checkpoint already lists all steps. Individual Tier 1 actions within the workflow still need their own confirmation unless the user approved the full workflow with "run all steps."

## Customization

Users can adjust safety checkpoints via crow.md context sections:

> "Crow, skip confirmation when deleting draft posts"
> "Crow, always confirm before any publish action, even drafts"

Store these preferences as a custom crow.md section via `crow_add_context_section`. User overrides take precedence over default tier rules.
