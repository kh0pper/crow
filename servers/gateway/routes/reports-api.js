/**
 * Crow Recurring Reports' private JSON API: `/dashboard/api/reports`, owner only.
 *
 * Mounted inside the dashboard router (servers/gateway/dashboard/index.js), not in boot/feature-
 * mounts.js, because the dashboard's `csrfMiddleware` guards every unsafe method under `/dashboard`
 * and a router mounted at app root runs before it. Funnel is refused upstream, on every private path.
 *
 * Every request passes the same chain, in this order, and each step refuses before the next can read
 * anything:
 *
 *   1. `dashboardAuth` on this router's own prefix, so the API is closed wherever it is mounted.
 *   2. `Cache-Control: no-store`: a report names sources, a sender and a schedule.
 *   3. a byte-size guard, then the owner: `isLocalPasswordSessionOn` (this machine's own password
 *      sign-in, from the owner's own client). A peer's single-sign-on session, a session minted by a
 *      login on this machine, a signed peer call and this machine's own console all get 403
 *      `{error:"owner_only"}` with no data, and no report row is read before the verdict.
 *   4. this router's own `express.json({limit:"256kb"})`. No report body is large: a recipe is blocks
 *      and settings, and a settings write is a handful of words. The guard in step 3 refuses an
 *      over-size body by its `Content-Length` too, because a body under the gateway's global 1 MB
 *      parser could otherwise reach a route already parsed.
 *
 * Errors are JSON `{error, message}` with a fixed sentence per code: a library message, a database
 * message and a value never reach a response or a log line. A failure that is not one of the named
 * codes answers 500 `{error:"internal"}` and logs only its code.
 *
 * A report is answered without its `live_seal` and `live_nonce` columns: the seal is the gate's own
 * secret state, and the owner's card reads `live` (whether it verifies) instead. That boolean is the
 * approvals module's `isLive`, so a report a direct UPDATE or a repointed provider stopped reads
 * `live: false` here.
 *
 * NOTHING ON THIS ROUTER SENDS MAIL, and it never imports the send door or a delivery module. An owner
 * add of a recipient is a propose plus an approve in one tap; "Send to the rest" only writes `pending`
 * `report_sends` rows for a run (reports/send-log.js); the delivery seam is somebody else's, and it
 * takes those row ids, never an address from here. No answer on this router ever carries a
 * `report_recipients` seal or nonce: the recipient view is the approvals module's own, which drops
 * both.
 */
import { Router, json as jsonParserOf } from "express";
import { createDbClient } from "../../db.js";
import { isLocalPasswordSessionOn } from "../dashboard/local-session.js";
import {
  approveGoLive, approveRecipient, isLive, listRecipients, ownerSaveRecipe, pauseReport,
  proposeRecipient, refuseRecipient, resumeReport, revokeRecipient, updateSettings,
} from "../reports/approvals.js";
import { buildApprovalsDeps } from "../reports/approvals-deps.js";
import { listRuns } from "../reports/run.js";
import { requestRun } from "../reports/run-requests.js";
import { kickReportsHook } from "../reports/schedule-hook.js";
import { createSendToRest, listSends } from "../reports/send-log.js";
import { createReport, getReport, listReports } from "../reports/store.js";

/** The mount point. */
export const REPORTS_API_PREFIX = "/dashboard/api/reports";

/**
 * The owner of a report made through this route: the instance owner. Not a person's name, not a bot
 * id, and never a value a caller sends: a report is always the owner's.
 */
export const OWNER_LABEL = "owner";

/** A report id, exactly what the store mints. Anything else is a 404 here. */
export const REPORT_ID_RE = /^rpt-[0-9a-f]{16}$/;

/** A recipient id, exactly what approvals.js mints. A malformed one is a 404 here. */
export const RECIPIENT_ID_RE = /^rrc-[0-9a-f]{16}$/;

/** A run id, exactly what run.js mints. A malformed one in a path is a 404 here. */
export const RUN_ID_RE = /^rrn-[0-9a-f]{16}$/;

