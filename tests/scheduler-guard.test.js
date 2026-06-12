/**
 * Tests for W4-4 commit 2: scheduler double-start guard.
 *
 * Verifies:
 *   1. A second startScheduler() call while running warns and returns without
 *      creating a second interval (no orphaned duplicate ticks).
 *   2. After stopScheduler() the guard resets and startScheduler() can run again.
 *   3. stopScheduler() clears the interval (no further ticks after stop).
 */

import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { startScheduler, stopScheduler } from "../servers/gateway/scheduler.js";

// Minimal stub DB that satisfies startScheduler's init query (the cron_expression
// SELECT on schedules). Returns an empty rows array so the "compute next_run" loop
// is a no-op and the function reaches the setInterval call normally.
function stubDb() {
  return {
    async execute() {
      return { rows: [] };
    },
  };
}

// Capture console.warn lines during a test.
function captureWarns(fn) {
  const warns = [];
  const orig = console.warn;
  console.warn = (...args) => warns.push(args.join(" "));
  try {
    return { result: fn(), warns };
  } finally {
    console.warn = orig;
  }
}

// Always stop the scheduler after each test to reset state.
after(() => stopScheduler());

test("scheduler: first startScheduler() runs normally and creates an interval", async () => {
  stopScheduler(); // ensure clean state

  const warns = [];
  const orig = console.warn;
  console.warn = (...args) => warns.push(args.join(" "));
  try {
    await startScheduler(stubDb());
  } finally {
    console.warn = orig;
  }

  const duplicateWarns = warns.filter((w) => w.includes("already running"));
  assert.equal(duplicateWarns.length, 0, "no duplicate-start warning on first call");

  stopScheduler(); // clean up
});

test("scheduler: second startScheduler() while running warns + returns (single interval)", async () => {
  stopScheduler(); // ensure clean state

  const db = stubDb();
  await startScheduler(db);

  // Track intervals to verify only one is ever created.
  const intervals = [];
  const origSetInterval = globalThis.setInterval;
  globalThis.setInterval = (...args) => {
    const id = origSetInterval(...args);
    intervals.push(id);
    return id;
  };

  const warns = [];
  const origWarn = console.warn;
  console.warn = (...args) => warns.push(args.join(" "));

  try {
    // Second call — should warn and return, NOT create another interval.
    await startScheduler(db);
  } finally {
    globalThis.setInterval = origSetInterval;
    console.warn = origWarn;
  }

  const duplicateWarns = warns.filter((w) => w.includes("already running"));
  assert.equal(duplicateWarns.length, 1, "exactly one 'already running' warning");
  assert.equal(intervals.length, 0, "no new interval created on duplicate start");

  stopScheduler();
});

test("scheduler: stopScheduler resets guard — startScheduler can run again", async () => {
  stopScheduler(); // ensure clean state

  const db = stubDb();
  await startScheduler(db);
  stopScheduler(); // resets _started flag

  // Third call after stop — should succeed (no warning, interval created).
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...args) => warns.push(args.join(" "));

  try {
    await startScheduler(db);
  } finally {
    console.warn = origWarn;
  }

  const duplicateWarns = warns.filter((w) => w.includes("already running"));
  assert.equal(duplicateWarns.length, 0, "no warning when starting after stop+reset");

  stopScheduler();
});
