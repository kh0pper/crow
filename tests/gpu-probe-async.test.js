import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runBoundedProbe } from "../servers/shared/bounded-probe.js";
import {
  RETRY_AFTER_MS,
  probeGpuHost,
  detectGpuArch,
  detectGpuVramGb,
  ensureGpuProbed,
  _resetGpuProbeForTest,
  _setProbeImplForTest,
} from "../servers/gateway/gpu-arch.js";

// Trimmed `rocminfo` output: a CPU agent with a larger pool, the gfx1151 GPU
// agent (124 GB pool) and an NPU agent.
const ROCMINFO_FIXTURE = `
Agent 1
  Name:                    AMD RYZEN AI MAX+ 395 w/ Radeon 8060S
  Vendor Name:             CPU
  Pool Info:
      Segment:                 GLOBAL; FLAGS: COARSE GRAINED
      Size:                    131011452(0x7cf137c) KB
Agent 2
  Name:                    gfx1151
  Vendor Name:             AMD
  Pool Info:
      Segment:                 GLOBAL; FLAGS: COARSE GRAINED
      Size:                    130023424(0x7c00000) KB
      Segment:                 GROUP
      Size:                    64(0x40) KB
Agent 3
  Name:                    aie2p
  Vendor Name:             AMD
  Pool Info:
      Segment:                 GLOBAL; FLAGS: COARSE GRAINED
      Size:                    131011452(0x7cf137c) KB
`;

const binName = (cmd) => String(cmd).split("/").pop();

/** A child that never exits and ignores every signal — the D-state shape. */
function fakeStuckChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.destroy = () => {};
  child.pid = 424242;
  child.signals = [];
  child.kill = (sig) => { child.signals.push(sig); return true; };
  child.unref = () => {};
  return child;
}

// The module-level probe implementation is what a cold-cache sync read kicks
// off, so it is stubbed for every test: nothing here spawns a real rocminfo.
let defaultProbeCalls = 0;

beforeEach(() => {
  _resetGpuProbeForTest();
  defaultProbeCalls = 0;
  _setProbeImplForTest(async () => {
    defaultProbeCalls += 1;
    return { ok: false, stdout: "", reason: "spawn-error" };
  });
});

afterEach(() => {
  _resetGpuProbeForTest();
  _setProbeImplForTest(null);
});

// ---------------------------------------------------------------------------
// runBoundedProbe
// ---------------------------------------------------------------------------

test("runBoundedProbe: a stuck child resolves 'deadline' at the deadline and is SIGKILLed", { timeout: 3000 }, async () => {
  const child = fakeStuckChild();
  let spawnOptions = null;
  const spawnImpl = (cmd, args, options) => {
    spawnOptions = options;
    return child;
  };

  const started = Date.now();
  const result = await runBoundedProbe("rocminfo", [], { deadlineMs: 100, spawnImpl });
  const elapsed = Date.now() - started;

  assert.equal(result.ok, false);
  assert.equal(result.reason, "deadline");
  assert.equal(result.stdout, "");
  assert.ok(elapsed < 400, `resolved after ${elapsed}ms`);
  assert.deepEqual(child.signals, ["SIGKILL"]);
  assert.equal(spawnOptions.detached, true);
  assert.deepEqual(spawnOptions.stdio, ["ignore", "pipe", "ignore"]);
});

test("runBoundedProbe: the event loop keeps ticking while a stuck child is abandoned", { timeout: 3000 }, async () => {
  const child = fakeStuckChild();
  let ticks = 0;
  const interval = setInterval(() => { ticks += 1; }, 10);
  try {
    const result = await runBoundedProbe("rocminfo", [], { deadlineMs: 100, spawnImpl: () => child });
    assert.equal(result.reason, "deadline");
  } finally {
    clearInterval(interval);
  }
  assert.ok(ticks >= 5, `only ${ticks} timer ticks during the probe`);
});

test("runBoundedProbe: a real child that ignores SIGTERM still resolves 'deadline' quickly", { timeout: 3000 }, async () => {
  const started = Date.now();
  const result = await runBoundedProbe(
    process.execPath,
    ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
    { deadlineMs: 200 },
  );
  const elapsed = Date.now() - started;

  assert.equal(result.ok, false);
  assert.equal(result.reason, "deadline");
  assert.equal(result.stdout, "");
  assert.ok(elapsed < 1000, `resolved after ${elapsed}ms`);
});

