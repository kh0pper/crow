/**
 * N3-4 phase 2f — Crow replaces the shipped default logins of Shiori, BookStack,
 * Calibre-Web and Stirling PDF.
 *
 * All four apps documented a default login that anyone reaching them could use as admin,
 * and three of them had no first-run page that could take a password instead. Each bundle
 * now ships `scripts/first-admin.sh` and declares `firstAdmin: { mode: "crow", via:
 * "setup", ... }`, so the installer runs that script once after `compose up` with the
 * generated password as ONE line on stdin. What these tests hold down:
 *
 *   1. a fresh install: exit 0, the password delivered on stdin and NEVER in an argument
 *      (that is what a process list would show) and never printed, and the new login
 *      proved,
 *   2. an install where the shipped default no longer works: exit 3, no set call, and the
 *      password never even reaches the app,
 *   3. docker missing / the container not running (and, for the two apps reached from the
 *      host, no host curl): exit 4, nothing changed,
 *   4. a password the protocol refuses (empty, short): exit 1, and docker/curl is not even
 *      asked,
 *   5. an admin account that is not a plain account name (BookStack's is an email): exit 1,
 *      docker not asked either,
 *   6. a detection step that answers with nothing usable: exit 4, never a change,
 *   7. a change the app confirmed but a login it never accepts: exit 5, after three proof
 *      tries, and the message says the host kept the new password instead of sending the
 *      operator to set an admin password by hand,
 *   8. a set step the app refused: exit 1, nothing claimed — and where the answer to a set
 *      call is unclear (Shiori's PATCH, Stirling's change-password) the confirm logins say
 *      whether it landed, never a claim that the old login is unchanged,
 *   9. BookStack: the shipped default is checked BEFORE anything is written (its CLI keys
 *      on the email alone and would overwrite an operator's own password), the CLI runs as
 *      uid 1000 with no `--password` argument and under this host's `timeout`, its exit 2
 *      means "already has an admin", and every login gets a cookie jar of its own — created
 *      inside the container and removed again, so no run inherits a session or leaves one,
 *   10. Calibre-Web: one transaction re-reads the hash, checks it is still the shipped
 *      password, updates exactly that row and commits (CHANGED means "already the
 *      operator's", exit 3), every snippet prints one status word and runs under the host's
 *      `timeout`, and the proof is the database's answer rather than a web login,
 *   11. Stirling PDF: exactly ONE sign-in attempt with the shipped password per run (failed
 *      ones lock the account), a "locked" answer stops the proof loop at once and is only
 *      read from the WORD, at most two confirm logins, and a run that ends at 3 leaves a
 *      marker so the next run refuses without spending another attempt,
 *   12. Shiori: the account the login named is the one the PATCH touches (never id 1), and
 *      an answer that names another account changes nothing,
 *   13. nothing inside a container or on the wire may outlive the protocol timeout: every
 *      curl config carries max-time, every wait is a $SECONDS budget, and the budgets plus
 *      every request bound fit inside the manifest's timeout_s,
 *   14. the four manifests carry what the contract, the runner and the card need (including
 *      BookStack's Laravel APP_KEY, which its image now requires to start at all, and the
 *      admin passwords Crow generates, which an install must not block on), the docs say
 *      what to do about a hand-set APP_KEY, and the generated registry carries the same
 *      declarations.
 *
 * No docker and no network here: a `docker` and a `curl` executable written into a temp dir
 * sit first on PATH, record every argv and the stdin they received, and replay canned
 * answers. An answer is handed to the stand-in as a FILE (`<calls>/answers/<KEY>.<i>`), one
 * per call of that kind, which is how a test says "the first attempt works, the retry does
 * not" without ever putting a secret in the environment. The stand-in docker also keeps a
 * `jars/` directory as the container's disk, and answers a GET of BookStack's form with a
 * redirect when the jar it names still holds a session — so a script that reused a jar, or
 * left one behind, is caught by a second run against the same container.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { validateManifest } from "../scripts/lib/bundle-contract.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const B = (id) => join(REPO, "bundles", id);

/** A generated-password-shaped value: URL- and shell-safe, 22 characters. */
const PASSWORD = "gen-Secret_ABC123xy-z45";
/** The token shape the two HTTP apps hand back (dots, dash and underscore are allowed). */
const TOKEN = "eyJhbGciOi.payload.sig-1_2";

const TMP = mkdtempSync(join(tmpdir(), "crow-fa-scripts-4-"));
const BIN = join(TMP, "bin");
const NO_TOOLS = join(TMP, "no-tools");
const NO_CURL_BIN = join(TMP, "no-curl");
/** By absolute path: the "nothing on PATH" case runs the script with an empty PATH. */
const BASH = existsSync("/bin/bash") ? "/bin/bash" : "bash";
mkdirSync(BIN, { recursive: true });
mkdirSync(NO_TOOLS, { recursive: true });
mkdirSync(NO_CURL_BIN, { recursive: true });

// ── the canned answers each app's own tool answers with ────────────────────────────

/** Shiori v1.8.0's login answer: only a token (in `message`), then the status code. */
const shioriLogin = (token = TOKEN) => `{"ok":true,"message":{"expires":0,"token":"${token}"}}\n200`;
/** GET /api/v1/auth/me: the signed-in account (Shiori puts it in `message`). */
const shioriMe = (id = 1, user = "shiori") =>
  `{"ok":true,"message":{"id":${id},"owner":true,"username":"${user}","config":{"ShowId":false}}}\n200`;
/** Stirling's login answer: the access token inside a session object, then the code. */
const stirlingLogin = (token = TOKEN) => `{"session":{"access_token":"${token}"}}\n200`;
/** BookStack's login page: the CSRF token a form login has to send back. */
const BOOKSTACK_PAGE =
  '<form method="POST" action="http://localhost:80/login"><input type="hidden" name="_token" value="csrf-token-123">' +
  '<input name="email"><input type="password" name="password"></form>\n200';
const BOOKSTACK_SIGNED_IN = "302 http://localhost:6875/";
const BOOKSTACK_REFUSED = "302 http://localhost:6875/login";
const SHIORI_REFUSED = '{"message":"Invalid username or password"}\n400';
const STIRLING_REFUSED = '{"message":"Invalid credentials"}\n401';

/** Everything a run answers with unless a test says otherwise. */
const DEFAULTS = {
  // The shipped password still works for the ONE detection attempt, and no longer once the
  // change went through — which is exactly what the proof's default check reads.
  FAKE_SHIORI_DEFAULT_0: shioriLogin(),
  FAKE_SHIORI_DEFAULT: SHIORI_REFUSED,
  FAKE_SHIORI_NEWLOGIN: shioriLogin(),
  FAKE_SHIORI_PATCH: "200",
  FAKE_SHIORI_ME: shioriMe(),
  FAKE_STIRLING_DEFAULT_0: stirlingLogin(),
  FAKE_STIRLING_DEFAULT: STIRLING_REFUSED,
  FAKE_STIRLING_NEWLOGIN: stirlingLogin(),
  FAKE_STIRLING_SET: "200",
  FAKE_BOOKSTACK_PAGE: BOOKSTACK_PAGE,
  FAKE_BOOKSTACK_LOGIN: BOOKSTACK_SIGNED_IN,
  FAKE_BOOKSTACK_PROVE: BOOKSTACK_SIGNED_IN,
  FAKE_CALIBRE_STATE: "DEFAULT",
  FAKE_CALIBRE_SET: "UPDATED",
  FAKE_CALIBRE_PROVE: "LOGIN-OK",
};

/**
 * The answers, spelled out for each stand-in: `next KEY DEFAULT` counts the calls of that
 * KEY and uses `<dir>/answers/KEY.<n>` when the test wrote one, `DEFAULT` otherwise. An
 * answer file that exists but is empty is an empty answer — which is how "the app answered
 * with nothing" is played.
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

/**
 * The stand-in docker. Every call is recorded as `<dir>/call.<n>.argv` (the program and the
 * arguments it saw) plus `<dir>/call.<n>.stdin`, and answered from the files above. An
 * answer of `<<fail>>` makes the call fail, which is how a CLI that refuses is played.
 *
 * Both the container calls and the app's own HTTP calls (BookStack and Calibre-Web are
 * reached inside their container) are told apart by what the argv and the stdin carry.
 */
