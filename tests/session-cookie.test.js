/**
 * The session cookie over HTTPS: `__Host-crow_session` is chosen by the REQUEST
 * (requestIsSecure), not by CROW_HOSTED/NODE_ENV, so Tailscale Serve and the
 * installer's Caddy — TLS terminated at the proxy, loopback at the gateway —
 * still get the `__Host-` cookie.
 *
 * Review F1 is pinned here: a DUPLICATED plain `crow_session` must not decide
 * anything while `__Host-` is present (a sibling host can toss two plain copies —
 * `Domain=<tailnet>.ts.net`, two Paths — and refusing those locked the owner out
 * permanently). Only a duplicated `__Host-` name, which no sibling can set, is
 * refused. The plain-only migration is still refused when the plain name is
 * duplicated.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

const {
  requestIsSecure,
  sessionFromCookies,
  sessionTokenFromRequest,
  sessionFromRequest,
  setSessionCookie,
  clearSessionCookie,
  cookieDomainCandidate,
  remainingLifetimeMs,
} = await import("../servers/gateway/dashboard/auth.js");

const saved = {
  proxies: process.env.CROW_TRUSTED_PROXIES,
  publicDashboard: process.env.CROW_DASHBOARD_PUBLIC,
};
afterEach(() => {
  if (saved.proxies === undefined) delete process.env.CROW_TRUSTED_PROXIES;
  else process.env.CROW_TRUSTED_PROXIES = saved.proxies;
  if (saved.publicDashboard === undefined) delete process.env.CROW_DASHBOARD_PUBLIC;
  else process.env.CROW_DASHBOARD_PUBLIC = saved.publicDashboard;
});

/** A raw request shape (no Express `secure` getter), as an upgrade sees it. */
function raw({ remoteAddress = "127.0.0.1", headers = {}, encrypted = false } = {}) {
  return { socket: { remoteAddress, encrypted }, headers };
}

function cookieReq(cookie, extra = {}) {
  return { secure: false, headers: { cookie }, ...extra };
}

function headersOf(fn) {
  const headers = {};
  fn({ setHeader: (name, value) => { headers[name] = value; } });
  return headers["Set-Cookie"] || [];
}

// ---- requestIsSecure ------------------------------------------------------

test("req.secure is authoritative on an Express request", () => {
  assert.equal(requestIsSecure({ secure: true, headers: {} }), true);
  // Even if an untrusted caller stamped the header, Express's answer wins.
  assert.equal(requestIsSecure({ secure: false, headers: { "x-forwarded-proto": "https" } }), false);
});

test("a raw request trusts X-Forwarded-Proto only from a verified proxy hop", () => {
  delete process.env.CROW_TRUSTED_PROXIES;
  assert.equal(
    requestIsSecure(raw({ headers: { "x-forwarded-proto": "https" } })),
    false,
    "bare loopback cannot claim HTTPS by writing the header itself",
  );
  assert.equal(
    requestIsSecure(raw({ remoteAddress: "100.64.20.5", headers: { "x-forwarded-proto": "https" } })),
    false,
    "a direct client cannot claim HTTPS either",
  );

  process.env.CROW_TRUSTED_PROXIES = "loopback";
  assert.equal(
    requestIsSecure(raw({ headers: { "x-forwarded-proto": "https" } })),
    true,
    "the declared same-box proxy (Caddy/Serve) may speak for the scheme",
  );
  assert.equal(requestIsSecure(raw({ headers: { "x-forwarded-proto": "http" } })), false);
});

test("a TLS socket is secure even without a header", () => {
  assert.equal(requestIsSecure(raw({ encrypted: true })), true);
  assert.equal(requestIsSecure(raw({ encrypted: true, headers: { "x-forwarded-proto": "http" } })), true);
});

// ---- sessionFromCookies ---------------------------------------------------

test("plain HTTP keeps the plain crow_session cookie", () => {
  assert.deepEqual(sessionFromCookies(cookieReq("crow_session=lan-token")), { token: "lan-token", migrate: false });
  // A __Host- cookie is never read over plain HTTP.
  assert.deepEqual(sessionFromCookies(cookieReq("__Host-crow_session=host-token")), { token: null, migrate: false });
});

