/**
 * Crow-to-Crow owner side (plan 1, task 6; spec §9.1, §10).
 *
 * The owner's Crow:
 *   - invites a contact's Crow to a project at a role, re-invites (a new epoch),
 *     changes the role, and unshares;
 *   - receives the contact's `project.accept` / `project.decline` inside the receive
 *     pipeline's transaction (receive.js step 8, S7) and records the outcome.
 *
 * Everything the owner sends goes through the outbox (`enqueue`, Task 4), so a frame
 * is delivered at-least-once and in order per stream (S1). The membership row's
 * `uuid` IS the epoch every frame of that membership carries, and a re-invite mints
 * a fresh one — which is what makes a frame queued before the re-invite
 * unapplicable (`stale_epoch`, R4) without any reset logic.
 *
 * Transactions (S4, R7). Each action writes its membership row, its frame and its
 * audit row in ONE `withTransaction`, and flushes AFTER COMMIT, never inside. The
 * handlers, by contrast, are called by the pipeline INSIDE its transaction, so they
 * do DB work only: no send, no flush, and no notification fan-out either (W1). They
 * write the notification ROW with `deliver: false` and RETURN
 * `{ afterCommit }`, which the pipeline runs once the transaction has committed.
 *
 * Logs say `[c2c]` and never carry a frame body; audit rows carry refs only.
 */
import { randomBytes } from "node:crypto";
import { createNotification, deliverNotification } from "../../shared/notifications.js";
import {
  AclError, appendAudit, assertLocalCapability, assertProjectExists,
} from "../../shared/project-acl.js";
import { fill, t } from "../../gateway/dashboard/shared/i18n.js";
import { sanitizeDisplayName } from "../display-name.js";
import { isCbPinnedStrict, lookupPinnedContactKey } from "../contact-binding.js";
import { CONTACT_CAPS_JSON, memberRole } from "./authz.js";
import {
  cancelEpoch, enqueue, flush, nextInviteGeneration, withTransaction,
} from "./outbox.js";
import { ROLES as C2C_ROLES, buildFrame, parseFrame } from "./frames.js";

/** The Crow-to-Crow roles the owner may grant (frames.js owns the list, S2). */
export const CONTACT_ROLES = C2C_ROLES;

/**
 * The `project_members.role` each Crow-to-Crow role is stored as. The column's
 * CHECK allows owner|editor|viewer|guest, so a "commenter" is stored as `guest` and
 * read back through authz.js's `memberRole` (guest → commenter). Storing
 * "commenter" would violate the CHECK.
 */
const DB_ROLE = Object.freeze({ viewer: "viewer", commenter: "guest", editor: "editor" });

/** The longest project name an invite body may carry (frames.js caps it too). */
const INVITE_NAME_MAX = 200;

/** A fixed, valid envelope for the frames.js probe below. */
const PROBE_UUID = "0".repeat(32);

/** Every control character, wherever it sits (global: one pass removes them all). */
const CTRL = /[\u0000-\u001f\u007f]/g;

/**
 * Is `value` a usable instance id? frames.js owns the cap (its `ID_RE`) and does
 * not export the predicate, so ask it: build the smallest legal `project.accept`
 * around the value and parse it back. A `visitor_instance_id` becomes the routing
 * target of every later frame, so it is checked against exactly the rule the wire
 * enforces, not a copy of it.
 * @returns {boolean}
 */
function isValidInstanceId(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  return parseFrame(buildFrame({
    kind: "project.accept",
    projectUuid: PROBE_UUID,
    epoch: PROBE_UUID,
    seq: 1,
    fromInstanceId: PROBE_UUID,
    toInstanceId: null,
    body: { visitor_instance_id: value },
  })).ok;
}

/** Validate a Crow-to-Crow role and return the `project_members.role` to store. */
function requireRole(role) {
  const dbRole = DB_ROLE[role];
  if (!dbRole) throw new AclError(`unknown Crow-to-Crow role: ${String(role)}`, "bad_role");
  return dbRole;
}

