/** Backup/restore/recovery scripts against a FAKE docker compose; real gpg in a scratch GNUPGHOME. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, statSync, readdirSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { after } from "node:test";
const ctxs = [];
after(() => { for (const c of ctxs) { spawnSync("gpgconf", ["--homedir", c.gnupg, "--kill", "gpg-agent"]); rmSync(c.root, { recursive: true, force: true }); } });
const OPS = join(import.meta.dirname, "..", "bundles", "workspace", "ops");
const SKIP = spawnSync("gpg", ["--version"]).status !== 0 && "gpg not installed";

const FAKE_DC = String.raw`#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FAKE_STATE/calls.log"
case "$*" in
  *"maintenance:mode --on"*) if [ -f "$FAKE_STATE/on-fails-after-applying" ]; then echo on-applied >> "$FAKE_STATE/maint.log"; exit 1; fi ;;
  *"mariadb-dump"*)
    if [ -f "$FAKE_STATE/fail-dump" ]; then echo "dump exploded" >&2; exit 2; fi
    if [ -f "$FAKE_STATE/slow-dump" ]; then sleep 5; fi
    echo "-- FAKE SQL DUMP household-db" ;;
  *" tar -C /var/www/html "*) printf 'FAKE-FILES-TAR household-doc' ;;
  *) : ;;
esac
exit 0
`;
const FAKE_ALERT_LIB = 'send_alert() { printf "%s|%s|%s\\n" "$1" "$2" "${3:-}" >> "$FAKE_STATE/alerts.log"; }\n';

function setup() {
  const root = mkdtempSync(join(tmpdir(), "ws-bak-"));
  const ctx = { root, bundle: join(root, "bundle"), ws: join(root, "ws"), dest: join(root, "external"), st: join(root, "state"), bin: join(root, "bin"), gnupg: join(root, "gnupg") };
  for (const d of [ctx.bundle, ctx.ws, ctx.dest, ctx.st, ctx.bin, ctx.gnupg]) mkdirSync(d, { recursive: true });
  chmodSync(ctx.gnupg, 0o700);
  writeFileSync(join(ctx.bin, "dc"), FAKE_DC); chmodSync(join(ctx.bin, "dc"), 0o755);
  writeFileSync(join(ctx.bin, "alerts.sh"), FAKE_ALERT_LIB);
  writeFileSync(join(ctx.bundle, ".env"), "WORKSPACE_DB_PASSWORD=env-SECRET\n", { mode: 0o600 });
  writeFileSync(join(ctx.ws, "backup-passphrase"), "test-passphrase-123\n", { mode: 0o600 });
  ctxs.push(ctx);
  return ctx;
}
function baseEnv(ctx, extra = {}) {
  return {
    PATH: process.env.PATH, HOME: ctx.root, GNUPGHOME: ctx.gnupg, FAKE_STATE: ctx.st,
    CROW_BUNDLE_DIR: ctx.bundle, WORKSPACE_DATA_ROOT: ctx.ws, WORKSPACE_BACKUP_DEST: ctx.dest,
    WORKSPACE_DC: join(ctx.bin, "dc"), WORKSPACE_BACKUP_ALERT_LIB: join(ctx.bin, "alerts.sh"), ...extra,
  };
}
const runOps = (script, ctx, extra = {}, args = []) => {
  const r = spawnSync("bash", [join(OPS, script), ...args], { encoding: "utf8", env: baseEnv(ctx, extra) });
  return { ...r, out: `${r.stdout}\n${r.stderr}` };
};
const read = (ctx, f) => (existsSync(join(ctx.st, f)) ? readFileSync(join(ctx.st, f), "utf8") : "");
const archives = (dir) => readdirSync(dir).filter((n) => /^crow-workspace-\d{8}-\d{6}\.tar$/.test(n));
const listTar = (p) => spawnSync("tar", ["-tf", p], { encoding: "utf8" }).stdout.trim().split("\n").sort();

test("happy path: archive = 3 gpg members, no plaintext; staging (600) + drive; maintenance on then off; MYSQL_PWD", { skip: SKIP }, () => {
  const ctx = setup();
  const r = runOps("backup.sh", ctx);
  assert.equal(r.status, 0, r.out);
  const [name] = archives(ctx.dest);
  assert.ok(name);
  assert.deepEqual(archives(join(ctx.ws, "backups-staging")), [name]);
  assert.equal(statSync(join(ctx.ws, "backups-staging", name)).mode & 0o777, 0o600);
  assert.deepEqual(listTar(join(ctx.dest, name)), ["bundle.env.gpg", "db.sql.gpg", "files.tar.gpg"]);
  const bytes = readFileSync(join(ctx.dest, name));
  for (const plain of ["FAKE SQL DUMP", "FAKE-FILES-TAR", "env-SECRET"]) assert.ok(!bytes.includes(plain), plain);
  const c = read(ctx, "calls.log");
  assert.ok(c.indexOf("maintenance:mode --on") < c.indexOf("mariadb-dump"));
  assert.ok(c.indexOf(" tar -C /var/www/html ") < c.indexOf("maintenance:mode --off"));
  assert.match(c, /MYSQL_PWD="\$MARIADB_ROOT_PASSWORD" exec mariadb-dump/);
  assert.equal(read(ctx, "alerts.log"), "", "no alert on success");
});

test("restore.sh round-trips the archive into a private dir", { skip: SKIP }, () => {
  const ctx = setup();
  assert.equal(runOps("backup.sh", ctx).status, 0);
  const [name] = archives(ctx.dest);
  const target = join(ctx.root, "restored");
  const r = spawnSync("bash", [join(OPS, "restore.sh"), join(ctx.dest, name), target, join(ctx.ws, "backup-passphrase")], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: ctx.root, GNUPGHOME: ctx.gnupg } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(statSync(target).mode & 0o777, 0o700);
  assert.equal(readFileSync(join(target, "db.sql"), "utf8"), "-- FAKE SQL DUMP household-db\n");
  assert.equal(readFileSync(join(target, "nextcloud-files.tar"), "utf8"), "FAKE-FILES-TAR household-doc");
  assert.equal(readFileSync(join(target, "bundle.env"), "utf8"), "WORKSPACE_DB_PASSWORD=env-SECRET\n");
  assert.ok(!existsSync(join(target, "db.sql.gpg")), "encrypted members cleaned up");
});

test("REVIEW FOCUS 4 — failure and hang still turn maintenance off; no plaintext ever on disk", { skip: SKIP }, () => {
  const ctx = setup();
  writeFileSync(join(ctx.st, "fail-dump"), "");
  const r = runOps("backup.sh", ctx);
  assert.notEqual(r.status, 0);
  const c = read(ctx, "calls.log");
  assert.ok(c.lastIndexOf("maintenance:mode --off") > c.indexOf("maintenance:mode --on"));
  assert.deepEqual(archives(ctx.dest), []);
  assert.deepEqual(readdirSync(join(ctx.ws, "backups-staging")), []);
  assert.match(read(ctx, "alerts.log"), /Workspace backup FAILED/);

  const ctx2 = setup();
  writeFileSync(join(ctx2.st, "slow-dump"), "");
  assert.notEqual(runOps("backup.sh", ctx2, { WORKSPACE_BACKUP_HOLD_S: "1" }).status, 0);
  assert.match(read(ctx2, "calls.log"), /maintenance:mode --off/);
  assert.deepEqual(readdirSync(join(ctx2.ws, "backups-staging")), []);
});

test("REVIEW FOCUS 4 (SIGKILL) — ExecStopPost recovers maintenance mode, sweeps, alerts", () => {
  const ctx = setup();
  const leftover = join(ctx.ws, "backups-staging", "run-20261003-035500.abc123");
  mkdirSync(leftover, { recursive: true });
  writeFileSync(join(leftover, "db.sql.gpg"), "x");
  const r = runOps("backup-stoppost.sh", ctx, { SERVICE_RESULT: "signal", EXIT_CODE: "killed", EXIT_STATUS: "KILL" });
  assert.equal(r.status, 0, r.out);
  assert.match(read(ctx, "calls.log"), /exec -T -u www-data nextcloud php occ maintenance:mode --off/);
  assert.equal(existsSync(leftover), false);
  assert.match(read(ctx, "alerts.log"), /Workspace backup was killed \(signal/);
  const ok = setup();
  assert.equal(runOps("backup-stoppost.sh", ok, { SERVICE_RESULT: "success" }).status, 0);
  assert.equal(read(ok, "alerts.log"), "", "a clean run never alerts");
  assert.match(read(ok, "calls.log"), /maintenance:mode --off/, "always forces maintenance off (idempotent)");
});

test("a run starts by sweeping run-* left by a killed run", { skip: SKIP }, () => {
  const ctx = setup();
  const leftover = join(ctx.ws, "backups-staging", "run-old.zzz");
  mkdirSync(leftover, { recursive: true });
  assert.equal(runOps("backup.sh", ctx).status, 0);
  assert.equal(existsSync(leftover), false);
});

test("preflight refusals happen BEFORE maintenance mode: no dest, not a mountpoint, unwritable, passfile mode", { skip: SKIP }, () => {
  const cases = [
    [{ WORKSPACE_BACKUP_DEST: "" }, /WORKSPACE_BACKUP_DEST is not set/],
    [{ WORKSPACE_BACKUP_MOUNT: "/tmp" }, /is not a mounted filesystem/],
  ];
  for (const [extra, re] of cases) {
    const ctx = setup();
    if (extra.WORKSPACE_BACKUP_MOUNT && spawnSync("mountpoint", ["-q", "/tmp"]).status === 0) continue; // /tmp is a mount on this host; case not representable
    const r = runOps("backup.sh", ctx, extra);
    assert.notEqual(r.status, 0); assert.match(r.out, re); assert.doesNotMatch(read(ctx, "calls.log"), /maintenance:mode/);
    assert.match(read(ctx, "alerts.log"), /ABORTED/);
  }
  const ctx = setup();
  chmodSync(join(ctx.ws, "backup-passphrase"), 0o644);
  const r = runOps("backup.sh", ctx);
  assert.notEqual(r.status, 0); assert.match(r.out, /must be mode 600/); assert.doesNotMatch(read(ctx, "calls.log"), /maintenance:mode/);
  if (!(process.getuid && process.getuid() === 0)) {
    const c2 = setup(); const locked = join(c2.root, "locked"); mkdirSync(locked); chmodSync(locked, 0o500);
    const r2 = runOps("backup.sh", c2, { WORKSPACE_BACKUP_DEST: join(locked, "sub") });
    assert.notEqual(r2.status, 0); assert.match(r2.out, /not writable/); assert.doesNotMatch(read(c2, "calls.log"), /maintenance:mode/);
  }
});

test("retention: drive keeps 14 days, staging keeps only the newest", { skip: SKIP }, () => {
  const ctx = setup();
  const old = join(ctx.dest, "crow-workspace-20260901-035500.tar");
  const recent = join(ctx.dest, "crow-workspace-20260929-035500.tar");
  mkdirSync(join(ctx.ws, "backups-staging"), { recursive: true });
  const oldStaged = join(ctx.ws, "backups-staging", "crow-workspace-20260930-035500.tar");
  for (const p of [old, recent, oldStaged]) writeFileSync(p, "x");
  const now = Date.now() / 1000; const day = 86400;
  utimesSync(old, now - 15 * day, now - 15 * day);
  utimesSync(recent, now - 3 * day, now - 3 * day);
  assert.equal(runOps("backup.sh", ctx).status, 0);
  assert.equal(existsSync(old), false);
  assert.equal(existsSync(recent), true);
  assert.equal(existsSync(oldStaged), false);
  assert.equal(archives(join(ctx.ws, "backups-staging")).length, 1);
});

test("install-backup-timer.sh: --dest required; units carry dest/mount/alert-lib, ExecStopPost and caps; passphrase once", () => {
  const ctx = setup();
  rmSync(join(ctx.ws, "backup-passphrase"));
  const fakeCtl = join(ctx.bin, "systemctl");
  writeFileSync(fakeCtl, '#!/usr/bin/env bash\nprintf "%s\\n" "systemctl $*" >> "$FAKE_STATE/calls.log"\n'); chmodSync(fakeCtl, 0o755);
  const env = { PATH: process.env.PATH, HOME: ctx.root, FAKE_STATE: ctx.st, CROW_HOME: join(ctx.root, "crowhome"), CROW_BUNDLE_DIR: ctx.bundle, WORKSPACE_DATA_ROOT: ctx.ws, XDG_CONFIG_HOME: join(ctx.root, "cfg"), WORKSPACE_SYSTEMCTL: fakeCtl };
  const sh = (args) => spawnSync("bash", [join(OPS, "install-backup-timer.sh"), ...args], { encoding: "utf8", env });
  assert.notEqual(sh([]).status, 0, "no --dest → refused");
  const r1 = sh(["--dest", "/mnt/external/crow-workspace-backups", "--mount", "/mnt/external", "--alert-lib", "/home/k/lab-maintenance/scripts/lib/alerts.sh"]);
  assert.equal(r1.status, 0, r1.stderr);
  const pass = join(ctx.ws, "backup-passphrase");
  const secret = readFileSync(pass, "utf8").trim();
  assert.match(secret, /^[A-Za-z0-9]{48}$/);
  assert.equal(statSync(pass).mode & 0o777, 0o600);
  assert.ok(r1.stdout.includes(secret));
  const unit = (n) => readFileSync(join(ctx.root, "cfg", "systemd", "user", n), "utf8");
  const svc = unit("crow-workspace-backup.service");
  assert.match(svc, new RegExp(`ExecStart=/bin/bash ${ctx.bundle}/ops/backup.sh`));
  assert.match(svc, new RegExp(`ExecStopPost=/bin/bash ${ctx.bundle}/ops/backup-stoppost.sh`));
  assert.match(svc, /TimeoutStartSec=2h/);
  assert.match(svc, /TimeoutStopSec=5min/, "ExecStopPost runs under TimeoutStopSec: it must exceed stoppost's 120 s bound");
  assert.match(svc, /Environment=WORKSPACE_BACKUP_DEST=\/mnt\/external\/crow-workspace-backups/);
  assert.match(svc, /Environment=WORKSPACE_BACKUP_MOUNT=\/mnt\/external/);
  assert.match(svc, /Environment=WORKSPACE_BACKUP_ALERT_LIB=\/home\/k\/lab-maintenance\/scripts\/lib\/alerts\.sh/);
  assert.doesNotMatch(svc, /Nice=|IOSchedulingClass=/);
  const tmr = unit("crow-workspace-backup.timer");
  assert.match(tmr, /OnCalendar=\*-\*-\* 03:55:00/);
  assert.match(tmr, /Persistent=true/);
  assert.doesNotMatch(tmr, /RandomizedDelaySec/);
  assert.match(read(ctx, "calls.log"), /systemctl --user enable --now crow-workspace-backup\.timer/);
  const r2 = sh(["--dest", "/mnt/external/crow-workspace-backups"]);
  assert.equal(r2.status, 0);
  assert.ok(!r2.stdout.includes(secret));
  assert.equal(readFileSync(pass, "utf8").trim(), secret);
});

test("scratch-restore override never restarts, publishes nothing, uses its own subnet", () => {
  const o = readFileSync(join(OPS, "restore-scratch.override.yml"), "utf8");
  for (const s of ["nextcloud", "nextcloud-cron", "nextcloud-db", "nextcloud-redis", "onlyoffice"]) assert.match(o, new RegExp(`  ${s}:\\n    restart: "no"`), s);
  assert.match(o, /ports: !reset \[\]/);
  assert.match(o, /subnet: 10\.89\.72\.0\/24/);
});

test("maintenance --on that applies but returns non-zero → --off still runs; --on/--off run under timeout", { skip: SKIP }, () => {
  const ctx = setup();
  writeFileSync(join(ctx.st, "on-fails-after-applying"), "");
  const r = runOps("backup.sh", ctx);
  assert.notEqual(r.status, 0);
  assert.match(read(ctx, "maint.log"), /on-applied/);
  const c = read(ctx, "calls.log");
  assert.ok(c.lastIndexOf("maintenance:mode --off") > c.indexOf("maintenance:mode --on"));
  const src = readFileSync(join(OPS, "backup.sh"), "utf8");
  assert.equal((src.match(/timeout 60 \$DC exec -T -u www-data nextcloud php occ maintenance:mode --(on|off)/g) || []).length, 3, "on, in-band off, trap off");
  assert.doesNotMatch(src, /^occ maintenance:mode/m);
  assert.match(src, /--no-symkey-cache/);
});

test("install-backup-timer.sh refuses when the bundle dir has no .env (run from a checkout) and prints the resolved dir otherwise", () => {
  const ctx = setup();
  const env = { PATH: process.env.PATH, HOME: ctx.root, FAKE_STATE: ctx.st, CROW_HOME: join(ctx.root, "crowhome"), CROW_BUNDLE_DIR: ctx.bundle, WORKSPACE_DATA_ROOT: ctx.ws, XDG_CONFIG_HOME: join(ctx.root, "cfg"), WORKSPACE_SYSTEMCTL: "true" };
  rmSync(join(ctx.bundle, ".env"));
  const bad = spawnSync("bash", [join(OPS, "install-backup-timer.sh"), "--dest", "/x"], { encoding: "utf8", env });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /~\/\.crow\/bundles\/workspace\/ops\//);
  assert.ok(!existsSync(join(ctx.root, "cfg", "systemd")), "no units written");
  writeFileSync(join(ctx.bundle, ".env"), "X=1\n", { mode: 0o600 });
  const ok = spawnSync("bash", [join(OPS, "install-backup-timer.sh"), "--dest", "/x"], { encoding: "utf8", env });
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(ok.stdout.includes(`Using bundle dir: ${ctx.bundle}`));
});
