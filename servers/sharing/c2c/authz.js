/**
 * Crow-to-Crow per-frame authorization (plan 1, task 5; spec §5.1, §9.1).
 *
 * Two sides, two rulesets:
 *   - the owner side receives `project.accept` / `project.decline` and checks
 *     the live membership row in `project_members` (mode='live', not revoked);
 *   - the visitor side receives `project.invite` / `project.role` /
 *     `project.unshare` and checks the local `c2c_visits` row, judging invites
 *     by the outbox contract's invite generation (S2), never by a state list.
 *
 * Membership is never cached on the session: every frame re-reads the row, so an
 * unshare or a role change takes effect on a live connection. Logs never carry
 * frame bodies (contact text).
 */
import { CAPABILITY_KEYS } from "../../shared/project-acl.js";
import { inviteSupersedes } from "./outbox.js";

/** Contact members' MCP capability mask: every key false (spec §9). */
export const CONTACT_CAPS_JSON = JSON.stringify(
  Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, false])),
);

// Crow-to-Crow rights come only from here, never from the MCP capability mask.
const ACTIONS_BY_ROLE = Object.freeze({
  viewer: new Set(["read"]),
  commenter: new Set(["read", "comment"]),
  editor: new Set(["read", "comment", "propose", "add"]),
});

/**
 * Can `role` do `action`? Actions are read|comment|propose|add: a viewer reads,
 * a commenter reads and comments, an editor does all four.
 * @returns {boolean}
 */
export function c2cCan(role, action) {
  return ACTIONS_BY_ROLE[role]?.has(action) ?? false;
}

/**
 * Map a `project_members.role` to a Crow-to-Crow role: viewer→viewer,
 * guest→commenter, editor→editor. Anything else (owner, unknown) has no
 * Crow-to-Crow role and gets null.
 * @returns {"viewer"|"commenter"|"editor"|null}
 */
export function memberRole(row) {
  switch (row?.role) {
    case "viewer": return "viewer";
    case "guest": return "commenter";
    case "editor": return "editor";
    default: return null;
  }
}

/**
 * The active live membership of `contactId` on the project with `projectUuid`,
 * or null. mode='clone' rows (the old one-time copy shares) are deliberately not
 * live authorizations (spec §9.1); neither are revoked rows.
 *
 * @returns {Promise<object|null>} the member row, with `project_uuid`,
 *   `project_name` and the row's own `uuid` (the membership epoch)
 */
export async function liveMember(db, { projectUuid, contactId }) {
  const { rows } = await db.execute({
    sql: `SELECT pm.*, ps.uuid AS project_uuid, ps.name AS project_name, ps.slug AS project_slug
            FROM project_members pm
            JOIN project_spaces ps ON ps.id = pm.project_id
           WHERE ps.uuid = ? AND pm.contact_id = ?
             AND pm.mode = 'live' AND pm.revoked_at IS NULL
           ORDER BY pm.id DESC LIMIT 1`,
    args: [projectUuid, contactId],
  });
  return rows[0] ?? null;
}

/**
 * Owner-side rule for a frame from a contact: accept/decline (and, in later
 * plans, the owner-side kinds that follow) against the live membership.
 *
 *   - no live row → `forbidden`;
 *   - `frame.epoch !== member.uuid` → `stale_epoch` (a frame queued before an
 *     unshare/re-invite or a role change keeps the old epoch, spec §9.1);
 *   - accept/decline need `accepted_at IS NULL`; decline `{reason:"left"}` is the
 *     exception (it ends an accepted membership);
 *   - every other kind needs `accepted_at` set.
 *
 * @returns {Promise<{ok:true, member:object}|{ok:false, reason:"forbidden"|"stale_epoch"}>}
 */
export async function authorizeOwnerFrame(db, { frame, contactId }) {
  const member = await liveMember(db, { projectUuid: frame.project_uuid, contactId });
  if (!member) return { ok: false, reason: "forbidden" };
  if (frame.epoch !== member.uuid) return { ok: false, reason: "stale_epoch" };

  const accepted = Boolean(member.accepted_at);
  const inviteOnly = frame.kind === "project.accept"
    || (frame.kind === "project.decline" && frame.body?.reason !== "left");
  if (inviteOnly) {
    if (accepted) return { ok: false, reason: "forbidden" };
  } else if (!accepted) {
    return { ok: false, reason: "forbidden" };
  }
  return { ok: true, member };
}

/**
 * Visitor-side rule for a frame from the owner contact: the local visit row for
 * (owner contact, project uuid). An invite is judged by the outbox contract's
 * `inviteSupersedes` (S2: the generation, not a visit state), so a newer invite
 * replaces an active visit and an old one overtaking it is `stale_epoch`.
 * Every other kind needs `visit.epoch === frame.epoch`; a missing visit, or an
 * epoch mismatch, gives `stale_epoch`/`forbidden` as below.
 *
 * @returns {Promise<{ok:true, visit:object}|{ok:false, visit:object|null, reason:"forbidden"|"stale_epoch"}>}
 */
export async function authorizeVisitorFrame(db, { frame, contactId }) {
  const { rows } = await db.execute({
    sql: `SELECT * FROM c2c_visits
           WHERE owner_contact_id = ? AND project_uuid = ?
           ORDER BY id DESC LIMIT 1`,
    args: [contactId, frame.project_uuid],
  });
  const visit = rows[0] ?? null;

  if (frame.kind === "project.invite") {
    if (!inviteSupersedes(visit, frame)) return { ok: false, visit, reason: "stale_epoch" };
    return { ok: true, visit };
  }
  if (!visit) return { ok: false, visit: null, reason: "forbidden" };
  if (visit.epoch !== frame.epoch) return { ok: false, visit, reason: "stale_epoch" };
  return { ok: true, visit };
}