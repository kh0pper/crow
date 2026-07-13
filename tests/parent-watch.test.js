// Tests for servers/gateway/parent-watch.js — die-with-session watchdog.
//
// Contract under test:
//   startParentWatch({ onOrphaned, getPpid, intervalMs }) →
//     - records the INITIAL ppid; fires onOrphaned() exactly ONCE when a later
//       tick sees a DIFFERENT ppid (parent died → we were re-parented), then stops.
//     - never fires while ppid is stable.
//     - refuses to arm (returns { armed: false }) when:
//         * process.env.INVOCATION_ID is set (running under systemd), or
//         * process.env.CROW_ALLOW_ORPHAN === "1", or
//         * the INITIAL ppid is already <= 1 (started detached / container
//           PID-1 child — ppid-CHANGE is the only safe signal there).
//     - returns a stop() handle; stop() prevents any later firing.
//
// All tests are pure unit tests with an injected getPpid and a short real
// intervalMs (no gateway boot, no processes spawned).
//
// NOTE on wiring: the final test asserts the gateway SOURCE wires
// startParentWatch (import + call + gracefulShutdown in the handler). This is
// source-asserted, not executed — we cannot boot the prod gateway in-test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { startParentWatch } from "../servers/gateway/parent-watch.js";

const __dir = dirname(fileURLToPath(import.meta.url));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Save the env keys the module reads, clear them, and return a restore fn. */
function scrubEnv() {
  const saved = {
    INVOCATION_ID: process.env.INVOCATION_ID,
    CROW_ALLOW_ORPHAN: process.env.CROW_ALLOW_ORPHAN,
  };
  delete process.env.INVOCATION_ID;
  delete process.env.CROW_ALLOW_ORPHAN;
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

test("fires onOrphaned exactly once when ppid changes, then stops", async (t) => {
  const restore = scrubEnv();
  t.after(restore);

  let ppid = 4242;
  let fired = 0;
  const watch = startParentWatch({
    onOrphaned: () => fired++,
    getPpid: () => ppid,
    intervalMs: 10,
  });
  t.after(() => watch.stop());

  assert.equal(watch.armed, true, "should arm with a normal initial ppid");

  await sleep(40); // several stable ticks first
  assert.equal(fired, 0, "must not fire while ppid is unchanged");

  ppid = 1; // parent died → re-parented to init
  await sleep(60); // multiple ticks AFTER the change
  assert.equal(fired, 1, "must fire exactly once, even across many ticks");
});

test("never fires when ppid stays stable", async (t) => {
  const restore = scrubEnv();
  t.after(restore);

  let fired = 0;
  const watch = startParentWatch({
    onOrphaned: () => fired++,
    getPpid: () => 777,
    intervalMs: 10,
  });
  t.after(() => watch.stop());

  await sleep(80);
  assert.equal(fired, 0, "stable ppid must never trigger onOrphaned");
});

test("refuses to arm under systemd (INVOCATION_ID set)", async (t) => {
  const restore = scrubEnv();
  t.after(restore);
  process.env.INVOCATION_ID = "abcdef1234567890";

  let ppid = 4242;
  let fired = 0;
  const watch = startParentWatch({
    onOrphaned: () => fired++,
    getPpid: () => ppid,
    intervalMs: 10,
  });
  t.after(() => watch.stop());

  assert.equal(watch.armed, false, "must not arm when INVOCATION_ID is set");
  ppid = 1;
  await sleep(50);
  assert.equal(fired, 0, "must never fire under systemd even if ppid changes");
});

test("refuses to arm when CROW_ALLOW_ORPHAN=1", async (t) => {
  const restore = scrubEnv();
  t.after(restore);
  process.env.CROW_ALLOW_ORPHAN = "1";

  let ppid = 4242;
  let fired = 0;
  const watch = startParentWatch({
    onOrphaned: () => fired++,
    getPpid: () => ppid,
    intervalMs: 10,
  });
  t.after(() => watch.stop());

  assert.equal(watch.armed, false, "must not arm when CROW_ALLOW_ORPHAN=1");
  ppid = 1;
  await sleep(50);
  assert.equal(fired, 0, "opt-out must fully disable firing");
});

test("refuses to arm when the initial ppid is already <= 1", async (t) => {
  const restore = scrubEnv();
  t.after(restore);

  for (const initial of [1, 0]) {
    let ppid = initial;
    let fired = 0;
    const watch = startParentWatch({
      onOrphaned: () => fired++,
      getPpid: () => ppid,
      intervalMs: 10,
    });
    assert.equal(
      watch.armed,
      false,
      `initial ppid ${initial} is a legit steady state (detached/container) — must not arm`
    );
    ppid = 999; // even a subsequent "change" must not fire
    await sleep(40);
    assert.equal(fired, 0, `must never fire when started with ppid ${initial}`);
    watch.stop();
  }
});

test("stop() prevents any later firing", async (t) => {
  const restore = scrubEnv();
  t.after(restore);

  let ppid = 4242;
  let fired = 0;
  const watch = startParentWatch({
    onOrphaned: () => fired++,
    getPpid: () => ppid,
    intervalMs: 10,
  });

  watch.stop();
  ppid = 1;
  await sleep(50);
  assert.equal(fired, 0, "stop() must disarm the watch");
});

test("gateway index.js wires startParentWatch (source-asserted, not executed)", () => {
  // We cannot boot the production gateway inside a unit test, so this asserts
  // the WIRING exists in source: the import, the call, and that the orphan
  // handler routes into the existing gracefulShutdown path.
  const src = readFileSync(
    join(__dir, "..", "servers", "gateway", "index.js"),
    "utf8"
  );
  assert.match(
    src,
    /import\s*\{\s*startParentWatch\s*\}\s*from\s*["']\.\/parent-watch\.js["']/,
    "index.js must import startParentWatch from ./parent-watch.js"
  );
  assert.match(src, /startParentWatch\s*\(/, "index.js must call startParentWatch");
  const callIdx = src.indexOf("startParentWatch(");
  const region = src.slice(callIdx, callIdx + 600);
  assert.match(
    region,
    /gracefulShutdown/,
    "the onOrphaned handler must invoke the existing gracefulShutdown"
  );
});
