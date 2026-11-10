/**
 * N3-4 (calibre-server) — the bundle runs Calibre's CONTENT server with a login, and Crow
 * creates its admin at install.
 *
 * The bundle used to run `linuxserver/calibre` in its default mode: the full Calibre desktop
 * app over a web VNC (ports 3000/3001). The content server on 8081 only existed if someone
 * turned it on by hand inside that desktop app, without a login — so a fresh install served
 * nothing, and an install that did turn it on served the library to anything on the machine.
 *
 * What these tests hold down:
 *
 *   1. a fresh install: exit 0, the generated password delivered on stdin and NEVER in an
 *      argument, never printed, the account created exactly once, and the new login proved
 *      with a real request from this host,
 *   2. the create's stdin carries the password with NO trailing newline — Calibre stores the
 *      newline as part of the password and then its own login fails,
 *   3. an install that already has accounts: exit 3, no create, and the password never
 *      reaches the app,
 *   4. an account list Calibre will not print: exit 4 — never "no accounts", because creating
 *      over an unreadable list would claim someone else's install,
 *   5. not running / no docker / no curl: exit 4, nothing changed,
 *   6. a password the protocol refuses (empty, short) or a username that is not a plain
 *      account name: exit 1, with docker not even asked,
 *   7. a create Calibre confirmed but a login it never accepts: exit 5 (Crow keeps the
 *      password), and at most TWO login attempts,
 *   8. a create that answers unclearly is settled by Calibre's own account list: the name now
 *      listed is proved with a real login (0), an install with other accounts is left alone
 *      (3), an unreadable re-read is tried again rather than treated as a verdict, and a create
 *      the docker client timed out on (exit 124) whose account never appears before the loop's
 *      25 s deadline is kept with exit 5 — `timeout` kills the client, not the add, so the
 *      account may yet exist; a clean refusal whose account never appears is exit 1,
 *   9. the compose: no 3000/3001, the content server only, `--enable-auth --auth-mode basic`
 *      with the user database, the library mounted at /library, the loopback publish, and a
 *      config-volume owner that runs on the SAME image after Docker's first copy-up,
 *   10. the manifest passes the bundle contract and carries the declaration the installer and
 *      the card need (including the address saved with the login and the refreshed compose),
 *   11. the docs and the skill say who creates the login and where it is kept, that the old
 *      desktop-mode users are NOT carried over, how to upgrade, and say nothing about a login
 *      ban — Calibre's `--ban-for` default is 0, so it never bans (en + es).
 *
 * No docker and no network here: a `docker` and a `curl` stand-in are written into a temp dir
 * that sits first on PATH, record every argv and the stdin they received, and replay canned
 * answers. An answer for the n-th call of one kind comes from `<dir>/answers/<KEY>.<n>`, which
 * is how "the first attempt answers this, the retry that" is played without a secret ever
 * touching the environment.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { validateManifest } from "../scripts/lib/bundle-contract.mjs";
import { skillHash } from "../servers/gateway/bundle-skill-sync.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const B = join(REPO, "bundles", "calibre-server");

/** A generated-password-shaped value: URL- and shell-safe, 22 characters. */
const PASSWORD = "gen-Secret_ABC123xy-z45";
const ADMIN = "admin";

const TMP = mkdtempSync(join(tmpdir(), "crow-calibre-fa-"));
const BIN = join(TMP, "bin");
const BIN_DOCKER_ONLY = join(TMP, "bin-docker-only");
const NO_TOOLS = join(TMP, "no-tools");
/** By absolute path: the "nothing on PATH" case runs the script with an empty PATH. */
const BASH = existsSync("/bin/bash") ? "/bin/bash" : "bash";
mkdirSync(BIN, { recursive: true });
mkdirSync(BIN_DOCKER_ONLY, { recursive: true });
mkdirSync(NO_TOOLS, { recursive: true });

