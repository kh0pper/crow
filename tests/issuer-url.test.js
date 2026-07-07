import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveIssuerUrl } from "../servers/gateway/issuer-url.js";

test("configured HTTPS URL passes through byte-identical (existing drop-in installs)", () => {
  const r = resolveIssuerUrl({ publicUrl: "https://black-swan.dachshund-chromatic.ts.net", port: 3001 });
  assert.equal(r.url.href, "https://black-swan.dachshund-chromatic.ts.net/");
  assert.equal(r.degraded, false);
});

test("unset publicUrl → http://localhost:<port>, NOT degraded (nothing configured)", () => {
  const r = resolveIssuerUrl({ publicUrl: undefined, port: 3001 });
  assert.equal(r.url.href, "http://localhost:3001/");
  assert.equal(r.degraded, false);
  assert.equal(r.configured, false);
});

test("F-8 repro: http non-localhost URL degrades to localhost instead of throwing", () => {
  const r = resolveIssuerUrl({ publicUrl: "http://crow.local", port: 3001 });
  assert.equal(r.url.href, "http://localhost:3001/");
  assert.equal(r.degraded, true);
  assert.match(r.reason, /HTTPS/);
});

test("http localhost / 127.0.0.1 are SDK-exempt and pass through", () => {
  assert.equal(resolveIssuerUrl({ publicUrl: "http://localhost:3001", port: 3001 }).degraded, false);
  assert.equal(resolveIssuerUrl({ publicUrl: "http://127.0.0.1:3001", port: 3001 }).degraded, false);
});

test("query/fragment are stripped (SDK throws on them)", () => {
  const r = resolveIssuerUrl({ publicUrl: "https://x.ts.net/?a=1#b", port: 3001 });
  assert.equal(r.url.search, "");
  assert.equal(r.url.hash, "");
  assert.equal(r.degraded, false);
});

test("garbage URL degrades instead of throwing", () => {
  const r = resolveIssuerUrl({ publicUrl: "not a url", port: 3001 });
  assert.equal(r.url.href, "http://localhost:3001/");
  assert.equal(r.degraded, true);
});
