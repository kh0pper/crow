/**
 * scripts/ops/install-boot-guard.sh, dry run against fixture units (audit N1c-3 L1).
 *
 * The real script writes into a systemd unit directory and can call
 * `daemon-reload`; neither may happen from a test. Every case here runs with
 * `--dry-run` and CROW_SYSTEMD_(USER_)UNIT_DIR pointing at a scratch directory,
 * so what is asserted is the exact drop-in the operator will get.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { test, after } from "node:test";
import assert from "node:assert/strict";

const SCRIPT = join(import.meta.dirname, "..", "scripts", "ops", "install-boot-guard.sh");
const _dirs = [];
after(() => { for (const d of _dirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} } });

function scratch(prefix = "bg-install-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  _dirs.push(dir);
  return dir;
}

/** A fake node that reports `version`; returns its absolute path. */
function fakeNode(dir, version, name = "node") {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\necho v${version}\n`);
  chmodSync(path, 0o755);
  return path;
}

function fixtureUnit(unitDir, name, body) {
  mkdirSync(unitDir, { recursive: true });
  const path = join(unitDir, name);
  writeFileSync(path, body);
  return path;
}

const UNIT = ({ node, workdir = "/srv/crow", crowHome = "/srv/crow-home", execStart = null }) => `[Unit]
Description=Crow Gateway
After=network-online.target

[Service]
Type=simple
User=alice
WorkingDirectory=${workdir}
ExecStart=${execStart ?? `${node} servers/gateway/index.js`}
Restart=on-failure
Environment=NODE_ENV=production
Environment=CROW_HOME=${crowHome}

[Install]
WantedBy=multi-user.target
`;

function run(args, env) {
  return spawnSync("bash", [SCRIPT, ...args], {
    // No fake systemctl by default: /bin/false makes the merged read fail, so the
    // fixture unit FILE is what the script reads (the pre-5c behaviour). Tests
    // that exercise the merged read pass CROW_SYSTEMCTL explicitly.
    env: { ...process.env, CROW_SYSTEMCTL: "/bin/false", ...env },
    encoding: "utf8", timeout: 60_000,
  });
}

/**
 * A `sudo` that logs its argv and then runs it, plus a `systemctl` that never
 * reaches the real daemon (a test must not reload the machine's systemd).
 */
function fakePrivileged(base) {
  const dir = join(base, "priv-bin");
  mkdirSync(dir, { recursive: true });
  const log = join(base, "privileged.log");
  for (const [name, body] of [
    // `-u <user>` is dropped: this test is not root, so the real command must run
    // as the current user — the log still records the argv the installer used.
    ["sudo", `#!/bin/sh\nprintf 'sudo %s\\n' "$*" >> ${JSON.stringify(log)}\n[ "$1" = "-u" ] && shift 2\nexec "$@"\n`],
    ["systemctl", `#!/bin/sh\nprintf 'systemctl %s\\n' "$*" >> ${JSON.stringify(log)}\nexit 0\n`],
  ]) {
    writeFileSync(join(dir, name), body);
    chmodSync(join(dir, name), 0o755);
  }
  return { dir, log };
}

/**
 * A fake `systemctl show` that merges a fixture unit with its drop-ins, and
 * prints properties the way real systemd does: ExecStart (from the service
 * table) FIRST, then the exec-context fields Environment, WorkingDirectory,
 * User — whatever order the `-p` flags were given in — with every
 * `Environment=` line (unit and drop-ins) merged into ONE space-separated line,
 * in systemd's real `{ path=… ; argv[]=… ; … }` ExecStart form. Each call is
 * logged, so a test can pin "one property per call".
 */
function fakeSystemctlMerging(base, unitDir) {
  const dir = join(base, "fake-systemctl-bin");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "fake-systemctl");
  const log = join(base, "systemctl.log");
  writeFileSync(path, `#!/bin/sh
log=${JSON.stringify(log)}
printf '%s\\n' "$*" >> "$log"
unit=""
wanted=" "
while [ "$#" -gt 0 ]; do
  case "$1" in
    -p) shift; wanted="$wanted$1 " ;;
    --user|--value) ;;
    -*) echo "unexpected flag: $1" >&2; exit 2 ;;
    *) unit="$1" ;;
  esac
  shift
done
case "$unit" in
  "") echo "no unit named" >&2; exit 1 ;;
esac
file="${unitDir}/$unit"
body=""
[ -f "$file" ] && body="$(cat "$file")"
if [ -d "$file.d" ]; then
  for f in "$file.d"/*.conf; do
    [ -e "$f" ] || continue
    body="$body
$(cat "$f")"
  done
fi
val() { printf '%s\\n' "$body" | sed -n "s/^[[:space:]]*$1=//p" | tail -n 1; }
# systemd merges EVERY Environment= line into ONE space-separated line.
envs="$(printf '%s\\n' "$body" | sed -n 's/^[[:space:]]*Environment=//p' | tr '\\n' ' ')"
raw="$(val ExecStart)"
case "$raw" in
  -*) raw="\${raw#-}" ;;
esac
# path= is systemd's RESOLVED program: the longest prefix naming a file (a
# program path may contain spaces; argv[] is space-joined and cannot say where
# the program ends).
exe="$raw"
while [ -n "$exe" ] && [ ! -f "$exe" ]; do
  next="\${exe% *}"
  [ "$next" = "$exe" ] && break
  exe="$next"
done
[ -n "$exe" ] || exe="\${raw%% *}"
emit() { case "$wanted" in *" $1 "*) printf '%s\\n' "$2" ;; esac; }
emit ExecStart "{ path=$exe ; argv[]=$raw ; ignore_errors=no ; start_time=[Thu 2026-11-05 11:20:12 CST] ; stop_time=[n/a] ; pid=1234 ; code=(null) ; status=0/0 }"
emit Environment "$envs"
emit WorkingDirectory "$(val WorkingDirectory)"
emit User "$(val User)"
exit 0
`);
  chmodSync(path, 0o755);
  return { path, log };
}

