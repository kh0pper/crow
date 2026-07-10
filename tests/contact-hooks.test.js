/**
 * F-CONTACT-1 — the onContactSynced/onContactDeleted pairing.
 *
 * The final whole-branch review caught `onContactDeleted` being defined in
 * _applyContact and called there, but never ASSIGNED at boot: a synced delete
 * removed the row on every peer while leaving its Nostr subscription, sync feeds
 * and DHT topic open. The call site is guarded (`typeof === "function"`), so the
 * omission was a silent no-op that no unit test could see.
 *
 * These tests pin both halves: the pure wiring seam, and the fact that boot
 * actually calls it. boot/mcp-mounts.js cannot be imported here — it starts the
 * sharing servers at import time — so the call site is pinned by source.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { attachContactSyncHooks } from "../servers/sharing/contact-hooks.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function makeDeps() {
  const calls = { wired: [], unwired: [] };
  const managers = { marker: "managers" };
  return {
    calls,
    managers,
    deps: {
      wireSyncedContact: (m, row) => calls.wired.push([m, row]),
      unwireContact: (m, row) => calls.unwired.push([m, row]),
      getManagers: () => managers,
    },
  };
}

test("attachContactSyncHooks sets BOTH hooks", () => {
  const mgr = {};
  const { deps } = makeDeps();
  assert.equal(attachContactSyncHooks(mgr, deps), true);
  assert.equal(typeof mgr.onContactSynced, "function");
  assert.equal(typeof mgr.onContactDeleted, "function", "onContactDeleted must be wired, not just onContactSynced");
});

test("onContactDeleted delegates to unwireContact with the live managers and the row", () => {
  const mgr = {};
  const { deps, calls, managers } = makeDeps();
  attachContactSyncHooks(mgr, deps);

  const row = { id: 7, crow_id: "crow:abc" };
  mgr.onContactDeleted(row);

  assert.equal(calls.unwired.length, 1);
  assert.deepEqual(calls.unwired[0], [managers, row]);
  assert.equal(calls.wired.length, 0, "a delete must not wire the contact up");
});

test("onContactSynced still delegates to wireSyncedContact", () => {
  const mgr = {};
  const { deps, calls, managers } = makeDeps();
  attachContactSyncHooks(mgr, deps);

  const row = { id: 8, crow_id: "crow:def" };
  mgr.onContactSynced(row);

  assert.deepEqual(calls.wired[0], [managers, row]);
  assert.equal(calls.unwired.length, 0);
});

test("managers are resolved at call time, not at attach time", () => {
  const mgr = {};
  let current = null;
  attachContactSyncHooks(mgr, {
    wireSyncedContact: () => {},
    unwireContact: (m) => { current = m; },
    getManagers: () => ({ generation: 2 }),
  });
  mgr.onContactDeleted({ id: 1, crow_id: "crow:x" });
  assert.deepEqual(current, { generation: 2 });
});

test("a null syncManager (--no-auth boot) attaches nothing and does not throw", () => {
  const { deps } = makeDeps();
  assert.equal(attachContactSyncHooks(null, deps), false);
});

test("missing deps attach nothing rather than half-wiring", () => {
  const mgr = {};
  assert.equal(attachContactSyncHooks(mgr, { wireSyncedContact: () => {}, getManagers: () => null }), false);
  assert.equal(mgr.onContactSynced, undefined, "must not wire one hook without the other");
  assert.equal(mgr.onContactDeleted, undefined);
});

test("boot/mcp-mounts.js actually calls attachContactSyncHooks", () => {
  // Source pin: mcp-mounts.js starts the sharing servers at import time, so it
  // cannot be imported into a unit test. Without this pin, deleting the boot
  // call re-introduces the exact silent no-op the final review caught — every
  // other test in this file would still pass.
  const src = readFileSync(join(repoRoot, "servers/gateway/boot/mcp-mounts.js"), "utf8");
  assert.match(src, /attachContactSyncHooks\(\s*syncManager/, "boot must attach the contact sync hooks");
  assert.match(src, /unwireContact/, "boot must supply unwireContact to the hook attacher");
});
