/**
 * Box schedule API routes — the owner's dashboard door onto the one box
 * calendar (the private engineering notes §6.3, the two layers in
 * ./box-schedule.js and ./box-reservation.js).
 *
 * Three routes, all under `/api/box`:
 *   GET  /api/box/schedule?from&to      the active hold + the bookings in range
 *   POST /api/box/bookings/:id/approve  clear a pending approval
 *   POST /api/box/bookings/:id/decline  refuse a pending approval
 *   POST /api/box/bookings/:id/cancel   drop a booking
 * `from`/`to` are ISO-8601 strings or epoch ms; the default range is now to
 * now + 48 h. A `from` at or after `to` is refused as a bad range, never
 * silently widened.
 *
 * Auth: the SAME JSON session gate the model catalog API uses
 * (`requireDashboardSessionJson`, imported from ./models.js) rather than the
 * redirect-based `dashboardAuth` every other panel router takes — this is a
 * JSON API a panel polls, and a 302 to the login page is not an answer a
 * `fetch()` caller can act on. `dashboardAuth` stays this factory's first
 * argument (unused) purely so the call site in `boot/feature-mounts.js`
 * matches every sibling router's `xRouter(dashboardAuth)` shape.
 *
 * The Funnel refusal is explicit and comes BEFORE the session check: a
 * request carrying `Tailscale-Funnel-Request` is answered 403 NETWORK_DENIED
 * whatever `CROW_DASHBOARD_PUBLIC` says, so this surface stays private even
 * on an install that has opted the dashboard into Funnel. `/api/box` is never
 * added to `PUBLIC_FUNNEL_PREFIXES` — see CLAUDE.md's "Network exposure
 * invariant".
 *
 * CSRF: every mutating route runs the double-submit check
 * (`dashboard/shared/csrf.js`), the same middleware the mutating models
 * routes use. Approve and decline write the calendar under
 * `withReservationLockAsync` (the gateway must never block its event loop on
 * the file lock); a cancel re-reads the calendar in the same critical
 * section to look up the booking's own owner.
 *
 * `approval.by` is `"owner:"` plus the first 8 hex characters of the SHA-256
 * of the request's session id: the calendar says a dashboard session
 * approved it, without the session token itself ever reaching the file.
 */

import { Router } from "express";
import { createHash } from "node:crypto";

import { requireDashboardSessionJson } from "./models.js";
import { csrfMiddleware } from "../dashboard/shared/csrf.js";
import {
  approveBookingLocked, cancelBookingLocked, declineBookingLocked, listBookings,
} from "../box-schedule.js";
import { readReservation, withReservationLockAsync } from "../box-reservation.js";

/** Booking ids are `bk_<hex>` or `<series id>@YYYY-MM-DD`. */
const BOOKING_ID_RE = /^[A-Za-z0-9_@-]+$/;
const DEFAULT_WINDOW_MS = 48 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// A cancel looks the booking's own owner up in the calendar; the window is
// wide enough for any booking the API can be asked about, and the id itself
// is resolved (and a missing one refused) by the calendar layer anyway.
const CANCEL_LOOKUP_BACK_MS = 365 * DAY_MS;
const CANCEL_LOOKUP_FORWARD_MS = 400 * DAY_MS;

const STATUS_BY_CODE = Object.freeze({
  booking_not_found: 404,
  booking_not_owner: 403,
  booking_approval_not_pending: 409,
  booking_approval_expired: 409,
  calendar_corrupt: 503,
  box_lock_timeout: 503,
});

