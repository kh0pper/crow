// tests/live-sampler.test.js
//
// The beside-mode admission gate is synchronous, so the live readings come
// from a background sampler that keeps the last snapshot. These tests drive it
// with a fake `cat` (and a fake /sys/class/drm listing) so no real sysfs, no
// real /proc/meminfo and no child process is involved.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  startLiveSampler, stopLiveSampler, getLiveSnapshot, readLiveSnapshotSync,
  _setLiveSnapshotForTest, _setExecFileForTest, _setDrmCardsForTest,
} from "../servers/gateway/models/live-sampler.js";

const CARDS = ["card0", "card0-DP-1", "card1", "renderD128"];
const GTT_USED_1 = "/sys/class/drm/card1/device/mem_info_gtt_used";
const GTT_TOTAL_1 = "/sys/class/drm/card1/device/mem_info_gtt_total";
const MEMINFO = "/proc/meminfo";

/** A fake execFile: `files` maps a path to its cat output; anything else fails. */
function fakeCat(files) {
  const calls = [];
  const fn = (cmd, args, opts, cb) => {
    const path = args[0];
    calls.push({ cmd, path, opts });
    // Asynchronous like the real execFile: a reading never lands synchronously.
    setImmediate(() => {
      if (Object.prototype.hasOwnProperty.call(files, path)) cb(null, files[path]);
      else cb(Object.assign(new Error(`cat: ${path}: No such file or directory`), { code: 1 }));
    });
    return null;
  };
  fn.calls = calls;
  return fn;
}

const GOOD_FILES = {
  [GTT_USED_1]: "104857600\n",            // 100 MB
  [GTT_TOTAL_1]: "2147483648\n",          // 2048 MB
  [MEMINFO]: "MemTotal:       65536000 kB\nMemFree:  100 kB\nMemAvailable:    5242880 kB\n",
};

async function waitFor(pred, timeoutMs, label) {
  const started = Date.now();
  while (!pred()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

afterEach(() => {
  _setLiveSnapshotForTest(undefined);
  _setExecFileForTest(null);
  _setDrmCardsForTest(undefined);
  stopLiveSampler();
});

test("snapshot is parsed from injected cat output and reports MB", async () => {
  _setDrmCardsForTest(CARDS);
  const exec = fakeCat(GOOD_FILES);
  const sampler = startLiveSampler({ intervalMs: 20, execFileFn: exec });
  try {
    await waitFor(() => getLiveSnapshot() !== null, 2000, "the first reading");
    const snap = getLiveSnapshot();
    assert.equal(snap.gttUsedMb, 100);
    assert.equal(snap.gttTotalMb, 2048);
    assert.equal(snap.memAvailableMb, 5120);
    assert.equal(typeof snap.at, "number");
    assert.ok(exec.calls.every((c) => c.cmd === "cat" && c.opts.timeout === 2000), "every read is a timed cat");
    assert.ok(exec.calls.some((c) => c.path === GTT_USED_1), "card1 is the first card with both counters");
    assert.ok(exec.calls.some((c) => c.path.startsWith("/sys/class/drm/card0/")), "card0 is tried first and fails (it has no counters here)");
    assert.ok(!exec.calls.some((c) => c.path.includes("card0-DP-1") || c.path.includes("renderD128")), "connector and render entries are never read");
  } finally {
    sampler.stop();
  }
});

test("getLiveSnapshot is null until the first reading", async () => {
  _setLiveSnapshotForTest(undefined);
  _setDrmCardsForTest(CARDS);
  let reads = 0;
  // A reader that never answers stands in for "the first reading has not landed".
  _setExecFileForTest(() => { reads++; return null; });
  try {
    assert.equal(getLiveSnapshot(), null);
    assert.equal(getLiveSnapshot(), null);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(getLiveSnapshot(), null, "still nothing to report");
    assert.ok(reads > 0, "the lazily started sampler did try a reading");
  } finally {
    _setLiveSnapshotForTest(undefined); // stops the lazily started sampler
  }
  // Undefined restores the real behaviour: no seam value, no stale snapshot.
  _setExecFileForTest(() => { throw new Error("no reading in this test"); });
  assert.equal(getLiveSnapshot(), null);
  stopLiveSampler();
});

test("a failing read keeps the last good snapshot or null", async () => {
  _setDrmCardsForTest(CARDS);
  const files = { ...GOOD_FILES };
  const exec = fakeCat(files);
  const sampler = startLiveSampler({ intervalMs: 20, execFileFn: exec });
  try {
    await waitFor(() => getLiveSnapshot() !== null, 2000, "the first reading");
    const good = getLiveSnapshot();
    for (const key of Object.keys(files)) delete files[key];
    await new Promise((r) => setTimeout(r, 120));
    assert.deepEqual(getLiveSnapshot(), good, "the last good snapshot survives failing reads");
  } finally {
    sampler.stop();
  }
  // Nothing ever read at all: still null, never a fabricated snapshot.
  const dead = startLiveSampler({ intervalMs: 20, execFileFn: fakeCat({}) });
  try {
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(getLiveSnapshot(), null);
  } finally {
    dead.stop();
  }
  // The synchronous CLI read uses the same parsing (and reports null on a dead read).
  _setDrmCardsForTest(CARDS);
  const syncOk = (cmd, args, opts) => {
    assert.equal(cmd, "cat");
    assert.equal(opts.timeout, 2000);
    const out = GOOD_FILES[args[0]];
    if (out == null) throw new Error("cat: no such file");
    return out;
  };
  assert.deepEqual(
    { ...readLiveSnapshotSync({ execFileFn: syncOk }), at: 0 },
    { gttUsedMb: 100, gttTotalMb: 2048, memAvailableMb: 5120, at: 0 },
  );
  assert.equal(readLiveSnapshotSync({ execFileFn: () => { throw new Error("cat: nope"); } }), null);
});