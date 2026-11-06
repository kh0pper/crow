/**
 * N4-3: when a scheduled tick's CI verdict is not known YET — a run still in
 * progress (`ci-pending`) — auto-update schedules ONE extra check ~30 min out
 * instead of waiting the whole interval. On a day of frequent merges every
 * regular tick landed mid-CI and a box went a whole day without updating.
 *
 * `ci-unavailable` (GitHub unreachable) deliberately does NOT retry: each skip
 * counts toward the 3-in-a-row "updates paused" bell, so a 30-minute retry over
 * a one-hour outage would ring it — alert behaviour this item must not change.
 * Tests below pin both halves of that.
 *
 * Everything here goes through the real scheduler (`startAutoUpdate` →
 * `scheduledTick` → `tickCheck`) with only two seams: the retry delay is
 * injected (a test never waits real minutes) and the scheduled check is stubbed
 * so no git, DB, network or restart path is touched.
 *
 * EVERY test that arms the scheduler stops it in a `finally`: `startAutoUpdate`
 * leaves a ref'd five-minute first-check timer behind, and a leaked one fires
 * later, arms the real multi-hour interval and keeps the whole file's process
 * alive forever (fix round 2: `startAutoUpdate` itself now calls
 * `stopAutoUpdate` first, so a second arm cannot stack timers).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appRoot, startAutoUpdate, stopAutoUpdate, CI_RETRY_DELAY_MS,
  _setAppRootForTest, _setDbForTest, _setCiRetryDelayForTest, _setRetryIntervalForTest,
  _setScheduledCheckForTest, _runScheduledTickForTest, _retryPendingForTest,
} from "../servers/gateway/auto-update.js";

const RETRY_MS = 8; // injected retry delay — never the real 30 minutes

let tmp;           // stand-in checkout: startAutoUpdate's sha probe fails quietly
let savedRoot;
let savedAutoUpdateEnv;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "crow-ci-retry-"));
  savedRoot = appRoot();
  _setAppRootForTest(tmp);
  savedAutoUpdateEnv = process.env.CROW_AUTO_UPDATE;
  delete process.env.CROW_AUTO_UPDATE;
});

after(() => {
  stopAutoUpdate();
  _setScheduledCheckForTest(null);
  _setCiRetryDelayForTest(null);
  _setRetryIntervalForTest(null);
  _setDbForTest(null);
  _setAppRootForTest(savedRoot);
  if (savedAutoUpdateEnv !== undefined) process.env.CROW_AUTO_UPDATE = savedAutoUpdateEnv;
  rmSync(tmp, { recursive: true, force: true });
});

/** A dashboard_settings-shaped db whose enabled flag a test can flip. */
function settingsDb({ intervalHours = "6", enabled = "true" } = {}) {
  const state = { enabled };
  return {
    state,
    execute: async ({ sql }) => {
      if (/^SELECT/i.test(sql)) {
        return {
          rows: [
            { key: "auto_update_enabled", value: state.enabled },
            { key: "auto_update_interval_hours", value: intervalHours },
          ],
        };
      }
      return { rows: [] };
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond, what, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return;
    await sleep(2);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * Arm the scheduler the way post-listen does. `results` is consumed in order and
 * the last entry repeats; every call is recorded in `calls`. The caller MUST
 * stopAutoUpdate() in a finally.
 */
async function arm({ intervalHours = "6", retryDelayMs = RETRY_MS, enabled = "true", results = [] } = {}) {
  const database = settingsDb({ intervalHours, enabled });
  const calls = [];
  _setCiRetryDelayForTest(retryDelayMs);
  _setScheduledCheckForTest(async () => {
    const result = results[Math.min(calls.length, results.length - 1)];
    calls.push(result);
    return result;
  });
  await startAutoUpdate(database, {});
  return { database, calls };
}

/**
 * Arm the scheduler with its first-check timer CAPTURED instead of armed. Its
 * delay is five minutes plus jitter, so no test can wait for it; the fake handle
 * records a `clearTimeout()` on itself, which is how a re-arm is observed.
 *
 * Only the first-check timer is captured: `git rev-parse` runs through
 * `execFile`, whose own 120 s watchdog must stay a real timer, so any timeout
 * under five minutes is passed through untouched.
 */
async function armCapturingFirstCheck(database) {
  const FIRST_CHECK_MIN_MS = 5 * 60 * 1000;
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  let captured = null;
  globalThis.setTimeout = (fn, ms, ...args) => {
    if (captured || !(ms >= FIRST_CHECK_MIN_MS)) return realSetTimeout(fn, ms, ...args);
    captured = { __captured: true, fn, ms, cleared: false };
    return captured;
  };
  globalThis.clearTimeout = (handle) => {
    if (handle && handle.__captured) { handle.cleared = true; return; }
    realClearTimeout(handle);
  };
  try {
    await startAutoUpdate(database, {});
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
  assert.ok(captured, "startAutoUpdate must arm a first-check timer");
  return captured;
}

function captureConsole() {
  const lines = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...a) => { lines.push(a.join(" ")); };
  console.error = (...a) => { lines.push(a.join(" ")); };
  return {
    lines,
    retries: () => lines.filter((l) => l.includes("CI result not known yet")),
    restore: () => { console.log = origLog; console.error = origError; },
  };
}

const pending = { updated: false, skipped: "ci-pending", message: "Skipped: CI still running on origin/main (abc123456)" };
const success = { updated: true, from: "abc1234", to: "def5678" };

test("the retry delay is the documented 30 minutes", () => {
  assert.equal(CI_RETRY_DELAY_MS, 30 * 60 * 1000);
});

test("ci-pending retries, keeps retrying while the verdict stays unknown, and stops on success", async () => {
  const out = captureConsole();
  try {
    // pending → pending → success. Budget for a 6 h interval is 11, so nothing
    // here is stopped by the bound: the chain ends because the verdict arrived.
    const { calls } = await arm({ intervalHours: "6", results: [pending, pending, success] });

    await _runScheduledTickForTest("regular");
    assert.equal(calls.length, 1, "the regular tick ran");
    assert.equal(_retryPendingForTest(), true, "a ci-pending result must arm a retry");

    await waitFor(() => calls.length === 2, "the first retry");
    await waitFor(() => calls.length === 3, "the second retry");

    await sleep(4 * RETRY_MS);
    assert.equal(calls.length, 3, "a known verdict (success) must stop the retry chain");
    assert.equal(_retryPendingForTest(), false);

    const retries = out.retries();
    assert.equal(retries.length, 2, "one log line per retry, and only two retries happened");
    for (const line of retries) {
      assert.match(line, /^\[auto-update\] CI result not known yet; checking again in \d+ min$/);
    }
  } finally {
    stopAutoUpdate();
    out.restore();
  }
});

test("only a CI run still in progress retries: ci-pending, never a verdict", async () => {
  const cases = [
    ["ci-pending", true],
    ["ci-unavailable", false],
    ["ci-red", false],
    ["ci-gate-unavailable", false],
    ["no-ci", false],
    ["not-on-main", false],
  ];
  for (const [code, expectRetry] of cases) {
    const { calls } = await arm({
      intervalHours: "6",
      retryDelayMs: RETRY_MS,
      results: [{ updated: false, skipped: code, message: `Skipped: ${code}` }, success],
    });
    try {
      await _runScheduledTickForTest("regular");
      if (expectRetry) {
        // The positive case waits for the retry instead of racing a fixed sleep:
        // on a loaded runner the first timer callback can land well after the
        // injected delay.
        await waitFor(() => calls.length === 2, `${code} must schedule a retry`);
      } else {
        // Long enough for a retry to have run several times over if one was armed.
        await sleep(6 * RETRY_MS);
        assert.equal(calls.length, 1,
          `${code} must NOT schedule a retry (calls=${calls.length})`);
      }
    } finally {
      stopAutoUpdate();
    }
  }
});

test("ci-unavailable never schedules a retry, so the pause counter only moves on regular ticks", async () => {
  // Each ci-unavailable skip increments auto_update_ci_unavailable_count and the
  // third in a row rings the "updates paused" bell; a 30-minute retry would ring
  // it after ~1 h of outage instead of after three regular ticks. Pin that a run
  // of unreadable-CI results leaves the retry chain unarmed.
  const { calls } = await arm({
    intervalHours: "6",
    results: [
      { updated: false, skipped: "ci-unavailable", message: "Skipped: CI status could not be read for origin/main (abc123456)" },
      success,
    ],
  });
  try {
    for (let i = 0; i < 3; i++) {
      await _runScheduledTickForTest("regular");
      assert.equal(_retryPendingForTest(), false,
        `ci-unavailable tick ${i + 1} must not arm a retry`);
    }
    // Long enough for a retry to have run several times over if one was armed.
    await sleep(6 * RETRY_MS);
    assert.equal(calls.length, 3,
      "only the three regular ticks ran: one ci-unavailable skip never buys an extra check");
  } finally {
    stopAutoUpdate();
  }
});

test("a tick that never reached the CI gate (tickCheck returned null) schedules no retry", async () => {
  // tickCheck's guards return null — e.g. a collection install is running, or
  // auto-update was disabled between the arrow and the tick.
  const { calls } = await arm({ intervalHours: "6" });
  _setScheduledCheckForTest(async () => { calls.push(null); return null; });
  try {
    await _runScheduledTickForTest("regular");
    await sleep(6 * RETRY_MS);
    assert.equal(calls.length, 1);
    assert.equal(_retryPendingForTest(), false);
  } finally {
    stopAutoUpdate();
  }
});

test("the retry bound is ceil(interval / 30 min) - 1: one retry for 1 h, eleven for 6 h", async () => {
  // Pin the arithmetic, not just the constant: a 1 h interval can only fit one
  // 30-minute retry before the next regular tick, a 6 h interval eleven.
  for (const [hours, retries] of [["1", 1], ["6", 11]]) {
    const { calls } = await arm({
      intervalHours: hours,
      retryDelayMs: 2,
      results: [{ updated: false, skipped: "ci-pending", message: "Skipped: CI still running" }],
    });
    try {
      await _runScheduledTickForTest("regular");
      await waitFor(() => calls.length >= 1 + retries, `${retries} retries for a ${hours} h interval`);
      // Well past the last allowed retry: a missing bound keeps counting here.
      await sleep(60);
      assert.equal(calls.length, 1 + retries,
        `a ${hours} h interval must allow exactly ${retries} retries before the next regular tick`);
      assert.equal(_retryPendingForTest(), false, "the chain must not stay armed once the bound is spent");
    } finally {
      stopAutoUpdate();
    }
  }
});

test("at most one retry is pending, and a regular tick cancels the one already armed", async () => {
  const { calls } = await arm({
    intervalHours: "6",
    retryDelayMs: 60,
    // regular, regular, then success end the chain
    results: [pending, pending, success],
  });
  try {
    await _runScheduledTickForTest("regular");
    assert.equal(_retryPendingForTest(), true, "first tick armed a retry");
    // The regular tick arrives before that retry fires: it must cancel it.
    await _runScheduledTickForTest("regular");
    assert.equal(_retryPendingForTest(), true, "the second tick armed its own retry");

    await waitFor(() => calls.length >= 3, "a retry after the second tick");
    await sleep(3 * 60); // three retry slots, long enough for a leaked timer to fire
    assert.equal(calls.length, 3,
      "exactly ONE retry ran: a cancelled timer and its replacement never both fire");
  } finally {
    stopAutoUpdate();
  }
});

test("stopAutoUpdate clears a pending retry", async () => {
  const { calls } = await arm({ intervalHours: "6", retryDelayMs: 40, results: [pending, success] });
  try {
    await _runScheduledTickForTest("regular");
    assert.equal(_retryPendingForTest(), true);

    stopAutoUpdate();
    assert.equal(_retryPendingForTest(), false, "the retry timer must be cleared with the interval");
    await sleep(120);
    assert.equal(calls.length, 1, "a stopped updater must never fire its retry");
  } finally {
    stopAutoUpdate();
  }
});

test("a retry that rejects does not crash the process and later ticks still schedule", async () => {
  const out = captureConsole();
  try {
    const { calls } = await arm({ intervalHours: "6", retryDelayMs: 15 });
    // An unhandled rejection here fails this test file outright; the timer
    // callback must catch it, exactly like the first-check timer does.
    const script = [pending, "throw", pending, success];
    _setScheduledCheckForTest(async () => {
      const result = script[Math.min(calls.length, script.length - 1)];
      calls.push(result);
      if (result === "throw") throw new Error("boom from tickCheck");
      return result;
    });

    await _runScheduledTickForTest("regular");
    await waitFor(() => calls.length === 2, "the retry that rejects");
    await sleep(4 * 15);
    assert.equal(calls.length, 2, "a rejected retry schedules no further retry on its own");
    assert.equal(_retryPendingForTest(), false);

    // The scheduler must still be able to start a fresh chain afterwards.
    await _runScheduledTickForTest("regular");
    await waitFor(() => calls.length === 4, "the retry after the next regular tick");
    assert.ok(out.lines.some((l) => l.includes("retry tick failed")),
      "the rejection is logged, not swallowed silently");
  } finally {
    stopAutoUpdate();
    out.restore();
  }
});

test("the disabled guard still applies to a retry", async () => {
  const out = captureConsole();
  try {
    const { database, calls } = await arm({ intervalHours: "6", retryDelayMs: 40, results: [pending, success] });
    await _runScheduledTickForTest("regular");
    assert.equal(_retryPendingForTest(), true);

    // The operator turns auto-update off between the tick and its retry.
    database.state.enabled = "false";
    await sleep(150);

    assert.equal(calls.length, 1, "the retry must go through tickCheck and be refused by it");
    assert.equal(_retryPendingForTest(), false);
    assert.ok(out.lines.some((l) => l.includes("Skipping scheduled check — disabled in settings")),
      "the refusal must be the tickCheck guard, not a bypass");
  } finally {
    stopAutoUpdate();
    out.restore();
  }
});

test("scheduled ticks never overlap: a tick still running makes the next one skip", async () => {
  const out = captureConsole();
  let release;
  const gate = new Promise((r) => { release = r; });
  const calls = [];
  try {
    _setCiRetryDelayForTest(RETRY_MS);
    _setScheduledCheckForTest(async () => { calls.push(1); await gate; return success; });
    await startAutoUpdate(settingsDb({ intervalHours: "6" }), {});

    const inFlight = _runScheduledTickForTest("regular");
    await waitFor(() => calls.length === 1, "the first tick to reach the check");

    // The interval (or a retry) fires while the slow tick is still in npm
    // install: it must skip instead of running a second checkForUpdates().
    const skipped = await _runScheduledTickForTest("regular");
    assert.equal(skipped, null, "the overlapping tick returns without a result");
    assert.equal(calls.length, 1, "the check ran exactly once");
    assert.ok(out.lines.some((l) => l.includes("a check is already running; skipping this one")),
      "the skipped tick logs one line");

    release();
    await inFlight;
    // The flag is cleared in a finally, so the scheduler keeps working after.
    await _runScheduledTickForTest("regular");
    assert.equal(calls.length, 2, "a later tick runs once the slow one has finished");
  } finally {
    release();
    stopAutoUpdate();
    out.restore();
  }
});

test("a second startAutoUpdate re-arms instead of stacking a timer or a retry", async () => {
  _setCiRetryDelayForTest(60);
  _setScheduledCheckForTest(async () => pending);
  try {
    const firstTimer = await armCapturingFirstCheck(settingsDb({ intervalHours: "6" }));
    await _runScheduledTickForTest("regular");
    assert.equal(_retryPendingForTest(), true, "the first arm left a retry pending");
    assert.equal(firstTimer.cleared, false,
      "nothing has cleared the first arm's first-check timer yet");

    const secondTimer = await armCapturingFirstCheck(settingsDb({ intervalHours: "6" }));
    assert.equal(firstTimer.cleared, true,
      "the second start must clear the first arm's first-check timer");
    assert.notEqual(secondTimer, firstTimer, "the second start arms its own timer");
    assert.equal(_retryPendingForTest(), false,
      "the second start must clear the first arm's retry timer too");

    // The interval is armed by the first check, not by startAutoUpdate: fire the
    // second arm's captured first check and count the intervals it creates.
    const armedIntervals = [];
    const realSetInterval = globalThis.setInterval;
    globalThis.setInterval = (fn, ms, ...args) => {
      const handle = realSetInterval(fn, ms, ...args);
      armedIntervals.push(ms);
      return handle;
    };
    try {
      await secondTimer.fn();
    } finally {
      globalThis.setInterval = realSetInterval;
    }
    assert.deepEqual(armedIntervals, [6 * 60 * 60 * 1000],
      "exactly ONE interval, for the configured 6 h — no orphan from the first arm");
  } finally {
    stopAutoUpdate();
    _setScheduledCheckForTest(null);
  }
});

test("the wall-clock bound stops a chain at the interval edge", async () => {
  // elapsed + delay >= intervalMs. A 1 h interval cannot show this: its budget
  // is 1, so the budget bound fires first, and a delay near the interval would
  // arm a real hour-long timer. The interval seam narrows the edge instead,
  // leaving the 6 h budget (11 retries) well out of the way.
  const INTERVAL_MS = 3000;
  for (const [delayMs, expectRetry] of [[1000, true], [INTERVAL_MS, false]]) {
    const out = captureConsole();
    try {
      _setRetryIntervalForTest(INTERVAL_MS);
      const { calls } = await arm({
        intervalHours: "6",
        retryDelayMs: delayMs,
        results: [pending, success],
      });
      await _runScheduledTickForTest("regular");
      if (expectRetry) {
        // Control: the same narrowed interval does allow a shorter delay.
        await waitFor(() => calls.length === 2, "the retry inside the interval");
      } else {
        assert.equal(_retryPendingForTest(), false,
          "a retry whose delay reaches the interval edge must not be armed");
        assert.equal(calls.length, 1, "no extra check ran");
        assert.equal(out.retries().length, 0, "and no retry line was logged");
      }
    } finally {
      stopAutoUpdate();
      _setRetryIntervalForTest(null);
      out.restore();
    }
  }
});

test("a regular tick resets a partly spent retry budget, so a new chain gets the full one", async () => {
  // A 1 h interval allows exactly one retry. Spend it, watch the chain stay
  // exhausted, then show the next regular tick starts a fresh chain: `used` and
  // `startedAt` restart with the interval instead of carrying over.
  const { calls } = await arm({ intervalHours: "1", retryDelayMs: 2, results: [pending] });
  try {
    await _runScheduledTickForTest("regular");
    await waitFor(() => calls.length === 2, "the one retry of the first budget");
    await sleep(40);
    assert.equal(calls.length, 2, "the 1 h budget is spent after one retry");
    assert.equal(_retryPendingForTest(), false, "an exhausted chain stays unarmed");

    await _runScheduledTickForTest("regular");
    assert.equal(_retryPendingForTest(), true,
      "the new regular tick re-arms a retry, so `used` was reset");
    await waitFor(() => calls.length === 4, "the retry of the second chain");
    await sleep(40);
    assert.equal(calls.length, 4, "the new chain got a full budget again (one more retry)");

    await _runScheduledTickForTest("regular");
    assert.equal(_retryPendingForTest(), true, "and again on the next interval, not just once");
  } finally {
    stopAutoUpdate();
  }
});
