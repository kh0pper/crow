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
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  RuntimeAssetError,
  RuntimeChecksumError,
  resolveAsset,
  isAllowedRuntimeHost,
  buildRuntimeDownloadUrl,
  ensureRuntime,
  buildLlamaServerArgs,
  startModel,
  stopModel,
  identityProbe,
  probeSetprivAvailable,
  __resetSetprivProbeCacheForTest,
  getStatusSnapshot,
} from "../servers/gateway/models/runtime.js";
import { acquireHostLock, lockPathFor } from "../servers/gateway/models/native-lock.js";
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

test("isAllowedRuntimeHost allows exactly github.com and objects.githubusercontent.com", () => {
  assert.equal(isAllowedRuntimeHost("github.com"), true);
  assert.equal(isAllowedRuntimeHost("objects.githubusercontent.com"), true);
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
// ensureRuntime — real tar extraction, checksum-before-chmod ordering
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
      assert.equal(chmodCalls.length, 1);
      assert.equal(chmodCalls[0].p, binPath);
      assert.equal(chmodCalls[0].mode, 0o755);
      assert.equal(readFileSync(binPath, "utf8").includes("fake-llama-server"), true);

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
      // The staging archive must not survive a checksum failure either.
      const releaseDir = join(dir, "crow-home", "runtimes", "llamacpp", "test-rel-bad");
      const staged = existsSync(join(releaseDir, ".download-linux-x64-cpu.tmp"));
      assert.equal(staged, false);
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
