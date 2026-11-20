/**
 * The CSRF rail (queue item #51 PR-1).
 *
 * The token is SERVER-BOUND: HMAC-SHA256(secret in <CROW_HOME>/secrets/csrf.key,
 * session id), base64url. It is never compared to a cookie — the old
 * double-submit cookie was forgeable from any same-site host (`ts.net` is a
 * public suffix, so every host on the tailnet is same-site and can toss a
 * `Domain=<tailnet>.ts.net` cookie). These tests pin: the HMAC, the refusal
 * kinds, the kill-switch, the `__Host-` session cookie over HTTPS, and a forged
 * cookie being entirely ignored.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const CROW_HOME = mkdtempSync(join(tmpdir(), "crow-csrf-test-"));
process.env.CROW_HOME = CROW_HOME;

const {
  csrfMiddleware, csrfInput, csrfRefusal, csrfTokenAccepted, csrfTokenForSession,
  csrfTokenForRequest, csrfTokenMatches, REFUSAL_HEADER,
} = await import("../servers/gateway/dashboard/shared/csrf.js");

let savedStrict;
beforeEach(() => { savedStrict = process.env.CROW_CSRF_STRICT; });
afterEach(() => {
  if (savedStrict === undefined) delete process.env.CROW_CSRF_STRICT;
  else process.env.CROW_CSRF_STRICT = savedStrict;
});
process.on("exit", () => { try { rmSync(CROW_HOME, { recursive: true, force: true }); } catch {} });

/** Minimal request: `secure` drives the `__Host-` cookie name (auth.js). */
function mkReq({ method = "POST", cookies = {}, headers = {}, body = {}, secure = false } = {}) {
  const cookieHeader = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
  return {
    method,
    secure,
    cookies,
    headers: { ...(cookieHeader ? { cookie: cookieHeader } : {}), ...headers },
    body,
  };
}
function mkRes() {
  return {
    statusCode: null,
    _body: null,
    _type: null,
    _headers: {},
    headersSent: false,
    setHeader(name, value) { this._headers[String(name).toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    type(t) { this._type = t; return this; },
    send(body) { this._body = body; this.headersSent = true; return this; },
  };
}
const run = (req) => {
  const res = mkRes();
  let nextCalled = false;
  csrfMiddleware(req, res, () => { nextCalled = true; });
  return { res, nextCalled };
};
const SESSION = "session-token-abc";
const TOKEN = csrfTokenForSession(SESSION);

test("the token is a stable HMAC of the session id (base64url, not the cookie value)", () => {
  assert.equal(csrfTokenForSession(SESSION), TOKEN);
  assert.match(TOKEN, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(TOKEN, SESSION, "the token is never the session id itself");
  assert.notEqual(csrfTokenForSession("another-session"), TOKEN);
  assert.equal(csrfTokenForSession(""), "");
  assert.equal(csrfTokenForSession(null), "");
});

test("GET passes without any CSRF check", () => {
  const { res, nextCalled } = run(mkReq({ method: "GET" }));
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, null);
});

test("POST with no session cookie passes (pre-auth flow)", () => {
  const { res, nextCalled } = run(mkReq({ method: "POST" }));
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, null);
});

test("an HMAC-signed peer call bypasses CSRF (a stronger check)", () => {
  const req = mkReq({
    cookies: { crow_session: SESSION },
    headers: { "x-crow-signature": "deadbeef" },
  });
  assert.equal(csrfRefusal(req), null);
});

test("the session's own token passes via X-Crow-Csrf", () => {
  const { res, nextCalled } = run(mkReq({ cookies: { crow_session: SESSION }, headers: { "x-crow-csrf": TOKEN } }));
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, null);
});

test("the session's own token passes via the _csrf body field", () => {
  const { nextCalled } = run(mkReq({ cookies: { crow_session: SESSION }, body: { _csrf: TOKEN, other: "value" } }));
  assert.equal(nextCalled, true);
});

