// tests/fediverse-panel-gate.test.js
//
// B5 (2026-07-18): fediverse features are blind to core. The Fediverse Admin
// panel must be absent from the visible panel list on an instance with no
// federated bundle installed, appear once one is installed (with NO restart —
// the hidden predicate re-evaluates per getVisiblePanels() call), and the
// predicate mechanism itself must fail open (a throwing predicate never hides
// a panel).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// CROW_HOME must be scratch before any dashboard module import (same
// prod-contamination guard as extensions-data-queries.test.js) — the gate
// resolves it at call time, but other dashboard modules resolve at load.
const scratchHome = mkdtempSync(join(tmpdir(), "crow-test-home-"));
process.env.CROW_HOME = scratchHome;

const { registerPanel, getVisiblePanels } = await import("../servers/gateway/dashboard/panel-registry.js");
const { default: fediversePanel, hasFederatedBundleInstalled } = await import("../servers/gateway/dashboard/panels/fediverse.js");

registerPanel(fediversePanel);

const visibleIds = () => getVisiblePanels().map((p) => p.id);

test("no installed.json → Fediverse Admin is hidden", () => {
  assert.equal(hasFederatedBundleInstalled(), false);
  assert.ok(!visibleIds().includes("fediverse"), "fediverse panel leaked into a fresh install's nav");
});

test("non-federated installs alone keep the panel hidden", () => {
  writeFileSync(join(scratchHome, "installed.json"), JSON.stringify({
    dozzle: { id: "dozzle", name: "Dozzle", installedAt: "2026-07-01T00:00:00.000Z" },
  }));
  assert.equal(hasFederatedBundleInstalled(), false);
  assert.ok(!visibleIds().includes("fediverse"));
});

test("installing a federated bundle reveals the panel with no restart (registry-tag path)", () => {
  // peertube is federated via its registry tags — the panel module has NOT
  // been re-imported since the writes above, proving per-call evaluation.
  writeFileSync(join(scratchHome, "installed.json"), JSON.stringify({
    dozzle: { id: "dozzle", name: "Dozzle", installedAt: "2026-07-01T00:00:00.000Z" },
    peertube: { id: "peertube", name: "PeerTube", installedAt: "2026-07-02T00:00:00.000Z" },
  }));
  assert.equal(hasFederatedBundleInstalled(), true);
  assert.ok(visibleIds().includes("fediverse"), "panel must appear once a federated bundle is installed");
});

test("a community-store install with its own fediverse tag also reveals the panel", () => {
  writeFileSync(join(scratchHome, "installed.json"), JSON.stringify({
    "acme-ap": { id: "acme-ap", name: "Acme AP", tags: ["fediverse"], installedAt: "2026-07-03T00:00:00.000Z" },
  }));
  assert.equal(hasFederatedBundleInstalled(), true);
});

test("corrupt installed.json fails closed for the gate (hidden), never throws", () => {
  writeFileSync(join(scratchHome, "installed.json"), "{not json");
  assert.equal(hasFederatedBundleInstalled(), false);
  assert.ok(!visibleIds().includes("fediverse"));
});

test("a throwing hidden predicate fails open — the panel stays visible", () => {
  registerPanel({ id: "zz-throwing-fixture", name: "ZZ", route: "/dashboard/zz", hidden: () => { throw new Error("probe bug"); } });
  assert.ok(visibleIds().includes("zz-throwing-fixture"), "predicate errors must never hide a panel");
});

test("boolean hidden still works (design-system stays out of nav)", () => {
  registerPanel({ id: "zz-bool-hidden", name: "ZZ2", route: "/dashboard/zz2", hidden: true });
  assert.ok(!visibleIds().includes("zz-bool-hidden"));
});

test.after(() => {
  rmSync(scratchHome, { recursive: true, force: true });
});
