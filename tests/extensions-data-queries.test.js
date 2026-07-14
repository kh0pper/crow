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

const { getInstalled, fetchRegistryData, CROW_DIR, INSTALLED_PATH } = await import("../servers/gateway/dashboard/panels/extensions/data-queries.js");

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

test("fetchRegistryData derives _community from the entry's own official field (registry provenance)", async () => {
  // Stub the remote-registry fetch: one third-party entry (official:false, the
  // build-registry output for manifest origin:"community"), one pre-provenance
  // entry with official ABSENT (a stale remote mirror) — the conservative
  // default must treat it as first-party. The repo's local registry entries
  // (all official:true) merge in and must all stay _community:false.
  const remote = {
    "add-ons": [
      { id: "zz-thirdparty-fixture", name: "ZZ Third Party", description: "d", type: "skill", category: "misc", official: false, origin: "community" },
      { id: "zz-stale-mirror-fixture", name: "ZZ Stale", description: "d", type: "skill", category: "misc" },
    ],
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => remote });
  try {
    const { available } = await fetchRegistryData();
    const third = available.find((a) => a.id === "zz-thirdparty-fixture");
    const stale = available.find((a) => a.id === "zz-stale-mirror-fixture");
    assert.ok(third, "stubbed community entry missing from available");
    assert.equal(third._community, true, "official:false entry must be _community (Community badge + install caution)");
    assert.equal(stale._community, false, "official-absent entry must default to first-party, never falsely badged");
    const locals = available.filter((a) => !a.id.startsWith("zz-"));
    assert.ok(locals.length > 50, "local registry entries should have merged in");
    for (const a of locals) {
      assert.equal(a._community, false, `local first-party entry '${a.id}' must not be _community`);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

test.after(() => {
  rmSync(scratchHome, { recursive: true, force: true });
});
