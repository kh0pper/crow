/**
 * Crow takes Linkding's API token from Linkding itself (manifest `firstAdmin.setup.token`).
 *
 * Linkding has no environment variable for its API token, so the last "Finish setup" step of
 * this bundle used to be a human copying a hex string out of Settings → Integrations. The
 * bundle now ships `scripts/api-token.sh`, and the installer runs it after the first-admin
 * script with a FOURTH stdio entry: the token comes back on fd 3, one line, while stdout and
 * stderr stay the run's log. What these tests hold down:
 *
 *   1. a fresh install: exit 0, fd 3 is exactly "<40 hex>\n", and the key is in neither
 *      stdout nor stderr nor any argv a docker call was given (what a process list shows),
 *   2. re-runs reuse the key: the mint asks Linkding's own `get_or_create` for the account's
 *      "Crow" token, so the second run answers with the same one,
 *   3. docker missing / the container not running: exit 4, nothing on fd 3,
 *   4. a `crow-linkding` that belongs to ANOTHER install (compose's working_dir label is not
 *      this folder) is refused with exit 4 before anything runs inside it — and the check can
 *      only be skipped by a test that also names the container,
 *   5. the admin account is missing: exit 1, fd 3 empty,
 *   6. a mint that answers with nothing usable (no TOKEN= line, or one that is not 40 hex):
 *      exit 1, fd 3 empty,
 *   7. a token Linkding itself refuses: exit 5, and nothing is handed back,
 *   8. a Django warning printed above the answer is ignored, not taken for one,
 *   9. the static rules: bash, fail-fast, executable, fd 3 written exactly once and only
 *      after the proof, every external command with fd 3 closed, never `docker compose`,
 *  10. the manifest: the version bump (the installed copy refreshes only on a version
 *      change), the token's 40-hex pattern, the token step, and a clean contract check.
 *
 * No docker and no network here: a `docker` executable written into a temp dir sits first on
 * PATH, records every argv and the stdin it received, and replays canned answers. The script
 * only ever reaches a container through `docker exec`/`inspect`.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { validateManifest } from "../scripts/lib/bundle-contract.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = join(REPO, "bundles", "linkding");
const SCRIPT = join(BUNDLE, "scripts", "api-token.sh");

/** Linkding-shaped: exactly the 40 lowercase hex characters its ApiToken keys are. */
const KEY = "0123456789abcdef0123456789abcdef01234567";

const TMP = mkdtempSync(join(tmpdir(), "crow-linkding-token-"));
const BIN = join(TMP, "bin");
const NO_DOCKER = join(TMP, "no-docker");
/** By absolute path: the "no docker at all" case runs the script with an empty PATH. */
const BASH = existsSync("/bin/bash") ? "/bin/bash" : "bash";
mkdirSync(BIN, { recursive: true });
mkdirSync(NO_DOCKER, { recursive: true });

/**
 * The stand-in docker. Every call is recorded as `<dir>/call.<n>.argv` (the arguments joined
 * by spaces) plus `<dir>/call.<n>.stdin`, whether fd 3 was open in that child is recorded in
 * `<dir>/fd3-open`, and answers come from `FAKE_<KEY>_<i>` env vars — the i-th answer for that
 * KEY, falling back to the KEY's default.
 */
