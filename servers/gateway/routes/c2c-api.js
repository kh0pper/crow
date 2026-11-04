/**
 * c2c-api.js — the Crow-to-Crow sharing API the Projects panel calls.
 *
 *   POST /dashboard/c2c-api/projects/:id/invite                  { contact_id, role }
 *   POST /dashboard/c2c-api/projects/:id/members/:contactId/role { role }
 *   POST /dashboard/c2c-api/projects/:id/members/:contactId/unshare
 *   GET  /dashboard/c2c-api/projects/:id/members                 -> { members: [...] }
 *   GET  /dashboard/c2c-api/visits                               -> { visits: [...] }
 *   POST /dashboard/c2c-api/visits/:id/accept|decline|leave       -> { ok: true, state }
 *
 * The work itself lives in servers/sharing/c2c/owner.js (invite / role / unshare /
 * the live-member list) and visitor.js (accept / decline / leave / the visit list).
 * This file only parses, authorizes, calls them, and maps their refusals to JSON
 * statuses — nothing about membership or a visit is decided here.
 *
 * WHO: the owner at THIS instance's own password sign-in, and nobody else
 * (isLocalPasswordSessionOn). A peer-SSO session, a session minted by a login on
 * this machine itself, or any peer-signed call is refused `403 not_owner` before a
 * row is read. The owner/visitor functions add the project-level rule on top
 * (`manage_members` for every owner action, owner.js W3).
 *
 * IDS: every id in a path or body must be a positive integer; anything else is
 * `400 bad_request`. A Crow-to-Crow role outside viewer|commenter|editor is
 * `400 bad_role` (owner.js/visitor.js re-check it inside their transaction).
 *
 * ERROR SHAPE (routes/_error.js): `{ error, code? }`. `contact_not_bound` (a contact
 * whose Crow never proved the bound key on this instance) is `409
 * contact_not_bound`; any other AclError / VisitError is `403 forbidden` unless it
 * names a missing thing (`404 not_found` for an unknown project or contact, a
 * VisitError `not_found` for an unknown visit) or a visit in the wrong state
 * (`409 bad_state`). Everything else is `500` with a generic message; the real one
 * goes to the log as `[c2c-api]`, with ids only — never a frame body or a request
 * body (contact text).
 *
 * DELIVERY: every action queues its frame in the outbox inside its own
 * transaction (S4) and flushes AFTER COMMIT. `send` here is the c2c transport bound
 * to the one contact the request is about (a targeted frame rides `sendTo`, so it
 * reaches the instance it names); when the sharing runtime is not up (an early
 * boot, a test) `send` is null, the frame stays queued and boot.js's 60 s tick
 * sends it — the membership change itself has already committed either way.
 *
 * MOUNT: `/dashboard/c2c-api`, dashboardAuth first, mounted in dashboard/index.js
 * AFTER csrfMiddleware (the real CSRF rail), never public. The router also
 * installs dashboardAuth on its own prefix, so it stays closed wherever it is
 * mounted. Listed in tests/auth-network.test.js like every other private API.
 */
import express, { Router } from "express";
import { jsonError } from "./_error.js";
import { createDbClient } from "../../db.js";
import { assertProjectExists } from "../../shared/project-acl.js";
import { getManagersOrNull } from "../../sharing/managers.js";
import { getOrCreateLocalInstanceId } from "../instance-registry.js";
import { isLocalPasswordSessionOn } from "../dashboard/local-session.js";
import { ROLES as C2C_ROLES } from "../../sharing/c2c/frames.js";
import { inviteContact, listLiveMembers, setRole, unshareContact } from "../../sharing/c2c/owner.js";
import { acceptVisit, declineVisit, leaveVisit, listVisits } from "../../sharing/c2c/visitor.js";
import { c2cSendForContact } from "../../sharing/c2c/transport.js";

const P = "/dashboard/c2c-api";

/** The dashboard's own writes are attributed to the local operator (no bot behind them). */
const DASHBOARD_ACTOR = "local";

/** AclError / VisitError codes that mean "the thing this request names does not exist". */
const NOT_FOUND_CODES = new Set(["not_found", "archived"]);

/**
 * A path or body id as a positive integer, or null. A number or a decimal string
 * is accepted (the panel posts numbers, a URL carries strings); anything else —
 * a float, a negative, `"1e3"`, an empty string — is refused, never coerced.
 * @returns {number|null}
 */
