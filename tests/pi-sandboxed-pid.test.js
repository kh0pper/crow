// resolveSandboxedPiPid: pi's outer pid inside a PID-namespace sandbox, driven
// against a fake /proc and a fake clock (no bwrap, no real sleeps). The contain
// tier's entry process sits between the namespace init and pi, and it boots
// node, opens its relay listeners and only THEN spawns pi — so the resolution
// needs one wall-clock budget for the whole descent, and it must not accept a
// child read right after fork (its cmdline is still the parent's).
import { test } from "node:test";
import assert from "node:assert/strict";
import "./helpers/pi-scratch-home.mjs";

const { resolveSandboxedPiPid, SANDBOXED_PI_PID_BUDGET_MS, SANDBOXED_PI_PID_INTERVAL_MS } =
  await import("../scripts/pi-bots/bridge.mjs");

const INIT = 100;
const ENTRY = 200;
const PI = 300;
const children = (pid) => "/proc/" + pid + "/task/" + pid + "/children";
const cmdline = (pid) => "/proc/" + pid + "/cmdline";
const PARENT_CMD = "/usr/bin/bwrap\0--tmpfs\0/\0--\0/n/node\0/a/scripts/pi-bots/pi_netns_entry.mjs\0";
const ENTRY_CMD = "/n/node\0/a/scripts/pi-bots/pi_netns_entry.mjs\0--sock\0/run/crow-net/relay.sock\0--\0/n/node\0/x/stub-pi.mjs\0";
const PI_CMD = "/n/node\0/x/stub-pi.mjs\0--mode\0rpc\0";
const fakeRpc = () => ({ piPid: null, _exitCode: null });

/**
 * A fake /proc (`table` maps a path to a string, or to a (clock) => string
 * function so a process can appear/exec later) plus a fake clock and timer.
 * Both are injected, so nothing here waits.
 *   - `tick()` runs the next scheduled poll, advancing the clock by the interval
 *     the product itself asked for;
 *   - `drive()` ticks until the resolution settles (the deadline guarantees an
 *     end even if the product never finds a process).
 */
function harness(table, { budgetMs = SANDBOXED_PI_PID_BUDGET_MS, intervalMs = SANDBOXED_PI_PID_INTERVAL_MS } = {}) {
  let clock = 0;
  const timers = [];
  const paths = [];
  let steps = 0;
  const readFile = (path) => {
    paths.push(path);
    const v = table[path];
    if (v === undefined) { const e = new Error("ENOENT: " + path); e.code = "ENOENT"; throw e; }
    return typeof v === "function" ? v(clock) : v;
  };
  const h = {
    now: () => clock,
    pending: () => timers.length,
    steps: () => steps,
    paths,
    tick() {
      const t = timers.shift();
      if (!t) return false;
      steps++;
      clock += t.ms;
      t.fn();
      return true;
    },
    drive() { while (h.pending()) h.tick(); },
    start(rpc, initPid) {
      resolveSandboxedPiPid(rpc, initPid, {
        readFile,
        now: () => clock,
        budgetMs,
        intervalMs,
        // Unref'd like the real one; the test holds the callbacks instead.
        setTimer: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; },
      });
      return rpc;
    },
  };
  return h;
}

test("pi that appears under the contain entry after 5000 ms is found (past the old 2 s budget)", async () => {
  const h = harness({
    [children(INIT)]: String(ENTRY),
    [cmdline(INIT)]: PARENT_CMD,
    [cmdline(ENTRY)]: ENTRY_CMD,
    // The entry is slow under load: node boots and listens before it spawns pi.
    [children(ENTRY)]: (t) => (t >= 5000 ? String(PI) : ""),
    [cmdline(PI)]: PI_CMD,
  });
  const rpc = h.start(fakeRpc(), INIT);
  h.drive();
  await rpc.piPidReady;
  assert.equal(rpc.piPid, PI);
  assert.ok(h.now() >= 5000, "resolved only once pi was there: " + h.now() + " ms");
  assert.ok(h.now() > 2000, "the entry level does not share the old 2 s try budget");
});

test("a child still showing its parent's cmdline (forked, not yet exec'd) is not pi; it is after exec", async () => {
  const h = harness({
    [children(INIT)]: String(PI),
    [cmdline(INIT)]: PARENT_CMD,
    // Right after fork the copy has not exec'd: it reads exactly the parent's cmdline.
    [cmdline(PI)]: (t) => (t >= 300 ? PI_CMD : PARENT_CMD),
  });
  const rpc = h.start(fakeRpc(), INIT);
  assert.equal(rpc.piPid, null, "the pre-exec copy is not accepted");
  h.drive();
  await rpc.piPidReady;
  assert.equal(rpc.piPid, PI);
  assert.ok(h.now() >= 300, "accepted only after the exec: " + h.now() + " ms");
  // Without the parent-cmdline check this PARENT_CMD would be taken as the entry
  // and only the deadline fallback would land on PI, long after the exec.
  assert.ok(h.now() < 300 + 2 * SANDBOXED_PI_PID_INTERVAL_MS, "settled right after the exec: " + h.now() + " ms");
});

