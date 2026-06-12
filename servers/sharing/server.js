/**
 * Crow Sharing Server — Server Factory
 *
 * Creates a configured McpServer with P2P sharing tools.
 * Transport-agnostic: used by both stdio (index.js) and HTTP (gateway).
 *
 * 33 MCP tools registered via tools/ modules:
 *   tools/contacts.js       — crow_generate_invite, crow_accept_invite, crow_list_contacts (#1-3)
 *   tools/share-inbox.js    — crow_share, crow_inbox (#4-5)
 *   tools/messaging.js      — crow_send_message, crow_create_message_group, crow_list_message_groups, crow_send_group_message (#6-9)
 *   tools/sharing-admin.js  — crow_revoke_access, crow_sharing_status (#10-11)
 *   tools/discovery.js      — crow_find_contacts, crow_set_discoverable (#12-13)
 *   tools/instances.js      — crow_discover_relays, crow_add_relay, crow_list_instances, crow_register_instance, crow_update_instance, crow_revoke_instance, crow_list_sync_conflicts (#14-20)
 *   tools/rooms-social.js   — crow_room_invite, crow_room_close, crow_voice_memo, crow_react (#21-24)
 *   tools/identity.js       — crow_identity_attest, crow_identity_verify, crow_identity_revoke, crow_identity_list (#25-28)
 *   tools/crosspost.js      — crow_list_crosspost_transforms, crow_crosspost, crow_crosspost_cancel, crow_crosspost_mark_published, crow_list_crossposts (#29-33)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getSharedManagers } from "./managers.js";
export { getInstanceSyncManager } from "./managers.js";
import { createCloneBundleHelpers } from "./clone-bundle.js";
import { initSharingRuntime } from "./boot.js";
import { registerContactsTools } from "./tools/contacts.js";
import { registerShareInboxTools } from "./tools/share-inbox.js";
import { registerMessagingTools } from "./tools/messaging.js";
import { registerSharingAdminTools } from "./tools/sharing-admin.js";
import { registerDiscoveryTools } from "./tools/discovery.js";
import { registerInstancesTools } from "./tools/instances.js";
import { registerRoomsSocialTools } from "./tools/rooms-social.js";
import { registerIdentityTools } from "./tools/identity.js";
import { registerCrosspostTools } from "./tools/crosspost.js";

import {
  validateRoomToken,
  sendRoomInvite,
  getActiveRooms,
  sendVoiceMemo,
  sendReaction,
} from "./rooms.js";
export { validateRoomToken, sendRoomInvite, getActiveRooms, sendVoiceMemo, sendReaction };

import { sendBotRelay } from "./bot-relay.js";
export { sendBotRelay };

export function createSharingServer(dbPath, options = {}) {
  const managers = getSharedManagers(dbPath);
  const { db, identity, peerManager, syncManager, instanceSyncManager, nostrManager } = managers;

  // Build clone-bundle helpers BEFORE boot wiring so they are available when
  // boot.js's onPeerData handler calls applyProjectCloneBundle.  createCloneBundleHelpers
  // closes over ctx; ctx is mutated post-construction to add the helpers onto it
  // (boot.js receives applyProjectCloneBundle via its helpers param in commit 5).
  const ctx = { db };
  const { buildProjectCloneBundle, applyProjectCloneBundle } = createCloneBundleHelpers(ctx);

  // One-time initialization: start Hyperswarm, join contacts, wire callbacks.
  // managers.initialized is set SYNCHRONOUSLY first (before the async chain in
  // initSharingRuntime) to prevent a second createSharingServer call from
  // entering the block while the first is mid-boot.  The guard check stays at
  // the call site here; initSharingRuntime does not re-check it.
  if (!managers.initialized) {
    managers.initialized = true;
    initSharingRuntime(managers, { applyProjectCloneBundle });
  }

  const server = new McpServer(
    { name: "crow-sharing", version: "0.1.0" },
    options.instructions ? { instructions: options.instructions } : undefined
  );

  // tools/contacts.js — crow_generate_invite, crow_accept_invite, crow_list_contacts (#1-3)
  const fullCtx = { db, identity, peerManager, syncManager, instanceSyncManager, nostrManager, buildProjectCloneBundle, applyProjectCloneBundle };
  registerContactsTools(server, fullCtx);

  // tools/share-inbox.js — crow_share, crow_inbox (#4-5)
  registerShareInboxTools(server, fullCtx);

  // tools/messaging.js — crow_send_message, crow_create_message_group, crow_list_message_groups, crow_send_group_message (#6-9)
  registerMessagingTools(server, fullCtx);

  // tools/sharing-admin.js — crow_revoke_access, crow_sharing_status (#10-11)
  registerSharingAdminTools(server, fullCtx);

  // tools/discovery.js — crow_find_contacts, crow_set_discoverable (#12-13)
  registerDiscoveryTools(server, fullCtx);

  // tools/instances.js — crow_discover_relays, crow_add_relay, crow_list_instances, crow_register_instance, crow_update_instance, crow_revoke_instance, crow_list_sync_conflicts (#14-20)
  registerInstancesTools(server, fullCtx);

  // tools/rooms-social.js — crow_room_invite, crow_room_close, crow_voice_memo, crow_react (#21-24)
  registerRoomsSocialTools(server, fullCtx);

  // --- Prompts ---

  server.prompt(
    "sharing-guide",
    "P2P sharing and messaging workflow — invites, contacts, sharing data, and Nostr messaging",
    async () => {
      const text = `Crow P2P Sharing Guide

1. Getting Started
   - Each Crow instance has a unique Crow ID (Ed25519 + secp256k1 key pair)
   - Check your identity with crow_sharing_status
   - Sharing uses end-to-end encryption — no data passes through central servers

2. Connecting with Peers
   - Generate an invite code with crow_generate_invite (expires in 24 hours)
   - Share the invite code with the other person (via any channel)
   - They accept with crow_accept_invite — both sides see a safety number to verify
   - Verify safety numbers match out-of-band for maximum security

3. Sharing Data
   - Share memories, research projects, sources, or notes with crow_share
   - Specify the contact, item type, and item ID
   - Set permissions: "read" (view only) or "read-write" (can modify)
   - Check incoming shares with crow_inbox

4. Messaging
   - Send encrypted messages with crow_send_message
   - Messages use Nostr protocol with NIP-44 encryption
   - View received messages in crow_inbox

5. Managing Access
   - List all contacts with crow_list_contacts (shows online/offline status)
   - Revoke shared access with crow_revoke_access
   - Sharing is peer-to-peer via Hyperswarm (NAT holepunching for direct connections)`;

      return { messages: [{ role: "user", content: { type: "text", text } }] };
    }
  );

  // tools/identity.js — crow_identity_attest, crow_identity_verify, crow_identity_revoke, crow_identity_list (#25-28)
  registerIdentityTools(server, fullCtx);

  // tools/crosspost.js — crow_list_crosspost_transforms, crow_crosspost, crow_crosspost_cancel, crow_crosspost_mark_published, crow_list_crossposts (#29-33)
  registerCrosspostTools(server, fullCtx);

  return server;
}
