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
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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
    ["sudo", `#!/bin/sh\nprintf 'sudo %s\\n' "$*" >> ${JSON.stringify(log)}\nexec "$@"\n`],
    ["systemctl", `#!/bin/sh\nprintf 'systemctl %s\\n' "$*" >> ${JSON.stringify(log)}\nexit 0\n`],
  ]) {
    writeFileSync(join(dir, name), body);
    chmodSync(join(dir, name), 0o755);
  }
  return { dir, log };
}

/**
 * A fake `systemctl show` that merges a fixture unit with its drop-ins (later
 * wins) and prints the four properties `--value` style, one per line. It refuses
 * any other argument list, which pins the command the installer is required to
 * use.
 */
function fakeSystemctlMerging(base, unitDir) {
  const dir = join(base, "fake-systemctl-bin");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "fake-systemctl");
  writeFileSync(path, `#!/bin/sh
case "$*" in
  *"-p Environment -p WorkingDirectory -p User -p ExecStart --value"*) ;;
  *) echo "unexpected arguments: $*" >&2; exit 2 ;;
esac
for a in "$@"; do unit="$a"; done
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
printf '%s\\n' "$(val Environment)"
printf '%s\\n' "$(val WorkingDirectory)"
printf '%s\\n' "$(val User)"
printf '%s\\n' "$(val ExecStart)"
`);
  chmodSync(path, 0o755);
  return path;
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

  const r = run(["--dry-run"], {
    CROW_SYSTEMD_UNIT_DIR: unitDir, CROW_SYSTEMCTL: fakeSystemctlMerging(base, unitDir),
  });
  assert.equal(r.status, 0, r.stderr);
  const dropin = printedDropin(r.stdout);
  assert.ok(dropin.includes(`"${mergedHome}/boot-guard/crow-boot-guard.mjs"`), `drop-in CROW_HOME ignored:\n${dropin}`);
  // WorkingDirectory=-/path: the optional-exec '-' is not part of the path, and
  // the path is quoted with % doubled.
  assert.ok(dropin.includes(`--app-root "${appRoot.replace("%", "%%")}"`), dropin);
  assert.match(r.stdout, /would install: .*merged-home\/boot-guard\/crow-boot-guard\.mjs/);
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
  fixtureUnit(unitDir, "crow-gateway.service",
    UNIT({ node, crowHome, workdir: appRoot }).replace("User=alice\n", ""));
  const priv = fakePrivileged(base);

  const r = run([], {
    CROW_SYSTEMD_UNIT_DIR: unitDir,
    PATH: `${priv.dir}:${process.env.PATH}`,
  });
  assert.equal(r.status, 0, r.stderr);

  const dropinPath = join(unitDir, "crow-gateway.service.d", "10-boot-guard.conf");
  assert.ok(existsSync(dropinPath), `the drop-in must be written:\n${r.stdout}\n${r.stderr}`);
  const log = readFileSync(priv.log, "utf8");
  assert.match(log, /sudo install -m 644 \S+ \S*10-boot-guard\.conf/,
    `the drop-in must be installed, not redirected into the unit dir:\n${log}`);
  assert.doesNotMatch(log, /sudo cp /, "the old redirect + cp path must be gone");
  // Nothing but the drop-in is left in the drop-in directory (no temp files).
  assert.deepEqual(readdirSync(join(unitDir, "crow-gateway.service.d")), ["10-boot-guard.conf"]);
  // And the launcher copy landed in the unit's own CROW_HOME, mode 0600.
  const copy = join(crowHome, "boot-guard", "crow-boot-guard.mjs");
  assert.ok(existsSync(copy), "the launcher copy must be installed");
  assert.equal(readFileSync(copy, "utf8"), readFileSync(join(import.meta.dirname, "..", "scripts", "boot-guard", "crow-boot-guard.mjs"), "utf8"));
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
  // rewrite (and the gateway refreshes this copy itself). Root behaviour cannot
  // be exercised from an unprivileged test run, so the source is pinned.
  const source = readFileSync(SCRIPT, "utf8");
  assert.match(source, /sudo -u "\$owner" install -m 600/, "the copy must run as the unit's user");
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