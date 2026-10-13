// The gateway's CSP frame-ancestors: who may embed the dashboard in a frame.
// It used to be `'self' https:` — any https site could frame the dashboard
// (clickjacking). The legitimate cross-origin framers are the AI Companion,
// served from the SAME hostname on another port, and its federation windows
// on trusted paired instances, so the rule is now `'self'` plus
// `https://<this hostname>:*` plus `https://<trusted peer>:*`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { frameAncestorsFor, createPeerFrameHosts } from "../servers/gateway/frame-ancestors.js";

test("frame-ancestors allows the gateway itself and the same hostname on any https port", () => {
  assert.equal(frameAncestorsFor("crow.example.ts.net:8444"), "frame-ancestors 'self' https://crow.example.ts.net:*");
  assert.equal(frameAncestorsFor("crow.example.ts.net"), "frame-ancestors 'self' https://crow.example.ts.net:*");
  assert.equal(frameAncestorsFor("100.64.20.5:3001"), "frame-ancestors 'self' https://100.64.20.5:*");
  assert.equal(frameAncestorsFor("LOCALHOST:3001"), "frame-ancestors 'self' https://localhost:*");
  assert.equal(frameAncestorsFor("crow.example.ts.net.:8444"), "frame-ancestors 'self' https://crow.example.ts.net:*", "a trailing-dot FQDN is the same host");
});

test("frame-ancestors never allows every https site, and falls back to 'self' for a host it cannot use", () => {
  for (const h of [undefined, null, "", "   ", ":8444", "[::1]:3001", "a b", "evil.example; script-src *", "x.example,https:", "x.example/*", "https:", "*", "*.example", "null", "a".repeat(254)]) {
    assert.equal(frameAncestorsFor(h), "frame-ancestors 'self'", `host ${JSON.stringify(h)}`);
  }
  for (const h of ["crow.example.ts.net:8444", "100.64.20.5"]) {
    assert.doesNotMatch(frameAncestorsFor(h), /(^|\s)https:(\s|$)/, "the bare https: scheme source is gone");
  }
});

test("the gateway's security-header middleware uses frameAncestorsFor (no hardcoded frame-ancestors)", () => {
  const src = readFileSync(new URL("../servers/gateway/index.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /"frame-ancestors [^"]*"/, "no literal frame-ancestors directive in index.js");
  assert.match(src, /frameAncestorsFor\(req\.headers\.host, peerFrameHosts\.get\(\)\)/);
  assert.match(src, /getTrustedInstances\(_frameDb\)/, "peers come from the one trusted-instances query");
});

test("trusted peers' hostnames are allowed too, each validated, deduped and capped", () => {
  assert.equal(frameAncestorsFor("crow.example.ts.net:8444", ["peer-a", "PEER-A", "crow.example.ts.net", "peer-b.example.ts.net:8444"]),
    "frame-ancestors 'self' https://crow.example.ts.net:* https://peer-a:* https://peer-b.example.ts.net:*");
  assert.equal(frameAncestorsFor("crow.example.ts.net", ["evil; script-src *", "*", "https:", "", null, "null", 7]),
    "frame-ancestors 'self' https://crow.example.ts.net:*", "bad peer names are dropped, never written");
  assert.equal(frameAncestorsFor("[::1]", ["peer-a"]), "frame-ancestors 'self' https://peer-a:*", "an unusable Host still allows the peers");
  const many = Array.from({ length: 50 }, (_, i) => `p${i}`);
  assert.equal(frameAncestorsFor("h", many).split(" ").length, 2 + 1 + 32, "at most 32 peers");
  assert.equal(frameAncestorsFor("h", "peer-a"), "frame-ancestors 'self' https://h:*", "a non-array peer list is ignored");
});

test("the peer cache never blocks, refreshes when stale, and keeps the last list on failure", async () => {
  let t = 0, calls = 0, mode = "ok";
  const cache = createPeerFrameHosts(async () => { calls++; if (mode === "fail") throw new Error("db down"); return mode === "bad" ? "nope" : ["Peer-A", "bad host", "peer-b."]; }, { ttlMs: 1000, now: () => t });
  assert.deepEqual(cache.get(), [], "the first call returns at once, before any load");
  await cache.refreshed();
  assert.deepEqual(cache.get(), ["peer-a", "peer-b"]);
  assert.equal(calls, 1, "fresh: no reload");
  t = 1500; mode = "fail"; cache.get(); await cache.refreshed();
  assert.deepEqual(cache.get(), ["peer-a", "peer-b"], "a failed load keeps the previous list");
  t = 3000; mode = "bad"; cache.get(); await cache.refreshed();
  assert.deepEqual(cache.get(), ["peer-a", "peer-b"], "a non-array result keeps the previous list");
  t = 4500; mode = "ok"; cache.get(); cache.get(); cache.get(); await cache.refreshed();
  assert.equal(calls, 4, "one load per stale window, never concurrent");
});
