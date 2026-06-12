/**
 * Crow Sharing — Discovery Tools
 *
 * Registers: crow_find_contacts, crow_set_discoverable
 * (tool registration order #12-13)
 */

import { z } from "zod";
import { createHash } from "node:crypto";

export function registerDiscoveryTools(server, ctx) {
  const { db } = ctx;

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
}