/** `next KEY DEFAULT`: count the calls of that kind; `<dir>/answers/KEY.<n>` wins over DEFAULT. */
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
 * The stand-in docker: every call is recorded as `<dir>/call.<n>.argv` (the program and the
 * arguments it saw) plus `<dir>/call.<n>.stdin`. Only two shapes reach it — the container
 * state check, and Calibre's own binary inside the container.
 */
const FAKE_DOCKER = [
  "#!/usr/bin/env bash",
  "set -uo pipefail",
  'dir="$FAKE_DOCKER_DIR"',
  "n=0",
  'while [ -f "$dir/call.$n.argv" ]; do n=$((n + 1)); done',
  'printf "docker %s" "$*" > "$dir/call.$n.argv"',
  'if [[ " $* " == *" -i "* ]]; then cat > "$dir/call.$n.stdin"; else : > "$dir/call.$n.stdin"; fi',
  "",
  ...NEXT_FN,
  "",
  'case "${1:-}" in',
  '  inspect) next RUNNING "${FAKE_RUNNING:-true}"; printf "%s\\n" "$NEXT"; exit 0 ;;',
  "  exec) ;;",
  '  *) printf "fake docker: unsupported: %s\\n" "$*" >&2; exit 99 ;;',
  "esac",
  "",
  'args="$*"',
  'if [[ "$args" == *"--manage-users -- list"* ]]; then',
  '  next USERS "${FAKE_USERS:-}"',
  '  if [ "$NEXT" = "<<fail>>" ]; then exit 7; fi',
  '  printf "%s" "$NEXT"',
  "  exit 0",
  "fi",
  'if [[ "$args" == *"--manage-users -- add"* ]]; then',
  '  next ADD "${FAKE_ADD:-0}"',
  '  if [ "$NEXT" = "already" ]; then printf "already exists\\n" >&2; exit 1; fi',
  '  exit "$NEXT"',
  "fi",
  'printf "fake docker: no answer for: %s\\n" "$args" >&2',
  "exit 98",
  "",
].join("\n");

/**
 * The stand-in curl: the request (url, user, …) is a config on stdin, and the status code is
 * the only thing printed — exactly what the script asks for with `-o /dev/null -w`.
 */
const FAKE_CURL = [
  "#!/usr/bin/env bash",
  "set -uo pipefail",
  'dir="$FAKE_DOCKER_DIR"',
  "n=0",
  'while [ -f "$dir/curl.$n.argv" ]; do n=$((n + 1)); done',
  'printf "curl %s" "$*" > "$dir/curl.$n.argv"',
  'cat > "$dir/curl.$n.stdin"',
  'cfg="$dir/curl.$n.stdin"',
  'url="$(printf "%s\\n" "$(cat "$cfg")" | sed -n \'s/^url = "\\(.*\\)"$/\\1/p\' | head -n 1)"',
  "",
  ...NEXT_FN,
  "",
  'case "$url" in',
  '  http://127.0.0.1:8081/) next READY "${FAKE_READY:-200}" ;;',
  '  http://127.0.0.1:8081/ajax/library-info) next PROOF "${FAKE_PROOF:-200}" ;;',
  '  *) printf "fake curl: no answer for: %s\\n" "$url" >&2; exit 98 ;;',
  "esac",
  'if [ "$NEXT" = "<<fail>>" ]; then printf "000"; exit 22; fi',
  'printf "%s" "$NEXT"',
  "exit 0",
  "",
].join("\n");

writeFileSync(join(BIN, "docker"), FAKE_DOCKER, { mode: 0o755 });
writeFileSync(join(BIN, "curl"), FAKE_CURL, { mode: 0o755 });
// The docker-only PATH: the same stand-in and a shell to run it with, and nothing else — so
// `command -v curl` fails exactly as it would on a host without curl.
writeFileSync(join(BIN_DOCKER_ONLY, "docker"), FAKE_DOCKER, { mode: 0o755 });
symlinkSync(BASH.startsWith("/") ? BASH : "/bin/bash", join(BIN_DOCKER_ONLY, "bash"));

