// The satellite's follow-the-primary update (SAT-6, spec §10, S11 a). POST /satellite/v1/update
// {target_sha} is accepted only when, after `git fetch origin main`, the target is an ancestor of
// (or equal to) origin/main, a fast-forward of the current sha, different from it, CI-green
// (classifyCheckRuns), and crow was heard from within 7 days. Then: satellite.db backup,
// `git merge --ff-only`, `npm ci --omit=dev` only when package-lock.json changed (under a
// 600 MB systemd scope, nice + ionice), the new tree's self-check and migration, and a
// supervised restart (exit 75). Any failure rolls back to the previous sha.
// Every git / npm / node / systemd call goes through a fake runner: no real repo is touched.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { actAsServe, serveHeaders } from "./fixtures/serve-peer.mjs";

const CROW_HOME = mkdtempSync(join(tmpdir(), "satupd-crow-"));
process.env.CROW_HOME = CROW_HOME;
process.env.CROW_DATA_DIR = mkdtempSync(join(tmpdir(), "satupd-data-"));
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
actAsServe();

const P = await import("../servers/shared/satellite-protocol.js");
const { classifyCheckRuns } = await import("../servers/shared/ci-check-runs.js");
const AU = await import("../servers/gateway/auto-update.js");
const { satelliteFetch } = await import("../servers/gateway/satellites/client.js");
const { issueCert } = await import("../servers/gateway/satellites/certs.js");
const { fakeIdentity } = await import("./helpers/fake-satellite.js");
const { startAgent } = await import("../servers/satellite/agent.js");
const { openSatelliteDb } = await import("../servers/satellite/db.js");
const { ensureSatelliteKey, writeCert, writePinned } = await import("../servers/satellite/keys.js");
const U = await import("../servers/satellite/update.js");