/** The largest body this router accepts. */
const BODY_LIMIT_BYTES = 256 * 1024;
const JSON_LIMIT = "256kb";

/** The fixed sentence per code. Plain words, no dash. */
const FIXED_TEXT = Object.freeze({
  owner_only: "Only the owner can see this.",
  not_found: "Not found.",
  bad_input: "That request is not valid.",
  bad_recipe: "That report recipe is not valid.",
  bad_seal_field: "That approval could not be sealed.",
  too_large: "That request is too large.",
  preview_missing: "Preview this report before going live.",
  preview_stale: "The recipe changed since that preview. Preview it again.",
  preview_failed: "That preview did not finish, so this report cannot go live yet.",
  go_live_needed: "Preview and go live again.",
  conflict: "That report changed while this request was in flight. Try again.",
  recipient_changed: "That report changed while this request was in flight. Try again.",
  no_schedule: "Choose when this report runs before going live.",
  sender_not_ready: "Choose a mail account that is ready to send.",
  model_unresolved: "Crow could not work out which model this report uses, so it cannot go live.",
  keychain_key_missing: "The keychain key for this password is not on this machine.",
  internal: "Something went wrong.",
});

/** The status a refusal answers with, by its code. Everything else is a 500. */
const STATUS_BY_CODE = Object.freeze({
  owner_only: 403,
  not_found: 404,
  bad_input: 400,
  bad_recipe: 400,
  bad_seal_field: 400,
  preview_missing: 409,
  preview_stale: 409,
  preview_failed: 409,
  go_live_needed: 409,
  conflict: 409,
  recipient_changed: 409,
  no_schedule: 409,
  sender_not_ready: 409,
  model_unresolved: 409,
  keychain_key_missing: 409,
});

function messageFor(code) {
  return FIXED_TEXT[code] || FIXED_TEXT.internal;
}

/** One JSON error. The message is a fixed sentence, never an error's own text. */
function sendError(res, status, code, message = null) {
  if (res.headersSent) return;
  res.status(status).json({ error: code, message: message || messageFor(code) });
}

/** A thrown failure as its own code and sentence, or 500 internal. */
function sendFailure(res, err) {
  const code = err && typeof err.code === "string" ? err.code : "";
  const status = STATUS_BY_CODE[code];
  if (!status) return sendError(res, 500, "internal");
  return sendError(res, status, code);
}

/** A route's failure in the log: the code only, so no value can travel with it. */
function logCode(route, err) {
  try {
    const code = err && typeof err.code === "string" && err.code ? err.code : "internal";
    console.warn(`[reports-api] ${route}: ${code}`);
  } catch {
    // A log line is never worth failing a request over.
  }
}

/* --------------------------------------------------------------------- validation */

function isReportId(value) {
  return typeof value === "string" && REPORT_ID_RE.test(value);
}

/** A project id from a query string or a JSON body: a positive integer, or null. */
function readProjectId(value) {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? value : null;
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) return null;
  const number = Number(value.trim());
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function readTitle(value) {
  if (typeof value !== "string") return null;
  const title = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return title ? title : null;
}

/** A report row as this API answers it: no seal, no nonce, and whether the approval verifies. */
async function reportView(db, approvalsDeps, report) {
  if (!report) return null;
  const { live_seal: _seal, live_nonce: _nonce, ...rest } = report;
  return { ...rest, live: await isLive(db, approvalsDeps, report) };
}

/* ------------------------------------------------------------------------- router */

/**
 * The reports API router.
 *
 * @param {Function} dashboardAuth the dashboard's auth middleware
 * @param {{openDb?: Function, ownerCheck?: Function, approvalsDeps?: object}} [deps]
 *   `openDb` mints the request's crow.db client; `ownerCheck` defaults to `isLocalPasswordSessionOn`;
 *   `approvalsDeps` is handed to the approvals module through `buildApprovalsDeps` (reports/
 *   approvals-deps.js): the real sender reader (reports/sender-ready.js), the real run reader
 *   (reports/run.js's `getRunForApproval`) and the real model resolver are the base, because
 *   approvals.js imports nothing under `mail/` and its own defaults fail closed. A member the caller
 *   injects (`loadSeed`, `now`, `getSchedule`, `registry`, or any of those three) wins over the base.
 * @returns {import("express").Router}
 */
