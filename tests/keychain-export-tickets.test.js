/** One-time keychain Export download tickets (2026-10-20): the pure state machine. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createExportTickets, TOKEN_RE } from "../servers/gateway/keychain/export-tickets.js";

const payload = (n = 1) => ({ file: { format: "crow-keychain-export", count: n }, filename: "crow-keychain-2026-10-20.json", keyId: "k1", snapshot: { 1: "fp" }, count: n });
const clock = () => { const c = { t: 1_000_000 }; c.now = () => c.t; return c; };

test("issue gives a 43-char base64url token; take serves once to the same session, then 'used'", () => {
  const c = clock();
  const T = createExportTickets({ now: c.now });
  const { token, expiresAt } = T.issue("S1", payload(2));
  assert.match(token, TOKEN_RE);
  assert.equal(expiresAt, c.t + 120_000);
  const a = T.take(token, "S1");
  assert.equal(a.error, undefined);
  assert.deepEqual(a.file, payload(2).file);
  assert.equal(a.count, 2);
  assert.deepEqual(a.record, { keyId: "k1", snapshot: { 1: "fp" }, count: 2 });
  assert.equal(T.take(token, "S1").error, "used");
});

test("another session or an unknown / malformed token is not_found and does NOT consume the ticket", () => {
  const T = createExportTickets({ now: clock().now });
  const { token } = T.issue("S1", payload());
  assert.equal(T.take(token, "S2").error, "not_found");
  assert.equal(T.take(token, null).error, "not_found");
  assert.equal(T.take("x".repeat(43), "S1").error, "not_found");
  assert.equal(T.take("bad token!", "S1").error, "not_found");
  assert.equal(T.take(undefined, "S1").error, "not_found");
  assert.equal(T.take(token, "S1").error, undefined, "still there for its owner");
});

test("an expired ticket is 'expired' and gone", () => {
  const c = clock();
  const T = createExportTickets({ now: c.now });
  const { token } = T.issue("S1", payload());
  c.t += 120_001;
  assert.equal(T.take(token, "S1").error, "expired");
  assert.ok(!JSON.stringify(T._debugEntries()).includes("crow-keychain-export"), "the sealed file is dropped at expiry");
  c.t += 600_001;
  assert.equal(T.size(), 0, "the husk goes too");
});

test("a new Export replaces only a ready link, never a file the app is still saving", () => {
  const T = createExportTickets({ now: clock().now });
  const a = T.issue("S1", payload()).token;
  T.take(a, "S1", { deferRecord: true });
  const b = T.issue("S1", payload()).token;
  assert.ok(T.confirm(a, "S1").snapshot, "the first save can still be confirmed");
  assert.equal(T.take(b, "S1").error, undefined);
});

test("deferRecord: take returns no record; confirm returns it once, same session only, inside the confirm window", () => {
  const c = clock();
  const T = createExportTickets({ now: c.now });
  const { token } = T.issue("S1", payload(3));
  const a = T.take(token, "S1", { deferRecord: true });
  assert.equal(a.record, null);
  assert.equal(T.take(token, "S1").error, "used", "the file is served once either way");
  assert.equal(T.confirm(token, "S2").error, "not_found");
  c.t += 599_000;
  assert.deepEqual(T.confirm(token, "S1"), { keyId: "k1", snapshot: { 1: "fp" }, count: 3 });
  assert.equal(T.confirm(token, "S1").error, "not_found", "confirmed once");
});

test("confirm before any take, after a non-deferred take, or after the window fails", () => {
  const c = clock();
  const T = createExportTickets({ now: c.now });
  const a = T.issue("S1", payload());
  assert.equal(T.confirm(a.token, "S1").error, "not_served");
  T.take(a.token, "S1");
  assert.equal(T.confirm(a.token, "S1").error, "used");
  const b = T.issue("S1", payload());
  T.take(b.token, "S1", { deferRecord: true });
  c.t += 600_001;
  assert.equal(T.confirm(b.token, "S1").error, "expired");
});

test("one live ticket per session; a global cap drops the oldest", () => {
  const T = createExportTickets({ now: clock().now, max: 3 });
  assert.equal(createExportTickets().issue("Z", payload()).token.length, 43);
  const first = T.issue("S1", payload()).token;
  const second = T.issue("S1", payload()).token;
  assert.equal(T.take(first, "S1").error, "not_found", "superseded");
  assert.equal(T.size(), 1);
  const b = T.issue("S2", payload()).token;
  T.issue("S3", payload());
  T.issue("S4", payload());
  assert.equal(T.size(), 3);
  assert.equal(T.take(second, "S1").error, "not_found", "the oldest went first");
  assert.equal(T.take(b, "S2").error, undefined);
});

test("served tickets drop the sealed file; the store keys hashes, never the token or the session", () => {
  const T = createExportTickets({ now: clock().now });
  const { token } = T.issue("session-secret-value", payload());
  T.take(token, "session-secret-value", { deferRecord: true });
  const dump = JSON.stringify(T._debugEntries());
  assert.ok(!dump.includes(token));
  assert.ok(!dump.includes("session-secret-value"));
  assert.ok(!dump.includes("crow-keychain-export"), "the file is not kept after it was served");
});