test("at the entry level, pi showing the entry's cmdline is not accepted and pi's own child is never taken", async () => {
  const DECOY = 400;
  const h = harness({
    [children(INIT)]: String(ENTRY),
    [cmdline(INIT)]: PARENT_CMD,
    [cmdline(ENTRY)]: ENTRY_CMD,
    [children(ENTRY)]: String(PI),
    // pi forked from the entry: until its exec it reads the ENTRY's cmdline, mark included.
    [cmdline(PI)]: (t) => (t >= 300 ? PI_CMD : ENTRY_CMD),
    // A trap: stepping into an unsettled pi's children would reach this one.
    [children(PI)]: String(DECOY),
    [cmdline(DECOY)]: PI_CMD,
  });
  const rpc = h.start(fakeRpc(), INIT);
  assert.equal(rpc.piPid, null, "neither the entry nor the pre-exec copy is pi");
  h.drive();
  await rpc.piPidReady;
  assert.equal(rpc.piPid, PI, "pi itself, never its child " + DECOY);
  assert.ok(h.now() >= 300, "accepted only after the exec: " + h.now() + " ms");
  assert.ok(h.now() < 300 + 2 * SANDBOXED_PI_PID_INTERVAL_MS, "settled right after the exec: " + h.now() + " ms");
});

test("outside the contain tier a child copying the plain bwrap cmdline is not pi until it execs", async () => {
  // No entry process: the init's args carry no ENTRY_MARK, so only the
  // parent-cmdline comparison can tell the forked copy from a settled pi.
  const BWRAP_CMD = "/usr/bin/bwrap\0--tmpfs\0/\0";
  const h = harness({
    [children(INIT)]: String(PI),
    [cmdline(INIT)]: BWRAP_CMD,
    [cmdline(PI)]: (t) => (t >= 300 ? PI_CMD : BWRAP_CMD),
  });
  const rpc = h.start(fakeRpc(), INIT);
  assert.equal(rpc.piPid, null, "the pre-exec copy is not accepted");
  h.drive();
  await rpc.piPidReady;
  assert.equal(rpc.piPid, PI);
  assert.ok(h.now() >= 300, "accepted only after the exec: " + h.now() + " ms");
  assert.ok(h.now() < 300 + 2 * SANDBOXED_PI_PID_INTERVAL_MS, "settled right after the exec: " + h.now() + " ms");
});

test("deadline reached with only the entry present: falls back to the deepest process (the entry)", async () => {
  const h = harness({
    [children(INIT)]: String(ENTRY),
    [cmdline(INIT)]: PARENT_CMD,
    [cmdline(ENTRY)]: ENTRY_CMD,
    // pi never shows up.
  });
  const rpc = h.start(fakeRpc(), INIT);
  h.drive();
  await rpc.piPidReady;
  assert.equal(rpc.piPid, ENTRY, "the fallback is the entry, still inside the sandbox");
  assert.ok(h.now() >= SANDBOXED_PI_PID_BUDGET_MS, "stopped on the wall-clock budget: " + h.now() + " ms");
  assert.ok(h.now() < SANDBOXED_PI_PID_BUDGET_MS + SANDBOXED_PI_PID_INTERVAL_MS * 2, "and not long after it");
});

test("rpc exit stops the polling and settles piPidReady on the deepest process", async () => {
  const h = harness({ [children(INIT)]: "" });
  const rpc = h.start(fakeRpc(), INIT);
  assert.equal(h.pending(), 1, "polling started");
  h.tick();
  rpc._exitCode = 1;
  h.drive();
  await rpc.piPidReady;
  assert.equal(rpc.piPid, INIT);
  assert.equal(h.pending(), 0, "no further polls after the exit");
  assert.ok(h.now() < SANDBOXED_PI_PID_BUDGET_MS, "the exit ended it early: " + h.now() + " ms");
});

test("an rpc whose piPidReady is already pending (the pidns constructor's) keeps that same promise", async () => {
  const h = harness({
    [children(INIT)]: String(ENTRY),
    [cmdline(INIT)]: PARENT_CMD,
    [cmdline(ENTRY)]: ENTRY_CMD,
    // pi shows up a second in, so the promise really is still pending at await time.
    [children(ENTRY)]: (t) => (t >= 1000 ? String(PI) : ""),
    [cmdline(PI)]: PI_CMD,
  });
  const rpc = fakeRpc();
  let settle = null;
  rpc.piPidReady = new Promise((resolve) => { settle = resolve; });
  rpc._piPidDone = settle;
  const early = rpc.piPidReady;
  h.start(rpc, INIT);
  assert.equal(rpc.piPidReady, early, "the pending promise is settled, not replaced");
  assert.equal(rpc.piPid, null, "still unresolved while pi is missing");
  h.drive();
  await early;
  assert.equal(rpc.piPid, PI, "the early awaiter sees the pid");
  assert.equal(rpc._piPidDone, null, "the resolver is not kept after settling");
});

test("normal case: the init's first child is pi, and piPidReady resolves", async () => {
  const h = harness({ [children(INIT)]: String(PI), [cmdline(INIT)]: PARENT_CMD, [cmdline(PI)]: PI_CMD });
  const rpc = h.start(fakeRpc(), INIT);
  assert.ok(rpc.piPidReady instanceof Promise, "readiness is exposed as a promise");
  assert.equal(rpc.piPid, PI, "resolved without a wait");
  assert.equal(h.pending(), 0, "nothing left polling");
  await rpc.piPidReady;
  assert.equal(rpc.piPid, PI);
});