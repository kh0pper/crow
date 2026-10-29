import { test } from "node:test";
import assert from "node:assert/strict";
import { testTunableMs, TEST_TIMING_MIN_MS } from "../servers/shared/test-timing.js";

const N = "CROW_TEST_SOME_TIMER_MS";

test("ignored without the suite scratch marker (production default applies)", () => {
  assert.equal(testTunableMs(N, 60_000, { env: { [N]: "1000" } }), 60_000);
  assert.equal(testTunableMs(N, 60_000, { env: { [N]: "1000", CROW_SUITE_SCRATCH: "" } }), 60_000);
});

test("honoured with the marker", () => {
  assert.equal(testTunableMs(N, 60_000, { env: { [N]: "1000", CROW_SUITE_SCRATCH: "/tmp/x" } }), 1000);
  assert.equal(testTunableMs(N, 60_000, { env: { [N]: " 1500 ", CROW_SUITE_SCRATCH: "/tmp/x" } }), 1500);
});

test("unset with the marker: the default", () => {
  assert.equal(testTunableMs(N, 60_000, { env: { CROW_SUITE_SCRATCH: "/tmp/x" } }), 60_000);
});

test("clamped to the minimum", () => {
  const env = { [N]: "1", CROW_SUITE_SCRATCH: "/tmp/x" };
  assert.equal(testTunableMs(N, 60_000, { env }), TEST_TIMING_MIN_MS);
  assert.equal(TEST_TIMING_MIN_MS, 250);
  assert.equal(testTunableMs(N, 60_000, { env, minMs: 500 }), 500);
});

test("bad values are ignored", () => {
  for (const v of ["", "abc", "-5", "0", "1.5", "1e3", "NaN", "Infinity", "99999999999999999999", "100ms"]) {
    assert.equal(testTunableMs(N, 60_000, { env: { [N]: v, CROW_SUITE_SCRATCH: "/tmp/x" } }), 60_000, `value ${JSON.stringify(v)}`);
  }
});

test("reads process.env by default", () => {
  const saved = process.env[N];
  try {
    process.env[N] = "777";
    // Under scripts/run-suite.mjs the marker is set; without it, the default.
    const expect = process.env.CROW_SUITE_SCRATCH ? 777 : 60_000;
    assert.equal(testTunableMs(N, 60_000), expect);
  } finally {
    if (saved === undefined) delete process.env[N]; else process.env[N] = saved;
  }
});