test("HTTPS reads only __Host-crow_session, and ignores a plain crow_session once it exists", () => {
  assert.deepEqual(
    sessionFromCookies(cookieReq("__Host-crow_session=host-token", { secure: true })),
    { token: "host-token", migrate: false },
  );
  // Both present (a sibling host tossed the plain one): the __Host- value wins,
  // and the plain one is not even a fallback.
  assert.deepEqual(
    sessionFromCookies(cookieReq("__Host-crow_session=host-token; crow_session=tossed", { secure: true })),
    { token: "host-token", migrate: false },
  );
  assert.equal(sessionTokenFromRequest(cookieReq("__Host-crow_session=host-token; crow_session=tossed", { secure: true })), "host-token");
});

test("HTTPS accepts a lone plain crow_session ONCE, for migration", () => {
  assert.deepEqual(
    sessionFromCookies(cookieReq("crow_session=legacy", { secure: true })),
    { token: "legacy", migrate: true },
  );
});

test("a duplicated PLAIN crow_session cannot lock the owner out while __Host- is present", () => {
  // The verified F1 lockout: a sibling host tossed two plain copies (its own
  // `Domain=<tailnet>.ts.net` cookie under two Paths). The owner's `__Host-`
  // cookie is untouchable by that sibling, so it decides — and only it.
  const cookie = "__Host-crow_session=GOOD; crow_session=a; crow_session=b";
  assert.deepEqual(
    sessionFromCookies(cookieReq(cookie, { secure: true })),
    { token: "GOOD", migrate: false },
    "the owner keeps their session",
  );
  assert.equal(sessionTokenFromRequest(cookieReq(cookie, { secure: true })), "GOOD");
  assert.deepEqual(
    sessionFromCookies(cookieReq(`crow_session=a; ${cookie}; crow_session=b`, { secure: true })),
    { token: "GOOD", migrate: false },
    "order in the header does not matter",
  );
});

test("a duplicated __Host-crow_session IS refused (no sibling can produce that shape)", () => {
  for (const cookie of [
    "__Host-crow_session=owner; __Host-crow_session=tossed",
    "__Host-crow_session=owner; crow_session=plain; __Host-crow_session=tossed",
  ]) {
    assert.deepEqual(
      sessionFromCookies(cookieReq(cookie, { secure: true })),
      { token: null, migrate: false },
      cookie,
    );
    assert.equal(sessionTokenFromRequest(cookieReq(cookie, { secure: true })), null, cookie);
  }
});

test("the migration path is refused when the plain crow_session is duplicated", () => {
  // No `__Host-` cookie to trust, and nothing says which plain value is the
  // owner's: the request is treated as signed out (the browser re-logs in).
  for (const cookie of [
    "crow_session=owner; crow_session=tossed",
    "crow_session=owner; crow_session=tossed; crow_session=third",
  ]) {
    assert.deepEqual(
      sessionFromCookies(cookieReq(cookie, { secure: true })),
      { token: null, migrate: false },
      cookie,
    );
  }
});

test("plain HTTP keeps refusing a duplicated crow_session, and never reads __Host-", () => {
  assert.deepEqual(
    sessionFromCookies(cookieReq("crow_session=owner; crow_session=tossed")),
    { token: null, migrate: false },
    "the only session name a plain-HTTP request carries is the plain one",
  );
  assert.deepEqual(
    sessionFromCookies(cookieReq("crow_session=owner; __Host-crow_session=a; __Host-crow_session=b")),
    { token: "owner", migrate: false },
    "__Host- is never read over plain HTTP, so its duplicates are inert there",
  );
});

test("a tossed duplicate reaches a session-gated caller as no session (401 / re-login)", async () => {
  process.env.CROW_DASHBOARD_PUBLIC = "true"; // network gate open; the cookie decides
  const req = cookieReq("crow_session=owner; crow_session=tossed");
  assert.equal(await sessionFromRequest(req), null);
});

// ---- setSessionCookie / clearSessionCookie --------------------------------

test("setSessionCookie follows the request's own HTTPS answer", () => {
  const secureReq = { secure: true };
  const plainReq = { secure: false };

  const secureCookies = headersOf((res) => setSessionCookie(res, "tok", undefined, { secure: requestIsSecure(secureReq) }));
  assert.match(secureCookies[0], /^__Host-crow_session=tok;/);
  assert.match(secureCookies[0], /; Secure/);

  const plainCookies = headersOf((res) => setSessionCookie(res, "tok", undefined, { secure: requestIsSecure(plainReq) }));
  assert.match(plainCookies[0], /^crow_session=tok;/);
  assert.doesNotMatch(plainCookies[0], /; Secure/);
});

