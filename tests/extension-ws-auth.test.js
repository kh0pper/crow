import { test } from "node:test";
import assert from "node:assert/strict";
import { authorizeExtensionUpgrade } from "../servers/gateway/routes/extension-proxy.js";

// Rejection paths only — none of these touch the DB:
//  - funnel header → rejected before any cookie parsing
//  - no/irrelevant cookies → rejected before verifySession opens the DB
//    (verifySession itself short-circuits on a falsy token).

test("ws auth: funneled upgrade is rejected even with a session cookie", async () => {
  const ok = await authorizeExtensionUpgrade({
    headers: {
      "tailscale-funnel-request": "?1",
      cookie: "crow_session=abc123",
    },
  });
  assert.equal(ok, false);
});

// For the cookie-path tests, give the request an allowed-network identity
// (tailnet CGNAT ip) so isAllowedNetwork passes and the cookie branch is
// actually exercised.
function tailnetReq(headers = {}) {
  return { headers, ip: "100.64.0.5", connection: { remoteAddress: "100.64.0.5" } };
}

test("ws auth: allowed network but no cookies is rejected", async () => {
  assert.equal(await authorizeExtensionUpgrade(tailnetReq()), false);
});

test("ws auth: allowed network with unrelated cookies (no crow_session) is rejected", async () => {
  const ok = await authorizeExtensionUpgrade(tailnetReq({ cookie: "theme=dark; csrf=xyz" }));
  assert.equal(ok, false);
});

test("ws auth: disallowed network is rejected even WITH a session cookie", async () => {
  const ok = await authorizeExtensionUpgrade({
    headers: { cookie: "crow_session=abc123" },
    ip: "8.8.8.8",
    connection: { remoteAddress: "8.8.8.8" },
  });
  assert.equal(ok, false);
});
