/**
 * L0.3 — the update quarantine marker (audit N1c-3).
 *
 * A commit this host already rolled back must never be pulled again, or the
 * updater re-rolls it on every tick. The record lives in the GIT DIR (shared by
 * co-hosted instances, untouched by `reset`/`clean`), names full 40-hex shas,
 * and clears itself when main moves past the bad commit.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkForUpdates, _setAppRootForTest, _setDbForTest } from "../servers/gateway/auto-update.js";
import {
  activeUpdateQuarantine, evaluateUpdateQuarantine, quarantineExpired, quarantinePath,
  readUpdateQuarantine, updateQuarantineHeldAtHead, writeUpdateQuarantine,
} from "../servers/shared/update-quarantine.js";

delete process.env.INVOCATION_ID;
delete process.env.CROW_SUPERVISED;

const REAL_APP_ROOT = join(import.meta.dirname, "..");
const g = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();

const _fixtures = [];
process.on("exit", () => { for (const f of _fixtures) { try { f.cleanup(); } catch {} } });

/**
 * A bare origin plus a clone one commit behind it. The pulled tree carries NO
 * import-check seam, so these tests stay about the marker: the update itself is
 * allowed to complete.
 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "uq-"));
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  execFileSync("git", ["init", "--bare", "-b", "main", origin], { stdio: "pipe" });
  execFileSync("git", ["clone", origin, work], { stdio: "pipe" });
  g(work, "config", "user.email", "t@t");
  g(work, "config", "user.name", "t");
  mkdirSync(join(work, "scripts"), { recursive: true });
  mkdirSync(join(work, "servers", "gateway"), { recursive: true });
  writeFileSync(join(work, "scripts", "init-db.js"), "process.exit(0);\n");
  writeFileSync(join(work, "servers", "gateway", "index.js"), "process.exit(0);\n");
  writeFileSync(join(work, "a.txt"), "one\n");
  g(work, "add", "-A");
  g(work, "commit", "-m", "c1");
  g(work, "push", "origin", "main");
  const f = {
    root, origin, work, gitDir: join(work, ".git"), prev: g(work, "rev-parse", "HEAD"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
  _fixtures.push(f);
  return f;
}

/** Land a commit on origin only; the clone stays behind (a real deploy). */
function pushToOrigin(fx, name, content) {
  const pusher = mkdtempSync(join(fx.root, "pusher-"));
  execFileSync("git", ["clone", fx.origin, pusher], { stdio: "pipe" });
  g(pusher, "config", "user.email", "t@t");
  g(pusher, "config", "user.name", "t");
  writeFileSync(join(pusher, name), content);
  g(pusher, "add", name);
  g(pusher, "commit", "-m", `up ${name}`);
  g(pusher, "push", "origin", "main");
  return g(pusher, "rev-parse", "HEAD");
}

function stubDb() {
  const settings = new Map();
  const notifications = [];
  return {
    settings,
    notifications,
    async execute({ sql, args = [] } = {}) {
      if (/^\s*SELECT value FROM dashboard_settings WHERE key = \?/.test(sql || "")) {
        return { rows: settings.has(args[0]) ? [{ value: settings.get(args[0]) }] : [] };
      }
      if (/SELECT key, value FROM dashboard_settings WHERE key IN \(\?, \?\)/.test(sql || "")) {
        return { rows: args.filter((k) => settings.has(k)).map((k) => ({ key: k, value: settings.get(k) })) };
      }
      if (/INSERT INTO dashboard_settings/.test(sql || "")) {
        settings.set(args[0], args[1]);
        return { rows: [], lastInsertRowid: 0 };
      }
      if (/INSERT INTO notifications/.test(sql || "")) {
        notifications.push({
          type: args[0], source: args[1], title: args[2], body: args[3],
          priority: args[4], action_url: args[5], metadata: args[6],
        });
        return { rows: [], lastInsertRowid: notifications.length };
      }
      return { rows: [] };
    },
  };
}

function cleanup() {
  _setAppRootForTest(REAL_APP_ROOT);
  _setDbForTest(null);
}