test("a COOKIE-TOSSING attempt fails: a forged crow_csrf cookie plus a matching header is refused", () => {
  // The shape of the attack this PR closes: a same-site host (any
  // <x>.<tailnet>.ts.net) sets crow_csrf=forged, and echoes it. Under the old
  // double-submit rule that matched; now only the server's HMAC does.
  const req = mkReq({
    cookies: { crow_session: SESSION, crow_csrf: "forged-by-a-sibling-host" },
    headers: { "x-crow-csrf": "forged-by-a-sibling-host" },
  });
  const { res, nextCalled } = run(req);
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res._headers[REFUSAL_HEADER.toLowerCase()], "mismatch");
});

test("a token minted for ANOTHER session is refused (no cross-session replay)", () => {
  const other = csrfTokenForSession("someone-elses-session");
  const { res } = run(mkReq({ cookies: { crow_session: SESSION }, headers: { "x-crow-csrf": other } }));
  assert.equal(res.statusCode, 403);
});

test("no echoed token is 'absent'; a wrong one is 'mismatch'", () => {
  assert.equal(csrfRefusal(mkReq({ cookies: { crow_session: SESSION } })), "absent");
  assert.equal(csrfRefusal(mkReq({ cookies: { crow_session: SESSION }, headers: { "x-crow-csrf": "nope" } })), "mismatch");
});

test("PUT, DELETE and PATCH are all gated", () => {
  for (const method of ["PUT", "DELETE", "PATCH"]) {
    const { res } = run(mkReq({ method, cookies: { crow_session: SESSION } }));
    assert.equal(res.statusCode, 403, `${method} must be CSRF-gated`);
  }
});

test("CROW_CSRF_STRICT=0 disables validation globally (rollback switch)", () => {
  process.env.CROW_CSRF_STRICT = "0";
  const { nextCalled, res } = run(mkReq({ cookies: { crow_session: SESSION } }));
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, null);
  assert.equal(csrfTokenAccepted(mkReq({ cookies: { crow_session: SESSION } }), "anything"), true);
});

test("csrfMiddleware populates req.csrfToken with the SERVER-BOUND token", () => {
  const req = mkReq({ method: "GET", cookies: { crow_session: SESSION, crow_csrf: "a-stale-cookie" } });
  const res = mkRes();
  csrfMiddleware(req, res, () => {});
  assert.equal(req.csrfToken, TOKEN, "the cookie value is ignored entirely");
});

test("req.csrfToken is absent when the request carries no session", () => {
  const req = mkReq({ method: "GET" });
  csrfMiddleware(req, mkRes(), () => {});
  assert.equal(req.csrfToken, undefined);
});

test("over HTTPS only __Host-crow_session is read; a plain crow_session is ignored once __Host- exists", () => {
  assert.equal(csrfTokenForRequest(mkReq({ secure: true, cookies: { "__Host-crow_session": "host-tok" } })), csrfTokenForSession("host-tok"));
  // Both present (an attacker tossed the plain one): the __Host- cookie wins.
  assert.equal(
    csrfTokenForRequest(mkReq({ secure: true, cookies: { "__Host-crow_session": "host-tok", crow_session: "tossed" } })),
    csrfTokenForSession("host-tok"),
  );
  // Migration: no __Host- yet, the plain cookie from an older release is accepted once.
  assert.equal(csrfTokenForRequest(mkReq({ secure: true, cookies: { crow_session: "legacy" } })), csrfTokenForSession("legacy"));
  // Plain HTTP keeps the plain name and never reads a __Host- one.
  assert.equal(csrfTokenForRequest(mkReq({ cookies: { crow_session: "lan" } })), csrfTokenForSession("lan"));
});

test("csrfTokenAccepted (WebSocket first frame) uses the same server-bound token", () => {
  const req = mkReq({ cookies: { crow_session: SESSION } });
  assert.equal(csrfTokenAccepted(req, TOKEN), true);
  assert.equal(csrfTokenAccepted(req, "forged"), false);
  assert.equal(csrfTokenAccepted(req, ""), false);
  assert.equal(csrfTokenAccepted(mkReq({}), TOKEN), false, "no session, no token");
});

test("csrfTokenMatches ignores the kill-switch (the OAuth consent grant keeps its rail)", () => {
  process.env.CROW_CSRF_STRICT = "0";
  const req = mkReq({ cookies: { crow_session: SESSION } });
  assert.equal(csrfTokenAccepted(req, "anything"), true, "kill-switch applies to the conventional check");
  assert.equal(csrfTokenMatches(req, "anything"), false, "…but not to this one");
  assert.equal(csrfTokenMatches(req, TOKEN), true);
});

