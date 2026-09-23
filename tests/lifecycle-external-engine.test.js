/**
 * Legacy lifecycle.js (ensureModelWarm/releaseModel) refuses external engines
 * (spec 2026-09-23 external-engine-provider §2.2). CROW_REFCOUNT_PATH is
 * pointed at a tmp file BEFORE the module loads (it reads/persists refcounts
 * at import time); fetch is replaced with a spy so nothing leaves the box.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "lifecycle-ext-"));
process.env.CROW_REFCOUNT_PATH = join(dir, "refcounts.json");
const { ensureModelWarm, releaseModel, onLifecycleEvent } = await import("../servers/shared/lifecycle.js");

const cfg = { providers: {
  "raven-flash-next": {
    baseUrl: "http://10.0.0.126:8030/v1", host: "cloud", bundleId: "halogen", // contradictory on purpose
    models: [{ id: "flash-next" }],
    gpuPolicy: { engine: { managed: "external", host: "raven", label: "halogen" } },
  },
} };

let realFetch;
const fetchCalls = [];
before(() => { realFetch = globalThis.fetch; globalThis.fetch = async (...a) => { fetchCalls.push(a); throw new Error("no network in tests"); }; });
after(() => { globalThis.fetch = realFetch; rmSync(dir, { recursive: true, force: true }); });

// cfg is injected through the Step 2b lookupProvider seam, so without the guard
// this row IS found: the probe and the bundle start run (fetchCalls 2) — the
// assertions below then fail on the guard itself, not on "unknown_provider".
test("ensureModelWarm refuses an external engine: no probe, no bundle start, reason external_engine", async () => {
  const events = [];
  const off = onLifecycleEvent((e) => events.push(e.type));
  try {
    const r = await ensureModelWarm("raven-flash-next", { cfg });
    assert.deepEqual(r, { ok: false, reason: "external_engine" });
  } finally { off(); }
  assert.equal(fetchCalls.length, 0);
  assert.ok(!events.includes("bundle_start"));
});

test("releaseModel is a no-op for an external engine", async () => {
  assert.deepEqual(await releaseModel("raven-flash-next", { cfg }), { ok: true, refs: 0, external: true });
  assert.equal(fetchCalls.length, 0);
});