/** Epoch ms for an ISO string or an epoch-ms value (a query string included). */
function parseTime(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const text = value.trim();
  if (/^-?\d+$/.test(text)) {
    const n = Number(text);
    return Number.isFinite(n) ? n : null;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * `{from, to}` in epoch ms from a request query, or null when either bound is
 * unreadable or the range is empty. Missing bounds fall back to now and
 * now + 48 h.
 */
export function parseRange(query, now = Date.now()) {
  const q = query || {};
  const rawFrom = q.from == null || q.from === "" ? null : parseTime(q.from);
  const rawTo = q.to == null || q.to === "" ? null : parseTime(q.to);
  if (rawFrom === null && q.from != null && q.from !== "") return null;
  if (rawTo === null && q.to != null && q.to !== "") return null;
  const from = rawFrom == null ? now : rawFrom;
  const to = rawTo == null ? (rawFrom == null ? now + DEFAULT_WINDOW_MS : from + DEFAULT_WINDOW_MS) : rawTo;
  if (!(to > from)) return null;
  return { from, to };
}

/** `"owner:"` plus the first 8 hex of sha256(session id) — never the token. */
export function ownerStamp(sessionToken) {
  const hex = createHash("sha256").update(String(sessionToken || "")).digest("hex");
  return "owner:" + hex.slice(0, 8);
}

/**
 * The active hold plus the bookings overlapping [from, to). A corrupt
 * calendar is reported as `corrupt: true` and an empty list: the readable
 * hold still comes back, so the caller can say what the box is doing even
 * when the calendar cannot be read. Never throws for a corrupt file (a write
 * is a different matter — the calendar layer refuses those itself).
 */
export function readScheduleRange({
  from, to, now = Date.now(), listBookingsFn = listBookings, readReservationFn = readReservation,
} = {}) {
  let active = null;
  try {
    active = readReservationFn({ now }) || null;
  } catch {
    active = null;
  }
  try {
    return { active, bookings: listBookingsFn({ from, to, now }), corrupt: false };
  } catch (err) {
    if (err && err.code === "calendar_corrupt") return { active, bookings: [], corrupt: true };
    throw err;
  }
}

/** The owner a booking row (or occurrence) carries, for a force cancel. */
function ownerOfRow(rows, id) {
  const text = String(id || "");
  const hit = rows.find((row) => row && row.id === text);
  if (hit) return typeof hit.owner === "string" ? hit.owner : null;
  const at = text.lastIndexOf("@");
  if (at > 0) {
    const seriesId = text.slice(0, at);
    const series = rows.find((row) => row && (row.id === seriesId || row.series_id === seriesId));
    if (series && typeof series.owner === "string") return series.owner;
  }
  return null;
}

/**
 * One error mapper for every route here: the codes the calendar and the hold
 * layer raise keep their status; anything else is a generic 500 that names
 * nothing (no stack, no internal message).
 */
function sendErr(res, err) {
  const code = err && typeof err.code === "string" && err.code ? err.code : null;
  const status = code ? STATUS_BY_CODE[code] : null;
  if (status) {
    if (status >= 500) console.warn("[box-schedule] request refused:", code);
    return res.status(status).json({ error: err.message || code, code });
  }
  console.warn("[box-schedule] request failed:", (err && err.message) || String(err));
  return res.status(500).json({ error: "The box schedule request failed", code: "internal_error" });
}

/**
 * @param {Function} dashboardAuth - accepted for call-site parity with every
 *   sibling router (`xRouter(dashboardAuth)`); NOT used — see module doc.
 * @param {object} [deps] - injectable seams (tests only; production omits
 *   all of these, using the real implementations imported above).
 */
export default function boxScheduleRouter(dashboardAuth, deps = {}) {
  const {
    listBookingsFn = listBookings,
    readReservationFn = readReservation,
    approveFn = approveBookingLocked,
    declineFn = declineBookingLocked,
    cancelFn = cancelBookingLocked,
    withLockAsyncFn = withReservationLockAsync,
    nowFn = Date.now,
  } = deps;

  const router = Router();

  // Explicit Funnel refusal, before the session gate: isAllowedNetwork()
  // already rejects the header, but this surface must not depend on it (a
  // CROW_DASHBOARD_PUBLIC install skips that check entirely).
  router.use("/api/box", (req, res, next) => {
    if (req.headers["tailscale-funnel-request"]) {
      return res.status(403).json({ error: "Not reachable from this network", code: "NETWORK_DENIED" });
    }
    next();
  });

  // Every /api/box route requires a valid dashboard session — the same gate
  // (and the same reasons) as /api/models.
  router.use("/api/box", requireDashboardSessionJson);

  const badId = (id) => !BOOKING_ID_RE.test(String(id == null ? "" : id));
  const refuseId = (res) => res.status(400).json({
    error: "a booking id is letters, digits, underscore, \"@\" or \"-\"",
    code: "bad_booking_id",
  });

  router.get("/api/box/schedule", (req, res) => {
    const now = nowFn();
    const range = parseRange(req.query, now);
    if (!range) {
      return res.status(400).json({
        error: "from/to must be ISO times or epoch ms, with to after from",
        code: "bad_range",
      });
    }
    try {
      const { active, bookings, corrupt } = readScheduleRange({
        from: range.from, to: range.to, now, listBookingsFn, readReservationFn,
      });
      if (corrupt) {
        return res.status(503).json({
          error: "the box calendar file is unreadable",
          code: "calendar_corrupt",
          active,
        });
      }
      return res.json({ active, bookings });
    } catch (err) {
      return sendErr(res, err);
    }
  });

  router.post("/api/box/bookings/:id/approve", csrfMiddleware, async (req, res) => {
    const id = req.params.id;
    if (badId(id)) return refuseId(res);
    try {
      const booking = await withLockAsyncFn(() => approveFn(id, { by: ownerStamp(req.dashboardSession) }));
      return res.json({ ok: true, booking });
    } catch (err) {
      return sendErr(res, err);
    }
  });

  router.post("/api/box/bookings/:id/decline", csrfMiddleware, async (req, res) => {
    const id = req.params.id;
    if (badId(id)) return refuseId(res);
    try {
      const booking = await withLockAsyncFn(() => declineFn(id, { by: ownerStamp(req.dashboardSession) }));
      return res.json({ ok: true, booking });
    } catch (err) {
      return sendErr(res, err);
    }
  });

  router.post("/api/box/bookings/:id/cancel", csrfMiddleware, async (req, res) => {
    const id = req.params.id;
    if (badId(id)) return refuseId(res);
    try {
      // The dashboard user IS the box owner, so a cancel is forced: a bot's or
      // the audit's booking is the owner's to drop. The booking's own owner is
      // read first, in the same critical section, so the calendar records who
      // the booking belonged to rather than guessing.
      const booking = await withLockAsyncFn(() => {
        const now = nowFn();
        const rows = listBookingsFn({
          from: now - CANCEL_LOOKUP_BACK_MS,
          to: now + CANCEL_LOOKUP_FORWARD_MS,
          now,
        });
        return cancelFn(id, { owner: ownerOfRow(rows, id), force: true, now });
      });
      return res.json({ ok: true, booking });
    } catch (err) {
      return sendErr(res, err);
    }
  });

  return router;
}