test("the stand-in docker and curl are valid bash", () => {
  for (const file of [join(BIN, "docker"), join(BIN, "curl")]) {
    const parsed = spawnSync(BASH, ["-n", file], { encoding: "utf8" });
    assert.equal(parsed.status, 0, `${file}: ${parsed.stderr}`);
  }
});

after(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
});

/** One recorded call: the program with its arguments, and whatever arrived on stdin. */
function readCalls(dir, prefix) {
  const out = [];
  for (let i = 0; existsSync(join(dir, `${prefix}.${i}.argv`)); i++) {
    out.push({
      argv: readFileSync(join(dir, `${prefix}.${i}.argv`), "utf8"),
      stdin: readFileSync(join(dir, `${prefix}.${i}.stdin`), "utf8"),
    });
  }
  return out;
}

/** Split the answers into the files the stand-ins read and the variables they read directly. */
function materialize(callsDir, answers) {
  const env = {};
  for (const [name, value] of Object.entries(answers)) {
    const m = /^FAKE_([A-Z0-9]+)_(\d+)$/.exec(name);
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

/** Everything a run answers with unless a test says otherwise (a fresh, healthy install). */
const DEFAULTS = {
  FAKE_RUNNING: "true",
  FAKE_USERS: "",
  FAKE_ADD: "0",
  FAKE_READY: "200",
  FAKE_PROOF: "200",
};

/**
 * Run the bundle's setup script with the password on stdin, as the installer does: the admin
 * username in `CROW_FIRST_ADMIN_USER`, and nothing else of Crow's environment.
 */
function run({ password = `${PASSWORD}\n`, answers = {}, mode = "full", user = ADMIN } = {}) {
  const dir = mkdtempSync(join(TMP, "calls-"));
  const path = mode === "noDocker" ? NO_TOOLS : mode === "noCurl" ? BIN_DOCKER_ONLY : `${BIN}:/usr/bin:/bin`;
  const res = spawnSync(BASH, [join(B, "scripts", "first-admin.sh")], {
    input: password,
    encoding: "utf8",
    timeout: 120_000,
    cwd: mkdtempSync(join(TMP, "cwd-")),
    env: {
      PATH: path,
      HOME: TMP,
      CROW_FIRST_ADMIN_USER: user,
      FAKE_DOCKER_DIR: dir,
      ...materialize(dir, { ...DEFAULTS, ...answers }),
    },
  });
  return {
    status: res.status,
    stdout: res.stdout || "",
    stderr: res.stderr || "",
    docker: readCalls(dir, "call"),
    curl: readCalls(dir, "curl"),
  };
}

const argvText = (r) => [...r.docker, ...r.curl].map((c) => c.argv).join("\n");
const stdinText = (r) => [...r.docker, ...r.curl].map((c) => c.stdin).join("\n");
const listCalls = (r) => r.docker.filter((c) => c.argv.includes("--manage-users -- list"));
const addCalls = (r) => r.docker.filter((c) => c.argv.includes("--manage-users -- add"));
const proofCalls = (r) => r.curl.filter((c) => configValue(c.stdin, "url") === "http://127.0.0.1:8081/ajax/library-info");

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
const configValue = (text, key) => configLines(text).filter((l) => l.key === key).map((l) => l.value)[0];

const manifestOf = (id) => JSON.parse(readFileSync(join(REPO, "bundles", id, "manifest.json"), "utf8"));

// ── a fresh install, and the exits the protocol asks for ─────────────────────────────

test("a fresh install gets the generated password on stdin only, with NO trailing newline", () => {
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assertPasswordStayedOutOfSight(r);
  assert.equal(r.docker[0].argv.startsWith("docker inspect"), true, "the container is checked before it is touched");
  assert.equal(r.docker[0].argv.includes("crow-calibre-server"), true, "and the bundle's own container is the one named");

  assert.equal(listCalls(r).length, 1, "Calibre's own account list is read once");
  assert.equal(listCalls(r)[0].argv.includes("/config/users.sqlite"), true, "from the user database the server runs with");

  const adds = addCalls(r);
  assert.equal(adds.length, 1, "the account is created exactly once");
  assert.equal(adds[0].argv.includes("-i"), true, "the password reaches it on a pipe");
  assert.equal(adds[0].argv.trimEnd().endsWith(`add ${ADMIN}`), true, "the declared username is created");
  assert.equal(adds[0].stdin, PASSWORD, "the password arrives with NO trailing newline (Calibre would store it)");

  const proofs = proofCalls(r);
  assert.equal(proofs.length, 1, "the new login is proved once");
  assert.equal(configValue(proofs[0].stdin, "user"), `${ADMIN}:${PASSWORD}`, "with that same password, in the config on stdin");
  assert.equal(proofs[0].argv.includes(" -L "), false, "a redirect is never followed as if it were a login");
});

test("an install that already has accounts is left alone (exit 3)", () => {
  const r = run({ answers: { FAKE_USERS: "admin\nsecond-user" } });
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /already has accounts/);
  assert.match(r.stderr, /nothing was changed/);
  assert.equal(addCalls(r).length, 0, "nothing may be created");
  assert.equal(proofCalls(r).length, 0, "and nothing has to be proved");
  assert.equal(stdinText(r).includes(PASSWORD), false, "the new password never even reaches the app");
});

test("an account list Calibre will not print is exit 4, never 'no accounts'", () => {
  const r = run({ answers: { FAKE_USERS: "<<fail>>" } });
  assert.equal(r.status, 4, r.stderr);
  assert.match(r.stderr, /account list could not be read/);
  assert.match(r.stderr, /nothing was changed/);
  assert.equal(addCalls(r).length, 0, "no account may be created over a list nobody could read");
});

test("a container that is not running, no docker at all, or no curl is exit 4", () => {
  const stopped = run({ answers: { FAKE_RUNNING: "false" } });
  assert.equal(stopped.status, 4, stopped.stderr);
  assert.equal(stopped.docker.length, 1, "only the state check ran");
  assert.match(stopped.stderr, /not running/);

  const noDocker = run({ mode: "noDocker" });
  assert.equal(noDocker.status, 4);
  assert.equal(noDocker.docker.length, 0, "docker was not even asked");

  const noCurl = run({ mode: "noCurl" });
  assert.equal(noCurl.status, 4, noCurl.stderr);
  assert.match(noCurl.stderr, /curl is not available/);
  assert.equal(addCalls(noCurl).length, 0, "nothing is created without the tool that proves it");
});

test("a password the protocol refuses never reaches docker", () => {
  for (const password of ["", "\n", "short-pass\n"]) {
    const r = run({ password });
    assert.equal(r.status, 1, JSON.stringify(password));
    assert.equal(r.docker.length + r.curl.length, 0, `${JSON.stringify(password)}: nothing was called`);
  }
});

test("a username that is not a plain account name is refused before anything runs", () => {
  for (const user of ['ad"min', "admin name", "", "admin;rm -rf /"]) {
    const r = run({ user });
    assert.equal(r.status, 1, JSON.stringify(user));
    assert.equal(r.docker.length + r.curl.length, 0, `${JSON.stringify(user)}: nothing was called`);
  }
});

test("a create Calibre confirmed but a login it never accepts is kept (exit 5)", () => {
  const r = run({ answers: { FAKE_PROOF: "401" } });
  assert.equal(r.status, 5, r.stderr);
  assert.match(r.stderr, /accepted the new password, but logging in with it did not succeed/);
  assert.match(r.stderr, /Crow kept the new password; use the login in Settings → Passwords/);
  assert.equal(addCalls(r).length, 1, "the account really was created first");
  assert.equal(proofCalls(r).length, 2, "the proof is tried twice and no more");
  assertPasswordStayedOutOfSight(r);
});

test("the proof makes at most TWO login attempts", () => {
  const script = readFileSync(join(B, "scripts", "first-admin.sh"), "utf8");
  assert.match(script, /\[ "\$attempt" -ge 2 \]/, "the proof loop's own cap is two");
  assert.match(script, /AT MOST TWO/, "and the script says so");
  // Calibre's `--ban-for` default is 0: it never bans, so the cap is about not repeating a
  // proof that already failed, not about an address allowance.
  assert.doesNotMatch(script, /ban/i, "the script does not claim a login ban that does not exist");
  // A name that is not listed is never a reason to log in: that path saves nothing.
  const notOurs = run({ answers: { FAKE_USERS_0: "", FAKE_ADD_0: "1", FAKE_USERS_1: "second-user" } });
  assert.equal(notOurs.status, 3, notOurs.stderr);
  assert.equal(proofCalls(notOurs).length, 0, "no login is attempted against an account that is not Crow's");
});

// ── an unclear create is settled by Calibre's own account list ───────────────────────

test("an unclear create whose name is now listed is proved with a real login (exit 0)", () => {
  const r = run({ answers: { FAKE_USERS_0: "", FAKE_ADD_0: "already", FAKE_USERS_1: ADMIN } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(addCalls(r).length, 1, "the create is attempted once");
  assert.equal(proofCalls(r).length, 1, "the password the app may hold is proved");
  assertPasswordStayedOutOfSight(r);
});

test("an unclear create re-detected with other accounts is exit 3, nothing saved", () => {
  const r = run({ answers: { FAKE_USERS_0: "", FAKE_ADD_0: "1", FAKE_USERS_1: "second-user" } });
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /none named 'admin'/);
  assert.match(r.stderr, /nothing of Crow's was saved/);
  assert.equal(proofCalls(r).length, 0, "Crow's password cannot open an account that is not its own");
});

test("an unclear create on an app that still has no accounts changes nothing (exit 1)", () => {
  const r = run({ answers: { FAKE_USERS_0: "", FAKE_ADD_0: "1" } });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /did not create the account, so nothing was changed/);
  assert.equal(proofCalls(r).length, 0, "no proof after a create that did not happen");
  assert.equal(/nothing of Crow's was saved/.test(r.stderr), false, "that is the exit-3 sentence");
  assert.ok(listCalls(r).length > 2, "the list is re-read until the loop's deadline before deciding");
});

test("a create the docker client timed out on is kept when the account shows up on a later read", () => {
  // `timeout 30` kills the CLIENT; the add can still finish inside the container. Calibre's
  // own list gaining the account is the proof — dropping the password here would leave an
  // account nobody on this machine knows the password to.
  const r = run({ answers: { FAKE_USERS_0: "", FAKE_ADD_0: "124", FAKE_USERS_1: "", FAKE_USERS_2: ADMIN } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(addCalls(r).length, 1, "the create is attempted exactly once");
  assert.equal(listCalls(r).length, 3, "the account was found on the third read");
  assert.equal(proofCalls(r).length, 1, "and the password the container took is proved with a real login");
  assert.equal(configValue(proofCalls(r)[0].stdin, "user"), `${ADMIN}:${PASSWORD}`);
  assertPasswordStayedOutOfSight(r);
});

test("an unreadable re-read after an unclear create is tried again, not treated as a verdict", () => {
  // Review round 3, finding 2: an UNREADABLE re-read says nothing about whether the account
  // exists. It must not end the run — the list becomes readable a moment later, the account is
  // there, and the password Crow holds is proved with a real login.
  const r = run({ answers: { FAKE_USERS: "<<fail>>", FAKE_USERS_0: "", FAKE_ADD_0: "1", FAKE_USERS_3: ADMIN } });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(listCalls(r).length >= 4, "the unreadable reads were tried again");
  assert.equal(proofCalls(r).length, 1, "and the password the app holds was proved");
  assertPasswordStayedOutOfSight(r);
});

test("a create the docker client timed out on, whose list never becomes readable, keeps the password (exit 5)", () => {
  // `timeout 30` killed the CLIENT: the add may still have gone through inside the container,
  // and Calibre never lets the script read its account list. Dropping the password here could
  // leave an account nobody on this machine knows the password to, so it is kept.
  const r = run({ answers: { FAKE_USERS: "<<fail>>", FAKE_USERS_0: "", FAKE_ADD_0: "124" } });
  assert.equal(r.status, 5, r.stderr);
  assert.match(r.stderr, /may have gone through, so Crow kept the new password/);
  assert.match(r.stderr, /use the login in Settings → Passwords/);
  assert.equal(addCalls(r).length, 1, "the create was attempted exactly once");
  assert.equal(proofCalls(r).length, 0, "no login can be proved from a list nobody could read");
  assert.ok(listCalls(r).length > 2, "and the reads were retried until the deadline");
  assertPasswordStayedOutOfSight(r);
});

test("a clean refusal whose account never appears before the deadline is still exit 1", () => {
  // Calibre answered (not 124): nothing changed, so nothing is kept.
  const r = run({ answers: { FAKE_USERS: "<<fail>>", FAKE_USERS_0: "", FAKE_ADD_0: "1" } });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /did not create the account, so nothing was changed/);
  assert.equal(proofCalls(r).length, 0);
  assertPasswordStayedOutOfSight(r);
});

test("an unclear create whose login is refused is exit 3 (the account is not Crow's)", () => {
  const r = run({ answers: { FAKE_USERS_0: "", FAKE_ADD_0: "already", FAKE_USERS_1: ADMIN, FAKE_PROOF: "401" } });
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /not Crow's/);
  assert.equal(proofCalls(r).length, 2, "the login is tried before the password is dropped");
  assertPasswordStayedOutOfSight(r);
});

// ── the compose: the content server only, with a login ──────────────────────────────

const composeText = () => readFileSync(join(B, "docker-compose.yml"), "utf8");

test("the compose runs the CONTENT server, not the desktop app over a web VNC", () => {
  const compose = composeText();
  assert.equal(/\b300[01]\b/.test(compose), false, "the desktop app's ports (3000/3001) are gone");
  assert.equal(compose.includes("/config/Calibre Library"), false, "and so is the desktop app's library location");
  assert.equal(/PUID|PGID/.test(compose), false, "the content server runs as 1000:1000 instead");
  assert.match(compose, /user: "1000:1000"/);
  assert.match(compose, /- \$\{CALIBRE_LIBRARY_PATH:\?Set CALIBRE_LIBRARY_PATH\}:\/library/, "the library is mounted where the server reads it");
  assert.match(compose, /- HOME=\/config/, "Calibre keeps its own state (the user database included) in /config");
  assert.match(compose, /- "127\.0\.0\.1:8081:8081"/, "the only publish is the content server, on the loopback");
  assert.match(compose, /entrypoint: \["sh", "-c"\]/);
});

test("the content server runs with a fixed command that creates an empty library and requires a login", () => {
  const compose = composeText();
  assert.match(compose, /\[ -f \/library\/metadata\.db \] \|\| \/opt\/calibre\/calibredb --library-path \/library list >\/dev\/null/, "calibre-server refuses a folder with no metadata.db");
  assert.match(compose, /exec \/opt\/calibre\/calibre-server --enable-auth --auth-mode basic --userdb \/config\/users\.sqlite --listen-on 0\.0\.0\.0 --port 8081 \/library/);
  assert.match(compose, /test: \["CMD", "curl", "-fsS", "-o", "\/dev\/null", "http:\/\/127\.0\.0\.1:8081\/"\]/, "`/` answers without a login; the data behind it does not");
});

test("the config volume's owner is fixed by a one-shot on the SAME image, after Docker's copy-up", () => {
  const compose = composeText();
  const start = compose.indexOf("\n  calibre-server-config-owner:");
  const end = compose.indexOf("\n  calibre-server:");
  assert.equal(start >= 0 && end > start, true, "both services are there, the owner first");
  const owner = compose.slice(start, end);
  assert.match(owner, /image: linuxserver\/calibre:9\.17\.0/, "a different image would copy up at the MAIN mount and reset the owner");
  assert.match(owner, /user: "0:0"/, "only root may chown the volume Docker filled");
  assert.match(owner, /entrypoint: \["chown", "-R", "1000:1000", "\/config"\]/);
  assert.match(owner, /network_mode: none/);
  assert.match(owner, /restart: "no"/, "one short run, never restarted");
  assert.match(owner, /- calibre-server-config:\/config/, "the volume it fixes is the one the server mounts");
  assert.match(compose, /depends_on:\n\s+calibre-server-config-owner:\n\s+condition: service_completed_successfully/, "the server waits for the owner to finish");
  assert.match(compose, /^volumes:\n  calibre-server-config:$/m);
});

// ── the declaration that puts the script to work ────────────────────────────────────

test("the manifest passes the bundle contract and declares the setup script Crow runs", () => {
  const manifest = manifestOf("calibre-server");
  const { errors } = validateManifest(manifest, B, { bundleExists: () => true });
  assert.deepEqual(errors, [], "the whole manifest");
  assert.equal(manifest.version, "1.0.6", "a bundle change is a version bump (the installed copy refreshes on it)");
  assert.deepEqual(manifest.refreshFiles, ["docker-compose.yml"], "an installed copy receives the fixed compose");
  assert.deepEqual(manifest.firstAdmin, {
    mode: "crow",
    via: "setup",
    setup: { script: "scripts/first-admin.sh", timeout_s: 180 },
    user: "admin",
    secretEnv: "CALIBRE_PASSWORD",
    userEnv: "CALIBRE_USERNAME",
    urlEnv: "CALIBRE_URL",
  });
  assert.equal(manifest.webUI.port, 8081, "the web UI stays where the compose publishes it");
  assert.equal(manifest.env_vars.some((v) => v.name === "CALIBRE_URL" && v.default === "http://localhost:8081"), true, "the MCP server still reaches the content server through CALIBRE_URL");
});

test("the login Crow creates is not a field an install blocks on", () => {
  const manifest = manifestOf("calibre-server");
  const password = manifest.env_vars.find((v) => v.name === "CALIBRE_PASSWORD");
  assert.ok(password, "CALIBRE_PASSWORD is declared, or the bundle's own MCP server never sees the login");
  assert.equal(password.required, false, "the password is generated by Crow: demanding one would block the install that creates it");
  assert.equal(password.secret, true, "and it stays a secret");
  assert.equal((manifest.requires.env || []).includes("CALIBRE_PASSWORD"), false, "out of requires.env");
  assert.match(password.description, /Crow generates it/);

  const username = manifest.env_vars.find((v) => v.name === "CALIBRE_USERNAME");
  assert.ok(username);
  assert.equal(username.required, false, "also not a blocking field");
  assert.equal(username.default, "admin", "it defaults to the account Crow creates");
  assert.match(username.description, /Crow creates `admin`/);
  assert.equal((manifest.requires.env || []).includes("CALIBRE_USERNAME"), false, "out of requires.env");
});

test("the committed registry carries the same declaration (it is generated from the manifest)", () => {
  const registry = JSON.parse(readFileSync(join(REPO, "registry", "add-ons.json"), "utf8"))["add-ons"];
  const entry = registry.find((e) => e.id === "calibre-server");
  assert.ok(entry, "registry/add-ons.json has an entry for calibre-server");
  // Serialized, not just deep-equal: build-registry writes JSON.stringify(manifest + official),
  // so the key ORDER is part of what the drift check compares.
  assert.equal(JSON.stringify(entry), JSON.stringify({ ...manifestOf("calibre-server"), official: true }));
});

test("the script names its container for the tests, validates before any call, and says where the login lives", () => {
  const script = readFileSync(join(B, "scripts", "first-admin.sh"), "utf8");
  assert.match(script, /^#!\/usr\/bin\/env bash/);
  assert.match(script, /set -euo pipefail/);
  assert.match(script, /IFS= read -r PW/, "the password is read from stdin");
  assert.equal(script.includes("CROW_FA_CONTAINER"), true, "the container name is overridable for tests");
  assert.equal(script.includes(`[[ "$ADMIN_USER" =~ ^[A-Za-z0-9._-]+$ ]]`), true, "the username is validated before any docker call");
  assert.match(script, /\[ "\$\{#PW\}" -ge 12 \]/, "a password shorter than 12 characters is refused");
  assert.equal(script.includes(PASSWORD), false, "no password is baked into the script");
  const exit5 = script.split("\n").filter((line) => /^\s*die ".*" 5$/.test(line));
  assert.equal(exit5.length, 2, "two exit-5 paths: an accepted create whose login fails, and a create the client timed out on");
  for (const line of exit5) assert.match(line, /Crow kept the new password; use the login in Settings → Passwords/);
});

// ── the notes the operator reads ────────────────────────────────────────────────────

test("the docs and the skill say the desktop app is gone and who creates the login, in both languages", () => {
  for (const path of [
    join(REPO, "docs", "integrations", "calibre-server.md"),
    join(REPO, "docs", "es", "integrations", "calibre-server.md"),
  ]) {
    const doc = readFileSync(path, "utf8");
    assert.match(doc, /Settings → Passwords|Ajustes → Contraseñas/, `${path}: says where the password is kept`);
    assert.match(doc, /content server|servidor de contenido/i, `${path}: names the content server`);
    assert.match(doc, /desktop app|aplicación de escritorio/, `${path}: says the desktop app over the browser is gone`);
    assert.match(doc, /Crow creates the `admin` account|Crow crea la cuenta `admin`/, `${path}: says Crow creates it`);
    // The old desktop-mode accounts lived in the desktop app's own user file, not in the
    // content server's users.sqlite: they are NOT carried over, and promising they are is
    // what round 2 (finding 3) is about.
    assert.match(doc, /not carried over|no se conservan/, `${path}: says the old users are not carried over`);
    assert.doesNotMatch(doc, /keeps them|los conserva/, `${path}: no false promise about an existing install's users`);
    assert.match(doc, /users\.sqlite/, `${path}: names the file the content server's users live in`);
    // Calibre's `--ban-for` default is 0, so there is no login ban to warn about (review round
    // 3, finding 4): a doc that claims one is wrong, and a reader who waits a minute for it is
    // waiting for nothing.
    assert.doesNotMatch(doc, /five failed logins|cinco inicios de sesión fallidos|blocks an address|bloquea una dirección/, `${path}: claims a login ban Calibre does not have`);
    // The upgrade path: the button that creates the login once the update is applied.
    assert.match(doc, /Upgrading from the desktop version|Actualizar desde la versión de escritorio/, `${path}: has the upgrade section`);
    assert.match(doc, /Set it up for me/, `${path}: names the button that creates the login`);
  }
  const skill = readFileSync(join(B, "skills", "calibre-server.md"), "utf8");
  assert.match(skill, /Settings → Passwords/, "the skill names where Crow keeps the login");
  assert.match(skill, /desktop app/, "and says which mode is gone");
  assert.doesNotMatch(skill, /keeps them/, "no false promise about an existing install's users");
  assert.match(skill, /not carried over/, "it says the old desktop-mode users do not come over");
  assert.match(skill, /users\.sqlite/, "and where the content server's own users live");
  assert.doesNotMatch(skill, /five failed logins|blocks an address/, "no login ban: Calibre's --ban-for default is 0");
  assert.match(skill, /Upgrading from the desktop version/, "and covers the upgrade");
  assert.match(skill, /Set it up for me/, "naming the button that creates the login");
});

test("the edited skill is in the ledger (an edited skill needs its new hash recorded)", () => {
  const ledger = JSON.parse(readFileSync(join(REPO, "bundles", "skill-history.json"), "utf8"));
  const hash = skillHash(readFileSync(join(B, "skills", "calibre-server.md")));
  assert.equal(
    (ledger["calibre-server/skills/calibre-server.md"] || []).includes(hash),
    true,
    `bundles/skill-history.json is missing ${hash} — run: node scripts/build-skill-history.mjs`,
  );
});