/** `appendAudit`'s actor fields from a `"local"` string or an `{type, id}` object. */
function actorOf(actor) {
  if (actor && typeof actor === "object") {
    return { actor_type: String(actor.type ?? "local"), actor_id: actor.id ?? null };
  }
  return { actor_type: typeof actor === "string" && actor ? actor : "local", actor_id: null };
}

/**
 * The project name as an invite body may carry it: well-formed, no control
 * characters, single-spaced, at most `INVITE_NAME_MAX` UTF-16 units. `enqueue`
 * refuses a frame `parseFrame` cannot read back, so a name that violates the wire
 * rule is normalised here rather than turning into a failed invite.
 *
 * The cap counts UTF-16 units, exactly as frames.js's `isText` does (`x.length`), and
 * whole code points are added while they still fit, so the cut can never split a
 * surrogate pair (a lone half would fail `isWellFormed` on the wire).
 */
function inviteNameOf(project) {
  const s = String(project?.name ?? "").toWellFormed()
    .replace(CTRL, "")
    .replace(/\s+/g, " ")
    .trim();
  let name = "";
  for (const cp of s) {
    if (name.length + cp.length > INVITE_NAME_MAX) break;
    name += cp;
  }
  if (!name) throw new AclError(`Project #${project?.id} has no name to send`, "bad_state");
  return name;
}

/** The project's instance-independent uuid (every frame names the project by it). */
async function projectUuidOf(db, projectId) {
  const { rows } = await db.execute({
    sql: "SELECT uuid FROM project_spaces WHERE id = ? LIMIT 1",
    args: [projectId],
  });
  const uuid = rows[0]?.uuid;
  if (typeof uuid !== "string" || !uuid) {
    throw new AclError(`Project #${projectId} has no uuid to address frames with`, "bad_state");
  }
  return uuid;
}

/** A full, unblocked contact, or null. */
async function contactRowOf(db, contactId) {
  const { rows } = await db.execute({
    sql: `SELECT id, crow_id, display_name FROM contacts
           WHERE id = ? AND is_blocked = 0 LIMIT 1`,
    args: [contactId],
  });
  return rows[0] ?? null;
}

/**
 * The contact's ACTIVE membership row of the project, whatever its mode
 * (`revoked_at IS NULL`). At most one exists (init-db's partial unique index).
 */
async function activeRowOf(db, { projectId, contactId }) {
  const { rows } = await db.execute({
    sql: `SELECT * FROM project_members
           WHERE project_id = ? AND contact_id = ? AND revoked_at IS NULL
           ORDER BY id DESC LIMIT 1`,
    args: [projectId, contactId],
  });
  return rows[0] ?? null;
}

/**
 * The contact's ACTIVE Crow-to-Crow membership of the project: `mode='live'` and
 * not revoked (a `clone` row is the old one-time copy share, not a live
 * membership — spec §9.1).
 */
async function liveRowOf(db, { projectId, contactId }) {
  const { rows } = await db.execute({
    sql: `SELECT * FROM project_members
           WHERE project_id = ? AND contact_id = ?
             AND mode = 'live' AND revoked_at IS NULL
           ORDER BY id DESC LIMIT 1`,
    args: [projectId, contactId],
  });
  return rows[0] ?? null;
}

/**
 * S4: the flush runs AFTER COMMIT, never inside the transaction.
 *
 * `send` is the shape boot.js builds for the outbox flush — a per-contact send,
 * `(frame) => peerManager.send(crowId, frame)`. `flushAfter` is the optional
 * control: a function replaces the flush itself (a caller that owns its own tick,
 * or a test that only wants to know WHEN the flush ran), and `false` opts out even
 * when a `send` was given. With neither, the frame stays queued and boot.js's 60 s
 * tick sends it; a flush failure never fails the membership change, which is
 * already committed.
 * @returns {Promise<number>} frames sent
 */
async function flushAfterCommit(db, { contactId, send, flushAfter }) {
  try {
    if (typeof flushAfter === "function") return await flushAfter({ contactId });
    if (flushAfter === false) return 0;
    if (typeof send !== "function") return 0;
    return await flush(db, send, { contactId });
  } catch (err) {
    console.warn(`[c2c] flush after a membership change failed: ${err?.message || err}`);
    return 0;
  }
}

