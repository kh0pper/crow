/**
 * Box schedule API routes (the one box calendar, the private engineering
 * notes §6.3): the owner's dashboard door onto the calendar and the active
 * hold.
 *
 * Harness: tests/fixtures/models-routes-harness.mjs gives a scratch
 * CROW_DATA_DIR with the real schema (never the real ~/.crow), a seeded
 * dashboard session, and the real JSON session gate (`verifySession` reads
 * the `oauth_tokens` row this seeds). The calendar and the hold file are
 * redirected into a scratch directory with CROW_BOX_SCHEDULE_PATH /
 * CROW_BOX_RESERVATION_PATH, so no test touches a real box.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  freshLibsql, seedSession, authHeaders, noCsrfHeaders, noSessionHeaders,
} from "./fixtures/models-routes-harness.mjs";
import boxScheduleRouter from "../servers/gateway/routes/box-schedule.js";
import { book, listBookings, schedulePath } from "../servers/gateway/box-schedule.js";
import { activateHold, reservationPath } from "../servers/gateway/box-reservation.js";

const SCRATCH = mkdtempSync(join(tmpdir(), "box-schedule-routes-"));
process.env.CROW_BOX_RESERVATION_PATH = join(SCRATCH, "reservation.json");
process.env.CROW_BOX_SCHEDULE_PATH = join(SCRATCH, "box-schedule.json");

const HOUR = 60 * 60 * 1000;

/** Both state files start empty for every test. */
function resetState() {
  for (const path of [schedulePath(), reservationPath()]) {
    try { rmSync(path, { force: true }); } catch { /* already gone */ }
  }
}

let scratch = null;
async function harness() {
  if (!scratch) {
    scratch = freshLibsql("box-schedule-routes-");
    await seedSession(scratch.db);
  }
  return scratch;
}

after(async () => {
  if (scratch) await scratch.cleanup();
  rmSync(SCRATCH, { recursive: true, force: true });
});

/** The real router on an ephemeral port; `dashboardAuth` is accepted unused. */
async function withBoxServer(fn) {
  const app = express();
  app.use(express.json());
  app.use(boxScheduleRouter((req, res, next) => next()));
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    server.close();
  }
}

const post = (base, path, headers) => fetch(base + path, { method: "POST", headers, body: "{}" });

const rangeQuery = (fromMs, toMs) => {
  const q = new URLSearchParams();
  if (fromMs != null) q.set("from", new Date(fromMs).toISOString());
  if (toMs != null) q.set("to", new Date(toMs).toISOString());
  return q.toString();
};