/**
 * A PATH prefix that makes the installer believe it runs as root: `id -u`
 * prints 0, `sudo` drops `-u <user>` and execs the rest, and any `chown` is
 * logged instead of run. The log proves root never chowns inside the guard dir.
 */
function fakeRootShims(base) {
  const dir = join(base, "root-shims");
  mkdirSync(dir, { recursive: true });
  const log = join(base, "root.log");
  for (const [name, body] of [
    ["id", `#!/bin/sh\nprintf '0\\n'\n`],
    ["sudo", `#!/bin/sh\nprintf 'sudo %s\\n' "$*" >> ${JSON.stringify(log)}\n[ "$1" = "-u" ] && shift 2\nexec "$@"\n`],
    ["chown", `#!/bin/sh\nprintf 'chown %s\\n' "$*" >> ${JSON.stringify(log)}\nexit 0\n`],
    ["systemctl", `#!/bin/sh\nprintf 'systemctl %s\\n' "$*" >> ${JSON.stringify(log)}\nexit 0\n`],
  ]) {
    writeFileSync(join(dir, name), body);
    chmodSync(join(dir, name), 0o755);
  }
  return { dir, log };
}

/**
 * Shims for the branch a minimal container takes: `id` says root and there is NO
 * usable sudo (the test points CROW_SUDO at a missing path). `install` logs its
 * argv and drops `-o <owner>` before running the real install — this test is not
 * root, so the real one would refuse to change ownership. Returns null when
 * coreutils' install cannot be found.
 */
function fakeRootNoSudoShims(base) {
  const which = spawnSync("sh", ["-c", "command -v install"], { encoding: "utf8" });
  const real = (which.stdout || "").trim();
  if (which.status !== 0 || !real) return null;
  const dir = join(base, "root-nosudo-shims");
  mkdirSync(dir, { recursive: true });
  const log = join(base, "root-nosudo.log");
  const installShim = `#!/usr/bin/env bash
printf 'install %s\\n' "$*" >> ${JSON.stringify(log)}
args=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) shift 2 ;;
    *) args+=("$1"); shift ;;
  esac
done
exec ${real} "\${args[@]}"
`;
  for (const [name, body] of [
    ["id", `#!/bin/sh\nprintf '0\\n'\n`],
    ["chown", `#!/bin/sh\nprintf 'chown %s\\n' "$*" >> ${JSON.stringify(log)}\nexit 0\n`],
    ["systemctl", `#!/bin/sh\nprintf 'systemctl %s\\n' "$*" >> ${JSON.stringify(log)}\nexit 0\n`],
    ["install", installShim],
  ]) {
    writeFileSync(join(dir, name), body);
    chmodSync(join(dir, name), 0o755);
  }
  return { dir, log };
}

/** Every logged command that touches the guard directory (one per line). */
function guardCommands(log, guard) {
  return log.split("\n").filter((line) => line.trim() !== "" && line.includes(guard));
}

/** The drop-in body the dry run printed. */
function printedDropin(stdout) {
  const start = stdout.indexOf("----- 10-boot-guard.conf -----");
  const end = stdout.indexOf("-------------------------", start);
  assert.ok(start >= 0 && end > start, `no drop-in printed:\n${stdout}`);
  return stdout.slice(start + "----- 10-boot-guard.conf -----\n".length, end).trimEnd();
}

/* ------------------------------------------------------------- system */

test("system unit: dry run names <unit>.d/10-boot-guard.conf and writes nothing", () => {
  const base = scratch();
  const unitDir = join(base, "units");
  const node = fakeNode(join(base, "bin"), "24.21.0");
  fixtureUnit(unitDir, "crow-gateway.service", UNIT({ node }));

  const r = run(["--dry-run"], { CROW_SYSTEMD_UNIT_DIR: unitDir });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`would write: ${unitDir}/crow-gateway\\.service\\.d/10-boot-guard\\.conf`));
  assert.equal(existsSync(join(unitDir, "crow-gateway.service.d")), false, "a dry run must not create anything");

  const dropin = printedDropin(r.stdout);
  assert.match(dropin, /^\[Service\]$/m);
  assert.ok(dropin.includes(`ExecStartPre=-"${node}" "/srv/crow-home/boot-guard/crow-boot-guard.mjs" --app-root "/srv/crow"`),
    dropin);
  assert.ok(dropin.includes(`ExecStopPost=-"${node}" "/srv/crow-home/boot-guard/crow-boot-guard.mjs" --app-root "/srv/crow" --record-exit`),
    dropin);
  assert.match(dropin, /^TimeoutStartSec=15min$/m, "the guard runs npm install, so the start timeout must cover it");
  assert.match(dropin, /^Environment=CROW_BOOT_GUARD=1$/m);
  assert.doesNotMatch(r.stdout, /sudo/, "a dry run must never escalate");
  // The dry run DOES read the merged unit values through `systemctl show`, so the
  // banner must not claim systemctl is never called.
  assert.doesNotMatch(r.stdout, /systemctl is never called/);
  assert.match(r.stdout, /dry run:.*nothing will be written/);
  assert.match(r.stdout, /would install: \/srv\/crow-home\/boot-guard\/crow-boot-guard\.mjs \(dir 0700, file 0600\)/);
});

