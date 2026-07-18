// A1 acceptance red-proof: deliberately failing test, pushed to PR #221 and
// reverted immediately. Runtime-inert (test-only) by design.
import { test } from "node:test";
import assert from "node:assert/strict";
test("A1 red-proof: this failure must turn the suite check red", () => {
  assert.fail("deliberate red-proof failure — this commit is reverted in the next push");
});
