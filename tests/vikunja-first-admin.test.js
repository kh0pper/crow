/**
 * N3-4 — Vikunja: Crow registers the owner's account, then closes registration.
 *
 * The finding: a fresh Vikunja answers on 127.0.0.1:3456 with its own registration page
 * open, so anything else on the machine can claim the server before the operator's first
 * visit. `bundles/vikunja/scripts/first-admin.sh` registers the account `admin` with the
 * password Crow generated (one line on stdin, never an argument), and the manifest's
 * `firstAdmin.setup.after` step then writes `VIKUNJA_ENABLE_REGISTRATION=false` into the
 * bundle's .env and recreates the container once, so the page stops accepting accounts.
 *
 * What this file holds down:
 *   1. a fresh install registers ONCE and proves the login, with the password on stdin only
 *      (never in an argument and never printed), and the register body carries the account,
 *      the .invalid address and the generated password,
 *   2. an install that already has accounts is left alone (exit 3) — nothing is registered
 *      and the password never even reaches the app,
 *   3. registration closed with no account is exit 4 and says how to reopen it,
 *   4. not running / no docker / no curl is exit 4 with nothing changed,
 *   5. a password the protocol refuses (empty, short) or a username that is not a plain
 *      account name is exit 1 with zero calls,
 *   6. a registration Vikunja confirmed but a login it never accepts is exit 5, so the
 *      password is kept instead of thrown away,
 *   7. an answer that does not say what happened is settled by Vikunja's OWN account list:
 *      accounts that appeared are proved with a real login (0), a login Crow's password does
 *      not open is not Crow's (3), and an app with no account at all changed nothing (1),
 *   8. the declaration: the manifest passes the bundle contract, carries the after-step and
 *      the env var it writes, the compose interpolates it, the docs and the skill say who
 *      creates the login, and every wait/request bound fits the manifest's timeout.
 *
 * No docker and no network: a `docker` stand-in and a `curl` stand-in written into a temp dir
 * sit first on PATH and replay canned answers. Vikunja's image is distroless (no shell, no
 * curl inside), so the script uses HOST curl with its config on stdin — that is exactly what
 * the curl stand-in reads.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { validateManifest } from "../scripts/lib/bundle-contract.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const B = (id = "vikunja") => join(REPO, "bundles", id);
const SCRIPT = join(B(), "scripts", "first-admin.sh");
const BASH = existsSync("/bin/bash") ? "/bin/bash" : "bash";

/** A generated-password-shaped value: URL- and shell-safe, 22 characters. */
const PASSWORD = "gen-Secret_ABC123xy-z45";

const TMP = mkdtempSync(join(tmpdir(), "crow-vikunja-fa-"));
const BIN = join(TMP, "bin");
const BIN_NO_CURL = join(TMP, "bin-no-curl");
const BIN_NO_DOCKER = join(TMP, "bin-no-docker");
const CORE = join(TMP, "core");
for (const d of [BIN, BIN_NO_CURL, BIN_NO_DOCKER, CORE]) mkdirSync(d, { recursive: true });
// The coreutils the script needs, by absolute path, so a PATH without curl still has `grep`.
for (const name of ["bash", "grep", "sed", "head", "tr", "sleep", "timeout", "cat", "env", "wc"]) {
  const from = [`/bin/${name}`, `/usr/bin/${name}`].find((p) => existsSync(p));
  if (from) symlinkSync(from, join(CORE, name));
}

after(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
});

// ── the canned answers ──────────────────────────────────────────────────────────────

/** A curl stand-in answer: the status on the first line, the body after it. */
const reply = (code, body = "") => `${code}\n${body}`;

/**
 * Vikunja 2.8.0's real `user list` output (from a live run on the pinned image): its own log
 * lines on stdout, then a table drawn with box-drawing characters; one row per account.
 */