test("schedule lists active + bookings", async () => {
  resetState();
  await harness();
  const token = "test-session-token";
  const start = Date.now() + HOUR;
  const booking = book({
    owner: "alex", kind: "window", mode: "exclusive", start, minutes: 60,
    reason: "window run", created_by: "test",
  });
  activateHold({ owner: "alex", reason: "window run", minutes: 30, kind: "window" });

  await withBoxServer(async (base) => {
    const r = await fetch(`${base}/api/box/schedule?${rangeQuery(Date.now() - HOUR, Date.now() + 6 * HOUR)}`, {
      headers: authHeaders(token),
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.active.owner, "alex");
    assert.equal(body.active.kind, "window");
    assert.equal(body.active.mode, "exclusive");
    assert.equal(body.bookings.length, 1);
    assert.equal(body.bookings[0].id, booking.id);
    assert.equal(body.bookings[0].owner, "alex");
    assert.equal(body.bookings[0].kind, "window");
  });
});

test("approve flips pending to approved and records by=owner plus a hashed session id", async () => {
  resetState();
  const h = await harness();
  const token = "approve-session-token";
  await seedSession(h.db, token);
  const start = Date.now() + HOUR;
  const booking = book({
    owner: "alex", kind: "manual", mode: "exclusive", start, minutes: 30,
    evict: ["crow-chat"], reason: "evict run", created_by: "test",
  });
  assert.equal(booking.approval.state, "pending");

  await withBoxServer(async (base) => {
    const r = await post(base, `/api/box/bookings/${booking.id}/approve`, authHeaders(token));
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.equal(body.booking.approval.state, "approved");
    assert.equal(
      body.booking.approval.by,
      "owner:" + createHash("sha256").update(token).digest("hex").slice(0, 8),
    );
    assert.ok(!body.booking.approval.by.includes(token), "the raw session token is never stored");
  });

  const stored = listBookings({ from: Date.now() - HOUR, to: Date.now() + 6 * HOUR });
  assert.equal(stored[0].approval.state, "approved");
});

test("decline works", async () => {
  resetState();
  const h = await harness();
  const token = "decline-session-token";
  await seedSession(h.db, token);
  const booking = book({
    owner: "alex", kind: "manual", mode: "exclusive", start: Date.now() + HOUR, minutes: 30,
    needs_approval: true, reason: "ask first", created_by: "test",
  });

  await withBoxServer(async (base) => {
    const r = await post(base, `/api/box/bookings/${booking.id}/decline`, authHeaders(token));
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.equal(body.booking.approval.state, "declined");
  });

  const stored = listBookings({ from: Date.now() - HOUR, to: Date.now() + 6 * HOUR });
  assert.equal(stored[0].approval.state, "declined");
});

test("cancel by the dashboard owner cancels another owner's booking", async () => {
  resetState();
  const h = await harness();
  const token = "cancel-session-token";
  await seedSession(h.db, token);
  const booking = book({
    owner: "nightly-audit", kind: "audit", mode: "exclusive", start: Date.now() + HOUR,
    minutes: 45, reason: "audit", created_by: "cli",
  });

  await withBoxServer(async (base) => {
    const r = await post(base, `/api/box/bookings/${booking.id}/cancel`, authHeaders(token));
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.equal(body.booking.status, "cancelled");
  });

  const stored = listBookings({ from: Date.now() - HOUR, to: Date.now() + 6 * HOUR });
  assert.equal(stored[0].status, "cancelled");
});

test("unauthenticated request is 401", async () => {
  resetState();
  await harness();
  const booking = book({
    owner: "alex", kind: "window", mode: "exclusive", start: Date.now() + HOUR,
    minutes: 30, created_by: "test",
  });

  await withBoxServer(async (base) => {
    const get = await fetch(`${base}/api/box/schedule`, { headers: noSessionHeaders() });
    assert.equal(get.status, 401);
    const approve = await post(base, `/api/box/bookings/${booking.id}/approve`, noSessionHeaders());
    assert.equal(approve.status, 401);
  });
});

test("mutating routes are 403 without the CSRF echo", async () => {
  resetState();
  const h = await harness();
  const token = "csrf-session-token";
  await seedSession(h.db, token);
  const booking = book({
    owner: "alex", kind: "manual", mode: "exclusive", start: Date.now() + HOUR,
    minutes: 30, needs_approval: true, created_by: "test",
  });

  await withBoxServer(async (base) => {
    for (const action of ["approve", "decline", "cancel"]) {
      const r = await post(base, `/api/box/bookings/${booking.id}/${action}`, noCsrfHeaders(token));
      assert.equal(r.status, 403, action);
    }
  });

  const stored = listBookings({ from: Date.now() - HOUR, to: Date.now() + 6 * HOUR });
  assert.equal(stored[0].approval.state, "pending", "nothing was decided");
});

test("request with Tailscale-Funnel-Request header is refused", async () => {
  resetState();
  const h = await harness();
  const token = "funnel-session-token";
  await seedSession(h.db, token);
  const booking = book({
    owner: "alex", kind: "window", mode: "exclusive", start: Date.now() + HOUR,
    minutes: 30, created_by: "test",
  });

  // CROW_DASHBOARD_PUBLIC would let isAllowedNetwork() pass, so the refusal
  // here can only be this router's own check.
  const prev = process.env.CROW_DASHBOARD_PUBLIC;
  process.env.CROW_DASHBOARD_PUBLIC = "true";
  try {
    await withBoxServer(async (base) => {
      const get = await fetch(`${base}/api/box/schedule`, {
        headers: { ...authHeaders(token), "tailscale-funnel-request": "?1" },
      });
      assert.equal(get.status, 403);
      assert.equal((await get.json()).code, "NETWORK_DENIED");

      const decided = await post(base, `/api/box/bookings/${booking.id}/approve`, {
        ...authHeaders(token), "tailscale-funnel-request": "?1",
      });
      assert.equal(decided.status, 403);
      assert.equal((await decided.json()).code, "NETWORK_DENIED");
    });
  } finally {
    if (prev === undefined) delete process.env.CROW_DASHBOARD_PUBLIC;
    else process.env.CROW_DASHBOARD_PUBLIC = prev;
  }
});

test("corrupt calendar answers 503 calendar_corrupt on GET", async () => {
  resetState();
  const h = await harness();
  const token = "corrupt-session-token";
  await seedSession(h.db, token);
  activateHold({ owner: "alex", reason: "still readable", minutes: 30, kind: "manual" });
  writeFileSync(schedulePath(), "{ this is not json", "utf8");

  await withBoxServer(async (base) => {
    const r = await fetch(`${base}/api/box/schedule`, { headers: authHeaders(token) });
    assert.equal(r.status, 503);
    const body = await r.json();
    assert.equal(body.code, "calendar_corrupt");
    assert.equal(body.active.owner, "alex", "the readable hold still comes back");
    assert.deepEqual(body.bookings, undefined);
  });
});

test("approving a non-pending booking is 409", async () => {
  resetState();
  const h = await harness();
  const token = "not-pending-session-token";
  await seedSession(h.db, token);
  const booking = book({
    owner: "alex", kind: "window", mode: "exclusive", start: Date.now() + HOUR,
    minutes: 30, created_by: "test",
  });
  assert.equal(booking.approval.state, "not_needed");

  await withBoxServer(async (base) => {
    const r = await post(base, `/api/box/bookings/${booking.id}/approve`, authHeaders(token));
    assert.equal(r.status, 409);
    assert.equal((await r.json()).code, "booking_approval_not_pending");
  });
});

test("unknown booking id is 404", async () => {
  resetState();
  const h = await harness();
  const token = "unknown-id-session-token";
  await seedSession(h.db, token);

  await withBoxServer(async (base) => {
    const r = await post(base, "/api/box/bookings/bk_000000000000/approve", authHeaders(token));
    assert.equal(r.status, 404);
    assert.equal((await r.json()).code, "booking_not_found");
  });
});

test("bad range is 400", async () => {
  resetState();
  const h = await harness();
  const token = "bad-range-session-token";
  await seedSession(h.db, token);

  await withBoxServer(async (base) => {
    for (const query of ["from=not-a-date", "to=yesterday", `from=${Date.now() + HOUR}&to=${Date.now()}`]) {
      const r = await fetch(`${base}/api/box/schedule?${query}`, { headers: authHeaders(token) });
      assert.equal(r.status, 400, query);
      assert.equal((await r.json()).code, "bad_range", query);
    }
  });
});

// ---------------------------------------------------------------------------
// A conflict found while approving, and an unreadable hold, keep their own
// statuses (409 with the blocker, 503) instead of the generic 500.

test("approving a booking that now conflicts answers 409 booking_conflict and leaves it pending", async () => {
  resetState();
  const h = await harness();
  const token = "approve-conflict-session-token";
  await seedSession(h.db, token);
  const pending = book({
    owner: "alex", kind: "gpu-job", mode: "exclusive", start: Date.now() + HOUR, minutes: 60,
    evict: ["crow-chat"], created_by: "test",
  });
  assert.equal(pending.approval.state, "pending");
  // A row written straight into the calendar file, the way a second writer
  // that never went through book() would: it overlaps the pending slot.
  const raw = JSON.parse(readFileSync(schedulePath(), "utf8"));
  const startMs = Date.parse(pending.start);
  const intruder = {
    id: "bk_00000000feed", owner: "sam", kind: "manual", mode: "exclusive",
    start: new Date(startMs + 15 * 60_000).toISOString(),
    end: new Date(startMs + 45 * 60_000).toISOString(),
    reason: "", allow: [], evict: [], approval: { state: "not_needed" },
    status: "booked", created_by: "sam", created_at: new Date().toISOString(),
  };
  raw.bookings.push(intruder);
  writeFileSync(schedulePath(), JSON.stringify(raw, null, 2) + "\n");

  await withBoxServer(async (base) => {
    const r = await post(base, `/api/box/bookings/${pending.id}/approve`, authHeaders(token));
    assert.equal(r.status, 409);
    const body = await r.json();
    assert.equal(body.code, "booking_conflict");
    assert.equal(body.conflict.id, intruder.id, "the answer names the booking in the way");
    assert.equal(body.conflict.owner, "sam");
  });

  const stored = listBookings({ from: Date.now() - HOUR, to: Date.now() + 6 * HOUR });
  assert.equal(stored.find((b) => b.id === pending.id).approval.state, "pending", "it stays pending");
});

test("a corrupt hold file answers 503 hold_corrupt on approve", async () => {
  resetState();
  const h = await harness();
  const token = "hold-corrupt-session-token";
  await seedSession(h.db, token);
  const pending = book({
    owner: "alex", kind: "manual", mode: "exclusive", start: Date.now() + HOUR, minutes: 30,
    needs_approval: true, reason: "ask first", created_by: "test",
  });
  writeFileSync(reservationPath(), "{ this is not json", "utf8");

  await withBoxServer(async (base) => {
    const r = await post(base, `/api/box/bookings/${pending.id}/approve`, authHeaders(token));
    assert.equal(r.status, 503);
    assert.equal((await r.json()).code, "hold_corrupt");
  });

  const stored = listBookings({ from: Date.now() - HOUR, to: Date.now() + 6 * HOUR });
  assert.equal(stored.find((b) => b.id === pending.id).approval.state, "pending");
});