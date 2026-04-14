#!/usr/bin/env node
/**
 * Phase 5-full smoke: lifecycle refcount + mutex + idempotent merging.
 *
 * Runs entirely in-process using the real grackle-embed provider as the
 * target (since it's already running and cheap to probe).
 *
 * Usage: node scripts/smoke/lifecycle-refcount.js
 */

import {
  ensureModelWarm,
  releaseModel,
  getLifecycleSnapshot,
  onLifecycleEvent,
  resetAllRefcounts,
} from "../../servers/orchestrator/lifecycle.js";

let failed = 0;
function t(name, ok, detail) {
  if (ok) console.log(`  PASS  ${name}`);
  else { console.error(`  FAIL  ${name}${detail ? " — " + detail : ""}`); failed++; }
}

// Reset to a known state
await resetAllRefcounts();

const events = [];
const unsub = onLifecycleEvent((e) => events.push(e));

// -- 1. ensureModelWarm on a live, always-warm provider --
const r1 = await ensureModelWarm("grackle-embed");
t("ensureModelWarm returns ok for live provider", r1.ok, r1.reason);

// -- 2. Refcount increments on subsequent calls --
const r2 = await ensureModelWarm("grackle-embed");
t("second ensureModelWarm increments refcount", r2.ok && r2.refs >= 2, `refs=${r2.refs}`);

// -- 3. Concurrent ensureModelWarm calls on the same provider share the mutex --
const [r3a, r3b, r3c] = await Promise.all([
  ensureModelWarm("grackle-embed"),
  ensureModelWarm("grackle-embed"),
  ensureModelWarm("grackle-embed"),
]);
t("concurrent warm all ok", r3a.ok && r3b.ok && r3c.ok);
const snap1 = getLifecycleSnapshot();
t("refcount reflects all calls", snap1["grackle-embed"].refs === 5, `refs=${snap1["grackle-embed"].refs}`);

// -- 4. Releases decrement --
for (let i = 0; i < 5; i++) await releaseModel("grackle-embed");
const snap2 = getLifecycleSnapshot();
t("refcount returns to 0 after matching releases", snap2["grackle-embed"].refs === 0);

// -- 5. Pinned provider (Maker Lab) rejects release --
// The existing Qwen3-4B provider is pinned priority=maker_lab in models.json
await ensureModelWarm("crow-dispatch");
const r5 = await releaseModel("crow-dispatch");
t("pinned provider release is a no-op", r5.ok && r5.pinned === true, JSON.stringify(r5));

// -- 6. Unknown provider rejected --
const r6 = await ensureModelWarm("nonexistent-provider");
t("unknown provider rejected", !r6.ok && r6.reason === "unknown_provider");

// -- 7. Mutex group blocking — swap-coder vs swap-deep share "8003-swap" --
// (Both are on-demand and likely fail to warm since :8003 bundles aren't running)
const rc = await ensureModelWarm("crow-swap-coder");
// We expect this to fail (bundle not present) but NOT with mutex error since nothing
// in the group has refs > 0.
if (!rc.ok && rc.reason.startsWith("mutex_group_busy")) {
  t("swap-coder correctly sees empty mutex group", false, "rejected with mutex error but group empty");
} else {
  t("swap-coder attempts warm (no mutex conflict at this point)", true);
}

// -- 8. Events were emitted --
t("lifecycle events observed", events.length >= 5, `count=${events.length}`);

unsub();

if (failed) {
  console.error(`\nFAIL: ${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nPASS: all lifecycle assertions passed");
process.exit(0);