/**
 * Write the membership row of an invite, in the caller's transaction: an ACTIVE
 * row (clone, subscription or an earlier live membership) is converted IN PLACE to
 * `mode='live'` with the new epoch, role and capability mask, and its acceptance
 * cleared; anything else gets a fresh row.
 *
 * The fresh `uuid` is the membership's epoch: every frame of the new membership
 * carries it, so every frame of the old one is `stale_epoch` (S1, R4). Clearing
 * `accepted_at` / `origin_instance_id` is what makes "no rights before accept" true
 * — the authorization rule allows only accept/decline until the visitor answers.
 *
 * @returns {Promise<number>} the member row's id
 */
async function writeInviteRow(db, { projectId, contactId, epoch, dbRole }) {
  // ANY active row, whatever its mode: a clone row converts to live in place
  // (review focus 4) and the partial unique index forbids a second active row.
  const active = await activeRowOf(db, { projectId, contactId });
  if (active) {
    await db.execute({
      sql: `UPDATE project_members
               SET uuid = ?, role = ?, capabilities = ?, mode = 'live',
                   accepted_at = NULL, origin_instance_id = NULL
             WHERE id = ?`,
      args: [epoch, dbRole, CONTACT_CAPS_JSON, active.id],
    });
    return Number(active.id);
  }
  const r = await db.execute({
    sql: `INSERT INTO project_members (project_id, contact_id, role, capabilities, mode, uuid)
          VALUES (?, ?, ?, ?, 'live', ?)`,
    args: [projectId, contactId, dbRole, CONTACT_CAPS_JSON, epoch],
  });
  return Number(r.lastInsertRowid);
}

/**
 * Invite a contact's Crow to a project (plan 1, task 6).
 *
 * One transaction does all of it (S4): the membership row with a fresh epoch, the
 * cancellation of the previous membership's queued frames (S6, an optimisation
 * only), the next invite generation (S2), the `project.invite` frame on the `"*"`
 * stream (the visitor's instance is not known yet, S1) and the audit row. The
 * flush runs after COMMIT.
 *
 * The contact must be bound on BOTH counts (O4): a pinned Ed25519 key
 * (`lookupPinnedContactKey`) and this instance's PT-3 pin (`contact_hs_cb:<crow_id>`
 * ≥ 1), else nothing is written and `contact_not_bound` is thrown.
 *
 * W3: the local caller must be allowed to manage members
 * (`assertLocalCapability(db, projectId, "manage_members")`), exactly like every
 * other member mutation. W5: the pin is read with the STRICT variant, so a failed
 * read refuses (`contact_not_bound`) instead of admitting the invite.
 *
 * @param {object} db
 * @param {{projectId:number, contactId:number, role:"viewer"|"commenter"|"editor",
 *   localInstanceId:string, actor?:string|{type:string,id?:any}, now?:number,
 *   send?:Function, flushAfter?:Function}} opts
 *   `send`/`flushAfter`: see `flushAfterCommit`. `now` is `nextInviteGeneration`'s
 *   clock seam.
 * @returns {Promise<{memberUuid:string}>} the new membership epoch
 * @throws {AclError} `contact_not_found`, `contact_not_bound`, `bad_role`,
 *   `missing_capability`/`not_member`, `not_found`/`archived` for the project
 */