test("every crow-*gateway*.service in the unit dir gets the drop-in", () => {
  const base = scratch();
  const unitDir = join(base, "units");
  const node = fakeNode(join(base, "bin"), "24.21.0");
  fixtureUnit(unitDir, "crow-gateway.service", UNIT({ node }));
  fixtureUnit(unitDir, "crow-b-gateway.service", UNIT({ node, workdir: "/srv/crow-b", crowHome: "/srv/crow-b-home" }));
  fixtureUnit(unitDir, "crow-scheduler.service", "[Service]\nExecStart=/bin/true\n");

  const r = run(["--dry-run"], { CROW_SYSTEMD_UNIT_DIR: unitDir });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /crow-gateway\.service\.d\/10-boot-guard\.conf/);
  assert.match(r.stdout, /crow-b-gateway\.service\.d\/10-boot-guard\.conf/);
  assert.match(r.stdout, /crow-b-home\/boot-guard\/crow-boot-guard\.mjs" --app-root "\/srv\/crow-b/);
  assert.doesNotMatch(r.stdout, /crow-scheduler\.service\.d/);
});

test("CROW_HOME comes from the unit's environment", () => {
  const base = scratch();
  const unitDir = join(base, "units");
  const node = fakeNode(join(base, "bin"), "24.21.0");
  fixtureUnit(unitDir, "crow-gateway.service", UNIT({ node, crowHome: "/opt/custom-crow" }));
  const r = run(["--dry-run"], { CROW_SYSTEMD_UNIT_DIR: unitDir });
  assert.ok(printedDropin(r.stdout).includes("/opt/custom-crow/boot-guard/crow-boot-guard.mjs"));
});

/* ----------------------------------------------------------------- node */

test("node comes from ExecStart's argv[0] when it is node", () => {
  const base = scratch();
  const unitDir = join(base, "units");
  const node = fakeNode(join(base, "direct"), "24.1.0");
  // A PATH that also has a node: ExecStart must win.
  fakeNode(join(base, "pathbin"), "22.20.0");
  fixtureUnit(unitDir, "crow-gateway.service",
    UNIT({ node }).replace("Environment=NODE_ENV=production", `Environment=PATH=${join(base, "pathbin")}\nEnvironment=NODE_ENV=production`));
  const r = run(["--dry-run"], { CROW_SYSTEMD_UNIT_DIR: unitDir });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(printedDropin(r.stdout).includes(`ExecStartPre=-"${node}" `), `expected ${node}:\n${r.stdout}`);
});

test("an `npm run gateway` ExecStart resolves node from the unit's Environment=PATH", () => {
  const base = scratch();
  const unitDir = join(base, "units");
  const pathbin = join(base, "nvm-bin");
  const node = fakeNode(pathbin, "24.21.0");
  fixtureUnit(unitDir, "crow-gateway.service", UNIT({
    node: "/nonexistent", execStart: "/usr/bin/npm run gateway",
  }).replace("Environment=NODE_ENV=production", `Environment=PATH=${pathbin}:/usr/bin:/bin\nEnvironment=NODE_ENV=production`));
  const r = run(["--dry-run"], { CROW_SYSTEMD_UNIT_DIR: unitDir });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(printedDropin(r.stdout).includes(`ExecStartPre=-"${node}" `), true, r.stdout);
});

test("a node older than 22.13 is refused (the launcher needs node:sqlite)", () => {
  const base = scratch();
  const unitDir = join(base, "units");
  const node = fakeNode(join(base, "old"), "22.10.0");
  fixtureUnit(unitDir, "crow-gateway.service", UNIT({ node }));
  const r = run(["--dry-run"], { CROW_SYSTEMD_UNIT_DIR: unitDir });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /older than 22\.13/);
  assert.equal(existsSync(join(unitDir, "crow-gateway.service.d")), false);
});

/* ----------------------------------------------------------------- user */

test("--user writes the user unit dir and never escalates", () => {
  const base = scratch();
  const unitDir = join(base, "user-units");
  const node = fakeNode(join(base, "bin"), "24.21.0");
  fixtureUnit(unitDir, "crow-gateway.service", UNIT({ node, workdir: "/home/u/crow", crowHome: "/home/u/.crow" }).replace("User=alice\n", ""));

  const r = run(["--user", "--dry-run"], { CROW_SYSTEMD_USER_UNIT_DIR: unitDir, HOME: base });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`would write: ${unitDir}/crow-gateway\\.service\\.d/10-boot-guard\\.conf`));
  assert.doesNotMatch(r.stdout, /sudo/);
  assert.doesNotMatch(r.stderr, /sudo/);
  assert.ok(printedDropin(r.stdout).includes('--app-root "/home/u/crow"'));
});

/* ------------------------------------------- merged values (systemctl show) */