const FAKE_DOCKER = [
  "#!/usr/bin/env bash",
  "set -uo pipefail",
  'dir="$FAKE_DOCKER_DIR"',
  "n=0",
  'while [ -f "$dir/call.$n.argv" ]; do n=$((n + 1)); done',
  // The token pipe is Crow's fd 3: no docker call may inherit it. Recorded, never asserted
  // here — the test reads the file.
  'if [ -e /proc/self/fd/3 ]; then printf "%s\\n" FD3OPEN >> "$dir/fd3-open"; fi',
  'printf "%s" "$*" > "$dir/call.$n.argv"',
  'if [[ " $* " == *" -i "* ]]; then cat > "$dir/call.$n.stdin"; else : > "$dir/call.$n.stdin"; fi',
  "",
  'NEXT=""',
  "# next KEY DEFAULT: the i-th answer for KEY (FAKE_<KEY>_0, _1, ...), else DEFAULT.",
  "next() {",
  '  local key="$1" dflt="$2" cf="$dir/counter.$1" i=0',
  '  if [ -f "$cf" ]; then i=$(cat "$cf"); fi',
  '  printf "%s\\n" "$((i + 1))" > "$cf"',
  '  local var="FAKE_${key}_${i}"',
  '  if [ -n "${!var+x}" ]; then NEXT="${!var}"; else NEXT="$dflt"; fi',
  "}",
  "",
  'case "${1:-}" in',
  "  inspect)",
  '    case "$*" in',
  '      *".State.Running"*) next RUNNING true; printf "%s\\n" "$NEXT"; exit 0 ;;',
  // compose's own label: the folder the script runs in IS this install's, unless a test
  // names another one (FAKE_OWNER_0).
  '      *"com.docker.compose.project.working_dir"*) next OWNER "$(pwd -P)"; printf "%s\\n" "$NEXT"; exit 0 ;;',
  "    esac",
  '    printf "fake docker: unsupported inspect: %s\\n" "$*" >&2; exit 99 ;;',
  "  exec) ;;",
  '  *) printf "fake docker: unsupported: %s\\n" "$*" >&2; exit 99 ;;',
  "esac",
  "",
  'args="$*"',
  'case "$args" in',
  // The proof carries its own URL; the mint is Django's shell; anything else with the port
  // is the wait for the health endpoint.
  '  *"/api/bookmarks/"*) next PROOF 0; exit "$NEXT" ;;',
  `  *manage.py*) next MINT "TOKEN=${KEY}"; printf "%s\\n" "$NEXT"; exit 0 ;;`,
  '  *9090/health*) next UP 0; exit "$NEXT" ;;',
  '  *) printf "fake docker: no answer for: %s\\n" "$args" >&2; exit 98 ;;',
  "esac",
  "",
].join("\n");
writeFileSync(join(BIN, "docker"), FAKE_DOCKER, { mode: 0o755 });

after(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
});

/** One recorded call: the arguments it saw and whatever arrived on stdin. */
function readCalls(dir) {
  const out = [];
  for (let i = 0; existsSync(join(dir, `call.${i}.argv`)); i++) {
    out.push({
      argv: readFileSync(join(dir, `call.${i}.argv`), "utf8"),
      stdin: readFileSync(join(dir, `call.${i}.stdin`), "utf8"),
    });
  }
  return out;
}

/**
 * Run the token script the way Crow does: cwd is the installed bundle dir, stdin is
 * nothing, and fd 3 is a pipe Crow reads separately.
 */
function run({ env = {}, withDocker = true } = {}) {
  const callsDir = mkdtempSync(join(TMP, "calls-"));
  // cwd is the installed bundle dir (the folder compose's label is compared with).
  const cwd = mkdtempSync(join(TMP, "cwd-"));
  const res = spawnSync(BASH, [SCRIPT], {
    encoding: "utf8",
    timeout: 120_000,
    cwd,
    stdio: ["ignore", "pipe", "pipe", "pipe"],
    env: {
      PATH: withDocker ? `${BIN}:/usr/bin:/bin` : NO_DOCKER,
      HOME: TMP,
      CROW_FA_CONTAINER: "crow-linkding",
      CROW_FA_SKIP_OWNER_CHECK: "1",
      FAKE_DOCKER_DIR: callsDir,
      ...env,
    },
  });
  const token = typeof res.output?.[3] === "string" ? res.output[3] : "";
  return {
    status: res.status,
    stdout: res.stdout || "",
    stderr: res.stderr || "",
    token,
    calls: readCalls(callsDir),
    fd3Open: existsSync(join(callsDir, "fd3-open")),
    cwd,
  };
}

