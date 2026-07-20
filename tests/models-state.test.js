import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import net from "node:net";

import {
  PORT_RANGE_START,
  PORT_RANGE_END,
  PortRangeExhaustedError,
  statePath,
  loadState,
  saveState,
  allocatePort,
  releasePort,
  reconcileOnBoot,
  registryEntryRuntimeState,
} from "../servers/gateway/models/state.js";

function scratchDir(tag) {
  return mkdtempSync(join(tmpdir(), `models-state-${tag}-`));
}

function withScratch(tag, fn) {
  const dir = scratchDir(tag);
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => rmSync(dir, { recursive: true, force: true }));
}

function listenOn(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

// ---------------------------------------------------------------------------
// Port allocation
// ---------------------------------------------------------------------------

test("allocatePort returns the lowest free port, starting at 18100", async () => {
  await withScratch("alloc-first", async () => {
    const state = { reservations: {}, journal: {}, registry: {} };
    // Stub the bind probe: node --test runs test FILES concurrently, and
    // tests/models-registration.test.js exercises the real allocatePort
    // over this same 18100-18199 range, so a live bind-probe can find
    // 18100 transiently held by that other process and correctly skip to
    // 18101 -- a real cross-file TOCTOU, not a product bug. This test
    // asserts the exact starting port, so it must not depend on host
    // network state to be hermetic.
    const port = await allocatePort(state, "model-a", { canBind: async () => true });
    assert.equal(port, PORT_RANGE_START);
    assert.equal(state.reservations["model-a"].port, PORT_RANGE_START);
  });
});

test("allocatePort skips ports already reserved in state", async () => {
  const state = { reservations: {}, journal: {}, registry: {} };
  // Same cross-file TOCTOU as above: both assertions below are exact
  // ports (not a first+1 relative check would still be racy too -- a
  // probe collision landing between the two calls could make
  // first=18100, second=18102), so stub the probe to isolate this test
  // from models-registration.test.js's concurrent real allocatePort calls.
  const stub = { canBind: async () => true };
  const first = await allocatePort(state, "model-a", stub);
  const second = await allocatePort(state, "model-b", stub);
  assert.equal(first, PORT_RANGE_START);
  assert.equal(second, PORT_RANGE_START + 1);
  assert.notEqual(first, second);
});

test("allocatePort records owner {crowHome, pid} and createdAt", async () => {
  const state = { reservations: {}, journal: {}, registry: {} };
  const port = await allocatePort(state, "model-a", { crowHome: "/fake/crow-home", pid: 4242 });
  const reservation = state.reservations["model-a"];
  assert.equal(reservation.port, port);
  assert.equal(reservation.owner.crowHome, "/fake/crow-home");
  assert.equal(reservation.owner.pid, 4242);
  assert.equal(typeof reservation.createdAt, "string");
  assert.ok(!Number.isNaN(Date.parse(reservation.createdAt)));
});

test("allocatePort bind-tests and skips a port actually held on the host", async () => {
  const held = await listenOn(PORT_RANGE_START);
  try {
    const state = { reservations: {}, journal: {}, registry: {} };
    const port = await allocatePort(state, "model-a");
    assert.equal(port, PORT_RANGE_START + 1);
  } finally {
    await closeServer(held);
  }
});

test("releasePort frees a reservation so its port can be reallocated", async () => {
  const state = { reservations: {}, journal: {}, registry: {} };
  // Exact-port assertions again (18100 before AND after release) -- same
  // cross-file TOCTOU with models-registration.test.js's real allocatePort,
  // so stub the probe here too.
  const stub = { canBind: async () => true };
  const port = await allocatePort(state, "model-a", stub);
  assert.equal(port, PORT_RANGE_START);
  releasePort(state, "model-a");
  assert.equal(state.reservations["model-a"], undefined);
  const reallocated = await allocatePort(state, "model-b", stub);
  assert.equal(reallocated, PORT_RANGE_START);
});

test("releasePort on a modelId with no reservation is a no-op", () => {
  const state = { reservations: {}, journal: {}, registry: {} };
  assert.doesNotThrow(() => releasePort(state, "never-reserved"));
});

test("allocatePort throws a typed PortRangeExhaustedError once the range is full", async () => {
  const state = { reservations: {}, journal: {}, registry: {} };
  const rangeSize = PORT_RANGE_END - PORT_RANGE_START + 1;
  for (let i = 0; i < rangeSize; i++) {
    // eslint-disable-next-line no-await-in-loop
    await allocatePort(state, `model-${i}`);
  }
  assert.equal(Object.keys(state.reservations).length, rangeSize);
  await assert.rejects(
    () => allocatePort(state, "model-overflow"),
    (err) => {
      assert.ok(err instanceof PortRangeExhaustedError);
      assert.equal(err.code, "PORT_RANGE_EXHAUSTED");
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// State file persistence
// ---------------------------------------------------------------------------

test("statePath derives from the injected dir, never os.homedir()", () => {
  const p = statePath("/some/injected/dir");
  assert.equal(p, join("/some/injected/dir", "models", "state.json"));
  assert.ok(!p.includes(homedir()));
});

test("loadState on a missing state file returns an empty state, not a throw", async () => {
  await withScratch("load-missing", async (dir) => {
    const state = loadState(dir);
    assert.deepEqual(state, { reservations: {}, journal: {}, registry: {} });
    assert.ok(!existsSync(statePath(dir)));
  });
});

test("saveState + loadState round-trip atomically and deep-equal", async () => {
  await withScratch("roundtrip", async (dir) => {
    const state = {
      reservations: {
        "model-a": { port: 18101, owner: { crowHome: dir, pid: 999 }, createdAt: "2026-07-18T00:00:00.000Z" },
      },
      journal: {
        "model-b": { url: "https://example.test/model-b.gguf", dest: "/tmp/model-b.gguf.part", bytesDone: 1024, expectedSha: "abc123", startedAt: "2026-07-18T00:01:00.000Z" },
      },
      registry: {
        "model-c": { file: "model-c-q4.gguf", quant: "Q4_K_M", catalogId: "model-c", registeredAt: "2026-07-17T00:00:00.000Z" },
      },
    };
    saveState(dir, state);
    assert.ok(existsSync(statePath(dir)));
    const reloaded = loadState(dir);
    assert.deepEqual(reloaded, state);
  });
});

test("saveState never leaves a stray tmp file behind after a successful write", async () => {
  await withScratch("tmp-cleanup", async (dir) => {
    saveState(dir, { reservations: {}, journal: {}, registry: {} });
    const entries = readdirSync(join(dir, "models"));
    assert.deepEqual(entries, ["state.json"]);
  });
});

test("loadState on a corrupt (non-JSON) state file returns an empty state, not a throw", async () => {
  await withScratch("load-corrupt", async (dir) => {
    mkdirSync(join(dir, "models"), { recursive: true });
    writeFileSync(statePath(dir), "{ not valid json", "utf8");
    const state = loadState(dir);
    assert.deepEqual(state, { reservations: {}, journal: {}, registry: {} });
  });
});

// ---------------------------------------------------------------------------
// Boot reconciliation
// ---------------------------------------------------------------------------

test("reconcileOnBoot frees a reservation whose owner pid is dead and has no provider row", () => {
  const state = {
    reservations: {
      "model-dead": { port: 18100, owner: { crowHome: "/x", pid: 111 }, createdAt: "2026-07-18T00:00:00.000Z" },
    },
    journal: {},
    registry: {},
  };
  const result = reconcileOnBoot({
    state,
    listProviderRows: () => [],
    isProcessAlive: (pid) => pid !== 111,
  });
  assert.equal(result.freedReservations.length, 1);
  assert.equal(result.freedReservations[0].modelId, "model-dead");
  assert.equal(result.freedReservations[0].port, 18100);
  assert.equal(state.reservations["model-dead"], undefined);
});

test("reconcileOnBoot keeps a reservation whose owner pid is dead but has a live provider row", () => {
  const state = {
    reservations: {
      "model-live": { port: 18100, owner: { crowHome: "/x", pid: 222 }, createdAt: "2026-07-18T00:00:00.000Z" },
    },
    journal: {},
    registry: {},
  };
  const result = reconcileOnBoot({
    state,
    listProviderRows: () => [{ modelId: "model-live" }],
    isProcessAlive: () => false,
  });
  assert.equal(result.freedReservations.length, 0);
  assert.ok(state.reservations["model-live"]);
});

test("reconcileOnBoot keeps a reservation whose owner pid is alive", () => {
  const state = {
    reservations: {
      "model-alive": { port: 18100, owner: { crowHome: "/x", pid: 333 }, createdAt: "2026-07-18T00:00:00.000Z" },
    },
    journal: {},
    registry: {},
  };
  const result = reconcileOnBoot({
    state,
    listProviderRows: () => [],
    isProcessAlive: (pid) => pid === 333,
  });
  assert.equal(result.freedReservations.length, 0);
  assert.ok(state.reservations["model-alive"]);
});

test("reconcileOnBoot flags a provider row whose reservation is missing", () => {
  const state = { reservations: {}, journal: {}, registry: {} };
  const result = reconcileOnBoot({
    state,
    listProviderRows: () => [{ modelId: "model-orphan", providerId: "p1" }],
    isProcessAlive: () => true,
  });
  assert.equal(result.orphanRows.length, 1);
  assert.equal(result.orphanRows[0].modelId, "model-orphan");
});

test("reconcileOnBoot does not flag a provider row that has a matching reservation", () => {
  const state = {
    reservations: {
      "model-ok": { port: 18100, owner: { crowHome: "/x", pid: 444 }, createdAt: "2026-07-18T00:00:00.000Z" },
    },
    journal: {},
    registry: {},
  };
  const result = reconcileOnBoot({
    state,
    listProviderRows: () => [{ modelId: "model-ok" }],
    isProcessAlive: () => true,
  });
  assert.equal(result.orphanRows.length, 0);
});

test("reconcileOnBoot lists every journal entry as a resumable download", () => {
  const state = {
    reservations: {},
    journal: {
      "model-x": { url: "https://example.test/x.gguf", dest: "/tmp/x.gguf.part", bytesDone: 512, expectedSha: "deadbeef", startedAt: "2026-07-18T00:00:00.000Z" },
      "model-y": { url: "https://example.test/y.gguf", dest: "/tmp/y.gguf.part", bytesDone: 0, expectedSha: "cafef00d", startedAt: "2026-07-18T00:05:00.000Z" },
    },
    registry: {},
  };
  const result = reconcileOnBoot({
    state,
    listProviderRows: () => [],
    isProcessAlive: () => true,
  });
  assert.equal(result.resumableDownloads.length, 2);
  const ids = result.resumableDownloads.map((d) => d.modelId).sort();
  assert.deepEqual(ids, ["model-x", "model-y"]);
  const x = result.resumableDownloads.find((d) => d.modelId === "model-x");
  assert.equal(x.url, "https://example.test/x.gguf");
  assert.equal(x.bytesDone, 512);
});

test("reconcileOnBoot does not mutate state.journal or state.registry", () => {
  const state = {
    reservations: {},
    journal: { "model-x": { url: "u", dest: "d", bytesDone: 0, expectedSha: "s", startedAt: "t" } },
    registry: { "model-z": { file: "f", quant: "q", catalogId: "c", registeredAt: "t" } },
  };
  const before = JSON.stringify(state);
  reconcileOnBoot({ state, listProviderRows: () => [], isProcessAlive: () => true });
  assert.equal(JSON.stringify(state), before);
});

// ---------------------------------------------------------------------------
// registryEntryRuntimeState (Task 13 fix round 1, finding c — "reloading
// after update")
// ---------------------------------------------------------------------------

test("registryEntryRuntimeState: live always wins, regardless of the marker", () => {
  assert.equal(registryEntryRuntimeState({ wasLive: true }, true), "running");
  assert.equal(registryEntryRuntimeState({ wasLive: false }, true), "running");
  assert.equal(registryEntryRuntimeState(null, true), "running");
});

test("registryEntryRuntimeState: not live + wasLive:true -> stopped_after_restart (the gateway restarted out from under it)", () => {
  assert.equal(registryEntryRuntimeState({ wasLive: true }, false), "stopped_after_restart");
  assert.equal(registryEntryRuntimeState({ wasLive: true, lastStoppedAt: null }, false), "stopped_after_restart");
});

test("registryEntryRuntimeState: not live + wasLive:false/absent -> plain stopped (never started, or deliberately stopped)", () => {
  assert.equal(registryEntryRuntimeState({ wasLive: false }, false), "stopped");
  assert.equal(registryEntryRuntimeState({}, false), "stopped");
  assert.equal(registryEntryRuntimeState(null, false), "stopped");
  assert.equal(registryEntryRuntimeState(undefined, false), "stopped");
});

test("registryEntryRuntimeState: a truthy-but-not-strictly-true wasLive (e.g. a stray string) does not accidentally match", () => {
  assert.equal(registryEntryRuntimeState({ wasLive: "true" }, false), "stopped");
  assert.equal(registryEntryRuntimeState({ wasLive: 1 }, false), "stopped");
});