function positiveInt(value) {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value === "string" && /^[1-9]\d{0,15}$/.test(value)) return Number(value);
  return null;
}

/**
 * This instance's own id: the sharing runtime's when it is up (it is the same id
 * boot.js hands the receive pipeline), else the registry's. Never null —
 * `getOrCreateLocalInstanceId()` mints one — and every frame's `from_instance_id`.
 * @returns {string}
 */
function localIdNow() {
  const managers = getManagersOrNull();
  const live = managers?.instanceSyncManager?.localInstanceId
    || managers?.peerManager?.localInstanceId;
  if (typeof live === "string" && live) return live;
  return getOrCreateLocalInstanceId();
}

/**
 * The outbox's `send` for one contact, through the c2c transport (a targeted frame
 * rides `sendTo`, a `'*'` one `send`), or null when the sharing runtime is not up or
 * the contact has no crow id. The resolver itself lives in c2c/transport.js, shared
 * with the two-node fixture, so the gate runs the production send path. Null is not
 * an error — the frame stays queued for boot.js's tick (S4), and an action must not
 * fail because a peer happens to be unreachable.
 * @returns {Promise<Function|null>}
 */
async function sendFor(db, contactId) {
  return c2cSendForContact(db, getManagersOrNull()?.peerManager, contactId);
}

/** The owner contact of a visit, for the answer's flush; null when there is no such visit. */
async function visitOwnerContactId(db, visitId) {
  try {
    const { rows } = await db.execute({
      sql: "SELECT owner_contact_id FROM c2c_visits WHERE id = ? LIMIT 1",
      args: [visitId],
    });
    const id = Number(rows[0]?.owner_contact_id);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  } catch {
    return null; // visitor.js reads the visit itself and answers not_found
  }
}

/**
 * Map a refusal from owner.js / visitor.js to the JSON this API speaks.
 *
 * The functions throw two error classes: `AclError` (project-acl.js) and
 * `VisitError` (visitor.js). Both carry a machine `code`; the mappings are the
 * plan's list plus the two visit states. An error of any other kind is a 500 with
 * a generic message — its own message goes to the log only (ids, never bodies).
 */
function fail(res, err, where) {
  const coded = err?.name === "AclError" || err?.name === "VisitError";
  const code = coded && typeof err.code === "string" ? err.code : "";
  console.warn(`[c2c-api] ${where} refused: ${code || "unexpected"} (${err?.message || err})`);
  if (res.headersSent) return;
  if (code === "contact_not_bound") return jsonError(res, 409, "contact_not_bound", { code });
  if (code === "bad_role") return jsonError(res, 400, "bad_role", { code });
  if (code === "bad_argument" || code === "bad_instance_id") return jsonError(res, 400, "bad_request", { code });
  if (NOT_FOUND_CODES.has(code)) return jsonError(res, 404, "not_found", { code });
  if (code === "bad_state") return jsonError(res, 409, "bad_state", { code });
  if (coded) return jsonError(res, 403, "forbidden", { code: code || "forbidden" });
  return jsonError(res, 500, "The request failed");
}

/**
 * The router. `dashboardAuth` is the dashboard's session middleware (dashboard/index.js
 * passes the real one; tests pass a stub that signs a request in).
 */