const argvText = (r) => r.calls.map((c) => c.argv).join("\n");
const ran = (r, needle) => r.calls.some((c) => c.argv.includes(needle));

/** The whole point: the key is in nobody's argument list and in no log line. */
function assertKeyStayedOutOfSight(r) {
  assert.equal(argvText(r).includes(KEY), false, "no docker argument may carry the key");
  assert.equal(String(r.stdout).includes(KEY), false, "the script must not print the key");
  assert.equal(String(r.stderr).includes(KEY), false, "the script must not print the key");
}

// ── 1. a fresh install ─────────────────────────────────────────────────────────────

test("linkding: the admin's token comes back on fd 3, exactly once and only there", () => {
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.token, `${KEY}\n`, "fd 3 holds the key and one newline, nothing else");
  assertKeyStayedOutOfSight(r);
  assert.match(r.stdout, /Crow read Linkding's API token for admin\./);

  // The container is checked before anything runs inside it, and Linkding's own tooling
  // mints the token.
  assert.equal(r.calls[0].argv.startsWith("inspect"), true, "the container is checked first");
  assert.equal(r.calls[0].argv.includes("crow-linkding"), true, "and the app's own container is the one named");

  const mint = r.calls.find((c) => c.argv.includes("manage.py"));
  assert.ok(mint, "the token is minted (or read back) through Linkding's own Django shell");
  assert.equal(mint.stdin, "admin\n", "the username arrives on stdin, never in the code");
  assert.match(mint.argv, /bookmarks\.models import ApiToken/);
  assert.match(mint.argv, /get_or_create\(user=user, name="Crow"\)/, "one token per account, reused on a second run");

  // The proof: the header goes in on stdin, so the key is on a pipe and not in an argument.
  const proof = r.calls.find((c) => c.argv.includes("/api/bookmarks/"));
  assert.ok(proof, "the key is proved against the app's own API before it is handed back");
  assert.equal(proof.stdin, `Authorization: Token ${KEY}\n`);
  assert.equal(proof.argv.includes("-H @-"), true, "curl reads the header from stdin");
});

test("linkding: the key never reaches a docker command line (what a process list shows)", () => {
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  for (const call of r.calls) assert.equal(call.argv.includes(KEY), false, call.argv.slice(0, 80));
});

test("linkding: a second run answers with the same token (get_or_create, not create)", () => {
  // The stand-in replays the model's own rule: the same account keeps the same key.
  const first = run();
  const second = run({ env: { FAKE_MINT_0: `WARNING: something\nTOKEN=${KEY}` } });
  assert.equal(first.token, `${KEY}\n`);
  assert.equal(second.token, `${KEY}\n`, "re-running never changes what the extension is set to use");
  const mint = second.calls.find((c) => c.argv.includes("manage.py"));
  assert.equal(mint.argv.includes("get_or_create"), true);
});

// ── 2. not running, or no docker at all ────────────────────────────────────────────

test("linkding: a container that is not running, or no docker at all, is exit 4", () => {
  const stopped = run({ env: { FAKE_RUNNING_0: "false" } });
  assert.equal(stopped.status, 4, stopped.stderr);
  assert.match(stopped.stderr, /Linkding is not running; nothing was changed\./);
  assert.equal(stopped.token, "", "fd 3 is empty");
  assert.equal(stopped.calls.length, 1, "only the state check ran");

  const noDocker = run({ withDocker: false });
  assert.equal(noDocker.status, 4, noDocker.stderr);
  assert.match(noDocker.stderr, /docker is not available here/);
  assert.equal(noDocker.token, "");
  assert.equal(noDocker.calls.length, 0);
});

// ── 3. whose container is it? ──────────────────────────────────────────────────────

