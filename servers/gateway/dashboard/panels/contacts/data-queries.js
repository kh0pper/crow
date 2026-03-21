/**
 * Contacts Panel — Data Queries
 *
 * DB queries for contacts, groups, activity, and profile.
 */

import { escapeLikePattern } from "../../../../db.js";

/**
 * Get contacts with optional filters.
 * @param {object} db
 * @param {{ search?: string, groupId?: number, type?: string, limit?: number, offset?: number }} opts
 */
export async function getContacts(db, opts = {}) {
  const { search, groupId, type, limit = 100, offset = 0 } = opts;
  const args = [];
  const conditions = [];

  if (search) {
    conditions.push("(c.display_name LIKE ? OR c.email LIKE ? OR c.crow_id LIKE ?)");
    const pattern = `%${escapeLikePattern(search)}%`;
    args.push(pattern, pattern, pattern);
  }

  if (type && type !== "all") {
    conditions.push("c.contact_type = ?");
    args.push(type);
  }

  let joinClause = "";
  if (groupId) {
    joinClause = "INNER JOIN contact_group_members gm ON gm.contact_id = c.id AND gm.group_id = ?";
    args.unshift(groupId);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  args.push(limit, offset);

  const { rows } = await db.execute({
    sql: `SELECT c.*, GROUP_CONCAT(gm2.group_id) as group_ids
          FROM contacts c
          ${joinClause}
          LEFT JOIN contact_group_members gm2 ON gm2.contact_id = c.id
          ${where}
          GROUP BY c.id
          ORDER BY c.is_blocked ASC, c.display_name ASC, c.created_at DESC
          LIMIT ? OFFSET ?`,
    args,
  });

  return rows;
}

/**
 * Get a single contact by ID with group memberships.
 */
export async function getContact(db, id) {
  const { rows } = await db.execute({
    sql: `SELECT c.*,
            GROUP_CONCAT(gm.group_id) as group_ids,
            GROUP_CONCAT(g.name) as group_names
          FROM contacts c
          LEFT JOIN contact_group_members gm ON gm.contact_id = c.id
          LEFT JOIN contact_groups g ON g.id = gm.group_id
          WHERE c.id = ?
          GROUP BY c.id`,
    args: [id],
  });
  return rows[0] || null;
}

/**
 * Get recent activity for a contact (shared items + messages).
 */
export async function getContactActivity(db, contactId) {
  const activities = [];

  try {
    const { rows: shared } = await db.execute({
      sql: `SELECT 'share' as activity_type, share_type as detail, direction, created_at
            FROM shared_items WHERE contact_id = ?
            ORDER BY created_at DESC LIMIT 20`,
      args: [contactId],
    });
    activities.push(...shared);
  } catch {}

  try {
    const { rows: msgs } = await db.execute({
      sql: `SELECT 'message' as activity_type,
            SUBSTR(content, 1, 100) as detail, direction, created_at
            FROM messages WHERE contact_id = ?
            ORDER BY created_at DESC LIMIT 20`,
      args: [contactId],
    });
    activities.push(...msgs);
  } catch {}

  // Sort combined by date descending
  activities.sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
  return activities.slice(0, 30);
}

/**
 * Get all contact groups with member counts.
 */
export async function getGroups(db) {
  const { rows } = await db.execute(
    `SELECT g.*, COUNT(gm.id) as member_count
     FROM contact_groups g
     LEFT JOIN contact_group_members gm ON gm.group_id = g.id
     GROUP BY g.id
     ORDER BY g.sort_order ASC, g.name ASC`
  );
  return rows;
}

/**
 * Get own profile from dashboard_settings.
 */
export async function getMyProfile(db) {
  const keys = ["profile_display_name", "profile_avatar_url", "profile_bio"];
  const profile = {};
  try {
    const { rows } = await db.execute(
      `SELECT key, value FROM dashboard_settings WHERE key IN ('profile_display_name', 'profile_avatar_url', 'profile_bio')`
    );
    for (const row of rows) {
      const short = row.key.replace("profile_", "");
      profile[short] = row.value;
    }
  } catch {}
  return profile;
}