test("runBoundedProbe: collects stdout and reports a zero exit", async () => {
  const child = fakeStuckChild();
  const spawnImpl = () => {
    setImmediate(() => {
      child.stdout.emit("data", "Name: gfx1151\n");
      child.stdout.emit("data", "      Size:                    130023424(0x7c00000) KB\n");
      child.emit("close", 0);
    });
    return child;
  };

  const result = await runBoundedProbe("rocminfo", [], { deadlineMs: 2000, spawnImpl });
  assert.equal(result.ok, true);
  assert.equal(result.reason, "exit");
  assert.equal(result.stdout, "Name: gfx1151\n      Size:                    130023424(0x7c00000) KB\n");
});

test("runBoundedProbe: a non-zero exit is 'nonzero' but keeps its output", async () => {
  const child = fakeStuckChild();
  const spawnImpl = () => {
    setImmediate(() => {
      child.stdout.emit("data", "partial");
      child.emit("close", 1);
    });
    return child;
  };

  const result = await runBoundedProbe("rocminfo", [], { deadlineMs: 2000, spawnImpl });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "nonzero");
  assert.equal(result.stdout, "partial");
});

test("runBoundedProbe: a missing binary resolves 'spawn-error'", async () => {
  const result = await runBoundedProbe("crow-probe-no-such-binary", [], { deadlineMs: 2000 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "spawn-error");
  assert.equal(result.stdout, "");
});

// ---------------------------------------------------------------------------
// probeGpuHost — caching, single flight, and what the sync readers see
// ---------------------------------------------------------------------------

test("probeGpuHost: one rocminfo answers both arches and VRAM", async () => {
  const calls = [];
  const probeImpl = async (cmd) => {
    calls.push(binName(cmd));
    if (binName(cmd) === "rocminfo") return { ok: true, stdout: ROCMINFO_FIXTURE, reason: "exit" };
    return { ok: false, stdout: "", reason: "spawn-error" };
  };

  const result = await probeGpuHost({ probeImpl });
  assert.equal(result.ok, true);

  const arches = detectGpuArch();
  assert.ok(arches.includes("gfx1151"), `arches: ${arches}`);
  assert.ok(arches.includes("rocm"), `arches: ${arches}`);
  assert.ok(arches.includes("cpu"), `arches: ${arches}`);
  assert.equal(detectGpuVramGb(), 124);
  assert.equal(calls.filter((c) => c === "rocminfo").length, 1);
  assert.equal(defaultProbeCalls, 0);
});

test("probeGpuHost: a deadline is cached as unknown and not re-probed inside the retry window", async () => {
  let calls = 0;
  const probeImpl = async () => {
    calls += 1;
    return { ok: false, stdout: "", reason: "deadline" };
  };

  const first = await probeGpuHost({ probeImpl });
  assert.equal(first.ok, false);
  assert.deepEqual(first.arches, ["cpu"]);
  assert.equal(first.vramGb, null);
  assert.equal(calls, 1);

  assert.deepEqual(detectGpuArch(), ["cpu"]);
  assert.equal(detectGpuVramGb(), null);

  const second = await probeGpuHost();
  assert.deepEqual(second.arches, ["cpu"]);
  assert.equal(second.vramGb, null);

  assert.equal(calls, 1);
  assert.equal(defaultProbeCalls, 0);
});

test("detectGpuArch: a cold cache returns ['cpu'] synchronously while the probe never resolves", () => {
  _setProbeImplForTest(() => new Promise(() => {}));

  const started = Date.now();
  const arches = detectGpuArch();
  const elapsed = Date.now() - started;

  assert.deepEqual(arches, ["cpu"]);
  assert.equal(detectGpuVramGb(), null);
  assert.ok(elapsed < 50, `took ${elapsed}ms`);
});

test("probeGpuHost: two concurrent calls share one probe", async () => {
  let probeRounds = 0;
  const probeImpl = async (cmd) => {
    if (binName(cmd) === "rocminfo") probeRounds += 1;
    return { ok: false, stdout: "", reason: "spawn-error" };
  };

  const [a, b] = await Promise.all([probeGpuHost({ probeImpl }), probeGpuHost({ probeImpl })]);
  assert.equal(probeRounds, 1);
  assert.equal(a.ok, true);
  assert.strictEqual(a, b);
});

// ---------------------------------------------------------------------------
// ensureGpuProbed — a lapsed retry window is the only reason to re-probe
// ---------------------------------------------------------------------------

test("ensureGpuProbed: a lapsed deadline retry window re-probes and picks up a recovered GPU", { timeout: 3000 }, async () => {
  let fakeNow = Date.now();
  mock.method(Date, "now", () => fakeNow);
  try {
    let calls = 0;
    let recovered = false;
    _setProbeImplForTest(async (cmd) => {
      calls += 1;
      if (binName(cmd) !== "rocminfo") return { ok: false, stdout: "", reason: "spawn-error" };
      if (!recovered) return { ok: false, stdout: "", reason: "deadline" };
      return { ok: true, stdout: ROCMINFO_FIXTURE, reason: "exit" };
    });

    // A wedged GPU: the probe answers "deadline" and is cached as unknown.
    const first = await probeGpuHost();
    assert.equal(first.ok, false);
    assert.deepEqual(first.arches, ["cpu"]);
    const callsAfterWedge = calls;
    assert.deepEqual(detectGpuArch(), ["cpu"]);

    // Inside the window: ensureGpuProbed is a no-op, whatever the host does.
    recovered = true;
    fakeNow += RETRY_AFTER_MS - 1;
    await ensureGpuProbed();
    assert.equal(calls, callsAfterWedge, "re-probed inside the retry window");
    assert.deepEqual(detectGpuArch(), ["cpu"]);

    // Past the window: the next ensureGpuProbed asks the host again.
    fakeNow += 2;
    await ensureGpuProbed();
    assert.ok(calls > callsAfterWedge, `stub called ${calls} times, was ${callsAfterWedge}`);
    const arches = detectGpuArch();
    assert.ok(arches.includes("gfx1151"), `arches: ${arches}`);
    assert.ok(arches.includes("rocm"), `arches: ${arches}`);
    assert.equal(defaultProbeCalls, 0);
  } finally {
    mock.restoreAll();
  }
});

test("ensureGpuProbed: after a normal (success) result it never calls the probe again", { timeout: 3000 }, async () => {
  let calls = 0;
  _setProbeImplForTest(async (cmd) => {
    calls += 1;
    if (binName(cmd) === "rocminfo") return { ok: true, stdout: ROCMINFO_FIXTURE, reason: "exit" };
    return { ok: false, stdout: "", reason: "spawn-error" };
  });

  await probeGpuHost();
  const callsAfterProbe = calls;
  assert.ok(callsAfterProbe > 0, "the probe never ran");
  assert.ok(detectGpuArch().includes("gfx1151"));

  await ensureGpuProbed();
  await ensureGpuProbed();

  assert.equal(calls, callsAfterProbe);
  assert.equal(defaultProbeCalls, 0);
});

// ---------------------------------------------------------------------------
// Source guard — no synchronous child-process primitive may come back
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Import-path guard — every async gpu-arch.js import must resolve
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Every specifier of a dynamic `import("<spec>")` in `sourcePath` ending with `suffix`. */
function dynamicImportSpecifiers(sourcePath, suffix) {
  const abs = path.join(REPO_ROOT, sourcePath);
  const text = readFileSync(abs, "utf8");
  const specs = [];
  for (const match of text.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) {
    if (match[1].endsWith(suffix)) specs.push(match[1]);
  }
  return { dir: path.dirname(abs), specs };
}

test("gpu-arch.js dynamic imports resolve to a real file", () => {
  for (const sourcePath of [
    "servers/gateway/dashboard/panels/extensions.js",
    "servers/gateway/boot/post-listen.js",
  ]) {
    const { dir, specs } = dynamicImportSpecifiers(sourcePath, "gpu-arch.js");
    assert.ok(specs.length > 0, `${sourcePath} has no dynamic import of gpu-arch.js`);
    for (const spec of specs) {
      const resolved = path.resolve(dir, spec);
      assert.ok(existsSync(resolved), `${sourcePath}: import("${spec}") -> ${resolved} does not exist`);
    }
  }
});

test("gpu-arch.js and models/probe.js carry no synchronous child-process calls", () => {
  for (const path of ["../servers/gateway/gpu-arch.js", "../servers/gateway/models/probe.js"]) {
    const text = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.equal(text.includes("execFileSync"), false, `${path} contains execFileSync`);
    assert.equal(text.includes("spawnSync"), false, `${path} contains spawnSync`);
  }
});