const dirs = [CROW_HOME, process.env.CROW_DATA_DIR];
const closers = [];
after(async () => {
  for (const c of closers) await c();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };

const CUR = "1".repeat(40);
const TARGET = "2".repeat(40);
const DAY = 86400000;
const green = { check_runs: ["suite", "static-checks", "audit"].map((name) => ({ name, status: "completed", conclusion: "success" })) };
const red = { check_runs: [{ name: "suite", status: "completed", conclusion: "failure" }, { name: "static-checks", status: "completed", conclusion: "success" }, { name: "audit", status: "completed", conclusion: "success" }] };

/** A scripted runner: `fail` maps a command-line prefix to an error (`failOnce`: only its first
 * match fails); `out` maps a prefix to stdout. */
function fakeRunner({ fail = {}, failOnce = {}, out = {} } = {}) {
  const calls = [];
  const once = new Map(Object.entries(failOnce));
  const runner = async (cmd, args = [], opts = {}) => {
    const line = [cmd, ...args].join(" ");
    calls.push({ line, cwd: opts.cwd, env: opts.env });
    for (const [prefix, err] of once) {
      if (line.startsWith(prefix)) { once.delete(prefix); throw Object.assign(new Error(err || `failed: ${line}`), { code: 1, stderr: err || "" }); }
    }
    for (const [prefix, err] of Object.entries(fail)) {
      if (line.startsWith(prefix)) throw Object.assign(new Error(err || `failed: ${line}`), { code: 1, stderr: err || "" });
    }
    for (const [prefix, stdout] of Object.entries(out)) if (line.startsWith(prefix)) return { stdout, stderr: "" };
    if (line === "git rev-parse HEAD") return { stdout: `${CUR}\n`, stderr: "" };
    return { stdout: "", stderr: "" };
  };
  runner.calls = calls;
  runner.lines = () => calls.map((c) => c.line);
  return runner;
}

function world({ runner = fakeRunner(), checkRuns = green, lastCallAgoMs = 60000, now = Date.now() } = {}) {
  const satHome = tmp("satupd-home-");
  const appRoot = tmp("satupd-app-");
  const db = openSatelliteDb(satHome);
  closers.push(() => db.close());
  if (lastCallAgoMs !== null) {
    db.prepare("INSERT INTO audit (ts, route, caller, result) VALUES (?, ?, ?, ?)").run(new Date(now - lastCallAgoMs).toISOString(), "status", "owner-local", "ok");
  }
  const exits = [];
  const updater = U.createUpdater({
    db, satHome, appRoot, runner, now: () => now, fetchCheckRuns: async () => checkRuns, exit: (c) => exits.push(c), log: () => {},
  });
  return { satHome, appRoot, db, runner, exits, updater };
}

test("classifyCheckRuns moved to a shared module; auto-update re-exports the same function", () => {
  assert.equal(AU.classifyCheckRuns, classifyCheckRuns);
  assert.equal(classifyCheckRuns(green), "green");
  assert.equal(classifyCheckRuns(red), "red");
});

test("constants", () => {
  assert.equal(U.UPDATE_RESTART_EXIT_CODE, 75);
  assert.equal(U.UNREACHABLE_MAX_MS, 7 * DAY);
  assert.deepEqual(U.npmCiCommand(), ["systemd-run", ["--user", "--scope", "-p", "MemoryMax=600M", "nice", "-n", "10", "ionice", "-c2", "-n7", "npm", "ci", "--omit=dev"]]);
});

test("refused: a bad sha, the current sha, a target that is not on origin/main, a non-fast-forward", async () => {
  const w = world();
  assert.deepEqual(await w.updater.check("nope"), { ok: false, status: 400, code: "bad_target_sha" });
  assert.equal((await w.updater.check(CUR)).code, "already_current");

  const off = world({ runner: fakeRunner({ fail: { [`git merge-base --is-ancestor ${TARGET} origin/main`]: "" } }) });
  const r = await off.updater.check(TARGET);
  assert.equal(r.code, "not_on_main");
  assert.equal(r.status, 409);
  assert.ok(off.runner.lines().includes("git fetch origin main"), "fetched first");
  assert.ok(off.runner.lines().indexOf("git fetch origin main") < off.runner.lines().findIndex((l) => l.startsWith("git merge-base")));

  const behind = world({ runner: fakeRunner({ fail: { [`git merge-base --is-ancestor ${CUR} ${TARGET}`]: "" } }) });
  assert.equal((await behind.updater.check(TARGET)).code, "not_fast_forward");

  const unknown = world({ runner: fakeRunner({ fail: { [`git cat-file -e ${TARGET}^{commit}`]: "" } }) });
  assert.equal((await unknown.updater.check(TARGET)).code, "unknown_sha");

  for (const x of [off, behind, unknown]) assert.ok(!x.runner.lines().some((l) => l.startsWith("git merge --ff-only")));
});

test("refused unless CI is green: red, pending and unknown all refuse", async () => {
  for (const [checkRuns, verdict] of [[red, "red"], [{ check_runs: [{ name: "suite", status: "in_progress" }] }, "pending"], [null, "unknown"]]) {
    const w = world({ checkRuns });
    const r = await w.updater.check(TARGET);
    assert.equal(r.ok, false);
    assert.equal(r.code, "ci_not_green");
    assert.equal(r.ci, verdict);
    const up = await w.updater.update(TARGET);
    assert.equal(up.code, "ci_not_green");
    assert.ok(!w.runner.lines().some((l) => l.startsWith("git merge --ff-only")));
    assert.deepEqual(w.exits, []);
  }
});

test("7-day rule: no update when the last signed call from crow is older than 7 days (or there is none)", async () => {
  assert.equal((await world({ lastCallAgoMs: 7 * DAY + 60000 }).updater.check(TARGET)).code, "crow_unreachable");
  assert.equal((await world({ lastCallAgoMs: null }).updater.check(TARGET)).code, "crow_unreachable");
  assert.equal((await world({ lastCallAgoMs: 7 * DAY - 60000 }).updater.check(TARGET)).ok, true);
});

test("happy path, lockfile unchanged: backup, ff-only merge, no npm, self-check + migrate in the new tree, exit 75", async () => {
  const w = world();
  const r = await w.updater.update(TARGET);
  assert.equal(r.ok, true, JSON.stringify(r));
  const lines = w.runner.lines();
  assert.ok(lines.includes(`git merge --ff-only ${TARGET}`));
  assert.ok(lines.includes(`git diff --name-only ${CUR} ${TARGET} -- package-lock.json`));
  assert.ok(!lines.some((l) => l.startsWith("systemd-run") || l.includes("npm ci")), "npm skipped");
  const cli = join(w.appRoot, "servers", "satellite", "cli.js");
  const self = lines.findIndex((l) => l === `${process.execPath} ${cli} self-check`);
  const mig = lines.findIndex((l) => l === `${process.execPath} ${cli} migrate`);
  assert.ok(self > lines.indexOf(`git merge --ff-only ${TARGET}`) && mig > self, "self-check, then migrate, after the merge");
  assert.equal(w.runner.calls[mig].env.CROW_HOME, w.satHome);
  for (const c of w.runner.calls) if (c.line.startsWith("git ")) assert.equal(c.cwd, w.appRoot);
  assert.deepEqual(w.exits, [75]);
  const backup = join(w.satHome, "backups", "satellite-db", `pre-update-${CUR.slice(0, 12)}.db`);
  assert.ok(existsSync(backup));
  assert.equal(statSync(backup).mode & 0o777, 0o600);
  const last = JSON.parse(readFileSync(join(w.satHome, "update-last.json"), "utf8"));
  assert.equal(last.result, "restarting");
  assert.equal(last.from, CUR);
  assert.equal(last.to, TARGET);
});

test("lockfile changed: npm ci --omit=dev runs under the 600 MB scope with nice + ionice", async () => {
  const w = world({ runner: fakeRunner({ out: { [`git diff --name-only ${CUR} ${TARGET}`]: "package-lock.json\n" } }) });
  assert.equal((await w.updater.update(TARGET)).ok, true);
  const npm = w.runner.calls.find((c) => c.line.startsWith("systemd-run"));
  assert.equal(npm.line, "systemd-run --user --scope -p MemoryMax=600M nice -n 10 ionice -c2 -n7 npm ci --omit=dev");
  assert.equal(npm.cwd, w.appRoot);
  assert.deepEqual(w.exits, [75]);
});

test("rollback: a failed npm ci resets to the previous sha and re-installs; no restart", async () => {
  const runner = fakeRunner({
    out: { [`git diff --name-only ${CUR} ${TARGET}`]: "package-lock.json\n" },
    failOnce: { "systemd-run": "oom" },
  });
  const w = world({ runner });
  const r = await w.updater.update(TARGET);
  assert.equal(r.ok, false);
  assert.equal(r.code, "rolled_back");
  const lines = runner.lines();
  assert.ok(lines.includes(`git reset --hard ${CUR}`));
  assert.ok(lines.indexOf(`git reset --hard ${CUR}`) > lines.indexOf(`git merge --ff-only ${TARGET}`));
  assert.equal(lines.filter((l) => l.startsWith("systemd-run")).length, 2, "the previous lockfile is installed again");
  assert.ok(!lines.some((l) => l.endsWith(" migrate")), "no migration after a failed install");
  assert.deepEqual(w.exits, []);
  assert.equal(JSON.parse(readFileSync(join(w.satHome, "update-last.json"), "utf8")).result, "rolled_back");
});

test("rollback: a failed self-check resets without touching satellite.db; a failed migration also restores the db at the next boot", async () => {
  const cliOf = (w) => join(w.appRoot, "servers", "satellite", "cli.js");
  const sc = world({ runner: fakeRunner({ fail: { [process.execPath]: "" } }) });
  const r1 = await sc.updater.update(TARGET);
  assert.equal(r1.code, "rolled_back");
  assert.ok(sc.runner.lines().includes(`git reset --hard ${CUR}`));
  assert.ok(!sc.runner.lines().some((l) => l === `${process.execPath} ${cliOf(sc)} migrate`));
  assert.ok(!existsSync(join(sc.satHome, U.DB_RESTORE_MARKER)));
  assert.deepEqual(sc.exits, []);

  const runner = fakeRunner();
  const w = world({ runner });
  const real = runner;
  const failing = async (cmd, args, opts) => {
    if (cmd === process.execPath && args.at(-1) === "migrate") { real.calls.push({ line: `${cmd} ${args.join(" ")}` }); throw Object.assign(new Error("migration 2 failed"), { code: 1 }); }
    return real(cmd, args, opts);
  };
  const w2 = { ...w, updater: U.createUpdater({ db: w.db, satHome: w.satHome, appRoot: w.appRoot, runner: failing, now: Date.now, fetchCheckRuns: async () => green, exit: (c) => w.exits.push(c), log: () => {} }) };
  const r2 = await w2.updater.update(TARGET);
  assert.equal(r2.code, "rolled_back");
  assert.ok(real.lines().includes(`git reset --hard ${CUR}`));
  const marker = JSON.parse(readFileSync(join(w.satHome, U.DB_RESTORE_MARKER), "utf8"));
  assert.equal(marker.backup, join(w.satHome, "backups", "satellite-db", `pre-update-${CUR.slice(0, 12)}.db`));
  assert.deepEqual(w.exits, [75], "restart so the old code boots on the restored db");
});

test("applyPendingDbRestore: at boot the backup replaces satellite.db (and its WAL), then the marker goes", () => {
  const home = tmp("satupd-restore-");
  const db = openSatelliteDb(home);
  db.prepare("INSERT INTO audit (ts, route, caller, result) VALUES ('2026-01-01T00:00:00.000Z', 'before', 'x', 'ok')").run();
  mkdirSync(join(home, "backups", "satellite-db"), { recursive: true });
  const backup = join(home, "backups", "satellite-db", "pre-update-x.db");
  db.exec(`VACUUM INTO '${backup}'`);
  db.prepare("INSERT INTO audit (ts, route, caller, result) VALUES ('2026-01-02T00:00:00.000Z', 'after', 'x', 'ok')").run();
  db.close();
  writeFileSync(join(home, U.DB_RESTORE_MARKER), JSON.stringify({ backup }));
  assert.equal(U.applyPendingDbRestore(home), true);
  assert.ok(!existsSync(join(home, U.DB_RESTORE_MARKER)));
  const again = openSatelliteDb(home);
  closers.push(() => again.close());
  assert.deepEqual(again.prepare("SELECT route FROM audit ORDER BY id").all().map((r) => r.route), ["before"]);
  assert.equal(statSync(join(home, "satellite.db")).mode & 0o777, 0o600);
  assert.equal(U.applyPendingDbRestore(home), false, "nothing pending");
});

test("a rollback that fails is reported as rollback_failed", async () => {
  const w = world({ runner: fakeRunner({ fail: { [`git merge --ff-only`]: "conflict", "git reset --hard": "locked" } }) });
  const r = await w.updater.update(TARGET);
  assert.equal(r.code, "rollback_failed");
  assert.equal(JSON.parse(readFileSync(join(w.satHome, "update-last.json"), "utf8")).result, "rollback_failed");
  assert.deepEqual(w.exits, []);
});

test("one update at a time", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const runner = fakeRunner();
  const slow = async (cmd, args, opts) => { if (args[0] === "merge" && args[1] === "--ff-only") await gate; return runner(cmd, args, opts); };
  const w = world({ runner });
  const up = U.createUpdater({ db: w.db, satHome: w.satHome, appRoot: w.appRoot, runner: slow, fetchCheckRuns: async () => green, exit: () => {}, log: () => {} });
  const first = up.update(TARGET);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await up.update(TARGET)).code, "update_running");
  release();
  assert.equal((await first).ok, true);
});

