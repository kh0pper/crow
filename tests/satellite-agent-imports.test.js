/**
 * SAT-3: the satellite agent's static import graph. Every module under servers/satellite/ is an
 * entry; every relative import (static, re-export, side-effect, literal dynamic) is followed
 * transitively. The agent runs on a 1 GB box without the full Crow: it must never load the
 * dashboard, crow.db (servers/db.js), init-db, the bundles route layer, the tool router, the
 * memory server, or the sharing server — except identity-attestation (reached through
 * satellite-protocol) and secret-box (the keychain's AES-GCM sealing, a pure crypto leaf).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const SPEC_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)(["'])([^"'\n]+)\1/gm;

function specifiers(src) {
  const out = [];
  let m;
  while ((m = SPEC_RE.exec(src)) !== null) out.push(m[2]);
  return out;
}

function importGraph(entries) {
  const files = new Set();
  const stack = entries.map((e) => resolve(ROOT, e));
  while (stack.length) {
    const file = stack.pop();
    const rel = relative(ROOT, file);
    if (files.has(rel)) continue;
    files.add(rel);
    for (const spec of specifiers(readFileSync(file, "utf8"))) {
      if (!(spec.startsWith(".") || spec.startsWith("/"))) continue;
      const target = resolve(dirname(file), spec);
      assert.ok(existsSync(target), `${rel} imports ${spec}, which does not resolve`);
      stack.push(target);
    }
  }
  return files;
}

const ALLOWED_SHARING = new Set(["servers/sharing/identity-attestation.js", "servers/sharing/secret-box.js"]);
const BANNED = [
  [/^servers\/gateway\/dashboard\//, "dashboard"],
  [/^servers\/db\.js$/, "db.js (crow.db)"],
  [/^scripts\/init-db\.js$/, "init-db"],
  [/^servers\/gateway\/routes\/bundles\.js$/, "routes/bundles.js"],
  [/(^|\/)router\.js$/, "router.js"],
  [/^servers\/memory\//, "the memory server"],
  [/^servers\/sharing\//, "the sharing server"],
];

function violations(files) {
  const out = [];
  for (const f of files) {
    if (ALLOWED_SHARING.has(f)) continue;
    for (const [re, why] of BANNED) if (re.test(f)) out.push(`${f} (${why})`);
  }
  return out;
}

const satelliteEntries = () => readdirSync(join(ROOT, "servers", "satellite"))
  .filter((f) => f.endsWith(".js"))
  .map((f) => join("servers", "satellite", f));

test("servers/satellite/** never reaches dashboard/, db.js, init-db, routes/bundles.js, router.js, memory or sharing", () => {
  const entries = satelliteEntries();
  for (const must of ["agent.js", "bundles.js", "gate.js", "compose-rules.js"]) {
    assert.ok(entries.includes(join("servers", "satellite", must)), `${must} is scanned`);
  }
  const files = importGraph(entries);
  // The shared pieces the agent does use are really in the scan (not silently skipped).
  for (const f of ["servers/gateway/bundle-core.js", "servers/gateway/compose-guard.js", "servers/gateway/keychain/key.js", "servers/gateway/bundle-lifecycle.js"]) {
    assert.ok(files.has(f), `the scan followed the agent into ${f}`);
  }
  assert.deepEqual(violations(files), []);
});

test("positive control: routes/bundles.js trips the same scan", () => {
  const out = violations(importGraph(["servers/gateway/routes/bundles.js"]));
  for (const why of ["dashboard", "db.js (crow.db)"]) assert.ok(out.some((v) => v.includes(`(${why})`)), `must catch ${why}`);
});

test("positive control: a satellite module importing the memory server or sharing would be caught", () => {
  assert.deepEqual(violations(new Set(["servers/memory/index.js", "servers/sharing/nostr.js", "servers/sharing/identity-attestation.js", "servers/gateway/router.js", "scripts/init-db.js"])),
    ["servers/memory/index.js (the memory server)", "servers/sharing/nostr.js (the sharing server)", "servers/gateway/router.js (router.js)", "scripts/init-db.js (init-db)"]);
});
