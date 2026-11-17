/**
 * The live GPU-memory / RAM snapshot beside-mode admission reads (the private
 * engineering notes, the one box calendar, beside mode).
 *
 * `startBlockedBy` in gpu-orchestrator.js stays synchronous and must not read
 * sysfs on a request path, so `startLiveSampler()` reads the counters in the
 * background every few seconds through `execFile("cat", …)` (async, 2 s
 * timeout) and keeps the last snapshot; `getLiveSnapshot()` hands it out.
 *
 * Counters:
 *   - `/sys/class/drm/card<N>/device/mem_info_gtt_used` and
 *     `mem_info_gtt_total` — the first card (in card-number order) that has
 *     both; discovery is a readdirSync of `/sys/class/drm`.
 *   - `MemAvailable` from `/proc/meminfo`.
 *
 * Units: MiB-ish "mb" everywhere (the repo's shorthand): bytes / 1048576,
 * and meminfo's kB / 1024, both rounded.
 *
 * `readLiveSnapshotSync()` is the one-shot synchronous form — for the CLI,
 * which is never on a request path.
 *
 * A failed read keeps the last good snapshot (or leaves it null). A snapshot
 * that stops arriving ages out by its `at`, and `startDecision` refuses a
 * beside start from a stale one.
 */

import { execFile, execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";

const DRM_CLASS_DIR = "/sys/class/drm";
const MEMINFO_PATH = "/proc/meminfo";
const BYTES_PER_MB = 1048576;
const READ_TIMEOUT_MS = 2_000;
const DEFAULT_INTERVAL_MS = 5_000;

function defaultListCards() {
  return readdirSync(DRM_CLASS_DIR);
}

let _execFileFn = execFile;
let _listCardsFn = defaultListCards;
let _timer = null;
let _last = null;
let _inFlight = false;
let _generation = 0;
let _seamSet = false;
let _seamValue = null;

const bytesToMb = (bytes) => Math.round(bytes / BYTES_PER_MB);
const kbToMb = (kb) => Math.round((kb * 1024) / BYTES_PER_MB);

function runCat(execFileFn, path) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err, stdout) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(String(stdout == null ? "" : stdout));
    };
    try {
      const ret = execFileFn("cat", [path], { timeout: READ_TIMEOUT_MS }, done);
      // A fake may return a promise instead of calling the callback.
      if (ret && typeof ret.then === "function") ret.then((v) => done(null, v), done);
    } catch (err) {
      done(err);
    }
  });
}

async function readInt(execFileFn, path) {
  let text;
  try { text = await runCat(execFileFn, path); } catch { return null; }
  const n = Number.parseInt(text.trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function cardNames(entries) {
  if (!Array.isArray(entries)) return [];
  return entries
    .map((e) => String(e))
    .filter((e) => /^card\d+$/.test(e))
    .sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)));
}

/** {usedMb, totalMb} of the first card that exposes both counters, else null. */
async function readGtt(execFileFn, listCardsFn) {
  let entries;
  try { entries = listCardsFn(); } catch { return null; }
  for (const card of cardNames(entries)) {
    const base = `${DRM_CLASS_DIR}/${card}/device`;
    const [used, total] = await Promise.all([
      readInt(execFileFn, `${base}/mem_info_gtt_used`),
      readInt(execFileFn, `${base}/mem_info_gtt_total`),
    ]);
    if (used == null || total == null) continue;
    return { usedMb: bytesToMb(used), totalMb: bytesToMb(total) };
  }
  return null;
}

async function readMemAvailable(execFileFn) {
  let text;
  try { text = await runCat(execFileFn, MEMINFO_PATH); } catch { return null; }
  const m = /^\s*MemAvailable:\s+(\d+)\s*kB\s*$/m.exec(text);
  if (!m) return null;
  const kb = Number(m[1]);
  return Number.isFinite(kb) ? kbToMb(kb) : null;
}

async function readSnapshot(execFileFn, listCardsFn) {
  const gtt = await readGtt(execFileFn, listCardsFn);
  if (!gtt) return null;
  const memAvailableMb = await readMemAvailable(execFileFn);
  if (memAvailableMb == null) return null;
  return { gttUsedMb: gtt.usedMb, gttTotalMb: gtt.totalMb, memAvailableMb, at: Date.now() };
}

/**
 * Start (or restart) the background sampler. Returns `{stop()}`; the interval
 * timer is unref'd so it never holds the process open.
 *
 * @param {{intervalMs?: number, execFileFn?: Function, listCardsFn?: Function}} [opts]
 *   `execFileFn` / `listCardsFn` are injection points for tests
 */