export async function inviteContact(db, {
  projectId, contactId, role, localInstanceId, actor = "local", now, send = null, flushAfter = null,
} = {}) {
  await assertLocalCapability(db, projectId, "manage_members");
  const dbRole = requireRole(role);
  if (!isValidInstanceId(localInstanceId)) {
    throw new AclError("inviteContact needs this instance's own id", "bad_instance_id");
  }
  const project = await assertProjectExists(db, projectId);
  const projectUuid = await projectUuidOf(db, projectId);

  const contact = await contactRowOf(db, contactId);
  if (!contact) throw new AclError("contact_not_found", "not_found");
  // O4: a Crow-to-Crow invite goes only to a Crow that has proved the bound key on
  // this instance. The key alone is not enough: the PT-3 pin is what says the
  // contact's CURRENT Crow can complete a bound handshake. W5: the pin is read with
  // the strict variant, which is false on a read error (isCbPinned fails closed the
  // other way — it admits on an unreadable pin — which would be fail OPEN here).
  const pinnedKey = await lookupPinnedContactKey(db, contact.crow_id);
  const pinned = pinnedKey ? await isCbPinnedStrict(db, localInstanceId, contact.crow_id) : false;
  if (!pinned) throw new AclError("contact_not_bound", "contact_not_bound");

  const name = inviteNameOf(project);
  const epoch = randomBytes(16).toString("hex");

  const memberUuid = await withTransaction(db, async () => {
    await writeInviteRow(db, { projectId, contactId, epoch, dbRole });
    // S6: the previous membership's still-queued frames are dead weight for the
    // peer; correctness never depends on this (S1/R4 refuse them anyway).
    await cancelEpoch(db, { contactId, projectUuid, keepEpoch: epoch });
    const gen = await nextInviteGeneration(db, projectUuid, now === undefined ? {} : { now });
    await enqueue(db, {
      contactId,
      projectUuid,
      kind: "project.invite",
      epoch,
      toInstanceId: null, // S1: the visitor's instance is not known yet
      body: { name, role, owner_instance_id: localInstanceId, gen },
      localInstanceId,
    });
    await appendAudit(db, {
      project_id: projectId,
      ...actorOf(actor),
      action: "c2c_invited",
      target: `contact:${contactId}`,
      payload: { member_uuid: epoch, role },
    });
    return epoch;
  });

  await flushAfterCommit(db, { contactId, send, flushAfter });
  return { memberUuid };
}

/**
 * Change the role of an accepted member (plan 1, task 6).
 *
 * One transaction writes the row, the `project.role` frame (current epoch, aimed at
 * the instance that accepted, S1) and the audit row; the flush runs after COMMIT.
 * The frame carries the Crow-to-Crow role, so the visitor side can apply it without
 * knowing the `guest`/`commenter` mapping.
 *
 * A member that has not accepted yet cannot be retargeted — its
 * `origin_instance_id` is null, and a null target is only legal for an invite and
 * an unshare (S1), so that is `not_accepted` rather than a frame the receiver would
 * refuse `not_home`.
 *
 * @param {object} db
 * @param {{projectId:number, contactId:number, role:"viewer"|"commenter"|"editor",
 *   localInstanceId:string, actor?:string|{type:string,id?:any},
 *   send?:Function, flushAfter?:Function}} opts
 * @returns {Promise<{memberUuid:string, seq:number}>}
 * @throws {AclError} `not_member`, `not_accepted`, `bad_role`, `missing_capability`
 */
export async function setRole(db, {
  projectId, contactId, role, localInstanceId, actor = "local", send = null, flushAfter = null,
} = {}) {
  await assertLocalCapability(db, projectId, "manage_members"); // W3: same gate as the panel
  const dbRole = requireRole(role);
  if (!isValidInstanceId(localInstanceId)) {
    throw new AclError("setRole needs this instance's own id", "bad_instance_id");
  }
  const projectUuid = await projectUuidOf(db, projectId);

  const out = await withTransaction(db, async () => {
    const member = await liveRowOf(db, { projectId, contactId });
    if (!member) throw new AclError("not a live member of this project", "not_member");
    if (!member.accepted_at || !member.origin_instance_id) {
      throw new AclError("the contact has not accepted the invitation yet", "not_accepted");
    }
    await db.execute({
      sql: "UPDATE project_members SET role = ? WHERE id = ?",
      args: [dbRole, member.id],
    });
    const seq = await enqueue(db, {
      contactId,
      projectUuid,
      kind: "project.role",
      epoch: member.uuid,
      toInstanceId: member.origin_instance_id,
      body: { role },
      localInstanceId,
    });
    await appendAudit(db, {
      project_id: projectId,
      ...actorOf(actor),
      action: "c2c_role",
      target: `contact:${contactId}`,
      payload: { member_uuid: member.uuid, role },
    });
    return { memberUuid: member.uuid, seq };
  });

  await flushAfterCommit(db, { contactId, send, flushAfter });
  return out;
}

