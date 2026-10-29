/**
 * scripts/satellite-install.sh and scripts/crow-satellite (SAT-4, spec §4.1, §4.3, §6.4, §11).
 *
 * Nothing here touches the real box: every case runs the installer with --dry-run in a fake HOME,
 * with fake /etc/os-release and /proc/meminfo files, and with every command that could change the
 * system (sudo, systemctl, tailscale, ufw, apt-get, curl, git, npm, loginctl, ...) replaced by a
 * stub on PATH that only logs its argv. The dry-run must never call a mutating stub.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SCRIPT = join(ROOT, "scripts", "satellite-install.sh");
const CLI = join(ROOT, "scripts", "crow-satellite");
const SHA = "0123456789abcdef0123456789abcdef01234567";
const src = () => readFileSync(SCRIPT, "utf8");

const OS_OK = 'ID=ubuntu\nVERSION_ID="24.04"\nPRETTY_NAME="Ubuntu 24.04 LTS"\n';
const mem = (memMiB, swapMiB) => `MemTotal:       ${memMiB * 1024} kB\nMemFree:  1000 kB\nSwapTotal:      ${swapMiB * 1024} kB\n`;

// Commands the dry-run must never run: each stub logs its argv and fails loudly.
const MUTATING = ["sudo", "apt-get", "apt", "curl", "git", "npm", "loginctl", "usermod", "systemd-run", "journalctl", "fallocate", "mkswap", "swapon", "docker", "ufw", "node"];

const REAL_TOOLS = ["realpath", "awk", "grep", "find", "cat"];

/**
 * A fake box. opts: os, meminfo, arch, diskKb, tsState ("Running" | "Stopped" | null = not
 * installed), gatewayProc (pgrep finds one), gatewayUnit (systemctl says active), uid.
 */
function fakeBox(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sat-install-"));
  const home = join(dir, "home", "alex");
  const bin = join(dir, "bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(bin);
  const log = join(dir, "calls.log");
  writeFileSync(log, "");
  writeFileSync(join(dir, "os-release"), opts.os ?? OS_OK);
  writeFileSync(join(dir, "meminfo"), opts.meminfo ?? mem(956, 2048));
  const stub = (name, body) => {
    const p = join(bin, name);
    writeFileSync(p, `#!/bin/bash\necho "${name} $*" >> "${log}"\n${body}\n`);
    chmodSync(p, 0o755);
  };
  // PATH is this dir only: real read-only tools are linked in, so nothing else on the host
  // (a real tailscale, systemctl, ufw) can ever be reached.
  for (const n of REAL_TOOLS) {
    const real = execFileSync("bash", ["-c", `command -v ${n}`], { encoding: "utf8" }).trim();
    symlinkSync(real, join(bin, n));
  }
  for (const n of MUTATING) stub(n, `echo "stub ${n} must not run in --dry-run" >&2; exit 99`);
  stub("uname", `echo "${opts.arch ?? "x86_64"}"`);
  stub("id", `if [ "$1" = "-u" ]; then echo "${opts.uid ?? 1000}"; elif [ "$1" = "-un" ]; then echo alex; else /usr/bin/id "$@"; fi`);
  stub("df", `echo "Filesystem 1024-blocks Used Available Capacity Mounted"; echo "/dev/sda1 50000000 1000 ${opts.diskKb ?? 30000000} 1% /"`);
  stub("pgrep", opts.gatewayProc ? `echo "4242 node /opt/crow/servers/gateway/index.js"; exit 0` : "exit 1");
  stub("systemctl", opts.gatewayUnit ? `[ "$1" = "is-active" ] && [[ "$*" == *crow-gateway* ]] && exit 0; exit 3` : "exit 3");
  if (opts.tsState !== null) {
    stub("tailscale", `if [ "$1" = "status" ]; then echo '{"BackendState": "${opts.tsState ?? "Running"}", "Self": {}}'; exit 0; fi; echo "stub tailscale $1 must not run" >&2; exit 99`);
  }
  return { dir, home, bin, log };
}

function dryRun(box, { args = ["--dry-run", "--sha", SHA], env = {} } = {}) {
  const r = spawnSync("/bin/bash", [SCRIPT, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    detached: true, // no controlling tty: every prompt takes its headless path
    env: {
      PATH: box.bin,
      HOME: box.home,
      USER: "alex",
      LANG: "C",
      SAT_OS_RELEASE: join(box.dir, "os-release"),
      SAT_MEMINFO: join(box.dir, "meminfo"),
      ...env,
    },
  });
  const calls = readFileSync(box.log, "utf8");
  return { ...r, out: r.stdout + r.stderr, calls };
}

/** No stub outside the read-only probes ran. */
function assertNoMutation(r) {
  const ran = r.calls.split("\n").filter(Boolean).map((l) => l.split(" ")[0]);
  for (const c of ran) assert.ok(!MUTATING.includes(c), `dry-run ran ${c}: ${r.calls}`);
  assert.ok(!/tailscale (serve|funnel|up)/.test(r.calls), r.calls);
}

test("bash -n: the installer and the CLI wrapper parse", () => {
  execFileSync("bash", ["-n", SCRIPT]);
  execFileSync("bash", ["-n", CLI]);
});

test("shellcheck passes when installed (skips otherwise)", (t) => {
  if (spawnSync("shellcheck", ["--version"], { stdio: "ignore" }).error) return t.skip("shellcheck not installed");
  const r = spawnSync("shellcheck", [SCRIPT, CLI], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout);
});

test("the installer's repo constant is the gateway's SATELLITE_REPO", async () => {
  const { SATELLITE_REPO, INSTALL_SCRIPT_PATH } = await import("../servers/gateway/satellites/install-command.js");
  const m = /^SATELLITE_REPO="([^"]+)"$/m.exec(src());
  assert.ok(m, "SATELLITE_REPO=\"...\" line in the installer");
  assert.equal(m[1], SATELLITE_REPO);
  assert.equal(INSTALL_SCRIPT_PATH, "scripts/satellite-install.sh");
  // Exactly one place names the repo: every github URL is built from the constant.
  const literal = src().split("\n").filter((l) => l.includes(SATELLITE_REPO) && !/^SATELLITE_REPO=/.test(l));
  assert.deepEqual(literal, []);
});