test("the marker blocks the pull when origin/main is the quarantined sha", async () => {
  const f = fixture();
  const db = stubDb();
  try {
    const bad = pushToOrigin(f, "b.txt", "two\n");
    writeUpdateQuarantine({ gitDir: f.gitDir, sha: bad, previous: f.prev, reason: "import-check" });
    _setAppRootForTest(f.work);
    _setDbForTest(db);

    const r = await checkForUpdates();

    assert.equal(r.skipped, "update-quarantined", JSON.stringify(r));
    assert.equal(db.settings.get("auto_update_last_result"),
      `Skipped: update quarantined (${bad.slice(0, 9)}, import-check); waiting for a newer commit on main`);
    assert.equal(g(f.work, "rev-parse", "HEAD"), f.prev, "the quarantined sha was never pulled");
    assert.ok(!existsSync(join(f.work, "b.txt")), "not a single file of it landed");
  } finally { cleanup(); }
});

test("the marker clears when main moves past it", async () => {
  const f = fixture();
  const db = stubDb();
  try {
    const bad = pushToOrigin(f, "b.txt", "two\n");
    writeUpdateQuarantine({ gitDir: f.gitDir, sha: bad, previous: f.prev, reason: "import-check" });
    const fix = pushToOrigin(f, "c.txt", "three\n");
    _setAppRootForTest(f.work);
    _setDbForTest(db);

    const r = await checkForUpdates();

    assert.equal(r.updated, true, JSON.stringify(r));
    assert.equal(g(f.work, "rev-parse", "HEAD"), fix, "a commit past the bad one is taken normally");
    assert.equal(readUpdateQuarantine({ gitDir: f.gitDir }), null, "the spent record is removed");
  } finally { cleanup(); }
});

test("a transient reason expires after its 6 h TTL", async () => {
  const f = fixture();
  const db = stubDb();
  try {
    const bad = pushToOrigin(f, "b.txt", "two\n");
    // Written 7 h ago: a timeout rollback must not pause updates indefinitely.
    writeUpdateQuarantine({
      gitDir: f.gitDir, sha: bad, previous: f.prev, reason: "import-timeout",
      now: Date.now() - 7 * 60 * 60 * 1000,
    });
    assert.ok(readUpdateQuarantine({ gitDir: f.gitDir }), "the record is still there (readers decide)");
    _setAppRootForTest(f.work);
    _setDbForTest(db);

    const r = await checkForUpdates();

    assert.equal(r.updated, true, `an expired quarantine must not block: ${JSON.stringify(r)}`);
    assert.equal(g(f.work, "rev-parse", "HEAD"), bad);
  } finally { cleanup(); }
});

test("a blocked deps-failed marker regains its TTL once HEAD moves off it", async () => {
  // A blocked rollback persists its marker WITHOUT an expiry because the refused
  // commit is still checked out. The operator then moves main back by hand, so
  // HEAD is no longer that sha: a machine-side reason (a registry outage is not a
  // bad commit) must expire from the marker's own `at` and the same commit must
  // be retried. Without that, a failed install pauses updates until main moves
  // past a commit main does not even point at any more.
  const f = fixture();
  const db = stubDb();
  try {
    const bad = pushToOrigin(f, "b.txt", "two\n");
    g(f.work, "pull", "--ff-only", "origin", "main"); // the checkout HOLDS the refused sha
    writeUpdateQuarantine({
      gitDir: f.gitDir, sha: bad, previous: f.prev, reason: "deps-failed",
      now: Date.now() - 7 * 60 * 60 * 1000, persist: true,
    });
    const marker = readUpdateQuarantine({ gitDir: f.gitDir });
    assert.equal(marker.reason, "deps-failed");
    assert.equal(marker.expires_at, undefined, "a blocked rollback persists without a TTL");
    // While the refused sha IS checked out the exemption holds, whatever the age.
    assert.equal(activeUpdateQuarantine({ gitDir: f.gitDir, localHeadSha: bad })?.sha, bad,
      "a checkout still sitting on the refused commit never times out");
    assert.equal(evaluateUpdateQuarantine({ gitDir: f.gitDir, originHeadSha: bad, localHeadSha: bad }).blocked, true);

    // The operator puts main back: HEAD is the previous healthy commit.
    g(f.work, "reset", "--keep", f.prev);
    _setAppRootForTest(f.work);
    _setDbForTest(db);

    const r = await checkForUpdates();

    assert.equal(r.updated, true,
      `a machine-side marker expires once HEAD moved off it: ${JSON.stringify(r)}`);
    assert.equal(g(f.work, "rev-parse", "HEAD"), bad, "the same commit is pulled again");
    assert.equal(readUpdateQuarantine({ gitDir: f.gitDir }), null, "the spent record is cleared");
  } finally { cleanup(); }
});

