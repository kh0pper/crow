// tests/box-reserve-cli.test.js
//
// scripts/ops/box-reserve.mjs — the operator's side of the one box calendar.
// Exercised as a real child process against temp CROW_BOX_RESERVATION_PATH and
// CROW_BOX_SCHEDULE_PATH files (the same env seams the gateway and the lab's
// window scripts honor), so no test can touch real state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(REPO, "scripts", "ops", "box-reserve.mjs");
const dir = mkdtempSync(join(tmpdir(), "box-reserve-cli-"));
const path = join(dir, "reservation.json");
const sched = join(dir, "box-schedule.json");

const DAY_MS = 86_400_000;

/** A pair of box state paths in a directory of its own. */
function freshPaths() {
  const scratch = mkdtempSync(join(tmpdir(), "box-reserve-cli-"));
  return { holdPath: join(scratch, "reservation.json"), schedPath: join(scratch, "box-schedule.json") };
}

function runIn(paths, ...args) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    env: {
      ...process.env,
      CROW_BOX_RESERVATION_PATH: paths.holdPath,
      CROW_BOX_SCHEDULE_PATH: paths.schedPath,
    },
    encoding: "utf8",
  });
  return { code: r.status, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

function run(...args) {
  return runIn({ holdPath: path, schedPath: sched }, ...args);
}

/** The booking id from a `booked <id> …` line. */
function idOf(out) {
  return out.split(/\s+/)[1];
}

test("no args / --help -> usage on stderr, exit 2", () => {
  const r = run();
  assert.equal(r.code, 2);
  assert.match(r.err, /box-reserve hold --owner/);
  assert.equal(run("--help").code, 2);
});

test("status with no reservation prints 'none', exit 0", () => {
  const r = run("status");
  assert.equal(r.code, 0);
  assert.equal(r.out, "none");
});

test("hold writes the file (default 480 min), status prints it as JSON", () => {
  const before = Date.now();
  const r = run("hold", "--owner", "casey", "--reason", "serving dsv4 tonight", "--allow", "crow-embed,my-heavy");
  assert.equal(r.code, 0, r.err);
  assert.ok(existsSync(path));
  const rec = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(rec.owner, "casey");
  assert.equal(rec.reason, "serving dsv4 tonight");
  assert.deepEqual(rec.allow, ["crow-embed", "my-heavy"]);
  const held = Date.parse(rec.expires_at) - Date.parse(rec.started_at);
  assert.equal(held, 480 * 60_000);
  assert.ok(Date.parse(rec.started_at) >= before - 1000);
  const s = run("status");
  assert.equal(s.code, 0);
  assert.equal(JSON.parse(s.out).owner, "casey");
});

test("hold beyond 8h without --force fails (exit 1) and leaves the existing file untouched", () => {
  const prev = readFileSync(path, "utf8");
  const r = run("hold", "--owner", "casey", "--reason", "long", "--minutes", "600");
  assert.equal(r.code, 1);
  assert.match(r.err, /8h/);
  assert.equal(readFileSync(path, "utf8"), prev);
});

test("hold beyond 8h WITH --force succeeds", () => {
  const r = run("hold", "--owner", "casey", "--reason", "long", "--minutes", "600", "--force");
  assert.equal(r.code, 0, r.err);
  const rec = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(Date.parse(rec.expires_at) - Date.parse(rec.started_at), 600 * 60_000);
});

test("hold without --owner is a usage error (exit 2)", () => {
  const r = run("hold", "--reason", "x");
  assert.equal(r.code, 2);
});

test("release removes the file; a second release reports none and still exits 0", () => {
  assert.equal(run("release").code, 0);
  assert.equal(existsSync(path), false);
  const again = run("release");
  assert.equal(again.code, 0);
  assert.match(again.out, /none/);
  assert.equal(run("status").out, "none");
});

// ---------------------------------------------------------------------------
// The calendar subcommands.

test("plain hold still works for legacy usage and creates an active booking", () => {
  const p = freshPaths();
  const held = runIn(p, "hold", "--owner", "alex", "--reason", "serving dsv4 tonight", "--minutes", "120");
  assert.equal(held.code, 0, held.err);
  assert.match(held.out, /^held by alex until \S+ \(.*reservation\.json\)$/);
  const rec = JSON.parse(readFileSync(p.holdPath, "utf8"));
  assert.equal(rec.owner, "alex");
  assert.equal(rec.reason, "serving dsv4 tonight");
  assert.equal(rec.kind, "manual");
  const cal = JSON.parse(runIn(p, "calendar", "--json").out);
  const live = cal.filter((booking) => booking.status === "active");
  assert.equal(live.length, 1);
  assert.equal(live[0].owner, "alex");
  assert.equal(live[0].kind, "manual");
  assert.equal(live[0].mode, "exclusive");
  assert.equal(rec.booking_id, live[0].id);
});

test("hold over a foreign hold exits 1 naming the holder", () => {
  const p = freshPaths();
  assert.equal(runIn(p, "hold", "--owner", "alex", "--reason", "window", "--minutes", "60").code, 0);
  const before = readFileSync(p.holdPath, "utf8");
  const r = runIn(p, "hold", "--owner", "casey", "--reason", "mine", "--minutes", "30");
  assert.equal(r.code, 1);
  assert.match(r.err, /alex/);
  assert.equal(readFileSync(p.holdPath, "utf8"), before);
});

test("release --owner by non-holder exits 1", () => {
  const p = freshPaths();
  assert.equal(runIn(p, "hold", "--owner", "alex", "--minutes", "60").code, 0);
  const r = runIn(p, "release", "--owner", "casey");
  assert.equal(r.code, 1);
  assert.match(r.err, /alex/);
  assert.ok(existsSync(p.holdPath));
});

test("book conflict exits 1 and prints the conflicting booking id", () => {
  const p = freshPaths();
  const first = runIn(p, "book", "--owner", "lab", "--kind", "window", "--start", "now", "--minutes", "120");
  assert.equal(first.code, 0, first.err);
  const id = idOf(first.out);
  assert.match(id, /^bk_[0-9a-f]{12}$/);
  const second = runIn(p, "book", "--owner", "alex", "--kind", "window", "--start", "now", "--minutes", "30");
  assert.equal(second.code, 1);
  assert.match(second.err, new RegExp(`conflict with ${id} \\(lab, `));
});

test("calendar --markdown prints a table with when/owner/kind/mode/status/approval columns", () => {
  const p = freshPaths();
  const booked = runIn(p, "book", "--owner", "lab", "--kind", "window", "--start", "now", "--minutes", "60");
  assert.equal(booked.code, 0, booked.err);
  const r = runIn(p, "calendar", "--markdown");
  assert.equal(r.code, 0, r.err);
  const lines = r.out.split("\n");
  assert.equal(lines[0], "| when (local) | owner | kind | mode | status | approval |");
  assert.equal(lines[1], "|---|---|---|---|---|---|");
  assert.equal(lines.length, 3);
  const cells = lines[2].split("|").map((cell) => cell.trim());
  assert.match(cells[1], /^\w{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2}-\d{2}:\d{2}$/);
  assert.deepEqual(cells.slice(2, 7), ["lab", "window", "exclusive", "booked", "not_needed"]);
});

test("approve then hold --booking activates", () => {
  const p = freshPaths();
  const booked = runIn(p, "book", "--owner", "alex", "--kind", "manual", "--start", "now", "--minutes", "60", "--needs-approval");
  assert.equal(booked.code, 0, booked.err);
  const id = idOf(booked.out);
  const early = runIn(p, "hold", "--booking", id);
  assert.equal(early.code, 1);
  assert.match(early.err, /booking_not_approved/);
  assert.equal(existsSync(p.holdPath), false);
  const approved = runIn(p, "approve", id);
  assert.equal(approved.code, 0, approved.err);
  const held = runIn(p, "hold", "--booking", id);
  assert.equal(held.code, 0, held.err);
  assert.match(held.out, /^held by alex until /);
  const rec = JSON.parse(readFileSync(p.holdPath, "utf8"));
  assert.equal(rec.booking_id, id);
  const stored = JSON.parse(runIn(p, "calendar", "--json").out).find((booking) => booking.id === id);
  assert.equal(stored.status, "active");
  assert.equal(stored.approval.state, "approved");
  assert.equal(stored.approval.by, "owner");
});

test("renew keeps started_at", () => {
  const p = freshPaths();
  assert.equal(runIn(p, "hold", "--owner", "alex", "--minutes", "60").code, 0);
  const before = JSON.parse(readFileSync(p.holdPath, "utf8"));
  const r = runIn(p, "renew", "--owner", "alex", "--minutes", "60");
  assert.equal(r.code, 0, r.err);
  const after = JSON.parse(readFileSync(p.holdPath, "utf8"));
  assert.equal(after.started_at, before.started_at);
  assert.equal(r.out, `renewed until ${after.expires_at}`);
  assert.ok(Date.parse(after.expires_at) >= Date.parse(before.expires_at));
});

test("bare release frees a legacy hold", () => {
  const p = freshPaths();
  const now = Date.now();
  writeFileSync(p.holdPath, JSON.stringify({
    owner: "pi-lab-dsv4",
    reason: "serving dsv4",
    started_at: new Date(now).toISOString(),
    expires_at: new Date(now + DAY_MS).toISOString(),
    allow: ["crow-embed"],
  }, null, 2) + "\n");
  const r = runIn(p, "release");
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^released .*reservation\.json$/);
  assert.equal(existsSync(p.holdPath), false);
  // nothing to mark: the legacy record names no booking, so the calendar stays absent
  assert.equal(existsSync(p.schedPath), false);
});

