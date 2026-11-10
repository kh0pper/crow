/**
 * The committed generated files must match what scripts/build-addon-profiles.mjs
 * produces from the repo today:
 *  - registry/addon-profiles.json is regenerated with the COMMITTED past defaults,
 *    so this check does not depend on git;
 *  - registry/addon-past-defaults.json needs git history (skipped on a shallow clone).
 *
 * The controller generates both files by running the script; until it has, these
 * tests fail with the reason rather than a bare ENOENT.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPastDefaults, buildPastDefaultsDoc, buildProfiles } from "../scripts/build-addon-profiles.mjs";
import { isShallowRepo, scanCrowDb } from "../scripts/addon-sandbox/profile.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

function readJson(rel) {
  try {
    return JSON.parse(readFileSync(join(REPO, rel), "utf8"));
  } catch (err) {
    throw new Error(`${rel} is missing or unreadable (${err?.code || err?.message}); run: node scripts/build-addon-profiles.mjs`);
  }
}

let committed = null;
function committedFiles() {
  if (!committed) {
    committed = {
      profiles: readJson("registry/addon-profiles.json"),
      pastDefaults: readJson("registry/addon-past-defaults.json"),
      registry: readJson("registry/add-ons.json"),
    };
  }
  return committed;
}

function profiledIds() {
  return committedFiles().registry["add-ons"].filter((e) => e && e.server).map((e) => e.id);
}

test("registry/addon-profiles.json regenerates equal to the committed file", () => {
  const { profiles, pastDefaults } = committedFiles();
  assert.deepEqual(buildProfiles(pastDefaults.defaults), profiles);
});

test("one profile per registry entry that declares a server", () => {
  const { profiles } = committedFiles();
  const ids = profiledIds();
  assert.equal(Object.keys(profiles.profiles).length, ids.length);
  assert.deepEqual(Object.keys(profiles.profiles).sort(), [...ids].sort());
});

test("every profile is manifest-only: no owner hosts, a label, and the scan's crowDb", () => {
  for (const [id, profile] of Object.entries(committedFiles().profiles.profiles)) {
    assert.equal(profile.id, id);
    for (const host of profile.network.hosts) {
      assert.notEqual(host.source, "owner", `${id}: the registry run holds no owner values`);
      assert.equal(host.source, "default-own-service", `${id}: only this add-on's own published service`);
    }
    assert.ok(profile.label.en.length > 0, `${id}: a label`);
    assert.equal(profile.label.en.length, profile.labelParts.length, `${id}: one phrase per part`);
    assert.equal(profile.crowDb, scanCrowDb(join(REPO, "bundles", id, "server")), `${id}: crowDb agrees with the scan`);
    for (const phrase of [...profile.label.en, ...profile.label.es]) {
      assert.doesNotMatch(phrase, /contained/i, `${id}: never the wall's word`);
    }
  }
});

test("every current manifest default is in the committed past-defaults file", () => {
  // History-free, so this holds on a shallow clone too.
  const { profiles, pastDefaults } = committedFiles();
  for (const id of Object.keys(profiles.profiles)) {
    const manifest = readJson(`bundles/${id}/manifest.json`);
    const defaults = pastDefaults.defaults[id] || {};
    for (const v of manifest.env_vars || []) {
      if (!v || typeof v.name !== "string") continue;
      if (v.default === undefined || v.default === null) continue;
      assert.ok(
        Array.isArray(defaults[v.name]) && defaults[v.name].includes(String(v.default)),
        `${id}: ${v.name} default ${JSON.stringify(v.default)} is missing from registry/addon-past-defaults.json`,
      );
    }
  }
});

test("registry/addon-past-defaults.json regenerates equal to the committed file", (t) => {
  if (isShallowRepo({ repoRoot: REPO })) {
    t.skip("shallow clone: git history is incomplete");
    return;
  }
  assert.deepEqual(buildPastDefaultsDoc(buildPastDefaults()), committedFiles().pastDefaults);
});