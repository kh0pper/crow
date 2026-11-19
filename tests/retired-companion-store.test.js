/**
 * Retiring the AI Companion — the store side, after the removal.
 *
 * Step 1 hid the Companion from the store (`draft: true`) and kept its manifest because
 * the uninstall read the REPO manifest. Step 2 removed it for good: `bundles/companion/`
 * is gone, so a live install's Remove is driven by the code-held stub in
 * `servers/gateway/retired-bundles.js` instead (tests/retired-companion-card.test.js owns
 * that half). What stays here is the store's own contract:
 *
 *   - the Companion is not listed and has no repo manifest left to list;
 *   - Maker Lab and Maker Lab Advanced stay ARCHIVED drafts (out of the store, code kept);
 *   - Calls no longer points at the Companion.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const { buildRegistry } = await import("../scripts/build-registry.mjs");

after(() => {
  // The registry build reads the repo tree only; nothing to restore.
});

const repoManifest = (id) => JSON.parse(readFileSync(join(ROOT, "bundles", id, "manifest.json"), "utf8"));
const registry = JSON.parse(readFileSync(join(ROOT, "registry", "add-ons.json"), "utf8"));

test("the Companion is gone from the repo, so nothing can install it fresh", () => {
  assert.equal(existsSync(join(ROOT, "bundles", "companion")), false);
  assert.equal(registry["add-ons"].some((a) => a.id === "companion"), false);
  const { registry: built } = buildRegistry({ tracked: null });
  assert.equal(built["add-ons"].some((a) => a.id === "companion"), false);
});

test("Maker Lab and Maker Lab Advanced stay archived drafts (code kept)", () => {
  for (const id of ["maker-lab", "maker-lab-advanced"]) {
    assert.equal(repoManifest(id).draft, true, `${id} must be draft: true`);
    assert.equal(registry["add-ons"].some((a) => a.id === id), false, `${id} must not be listed`);
  }
});

test("Maker Lab no longer requires the (now absent) Companion", () => {
  // A `requires.bundles` naming a bundle that does not exist marks the manifest INVALID,
  // which fails the contract check even for a draft.
  const reqs = repoManifest("maker-lab").requires?.bundles;
  assert.equal(Array.isArray(reqs) ? reqs.includes("companion") : false, false);
  const { audit } = buildRegistry({ tracked: null });
  const row = audit.find((a) => a.id === "maker-lab");
  assert.equal(row?.status, "draft", `maker-lab: ${JSON.stringify(row?.errors)}`);
});

test("Calls no longer points at the Companion (enhancedBy)", () => {
  assert.equal("enhancedBy" in repoManifest("calls"), false);
  const calls = registry["add-ons"].find((a) => a.id === "calls");
  assert.ok(calls, "Calls stays published");
  assert.equal("enhancedBy" in calls, false);
});