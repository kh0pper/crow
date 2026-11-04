/**
 * The Today card's calendar line, when the card stops waiting: the Workspace CalDAV read it started is
 * CANCELLED, not left running behind an abandoned page.
 *
 * Today is on the Widgets page's default layout, so every page view reads the next event under
 * CALENDAR_TIMEOUT_MS. A slow Workspace used to keep the calendar list PROPFIND, the owner display names
 * and the REPORT alive for ncFetch's own 30 s after the card had already given the line up. So
 * `within()` hands the read an AbortController's signal and aborts it when the budget fires; the seam
 * stands in for the bundle read here, exactly as it does for the rest of Today's tests.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "today-calendar-abort-"));
process.env.CROW_DATA_DIR = dir;
const HOME = join(dir, "home");
process.env.CROW_HOME = HOME;
delete process.env.CROW_DB_PATH;

const { loadToday, _setTodaySeamsForTest, CALENDAR_TIMEOUT_MS } = await import("../servers/gateway/for-you/today.js");

const NOW = Date.parse("2026-11-03T15:00:00Z");
const ctx = { crowHome: HOME, now: NOW, tz: "UTC", lang: "en" };
const CALENDAR = { summary: "Dentist", start: "2026-11-03T18:30:00Z", all_day: false };

after(() => {
  _setTodaySeamsForTest({});
  rmSync(dir, { recursive: true, force: true });
});

test("a calendar read still going when the budget fires is aborted, and the line is left out", async () => {
  let seamSignal = null;
  let seamArgs = null;
  _setTodaySeamsForTest({
    calendar: (args) => {
      seamArgs = args;
      seamSignal = args.signal;
      return new Promise(() => {}); // a Workspace that never answers
    },
  });

  const started = Date.now();
  const out = await loadToday(null, ctx);
  const took = Date.now() - started;

  assert.deepEqual(out, { calendar: null, move: null, ramble: null });
  assert.ok(took >= CALENDAR_TIMEOUT_MS - 25, `gave up after the budget (${took} ms)`);
  assert.ok(seamSignal, "the seam was handed a signal");
  assert.equal(seamSignal.aborted, true, "the abandoned read was cancelled");
  assert.equal(seamArgs.now, NOW);
  assert.equal(seamArgs.tz, "UTC");
});

test("a calendar read that answers inside the budget is never aborted", async () => {
  let seamSignal = null;
  _setTodaySeamsForTest({
    calendar: ({ signal }) => {
      seamSignal = signal;
      return CALENDAR;
    },
  });

  const out = await loadToday(null, ctx);
  assert.equal(out.calendar.summary, "Dentist");
  assert.ok(seamSignal, "the seam was handed a signal");
  // the budget was cleared when the read won the race: nothing aborts afterwards
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(seamSignal.aborted, false);
});