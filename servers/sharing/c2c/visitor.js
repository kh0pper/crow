/**
 * Crow-to-Crow visitor side (plan 1, task 7; spec §5.2, §9.1, §10 Q15).
 *
 * The visitor's Crow:
 *   - receives `project.invite` / `project.role` / `project.unshare` inside the
 *     receive pipeline's transaction (receive.js step 8, S7) and keeps ONE local
 *     `c2c_visits` row per (owner contact, project uuid) — never a `project_spaces`
 *     clone, so a visit can never be mistaken for a project this Crow owns;
 *   - answers an invitation (`project.accept` / `project.decline`) through the
 *     outbox (Task 4), so the answer is delivered at-least-once and in order.
 *
 * Mirror of owner.js, and it follows the same rules:
 *   - the handlers run INSIDE the pipeline's transaction and do DB work only. A
 *     handler that notifies writes its ROW there through the shared helper with
 *     `deliver: false` and RETURNS `{ afterCommit }`, which the pipeline runs once
 *     COMMIT landed (S7/W1). Nothing is pushed or mailed while the write lock is
 *     held, and a rolled-back frame leaves no notification behind;
 *   - the three ACTIONS each write their state change and their frame in ONE
 *     `withTransaction`, and flush AFTER COMMIT, never inside (S4).
 *
 * Roles. `c2c_visits.role` speaks the Crow-to-Crow vocabulary
 * (`viewer|commenter|editor`, frames.js `ROLES`), which is exactly what
 * `c2cCan(role, action)` and `memberRole` speak, so the visitor stores the role the
 * invite carried and never the owner's `project_members` spelling (`guest`). A role
 * change KEEPS the epoch (contract S7), so nothing may cache a role: plan 2 asks
 * `c2cCan` on every frame with the role read in that frame's own transaction.
 *
 * Caller authorization (V3). The three actions below are the LOCAL OPERATOR's, not
 * a frame's: the dashboard routes that call them (task 7 part B) sit behind
 * dashboardAuth after CSRF, and that is the whole gate. There is no project ACL to
 * consult, because a visit is not a local project — there is no `project_spaces`
 * row and no local `project_members` row for it. Nothing here takes the owner or
 * the project from a caller-supplied field: the caller names a `visitId` it read
 * from `listVisits`, and only a local operator can reach that list.
 *
 * Logs say `[c2c]` and never carry a frame body (it is the contact's text).
 */
import { createNotification, deliverNotification } from "../../shared/notifications.js";
import { fill, t } from "../../gateway/dashboard/shared/i18n.js";
import { sanitizeDisplayName } from "../display-name.js";
import { WILDCARD_STREAM, enqueue, flush, inTransaction, withTransaction } from "./outbox.js";
import { ROLES, buildFrame, parseFrame } from "./frames.js";

/** The `c2c_visits.state` values the actions accept as their starting point. */
const START = Object.freeze({ accept: "invited", decline: "invited", leave: "active" });

/** The two refusals that mean the membership a frame named is gone (X2). */
const ENDING_REFUSALS = new Set(["forbidden", "stale_epoch"]);

/** The answers a visit sends: a refusal of either one of OURS ends the visit (X2). */
const ANSWER_KINDS = new Set(["project.accept", "project.decline"]);

/**
 * A refused visit operation: a state a visit is not in, an unusable instance id, a
 * role outside `viewer|commenter|editor`. `code` is the stable handle (the routes
 * map it to a status), the message is for the log and the operator.
 */
export class VisitError extends Error {
  constructor(message, code = "bad_state") {
    super(message);
    this.name = "VisitError";
    this.code = code;
  }
}

/** A fixed, valid envelope for the frames.js probe below. */
const PROBE_UUID = "0".repeat(32);

/**
 * Is `value` a usable instance id? frames.js owns the cap (its `ID_RE`) and does
 * not export the predicate, so ask it: build the smallest legal `project.accept`
 * around the value and parse it back. This instance's own id becomes the routing
 * target of every answer the owner sends back, and the `from_instance_id` of the
 * answers we send, so it is checked against exactly the rule the wire enforces.
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

/**
 * Validate a Crow-to-Crow role. The visitor stores the vocabulary frames.js and
 * `c2cCan` use, so there is no `guest`/`commenter` mapping on this side.
 * @returns {"viewer"|"commenter"|"editor"}
 */