const FAKE_DOCKER = [
  "#!/usr/bin/env bash",
  "set -uo pipefail",
  'dir="$FAKE_DOCKER_DIR"',
  'jars="$FAKE_DOCKER_CONTAINER/jars"',
  'mkdir -p "$jars"',
  "n=0",
  'while [ -f "$dir/call.$n.argv" ]; do n=$((n + 1)); done',
  'argvf="$dir/call.$n.argv"',
  'stdinf="$dir/call.$n.stdin"',
  'printf "docker %s" "$*" > "$argvf"',
  'if [[ " $* " == *" -i "* ]]; then cat > "$stdinf"; else : > "$stdinf"; fi',
  "",
  ...NEXT_FN,
  "emit() {",
  '  if [ "$NEXT" = "<<fail>>" ]; then exit 1; fi',
  '  printf "%s\\n" "$NEXT"',
  "  exit 0",
  "}",
  "",
  'args="$*"',
  'last="${!#}"',
  'case "${1:-}" in',
  '  inspect) next RUNNING true; printf "%s\\n" "$NEXT"; exit 0 ;;',
  "  exec) ;;",
  '  *) printf "fake docker: unsupported: %s\\n" "$*" >&2; exit 99 ;;',
  "esac",
  "",
  // The container's own mktemp and rm: the login script makes a cookie jar inside the
  // container for each login and removes it again. `jars/` is this stand-in's container
  // disk, so a jar a script forgets to remove is still there for the next run to find.
  'if [ "$last" = "mktemp" ]; then',
  '  k="$(cat "$jars/.next" 2>/dev/null || printf 0)"',
  '  printf "%s\\n" "$((k + 1))" > "$jars/.next"',
  '  : > "$jars/crow-fa-jar.$k"',
  '  printf "/tmp/crow-fa-jar.%s\\n" "$k"',
  "  exit 0",
  "fi",
  'if [[ "$args" == *" rm -f "* ]]; then rm -f "$jars/$(basename "$last")"; exit 0; fi',
  "",
  // BookStack: its admin CLI (exits with its own code, so exit 2 can be played), then the
  // app's own form login over curl inside the container.
  'if [[ "$args" == *"bookstack:create-admin"* ]]; then next BOOKSTACK_CREATE 0; exit "$NEXT"; fi',
  'if [[ "$args" == *" -o /dev/null http://localhost:80/login"* ]]; then next BOOKSTACK_UP 0; exit "$NEXT"; fi',
  'if grep -q "localhost:80/login" "$stdinf"; then',
  '  jar="$(sed -n \'s/^cookie = "\\(.*\\)"$/\\1/p\' "$stdinf" | head -n 1)"',
  '  jarn="$jars/$(basename "$jar")"',
  '  if grep -q \'request = "POST"\' "$stdinf"; then',
  '    if grep -q "email=admin@admin.com" "$stdinf"; then next BOOKSTACK_LOGIN "$FAKE_BOOKSTACK_LOGIN"; else next BOOKSTACK_PROVE "$FAKE_BOOKSTACK_PROVE"; fi',
  // A signed-in answer is what puts a session in the jar; a jar that holds one answers the
  // next GET of the form with a redirect to the app, the way BookStack does.
  '    case "$NEXT" in "302 "*"/") [ -n "$jar" ] && printf "session\\n" > "$jarn" ;; esac',
  "    emit",
  "  fi",
  '  if [ -n "$jar" ] && [ -s "$jarn" ]; then printf "302\\n"; exit 0; fi',
  '  next BOOKSTACK_PAGE "$FAKE_BOOKSTACK_PAGE"',
  "  emit",
  "fi",
  // Calibre-Web: the health probe, then its three python snippets, told apart by the text
  // of the snippet (the stand-in never runs one).
  'if [[ "$args" == *"localhost:8083"* ]]; then next CALIBRE_UP 0; exit "$NEXT"; fi',
  'if [[ "$args" == *"python3"* ]]; then',
  '  if [[ "$args" == *"UPDATE user SET password"* ]]; then next CALIBRE_SET "${FAKE_CALIBRE_SET:-UPDATED}"',
  '  elif [[ "$args" == *"LOGIN-OK"* ]]; then next CALIBRE_PROVE "${FAKE_CALIBRE_PROVE:-LOGIN-OK}"',
  '  else next CALIBRE_STATE "${FAKE_CALIBRE_STATE:-DEFAULT}"',
  "  fi",
  "  emit",
  "fi",
  'printf "fake docker: no answer for: %s\\n" "$args" >&2; exit 98',
  "",
].join("\n");
writeFileSync(join(BIN, "docker"), FAKE_DOCKER, { mode: 0o755 });
writeFileSync(join(NO_CURL_BIN, "docker"), FAKE_DOCKER, { mode: 0o755 });

/**
 * The stand-in host curl (Shiori and Stirling are reached from this machine). It records the
 * same way and reads its config from stdin, exactly as `curl -K -` does. An answer is the
 * app's body followed by one line with the status code, which is what `-w '\n%{http_code}'`
 * appends; with `-o /dev/null` only that last line is printed.
 */
const FAKE_CURL = [
  "#!/usr/bin/env bash",
  "set -uo pipefail",
  'dir="$FAKE_CURL_DIR"',
  "n=0",
  'while [ -f "$dir/call.$n.argv" ]; do n=$((n + 1)); done',
  'argvf="$dir/call.$n.argv"',
  'stdinf="$dir/call.$n.stdin"',
  'printf "curl %s" "$*" > "$argvf"',
  'cat > "$stdinf"',
  "",
  ...NEXT_FN,
  "emit() {",
  '  if [ "$NEXT" = "<<fail>>" ]; then exit 7; fi',
  '  if [[ " $args " == *" -o /dev/null "* ]]; then printf "%s\\n" "$NEXT" | tail -n 1; else printf "%s" "$NEXT"; fi',
  "  exit 0",
  "}",
  "",
  'args="$*"',
  'url="$(sed -n \'s/^url = "\\(.*\\)"$/\\1/p\' "$stdinf" | head -n 1)"',
  'case "$url" in',
  '  *:8086/api/v1/auth/login*)',
  '    if grep -q gopher "$stdinf"; then next SHIORI_DEFAULT "$FAKE_SHIORI_DEFAULT"; else next SHIORI_NEWLOGIN "$FAKE_SHIORI_NEWLOGIN"; fi',
  "    emit ;;",
  '  *:8086/api/v1/auth/me*) next SHIORI_ME "$FAKE_SHIORI_ME"; emit ;;',
  '  *:8086/api/v1/accounts/*) next SHIORI_PATCH "200"; emit ;;',
  '  *:8086/*) next SHIORI_UP "200"; emit ;;',
  '  *:8092/api/v1/auth/login*)',
  '    if grep -q stirling "$stdinf"; then next STIRLING_DEFAULT "$FAKE_STIRLING_DEFAULT"; else next STIRLING_NEWLOGIN "$FAKE_STIRLING_NEWLOGIN"; fi',
  "    emit ;;",
  '  *:8092/api/v1/user/change-password-on-login*) next STIRLING_SET "200"; emit ;;',
  '  *:8092/*) next STIRLING_UP "200"; emit ;;',
  '  *) printf "fake curl: no answer for: %s\\n" "$url" >&2; exit 98 ;;',
  "esac",
  "",
].join("\n");
writeFileSync(join(BIN, "curl"), FAKE_CURL, { mode: 0o755 });

// The "no host curl" case runs with a PATH that has docker and the plain shell tools but no
// curl at all, so `command -v curl` is what fails — not a missing grep.
for (const tool of ["bash", "cat", "grep", "head", "sed", "sleep", "tail", "tr"]) {
  const src = ["/usr/bin", "/bin"].map((d) => join(d, tool)).find((p) => existsSync(p));
  if (src) symlinkSync(src, join(NO_CURL_BIN, tool));
}

/** PATH per case: everything, nothing at all, or everything but curl. */
const PATHS = {
  full: `${BIN}:/usr/bin:/bin`,
  noDocker: `${NO_TOOLS}`,
  noCurl: `${NO_CURL_BIN}`,
};

test("the stand-in docker and curl are valid bash", () => {
  for (const p of [join(BIN, "docker"), join(BIN, "curl")]) {
    const parsed = spawnSync(BASH, ["-n", p], { encoding: "utf8" });
    assert.equal(parsed.status, 0, `${p}: ${parsed.stderr}`);
  }
});

after(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
});

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

/**
 * Split a test's answers into the files the stand-ins read (`FAKE_<KEY>_<i>` becomes
 * `answers/<KEY>.<i>`) and the plain variables they read directly (`FAKE_<NAME>`).
 */
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

/** The admin account each bundle's manifest declares. */
const USERS = {
  shiori: "shiori",
  bookstack: "admin@localhost.localdomain",
  "calibre-web": "admin",
  "stirling-pdf": "admin",
};