test("linkding: another install's crow-linkding is refused before anything runs inside it", () => {
  const r = run({ env: { CROW_FA_SKIP_OWNER_CHECK: "", FAKE_OWNER_0: "/srv/another-crow/bundles/linkding" } });
  assert.equal(r.status, 4, r.stderr);
  assert.match(r.stderr, /^The running Linkding container does not belong to this install; nothing was changed\.$/m);
  assert.equal(r.token, "", "fd 3 is empty");
  assert.equal(r.calls.length, 2, "the state and the label were read, and nothing else");
  assert.equal(ran(r, "manage.py"), false, "the container was never entered");
});

test("linkding: the label check passes when the container really is this install's", () => {
  const r = run({ env: { CROW_FA_SKIP_OWNER_CHECK: "" } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.token, `${KEY}\n`);
  const label = r.calls.find((c) => c.argv.includes("com.docker.compose.project.working_dir"));
  assert.ok(label, "the working_dir label is what the ownership is read from");
  assert.equal(label.argv.startsWith("inspect -f"), true);
});

test("linkding: the owner check can only be skipped by a run that also names the container", () => {
  const r = run({ env: { CROW_FA_CONTAINER: "", FAKE_OWNER_0: "/srv/another-crow/bundles/linkding" } });
  assert.equal(r.status, 4, r.stderr);
  assert.match(r.stderr, /does not belong to this install/);
  assert.equal(r.token, "");
});

// ── 4. no usable answer ───────────────────────────────────────────────────────────

test("linkding: no account of that name is exit 1, and fd 3 stays empty", () => {
  const r = run({ env: { FAKE_MINT_0: "NOUSER" } });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /^Linkding has no account named admin; nothing was changed\.$/m);
  assert.equal(r.token, "");
  assert.equal(ran(r, "/api/bookmarks/"), false, "nothing to prove");
});

test("linkding: a mint that answers with nothing usable is exit 1, never a half-read key", () => {
  const answers = [
    "",
    "Traceback (most recent call last):\n  File \"<string>\", line 1\nbookmarks.models.ApiToken.DoesNotExist",
    "TOKEN=not-a-token",
    `TOKEN=${KEY}0`, // 41 hex
    `TOKEN=${KEY.toUpperCase()}`, // linkding's keys are lowercase hex
  ];
  for (const answer of answers) {
    const r = run({ env: { FAKE_MINT_0: answer } });
    assert.equal(r.status, 1, `${JSON.stringify(answer)}: ${r.stderr}`);
    assert.match(r.stderr, /did not report an API token for admin; nothing was changed\./);
    assert.equal(r.token, "", `${JSON.stringify(answer)}: fd 3 must stay empty`);
    assert.equal(ran(r, "/api/bookmarks/"), false, "an unusable answer is never proved");
  }
});

test("linkding: a token the app refuses is exit 5, and nothing is handed back", () => {
  const r = run({ env: { FAKE_PROOF_0: "22" } });
  assert.equal(r.status, 5, r.stderr);
  assert.match(r.stderr, /^Linkding did not accept the token Crow read; nothing was saved\.$/m);
  assert.equal(r.token, "", "an unproved token is never written to fd 3");
  assert.equal(ran(r, "manage.py"), true, "the token really was read before it was refused");
});

