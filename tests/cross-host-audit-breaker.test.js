/**
 * cross-host-audit-breaker.test.js
 *
 * Task 2: circuit-breaker + DB-free loud alert when the cross_host_calls
 * audit DB goes structurally corrupt.
 *
 * Contract under test (all in servers/shared/cross-host-auth.js):
 *  - 3 STRUCTURAL insert errors (malformed / not-a-database / disk image /
 *    disk I/O / SQLITE_IOERR) trip the breaker → isAuditDegraded() === true.
 *  - Once tripped, auditCrossHostCall short-circuits: it does NOT call
 *    db.execute (stop feeding the corruption).
 *  - Exactly one LOUD alert fires on trip, routed through the DB-free push
 *    channels (sendNtfyNotification / sendEmailNotification) — NOT
 *    createNotification (which INSERTs to the same corrupt crow.db first).
 *  - A transient SQLITE_BUSY does NOT trip it; an IOERR DOES.
 *  - After a ~6h cooldown the alert RE-ARMS (a days-long degradation
 *    re-alerts instead of going silent after the first ping).
 *  - _resetAuditBreaker() clears every flag.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  auditCrossHostCall,
  isAuditDegraded,
  _resetAuditBreaker,
  _setAlertChannels,
  _setAuditClock,
  _loadAlertChannels,
} from "../servers/shared/cross-host-auth.js";

import { sendNtfyNotification as realNtfy } from "../servers/gateway/push/ntfy.js";
import { sendEmailNotification as realEmail } from "../servers/gateway/push/email.js";

const REC = { direction: "inbound", action: "test.audit" };

// A db whose .execute always throws `err` and counts its invocations.
function throwingDb(err) {
  const db = {
    calls: 0,
    async execute() {
      db.calls++;
      throw err;
    },
  };
  return db;
}

function spyChannels() {
  const spy = { ntfy: 0, email: 0, lastPayload: null };
  _setAlertChannels({
    async sendNtfyNotification(p) { spy.ntfy++; spy.lastPayload = p; },
    async sendEmailNotification(p) { spy.email++; },
  });
  return spy;
}

test("3 malformed insert errors trip the breaker and fire exactly one alert", async () => {
  _resetAuditBreaker();
  const spy = spyChannels();
  const db = throwingDb(new Error("database disk image is malformed"));

  assert.equal(isAuditDegraded(), false);
  for (let i = 0; i < 3; i++) await auditCrossHostCall(db, REC);

  assert.equal(isAuditDegraded(), true, "breaker tripped after 3 structural errors");
  assert.equal(db.calls, 3, "all 3 inserts were attempted before tripping");
  assert.equal(spy.ntfy, 1, "one ntfy alert on trip");
  assert.equal(spy.email, 1, "one email alert on trip");
  assert.match(spy.lastPayload.body, /recover-db/);
  assert.equal(spy.lastPayload.priority, "high", "high priority so the email channel actually sends");
  _resetAuditBreaker();
});

test("once tripped, auditCrossHostCall does NOT touch db.execute", async () => {
  _resetAuditBreaker();
  spyChannels();
  const db = throwingDb(new Error("database disk image is malformed"));
  for (let i = 0; i < 3; i++) await auditCrossHostCall(db, REC);
  assert.equal(db.calls, 3);

  // Breaker open → subsequent calls skip the INSERT entirely.
  await auditCrossHostCall(db, REC);
  await auditCrossHostCall(db, REC);
  assert.equal(db.calls, 3, "no further db.execute while breaker is open");
  _resetAuditBreaker();
});

test("transient SQLITE_BUSY does NOT trip the breaker", async () => {
  _resetAuditBreaker();
  const spy = spyChannels();
  const db = throwingDb(new Error("SQLITE_BUSY: database is locked"));
  for (let i = 0; i < 6; i++) await auditCrossHostCall(db, REC);
  assert.equal(isAuditDegraded(), false, "SQLITE_BUSY is transient, must not trip");
  assert.equal(db.calls, 6, "keeps attempting inserts (never short-circuits)");
  assert.equal(spy.ntfy, 0, "no alert for transient errors");
  _resetAuditBreaker();
});

test("SQLITE_IOERR (structural) DOES trip the breaker", async () => {
  _resetAuditBreaker();
  spyChannels();
  const db = throwingDb(new Error("SQLITE_IOERR: disk I/O error"));
  for (let i = 0; i < 3; i++) await auditCrossHostCall(db, REC);
  assert.equal(isAuditDegraded(), true, "IOERR is structural, must trip");
  _resetAuditBreaker();
});

test("alert re-arms after the ~6h cooldown", async () => {
  _resetAuditBreaker();
  let clock = 1_000_000_000;
  _setAuditClock(() => clock);
  const spy = spyChannels();
  const db = throwingDb(new Error("database disk image is malformed"));

  for (let i = 0; i < 3; i++) await auditCrossHostCall(db, REC);
  assert.equal(spy.ntfy, 1, "alerted once on trip");

  // Still within cooldown → no re-alert on subsequent (short-circuited) calls.
  clock += 60 * 60 * 1000; // +1h
  await auditCrossHostCall(db, REC);
  assert.equal(spy.ntfy, 1, "no re-alert within cooldown");

  // Past 6h → re-arm fires again.
  clock += 6 * 60 * 60 * 1000; // +6h more
  await auditCrossHostCall(db, REC);
  assert.equal(spy.ntfy, 2, "re-alerted after 6h cooldown");
  _resetAuditBreaker();
});

test("_resetAuditBreaker clears all breaker state", async () => {
  _resetAuditBreaker();
  spyChannels();
  const db = throwingDb(new Error("database disk image is malformed"));
  for (let i = 0; i < 3; i++) await auditCrossHostCall(db, REC);
  assert.equal(isAuditDegraded(), true);

  _resetAuditBreaker();
  assert.equal(isAuditDegraded(), false, "reset clears the tripped flag");

  // After reset, a fresh healthy db is used again (no short-circuit).
  const ok = { calls: 0, async execute() { ok.calls++; return { rows: [] }; } };
  await auditCrossHostCall(ok, REC);
  assert.equal(ok.calls, 1, "reset re-enables inserts");
  _resetAuditBreaker();
});

test("default alert channels resolve to the DB-free push modules, NOT createNotification", async () => {
  _setAlertChannels(null); // clear any test override → exercise the real dynamic import
  const ch = await _loadAlertChannels();
  assert.strictEqual(ch.sendNtfyNotification, realNtfy, "uses gateway/push/ntfy.js sendNtfyNotification");
  assert.strictEqual(ch.sendEmailNotification, realEmail, "uses gateway/push/email.js sendEmailNotification");
});

test("a throwing alert channel never propagates into the auth path", async () => {
  _resetAuditBreaker();
  _setAlertChannels({
    async sendNtfyNotification() { throw new Error("ntfy down"); },
    async sendEmailNotification() { throw new Error("resend down"); },
  });
  const db = throwingDb(new Error("database disk image is malformed"));
  // Must not reject even though both alert channels throw.
  await assert.doesNotReject(async () => {
    for (let i = 0; i < 3; i++) await auditCrossHostCall(db, REC);
  });
  assert.equal(isAuditDegraded(), true);
  _resetAuditBreaker();
});