test("--sha is required and must be a full 40-hex sha", () => {
  const box = fakeBox();
  assert.equal(dryRun(box, { args: ["--dry-run"] }).status, 2);
  assert.equal(dryRun(box, { args: ["--dry-run", "--sha", "abc123"] }).status, 2);
  assert.equal(dryRun(box, { args: ["--dry-run", "--sha", SHA, "--bogus"] }).status, 2);
});

test("clean box: dry-run passes preflight, prints the plan, changes nothing", () => {
  const box = fakeBox();
  const r = dryRun(box);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /preflight passed/);
  assert.match(r.out, /plan: .*git clone https:\/\/github\.com\/kh0pper\/crow\.git/);
  assert.match(r.out, new RegExp(`plan: .*checkout .*${SHA}`));
  assert.match(r.out, /plan: .*systemd-run --user --scope -p MemoryMax=600M nice .*npm ci --omit=dev/);
  assert.match(r.out, /plan: .*loginctl enable-linger alex/);
  assert.match(r.out, /plan: .*tailscale serve --bg --https=443 http:\/\/127\.0\.0\.1:3014/);
  assert.match(r.out, /journal/i, "says the pairing code is visible in the journal");
  assertNoMutation(r);
});

test("SAT_HOME (~/.crow-satellite) itself is allowed, so a re-run works", () => {
  const box = fakeBox();
  mkdirSync(join(box.home, ".crow-satellite", "app"), { recursive: true });
  writeFileSync(join(box.home, ".crow-satellite", "installed.json"), "{}");
  const r = dryRun(box);
  assert.equal(r.status, 0, r.out);
  assertNoMutation(r);
});

for (const stray of [".crow", ".crow-x", ".crow.bak", ".crow-mpa"]) {
  test(`a stray ~/${stray} is refused and named`, () => {
    const box = fakeBox();
    mkdirSync(join(box.home, stray));
    const r = dryRun(box);
    assert.equal(r.status, 78, r.out);
    assert.match(r.out, new RegExp(stray.replace(".", "\\.")));
    assert.match(r.out, /step 0/i);
    assertNoMutation(r);
  });
}

test("a stray ~/.crow-x FILE (not only a directory) is refused too", () => {
  const box = fakeBox();
  writeFileSync(join(box.home, ".crow-x"), "x");
  assert.equal(dryRun(box).status, 78);
});