export function c2cApiRouter(dashboardAuth) {
  const router = Router();
  router.use(P, dashboardAuth);
  router.use(P, express.json({ limit: "8kb" }));

  // These responses name contacts, projects and visits: never cached, never framed.
  router.use(P, (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Frame-Options", "DENY");
    next();
  });

  /**
   * One request's db client, the owner gate, the handler and the error mapping —
   * the same lifecycle in every route below (mirrors make-api.js).
   */
  const handler = (label, fn) => async (req, res) => {
    const db = createDbClient();
    try {
      let owner = false;
      try { owner = (await isLocalPasswordSessionOn(db, req)) === true; } catch { owner = false; }
      if (!owner) return jsonError(res, 403, "not_owner", { code: "not_owner" });
      await fn(req, res, db);
    } catch (err) {
      fail(res, err, label);
    } finally {
      try { db.close(); } catch { /* already closed */ }
    }
  };

  /** A project id from the path, or a 400 already sent. */
  const projectIdOf = (req, res) => {
    const id = positiveInt(req.params.id);
    if (id === null) jsonError(res, 400, "bad_request", { code: "bad_id" });
    return id;
  };

  /** A contact id from the path, or a 400 already sent. */
  const contactIdOf = (req, res) => {
    const id = positiveInt(req.params.contactId);
    if (id === null) jsonError(res, 400, "bad_request", { code: "bad_contact" });
    return id;
  };

  const roleOf = (req) => {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    return typeof body.role === "string" ? body.role : "";
  };

  // Invite a contact's Crow. The role is checked here so a typo cannot reach the
  // outbox; owner.js re-checks it in its own transaction (`bad_role`).
  router.post(P + "/projects/:id/invite", handler("invite", async (req, res, db) => {
    const projectId = projectIdOf(req, res);
    if (projectId === null) return;
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const contactId = positiveInt(body.contact_id);
    if (contactId === null) return jsonError(res, 400, "bad_request", { code: "bad_contact" });
    const role = roleOf(req);
    if (!C2C_ROLES.includes(role)) return jsonError(res, 400, "bad_role", { code: "bad_role" });

    const { memberUuid } = await inviteContact(db, {
      projectId,
      contactId,
      role,
      localInstanceId: localIdNow(),
      actor: DASHBOARD_ACTOR,
      send: await sendFor(db, contactId),
    });
    return res.json({ ok: true, memberUuid });
  }));

  // Change an accepted member's role.
  router.post(P + "/projects/:id/members/:contactId/role", handler("role", async (req, res, db) => {
    const projectId = projectIdOf(req, res);
    if (projectId === null) return;
    const contactId = contactIdOf(req, res);
    if (contactId === null) return;
    const role = roleOf(req);
    if (!C2C_ROLES.includes(role)) return jsonError(res, 400, "bad_role", { code: "bad_role" });

    const out = await setRole(db, {
      projectId,
      contactId,
      role,
      localInstanceId: localIdNow(),
      actor: DASHBOARD_ACTOR,
      send: await sendFor(db, contactId),
    });
    return res.json({ ok: true, memberUuid: out.memberUuid, seq: out.seq });
  }));

  // Stop sharing: revoke the membership and tell the visitor's Crow.
  router.post(P + "/projects/:id/members/:contactId/unshare", handler("unshare", async (req, res, db) => {
    const projectId = projectIdOf(req, res);
    if (projectId === null) return;
    const contactId = contactIdOf(req, res);
    if (contactId === null) return;

    const out = await unshareContact(db, {
      projectId,
      contactId,
      localInstanceId: localIdNow(),
      actor: DASHBOARD_ACTOR,
      send: await sendFor(db, contactId),
    });
    return res.json({ ok: true, memberUuid: out.memberUuid, seq: out.seq });
  }));

  // The owner's live-members list (role, state, updateRequired, and the Z2
  // `problem`/`problemReason` pair: why nothing is moving for that member).
  router.get(P + "/projects/:id/members", handler("members", async (req, res, db) => {
    const projectId = projectIdOf(req, res);
    if (projectId === null) return;
    await assertProjectExists(db, projectId); // an unknown or archived project is 404
    return res.json({ members: await listLiveMembers(db, projectId) });
  }));

  // Everything shared with this Crow.
  router.get(P + "/visits", handler("visits", async (req, res, db) => {
    return res.json({ visits: await listVisits(db) });
  }));

  // Answer an invitation: accept, decline, or leave a visit already accepted.
  const VISIT_ACTIONS = {
    accept: { run: acceptVisit, state: "active" },
    decline: { run: declineVisit, state: "declined" },
    leave: { run: leaveVisit, state: "left" },
  };
  for (const [action, spec] of Object.entries(VISIT_ACTIONS)) {
    router.post(`${P}/visits/:id/${action}`, handler(`visit ${action}`, async (req, res, db) => {
      const visitId = positiveInt(req.params.id);
      if (visitId === null) return jsonError(res, 400, "bad_request", { code: "bad_id" });
      await spec.run(db, {
        visitId,
        localInstanceId: localIdNow(),
        send: await sendFor(db, await visitOwnerContactId(db, visitId)),
      });
      return res.json({ ok: true, state: spec.state });
    }));
  }

  return router;
}

export default c2cApiRouter;