test("a manual pull onto a successful rollback's marker sha does not wedge updates", async () => {
  // Round 4: "held at HEAD" belongs to a BLOCKED rollback only. A SUCCESSFUL
  // deps-failed rollback leaves an ordinary TTL marker for the sha it moved the
  // tree OFF. If the operator fixes the registry and fast-forwards HEAD onto
  // that same commit, HEAD names the marker — but the operator chose it, so the
  // round-2 rules apply: main moving past it clears it and the pull goes ahead.
  // Round 3 froze ANY marker naming HEAD, so this path recorded "Update rollback
  // blocked: … is still checked out" on every tick and never pulled again until
  // the marker was deleted by hand.
  const f = fixture();
  const db = stubDb();
  try {
    const bad = pushToOrigin(f, "b.txt", "two\n");
    // The rollback wrote an ordinary marker (6 h TTL, no `held`) and its reset
    // left the checkout on the previous commit — the fixture already is.
    writeUpdateQuarantine({ gitDir: f.gitDir, sha: bad, previous: f.prev, reason: "deps-failed" });
    const written = readUpdateQuarantine({ gitDir: f.gitDir });
    assert.equal(written.held, undefined, "a rollback that moved the tree back does not write a held marker");
    assert.ok(Date.parse(written.expires_at) > Date.now(), "…it is an ordinary marker with the 6 h TTL");
    assert.equal(g(f.work, "rev-parse", "HEAD"), f.prev, "fixture: the rollback left the checkout on the previous sha");

    // The operator fixes the registry and pulls that same commit by hand.
    g(f.work, "pull", "--ff-only", "origin", "main");
    assert.equal(g(f.work, "rev-parse", "HEAD"), bad, "the operator put the quarantined commit on HEAD by hand");

    // Main then moves on to a newer commit.
    const fix = pushToOrigin(f, "c.txt", "three\n");
    assert.notEqual(fix, bad);
    _setAppRootForTest(f.work);
    _setDbForTest(db);

    const r = await checkForUpdates();

    assert.equal(r.updated, true,
      `main moved past it, so the marker clears and the pull goes ahead: ${JSON.stringify(r)}`);
    assert.equal(r.blocked, undefined, JSON.stringify(r));
    assert.equal(r.skipped, undefined, JSON.stringify(r));
    assert.equal(g(f.work, "rev-parse", "HEAD"), fix, "the newer commit is pulled normally");
    assert.equal(readUpdateQuarantine({ gitDir: f.gitDir }), null, "the spent marker is removed");
  } finally { cleanup(); }
});

test("a reason that is not transient keeps waiting for main even after HEAD moved", async () => {
  // The TTL is only for machine-side reasons. A sha whose CODE does not load is
  // never retried just because the operator reset the checkout.
  const f = fixture();
  try {
    const bad = pushToOrigin(f, "b.txt", "two\n");
    writeUpdateQuarantine({
      gitDir: f.gitDir, sha: bad, previous: f.prev, reason: "import-check",
      now: Date.now() - 7 * 60 * 60 * 1000, persist: true,
    });
    assert.equal(quarantineExpired(readUpdateQuarantine({ gitDir: f.gitDir }), Date.now(), f.prev), false);
    const uq = evaluateUpdateQuarantine({ gitDir: f.gitDir, originHeadSha: bad, localHeadSha: f.prev });
    assert.equal(uq.blocked, true, "an import-check marker waits for main, not for the clock");
    assert.ok(existsSync(quarantinePath(f.gitDir)), "and is not cleared");
  } finally { f.cleanup(); }
});

