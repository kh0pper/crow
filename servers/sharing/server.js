/**
 * Crow Sharing Server — Server Factory
 *
 * Creates a configured McpServer with P2P sharing tools.
 * Transport-agnostic: used by both stdio (index.js) and HTTP (gateway).
 *
 * 17 MCP tools:
 *   crow_generate_invite    — Create invite code with 24h expiry
 *   crow_accept_invite      — Accept invite, handshake, show safety number
 *   crow_list_contacts      — List peers with online/offline status
 *   crow_share              — Share memory/project/source/note to a contact
 *   crow_inbox              — List received shares and messages
 *   crow_send_message       — Send encrypted Nostr message
 *   crow_revoke_access      — Revoke shared project access
 *   crow_sharing_status     — Show Crow ID, peer count, relay status
 *   crow_find_contacts      — Find Crow users by email hash (privacy-preserving)
 *   crow_set_discoverable   — Opt in/out of contact discovery
 *   crow_discover_relays    — List configured relays
 *   crow_add_relay          — Add a Nostr or peer relay
 *   crow_list_instances     — List registered Crow instances
 *   crow_register_instance  — Register a Crow instance
 *   crow_update_instance    — Update instance details
 *   crow_revoke_instance    — Revoke an instance (device compromise, decommission)
 *   crow_list_sync_conflicts — List and review sync conflicts between instances
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createHash, randomBytes } from "node:crypto";
import { generateToken, validateToken, shouldSkipGates } from "../shared/confirm.js";
import { isKioskActive, kioskBlockedResponse } from "../shared/kiosk-guard.js";
import {
  loadOrCreateIdentity,
  generateInviteCode,
  parseInviteCode,
  computeSafetyNumber,
} from "./identity.js";
import {
  canonicalPayload as canonicalAttestationPayload,
  signAttestation,
  verifyAttestation,
  verifyCrowIdBinding,
  signRevocation,
  verifyRevocation,
  SUPPORTED_APPS as ATTESTATION_APPS,
} from "../shared/identity-attestation.js";
import { transform as crosspostTransform, SUPPORTED_PAIRS as CROSSPOST_PAIRS } from "../gateway/crossposting/transforms.js";
import { createNotification } from "../shared/notifications.js";
import { getOrCreateLocalInstanceId } from "../gateway/instance-registry.js";
import {
  AclError,
  ROLES,
  assertLocalCapability,
  appendAudit,
} from "../shared/project-acl.js";
import { slugify, workspacePathFor, storagePrefixFor } from "../shared/slugify.js";
import { createProjectSpace } from "../shared/project-spaces.js";
import { mkdirSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { createDbClient, resolveDataDir } from "../db.js";
import { getSharedManagers, getManagersOrNull } from "./managers.js";
export { getInstanceSyncManager } from "./managers.js";
import { createCloneBundleHelpers } from "./clone-bundle.js";
import { initSharingRuntime } from "./boot.js";
import { registerContactsTools } from "./tools/contacts.js";
import { registerShareInboxTools } from "./tools/share-inbox.js";
import { registerMessagingTools } from "./tools/messaging.js";

import {
  _activeRooms,
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

  // --- Tool: crow_revoke_access ---

  server.tool(
    "crow_revoke_access",
    "Revoke a previously shared item or project from a contact. Stops ongoing sync for shared projects. Returns a preview and confirmation token on first call; pass the token back to execute.",
    {
      contact: z.string().max(500).describe("Crow ID or display name of the contact"),
      share_type: z.enum(["memory", "project", "source", "note", "kb_article"]).describe("Type of shared item"),
      item_id: z.number().describe("ID of the shared item to revoke"),
      confirm_token: z.string().max(100).describe('Confirmation token — pass "" on first call to get a preview, then pass the returned token to execute'),
    },
    async ({ contact, share_type, item_id, confirm_token }) => {
      const result = await db.execute({
        sql: "SELECT * FROM contacts WHERE crow_id = ? OR display_name = ?",
        args: [contact, contact],
      });

      if (result.rows.length === 0) {
        return {
          content: [{ type: "text", text: `Contact not found: ${contact}` }],
          isError: true,
        };
      }

      const contactRow = result.rows[0];

      // Check if a matching share exists
      const shareCheck = await db.execute({
        sql: `SELECT id FROM shared_items
              WHERE contact_id = ? AND share_type = ? AND item_id = ? AND direction = 'sent'`,
        args: [contactRow.id, share_type, item_id],
      });

      if (shareCheck.rows.length === 0) {
        return {
          content: [{ type: "text", text: `No matching share found to revoke.` }],
        };
      }

      // Confirmation gate
      const tokenKey = `revoke_${share_type}_${item_id}_${contactRow.id}`;
      if (!shouldSkipGates()) {
        if (confirm_token) {
          if (!validateToken(confirm_token, "revoke_access", tokenKey)) {
            return { content: [{ type: "text", text: "Invalid or expired confirmation token. Pass confirm_token: \"\" to get a new preview." }], isError: true };
          }
        } else {
          const token = generateToken("revoke_access", tokenKey);
          return {
            content: [{
              type: "text",
              text: `⚠️ This will revoke access:\n  ${share_type} #${item_id}\n  From: ${contactRow.display_name || contactRow.crow_id}\n\nTo proceed, call again with confirm_token: "${token}"`,
            }],
          };
        }
      }

      await db.execute({
        sql: `DELETE FROM shared_items
              WHERE contact_id = ? AND share_type = ? AND item_id = ? AND direction = 'sent'`,
        args: [contactRow.id, share_type, item_id],
      });

      // M4: project shares also soft-revoke any matching project_members row
      // (mode='clone' or 'subscription'). The recipient's local copy persists
      // — clone semantics. Append an audit entry on the origin so the project
      // timeline reflects the revocation.
      if (share_type === "project") {
        try {
          await db.execute({
            sql: `UPDATE project_members
                     SET revoked_at = datetime('now')
                   WHERE project_id = ? AND contact_id = ?
                     AND mode IN ('clone','subscription') AND revoked_at IS NULL`,
            args: [item_id, contactRow.id],
          });
          await appendAudit(db, {
            project_id: item_id, actor_type: "local",
            action: "share.revoke",
            target: `contact:${contactRow.id}`,
            payload: { recipient_crow_id: contactRow.crow_id },
          });
        } catch (revokeErr) {
          console.warn(`[sharing] project_members revoke / audit failed: ${revokeErr.message}`);
        }
      }

      // Send revocation notice via data channel
      if (peerManager.isConnected(contactRow.crow_id)) {
        try {
          peerManager.send(contactRow.crow_id, {
            type: "revoke",
            share_type,
            item_id,
            sender: identity.crowId,
            timestamp: new Date().toISOString(),
          });
        } catch {
          // Best effort
        }
      }

      return {
        content: [
          {
            type: "text",
            text: `Revoked ${share_type} #${item_id} from ${contactRow.display_name || contactRow.crow_id}.`,
          },
        ],
      };
    }
  );

  // --- Tool: crow_sharing_status ---

  server.tool(
    "crow_sharing_status",
    "Show your Crow identity, connected peers, relay status, and sharing statistics.",
    {},
    async () => {
      const contactCount = await db.execute({
        sql: "SELECT COUNT(*) as count FROM contacts WHERE is_blocked = 0",
        args: [],
      });

      const shareCount = await db.execute({
        sql: "SELECT direction, COUNT(*) as count FROM shared_items GROUP BY direction",
        args: [],
      });

      const unreadMsgs = await db.execute({
        sql: "SELECT COUNT(*) as count FROM messages WHERE is_read = 0 AND direction = 'received'",
        args: [],
      });

      const relays = await db.execute({
        sql: "SELECT * FROM relay_config WHERE enabled = 1",
        args: [],
      });

      const connectedPeers = peerManager.getConnectedPeers();

      const sent = shareCount.rows.find((r) => r.direction === "sent")?.count || 0;
      const received = shareCount.rows.find((r) => r.direction === "received")?.count || 0;

      const parts = [
        `Crow Sharing Status`,
        ``,
        `Identity:`,
        `  Crow ID: ${identity.crowId}`,
        `  Ed25519: ${identity.ed25519Pubkey.slice(0, 16)}...`,
        `  secp256k1: ${identity.secp256k1Pubkey.slice(0, 16)}...`,
        ``,
        `Network:`,
        `  Contacts: ${contactCount.rows[0]?.count || 0}`,
        `  Online peers: ${connectedPeers.length}`,
        `  Connected relays: ${nostrManager.relays.size}`,
        ``,
        `Sharing:`,
        `  Sent: ${sent}`,
        `  Received: ${received}`,
        `  Unread messages: ${unreadMsgs.rows[0]?.count || 0}`,
      ];

      if (relays.rows.length > 0) {
        parts.push("");
        parts.push("Configured relays:");
        for (const r of relays.rows) {
          parts.push(`  ${r.relay_url} (${r.relay_type})`);
        }
      }

      return {
        content: [{ type: "text", text: parts.join("\n") }],
      };
    }
  );

  // --- Tool: crow_find_contacts ---

  server.tool(
    "crow_find_contacts",
    "Search for Crow users by email hash. Privacy-preserving: only SHA-256 hashes are compared, never plain text emails. Users must opt in to discovery by setting their email hash.",
    {
      email: z.string().max(500).describe("Email address to search for (will be hashed locally, never sent in plain text)"),
    },
    async ({ email }) => {
      // Hash the email locally
      const normalized = email.trim().toLowerCase();
      const emailHash = createHash("sha256").update(normalized).digest("hex");

      // Check local contacts first
      const localMatch = await db.execute({
        sql: "SELECT crow_id, display_name, email_hash FROM contacts WHERE email_hash = ? AND is_blocked = 0",
        args: [emailHash],
      });

      if (localMatch.rows.length > 0) {
        const c = localMatch.rows[0];
        return {
          content: [{
            type: "text",
            text: `Found existing contact: ${c.display_name || c.crow_id} (${c.crow_id})`,
          }],
        };
      }

      // Check configured peer relays for discovery
      const relays = await db.execute({
        sql: "SELECT relay_url FROM relay_config WHERE relay_type = 'peer' AND enabled = 1",
        args: [],
      });

      const found = [];
      for (const relay of relays.rows) {
        try {
          const url = new URL("/discover/find", relay.relay_url);
          url.searchParams.set("hash", emailHash);
          const resp = await fetch(url.toString(), { signal: AbortSignal.timeout(5000) });
          if (resp.ok) {
            const data = await resp.json();
            if (data.found && data.crow_id) {
              found.push({
                crowId: data.crow_id,
                displayName: data.display_name,
                relay: relay.relay_url,
              });
            }
          }
        } catch {
          // Relay unreachable, skip
        }
      }

      if (found.length > 0) {
        const lines = found.map((f) =>
          `  ${f.displayName || f.crowId} (${f.crowId}) — via ${f.relay}`
        );
        return {
          content: [{
            type: "text",
            text: `Found ${found.length} Crow user(s):\n${lines.join("\n")}\n\nUse crow_accept_invite with their invite code to connect.`,
          }],
        };
      }

      return {
        content: [{
          type: "text",
          text: `No Crow users found for that email. They may not have opted into discovery. You can still connect by exchanging invite codes directly.`,
        }],
      };
    }
  );

  // --- Tool: crow_set_discoverable ---

  server.tool(
    "crow_set_discoverable",
    "Opt in or out of contact discovery by setting your email hash. Other Crow users can then find you by email without revealing your actual address.",
    {
      email: z.string().max(500).describe("Your email address (hashed locally, only the hash is stored)"),
      enabled: z.boolean().default(true).describe("Enable or disable discoverability"),
    },
    async ({ email, enabled }) => {
      const normalized = email.trim().toLowerCase();
      const emailHash = createHash("sha256").update(normalized).digest("hex");

      // Store the hash in dashboard_settings for the discovery endpoint
      if (enabled) {
        await db.execute({
          sql: `INSERT OR REPLACE INTO dashboard_settings (key, value, updated_at)
                VALUES ('discovery_email_hash', ?, datetime('now'))`,
          args: [emailHash],
        });
      } else {
        await db.execute({
          sql: "DELETE FROM dashboard_settings WHERE key = 'discovery_email_hash'",
          args: [],
        });
      }

      return {
        content: [{
          type: "text",
          text: enabled
            ? `Discovery enabled. Other Crow users can now find you by email (only your hash is stored: ${emailHash.slice(0, 12)}...).`
            : `Discovery disabled. You are no longer findable by email.`,
        }],
      };
    }
  );

  // --- Tool: crow_discover_relays ---

  server.tool(
    "crow_discover_relays",
    "List configured relays and discover new ones. Relays enable offline message delivery and contact discovery.",
    {},
    async () => {
      const relays = await db.execute({
        sql: "SELECT * FROM relay_config ORDER BY relay_type, relay_url",
        args: [],
      });

      if (relays.rows.length === 0) {
        return {
          content: [{
            type: "text",
            text: [
              "No relays configured.",
              "",
              "Add a relay with crow_add_relay:",
              '  Nostr relay: crow_add_relay({ url: "wss://relay.damus.io", type: "nostr" })',
              '  Peer relay:  crow_add_relay({ url: "https://friend.example.com", type: "peer" })',
              "",
              "Nostr relays enable encrypted messaging between Crow users.",
              "Peer relays enable offline share delivery (store-and-forward).",
            ].join("\n"),
          }],
        };
      }

      const lines = relays.rows.map((r) => {
        const status = r.enabled ? "enabled" : "disabled";
        return `  ${r.relay_url} (${r.relay_type}, ${status})`;
      });

      return {
        content: [{
          type: "text",
          text: `Configured relays (${relays.rows.length}):\n${lines.join("\n")}`,
        }],
      };
    }
  );

  // --- Tool: crow_add_relay ---

  server.tool(
    "crow_add_relay",
    "Add a Nostr or peer relay to your configuration. Nostr relays handle encrypted messaging. Peer relays handle offline share delivery.",
    {
      url: z.string().max(500).describe("Relay URL (wss:// for Nostr, https:// for peer relay)"),
      type: z.enum(["nostr", "peer"]).describe("Relay type"),
    },
    async ({ url, type }) => {
      // Basic URL validation
      try {
        new URL(url);
      } catch {
        return {
          content: [{ type: "text", text: `Invalid URL: ${url}` }],
          isError: true,
        };
      }

      try {
        await db.execute({
          sql: `INSERT INTO relay_config (relay_url, relay_type, enabled)
                VALUES (?, ?, 1)`,
          args: [url, type],
        });
      } catch (err) {
        if (err.message?.includes("UNIQUE")) {
          return {
            content: [{ type: "text", text: `Relay already configured: ${url}` }],
          };
        }
        throw err;
      }

      // If it's a Nostr relay, connect immediately
      if (type === "nostr") {
        try {
          await nostrManager.connectRelays();
        } catch {
          // Non-fatal — will connect on next message send
        }
      }

      return {
        content: [{
          type: "text",
          text: `Added ${type} relay: ${url}`,
        }],
      };
    }
  );

  // --- Instance Management Tools ---

  server.tool(
    "crow_list_instances",
    "List all registered Crow instances (local and remote). Shows instance name, hostname, directory, status, and whether it's the home instance.",
    {
      status: z.enum(["active", "offline", "paused", "revoked"]).optional()
        .describe("Filter by status (default: all)"),
    },
    async ({ status }) => {
      const { listInstances } = await import("../gateway/instance-registry.js");
      const instances = await listInstances(db, { status });

      if (instances.length === 0) {
        return {
          content: [{
            type: "text",
            text: "No instances registered yet. Use crow_register_instance to register this Crow installation.",
          }],
        };
      }

      const lines = instances.map((inst) => {
        const home = inst.is_home ? " [HOME]" : "";
        const topics = inst.topics ? ` | topics: ${inst.topics}` : "";
        const lastSeen = inst.last_seen_at ? ` | last seen: ${inst.last_seen_at}` : "";
        return `• ${inst.name}${home} (${inst.status})\n  id: ${inst.id}\n  host: ${inst.hostname || "unknown"} | dir: ${inst.directory || "unknown"}${topics}${lastSeen}`;
      });

      return {
        content: [{
          type: "text",
          text: `Registered instances (${instances.length}):\n\n${lines.join("\n\n")}`,
        }],
      };
    }
  );

  server.tool(
    "crow_register_instance",
    "Register a Crow instance in the instance registry. Each Crow installation directory is a separate instance. The first registered instance is typically designated as 'home' (the sync hub).",
    {
      name: z.string().max(100).describe("Display name for this instance (e.g., 'Main', 'Finance', 'Cloud Blog')"),
      directory: z.string().max(500).optional().describe("Installation directory path (e.g., ~/crow)"),
      hostname: z.string().max(100).optional().describe("Machine hostname (e.g., grackle, black-swan)"),
      tailscale_ip: z.string().max(50).optional().describe("Tailscale IP for cross-machine access"),
      gateway_url: z.string().max(500).optional().describe("Gateway URL if running (e.g., https://grackle:3001)"),
      sync_profile: z.enum(["full", "memory-only", "blog-only", "custom"]).optional()
        .describe("What to sync: full (everything), memory-only, blog-only, or custom"),
      topics: z.string().max(500).optional()
        .describe("Comma-separated routing keywords (e.g., 'finance, budget, tax')"),
      is_home: z.boolean().optional().describe("Designate as home instance (sync hub). Only one instance can be home."),
    },
    async ({ name, directory, hostname, tailscale_ip, gateway_url, sync_profile, topics, is_home }) => {
      const {
        registerInstance,
        getOrCreateLocalInstanceId,
        generateAuthToken,
        computeInstanceSyncTopic,
      } = await import("../gateway/instance-registry.js");

      const instanceId = getOrCreateLocalInstanceId();
      const crowId = identity.crowId;

      // Generate auth token for this instance
      const { token, hash } = generateAuthToken();

      // Compute Hyperswarm sync topic
      const syncTopic = computeInstanceSyncTopic(crowId);

      await registerInstance(db, {
        id: instanceId,
        name,
        crowId,
        directory: directory || process.cwd(),
        hostname: hostname || (await import("os")).hostname(),
        tailscaleIp: tailscale_ip || null,
        gatewayUrl: gateway_url || null,
        syncUrl: syncTopic.toString("hex"),
        syncProfile: sync_profile || "full",
        topics: topics || null,
        isHome: is_home || false,
        authTokenHash: hash,
      });

      try {
        await createNotification(db, {
          title: `Instance registered: ${name}`,
          type: "system",
          source: "instance-registry",
          action_url: "/dashboard/nest",
        });
      } catch {}

      const homeNote = is_home ? "\nDesignated as HOME instance (sync hub)." : "";
      return {
        content: [{
          type: "text",
          text: `Instance registered successfully.\n\nName: ${name}\nInstance ID: ${instanceId}\nCrow ID: ${crowId}\nAuth token: ${token}\n(Save this token — it's needed for remote instances to authenticate with this one)${homeNote}`,
        }],
      };
    }
  );

  server.tool(
    "crow_update_instance",
    "Update a registered instance's details (name, URL, topics, sync profile, or designate as home).",
    {
      instance_id: z.string().max(100).describe("Instance ID to update"),
      name: z.string().max(100).optional().describe("New display name"),
      gateway_url: z.string().max(500).optional().describe("Updated gateway URL"),
      tailscale_ip: z.string().max(50).optional().describe("Updated Tailscale IP"),
      sync_profile: z.enum(["full", "memory-only", "blog-only", "custom"]).optional()
        .describe("Updated sync profile"),
      topics: z.string().max(500).optional().describe("Updated routing keywords"),
      is_home: z.boolean().optional().describe("Set as home instance"),
      status: z.enum(["active", "offline", "paused"]).optional().describe("Updated status"),
    },
    async ({ instance_id, ...fields }) => {
      const { getInstance, updateInstance } = await import("../gateway/instance-registry.js");

      const existing = await getInstance(db, instance_id);
      if (!existing) {
        return {
          content: [{ type: "text", text: `Instance not found: ${instance_id}` }],
          isError: true,
        };
      }

      const updates = {};
      for (const [key, value] of Object.entries(fields)) {
        if (value !== undefined) updates[key] = value;
      }

      if (Object.keys(updates).length === 0) {
        return {
          content: [{ type: "text", text: "No fields to update." }],
        };
      }

      await updateInstance(db, instance_id, updates);

      return {
        content: [{
          type: "text",
          text: `Instance "${existing.name}" updated: ${Object.keys(updates).join(", ")}`,
        }],
      };
    }
  );

  server.tool(
    "crow_revoke_instance",
    "Revoke a registered instance — sets status to 'revoked', clears its auth token, and stops accepting its sync data. Use this if a device is compromised or an instance is no longer needed.",
    {
      instance_id: z.string().max(100).describe("Instance ID to revoke"),
      confirm: z.boolean().describe("Must be true to confirm revocation (this action cannot be undone)"),
    },
    async ({ instance_id, confirm }) => {
      if (!confirm) {
        return {
          content: [{ type: "text", text: "Revocation not confirmed. Set confirm: true to proceed." }],
        };
      }

      const { getInstance, revokeInstance } = await import("../gateway/instance-registry.js");

      const existing = await getInstance(db, instance_id);
      if (!existing) {
        return {
          content: [{ type: "text", text: `Instance not found: ${instance_id}` }],
          isError: true,
        };
      }

      if (existing.is_home) {
        return {
          content: [{ type: "text", text: "Cannot revoke the home instance. Designate another instance as home first." }],
          isError: true,
        };
      }

      await revokeInstance(db, instance_id);

      try {
        await createNotification(db, {
          title: `Instance revoked: ${existing.name}`,
          type: "system",
          source: "instance-registry",
        });
      } catch {}

      return {
        content: [{
          type: "text",
          text: `Instance "${existing.name}" has been revoked. Its auth token has been cleared and it will no longer be able to sync.`,
        }],
      };
    }
  );

  server.tool(
    "crow_list_sync_conflicts",
    "List sync conflicts between instances. When the same data is modified on multiple instances, conflicts are logged with both versions preserved. Review and resolve conflicts to keep data consistent.",
    {
      table_name: z.string().max(100).optional().describe("Filter by table name (e.g., 'memories', 'crow_context')"),
      unresolved_only: z.boolean().default(true).describe("Only show unresolved conflicts"),
      limit: z.number().max(100).default(20).describe("Maximum results"),
    },
    async ({ table_name, unresolved_only, limit }) => {
      let sql = "SELECT * FROM sync_conflicts WHERE 1=1";
      const params = [];

      if (table_name) {
        sql += " AND table_name = ?";
        params.push(table_name);
      }
      if (unresolved_only) {
        sql += " AND resolved = 0";
      }

      sql += " ORDER BY created_at DESC LIMIT ?";
      params.push(limit);

      const { rows } = await db.execute({ sql, args: params });

      if (rows.length === 0) {
        return {
          content: [{ type: "text", text: unresolved_only ? "No unresolved sync conflicts." : "No sync conflicts found." }],
        };
      }

      const formatted = rows.map((r) => {
        const winning = JSON.parse(r.winning_data);
        const losing = JSON.parse(r.losing_data);
        const winPreview = typeof winning.content === "string" ? winning.content.substring(0, 80) : JSON.stringify(winning).substring(0, 80);
        const losePreview = typeof losing.content === "string" ? losing.content.substring(0, 80) : JSON.stringify(losing).substring(0, 80);
        return `Conflict #${r.id} (${r.table_name}, row: ${r.row_id}, ${r.resolved ? "resolved" : "unresolved"})
  Winner: instance ${r.winning_instance_id} (ts: ${r.winning_lamport_ts})
    ${winPreview}...
  Loser:  instance ${r.losing_instance_id} (ts: ${r.losing_lamport_ts})
    ${losePreview}...
  Created: ${r.created_at}`;
      }).join("\n\n");

      return {
        content: [{ type: "text", text: `Sync conflicts (${rows.length}):\n\n${formatted}` }],
      };
    }
  );

  // --- Tool: crow_room_invite ---

  server.tool(
    "crow_room_invite",
    "Invite a Crow contact to join your companion room. Generates a room token and sends an encrypted invite via Nostr. The contact receives a notification with a join link.",
    {
      contact: z.string().max(500).describe("Crow ID or display name of the contact to invite"),
      host_name: z.string().max(100).optional().describe("Your display name shown in the invite (defaults to Crow ID)"),
    },
    async ({ contact, host_name }) => {
      const result = await sendRoomInvite(contact, host_name);
      if (!result.ok) {
        return { content: [{ type: "text", text: result.message }], isError: true };
      }
      return {
        content: [
          {
            type: "text",
            text: [
              result.message,
              `Room code: ${result.roomCode}`,
              `Join URL: ${result.joinUrl}`,
              `They will receive a notification to join your room.`,
            ].join("\n"),
          },
        ],
      };
    }
  );

  // --- Tool: crow_room_close ---

  server.tool(
    "crow_room_close",
    "Close an active companion room. Invalidates the room token and optionally notifies participants.",
    {
      room_code: z.string().max(50).optional().describe("Room code to close (closes the most recent room if omitted)"),
    },
    async ({ room_code }) => {
      let code = room_code;

      // If no code specified, close the most recent room
      if (!code) {
        let latestTime = 0;
        for (const [rc, room] of _activeRooms) {
          if (room.hostCrowId === identity.crowId && room.createdAt > latestTime) {
            latestTime = room.createdAt;
            code = rc;
          }
        }
      }

      if (!code || !_activeRooms.has(code)) {
        return {
          content: [{ type: "text", text: "No active room found to close." }],
          isError: true,
        };
      }

      const room = _activeRooms.get(code);

      // Notify participants that the room is closing
      for (const contactId of room.participants) {
        try {
          const { rows } = await db.execute({
            sql: "SELECT * FROM contacts WHERE id = ? AND is_blocked = 0",
            args: [contactId],
          });
          if (rows.length > 0) {
            const envelope = JSON.stringify({
              type: "crow_social",
              version: 1,
              subtype: "room_closed",
              payload: {
                room_code: code,
                host_name: room.hostName,
                host_crow_id: room.hostCrowId,
              },
            });
            await nostrManager.sendMessage(rows[0], envelope);
          }
        } catch {
          // Best-effort notification
        }
      }

      _activeRooms.delete(code);

      return {
        content: [{ type: "text", text: `Room ${code} closed. Participants have been notified.` }],
      };
    }
  );

  // --- Tool: crow_voice_memo ---

  server.tool(
    "crow_voice_memo",
    "Send a text voice memo to a Crow contact. The recipient's companion will speak it aloud using TTS.",
    {
      contact: z.string().max(500).describe("Crow ID or display name of the contact"),
      message: z.string().max(2000).describe("The message text to send as a voice memo"),
      sender_name: z.string().max(100).optional().describe("Your display name (defaults to Crow ID)"),
    },
    async ({ contact, message, sender_name }) => {
      const result = await sendVoiceMemo(contact, message, sender_name);
      if (!result.ok) {
        return { content: [{ type: "text", text: result.message }], isError: true };
      }
      return { content: [{ type: "text", text: result.message }] };
    }
  );

  // --- Tool: crow_react ---

  server.tool(
    "crow_react",
    "Send an emoji reaction to a Crow contact.",
    {
      contact: z.string().max(500).describe("Crow ID or display name of the contact"),
      emoji: z.string().max(20).describe("The emoji to send (e.g. thumbs up, heart, fire)"),
    },
    async ({ contact, emoji }) => {
      const result = await sendReaction(contact, emoji);
      if (!result.ok) {
        return { content: [{ type: "text", text: result.message }], isError: true };
      }
      return { content: [{ type: "text", text: result.message }] };
    }
  );

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

  // --- F.11: Identity attestation tools ---

  server.tool(
    "crow_identity_attest",
    "Create a signed attestation linking a per-app handle (e.g., @alice@m.example on Mastodon) to this Crow root identity. The signature can be verified by remote parties via /.well-known/crow-identity.json. OFF BY DEFAULT — opt-in per-handle; publication is permanent and can only be retracted via signed revocation (which itself is public).",
    {
      app: z.enum(ATTESTATION_APPS).describe("Federated app the handle belongs to."),
      external_handle: z.string().min(3).max(320).describe("Full handle, e.g. @alice@m.example or !community@lemmy.example or @user:server.org (Matrix)."),
      app_pubkey: z.string().max(1024).optional().describe("Optional: app-side public key (Matrix MXID signing key, Funkwhale actor key, etc.). Omit if the app doesn't expose a stable signing key."),
      confirm: z.literal("yes").describe("Public linkage is effectively permanent; confirm intent."),
    },
    async ({ app, external_handle, app_pubkey }) => {
      try {
        const identity = loadOrCreateIdentity();
        const db = createDbClient();
        try {
          // Check for an existing active attestation; bump version if present
          const existing = await db.execute({
            sql: `SELECT MAX(version) AS v FROM identity_attestations WHERE crow_id = ? AND app = ? AND external_handle = ?`,
            args: [identity.crowId, app, external_handle],
          });
          const prevVersion = existing.rows[0]?.v ? Number(existing.rows[0].v) : 0;
          const version = prevVersion + 1;
          const created_at = Math.floor(Date.now() / 1000);
          const payload = { crow_id: identity.crowId, app, external_handle, app_pubkey, version, created_at };
          const sig = signAttestation(identity, payload);

          const result = await db.execute({
            sql: `INSERT INTO identity_attestations
                    (crow_id, app, external_handle, app_pubkey, sig, version, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
            args: [identity.crowId, app, external_handle, app_pubkey || null, sig, version, created_at],
          });
          const id = Number(result.rows[0].id);

          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                attestation_id: id,
                crow_id: identity.crowId,
                app,
                external_handle,
                version,
                sig,
                publish_url: "/.well-known/crow-identity.json",
                note: "Attestation is now public via the .well-known endpoint. Use crow_identity_revoke to invalidate it (publication of the revocation itself is also public).",
              }, null, 2),
            }],
          };
        } finally {
          try { db.close(); } catch {}
        }
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    },
  );

  server.tool(
    "crow_identity_verify",
    "Verify an attestation for a given (crow_id, app, handle) triple. Fetches the latest non-revoked attestation from the local database and cryptographically verifies the signature. For cross-instance verification, the caller's gateway is expected to fetch /.well-known/crow-identity.json on the target host instead (rate-limited to 60 req/min/IP at that endpoint).",
    {
      crow_id: z.string().min(6).max(64),
      app: z.enum(ATTESTATION_APPS),
      external_handle: z.string().min(3).max(320),
      max_age_seconds: z.number().int().min(0).max(86400 * 30).optional().describe("If set, accept cached records up to this age; otherwise always fetch fresh (local DB read is already fresh — this is semantic only for HTTP callers)."),
    },
    async ({ crow_id, app, external_handle }) => {
      try {
        const db = createDbClient();
        try {
          const row = await db.execute({
            sql: `SELECT id, app_pubkey, sig, version, created_at, revoked_at
                  FROM identity_attestations
                  WHERE crow_id = ? AND app = ? AND external_handle = ? AND revoked_at IS NULL
                  ORDER BY version DESC LIMIT 1`,
            args: [crow_id, app, external_handle],
          });
          if (row.rows.length === 0) {
            return { content: [{ type: "text", text: JSON.stringify({ valid: false, reason: "no_active_attestation", crow_id, app, external_handle }, null, 2) }] };
          }
          const r = row.rows[0];
          // Re-derive pubkey from local identity iff crow_id matches local
          const localIdentity = loadOrCreateIdentity();
          let rootPubkey = null;
          if (localIdentity.crowId === crow_id) rootPubkey = localIdentity.ed25519Pubkey;
          if (!rootPubkey) {
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  valid: null,
                  reason: "remote_crow_id_pubkey_unavailable",
                  note: "This tool only verifies attestations that belong to THIS Crow instance. For cross-instance verification, fetch /.well-known/crow-identity.json on the remote host.",
                  crow_id, app, external_handle,
                }, null, 2),
              }],
            };
          }
          const payload = { crow_id, app, external_handle, app_pubkey: r.app_pubkey || undefined, version: Number(r.version), created_at: Number(r.created_at) };
          const ok = verifyAttestation(payload, r.sig, rootPubkey) && verifyCrowIdBinding(crow_id, rootPubkey);
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                valid: ok,
                version: Number(r.version),
                created_at: Number(r.created_at),
                fetched_at: Math.floor(Date.now() / 1000),
                attestation_id: Number(r.id),
              }, null, 2),
            }],
          };
        } finally {
          try { db.close(); } catch {}
        }
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    },
  );

  server.tool(
    "crow_identity_revoke",
    "Sign a revocation for a previously-published attestation. The revocation is added to /.well-known/crow-identity-revocations.json and the original attestation is marked revoked (but retained in the DB for audit). Rotating an app key should automatically chain revoke → attest; expose that via the bundle's own key-rotation flow.",
    {
      attestation_id: z.number().int(),
      reason: z.string().max(500).optional(),
      confirm: z.literal("yes").describe("Revocations themselves are public; confirm intent."),
    },
    async ({ attestation_id, reason }) => {
      try {
        const identity = loadOrCreateIdentity();
        const db = createDbClient();
        try {
          const row = await db.execute({
            sql: "SELECT crow_id, revoked_at FROM identity_attestations WHERE id = ?",
            args: [attestation_id],
          });
          if (row.rows.length === 0) {
            return { content: [{ type: "text", text: "Error: attestation not found." }] };
          }
          if (row.rows[0].crow_id !== identity.crowId) {
            return { content: [{ type: "text", text: "Error: this attestation belongs to a different crow_id — only the owner can revoke." }] };
          }
          if (row.rows[0].revoked_at) {
            return { content: [{ type: "text", text: JSON.stringify({ already_revoked: true, revoked_at: Number(row.rows[0].revoked_at) }, null, 2) }] };
          }

          const revoked_at = Math.floor(Date.now() / 1000);
          const payload = { attestation_id, revoked_at, reason };
          const sig = signRevocation(identity, payload);

          await db.execute({
            sql: "UPDATE identity_attestations SET revoked_at = ? WHERE id = ?",
            args: [revoked_at, attestation_id],
          });
          await db.execute({
            sql: `INSERT INTO identity_attestation_revocations (attestation_id, revoked_at, reason, sig) VALUES (?, ?, ?, ?)`,
            args: [attestation_id, revoked_at, reason || null, sig],
          });

          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                attestation_id,
                revoked_at,
                sig,
                publish_url: "/.well-known/crow-identity-revocations.json",
              }, null, 2),
            }],
          };
        } finally {
          try { db.close(); } catch {}
        }
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    },
  );

  server.tool(
    "crow_identity_list",
    "List attestations for this Crow instance. Includes both active and revoked entries; filter with include_revoked=false to see only active ones.",
    {
      include_revoked: z.boolean().optional(),
      app: z.enum(ATTESTATION_APPS).optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    async ({ include_revoked, app, limit }) => {
      try {
        const identity = loadOrCreateIdentity();
        const db = createDbClient();
        try {
          const clauses = ["crow_id = ?"];
          const args = [identity.crowId];
          if (app) { clauses.push("app = ?"); args.push(app); }
          if (include_revoked === false) clauses.push("revoked_at IS NULL");
          args.push(limit ?? 100);
          const rows = await db.execute({
            sql: `SELECT id, app, external_handle, version, created_at, revoked_at
                  FROM identity_attestations
                  WHERE ${clauses.join(" AND ")}
                  ORDER BY created_at DESC
                  LIMIT ?`,
            args,
          });
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                crow_id: identity.crowId,
                count: rows.rows.length,
                attestations: rows.rows.map(r => ({
                  id: Number(r.id),
                  app: r.app,
                  external_handle: r.external_handle,
                  version: Number(r.version),
                  created_at: Number(r.created_at),
                  revoked_at: r.revoked_at ? Number(r.revoked_at) : null,
                })),
              }, null, 2),
            }],
          };
        } finally {
          try { db.close(); } catch {}
        }
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    },
  );

  // --- F.12.2: Crow-native cross-posting ---

  server.tool(
    "crow_list_crosspost_transforms",
    "List the available (source, target) transform pairs for crow_crosspost. Each pair is a pure function in servers/gateway/crossposting/transforms.js.",
    {},
    async () => ({
      content: [{
        type: "text",
        text: JSON.stringify({ pairs: CROSSPOST_PAIRS }, null, 2),
      }],
    }),
  );

  server.tool(
    "crow_crosspost",
    "Cross-post a status from one federated bundle to another via the shared transform library. Requires idempotency_key — duplicate keys within 7 days return the cached result. on_publish trigger queues with a 60-second delay + cancel notification (no fake undo-after-publish).",
    {
      source_app: z.string().min(1).max(50),
      source_post_id: z.string().min(1).max(200).describe("The source app's native post id. Used for idempotency + audit."),
      source_post: z.object({}).passthrough().describe("Source post shape — transforms pull fields from this object (title, content, url, media, etc.)."),
      target_app: z.string().min(1).max(50),
      idempotency_key: z.string().min(8).max(200).describe("Required. Typically sha256(source_app+source_post_id+target_app). Per-Crow-instance scope."),
      trigger: z.enum(["manual", "on_publish", "on_tag"]).optional().describe("manual fires immediately; on_publish/on_tag enqueue with 60s delay."),
      delay_seconds: z.number().int().min(0).max(86400).optional().describe("Override the default 60s delay. 0 = fire immediately (manual default)."),
      confirm: z.literal("yes").describe("Cross-posts cannot be reliably retracted; confirm intent."),
    },
    async ({ source_app, source_post_id, source_post, target_app, idempotency_key, trigger, delay_seconds }) => {
      try {
        // Validate the transform exists before creating a queue entry
        let transformed;
        try {
          transformed = crosspostTransform(source_app, target_app, source_post);
        } catch (err) {
          return { content: [{ type: "text", text: `Error: ${err.message}` }] };
        }

        const db = createDbClient();
        try {
          // Idempotency check (last 7 days)
          const sevenDaysAgo = Math.floor(Date.now() / 1000) - 7 * 86400;
          const existing = await db.execute({
            sql: `SELECT id, status, target_post_id, scheduled_at, published_at, cancelled_at
                  FROM crosspost_log
                  WHERE idempotency_key = ? AND source_app = ? AND target_app = ?
                    AND created_at >= ?
                  LIMIT 1`,
            args: [idempotency_key, source_app, target_app, sevenDaysAgo],
          });
          if (existing.rows.length > 0) {
            const r = existing.rows[0];
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  status: "idempotent_hit",
                  log_id: Number(r.id),
                  prior_status: r.status,
                  target_post_id: r.target_post_id || null,
                  scheduled_at: Number(r.scheduled_at),
                  published_at: r.published_at ? Number(r.published_at) : null,
                  cancelled_at: r.cancelled_at ? Number(r.cancelled_at) : null,
                  note: "Duplicate idempotency_key within 7 days — returning cached entry without re-queuing.",
                }, null, 2),
              }],
            };
          }

          const effectiveTrigger = trigger || "manual";
          const isImmediate = effectiveTrigger === "manual";
          const delay = delay_seconds != null ? delay_seconds : (isImmediate ? 0 : 60);
          const now = Math.floor(Date.now() / 1000);
          const scheduledAt = now + delay;
          const status = delay > 0 ? "queued" : "ready";

          const inserted = await db.execute({
            sql: `INSERT INTO crosspost_log
                    (idempotency_key, source_app, source_post_id, target_app,
                     transform, status, scheduled_at, created_at, transformed_payload_json)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                  RETURNING id`,
            args: [
              idempotency_key, source_app, source_post_id, target_app,
              `${source_app}→${target_app}`, status, scheduledAt, now,
              JSON.stringify(transformed),
            ],
          });
          const logId = Number(inserted.rows[0].id);

          if (delay > 0) {
            try {
              await createNotification(db, {
                title: `About to cross-post to ${target_app}`,
                body: `Source: ${source_app}#${source_post_id}. Firing in ${delay}s unless cancelled. Cancel via crow_crosspost_cancel({ log_id: ${logId} }).`,
                type: "peer",
                source: "crosspost",
                priority: "medium",
                action_url: `/dashboard/crosspost?log_id=${logId}`,
              });
            } catch {}
          }

          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                log_id: logId,
                status,
                scheduled_at: scheduledAt,
                delay_seconds: delay,
                transform: `${source_app}→${target_app}`,
                transformed_preview: transformed,
                note: delay > 0
                  ? `Queued with ${delay}s cancel window. Target bundle's publish tool must be invoked when scheduled_at arrives — this tool only produces the transformed payload + audit log entry, it does NOT publish directly.`
                  : "Ready to publish. Target bundle's publish tool must be invoked now — this tool only produces the transformed payload.",
              }, null, 2),
            }],
          };
        } finally {
          try { db.close(); } catch {}
        }
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    },
  );

  server.tool(
    "crow_crosspost_cancel",
    "Cancel a queued cross-post before its scheduled_at fires. Idempotent — cancelling an already-published entry returns the published target_post_id. Cancelling an already-cancelled entry is a no-op.",
    {
      log_id: z.number().int(),
    },
    async ({ log_id }) => {
      try {
        const db = createDbClient();
        try {
          const row = await db.execute({
            sql: "SELECT status, target_post_id, cancelled_at, published_at, scheduled_at FROM crosspost_log WHERE id = ?",
            args: [log_id],
          });
          if (row.rows.length === 0) {
            return { content: [{ type: "text", text: "Error: crosspost not found." }] };
          }
          const r = row.rows[0];
          if (r.status === "published") {
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  status: "already_published",
                  target_post_id: r.target_post_id,
                  published_at: Number(r.published_at),
                  note: "Published cross-posts cannot be retracted via this tool — use the target bundle's delete verb + accept that delete-propagation is unreliable.",
                }, null, 2),
              }],
            };
          }
          if (r.cancelled_at) {
            return {
              content: [{
                type: "text",
                text: JSON.stringify({ status: "already_cancelled", cancelled_at: Number(r.cancelled_at) }, null, 2),
              }],
            };
          }
          const now = Math.floor(Date.now() / 1000);
          await db.execute({
            sql: "UPDATE crosspost_log SET status = 'cancelled', cancelled_at = ? WHERE id = ?",
            args: [now, log_id],
          });
          return { content: [{ type: "text", text: JSON.stringify({ status: "cancelled", cancelled_at: now }, null, 2) }] };
        } finally {
          try { db.close(); } catch {}
        }
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    },
  );

  server.tool(
    "crow_crosspost_mark_published",
    "Mark a queued cross-post as published (called by the target bundle's publish flow after the actual remote post is created). This tool ONLY updates the audit log — it does NOT perform the publication itself.",
    {
      log_id: z.number().int(),
      target_post_id: z.string().min(1).max(200),
    },
    async ({ log_id, target_post_id }) => {
      try {
        const db = createDbClient();
        try {
          const now = Math.floor(Date.now() / 1000);
          const res = await db.execute({
            sql: `UPDATE crosspost_log SET status = 'published', target_post_id = ?, published_at = ?
                  WHERE id = ? AND status != 'cancelled'`,
            args: [target_post_id, now, log_id],
          });
          if (res.rowsAffected === 0) {
            return { content: [{ type: "text", text: "Error: log row not found or already cancelled." }] };
          }
          return { content: [{ type: "text", text: JSON.stringify({ status: "published", target_post_id, published_at: now }, null, 2) }] };
        } finally {
          try { db.close(); } catch {}
        }
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    },
  );

  server.tool(
    "crow_list_crossposts",
    "List recent cross-posts from the log with their status (queued/ready/published/cancelled/error).",
    {
      status: z.enum(["queued", "ready", "published", "cancelled", "error"]).optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    async ({ status, limit }) => {
      try {
        const db = createDbClient();
        try {
          const clauses = [];
          const args = [];
          if (status) { clauses.push("status = ?"); args.push(status); }
          args.push(limit ?? 50);
          const rows = await db.execute({
            sql: `SELECT id, source_app, source_post_id, target_app, transform, status,
                         target_post_id, scheduled_at, published_at, cancelled_at, error, created_at
                  FROM crosspost_log
                  ${clauses.length ? "WHERE " + clauses.join(" AND ") : ""}
                  ORDER BY created_at DESC LIMIT ?`,
            args,
          });
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                count: rows.rows.length,
                crossposts: rows.rows.map(r => ({
                  id: Number(r.id),
                  source_app: r.source_app,
                  source_post_id: r.source_post_id,
                  target_app: r.target_app,
                  transform: r.transform,
                  status: r.status,
                  target_post_id: r.target_post_id || null,
                  scheduled_at: Number(r.scheduled_at),
                  published_at: r.published_at ? Number(r.published_at) : null,
                  cancelled_at: r.cancelled_at ? Number(r.cancelled_at) : null,
                  error: r.error || null,
                })),
              }, null, 2),
            }],
          };
        } finally {
          try { db.close(); } catch {}
        }
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }] };
      }
    },
  );

  return server;
}
