/**
 * Owner provenance in mcp-addons.json (`ownerSet`): only a value the LOCAL OWNER typed in
 * their own request may count. The sandbox profile reads `ownerSet` as "the owner chose
 * this address/path", so anything the server merely wrote — a generated secret, a
 * `previous_key` slot, a manifest default the form re-sent, another session's save — must
 * never end up there, and a caller that passes no `owner` gets none at all.
 *
 * Pure: scratch dirs under mkdtemp; bundles.js is imported only after CROW_HOME points at a
 * scratch dir (the same way tests/bundles-env-mcp-config.test.js does).
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ownerSetKeys } from "../scripts/addon-sandbox/profile.mjs";

let B, scratch, seq = 0;
before(async () => {
  scratch = mkdtempSync(join(tmpdir(), "addon-owner-provenance-"));
  process.env.CROW_HOME = scratch;
  process.env.CROW_DATA_DIR = join(scratch, "data");
  mkdirSync(process.env.CROW_DATA_DIR, { recursive: true });
  B = await import("../servers/gateway/routes/bundles.js");
});

/** An mcp-addons.json holding `entries`, in a fresh file. */
function addonsFile(entries) {
  const path = join(scratch, `mcp-addons-${seq++}.json`);
  writeFileSync(path, JSON.stringify(entries));
  return path;
}

const entryOf = (path, id) => JSON.parse(readFileSync(path, "utf8"))[id];
const PAST = JSON.parse(readFileSync(new URL("../registry/addon-past-defaults.json", import.meta.url), "utf8")).defaults || {};
/**
 * What the WALL counts as owner-typed for this entry (profile.mjs ownerSetKeys), and the
 * list must be present: an absent one reads as a legacy entry, where every non-default
 * value counts.
 */
function assertNoOwnerKeys(entry, manifest, id) {
  assert.ok(Array.isArray(entry.ownerSet), "ownerSet is always written once provenance is tracked");
  assert.deepEqual([...ownerSetKeys(entry, manifest, PAST[id] || {})], []);
}

// kolibri's KOLIBRI_URL shipped http://localhost:8085 before
// (registry/addon-past-defaults.json) and ships http://localhost:8041 today.
const KOLIBRI = {
  id: "kolibri",
  name: "Kolibri",
  type: "bundle",
  category: "test",
  server: { command: "node", args: ["server/index.js"], envKeys: ["KOLIBRI_URL"] },
  env_vars: [{ name: "KOLIBRI_URL", default: "http://localhost:8041" }],
};

// --- values that are not the owner's, even on the owner's own save -------------

test("a written value equal to an OLDER shipped default is not owner-set", () => {
  const path = addonsFile({ kolibri: { command: "node", args: [] } });
  B.applyEnvToMcpAddons("kolibri", { KOLIBRI_URL: "http://localhost:8085" }, path, KOLIBRI, { edited: [], owner: true });
  assertNoOwnerKeys(entryOf(path, "kolibri"), KOLIBRI, "kolibri");

  // The contrast: a value that differs from every default this manifest ever shipped is.
  const other = addonsFile({ kolibri: { command: "node", args: [] } });
  B.applyEnvToMcpAddons("kolibri", { KOLIBRI_URL: "http://localhost:9999" }, other, KOLIBRI, { edited: [], owner: true });
  assert.deepEqual(entryOf(other, "kolibri").ownerSet, ["KOLIBRI_URL"]);
});

test("a written key with no default at all is not owner-set when it was not edited", () => {
  const manifest = {
    id: "acme",
    type: "mcp-server",
    category: "test",
    server: { command: "node", args: [], envKeys: ["FREE_TEXT"] },
    env_vars: [{ name: "FREE_TEXT" }],
  };
  const path = addonsFile({ acme: { command: "node", args: [] } });
  // The form sends every filled field, so "it arrived in env_vars" proves nothing.
  B.applyEnvToMcpAddons("acme", { FREE_TEXT: "typed" }, path, manifest, { edited: [], owner: true });
  assertNoOwnerKeys(entryOf(path, "acme"), manifest, "acme");
});