test("a marker that expired this tick is not reported as blocked", async () => {
  // The up-to-date defence used to hold a pre-evaluation COPY of the marker, so
  // a marker the evaluator had just expired AND DELETED still produced "Update
  // rollback blocked" — plus a failure bell — for exactly one tick. (The marker
  // here names a commit the checkout does NOT hold: a marker naming HEAD is never
  // expired away at all — see the round-3 tests below.)
  const f = fixture();
  const db = stubDb();
  try {
    // A real commit that HEAD is then moved OFF, so the expired marker is spent.
    writeFileSync(join(f.work, "g.txt"), "gone\n");
    g(f.work, "add", "g.txt");
    g(f.work, "commit", "-m", "away");
    const away = g(f.work, "rev-parse", "HEAD");
    g(f.work, "reset", "--hard", f.prev); // HEAD == origin/main == f.prev
    // An expiring marker (the shape a successful rollback writes) that ran out
    // one minute ago.
    writeUpdateQuarantine({
      gitDir: f.gitDir, sha: away, previous: f.prev, reason: "import-timeout",
      now: Date.now() - 6 * 60 * 60 * 1000 - 60 * 1000,
    });
    const marker = readUpdateQuarantine({ gitDir: f.gitDir });
    assert.ok(Date.parse(marker.expires_at) <= Date.now(), "the fixture marker really is expired");
    _setAppRootForTest(f.work);
    _setDbForTest(db);

    const r = await checkForUpdates();

    assert.equal(db.settings.get("auto_update_last_result"), "Up to date",
      "an expired and cleared marker is not a blocked rollback");
    assert.equal(r.updated, false);
    assert.equal(r.blocked, undefined, JSON.stringify(r));
    assert.equal(db.notifications.length, 0, `no false failure bell: ${JSON.stringify(db.notifications)}`);
    assert.equal(readUpdateQuarantine({ gitDir: f.gitDir }), null);
  } finally { cleanup(); }
});

test("the evaluator never deletes a HELD marker whose sha is HEAD — main moved or expired", () => {
  // Round 3: a refused commit that is STILL CHECKED OUT must stay refused. The
  // "main moved past it" and "it expired" cleanups both used to delete the
  // record while HEAD was its sha, leaving the refused commit checked out with
  // nothing left to refuse it (a peer would then migrate and restart into it).
  // Only a marker a BLOCKED rollback wrote carries that rule (`held: true`, set
  // by `persist`); an unflagged marker naming HEAD is ordinary (see the manual-
  // pull test below).
  const f = fixture();
  try {
    const bad = pushToOrigin(f, "b.txt", "two\n");
    g(f.work, "pull", "--ff-only", "origin", "main"); // HEAD == bad
    // A blocked rollback's marker, recorded by a release that still carried the
    // TTL for the reason: held AND expired.
    writeFileSync(quarantinePath(f.gitDir), JSON.stringify({
      v: 1, sha: bad, previous: f.prev, reason: "import-timeout",
      at: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(), by: "test",
      expires_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      held: true,
    }));
    const fix = pushToOrigin(f, "c.txt", "three\n"); // origin/main moved PAST bad
    assert.notEqual(fix, bad);

    // (a) main moved past it, HEAD still the refused sha: reported, not cleared.
    const headNow = g(f.work, "rev-parse", "HEAD");
    assert.equal(headNow, bad, "fixture: the checkout holds the refused sha");
    let uq = evaluateUpdateQuarantine({ gitDir: f.gitDir, originHeadSha: fix, localHeadSha: headNow });
    assert.equal(uq.blocked, false, JSON.stringify(uq));
    assert.equal(uq.heldAtHead, true, JSON.stringify(uq));
    assert.ok(existsSync(quarantinePath(f.gitDir)), "the marker survives while HEAD is its sha");
    assert.equal(readUpdateQuarantine({ gitDir: f.gitDir }).sha, bad);

    // (b) an unreadable local HEAD may still be that sha: no cleanup on a guess.
    uq = evaluateUpdateQuarantine({ gitDir: f.gitDir, originHeadSha: fix, localHeadSha: "" });
    assert.equal(uq.heldAtHead, true, JSON.stringify(uq));
    assert.ok(existsSync(quarantinePath(f.gitDir)), "an unreadable HEAD never clears the marker");

    // (c) the marker's own expiry cannot delete it either, and it stays ACTIVE
    // for the convergence gate whatever its age.
    assert.ok(Date.parse(readUpdateQuarantine({ gitDir: f.gitDir }).expires_at) <= Date.now());
    assert.equal(activeUpdateQuarantine({ gitDir: f.gitDir, localHeadSha: bad })?.sha, bad,
      "a marker naming HEAD is active however expired it is");
    assert.equal(updateQuarantineHeldAtHead({ gitDir: f.gitDir, localHeadSha: bad })?.sha, bad);
    uq = evaluateUpdateQuarantine({ gitDir: f.gitDir, originHeadSha: fix, localHeadSha: bad });
    assert.equal(uq.heldAtHead, true, JSON.stringify(uq));
    assert.ok(existsSync(quarantinePath(f.gitDir)));

    // (d) once HEAD is OFF the sha the round-2 rules return: the expired record
    // is cleared, and so is a spent one main has moved past.
    uq = evaluateUpdateQuarantine({ gitDir: f.gitDir, originHeadSha: fix, localHeadSha: f.prev });
    assert.equal(uq.expired, true, JSON.stringify(uq));
    assert.equal(uq.heldAtHead, undefined);
    assert.ok(!existsSync(quarantinePath(f.gitDir)), "an expired marker the checkout moved off is spent");

    writeUpdateQuarantine({ gitDir: f.gitDir, sha: bad, previous: f.prev, reason: "import-check" });
    uq = evaluateUpdateQuarantine({ gitDir: f.gitDir, originHeadSha: fix, localHeadSha: f.prev });
    assert.equal(uq.cleared, true, JSON.stringify(uq));
    assert.equal(uq.heldAtHead, undefined);
    assert.ok(!existsSync(quarantinePath(f.gitDir)), "a marker main moved past is spent once HEAD is off it");
  } finally { f.cleanup(); }
});