/**
 * Run a bundle's setup script with the password on stdin, as the installer does.
 *
 * `cwd` and `container` are the two pieces of state that outlive one run: the script's own
 * directory (where a run may leave a marker) and the stand-in container's disk (where a run
 * may leave a cookie jar). Both default to fresh ones per run.
 */
function run(bundle, { password = `${PASSWORD}\n`, answers = {}, mode = "full", cwd: cwdIn = null, container = null } = {}) {
  const callsDir = mkdtempSync(join(TMP, "calls-"));
  const cwd = cwdIn || mkdtempSync(join(TMP, "cwd-"));
  const containerDir = container || join(callsDir, "container");
  mkdirSync(containerDir, { recursive: true });
  const res = spawnSync(BASH, [join(B(bundle), "scripts", "first-admin.sh")], {
    input: password,
    encoding: "utf8",
    timeout: 60_000,
    cwd,
    env: {
      PATH: PATHS[mode],
      HOME: TMP,
      CROW_FIRST_ADMIN_USER: USERS[bundle],
      FAKE_DOCKER_DIR: callsDir,
      FAKE_DOCKER_CONTAINER: containerDir,
      FAKE_CURL_DIR: callsDir,
      ...materialize(callsDir, { ...DEFAULTS, ...answers }),
    },
  });
  return { status: res.status, stdout: res.stdout || "", stderr: res.stderr || "", calls: readCalls(callsDir), cwd, container: containerDir };
}

const argvText = (r) => r.calls.map((c) => c.argv).join("\n");
const stdinText = (r) => r.calls.map((c) => c.stdin).join("\n");
const count = (r, needle) => r.calls.filter((c) => c.argv.includes(needle)).length;
const ran = (r, needle) => count(r, needle) > 0;

/** The calls that are the app's own HTTP requests from this host (Shiori, Stirling). */
const hostCalls = (r) => r.calls.filter((c) => c.argv.startsWith("curl"));
/** Host requests to one app path (the URL lives in the config on stdin, never in argv). */
const hostCallTo = (r, path) => hostCalls(r).filter((c) => c.stdin.includes(path));
/** Host requests to a login endpoint; `secret` narrows it to the ones carrying that value. */
const hostLogins = (r, secret = null) =>
  hostCallTo(r, "/api/v1/auth/login").filter((c) => (secret ? c.stdin.includes(secret) : true));

/** The whole point: the password is on a pipe, never in a command line, never printed. */
function assertPasswordStayedOutOfSight(r, password = PASSWORD) {
  assert.equal(argvText(r).includes(password), false, "no argument may carry the password");
  assert.equal(String(r.stdout).includes(password), false, "the script must not print the password");
  assert.equal(String(r.stderr).includes(password), false, "the script must not print the password");
}

/** Every `key = "value"` line of a curl config, unescaped exactly as curl reads it. */
function configLines(text) {
  const out = [];
  for (const line of String(text).split("\n")) {
    const m = /^([A-Za-z-]+) = "(.*)"$/.exec(line);
    if (m) out.push({ key: m[1], value: m[2].replace(/\\(.)/g, "$1") });
  }
  return out;
}
const configValue = (text, key) => (configLines(text).find((l) => l.key === key) || {}).value;

/** The body of one embedded python snippet (`DETECT='…'`), as the script carries it. */
function snippet(script, name) {
  const m = new RegExp(`^${name}='([\\s\\S]*?)'$`, "m").exec(script);
  assert.ok(m, `${name} snippet is in the script`);
  return m[1];
}

// ── Shiori: everything from this host, because the image is distroless ─────────────

test("shiori: a fresh install gets the generated password, delivered on stdin only", () => {
  const r = run("shiori");
  assert.equal(r.status, 0, r.stderr);
  assertPasswordStayedOutOfSight(r);
  assert.equal(r.calls[0].argv.startsWith("docker inspect"), true, "the container is checked before it is touched");
  assert.equal(r.calls[0].argv.includes("crow-shiori"), true, "and the app's own container is the one named");
  assert.equal(hostLogins(r, PASSWORD).length, 1, "the new login is proved once, from this host");
  assert.equal(hostCallTo(r, "/api/v1/accounts/1").length, 1, "the password is set through Shiori's own account API");
  const patch = hostCallTo(r, "/api/v1/accounts/1")[0];
  assert.equal(configValue(patch.stdin, "request"), "PATCH", "the method is in the config, not an argument");
  assert.equal(configValue(patch.stdin, "header"), `Authorization: Bearer ${TOKEN}`, "the token travels on the pipe");
  assert.deepEqual(JSON.parse(configValue(patch.stdin, "data")), {
    old_password: "gopher",
    new_password: PASSWORD,
  });
  assert.equal(patch.argv.includes(TOKEN), false, "the token is never an argument");
  assert.equal(hostLogins(r, "gopher").length, 2, "the shipped login is tried once to detect, once to prove it is gone");
});

test("shiori: an install whose shipped login no longer works is left alone (exit 3)", () => {
  const r = run("shiori", { answers: { FAKE_SHIORI_DEFAULT_0: SHIORI_REFUSED } });
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /already has its own admin password/);
  assert.equal(hostCallTo(r, "/api/v1/accounts/1").length, 0, "no account may be touched");
  assert.equal(stdinText(r).includes(PASSWORD), false, "and the new password never reaches the app");
});

test("shiori: a container that is not running, no docker, or no host curl is exit 4", () => {
  const stopped = run("shiori", { answers: { FAKE_RUNNING_0: "false" } });
  assert.equal(stopped.status, 4, stopped.stderr);
  assert.equal(stopped.calls.length, 1, "only the state check ran");
  const noDocker = run("shiori", { mode: "noDocker" });
  assert.equal(noDocker.status, 4);
  assert.equal(noDocker.calls.length, 0);
  const noCurl = run("shiori", { mode: "noCurl" });
  assert.equal(noCurl.status, 4, noCurl.stderr);
  assert.match(noCurl.stderr, /curl is not available on this host/);
  assert.equal(noCurl.calls.length, 1, "the container was checked, and nothing was sent");
});

test("shiori: a password the protocol refuses never reaches docker or curl", () => {
  for (const password of ["", "\n", "short-pass\n"]) {
    const r = run("shiori", { password });
    assert.equal(r.status, 1, JSON.stringify(password));
    assert.equal(r.calls.length, 0, `${JSON.stringify(password)}: nothing was called`);
  }
});

test("shiori: an admin username that is not a plain account name is refused before anything runs", () => {
  for (const user of ['shiori"x', "shiori name", "", "shiori;rm -rf /"]) {
    const r = run("shiori", { answers: { CROW_FIRST_ADMIN_USER: user } });
    assert.equal(r.status, 1, JSON.stringify(user));
    assert.equal(r.calls.length, 0, `${JSON.stringify(user)}: nothing was called`);
  }
});

test("shiori: an unreadable detection changes nothing (exit 4)", () => {
  for (const answer of ["", "\n500", "garbage", '{"message":"Login success"}\n200']) {
    const r = run("shiori", { answers: { FAKE_SHIORI_DEFAULT_0: answer } });
    assert.equal(r.status, 4, `${JSON.stringify(answer)}: ${r.stderr}`);
    assert.match(r.stderr, /nothing was changed/);
    assert.equal(hostCallTo(r, "/api/v1/accounts/1").length, 0, `${JSON.stringify(answer)}: no change`);
    assert.equal(stdinText(r).includes(PASSWORD), false, `${JSON.stringify(answer)}: the password stayed home`);
  }
});

test("shiori: a login the app never accepts after the change is kept, not thrown away (exit 5)", () => {
  const r = run("shiori", { answers: { FAKE_SHIORI_NEWLOGIN: SHIORI_REFUSED } });
  assert.equal(r.status, 5, r.stderr);
  assert.match(r.stderr, /accepted the new password, but logging in with it did not succeed/);
  assert.equal(hostLogins(r, PASSWORD).length, 3, "the proof is retried three times");
  assert.equal(hostCallTo(r, "/api/v1/accounts/1").length, 1, "the change really happened first");
  assertPasswordStayedOutOfSight(r);
});

