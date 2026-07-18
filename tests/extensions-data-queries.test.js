// tests/extensions-data-queries.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// data-queries.js resolves CROW_DIR/INSTALLED_PATH/STORES_PATH from CROW_HOME at
// module load (mirrors the same pattern in bundles.js / install-set-e2e.test.js).
// The env var MUST be set BEFORE the dynamic import below — a static import is
// hoisted to the top of the file and would read the real ~/.crow before this
// test ever runs, which is exactly the prod-contamination bug this test guards
// against (a scratch gateway rendered the OPERATOR's prod installed list).
const scratchHome = mkdtempSync(join(tmpdir(), "crow-test-home-"));
process.env.CROW_HOME = scratchHome;

mkdirSync(scratchHome, { recursive: true });
const fixtureInstalled = {
  "fx-panel": { id: "fx-panel", name: "FX Panel", installedAt: "2026-07-01T00:00:00.000Z" },
};
writeFileSync(join(scratchHome, "installed.json"), JSON.stringify(fixtureInstalled, null, 2));

const { getInstalled, fetchRegistryData, withProvenance, CROW_DIR, INSTALLED_PATH } = await import("../servers/gateway/dashboard/panels/extensions/data-queries.js");

test("getInstalled() resolves CROW_DIR from CROW_HOME, not the operator's real ~/.crow", () => {
  // The module must have derived its paths from the scratch CROW_HOME we set above,
  // not from homedir()/.crow.
  assert.equal(CROW_DIR, scratchHome, "CROW_DIR did not honor CROW_HOME env var");
  assert.equal(INSTALLED_PATH, join(scratchHome, "installed.json"));

  const installed = getInstalled();
  const ids = Object.keys(installed);

  assert.deepEqual(ids, ["fx-panel"], "getInstalled() must return ONLY the scratch fixture entry");
  assert.equal(installed["fx-panel"].name, "FX Panel");

  // Guard against the exact prod-contamination failure mode: the operator's real
  // ~/.crow/installed.json has entries like a Maker Lab bundle that must NEVER
  // show up here.
  for (const id of ids) {
    assert.doesNotMatch(id, /maker/i, "an operator-prod entry leaked into the scratch-home result");
  }
});

test("withProvenance derives _community from the entry's own official field (registry provenance)", () => {
  // A registry entry generated from a manifest with origin:"community" carries
  // official:false and must badge as Community (badge + install caution). An
  // entry with official ABSENT (pre-provenance data) must conservatively
  // default to first-party — never falsely badged.
  const [third, absent] = withProvenance([
    { id: "zz-thirdparty-fixture", name: "ZZ Third Party", description: "d", type: "skill", category: "misc", official: false, origin: "community" },
    { id: "zz-preprovenance-fixture", name: "ZZ Absent", description: "d", type: "skill", category: "misc" },
  ]);
  assert.equal(third._community, true, "official:false entry must be _community (Community badge + install caution)");
  assert.equal(absent._community, false, "official-absent entry must default to first-party, never falsely badged");
});

test("fetchRegistryData serves the in-repo registry as the sole registry source (remote mirror retired)", async () => {
  // The remote crow-addons mirror was retired 2026-07-18: no network fetch may
  // occur, and every available registry entry comes from registry/add-ons.json.
  const realFetch = globalThis.fetch;
  let fetched = false;
  globalThis.fetch = async () => { fetched = true; throw new Error("no network in tests"); };
  try {
    const { available, registrySource } = await fetchRegistryData();
    assert.equal(fetched, false, "fetchRegistryData must not fetch a remote registry");
    assert.equal(registrySource, "local");
    assert.ok(available.length > 50, "local registry entries should have loaded");
    for (const a of available) {
      assert.equal(a._community, a.official === false,
        `entry '${a.id}': _community must mirror official===false (badge exactly the declared community entries)`);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

test.after(() => {
  rmSync(scratchHome, { recursive: true, force: true });
});