test("a marker whose sha is still checked out blocks the tick when main moves past it", async () => {
  // Round 3: origin/main moving on used to delete the marker and pull the newer
  // commit while HEAD was STILL the refused sha. The refused commit stayed
  // checked out (so the next restart boots it) with no marker left to stop any
  // peer, and convergence was free to restart into it.
  const f = fixture();
  const db = stubDb();
  try {
    const bad = pushToOrigin(f, "b.txt", "two\n");
    g(f.work, "pull", "--ff-only", "origin", "main"); // the checkout HOLDS the bad sha
    writeUpdateQuarantine({
      gitDir: f.gitDir, sha: bad, previous: f.prev, reason: "deps-failed", persist: true,
    });
    const fix = pushToOrigin(f, "c.txt", "three\n"); // a NEWER commit on main
    assert.notEqual(fix, bad);
    _setAppRootForTest(f.work);
    _setDbForTest(db);

    const r = await checkForUpdates();

    assert.equal(r.skipped, "update-rollback-blocked", JSON.stringify(r));
    assert.equal(r.blocked, true, JSON.stringify(r));
    assert.equal(r.converge, false, "the refused commit is still checked out — no restart into it");
    assert.equal(r.converged, false, JSON.stringify(r));
    assert.match(db.settings.get("auto_update_last_result"),
      new RegExp(`Update rollback blocked: ${bad.slice(0, 9)} is still checked out`));
    assert.ok(existsSync(quarantinePath(f.gitDir)), "the marker is never deleted while HEAD is its sha");
    assert.equal(readUpdateQuarantine({ gitDir: f.gitDir }).sha, bad);
    assert.equal(g(f.work, "rev-parse", "HEAD"), bad, "the tree is left where it is");
    assert.ok(!existsSync(join(f.work, "c.txt")), "the newer commit is not pulled over the refusal");
  } finally { cleanup(); }
});