test("shiori: a PATCH that does not say 200 is settled by logins with the real password", () => {
  // The answer was not 200 but the app took the password: the first confirm login decides, and
  // the run ends at 0 — the honest outcome, not a claim that nothing changed.
  const written = run("shiori", { answers: { FAKE_SHIORI_PATCH_0: "500" } });
  assert.equal(written.status, 0, written.stderr);
  assert.equal(hostLogins(written, PASSWORD).length, 2, "the deciding login, then the proof");

  // Refused, and the new password does not work either: nothing is claimed, and the message
  // says the password may have changed rather than that the default is unchanged — nothing
  // checked the default after the PATCH.
  const refused = run("shiori", {
    answers: {
      FAKE_SHIORI_PATCH_0: "403",
      FAKE_SHIORI_NEWLOGIN_0: SHIORI_REFUSED,
      FAKE_SHIORI_NEWLOGIN_1: SHIORI_REFUSED,
      FAKE_SHIORI_NEWLOGIN_2: SHIORI_REFUSED,
    },
  });
  assert.equal(refused.status, 1, refused.stderr);
  assert.match(refused.stderr, /did not confirm the new password; the password may have changed; check the app's own login/);
  assert.doesNotMatch(refused.stderr, /default login is unchanged/, "nothing checked the default login");
  assert.equal(hostLogins(refused, PASSWORD).length, 3, "the confirm login is tried three times, and not once more");
  assert.equal(hostCallTo(refused, "/api/v1/accounts/1").length, 1, "the PATCH itself is attempted once");
});

test("shiori: the confirming login is retried up to three times before the run gives up", () => {
  const r = run("shiori", {
    answers: {
      FAKE_SHIORI_PATCH_0: "500",
      FAKE_SHIORI_NEWLOGIN_0: SHIORI_REFUSED,
      FAKE_SHIORI_NEWLOGIN_1: SHIORI_REFUSED,
    },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(hostLogins(r, PASSWORD).length, 4, "two refused confirms, the one that works, then the proof");
});

test("shiori: the PATCH goes to the account the signed-in session names (auth/me), not to id 1", () => {
  const r = run("shiori", { answers: { FAKE_SHIORI_ME_0: shioriMe(7) } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(hostCallTo(r, "/api/v1/auth/me").length, 1, "the account is asked for with the login's token");
  assert.equal(configValue(hostCallTo(r, "/api/v1/auth/me")[0].stdin, "header"), `Authorization: Bearer ${TOKEN}`);
  assert.equal(hostCallTo(r, "/api/v1/accounts/7").length, 1, "the account that answered is the one changed");
  assert.equal(hostCallTo(r, "/api/v1/accounts/1").length, 0, "id 1 is never assumed");
});

test("shiori: an auth/me answer naming another account, or none, changes nothing (exit 4)", () => {
  for (const answer of [shioriMe(1, "someone-else"), '{"ok":false,"message":"no"}\n401', '{"ok":true,"message":{"username":"shiori"}}\n200']) {
    const r = run("shiori", { answers: { FAKE_SHIORI_ME_0: answer } });
    assert.equal(r.status, 4, `${answer}: ${r.stderr}`);
    assert.match(r.stderr, /nothing was changed/);
    assert.equal(hostCalls(r).filter((c) => c.stdin.includes("/api/v1/accounts/")).length, 0, `${answer}: no PATCH`);
  }
});

// ── BookStack: the shipped default first, then its own admin CLI ──────────────────

test("bookstack: a fresh install gets the generated password, delivered on stdin only", () => {
  const r = run("bookstack");
  assert.equal(r.status, 0, r.stderr);
  assertPasswordStayedOutOfSight(r);
  assert.equal(r.calls[0].argv.startsWith("docker inspect"), true, "the container is checked before it is touched");
  assert.equal(r.calls[0].argv.includes("crow-bookstack"), true, "and the app's own container is the one named");

  const create = r.calls.find((c) => c.argv.includes("bookstack:create-admin"));
  assert.ok(create, "the password is set with BookStack's own admin command");
  assert.match(create.argv, / -u 1000 /, "it runs as the image's own user, or it cannot write its files");
  assert.match(create.argv, /--initial/);
  assert.match(create.argv, /--email=admin@localhost\.localdomain/);
  assert.match(create.argv, /--name=Admin/);
  assert.equal(create.argv.includes("--password"), false, "no password argument: the command prompts");
  assert.equal(create.stdin, `${PASSWORD}\n`, "the password is the one line on its stdin");

  // Detect runs BEFORE the CLI, or an operator's own password would be overwritten.
  const detect = r.calls.findIndex((c) => c.stdin.includes("email=admin@admin.com"));
  assert.ok(detect >= 0, "the shipped login is tried first");
  assert.equal(detect < r.calls.indexOf(create), true, "and before anything is written");

  const proof = r.calls.filter((c) => c.stdin.includes("email=admin@localhost.localdomain"));
  assert.equal(proof.length, 1, "the new login is proved once");
  assert.equal(configValue(proof[0].stdin, "request"), "POST", "as a form POST, the way the login page works");
});

test("bookstack: every login gets a fresh cookie jar, and no jar outlives it", () => {
  const r = run("bookstack");
  assert.equal(r.status, 0, r.stderr);

  // The fixed path an older version of this script kept a signed-in session in goes first.
  assert.equal(
    r.calls.some((c) => c.argv === "docker exec crow-bookstack rm -f /tmp/crow-fa-cookies.txt"),
    true,
    "the jar earlier versions left in the container is removed at the start",
  );

  // Every request of a login names the jar it reads and writes, and it is one the container
  // made for that login — never the old fixed path, never another login's jar.
  const logins = r.calls.filter((c) => c.stdin.includes("localhost:80/login") && configValue(c.stdin, "cookie"));
  assert.equal(logins.length >= 4, true, "a GET and a POST for the default login, and for the proof");
  for (const call of logins) {
    const jar = configValue(call.stdin, "cookie");
    assert.match(jar, /^\/tmp\/crow-fa-jar\.\d+$/, `a jar made inside the container, not the old fixed path: ${jar}`);
    assert.equal(configValue(call.stdin, "cookie-jar"), jar, "the same jar is read and written");
  }
  const pageJars = logins.filter((c) => configValue(c.stdin, "request") === undefined).map((c) => configValue(c.stdin, "cookie"));
  assert.equal(new Set(pageJars).size, pageJars.length, "no login reads a jar another login used");

  // One mktemp per login, and every one of those jars removed again: nothing for the next run
  // to inherit a session from.
  const made = r.calls.filter((c) => c.argv === "docker exec crow-bookstack mktemp").length;
  assert.equal(made, pageJars.length, "one jar per login, created in the container");
  const left = existsSync(join(r.container, "jars")) ? readdirSync(join(r.container, "jars")).filter((n) => n.startsWith("crow-fa-jar.")) : [];
  assert.deepEqual(left, [], "no cookie jar is left in the container");
});

test("bookstack: a re-run on the same container reads the form, not an inherited session (exit 3)", () => {
  const container = mkdtempSync(join(TMP, "container-"));
  const first = run("bookstack", { container });
  assert.equal(first.status, 0, first.stderr);

  // The same container, now with the operator's own admin: the shipped login no longer
  // works. A jar that still held the first run's session would answer the GET of the form
  // with a redirect, and the run would end at 4 instead of 3.
  const second = run("bookstack", { container, answers: { FAKE_BOOKSTACK_LOGIN_0: BOOKSTACK_REFUSED } });
  assert.equal(second.status, 3, second.stderr);
  assert.match(second.stderr, /already has its own admin/);
  assert.equal(ran(second, "bookstack:create-admin"), false, "nothing is written on that run");
});

test("bookstack: an install whose shipped login no longer works is left alone (exit 3)", () => {
  const r = run("bookstack", { answers: { FAKE_BOOKSTACK_LOGIN_0: BOOKSTACK_REFUSED } });
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /already has its own admin/);
  assert.equal(ran(r, "bookstack:create-admin"), false, "no account may be touched");
  assert.equal(stdinText(r).includes(PASSWORD), false, "and the new password never reaches the app");
});

test("bookstack: a container that is not running, or no docker at all, is exit 4", () => {
  const stopped = run("bookstack", { answers: { FAKE_RUNNING_0: "false" } });
  assert.equal(stopped.status, 4, stopped.stderr);
  assert.equal(stopped.calls.length, 1, "only the state check ran");
  const noDocker = run("bookstack", { mode: "noDocker" });
  assert.equal(noDocker.status, 4);
  assert.equal(noDocker.calls.length, 0);
});

test("bookstack: a password the protocol refuses never reaches docker", () => {
  for (const password of ["", "\n", "short-pass\n"]) {
    const r = run("bookstack", { password });
    assert.equal(r.status, 1, JSON.stringify(password));
    assert.equal(r.calls.length, 0, `${JSON.stringify(password)}: docker was not called`);
  }
});

test("bookstack: the admin account must be an email-shaped plain value, checked before anything runs", () => {
  for (const user of ['admin"@x.test', "admin name", "", "admin;rm -rf /", "admin"]) {
    const r = run("bookstack", { answers: { CROW_FIRST_ADMIN_USER: user } });
    assert.equal(r.status, 1, JSON.stringify(user));
    assert.equal(r.calls.length, 0, `${JSON.stringify(user)}: docker was not called`);
  }
});

test("bookstack: an unreadable login form changes nothing (exit 4)", () => {
  const answers = [
    { FAKE_BOOKSTACK_LOGIN_0: "200 " },
    { FAKE_BOOKSTACK_LOGIN_0: "302 " },
    { FAKE_BOOKSTACK_LOGIN_0: "500 http://localhost:6875/" },
    { FAKE_BOOKSTACK_LOGIN_0: "302 http://localhost:6875/home" },
    { FAKE_BOOKSTACK_PAGE_0: "<html>no form here</html>\n200" },
    { FAKE_BOOKSTACK_PAGE_0: "\n503" },
  ];
  for (const set of answers) {
    const r = run("bookstack", { answers: set });
    assert.equal(r.status, 4, `${JSON.stringify(set)}: ${r.stderr}`);
    assert.match(r.stderr, /could not be read; nothing was changed/);
    assert.equal(ran(r, "bookstack:create-admin"), false, `${JSON.stringify(set)}: no change`);
    assert.equal(stdinText(r).includes(PASSWORD), false, `${JSON.stringify(set)}: the password stayed home`);
  }
});

test("bookstack: a login the app never accepts after the change is kept (exit 5)", () => {
  const r = run("bookstack", { answers: { FAKE_BOOKSTACK_PROVE: BOOKSTACK_REFUSED } });
  assert.equal(r.status, 5, r.stderr);
  assert.match(r.stderr, /accepted the new password, but logging in with it did not succeed/);
  assert.equal(r.calls.filter((c) => c.stdin.includes("email=admin@localhost.localdomain")).length, 3, "three tries");
  assert.equal(ran(r, "bookstack:create-admin"), true, "the change really happened first");
  assertPasswordStayedOutOfSight(r);
});

test("bookstack: the admin command's exit 2 means the install already has an admin (exit 3)", () => {
  const r = run("bookstack", { answers: { FAKE_BOOKSTACK_CREATE_0: "2" } });
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /already has a non-default admin account/);
  assert.equal(r.calls.filter((c) => c.stdin.includes("email=admin@localhost.localdomain")).length, 0, "nothing to prove");
});

test("bookstack: a command that refuses the password is exit 1, nothing claimed", () => {
  const r = run("bookstack", { answers: { FAKE_BOOKSTACK_CREATE_0: "1" } });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /did not accept the new password; the default login is unchanged/);
  assert.equal(r.calls.filter((c) => c.stdin.includes("email=admin@localhost.localdomain")).length, 0, "no proof after a refusal");
  assertPasswordStayedOutOfSight(r);
});

// ── Calibre-Web: the hash in app.db, through the image's own python ────────────────

test("calibre-web: a fresh install gets the generated password, delivered on stdin only", () => {
  const r = run("calibre-web");
  assert.equal(r.status, 0, r.stderr);
  assertPasswordStayedOutOfSight(r);
  assert.equal(r.calls[0].argv.startsWith("docker inspect"), true, "the container is checked before it is touched");
  assert.equal(r.calls[0].argv.includes("crow-calibre-web"), true, "and the app's own container is the one named");

  const set = r.calls.find((c) => c.argv.includes("UPDATE user SET password"));
  assert.ok(set, "the password is written into the app's own user table");
  assert.match(set.argv, / -u 1000 /, "as the user that owns app.db");
  assert.equal(set.stdin, `admin\n${PASSWORD}\n`, "the account and the password arrive on stdin");

  const state = r.calls.findIndex(
    (c) => c.argv.includes("name = ?") && !c.argv.includes("UPDATE user SET password") && !c.argv.includes("LOGIN-OK"),
  );
  assert.ok(state >= 0, "the shipped password is checked first");
  assert.equal(state < r.calls.indexOf(set), true, "and before anything is written");
  assert.equal(r.calls.filter((c) => c.argv.includes("LOGIN-OK")).length, 1, "the new login is proved once");
});

test("calibre-web: an install whose shipped password no longer works is left alone (exit 3)", () => {
  const r = run("calibre-web", { answers: { FAKE_CALIBRE_STATE_0: "CHANGED" } });
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /already has its own admin password/);
  assert.equal(ran(r, "UPDATE user SET password"), false, "the table is never written");
  assert.equal(stdinText(r).includes(PASSWORD), false, "and the new password never reaches the app");
});

test("calibre-web: a container that is not running, or no docker at all, is exit 4", () => {
  const stopped = run("calibre-web", { answers: { FAKE_RUNNING_0: "false" } });
  assert.equal(stopped.status, 4, stopped.stderr);
  assert.equal(stopped.calls.length, 1, "only the state check ran");
  const noDocker = run("calibre-web", { mode: "noDocker" });
  assert.equal(noDocker.status, 4);
  assert.equal(noDocker.calls.length, 0);
});

test("calibre-web: a password the protocol refuses never reaches docker", () => {
  for (const password of ["", "\n", "short-pass\n"]) {
    const r = run("calibre-web", { password });
    assert.equal(r.status, 1, JSON.stringify(password));
    assert.equal(r.calls.length, 0, `${JSON.stringify(password)}: docker was not called`);
  }
});

test("calibre-web: an admin username that is not a plain account name is refused before anything runs", () => {
  for (const user of ['ad"min', "admin name", "", "admin;rm -rf /"]) {
    const r = run("calibre-web", { answers: { CROW_FIRST_ADMIN_USER: user } });
    assert.equal(r.status, 1, JSON.stringify(user));
    assert.equal(r.calls.length, 0, `${JSON.stringify(user)}: docker was not called`);
  }
});

test("calibre-web: an unreadable user table changes nothing (exit 4)", () => {
  for (const answer of ["", "UNKNOWN", "SOMETHING-ELSE", "<<fail>>"]) {
    const r = run("calibre-web", { answers: { FAKE_CALIBRE_STATE_0: answer } });
    assert.equal(r.status, 4, `${JSON.stringify(answer)}: ${r.stderr}`);
    assert.match(r.stderr, /could not be read; nothing was changed/);
    assert.equal(ran(r, "UPDATE user SET password"), false, `${JSON.stringify(answer)}: no write`);
    assert.equal(stdinText(r).includes(PASSWORD), false, `${JSON.stringify(answer)}: the password stayed home`);
  }
});

test("calibre-web: a proof that never reads LOGIN-OK is kept, not thrown away (exit 5)", () => {
  const r = run("calibre-web", { answers: { FAKE_CALIBRE_PROVE: "LOGIN-FAIL" } });
  assert.equal(r.status, 5, r.stderr);
  assert.match(r.stderr, /accepted the new password, but the database check that proves it did not succeed/);
  assert.match(r.stderr, /Crow kept the new password; use the login in Settings → Passwords/, "the message says where the login is");
  assert.equal(r.calls.filter((c) => c.argv.includes("LOGIN-OK")).length, 3, "three tries");
  assert.equal(ran(r, "UPDATE user SET password"), true, "the change really happened first");
  assertPasswordStayedOutOfSight(r);
});

test("calibre-web: a SET that finds the default already gone is exit 3, with nothing proved", () => {
  const r = run("calibre-web", { answers: { FAKE_CALIBRE_SET_0: "CHANGED" } });
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /already has its own admin password/);
  assert.equal(r.calls.filter((c) => c.argv.includes("LOGIN-OK")).length, 0, "no proof after a refusal");
});

