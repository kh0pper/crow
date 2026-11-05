/**
 * `auto_update_result_since` (audit N1c-1 follow-up — the stuck-transient fix).
 *
 * Every pending tick rewrites `auto_update_last_check`, so "this transient result
 * is older than 2x the interval" could never fire: a CI run still in progress
 * kept its check permanently fresh. auto-update.js now stamps
 * `auto_update_result_since` with the time the result's CLASSIFICATION CODE first
 * appeared, and leaves it alone while the same code keeps repeating; the Nest's
 * Updates card ages a transient result from that stamp.
 *
 * Driven through the module's OWN write path (checkForUpdates → saveSetting), not
 * a helper: the stamp is only correct if every result write goes past it. The
 * `git rev-parse --abbrev-ref HEAD` branch guard needs no origin, no fetch and no
 * lock, so a local fixture is enough, and `_setAppRootForTest` retargets the
 * module's git calls at it.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkForUpdates, _setAppRootForTest, _setDbForTest } from "../servers/gateway/auto-update.js";

// A successful update arms the gateway's restart chain, which must never happen
// inside a test process (both auto-update suites scrub these first).
delete process.env.INVOCATION_ID;
delete process.env.CROW_SUPERVISED;

const REAL_APP_ROOT = join(import.meta.dirname, "..");
const g = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "au-since-"));
  const work = join(root, "work");
  mkdirSync(work, { recursive: true });
  execFileSync("git", ["init", "-b", "main", work], { stdio: "pipe" });
  g(work, "config", "user.email", "t@t");
  g(work, "config", "user.name", "t");
  writeFileSync(join(work, "a.txt"), "one\n");
  g(work, "add", "a.txt");
  g(work, "commit", "-m", "c1");
  return { root, work, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/**
 * dashboard_settings with a map behind it: the by-key SELECT the stamp does
 * before writing sees the previous result, and every write is both stored and
 * recorded (so a test can prove a write did NOT happen).
 */
function settingsDb(initial = {}) {
  const rows = new Map(Object.entries(initial));
  const saved = {};
  const writes = [];
  return {
    rows,
    saved,
    writes,
    async execute({ sql, args }) {
      if (/^\s*SELECT value FROM dashboard_settings WHERE key = \?/.test(sql || "")) {
        const value = rows.get(args[0]);
        return { rows: value == null ? [] : [{ value }] };
      }
      if (/^\s*SELECT key, value FROM dashboard_settings WHERE key IN \(\?, \?\)/.test(sql || "")) {
        return { rows: args.filter((k) => rows.get(k) != null).map((k) => ({ key: k, value: rows.get(k) })) };
      }
      if (/INSERT INTO dashboard_settings/.test(sql || "")) {
        rows.set(args[0], args[1]);
        saved[args[0]] = args[1];
        writes.push(args[0]);
      }
      return { rows: [] };
    },
  };
}

test("auto_update_result_since: the same code keeps the first stamp, a different code resets it", async () => {
  const fx = fixture();
  const db = settingsDb();
  try {
    g(fx.work, "checkout", "-b", "feature/x");
    _setAppRootForTest(fx.work);
    _setDbForTest(db);

    // Tick 1 — "Skipped: not on main" (code not-on-main): a result exists, so a
    // stamp exists.
    const first = await checkForUpdates();
    assert.equal(first.skipped, "not-on-main");
    const firstSince = db.rows.get("auto_update_result_since");
    assert.ok(firstSince, "the first recorded result stamps auto_update_result_since");
    assert.ok(Number.isFinite(Date.parse(firstSince)), `since is an ISO time: ${firstSince}`);
    assert.match(db.rows.get("auto_update_last_result"), /not on main/);

    // Six hours later the SAME code repeats (another branch, same condition):
    // the clock must not restart — that is the whole point, because last_check
    // does restart on every tick.
    const pinned = new Date(Date.parse(firstSince) - 6 * 60 * 60 * 1000).toISOString();
    db.rows.set("auto_update_result_since", pinned);
    db.writes.length = 0;
    g(fx.work, "checkout", "-b", "feature/y");
    const repeated = await checkForUpdates();
    assert.equal(repeated.skipped, "not-on-main");
    assert.match(db.rows.get("auto_update_last_result"), /feature\/y/, "a new message, same code");
    assert.ok(db.rows.has("auto_update_last_check"), "the check time was rewritten as usual");
    assert.equal(db.rows.get("auto_update_result_since"), pinned, "the same code keeps the first stamp");
    assert.ok(!db.writes.includes("auto_update_result_since"), "no re-stamp write happened");

    // A DIFFERENT code (here: git cannot read the branch at all) resets it, so
    // the next result is aged from its own first appearance.
    db.writes.length = 0;
    _setAppRootForTest(join(fx.root, "not-a-checkout"));
    const changed = await checkForUpdates();
    assert.equal(changed.skipped, "not-on-main");
    assert.match(db.rows.get("auto_update_last_result"), /cannot determine branch/);
    assert.ok(db.writes.includes("auto_update_result_since"), "a changed code re-stamps");
    const resetted = db.rows.get("auto_update_result_since");
    assert.notEqual(resetted, pinned, "the stamp moved");
    assert.ok(Date.parse(resetted) > Date.parse(pinned), "…to now, not to the old value");
  } finally {
    _setAppRootForTest(REAL_APP_ROOT);
    _setDbForTest(null);
    fx.cleanup();
  }
});

test("auto_update_result_since: an unreadable previous result re-stamps instead of aging an old one", async () => {
  const fx = fixture();
  const writes = [];
  const db = {
    async execute({ sql, args }) {
      if (/^\s*SELECT value FROM dashboard_settings WHERE key = \?/.test(sql || "")) {
        throw new Error("db is busy");
      }
      if (/INSERT INTO dashboard_settings/.test(sql || "")) writes.push(args[0]);
      return { rows: [] };
    },
  };
  try {
    g(fx.work, "checkout", "-b", "feature/x");
    _setAppRootForTest(fx.work);
    _setDbForTest(db);
    await checkForUpdates();
    // The comparison could not be made, so the ambiguous case lands on the safe
    // side: an old `since` must never outlive the result it described and turn
    // into a false warn.
    assert.ok(writes.includes("auto_update_result_since"));
  } finally {
    _setAppRootForTest(REAL_APP_ROOT);
    _setDbForTest(null);
    fx.cleanup();
  }
});
test("auto_update_result_since: an install already on a result with no stamp gets one on the next tick", async () => {
  const fx = fixture();
  // Deployed onto a gateway already stuck on the same code: a result, no stamp.
  const db = settingsDb({ auto_update_last_result: "Skipped: not on main (on 'feature/old')" });
  try {
    g(fx.work, "checkout", "-b", "feature/x");
    _setAppRootForTest(fx.work);
    _setDbForTest(db);
    const r = await checkForUpdates();
    assert.equal(r.skipped, "not-on-main");
    assert.ok(db.writes.includes("auto_update_result_since"), "the same code, but no stamp yet: stamp it");
    assert.ok(Number.isFinite(Date.parse(db.rows.get("auto_update_result_since"))));
  } finally {
    _setAppRootForTest(REAL_APP_ROOT);
    _setDbForTest(null);
    fx.cleanup();
  }
});