test("an expired HELD marker whose sha is still checked out still blocks the tick", async () => {
  // Round 3: the TTL used to delete the marker and let the tick carry on with
  // the refused commit still checked out. It expires the marker, not the fact
  // that a commit this host refused is the one on disk. (The marker is HELD — a
  // blocked rollback wrote it; an ordinary marker's TTL still applies.)
  const f = fixture();
  const db = stubDb();
  try {
    const bad = pushToOrigin(f, "b.txt", "two\n");
    g(f.work, "pull", "--ff-only", "origin", "main"); // HEAD == origin/main == bad
    writeFileSync(quarantinePath(f.gitDir), JSON.stringify({
      v: 1, sha: bad, previous: f.prev, reason: "import-timeout",
      at: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(), by: "test",
      expires_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      held: true,
    }));
    assert.ok(Date.parse(readUpdateQuarantine({ gitDir: f.gitDir }).expires_at) <= Date.now(),
      "the fixture marker really is past its TTL");
    _setAppRootForTest(f.work);
    _setDbForTest(db);

    const r = await checkForUpdates();

    assert.equal(r.skipped, "update-rollback-blocked", JSON.stringify(r));
    assert.equal(r.blocked, true, JSON.stringify(r));
    assert.equal(r.converge, false, "no restart into a refused commit, expired marker or not");
    assert.match(db.settings.get("auto_update_last_result"),
      new RegExp(`Update rollback blocked: ${bad.slice(0, 9)} is still checked out`));
    assert.ok(existsSync(quarantinePath(f.gitDir)), "the expired marker is NOT deleted while HEAD is its sha");
    assert.equal(readUpdateQuarantine({ gitDir: f.gitDir }).sha, bad);
    assert.equal(g(f.work, "rev-parse", "HEAD"), bad);
  } finally { cleanup(); }
});

test("an init-db-failed marker also expires, an import-check one does not", () => {
  const f = fixture();
  try {
    const sha = f.prev;
    // A local HEAD that is NOT the marker's sha: only then does a TTL apply
    // (while HEAD is the sha the marker never expires — round 3).
    const elsewhere = "0".repeat(40);
    const old = Date.now() - 7 * 60 * 60 * 1000;
    writeUpdateQuarantine({ gitDir: f.gitDir, sha, reason: "init-db-failed", now: old });
    assert.equal(
      evaluateUpdateQuarantine({ gitDir: f.gitDir, originHeadSha: sha, localHeadSha: elsewhere }).blocked, false);
    assert.ok(!existsSync(quarantinePath(f.gitDir)), "the expired record is cleaned up");

    // A sha whose CODE does not load gets no deadline: it waits for main.
    writeUpdateQuarantine({ gitDir: f.gitDir, sha, reason: "import-check", now: old });
    const m = readUpdateQuarantine({ gitDir: f.gitDir });
    assert.equal(m.expires_at, undefined, "a clean import failure has no TTL");
    assert.equal(
      evaluateUpdateQuarantine({ gitDir: f.gitDir, originHeadSha: sha, localHeadSha: elsewhere }).blocked, true);
  } finally { f.cleanup(); }
});

test("a short sha is never a match", async () => {
  const f = fixture();
  const db = stubDb();
  try {
    const bad = pushToOrigin(f, "b.txt", "two\n");
    // A prefix would also name other commits; the writer refuses it, and the
    // reader ignores one planted by hand.
    assert.equal(writeUpdateQuarantine({ gitDir: f.gitDir, sha: bad.slice(0, 9), reason: "import-check" }), null);
    writeFileSync(quarantinePath(f.gitDir), JSON.stringify({
      v: 1, sha: bad.slice(0, 9), previous: f.prev, reason: "import-check", at: new Date().toISOString(), by: "test",
    }));
    assert.equal(readUpdateQuarantine({ gitDir: f.gitDir }), null, "a non-full sha is not a marker");
    _setAppRootForTest(f.work);
    _setDbForTest(db);

    const r = await checkForUpdates();
    assert.equal(r.updated, true, `a short prefix must never block an update: ${JSON.stringify(r)}`);
  } finally { cleanup(); }
});

test("a malformed marker file is ignored, not obeyed", () => {
  const f = fixture();
  try {
    writeFileSync(quarantinePath(f.gitDir), "{not json");
    assert.equal(readUpdateQuarantine({ gitDir: f.gitDir }), null);
    assert.equal(evaluateUpdateQuarantine({ gitDir: f.gitDir, originHeadSha: f.prev }).blocked, false);
  } finally { f.cleanup(); }
});