test("with no manifest nothing is owner-set — not even a value that differs from the old entry's", () => {
  const path = addonsFile({ acme: { command: "node", args: [], env: { X: "old" } } });
  B.applyEnvToMcpAddons("acme", { X: "new" }, path, null, { edited: [], owner: true });
  assertNoOwnerKeys(entryOf(path, "acme"), null, "acme");
});

test("an injected previous_key slot is not owner-set, whatever its value", () => {
  const manifest = {
    id: "acme",
    type: "mcp-server",
    category: "test",
    server: { command: "node", args: [], envKeys: ["TAX_KEY", "TAX_KEY_OLD"] },
    env_vars: [{ name: "TAX_KEY", default: "key-one" }, { name: "TAX_KEY_OLD", default: "key-zero" }],
  };
  // The Configure route carries the outgoing key into the previous-key slot itself.
  const path = addonsFile({ acme: { command: "node", args: [] } });
  B.applyEnvToMcpAddons("acme", { TAX_KEY: "key-two", TAX_KEY_OLD: "key-one" }, path, manifest, {
    edited: ["TAX_KEY"],
    injected: ["TAX_KEY_OLD"],
    owner: true,
  });
  assert.deepEqual(entryOf(path, "acme").ownerSet, ["TAX_KEY"]);

  // Without the injection the same slot value would look typed (it differs from its default).
  const unsaid = addonsFile({ acme: { command: "node", args: [] } });
  B.applyEnvToMcpAddons("acme", { TAX_KEY: "key-two", TAX_KEY_OLD: "key-one" }, unsaid, manifest, {
    edited: ["TAX_KEY"],
    owner: true,
  });
  assert.deepEqual(entryOf(unsaid, "acme").ownerSet, ["TAX_KEY", "TAX_KEY_OLD"]);
});

// --- the owner's own save ------------------------------------------------------

test("an edited key is owner-set only when the save is the local owner's", () => {
  const manifest = {
    id: "acme",
    type: "mcp-server",
    category: "test",
    server: { command: "node", args: [], envKeys: ["X"] },
    env_vars: [{ name: "X" }],
  };
  const owned = addonsFile({ acme: { command: "node", args: [] } });
  B.applyEnvToMcpAddons("acme", { X: "typed" }, owned, manifest, { edited: ["X"], owner: true });
  assert.deepEqual(entryOf(owned, "acme").ownerSet, ["X"]);

  const peer = addonsFile({ acme: { command: "node", args: [] } });
  B.applyEnvToMcpAddons("acme", { X: "typed" }, peer, manifest, { edited: ["X"], owner: false });
  assertNoOwnerKeys(entryOf(peer, "acme"), manifest, "acme");

  // No `owner` at all is the same as false: fail closed.
  const unstated = addonsFile({ acme: { command: "node", args: [] } });
  B.applyEnvToMcpAddons("acme", { X: "typed" }, unstated, manifest, { edited: ["X"] });
  assertNoOwnerKeys(entryOf(unstated, "acme"), manifest, "acme");
});

test("a save that is not the owner's removes the keys it rewrote from an existing ownerSet", () => {
  const manifest = {
    id: "acme",
    type: "mcp-server",
    category: "test",
    server: { command: "node", args: [], envKeys: ["X", "Y"] },
    env_vars: [{ name: "X" }, { name: "Y" }],
  };
  const path = addonsFile({ acme: { command: "node", args: [], env: { X: "typed", Y: "typed" }, ownerSet: ["X", "Y"] } });
  B.applyEnvToMcpAddons("acme", { X: "rewritten" }, path, manifest, { edited: ["X"], owner: false });
  // Y's value was not written by this save, so it keeps its claim; X's new value was not
  // typed by the owner, so its claim goes.
  assert.deepEqual(entryOf(path, "acme").ownerSet, ["Y"]);
});

// --- the install shape ---------------------------------------------------------

