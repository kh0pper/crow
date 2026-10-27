/**
 * Schedule panel PR 3: the box ledger parser (schedule-sources/box-ledger.js). Every row shape the
 * plan lists (cleared, ongoing, hard stop, overnight, cap/est, end of day, unreadable), the stale
 * rule at its 1 h edge, the caps, and the safe reader (env only, regular files only).
 * The fixture is synthetic: no real hosts or people.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, symlinkSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseLedger, readLedger, ledgerPath, isStale, LEDGER_MAX_BYTES, LEDGER_MAX_LINES } from "../servers/gateway/schedule-sources/box-ledger.js";

const FIXTURE = new URL("./fixtures/box-ledger.md", import.meta.url);
const text = readFileSync(FIXTURE, "utf8");
const TZ = "America/Chicago"; // CDT (UTC−5) on these dates
const NOW = Date.parse("2026-10-27T02:10:00Z"); // Mon 2026-10-26 21:10 local
const at = (s) => Date.parse(s);
const rows = parseLedger(text, { now: NOW, tz: TZ });
const byWhat = (w) => rows.find((r) => r.what === w);

test("reads only the Reservations table: header, separator and other sections are skipped", () => {
  assert.equal(rows.length, 19);
  assert.ok(!rows.some((r) => /not a reservation|nightly audit/.test(r.what)));
  assert.ok(!rows.some((r) => /^when/.test(r.when)));
});

test("markdown is stripped from what (bold, links, code)", () => {
  assert.ok(byWhat("Overnight benchmark sweep"), rows.map((r) => r.what).join(" | "));
  assert.equal(byWhat("Render the turntable stills").owner, "alex (render lane)");
});

test("cleared: a leading ~~|, or ~~ in the when or what cell", () => {
  for (const w of ["Cleared window", "Cleared by a leading strike", "Done window"]) {
    const r = byWhat(w);
    assert.ok(r, w);
    assert.equal(r.open, false, w);
    assert.equal(isStale(r, NOW), false, `${w} is never stale`);
  }
  assert.equal(byWhat("Full test suite").open, true);
});

test("ongoing words: ONGOING, standing, until <words>, HELD, multi-session — never stale", () => {
  for (const w of ["Speech service on the second box", "Lane B worktrees", "Stage 3 queue", "Decommission step 4"]) {
    const r = byWhat(w);
    assert.equal(r.ongoing, true, w);
    assert.equal(isStale(r, NOW + 365 * 86_400_000), false, w);
  }
});

test("hard stop wins over an estimate", () => {
  const r = byWhat("Render the turntable stills");
  assert.equal(r.startNow, true);
  assert.equal(r.end, at("2026-10-27T03:30:00Z"));
});

test("→ HH:MM ends that day; → HH:MM <Day> earlier than the start ends the next day", () => {
  const a = byWhat("Long-context profiling window");
  assert.equal(a.start, at("2026-10-27T02:00:00Z"));
  assert.equal(a.end, at("2026-10-27T03:50:00Z"));
  const b = byWhat("Overnight benchmark sweep");
  assert.equal(b.start, at("2026-10-28T02:00:00Z"));
  assert.equal(b.end, at("2026-10-28T09:00:00Z"));
});

test("→ cap N min / est. ~N h add to the start; a now start ends at 23:59 that day", () => {
  assert.equal(byWhat("Full test suite").end, at("2026-10-27T13:45:00Z"));
  assert.equal(byWhat("Model download").end, at("2026-10-28T17:30:00Z"));
  const docs = byWhat("Docs build");
  assert.equal(docs.startNow, true);
  assert.equal(docs.end, at("2026-10-28T04:59:00Z"));
});

test("→ end of day, and a dated row with no end, end at 23:59 that day", () => {
  assert.equal(byWhat("Disk check").end, at("2026-10-29T04:59:00Z"));
  const armed = byWhat("Archive copy");
  assert.equal(armed.start, at("2026-10-29T12:00:00Z"));
  assert.equal(armed.end, at("2026-10-30T04:59:00Z"));
  assert.equal(byWhat("Reboot to apply a kernel flag").end, at("2026-10-27T04:59:00Z"));
});

test("a row with no date is unreadable: shown neutrally, never stale", () => {
  const r = byWhat("Undated idea");
  assert.equal(r.unreadable, true);
  assert.equal(r.start, null);
  assert.equal(isStale(r, NOW), false);
});

test("stale = open, not ongoing, ended more than 1 h ago (the edge is exclusive)", () => {
  const r = byWhat("Short check"); // ends 2026-10-26 18:30 local = 23:30Z
  assert.equal(r.end, at("2026-10-26T23:30:00Z"));
  assert.equal(isStale(r, r.end + 3_600_000), false, "exactly 1 h after: not yet");
  assert.equal(isStale(r, r.end + 3_600_001), true, "1 h and 1 ms after: stale");
  assert.equal(isStale(byWhat("Weekend helper"), NOW), true);
  assert.equal(isStale(byWhat("Long-context profiling window"), NOW), false, "running now");
  assert.equal(isStale(byWhat("Overnight benchmark sweep"), NOW), false, "upcoming");
});

test("caps: at most 2,000 table lines are read, and text past 1 MB is ignored", () => {
  const head = "## Reservations\n\n| when | what | owner |\n|---|---|---|\n";
  const many = head + Array.from({ length: LEDGER_MAX_LINES + 500 }, (_, i) => `| 2026-10-26 10:00 → 11:00 | row ${i} | alex |`).join("\n");
  assert.ok(parseLedger(many, { now: NOW, tz: TZ }).length <= LEDGER_MAX_LINES);
  const big = head + "| 2026-10-26 10:00 → 11:00 | first | alex |\n" + "x".repeat(LEDGER_MAX_BYTES) + "\n| 2026-10-26 10:00 → 11:00 | after the cap | alex |\n";
  const out = parseLedger(big, { now: NOW, tz: TZ });
  assert.ok(out.some((r) => r.what === "first"));
  assert.ok(!out.some((r) => r.what === "after the cap"));
});

test("long cells are cut down for display", () => {
  const t = "## Reservations\n\n| when | what | owner |\n|---|---|---|\n" + `| 2026-10-26 10:00 → 11:00 | ${"w".repeat(900)} | ${"o".repeat(300)} |\n`;
  const [r] = parseLedger(t, { now: NOW, tz: TZ });
  assert.ok(r.what.length <= 200);
  assert.ok(r.owner.length <= 80);
});

test("timing: a 100 KB cell of [ (the link regex's worst case) finishes under 200 ms", () => {
  const t = "## Reservations\n\n| when | what | owner |\n|---|---|---|\n" + `| 2026-10-26 10:00 → 11:00 | ${"[".repeat(100_000)} | alex |\n` + `| ${"[".repeat(3000)}](${"(".repeat(500)} | ${"[a](".repeat(250)} | alex |\n`;
  const t0 = Date.now();
  parseLedger(t, { now: NOW, tz: TZ });
  const ms = Date.now() - t0;
  assert.ok(ms < 200, `took ${ms} ms`);
});

test("timing: 2,000 lines of 1 MB worst-case cells finish under 200 ms", () => {
  const row = `| 2026-10-26 ${"[".repeat(240)} → ${"[".repeat(240)} | ${"[(".repeat(120)} | x |`;
  const t = "## Reservations\n\n| when | what | owner |\n|---|---|---|\n" + Array.from({ length: 2000 }, () => row).join("\n");
  const t0 = Date.now();
  parseLedger(t.slice(0, LEDGER_MAX_BYTES), { now: NOW, tz: TZ });
  const ms = Date.now() - t0;
  assert.ok(ms < 200, `took ${ms} ms`);
});

test("a line over 4 KB is skipped; a cell is cut to 1 KB before it is read", () => {
  const head = "## Reservations\n\n| when | what | owner |\n|---|---|---|\n";
  const long = `| 2026-10-26 10:00 → 11:00 | ${"w".repeat(5000)} | alex |`;
  assert.deepEqual(parseLedger(head + long + "\n", { now: NOW, tz: TZ }), []);
  const lateDate = `| ${"x".repeat(1100)} 2026-10-26 10:00 → 11:00 | thing | alex |`;
  const [r] = parseLedger(head + lateDate + "\n", { now: NOW, tz: TZ });
  assert.equal(r.unreadable, true, "a date past the first 1 KB of the cell is not read");
});

test("no Reservations section → no rows", () => {
  assert.deepEqual(parseLedger("# Notes\n\n| a | b |\n|---|---|\n| 1 | 2 |\n", { now: NOW, tz: TZ }), []);
});

test("the path comes only from CROW_BOX_LEDGER_PATH, with no fallback", () => {
  assert.equal(ledgerPath({}), null);
  assert.equal(ledgerPath({ HOME: "/home/someone", CROW_HOME: "/x" }), null);
  assert.equal(ledgerPath({ CROW_BOX_LEDGER_PATH: "/srv/ledger.md" }), "/srv/ledger.md");
  assert.equal(ledgerPath({ CROW_BOX_LEDGER_PATH: "relative.md" }), null, "an absolute path only");
});

test("readLedger: unset → null with no file access; missing → null; symlink, directory, FIFO → null; a regular file → rows", () => {
  const dir = mkdtempSync(join(tmpdir(), "crow-ledger-"));
  try {
    let calls = 0;
    const spyFs = new Proxy({}, { get() { calls++; throw new Error("no fs access expected"); } });
    assert.equal(readLedger({ env: {}, now: NOW, tz: TZ, fs: spyFs }), null);
    assert.equal(calls, 0);
    assert.equal(readLedger({ env: { CROW_BOX_LEDGER_PATH: join(dir, "missing.md") }, now: NOW, tz: TZ }), null);
    const real = join(dir, "ledger.md");
    writeFileSync(real, text);
    const link = join(dir, "link.md");
    symlinkSync(real, link);
    assert.equal(readLedger({ env: { CROW_BOX_LEDGER_PATH: link }, now: NOW, tz: TZ }), null, "a symlink is refused");
    mkdirSync(join(dir, "adir.md"));
    assert.equal(readLedger({ env: { CROW_BOX_LEDGER_PATH: join(dir, "adir.md") }, now: NOW, tz: TZ }), null);
    let fifo = null;
    try { execFileSync("mkfifo", [join(dir, "fifo.md")]); fifo = join(dir, "fifo.md"); } catch {}
    if (fifo) assert.equal(readLedger({ env: { CROW_BOX_LEDGER_PATH: fifo }, now: NOW, tz: TZ }), null, "a FIFO is refused (and never blocks)");
    const got = readLedger({ env: { CROW_BOX_LEDGER_PATH: real }, now: NOW, tz: TZ });
    assert.equal(got.path, real);
    assert.equal(got.rows.length, 19);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