test("CROW_HOME and WorkingDirectory come from the MERGED unit, drop-ins included", () => {
  // A second co-hosted unit can set its own CROW_HOME in a drop-in; reading only
  // the main unit file would wire it to the other instance's launcher copy.
  const base = scratch();
  const unitDir = join(base, "units");
  const node = fakeNode(join(base, "bin"), "24.21.0");
  const mergedHome = join(base, "merged-home");
  // A space and a % in the path: the drop-in must quote it, and %% is how systemd
  // writes one literal percent.
  const appRoot = join(base, "crow app 100%");
  fixtureUnit(unitDir, "crow-gateway.service",
    UNIT({ node, crowHome: join(base, "unit-home"), workdir: `-${appRoot}` }));
  mkdirSync(join(unitDir, "crow-gateway.service.d"), { recursive: true });
  writeFileSync(join(unitDir, "crow-gateway.service.d", "20-home.conf"), `[Service]\nEnvironment=CROW_HOME=${mergedHome}\n`);

  const fake = fakeSystemctlMerging(base, unitDir);
  const r = run(["--dry-run"], {
    CROW_SYSTEMD_UNIT_DIR: unitDir, CROW_SYSTEMCTL: fake.path,
  });
  assert.equal(r.status, 0, r.stderr);
  const dropin = printedDropin(r.stdout);
  assert.ok(dropin.includes(`"${mergedHome}/boot-guard/crow-boot-guard.mjs"`), `drop-in CROW_HOME ignored:\n${dropin}`);
  // WorkingDirectory=-/path: the optional-exec '-' is not part of the path, and
  // the path is quoted with % doubled.
  assert.ok(dropin.includes(`--app-root "${appRoot.replace("%", "%%")}"`), dropin);
  assert.match(r.stdout, /would install: .*merged-home\/boot-guard\/crow-boot-guard\.mjs/);
  // The unit's own Environment= and the drop-in's are ONE merged line, so the
  // LAST CROW_HOME wins and the unit's PATH is still found.
  assert.ok(dropin.includes(`ExecStartPre=-"${node}" `), dropin);
});

test("one property per call: systemd's output order cannot misassign the values", () => {
  // systemctl prints ExecStart first, then Environment, WorkingDirectory, User,
  // whatever order the -p flags had. Reading them positionally hands every
  // variable its neighbour's value: the drop-in then carries the Environment
  // string as --app-root and the user name as the node path.
  const base = scratch();
  const unitDir = join(base, "units");
  const node = fakeNode(join(base, "bin"), "24.21.0");
  const crowHome = join(base, "crow-home");
  const appRoot = join(base, "app");
  fixtureUnit(unitDir, "crow-gateway.service", UNIT({ node, crowHome, workdir: appRoot }));
  const fake = fakeSystemctlMerging(base, unitDir);

  const r = run(["--dry-run"], { CROW_SYSTEMD_UNIT_DIR: unitDir, CROW_SYSTEMCTL: fake.path });
  assert.equal(r.status, 0, r.stderr);
  const dropin = printedDropin(r.stdout);
  assert.ok(dropin.includes(`ExecStartPre=-"${node}" "${crowHome}/boot-guard/crow-boot-guard.mjs" --app-root "${appRoot}"`),
    `every value must come from its own property:\n${dropin}`);

  const calls = readFileSync(fake.log, "utf8").trim().split("\n");
  assert.equal(calls.length, 4, `expected one show call per property:\n${calls.join("\n")}`);
  for (const call of calls) {
    assert.equal((call.match(/-p /g) || []).length, 1, `one property per call, got: ${call}`);
  }
});

test("a node path containing a space comes from ExecStart's path= field", () => {
  // argv[] is space-joined, so the program path is ambiguous there; systemd's
  // path= is not.
  const base = scratch();
  const unitDir = join(base, "units");
  const node = fakeNode(join(base, "node dir"), "24.21.0");
  fixtureUnit(unitDir, "crow-gateway.service",
    UNIT({ node, crowHome: join(base, "crow-home"), workdir: join(base, "app") }));
  const fake = fakeSystemctlMerging(base, unitDir);

  const r = run(["--dry-run"], { CROW_SYSTEMD_UNIT_DIR: unitDir, CROW_SYSTEMCTL: fake.path });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(printedDropin(r.stdout).includes(`ExecStartPre=-"${node}" `), printedDropin(r.stdout));
});

test("an argv carrying --db-path= does not shadow ExecStart's path= field", () => {
  // exec_start_field matched with a greedy `.*path=`, i.e. the LAST `path=` in the
  // struct — which an argument like `--db-path=/x` supplies. The node path here
  // contains a space, where argv[0] is ambiguous and path= is the only source, so
  // the installer fell back to the first node on the runner's $PATH and wired the
  // drop-in to a different node than the unit runs (audit L1 review 3 nit).
  const base = scratch();
  const unitDir = join(base, "units");
  const node = fakeNode(join(base, "node dir"), "24.21.0");
  fixtureUnit(unitDir, "crow-gateway.service", UNIT({
    node,
    crowHome: join(base, "crow-home"),
    workdir: join(base, "app"),
    execStart: `${node} servers/gateway/index.js --db-path=/x`,
  }));
  const fake = fakeSystemctlMerging(base, unitDir);

  const r = run(["--dry-run"], { CROW_SYSTEMD_UNIT_DIR: unitDir, CROW_SYSTEMCTL: fake.path });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const dropin = printedDropin(r.stdout);
  assert.ok(dropin.includes(`ExecStartPre=-"${node}" `), `node must still come from path=:\n${dropin}`);
});