/**
 * Unshare a member (plan 1, task 6): revoke the row and tell the visitor's Crow.
 *
 * One transaction writes the revoke, the `project.unshare` frame and the audit row;
 * the flush runs after COMMIT. The frame carries the PRE-revoke epoch, so it names
 * the membership it ends, and it is aimed at the instance that accepted — or at
 * nobody (`"*"`, S1) when the member never accepted and so never had an instance
 * (O2, the routing rule in receive.js allows a null target for an unshare too).
 *
 * Frames already queued for that member stay queued: the visitor refuses them
 * `stale_epoch` (the epoch is now revoked) or `forbidden` (no live row left), which
 * is exactly the answer the contract wants (R4 consumes their seq).
 *
 * @param {object} db
 * @param {{projectId:number, contactId:number, localInstanceId:string,
 *   actor?:string|{type:string,id?:any}, send?:Function, flushAfter?:Function}} opts
 * @returns {Promise<{memberUuid:string, seq:number}>}
 * @throws {AclError} `not_member`, `missing_capability`
 */
export async function unshareContact(db, {
  projectId, contactId, localInstanceId, actor = "local", send = null, flushAfter = null,
} = {}) {
  await assertLocalCapability(db, projectId, "manage_members"); // W3: same gate as the panel
  if (!isValidInstanceId(localInstanceId)) {
    throw new AclError("unshareContact needs this instance's own id", "bad_instance_id");
  }
  const projectUuid = await projectUuidOf(db, projectId);

  const out = await withTransaction(db, async () => {
    const member = await liveRowOf(db, { projectId, contactId });
    if (!member) throw new AclError("not a live member of this project", "not_member");
    const epoch = member.uuid; // the pre-revoke epoch the frame names
    const target = member.origin_instance_id ?? null; // null: never accepted (S1/O2)
    await db.execute({
      sql: "UPDATE project_members SET revoked_at = datetime('now') WHERE id = ?",
      args: [member.id],
    });
    const seq = await enqueue(db, {
      contactId,
      projectUuid,
      kind: "project.unshare",
      epoch,
      toInstanceId: target,
      body: {},
      localInstanceId,
    });
    await appendAudit(db, {
      project_id: projectId,
      ...actorOf(actor),
      action: "c2c_unshared",
      target: `contact:${contactId}`,
      payload: { member_uuid: epoch },
    });
    return { memberUuid: epoch, seq };
  });

  await flushAfterCommit(db, { contactId, send, flushAfter });
  return out;
}

/**
 * `listLiveMembers(db, projectId)` — the owner's Members area reads this (task 7).
 *
 * `role` is the Crow-to-Crow role (guest is shown as `commenter`, via
 * `memberRole`), `state` is `invited` until the contact's Crow accepts, and
 * `updateRequired` mirrors the per-contact `c2c_update_required:<crow_id>` flag the
 * receive pipeline writes when a contact's Crow is still on the legacy proof (R5,
 * S10).
 *
 * The flag is local and per instance (`dashboard_settings_overrides`), so any row
 * for that key counts: a sibling instance that saw the legacy proof is just as good
 * a reason to ask them to update. A missing table (an old DB) means "no flag".
 *
 * @returns {Promise<Array<{contactId:number, displayName:string,
 *   role:"viewer"|"commenter"|"editor"|null, state:"invited"|"active",
 *   updateRequired:boolean}>>}
 */
export async function listLiveMembers(db, projectId) {
  const { rows } = await db.execute({
    sql: `SELECT pm.id, pm.contact_id, pm.role, pm.accepted_at, pm.uuid,
                 c.crow_id, c.display_name
            FROM project_members pm
            LEFT JOIN contacts c ON c.id = pm.contact_id
           WHERE pm.project_id = ? AND pm.contact_id IS NOT NULL
             AND pm.mode = 'live' AND pm.revoked_at IS NULL
           ORDER BY pm.id`,
    args: [projectId],
  });
  const out = [];
  for (const row of rows) {
    out.push({
      contactId: Number(row.contact_id),
      displayName: sanitizeDisplayName(row.display_name) ?? row.crow_id ?? "",
      role: memberRole(row),
      state: row.accepted_at ? "active" : "invited",
      updateRequired: await updateRequiredFor(db, row.crow_id),
    });
  }
  return out;
}