const USERS_TABLE = (rows = []) => [
  'time=2026-11-10T09:00:00Z level=INFO msg="Running migrations…"',
  'time=2026-11-10T09:00:00Z level=WARN msg="No config file found, using default or env settings."',
  "┌────┬──────────┬───────────────────────────┬───────────────────────────┬───────────────────────────┐",
  "│ ID │ USERNAME │ EMAIL                     │ CREATED                   │ UPDATED                   │",
  "├────┼──────────┼───────────────────────────┼───────────────────────────┼───────────────────────────┤",
  ...rows.map(([id, user, mail]) => `│ ${String(id).padStart(2)} │ ${user.padEnd(8)} │ ${mail.padEnd(25)} │ 2026-11-10 09:00:00 +0000 │ 2026-11-10 09:00:00 +0000 │`),
  "└────┴──────────┴───────────────────────────┴───────────────────────────┴───────────────────────────┘",
].join("\n");

const INFO_OPEN = reply(200, '{"version":"2.8.0","frontend_url":"http://127.0.0.1:3456/","registration_enabled":true}');
const INFO_CLOSED = reply(200, '{"version":"2.8.0","frontend_url":"http://127.0.0.1:3456/","registration_enabled":false}');
const REGISTER_OK = reply(200, '{"id":1,"username":"admin","email":"admin@localhost.invalid","created":"2026-11-10T09:00:00Z"}');
const REGISTER_REFUSED = reply(412, '{"code":1002,"message":"registration is disabled"}');
const LOGIN_OK = reply(200, '{"token":"header.payload.signature"}');
const LOGIN_FAIL = reply(403, '{"code":1011,"message":"wrong username or password"}');

const DEFAULTS = {
  FAKE_RUNNING: "true",
  FAKE_USERS: USERS_TABLE(),
  FAKE_INFO: INFO_OPEN,
  FAKE_REGISTER: REGISTER_OK,
  FAKE_LOGIN: LOGIN_OK,
};

/**
 * The answers, spelled out for the stand-ins: `next KEY DEFAULT` counts the calls of that KEY
 * and uses `<dir>/answers/KEY.<n>` when the test wrote one, `DEFAULT` otherwise. An answer of
 * `<<fail>>` means curl could not reach the app at all (no output, nonzero exit).
 */
const NEXT_FN = [
  'NEXT=""',
  "next() {",
  '  local key="$1" dflt="$2" cf="$dir/counter.$1" af i=0',
  '  if [ -f "$cf" ]; then i=$(cat "$cf"); fi',
  '  printf "%s\\n" "$((i + 1))" > "$cf"',
  '  af="$dir/answers/$key.$i"',
  '  if [ -f "$af" ]; then NEXT="$(cat "$af")"; else NEXT="$dflt"; fi',
  "}",
];

/** Every call is recorded as `<dir>/call.<n>.argv` (program + arguments) and `.stdin`. */
const RECORD_FN = [
  "n=0",
  'while [ -f "$dir/call.$n.argv" ]; do n=$((n + 1)); done',
  'printf "%s %s" "$SELF" "$*" > "$dir/call.$n.argv"',
];

const FAKE_DOCKER = [
  "#!/bin/bash",
  "set -uo pipefail",
  'dir="$FAKE_DOCKER_DIR"',
  'SELF="docker"',
  ...RECORD_FN,
  'if [[ " $* " == *" -i "* ]]; then cat > "$dir/call.$n.stdin"; else : > "$dir/call.$n.stdin"; fi',
  ...NEXT_FN,
  'case "${1:-}" in',
  '  inspect) next RUNNING "${FAKE_RUNNING:-true}"; printf "%s\\n" "$NEXT"; exit 0 ;;',
  '  exec) next USERS "${FAKE_USERS}"; if [ "$NEXT" = "<<fail>>" ]; then exit 7; fi; printf "%s\\n" "$NEXT"; exit 0 ;;',
  '  *) printf "fake docker: unsupported: %s\\n" "$*" >&2; exit 99 ;;',
  "esac",
  "",
].join("\n");