test("a quoted Environment value keeps its space through the merged line", () => {
  const base = scratch();
  const unitDir = join(base, "units");
  const node = fakeNode(join(base, "bin"), "24.21.0");
  const crowHome = join(base, "crow home");
  fixtureUnit(unitDir, "crow-gateway.service",
    UNIT({ node, crowHome: "PLACEHOLDER", workdir: join(base, "app") })
      .replace("Environment=CROW_HOME=PLACEHOLDER", `Environment="CROW_HOME=${crowHome}"`));
  const fake = fakeSystemctlMerging(base, unitDir);

  const r = run(["--dry-run"], { CROW_SYSTEMD_UNIT_DIR: unitDir, CROW_SYSTEMCTL: fake.path });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(`would install: ${crowHome}/boot-guard/crow-boot-guard.mjs`), r.stdout);
  assert.ok(printedDropin(r.stdout).includes(`"${crowHome}/boot-guard/crow-boot-guard.mjs"`), printedDropin(r.stdout));
});

test("a \\x20 escape in a merged Environment value is a space", () => {
  const base = scratch();
  const unitDir = join(base, "units");
  const node = fakeNode(join(base, "bin"), "24.21.0");
  const crowHome = join(base, "crow home");
  fixtureUnit(unitDir, "crow-gateway.service",
    UNIT({ node, crowHome: "PLACEHOLDER", workdir: join(base, "app") })
      .replace("Environment=CROW_HOME=PLACEHOLDER", `Environment=CROW_HOME=${crowHome.replace(" ", "\\x20")}`));
  const fake = fakeSystemctlMerging(base, unitDir);

  const r = run(["--dry-run"], { CROW_SYSTEMD_UNIT_DIR: unitDir, CROW_SYSTEMCTL: fake.path });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(printedDropin(r.stdout).includes(`"${crowHome}/boot-guard/crow-boot-guard.mjs"`), printedDropin(r.stdout));
});

test("CROW_HOME from a drop-in Environment line is merged with the unit's PATH", () => {
  // The raven shape: an `npm run gateway` unit whose PATH is in the unit file and
  // whose CROW_HOME is only in a drop-in. One show call per property still has to
  // see both.
  const base = scratch();
  const unitDir = join(base, "units");
  const pathbin = join(base, "nvm-bin");
  const node = fakeNode(pathbin, "24.21.0");
  const mergedHome = join(base, "merged-home");
  const appRoot = join(base, "app");
  fixtureUnit(unitDir, "crow-gateway.service", UNIT({
    node: "/nonexistent", execStart: "/usr/bin/npm run gateway", crowHome: join(base, "unit-home"), workdir: appRoot,
  }).replace("Environment=NODE_ENV=production", `Environment=PATH=${pathbin}:/usr/bin:/bin\nEnvironment=NODE_ENV=production`));
  mkdirSync(join(unitDir, "crow-gateway.service.d"), { recursive: true });
  writeFileSync(join(unitDir, "crow-gateway.service.d", "20-home.conf"), `[Service]\nEnvironment=CROW_HOME=${mergedHome}\n`);
  const fake = fakeSystemctlMerging(base, unitDir);

  const r = run(["--dry-run"], { CROW_SYSTEMD_UNIT_DIR: unitDir, CROW_SYSTEMCTL: fake.path });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(printedDropin(r.stdout).includes(
    `ExecStartPre=-"${node}" "${mergedHome}/boot-guard/crow-boot-guard.mjs" --app-root "${appRoot}"`),
  printedDropin(r.stdout));
});

test("a templated unit is refused with a clear message", () => {
  const base = scratch();
  const unitDir = join(base, "units");
  const node = fakeNode(join(base, "bin"), "24.21.0");
  fixtureUnit(unitDir, "crow-gateway@1.service", UNIT({ node }));
  const r = run(["--dry-run"], { CROW_SYSTEMD_UNIT_DIR: unitDir });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /templated unit/);
  assert.equal(existsSync(join(unitDir, "crow-gateway@1.service.d")), false);
});

/* --------------------------------------------------- the real write path */