// ── the signed route ────────────────────────────────────────────────────────

const identity = fakeIdentity();
test("POST /satellite/v1/update: owners only, refusals signed, an accepted update answers 202 before it runs", async () => {
  const home = tmp("satupd-agent-");
  const key = ensureSatelliteKey(home);
  const mgmt = P.generateKeypair();
  const c = issueCert({ identity, instanceId: "inst-primary", primaryUrl: "https://crow.example.ts.net:8444", satellite_id: key.satellite_id, satellite_pubkey: key.ed25519_pub, mgmt_pubkey: mgmt.pubHex, now: Date.now() });
  writePinned(home, { crow_id: c.payload.crow_id, root_pubkey: c.payload.root_pubkey, mgmt_pubkey: c.payload.mgmt_pubkey, primary_url: c.payload.primary_url, primary_instance_id: c.payload.primary_instance_id, target_sha: null });
  writeCert(home, c);
  const runner = fakeRunner();
  const exits = [];
  const a = await startAgent({
    env: { CROW_HOME: home, CROW_SATELLITE_PORT: "0" }, out: () => {}, authLog: () => {}, sha: CUR,
    updateDeps: { runner, appRoot: tmp("satupd-agentapp-"), fetchCheckRuns: async () => green, exit: (code) => exits.push(code) },
  });
  closers.push(() => a.close());
  const call = (body, caller = "owner-local") => satelliteFetch(
    { id: a.satelliteId, tailnet_host: "satellite.example.ts.net", satellite_pubkey: a.key.ed25519_pub },
    { method: "POST", path: "/satellite/v1/update", body, caller, mgmtKey: { ed25519_priv: mgmt.privHex },
      fetchImpl: async (url, init = {}) => { const u = new URL(url); return fetch(`http://127.0.0.1:${a.port}${u.pathname}`, { ...init, headers: { ...init.headers, ...serveHeaders(null, "100.64.20.5") } }); } },
  );
  // A first signed call so crow counts as heard from (the 7-day rule reads the audit log).
  const bot = await call({ target_sha: TARGET }, "bot:b1");
  assert.equal(bot.status, 403);
  assert.equal(bot.json.error, "owner_only");
  assert.equal((await call({ target_sha: "zz" })).json.error, "bad_target_sha");
  const ok = await call({ target_sha: TARGET });
  assert.equal(ok.status, 202, JSON.stringify(ok.json));
  assert.deepEqual(ok.json, { ok: true, from: CUR, to: TARGET, npm: false });
  for (let i = 0; i < 200 && !exits.length; i++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(exits, [75]);
  assert.ok(runner.lines().includes(`git merge --ff-only ${TARGET}`));
});
