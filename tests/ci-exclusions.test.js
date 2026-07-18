// Meta-test for tests/ci-exclusions.json — the CI exclusion list is itself
// under test so it can rot in neither direction: entries must be well-formed
// and must name files that still exist (run-suite.mjs hard-errors on stale
// entries; this test makes the same contract visible in the suite).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const PATH = join(__dir, "ci-exclusions.json");
const VALID_CLASSES = new Set(["docker", "network", "multi-instance", "timing", "host-systemd"]);

test("ci-exclusions.json exists and parses", () => {
  assert.ok(existsSync(PATH), "tests/ci-exclusions.json must exist (an empty list is fine — run-suite.mjs requires the file)");
  const data = JSON.parse(readFileSync(PATH, "utf8"));
  assert.ok(Array.isArray(data.excluded), "top-level 'excluded' must be an array");
});

test("every exclusion entry is well-formed and names an existing test file", () => {
  const { excluded } = JSON.parse(readFileSync(PATH, "utf8"));
  for (const entry of excluded) {
    assert.equal(typeof entry.file, "string", "entry.file must be a string");
    assert.ok(entry.file.endsWith(".test.js"), `${entry.file}: must be a *.test.js file`);
    assert.ok(!entry.file.includes("/"), `${entry.file}: must be a bare filename relative to tests/`);
    assert.ok(existsSync(join(__dir, entry.file)), `${entry.file}: names a test file that no longer exists — remove the stale entry`);
    assert.ok(VALID_CLASSES.has(entry.class), `${entry.file}: class '${entry.class}' not in ${[...VALID_CLASSES].join("|")}`);
    assert.equal(typeof entry.reason, "string", `${entry.file}: reason must be a string`);
    assert.ok(entry.reason.trim().length >= 10, `${entry.file}: reason must be specific (≥10 chars)`);
  }
});

test("the exclusion list cannot silently exclude the whole suite", () => {
  const { excluded } = JSON.parse(readFileSync(PATH, "utf8"));
  // A quarantine list is for the tail, not the body. If this ever trips,
  // something is very wrong with either the runner or the process.
  assert.ok(excluded.length <= 10, `ci-exclusions.json has ${excluded.length} entries — that is not a quarantine, that is a broken gate`);
});
