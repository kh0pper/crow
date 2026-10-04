/**
 * Co-hosted instance isolation (2026-10-04 incident).
 *
 * crow runs two gateways from ONE checkout: the primary (CROW_HOME unset →
 * ~/.crow) and r4 (CROW_HOME=~/.crow-r4). Both wrote the nightly API backup to
 * ~/backups/crow/primary-<date>.db, so r4's copy replaced the primary's, and a
 * set of modules keyed on homedir()/.crow shared files across the two.
 *
 * The headline test boots TWO real gateways from this checkout under one fake
 * HOME — one host-default, one with its own CROW_HOME — on the same day, runs
 * POST /api/admin/backup on each (twice), and proves the backups do not
 * collide and every per-instance file resolves to a distinct path. The rest
 * pins the naming/ownership/retention rules and the instances.json repair.
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import http from "node:http";
import Database from "better-sqlite3";

import {
  instanceBackupTag, backupFileName, ownBackupRegex, listOwnBackups, isForeignOwner,
  newestBackupOwnership, ownerPath, backupLabel,
} from "../servers/shared/backup-naming.js";
import { resolveCrowHome, isDefaultCrowHome, coHostedDataDirWarning } from "../servers/shared/crow-home.js";
import { pruneOwnBackups, backupSelfCheck } from "../servers/gateway/routes/admin-backup.js";
import { classifyStaleLocalInstances, removeStaleLocalInstances } from "../servers/gateway/instance-registry.js";

const REPO = join(import.meta.dirname, "..");
const scratch = mkdtempSync(join(tmpdir(), "crow-cohost-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

// ─── naming rules ────────────────────────────────────────────────────────────

test("host-default instance keeps the legacy name; any other CROW_HOME is tagged", () => {
  const home = join(scratch, "h1");
  assert.equal(instanceBackupTag({ HOME: home }), null, "CROW_HOME unset → no tag");
  // os.homedir() is the process's, so build the default from it.
  assert.equal(instanceBackupTag({ CROW_HOME: resolveCrowHome({}) }), null, "CROW_HOME=~/.crow → no tag");
  const tag = instanceBackupTag({ CROW_HOME: "/srv/x/.crow-r4" });
  assert.match(tag, /^crow-r4-[0-9a-f]{6}$/);
  assert.notEqual(tag, instanceBackupTag({ CROW_HOME: "/srv/y/.crow-r4" }), "same basename, different path → different tag");
  assert.equal(backupFileName("primary", null, "2026-10-05"), "primary-2026-10-05.db");
  assert.equal(backupFileName("primary", tag, "2026-10-05"), `primary-${tag}-2026-10-05.db`);
});

test("own-file patterns never cross-match between the default and a tagged instance", () => {
  const tag = instanceBackupTag({ CROW_HOME: "/srv/x/.crow-r4" });
  const defRe = ownBackupRegex("primary", null);
  const tagRe = ownBackupRegex("primary", tag);
  assert.ok(defRe.test("primary-2026-10-05.db"));
  assert.ok(!defRe.test(`primary-${tag}-2026-10-05.db`));
  assert.ok(tagRe.test(`primary-${tag}-2026-10-05.db`));
  assert.ok(!tagRe.test("primary-2026-10-05.db"));
  assert.ok(!defRe.test("primary-2026-10-05.db-wal"));
  assert.ok(!defRe.test(".primary-2026-10-05.db.tmp-1-ab"));
});

test("isForeignOwner: differing instance id, db path or CROW_HOME is foreign; missing fields never are", () => {
  const me = { instance_id: "a", db_path: "/x/a.db" };
  assert.equal(isForeignOwner({ instance_id: "b" }, { instance_id: "a" }), true);
  assert.equal(isForeignOwner({ instance_id: "a", db_path: "/x/b.db" }, me), true);
  assert.equal(isForeignOwner({ instance_id: "a", db_path: "/x/a.db" }, me), false);
  assert.equal(isForeignOwner({}, me), false);
  assert.equal(isForeignOwner(null, me), false);
  assert.equal(isForeignOwner({ instance_id: "b" }, { db_path: "/x/a.db" }), false);
  assert.equal(isForeignOwner({ crow_home: "/h/.crow-r4" }, { crow_home: "/h/.crow" }), true);
  // Same CROW_HOME = own, even after the instance-id file was regenerated.
  assert.equal(isForeignOwner({ crow_home: "/h/.crow", instance_id: "old" }, { crow_home: "/h/.crow", instance_id: "new" }), false);
  assert.equal(isForeignOwner({ crow_home: "/h/.crow", db_path: "/d/a.db" }, { crow_home: "/h/.crow", db_path: "/d/b.db" }), true);
});

test("coHostedDataDirWarning flags CROW_HOME without CROW_DATA_DIR only", () => {
  assert.equal(coHostedDataDirWarning({}), null);
  assert.equal(coHostedDataDirWarning({ CROW_HOME: "/srv/.crow-x", CROW_DATA_DIR: "/srv/.crow-x/data" }), null);
  assert.match(coHostedDataDirWarning({ CROW_HOME: "/srv/.crow-x" }), /SHARED/);
  assert.equal(isDefaultCrowHome({ CROW_HOME: resolveCrowHome({}) }), true);
});

// ─── retention + ownership on disk ───────────────────────────────────────────

test("retention is per-instance: only this instance's old files are pruned", () => {
  const dir = join(scratch, "prune");
  mkdirSync(dir, { recursive: true });
  const tag = "crow-r4-abcdef";
  const me = { instance_id: "A", db_path: "/a/crow.db" };
  const old = Date.now() / 1000 - 30 * 86400;
  const files = {
    ownOld: "primary-2026-01-01.db",
    ownNew: "primary-2026-12-31.db",
    otherOld: `primary-${tag}-2026-01-01.db`,
    unrelated: "mpa-2026-01-01.db",
    foreignNamedOld: "primary-2026-01-02.db",
  };
  for (const f of Object.values(files)) writeFileSync(join(dir, f), "x");
  writeFileSync(ownerPath(join(dir, files.ownOld)), JSON.stringify(me));
  writeFileSync(join(dir, files.ownOld + "-wal"), "");
  writeFileSync(ownerPath(join(dir, files.foreignNamedOld)), JSON.stringify({ instance_id: "B", db_path: "/b/crow.db" }));
  for (const f of [files.ownOld, files.otherOld, files.unrelated, files.foreignNamedOld]) utimesSync(join(dir, f), old, old);
  writeFileSync(join(dir, ".primary-2026-01-01.db.tmp-1-ab"), "x");
  utimesSync(join(dir, ".primary-2026-01-01.db.tmp-1-ab"), old, old);

  const r = pruneOwnBackups(dir, { label: "primary", tag: null, me, keepDays: 7 });
  assert.equal(r.pruned, 1);
  const left = new Set(readdirSync(dir));
  assert.ok(!left.has(files.ownOld), "own old file pruned");
  assert.ok(!left.has(files.ownOld + "-wal") && !left.has(files.ownOld + ".owner.json"), "its wal + sidecar go with it");
  assert.ok(left.has(files.ownNew), "own fresh file kept");
  assert.ok(left.has(files.otherOld), "the co-hosted instance's old file is NOT ours to prune");
  assert.ok(left.has(files.unrelated), "another label is NOT ours to prune");
  assert.ok(left.has(files.foreignNamedOld), "a file whose sidecar names another instance is never pruned");
  assert.ok(!left.has(".primary-2026-01-01.db.tmp-1-ab"), "stale own temp swept");
});

test("newest-backup ownership + boot self-check warn when another instance owns it", () => {
  const dir = join(scratch, "selfcheck");
  mkdirSync(dir, { recursive: true });
  const env = { ...process.env, CROW_BACKUP_DIR: dir };
  const label = backupLabel(env);
  const tag = instanceBackupTag(env);
  const f = join(dir, backupFileName(label, tag, "2026-10-04"));
  writeFileSync(f, "x");

  const warns = [];
  const log = { warn: (m) => warns.push(m), log: () => {} };
  assert.equal(backupSelfCheck({ env, log }).status, "unknown", "sidecar-less legacy file → unknown, not foreign");
  assert.equal(warns.filter((w) => /belongs to another instance/.test(w)).length, 0);

  writeFileSync(ownerPath(f), JSON.stringify({ instance_id: "someone-else", crow_home: "/elsewhere/.crow-r4" }));
  assert.equal(backupSelfCheck({ env, log }).status, "foreign");
  assert.ok(warns.some((w) => /WARNING: newest backup .* belongs to another instance/.test(w)), warns.join("\n"));
  assert.equal(newestBackupOwnership(dir, label, tag, { instance_id: "someone-else", crow_home: "/elsewhere/.crow-r4" }).status, "ok");

  // Our own sidecar, but the file was rewritten in place afterwards (an
  // un-restarted co-hosted gateway on old code): mismatch → warn.
  const st = { size: 1, mtimeMs: 1000 };
  writeFileSync(ownerPath(f), JSON.stringify({ crow_home: resolveCrowHome(env), size_bytes: st.size + 5, mtime_ms: st.mtimeMs }));
  assert.equal(backupSelfCheck({ env, log }).status, "mismatch");
  assert.ok(warns.some((w) => /was rewritten after this instance wrote it/.test(w)));
});

test("Nest backup signal warns when this instance's newest file is owned by another instance", async () => {
  const { collectHealthSignals, invalidateHealthCache } = await import("../servers/gateway/dashboard/panels/nest/health-signals.js");
  const dir = join(scratch, "signal");
  mkdirSync(dir, { recursive: true });
  const prev = process.env.CROW_BACKUP_DIR;
  process.env.CROW_BACKUP_DIR = dir;
  try {
    const f = join(dir, backupFileName(backupLabel(), instanceBackupTag(), "2026-10-04"));
    writeFileSync(f, "x");
    writeFileSync(ownerPath(f), JSON.stringify({ instance_id: "someone-else", crow_home: "/elsewhere/.crow-r4" }));
    // A co-hosted instance's newer file in the same dir must not count as ours.
    writeFileSync(join(dir, "primary-zzz-9999-12-31.db"), "x");
    invalidateHealthCache();
    const db = { execute: async () => ({ rows: [] }) };
    const out = await collectHealthSignals(db);
    const b = out.details.find((d) => d.id === "backup");
    assert.equal(b.state, "warn");
    const issue = out.issues.find((i) => i.id === "backup");
    assert.equal(issue?.severity, "warn", "a warn issue → the health monitor raises a dashboard notification");
    assert.match(JSON.stringify(issue), /another Crow instance/);
  } finally {
    if (prev == null) delete process.env.CROW_BACKUP_DIR; else process.env.CROW_BACKUP_DIR = prev;
  }
});

// ─── instances.json repair ───────────────────────────────────────────────────

test("instances.json classifier: only unregistered, auto-named, throwaway entries", () => {
  const live = join(scratch, "live-wt");
  mkdirSync(live, { recursive: true });
  const local = {
    real_peer: { name: `crow:${live}`, directory: live },               // in crow_instances
    own: { name: `crow:${live}`, directory: live },                     // this instance's id
    named: { name: "Main", directory: "/gone/x" },                      // operator-named
    burst1: { name: `crow:${live}`, directory: live },
    burst2: { name: `crow:${live}`, directory: live },
    gone: { name: "crow:/gone/wt", directory: "/gone/wt" },
    temp: { name: "crow:/fake-tmp/x", directory: "/fake-tmp/x" },
    single: { name: "crow:/srv/one", directory: "/srv/one" },           // exists, alone → kept
  };
  const known = new Set(["real_peer"]);
  const exists = (p) => p === live || p === "/srv/one";
  const out = classifyStaleLocalInstances(local, known, { localId: "own", exists, tmpRoots: ["/fake-tmp"] });
  const ids = out.map((c) => c.id).sort();
  assert.deepEqual(ids, ["burst1", "burst2", "gone", "temp"]);
  assert.equal(out.find((c) => c.id === "gone").reason, "dir-missing");
  assert.equal(out.find((c) => c.id === "temp").reason, "temp-dir");
  assert.equal(out.find((c) => c.id === "burst1").reason, "burst");
});

test("instances.json repair is a dry run by default, count-checked, and backs the file up", async () => {
  const p = process.env.CROW_INSTANCES_JSON_PATH;
  assert.ok(p && p.startsWith(tmpdir()), "suite must point instances.json at scratch");
  const keep = { realpeer000000000000000000000000: { name: "crow:/gone/a", directory: "/gone/a" } };
  const junk = {};
  for (let i = 0; i < 5; i++) junk[`junk${i}`.padEnd(32, "0")] = { name: "crow:/gone/wt", directory: "/gone/wt" };
  writeFileSync(p, JSON.stringify({ ...keep, ...junk }));
  const db = { execute: async () => ({ rows: [{ id: "realpeer000000000000000000000000" }] }) };

  const dry = await removeStaleLocalInstances(db, { localId: null });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.scan.candidates.length, 5);
  assert.equal(Object.keys(JSON.parse(readFileSync(p, "utf8"))).length, 6, "dry run changes nothing");

  const refused = await removeStaleLocalInstances(db, { confirm: true, expected: 4, localId: null });
  assert.equal(refused.refused, true);
  assert.equal(Object.keys(JSON.parse(readFileSync(p, "utf8"))).length, 6);

  const done = await removeStaleLocalInstances(db, { confirm: true, expected: 5, localId: null });
  assert.equal(done.removed, 5);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(p, "utf8"))), ["realpeer000000000000000000000000"]);
  const dir = join(p, "..");
  assert.ok(readdirSync(dir).some((n) => n.startsWith("instances.json.bak-hygiene-")), "backup written first");
});

// ─── two real gateways, one checkout, one day ────────────────────────────────

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => { const port = s.address().port; s.close(() => resolve(port)); });
  });
}

async function waitForHealth(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const code = await new Promise((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}/health`, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
        req.on("error", reject);
        req.setTimeout(1000, () => { req.destroy(); reject(new Error("timeout")); });
      });
      if (code === 200) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`gateway on :${port} not healthy in ${timeoutMs}ms`);
}

function postBackup(port) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/api/admin/backup", method: "POST" }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => { try { resolve({ status: res.statusCode, json: JSON.parse(body) }); } catch { resolve({ status: res.statusCode, body }); } });
    });
    req.on("error", reject);
    req.setTimeout(60_000, () => { req.destroy(); reject(new Error("backup timeout")); });
    req.end();
  });
}

// The child env: the suite's scratch seams for these paths are REMOVED so the
// real per-instance resolution is what gets exercised, under a fake HOME so
// the host-default instance's ~/.crow and ~/backups are scratch too.
function instanceEnv(fakeHome, crowHome) {
  const env = { ...process.env, HOME: fakeHome };
  for (const k of ["CROW_HOME", "CROW_DATA_DIR", "CROW_DB_PATH", "CROW_BACKUP_DIR", "CROW_INSTANCES_JSON_PATH",
    "CROW_REFCOUNT_PATH", "CROW_PEER_TOKENS_PATH", "NTFY_TOPIC", "CROW_GATEWAY_URL", "PORT", "CROW_GATEWAY_PORT"]) delete env[k];
  if (crowHome) {
    env.CROW_HOME = crowHome;
    env.CROW_DATA_DIR = join(crowHome, "data");
  } else {
    env.CROW_DATA_DIR = join(fakeHome, ".crow", "data");
  }
  return env;
}

const PATHS_PROBE = `
const { instancesJsonPath } = await import("./servers/gateway/instance-registry.js");
const { refcountPath } = await import("./servers/shared/lifecycle.js");
const { peerTokensPath } = await import("./servers/shared/peer-credentials.js");
const { resolveCrowHome, resolveInstanceDataDir } = await import("./servers/shared/crow-home.js");
const { ntfyConfigPath } = await import("./servers/gateway/push/ntfy-config.js");
const { CROW_HOME, MCP_ADDONS_PATH } = await import("./servers/gateway/bundles-config.js");
const { resolveCrowHome: proxyHome } = await import("./servers/gateway/proxy.js");
const { CROW_USER_SKILLS } = await import("./scripts/pi-bots/skill_promote.mjs");
const { localBackupContext } = await import("./servers/shared/backup-naming.js");
const { join } = await import("node:path");
const b = localBackupContext();
console.log(JSON.stringify({
  instancesJson: instancesJsonPath(), refcounts: refcountPath(), peerTokens: peerTokensPath(),
  home: resolveCrowHome(), proxyHome: proxyHome(), bundlesHome: CROW_HOME, mcpAddons: MCP_ADDONS_PATH,
  instanceId: join(resolveInstanceDataDir(), "instance-id"), ntfy: ntfyConfigPath(), skills: CROW_USER_SKILLS,
  backupStem: b.tag ? b.label + "-" + b.tag : b.label,
}));
process.exit(0);
`;

let gateways = [];
after(() => { for (const g of gateways) { try { g.child.kill("SIGKILL"); } catch {} } });

test("two gateways from one checkout, same day: backups never collide and per-instance files are distinct", { timeout: 180_000 }, async () => {
  const fakeHome = join(scratch, "host");
  mkdirSync(fakeHome, { recursive: true });
  const specs = [
    { name: "primary", crowHome: null, marker: "PRIMARY" },
    { name: "r4", crowHome: join(fakeHome, ".crow-r4"), marker: "R4" },
  ];

  for (const s of specs) {
    s.env = instanceEnv(fakeHome, s.crowHome);
    mkdirSync(s.env.CROW_DATA_DIR, { recursive: true });
    execFileSync(process.execPath, ["scripts/init-db.js"], { env: s.env, cwd: REPO, stdio: "pipe" });
    const db = new Database(join(s.env.CROW_DATA_DIR, "crow.db"));
    db.prepare("INSERT INTO dashboard_settings (key, value, updated_at) VALUES ('cohost_marker', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(s.marker);
    db.close();
    s.paths = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", PATHS_PROBE], { env: s.env, cwd: REPO, stdio: ["ignore", "pipe", "pipe"] }).toString().trim().split("\n").pop());
  }

  // Every per-instance file resolves to a different path for the two instances.
  for (const key of ["instancesJson", "refcounts", "peerTokens", "home", "proxyHome", "bundlesHome", "mcpAddons", "instanceId", "ntfy", "skills", "backupStem"]) {
    assert.notEqual(specs[0].paths[key], specs[1].paths[key], `${key} must differ between co-hosted instances`);
  }
  // The host-default instance keeps its legacy locations.
  assert.equal(specs[0].paths.instancesJson, join(fakeHome, ".crow", "instances.json"));
  assert.equal(specs[0].paths.home, join(fakeHome, ".crow"));
  assert.equal(specs[0].paths.backupStem, "primary");
  assert.equal(specs[1].paths.instancesJson, join(fakeHome, ".crow-r4", "instances.json"));
  assert.ok(specs[1].paths.refcounts.startsWith(join(fakeHome, ".crow-r4", "data")));

  for (const s of specs) {
    s.port = await freePort();
    const env = { ...s.env, PORT: String(s.port), CROW_GATEWAY_URL: `http://127.0.0.1:${s.port}`, CROW_DISABLE_HEALTH_MONITOR: "1" };
    s.child = spawn(process.execPath, ["servers/gateway/index.js", "--no-auth"], { env, cwd: REPO, stdio: "pipe" });
    s.log = "";
    s.child.stdout.on("data", (c) => { s.log += c; });
    s.child.stderr.on("data", (c) => { s.log += c; });
    gateways.push(s);
  }
  for (const s of specs) {
    try { await waitForHealth(s.port); } catch (err) { throw new Error(`${s.name}: ${err.message}\n${s.log.slice(-3000)}`); }
  }

  const backupDir = join(fakeHome, "backups", "crow");
  const date = new Date().toISOString().split("T")[0];
  for (let round = 0; round < 2; round++) {
    for (const s of specs) {
      const r = await postBackup(s.port);
      assert.equal(r.status, 200, `${s.name} backup round ${round}: ${JSON.stringify(r.json || r.body)}`);
      s.result = r.json;
    }
  }

  const names = readdirSync(backupDir).filter((n) => n.endsWith(".db")).sort();
  assert.equal(names.length, 2, `exactly one file per instance: ${names.join(", ")}`);
  assert.ok(names.includes(`primary-${date}.db`), "host-default instance keeps the legacy file name");
  assert.notEqual(specs[0].result.path, specs[1].result.path);

  for (const s of specs) {
    const copy = new Database(s.result.path, { readonly: true });
    const marker = copy.prepare("SELECT value FROM dashboard_settings WHERE key='cohost_marker'").get()?.value;
    copy.close();
    assert.equal(marker, s.marker, `${s.name}'s backup holds ${s.name}'s data`);
    const owner = JSON.parse(readFileSync(ownerPath(s.result.path), "utf8"));
    const ownId = readFileSync(join(s.env.CROW_DATA_DIR, "instance-id"), "utf8").trim();
    assert.equal(owner.instance_id, ownId, `${s.name}'s sidecar names ${s.name}`);
    assert.equal(s.result.instance_id, ownId);
  }

  // Instance ids and the instances.json each gateway registered in are distinct.
  const idA = readFileSync(specs[0].paths.instanceId, "utf8").trim();
  const idB = readFileSync(specs[1].paths.instanceId, "utf8").trim();
  assert.notEqual(idA, idB);
  for (const [s, ownId, otherId] of [[specs[0], idA, idB], [specs[1], idB, idA]]) {
    if (!existsSync(s.paths.instancesJson)) continue; // self-registration is boot-async; absence is fine
    const reg = JSON.parse(readFileSync(s.paths.instancesJson, "utf8"));
    assert.ok(!(otherId in reg), `${s.name}'s instances.json must not hold the other instance's entry`);
  }

  // A same-name file owned by another instance is never overwritten.
  const own = specs[0].result.path;
  const before = readFileSync(own);
  writeFileSync(ownerPath(own), JSON.stringify({ instance_id: idB, crow_home: specs[1].crowHome }));
  const refused = await postBackup(specs[0].port);
  assert.equal(refused.status, 500);
  assert.match(JSON.stringify(refused.json), /refusing to overwrite/);
  assert.ok(readFileSync(own).equals(before), "the other instance's file is untouched");
  assert.deepEqual(readdirSync(backupDir).filter((n) => n.includes(".tmp-")), [], "no temp file left behind");
});