test("calibre-web: every snippet runs under the host's own timeout 30", () => {
  const script = readFileSync(join(B("calibre-web"), "scripts", "first-admin.sh"), "utf8");
  const wrapped = script.split('timeout 30 docker exec -i -u 1000 "$CONTAINER" python3 -c').length - 1;
  assert.equal(script.includes('docker exec -i -u 1000 "$CONTAINER" python3 -c'), true);
  assert.equal(script.split('docker exec -i -u 1000 "$CONTAINER" python3 -c').length - 1, wrapped, "no snippet call without the bound");
  assert.equal(wrapped, 4, "the detection, the update, the check after an unclear update and the proof are each bounded");
});

test("calibre-web: an unclear UPDATE answer asks the database before deciding", () => {
  // Cut off after its COMMIT: the database holds the new password → carry on to 0.
  const kept = run("calibre-web", { answers: { FAKE_CALIBRE_SET_0: "UNKNOWN", FAKE_CALIBRE_PROVE_0: "LOGIN-OK" } });
  assert.equal(kept.status, 0, kept.stderr);
  // The database does not hold it → exit 1, worded honestly (nothing checked the default).
  const r = run("calibre-web", { answers: { FAKE_CALIBRE_SET_0: "UNKNOWN", FAKE_CALIBRE_PROVE_0: "LOGIN-FAIL" } });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /the password may have changed; check the app's own login/);
  assert.doesNotMatch(r.stderr, /default login is unchanged/);
  assert.equal(r.calls.filter((c) => c.argv.includes("LOGIN-OK")).length, 1, "exactly one check after the unclear answer");
});

