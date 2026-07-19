/**
 * Tests for servers/gateway/models/runtime.js + native-lock.js — llama.cpp
 * binary asset management and llama-server child supervision (Item G,
 * Task 8).
 *
 * No real llama-server binary is ever spawned and no real network traffic
 * ever leaves this process: `identityProbe` is exercised against the
 * in-process stub server fixture (`tests/fixtures/stub-llama-server.mjs`);
 * `startModel`'s supervision logic is exercised against a fake `spawn`
 * that returns a plain `EventEmitter` standing in for a `ChildProcess`;
 * `ensureRuntime`'s download step is exercised against a local
 * node:http fixture server (same technique `tests/models-manager.test.js`
 * uses for its huggingface.co allowlist tests: a real hostname in the URL
 * + an injected DNS `lookup` forced to 127.0.0.1), with the actual system
 * `tar` binary doing real extraction of a real (test-fabricated) tarball —
 * so the checksum-before-chmod ordering guarantee is proven end to end,
 * not just asserted against a mock.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  createWriteStream as fsWriteStream,
  utimesSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  RuntimeAssetError,
  RuntimeChecksumError,
  RuntimeDownloadTimeoutError,
  RuntimeHostNotAllowedError,
  resolveAsset,
  isAllowedRuntimeHost,
  buildRuntimeDownloadUrl,
  ensureRuntime,
  downloadRuntimeAsset,
  buildLlamaServerArgs,
  startModel,
  stopModel,
  identityProbe,
  probeSetprivAvailable,
  __resetSetprivProbeCacheForTest,
  getStatusSnapshot,
  sweepStaleRuntimeTmp,
  STALE_RUNTIME_TMP_MAX_AGE_MS,
  collectLddOutput,
} from "../servers/gateway/models/runtime.js";
import { acquireHostLock, lockPathFor, stealStaleLock } from "../servers/gateway/models/native-lock.js";
import { startStubLlamaServer } from "./fixtures/stub-llama-server.mjs";

function scratchDir(tag) {
  return mkdtempSync(join(tmpdir(), `models-runtime-${tag}-`));
}

function withScratch(tag, fn) {
  const dir = scratchDir(tag);
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => rmSync(dir, { recursive: true, force: true }));
}

// ---------------------------------------------------------------------------
// identityProbe
// ---------------------------------------------------------------------------

test("identity probe reports resident when the served id matches the alias", async () => {
  const stub = await startStubLlamaServer({ modelId: "qwen3-4b" });
  try {
    const result = await identityProbe(stub.baseUrl, "qwen3-4b", fetch);
    assert.equal(result, "resident");
  } finally {
    await stub.close();
  }
});

test("identity probe rejects a live server whose served id != alias", async () => {
  const stub = await startStubLlamaServer({ modelId: "some-other-model" });
  try {
    const result = await identityProbe(stub.baseUrl, "qwen3-4b", fetch);
    assert.equal(result, "conflict");
    assert.notEqual(result, "resident");
  } finally {
    await stub.close();
  }
});

test("identity probe reports down when nothing is listening", async () => {
  // Grab a real ephemeral port, close the listener immediately so nothing
  // is bound there, then probe it — a real connection-refused, not a mock.
  const stub = await startStubLlamaServer({ modelId: "x" });
  const deadPort = stub.port;
  await stub.close();
  const result = await identityProbe(`http://127.0.0.1:${deadPort}`, "qwen3-4b", fetch);
  assert.equal(result, "down");
});

test("identity probe reports down on malformed JSON from a live server", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("not json");
  });
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const port = server.address().port;
  try {
    const result = await identityProbe(`http://127.0.0.1:${port}`, "qwen3-4b", fetch);
    assert.equal(result, "down");
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// ---------------------------------------------------------------------------
// startModel — args, process group
// ---------------------------------------------------------------------------

function fakeChild(pid) {
  const ee = new EventEmitter();
  ee.pid = pid;
  ee.kill = () => {
    setImmediate(() => ee.emit("exit", 0, "SIGTERM"));
  };
  return ee;
}

test("startModel passes --alias/--port/--host args and spawns detached (own process group)", async () => {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return fakeChild(9001);
  };
  const handle = startModel({
    binPath: "/opt/llamacpp/llama-server",
    ggufPath: "/models/qwen3-4b.gguf",
    alias: "qwen3-4b",
    port: 18100,
    spawn,
    setprivAvailable: false,
    keepWarm: true, // no idle timer noise for this test
  });
  try {
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, "/opt/llamacpp/llama-server");
    const args = calls[0].args;
    assert.ok(args.includes("--alias"));
    assert.equal(args[args.indexOf("--alias") + 1], "qwen3-4b");
    assert.ok(args.includes("--port"));
    assert.equal(args[args.indexOf("--port") + 1], "18100");
    assert.ok(args.includes("--host"));
    assert.equal(args[args.indexOf("--host") + 1], "127.0.0.1");
    assert.equal(calls[0].opts.detached, true);
    assert.equal(handle.live, true);
    assert.equal(handle.state, "running");
  } finally {
    await handle.stop();
  }
});

test("startModel wraps the command in setpriv --pdeathsig=SIGTERM when available", async () => {
  const calls = [];
  const spawn = (cmd, args) => {
    calls.push({ cmd, args });
    return fakeChild(9002);
  };
  const handle = startModel({
    binPath: "/opt/llamacpp/llama-server",
    ggufPath: "/models/qwen3-4b.gguf",
    alias: "qwen3-4b-setpriv",
    port: 18101,
    spawn,
    setprivAvailable: true,
    keepWarm: true,
  });
  try {
    assert.equal(calls[0].cmd, "setpriv");
    assert.deepEqual(calls[0].args.slice(0, 2), ["--pdeathsig=SIGTERM", "/opt/llamacpp/llama-server"]);
    assert.ok(calls[0].args.includes("--alias"));
  } finally {
    await handle.stop();
  }
});

test("buildLlamaServerArgs includes model, alias, port, host", () => {
  const args = buildLlamaServerArgs({ ggufPath: "/m/x.gguf", alias: "x", port: 18150, host: "127.0.0.1" });
  assert.deepEqual(args, ["--model", "/m/x.gguf", "--alias", "x", "--port", "18150", "--host", "127.0.0.1"]);
});

// ---------------------------------------------------------------------------
// startModel — restart with backoff, gives up at maxRestarts
// ---------------------------------------------------------------------------

test("startModel restarts with backoff up to maxRestarts, then goes unhealthy with lastError", async () => {
  const children = [];
  const spawn = () => {
    const child = fakeChild(9100 + children.length);
    children.push(child);
    return child;
  };
  // Synchronous "timer": fires the callback immediately so the restart
  // chain plays out deterministically within this test, no real clock.
  const timeoutCalls = [];
  const setTimeoutFn = (fn, ms) => {
    timeoutCalls.push(ms);
    fn();
    return timeoutCalls.length;
  };
  const clearTimeoutFn = () => {};

  const handle = startModel({
    binPath: "/opt/llamacpp/llama-server",
    ggufPath: "/models/x.gguf",
    alias: "restart-test-model",
    port: 18102,
    spawn,
    setprivAvailable: false,
    keepWarm: true, // isolate from idle-timer scheduling entirely
    maxRestarts: 3,
    setTimeoutFn,
    clearTimeoutFn,
  });

  assert.equal(children.length, 1);
  children[0].emit("exit", 1, null);
  // The injected setTimeoutFn fires its callback synchronously, so by the
  // time `emit` returns, the restart chain has already respawned once and
  // `state` is back to "running" (not left at the intermediate
  // "restarting" value — there's no async gap to observe it in).
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
// startModel — idle timer
// ---------------------------------------------------------------------------

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
    const child = fakeChild(9200);
    child.kill = () => {
      killed = true;
      setImmediate(() => child.emit("exit", 0, "SIGTERM"));
    };
    return child;
  };

  const handle = startModel({
    binPath: "/opt/llamacpp/llama-server",
    ggufPath: "/models/x.gguf",
    alias: "idle-test-model",
    port: 18103,
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

test("keepWarm disables the idle timer entirely", async () => {
  const timerCalls = [];
  const setTimeoutFn = (fn, ms) => {
    timerCalls.push({ fn, ms });
    return timerCalls.length;
  };
  const spawn = () => fakeChild(9300);

  const handle = startModel({
    binPath: "/opt/llamacpp/llama-server",
    ggufPath: "/models/x.gguf",
    alias: "keepwarm-test-model",
    port: 18104,
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
  const spawn = () => fakeChild(9301);

  const handle = startModel({
    binPath: "/opt/llamacpp/llama-server",
    ggufPath: "/models/x.gguf",
    alias: "alwaysresident-test-model",
    port: 18105,
    spawn,
    setprivAvailable: false,
    alwaysResident: true,
    setTimeoutFn,
    clearTimeoutFn: () => {},
  });

  assert.equal(timerCalls.length, 0);
  await handle.stop();
});

// ---------------------------------------------------------------------------
// startModel — onTerminal (Task 9 review round 1: gpu-orchestrator's native
// host lock is released exactly when this fires, so it must fire exactly
// once per terminal transition and NEVER for a restart that still has
// budget left)
// ---------------------------------------------------------------------------

test("onTerminal fires exactly once when the idle timer stops the process", async () => {
  const timerCalls = [];
  const setTimeoutFn = (fn, ms) => {
    timerCalls.push({ fn, ms });
    return timerCalls.length;
  };
  const clearTimeoutFn = () => {};
  const spawn = () => fakeChild(9210);
  const terminalCalls = [];

  const handle = startModel({
    binPath: "/opt/llamacpp/llama-server",
    ggufPath: "/models/x.gguf",
    alias: "onterminal-idle-model",
    port: 18113,
    spawn,
    setprivAvailable: false,
    idleMinutes: 30,
    setTimeoutFn,
    clearTimeoutFn,
    onTerminal: (reason) => terminalCalls.push(reason),
  });

  assert.deepEqual(terminalCalls, [], "not terminal while running");
  await timerCalls[0].fn(); // simulate the idle period elapsing -> handle.stop()
  assert.deepEqual(terminalCalls, ["stopped"]);
  assert.equal(handle.state, "stopped");
});

test("onTerminal fires exactly once when restarts are exhausted (unhealthy), never for a restart still under budget", async () => {
  const children = [];
  const spawn = () => {
    const child = fakeChild(9220 + children.length);
    children.push(child);
    return child;
  };
  const setTimeoutFn = (fn) => {
    fn(); // synchronous restart chain, mirrors the existing backoff test
    return children.length;
  };
  const clearTimeoutFn = () => {};
  const terminalCalls = [];

  const handle = startModel({
    binPath: "/opt/llamacpp/llama-server",
    ggufPath: "/models/x.gguf",
    alias: "onterminal-restart-model",
    port: 18114,
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

  // A caller (like gpu-orchestrator's release()) that got the single
  // onTerminal call must never see a second one even if something later
  // also calls stop() on an already-unhealthy handle.
  await handle.stop();
  assert.deepEqual(terminalCalls, ["unhealthy"], "onTerminal is idempotent — fires at most once per handle");
});

test("onTerminal fires exactly once on an explicit stop() and is idempotent across a double stop()", async () => {
  const spawn = () => fakeChild(9230);
  const terminalCalls = [];
  const handle = startModel({
    binPath: "/opt/llamacpp/llama-server",
    ggufPath: "/models/x.gguf",
    alias: "onterminal-stop-model",
    port: 18115,
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
  // No onTerminal passed at all — default must be a safe no-op.
  const handle = startModel({
    binPath: "/opt/llamacpp/llama-server",
    ggufPath: "/models/x.gguf",
    alias: "onterminal-default-model",
    port: 18116,
    spawn,
    setprivAvailable: false,
    keepWarm: true,
  });
  await handle.stop(); // must not throw
  assert.equal(handle.state, "stopped");

  const spawn2 = () => fakeChild(9241);
  const handle2 = startModel({
    binPath: "/opt/llamacpp/llama-server",
    ggufPath: "/models/x.gguf",
    alias: "onterminal-throwing-model",
    port: 18117,
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

test("getStatusSnapshot reports every tracked model and drops it once stopped", async () => {
  const spawn = () => fakeChild(9400);
  const handle = startModel({
    binPath: "/opt/llamacpp/llama-server",
    ggufPath: "/models/x.gguf",
    alias: "snapshot-test-model",
    port: 18106,
    spawn,
    setprivAvailable: false,
    keepWarm: true,
  });
  const before = getStatusSnapshot();
  assert.ok(before.some((s) => s.alias === "snapshot-test-model" && s.live === true));
  await handle.stop();
  const after = getStatusSnapshot();
  assert.ok(!after.some((s) => s.alias === "snapshot-test-model"));
});

test("stopModel(handle) is equivalent to handle.stop()", async () => {
  const spawn = () => fakeChild(9500);
  const handle = startModel({
    binPath: "/opt/llamacpp/llama-server",
    ggufPath: "/models/x.gguf",
    alias: "stopmodel-test-model",
    port: 18107,
    spawn,
    setprivAvailable: false,
    keepWarm: true,
  });
  await stopModel(handle);
  assert.equal(handle.state, "stopped");
  assert.equal(handle.live, false);
});

// ---------------------------------------------------------------------------
// probeSetprivAvailable
// ---------------------------------------------------------------------------

test("probeSetprivAvailable returns true when the probe command succeeds", () => {
  const result = probeSetprivAvailable({ force: true, execFileSyncImpl: () => "" });
  assert.equal(result, true);
  __resetSetprivProbeCacheForTest();
});

test("probeSetprivAvailable returns false when the probe command throws", () => {
  const result = probeSetprivAvailable({
    force: true,
    execFileSyncImpl: () => {
      throw new Error("not found");
    },
  });
  assert.equal(result, false);
  __resetSetprivProbeCacheForTest();
});

test("probeSetprivAvailable caches after the first real call", () => {
  __resetSetprivProbeCacheForTest();
  let calls = 0;
  const impl = () => {
    calls += 1;
    return "";
  };
  probeSetprivAvailable({ execFileSyncImpl: impl });
  probeSetprivAvailable({ execFileSyncImpl: impl });
  assert.equal(calls, 1);
  __resetSetprivProbeCacheForTest();
});

// ---------------------------------------------------------------------------
// native-lock.js
// ---------------------------------------------------------------------------

test("acquireHostLock: second acquire in-process returns null while first is held; released -> acquirable", async () => {
  await withScratch("lock-conflict", (dir) => {
    const release1 = acquireHostLock("local-llm", { runtimeDir: dir });
    assert.ok(typeof release1 === "function");
    assert.ok(existsSync(lockPathFor("local-llm", { runtimeDir: dir })));

    const release2 = acquireHostLock("local-llm", { runtimeDir: dir });
    assert.equal(release2, null); // held elsewhere (this same process, but a live pid)

    release1();
    assert.ok(!existsSync(lockPathFor("local-llm", { runtimeDir: dir })));

    const release3 = acquireHostLock("local-llm", { runtimeDir: dir });
    assert.ok(typeof release3 === "function");
    release3();
  });
});

test("acquireHostLock: different mutex groups don't contend", async () => {
  await withScratch("lock-groups", (dir) => {
    const releaseA = acquireHostLock("group-a", { runtimeDir: dir });
    const releaseB = acquireHostLock("group-b", { runtimeDir: dir });
    assert.ok(releaseA);
    assert.ok(releaseB);
    releaseA();
    releaseB();
  });
});

test("acquireHostLock: steals a stale lock left by a dead owner pid", async () => {
  await withScratch("lock-stale", (dir) => {
    const deadPid = 999999; // never released
    const releaseDead = acquireHostLock("local-llm", {
      runtimeDir: dir,
      pid: deadPid,
      isProcessAlive: () => true, // pretend it's alive at acquire time
    });
    assert.ok(releaseDead); // acquired, but deliberately never called (simulates a crash)

    // A fresh acquirer now sees the pid as dead and should steal the lock.
    const releaseLive = acquireHostLock("local-llm", {
      runtimeDir: dir,
      pid: process.pid,
      isProcessAlive: (pid) => pid !== deadPid,
    });
    assert.ok(typeof releaseLive === "function");
    releaseLive();
  });
});

test("acquireHostLock: does NOT steal a lock whose owner is confirmed alive", async () => {
  await withScratch("lock-alive", (dir) => {
    const ownerPid = 424242;
    const release1 = acquireHostLock("local-llm", {
      runtimeDir: dir,
      pid: ownerPid,
      isProcessAlive: () => true,
    });
    assert.ok(release1);

    const release2 = acquireHostLock("local-llm", {
      runtimeDir: dir,
      pid: process.pid,
      isProcessAlive: (pid) => pid === ownerPid,
    });
    assert.equal(release2, null);
    release1();
  });
});

test("acquireHostLock: corrupt lock content is treated as stale and stolen", async () => {
  await withScratch("lock-corrupt", (dir) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(lockPathFor("local-llm", { runtimeDir: dir }), "not-a-pid", "utf8");
    const release = acquireHostLock("local-llm", { runtimeDir: dir, isProcessAlive: () => true });
    assert.ok(typeof release === "function");
    release();
  });
});

test("native-lock: rename-atomic steal never clobbers a winner's fresh lock (dual-steal TOCTOU regression)", async () => {
  // Reproduces the exact race a reviewer caught against an earlier
  // (unlink-based) version of stealStaleLock: two racers, A and B, both
  // read the SAME stale lock. A completes its whole steal-and-create
  // cycle first. B — simulated here at the moment it decided to steal,
  // holding the pid it read BEFORE A acted — only gets around to its own
  // steal attempt afterward, when the file at lockPath is no longer the
  // original stale one but A's brand-new live lock. B must detect that
  // mismatch and back off rather than destroy A's lock.
  await withScratch("lock-toctou", async (dir) => {
    const lockPath = lockPathFor("local-llm", { runtimeDir: dir });
    const deadPid = 888888;
    const winnerPid = 777777;

    mkdirSync(dir, { recursive: true });
    writeFileSync(lockPath, String(deadPid), "utf8"); // the original stale lock both racers see

    // Racer A ("the winner") runs a complete acquire through the public
    // API — read stale pid -> rename-steal -> discard -> fresh create.
    const releaseWinner = acquireHostLock("local-llm", {
      runtimeDir: dir,
      pid: winnerPid,
      isProcessAlive: (p) => p !== deadPid,
    });
    assert.ok(typeof releaseWinner === "function");
    assert.equal(readFileSync(lockPath, "utf8"), String(winnerPid));

    // Racer B ("the loser") is simulated at the exact point it decided to
    // steal: it captured `existingPid: deadPid` before A did anything,
    // and is only now attempting the rename. This specific interleaving
    // can't be forced through the public `acquireHostLock` entry point
    // alone (a real re-read there always reflects current disk state),
    // so this calls the exported primitive directly with the STALE belief
    // B actually held at decision time.
    stealStaleLock({
      fs: { renameSync, readFileSync, unlinkSync },
      lockPath,
      existingPid: deadPid,
    });

    // A's fresh, live lock must be completely intact — the mismatch
    // (staged content is winnerPid, not the deadPid B was expecting) must
    // have been detected and the file put back, never discarded.
    assert.equal(readFileSync(lockPath, "utf8"), String(winnerPid));

    // And B, now going through the normal acquireHostLock path, correctly
    // sees the winner's lock as live and gets null back — it does NOT
    // end up holding a lock while the winner's lock is present.
    const releaseLoser = acquireHostLock("local-llm", {
      runtimeDir: dir,
      pid: 555555,
      isProcessAlive: (p) => p === winnerPid,
    });
    assert.equal(releaseLoser, null);

    releaseWinner();
  });
});

test("stealStaleLock: a rename that finds nothing at lockPath (already claimed) is a silent no-op", async () => {
  await withScratch("lock-steal-noop", async (dir) => {
    const lockPath = lockPathFor("local-llm", { runtimeDir: dir });
    // Nothing exists at lockPath at all — represents the case where a
    // different racer's rename already won AND that racer had also
    // already finished discarding (or the lock was legitimately released
    // in between). Must not throw, must not create anything.
    assert.doesNotThrow(() => stealStaleLock({
      fs: { renameSync, readFileSync, unlinkSync },
      lockPath,
      existingPid: 123,
    }));
    assert.equal(existsSync(lockPath), false);
  });
});

// ---------------------------------------------------------------------------
// resolveAsset
// ---------------------------------------------------------------------------

function makeRuntimeBlock(overrides = {}) {
  return {
    name: "llama.cpp",
    release: "b10068",
    assets: {
      "linux-x64-vulkan": { file: "llama-vulkan.tar.gz", sha256: "vk-sha", min_glibc: "2.34" },
      "linux-x64-cpu": { file: "llama-cpu.tar.gz", sha256: "cpu-sha", min_glibc: "2.34" },
      "darwin-arm64": { file: "llama-arm64.tar.gz", sha256: "arm-sha" },
      "darwin-x64": { file: "llama-x64.tar.gz", sha256: "x64-sha" },
    },
    ...overrides,
  };
}

test("resolveAsset: WSL2 probe forces the cpu asset even when accel says cuda", () => {
  const probe = { platform: "linux", wsl2: true, accel: "cuda", ramAvailableMb: 16000 };
  const result = resolveAsset(probe, makeRuntimeBlock(), { lddOutput: "ldd (Ubuntu GLIBC 2.35-0ubuntu3) 2.35" });
  assert.equal(result.error, undefined);
  assert.equal(result.key, "linux-x64-cpu");
});

test("resolveAsset: unknown platform returns a typed error, never a guess", () => {
  const probe = { platform: "windows" };
  const result = resolveAsset(probe, makeRuntimeBlock());
  assert.ok(result.error instanceof RuntimeAssetError);
  assert.equal(result.error.code, "UNSUPPORTED_PLATFORM");
  assert.equal(result.key, undefined);
});

test("resolveAsset: darwin picks arm64 vs x64 by injected arch", () => {
  const probe = { platform: "darwin", accel: "metal" };
  const arm = resolveAsset(probe, makeRuntimeBlock(), { arch: "arm64" });
  assert.equal(arm.key, "darwin-arm64");
  const x64 = resolveAsset(probe, makeRuntimeBlock(), { arch: "x64" });
  assert.equal(x64.key, "darwin-x64");
});

test("resolveAsset: unsupported darwin arch returns a typed error", () => {
  const probe = { platform: "darwin", accel: "metal" };
  const result = resolveAsset(probe, makeRuntimeBlock(), { arch: "ppc64" });
  assert.ok(result.error instanceof RuntimeAssetError);
  assert.equal(result.error.code, "UNSUPPORTED_PLATFORM");
});

test("resolveAsset: glibc too old for vulkan falls back to the cpu asset when cpu's requirement is met", () => {
  const runtimeBlock = makeRuntimeBlock({
    assets: {
      "linux-x64-vulkan": { file: "llama-vulkan.tar.gz", sha256: "vk-sha", min_glibc: "2.34" },
      "linux-x64-cpu": { file: "llama-cpu.tar.gz", sha256: "cpu-sha", min_glibc: "2.17" },
    },
  });
  const probe = { platform: "linux", wsl2: false, accel: "vulkan" };
  const result = resolveAsset(probe, runtimeBlock, { lddOutput: "ldd (GNU libc) 2.17" });
  assert.equal(result.error, undefined);
  assert.equal(result.key, "linux-x64-cpu");
});

test("resolveAsset: glibc too old for every asset returns an honest typed error, not a guess", () => {
  const runtimeBlock = makeRuntimeBlock({
    assets: {
      "linux-x64-vulkan": { file: "llama-vulkan.tar.gz", sha256: "vk-sha", min_glibc: "2.34" },
      "linux-x64-cpu": { file: "llama-cpu.tar.gz", sha256: "cpu-sha", min_glibc: "2.34" },
    },
  });
  const probe = { platform: "linux", wsl2: false, accel: "vulkan" };
  const result = resolveAsset(probe, runtimeBlock, { lddOutput: "ldd (GNU libc) 2.17" });
  assert.ok(result.error instanceof RuntimeAssetError);
  assert.equal(result.error.code, "GLIBC_TOO_OLD");
  assert.equal(result.key, undefined);
});

test("resolveAsset: undetectable glibc (no ldd output) is treated as unmet, not assumed fine", () => {
  const probe = { platform: "linux", wsl2: false, accel: "vulkan" };
  const result = resolveAsset(probe, makeRuntimeBlock(), { lddOutput: null });
  // Both assets in makeRuntimeBlock() require 2.34; undetectable can't
  // confirm either, so this must be the honest error, never a resident guess.
  assert.ok(result.error instanceof RuntimeAssetError);
  assert.equal(result.error.code, "GLIBC_TOO_OLD");
});

test("resolveAsset: no catalog entry for the resolved key is a typed NO_ASSET error", () => {
  const runtimeBlock = makeRuntimeBlock({ assets: { "linux-x64-vulkan": { file: "v.tar.gz", sha256: "s", min_glibc: "2.34" } } });
  const probe = { platform: "linux", wsl2: false, accel: "cpu" };
  const result = resolveAsset(probe, runtimeBlock, {});
  assert.ok(result.error instanceof RuntimeAssetError);
  assert.equal(result.error.code, "NO_ASSET");
});

test("resolveAsset: cpu accel goes straight to the cpu asset (no vulkan attempt)", () => {
  const probe = { platform: "linux", wsl2: false, accel: "cpu" };
  const result = resolveAsset(probe, makeRuntimeBlock(), { lddOutput: "ldd (GNU libc) 2.35" });
  assert.equal(result.key, "linux-x64-cpu");
});

test("resolveAsset: vulkan accel with sufficient glibc picks the vulkan asset", () => {
  const probe = { platform: "linux", wsl2: false, accel: "vulkan" };
  const result = resolveAsset(probe, makeRuntimeBlock(), { lddOutput: "ldd (GNU libc) 2.35" });
  assert.equal(result.key, "linux-x64-vulkan");
});

// ---------------------------------------------------------------------------
// isAllowedRuntimeHost / buildRuntimeDownloadUrl
// ---------------------------------------------------------------------------

test("isAllowedRuntimeHost allows exactly github.com, objects.githubusercontent.com, and release-assets.githubusercontent.com", () => {
  assert.equal(isAllowedRuntimeHost("github.com"), true);
  assert.equal(isAllowedRuntimeHost("objects.githubusercontent.com"), true);
  // Item G, PR G-F follow-up: GitHub's release-asset redirect target
  // observed live as of 2026-07-19 (confirmed via `curl -sIL` against a
  // real release URL) — objects.githubusercontent.com is kept alongside
  // it since there's no signal it's fully retired.
  assert.equal(isAllowedRuntimeHost("release-assets.githubusercontent.com"), true);
  assert.equal(isAllowedRuntimeHost("evilgithub.com"), false);
  assert.equal(isAllowedRuntimeHost("huggingface.co"), false);
  assert.equal(isAllowedRuntimeHost(""), false);
  assert.equal(isAllowedRuntimeHost(undefined), false);
});

test("buildRuntimeDownloadUrl builds a releases/download URL", () => {
  const url = buildRuntimeDownloadUrl("b10068", "llama-b10068-bin-ubuntu-x64.tar.gz");
  assert.equal(url, "https://github.com/ggml-org/llama.cpp/releases/download/b10068/llama-b10068-bin-ubuntu-x64.tar.gz");
});

// ---------------------------------------------------------------------------
// Shared fixtures for downloadRuntimeAsset / ensureRuntime tests below
// ---------------------------------------------------------------------------

function startFixtureServer(handler) {
  return new Promise((resolvePromise, reject) => {
    const srv = http.createServer(handler);
    srv.listen(0, "127.0.0.1", () => resolvePromise({ srv, port: srv.address().port }));
    srv.on("error", reject);
  });
}

/** Forces every hostname to 127.0.0.1 — same technique (and the same
 * both-shapes handling) as `tests/models-manager.test.js`'s
 * `lookupToLocalhost`, needed for Node's happy-eyeballs multi-address
 * connect path (`{ all: true }`) as well as the classic single-address
 * callback shape. */
