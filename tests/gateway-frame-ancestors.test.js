// The gateway's CSP frame-ancestors: who may embed the dashboard in a frame.
// It used to be `'self' https:` — any https site could frame the dashboard
// (clickjacking). The one legitimate cross-origin framer is the AI Companion,
// served from the SAME hostname on another port, so the rule is now `'self'`
// plus `https://<this hostname>:*`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { frameAncestorsFor } from "../servers/gateway/frame-ancestors.js";

test("frame-ancestors allows the gateway itself and the same hostname on any https port", () => {
  assert.equal(frameAncestorsFor("crow.example.ts.net:8444"), "frame-ancestors 'self' https://crow.example.ts.net:*");
  assert.equal(frameAncestorsFor("crow.example.ts.net"), "frame-ancestors 'self' https://crow.example.ts.net:*");
  assert.equal(frameAncestorsFor("100.64.20.5:3001"), "frame-ancestors 'self' https://100.64.20.5:*");
  assert.equal(frameAncestorsFor("LOCALHOST:3001"), "frame-ancestors 'self' https://localhost:*");
});

test("frame-ancestors never allows every https site, and falls back to 'self' for a host it cannot use", () => {
  for (const h of [undefined, null, "", "   ", ":8444", "[::1]:3001", "a b", "evil.example; script-src *", "x.example,https:", "x.example/*", "https:", "*", "*.example", "a".repeat(254)]) {
    assert.equal(frameAncestorsFor(h), "frame-ancestors 'self'", `host ${JSON.stringify(h)}`);
  }
  for (const h of ["crow.example.ts.net:8444", "100.64.20.5"]) {
    assert.doesNotMatch(frameAncestorsFor(h), /(^|\s)https:(\s|$)/, "the bare https: scheme source is gone");
  }
});

test("the gateway's security-header middleware uses frameAncestorsFor (no hardcoded frame-ancestors)", () => {
  const src = readFileSync(new URL("../servers/gateway/index.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /"frame-ancestors [^"]*"/, "no literal frame-ancestors directive in index.js");
  assert.match(src, /frameAncestorsFor\(req\.headers\.host\)/);
});