test("a seed-bearing identity.json.bak anywhere under $HOME is refused", () => {
  const box = fakeBox();
  mkdirSync(join(box.home, "old", "data"), { recursive: true });
  const p = join(box.home, "old", "data", "identity.json.bak");
  writeFileSync(p, JSON.stringify({ crow_id: "crow:x", seed: "00ff" }));
  const r = dryRun(box);
  assert.equal(r.status, 78, r.out);
  assert.ok(r.out.includes(p), r.out);
  assertNoMutation(r);
});

test("a seed-bearing identity.json inside SAT_HOME is refused", () => {
  const box = fakeBox();
  mkdirSync(join(box.home, ".crow-satellite"), { recursive: true });
  writeFileSync(join(box.home, ".crow-satellite", "identity.json"), '{ "seed" : "ab" }');
  assert.equal(dryRun(box).status, 78);
});

test("an identity.json with no seed field is fine", () => {
  const box = fakeBox();
  writeFileSync(join(box.home, "identity.json"), JSON.stringify({ crow_id: "crow:x", pub: "ab" }));
  assert.equal(dryRun(box).status, 0);
});

test("a seed under $CROW_DATA_DIR (outside HOME) is refused", () => {
  const box = fakeBox();
  const data = join(box.dir, "srv-data");
  mkdirSync(data);
  writeFileSync(join(data, "identity.json"), '{"seed":"aa"}');
  const r = dryRun(box, { env: { CROW_DATA_DIR: data } });
  assert.equal(r.status, 78, r.out);
  assert.ok(r.out.includes(join(data, "identity.json")));
});

test("SAT_HOME outside $HOME is refused (the compose guard treats /var and /opt as sensitive)", () => {
  const box = fakeBox();
  const r = dryRun(box, { env: { SAT_HOME: "/opt/crow-satellite" } });
  assert.equal(r.status, 78, r.out);
  assert.match(r.out, /SAT_HOME/);
});

test("a custom SAT_HOME under $HOME makes ~/.crow-satellite a stray", () => {
  const box = fakeBox();
  mkdirSync(join(box.home, ".crow-satellite"));
  const r = dryRun(box, { env: { SAT_HOME: join(box.home, ".crow-sat2") } });
  assert.equal(r.status, 78, r.out);
  assert.match(r.out, /\.crow-satellite/);
});

const refusals = [
  ["old Ubuntu", { os: 'ID=ubuntu\nVERSION_ID="20.04"\n' }, /Ubuntu 22\.04|Debian 12/],
  ["old Debian", { os: 'ID=debian\nVERSION_ID="11"\n' }, /Debian 12/],
  ["another distro", { os: 'ID=fedora\nVERSION_ID="40"\n' }, /Ubuntu 22\.04/],
  ["32-bit arm", { arch: "armv7l" }, /x86_64 or arm64/],
  ["RAM under 900 MiB", { meminfo: mem(800, 2048) }, /900 MiB/],
  ["swap under 1 GiB", { meminfo: mem(956, 512) }, /1 GiB/],
  ["disk under 5 GB", { diskKb: 4000000 }, /5 GB/],
  ["Tailscale not up", { tsState: "Stopped" }, /Tailscale/],
  ["a full gateway process", { gatewayProc: true }, /full Crow gateway/],
  ["a crow-gateway unit active", { gatewayUnit: true }, /full Crow gateway/],
  ["run as root", { uid: 0 }, /root/],
];
for (const [name, opts, re] of refusals) {
  test(`preflight refuses: ${name}`, () => {
    const r = dryRun(fakeBox(opts));
    assert.equal(r.status, 78, r.out);
    assert.match(r.out, re);
    assertNoMutation(r);
  });
}

test("Debian 12 on arm64 passes", () => {
  const r = dryRun(fakeBox({ os: 'ID=debian\nVERSION_ID="12"\n', arch: "aarch64" }));
  assert.equal(r.status, 0, r.out);
});

test("no swap at all: the dry-run plans the 2 GiB swap offer instead of refusing", () => {
  const r = dryRun(fakeBox({ meminfo: mem(956, 0) }));
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /plan: .*2 GiB swap/);
  assertNoMutation(r);
});

test("Tailscale missing: the dry-run plans its install and the owner's login", () => {
  const r = dryRun(fakeBox({ tsState: null }));
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /plan: .*install Tailscale/);
  assertNoMutation(r);
});