// ── Stirling PDF: one sign-in attempt, and the lockout respected ──────────────────

test("stirling-pdf: a fresh install gets the generated password, delivered on stdin only", () => {
  const r = run("stirling-pdf");
  assert.equal(r.status, 0, r.stderr);
  assertPasswordStayedOutOfSight(r);
  assert.equal(r.calls[0].argv.startsWith("docker inspect"), true, "the container is checked before it is touched");
  assert.equal(r.calls[0].argv.includes("crow-stirling-pdf"), true, "and the app's own container is the one named");

  const set = hostCallTo(r, "/api/v1/user/change-password-on-login")[0];
  assert.ok(set, "the password is set through Stirling's own endpoint");
  assert.equal(configValue(set.stdin, "header"), `Authorization: Bearer ${TOKEN}`, "the token travels on the pipe");
  assert.deepEqual(
    configLines(set.stdin).filter((l) => l.key === "data-urlencode").map((l) => l.value),
    ["currentPassword=stirling", `newPassword=${PASSWORD}`, `confirmPassword=${PASSWORD}`],
    "all three form fields are on the pipe",
  );
  assert.equal(set.argv.includes(TOKEN), false, "the token is never an argument");
  assert.equal(hostLogins(r, PASSWORD).length, 1, "the new login is proved once");
});

test("stirling-pdf: the shipped login is tried exactly ONCE per run (a failure locks the account)", () => {
  const fresh = run("stirling-pdf");
  assert.equal(hostLogins(fresh, "stirling").length, 1, "one attempt on a fresh install");
  const changed = run("stirling-pdf", { answers: { FAKE_STIRLING_DEFAULT_0: STIRLING_REFUSED } });
  assert.equal(hostLogins(changed, "stirling").length, 1, "and one attempt when it no longer works");
});

test("stirling-pdf: an install whose shipped login no longer works is left alone (exit 3)", () => {
  const r = run("stirling-pdf", { answers: { FAKE_STIRLING_DEFAULT_0: STIRLING_REFUSED } });
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /already has its own admin password/);
  assert.equal(hostCallTo(r, "/api/v1/user/change-password-on-login").length, 0, "no password may be set");
  assert.equal(stdinText(r).includes(PASSWORD), false, "and the new password never reaches the app");
});

test("stirling-pdf: a locked account is left alone, and the reason says so (exit 3)", () => {
  const r = run("stirling-pdf", { answers: { FAKE_STIRLING_DEFAULT_0: '{"message":"Account is locked"}\n401' } });
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /locked/);
  assert.equal(hostCallTo(r, "/api/v1/user/change-password-on-login").length, 0, "nothing was touched");
});

test("stirling-pdf: 'locked' is matched as a word, not inside another one", () => {
  const script = readFileSync(join(B("stirling-pdf"), "scripts", "first-admin.sh"), "utf8");
  assert.match(script, /grep -qiE '\\blocked\\b'/, "the word only");

  // A 401 whose body carries "unlocked" says nothing about a lock: it is a refusal like any
  // other, so the reason must be the refusal, not the lockout.
  const refused = run("stirling-pdf", { answers: { FAKE_STIRLING_DEFAULT_0: '{"message":"the door is unlocked"}\n401' } });
  assert.equal(refused.status, 3, refused.stderr);
  assert.match(refused.stderr, /shipped login no longer works/);
  assert.doesNotMatch(refused.stderr, /account is locked/);

  // And in the proof loop an "unlocked" answer is not a locked one: the loop keeps its three
  // tries instead of stopping at the first.
  const proof = run("stirling-pdf", {
    answers: {
      FAKE_STIRLING_NEWLOGIN_0: '{"message":"session unlocked"}\n401',
      FAKE_STIRLING_NEWLOGIN_1: '{"message":"session unlocked"}\n401',
      FAKE_STIRLING_NEWLOGIN_2: '{"message":"session unlocked"}\n401',
    },
  });
  assert.equal(proof.status, 5, proof.stderr);
  assert.equal(hostLogins(proof, PASSWORD).length, 3, "three proof tries, none of them read as a lock");
});

test("stirling-pdf: a run that ends at 3 leaves a marker, and the next run signs in no more", () => {
  const cwd = mkdtempSync(join(TMP, "cwd-"));
  const first = run("stirling-pdf", { cwd, answers: { FAKE_STIRLING_DEFAULT_0: STIRLING_REFUSED } });
  assert.equal(first.status, 3, first.stderr);
  assert.match(first.stderr, /Each retry costs another sign-in attempt/);
  assert.equal(existsSync(join(cwd, ".crow-first-admin-kept")), true, "the marker is written where the script runs");

  // Nothing about the install changed: another sign-in attempt would only push the account
  // towards its lockout, so the run refuses without one.
  const second = run("stirling-pdf", { cwd });
  assert.equal(second.status, 3, second.stderr);
  assert.match(second.stderr, /no sign-in attempt was made this time/);
  assert.equal(second.calls.length, 0, "not even the container is asked");
  assert.equal(stdinText(second).includes(PASSWORD), false, "and the password never reaches anything");

  // A locked account writes the marker too: that is a run that spent its attempt.
  const lockedCwd = mkdtempSync(join(TMP, "cwd-"));
  const locked = run("stirling-pdf", { cwd: lockedCwd, answers: { FAKE_STIRLING_DEFAULT_0: '{"message":"Account is locked"}\n401' } });
  assert.equal(locked.status, 3, locked.stderr);
  assert.equal(existsSync(join(lockedCwd, ".crow-first-admin-kept")), true, "a locked run leaves it as well");
});

test("stirling-pdf: a container that is not running, no docker, or no host curl is exit 4", () => {
  const stopped = run("stirling-pdf", { answers: { FAKE_RUNNING_0: "false" } });
  assert.equal(stopped.status, 4, stopped.stderr);
  assert.equal(stopped.calls.length, 1, "only the state check ran");
  const noDocker = run("stirling-pdf", { mode: "noDocker" });
  assert.equal(noDocker.status, 4);
  assert.equal(noDocker.calls.length, 0);
  const noCurl = run("stirling-pdf", { mode: "noCurl" });
  assert.equal(noCurl.status, 4, noCurl.stderr);
  assert.equal(noCurl.calls.length, 1, "the container was checked, and nothing was sent");
});

test("stirling-pdf: a password the protocol refuses never reaches docker or curl", () => {
  for (const password of ["", "\n", "short-pass\n"]) {
    const r = run("stirling-pdf", { password });
    assert.equal(r.status, 1, JSON.stringify(password));
    assert.equal(r.calls.length, 0, `${JSON.stringify(password)}: nothing was called`);
  }
});

test("stirling-pdf: an admin username that is not a plain account name is refused before anything runs", () => {
  for (const user of ['ad"min', "admin name", "", "admin;rm -rf /"]) {
    const r = run("stirling-pdf", { answers: { CROW_FIRST_ADMIN_USER: user } });
    assert.equal(r.status, 1, JSON.stringify(user));
    assert.equal(r.calls.length, 0, `${JSON.stringify(user)}: nothing was called`);
  }
});

test("stirling-pdf: an unreadable detection changes nothing (exit 4)", () => {
  for (const answer of ["", "\n500", '{"session":{}}\n200', "garbage"]) {
    const r = run("stirling-pdf", { answers: { FAKE_STIRLING_DEFAULT_0: answer } });
    assert.equal(r.status, 4, `${JSON.stringify(answer)}: ${r.stderr}`);
    assert.match(r.stderr, /nothing was changed/);
    assert.equal(hostCallTo(r, "/api/v1/user/change-password-on-login").length, 0, `${JSON.stringify(answer)}: no change`);
    assert.equal(stdinText(r).includes(PASSWORD), false, `${JSON.stringify(answer)}: the password stayed home`);
    assert.equal(hostLogins(r, "stirling").length, 1, `${JSON.stringify(answer)}: still one attempt`);
  }
});

