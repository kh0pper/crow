/**
 * Crow Sharing — Instance Management Tools
 *
 * Registers: crow_discover_relays, crow_add_relay, crow_list_instances,
 *            crow_register_instance, crow_update_instance, crow_revoke_instance,
 *            crow_list_sync_conflicts
 * (tool registration order #14-20)
 */

import { z } from "zod";
import { createNotification } from "../../shared/notifications.js";

export function registerInstancesTools(server, ctx) {
  const { db, identity, nostrManager, instanceSyncManager } = ctx;

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
      const { listInstances } = await import("../../gateway/instance-registry.js");
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
      } = await import("../../gateway/instance-registry.js");

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
      const { getInstance, updateInstance } = await import("../../gateway/instance-registry.js");

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

      const { getInstance, revokeInstance } = await import("../../gateway/instance-registry.js");

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

      // Close Hypercore feeds for the revoked instance to free FDs.
      // Instances lazily re-init on un-revoke (boot eagerInitPairedPeers /
      // tailnet-sync paths gate on status and will reopen if un-revoked).
      if (instanceSyncManager) {
        try { await instanceSyncManager.closeInstanceFeeds(instance_id); } catch {}
      }

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
}
