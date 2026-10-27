/**
 * Task 4.5: the trust rule lives in one place (servers/shared/artifact-trust.js). The
 * Artifacts bundle's store.js re-exports it, so the bundle and core (Make's previews)
 * cannot drift apart. Same answers on a truth table, and the same function objects.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as shared from "../servers/shared/artifact-trust.js";
import * as store from "../bundles/artifacts/server/store.js";

const FLAGS = [0, 1, 2, -1, 0n, 1n, "0", "1", "", " ", null, undefined, NaN, "x", true, false, 0.5, "0.0"];

test("flagUntrusted: the bundle's re-export is the shared rule", () => {
  assert.equal(store.flagUntrusted, shared.flagUntrusted);
  for (const x of FLAGS) assert.equal(store.flagUntrusted(x), shared.flagUntrusted(x), `flagUntrusted(${String(x)})`);
  // Only an explicit 0 is clean.
  assert.equal(shared.flagUntrusted(0), false);
  assert.equal(shared.flagUntrusted(0n), false);
  assert.equal(shared.flagUntrusted("0"), false);
  for (const x of [1, 1n, "1", null, undefined, "", " ", false, "0.0", 0.5, -1, NaN, "x", true, "00", " 0"]) assert.equal(shared.flagUntrusted(x), true, String(x));
  assert.equal(shared.isTainted({ untrusted_input: false }), true, "false is not an explicit 0");
});

test("isTainted: the bundle's re-export is the shared rule", () => {
  assert.equal(store.isTainted, shared.isTainted);
  const rows = [null, undefined, {}];
  for (const u of FLAGS) for (const c of [null, undefined, "", "2026-10-27 10:00:00"]) rows.push({ untrusted_input: u, trust_cleared_at: c });
  for (const v of rows) assert.equal(store.isTainted(v), shared.isTainted(v), JSON.stringify(v, (k, x) => (typeof x === "bigint" ? `${x}n` : x)));
  assert.equal(shared.isTainted(null), true);
  assert.equal(shared.isTainted({ untrusted_input: 0 }), false);
  assert.equal(shared.isTainted({ untrusted_input: 1 }), true);
  assert.equal(shared.isTainted({ untrusted_input: 1, trust_cleared_at: "2026-10-27 10:00:00" }), false);
});