test("--repair with nothing installed is refused; with an install it keeps state", () => {
  const box = fakeBox();
  const r = dryRun(box, { args: ["--dry-run", "--repair", "--sha", SHA] });
  assert.equal(r.status, 78, r.out);
  assert.match(r.out, /nothing to repair/);
  const sat = join(box.home, ".crow-satellite");
  mkdirSync(join(sat, "app"), { recursive: true });
  for (const d of ["vault", "secrets", "bundles"]) mkdirSync(join(sat, d));
  writeFileSync(join(sat, "installed.json"), "{}");
  const r2 = dryRun(box, { args: ["--dry-run", "--repair", "--sha", SHA] });
  assert.equal(r2.status, 0, r2.out);
  assert.match(r2.out, /keeps vault\/, installed\.json, bundle data and secrets\//);
  for (const p of ["vault", "secrets", "bundles", "installed.json"]) assert.ok(existsSync(join(sat, p)));
  assertNoMutation(r2);
});

function unitFrom(out) {
  const m = /--- crow-satellite\.service ---\n([\s\S]*?)\n--- end ---/.exec(out);
  assert.ok(m, `unit block in: ${out}`);
  return m[1];
}

test("the unit file carries the §6.4 budget, the exit-code policy and the satellite env", () => {
  const box = fakeBox();
  const r = dryRun(box);
  assert.equal(r.status, 0, r.out);
  const unit = unitFrom(r.out);
  const lines = unit.split("\n");
  const has = (l) => assert.ok(lines.includes(l), `missing "${l}" in:\n${unit}`);
  const sat = join(box.home, ".crow-satellite");
  has("[Service]");
  has("Type=simple");
  has("User=alex");
  has("MemoryHigh=150M");
  has("MemoryMax=192M");
  has("OOMScoreAdjust=-300");
  has("Nice=5");
  has("Restart=on-failure");
  has("RestartPreventExitStatus=78");
  has(`Environment=CROW_PROFILE=satellite CROW_HOME=${sat}`);
  has(`WorkingDirectory=${sat}/app`);
  has(`ExecStart=/usr/bin/node ${sat}/app/servers/satellite/index.js`);
  has("Environment=XDG_RUNTIME_DIR=/run/user/1000");
  has("WantedBy=multi-user.target");
  assert.ok(!/CROW_TRUSTED_PROXIES|CROW_DASHBOARD_PUBLIC|CROW_SATELLITE_HOST/.test(unit), "no env the agent refuses");
  // 75 (update restart) must restart: it is neither in RestartPreventExitStatus nor SuccessExitStatus.
  assert.ok(!/SuccessExitStatus=.*75|RestartPreventExitStatus=.*75/.test(unit));
});

test("static: never Funnel, never a path-prefixed Serve mapping, never rewrites ufw rules", () => {
  const code = src().split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  assert.doesNotMatch(code, /tailscale funnel (?!status)/);
  assert.doesNotMatch(code, /--set-path/);
  assert.doesNotMatch(code, /ufw (--force )?(delete|reset|disable|enable|default|insert|route)/);
  assert.match(code, /ufw allow in on tailscale0/);
  assert.match(code, /tailscale serve --bg --https=443 http:\/\/127\.0\.0\.1:3014/);
  // --repair never deletes kept state.
  assert.doesNotMatch(code, /rm -rf?[^\n]*(vault|secrets|installed\.json|bundles|cert\.json|pinned\.json)/);
});

test("crow-satellite wrapper: only status and pair-code, CROW_HOME defaults to ~/.crow-satellite", () => {
  const box = fakeBox();
  const env = { PATH: process.env.PATH, HOME: box.home };
  const bad = spawnSync("bash", [CLI, "self-check"], { encoding: "utf8", env });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /usage: crow-satellite status \| pair-code/);
  const none = spawnSync("bash", [CLI], { encoding: "utf8", env });
  assert.equal(none.status, 2);
  // Real cli.js against the fake HOME: no key there yet.
  const st = spawnSync("bash", [CLI, "status"], { encoding: "utf8", env });
  assert.equal(st.status, 1, st.stdout + st.stderr);
  assert.ok(st.stderr.includes(join(box.home, ".crow-satellite")), st.stderr);
});
