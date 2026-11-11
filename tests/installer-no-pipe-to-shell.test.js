/**
 * Installer: no download is piped into a shell (security audit K7 / N4-2).
 *
 * The installer used to wire Node.js, Docker and Tailscale up by piping a
 * vendor script off the network into a root shell (`curl … | sudo sh`,
 * `curl … | sudo -E bash -`, and a `curl … | sh` in the Dockerfile). Each of
 * those hands the decision "what runs as root on this machine" to whatever the
 * server answers with. They are now apt repositories wired from a signing key
 * whose PRIMARY fingerprint is compared against a constant first.
 *
 * Nothing here touches the network, /etc or root: the static half reads the
 * three files, and the behavioural half runs the installer's helpers with a
 * curl shim that serves a local fixture, a sudo shim that runs its argument, an
 * apt shim that only logs, and every keyring/sources path pointed into a
 * scratch directory. The signing keys are throwaway rsa2048 keys generated in
 * this test's own GNUPGHOME; the gpg-dependent tests skip when gpg is absent.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const INSTALLER = join(ROOT, "scripts", "crow-install.sh");
const SETUP = join(ROOT, "scripts", "setup.js");
const DOCKERFILE = join(ROOT, "Dockerfile");
const src = () => readFileSync(INSTALLER, "utf-8");

/** A pipeline into a shell: `… | sh`, `… | bash`, `… | sudo sh`,
 *  `… | sudo -E bash -`. Comment lines are handled by the caller. */
