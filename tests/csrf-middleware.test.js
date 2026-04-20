import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { csrfMiddleware, csrfInput } from "../servers/gateway/dashboard/shared/csrf.js";

// Capture and restore CROW_CSRF_STRICT between tests so mutating it
// inside one test doesn't leak into siblings.
let savedStrict;
beforeEach(() => { savedStrict = process.env.CROW_CSRF_STRICT; });
afterEach(() => {
  if (savedStrict === undefined) delete process.env.CROW_CSRF_STRICT;
  else process.env.CROW_CSRF_STRICT = savedStrict;
});

/** Construct a minimal request + response duo for middleware tests. */
function mkReq({ method = "POST", cookies = {}, headers = {}, body = {} } = {}) {
  const cookieHeader = Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
  return {
    method,
    headers: { ...(cookieHeader ? { cookie: cookieHeader } : {}), ...headers },
    body,
  };
}
function mkRes() {
  const res = {
    statusCode: null,
    _body: null,
    _type: null,
    status(code) { this.statusCode = code; return this; },
    type(t) { this._type = t; return this; },
    send(body) { this._body = body; return this; },
  };
  return res;
}

test("csrfMiddleware: GET passes without any CSRF check", () => {
  const req = mkReq({ method: "GET" });
  const res = mkRes();
  let nextCalled = false;
  csrfMiddleware(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, null);
});

test("csrfMiddleware: POST with no session cookie passes (pre-auth flow)", () => {
  // Login/reset/2fa-setup forms submit before a session exists. The middleware
  // must not block them; they have their own rate-limit + lockout defenses.
  const req = mkReq({ method: "POST", cookies: {} });
  const res = mkRes();
  let nextCalled = false;
  csrfMiddleware(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, null);
});

test("csrfMiddleware: POST with HMAC signature bypasses CSRF check", () => {
  // Cross-host peer calls use HMAC, which is a strictly stronger check.
  const req = mkReq({
    method: "POST",
    cookies: { crow_session: "abc", crow_csrf: "zzz" },
    headers: { "x-crow-signature": "deadbeef" },
  });
  const res = mkRes();
  let nextCalled = false;
  csrfMiddleware(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

test("csrfMiddleware: authenticated POST without cookie value is rejected", () => {
  // Session cookie present but CSRF cookie absent → 403.
  const req = mkReq({ method: "POST", cookies: { crow_session: "abc" } });
  const res = mkRes();
  csrfMiddleware(req, res, () => { throw new Error("next should not fire"); });
  assert.equal(res.statusCode, 403);
});

test("csrfMiddleware: authenticated POST without echoed token is rejected", () => {
  const req = mkReq({
    method: "POST",
    cookies: { crow_session: "abc", crow_csrf: "token-xyz" },
  });
  const res = mkRes();
  csrfMiddleware(req, res, () => { throw new Error("next should not fire"); });
  assert.equal(res.statusCode, 403);
});

test("csrfMiddleware: matching X-Crow-Csrf header passes", () => {
  const req = mkReq({
    method: "POST",
    cookies: { crow_session: "abc", crow_csrf: "token-xyz" },
    headers: { "x-crow-csrf": "token-xyz" },
  });
  const res = mkRes();
  let nextCalled = false;
  csrfMiddleware(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

test("csrfMiddleware: matching _csrf body field passes", () => {
  const req = mkReq({
    method: "POST",
    cookies: { crow_session: "abc", crow_csrf: "token-xyz" },
    body: { _csrf: "token-xyz", other: "value" },
  });
  const res = mkRes();
  let nextCalled = false;
  csrfMiddleware(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

test("csrfMiddleware: mismatched token is rejected", () => {
  const req = mkReq({
    method: "POST",
    cookies: { crow_session: "abc", crow_csrf: "cookie-value" },
    headers: { "x-crow-csrf": "different-value" },
  });
  const res = mkRes();
  csrfMiddleware(req, res, () => { throw new Error("next should not fire"); });
  assert.equal(res.statusCode, 403);
});

test("csrfMiddleware: PUT, DELETE, PATCH are all gated", () => {
  for (const method of ["PUT", "DELETE", "PATCH"]) {
    const req = mkReq({ method, cookies: { crow_session: "abc", crow_csrf: "x" } });
    const res = mkRes();
    csrfMiddleware(req, res, () => { throw new Error(`next should not fire for ${method}`); });
    assert.equal(res.statusCode, 403, `${method} must be CSRF-gated`);
  }
});

test("csrfMiddleware: CROW_CSRF_STRICT=0 disables validation", () => {
  process.env.CROW_CSRF_STRICT = "0";
  const req = mkReq({
    method: "POST",
    cookies: { crow_session: "abc", crow_csrf: "cookie-value" },
    // No echoed token — would normally 403.
  });
  const res = mkRes();
  let nextCalled = false;
  csrfMiddleware(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, null);
});

test("csrfMiddleware: populates req.csrfToken from cookie for templates", () => {
  const req = mkReq({
    method: "GET",
    cookies: { crow_session: "abc", crow_csrf: "cookie-value" },
  });
  const res = mkRes();
  csrfMiddleware(req, res, () => {});
  assert.equal(req.csrfToken, "cookie-value");
});

test("csrfInput: emits hidden input with escaped token value", () => {
  assert.equal(
    csrfInput({ csrfToken: "abc123" }),
    '<input type="hidden" name="_csrf" value="abc123">',
  );
});

test("csrfInput: handles missing token gracefully", () => {
  assert.equal(
    csrfInput({}),
    '<input type="hidden" name="_csrf" value="">',
  );
  assert.equal(
    csrfInput(null),
    '<input type="hidden" name="_csrf" value="">',
  );
});

test("csrfMiddleware: constant-time comparison does not short-circuit on length", () => {
  // This isn't a true timing test (would require statistical measurement),
  // but verifies the function returns 403 for inputs of different lengths
  // without throwing.
  const req = mkReq({
    method: "POST",
    cookies: { crow_session: "abc", crow_csrf: "long-token-value" },
    headers: { "x-crow-csrf": "short" },
  });
  const res = mkRes();
  csrfMiddleware(req, res, () => { throw new Error("next should not fire"); });
  assert.equal(res.statusCode, 403);
});