export function reportsApiRouter(dashboardAuth, deps = {}) {
  const router = Router();
  const openDb = typeof deps.openDb === "function" ? deps.openDb : () => createDbClient();
  const ownerCheck = typeof deps.ownerCheck === "function" ? deps.ownerCheck : isLocalPasswordSessionOn;
  const givenDeps = deps.approvalsDeps == null ? {} : deps.approvalsDeps;
  const approvalsDeps = buildApprovalsDeps(givenDeps);
  const jsonParser = jsonParserOf({ limit: JSON_LIMIT });

  /** One client per request, closed in `finally`; a handler that throws answers its own code. */
  const route = (label, handler) => async (req, res) => {
    const db = openDb();
    try {
      await handler(db, req, res);
    } catch (err) {
      logCode(label, err);
      sendFailure(res, err);
    } finally {
      try {
        db.close();
      } catch {
        // Already closed is the only failure a per-request client has here.
      }
    }
  };

  router.use(REPORTS_API_PREFIX, dashboardAuth);

  /** Never cached: a report names its sources and its sender. */
  const guardHeaders = (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  };

  /** A body above the limit is refused by its declared size, whichever parser would read it. */
  const guardSize = (req, res, next) => {
    const declared = Number(req.headers?.["content-length"]);
    if (Number.isFinite(declared) && declared > BODY_LIMIT_BYTES) {
      return sendError(res, 413, "too_large");
    }
    next();
  };

  /** The owner: this instance's own password session, from the owner's own client. No row is read
   *  before the verdict, so a refused request carries no data at all. */
  const ownerGuard = async (req, res, next) => {
    const db = openDb();
    try {
      let owner = false;
      try {
        owner = (await ownerCheck(db, req)) === true;
      } catch {
        owner = false;
      }
      if (!owner) return sendError(res, 403, "owner_only");
      next();
    } finally {
      try {
        db.close();
      } catch {
        // Already closed is the only failure a per-request client has here.
      }
    }
  };

  /** A body this router's own parser refuses: too large is 413, anything else is 400. */
  const bodyParser = (req, res, next) => jsonParser(req, res, (err) => {
    if (!err) return next();
    const status = Number(err.status || err.statusCode || 0);
    if (status === 413 || err.type === "entity.too.large") return sendError(res, 413, "too_large");
    return sendError(res, 400, "bad_input");
  });

  router.use(REPORTS_API_PREFIX, guardHeaders);
  router.use(REPORTS_API_PREFIX, ownerGuard);
  router.use(REPORTS_API_PREFIX, guardSize);
  router.use(REPORTS_API_PREFIX, bodyParser);

  /** Every route's id check: a malformed id is a 404 before anything is read. */
  const idOf = (req, res) => {
    const id = String(req.params?.id ?? "");
    if (!isReportId(id)) {
      sendError(res, 404, "not_found");
      return null;
    }
    return id;
  };

  /** A recipient id in a path: a malformed one is a 404 before anything is read. */
  const recipientIdOf = (req, res) => {
    const rid = String(req.params?.rid ?? "");
    if (!RECIPIENT_ID_RE.test(rid)) {
      sendError(res, 404, "not_found");
      return null;
    }
    return rid;
  };

  /**
   * One recipient of THIS report, or a 404. The recipient list is the approvals module's (it carries
   * no seal and no nonce), so a rid of another report is simply not in it.
   */
  const recipientInReport = async (db, res, reportId, recipientId) => {
    const recipients = await listRecipients(db, reportId, approvalsDeps);
    const found = recipients.find((row) => row.id === recipientId) ?? null;
    if (!found) {
      sendError(res, 404, "not_found");
      return null;
    }
    return found;
  };

  /* -------------------------------------------------------------------------- reads */

  // GET /?project=<id> — one project's reports, newest first, without their recipe bodies.
  router.get(REPORTS_API_PREFIX, route("GET /", async (db, req, res) => {
    const projectId = readProjectId(req.query?.project);
    if (projectId == null) return sendError(res, 400, "bad_input");
    const rows = await listReports(db, { projectId });
    const reports = [];
    for (const row of rows) reports.push(await reportView(db, approvalsDeps, row));
    res.json({ reports });
  }));

  // POST / — a new report, in draft, with an empty recipe. The owner is always the instance owner.
  router.post(REPORTS_API_PREFIX, route("POST /", async (db, req, res) => {
    const body = req.body == null ? {} : req.body;
    if (typeof body !== "object" || Array.isArray(body)) return sendError(res, 400, "bad_input");
    const projectId = readProjectId(body.projectId);
    const title = readTitle(body.title);
    if (projectId == null || !title) return sendError(res, 400, "bad_input");
    let botId = null;
    if (body.botId !== undefined && body.botId !== null && body.botId !== "") {
      if (typeof body.botId !== "string" || !body.botId.trim() || body.botId.length > 120) {
        return sendError(res, 400, "bad_input");
      }
      botId = body.botId.trim();
    }
    const { id } = await createReport(db, { projectId, owner: OWNER_LABEL, botId, title });
    const row = await getReport(db, id);
    res.status(201).json({ report: await reportView(db, approvalsDeps, row) });
  }));

  // GET /:id — one report, with its recipe body, and whether its approval still verifies.
  router.get(`${REPORTS_API_PREFIX}/:id`, route("GET /:id", async (db, req, res) => {
    const id = idOf(req, res);
    if (!id) return;
    const row = await getReport(db, id);
    if (!row) return sendError(res, 404, "not_found");
    res.json({ report: await reportView(db, approvalsDeps, row) });
  }));

  /* ------------------------------------------------------------------------- writes */

  // PUT /:id/recipe — the owner's save. A live report is re-stamped only when nothing it approved
  // moved (the same sources hash and the same model-call status); otherwise it stays on its sealed
  // revision and the answer says a go-live is needed.
  router.put(`${REPORTS_API_PREFIX}/:id/recipe`, route("PUT /:id/recipe", async (db, req, res) => {
    const id = idOf(req, res);
    if (!id) return;
    const body = req.body == null ? {} : req.body;
    if (typeof body !== "object" || Array.isArray(body) || body.recipe == null) {
      return sendError(res, 400, "bad_input");
    }
    const saved = await ownerSaveRecipe(db, approvalsDeps, {
      reportId: id,
      recipe: body.recipe,
      actor: { kind: "owner" },
    });
    res.json(saved);
  }));

  // PUT /:id/settings — the sender, the delivery rule, the comment defaults, the AI switch, the title
  // and the notify switch. A live-set change on a live report pauses it with a fixed sentence.
  router.put(`${REPORTS_API_PREFIX}/:id/settings`, route("PUT /:id/settings", async (db, req, res) => {
    const id = idOf(req, res);
    if (!id) return;
    const body = req.body == null ? {} : req.body;
    if (typeof body !== "object" || Array.isArray(body) || body.settings == null) {
      return sendError(res, 400, "bad_input");
    }
    const row = await updateSettings(db, approvalsDeps, {
      reportId: id,
      settings: body.settings,
      actor: { kind: "owner" },
    });
    res.json({ report: await reportView(db, approvalsDeps, row) });
  }));

  // POST /:id/go-live — seal the live set over the head revision the preview ran against.
  router.post(`${REPORTS_API_PREFIX}/:id/go-live`, route("POST /:id/go-live", async (db, req, res) => {
    const id = idOf(req, res);
    if (!id) return;
    const body = req.body == null ? {} : req.body;
    if (typeof body !== "object" || Array.isArray(body)) return sendError(res, 400, "bad_input");
    const result = await approveGoLive(db, approvalsDeps, {
      reportId: id,
      previewRunId: body.previewRunId,
      actor: { kind: "owner" },
    });
    res.json(result);
  }));

  // POST /:id/pause — the report stops. The seal stays on the row, for a resume.
  router.post(`${REPORTS_API_PREFIX}/:id/pause`, route("POST /:id/pause", async (db, req, res) => {
    const id = idOf(req, res);
    if (!id) return;
    const body = req.body == null ? {} : req.body;
    if (typeof body !== "object" || Array.isArray(body)) return sendError(res, 400, "bad_input");
    const row = await pauseReport(db, approvalsDeps, {
      reportId: id,
      reason: body.reason,
      actor: { kind: "owner" },
    });
    res.json({ report: await reportView(db, approvalsDeps, row) });
  }));

  // POST /:id/resume — back to live only while the seal still verifies, else `go_live_needed`.
  router.post(`${REPORTS_API_PREFIX}/:id/resume`, route("POST /:id/resume", async (db, req, res) => {
    const id = idOf(req, res);
    if (!id) return;
    const row = await resumeReport(db, approvalsDeps, { reportId: id, actor: { kind: "owner" } });
    res.json({ report: await reportView(db, approvalsDeps, row) });
  }));

  /* -------------------------------------------------------------------------- runs */

  // POST /:id/preview — ask the scheduler hook for a preview run. A preview runs whatever the
  // report's status is (a draft is exactly what go-live needs to see), so nothing about the live set
  // is checked here; the request queue is the one path a run is ever asked for, and the hook queues it.
  router.post(`${REPORTS_API_PREFIX}/:id/preview`, route("POST /:id/preview", async (db, req, res) => {
    const id = idOf(req, res);
    if (!id) return;
    if (!(await getReport(db, id))) return sendError(res, 404, "not_found");
    await requestRun(db, { reportId: id, kind: "preview", requestedBy: "owner" });
    kickReportsHook();
    res.status(202).json({ requested: true });
  }));

  // POST /:id/run-now — ask for a full run now. Only a live report whose approval still verifies
  // may run, and that is decided here as well as in the run engine: a 409 says to go live again.
  router.post(`${REPORTS_API_PREFIX}/:id/run-now`, route("POST /:id/run-now", async (db, req, res) => {
    const id = idOf(req, res);
    if (!id) return;
    const row = await getReport(db, id);
    if (!row) return sendError(res, 404, "not_found");
    if (row.status !== "live" || !(await isLive(db, approvalsDeps, row))) {
      return sendError(res, 409, "go_live_needed");
    }
    await requestRun(db, { reportId: id, kind: "run_now", requestedBy: "owner" });
    kickReportsHook();
    res.status(202).json({ requested: true });
  }));

  // GET /:id/runs — this report's runs, newest first. A list row carries no gateway run id (that is
  // the boot sweep's own bookkeeping).
  router.get(`${REPORTS_API_PREFIX}/:id/runs`, route("GET /:id/runs", async (db, req, res) => {
    const id = idOf(req, res);
    if (!id) return;
    if (!(await getReport(db, id))) return sendError(res, 404, "not_found");
    const runs = await listRuns(db, id);
    res.json({ runs });
  }));

  /* -------------------------------------------------------------------- recipients */

  // GET /:id/recipients — who this report goes to. The approval seal and its nonce never leave the
  // approvals module, so no answer here can carry them; each row carries `verified` (whether its seal
  // still matches the row as it is now) instead.
  router.get(`${REPORTS_API_PREFIX}/:id/recipients`, route("GET /:id/recipients", async (db, req, res) => {
    const id = idOf(req, res);
    if (!id) return;
    if (!(await getReport(db, id))) return sendError(res, 404, "not_found");
    res.json({ recipients: await listRecipients(db, id, approvalsDeps) });
  }));

  // POST /:id/recipients — the owner adds one person: propose, then approve, in this one tap. A bot's
  // propose-only path is elsewhere; this route is the owner's, so `proposedBy` is always `owner`.
  router.post(`${REPORTS_API_PREFIX}/:id/recipients`, route("POST /:id/recipients", async (db, req, res) => {
    const id = idOf(req, res);
    if (!id) return;
    const body = req.body == null ? {} : req.body;
    if (typeof body !== "object" || Array.isArray(body)) return sendError(res, 400, "bad_input");
    const proposed = await proposeRecipient(db, approvalsDeps, {
      reportId: id,
      address: body.address,
      displayName: body.displayName,
      commentTier: body.commentTier,
      proposedBy: OWNER_LABEL,
    });
    const approved = await approveRecipient(db, approvalsDeps, {
      recipientId: proposed.id,
      actor: { kind: "owner" },
    });
    res.status(201).json({ recipient: approved });
  }));

  /** The shared body of approve, refuse and revoke: the same path, one decision each. */
  const decide = (label, action) => route(label, async (db, req, res) => {
    const id = idOf(req, res);
    if (!id) return;
    const rid = recipientIdOf(req, res);
    if (!rid) return;
    if (!(await getReport(db, id))) return sendError(res, 404, "not_found");
    const row = await recipientInReport(db, res, id, rid);
    if (!row) return;
    const recipient = await action(db, rid);
    res.json({ recipient });
  });

  // POST /:id/recipients/:rid/approve — the owner's approval, with a fresh nonce and seal.
  router.post(`${REPORTS_API_PREFIX}/:id/recipients/:rid/approve`, decide(
    "POST /:id/recipients/:rid/approve",
    (db, rid) => approveRecipient(db, approvalsDeps, { recipientId: rid, actor: { kind: "owner" } }),
  ));

  // POST /:id/recipients/:rid/refuse — the state and a NULLED seal, so an old approval cannot return.
  router.post(`${REPORTS_API_PREFIX}/:id/recipients/:rid/refuse`, decide(
    "POST /:id/recipients/:rid/refuse",
    (db, rid) => refuseRecipient(db, approvalsDeps, { recipientId: rid, actor: { kind: "owner" } }),
  ));

  // POST /:id/recipients/:rid/revoke — the same for an approval already given.
  router.post(`${REPORTS_API_PREFIX}/:id/recipients/:rid/revoke`, decide(
    "POST /:id/recipients/:rid/revoke",
    (db, rid) => revokeRecipient(db, approvalsDeps, { recipientId: rid, actor: { kind: "owner" } }),
  ));

  /* ------------------------------------------------------------------- the send log */

  // GET /:id/sends?run=<runId> — this report's send log, or one run's, bounded to 200 rows. Claim
  // tokens and gateway run ids stay out of it: they are delivery's own bookkeeping.
  router.get(`${REPORTS_API_PREFIX}/:id/sends`, route("GET /:id/sends", async (db, req, res) => {
    const id = idOf(req, res);
    if (!id) return;
    if (!(await getReport(db, id))) return sendError(res, 404, "not_found");
    const runId = req.query?.run;
    if (runId !== undefined && (typeof runId !== "string" || !RUN_ID_RE.test(runId))) {
      return sendError(res, 400, "bad_input");
    }
    res.json({ sends: await listSends(db, { reportId: id, runId: runId ?? null }) });
  }));

  // POST /:id/runs/:runId/send-rest — the owner's "Send to the rest": a `pending` row for every
  // approved recipient this run has not sent to, is not sending to, and holds no row for. It SENDS
  // nothing; delivery picks the rows up. A malformed run id is a 404, like every other path id here.
  router.post(`${REPORTS_API_PREFIX}/:id/runs/:runId/send-rest`, route(
    "POST /:id/runs/:runId/send-rest",
    async (db, req, res) => {
      const id = idOf(req, res);
      if (!id) return;
      const runId = String(req.params?.runId ?? "");
      if (!RUN_ID_RE.test(runId)) return sendError(res, 404, "not_found");
      if (!(await getReport(db, id))) return sendError(res, 404, "not_found");
      const out = await createSendToRest(db, { approvals: approvalsDeps }, {
        reportId: id,
        runId,
        actor: { kind: "owner" },
      });
      res.status(201).json(out);
    },
  ));

  return router;
}

export default reportsApiRouter;