test("bare release refuses a gpu-job hold", () => {
  const p = freshPaths();
  assert.equal(runIn(p, "hold", "--owner", "gpujob:abc", "--kind", "gpu-job", "--reason", "render", "--minutes", "30").code, 0);
  const r = runIn(p, "release");
  assert.equal(r.code, 1);
  assert.match(r.err, /--force/);
  assert.ok(existsSync(p.holdPath));
});

test("release --force removes a gpu-job hold", () => {
  const p = freshPaths();
  assert.equal(runIn(p, "hold", "--owner", "gpujob:abc", "--kind", "gpu-job", "--minutes", "30").code, 0);
  const r = runIn(p, "release", "--force");
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^released /);
  assert.equal(existsSync(p.holdPath), false);
  const live = JSON.parse(runIn(p, "calendar", "--json").out)
    .filter((booking) => booking.status === "booked" || booking.status === "active");
  assert.deepEqual(live, []);
});

test("a failed hold leaves no ghost booking", () => {
  const p = freshPaths();
  const r = runIn(p, "hold", "--owner", "alex", "--minutes", "600");
  assert.equal(r.code, 1);
  assert.match(r.err, /8h/);
  const cal = runIn(p, "calendar", "--json");
  assert.equal(cal.code, 0, cal.err);
  assert.deepEqual(JSON.parse(cal.out), []);
});