/** Mirrors `C2C_UPDATE_REQUIRED_PREFIX` in receive.js (importing it would cycle). */
const UPDATE_REQUIRED_PREFIX = "c2c_update_required:";

/** The receive pipeline's legacy-proof marker for one contact (R5, S10). */
async function updateRequiredFor(db, crowId) {
  if (typeof crowId !== "string" || !crowId) return false;
  try {
    const { rows } = await db.execute({
      sql: "SELECT 1 AS present FROM dashboard_settings_overrides WHERE key = ? LIMIT 1",
      args: [UPDATE_REQUIRED_PREFIX + crowId],
    });
    return rows.length > 0;
  } catch {
    return false; // an old DB without the local settings table has no flags
  }
}

/**
 * The contact's display name and the project's name, as a notification may show
 * them: both are remote- or owner-chosen text that lands in a stored, pushed
 * notification title, so both go through `sanitizeDisplayName` (controls and bidi
 * overrides stripped, identity-string prefixes refused, 64 code points). A name the
 * sanitiser rejects falls back to a neutral label rather than to an empty title.
 */
async function namesOf(db, member) {
  let displayName = "";
  let projectName = member?.project_name ?? "";
  try {
    const { rows } = await db.execute({
      sql: `SELECT c.display_name, ps.name AS project_name
              FROM project_members pm
              LEFT JOIN contacts c ON c.id = pm.contact_id
              LEFT JOIN project_spaces ps ON ps.id = pm.project_id
             WHERE pm.id = ? LIMIT 1`,
      args: [member.id],
    });
    displayName = rows[0]?.display_name ?? displayName;
    projectName = rows[0]?.project_name ?? projectName;
  } catch (err) {
    console.warn(`[c2c] could not read the names for a notification: ${err?.message || err}`);
  }
  return {
    contact: sanitizeDisplayName(displayName) ?? t("c2c.notify.someone"),
    project: sanitizeDisplayName(projectName) ?? t("c2c.notify.aProject"),
  };
}

/**
 * One notification ROW, written inside the caller's transaction (the plan's O3,
 * W1/R7): the shared helper is asked for `deliver: false`, so no push, ntfy call or
 * email happens while the frame's transaction holds the handle's write lock.
 *
 * Returns the `afterCommit` hook the receive pipeline runs once COMMIT succeeded
 * (after the ack, and after the flush when there is one). The hook hands the exact
 * payload the helper would have fanned out (`note.delivery`) to
 * `deliverNotification`. `deliver` is the fan-out seam tests inject; the default is
 * the real one.
 *
 * Never throws: a notification is not the effect, and the handler's transaction
 * must not fail because a push channel or the settings table is missing. A row the
 * type gate drops (null) means there is nothing to deliver.
 *
 * The title comes from i18n (en + es, `c2c.notify.*`) with the two names
 * interpolated; like every server-side notification it is stored in English (the
 * dashboard translates its own UI, a stored row has no language). Nothing else of
 * the frame is used — never a body beyond those two names.
 * @returns {Promise<Function|null>} the afterCommit hook, or null
 */
async function safeNotify(db, { title, source }, deliver = null) {
  try {
    const note = await createNotification(db, {
      title,
      type: "peer",
      source,
      action_url: "/dashboard/projects",
      deliver: false, // W1/R7: the row here, the fan-out after COMMIT
    });
    if (!note) return null; // the notification type is switched off: nothing to deliver
    const fanOut = typeof deliver === "function" ? deliver : deliverNotification;
    return async () => { await fanOut(db, note.delivery); };
  } catch (err) {
    console.warn(`[c2c] notification failed: ${err?.message || err}`);
    return null;
  }
}