test("csrfInput: emits hidden input with escaped token value", () => {
  assert.equal(csrfInput({ csrfToken: "abc123" }), '<input type="hidden" name="_csrf" value="abc123">');
  assert.equal(csrfInput({}), '<input type="hidden" name="_csrf" value="">');
  assert.equal(csrfInput(null), '<input type="hidden" name="_csrf" value="">');
});

test("constant-time comparison does not short-circuit on length", () => {
  const { res } = run(mkReq({ cookies: { crow_session: SESSION }, headers: { "x-crow-csrf": "short" } }));
  assert.equal(res.statusCode, 403);
});

// ---- review F4: a corrupt key file is loud, quarantined, and replaced ---------
//
// A key file that exists but cannot be read used to be silent: createSecret's
// hard-link lost to the file already there, so the process kept a fresh RANDOM
// key that was never written — a different secret on every boot, and every
// token minted from one dying with the process. Now the bad file is renamed
// aside (kept, 0600: it may hold a real key that a permissions accident hid) and
// a fresh one is created, with a loud line in the log.

const { csrfSecret, csrfSecretPath, forgetCsrfSecret } = await import("../servers/gateway/dashboard/shared/csrf-secret.js");

test("a corrupt csrf.key is logged loudly, moved aside, and replaced by a real key", () => {
  const home = mkdtempSync(join(tmpdir(), "crow-csrf-key-"));
  const path = csrfSecretPath(home);
  mkdirSync(join(home, "secrets"), { recursive: true, mode: 0o700 });
  writeFileSync(path, "{ this is not json", { mode: 0o600 });

  const logged = [];
  const realError = console.error;
  console.error = (...args) => { logged.push(args.join(" ")); };
  let key;
  try {
    forgetCsrfSecret();
    key = csrfSecret({ crowHome: home });
  } finally {
    console.error = realError;
  }

  assert.ok(Buffer.isBuffer(key) && key.length >= 32, "a usable secret comes back");
  assert.equal(logged.filter((m) => /csrf\.key/.test(m)).length, 1, `one loud line: ${JSON.stringify(logged)}`);
  assert.ok(/moved aside/.test(logged[0]), logged[0]);

  // A real key file now exists and the broken one was KEPT, under .bad-<ts>.
  assert.ok(existsSync(path), "a fresh csrf.key was written");
  const fresh = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(Buffer.from(fresh.key, "base64").length, 32);
  assert.equal(statSync(path).mode & 0o777, 0o600, "still 0600");
  const aside = readdirSync(join(home, "secrets")).filter((f) => f.startsWith("csrf.key.bad-"));
  assert.equal(aside.length, 1, "the corrupt file is kept aside: " + readdirSync(join(home, "secrets")).join(", "));
  assert.equal(readFileSync(join(home, "secrets", aside[0]), "utf8"), "{ this is not json");
  assert.equal(statSync(join(home, "secrets", aside[0])).mode & 0o777, 0o600, "and is as private as one");

  // THE point: the new secret is persisted, not a per-process random. A second
  // "boot" (cache forgotten) reads the same key back.
  forgetCsrfSecret();
  const again = csrfSecret({ crowHome: home });
  assert.deepEqual(again, key, "the secret is stable across boots");
  rmSync(home, { recursive: true, force: true });
});

test("a key that is valid JSON but far too short is treated as corrupt too", () => {
  const home = mkdtempSync(join(tmpdir(), "crow-csrf-key-short-"));
  const path = csrfSecretPath(home);
  mkdirSync(join(home, "secrets"), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify({ v: 1, key: Buffer.alloc(8).toString("base64") }), { mode: 0o600 });
  const realError = console.error;
  console.error = () => {};
  let key;
  try {
    forgetCsrfSecret();
    key = csrfSecret({ crowHome: home });
  } finally {
    console.error = realError;
  }
  assert.equal(key.length, 32);
  assert.ok(readdirSync(join(home, "secrets")).some((f) => f.startsWith("csrf.key.bad-")));
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).key, key.toString("base64"));
  rmSync(home, { recursive: true, force: true });
  forgetCsrfSecret();
});