const FAKE_CURL = [
  "#!/bin/bash",
  "set -uo pipefail",
  'dir="$FAKE_DOCKER_DIR"',
  'SELF="curl"',
  ...RECORD_FN,
  'cfg="$(cat)"',
  'printf "%s" "$cfg" > "$dir/call.$n.stdin"',
  ...NEXT_FN,
  'url="$(printf "%s\\n" "$cfg" | sed -n \'s/^url = "\\(.*\\)"$/\\1/p\' | head -n 1)"',
  'case "$url" in',
  '  */api/v1/info) next INFO "${FAKE_INFO}" ;;',
  '  */api/v1/register) next REGISTER "${FAKE_REGISTER}" ;;',
  '  */api/v1/login) next LOGIN "${FAKE_LOGIN}" ;;',
  '  *) printf "fake curl: no answer for: %s\\n" "$url" >&2; exit 98 ;;',
  "esac",
  'if [ "$NEXT" = "<<fail>>" ]; then exit 7; fi',
  'code="$(printf "%s\\n" "$NEXT" | sed -n 1p)"',
  'body="$(printf "%s\\n" "$NEXT" | sed -n \'2,$p\')"',
  'printf "%s\\n%s" "$body" "$code"',
  "",
].join("\n");

writeFileSync(join(BIN, "docker"), FAKE_DOCKER, { mode: 0o755 });
writeFileSync(join(BIN, "curl"), FAKE_CURL, { mode: 0o755 });
writeFileSync(join(BIN_NO_CURL, "docker"), FAKE_DOCKER, { mode: 0o755 });
writeFileSync(join(BIN_NO_DOCKER, "curl"), FAKE_CURL, { mode: 0o755 });

test("the stand-ins are valid bash", () => {
  for (const [name, body] of [["docker", FAKE_DOCKER], ["curl", FAKE_CURL]]) {
    const p = join(TMP, `${name}.syntax.sh`);
    writeFileSync(p, body);
    const parsed = spawnSync(BASH, ["-n", p], { encoding: "utf8" });
    assert.equal(parsed.status, 0, `${name}: ${parsed.stderr}`);
  }
});