test("linkding: a Django warning printed before TOKEN= is ignored, not taken for the token", () => {
  const r = run({
    env: {
      FAKE_MINT_0: [
        "WARNING: There are no migrations to apply.",
        "System check identified some issues:",
        `TOKEN=${KEY}`,
      ].join("\n"),
    },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.token, `${KEY}\n`, "exactly the TOKEN= line, nothing above it");
  assertKeyStayedOutOfSight(r);
});

// ── 5. the static rules the protocol rests on ──────────────────────────────────────

const codeLines = (text) => text.split("\n").filter((line) => !/^\s*#/.test(line) && line.trim() !== "");

test("linkding: the script is bash, fail-fast and executable", () => {
  const script = readFileSync(SCRIPT, "utf8");
  assert.match(script, /^#!\/usr\/bin\/env bash/);
  assert.match(script, /set -euo pipefail/);
  assert.notEqual(statSync(SCRIPT).mode & 0o111, 0, "a script declared as one is executable");
  const syntax = spawnSync(BASH, ["-n", SCRIPT], { encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
});

test("linkding: fd 3 is written exactly once, after the proof, and never read", () => {
  const script = codeLines(readFileSync(SCRIPT, "utf8")).join("\n");
  assert.equal(script.match(/>&3/g)?.length, 1, "one write to fd 3 and no other");
  const write = script.indexOf(">&3");
  const proof = script.indexOf("did not accept the token Crow read");
  assert.ok(proof > 0 && write > proof, "the key is proved before it is handed back");
  assert.equal(script.includes("<&3"), false, "nothing is ever read from fd 3");
});

test("linkding: every external command runs with fd 3 closed, so no child can hold the pipe", () => {
  const script = readFileSync(SCRIPT, "utf8");
  const external = /(\bdocker\b|\bsed\b|\btail\b|\bseq\b|\bsleep\b|\bcurl\b)/;
  const offenders = codeLines(script).filter((line) => external.test(line) && !/command -v docker/.test(line) && !line.includes("3>&-"));
  assert.deepEqual(offenders.map((l) => l.trim()), [], "every such line closes fd 3");
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.calls.length > 0, "the stand-in docker really ran");
  assert.equal(r.fd3Open, false, "no docker call — and so no child — ever saw fd 3 open");
});

test("linkding: the script never runs `docker compose` and never echoes the key", () => {
  const code = codeLines(readFileSync(SCRIPT, "utf8")).join("\n");
  assert.equal(/docker\s+compose/.test(code), false, "no compose file in the folder is read at all");
  assert.equal(/\becho\b/.test(code), false, "echo is a way to leak by accident");
});

// ── 6. the declaration that puts the script to work ────────────────────────────────

const manifestOf = () => JSON.parse(readFileSync(join(BUNDLE, "manifest.json"), "utf8"));

test("linkding: the manifest declares the token step, and the version that refreshes installs", () => {
  const manifest = manifestOf();
  assert.equal(manifest.version, "1.0.4", "the installed copy refreshes only on a version change");
  const token = manifest.firstAdmin.setup.token;
  assert.deepEqual(
    { script: token.script, env: token.env, timeout_s: token.timeout_s },
    { script: "scripts/api-token.sh", env: "LINKDING_API_TOKEN", timeout_s: 120 },
    "the script, the env var the minted token belongs in, and enough time for a slow start",
  );
  assert.equal(existsSync(join(BUNDLE, token.script)), true, "the script really ships");
  // The admin step it rides on is untouched.
  assert.deepEqual(
    { script: manifest.firstAdmin.setup.script, timeout_s: manifest.firstAdmin.setup.timeout_s, user: manifest.firstAdmin.user, secretEnv: manifest.firstAdmin.secretEnv },
    { script: "scripts/first-admin.sh", timeout_s: 180, user: "admin", secretEnv: "LINKDING_ADMIN_PASSWORD" },
  );
});

test("linkding: LINKDING_API_TOKEN carries the app's own grammar (40 lowercase hex)", () => {
  const manifest = manifestOf();
  const spec = (manifest.env_vars || []).find((v) => v.name === "LINKDING_API_TOKEN");
  assert.ok(spec, "the env var the token goes in is declared");
  assert.equal(spec.secret, true, "it is a secret");
  assert.equal(spec.pattern, "^[0-9a-f]{40}$", "the pattern Crow's token reader enforces");
  assert.equal(new RegExp(spec.pattern).test(KEY), true, "a Linkding token matches it");
  assert.equal(new RegExp(spec.pattern).test(KEY.toUpperCase()), false, "anything else does not");
});

test("linkding: the manifest still passes the bundle contract, token step included", () => {
  const { errors } = validateManifest(manifestOf(), BUNDLE, { bundleExists: () => true });
  assert.deepEqual((errors || []).filter((e) => e.startsWith("firstAdmin")), [], "firstAdmin errors");
});