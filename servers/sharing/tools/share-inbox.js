/**
 * Crow Sharing — Share Inbox Tools
 *
 * Registers: crow_share, crow_inbox
 * (tool registration order #4-5)
 */

import { z } from "zod";
import { isKioskActive, kioskBlockedResponse } from "../../shared/kiosk-guard.js";
import { generateToken, validateToken, shouldSkipGates } from "../../shared/confirm.js";
import { ROLES, AclError, assertLocalCapability, appendAudit } from "../../shared/project-acl.js";

export function registerShareInboxTools(server, ctx) {
  const { db, identity, peerManager, buildProjectCloneBundle } = ctx;

  // --- Tool: crow_share ---

  server.tool(
    "crow_share",
    "Share a memory, research project, source, or note with a connected contact. The data is encrypted end-to-end. Returns a preview and confirmation token on first call; pass the token back to execute.\n\nFor share_type=\"project\", mode=\"clone\" delivers a one-shot snapshot bundle (project metadata + sources + notes + audit log + data-backend manifests + storage manifest). The recipient creates an independent copy with a -clone-N slug; further changes on either side do NOT sync. Subscription mode (live one-way sync) is planned for a follow-on milestone.",
    {
      contact: z.string().max(500).describe("Crow ID or display name of the contact"),
      share_type: z.enum(["memory", "project", "source", "note", "kb_article"]).describe("Type of item to share"),
      item_id: z.number().describe("ID of the item to share"),
      permissions: z.enum(["read", "read-write", "one-time"]).default("read").describe("Permission level (event-style shares only — ignored for share_type=project)"),
      mode: z.enum(["clone"]).optional().describe("For share_type=project: 'clone' delivers a one-shot snapshot bundle. Omit for non-project shares (legacy event-style)."),
      role: z.enum(ROLES).optional().describe("For share_type=project: role to record on the origin-side project_members audit row (default viewer)"),
      capabilities: z.string().max(2000).optional().describe("For share_type=project: JSON object overriding role default capabilities (recorded for audit, not enforced on the receiver clone)"),
      confirm_token: z.string().max(100).describe('Confirmation token — pass "" on first call to get a preview, then pass the returned token to execute'),
    },
    async ({ contact, share_type, item_id, permissions, mode, role, capabilities, confirm_token }) => {
      if (await isKioskActive(db)) return kioskBlockedResponse("crow_share");
      // Find contact
      const result = await db.execute({
        sql: "SELECT * FROM contacts WHERE (crow_id = ? OR display_name = ?) AND is_blocked = 0",
        args: [contact, contact],
      });

      if (result.rows.length === 0) {
        return {
          content: [{ type: "text", text: `Contact not found: ${contact}` }],
          isError: true,
        };
      }

      const contactRow = result.rows[0];

      // M4: project-clone path. Different lifecycle from event-style shares:
      // build a bundle, gate behind manage_members, write a project_members
      // row recording the share, and ride the same Hyperswarm channel.
      if (share_type === "project" && (mode === "clone" || mode === undefined)) {
        // For projects we ALWAYS use the new project_spaces row (not the legacy
        // research_projects view of it) — the bundle needs slug, workspace_dir,
        // storage_prefix, etc.
        const projectExists = (await db.execute({
          sql: "SELECT id, name, slug, archived_at FROM project_spaces WHERE id = ?",
          args: [item_id],
        })).rows[0];
        if (!projectExists) {
          return { content: [{ type: "text", text: `Project #${item_id} not found in project_spaces` }], isError: true };
        }
        if (projectExists.archived_at) {
          return { content: [{ type: "text", text: `Project #${item_id} is archived and cannot be shared` }], isError: true };
        }

        // ACL: the local user must have manage_members to share a project.
        // Owners get this by default; editors don't.
        try {
          await assertLocalCapability(db, item_id, "manage_members");
        } catch (err) {
          if (err instanceof AclError) {
            return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
          }
          throw err;
        }

        // Capabilities JSON validation
        if (capabilities) {
          try { JSON.parse(capabilities); }
          catch { return { content: [{ type: "text", text: "Error: capabilities must be valid JSON" }], isError: true }; }
        }

        // Confirmation gate — preview shows what the bundle will contain
        const effectiveRole = role || "viewer";
        const tokenKey = `share_project_clone_${item_id}_${contactRow.id}_${effectiveRole}`;
        if (!shouldSkipGates()) {
          if (confirm_token) {
            if (!validateToken(confirm_token, "share", tokenKey)) {
              return { content: [{ type: "text", text: "Invalid or expired confirmation token. Pass confirm_token: \"\" to get a new preview." }], isError: true };
            }
          } else {
            const sCount = (await db.execute({ sql: "SELECT COUNT(*) AS n FROM research_sources WHERE project_id=?", args: [item_id] })).rows[0]?.n ?? 0;
            const nCount = (await db.execute({ sql: "SELECT COUNT(*) AS n FROM research_notes WHERE project_id=?", args: [item_id] })).rows[0]?.n ?? 0;
            const bCount = (await db.execute({ sql: "SELECT COUNT(*) AS n FROM data_backends WHERE project_id=?", args: [item_id] })).rows[0]?.n ?? 0;
            const fCount = (await db.execute({ sql: "SELECT COUNT(*) AS n FROM storage_files WHERE project_id=?", args: [item_id] })).rows[0]?.n ?? 0;
            const token = generateToken("share", tokenKey);
            return {
              content: [{
                type: "text",
                text: `⚠️ Clone-share project to ${contactRow.display_name || contactRow.crow_id}:\n` +
                      `  Project: #${item_id} "${projectExists.name}" (slug: ${projectExists.slug})\n` +
                      `  Mode: clone (one-shot snapshot; no further sync)\n` +
                      `  Recipient role on their clone: ${effectiveRole}\n` +
                      `  Bundle: ${sCount} sources, ${nCount} notes, ${bCount} backend manifests, ${fCount} file manifests\n` +
                      `  Backends carry env-var NAMES only — secrets stay on origin; operator must reconnect on recipient.\n` +
                      `  Files are MANIFEST only (presigned URLs valid 24h) — receiver pulls blobs out-of-band if needed.\n\n` +
                      `To proceed, call again with confirm_token: "${token}"`,
              }],
            };
          }
        }

        // Build the bundle
        let bundle;
        try {
          bundle = await buildProjectCloneBundle(item_id);
        } catch (err) {
          return { content: [{ type: "text", text: `Failed to build bundle: ${err.message}` }], isError: true };
        }

        // Record the share in shared_items (event-style row for inbox listing)
        // AND in project_members (mode='clone') so the origin retains an audit
        // trail of which clones were sent to whom.
        await db.execute({
          sql: `INSERT INTO shared_items (contact_id, share_type, item_id, permissions, direction, delivery_status)
                VALUES (?, 'project', ?, ?, 'sent', ?)`,
          args: [
            contactRow.id, item_id, "read",
            peerManager.isConnected(contactRow.crow_id) ? "delivered" : "pending",
          ],
        });

        // project_members row: contact_id + role + mode='clone' so revoke
        // can find the same record later. Upsert: if the same contact got
        // another clone of the same project, update the role.
        try {
          const existing = (await db.execute({
            sql: `SELECT id FROM project_members WHERE project_id = ? AND contact_id = ? AND mode = 'clone' AND revoked_at IS NULL`,
            args: [item_id, contactRow.id],
          })).rows[0];
          if (existing) {
            await db.execute({
              sql: `UPDATE project_members SET role = ?, capabilities = ? WHERE id = ?`,
              args: [effectiveRole, capabilities ?? null, existing.id],
            });
          } else {
            await db.execute({
              sql: `INSERT INTO project_members (project_id, contact_id, role, capabilities, mode)
                    VALUES (?, ?, ?, ?, 'clone')`,
              args: [item_id, contactRow.id, effectiveRole, capabilities ?? null],
            });
          }
        } catch (memberErr) {
          // Non-fatal — the share itself proceeds.
          console.warn(`[sharing] could not record project_members clone row: ${memberErr.message}`);
        }

        // Deliver via Hyperswarm if peer online; queue otherwise.
        let deliveryStatus = "pending";
        if (peerManager.isConnected(contactRow.crow_id)) {
          try {
            peerManager.send(contactRow.crow_id, {
              type: "share",
              share_type: "project",
              mode: "clone",
              payload: bundle,
              role: effectiveRole,
              capabilities: capabilities ?? null,
              sender: identity.crowId,
              timestamp: new Date().toISOString(),
            });
            deliveryStatus = "delivered";
          } catch (err) {
            deliveryStatus = "pending";
            console.warn(`[sharing] project clone send failed: ${err.message}`);
          }
        }

        await appendAudit(db, {
          project_id: item_id, actor_type: "local",
          action: "share.send",
          target: `contact:${contactRow.id}`,
          payload: {
            mode: "clone", role: effectiveRole,
            recipient_crow_id: contactRow.crow_id,
            delivery_status: deliveryStatus,
            sources: bundle.sources.length, notes: bundle.notes.length,
            backends: bundle.backends.length, files: bundle.file_manifest.length,
          },
        });

        return {
          content: [{
            type: "text",
            text: `Clone-shared project #${item_id} "${projectExists.name}" with ${contactRow.display_name || contactRow.crow_id} as ${effectiveRole}. ` +
                  `Bundle: ${bundle.sources.length} sources, ${bundle.notes.length} notes, ${bundle.backends.length} backend manifests, ${bundle.file_manifest.length} file manifests. ` +
                  `Delivery: ${deliveryStatus === "delivered" ? "delivered" : "queued (will deliver when peer comes online)"}.`,
          }],
        };
      }

      // Verify the item exists
      const tableMap = {
        memory: { table: "memories", query: null },
        project: {
          table: "project_spaces",
          query: `SELECT id, uuid, name, description, type, status, tags, created_at, updated_at
                  FROM project_spaces WHERE id = ? AND archived_at IS NULL`,
        },
        source: { table: "research_sources", query: null },
        note: { table: "research_notes", query: null },
      };
      const mapEntry = tableMap[share_type];
      let item;
      if (mapEntry?.query) {
        item = await db.execute({ sql: mapEntry.query, args: [item_id] });
      } else {
        item = await db.execute({
          sql: `SELECT * FROM ${mapEntry?.table || share_type} WHERE id = ?`,
          args: [item_id],
        });
      }

      if (item.rows.length === 0) {
        return {
          content: [{ type: "text", text: `${share_type} #${item_id} not found` }],
          isError: true,
        };
      }

      // Confirmation gate
      const tokenKey = `share_${share_type}_${item_id}_${contactRow.id}`;
      if (!shouldSkipGates()) {
        if (confirm_token) {
          if (!validateToken(confirm_token, "share", tokenKey)) {
            return { content: [{ type: "text", text: "Invalid or expired confirmation token. Pass confirm_token: \"\" to get a new preview." }], isError: true };
          }
        } else {
          const itemRow = item.rows[0];
          const itemDesc = itemRow.title || itemRow.name || itemRow.content?.substring(0, 100) || `#${item_id}`;
          const token = generateToken("share", tokenKey);
          return {
            content: [{
              type: "text",
              text: `⚠️ This will share:\n  ${share_type} #${item_id}: "${itemDesc}"\n  With: ${contactRow.display_name || contactRow.crow_id}\n  Permissions: ${permissions}\n\nTo proceed, call again with confirm_token: "${token}"`,
            }],
          };
        }
      }

      // Record the share
      await db.execute({
        sql: `INSERT INTO shared_items (contact_id, share_type, item_id, permissions, direction, delivery_status)
              VALUES (?, ?, ?, ?, 'sent', ?)`,
        args: [
          contactRow.id,
          share_type,
          item_id,
          permissions,
          peerManager.isConnected(contactRow.crow_id) ? "delivered" : "pending",
        ],
      });

      // If peer is online, send directly via Hyperswarm data channel
      if (peerManager.isConnected(contactRow.crow_id)) {
        try {
          peerManager.send(contactRow.crow_id, {
            type: "share",
            share_type,
            payload: item.rows[0],
            permissions,
            sender: identity.crowId,
            timestamp: new Date().toISOString(),
          });
        } catch (err) {
          // Send failed — still recorded in shared_items as pending
          await db.execute({
            sql: "UPDATE shared_items SET delivery_status = 'pending' WHERE contact_id = ? AND item_id = ? AND share_type = ? AND direction = 'sent' ORDER BY created_at DESC LIMIT 1",
            args: [contactRow.id, item_id, share_type],
          });
        }
      }

      const status = peerManager.isConnected(contactRow.crow_id)
        ? "delivered"
        : "queued (will deliver when peer comes online)";

      return {
        content: [
          {
            type: "text",
            text: `Shared ${share_type} #${item_id} with ${contactRow.display_name || contactRow.crow_id} (${permissions}). Status: ${status}`,
          },
        ],
      };
    }
  );

  // --- Tool: crow_inbox ---

  server.tool(
    "crow_inbox",
    "Check your inbox for received shares and messages from contacts.",
    {
      unread_only: z.boolean().default(false).describe("Show only unread items"),
      limit: z.number().max(100).default(20).describe("Maximum items to return"),
    },
    async ({ unread_only, limit }) => {
      // Get received shares
      const sharesSql = `
        SELECT si.*, c.crow_id, c.display_name
        FROM shared_items si
        JOIN contacts c ON c.id = si.contact_id
        WHERE si.direction = 'received'
        ORDER BY si.created_at DESC
        LIMIT ?
      `;
      const shares = await db.execute({ sql: sharesSql, args: [limit] });

      // Get unread messages
      let msgSql = `
        SELECT m.*, c.crow_id, c.display_name
        FROM messages m
        JOIN contacts c ON c.id = m.contact_id
        WHERE m.direction = 'received'
      `;
      const msgArgs = [];

      if (unread_only) {
        msgSql += " AND m.is_read = 0";
      }
      msgSql += " ORDER BY m.created_at DESC LIMIT ?";
      msgArgs.push(limit);

      const messages = await db.execute({ sql: msgSql, args: msgArgs });

      const parts = [];

      if (shares.rows.length > 0) {
        parts.push("Received shares:");
        for (const s of shares.rows) {
          parts.push(`  [${s.share_type}] from ${s.display_name || s.crow_id} — ${s.permissions} (${s.created_at})`);
        }
      }

      if (messages.rows.length > 0) {
        parts.push("");
        parts.push("Messages:");
        for (const m of messages.rows) {
          const readIcon = m.is_read ? "" : "[NEW] ";
          parts.push(`  ${readIcon}${m.display_name || m.crow_id}: --- stored content ---\n${m.content}\n--- end stored content --- (${m.created_at})`);
        }
      }

      if (parts.length === 0) {
        parts.push("Inbox is empty. No shares or messages received.");
      }

      return {
        content: [{ type: "text", text: parts.join("\n") }],
      };
    }
  );
}