test("a blocked rollback says the bad commit is still checked out (S5)", async () => {
  // After a blocked rollback HEAD is still the bad sha, so the next tick used to
  // report "waiting for a newer commit" and the bell said the update "was rolled
  // back" — while the next restart or reboot boots exactly that commit.
  const f = fixture();
  const db = stubDb();
  try {
    const bad = pushToOrigin(f, "b.txt", "two\n");
    g(f.work, "pull", "--ff-only", "origin", "main"); // the checkout HOLDS the bad sha
    // A blocked rollback wrote it: HELD, so the refusal survives TTL and main.
    writeUpdateQuarantine({ gitDir: f.gitDir, sha: bad, previous: f.prev, reason: "import-check", persist: true });
    _setAppRootForTest(f.work);
    _setDbForTest(db);

    const r = await checkForUpdates();

    assert.equal(r.skipped, "update-rollback-blocked", JSON.stringify(r));
    assert.equal(db.settings.get("auto_update_last_result"),
      `Update rollback blocked: ${bad.slice(0, 9)} is still checked out; the next restart will boot it`);
    assert.equal(db.notifications.length, 1, `one bell: ${JSON.stringify(db.notifications)}`);
    const n = db.notifications[0];
    assert.equal(JSON.parse(n.metadata).code, "update-rollback-blocked");
    assert.match(n.body, /still checked out/);
    assert.ok(!/was rolled back/.test(`${n.title} ${n.body}`),
      `the bell must not claim a rollback that never happened: ${n.title} | ${n.body}`);
  } finally { cleanup(); }
});

test("the marker reader refuses a symlink, a directory and an oversized file", () => {
  // The writer is atomic and never follows a planted file; the reader must be
  // just as strict, because PR 2's boot guard trusts the same record.
  const f = fixture();
  const path = quarantinePath(f.gitDir);
  const valid = JSON.stringify({
    v: 1, sha: f.prev, reason: "import-check", at: new Date().toISOString(), by: "test",
  });
  try {
    const real = join(f.root, "real-marker.json");
    writeFileSync(real, valid);
    symlinkSync(real, path);
    assert.equal(readUpdateQuarantine({ gitDir: f.gitDir }), null, "a symlinked marker is never followed");

    rmSync(path, { force: true });
    mkdirSync(path);
    assert.equal(readUpdateQuarantine({ gitDir: f.gitDir }), null, "a directory is not a marker");
    rmSync(path, { recursive: true, force: true });

    const huge = JSON.parse(valid);
    huge.pad = "x".repeat(70 * 1024);
    writeFileSync(path, JSON.stringify(huge));
    assert.equal(readUpdateQuarantine({ gitDir: f.gitDir }), null, "above the 64 KiB cap nothing is read");

    writeFileSync(path, valid);
    assert.equal(readUpdateQuarantine({ gitDir: f.gitDir }).sha, f.prev, "a plain, small, regular file still reads");
  } finally { f.cleanup(); }
});

test("Check-now goes through the same under-lock path", async () => {
  // The Settings button must consult the marker too. Drive the REAL handler
  // (settings.post "check_updates_now"), not a pattern match on its source: the
  // handler imports auto-update.js, so the same module instance and the same
  // _setAppRootForTest fixture apply.
  const f = fixture();
  const db = stubDb();
  try {
    const bad = pushToOrigin(f, "b.txt", "two\n");
    writeUpdateQuarantine({ gitDir: f.gitDir, sha: bad, previous: f.prev, reason: "import-check" });
    _setAppRootForTest(f.work);
    _setDbForTest(db);
    const section = (await import(
      "../servers/gateway/dashboard/settings/sections/updates.js"
    )).default;
    let payload = null;
    const handled = await section.handleAction({
      req: { body: {} },
      res: { json: (o) => { payload = o; } },
      db: null,
      action: "check_updates_now",
    });

    assert.equal(handled, true, "the handler recognised the action");
    assert.equal(payload.skipped, "update-quarantined", JSON.stringify(payload));
    assert.match(payload.message, /^Skipped: update quarantined \(/);
    assert.equal(g(f.work, "rev-parse", "HEAD"), f.prev, "Check-now never pulls the quarantined sha");
    assert.ok(!existsSync(join(f.work, "b.txt")));
  } finally { cleanup(); }
});