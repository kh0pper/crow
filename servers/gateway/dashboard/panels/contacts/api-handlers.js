/**
 * Contacts Panel — POST Action Handlers
 *
 * Dispatches form POST actions for contact management, groups, profile, and import/export.
 */

import { randomUUID } from "crypto";
import { parseVCard, generateVCard, parseCsv } from "./vcard.js";
import { upsertSetting } from "../../settings/registry.js";
import { getContacts } from "./data-queries.js";
import { getManagersOrNull } from "../../../../sharing/managers.js";
import { emitContactChange } from "../../../../sharing/contact-sync.js";
import { deleteContactLocal } from "../../../../sharing/contact-delete.js";
import { sanitizeDisplayName } from "../../../../sharing/display-name.js";
import { emitGroupUpsert, emitGroupDelete } from "../../../../sharing/group-sync.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createSharingServer } from "../../../../sharing/server.js";
import { markContactIsBot } from "../../shared/mark-contact-bot.js";
import { extractInviteCode } from "../../../../sharing/invite-url.js";

/**
 * Create a connected sharing MCP client.
 */
async function makeSharingClient() {
  const server = createSharingServer();
  const client = new Client({ name: "dashboard-contacts-action", version: "0.1.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  return client;
}

/**
 * Handle POST actions from the contacts panel.
 * @returns {{ redirect?: string, download?: string } | null}
 */
export async function handleContactAction(req, db, { sharingClientFactory = makeSharingClient } = {}) {
  const { action } = req.body;

  // --- Block / Unblock ---
  if (action === "block" && req.body.contact_id) {
    const contactId = parseInt(req.body.contact_id);
    await db.execute({
      sql: "UPDATE contacts SET is_blocked = 1 WHERE id = ?",
      args: [contactId],
    });
    // Close Hypercore feeds for the blocked contact to free FDs.
    // NOTE: unblocking does NOT re-init feeds — no lazy re-init path exists for
    // contacts. A restart or re-invite is needed to reopen feeds after an unblock.
    const managers = getManagersOrNull();
    if (managers) {
      try {
        // SyncManager keys by integer contactId; PeerManager keys by crow_id string.
        if (managers.syncManager) {
          await managers.syncManager.closeContactFeeds(contactId);
        }
        if (managers.peerManager) {
          const { rows } = await db.execute({
            sql: "SELECT crow_id FROM contacts WHERE id = ?",
            args: [contactId],
          });
          if (rows[0]?.crow_id) {
            await managers.peerManager.leaveContact(rows[0].crow_id);
          }
        }
      } catch {}
    }
    // Phase 3: a block follows the user across their instances.
    try { const { rows } = await db.execute({ sql: "SELECT * FROM contacts WHERE id = ?", args: [contactId] }); if (rows[0]) await emitContactChange("update", rows[0]); } catch {}
    return { redirect: "/dashboard/contacts" };
  }

  if (action === "unblock" && req.body.contact_id) {
    const contactId = parseInt(req.body.contact_id);
    await db.execute({
      sql: "UPDATE contacts SET is_blocked = 0 WHERE id = ?",
      args: [contactId],
    });
    try { const { rows } = await db.execute({ sql: "SELECT * FROM contacts WHERE id = ?", args: [contactId] }); if (rows[0]) await emitContactChange("update", rows[0]); } catch {}
    return { redirect: "/dashboard/contacts" };
  }

  // --- Trust: mark/unmark a contact as safety-number verified (P2/C4) ---
  if (action === "set_verified" && req.body.contact_id) {
    const contactId = parseInt(req.body.contact_id);
    await db.execute({
      sql: "UPDATE contacts SET verified = ? WHERE id = ?",
      args: [req.body.verified === "1" ? 1 : 0, contactId],
    });
    // Phase 3: deliberately NO emit — `verified` is a per-device attestation
    // (in EXCLUDED_COLUMNS.contacts); each device verifies independently.
    return { redirect: "/dashboard/contacts?view=contact&contact=" + contactId };
  }

  // --- Add manual contact ---
  if (action === "add_manual") {
    const name = (req.body.name || "").trim();
    if (!name) return { redirect: "/dashboard/contacts" };

    const manualCrowId = `manual:${randomUUID()}`;
    await db.execute({
      sql: `INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey, contact_type, email, phone, notes, created_at)
            VALUES (?, ?, '', '', 'manual', ?, ?, ?, datetime('now'))`,
      args: [
        manualCrowId,
        name,
        (req.body.email || "").trim(),
        (req.body.phone || "").trim(),
        (req.body.notes || "").trim(),
      ],
    });
    // Phase 3: the manual address-book entry follows the user (no secp key, so
    // the receiver's onContactSynced hook won't try to subscribe).
    try { const { rows } = await db.execute({ sql: "SELECT * FROM contacts WHERE crow_id = ?", args: [manualCrowId] }); if (rows[0]) await emitContactChange("insert", rows[0]); } catch {}
    return { redirect: "/dashboard/contacts" };
  }

  // R4: repair/add a real Crow contact by pasting its Crow ID + public keys.
  // Delegates to the crow_add_contact tool (idempotent insert/promote/merge),
  // which does the sync/DHT/Nostr wiring in-process.
  if (action === "add_by_id") {
    const crowId = (req.body.crow_id || "").trim();
    const secp = (req.body.secp256k1_pubkey || "").trim();
    if (!crowId || !secp) return { redirect: "/dashboard/contacts" };
    try {
      const client = await sharingClientFactory();
      try {
        await client.callTool({
          name: "crow_add_contact",
          arguments: {
            crow_id: crowId,
            secp256k1_pubkey: secp,
            ed25519_pubkey: (req.body.ed25519_pubkey || "").trim() || undefined,
            display_name: (req.body.name || "").trim() || undefined,
          },
        });
      } finally { try { await client.close?.(); } catch {} }
    } catch (err) {
      console.error("[contacts] add_by_id failed:", err.message);
    }
    return { redirect: "/dashboard/contacts" };
  }

  // P2/C1+C3: full peer-add from the Contacts panel — generate an invite…
  if (action === "generate_invite") {
    try {
      const client = await sharingClientFactory();
      try {
        const result = await client.callTool({ name: "crow_generate_invite", arguments: {} });
        const text = result.content?.[0]?.text || "";
        if (result?.isError) return { inviteError: text || "Could not generate invite." };
        return { inviteResult: text };
      } finally { try { await client.close?.(); } catch {} }
    } catch (err) {
      console.error("[contacts] generate_invite failed:", err.message);
      return { inviteError: err.message };
    }
  }

  // …and accept one (forgiving: raw code or full share URL).
  if (action === "accept_invite" && req.body.invite_code) {
    try {
      const code = extractInviteCode(req.body.invite_code);
      const client = await sharingClientFactory();
      try {
        const result = await client.callTool({ name: "crow_accept_invite", arguments: { invite_code: code } });
        if (result?.isError) return { inviteError: result.content?.[0]?.text || "Invite could not be accepted." };
      } finally { try { await client.close?.(); } catch {} }
    } catch (err) {
      console.error("[contacts] accept_invite failed"); // never echo the code
      return { inviteError: err.message };
    }
    return { redirect: "/dashboard/contacts" };
  }

  // Short-code pairing (P2/C2): generate a 12-char code to read aloud/type...
  if (action === "generate_short_invite") {
    try {
      const client = await sharingClientFactory();
      try {
        const result = await client.callTool({ name: "crow_generate_short_invite", arguments: {} });
        const text = result.content?.[0]?.text || "";
        if (result?.isError) return { inviteError: text || "Could not generate a short code." };
        return { shortCodeResult: text };
      } finally { try { await client.close?.(); } catch {} }
    } catch (err) {
      console.error("[contacts] generate_short_invite failed:", err.message);
      return { inviteError: err.message };
    }
  }

  // ...and accept one.
  if (action === "accept_short_invite" && req.body.short_code) {
    try {
      const client = await sharingClientFactory();
      try {
        const result = await client.callTool({ name: "crow_accept_short_invite", arguments: { short_code: req.body.short_code } });
        if (result?.isError) return { inviteError: result.content?.[0]?.text || "Code could not be accepted." };
      } finally { try { await client.close?.(); } catch {} }
    } catch (err) {
      console.error("[contacts] accept_short_invite failed"); // never echo the code
      return { inviteError: err.message };
    }
    return { redirect: "/dashboard/contacts" };
  }

  // --- Edit contact ---
  if (action === "edit_contact" && req.body.contact_id) {
    const fields = [];
    const args = [];

    if (req.body.display_name !== undefined) {
      fields.push("display_name = ?");
      args.push(req.body.display_name.trim());
    }
    if (req.body.notes !== undefined) {
      fields.push("notes = ?");
      args.push(req.body.notes.trim());
    }
    if (req.body.bio !== undefined) {
      fields.push("bio = ?");
      args.push(req.body.bio.trim());
    }
    if (req.body.email !== undefined) {
      fields.push("email = ?");
      args.push(req.body.email.trim());
    }
    if (req.body.phone !== undefined) {
      fields.push("phone = ?");
      args.push(req.body.phone.trim());
    }
    if (req.body.avatar_url !== undefined) {
      fields.push("avatar_url = ?");
      args.push(req.body.avatar_url.trim());
    }

    if (fields.length > 0) {
      const editId = parseInt(req.body.contact_id);
      args.push(editId);
      await db.execute({
        sql: `UPDATE contacts SET ${fields.join(", ")} WHERE id = ?`,
        args,
      });
      // Phase 3: profile edits follow the user.
      try { const { rows } = await db.execute({ sql: "SELECT * FROM contacts WHERE id = ?", args: [editId] }); if (rows[0]) await emitContactChange("update", rows[0]); } catch {}
    }

    return { redirect: `/dashboard/contacts?view=contact&contact=${req.body.contact_id}` };
  }

  // --- Delete contact ---
  if (action === "delete_contact" && req.body.contact_id) {
    const delId = parseInt(req.body.contact_id);
    const { rows } = await db.execute({ sql: "SELECT * FROM contacts WHERE id = ?", args: [delId] });
    const row = rows[0];
    if (!row) return { redirect: "/dashboard/contacts" };

    // Two-step confirmation (design §4.2). A POST WITHOUT confirm=1 must not
    // mutate anything — redirect to the GET interstitial that discloses the
    // exact blast radius (cascade counts) and offers Block as the reversible
    // alternative. The destructive step is the confirm=1 POST below, which
    // passes through csrfMiddleware; the interstitial GET stays side-effect-free.
    if (req.body.confirm !== "1") {
      return { redirect: `/dashboard/contacts?view=contact&contact=${delId}&confirm=delete` };
    }

    // Phase 3 REVERSES the former "deliberate no-op" here: contacts follow the
    // user across their linked Crows, so a delete DOES propagate to peers — a
    // delete that did NOT follow would be a divergence bug. Durability against a
    // resurrecting rename is provided by the tombstone that emitContactDelete
    // co-writes (design §D3). deleteContactLocal drops the old
    // contact_type='manual' restriction (so crow: rows are finally deletable)
    // and refuses origin='local-bot' rows, which this instance recreates at boot.
    const managers = getManagersOrNull();
    const result = await deleteContactLocal(db, managers || {}, row);
    if (!result.ok) return { redirect: `/dashboard/contacts?view=contact&contact=${delId}` };
    return { redirect: "/dashboard/contacts" };
  }

  // --- Group management ---
  if (action === "create_group") {
    const name = (req.body.group_name || "").trim();
    const color = (req.body.group_color || "#6366f1").trim();
    if (name) {
      const gRes = await db.execute({
        sql: "INSERT INTO contact_groups (name, color) VALUES (?, ?)",
        args: [name, color],
      });
      // M2: keep this emit INSIDE if(name) — gRes.lastInsertRowid is only valid here.
      try { await emitGroupUpsert(db, Number(gRes.lastInsertRowid)); } catch {}
    }
    return { redirect: "/dashboard/contacts?view=groups" };
  }

  if (action === "rename_group" && req.body.group_id) {
    const name = (req.body.group_name || "").trim();
    if (name) {
      await db.execute({
        sql: "UPDATE contact_groups SET name = ? WHERE id = ?",
        args: [name, parseInt(req.body.group_id)],
      });
      try { await emitGroupUpsert(db, parseInt(req.body.group_id)); } catch {}
    }
    return { redirect: "/dashboard/contacts?view=groups" };
  }

  if (action === "delete_group" && req.body.group_id) {
    const gid = parseInt(req.body.group_id);
    let gUid = null;
    try { const { rows } = await db.execute({ sql: "SELECT group_uid FROM contact_groups WHERE id = ?", args: [gid] }); gUid = rows[0]?.group_uid || null; } catch {}
    await db.execute({ sql: "DELETE FROM contact_groups WHERE id = ?", args: [gid] });
    if (gUid) { try { await emitGroupDelete(gUid); } catch {} }
    return { redirect: "/dashboard/contacts?view=groups" };
  }

  if (action === "add_to_group" && req.body.group_id && req.body.contact_id) {
    try {
      await db.execute({
        sql: "INSERT OR IGNORE INTO contact_group_members (group_id, contact_id) VALUES (?, ?)",
        args: [parseInt(req.body.group_id), parseInt(req.body.contact_id)],
      });
    } catch {}
    try { await emitGroupUpsert(db, parseInt(req.body.group_id)); } catch {}
    const returnView = req.body.return_view || "contact";
    const returnContact = req.body.contact_id;
    return { redirect: `/dashboard/contacts?view=${returnView}&contact=${returnContact}` };
  }

  if (action === "remove_from_group" && req.body.group_id && req.body.contact_id) {
    await db.execute({
      sql: "DELETE FROM contact_group_members WHERE group_id = ? AND contact_id = ?",
      args: [parseInt(req.body.group_id), parseInt(req.body.contact_id)],
    });
    try { await emitGroupUpsert(db, parseInt(req.body.group_id)); } catch {}
    const returnView = req.body.return_view || "contact";
    const returnContact = req.body.contact_id;
    return { redirect: `/dashboard/contacts?view=${returnView}&contact=${returnContact}` };
  }

  // --- Own profile ---
  if (action === "save_profile") {
    if (req.body.display_name !== undefined) {
      // This value is SENT on every handshake and syncs to all of the user's
      // instances — cap + strip it at write (design §D5). sanitizeDisplayName
      // returns null when nothing survives; store "" rather than the literal
      // "null" so the setting is cleared, not poisoned.
      await upsertSetting(db, "profile_display_name", sanitizeDisplayName(req.body.display_name) ?? "");
    }
    if (req.body.avatar_url !== undefined) {
      await upsertSetting(db, "profile_avatar_url", req.body.avatar_url.trim());
    }
    if (req.body.bio !== undefined) {
      await upsertSetting(db, "profile_bio", req.body.bio.trim());
    }
    return { redirect: "/dashboard/contacts?view=profile" };
  }

  // --- Export vCard ---
  if (action === "export_vcard") {
    const contacts = await getContacts(db, { limit: 1000 });
    const vcf = generateVCard(contacts);
    return { download: vcf };
  }

  // --- Import vCard/CSV ---
  if (action === "import_contacts") {
    const content = (req.body.import_content || "").trim();
    const format = req.body.import_format || "vcard";

    if (content) {
      const parsed = format === "csv" ? parseCsv(content) : parseVCard(content);
      let imported = 0;

      for (const c of parsed) {
        const name = c.name || c.email || "Imported Contact";
        const manualCrowId = `manual:${randomUUID()}`;
        try {
          await db.execute({
            sql: `INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey, contact_type, email, phone, notes, created_at)
                  VALUES (?, ?, '', '', 'manual', ?, ?, ?, datetime('now'))`,
            args: [manualCrowId, name, c.email || "", c.phone || "", c.notes || ""],
          });
          imported++;
          // Phase 3: an imported address book follows the user (guarded; a slow
          // import must not stall on emit).
          try { const { rows } = await db.execute({ sql: "SELECT * FROM contacts WHERE crow_id = ?", args: [manualCrowId] }); if (rows[0]) await emitContactChange("insert", rows[0]); } catch {}
        } catch (err) {
          console.warn("[contacts] Import error for", name, err.message);
        }
      }

      console.log(`[contacts] Imported ${imported} contacts from ${format}`);
    }

    return { redirect: "/dashboard/contacts" };
  }

  // --- Browse bots directory: add bot as contact ---
  if (action === "dir_add_bot" && req.body.invite_code) {
    const code = req.body.invite_code.trim();
    let botCrowId = null;
    try {
      const { parseBotInviteCode } = await import("../../../../sharing/identity.js");
      botCrowId = parseBotInviteCode(code).botCrowId;
    } catch {}
    let wasNew = false;
    if (botCrowId) { try { const { rows } = await db.execute({ sql: "SELECT 1 FROM contacts WHERE crow_id = ?", args: [botCrowId] }); wasNew = rows.length === 0; } catch {} }
    try {
      const client = await sharingClientFactory();
      try {
        const accepted = await client.callTool({ name: "crow_accept_bot_invite", arguments: { invite_code: code } });
        if (!accepted?.isError && botCrowId) {
          if (wasNew) await db.execute({ sql: "UPDATE contacts SET origin = 'advertised' WHERE crow_id = ?", args: [botCrowId] });
          await markContactIsBot(db, botCrowId);
          // Phase 3: propagate the final advertised-bot state (origin + is_bot)
          // to the user's other instances. (The accept tool emits the base row;
          // this update carries the advertised/is_bot flags set just above.)
          try { const { rows } = await db.execute({ sql: "SELECT * FROM contacts WHERE crow_id = ?", args: [botCrowId] }); if (rows[0]) await emitContactChange("update", rows[0]); } catch {}
        }
      } finally { await client.close(); }
    } catch (err) { console.error("[contacts] dir_add_bot failed:", err.message); }
    return { redirect: "/dashboard/contacts?view=bots" };
  }

  return null;
}