/** The bundle's own script is bash, fails fast, and reads the password from stdin. */
test("the setup script is bash, fails fast, and takes the password from stdin", () => {
  const script = readFileSync(SCRIPT, "utf8");
  assert.match(script, /^#!\/usr\/bin\/env bash/, "bash, like every other first-admin script");
  assert.match(script, /set -euo pipefail/);
  assert.match(script, /IFS= read -r PW/, "the password arrives on stdin");
  assert.equal(script.includes(PASSWORD), false, "no password is baked in");
  assert.match(script, /CROW_FA_CONTAINER/, "the container name is overridable for tests only");
  assert.match(script, /^VIKUNJA_BIN="\/app\/vikunja\/vikunja"$/m, "the image is distroless: its own binary lists accounts");
  assert.equal(/docker exec[^\n]*curl/.test(script), false, "no curl inside the container: it has none");
});

// ── the harness ─────────────────────────────────────────────────────────────────────

/** One recorded call: the program with its arguments, and whatever arrived on stdin. */
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

/** Split a test's answers into the files the stand-ins read (`FAKE_X_<n>` → answers/X.<n>). */
function materialize(callsDir, answers) {
  const env = {};
  for (const [name, value] of Object.entries(answers)) {
    const m = /^FAKE_([A-Z0-9]+(?:_[A-Z0-9]+)*)_(\d+)$/.exec(name);
    if (m) {
      const dir = join(callsDir, "answers");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${m[1]}.${m[2]}`), String(value));
    } else {
      env[name] = value;
    }
  }
  return env;
}

/** Run the bundle's script as the installer does: password on stdin, username in the env. */
function run({ password = `${PASSWORD}\n`, answers = {}, mode = "full", user = "admin" } = {}) {
  const callsDir = mkdtempSync(join(TMP, "calls-"));
  const cwd = mkdtempSync(join(TMP, "cwd-"));
  const PATH = mode === "noDocker"
    ? `${CORE}`
    : mode === "noCurl"
      ? `${CORE}:${BIN_NO_CURL}`
      : `${CORE}:${BIN}`;
  const res = spawnSync(BASH, [SCRIPT], {
    input: password,
    encoding: "utf8",
    timeout: 120_000,
    cwd,
    env: {
      PATH,
      HOME: TMP,
      CROW_FIRST_ADMIN_USER: user,
      FAKE_DOCKER_DIR: callsDir,
      ...materialize(callsDir, { ...DEFAULTS, ...answers }),
    },
  });
  return { status: res.status, stdout: res.stdout || "", stderr: res.stderr || "", calls: readCalls(callsDir) };
}

const argvText = (r) => r.calls.map((c) => c.argv).join("\n");
const stdinText = (r) => r.calls.map((c) => c.stdin).join("\n");
const curls = (r) => r.calls.filter((c) => c.argv.startsWith("curl "));
const usersCalls = (r) => r.calls.filter((c) => c.argv.includes("/app/vikunja/vikunja user list"));

/** The whole point: the password is on a pipe, never in a command line, never printed. */
function assertPasswordStayedOutOfSight(r, password = PASSWORD) {
  assert.equal(argvText(r).includes(password), false, "no argument may carry the password");
  assert.equal(String(r.stdout).includes(password), false, "the script must not print the password");
  assert.equal(String(r.stderr).includes(password), false, "the script must not print the password");
}

/** The URL of one curl call (its whole request is the config on the call's stdin). */
const urlOf = (call) => (/^url = "(.*)"$/m.exec(call.stdin) || [])[1] || "";
const dataOf = (call) => {
  const m = /^data = "(.*)"$/m.exec(call.stdin);
  return m ? JSON.parse(m[1].replace(/\\(.)/g, "$1")) : null;
};
const callsTo = (r, suffix) => curls(r).filter((c) => urlOf(c).endsWith(suffix));

// ── the exits every app owes the protocol ───────────────────────────────────────────

test("a fresh install registers the account once and proves the login, password on stdin only", () => {
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assertPasswordStayedOutOfSight(r);

  const registers = callsTo(r, "/api/v1/register");
  assert.equal(registers.length, 1, "the account is registered exactly once");
  assert.deepEqual(dataOf(registers[0]), {
    username: "admin",
    email: "admin@localhost.invalid",
    password: PASSWORD,
  }, "the account, the .invalid address and the generated password travel in the body");
  assert.equal(/^request = "POST"$/m.test(registers[0].stdin), true, "the method is in the config, not an argument");
  assert.equal(registers[0].argv.includes(PASSWORD), false, "never an argument");

  const logins = callsTo(r, "/api/v1/login");
  assert.equal(logins.length, 1, "the new login is proved once");
  assert.deepEqual(dataOf(logins[0]), { username: "admin", password: PASSWORD });
  assert.match(r.stdout, /now uses the password Crow generated/);
});

test("the account is only registered while the app has none", () => {
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(usersCalls(r).length, 2, "Vikunja's own account list is read once before anything is written, and once after to name any other account");
  assert.match(usersCalls(r)[0].argv, /docker exec crow-vikunja \/app\/vikunja\/vikunja user list/);
  assert.equal(r.calls[0].argv.startsWith("docker inspect"), true, "the container is checked before it is touched");
});

test("an install that already has accounts is left alone (exit 3)", () => {
  const r = run({ answers: { FAKE_USERS: USERS_TABLE([[1, "alex", "alex@example.invalid"]]) } });
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /already has accounts/);
  assert.match(r.stderr, /nothing was changed/);
  assert.equal(callsTo(r, "/api/v1/register").length, 0, "nothing may be registered");
  assert.equal(callsTo(r, "/api/v1/login").length, 0, "and nothing has to be proved");
  assert.equal(stdinText(r).includes(PASSWORD), false, "the new password never even reaches the app");
});

test("registration closed with no account is exit 4, and says how to reopen it", () => {
  const r = run({ answers: { FAKE_INFO: INFO_CLOSED } });
  assert.equal(r.status, 4, r.stderr);
  assert.match(r.stderr, /registration is closed and it has no account/);
  assert.match(r.stderr, /VIKUNJA_ENABLE_REGISTRATION=true/);
  assert.match(r.stderr, /nothing was changed/);
  assert.equal(callsTo(r, "/api/v1/register").length, 0);
});

test("a container that is not running is exit 4 after the state check only", () => {
  const r = run({ answers: { FAKE_RUNNING: "false" } });
  assert.equal(r.status, 4, r.stderr);
  assert.match(r.stderr, /not running/);
  assert.equal(r.calls.length, 1, "only `docker inspect` ran");
});

test("no docker, or no curl on this host, is exit 4 with nothing changed", () => {
  const noDocker = run({ mode: "noDocker" });
  assert.equal(noDocker.status, 4, noDocker.stderr);
  assert.match(noDocker.stderr, /docker is not available/);
  assert.equal(noDocker.calls.length, 0, "nothing was asked");

  const noCurl = run({ mode: "noCurl" });
  assert.equal(noCurl.status, 4, noCurl.stderr);
  assert.match(noCurl.stderr, /curl is not available/);
  assert.equal(noCurl.calls.filter((c) => c.argv.startsWith("curl ")).length, 0);
  assert.equal(callsTo(noCurl, "/api/v1/register").length, 0);
});

test("a password the protocol refuses, or a username that is not an account name, is exit 1 with no calls", () => {
  for (const password of ["", "\n", "short-pass\n"]) {
    const r = run({ password });
    assert.equal(r.status, 1, JSON.stringify(password));
    assert.equal(r.calls.length, 0, `${JSON.stringify(password)}: nothing was called`);
  }
  for (const user of ['ad"min', "admin name", "", "admin;rm -rf /"]) {
    const r = run({ user });
    assert.equal(r.status, 1, JSON.stringify(user));
    assert.equal(r.calls.length, 0, `${JSON.stringify(user)}: nothing was called`);
  }
});

test("an account and password Vikunja took but never accepts a login for is kept (exit 5)", () => {
  const r = run({ answers: { FAKE_LOGIN: LOGIN_FAIL } });
  assert.equal(r.status, 5, r.stderr);
  assert.match(r.stderr, /accepted the new password, but logging in with it did not succeed/);
  assert.match(r.stderr, /Crow kept the new password; use the login in Settings → Passwords/);
  assert.equal(callsTo(r, "/api/v1/register").length, 1, "the registration really happened first");
  assert.equal(callsTo(r, "/api/v1/login").length, 3, "the proof is tried three times, no more");
  assertPasswordStayedOutOfSight(r);
});

// ── a registration that does not say what happened ─────────────────────────────────

test("an unclear registration that left an account behind is proved, and that is a success", () => {
  const r = run({
    answers: {
      FAKE_REGISTER: REGISTER_REFUSED,
      // The re-check reads the registration flag, then the account list: an account appeared.
      FAKE_INFO_1: INFO_CLOSED,
      FAKE_USERS_1: USERS_TABLE([[1, "admin", "admin@localhost.invalid"]]),
    },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(usersCalls(r).length, 3, "Vikunja's own list decides after an unclear answer (and names any other account after)");
  assert.equal(callsTo(r, "/api/v1/login").length, 1, "the password the app may hold is proved");
  assertPasswordStayedOutOfSight(r);
});

test("an unclear registration whose account Crow's password does not open is exit 3, nothing saved", () => {
  const r = run({
    answers: {
      FAKE_REGISTER: REGISTER_REFUSED,
      FAKE_INFO_1: INFO_CLOSED,
      FAKE_USERS_1: USERS_TABLE([[1, "alex", "alex@example.invalid"]]),
      FAKE_LOGIN: LOGIN_FAIL,
    },
  });
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /not Crow's/);
  assert.match(r.stderr, /left alone, and nothing of Crow's was saved/);
  assert.equal(callsTo(r, "/api/v1/login").length, 3, "the login is tried before the password is dropped");
  assertPasswordStayedOutOfSight(r);
});

test("an unclear registration on an app that still has no account changes nothing (exit 1)", () => {
  const r = run({ answers: { FAKE_REGISTER: REGISTER_REFUSED, FAKE_INFO_1: INFO_OPEN } });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /did not create the account, so nothing was changed/);
  assert.equal(callsTo(r, "/api/v1/login").length, 0, "no proof after a registration that did not happen");
});

test("an unreadable re-check after an unclear registration changes nothing (exit 1)", () => {
  const r = run({ answers: { FAKE_REGISTER: REGISTER_REFUSED, FAKE_USERS_1: "<<fail>>" } });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /did not report whether it created the account/);
  assert.equal(callsTo(r, "/api/v1/login").length, 0, "no proof without a state");
});

test("the app's registration flag is required: an answer without it is exit 4, never a guess", () => {
  for (const answer of [reply(200, '{"version":"2.8.0"}'), reply(200, "not json at all"), INFO_OPEN.replace("true", "TRUE")]) {
    const r = run({ answers: { FAKE_INFO: answer } });
    assert.equal(r.status, 4, `${JSON.stringify(answer)}: ${r.stderr}`);
    assert.match(r.stderr, /accounts could not be read/);
    assert.equal(callsTo(r, "/api/v1/register").length, 0, "nothing is written on an unreadable state");
  }
});

test("a web port that is not up yet is retried before the state is read", () => {
  const r = run({ answers: { FAKE_INFO_0: "<<fail>>", FAKE_USERS_0: USERS_TABLE() } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(callsTo(r, "/api/v1/info").length, 2, "the first probe failed, the second answered");
  assert.equal(callsTo(r, "/api/v1/register").length, 1);
});

test("an account list that cannot be read is exit 4, and nothing is registered", () => {
  const r = run({ answers: { FAKE_USERS: "<<fail>>" } });
  assert.equal(r.status, 4, r.stderr);
  assert.match(r.stderr, /accounts could not be read/);
  assert.equal(callsTo(r, "/api/v1/register").length, 0);
});

// ── the declaration that puts the script to work ───────────────────────────────────

const manifestOf = (id = "vikunja") => JSON.parse(readFileSync(join(B(id), "manifest.json"), "utf8"));

/** Every per-request bound the script hands its tools: host `timeout`, curl max-time. */
const requestBounds = (script) => {
  const text = script.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
  return [
    ...[...text.matchAll(/\btimeout (\d+)\b/g)].map((m) => Number(m[1])),
    ...[...text.matchAll(/max-time = (\d+)/g)].map((m) => Number(m[1])),
  ];
};

test("the manifest passes the bundle contract and declares the setup script and its after-step", () => {
  const manifest = manifestOf();
  const { errors } = validateManifest(manifest, B(), { bundleExists: (id) => existsSync(join(REPO, "bundles", id, "manifest.json")) });
  assert.deepEqual(errors, [], "the whole manifest");
  assert.deepEqual(
    { mode: manifest.firstAdmin.mode, via: manifest.firstAdmin.via, script: manifest.firstAdmin.setup.script },
    { mode: "crow", via: "setup", script: "scripts/first-admin.sh" },
  );
  assert.equal(manifest.firstAdmin.user, "admin", "the account Crow creates");
  assert.equal(manifest.firstAdmin.secretEnv, "VIKUNJA_ADMIN_PASSWORD", "where the keychain keeps the password");
  assert.equal(manifest.firstAdmin.userEnv, undefined, "nothing in the bundle's .env needs the username");
  assert.deepEqual(manifest.firstAdmin.setup.after, {
    env: { VIKUNJA_ENABLE_REGISTRATION: "false" },
    recreate: true,
  }, "Crow turns registration off and recreates the container once");
  assert.match(manifest.firstAdmin.note, /VIKUNJA_ENABLE_REGISTRATION=false/, "an install set up by hand is told how to close registration");
  assert.equal(manifest.refreshFiles.includes("docker-compose.yml"), true, "an installed copy receives the compose that reads the setting");
});

test("the registration setting is a declared, non-secret env var, and the compose interpolates it", () => {
  const manifest = manifestOf();
  const spec = (manifest.env_vars || []).find((v) => v.name === "VIKUNJA_ENABLE_REGISTRATION");
  assert.ok(spec, "the after-step may only write a DECLARED env var");
  assert.equal(spec.default, "true");
  assert.equal(spec.required, false, "an install must not block on it");
  assert.equal(spec.secret, undefined, "it is a switch, not a secret");
  assert.match(spec.description, /Crow turns this off after it creates your account/);
  const compose = readFileSync(join(B(), "docker-compose.yml"), "utf8");
  assert.match(compose, /VIKUNJA_SERVICE_ENABLEREGISTRATION=\$\{VIKUNJA_ENABLE_REGISTRATION:-true\}/);
  // The password Crow keeps in the keychain is NOT written into the bundle's .env: the MCP
  // tools log in with the API token, not with the admin password.
  assert.equal((manifest.env_vars || []).some((v) => v.name === "VIKUNJA_ADMIN_PASSWORD"), false);
  assert.equal((manifest.requires?.env || []).includes("VIKUNJA_ADMIN_PASSWORD"), false);
});

test("the waits, the proof loop and every request bound fit the manifest timeout", () => {
  const script = readFileSync(SCRIPT, "utf8");
  const timeout = manifestOf().firstAdmin.setup.timeout_s;
  const budgets = [...script.matchAll(/^(\w+_deadline)=\$\(\(SECONDS \+ (\d+)\)\)$/gm)];
  assert.equal(budgets.length >= 2, true, "a wait and a proof budget");
  const total = budgets.reduce((sum, m) => sum + Number(m[2]), 0);
  const bounds = requestBounds(script);
  assert.equal(bounds.length > 0, true, "every request carries its own time bound");
  assert.equal(bounds.every((b) => b > 0 && b <= 45), true, "no single request may take more than 45s");
  const worst = total + bounds.reduce((x, y) => x + y, 0);
  assert.equal(worst < timeout, true, `worst case ${worst}s inside ${timeout}s`);
  assert.equal(worst <= timeout - 20, true, `${worst}s leaves the runner ${timeout - worst}s of slack`);
});

test("the docs and the skill say who creates the account, in both languages", () => {
  for (const path of [join(REPO, "docs", "integrations", "vikunja.md"), join(REPO, "docs", "es", "integrations", "vikunja.md")]) {
    const doc = readFileSync(path, "utf8");
    assert.match(doc, /Settings\*\* → \*\*Passwords|Contraseñas/, `${path}: says where the password is kept`);
    assert.match(doc, /VIKUNJA_ENABLE_REGISTRATION=false/, `${path}: says how a hand-set-up install closes registration`);
    assert.equal(/you create the account: register in the web UI/.test(doc), false, `${path}: no longer sends the operator to register by hand`);
  }
  const skill = readFileSync(join(B(), "skills", "vikunja.md"), "utf8");
  assert.match(skill, /Settings → Passwords/, "the skill names where Crow keeps the login");
  assert.match(skill, /add more people\s+from Vikunja's own admin tools/i, "and where people are added instead");
  assert.match(skill, /VIKUNJA_ENABLE_REGISTRATION=false/, "and how a hand-set-up install closes registration");
});

test("the committed registry carries the same declaration (it is generated from the manifest)", () => {
  const registry = JSON.parse(readFileSync(join(REPO, "registry", "add-ons.json"), "utf8"))["add-ons"];
  const entry = registry.find((e) => e.id === "vikunja");
  assert.ok(entry, "registry/add-ons.json has an entry for vikunja");
  assert.equal(JSON.stringify(entry), JSON.stringify({ ...manifestOf(), official: true }), "the entry is what build-registry would write");
});

test("vikunja: the account count reads the real 2.8.0 table — log lines and box borders are not accounts", () => {
  const fresh = run({ answers: { FAKE_USERS_0: USERS_TABLE([]) } });
  assert.equal(fresh.status, 0, `a fresh install with only log lines and borders is fresh: ${fresh.stderr}`);
  const existing = run({ answers: { FAKE_USERS_0: USERS_TABLE([[1, "owner", "owner@example.com"]]) } });
  assert.equal(existing.status, 3, existing.stderr);
});

test("vikunja: a user list without the table header is unreadable (exit 4), never 'no accounts'", () => {
  const r = run({ answers: { FAKE_USERS_0: 'time=2026-11-10T09:00:00Z level=ERROR msg="database is locked"' } });
  assert.equal(r.status, 4, r.stderr);
});

test("vikunja: another account made while registration was open is named after setup", () => {
  const both = USERS_TABLE([[1, "admin", "admin@localhost.invalid"], [2, "intruder", "x@example.com"]]);
  const r = run({ answers: { FAKE_USERS_1: both, FAKE_USERS_2: both } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(`${r.stdout}${r.stderr}`, /also has these accounts, made while registration was open: intruder/, `user list calls: ${usersCalls(r).length}; out: ${r.stdout} | err: ${r.stderr} | stdin of 2nd: ${JSON.stringify(usersCalls(r)[1])}`);
});
