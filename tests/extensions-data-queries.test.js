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

const { getInstalled, CROW_DIR, INSTALLED_PATH } = await import("../servers/gateway/dashboard/panels/extensions/data-queries.js");

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

test.after(() => {
  rmSync(scratchHome, { recursive: true, force: true });
});
