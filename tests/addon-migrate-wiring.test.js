/**
 * The boot repair calls the linked-add-on migration, and that call is gated on
 * the per-host switch: with walls off the real migration reports "walls off"
 * and the repair reports nothing about it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { repairInstalledBundleAssets } = await import("../servers/gateway/routes/bundles.js");

test("repair passes the gateway env to the migration and reports what it moved", async () => {
  const calls = [];
  const out = await repairInstalledBundleAssets({
    env: { CROW_ADDON_WALLS_DEFAULT: "walled" },
    log: () => {},
    migrateLinked: async (o) => {
      calls.push(o);
      return { migrated: ["alpha"], repointed: ["funkwhale"], failed: [{ id: "beta", reason: "the copy does not match its source" }] };
    },
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].env, { CROW_ADDON_WALLS_DEFAULT: "walled" });
  assert.ok(out.repaired.some((l) => l.startsWith("alpha: moved into the Crow home")));
  assert.ok(out.repaired.some((l) => l.startsWith("funkwhale: its own-host URL repointed")));
  assert.ok(out.errors.some((e) => e.id === "beta" && /wall migration/.test(e.error)));
});

test("with the switch unset the real migration does nothing and the repair says nothing about it", async () => {
  const out = await repairInstalledBundleAssets({ env: {}, log: () => {} });
  assert.ok(!out.repaired.some((l) => /Crow home for its wall|repointed/.test(l)));
  assert.ok(!out.errors.some((e) => /wall migration/.test(e.error || "")));
});

test("a migration that throws never stops the repair", async () => {
  const out = await repairInstalledBundleAssets({
    env: { CROW_ADDON_WALLS_DEFAULT: "walled" },
    log: () => {},
    migrateLinked: async () => { throw new Error("boom"); },
  });
  assert.ok(out.errors.some((e) => e.id === "*" && /wall migration: boom/.test(e.error)));
});
