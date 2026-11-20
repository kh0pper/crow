/**
 * The fetch-metadata gate's PATH matching (queue item #51 PR-1).
 *
 * Express routing is case-insensitive and normalises repeated slashes, so the
 * gate must compare the same path form the router matches. A raw `req.path`
 * comparison let `/DASHBOARD/...` or `/Api/...` reach the handler while skipping
 * the gate. Every cookie-authenticated mount outside the CSRF rail is covered:
 * `/dashboard`, `/api`, `/proxy/<id>` (the extension web-UI proxy) and
 * `/apps/<name>` (authenticated static apps).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { csrfTokenFor } from "./helpers/csrf-token.mjs";

const { fetchMetadataGate, FETCH_METADATA_REFUSAL } = await import("../servers/gateway/dashboard/fetch-metadata.js");

const gate = fetchMetadataGate({ log: () => {} });
const SESSION = "session-token-abc";

function req({ method = "POST", path, headers = {} } = {}) {
  return {
    method,
    path,
    headers: {
      cookie: `crow_session=${SESSION}`,
      "sec-fetch-site": "cross-site",
      ...headers,
    },
  };
}

function res() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    type() { return this; },
    send(body) { this.body = body; return this; },
  };
}

/** true when the request was refused by the gate. */
function refused(request) {
  const r = res();
  let next = false;
  gate(request, r, () => { next = true; });
  if (r.statusCode === 403) {
    assert.equal(r.body, FETCH_METADATA_REFUSAL);
    assert.equal(next, false);
    return true;
  }
  assert.equal(next, true, "an unrefused request must reach the router");
  return false;
}

test("mixed-case gated paths are refused (Express routes them case-insensitively)", () => {
  for (const path of [
    "/DASHBOARD", "/Dashboard", "/DASHBOARD/nest", "/Api/models", "/API/chat",
    "/PROXY/demo", "/Proxy/demo/", "/APPS/demo", "/Apps/demo/page",
  ]) {
    assert.equal(refused(req({ path })), true, `${path} must be gated`);
  }
});

test("duplicate slashes are collapsed before the comparison", () => {
  for (const path of [
    "//dashboard/nest", "/dashboard//nest", "//DASHBOARD//nest",
    "//api//models", "//proxy//demo", "//apps//demo",
  ]) {
    assert.equal(refused(req({ path })), true, `${path} must be gated`);
  }
});

test("percent-encoded paths are decoded once before the comparison", () => {
  for (const path of [
    "/%64ashboard/nest", "/dashboard%2Fnest", "/Api%2Fmodels",
    "/pro%78y/demo", "/%2F%2Fdashboard%2Fnest",
  ]) {
    assert.equal(refused(req({ path })), true, `${path} must be gated`);
  }
});

test("a malformed escape still gates a path that starts with a gated prefix", () => {
  assert.equal(refused(req({ path: "/dashboard/%ZZ/nest" })), true);
  // A malformed escape elsewhere does not throw, and is not a gated prefix.
  assert.equal(refused(req({ path: "/not%ZZ/dashboard" })), false);
});

test("/proxy and the other cookie-authenticated mounts refuse same-site and cross-site state changes", () => {
  for (const site of ["same-site", "cross-site"]) {
    assert.equal(refused(req({ path: "/proxy/demo/api/hub/spawn", headers: { "sec-fetch-site": site } })), true, `${site} POST to /proxy`);
  }
  for (const path of ["/proxy/demo", "/apps/demo", "/api/models", "/DASHBOARD/nest"]) {
    assert.equal(refused(req({ path, headers: { "sec-fetch-site": "same-site" } })), true, `${path} same-site`);
  }
});

test("same-origin app requests still pass, including /proxy", () => {
  for (const path of ["/proxy/demo", "/PROXY/demo", "/apps/demo", "/dashboard/nest", "/api/models"]) {
    assert.equal(
      refused(req({ path, headers: { "sec-fetch-site": "same-origin" } })),
      false,
      `${path} from the app's own origin`,
    );
  }
  assert.equal(refused(req({ path: "/proxy/demo", headers: { "sec-fetch-site": "none" } })), false);
});

test("read-only methods pass; prefix lookalikes are not gated", () => {
  for (const method of ["GET", "HEAD", "OPTIONS"]) {
    assert.equal(refused(req({ method, path: "/DASHBOARD/nest" })), false, method);
  }
  for (const path of ["/dashboardish", "/api2/models", "/proxyish/demo", "/apps2/demo", "/dashboardx/nest"]) {
    assert.equal(refused(req({ path })), false, `${path} is not inside a gated prefix`);
  }
});

test("requests with no session cookie are untouched (bearer/MCP and pre-auth flows)", () => {
  const r = res();
  let next = false;
  gate({ method: "POST", path: "/DASHBOARD/nest", headers: { "sec-fetch-site": "cross-site" } }, r, () => { next = true; });
  assert.equal(next, true);
  assert.equal(r.statusCode, null);
});

/**
 * Regression (queue item #51 PR-1): the gate on a REAL dashboard form's target.
 *
 * `POST /api/messages/peer/:id/send` is a cookie-authenticated dashboard call (routes/peer-messages.js
 * is mounted behind dashboardAuth + csrfMiddleware), and `/api` is one of the gated prefixes. A page
 * on another site — or on a same-site sibling host, which `ts.net` being a public suffix makes
 * unremarkable — is refused here even when it somehow holds a token, because a browser writes
 * Sec-Fetch-Site and page script cannot. The owner's own page passes, and its server-bound token is
 * the CSRF rail's second, independent check.
 */
test("a cookie-authenticated cross-site POST to /api/messages/peer/<id>/send is refused; the same call from the dashboard's own origin passes", () => {
  const send = "/api/messages/peer/42/send";
  const token = csrfTokenFor(SESSION);
  const own = "http://127.0.0.1:3001";

  // Cross-site and same-site, with and without the token: the gate never lets them through.
  for (const site of ["cross-site", "same-site"]) {
    assert.equal(refused(req({ path: send, headers: { "sec-fetch-site": site } })), true, `${site}, no token`);
    assert.equal(refused(req({ path: send, headers: { "sec-fetch-site": site, "x-crow-csrf": token } })), true, `${site}, even with a token`);
  }
  // No Sec-Fetch-Site at all, but an Origin naming another site: refused.
  assert.equal(refused(req({ path: send, headers: { "sec-fetch-site": undefined, origin: "https://evil.example.invalid" } })), true);

  // The dashboard's own page: same-origin fetch metadata naming this gateway, and the session's token.
  assert.equal(
    refused(req({ path: send, headers: { host: "127.0.0.1:3001", "sec-fetch-site": "same-origin", origin: own, "x-crow-csrf": token } })),
    false,
    "the owner's own page reaches the route",
  );

  // A bearer-authenticated peer call carries no session cookie, so the gate never looks at it.
  const r = res();
  let next = false;
  gate({ method: "POST", path: send, headers: { authorization: "Bearer peer-token", "sec-fetch-site": "cross-site" } }, r, () => { next = true; });
  assert.equal(next, true);
  assert.equal(r.statusCode, null);
});