/**
 * Tests for servers/gateway/process-supervisor.js — the generic
 * child-process supervision core extracted out of models/runtime.js's
 * `startModel` (C4 Task 1). `models/runtime.js` is the first consumer
 * (`key: alias`, `command: binPath`); `bot-runtime.js` (discord child,
 * PR C4-C) and future Perch session hosts are next — this module must
 * stay free of model- or bot-specific logic, so these tests exercise it
 * with a generic `command`/`args`/`key` shape, never `alias`/`binPath`.
 *
 * Same stub pattern as `tests/models-runtime.test.js`: a fake `spawn`
 * returning a plain `EventEmitter` standing in for a `ChildProcess`, plus
 * injected `setTimeoutFn`/`clearTimeoutFn` recording calls instead of
 * touching a real clock. No real process is ever spawned.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { superviseProcess, stopSupervised } from "../servers/gateway/process-supervisor.js";

function fakeChild(pid) {
  const ee = new EventEmitter();
  ee.pid = pid;
  ee.kill = () => {
    setImmediate(() => ee.emit("exit", 0, "SIGTERM"));
  };
  return ee;
}

// ---------------------------------------------------------------------------
// spawn shape — detached, own process group, setpriv wrapping
// ---------------------------------------------------------------------------

test("superviseProcess spawns detached (own process group) with the given command/args", async () => {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return fakeChild(9001);
  };
  const handle = superviseProcess({
    key: "generic-child-1",
    command: "/opt/bot/bridge",
    args: ["--turn", "1"],
    spawn,
    setprivAvailable: false,
    keepWarm: true, // no idle timer noise for this test
  });
  try {
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, "/opt/bot/bridge");
    assert.deepEqual(calls[0].args, ["--turn", "1"]);
    assert.equal(calls[0].opts.detached, true);
    assert.equal(handle.live, true);
    assert.equal(handle.state, "running");
    assert.equal(handle.key, "generic-child-1");
  } finally {
    await handle.stop();
  }
});

test("superviseProcess wraps the command in setpriv --pdeathsig=SIGTERM when setprivAvailable", async () => {
  const calls = [];
  const spawn = (cmd, args) => {
    calls.push({ cmd, args });
    return fakeChild(9002);
  };
  const handle = superviseProcess({
    key: "generic-child-2",
    command: "/opt/bot/bridge",
    args: ["--turn", "1"],
    spawn,
    setprivAvailable: true,
    keepWarm: true,
  });
  try {
    assert.equal(calls[0].cmd, "setpriv");
    assert.deepEqual(calls[0].args.slice(0, 2), ["--pdeathsig=SIGTERM", "/opt/bot/bridge"]);
    assert.deepEqual(calls[0].args.slice(2), ["--turn", "1"]);
  } finally {
    await handle.stop();
  }
});

// ---------------------------------------------------------------------------
// restart with backoff, gives up at maxRestarts
// ---------------------------------------------------------------------------

test("superviseProcess restarts with backoff up to maxRestarts, then goes unhealthy with lastError", async () => {
  const children = [];
  const spawn = () => {
    const child = fakeChild(9100 + children.length);
    children.push(child);
    return child;
  };
  const timeoutCalls = [];
  const setTimeoutFn = (fn, ms) => {
    timeoutCalls.push(ms);
    fn();
    return timeoutCalls.length;
  };
  const clearTimeoutFn = () => {};

  const handle = superviseProcess({
    key: "restart-test",
    command: "/opt/bot/bridge",
    args: [],
    spawn,
    setprivAvailable: false,
    keepWarm: true, // isolate from idle-timer scheduling entirely
    maxRestarts: 3,
    setTimeoutFn,
    clearTimeoutFn,
  });

  assert.equal(children.length, 1);
  children[0].emit("exit", 1, null);
  assert.equal(handle.restartCount, 1);
  assert.equal(handle.state, "running");
  assert.equal(children.length, 2);

  children[1].emit("exit", 1, null);
  assert.equal(children.length, 3);
  assert.equal(handle.restartCount, 2);

  children[2].emit("exit", 1, null);
  assert.equal(children.length, 4);
  assert.equal(handle.restartCount, 3);

  // Fourth failure: restartCount(3) >= maxRestarts(3) -> give up.
  children[3].emit("exit", 1, "SIGSEGV");
  assert.equal(children.length, 4); // no fifth spawn
  assert.equal(handle.state, "unhealthy");
  assert.equal(handle.restartCount, 3);
  assert.match(handle.lastError, /SIGSEGV/);
  assert.equal(handle.live, false);
});

// ---------------------------------------------------------------------------
// onTerminal — exactly once, both terminal paths
// ---------------------------------------------------------------------------

test("onTerminal fires exactly once when restarts are exhausted (unhealthy), never for a restart still under budget", async () => {
  const children = [];
  const spawn = () => {
    const child = fakeChild(9220 + children.length);
    children.push(child);
    return child;
  };
  const setTimeoutFn = (fn) => {
    fn(); // synchronous restart chain
    return children.length;
  };
  const clearTimeoutFn = () => {};
  const terminalCalls = [];

  const handle = superviseProcess({
    key: "onterminal-restart-test",
    command: "/opt/bot/bridge",
    args: [],
    spawn,
    setprivAvailable: false,
    keepWarm: true,
    maxRestarts: 2,
    setTimeoutFn,
    clearTimeoutFn,
    onTerminal: (reason) => terminalCalls.push(reason),
  });

  children[0].emit("exit", 1, null); // restart 1 of 2 -- NOT terminal
  assert.deepEqual(terminalCalls, [], "a restart still under budget is not a terminal transition");
  children[1].emit("exit", 1, null); // restart 2 of 2 -- NOT terminal
  assert.deepEqual(terminalCalls, []);
  children[2].emit("exit", 1, "SIGSEGV"); // restartCount(2) >= maxRestarts(2) -> unhealthy, terminal
  assert.deepEqual(terminalCalls, ["unhealthy"]);
  assert.equal(handle.state, "unhealthy");

  // A caller that got the single onTerminal call must never see a second
  // one even if something later also calls stop() on an already-unhealthy
  // handle.
  await handle.stop();
  assert.deepEqual(terminalCalls, ["unhealthy"], "onTerminal is idempotent — fires at most once per handle");
});

test("onTerminal fires exactly once on an explicit stop() and is idempotent across a double stop()", async () => {
  const spawn = () => fakeChild(9230);
  const terminalCalls = [];
  const handle = superviseProcess({
    key: "onterminal-stop-test",
    command: "/opt/bot/bridge",
    args: [],
    spawn,
    setprivAvailable: false,
    keepWarm: true,
    onTerminal: (reason) => terminalCalls.push(reason),
  });

  await handle.stop();
  assert.deepEqual(terminalCalls, ["stopped"]);
  await handle.stop(); // double-stop — must not double-fire
  assert.deepEqual(terminalCalls, ["stopped"]);
});

test("onTerminal defaults to a no-op and never breaks supervision when it throws", async () => {
  const spawn = () => fakeChild(9240);
  const handle = superviseProcess({
    key: "onterminal-default-test",
    command: "/opt/bot/bridge",
    args: [],
    spawn,
    setprivAvailable: false,
    keepWarm: true,
  });
  await handle.stop(); // must not throw
  assert.equal(handle.state, "stopped");

  const spawn2 = () => fakeChild(9241);
  const handle2 = superviseProcess({
    key: "onterminal-throwing-test",
    command: "/opt/bot/bridge",
    args: [],
    spawn: spawn2,
    setprivAvailable: false,
    keepWarm: true,
    onTerminal: () => {
      throw new Error("a caller's terminal hook must never break supervision");
    },
  });
  await handle2.stop(); // must not throw/propagate the callback's error
  assert.equal(handle2.state, "stopped");
});

// ---------------------------------------------------------------------------
// stop() — kills the process group via a negative pid
// ---------------------------------------------------------------------------

test("stop() SIGTERMs the process group with a negative pid, falling back to a direct child kill", async () => {
  const child = fakeChild(9600);
  let childKilled = false;
  child.kill = (signal) => {
    childKilled = true;
    setImmediate(() => child.emit("exit", 0, signal));
  };
  const spawn = () => child;

  const originalKill = process.kill;
  const killCalls = [];
  process.kill = (pid, signal) => {
    killCalls.push({ pid, signal });
    // Simulate "no such process group" — the real code's catch-and-fallback
    // path is exercised exactly like it would be if the pgroup were already
    // gone, without depending on any real OS process existing.
    throw new Error("ESRCH: no such process (test stub)");
  };

  try {
    const handle = superviseProcess({
      key: "stop-pgroup-test",
      command: "/opt/bot/bridge",
      args: [],
      spawn,
      setprivAvailable: false,
      keepWarm: true,
    });
    await handle.stop();
    assert.deepEqual(killCalls, [{ pid: -9600, signal: "SIGTERM" }]);
    assert.equal(childKilled, true, "falls back to child.kill() when the pgroup kill throws");
    assert.equal(handle.state, "stopped");
    assert.equal(handle.live, false);
  } finally {
    process.kill = originalKill;
  }
});

// ---------------------------------------------------------------------------
// registry — gains/loses the handle; distinct registries never collide
// ---------------------------------------------------------------------------

test("registry gains the handle on start and loses it once stopped", async () => {
  const spawn = () => fakeChild(9700);
  const registry = new Map();
  const handle = superviseProcess({
    key: "registry-test",
    command: "/opt/bot/bridge",
    args: [],
    spawn,
    setprivAvailable: false,
    keepWarm: true,
    registry,
  });
  assert.equal(registry.get("registry-test"), handle);
  await handle.stop();
  assert.equal(registry.has("registry-test"), false);
});

test("two supervisors with distinct registries and the same key don't collide", async () => {
  const registryA = new Map();
  const registryB = new Map();
  const handleA = superviseProcess({
    key: "shared-key",
    command: "/opt/bot/bridge-a",
    args: [],
    spawn: () => fakeChild(9800),
    setprivAvailable: false,
    keepWarm: true,
    registry: registryA,
  });
  const handleB = superviseProcess({
    key: "shared-key",
    command: "/opt/bot/bridge-b",
    args: [],
    spawn: () => fakeChild(9801),
    setprivAvailable: false,
    keepWarm: true,
    registry: registryB,
  });

  assert.equal(registryA.get("shared-key"), handleA);
  assert.equal(registryB.get("shared-key"), handleB);

  await handleA.stop();
  assert.equal(registryA.has("shared-key"), false);
  // Stopping A must never touch B's registry.
  assert.equal(registryB.get("shared-key"), handleB);

  await handleB.stop();
  assert.equal(registryB.has("shared-key"), false);
});

test("registry defaults to untracked (null) — no error when omitted", async () => {
  const spawn = () => fakeChild(9900);
  const handle = superviseProcess({
    key: "untracked-test",
    command: "/opt/bot/bridge",
    args: [],
    spawn,
    setprivAvailable: false,
    keepWarm: true,
  });
  assert.equal(handle.live, true);
  await handle.stop(); // must not throw despite no registry
  assert.equal(handle.state, "stopped");
});

// ---------------------------------------------------------------------------
// idle timer
// ---------------------------------------------------------------------------

test("idleMinutes: 0 never arms an idle timer (the bot-runtime default case)", async () => {
  const timerCalls = [];
  const setTimeoutFn = (fn, ms) => {
    timerCalls.push({ fn, ms });
    return timerCalls.length;
  };
  const spawn = () => fakeChild(10000);

  const handle = superviseProcess({
    key: "idle-zero-test",
    command: "/opt/bot/bridge",
    args: [],
    spawn,
    setprivAvailable: false,
    idleMinutes: 0,
    setTimeoutFn,
    clearTimeoutFn: () => {},
  });

  assert.equal(timerCalls.length, 0); // never scheduled
  await handle.stop();
});

test("idle timer stops the process after the configured idle period", async () => {
  const timerCalls = [];
  const setTimeoutFn = (fn, ms) => {
    const id = timerCalls.length;
    timerCalls.push({ fn, ms });
    return id;
  };
  const clearTimeoutFn = () => {};
  let killed = false;
  const spawn = () => {
    const child = fakeChild(10100);
    child.kill = () => {
      killed = true;
      setImmediate(() => child.emit("exit", 0, "SIGTERM"));
    };
    return child;
  };

  const handle = superviseProcess({
    key: "idle-timer-test",
    command: "/opt/bot/bridge",
    args: [],
    spawn,
    setprivAvailable: false,
    idleMinutes: 30,
    setTimeoutFn,
    clearTimeoutFn,
  });

  assert.equal(timerCalls.length, 1);
  assert.equal(timerCalls[0].ms, 30 * 60 * 1000);
  assert.equal(handle.live, true);

  await timerCalls[0].fn(); // simulate the idle period elapsing

  assert.equal(killed, true);
  assert.equal(handle.state, "stopped");
  assert.equal(handle.live, false);
});

test("keepWarm disables the idle timer entirely even with a positive idleMinutes", async () => {
  const timerCalls = [];
  const setTimeoutFn = (fn, ms) => {
    timerCalls.push({ fn, ms });
    return timerCalls.length;
  };
  const spawn = () => fakeChild(10200);

  const handle = superviseProcess({
    key: "keepwarm-test",
    command: "/opt/bot/bridge",
    args: [],
    spawn,
    setprivAvailable: false,
    keepWarm: true,
    idleMinutes: 30,
    setTimeoutFn,
    clearTimeoutFn: () => {},
  });

  assert.equal(timerCalls.length, 0); // never scheduled
  await handle.stop();
});

test("alwaysResident also disables the idle timer", async () => {
  const timerCalls = [];
  const setTimeoutFn = (fn, ms) => {
    timerCalls.push({ fn, ms });
    return timerCalls.length;
  };
  const spawn = () => fakeChild(10300);

  const handle = superviseProcess({
    key: "alwaysresident-test",
    command: "/opt/bot/bridge",
    args: [],
    spawn,
    setprivAvailable: false,
    alwaysResident: true,
    idleMinutes: 30,
    setTimeoutFn,
    clearTimeoutFn: () => {},
  });

  assert.equal(timerCalls.length, 0);
  await handle.stop();
});

// ---------------------------------------------------------------------------
// status() / touch() / stopSupervised()
// ---------------------------------------------------------------------------

test("status() reports the generic shape: key, state, live, restartCount, lastError, startedAt, pid", async () => {
  const spawn = () => fakeChild(10400);
  const handle = superviseProcess({
    key: "status-test",
    command: "/opt/bot/bridge",
    args: [],
    spawn,
    setprivAvailable: false,
    keepWarm: true,
  });
  const snap = handle.status();
  assert.equal(snap.key, "status-test");
  assert.equal(snap.state, "running");
  assert.equal(snap.live, true);
  assert.equal(snap.restartCount, 0);
  assert.equal(snap.lastError, null);
  assert.equal(typeof snap.startedAt, "string");
  assert.equal(snap.pid, 10400);
  await handle.stop();
});

test("touch() resets the idle timer", async () => {
  const timerCalls = [];
  let nextId = 1;
  const clearedIds = [];
  const setTimeoutFn = (fn, ms) => {
    const id = nextId++;
    timerCalls.push({ id, fn, ms });
    return id;
  };
  const clearTimeoutFn = (id) => clearedIds.push(id);
  const spawn = () => fakeChild(10500);

  const handle = superviseProcess({
    key: "touch-test",
    command: "/opt/bot/bridge",
    args: [],
    spawn,
    setprivAvailable: false,
    idleMinutes: 30,
    setTimeoutFn,
    clearTimeoutFn,
  });

  assert.equal(timerCalls.length, 1);
  handle.touch();
  assert.equal(timerCalls.length, 2, "touch() reschedules the idle timer");
  assert.deepEqual(clearedIds, [1], "touch() clears the previous timer first");
});

test("stopSupervised(handle) is equivalent to handle.stop()", async () => {
  const spawn = () => fakeChild(10600);
  const handle = superviseProcess({
    key: "stopsupervised-test",
    command: "/opt/bot/bridge",
    args: [],
    spawn,
    setprivAvailable: false,
    keepWarm: true,
  });
  await stopSupervised(handle);
  assert.equal(handle.state, "stopped");
  assert.equal(handle.live, false);
});