test("the real write path uses mktemp + a privileged install, not a redirect", (t) => {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    t.skip("running as root: the installer has no sudo hop to observe");
    return;
  }
  // NOT --dry-run: a non-root run must still be able to write the drop-in, and
  // the privileged half must be a single `install -m 644` from a temp file that
  // lives outside the unit directory.
  const base = scratch();
  const unitDir = join(base, "units");
  const node = fakeNode(join(base, "bin"), "24.21.0");
  const crowHome = join(base, "crow-home");
  const appRoot = join(base, "app");
  const tmpDir = join(base, "tmp");
  mkdirSync(tmpDir, { recursive: true });
  fixtureUnit(unitDir, "crow-gateway.service",
    UNIT({ node, crowHome, workdir: appRoot }).replace("User=alice\n", ""));
  const priv = fakePrivileged(base);

  const r = run([], {
    CROW_SYSTEMD_UNIT_DIR: unitDir,
    TMPDIR: tmpDir,
    PATH: `${priv.dir}:${process.env.PATH}`,
  });
  assert.equal(r.status, 0, r.stderr);

  const dropinPath = join(unitDir, "crow-gateway.service.d", "10-boot-guard.conf");
  assert.ok(existsSync(dropinPath), `the drop-in must be written:\n${r.stdout}\n${r.stderr}`);
  const log = readFileSync(priv.log, "utf8");
  // The body comes from mktemp OUTSIDE the unit dir, and lands through install.
  assert.match(log, new RegExp(`sudo install -m 644 ${tmpDir}/crow-boot-guard\\.\\w+ \\S*10-boot-guard\\.conf`),
    `the drop-in must be installed from a temp file outside the unit dir:\n${log}`);
  assert.doesNotMatch(log, /sudo cp /, "the old redirect + cp path must be gone");
  // ...and what lands on disk is the body the installer meant to write.
  const body = readFileSync(dropinPath, "utf8");
  assert.match(body, /^\[Service\]$/m, body);
  assert.ok(body.includes(`ExecStartPre=-"${node}" "${crowHome}/boot-guard/crow-boot-guard.mjs" --app-root "${appRoot}"`), body);
  assert.ok(body.includes(`ExecStopPost=-"${node}" "${crowHome}/boot-guard/crow-boot-guard.mjs" --app-root "${appRoot}" --record-exit`), body);
  assert.match(body, /^TimeoutStartSec=15min$/m, body);
  assert.match(body, /^Environment=CROW_BOOT_GUARD=1$/m, body);
  // Nothing but the drop-in is left in the drop-in directory (no temp files),
  // and the temp dir the body was staged in is empty again.
  assert.deepEqual(readdirSync(join(unitDir, "crow-gateway.service.d")), ["10-boot-guard.conf"]);
  assert.deepEqual(readdirSync(tmpDir), []);
  // And the launcher copy landed in the unit's own CROW_HOME, mode 0600.
  const copy = join(crowHome, "boot-guard", "crow-boot-guard.mjs");
  assert.ok(existsSync(copy), "the launcher copy must be installed");
  assert.equal(readFileSync(copy, "utf8"), readFileSync(join(import.meta.dirname, "..", "scripts", "boot-guard", "crow-boot-guard.mjs"), "utf8"));
  assert.equal(statSync(copy).mode & 0o777, 0o600, "the launcher copy is 0600");
});

test("as root no chown runs on any path inside the guard dir", () => {
  // Root behaviour without root: shims put `id -u` = 0 and capture every sudo /
  // chown argv. The copy must be made BY the unit's user (sudo -u), so root never
  // chowns a predictable temp path in a directory that user can rewrite.
  const base = scratch();
  const unitDir = join(base, "units");
  const node = fakeNode(join(base, "bin"), "24.21.0");
  const crowHome = join(base, "crow-home");
  // User=alice, so the installer has an owner to hand the copy to.
  fixtureUnit(unitDir, "crow-gateway.service", UNIT({ node, crowHome, workdir: join(base, "app") }));
  const shims = fakeRootShims(base);

  const r = run([], {
    CROW_SYSTEMD_UNIT_DIR: unitDir,
    PATH: `${shims.dir}:${process.env.PATH}`,
  });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);

  const log = readFileSync(shims.log, "utf8");
  const guard = join(crowHome, "boot-guard");
  assert.doesNotMatch(log, /(^|\n|sudo )chown /, `root must never chown inside the guard dir:\n${log}`);
  assert.ok(log.includes(`sudo -u alice install -d -m 700 ${guard}`), `the guard dir must be made by its owner:\n${log}`);
  assert.ok(log.includes(`sudo -u alice install -m 600 `), `the copy must be installed by its owner:\n${log}`);
  assert.ok(log.includes(` ${guard}/crow-boot-guard.mjs.tmp.`), `the copy must land in the guard dir:\n${log}`);
  assert.ok(log.includes(`sudo -u alice mv -f `), `the replace must be the owner's rename too:\n${log}`);
  // Nothing may go through a bare `sudo`: in system mode that is root doing the
  // write inside the service user's directory.
  assert.doesNotMatch(log, /^sudo (mkdir|install|mv) /m, `no root write in the guard dir:\n${log}`);

  const copy = join(guard, "crow-boot-guard.mjs");
  assert.ok(existsSync(copy), "the launcher copy must be installed");
  assert.equal(readFileSync(copy, "utf8"), readFileSync(join(import.meta.dirname, "..", "scripts", "boot-guard", "crow-boot-guard.mjs"), "utf8"));
});

