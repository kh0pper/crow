// SAT-5 review M1: crow stores only a whitelisted, type-checked, size-capped form of a
// satellite's status, and the Servers card never throws on hostile shapes.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const HOME = mkdtempSync(join(tmpdir(), "satsan-home-"));
process.env.CROW_HOME = HOME;
process.env.CROW_DATA_DIR = mkdtempSync(join(tmpdir(), "satsan-data-"));
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
after(() => { rmSync(HOME, { recursive: true, force: true }); rmSync(process.env.CROW_DATA_DIR, { recursive: true, force: true }); });

const { sanitizeStatus, MAX_INSTALLED } = await import("../servers/gateway/satellites/status-sanitize.js");
const { createSatelliteManager } = await import("../servers/gateway/satellites/manage.js");
const { installPaths } = await import("../servers/gateway/satellites/installs.js");

const HOSTILE = [
  null, 7, "x", [], { installed: "nope", tools: [] },
  { __proto__: { evil: 1 }, installed: [{ id: "../x" }, { id: "Bad" }, { id: "ok", version: { a: 1 } }, "plain", 5, null, { id: "ok" }],
    tools: { "../x": { sha256: "f".repeat(64) }, ok: { version: "1".repeat(65), sha256: "zz" }, good: { version: "1.0", sha256: "a".repeat(64) }, er: { error: "<script>" } },
    mem: { MemTotal: -1, MemAvailable: "1", SwapTotal: Infinity, SwapFree: 10 }, psi_memory_some_avg10: 101, sha: "nothex", cert: { serial: "x".repeat(65), expires_at: 3 },
    agent_protocol: 1.5, disk_free_bytes: NaN, uptime_s: -3, satellite_id: "<b>", extra: "dropped" },
  { installed: Array.from({ length: 500 }, (_, i) => ({ id: `b${i}` })), tools: Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`b${i}`, { error: "tools_too_large" }])) },
];

test("hostile shapes → the whitelisted shape only", () => {
  for (const h of HOSTILE) {
    const s = sanitizeStatus(h);
    assert.deepEqual(Object.keys(s).sort(), ["agent_protocol", "cert", "disk_free_bytes", "installed", "mem", "psi_memory_some_avg10", "satellite_id", "sha", "tools", "uptime_s"]);
    assert.ok(Array.isArray(s.installed) && s.installed.length <= MAX_INSTALLED);
    assert.ok(Object.keys(s.tools).length <= MAX_INSTALLED);
    for (const b of s.installed) assert.match(b.id, /^[a-z0-9][a-z0-9-]{0,63}$/);
    for (const [k, t] of Object.entries(s.tools)) {
      assert.match(k, /^[a-z0-9][a-z0-9-]{0,63}$/);
      if (t.sha256) assert.match(t.sha256, /^[0-9a-f]{64}$/);
      else assert.ok(["tools_too_large", "tools_unavailable"].includes(t.error));
      assert.ok(t.version === null || (typeof t.version === "string" && t.version.length <= 64));
    }
  }
  const s = sanitizeStatus(HOSTILE[5]);
  assert.deepEqual(s.installed, [{ id: "ok", version: null }, { id: "plain", version: null }]);
  assert.deepEqual(s.tools, { ok: { version: null, error: "tools_unavailable" }, good: { version: "1.0", sha256: "a".repeat(64) }, er: { version: null, error: "tools_unavailable" } });
  assert.deepEqual(s.mem, { MemTotal: null, MemAvailable: null, SwapTotal: null, SwapFree: 10 });
  assert.equal(s.psi_memory_some_avg10, null);
  assert.equal(s.sha, null);
  assert.equal(s.satellite_id, null);
  assert.equal("extra" in s, false);
});

test("card() never throws on a hostile stored record", async () => {
  const m = createSatelliteManager({ paths: installPaths(mkdtempSync(join(tmpdir(), "satsan-p-"))), appBundlesDir: () => "/nonexistent", behindByFn: async () => null, watchJobs: false });
  const db = { execute: async () => ({ rows: [] }) };
  for (const raw of ["{not json", JSON.stringify({ status: HOSTILE[5] }), JSON.stringify({ status: { installed: [{ id: { x: 1 } }], tools: "x" } }), JSON.stringify([1, 2]), JSON.stringify({ status: 5, skew_ms: "x" })]) {
    const c = await m.card(db, { id: "sat_aaaaaaaaaaaaaaaaaaaa", name: "x", status: "active", last_status_json: raw, cert_expires_at: "bad" });
    assert.ok(Array.isArray(c.installed));
    assert.ok(c.skew_ms === null || typeof c.skew_ms === "number");
  }
});