/**
 * Build the owner's handler map for the receive pipeline's `ctx.handlers`
 * (`boot.js`'s `createC2cHandlerLoader` merges the module's exports, so the module
 * also exports `onAccept` / `onDecline` directly).
 *
 * These run INSIDE the pipeline's transaction (S7) and must do DB work only: no
 * send, no flush, no notification fan-out. A handler that notifies writes the ROW
 * here (with `deliver: false`) and RETURNS `{ afterCommit }`, which the pipeline
 * runs after COMMIT (S7/W1) — so a rolled-back accept leaves no notification
 * behind and nothing is pushed while the write lock is held.
 *
 * `notify` is the row-writing seam (tests inject a spy that records the title and
 * returns nothing); `deliver` is the fan-out seam the returned hook uses. The
 * default is the shared notification helper and `deliverNotification`.
 *
 * @param {{notify?: Function, deliver?: Function}} [opts]
 * @returns {{onAccept: Function, onDecline: Function}}
 */
export function createOwnerHandlers({ notify = null, deliver = null } = {}) {
  const notifier = notify ?? ((db, opts) => safeNotify(db, opts, deliver));

  /**
   * The handler's return: only a real hook becomes one, so a stub notifier (or a
   * notification the type gate dropped) simply has nothing to run.
   */
  const afterCommitOf = (hook) => (typeof hook === "function" ? { afterCommit: hook } : undefined);

  /**
   * `project.accept`: the member's Crow said yes from `visitor_instance_id`, which
   * becomes the target of every later frame of this membership (S1). The instance
   * id is validated against frames.js's own cap — it is about to steer routing.
   *
   * A throw is the pipeline's failure path (S5): the accept rolls back with the
   * seq's mark, the seq is consumed and the frame is refused `unsupported`.
   * Otherwise it RETURNS `{ afterCommit }` (S7/W1): the notification row is already
   * written, and that hook is what announces the acceptance once COMMIT lands.
   */
  async function onAccept(db, { member, frame } = {}) {
    if (!member) throw new AclError("accept without a membership", "forbidden");
    const visitorInstanceId = frame?.body?.visitor_instance_id;
    if (!isValidInstanceId(visitorInstanceId)) {
      throw new AclError("accept carries no usable visitor instance id", "bad_frame");
    }
    const r = await db.execute({
      sql: `UPDATE project_members
               SET accepted_at = datetime('now'), origin_instance_id = ?
             WHERE id = ? AND accepted_at IS NULL`,
      args: [visitorInstanceId, member.id],
    });
    if (Number(r.rowsAffected ?? 0) === 0) return; // already announced: no second notification
    const names = await namesOf(db, member);
    return afterCommitOf(await notifier(db, {
      title: fill(t("c2c.notify.joined"), names),
      source: "sharing:c2c_accept",
    }));
  }

  /**
   * `project.decline`: `{reason:"declined"}` (or no reason) ends the pending
   * invitation quietly; `{reason:"left"}` ends an accepted membership and says so
   * once. Both revoke the row, which is what takes the member's rights away (no
   * live row → every later frame is `forbidden`). A `left` RETURNS
   * `{ afterCommit }` for its one notification (S7/W1); a plain decline announces
   * nothing and returns nothing.
   */
  async function onDecline(db, { member, frame } = {}) {
    if (!member) throw new AclError("decline without a membership", "forbidden");
    const left = frame?.body?.reason === "left";
    const r = await db.execute({
      sql: `UPDATE project_members SET revoked_at = datetime('now')
             WHERE id = ? AND revoked_at IS NULL`,
      args: [member.id],
    });
    if (!left || Number(r.rowsAffected ?? 0) === 0) return;
    const names = await namesOf(db, member);
    return afterCommitOf(await notifier(db, {
      title: fill(t("c2c.notify.left"), names),
      source: "sharing:c2c_left",
    }));
  }

  return { onAccept, onDecline };
}

const defaultHandlers = createOwnerHandlers();

/** The receive pipeline's handler for `project.accept` (real notification helper). */
export const onAccept = defaultHandlers.onAccept;
/** The receive pipeline's handler for `project.decline`. */
export const onDecline = defaultHandlers.onDecline;