test("a non-root system-mode run with User= as itself installs the copy directly", (t) => {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    t.skip("running as root: there is no unprivileged sudo hop to observe");
    return;
  }
  // In system mode `run` prefixes sudo, and the old launcher branch went through
  // it: `sudo mkdir -m 700` and `sudo install -m 600` left the guard dir and the
  // copy root-owned 0700/0600 inside the operator's CROW_HOME, so the gateway's
  // own user could not read them and ExecStartPre failed behind its silent `-`
  // (audit L1 review 3, 5b(a)).
  const base = scratch();
  const unitDir = join(base, "units");
  const node = fakeNode(join(base, "bin"), "24.21.0");
  const crowHome = join(base, "crow-home");
  const guard = join(crowHome, "boot-guard");
  fixtureUnit(unitDir, "crow-gateway.service",
    UNIT({ node, crowHome, workdir: join(base, "app") }).replace("User=alice", `User=${userInfo().username}`));
  const priv = fakePrivileged(base);

  const r = run([], {
    CROW_SYSTEMD_UNIT_DIR: unitDir,
    PATH: `${priv.dir}:${process.env.PATH}`,
  });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);

  const log = readFileSync(priv.log, "utf8");
  // The copy belongs to the unit's user, and that user is us: nothing escalates.
  assert.deepEqual(guardCommands(log, guard), [], `no sudo may touch the guard dir:\n${log}`);
  assert.doesNotMatch(log, /sudo install -m 600/, `the copy must not be installed by root:\n${log}`);
  // The drop-in itself still needs the hop: it lives in the (root-owned) unit dir.
  assert.match(log, /sudo install -m 644 /, `the drop-in still goes through sudo:\n${log}`);

  const copy = join(guard, "crow-boot-guard.mjs");
  assert.ok(existsSync(copy), "the launcher copy must be installed");
  assert.equal(readFileSync(copy, "utf8"),
    readFileSync(join(import.meta.dirname, "..", "scripts", "boot-guard", "crow-boot-guard.mjs"), "utf8"));
  assert.equal(statSync(copy).mode & 0o777, 0o600, "the launcher copy is 0600");
  assert.equal(statSync(guard).mode & 0o777, 0o700, "the guard dir is 0700");
});

test("a non-root system-mode run with another owner runs the three steps as that owner", (t) => {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    t.skip("running as root: the installer would take the root branch");
    return;
  }
  // `sudo mkdir -m 700` + `sudo install -m 600` (the old branch) put a root-owned
  // 0700 dir and 0600 copy in the service user's CROW_HOME. Every guard-dir step
  // must instead be run BY that user.
  const base = scratch();
  const unitDir = join(base, "units");
  const node = fakeNode(join(base, "bin"), "24.21.0");
  const crowHome = join(base, "crow-home");
  const guard = join(crowHome, "boot-guard");
  // A name that is never the test runner: the branch under test is the sudo -u one.
  const owner = "bg-owner";
  fixtureUnit(unitDir, "crow-gateway.service",
    UNIT({ node, crowHome, workdir: join(base, "app") }).replace("User=alice", `User=${owner}`));
  const priv = fakePrivileged(base);

  const r = run([], {
    CROW_SYSTEMD_UNIT_DIR: unitDir,
    PATH: `${priv.dir}:${process.env.PATH}`,
  });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);

  const log = readFileSync(priv.log, "utf8");
  const lines = guardCommands(log, guard);
  assert.ok(lines.length >= 3, `expected the dir, the copy and the replace:\n${log}`);
  for (const line of lines) {
    assert.match(line, new RegExp(`^sudo -u ${owner} `), `every guard-dir command must run as its owner:\n${line}`);
  }
  assert.ok(lines.includes(`sudo -u ${owner} install -d -m 700 ${guard}`), `the dir must be made as the owner:\n${log}`);
  assert.ok(lines.some((l) => l.startsWith(`sudo -u ${owner} install -m 600 `)
    && l.includes(`${guard}/crow-boot-guard.mjs.tmp.`)), `the copy must be installed as the owner:\n${log}`);
  assert.ok(lines.some((l) => l.startsWith(`sudo -u ${owner} mv -f `)), `the replace must run as the owner:\n${log}`);
  // Never a bare `sudo install -m 600`: that is root writing the copy.
  assert.doesNotMatch(log, /^sudo install -m 600/m, `the copy may not be written by root:\n${log}`);

  const copy = join(guard, "crow-boot-guard.mjs");
  assert.ok(existsSync(copy), "the launcher copy must be installed");
  assert.equal(statSync(copy).mode & 0o777, 0o600);
  assert.equal(statSync(guard).mode & 0o777, 0o700);
});

test("as root without sudo the guard dir and the copy are made with -o <owner>", (t) => {
  // A minimal container has root and no sudo: the old branch ran `mkdir -m 700`
  // as root there, so the directory was root-owned and the service user could not
  // even traverse it (audit L1 review 3, 5b(b)).
  const base = scratch();
  const shims = fakeRootNoSudoShims(base);
  if (!shims) {
    t.skip("coreutils' install is not available");
    return;
  }
  const unitDir = join(base, "units");
  const node = fakeNode(join(base, "bin"), "24.21.0");
  const crowHome = join(base, "crow-home");
  const guard = join(crowHome, "boot-guard");
  fixtureUnit(unitDir, "crow-gateway.service", UNIT({ node, crowHome, workdir: join(base, "app") }));

  const r = run([], {
    CROW_SYSTEMD_UNIT_DIR: unitDir,
    PATH: `${shims.dir}:${process.env.PATH}`,
    // A path that does not exist: root with no sudo, so the `-o` fallback is taken.
    CROW_SUDO: join(base, "no-such-sudo"),
  });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);

  const lines = readFileSync(shims.log, "utf8").split("\n");
  assert.ok(lines.includes(`install -d -m 700 -o alice ${guard}`),
    `the guard dir must be made with -o so its owner owns it:\n${lines.join("\n")}`);
  assert.ok(lines.some((l) => l.startsWith("install -m 600 -o alice ") && l.includes(`${guard}/crow-boot-guard.mjs.tmp.`)),
    `the copy must be made with -o so its owner owns it:\n${lines.join("\n")}`);
  assert.doesNotMatch(lines.join("\n"), /^sudo /m, "there is no sudo here");
  // Root creates both as the owner and never changes the owner afterwards.
  assert.doesNotMatch(lines.join("\n"), /\bchown\b/, lines.join("\n"));

  const copy = join(guard, "crow-boot-guard.mjs");
  assert.ok(existsSync(copy), "the launcher copy must be installed");
  assert.equal(statSync(copy).mode & 0o777, 0o600);
  assert.equal(statSync(guard).mode & 0o777, 0o700);
});