test("stirling-pdf: a login the app never accepts after the change is kept (exit 5)", () => {
  const r = run("stirling-pdf", { answers: { FAKE_STIRLING_NEWLOGIN: STIRLING_REFUSED } });
  assert.equal(r.status, 5, r.stderr);
  assert.match(r.stderr, /accepted the new password, but logging in with it did not succeed/);
  assert.equal(hostLogins(r, PASSWORD).length, 3, "three tries");
  assert.equal(hostCallTo(r, "/api/v1/user/change-password-on-login").length, 1, "the change really happened first");
  assertPasswordStayedOutOfSight(r);
});

test("stirling-pdf: a LOCKED answer stops the proof at once instead of deepening the lock", () => {
  const r = run("stirling-pdf", {
    answers: {
      FAKE_STIRLING_NEWLOGIN_0: '{"message":"Account is locked"}\n401',
      FAKE_STIRLING_NEWLOGIN_1: '{"message":"Account is locked"}\n401',
    },
  });
  assert.equal(r.status, 5, r.stderr);
  assert.match(r.stderr, /locked/);
  assert.equal(hostLogins(r, PASSWORD).length, 1, "one attempt, then the loop stops");
  assert.equal(hostLogins(r).length, 2, "the detection attempt and that one proof attempt, and nothing more");
});

test("stirling-pdf: a change the app did not confirm is exit 1 after at most two confirm tries", () => {
  const r = run("stirling-pdf", {
    answers: {
      FAKE_STIRLING_SET_0: "500",
      FAKE_STIRLING_NEWLOGIN_0: STIRLING_REFUSED,
      FAKE_STIRLING_NEWLOGIN_1: STIRLING_REFUSED,
      FAKE_STIRLING_NEWLOGIN_2: STIRLING_REFUSED,
    },
  });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /did not confirm the new password; the password may have changed; check the app's own login/);
  assert.doesNotMatch(r.stderr, /shipped login is unchanged/, "nothing checked the shipped login after the change");
  assert.equal(hostLogins(r, PASSWORD).length, 2, "two confirm tries, and not one more (each costs a sign-in)");
});