const PIPE_TO_SHELL = /\|\s*(?:sudo\s+(?:-E\s+)?)?(?:ba)?sh\b|<\(\s*(?:curl|wget)\b|\b(?:ba)?sh\s+-c\s+"?\$\(\s*(?:curl|wget)\b/;

/** Lines that are not a comment (first non-space character is '#'). */
const codeLines = (text) => text.split("\n").filter((line) => !/^\s*#/.test(line));

/** Write an executable shim called `name` into `dir` (the installer suite's own
 *  helper, duplicated here so this file exports nothing from it). */
function shim(dir, name, body) {
  writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return join(dir, name);
}

/** Source the installer's helper layer (CROW_INSTALL_SOURCE_ONLY=1) and run a
 *  snippet against it. detached:true → no controlling terminal → the headless
 *  prompt path. The rail mirrors tests/crow-install-script.test.js: a snippet
 *  that can reach a vendor-repository step may only run with every seam set, so
 *  a mistake in this file can never write under the real /etc, read the real
 *  os-release, or reach the network. */
function runWithHelpers(snippet, env = {}) {
  if (/install_docker_repo|install_nodesource_repo|install_tailscale_repo|fetch_verified_key/.test(snippet)) {
    for (const key of ["CROW_CURL", "CROW_SUDO", "CROW_APT", "CROW_GPG", "VENDOR_KEY_DIR", "USR_KEYRING_DIR",
      "APT_SOURCES_DIR", "CROW_OS_RELEASE", "CROW_TEST_DOCKER_KEY_FPR", "CROW_TEST_NODESOURCE_KEY_FPR", "CROW_TEST_TAILSCALE_KEY_FPR"]) {
      if (!env[key]) throw new Error(`${key} is required to run the vendor repository steps in a test`);
    }
  }
  return spawnSync("bash", ["-c", `set -euo pipefail; CROW_INSTALL_SOURCE_ONLY=1 source "${INSTALLER}"; ${snippet}`], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    env: { ...process.env, ...env },
    encoding: "utf-8",
  });
}

const logLines = (path) => (existsSync(path) ? readFileSync(path, "utf-8").split("\n").filter(Boolean) : []);

// ─── static: nothing pipes a download into a shell ────────────────────────────

test("K7/N4-2: no line of the installer, setup.js or the Dockerfile pipes a download into a shell", () => {
  for (const [name, file] of [["scripts/crow-install.sh", INSTALLER], ["scripts/setup.js", SETUP], ["Dockerfile", DOCKERFILE]]) {
    const offenders = codeLines(readFileSync(file, "utf-8"))
      .filter((line) => PIPE_TO_SHELL.test(line));
    assert.deepEqual(offenders, [], `${name} must not pipe anything into sh/bash:\n${offenders.join("\n")}`);
  }
});

test("K7/N4-2: the installer's own documented `curl … | bash` usage stays in its header comment", () => {
  // The rule is about what the INSTALLER runs, not about how the operator is
  // told to run the installer itself.
  const header = src().slice(0, src().indexOf("set -euo pipefail"));
  assert.match(header, /crow-install\.sh \| bash/, "the documented one-liner is still there");
});

test("K7/N4-2: the vendor install scripts are gone from the installer", () => {
  const s = src();
  assert.doesNotMatch(s, /get\.docker\.com/, "the Docker convenience script is gone");
  assert.doesNotMatch(s, /deb\.nodesource\.com\/setup_/, "NodeSource's setup script is gone");
  assert.doesNotMatch(s, /tailscale\.com\/install\.sh/, "Tailscale's install script is gone");
  // …and the three repository steps take their place, above the source-only
  // seam so the suite can drive them.
  const seam = s.indexOf("CROW_INSTALL_SOURCE_ONLY");
  for (const fn of ["fetch_verified_key() {", "install_docker_repo() {", "install_nodesource_repo() {", "install_tailscale_repo() {"]) {
    const at = s.indexOf(fn);
    assert.ok(at > -1 && at < seam, `${fn} must be defined above the seam`);
  }
});

test("K7/N4-2: the Dockerfile gets uv from a pinned image instead of a downloaded installer", () => {
  const df = readFileSync(DOCKERFILE, "utf-8");
  const copies = codeLines(df).filter((line) => line.includes("ghcr.io/astral-sh/uv"));
  assert.equal(copies.length, 1, "exactly one uv COPY line");
  const m = /^COPY --from=ghcr\.io\/astral-sh\/uv:(\d+\.\d+\.\d+)@sha256:([0-9a-f]{64}) \/uv \/uvx \/bin\/$/.exec(copies[0].trim());
  assert.ok(m, `the uv COPY must pin an exact x.y.z version AND a @sha256 digest: ${copies[0]}`);
  assert.doesNotMatch(df, /astral\.sh\/uv\/install\.sh/, "the uv installer script is not downloaded");
  assert.doesNotMatch(df, /ENV PATH="\/root\/\.local\/bin/, "the uv-installer PATH line is gone");
  // curl stays installed for the rest of the tooling, and the comment above the
  // apt layer no longer claims it is there for the uv installer.
  assert.match(df, /--no-install-recommends \\\n\s+[^\n]*\bcurl\b/, "curl stays in the apt layer");
  assert.doesNotMatch(df, /curl for uv installer/);
  // Still root, deliberately: the documented usage execs `cat /root/.crow/setup-token`
  // and bind-mounts ./data, so a non-root USER is a follow-up.
  assert.doesNotMatch(df, /^USER\s/m, "the image still runs as root (a non-root USER is a follow-up)");
  assert.match(df, /non-root USER/, "the follow-up is stated in a comment");
});

test("K7/N4-2: every *_FPR constant in the installer is 40 uppercase hex, and the three are pinned", () => {
  const s = src();
  const defs = new Map();
  for (const line of s.split("\n")) {
    const m = /^([A-Z][A-Z0-9_]*_FPR)=(.*)$/.exec(line);
    if (m && !defs.has(m[1])) defs.set(m[1], m[2].replace(/^"|"$/g, ""));
  }
  const defaultValue = (raw) => raw;
  for (const [name, raw] of defs) {
    assert.ok(/^[0-9A-F]{40}$/.test(raw),
      `${name} must be a plain assignment of exactly 40 uppercase hex (no env default): ${raw}`);
  }
  assert.equal(defaultValue(defs.get("DOCKER_KEY_FPR")), "9DC858229FC7DD38854AE2D88D81803C0EBFCD88");
  assert.equal(defaultValue(defs.get("NODESOURCE_KEY_FPR")), "6F71F525282841EEDAF851B42F59B5F99B1BE0B4");
  assert.equal(defaultValue(defs.get("TAILSCALE_KEY_FPR")), "2596A99EAAB33821893C0A79458CA832957F5868");
});

/** The text of one function definition (`name() {` … the closing `}` line). */
function fnBody(name) {
  const s = src();
  const start = s.indexOf(`\n${name}() {`);
  assert.ok(start > -1, `${name}() must be defined`);
  const end = s.indexOf("\n}\n", start);
  assert.ok(end > start, `${name}() must have a closing brace line`);
  return s.slice(start, end);
}

test("K7/N4-2: each repository step verifies its key against ITS OWN fingerprint constant", () => {
  const docker = fnBody("install_docker_repo");
  const node = fnBody("install_nodesource_repo");
  const tailscale = fnBody("install_tailscale_repo");
  assert.equal((docker.match(/fetch_verified_key/g) || []).length, 1);
  assert.match(docker, /fetch_verified_key[^\n]*"\$DOCKER_KEY_FPR"/);
  assert.match(docker, /"\$DOCKER_KEY_URL_BASE\/\$repo_path\/gpg"/);
  assert.equal((node.match(/fetch_verified_key/g) || []).length, 1);
  assert.match(node, /fetch_verified_key[^\n]*"\$NODESOURCE_KEY_FPR"/);
  assert.match(node, /"\$NODESOURCE_KEY_URL"/);
  assert.equal((tailscale.match(/fetch_verified_key/g) || []).length, 1);
  assert.match(tailscale, /fetch_verified_key[^\n]*"\$TAILSCALE_KEY_FPR"/);
  assert.match(tailscale, /"\$TAILSCALE_REPO_BASE\/\$flavor\/\$codename\.noarmor\.gpg"/);
  // Every privileged action goes through the script's own sudo seam, and the
  // downloads run as the invoking user.
  for (const body of [docker, node, tailscale]) {
    assert.doesNotMatch(body, /(^|\s)sudo\s/, "no raw sudo in these steps");
    assert.doesNotMatch(body, /^\s*(curl|gpg|install)\s/m, "no bare curl/gpg/install");
  }
});

// ─── scratch machinery: real gpg, shimmed curl/sudo/apt, scratch dirs ─────────

const hasGpg = () => !spawnSync("gpg", ["--version"], { stdio: "ignore" }).error;

let keysCache;
/** Two throwaway rsa2048 keys in one private GNUPGHOME, plus the armor of each
 *  and of both together (two primary keys in one file). Generated once. */
function throwawayKeys() {
  if (keysCache !== undefined) return keysCache;
  const home = mkdtempSync(join(tmpdir(), "crow-gpg-"));
  chmodSync(home, 0o700);
  const gpg = (args) => {
    const r = spawnSync("gpg", ["--homedir", home, "--batch", "--pinentry-mode", "loopback", ...args],
      { encoding: "utf-8" });
    assert.equal(r.status, 0, `gpg ${args.join(" ")} failed: ${r.stderr}`);
    return r.stdout;
  };
  const make = (uid) => {
    gpg(["--passphrase", "", "--quick-generate-key", uid, "rsa2048", "default", "never"]);
    const cols = gpg(["--with-colons", "--list-keys", uid]);
    const fpr = cols.split("\n").find((line) => line.startsWith("fpr:"));
    assert.ok(fpr, `no fpr line for ${uid}`);
    return { uid, fpr: fpr.split(":")[9], armor: gpg(["--armor", "--export", uid]), secretArmor: gpg(["--armor", "--export-secret-keys", uid]) };
  };
  const one = make("crow test one <t1@example.invalid>");
  const two = make("crow test two <t2@example.invalid>");
  assert.match(one.fpr, /^[0-9A-F]{40}$/);
  assert.notEqual(one.fpr, two.fpr);
  assert.ok(one.armor.includes("BEGIN PGP PUBLIC KEY BLOCK"));
  keysCache = { home, ...one, otherFpr: two.fpr, multiArmor: one.armor + two.armor,
    // the vendor key with an attacker's SECRET-key block appended
    secretTailArmor: one.armor + two.secretArmor };
  return keysCache;
}

// The throwaway keys live in a private GNUPGHOME whose gpg-agent must not outlive the suite.
after(() => {
  if (keysCache === undefined) return;
  spawnSync("gpgconf", ["--homedir", keysCache.home, "--kill", "all"], { stdio: "ignore" });
  rmSync(keysCache.home, { recursive: true, force: true });
});

const UBUNTU_NOBLE = [
  'PRETTY_NAME="Ubuntu 24.04 LTS"',
  "ID=ubuntu",
  'ID_LIKE="debian"',
  "VERSION_CODENAME=noble",
  "UBUNTU_CODENAME=noble",
  "",
].join("\n");

const RASPBIAN_BOOKWORM = [
  'PRETTY_NAME="Raspbian GNU/Linux 12 (bookworm)"',
  "ID=raspbian",
  'ID_LIKE="debian"',
  "VERSION_CODENAME=bookworm",
  "",
].join("\n");

/** A scratch root: os-release fixture, keyring/sources dirs, a private TMPDIR, a
 *  curl shim that serves `served` to its -o target, a sudo shim that runs its
 *  argument, and an apt shim that only logs. `fpr` is the fingerprint this run
 *  treats as expected (the throwaway key's, unless a test overrides one). */
function vendorScratch({ osRelease = UBUNTU_NOBLE, served = "", fpr, downloadOk = true, arch = "amd64" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "crow-vendors-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const tmpDir = join(dir, "tmp");
  mkdirSync(tmpDir);
  const vendorKeyDir = join(dir, "keyrings");
  mkdirSync(vendorKeyDir);
  const usrKeyringDir = join(dir, "usr-keyrings");
  mkdirSync(usrKeyringDir);
  const sourcesDir = join(dir, "sources.list.d");
  mkdirSync(sourcesDir);
  const osReleasePath = join(dir, "os-release");
  writeFileSync(osReleasePath, osRelease);

  const servedPath = join(dir, "served");
  writeFileSync(servedPath, served);
  const curlLog = join(dir, "curl.log");
  const curl = shim(bin, "curl", [
    `printf '%s\\n' "$*" >> ${JSON.stringify(curlLog)}`,
    ...(downloadOk ? [] : ["exit 22"]),
    'out=""',
    'while [ "$#" -gt 0 ]; do',
    '  case "$1" in',
    '    -o) out="$2"; shift 2 ;;',
    "    *) shift ;;",
    "  esac",
    "done",
    '[ -n "$out" ] || exit 2',
    `cp ${JSON.stringify(servedPath)} "$out"`,
  ].join("\n"));

  const sudoLog = join(dir, "sudo.log");
  const sudo = shim(bin, "sudo", [
    `printf '%s\\n' "$*" >> ${JSON.stringify(sudoLog)}`,
    'exec "$@"',
  ].join("\n"));

  const aptLog = join(dir, "apt.log");
  const apt = shim(bin, "apt", [
    `printf '%s\\n' "$*" >> ${JSON.stringify(aptLog)}`,
    "exit 0",
  ].join("\n"));

  // Stands in for `dpkg --print-architecture`.
  const archCmd = shim(bin, "print-architecture", `printf '%s\\n' ${JSON.stringify(arch)}`);

  return {
    dir, tmpDir, vendorKeyDir, usrKeyringDir, sourcesDir, osReleasePath, servedPath, curlLog, sudoLog, aptLog,
    env: {
      CROW_CURL: curl,
      CROW_SUDO: sudo,
      CROW_APT: apt,
      CROW_GPG: "gpg",
      VENDOR_KEY_DIR: vendorKeyDir,
      USR_KEYRING_DIR: usrKeyringDir,
      APT_SOURCES_DIR: sourcesDir,
      CROW_OS_RELEASE: osReleasePath,
      CROW_DPKG_ARCH_CMD: archCmd,
      CROW_TEST_DOCKER_KEY_FPR: fpr,
      CROW_TEST_NODESOURCE_KEY_FPR: fpr,
      CROW_TEST_TAILSCALE_KEY_FPR: fpr,
      TMPDIR: tmpDir,
    },
  };
}

const runVendor = (s, snippet, env = {}) => runWithHelpers(snippet, { ...s.env, ...env });

/** Run one step and report OK/FAIL instead of letting `set -e` swallow it. */
const outcome = (call) => `if ${call}; then echo STEP_OK; else echo STEP_FAIL; fi`;

const read = (path) => readFileSync(path, "utf-8");

test("ops: the container smoke script parses and is executable", () => {
  const ops = join(ROOT, "scripts", "ops", "test-vendor-repos-in-containers.sh");
  const r = spawnSync("bash", ["-n", ops], { encoding: "utf-8" });
  assert.equal(r.status, 0, r.stderr);
  assert.notEqual(statSync(ops).mode & 0o111, 0, "the ops script must be executable");
  // It may only touch containers: the repo mounted read-only, no privileged
  // container, no daemon start, and never `tailscale up`.
  const s = readFileSync(ops, "utf-8");
  assert.match(s, /docker run --rm -v "\$REPO:\/crow:ro"/);
  const code = codeLines(s);
  assert.deepEqual(code.filter((line) => line.includes("--privileged")), [], "no privileged container");
  assert.deepEqual(code.filter((line) => line.includes("tailscale up")), [], "never `tailscale up`");
  assert.match(s, /exit 101/, "policy-rc.d keeps every service from starting");
});

// ─── behaviour: a key that matches is installed, then the source file ─────────

test("K7/N4-2: Docker — a matching key writes the deb822 source and installs the exact packages", (t) => {
  if (!hasGpg()) return t.skip("gpg is not installed");
  const keys = throwawayKeys();
  const s = vendorScratch({ served: keys.armor, fpr: keys.fpr });
  const r = runVendor(s, outcome("install_docker_repo"));
  assert.match(r.stdout, /STEP_OK/, r.stdout + r.stderr);

  const keyPath = join(s.vendorKeyDir, "docker.asc");
  assert.equal(read(keyPath), keys.armor, "the verified key is installed as-is");
  assert.equal(read(join(s.sourcesDir, "docker.sources")), [
    "Types: deb",
    "URIs: https://download.docker.com/linux/ubuntu",
    "Suites: noble",
    "Components: stable",
    "Architectures: amd64",
    `Signed-By: ${keyPath}`,
    "",
  ].join("\n"));
  // The download was the Docker key for the ubuntu path, into a temp file.
  const curlCalls = logLines(s.curlLog);
  assert.equal(curlCalls.length, 1);
  assert.match(curlCalls[0], /-fsSL --proto '?=https'? --tlsv1\.2/);
  assert.match(curlCalls[0], /https:\/\/download\.docker\.com\/linux\/ubuntu\/gpg$/);
  assert.ok(curlCalls[0].includes(s.tmpDir), "downloaded into a temp file, never into the keyring");
  // apt: the prerequisites, then update, then exactly Docker's packages.
  assert.deepEqual(logLines(s.aptLog), [
    "install -y ca-certificates curl gnupg",
    "update",
    "install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin",
  ]);
  assert.deepEqual(readdirSync(s.tmpDir), [], "no temp file is left behind");
});

test("K7/N4-2: NodeSource — a matching key writes nodistro sources and installs nodejs", (t) => {
  if (!hasGpg()) return t.skip("gpg is not installed");
  const keys = throwawayKeys();
  const s = vendorScratch({ served: keys.armor, fpr: keys.fpr });
  const r = runVendor(s, outcome("install_nodesource_repo 24"));
  assert.match(r.stdout, /STEP_OK/, r.stdout + r.stderr);

  const keyPath = join(s.vendorKeyDir, "nodesource.asc");
  assert.equal(read(keyPath), keys.armor);
  assert.equal(read(join(s.sourcesDir, "nodesource.sources")), [
    "Types: deb",
    "URIs: https://deb.nodesource.com/node_24.x",
    "Suites: nodistro",
    "Components: main",
    `Signed-By: ${keyPath}`,
    "",
  ].join("\n"));
  assert.deepEqual(logLines(s.aptLog), ["install -y ca-certificates curl gnupg", "update", "install -y nodejs"]);
  assert.match(logLines(s.curlLog)[0], /https:\/\/deb\.nodesource\.com\/gpgkey\/nodesource-repo\.gpg\.key$/);
  assert.deepEqual(readdirSync(s.tmpDir), []);
});

test("K7/N4-2: Tailscale — a matching key writes the one-line source and installs tailscale", (t) => {
  if (!hasGpg()) return t.skip("gpg is not installed");
  const keys = throwawayKeys();
  const s = vendorScratch({ served: keys.armor, fpr: keys.fpr });
  const r = runVendor(s, outcome("install_tailscale_repo"));
  assert.match(r.stdout, /STEP_OK/, r.stdout + r.stderr);

  const keyPath = join(s.usrKeyringDir, "tailscale-archive-keyring.gpg");
  // A .gpg destination gets the BINARY export of the verified key, not the armored download.
  const shown = spawnSync("gpg", ["--batch", "--show-keys", "--with-colons", keyPath],
    { encoding: "utf-8", env: { ...process.env, GNUPGHOME: mkdtempSync(join(tmpdir(), "crow-gpgshow-")) } });
  assert.equal(shown.stdout.split("\n").filter((l) => l.startsWith("pub:")).length, 1);
  assert.ok(shown.stdout.includes(`fpr:::::::::${keys.fpr}:`), "the installed binary key is the verified one");
  assert.ok(!read(keyPath).includes("BEGIN PGP"), "binary, not armored");
  assert.equal(read(join(s.sourcesDir, "tailscale.list")),
    `deb [signed-by=${keyPath}] https://pkgs.tailscale.com/stable/ubuntu noble main\n`);
  assert.deepEqual(logLines(s.aptLog),
    ["install -y ca-certificates curl gnupg", "update", "install -y tailscale tailscale-archive-keyring"]);
  assert.match(logLines(s.curlLog)[0], /https:\/\/pkgs\.tailscale\.com\/stable\/ubuntu\/noble\.noarmor\.gpg$/);
  assert.deepEqual(readdirSync(s.tmpDir), []);
});

// ─── behaviour: anything else is refused, with nothing written ────────────────

test("K7/N4-2: a key with the wrong fingerprint is refused — no source file, no key, no install", (t) => {
  if (!hasGpg()) return t.skip("gpg is not installed");
  const keys = throwawayKeys();
  const s = vendorScratch({ served: keys.armor, fpr: keys.fpr });
  const r = runVendor(s, outcome("install_docker_repo"), { CROW_TEST_DOCKER_KEY_FPR: keys.otherFpr });
  assert.match(r.stdout, /STEP_FAIL/, "a fingerprint mismatch must fail the step");

  assert.equal(existsSync(join(s.sourcesDir, "docker.sources")), false, "no sources file is written");
  assert.equal(existsSync(join(s.vendorKeyDir, "docker.asc")), false, "no key is installed");
  // The error names the URL and both fingerprints.
  assert.match(r.stdout, /https:\/\/download\.docker\.com\/linux\/ubuntu\/gpg/);
  assert.match(r.stdout, new RegExp(`expected fingerprint ${keys.otherFpr}`));
  assert.match(r.stdout, new RegExp(`got ${keys.fpr}`));
  // apt never got as far as installing Docker's packages.
  assert.equal(logLines(s.aptLog).filter((line) => line.includes("docker-ce")).length, 0);
  assert.deepEqual(logLines(s.sudoLog).filter((line) => line.includes("docker.sources")), [],
    "no source file was installed");
  assert.deepEqual(readdirSync(s.tmpDir), [], "the temp file is removed");
});

test("K7/N4-2: two primary keys in one download are refused", (t) => {
  if (!hasGpg()) return t.skip("gpg is not installed");
  const keys = throwawayKeys();
  const s = vendorScratch({ served: keys.multiArmor, fpr: keys.fpr });
  const r = runVendor(s, outcome("install_nodesource_repo 24"));
  assert.match(r.stdout, /STEP_FAIL/, r.stdout + r.stderr);
  assert.match(r.stdout, /2 primary key\(s\)/, "the refusal reports how many primary keys it found");
  assert.equal(existsSync(join(s.sourcesDir, "nodesource.sources")), false);
  assert.equal(existsSync(join(s.vendorKeyDir, "nodesource.asc")), false);
  assert.equal(logLines(s.aptLog).filter((line) => line.includes("nodejs")).length, 0);
  assert.deepEqual(readdirSync(s.tmpDir), []);
});

test("K7/N4-2: a failed download is refused — nothing written, nothing installed", (t) => {
  if (!hasGpg()) return t.skip("gpg is not installed");
  const keys = throwawayKeys();
  const s = vendorScratch({ served: keys.armor, fpr: keys.fpr, downloadOk: false });
  const r = runVendor(s, outcome("install_tailscale_repo"));
  assert.match(r.stdout, /STEP_FAIL/, r.stdout + r.stderr);
  assert.match(r.stdout, /Could not download the signing key https:\/\/pkgs\.tailscale\.com\/stable\/ubuntu\/noble\.noarmor\.gpg/);
  assert.equal(existsSync(join(s.sourcesDir, "tailscale.list")), false);
  assert.equal(existsSync(join(s.usrKeyringDir, "tailscale-archive-keyring.gpg")), false);
  assert.equal(logLines(s.aptLog).filter((line) => line.includes("tailscale")).length, 0);
  assert.deepEqual(readdirSync(s.tmpDir), []);
});

// ─── behaviour: which repository does which distribution get ─────────────────

test("K7/N4-2: vendor_repo_target maps the supported distributions and refuses the rest", () => {
  const dir = mkdtempSync(join(tmpdir(), "crow-vendortarget-"));
  const fixtures = [
    // [name, os-release body, expected "flavor codename" or null for refused]
    ["Ubuntu 24.04", 'ID=ubuntu\nID_LIKE="debian"\nVERSION_CODENAME=noble\nUBUNTU_CODENAME=noble\n', "ubuntu noble"],
    ["Debian 13", 'ID=debian\nVERSION_CODENAME=trixie\n', "debian trixie"],
    ["Raspberry Pi OS 12", 'ID=raspbian\nID_LIKE="debian"\nVERSION_CODENAME=bookworm\n', "raspbian bookworm"],
    // Mint: the codename that goes with the ubuntu repositories is UBUNTU_CODENAME,
    // not its own VERSION_CODENAME (xia).
    ["Mint", 'ID=linuxmint\nID_LIKE="ubuntu debian"\nUBUNTU_CODENAME=noble\nVERSION_CODENAME=xia\n', "ubuntu noble"],
    ["LMDE", 'ID=linuxmint\nID_LIKE="debian"\nDEBIAN_CODENAME=bookworm\nVERSION_CODENAME=faye\n', "debian bookworm"],
    // Kali has no vendor repository: its codename is rolling.
    ["Kali", 'ID=kali\nID_LIKE="debian"\nVERSION_CODENAME=kali-rolling\n', null],
    ["empty codename", "ID=debian\n", null],
    ["odd codename", 'ID=ubuntu\nVERSION_CODENAME=noble/../x\n', null],
    ["missing file", null, null],
  ];
  fixtures.forEach(([name, body, want], i) => {
    const file = join(dir, `os-release-${i}`);
    if (body !== null) writeFileSync(file, body);
    const r = runWithHelpers(
      `if target="$(vendor_repo_target ${JSON.stringify(file)})"; then printf 'TARGET=%s\\n' "$target"; else echo REFUSED; fi`);
    assert.equal(r.status, 0, r.stderr);
    if (want === null) {
      assert.match(r.stdout, /REFUSED/, `${name} must be refused, got: ${r.stdout}`);
      assert.doesNotMatch(r.stdout, /TARGET=/, `${name} must print no target`);
    } else {
      assert.match(r.stdout, new RegExp(`TARGET=${want}`), `${name}: ${r.stdout}`);
    }
  });
});

test("K7/N4-2: Raspberry Pi OS bookworm takes Docker's raspbian repo and Tailscale's raspbian one; trixie falls back to Docker's debian one", (t) => {
  if (!hasGpg()) return t.skip("gpg is not installed");
  const keys = throwawayKeys();
  const s = vendorScratch({ osRelease: RASPBIAN_BOOKWORM, served: keys.armor, fpr: keys.fpr });
  const r = runVendor(s, `${outcome("install_docker_repo")}; ${outcome("install_tailscale_repo")}`);
  assert.doesNotMatch(r.stdout, /STEP_FAIL/, r.stdout + r.stderr);

  assert.match(read(join(s.sourcesDir, "docker.sources")),
    /^URIs: https:\/\/download\.docker\.com\/linux\/raspbian$/m, "Docker's raspbian repository serves Raspberry Pi OS bookworm");
  assert.equal(read(join(s.sourcesDir, "tailscale.list")),
    `deb [signed-by=${join(s.usrKeyringDir, "tailscale-archive-keyring.gpg")}] https://pkgs.tailscale.com/stable/raspbian bookworm main\n`);
  const curlCalls = logLines(s.curlLog);
  assert.match(curlCalls.map((c) => c).join("\n"), /download\.docker\.com\/linux\/raspbian\/gpg/);
  assert.match(curlCalls.map((c) => c).join("\n"), /pkgs\.tailscale\.com\/stable\/raspbian\/bookworm\.noarmor\.gpg/);
});

test("K7/N4-2: Raspberry Pi OS trixie has no Docker raspbian repo, so it takes the debian one", (t) => {
  if (!hasGpg()) return t.skip("gpg is not installed");
  const keys = throwawayKeys();
  const s = vendorScratch({ osRelease: RASPBIAN_BOOKWORM.replaceAll("bookworm", "trixie"), served: keys.armor, fpr: keys.fpr });
  const r = runVendor(s, outcome("install_docker_repo"));
  assert.doesNotMatch(r.stdout, /STEP_FAIL/, r.stdout + r.stderr);
  assert.match(read(join(s.sourcesDir, "docker.sources")), /^URIs: https:\/\/download\.docker\.com\/linux\/debian$/m);
  assert.match(read(join(s.sourcesDir, "docker.sources")), /^Suites: trixie$/m);
});

test("K7/N4-2: a secret-key block appended to the vendor key never reaches apt's keyring", (t) => {
  if (!hasGpg()) return t.skip("gpg is not installed");
  const keys = throwawayKeys();
  const s = vendorScratch({ served: keys.secretTailArmor, fpr: keys.fpr });
  const r = runVendor(s, outcome("install_nodesource_repo 24"));
  const keyPath = join(s.vendorKeyDir, "nodesource.asc");
  if (existsSync(keyPath)) {
    // If it was accepted at all, only the verified public key may have been installed.
    const g = spawnSync("gpg", ["--batch", "--show-keys", "--with-colons", keyPath],
      { encoding: "utf-8", env: { ...process.env, GNUPGHOME: mkdtempSync(join(tmpdir(), "crow-gpgshow-")) } });
    const recs = g.stdout.split("\n").map((l) => l.split(":")[0]);
    assert.equal(recs.filter((k) => k === "pub").length, 1);
    assert.equal(recs.filter((k) => k === "sec" || k === "ssb").length, 0, "no secret packets in the installed key");
  } else {
    assert.match(r.stdout, /STEP_FAIL/, r.stdout + r.stderr);
  }
  assert.deepEqual(readdirSync(s.tmpDir), []);
});

test("K7/N4-2: an unsupported distribution refuses both steps and names them", (t) => {
  if (!hasGpg()) return t.skip("gpg is not installed");
  const keys = throwawayKeys();
  const kali = 'ID=kali\nID_LIKE="debian"\nVERSION_CODENAME=kali-rolling\n';
  const s = vendorScratch({ osRelease: kali, served: keys.armor, fpr: keys.fpr });
  const r = runVendor(s, `${outcome("install_docker_repo")}; ${outcome("install_tailscale_repo")}`);
  assert.doesNotMatch(r.stdout, /STEP_OK/, "neither step may report success");
  assert.match(r.stdout, /Docker has no apt repository for this distribution/);
  assert.match(r.stdout, /https:\/\/docs\.docker\.com\/engine\/install\//);
  assert.match(r.stdout, /Tailscale has no apt repository for this distribution/);
  assert.match(r.stdout, /https:\/\/tailscale\.com\/download/);
  assert.deepEqual(readdirSync(s.sourcesDir), [], "no apt source is written");
  assert.deepEqual(logLines(s.curlLog), [], "and nothing is downloaded");
});

// ─── behaviour: the old NodeSource setup files are cleaned up ────────────────

test("K7/N4-2: legacy nodesource.list and nodesource.gpg are removed before the new source is written", (t) => {
  if (!hasGpg()) return t.skip("gpg is not installed");
  const keys = throwawayKeys();
  const s = vendorScratch({ served: keys.armor, fpr: keys.fpr });
  const legacyList = join(s.sourcesDir, "nodesource.list");
  const legacyKey = join(s.vendorKeyDir, "nodesource.gpg");
  const legacyUsrKey = join(s.usrKeyringDir, "nodesource.gpg");
  for (const p of [legacyList, legacyKey, legacyUsrKey]) writeFileSync(p, "legacy\n");

  const r = runVendor(s, outcome("install_nodesource_repo 24"));
  assert.match(r.stdout, /STEP_OK/, r.stdout + r.stderr);

  for (const p of [legacyList, legacyKey, legacyUsrKey]) {
    assert.equal(existsSync(p), false, `${p} must be removed`);
  }
  assert.equal(existsSync(join(s.sourcesDir, "nodesource.sources")), true);
  assert.equal(existsSync(join(s.vendorKeyDir, "nodesource.asc")), true);

  // Order matters: a stale nodesource.list next to the new deb822 file would
  // make apt read two sources for the same packages.
  const calls = logLines(s.sudoLog);
  const firstRm = calls.findIndex((line) => line.startsWith("rm -f "));
  const sourceWrite = calls.findIndex((line) => line.includes("nodesource.sources"));
  assert.ok(firstRm > -1, `the legacy files are removed through the sudo seam: ${JSON.stringify(calls)}`);
  assert.ok(sourceWrite > firstRm, "the removals come before the new source file is installed");
  assert.deepEqual(readdirSync(s.tmpDir), []);
});