export function startLiveSampler({ intervalMs = DEFAULT_INTERVAL_MS, execFileFn = null, listCardsFn = null } = {}) {
  const runFn = execFileFn || _execFileFn;
  const listFn = listCardsFn || _listCardsFn;
  stopLiveSampler();
  const gen = _generation;
  const tick = () => {
    if (_inFlight) return;
    _inFlight = true;
    readSnapshot(runFn, listFn)
      .then((snap) => {
        // A stop() during the read must not resurrect a snapshot.
        if (snap && gen === _generation) _last = snap;
      })
      .catch(() => { /* a failing read keeps the last good snapshot */ })
      .finally(() => { if (gen === _generation) _inFlight = false; });
  };
  tick();
  _timer = setInterval(tick, Math.max(1, Number(intervalMs) || DEFAULT_INTERVAL_MS));
  if (typeof _timer.unref === "function") _timer.unref();
  return { stop: () => stopLiveSampler() };
}

/** Stop the background sampler and forget the snapshot it kept. */
export function stopLiveSampler() {
  _generation += 1;
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
  _inFlight = false;
  _last = null;
}

/**
 * The last snapshot the sampler took, or null before the first reading lands.
 * Lazily starts the sampler on the first call (non-blocking) unless a test
 * seam value is set.
 *
 * @returns {{gttUsedMb: number, gttTotalMb: number, memAvailableMb: number, at: number}|null}
 */
export function getLiveSnapshot() {
  if (_seamSet) return _seamValue;
  if (!_timer) startLiveSampler();
  return _last;
}

/**
 * Test seam: any value (including null) is returned by `getLiveSnapshot`
 * verbatim and the real sampler is stopped; `undefined` restores the real
 * behaviour (and stops a lazily started sampler).
 */
export function _setLiveSnapshotForTest(snap) {
  if (snap === undefined) {
    _seamSet = false;
    _seamValue = null;
    stopLiveSampler();
    return;
  }
  _seamSet = true;
  _seamValue = snap;
  stopLiveSampler();
}

/** Test seam: the `cat` runner the real sampler uses. `null` restores execFile. */
export function _setExecFileForTest(fn) {
  _execFileFn = typeof fn === "function" ? fn : execFile;
}

/**
 * Test seam: the `/sys/class/drm` listing. An array of entry names, or a
 * function returning one; `undefined` restores the real readdirSync.
 */
export function _setDrmCardsForTest(cards) {
  if (cards === undefined) {
    _listCardsFn = defaultListCards;
    return;
  }
  _listCardsFn = typeof cards === "function" ? cards : () => cards;
}

function runCatSync(execFileFn, path) {
  try {
    return String(execFileFn("cat", [path], { timeout: READ_TIMEOUT_MS, encoding: "utf8" }));
  } catch {
    return null;
  }
}

function readIntSync(execFileFn, path) {
  const text = runCatSync(execFileFn, path);
  if (text == null) return null;
  const n = Number.parseInt(text.trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function readGttSync(execFileFn) {
  let entries;
  try { entries = _listCardsFn(); } catch { return null; }
  for (const card of cardNames(entries)) {
    const base = `${DRM_CLASS_DIR}/${card}/device`;
    const used = readIntSync(execFileFn, `${base}/mem_info_gtt_used`);
    const total = readIntSync(execFileFn, `${base}/mem_info_gtt_total`);
    if (used == null || total == null) continue;
    return { usedMb: bytesToMb(used), totalMb: bytesToMb(total) };
  }
  return null;
}

/**
 * One-shot synchronous snapshot, for the CLI only (never a request path).
 *
 * @param {{execFileFn?: Function}} [opts]
 * @returns {{gttUsedMb: number, gttTotalMb: number, memAvailableMb: number, at: number}|null}
 */
export function readLiveSnapshotSync({ execFileFn = execFileSync } = {}) {
  const gtt = readGttSync(execFileFn);
  if (!gtt) return null;
  const text = runCatSync(execFileFn, MEMINFO_PATH);
  if (text == null) return null;
  const m = /^\s*MemAvailable:\s+(\d+)\s*kB\s*$/m.exec(text);
  if (!m) return null;
  const kb = Number(m[1]);
  if (!Number.isFinite(kb)) return null;
  return { gttUsedMb: gtt.usedMb, gttTotalMb: gtt.totalMb, memAvailableMb: kbToMb(kb), at: Date.now() };
}