test("stirling-pdf: the confirming login may succeed on the second try", () => {
  const r = run("stirling-pdf", {
    answers: { FAKE_STIRLING_SET_0: "500", FAKE_STIRLING_NEWLOGIN_0: STIRLING_REFUSED },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(hostLogins(r, PASSWORD).length, 3, "one refused confirm, the one that works, then the proof");
});

// ── the snippets the stand-in docker never runs ────────────────────────────────────

// ── the snippets the stand-in docker never runs ────────────────────────────────────

test("calibre-web: the detection snippet is read-only and every snippet prints one status word", () => {
  const script = readFileSync(join(B("calibre-web"), "scripts", "first-admin.sh"), "utf8");
  const detect = snippet(script, "DETECT");
  assert.match(detect, /mode=ro/, "the check opens the database read-only");
  assert.doesNotMatch(detect, /UPDATE|INSERT|DELETE/, "and never writes anything");
  assert.match(detect, /check_password_hash\(stored, "admin123"\)/, "the shipped password is what is checked");

  const set = snippet(script, "SET");
  // One transaction: the lock, the re-read of the hash, the check that it is still the shipped
  // password, the write of exactly that row, and the commit — all of it or none of it.
  assert.match(set, /db\.execute\("BEGIN IMMEDIATE"\)/, "the transaction takes the write lock first");
  assert.match(set, /SELECT password FROM user WHERE id = 1 AND name = \?/, "the hash is read under that lock");
  assert.match(set, /check_password_hash\(stored, "admin123"\)/, "and it has to still be the shipped password");
  assert.match(
    set,
    /UPDATE user SET password = \? WHERE id = 1 AND name = \? AND password = \?/,
    "exactly the shipped row, and only while it still holds the hash that was read",
  );
  assert.match(set, /if cur\.rowcount == 1:\n\s+db\.execute\("COMMIT"\)\n\s+print\("UPDATED"\)/, "UPDATED only after one row changed and committed");
  assert.match(set, /else:\n\s+db\.execute\("ROLLBACK"\)\n\s+print\("UNKNOWN"\)/, "anything else rolls back and says UNKNOWN");
  assert.match(set, /if not stored or not check_password_hash[\s\S]*?print\("CHANGED"\)/, "a hash that is no longer the default says CHANGED");
  assert.match(set, /except Exception:\n\s+print\("UNKNOWN"\)/, "anything raised is UNKNOWN, never a traceback");

  const prove = snippet(script, "PROVE");
  assert.match(prove, /check_password_hash\(stored, password\)/, "the new password opens the stored hash");
  assert.match(prove, /not check_password_hash\(stored, "admin123"\)/, "and the shipped one no longer does");
  // The proof is the database's answer, not a web login: say so where a reader looks.
  assert.match(script, /PROVE reads the stored hash back: this is a DATABASE check, not a web login/);
  for (const [name, code] of [["DETECT", detect], ["SET", set], ["PROVE", prove]]) {
    assert.equal(code.includes(PASSWORD), false, `${name}: no password is baked into a snippet`);
    assert.equal(
      /print\("(DEFAULT|CHANGED|UNKNOWN|UPDATED|LOGIN-OK|LOGIN-FAIL|PROOF-UNKNOWN)"\)/.test(code),
      true,
      `${name}: prints a status word`,
    );
  }
});

test("every exit-5 message points at the login Crow kept", () => {
  for (const app of ["shiori", "bookstack", "calibre-web", "stirling-pdf"]) {
    const script = readFileSync(join(B(app), "scripts", "first-admin.sh"), "utf8");
    const exit5 = script.split("\n").filter((line) => /^\s*die ".*" 5$/.test(line));
    assert.equal(exit5.length > 0, true, `${app}: has an exit-5 path`);
    for (const line of exit5) {
      assert.match(
        line,
        /Crow kept the new password; use the login in Settings → Passwords/,
        `${app}: the password is already Crow's, so say where the login is: ${line.trim()}`,
      );
      assert.doesNotMatch(line, /set its admin password there/, `${app}: and not to type one in again: ${line.trim()}`);
    }
  }
});

// ── nothing may outlive the protocol timeout ──────────────────────────────────────

const budgetOf = (script, name) => {
  const line = script.split("\n").find((l) => l.startsWith(`${name}=$((SECONDS + `));
  assert.ok(line, `${name} is a $SECONDS budget`);
  return Number(/SECONDS \+ (\d+)\)/.exec(line)[1]);
};

const manifestOf = (id) => JSON.parse(readFileSync(join(B(id), "manifest.json"), "utf8"));

/**
 * Every per-request time bound the script carries, counted once per request site: the
 * `max-time` (or `--max-time`) each curl config or probe hands curl. A `timeout 30` in front
 * of a docker exec bounds that exec on this host, not one HTTP request, and is asserted
 * separately below.
 */
const requestBounds = (script) =>
  [
    ...script
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n")
      .matchAll(/max-time (?:= )?(\d+)/g),
  ].map((m) => Number(m[1]));

for (const app of ["shiori", "bookstack", "calibre-web", "stirling-pdf"]) {
  test(`${app}: the waits, the loops and every request bound fit the manifest timeout`, () => {
    const script = readFileSync(join(B(app), "scripts", "first-admin.sh"), "utf8");
    const timeout = manifestOf(app).firstAdmin.setup.timeout_s;
    const wait = budgetOf(script, "wait_deadline");
    const proof = budgetOf(script, "proof_deadline");
    assert.equal(wait < timeout, true, `${app}: the health wait (${wait}s) is inside the ${timeout}s the runner allows`);
    // The worst case: both $SECONDS budgets run out AND every request that ran can take its
    // own max-time. It has to fit what the runner allows, or the runner kills a run that is
    // still working and the operator is told nothing.
    const bounds = requestBounds(script);
    assert.equal(bounds.length > 0, true, `${app}: every request carries a max-time`);
    const worst = wait + proof + bounds.reduce((a, b) => a + b, 0);
    assert.equal(worst < timeout, true, `${app}: worst case ${wait} + ${proof} + ${bounds.join(" + ")} = ${worst}s inside ${timeout}s`);
  });
}

test("bookstack: the admin command is bounded by this host's own timeout", () => {
  const script = readFileSync(join(B("bookstack"), "scripts", "first-admin.sh"), "utf8");
  assert.match(
    script,
    /\| timeout 30 docker exec -i -u 1000 -w \/app\/www "\$CONTAINER" php artisan bookstack:create-admin --initial/,
    "a stuck admin command cannot outlive 30 s",
  );
});

for (const app of ["shiori", "stirling-pdf"]) {
  test(`${app}: every request from this host carries max-time in its config`, () => {
    const r = run(app);
    assert.equal(r.status, 0, r.stderr);
    const calls = hostCalls(r);
    assert.equal(calls.length >= 4, true, `${app}: the probe, the detection, the change and the proof all use a config`);
    for (const call of calls) {
      assert.match(call.stdin, /^max-time = \d+$/m, `${app}: ${call.argv} carries max-time`);
      assert.match(call.stdin, /^url = "http:\/\/127\.0\.0\.1:\d+\//m, `${app}: and names a loopback URL`);
    }
  });
}

// ── the declarations that put those scripts to work ────────────────────────────────

const CONVERTED = {
  // Shiori's own MCP server logs in with the username and password from the bundle's .env,
  // so both names are declared env_vars and the runner writes them there.
  shiori: { user: "shiori", secretEnv: "SHIORI_PASSWORD", userEnv: "SHIORI_USERNAME", timeout_s: 240 },
  // BookStack's tools use an API token the operator makes, so the admin password lives in
  // the keychain only; the account itself is an email address.
  bookstack: { user: "admin@localhost.localdomain", secretEnv: "BOOKSTACK_ADMIN_PASSWORD", userEnv: undefined, timeout_s: 240 },
  "calibre-web": { user: "admin", secretEnv: "CALIBRE_WEB_PASSWORD", userEnv: "CALIBRE_WEB_USERNAME", timeout_s: 120 },
  "stirling-pdf": { user: "admin", secretEnv: "STIRLING_ADMIN_PASSWORD", userEnv: undefined, timeout_s: 240 },
};

test("each converted manifest passes the bundle contract and declares the setup script", () => {
  const bundleExists = (id) => existsSync(join(REPO, "bundles", id, "manifest.json"));
  for (const [id, want] of Object.entries(CONVERTED)) {
    const manifest = manifestOf(id);
    const { errors } = validateManifest(manifest, B(id), { bundleExists });
    assert.deepEqual(errors, [], `${id}: the whole manifest`);
    assert.deepEqual(
      { mode: manifest.firstAdmin.mode, via: manifest.firstAdmin.via, script: manifest.firstAdmin.setup.script },
      { mode: "crow", via: "setup", script: "scripts/first-admin.sh" },
      id,
    );
    assert.equal(manifest.firstAdmin.user, want.user, `${id}: the account Crow gives the password to`);
    assert.equal(manifest.firstAdmin.secretEnv, want.secretEnv, `${id}: where the keychain keeps the password`);
    assert.equal(manifest.firstAdmin.userEnv, want.userEnv, `${id}: userEnv only where .env carries the username`);
    assert.equal(manifest.firstAdmin.setup.timeout_s, want.timeout_s, `${id}: enough time for a slow first start`);
    assert.equal(manifest.firstAdmin.note, undefined, `${id}: a crow-created login has no note to read`);
    assert.doesNotMatch(manifest.notes, /default (credentials|login)/i, `${id}: the notes no longer advertise a default login`);

    // The names the runner writes into the bundle's .env have to be DECLARED, or the app's
    // own MCP server never sees the login; a keychain-only entry is not written there.
    const declared = new Set((manifest.env_vars || []).map((v) => v.name));
    assert.equal(declared.has(want.secretEnv), want.userEnv !== undefined, `${id}: secretEnv is declared only when .env carries it`);
    if (want.userEnv) assert.equal(declared.has(want.userEnv), true, `${id}: userEnv is a declared env var`);

    const script = readFileSync(join(B(id), manifest.firstAdmin.setup.script), "utf8");
    assert.match(script, /^#!\/usr\/bin\/env bash/, `${id}: the script is bash`);
    assert.match(script, /set -euo pipefail/, `${id}: fail fast`);
    assert.match(script, /IFS= read -r PW/, `${id}: reads the password from stdin`);
    assert.equal(
      script.includes('[[ "$ADMIN_USER" =~ ^[A-Za-z0-9._@-]+$ ]]'),
      true,
      `${id}: the admin account is validated before any docker call`,
    );
    assert.equal(script.includes("CROW_FA_CONTAINER"), true, `${id}: the container name is overridable for tests`);
    assert.equal(script.includes("the password Crow generated"), true, `${id}: it says what the login now holds`);
    assert.equal(script.includes(PASSWORD), false, `${id}: no password is baked into the script`);
    assert.match(script, /\[ "\$\{#PW\}" -ge 12 \]/, `${id}: a password shorter than 12 characters is refused`);
  }
});

test("bookstack: the compose file passes the Laravel APP_KEY its image refuses to start without", () => {
  const compose = readFileSync(join(B("bookstack"), "docker-compose.yml"), "utf8");
  assert.match(compose, /APP_KEY=\$\{BOOKSTACK_APP_KEY:\?Set BOOKSTACK_APP_KEY\}/, "a hard failure, not a fallback value");
});

test("bookstack: the manifest generates APP_KEY at install and mints it for an existing install", () => {
  const manifest = manifestOf("bookstack");
  const spec = (manifest.env_vars || []).find((v) => v.name === "BOOKSTACK_APP_KEY");
  assert.ok(spec, "the key is declared, or Crow has nothing to put in the .env");
  assert.deepEqual(
    { secret: spec.secret, generate: spec.generate, required: spec.required, mint_if_missing: spec.mint_if_missing },
    { secret: true, generate: "laravel_key", required: false, mint_if_missing: true },
    "generated at install, hidden from the forms, never install-blocking, minted for an install that predates it",
  );
  assert.match(spec.description, /Laravel application key/);
  assert.equal(manifest.refreshFiles.includes("docker-compose.yml"), true, "the compose file that passes it is refreshed");
});

test("the committed registry carries the same declarations (it is generated from the manifests)", () => {
  const registry = JSON.parse(readFileSync(join(REPO, "registry", "add-ons.json"), "utf8"))["add-ons"];
  for (const id of Object.keys(CONVERTED)) {
    const entry = registry.find((e) => e.id === id);
    assert.ok(entry, `registry/add-ons.json has an entry for ${id}`);
    // Serialized, not just deep-equal: build-registry writes JSON.stringify(manifest + official),
    // so the key ORDER is part of what the drift check compares.
    assert.equal(
      JSON.stringify(entry),
      JSON.stringify({ ...manifestOf(id), official: true }),
      `${id}: the registry entry is what build-registry would write`,
    );
  }
});

test("the admin passwords Crow fills are not fields an install blocks on", () => {
  // The password is generated and saved by the setup script, so demanding one from the
  // operator would block the very install that creates it (the Frigate shape: optional).
  for (const [id, name] of [["shiori", "SHIORI_PASSWORD"], ["calibre-web", "CALIBRE_WEB_PASSWORD"]]) {
    const manifest = manifestOf(id);
    const spec = (manifest.env_vars || []).find((v) => v.name === name);
    assert.ok(spec, `${id}: ${name} is still declared, or the app's MCP server never sees the login`);
    assert.equal(spec.required, false, `${id}: ${name} must not be required`);
    assert.equal(spec.secret, true, `${id}: ${name} stays a secret`);
    assert.equal((manifest.requires.env || []).includes(name), false, `${id}: and it is not in requires.env`);
    assert.match(spec.description, /Crow generates it/, `${id}: the description says where it comes from`);
  }
});

test("bookstack: the .env.example says the APP_KEY must never be blank", () => {
  const example = readFileSync(join(B("bookstack"), ".env.example"), "utf8");
  assert.match(example, /Crow generates it; never leave it blank when starting by hand/, "the compose file fails on a blank one");
  assert.match(example, /BOOKSTACK_APP_KEY=/, "the name is there to fill in");
});

test("bookstack: the docs tell an install with a hand-set APP_KEY what to do before updating", () => {
  const docs = [
    { path: join(REPO, "docs", "integrations", "bookstack.md"), before: /before updating/ },
    { path: join(REPO, "docs", "es", "integrations", "bookstack.md"), before: /antes de actualizar/ },
  ];
  for (const { path, before } of docs) {
    const doc = readFileSync(path, "utf8");
    assert.match(doc, /BOOKSTACK_APP_KEY/, `${path}: names the setting`);
    assert.match(doc, /docker-compose\.yml/, `${path}: says where the hand-set key was`);
    assert.match(doc, before, `${path}: and that it has to be moved before an update`);
  }
});