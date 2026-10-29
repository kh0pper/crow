import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { isLocalPeer, classifyPeer } from "../servers/shared/peer-class.js";

const saved = process.env.CROW_TRUSTED_PROXIES;
afterEach(() => {
  if (saved === undefined) delete process.env.CROW_TRUSTED_PROXIES; else process.env.CROW_TRUSTED_PROXIES = saved;
});

test("plain loopback with no headers is local", () => {
  delete process.env.CROW_TRUSTED_PROXIES;
  for (const a of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) assert.equal(isLocalPeer(a), true, a);
  assert.equal(isLocalPeer("127.0.0.1", {}), true);
});
test("a forwarding header or a tailscale-* header is not local", () => {
  delete process.env.CROW_TRUSTED_PROXIES;
  assert.equal(isLocalPeer("127.0.0.1", { "x-forwarded-for": "100.64.20.5" }), false);
  assert.equal(isLocalPeer("127.0.0.1", { "tailscale-user-login": "alex@example.com" }), false);
});
test("a non-loopback socket is not local", () => {
  delete process.env.CROW_TRUSTED_PROXIES;
  assert.equal(isLocalPeer("100.64.20.5", {}), false);
  assert.equal(isLocalPeer("", {}), false);
  assert.equal(isLocalPeer(undefined), false);
});
test("a loopback socket listed in CROW_TRUSTED_PROXIES is a proxy, never local", () => {
  process.env.CROW_TRUSTED_PROXIES = "loopback";
  assert.equal(isLocalPeer("127.0.0.1", {}), false);
  process.env.CROW_TRUSTED_PROXIES = "127.0.0.1";
  assert.equal(isLocalPeer("::1", {}), true); // ::1 is not in that list
  assert.equal(isLocalPeer("127.0.0.1", {}), false);
});
test("isLocalPeer agrees with classifyPeer(...).via === 'local' over a case table", () => {
  const addrs = ["127.0.0.1", "::1", "::ffff:127.0.0.1", "100.64.20.5", "192.168.1.9", "", "localhost"];
  const headerSets = [{}, { "x-forwarded-for": "100.64.20.5" }, { "x-real-ip": "100.64.20.5" }, { forwarded: "for=100.64.20.5" },
    { "x-forwarded-host": "crow.example.ts.net" }, { "tailscale-user-login": "alex@example.com" }, { "Tailscale-Funnel-Request": "?1" }, { "x-forwarded-for": "" }];
  for (const env of [undefined, "loopback", "127.0.0.1", "100.64.20.5"]) {
    if (env === undefined) delete process.env.CROW_TRUSTED_PROXIES; else process.env.CROW_TRUSTED_PROXIES = env;
    for (const a of addrs) for (const h of headerSets) {
      const req = { headers: { ...h }, socket: { remoteAddress: a } };
      assert.equal(isLocalPeer(a, h), classifyPeer(req).via === "local", `${a} ${JSON.stringify(h)} env=${env}`);
    }
  }
});
