// tests/roster-advertise-dispatch.test.js
//
// Regression guard for a dead-on-arrival class of bug: servers/gateway/dashboard/index.js
// has a hardcoded allowlist deciding which paths a SIGNED peer request is dispatched to
// the federationRouter (vs falling through to bundlesRouter). A federation route that
// isn't in that allowlist is unreachable in production even though its handler + auth
// are correct. The route's own test mounts federationRouter directly, so it CANNOT catch
// this. This test asserts the dispatch allowlist includes /advertised-bots alongside the
// other federation routes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const indexSrc = readFileSync(
  join(__dirname, "../servers/gateway/dashboard/index.js"), "utf-8"
);

test("the signed-peer dispatch allowlist routes /advertised-bots to the federation router", () => {
  // Find the cross-host dispatch branch (the `if (federationRouter && (...))` condition).
  const m = indexSrc.match(/if\s*\(\s*federationRouter\s*&&\s*\(([\s\S]*?)\)\s*\)\s*\{/);
  assert.ok(m, "could not locate the federationRouter dispatch condition in index.js");
  const condition = m[1];
  // All three first-class federation routes must be dispatched together; if a new
  // route handler is added without this entry it is silently unreachable for peers.
  assert.ok(/"\/overview"/.test(condition), "dispatch must include /overview");
  assert.ok(/"\/capabilities"/.test(condition), "dispatch must include /capabilities");
  assert.ok(/"\/advertised-bots"/.test(condition), "dispatch must include /advertised-bots (roster auto-advertise)");
});
