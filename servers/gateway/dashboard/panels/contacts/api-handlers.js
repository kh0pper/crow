/**
 * Contacts Panel — POST Action Handlers
 *
 * Dispatches form POST actions for contact management, groups, profile, and import/export.
 */

import { randomUUID } from "crypto";
import { parseVCard, generateVCard, parseCsv } from "./vcard.js";
import { upsertSetting } from "../../settings/registry.js";
import { getContacts } from "./data-queries.js";

/**
 * Handle POST actions from the contacts panel.
 * @returns {{ redirect?: string, download?: string } | null}
 */
export async function handleContactAction(req, db) {
  const { action } = req.body;

  // --- Block / Unblock ---
  if (action === "block" && req.body.contact_id) {
    await db.execute({
      sql: "UPDATE contacts SET is_blocked = 1 WHERE id = ?",
      args: [parseInt(req.body.contact_id)],
    });
    return { redirect: "/dashboard/contacts" };
  }

  if (action === "unblock" && req.body.contact_id) {
    await db.execute({
      sql: "UPDATE contacts SET is_blocked = 0 WHERE id = ?",
      args: [parseInt(req.body.contact_id)],
    });
    return { redirect: "/dashboard/contacts" };
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
      args.push(parseInt(req.body.contact_id));
      await db.execute({
        sql: `UPDATE contacts SET ${fields.join(", ")} WHERE id = ?`,
        args,
      });
    }

    return { redirect: `/dashboard/contacts?view=contact&contact=${req.body.contact_id}` };
  }

  // --- Delete contact ---
  if (action === "delete_contact" && req.body.contact_id) {
    await db.execute({
      sql: "DELETE FROM contacts WHERE id = ? AND contact_type = 'manual'",
      args: [parseInt(req.body.contact_id)],
    });
    return { redirect: "/dashboard/contacts" };
  }

  // --- Group management ---
  if (action === "create_group") {
    const name = (req.body.group_name || "").trim();
    const color = (req.body.group_color || "#6366f1").trim();
    if (name) {
      await db.execute({
        sql: "INSERT INTO contact_groups (name, color) VALUES (?, ?)",
        args: [name, color],
      });
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
    }
    return { redirect: "/dashboard/contacts?view=groups" };
  }

  if (action === "delete_group" && req.body.group_id) {
    await db.execute({
      sql: "DELETE FROM contact_groups WHERE id = ?",
      args: [parseInt(req.body.group_id)],
    });
    return { redirect: "/dashboard/contacts?view=groups" };
  }

  if (action === "add_to_group" && req.body.group_id && req.body.contact_id) {
    try {
      await db.execute({
        sql: "INSERT OR IGNORE INTO contact_group_members (group_id, contact_id) VALUES (?, ?)",
        args: [parseInt(req.body.group_id), parseInt(req.body.contact_id)],
      });
    } catch {}
    const returnView = req.body.return_view || "contact";
    const returnContact = req.body.contact_id;
    return { redirect: `/dashboard/contacts?view=${returnView}&contact=${returnContact}` };
  }

  if (action === "remove_from_group" && req.body.group_id && req.body.contact_id) {
    await db.execute({
      sql: "DELETE FROM contact_group_members WHERE group_id = ? AND contact_id = ?",
      args: [parseInt(req.body.group_id), parseInt(req.body.contact_id)],
    });
    const returnView = req.body.return_view || "contact";
    const returnContact = req.body.contact_id;
    return { redirect: `/dashboard/contacts?view=${returnView}&contact=${returnContact}` };
  }

  // --- Own profile ---
  if (action === "save_profile") {
    if (req.body.display_name !== undefined) {
      await upsertSetting(db, "profile_display_name", req.body.display_name.trim());
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
        } catch (err) {
          console.warn("[contacts] Import error for", name, err.message);
        }
      }

      console.log(`[contacts] Imported ${imported} contacts from ${format}`);
    }

    return { redirect: "/dashboard/contacts" };
  }

  return null;
}