test("mcpAddonEntryFor writes an ownerSet only for the local owner's own install", () => {
  const manifest = {
    id: "acme",
    type: "mcp-server",
    category: "test",
    server: { command: "node", args: [], envKeys: ["X"] },
    env_vars: [{ name: "X" }],
  };
  assertNoOwnerKeys(B.mcpAddonEntryFor(manifest, { X: "typed" }, { edited: ["X"], owner: false }), manifest, "acme");
  assertNoOwnerKeys(B.mcpAddonEntryFor(manifest, { X: "typed" }, { edited: ["X"] }), manifest, "acme");
  assert.deepEqual(B.mcpAddonEntryFor(manifest, { X: "typed" }, { edited: ["X"], owner: true }).ownerSet, ["X"]);
});
test("a non-owner save keeps the owner's claim on a value it did not change", () => {
  const dir = mkdtempSync(join(tmpdir(), "crow-owner-prov-keep-"));
  const path = join(dir, "mcp-addons.json");
  writeFileSync(path, JSON.stringify({ acme: { command: "node", args: [], env: { X: "typed", Y: "old" }, ownerSet: ["X", "Y"] } }));
  B.applyEnvToMcpAddons("acme", { X: "typed", Y: "new" }, path, { id: "acme", env_vars: [{ name: "X" }, { name: "Y" }] }, { owner: false });
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).acme.ownerSet, ["X"]);
  rmSync(dir, { recursive: true, force: true });
});

// --- an absent list must never be what a non-owner leaves behind -----------------

const ACME_URL_MANIFEST = {
  id: "acme",
  type: "mcp-server",
  category: "test",
  server: { command: "node", args: [], envKeys: ["ACME_URL"] },
  env_vars: [{ name: "ACME_URL" }],
};

test("a non-owner install leaves an empty list, so the wall counts none of its values", () => {
  const entry = B.mcpAddonEntryFor(ACME_URL_MANIFEST, { ACME_URL: "http://100.64.20.9:22" }, { owner: false });
  assertNoOwnerKeys(entry, ACME_URL_MANIFEST, "acme");
});

test("a non-owner save that empties the list keeps it, so the new value is not laundered as legacy", () => {
  const path = addonsFile({ acme: { command: "node", args: [], env: { ACME_URL: "http://100.64.20.5:80" }, ownerSet: ["ACME_URL"] } });
  B.applyEnvToMcpAddons("acme", { ACME_URL: "http://100.64.20.9:22" }, path, ACME_URL_MANIFEST, { owner: false });
  assertNoOwnerKeys(entryOf(path, "acme"), ACME_URL_MANIFEST, "acme");
});

test("a non-owner save on a legacy entry materialises the legacy claims and drops the ones it changed", () => {
  const manifest = { ...ACME_URL_MANIFEST, server: { command: "node", args: [], envKeys: ["ACME_URL", "KEEP_URL"] }, env_vars: [{ name: "ACME_URL" }, { name: "KEEP_URL" }] };
  const path = addonsFile({ acme: { command: "node", args: [], env: { ACME_URL: "http://100.64.20.5:80", KEEP_URL: "http://100.64.20.6:80" } } });
  B.applyEnvToMcpAddons("acme", { ACME_URL: "http://100.64.20.9:22" }, path, manifest, { owner: false });
  const e = entryOf(path, "acme");
  assert.deepEqual(e.ownerSet, ["KEEP_URL"]);
  assert.deepEqual([...ownerSetKeys(e, manifest, {})], ["KEEP_URL"]);
});

test("a reinstall keeps the claims on values it does not change, and drops the rest", () => {
  const manifest = { ...ACME_URL_MANIFEST, server: { command: "node", args: [], envKeys: ["ACME_URL", "OTHER_URL"] }, env_vars: [{ name: "ACME_URL" }, { name: "OTHER_URL" }] };
  const prior = { command: "node", args: [], env: { ACME_URL: "http://100.64.20.5:80", OTHER_URL: "http://100.64.20.6:80" }, ownerSet: ["ACME_URL", "OTHER_URL"] };
  const owned = B.mcpAddonEntryFor(manifest, { ACME_URL: "http://100.64.20.5:80", OTHER_URL: "http://100.64.20.7:80" }, { owner: true, edited: [], priorEntry: prior });
  assert.deepEqual(owned.ownerSet, ["ACME_URL"]);
  const peer = B.mcpAddonEntryFor(manifest, { ACME_URL: "http://100.64.20.5:80", OTHER_URL: "http://100.64.20.7:80" }, { owner: false, priorEntry: prior });
  assert.deepEqual(peer.ownerSet, ["ACME_URL"]);
});