function requireRole(role) {
  if (!ROLES.includes(role)) throw new VisitError(`unknown Crow-to-Crow role: ${String(role)}`, "bad_role");
  return role;
}

/** The visit row with this id, or null. */
async function visitRowOf(db, visitId) {
  const { rows } = await db.execute({
    sql: "SELECT * FROM c2c_visits WHERE id = ? LIMIT 1",
    args: [visitId],
  });
  return rows[0] ?? null;
}

/**
 * S4: the flush runs AFTER COMMIT, never inside the transaction.
 *
 * `send` is the shape boot.js builds for the outbox flush — a per-contact send,
 * `(frame) => peerManager.send(crowId, frame)`, here bound to the OWNER contact's
 * crow id. `flushAfter` is the optional control: a function replaces the flush
 * itself (a caller that owns its own tick, or a test that only wants to know WHEN
 * the flush ran), and `false` opts out even when a `send` was given. With neither,
 * the answer stays queued and boot.js's 60 s tick sends it; a flush failure never
 * fails the visit change, which is already committed.
 * @returns {Promise<number>} frames sent
 */
async function flushAfterCommit(db, { contactId, send, flushAfter }) {
  try {
    if (typeof flushAfter === "function") return await flushAfter({ contactId });
    if (flushAfter === false) return 0;
    if (typeof send !== "function") return 0;
    return await flush(db, send, { contactId });
  } catch (err) {
    console.warn(`[c2c] flush after a visit change failed: ${err?.message || err}`);
    return 0;
  }
}

/**
 * Plan 2 fills this in (spec §9 "Cleanup"): the visitor deletes that project's
 * drafts, its proposal states and the read-only snapshots it holds.
 *
 * A no-op in plan 1 — nothing is shared yet, so a visit has nothing to delete — and
 * exported so plan 2 can put the work here. The plan-2 version purges on all four
 * ways a visit ends or is replaced: LEAVE (`leaveVisit`), UNSHARE (`onUnshare`),
 * SUPERSEDE (a newer invite replacing an active visit, `onInvite`) and REFUSAL (our
 * accept/decline was refused `forbidden`/`stale_epoch`, `onRefusal`). Every call site
 * wraps it in try/catch: the state change is the effect that must land, and a
 * cleanup that threw would roll it back and lose it.
 *
 * It is called INSIDE the frame's transaction, so the real version must do DB work
 * only (no file or network I/O while the handle's write lock is held, R7).
 * @param {object} _visit the `c2c_visits` row being ended
 */
export async function deleteLocalCopies(_visit) {
  // Nothing to delete in plan 1.
}

/**
 * The owner contact's name, as a notification title may show it: a remote-chosen
 * string that lands in a stored, pushed notification, so it goes through
 * `sanitizeDisplayName` (controls and bidi overrides stripped, identity-string
 * prefixes refused, 64 code points). A name the sanitiser rejects falls back to a
 * neutral label rather than to an empty title.
 * @returns {Promise<string>}
 */
async function ownerNameOf(db, contactId) {
  try {
    const { rows } = await db.execute({
      sql: "SELECT display_name, crow_id FROM contacts WHERE id = ? LIMIT 1",
      args: [contactId],
    });
    return sanitizeDisplayName(rows[0]?.display_name)
      ?? sanitizeDisplayName(rows[0]?.crow_id)
      ?? t("c2c.notify.someone");
  } catch (err) {
    console.warn(`[c2c] could not read the owner's name for a notification: ${err?.message || err}`);
    return t("c2c.notify.someone");
  }
}

/**
 * Both names a visit notification shows: the owner contact's (from our own contacts
 * table) and the project's (the name the owner's invite carried, stored in the
 * visit). The project name is REMOTE text, so it is sanitized exactly like the
 * contact name, and a name the sanitiser rejects becomes a neutral label.
 * @returns {Promise<{contact:string, project:string}>}
 */
async function namesOfVisit(db, visit) {
  return {
    contact: await ownerNameOf(db, visit.owner_contact_id),
    project: sanitizeDisplayName(visit.name) ?? t("c2c.notify.aProject"),
  };
}

/**
 * One notification ROW, written inside the caller's transaction (S7/W1): the shared
 * helper is asked for `deliver: false`, so no push, ntfy call or email happens while
 * the frame's transaction holds the write lock.
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
 * @returns {Promise<Function|null>} the afterCommit hook, or null
 */