function forceGithubLookup() {
  return (_hostname, options, callback) => {
    if (options && options.all) {
      callback(null, [{ address: "127.0.0.1", family: 4 }]);
    } else {
      callback(null, "127.0.0.1", 4);
    }
  };
}

/** Fabricate a real gzip tarball (via the system `tar`) containing a
 * single file named `llama-server` with the given content. Returns the
 * archive bytes and its sha256 — a genuine end-to-end fixture, not a
 * hand-rolled fake of tar's format. */
function makeRealTarball(dir) {
  const payloadDir = join(dir, "payload");
  mkdirSync(payloadDir, { recursive: true });
  writeFileSync(join(payloadDir, "llama-server"), "#!/bin/sh\necho fake-llama-server\n");
  const archivePath = join(dir, "llama-runtime.tar.gz");
  execFileSync("tar", ["-czf", archivePath, "-C", payloadDir, "llama-server"]);
  const bytes = readFileSync(archivePath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { bytes, sha256 };
}

// ---------------------------------------------------------------------------
// downloadRuntimeAsset — partial-file cleanup on a mid-stream error
// ---------------------------------------------------------------------------

/** A `createWriteStream` that writes a few real bytes to disk and then
 * asynchronously emits an "error" — simulates a network drop / ENOSPC
 * partway through a download against a REAL partial file on disk, so the
 * cleanup assertion is checking a genuine leftover, not a hypothetical
 * one. */
function createFlakyWriteStream(dest) {
  const real = fsWriteStream(dest);
  let bytesSeen = 0;
  const originalWrite = real.write.bind(real);
  real.write = (chunk, ...rest) => {
    bytesSeen += chunk.length;
    const ok = originalWrite(chunk, ...rest);
    if (bytesSeen > 200 && !real.__failed) {
      real.__failed = true;
      setImmediate(() => real.emit("error", Object.assign(new Error("simulated mid-stream failure"), { code: "EIO" })));
    }
    return ok;
  };
  return real;
}

test("downloadRuntimeAsset deletes the partial file on a mid-stream error", async () => {
  await withScratch("dl-stream-error", async (dir) => {
    const { srv, port } = await startFixtureServer((req, res) => {
      res.writeHead(200, { "content-type": "application/gzip" });
      res.write(Buffer.alloc(2000, 7));
      // Give the flaky write-stream time to raise its injected error
      // before the response ends, so the failure path (not a clean
      // finish) is what actually resolves the download promise.
      setTimeout(() => res.end(), 100);
    });
    const dest = join(dir, "partial-runtime.tar.gz");
    try {
      await assert.rejects(
        () => downloadRuntimeAsset({
          url: `http://github.com:${port}/releases/download/x/y.tar.gz`,
          dest,
          expectedSha: null,
          lookup: forceGithubLookup(),
          insecureHttpHosts: ["github.com"],
          createWriteStream: createFlakyWriteStream,
        }),
        (err) => {
          assert.equal(err.code, "EIO");
          return true;
        },
      );
      assert.equal(existsSync(dest), false); // partial file cleaned up, not left behind
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});

test("downloadRuntimeAsset rejects a stalled connection with RuntimeDownloadTimeoutError instead of hanging forever", async () => {
  await withScratch("dl-stall-timeout", async (dir) => {
    // Accepts the connection but never writes a byte and never ends the
    // response — a genuine stalled-socket simulation (Task 9 review round
    // 1, finding 2b: "no promise may hang forever on a stalled TCP
    // connection").
    const { srv, port } = await startFixtureServer(() => {});
    const dest = join(dir, "stalled-runtime.tar.gz");
    try {
      await assert.rejects(
        () => downloadRuntimeAsset({
          url: `http://github.com:${port}/releases/download/x/y.tar.gz`,
          dest,
          expectedSha: null,
          lookup: forceGithubLookup(),
          insecureHttpHosts: ["github.com"],
          timeoutMs: 50, // tiny for a fast test — production default is 120s
        }),
        (err) => {
          assert.ok(err instanceof RuntimeDownloadTimeoutError, `expected RuntimeDownloadTimeoutError, got ${err}`);
          assert.equal(err.code, "DOWNLOAD_TIMEOUT");
          assert.equal(err.timeoutMs, 50);
          return true;
        },
      );
      assert.equal(existsSync(dest), false, "no partial file — the stall was never past the connect/header phase");
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});

// ---------------------------------------------------------------------------
// downloadRuntimeAsset — redirect-host allowlist (Item G, PR G-F follow-up:
// GitHub's release-asset redirect target observed live as of 2026-07-19 is
// release-assets.githubusercontent.com, not the previously-hardcoded
// objects.githubusercontent.com — confirmed via `curl -sIL` against a real
// release URL. Both hosts are now allowed; every hop is still re-checked
// against the allowlist, so an attacker-controlled redirect to anything
// else is still refused.)
// ---------------------------------------------------------------------------

test("downloadRuntimeAsset follows a real github.com -> release-assets.githubusercontent.com redirect chain", async () => {
  await withScratch("dl-redirect-release-assets", async (dir) => {
    const buildDir = join(dir, "build");
    mkdirSync(buildDir, { recursive: true });
    const { bytes, sha256 } = makeRealTarball(buildDir);

    const { srv, port } = await startFixtureServer((req, res) => {
      if (req.url.startsWith("/releases/download/")) {
        // The first hop, as if it came from github.com — redirects to the
        // OTHER allowed host. forceGithubLookup() resolves every hostname
        // to 127.0.0.1, so this single fixture server plays both hops.
        res.writeHead(302, { location: `http://release-assets.githubusercontent.com:${port}/blob/x?sig=abc` });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/gzip" });
      res.end(bytes);
    });

    const dest = join(dir, "redirected-runtime.tar.gz");
    try {
      await downloadRuntimeAsset({
        url: `http://github.com:${port}/releases/download/x/y.tar.gz`,
        dest,
        expectedSha: sha256,
        lookup: forceGithubLookup(),
        insecureHttpHosts: ["github.com", "release-assets.githubusercontent.com"],
      });
      assert.ok(readFileSync(dest).equals(bytes), "the redirected download landed the real payload, checksum-verified");
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});

test("downloadRuntimeAsset still refuses a redirect to a host outside the runtime allowlist", async () => {
  await withScratch("dl-redirect-refused", async (dir) => {
    const { srv, port } = await startFixtureServer((req, res) => {
      res.writeHead(302, { location: `http://evil-cdn.example.com:${port}/payload` });
      res.end();
    });

    const dest = join(dir, "refused-runtime.tar.gz");
    try {
      await assert.rejects(
        () => downloadRuntimeAsset({
          url: `http://github.com:${port}/releases/download/x/y.tar.gz`,
          dest,
          expectedSha: null,
          lookup: forceGithubLookup(),
          insecureHttpHosts: ["github.com", "evil-cdn.example.com"],
        }),
        (err) => {
          assert.ok(err instanceof RuntimeHostNotAllowedError);
          assert.equal(err.hostname, "evil-cdn.example.com");
          return true;
        },
      );
      assert.equal(existsSync(dest), false, "an unallowed redirect target never gets a partial file written");
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});

// ---------------------------------------------------------------------------
// ensureRuntime — real tar extraction, checksum-before-chmod ordering
// ---------------------------------------------------------------------------

test("ensureRuntime downloads, verifies, extracts (real tar), and chmods only after verification", async () => {
  await withScratch("ensure-happy", async (dir) => {
    const buildDir = join(dir, "build");
    mkdirSync(buildDir, { recursive: true });
    const { bytes, sha256 } = makeRealTarball(buildDir);

    const { srv, port } = await startFixtureServer((req, res) => {
      res.writeHead(200, { "content-type": "application/gzip" });
      res.end(bytes);
    });

    const chmodCalls = [];
    const runtimeBlock = {
      release: "test-rel",
      assets: { "linux-x64-cpu": { file: "llama-runtime.tar.gz", sha256, min_glibc: "2.0" } },
    };
    const probe = { platform: "linux", wsl2: false, accel: "cpu" };

    try {
      const binPath = await ensureRuntime(join(dir, "crow-home"), runtimeBlock, probe, {
        lddOutput: "ldd (GNU libc) 2.35",
        baseUrl: `http://github.com:${port}`,
        insecureHttpHosts: ["github.com"],
        lookup: forceGithubLookup(port),
        chmodFn: (p, mode) => chmodCalls.push({ p, mode }),
      });

      assert.ok(existsSync(binPath));
      // binPath is under the FINAL releaseDir; chmod ran on the file while
      // it was still in the staging extract dir (before the finalize
      // rename), so the two paths differ by design — assert on shape
      // (same basename, correct mode) rather than string equality.
      assert.equal(chmodCalls.length, 1);
      assert.ok(chmodCalls[0].p.endsWith("llama-server"));
      assert.ok(chmodCalls[0].p.includes(".extract-linux-x64-cpu-test-rel.tmp"));
      assert.equal(chmodCalls[0].mode, 0o755);
      assert.equal(readFileSync(binPath, "utf8").includes("fake-llama-server"), true);

      // Finalization is a real rename: no leftover staging dir, no
      // leftover download tmp file, next to the now-populated releaseDir.
      const runtimesDir = join(dir, "crow-home", "runtimes", "llamacpp");
      assert.equal(existsSync(join(runtimesDir, ".extract-linux-x64-cpu-test-rel.tmp")), false);
      assert.equal(existsSync(join(runtimesDir, ".download-linux-x64-cpu-test-rel.tmp")), false);
      assert.equal(existsSync(join(runtimesDir, "test-rel", ".crow-runtime-installed.json")), true);

      // Idempotent: a second call reuses the manifest, no re-download
      // (fixture server would 200 again anyway, but chmod must NOT be
      // called a second time for an already-installed asset).
      const binPath2 = await ensureRuntime(join(dir, "crow-home"), runtimeBlock, probe, {
        lddOutput: "ldd (GNU libc) 2.35",
        baseUrl: `http://github.com:${port}`,
        insecureHttpHosts: ["github.com"],
        lookup: forceGithubLookup(port),
        chmodFn: (p, mode) => chmodCalls.push({ p, mode }),
      });
      assert.equal(binPath2, binPath);
      assert.equal(chmodCalls.length, 1); // unchanged — reused the manifest
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});

test("ensureRuntime never chmods when the downloaded archive fails checksum verification", async () => {
  await withScratch("ensure-checksum-fail", async (dir) => {
    const buildDir = join(dir, "build");
    mkdirSync(buildDir, { recursive: true });
    const { bytes } = makeRealTarball(buildDir);

    const { srv, port } = await startFixtureServer((req, res) => {
      res.writeHead(200, { "content-type": "application/gzip" });
      res.end(bytes);
    });

    const chmodCalls = [];
    const runtimeBlock = {
      release: "test-rel-bad",
      assets: { "linux-x64-cpu": { file: "llama-runtime.tar.gz", sha256: "0000000000000000000000000000000000000000000000000000000000000000", min_glibc: "2.0" } },
    };
    const probe = { platform: "linux", wsl2: false, accel: "cpu" };

    try {
      await assert.rejects(
        () => ensureRuntime(join(dir, "crow-home"), runtimeBlock, probe, {
          lddOutput: "ldd (GNU libc) 2.35",
          baseUrl: `http://github.com:${port}`,
          insecureHttpHosts: ["github.com"],
          lookup: forceGithubLookup(port),
          chmodFn: (p, mode) => chmodCalls.push({ p, mode }),
        }),
        (err) => {
          assert.ok(err instanceof RuntimeChecksumError);
          return true;
        },
      );
      assert.equal(chmodCalls.length, 0); // unverified binary never made executable
      // A checksum failure happens entirely inside downloadRuntimeAsset,
      // before ensureRuntime ever touches the staging extract dir or
      // releaseDir — none of the three should exist.
      const runtimesDir = join(dir, "crow-home", "runtimes", "llamacpp");
      assert.equal(existsSync(join(runtimesDir, ".download-linux-x64-cpu-test-rel-bad.tmp")), false);
      assert.equal(existsSync(join(runtimesDir, ".extract-linux-x64-cpu-test-rel-bad.tmp")), false);
      assert.equal(existsSync(join(runtimesDir, "test-rel-bad")), false);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});

test("ensureRuntime rejects a resolveAsset failure before attempting any download", async () => {
  await withScratch("ensure-bad-platform", async (dir) => {
    const runtimeBlock = makeRuntimeBlock();
    const probe = { platform: "windows" };
    await assert.rejects(
      () => ensureRuntime(dir, runtimeBlock, probe, {}),
      (err) => {
        assert.ok(err instanceof RuntimeAssetError);
        assert.equal(err.code, "UNSUPPORTED_PLATFORM");
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// ensureRuntime — self-collected ldd output (Item G, PR G-F, blocker fix:
// resolveNativeBinPath never passed opts.lddOutput, so every linux host hit
// resolveAsset's fail-closed "undetectable == too old" branch and got
// GLIBC_TOO_OLD unconditionally, even on hosts with a perfectly modern
// glibc — see runtime.js's ensureRuntime doc, "glibc detection" section).
// ---------------------------------------------------------------------------

test("collectLddOutput: runs the injected execFileSyncImpl as `ldd --version`", () => {
  let sawArgs = null;
  const out = collectLddOutput((cmd, args, opts) => {
    sawArgs = [cmd, args, opts];
    return "ldd (GNU libc) 2.35\n";
  });
  assert.equal(out, "ldd (GNU libc) 2.35\n");
  assert.equal(sawArgs[0], "ldd");
  assert.deepEqual(sawArgs[1], ["--version"]);
});

test("ensureRuntime: undefined opts.lddOutput on a linux probe triggers self-collection, and the collected value picks the right asset", async () => {
  await withScratch("ensure-ldd-collect", async (dir) => {
    const buildDir = join(dir, "build");
    mkdirSync(buildDir, { recursive: true });
    const { bytes, sha256 } = makeRealTarball(buildDir);

    const { srv, port } = await startFixtureServer((req, res) => {
      res.writeHead(200, { "content-type": "application/gzip" });
      res.end(bytes);
    });

    // Only a cpu asset in this catalog block — accel:"cpu" below means
    // resolveAsset never even attempts the (absent) vulkan key, so a
    // successful resolve here proves the collected glibc satisfied the
    // cpu asset's own min_glibc gate.
    const runtimeBlock = {
      release: "test-rel-ldd-collect",
      assets: { "linux-x64-cpu": { file: "llama-runtime.tar.gz", sha256, min_glibc: "2.17" } },
    };
    const probe = { platform: "linux", wsl2: false, accel: "cpu" };

    let execCalls = 0;
    let sawArgs = null;

    try {
      const binPath = await ensureRuntime(join(dir, "crow-home"), runtimeBlock, probe, {
        // lddOutput deliberately OMITTED — must be self-collected.
        baseUrl: `http://github.com:${port}`,
        insecureHttpHosts: ["github.com"],
        lookup: forceGithubLookup(port),
        chmodFn: () => {},
        execFileSyncImpl: (cmd, args) => {
          execCalls++;
          sawArgs = [cmd, args];
          return "ldd (GNU libc) 2.35\n";
        },
      });
      assert.ok(existsSync(binPath), "resolved and installed a real asset with no injected lddOutput");
      assert.equal(execCalls, 1, "the ldd collector ran exactly once");
      assert.deepEqual(sawArgs, ["ldd", ["--version"]]);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});

test("ensureRuntime: a failing ldd collection is an honest GLIBC_UNKNOWN error, never the GLIBC_TOO_OLD lie", async () => {
  await withScratch("ensure-ldd-collect-fail", async (dir) => {
    const runtimeBlock = makeRuntimeBlock();
    const probe = { platform: "linux", wsl2: false, accel: "cpu" };
    await assert.rejects(
      () => ensureRuntime(dir, runtimeBlock, probe, {
        execFileSyncImpl: () => {
          throw new Error("spawnSync ldd ENOENT");
        },
      }),
      (err) => {
        assert.ok(err instanceof RuntimeAssetError);
        assert.equal(err.code, "GLIBC_UNKNOWN");
        assert.notEqual(err.code, "GLIBC_TOO_OLD", "couldn't-ask must never be relabeled as asked-and-too-old");
        assert.match(err.message, /ENOENT/);
        return true;
      },
    );
  });
});

test("ensureRuntime: an explicitly injected opts.lddOutput (even undefined-looking falsy values like null) wins outright — the collector never runs", async () => {
  await withScratch("ensure-ldd-injected-wins", async (dir) => {
    const buildDir = join(dir, "build");
    mkdirSync(buildDir, { recursive: true });
    const { bytes, sha256 } = makeRealTarball(buildDir);
    const { srv, port } = await startFixtureServer((req, res) => {
      res.writeHead(200, { "content-type": "application/gzip" });
      res.end(bytes);
    });
    const runtimeBlock = {
      release: "test-rel-ldd-injected",
      assets: { "linux-x64-cpu": { file: "llama-runtime.tar.gz", sha256, min_glibc: "2.17" } },
    };
    const probe = { platform: "linux", wsl2: false, accel: "cpu" };
    let execCalls = 0;
    try {
      const binPath = await ensureRuntime(join(dir, "crow-home"), runtimeBlock, probe, {
        lddOutput: "ldd (GNU libc) 2.35",
        baseUrl: `http://github.com:${port}`,
        insecureHttpHosts: ["github.com"],
        lookup: forceGithubLookup(port),
        chmodFn: () => {},
        execFileSyncImpl: () => {
          execCalls++;
          return "ldd (GNU libc) 2.35";
        },
      });
      assert.ok(existsSync(binPath));
      assert.equal(execCalls, 0, "the collector must never run when lddOutput is explicitly injected");
    } finally {
      await new Promise((r) => srv.close(r));
    }

    // A null lddOutput (resolveAsset's own "explicitly unknown" test case)
    // is still NOT `undefined` — collection must not fire for it either.
    let nullExecCalls = 0;
    await assert.rejects(
      () => ensureRuntime(dir, runtimeBlock, probe, {
        lddOutput: null,
        execFileSyncImpl: () => { nullExecCalls++; return "ldd (GNU libc) 2.35"; },
      }),
      (err) => {
        assert.ok(err instanceof RuntimeAssetError);
        assert.equal(err.code, "GLIBC_TOO_OLD", "null lddOutput still resolves via resolveAsset's own fail-closed path");
        return true;
      },
    );
    assert.equal(nullExecCalls, 0, "an explicit null must not trigger collection either");
  });
});

// ---------------------------------------------------------------------------
// sweepStaleRuntimeTmp (Task 14, PR G-D — stale tmp sweep)
// ---------------------------------------------------------------------------

/** Backdate a path's mtime by `ageMs` from `now` (real fs call — these
 * tests exercise sweepStaleRuntimeTmp's default real-fs binding directly,
 * since it has no test-visible network/process side effects to fake). */
function backdate(path, ageMs, now = Date.now()) {
  const t = (now - ageMs) / 1000;
  utimesSync(path, t, t);
}

test("sweepStaleRuntimeTmp removes an old .extract-*.tmp directory and .download-*.tmp file, leaves fresh ones and non-tmp paths alone", async () => {
  await withScratch("sweep-basic", async (dir) => {
    const runtimesDir = join(dir, "runtimes", "llamacpp");
    mkdirSync(runtimesDir, { recursive: true });

    const now = Date.now();
    const eightDaysMs = 8 * 24 * 60 * 60 * 1000;
    const oneDayMs = 24 * 60 * 60 * 1000;

    // Old staging dir (from a killed extract) — must be removed.
    const oldExtractDir = join(runtimesDir, ".extract-linux-x64-cpu-old-release.tmp");
    mkdirSync(oldExtractDir, { recursive: true });
    writeFileSync(join(oldExtractDir, "partial-file"), "junk");
    backdate(oldExtractDir, eightDaysMs, now);

    // Old download tmp file (from a killed download) — must be removed.
    const oldDownloadFile = join(runtimesDir, ".download-linux-x64-cpu-old-release.tmp");
    writeFileSync(oldDownloadFile, "partial bytes");
    backdate(oldDownloadFile, eightDaysMs, now);

    // Fresh (recent) staging dir — must survive (an install could be
    // mid-flight from a concurrent ensureRuntime call).
    const freshExtractDir = join(runtimesDir, ".extract-linux-x64-cpu-new-release.tmp");
    mkdirSync(freshExtractDir, { recursive: true });
    backdate(freshExtractDir, oneDayMs, now);

    // A completed release dir with a similar-looking but non-matching name
    // must never be touched, regardless of age.
    const releaseDir = join(runtimesDir, "some-release");
    mkdirSync(releaseDir, { recursive: true });
    writeFileSync(join(releaseDir, "llama-server"), "binary");
    backdate(releaseDir, eightDaysMs, now);

    const removed = sweepStaleRuntimeTmp(dir, { now });

    assert.deepEqual(new Set(removed), new Set([oldExtractDir, oldDownloadFile]));
    assert.equal(existsSync(oldExtractDir), false, "old staging dir must be gone");
    assert.equal(existsSync(oldDownloadFile), false, "old download tmp file must be gone");
    assert.equal(existsSync(freshExtractDir), true, "fresh staging dir must survive");
    assert.equal(existsSync(releaseDir), true, "a completed release dir must never be touched");
    assert.equal(existsSync(join(releaseDir, "llama-server")), true);
  });
});

test("sweepStaleRuntimeTmp respects the maxAgeMs boundary (default 7 days)", async () => {
  await withScratch("sweep-boundary", async (dir) => {
    const runtimesDir = join(dir, "runtimes", "llamacpp");
    mkdirSync(runtimesDir, { recursive: true });
    const now = Date.now();

    const justUnder = join(runtimesDir, ".download-x-just-under.tmp");
    writeFileSync(justUnder, "x");
    backdate(justUnder, STALE_RUNTIME_TMP_MAX_AGE_MS - 60_000, now);

    const justOver = join(runtimesDir, ".download-x-just-over.tmp");
    writeFileSync(justOver, "x");
    backdate(justOver, STALE_RUNTIME_TMP_MAX_AGE_MS + 60_000, now);

    const removed = sweepStaleRuntimeTmp(dir, { now });
    assert.deepEqual(removed, [justOver]);
    assert.equal(existsSync(justUnder), true);
    assert.equal(existsSync(justOver), false);
  });
});

test("sweepStaleRuntimeTmp is a no-op when runtimes/llamacpp doesn't exist yet", async () => {
  await withScratch("sweep-missing-dir", async (dir) => {
    assert.equal(existsSync(join(dir, "runtimes")), false);
    const removed = sweepStaleRuntimeTmp(dir);
    assert.deepEqual(removed, []);
  });
});

test("sweepStaleRuntimeTmp never throws on a readdir/stat error (best-effort)", () => {
  const brokenFs = {
    existsSync: () => true,
    readdirSync: () => {
      throw new Error("boom");
    },
    statSync,
    rmSync: () => {},
  };
  assert.doesNotThrow(() => {
    const removed = sweepStaleRuntimeTmp("/nonexistent-for-this-test", { fs: brokenFs });
    assert.deepEqual(removed, []);
  });
});

test("ensureRuntime sweeps stale tmp leftovers on its startup path before doing anything else", async () => {
  await withScratch("ensure-sweeps-stale-tmp", async (dir) => {
    const crowHome = join(dir, "crow-home");
    const runtimesDir = join(crowHome, "runtimes", "llamacpp");
    mkdirSync(runtimesDir, { recursive: true });
    const staleFile = join(runtimesDir, ".download-linux-x64-cpu-ancient-release.tmp");
    writeFileSync(staleFile, "leftover");
    backdate(staleFile, STALE_RUNTIME_TMP_MAX_AGE_MS + 60_000);

    // A bad-platform probe makes ensureRuntime reject immediately after the
    // sweep runs — proves the sweep executes even when the rest of the
    // function never gets past resolveAsset.
    const runtimeBlock = makeRuntimeBlock();
    const probe = { platform: "windows" };
    await assert.rejects(() => ensureRuntime(crowHome, runtimeBlock, probe, {}));

    assert.equal(existsSync(staleFile), false, "stale tmp leftover must be swept even on an immediate-reject path");
  });
});

test("ensureRuntime's stale-tmp sweep failure never blocks the real install", async () => {
  await withScratch("ensure-sweep-failure-tolerant", async (dir) => {
    const runtimeBlock = makeRuntimeBlock();
    const probe = { platform: "windows" };
    const throwingSweep = () => {
      throw new Error("sweep exploded");
    };
    await assert.rejects(
      () => ensureRuntime(dir, runtimeBlock, probe, { sweepStaleTmp: throwingSweep }),
      (err) => {
        // Still the REAL error from resolveAsset, not the sweep's throw —
        // proves the try/catch around the sweep call swallows it.
        assert.ok(err instanceof RuntimeAssetError);
        assert.equal(err.code, "UNSUPPORTED_PLATFORM");
        return true;
      },
    );
  });
});