test("the migration re-issue sets __Host- and expires the old plain cookie", () => {
  const cookies = headersOf((res) => setSessionCookie(res, "tok", 1000, { secure: true, expirePlain: true }));
  assert.ok(cookies.some((c) => /^__Host-crow_session=tok;/.test(c)), cookies.join(" | "));
  assert.ok(cookies.some((c) => /^crow_session=;.*Max-Age=0/.test(c)), "the plain cookie is expired");
  assert.ok(cookies.some((c) => /^crow_session=;.*; Secure/.test(c)), "with the attributes it was set with");
});

test("the migration re-issue also expires the parent-domain copy a sibling tossed", () => {
  const cookies = headersOf((res) => setSessionCookie(res, "tok", 1000, {
    secure: true, expirePlain: true, host: "crow.example.ts.net",
  }));
  assert.ok(cookies.some((c) => /^__Host-crow_session=tok;/.test(c)), cookies.join(" | "));
  const plain = cookies.filter((c) => c.startsWith("crow_session=;"));
  assert.equal(plain.length, 2, `host-only + parent domain: ${cookies.join(" | ")}`);
  assert.ok(plain.some((c) => !/; Domain=/.test(c)), "the host-only copy is expired");
  assert.ok(plain.some((c) => /; Domain=example\.ts\.net/.test(c)), "and the sibling's Domain= copy too");

  // A host with no parent worth naming gets only the host-only expiry.
  const bare = headersOf((res) => setSessionCookie(res, "tok", 1000, {
    secure: true, expirePlain: true, req: { headers: { host: "crow.example.ts.net" } },
  }));
  assert.equal(bare.filter((c) => c.startsWith("crow_session=;")).length, 2, "req.headers.host is read too");
  const loopback = headersOf((res) => setSessionCookie(res, "tok", 1000, {
    secure: true, expirePlain: true, host: "localhost:3001",
  }));
  assert.equal(loopback.filter((c) => c.startsWith("crow_session=;")).length, 1);
});

test("cookieDomainCandidate: the parent domain, and only when it is not a public suffix itself", () => {
  assert.equal(cookieDomainCandidate("crow.example.ts.net"), "example.ts.net");
  assert.equal(cookieDomainCandidate("crow.example.ts.net:8443"), "example.ts.net");
  assert.equal(cookieDomainCandidate("crow.example.com"), "example.com");
  assert.equal(cookieDomainCandidate("CROW.Example.COM."), "example.com", "case and trailing dot are normalised");
  assert.equal(cookieDomainCandidate("example.ts.net"), null, "its parent is ts.net, a public suffix");
  assert.equal(cookieDomainCandidate("ts.net"), null);
  assert.equal(cookieDomainCandidate("crow.localhost"), null);
  assert.equal(cookieDomainCandidate("100.64.0.5"), null, "an IPv4 literal");
  assert.equal(cookieDomainCandidate("[::1]:3001"), null);
  assert.equal(cookieDomainCandidate("localhost:3001"), null);
  assert.equal(cookieDomainCandidate(""), null);
  assert.equal(cookieDomainCandidate(undefined), null);
  assert.equal(cookieDomainCandidate("evil.example/x"), null, "never a path or a header with junk in it");
});

test("remainingLifetimeMs reads both shapes oauth_tokens.expires_at is written in", () => {
  const now = Date.parse("2026-05-01T12:00:00Z");
  assert.equal(remainingLifetimeMs("2026-05-01T13:00:00.000Z", now), 60 * 60 * 1000);
  assert.equal(remainingLifetimeMs("2026-05-01 13:00:00", now), 60 * 60 * 1000, "zone-less SQLite text is UTC");
  assert.equal(remainingLifetimeMs("2026-05-01T11:00:00Z", now), 0, "never negative");
  assert.equal(remainingLifetimeMs("not a date", now), 0);
  assert.equal(remainingLifetimeMs(null, now), 0);
});

test("logout expires both names, adding Secure to the plain one over HTTPS", () => {
  const https = headersOf((res) => clearSessionCookie(res, { secure: true }));
  assert.ok(https.some((c) => /^__Host-crow_session=;.*Max-Age=0.*Secure/.test(c)));
  assert.ok(https.some((c) => /^crow_session=;.*Max-Age=0.*Secure/.test(c)));

  const http = headersOf((res) => clearSessionCookie(res));
  assert.ok(http.some((c) => /^crow_session=;/.test(c)));
  assert.ok(http.some((c) => /^crow_session=;/.test(c) && !/; Secure/.test(c)), "plain HTTP needs no Secure on the plain expiry");
});