async function safeNotify(db, { title, source }, deliver = null) {
  try {
    const note = await createNotification(db, {
      title,
      type: "peer",
      source,
      action_url: "/dashboard/projects", // the Projects panel (task 7 part B)
      deliver: false, // S7/W1: the row here, the fan-out after COMMIT
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
 * Build the visitor's handler map for the receive pipeline's `ctx.handlers`
 * (boot.js's `createC2cHandlerLoader` merges the module's exports with
 * `Object.assign`, so the module also exports `onInvite` / `onRole` / `onUnshare` /
 * `onRefusal` directly — that is the whole shape it expects, no change to boot.js).
 * `onRefusal` is not a frame handler: the pipeline calls it at its ack/refusal step
 * (outside any transaction) whenever a terminal refusal arrived for one of our
 * frames, with ONE argument, `{ db, contactId, crowId, frame, reason, terminal }`.
 *
 * These run INSIDE the pipeline's transaction (S7) and must do DB work only: no
 * send, no flush, no notification fan-out. A handler that notifies writes the ROW
 * here (with `deliver: false`) and RETURNS `{ afterCommit }`, which the pipeline
 * runs after COMMIT — so a rolled-back frame leaves no notification behind and
 * nothing is pushed while the write lock is held.
 *
 * `notify` is the row-writing seam (tests inject a spy that records the title and
 * returns nothing); `deliver` is the fan-out seam the returned hook uses;
 * `deleteCopies` is the plan-2 cleanup hook. The defaults are the shared
 * notification helper, `deliverNotification` and the exported `deleteLocalCopies`.
 *
 * @param {{notify?: Function, deliver?: Function, deleteCopies?: Function}} [opts]
 * @returns {{onInvite: Function, onRole: Function, onUnshare: Function,
 *   onRefusal: Function}}
 */
export function createVisitorHandlers({ notify = null, deliver = null, deleteCopies = null } = {}) {
  const notifier = notify ?? ((db, opts) => safeNotify(db, opts, deliver));

  /**
   * The handler's return: only a real hook becomes one, so a stub notifier (or a
   * notification the type gate dropped) simply has nothing to run.
   */
  const afterCommitOf = (hook) => (typeof hook === "function" ? { afterCommit: hook } : undefined);

  /**
   * `project.invite`: the pipeline has already judged `inviteSupersedes` (S2), so
   * this invite is the newest generation and replaces whatever the visit was —
   * `active` included, because a newer invite is also an implicit unshare of the
   * membership it replaces.
   *
   * The upsert is keyed on the table's `UNIQUE (owner_contact_id, project_uuid)`, so
   * a re-invite reuses the row (the visit keeps its id) and a first invite creates
   * it. The epoch is the new membership's, the generation is what the next invite
   * must beat, and `accepted_at` / `ended_at` are cleared: the visit starts over as
   * an unanswered invitation. `invited_at` is the time of THIS invitation (it orders
   * `listVisits`).
   *
   * The contact is the pipeline's admitted contact, never a frame field; the project
   * name and role come from the frame body (frames.js has already validated them).
   * RETURNS `{ afterCommit }` for the one notification (S7/W1).
   */
  async function onInvite(db, { visit = null, frame = null, contactId } = {}) {
    const body = frame?.body ?? {};
    const role = requireRole(body.role);
    const epoch = frame?.epoch;
    if (typeof epoch !== "string" || !epoch) {
      throw new VisitError("an invite carries no membership epoch", "bad_frame");
    }
    const gen = body.gen;
    if (!Number.isSafeInteger(gen) || gen < 0) {
      throw new VisitError("an invite carries no usable generation", "bad_frame");
    }
    // The owner instance is the target of every answer we send, so without it the
    // visit could never be accepted: refuse the frame (the pipeline consumes its
    // seq and refuses `unsupported`) rather than store an unusable visit.
    if (typeof body.owner_instance_id !== "string" || !body.owner_instance_id) {
      throw new VisitError("an invite carries no owner instance id", "bad_frame");
    }
    if (typeof contactId !== "number" || !Number.isSafeInteger(contactId)) {
      throw new VisitError("an invite without an owner contact", "forbidden");
    }
    const projectUuid = frame?.project_uuid;
    if (typeof projectUuid !== "string" || !projectUuid) {
      throw new VisitError("an invite carries no project uuid", "bad_frame");
    }
    const name = typeof body.name === "string" && body.name ? body.name : t("c2c.notify.aProject");

    if (visit && visit.state === "active") {
      // S2: an implicit unshare of the membership this invite replaces. Refs only.
      // The old membership's own project.unshare may arrive after this invite (its
      // stream is independent) and then reads as stale, so the copies of the visit
      // being replaced are deleted HERE, exactly as onUnshare would have.
      console.log(`[c2c] a newer invite supersedes an active visit (${projectUuid})`);
      // X3: wrapped like every other cleanup call. Ending the old visit is not this
      // handler's effect — the new invite is — so a throwing plan-2 purge must not
      // roll the invite back and lose it.
      try {
        await (deleteCopies ?? deleteLocalCopies)(visit);
      } catch (err) {
        console.warn(`[c2c] deleting a superseded visit's local copies failed: ${err?.message || err}`);
      }
    }

    await db.execute({
      sql: `INSERT INTO c2c_visits
              (owner_contact_id, project_uuid, name, role, epoch, gen, owner_instance_id,
               state, invited_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'invited', datetime('now'))
            ON CONFLICT (owner_contact_id, project_uuid) DO UPDATE SET
              name = excluded.name,
              role = excluded.role,
              epoch = excluded.epoch,
              gen = excluded.gen,
              owner_instance_id = excluded.owner_instance_id,
              state = 'invited',
              invited_at = excluded.invited_at,
              accepted_at = NULL,
              ended_at = NULL`,
      args: [contactId, projectUuid, name, role, epoch, gen, body.owner_instance_id],
    });

    const names = {
      contact: await ownerNameOf(db, contactId),
      project: sanitizeDisplayName(name) ?? t("c2c.notify.aProject"),
    };
    return afterCommitOf(await notifier(db, {
      title: fill(t("c2c.notify.invited"), names),
      source: "sharing:c2c_invite",
    }));
  }

  /**
   * `project.role`: the owner changed this visit's role. A role change KEEPS the
   * epoch (S1/S7), so only `role` is rewritten and everything else about the visit
   * stands. The role is stored in the Crow-to-Crow vocabulary, which is what
   * `c2cCan` reads on every later frame — nothing caches an earlier one.
   *
   * A role frame for a visit that has already ended (declined, left, unshared) is
   * refused: it names a membership that no longer exists, and silently rewriting a
   * dead row would hide that. A throw is the pipeline's failure path (rollback, the
   * seq consumed, `unsupported`), which is what such a frame deserves.
   */
  async function onRole(db, { visit = null, frame = null } = {}) {
    if (!visit) throw new VisitError("a role change without a visit", "forbidden");
    const role = requireRole(frame?.body?.role);
    if (visit.state !== "invited" && visit.state !== "active") {
      throw new VisitError(`a ${visit.state} visit has no role to change`, "ended_visit");
    }
    await db.execute({
      sql: "UPDATE c2c_visits SET role = ? WHERE id = ?",
      args: [role, visit.id],
    });
  }

  /**
   * `project.unshare`: the owner ended this visit. The row becomes `unshared` with
   * its end time, the visitor's local copies go (the plan-2 hook; a no-op in plan
   * 1), and one notification is raised.
   *
   * The cleanup runs even when the row was already `unshared` — an unshare must
   * leave nothing behind, however often it arrives — but only a real transition
   * announces itself, so a repeated frame cannot notify twice. X4: a real transition
   * is one from `invited` or `active`; an unshare reaching a `left`/`declined` visit
   * (already over, ended by the operator) ends it quietly instead of announcing an
   * end the operator made themselves.
   *
   * The cleanup is wrapped: ending the visit is the effect that must land, and a
   * failing hook that threw here would roll the unshare back and get the frame
   * acked away forever (the owner has already revoked the membership).
   */
  async function onUnshare(db, { visit = null } = {}) {
    if (!visit) throw new VisitError("an unshare without a visit", "forbidden");
    const r = await db.execute({
      sql: `UPDATE c2c_visits
               SET state = 'unshared', ended_at = COALESCE(ended_at, datetime('now'))
             WHERE id = ? AND state <> 'unshared'`,
      args: [visit.id],
    });
    const ended = Number(r.rowsAffected ?? 0) > 0;
    try {
      await (deleteCopies ?? deleteLocalCopies)(visit);
    } catch (err) {
      console.warn(`[c2c] deleting a visit's local copies failed: ${err?.message || err}`);
    }
    if (!ended) return; // already unshared: no second notification
    // X4: the transition we announce is from a LIVE state only.
    if (visit.state !== "invited" && visit.state !== "active") return;
    const names = await namesOfVisit(db, visit);
    return afterCommitOf(await notifier(db, {
      title: fill(t("c2c.notify.unshared"), names),
      source: "sharing:c2c_unshare",
    }));
  }

  /**
   * `project.refuse` (X2): the owner refused one of OUR answers, and the refusal is
   * terminal (`forbidden` / `stale_epoch`) — the membership that answer belonged to
   * is gone. Until now the visitor would sit on a visit the owner already ended.
   *
   * The refused frame is identified from the outbox row `onRefuse` just closed, by
   * (contact, project, epoch, stream, seq): only a refused `project.accept` or
   * `project.decline` is an ANSWER whose refusal says something about the visit. A
   * refused invite/role/unshare frame is left to the pipeline. When the visit still
   * stands at that epoch it ends: `unshared` with an end time, the plan-2 cleanup
   * (guarded, X3 — a throwing purge must not cost us the state change), and one
   * notification. A visit already superseded by a newer invite (a different epoch)
   * is not ours to end, so it is left alone.
   *
   * Delivery: receive.js calls this OUTSIDE any transaction, passing the handle with
   * the rest (`{ db, contactId, crowId, frame, reason, terminal }`), so the row is
   * written with `deliver: false` and its fan-out runs right here, after the write.
   * If a future caller does run it inside a transaction, nothing is delivered there
   * (R7): the hook is returned as `{ afterCommit }` instead.
   *
   * Never throws: a refusal we could not read is worth a log line, not a broken
   * reply path.
   */
  async function onRefusal({ db = null, contactId, frame = null, reason = null, terminal = false } = {}) {
    if (!db) return;
    if (!terminal || !ENDING_REFUSALS.has(reason)) return;
    const body = frame?.body ?? {};
    const projectUuid = frame?.project_uuid;
    const epoch = body.epoch;
    if (!Number.isSafeInteger(contactId)) return;
    if (typeof projectUuid !== "string" || !projectUuid) return;
    if (typeof epoch !== "string" || !epoch) return;
    if (!Number.isSafeInteger(body.seq) || body.seq <= 0) return;
    const stream = typeof body.stream === "string" && body.stream ? body.stream : WILDCARD_STREAM;

    // Which of our frames did it answer? The row is already closed by `onRefuse`
    // (terminal refusals ack it), so this only reads it.
    let kind = null;
    try {
      const { rows } = await db.execute({
        sql: `SELECT kind FROM c2c_outbox
               WHERE contact_id = ? AND project_uuid = ? AND epoch = ? AND seq = ?
                 AND COALESCE(to_instance_id, '*') = ?
               LIMIT 1`,
        args: [contactId, projectUuid, epoch, body.seq, stream],
      });
      kind = rows[0]?.kind ?? null;
    } catch (err) {
      console.warn(`[c2c] could not read a refused frame's kind: ${err?.message || err}`);
      return;
    }
    if (!ANSWER_KINDS.has(kind)) return;

    let visit = null;
    try {
      const { rows } = await db.execute({
        sql: `SELECT * FROM c2c_visits
               WHERE owner_contact_id = ? AND project_uuid = ?
               ORDER BY id DESC LIMIT 1`,
        args: [contactId, projectUuid],
      });
      visit = rows[0] ?? null;
    } catch (err) {
      console.warn(`[c2c] could not read the visit of a refused answer: ${err?.message || err}`);
      return;
    }
    // A visit superseded by a newer invite is at a newer epoch: this refusal is
    // about a membership nobody holds any more, so it changes nothing.
    if (!visit || visit.epoch !== epoch) return;

    const r = await db.execute({
      sql: `UPDATE c2c_visits
               SET state = 'unshared', ended_at = COALESCE(ended_at, datetime('now'))
             WHERE id = ? AND state <> 'unshared'`,
      args: [visit.id],
    });
    const ended = Number(r.rowsAffected ?? 0) > 0;
    try {
      await (deleteCopies ?? deleteLocalCopies)(visit);
    } catch (err) {
      console.warn(`[c2c] deleting a refused visit's local copies failed: ${err?.message || err}`);
    }
    if (!ended) return; // already ended: no second notification
    const names = await namesOfVisit(db, visit);
    const hook = await notifier(db, {
      title: fill(t("c2c.notify.noLongerSharing"), names),
      source: "sharing:c2c_refused",
    });
    if (typeof hook !== "function") return;
    if (inTransaction(db)) return { afterCommit: hook };
    await hook();
  }

  return { onInvite, onRole, onUnshare, onRefusal };
}

const defaultHandlers = createVisitorHandlers();

/** The receive pipeline's handler for `project.invite` (real notification helper). */
export const onInvite = defaultHandlers.onInvite;
/** The receive pipeline's handler for `project.role`. */
export const onRole = defaultHandlers.onRole;
/** The receive pipeline's handler for `project.unshare`. */
export const onUnshare = defaultHandlers.onUnshare;
/** The receive pipeline's handler for a terminal refusal of one of our answers (X2). */
export const onRefusal = defaultHandlers.onRefusal;

/* ------------------------------------------------------------------ actions */

/**
 * The one transaction the three actions share: read the visit, refuse it unless it
 * is in the state this action starts from, write the new state, and queue the answer
 * (the visit's epoch, aimed at the instance whose invite created it, S1).
 *
 * `from` is the state the action requires (V2: accept/decline only from `invited`,
 * leave only from `active`); any other state is a clear `VisitError`, and nothing is
 * written or queued.
 *
 * The `to_instance_id` is `visit.owner_instance_id`: the owner's Crow that sent the
 * invite, so a paired sibling of the owner never sees the answer on the `"*"`
 * stream (S3's routing rule would refuse a targeted answer that has no target, and
 * an answer on `"*"` would be answered by whichever instance saw it first).
 */
async function answerVisit(db, {
  visitId, kind, from, state, reason, action, localInstanceId, send = null, flushAfter = null,
  deleteCopies = null,
}) {
  if (!Number.isSafeInteger(visitId) || visitId <= 0) {
    throw new VisitError("a visit id is required", "bad_argument");
  }
  if (!isValidInstanceId(localInstanceId)) {
    throw new VisitError(`${action} needs this instance's own id`, "bad_instance_id");
  }

  const contactId = await withTransaction(db, async () => {
    const visit = await visitRowOf(db, visitId);
    if (!visit) throw new VisitError(`visit ${visitId} is not here`, "not_found");
    if (visit.state !== from) {
      throw new VisitError(
        `a ${String(visit.state)} visit cannot be ${action}`,
        "bad_state",
      );
    }
    const target = visit.owner_instance_id;
    if (typeof target !== "string" || !target) {
      // A null target is legal only for an invite and an unshare (S1), so an answer
      // aimed at nobody would be refused `not_home` forever: refuse it here instead.
      throw new VisitError("the visit has no owner instance to answer", "bad_state");
    }

    if (state === "active") {
      await db.execute({
        sql: `UPDATE c2c_visits SET state = 'active', accepted_at = datetime('now')
               WHERE id = ? AND state = ?`,
        args: [visit.id, from],
      });
    } else {
      await db.execute({
        sql: `UPDATE c2c_visits SET state = ?, ended_at = datetime('now')
               WHERE id = ? AND state = ?`,
        args: [state, visit.id, from],
      });
    }

    // S1/S5: the answer is numbered on the stream of (epoch, target), inside this
    // same transaction, so a rollback un-takes the seq and no reader sees a gap.
    await enqueue(db, {
      contactId: Number(visit.owner_contact_id),
      projectUuid: visit.project_uuid,
      kind,
      epoch: visit.epoch,
      toInstanceId: target,
      body: kind === "project.accept"
        ? { visitor_instance_id: localInstanceId }
        : { reason },
      localInstanceId,
    });

    // X4: a leave ends the membership locally, so the visit's copies go with it —
    // the fourth way a visit ends (the others are unshare, supersede and refusal).
    // Guarded like the rest: the state change is the effect that must land, and the
    // purge is plan 2's work.
    if (state === "left") {
      try {
        await (deleteCopies ?? deleteLocalCopies)(visit);
      } catch (err) {
        console.warn(`[c2c] deleting a left visit's local copies failed: ${err?.message || err}`);
      }
    }
    return Number(visit.owner_contact_id);
  });

  await flushAfterCommit(db, { contactId, send, flushAfter });
}

/**
 * Accept an invitation (plan 1, task 7): `invited` → `active`, and one
 * `project.accept` carrying this instance's id, which becomes the routing target of
 * every later frame of the membership (S1).
 *
 * The caller is the local operator, gated by the dashboard's own auth (see the file
 * header, V3). The flush runs after COMMIT through `send` / `flushAfter`.
 *
 * @param {object} db
 * @param {{visitId:number, localInstanceId:string, send?:Function,
 *   flushAfter?:Function}} opts
 * @returns {Promise<void>}
 * @throws {VisitError} `not_found`, `bad_state` (not `invited`), `bad_instance_id`,
 *   `bad_argument`
 */
export async function acceptVisit(db, { visitId, localInstanceId, send = null, flushAfter = null } = {}) {
  return answerVisit(db, {
    visitId,
    kind: "project.accept",
    from: START.accept,
    state: "active",
    action: "accepted",
    localInstanceId,
    send,
    flushAfter,
  });
}

/**
 * Decline an invitation: `invited` → `declined`, and one `project.decline` with
 * `reason: "declined"`. The owner's Crow revokes the membership on receipt.
 *
 * @param {object} db
 * @param {{visitId:number, localInstanceId:string, send?:Function,
 *   flushAfter?:Function}} opts
 * @returns {Promise<void>}
 * @throws {VisitError} `not_found`, `bad_state` (not `invited`), `bad_instance_id`
 */
export async function declineVisit(db, { visitId, localInstanceId, send = null, flushAfter = null } = {}) {
  return answerVisit(db, {
    visitId,
    kind: "project.decline",
    from: START.decline,
    state: "declined",
    reason: "declined",
    action: "declined",
    localInstanceId,
    send,
    flushAfter,
  });
}

/**
 * Leave a shared project: `active` → `left`, and one `project.decline` with
 * `reason: "left"` (the owner's Crow tells the operator once, owner.js `onDecline`).
 * The visit's local copies are purged in the same transaction (guarded, X4: the
 * plan-2 hook purges on leave, unshare, supersede and refusal).
 *
 * @param {object} db
 * @param {{visitId:number, localInstanceId:string, send?:Function,
 *   flushAfter?:Function, deleteCopies?:Function}} opts
 *   `deleteCopies` is the plan-2 cleanup seam (as on `createVisitorHandlers`); the
 *   default is the exported `deleteLocalCopies`.
 * @returns {Promise<void>}
 * @throws {VisitError} `not_found`, `bad_state` (not `active`), `bad_instance_id`
 */
export async function leaveVisit(db, {
  visitId, localInstanceId, send = null, flushAfter = null, deleteCopies = null,
} = {}) {
  return answerVisit(db, {
    visitId,
    kind: "project.decline",
    from: START.leave,
    state: "left",
    reason: "left",
    action: "left",
    localInstanceId,
    send,
    flushAfter,
    deleteCopies,
  });
}

/* -------------------------------------------------------------------- list */

/**
 * `listVisits(db)` — the visitor's "Shared with you" list reads this (task 7 part
 * B). Every visit row is returned with its state; the route decides what to show
 * (`invited` / `active`, or the ended ones too).
 *
 * Names are sanitized here, exactly like owner.js's `listLiveMembers`: the project
 * name is the owner's text (from the invite body) and the owner's name is a remote
 * display name, and both are rendered in the dashboard.
 *
 * @returns {Promise<Array<{id:number, ownerContactId:number, ownerName:string,
 *   projectName:string, role:"viewer"|"commenter"|"editor", state:string,
 *   invitedAt:string|null}>>}
 */
export async function listVisits(db) {
  const { rows } = await db.execute({
    sql: `SELECT v.*, c.display_name AS owner_display_name, c.crow_id AS owner_crow_id
            FROM c2c_visits v
            LEFT JOIN contacts c ON c.id = v.owner_contact_id
           ORDER BY v.invited_at DESC, v.id DESC`,
  });
  return rows.map((row) => ({
    id: Number(row.id),
    ownerContactId: Number(row.owner_contact_id),
    ownerName: sanitizeDisplayName(row.owner_display_name)
      ?? sanitizeDisplayName(row.owner_crow_id)
      ?? "",
    projectName: sanitizeDisplayName(row.name) ?? "",
    role: row.role,
    state: row.state,
    invitedAt: row.invited_at ?? null,
  }));
}