test("a symlinked boot-guard directory is refused, never written through", () => {
  const base = scratch();
  const unitDir = join(base, "units");
  const node = fakeNode(join(base, "bin"), "24.21.0");
  const crowHome = join(base, "crow-home");
  mkdirSync(crowHome, { recursive: true });
  const elsewhere = join(base, "elsewhere");
  mkdirSync(elsewhere, { recursive: true });
  symlinkSync(elsewhere, join(crowHome, "boot-guard"));
  fixtureUnit(unitDir, "crow-gateway.service", UNIT({ node, crowHome, workdir: join(base, "app") }).replace("User=alice\n", ""));
  const priv = fakePrivileged(base);

  const r = run([], {
    CROW_SYSTEMD_UNIT_DIR: unitDir,
    PATH: `${priv.dir}:${process.env.PATH}`,
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /symlink/);
  assert.deepEqual(readdirSync(elsewhere), [], "nothing may be written through the link");
  assert.equal(existsSync(join(unitDir, "crow-gateway.service.d")), false, "no drop-in points at a copy that was not installed");
});

/* ------------------------------------------------------------ idempotency */

test("as root the launcher copy is installed as the unit's user", () => {
  // Root must not leave a root-owned file in a directory the service user can
  // rewrite (and the gateway refreshes this copy itself). The root branch is
  // walked with a shimmed `id` in "as root no chown runs …"; this pins the
  // source so neither branch can quietly come back.
  const source = readFileSync(SCRIPT, "utf8");
  assert.match(source, /"\$SUDO_BIN" -u "\$owner" install -d -m 700 "\$dir"/, "the guard dir must be made by the unit's user");
  assert.match(source, /"\$SUDO_BIN" -u "\$owner" install -m 600/, "the copy must run as the unit's user");
  assert.match(source, /"\$SUDO_BIN" -u "\$owner" mv -f/, "the replace must run as the unit's user");
  // `install -o` is the root-without-sudo fallback only.
  assert.match(source, /install -d -m 700 -o "\$owner" "\$dir"/, "a root without sudo must make the dir with -o");
  assert.match(source, /install -m 600 -o "\$owner"/);
  // No `run` anywhere in that branch: `run` prefixes sudo in system mode, which
  // is how a non-root run used to leave a root-owned 0700/0600 copy behind.
  assert.doesNotMatch(source, /run sudo -u/, "the owner branch must not go through run");
  assert.doesNotMatch(source, /run mkdir -m 700/, "no mkdir through run for the guard dir");
  assert.doesNotMatch(source, /\bchown\b/, "root must never chown inside the guard dir");
  assert.doesNotMatch(source, /run chmod 700 "\$dir"/, "no check-then-act chmod of the guard dir");
  // And never through a symlinked directory.
  assert.match(source, /if \[ -L "\$dir" \]; then/);
});

test("a drop-in that already matches is left alone and no daemon-reload happens", () => {
  const base = scratch();
  const unitDir = join(base, "units");
  const node = fakeNode(join(base, "bin"), "24.21.0");
  fixtureUnit(unitDir, "crow-gateway.service", UNIT({ node }));

  const first = run(["--dry-run"], { CROW_SYSTEMD_UNIT_DIR: unitDir });
  const dropin = printedDropin(first.stdout);
  // Plant it exactly as the installer would, then run again.
  mkdirSync(join(unitDir, "crow-gateway.service.d"), { recursive: true });
  writeFileSync(join(unitDir, "crow-gateway.service.d", "10-boot-guard.conf"), `${dropin}\n`);

  const second = run(["--dry-run"], { CROW_SYSTEMD_UNIT_DIR: unitDir });
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /unchanged: .*crow-gateway\.service\.d\/10-boot-guard\.conf/);
  assert.match(second.stdout, /nothing changed — no daemon-reload/);
  assert.equal(readFileSync(join(unitDir, "crow-gateway.service.d", "10-boot-guard.conf"), "utf8").trimEnd(), dropin);
});

test("no gateway units in the directory is a no-op, not an error", () => {
  const base = scratch();
  const unitDir = join(base, "units");
  mkdirSync(unitDir, { recursive: true });
  const r = run(["--dry-run"], { CROW_SYSTEMD_UNIT_DIR: unitDir });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /no crow-\*gateway\*\.service units/);
  assert.deepEqual(readdirSync(unitDir), []);
});

test("bash -n: the installer parses", () => {
  const r = spawnSync("bash", ["-n", SCRIPT], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

test("shellcheck passes when available (skips otherwise)", (t) => {
  const which = spawnSync("shellcheck", ["--version"], { stdio: "ignore" });
  if (which.error) return t.skip("shellcheck not installed");
  const r = spawnSync("shellcheck", [SCRIPT], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout);
});