test("plain hold preempts a gpujob: booking but refuses to overlap a window booking", () => {
  const p = freshPaths();
  const job = runIn(p, "book", "--owner", "gpujob:abc", "--kind", "gpu-job", "--start", "now", "--minutes", "120");
  assert.equal(job.code, 0, job.err);
  const jobId = idOf(job.out);
  const held = runIn(p, "hold", "--owner", "alex", "--reason", "urgent", "--minutes", "30");
  assert.equal(held.code, 0, held.err);
  const cal = JSON.parse(runIn(p, "calendar", "--json").out);
  assert.equal(cal.find((booking) => booking.id === jobId).status, "lapsed");

  // the live gpu-job hold is taken over too
  const h = freshPaths();
  assert.equal(runIn(h, "hold", "--owner", "gpujob:xyz", "--kind", "gpu-job", "--minutes", "60").code, 0);
  const took = runIn(h, "hold", "--owner", "alex", "--reason", "mine", "--minutes", "30");
  assert.equal(took.code, 0, took.err);
  assert.equal(JSON.parse(readFileSync(h.holdPath, "utf8")).owner, "alex");

  // another owner's window booking is refused, by name
  const w = freshPaths();
  assert.equal(runIn(w, "book", "--owner", "lab", "--kind", "window", "--start", "now", "--minutes", "120").code, 0);
  const refused = runIn(w, "hold", "--owner", "alex", "--reason", "mine", "--minutes", "30");
  assert.equal(refused.code, 1);
  assert.match(refused.err, /lab/);
  assert.equal(existsSync(w.holdPath), false);
});

test("status shows next_bookings", () => {
  const p = freshPaths();
  const start = new Date(Date.now() + 2 * 3_600_000).toISOString();
  assert.equal(runIn(p, "book", "--owner", "lab", "--kind", "window", "--start", start, "--minutes", "60").code, 0);
  const idle = runIn(p, "status");
  assert.equal(idle.code, 0, idle.err);
  const idleJson = JSON.parse(idle.out);
  assert.equal(idleJson.active, null);
  assert.equal(idleJson.next_bookings.length, 1);
  assert.equal(idleJson.next_bookings[0].owner, "lab");
  assert.equal(runIn(p, "hold", "--owner", "alex", "--minutes", "30").code, 0);
  const withHold = runIn(p, "status");
  assert.equal(withHold.code, 0, withHold.err);
  const json = JSON.parse(withHold.out);
  assert.equal(json.owner, "alex");
  assert.equal(json.next_bookings.length, 1);
  assert.equal(json.next_bookings[0].owner, "lab");
});

test("daily book then calendar --markdown shows the series", () => {
  const p = freshPaths();
  const booked = runIn(p, "book", "--owner", "pi-lab-nightly-audit", "--kind", "audit", "--mode", "exclusive",
    "--daily", "02:15-04:15", "--reason", "pi-lab nightly audit");
  assert.equal(booked.code, 0, booked.err);
  assert.match(booked.out, /^booked bk_[0-9a-f]{12} daily 02:15-04:15$/);
  const md = runIn(p, "calendar", "--markdown");
  assert.equal(md.code, 0, md.err);
  const rows = md.out.split("\n").slice(2);
  assert.ok(rows.length >= 1);
  assert.ok(rows.every((row) => row.includes("daily 02:15-04:15")));
  assert.ok(rows[0].includes("pi-lab-nightly-audit"));
  assert.ok(rows[0].includes("audit"));
});