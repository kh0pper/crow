/**
 * N3-4 phase 2g — Crow creates the first admin of Jellyfin, Navidrome, Audiobookshelf
 * and Kavita.
 *
 * All four ship a first-run page that the FIRST caller claims: the setup wizard or the
 * "create the first admin" form answers on 127.0.0.1, so an install left alone is
 * claimable by anything else on the machine. Each bundle now ships `scripts/first-admin.sh`
 * and declares `firstAdmin: { mode: "crow", via: "setup", ... }`, so the installer runs it
 * once after `compose up` with the generated password as ONE line on stdin, and only while
 * the app itself reports that its setup is NOT done.
 *
 * What these tests hold down:
 *
 *   1. a fresh install: exit 0, the generated password delivered on stdin and NEVER in an
 *      argument (that is what a process list would show) and never printed, the account
 *      created and the new login proved,
 *   2. an app that already has its admin: exit 3, no create call, and the password never
 *      even reaches the app,
 *   3. docker missing / the container not running: exit 4, nothing changed,
 *   4. a password the protocol refuses (empty, short) or an admin username that is not a
 *      plain account name: exit 1, and docker is not even asked,
 *   5. a detection step that answers with nothing usable: exit 4, never a change,
 *   6. a create the app confirmed but a login it never accepts: exit 5, after three proof
 *      tries, and the message says Crow kept the new password instead of sending the
 *      operator to set one by hand,
 *   7. a create step that answers unclearly is settled by the app's own state, never by the
 *      status code alone: an app that now has its admin is proved with a real login (0), and
 *      one whose login Crow's password does not open is not Crow's at all (3); an app that
 *      still has none changed nothing (1),
 *   8. Jellyfin's wizard steps run in order and the user step (which names the admin and its
 *      password) comes BEFORE the wizard is completed — and after the GET that creates
 *      Jellyfin's default user, without which a fresh install answers 404,
 *   9. Navidrome's first-run flag is matched in both of the spellings its page can carry
 *      (`firstTime":true` and the JSON-escaped `firstTime\":true`),
 *   10. Audiobookshelf is reached through node inside its container (that image has no
 *      command-line HTTP client), its compose healthcheck no longer probes with the tool
 *      the image does not ship, and the manifest refreshes that compose file,
 *   11. Kavita registers the account and then proves it with its own login call, and only an
 *      exact `"Admin"` role counts — a username containing the word does not,
 *   12. nothing may outlive the protocol timeout: every curl config carries max-time, the
 *      node request carries its own timeout, and every $SECONDS budget plus every request
 *      bound fits inside the manifest's timeout_s,
 *   13. Jellyfin's 503 while it is loading is "not ready", not "unreadable", and a readable
 *      wizard state is only acted on when it arrives twice in a row,
 *   14. a POST never follows a redirect (`-L` belongs to the reads, where Navidrome's `/app/`
 *      answers one),
 *   15. the four manifests carry what the contract, the runner and the card need (including
 *      admin passwords that an install must not block on), and the generated registry
 *      carries the same declarations.
 *
 * No docker and no network here: a `docker` executable written into a temp dir sits first on
 * PATH, records every argv and the stdin it received, and replays canned answers. An answer
 * is handed to the stand-in as a FILE (`<calls>/answers/<KEY>.<i>`), one per call of that
 * kind, which is how a test says "the first attempt answers this, the retry that" without
 * ever putting a secret in the environment. Inside a run the stand-in answers for the
 * container the script names: the three curl-based apps by the URL in the config on stdin,
 * Audiobookshelf by the path in the node snippet's argv.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { validateManifest } from "../scripts/lib/bundle-contract.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const B = (id) => join(REPO, "bundles", id);

/** A generated-password-shaped value: URL- and shell-safe, 22 characters. */
const PASSWORD = "gen-Secret_ABC123xy-z45";

const TMP = mkdtempSync(join(tmpdir(), "crow-fa-scripts-5-"));
const BIN = join(TMP, "bin");
const NO_TOOLS = join(TMP, "no-tools");
/** By absolute path: the "nothing on PATH" case runs the script with an empty PATH. */
const BASH = existsSync("/bin/bash") ? "/bin/bash" : "bash";
mkdirSync(BIN, { recursive: true });
mkdirSync(NO_TOOLS, { recursive: true });

// ── the canned answers each app's own API answers with ─────────────────────────────

const JELLYFIN_FRESH = '{"StartupWizardCompleted":false,"ProductName":"Jellyfin Server"}\n200';
const JELLYFIN_DONE = '{"StartupWizardCompleted":true,"ProductName":"Jellyfin Server"}\n200';
const JELLYFIN_LOGIN_OK = '{"AccessToken":"tok-1","User":{"Name":"admin"}}\n200';
const JELLYFIN_LOGIN_FAIL = '\n401';

/** Navidrome's page, with the flag in the two spellings it can arrive in. */
const NAVIDROME_PAGE = (flag) => `<html><script>window.__INITIAL_STATE__={"firstTime\\":${flag}}</script></html>\n200`;
const NAVIDROME_CREATED = '{"id":"user-1","username":"admin","isAdmin":true}\n200';
const NAVIDROME_REFUSED = '{"error":"Cannot create another first admin"}\n403';
const NAVIDROME_LOGIN_OK = '{"id":"user-1","username":"admin","isAdmin":true,"token":"tok"}\n200';
const NAVIDROME_LOGIN_FAIL = '\n401';

const KAVITA_REGISTERED = '[{"username":"admin","token":"tok","roles":["Admin","Login"]}]\n200';
const KAVITA_REFUSED = '{"message":"Not allowed"}\n400';
const KAVITA_LOGIN_OK = '{"username":"admin","token":"tok","roles":["Admin"]}\n200';
const KAVITA_LOGIN_FAIL = '\n401';

/** Everything a run answers with unless a test says otherwise. */
const DEFAULTS = {
  FAKE_JELLYFIN_STATE: JELLYFIN_FRESH,
  FAKE_JELLYFIN_CONFIG: "204",
  FAKE_JELLYFIN_USER_GET: '{"Name":"root"}\n200',
  FAKE_JELLYFIN_USER: "204",
  FAKE_JELLYFIN_ACCESS: "204",
  FAKE_JELLYFIN_COMPLETE: "204",
  FAKE_JELLYFIN_LOGIN: JELLYFIN_LOGIN_OK,
  FAKE_NAVIDROME_STATE: NAVIDROME_PAGE("true"),
  FAKE_NAVIDROME_CREATE: NAVIDROME_CREATED,
  FAKE_NAVIDROME_LOGIN: NAVIDROME_LOGIN_OK,
  FAKE_KAVITA_STATE: "false\n200",
  FAKE_KAVITA_CREATE: KAVITA_REGISTERED,
  FAKE_KAVITA_LOGIN: KAVITA_LOGIN_OK,
  FAKE_ABS_STATE: "INIT",
  FAKE_ABS_INIT: "CREATED",
  FAKE_ABS_LOGIN: "LOGIN-OK",
};

/**
 * The answers, spelled out for the stand-in: `next KEY DEFAULT` counts the calls of that KEY
 * and uses `<dir>/answers/KEY.<n>` when the test wrote one, `DEFAULT` otherwise. An answer
 * file that exists but is empty is an empty answer — which is how "the app answered with
 * nothing" is played.
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
 * arguments it saw) plus `<dir>/call.<n>.stdin`, and answered from the files above.
 *
 * `docker exec` is dispatched on the container the script names, because each app is reached
 * with a different tool and a different API: Jellyfin, Navidrome and Kavita are asked through
 * the curl their images ship (the request is a config on stdin, so the URL lives there), and
 * Audiobookshelf through the node it ships (so the path is one of its arguments).
 */
const FAKE_DOCKER = [
  "#!/usr/bin/env bash",
  "set -uo pipefail",
  'dir="$FAKE_DOCKER_DIR"',
  "n=0",
  'while [ -f "$dir/call.$n.argv" ]; do n=$((n + 1)); done',
  'argvf="$dir/call.$n.argv"',
  'stdinf="$dir/call.$n.stdin"',
  'printf "docker %s" "$*" > "$argvf"',
  'if [[ " $* " == *" -i "* ]]; then cat > "$stdinf"; else : > "$stdinf"; fi',
  "",
  ...NEXT_FN,
  "emit() {",
  '  if [ "$NEXT" = "<<fail>>" ]; then exit 7; fi',
  '  printf "%s" "$NEXT"',
  "  exit 0",
  "}",
  "emit_word() {",
  '  if [ "$NEXT" = "<<fail>>" ]; then exit 1; fi',
  '  printf "%s\\n" "$NEXT"',
  "  exit 0",
  "}",
  "",
  'case "${1:-}" in',
  '  inspect) next RUNNING true; printf "%s\\n" "$NEXT"; exit 0 ;;',
  "  exec) ;;",
  '  *) printf "fake docker: unsupported: %s\\n" "$*" >&2; exit 99 ;;',
  "esac",
  "",
  'container="${3:-}"',
  "",
  // Audiobookshelf: the node snippet prints ONE status word; the path it is asked for is one
  // of its arguments, and the username and password arrive on stdin (never in the argv).
  'if [ "$container" = "crow-audiobookshelf" ]; then',
  '  target=""',
  '  for a in "$@"; do',
  '    case "$a" in /status|/init|/login) target="$a" ;; esac',
  "  done",
  '  case "$target" in',
  '    /status) next ABS_STATE "$FAKE_ABS_STATE"; emit_word ;;',
  '    /init) next ABS_INIT "$FAKE_ABS_INIT"; emit_word ;;',
  '    /login) next ABS_LOGIN "$FAKE_ABS_LOGIN"; emit_word ;;',
  '    *) printf "fake docker: no answer for: %s\\n" "$*" >&2; exit 98 ;;',
  "  esac",
  "fi",
  "",
  // The three curl-based apps: the URL is the config line the script wrote on stdin.
  'url="$(sed -n \'s/^url = "\\(.*\\)"$/\\1/p\' "$stdinf" | head -n 1)"',
  'case "$url" in',
  '  *:8096/System/Info/Public*) next JELLYFIN_STATE "$FAKE_JELLYFIN_STATE"; emit ;;',
  '  *:8096/Startup/Configuration*) next JELLYFIN_CONFIG "$FAKE_JELLYFIN_CONFIG"; emit ;;',
  '  *:8096/Startup/User*)',
  '    method=GET',
  '    case "$(cat "$stdinf")" in *request*) method=POST ;; esac',
  '    if [ "$method" = "GET" ]; then',
  '      : > "$dir/user-created"',
  '      next JELLYFIN_USER_GET "$FAKE_JELLYFIN_USER_GET"; emit',
  "    fi",
  // On a fresh 12.4 install the default user only exists once that read has happened: a POST
  // that arrives first answers 404. The stand-in models exactly that.
  '    if [ ! -f "$dir/user-created" ]; then printf "\\n404"; exit 0; fi',
  '    next JELLYFIN_USER "$FAKE_JELLYFIN_USER"; emit ;;',
  '  *:8096/Startup/RemoteAccess*) next JELLYFIN_ACCESS "$FAKE_JELLYFIN_ACCESS"; emit ;;',
  '  *:8096/Startup/Complete*) next JELLYFIN_COMPLETE "$FAKE_JELLYFIN_COMPLETE"; emit ;;',
  '  *:8096/Users/AuthenticateByName*) next JELLYFIN_LOGIN "$FAKE_JELLYFIN_LOGIN"; emit ;;',
  '  *:4533/app/*) next NAVIDROME_STATE "$FAKE_NAVIDROME_STATE"; emit ;;',
  '  *:4533/auth/createAdmin*) next NAVIDROME_CREATE "$FAKE_NAVIDROME_CREATE"; emit ;;',
  '  *:4533/auth/login*) next NAVIDROME_LOGIN "$FAKE_NAVIDROME_LOGIN"; emit ;;',
  '  *:5000/api/Admin/exists*) next KAVITA_STATE "$FAKE_KAVITA_STATE"; emit ;;',
  '  *:5000/api/Account/register*) next KAVITA_CREATE "$FAKE_KAVITA_CREATE"; emit ;;',
  '  *:5000/api/Account/login*) next KAVITA_LOGIN "$FAKE_KAVITA_LOGIN"; emit ;;',
  '  *) printf "fake docker: no answer for: %s\\n" "$url" >&2; exit 98 ;;',
  "esac",
  "",
].join("\n");
writeFileSync(join(BIN, "docker"), FAKE_DOCKER, { mode: 0o755 });

test("the stand-in docker is valid bash", () => {
  const parsed = spawnSync(BASH, ["-n", join(BIN, "docker")], { encoding: "utf8" });
  assert.equal(parsed.status, 0, parsed.stderr);
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

/**
 * Run a bundle's setup script with the password on stdin, as the installer does: the admin
 * username in CROW_FIRST_ADMIN_USER and nothing else of Crow's environment.
 */
function run(bundle, { password = `${PASSWORD}\n`, answers = {}, mode = "full", user = "admin" } = {}) {
  const callsDir = mkdtempSync(join(TMP, "calls-"));
  const cwd = mkdtempSync(join(TMP, "cwd-"));
  const res = spawnSync(BASH, [join(B(bundle), "scripts", "first-admin.sh")], {
    input: password,
    encoding: "utf8",
    timeout: 120_000,
    cwd,
    env: {
      PATH: mode === "noDocker" ? NO_TOOLS : `${BIN}:/usr/bin:/bin`,
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

/** The calls that are a request to one API path — inside the container either way. */
const isNodeCall = (c) => c.argv.includes("node -e");
/** Audiobookshelf's snippet carries its own path strings, so only its last argument is the request. */
const requestedPath = (c) => (isNodeCall(c) ? c.argv.trim().split(/\s+/).pop() : null);
const toPath = (r, path) => r.calls.filter((c) => (isNodeCall(c) ? requestedPath(c) === path : c.stdin.includes(path)));
const indexOfPath = (r, path) => r.calls.findIndex((c) => (isNodeCall(c) ? requestedPath(c) === path : c.stdin.includes(path)));
/** The method a recorded request used: the curl config's `request`, or the node snippet's argv. */
const methodOf = (call) =>
  isNodeCall(call) ? (call.argv.includes(" POST ") ? "POST" : "GET") : (configValue(call.stdin, "request") || "GET");
/** The calls that are a request to one API path with one method. */
const toPathAs = (r, path, method) => toPath(r, path).filter((c) => methodOf(c) === method);

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
const configValues = (text, key) => configLines(text).filter((l) => l.key === key).map((l) => l.value);
const configValue = (text, key) => configValues(text, key)[0];

// ── the four converted apps, and how each one is asked ─────────────────────────────

const APPS = {
  jellyfin: {
    container: "crow-jellyfin",
    fresh: JELLYFIN_FRESH,
    done: JELLYFIN_DONE,
    stateKey: "FAKE_JELLYFIN_STATE",
    unreadable: ['garbage\n200', '{"StartupWizardCompleted":"maybe"}\n200', '\n500'],
    createPath: "/Startup/User",
    createKey: "FAKE_JELLYFIN_USER",
    createUnclear: "500",
    loginPath: "/Users/AuthenticateByName",
    loginKey: "FAKE_JELLYFIN_LOGIN",
    loginFail: JELLYFIN_LOGIN_FAIL,
    /** The password as it arrives at the app, read out of the recorded request. */
    createPasswordIn: (call) => JSON.parse(configValue(call.stdin, "data")).Password,
    loginPasswordIn: (call) => JSON.parse(configValue(call.stdin, "data")).Pw,
    /**
     * How many reads of the setup state come before the re-check after an unclear create: the
     * wait wants two agreeing reads, so the re-check is the third.
     */
    recheck: 2,
    freshMessage: /did not finish its setup wizard, so nothing was changed/,
    unknownMessage: /did not report whether its setup wizard finished/,
  },
  navidrome: {
    container: "crow-navidrome",
    fresh: NAVIDROME_PAGE("true"),
    done: NAVIDROME_PAGE("false"),
    stateKey: "FAKE_NAVIDROME_STATE",
    unreadable: ["<html>no flag here</html>\n200", "\n503", "<html>firstTime: yes</html>\n200"],
    createPath: "/auth/createAdmin",
    createKey: "FAKE_NAVIDROME_CREATE",
    createUnclear: NAVIDROME_REFUSED,
    loginPath: "/auth/login",
    loginKey: "FAKE_NAVIDROME_LOGIN",
    loginFail: NAVIDROME_LOGIN_FAIL,
    createPasswordIn: (call) => JSON.parse(configValue(call.stdin, "data")).password,
    loginPasswordIn: (call) => JSON.parse(configValue(call.stdin, "data")).password,
    recheck: 1,
    freshMessage: /did not create the admin account, so nothing was changed/,
    unknownMessage: /did not report whether it created the admin account/,
  },
  kavita: {
    container: "crow-kavita",
    fresh: "false\n200",
    done: "true\n200",
    stateKey: "FAKE_KAVITA_STATE",
    unreadable: ["maybe\n200", "\n500", "null\n200"],
    createPath: "/api/Account/register",
    createKey: "FAKE_KAVITA_CREATE",
    createUnclear: KAVITA_REFUSED,
    loginPath: "/api/Account/login",
    loginKey: "FAKE_KAVITA_LOGIN",
    loginFail: KAVITA_LOGIN_FAIL,
    createPasswordIn: (call) => JSON.parse(configValue(call.stdin, "data")).password,
    loginPasswordIn: (call) => JSON.parse(configValue(call.stdin, "data")).password,
    recheck: 1,
    freshMessage: /did not create the admin account, so nothing was changed/,
    unknownMessage: /did not report whether it created the admin account/,
  },
  audiobookshelf: {
    container: "crow-audiobookshelf",
    fresh: "INIT",
    done: "READY",
    stateKey: "FAKE_ABS_STATE",
    unreadable: ["UNKNOWN", "READY-ISH", "garbage"],
    createPath: "/init",
    createKey: "FAKE_ABS_INIT",
    createUnclear: "REFUSED",
    loginPath: "/login",
    loginKey: "FAKE_ABS_LOGIN",
    loginFail: "LOGIN-FAIL",
    /** Audiobookshelf's snippet reads the username and the password as its first two stdin lines. */
    createPasswordIn: (call) => call.stdin.split("\n")[1],
    loginPasswordIn: (call) => call.stdin.split("\n")[1],
    recheck: 1,
    freshMessage: /did not create the root user, so nothing was changed/,
    unknownMessage: /did not report whether it created the root user/,
  },
};

// ── one fresh install per app ──────────────────────────────────────────────────────

for (const [app, a] of Object.entries(APPS)) {
  test(`${app}: a fresh install gets the generated password, delivered on stdin only`, () => {
    const r = run(app);
    assert.equal(r.status, 0, r.stderr);
    assertPasswordStayedOutOfSight(r);
    assert.equal(r.calls[0].argv.startsWith("docker inspect"), true, "the container is checked before it is touched");
    assert.equal(r.calls[0].argv.includes(a.container), true, "and the app's own container is the one named");

    const creates = toPathAs(r, a.createPath, "POST");
    assert.equal(creates.length, 1, "the account is created exactly once");
    assert.equal(a.createPasswordIn(creates[0]), PASSWORD, "with the generated password, on the pipe");

    const logins = toPath(r, a.loginPath);
    assert.equal(logins.length, 1, "and the new login is proved once");
    assert.equal(a.loginPasswordIn(logins[0]), PASSWORD, "with that same password, on the pipe");
  });

  test(`${app}: an install that already has its admin is left alone (exit 3)`, () => {
    const r = run(app, { answers: { [a.stateKey]: `${a.done}` } });
    assert.equal(r.status, 3, r.stderr);
    assert.match(r.stderr, /already (has|finished|set up)/i);
    assert.equal(toPathAs(r, a.createPath, "POST").length, 0, "no account may be touched");
    assert.equal(toPath(r, a.loginPath).length, 0, "and nothing has to be proved");
  });

  test(`${app}: a container that is not running, or no docker at all, is exit 4`, () => {
    const stopped = run(app, { answers: { FAKE_RUNNING_0: "false" } });
    assert.equal(stopped.status, 4, stopped.stderr);
    assert.equal(stopped.calls.length, 1, "only the state check ran");
    const noDocker = run(app, { mode: "noDocker" });
    assert.equal(noDocker.status, 4);
    assert.equal(noDocker.calls.length, 0, "docker was not even asked");
  });

  test(`${app}: a password the protocol refuses never reaches docker`, () => {
    for (const password of ["", "\n", "short-pass\n"]) {
      const r = run(app, { password });
      assert.equal(r.status, 1, JSON.stringify(password));
      assert.equal(r.calls.length, 0, `${JSON.stringify(password)}: nothing was called`);
    }
  });

  test(`${app}: an admin username that is not a plain account name is refused before anything runs`, () => {
    for (const user of ['ad"min', "admin name", "", "admin;rm -rf /"]) {
      const r = run(app, { user });
      assert.equal(r.status, 1, JSON.stringify(user));
      assert.equal(r.calls.length, 0, `${JSON.stringify(user)}: nothing was called`);
    }
  });

  test(`${app}: an unreadable detection changes nothing (exit 4)`, () => {
    for (const answer of a.unreadable) {
      const r = run(app, { answers: { [a.stateKey]: answer } });
      assert.equal(r.status, 4, `${JSON.stringify(answer)}: ${r.stderr}`);
      assert.match(r.stderr, /nothing was changed/);
      assert.equal(toPathAs(r, a.createPath, "POST").length, 0, `${JSON.stringify(answer)}: no create call`);
      assert.equal(argvText(r).includes(PASSWORD), false, `${JSON.stringify(answer)}: the password stayed home`);
    }
  });

  test(`${app}: a login the app never accepts after the change is kept, not thrown away (exit 5)`, () => {
    const r = run(app, { answers: { [a.loginKey]: a.loginFail } });
    assert.equal(r.status, 5, r.stderr);
    assert.match(r.stderr, /accepted the new password, but logging in with it did not succeed/);
    assert.match(r.stderr, /Crow kept the new password; use the login in Settings → Passwords/);
    assert.equal(toPath(r, a.loginPath).length, 3, "the proof is retried three times");
    assert.equal(toPathAs(r, a.createPath, "POST").length, 1, "the change really happened first");
    assertPasswordStayedOutOfSight(r);
  });

  test(`${app}: an unclear create that re-detects as DONE is proved with Crow's password`, () => {
    const r = run(app, {
      answers: { [a.createKey]: a.createUnclear, [`${a.stateKey}_${a.recheck}`]: a.done },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(toPathAs(r, a.createPath, "POST").length, 1, "the create is attempted once");
    assert.equal(toPath(r, a.loginPath).length, 1, "the password the app may hold is proved");
    assertPasswordStayedOutOfSight(r);
  });

  test(`${app}: an unclear create re-detected as DONE whose login fails is exit 3, nothing saved`, () => {
    const r = run(app, {
      answers: {
        [a.createKey]: a.createUnclear,
        [`${a.stateKey}_${a.recheck}`]: a.done,
        [a.loginKey]: a.loginFail,
      },
    });
    assert.equal(r.status, 3, r.stderr);
    assert.match(r.stderr, /already/i, "the app already has an admin");
    assert.match(r.stderr, /not Crow's/);
    assert.match(r.stderr, /left alone, and nothing of Crow's was saved/);
    assert.equal(toPath(r, a.loginPath).length, 3, "the login is tried before the password is dropped");
    assert.equal(argvText(r).includes(PASSWORD), false, "nothing of Crow's is saved, so nothing leaks either");
    assertPasswordStayedOutOfSight(r);
  });

  test(`${app}: an unclear create on an app that still has no admin changes nothing (exit 1)`, () => {
    const r = run(app, {
      answers: { [a.createKey]: a.createUnclear, [`${a.stateKey}_${a.recheck}`]: a.fresh },
    });
    assert.equal(r.status, 1, `${r.stderr}`);
    assert.match(r.stderr, a.freshMessage);
    assert.equal(toPath(r, a.loginPath).length, 0, "no proof after a create that did not happen");
    assert.equal(/nothing of Crow's was saved/.test(r.stderr), false, "that is the exit-3 sentence, and here the app has no admin at all");
  });

  test(`${app}: an unreadable re-check after an unclear create changes nothing (exit 1)`, () => {
    const r = run(app, {
      answers: { [a.createKey]: a.createUnclear, [`${a.stateKey}_${a.recheck}`]: a.unreadable[0] },
    });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, a.unknownMessage);
    assert.equal(toPath(r, a.loginPath).length, 0, "no proof without a state");
  });
}

// ── Jellyfin: the wizard's steps, in order, with the user step before Complete ─────

test("jellyfin: the wizard's steps run in order, and the user step comes before Complete", () => {
  const r = run("jellyfin");
  assert.equal(r.status, 0, r.stderr);

  const config = indexOfPath(r, "/Startup/Configuration");
  const user = indexOfPath(r, "/Startup/User");
  const access = indexOfPath(r, "/Startup/RemoteAccess");
  const complete = indexOfPath(r, "/Startup/Complete");
  const login = indexOfPath(r, "/Users/AuthenticateByName");
  assert.equal(config > 0, true, "the wizard's first step ran");
  assert.equal(config < user, true, "then the user step");
  assert.equal(user < access, true, "then remote access");
  assert.equal(access < complete, true, "then the wizard is completed");
  assert.equal(complete < login, true, "and only then the login is proved");

  assert.equal(toPathAs(r, "/Startup/User", "GET").length, 1, "the default user is READ once, which is what creates it");
  assert.equal(toPathAs(r, "/Startup/User", "POST").length, 1, "and the user step is posted once");
  const userCall = toPathAs(r, "/Startup/User", "POST")[0];
  assert.deepEqual(JSON.parse(configValue(userCall.stdin, "data")), { Name: "admin", Password: PASSWORD });
  assert.equal(configValue(userCall.stdin, "request"), "POST", "the method is in the config, not an argument");
  assert.equal(configValue(toPath(r, "/Startup/Configuration")[0].stdin, "request"), "POST");

  const loginCall = toPath(r, "/Users/AuthenticateByName")[0];
  assert.equal(
    configValues(loginCall.stdin, "header").includes(
      'Authorization: MediaBrowser Client="crow", Device="installer", DeviceId="crow-install", Version="1"',
    ),
    true,
    "Jellyfin's own client header is sent with the login, quotes intact after the config is read",
  );
  assert.deepEqual(JSON.parse(configValue(loginCall.stdin, "data")), { Username: "admin", Pw: PASSWORD });
});

test("jellyfin: a completed wizard is exit 3 even when the account looks like it is still missing", () => {
  const r = run("jellyfin", { answers: { FAKE_JELLYFIN_STATE: JELLYFIN_DONE } });
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /already finished/);
  assert.equal(toPath(r, "/Startup/Configuration").length, 0, "no wizard step may run");
});

test("jellyfin: the default user is read before the user step is posted", () => {
  // On a fresh 12.4 install the POST answers 404 until that read has created the default
  // user — the stand-in models exactly that, so the order is part of the fix.
  const r = run("jellyfin");
  assert.equal(r.status, 0, r.stderr);
  const reads = toPathAs(r, "/Startup/User", "GET");
  const posts = toPathAs(r, "/Startup/User", "POST");
  assert.equal(reads.length, 1, "one plain read of the user endpoint");
  assert.equal(posts.length, 1, "and one POST that names the admin");
  assert.equal(r.calls.indexOf(reads[0]) < r.calls.indexOf(posts[0]), true, "the read goes first");
  assert.equal(configValues(reads[0].stdin, "data").length, 0, "the read carries no body");
  assert.equal(posts[0].stdin.includes("Password"), true, "and the POST is the one with the account in it");
});

test("jellyfin: a user step the app refused is settled by the wizard's own state", () => {
  // The wizard is finished by the time the re-check happens: the password the app took is
  // proved with a real login, rather than reported as a failed change.
  const kept = run("jellyfin", { answers: { FAKE_JELLYFIN_USER_0: "500", FAKE_JELLYFIN_STATE_2: JELLYFIN_DONE } });
  assert.equal(kept.status, 0, kept.stderr);
  assert.equal(toPath(kept, "/Users/AuthenticateByName").length, 1, "the login is proved");

  // The wizard never finished: nothing was changed.
  const stopped = run("jellyfin", { answers: { FAKE_JELLYFIN_USER_0: "500" } });
  assert.equal(stopped.status, 1, stopped.stderr);
  assert.match(stopped.stderr, /did not finish its setup wizard, so nothing was changed/);
  assert.equal(toPath(stopped, "/Startup/RemoteAccess").length, 0, "and the wizard was not carried further");
});

test("jellyfin: a wizard state read once is not acted on — it has to answer twice", () => {
  // A 200 that arrives while Jellyfin is still coming up is not the wizard's last word.
  const r = run("jellyfin", { answers: { FAKE_JELLYFIN_STATE_0: JELLYFIN_DONE } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(toPath(r, "/Startup/Configuration").length, 1, "one finished-looking read is not a finished wizard");
});

test("jellyfin: 503 while it is loading is 'not ready', not 'unreadable'", () => {
  const loading = '{"message":"Jellyfin Server is loading"}\n503';
  const r = run("jellyfin", { answers: { FAKE_JELLYFIN_STATE_0: loading, FAKE_JELLYFIN_STATE_1: loading } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(/could not be read/.test(r.stderr), false, "a loading server is never reported as unreadable");
  assert.equal(toPath(r, "/Startup/Configuration").length, 1, "the wizard is finished once the app answers");
});

test("jellyfin: a 503 between two 200s restarts the wait, and the 200s still settle it", () => {
  const loading = '{"message":"Jellyfin Server is loading"}\n503';
  const r = run("jellyfin", { answers: { FAKE_JELLYFIN_STATE_1: loading } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(toPath(r, "/Startup/Configuration").length, 1, "the wizard is finished after the loading pass");
});

test("jellyfin: the start-up server's lowercase answer is 'still loading', never a reading", () => {
  // The real 12.4 sequence on a fresh container: nothing, a start-up 200 with the lowercase
  // key, 503s, then the real server's answers.
  const early = '{"localAddress":"http://127.0.0.1:8096","startupWizardCompleted":false}\n200';
  const loading = '{"message":"Jellyfin Server is loading"}\n503';
  const r = run("jellyfin", { answers: { FAKE_JELLYFIN_STATE_0: early, FAKE_JELLYFIN_STATE_1: loading, FAKE_JELLYFIN_STATE_2: early } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(/could not be read/.test(r.stderr), false);
  assert.equal(toPath(r, "/Startup/Configuration").length, 1);
  // A finished install whose start-up server says lowercase false is never re-run: only the
  // real server's DONE counts.
  const done = '{"StartupWizardCompleted":true}\n200';
  const d = run("jellyfin", { answers: { FAKE_JELLYFIN_STATE_0: early, FAKE_JELLYFIN_STATE_1: done, FAKE_JELLYFIN_STATE_2: done } });
  assert.equal(d.status, 3, d.stderr);
  assert.equal(toPath(d, "/Startup/Configuration").length, 0);
});

test("jellyfin: a Complete that failed is retried once before the wizard's state is asked", () => {
  const r = run("jellyfin", { answers: { FAKE_JELLYFIN_COMPLETE_0: "500" } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(toPath(r, "/Startup/Complete").length, 2, "the idempotent step is attempted twice");
  assert.equal(toPathAs(r, "/Startup/User", "POST").length, 1, "the account is written once, not twice");
  assert.equal(toPath(r, "/System/Info/Public").length, 2, "no re-check was needed after the retry");
  assert.equal(toPath(r, "/Users/AuthenticateByName").length, 1, "and the login is proved");
});

test("jellyfin: a wizard that never completes after Crow set the admin says so honestly", () => {
  const r = run("jellyfin", {
    answers: { FAKE_JELLYFIN_COMPLETE_0: "500", FAKE_JELLYFIN_COMPLETE_1: "500" },
  });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /Crow set the admin, but Jellyfin's setup wizard is still open; press Set it up for me again\./);
  assert.equal(/nothing was changed/.test(r.stderr), false, "the account WAS written, so it must not claim nothing changed");
  assert.equal(toPath(r, "/Startup/Complete").length, 2, "Complete is retried once, not forever");
  assert.equal(toPath(r, "/Users/AuthenticateByName").length, 0, "no login is proved while the wizard is open");
});

test("jellyfin: a first step the app refuses is exit 1 with nothing set", () => {
  const r = run("jellyfin", { answers: { FAKE_JELLYFIN_CONFIG_0: "400" } });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /first step, so nothing was changed/);
  assert.equal(toPath(r, "/Startup/User").length, 0, "the account is never touched");
});

// ── Navidrome: both spellings of its first-run flag ───────────────────────────────

test("navidrome: the unescaped firstTime flag is read as a fresh install", () => {
  const r = run("navidrome", { answers: { FAKE_NAVIDROME_STATE: '</script>{"firstTime":true}<script>\n200' } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(toPath(r, "/auth/createAdmin").length, 1, "the account is created");
});

test("navidrome: the JSON-escaped firstTime flag is a fresh install, and its false form is exit 3", () => {
  const fresh = run("navidrome", { answers: { FAKE_NAVIDROME_STATE: NAVIDROME_PAGE("true") } });
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.equal(toPath(fresh, "/auth/createAdmin").length, 1, "the escaped form is still a fresh install");

  const done = run("navidrome", { answers: { FAKE_NAVIDROME_STATE: NAVIDROME_PAGE("false") } });
  assert.equal(done.status, 3, done.stderr);
  assert.equal(toPath(done, "/auth/createAdmin").length, 0, "an install with an admin is left alone");

  const doneUnescaped = run("navidrome", { answers: { FAKE_NAVIDROME_STATE: '{"firstTime":false}\n200' } });
  assert.equal(doneUnescaped.status, 3, doneUnescaped.stderr);
});

test("navidrome: a create the app refuses is settled by its own state, and its 403 is not read as 'set up'", () => {
  // The app says it cannot make another first admin and its page now says the admin exists:
  // the password Crow may hold is proved with a real login instead of being thrown away.
  const proved = run("navidrome", {
    answers: { FAKE_NAVIDROME_CREATE: NAVIDROME_REFUSED, FAKE_NAVIDROME_STATE_1: NAVIDROME_PAGE("false") },
  });
  assert.equal(proved.status, 0, proved.stderr);
  assert.equal(toPath(proved, "/auth/login").length, 1, "the login is the proof");

  // The same page with a login that does not work: that first admin is someone else's.
  const foreign = run("navidrome", {
    answers: {
      FAKE_NAVIDROME_CREATE: NAVIDROME_REFUSED,
      FAKE_NAVIDROME_STATE_1: NAVIDROME_PAGE("false"),
      FAKE_NAVIDROME_LOGIN: NAVIDROME_LOGIN_FAIL,
    },
  });
  assert.equal(foreign.status, 3, foreign.stderr);
  assert.match(foreign.stderr, /already has a first admin that is not Crow's/);

  // The same 403 while the page still says no admin exists: nothing was created.
  const nothing = run("navidrome", {
    answers: { FAKE_NAVIDROME_CREATE: NAVIDROME_REFUSED, FAKE_NAVIDROME_STATE_1: NAVIDROME_PAGE("true") },
  });
  assert.equal(nothing.status, 1, nothing.stderr);
  assert.match(nothing.stderr, /did not create the admin account/);
});

test("navidrome: a page carrying both flags, or the flag twice, is unreadable (the read fails closed)", () => {
  // Both values on one page means the page no longer says which is true: acting on either
  // would be a guess, so nothing is touched.
  for (const answer of [
    '{"firstTime":true,"firstTime":false}\n200',
    '{"firstTime\\":true,"firstTime\\":false}\n200',
    '{"firstTime":true,"firstTime\\":false}\n200',
  ]) {
    const r = run("navidrome", { answers: { FAKE_NAVIDROME_STATE: answer } });
    assert.equal(r.status, 4, `${answer}: ${r.stderr}`);
    assert.match(r.stderr, /could not be read/);
    assert.equal(toPath(r, "/auth/createAdmin").length, 0, `${answer}: no create call`);
  }
});

test("navidrome: a 200 without isAdmin:true is not a created admin", () => {
  const r = run("navidrome", { answers: { FAKE_NAVIDROME_CREATE: '{"id":"user-1","username":"admin"}\n200' } });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /did not create the admin account/);
});

// ── Kavita: register, then log in with the same credentials ───────────────────────

test("kavita: the account is registered and then proved with Kavita's own login call", () => {
  const r = run("kavita");
  assert.equal(r.status, 0, r.stderr);
  const register = indexOfPath(r, "/api/Account/register");
  const login = indexOfPath(r, "/api/Account/login");
  assert.equal(register > 0, true, "the registration ran");
  assert.equal(register < login, true, "and before the login that proves it");

  const body = JSON.parse(configValue(toPath(r, "/api/Account/register")[0].stdin, "data"));
  assert.deepEqual(body, { username: "admin", email: "admin@localhost.invalid", password: PASSWORD });
  assert.equal(configValue(toPath(r, "/api/Account/login")[0].stdin, "request"), "POST");
});

test("kavita: a registration the app refuses is settled by its own admin state", () => {
  const proved = run("kavita", { answers: { FAKE_KAVITA_CREATE: KAVITA_REFUSED, FAKE_KAVITA_STATE_1: "true\n200" } });
  assert.equal(proved.status, 0, proved.stderr);
  assert.equal(toPath(proved, "/api/Account/login").length, 1, "the login is the proof");

  const foreign = run("kavita", {
    answers: {
      FAKE_KAVITA_CREATE: KAVITA_REFUSED,
      FAKE_KAVITA_STATE_1: "true\n200",
      FAKE_KAVITA_LOGIN: KAVITA_LOGIN_FAIL,
    },
  });
  assert.equal(foreign.status, 3, foreign.stderr);
  assert.match(foreign.stderr, /already has an admin account that is not Crow's/);

  const nothing = run("kavita", { answers: { FAKE_KAVITA_CREATE: KAVITA_REFUSED, FAKE_KAVITA_STATE_1: "false\n200" } });
  assert.equal(nothing.status, 1, nothing.stderr);
  assert.equal(toPath(nothing, "/api/Account/login").length, 0, "no proof without an account");
});

test("kavita: a 200 whose roles are not an admin's is not a created admin", () => {
  const r = run("kavita", { answers: { FAKE_KAVITA_CREATE: '[{"username":"admin","roles":["Login"]}]\n200' } });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /did not create the admin account/);
});

test("kavita: a username containing 'Admin' is not the Admin role", () => {
  // The role is matched inside the roles array, exactly: a name is not a permission.
  const r = run("kavita", {
    user: "AdminFan",
    answers: { FAKE_KAVITA_CREATE: '[{"username":"AdminFan","token":"t","roles":["Login"]}]\n200' },
  });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /did not create the admin account/);
  assert.equal(toPath(r, "/api/Account/login").length, 0, "nothing is proved without the role");
});

test("kavita: the Admin role is read out of the roles array, not out of the whole answer", () => {
  const r = run("kavita", {
    answers: { FAKE_KAVITA_CREATE: '[{"username":"admin","roles":["Login","Admin"]}]\n200' },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(toPath(r, "/api/Account/login").length, 1, "a real Admin role is still confirmed");
});

// ── Audiobookshelf: node inside the container, and the healthcheck fix ────────────

test("audiobookshelf: every request goes through node inside the container — that image has no curl", () => {
  const script = readFileSync(join(B("audiobookshelf"), "scripts", "first-admin.sh"), "utf8");
  assert.equal(/\bcurl\b/.test(script), false, "nothing in the script reaches for a tool the image does not ship");
  assert.match(script, /docker exec -i "\$CONTAINER" node -e "\$HTTP_REQUEST" "\$1" "\$2"/, "one node snippet, called with the method and the path");

  const snippet = snippetOf(script, "HTTP_REQUEST");
  assert.equal(snippet.includes(PASSWORD), false, "no secret is baked into the snippet");
  assert.equal(/\$\{?[A-Z_]/.test(snippet), false, "the snippet is fixed text, never a shell expansion");
  assert.match(snippet, /process\.stdin\.on\("end"/, "it reads its input from stdin");
  assert.match(snippet, /const username = lines\[0\]/, "the admin username is the first stdin line");
  assert.match(snippet, /const password = lines\[1\]/, "and the password the second");
  assert.match(snippet, /host: "127\.0\.0\.1"/, "the request stays inside the container");
  assert.match(snippet, /timeout: \d+/, "and cannot hang forever");
  assert.match(snippet, /newRoot: \{ username: username, password: password \}/, "the init body is the shape Audiobookshelf expects");
});

test("audiobookshelf: the username and the password travel on the pipe of every request", () => {
  const r = run("audiobookshelf");
  assert.equal(r.status, 0, r.stderr);
  const nodeCalls = r.calls.filter((c) => c.argv.includes("node -e"));
  assert.equal(nodeCalls.length >= 3, true, "the state check, the create and the proof");
  for (const call of nodeCalls) {
    assert.equal(call.stdin, `admin\n${PASSWORD}\n`, "both values arrive on stdin, nothing else");
  }
  assertPasswordStayedOutOfSight(r);
});

test("audiobookshelf: a create answer that is not CREATED is re-checked against /status", () => {
  // A second init answers 500 rather than a 4xx, so the status code alone never means
  // "already set up": the app's own state decides.
  const kept = run("audiobookshelf", { answers: { FAKE_ABS_INIT: "REFUSED", FAKE_ABS_STATE_1: "READY" } });
  assert.equal(kept.status, 0, kept.stderr);
  assert.equal(toPath(kept, "/login").length, 1, "the password the app took is proved");

  const nothing = run("audiobookshelf", { answers: { FAKE_ABS_INIT: "OFFLINE", FAKE_ABS_STATE_1: "INIT" } });
  assert.equal(nothing.status, 1, nothing.stderr);
  assert.match(nothing.stderr, /did not create the root user/);
});

test("audiobookshelf: the compose healthcheck probes with a tool the image ships, and is refreshed", () => {
  const compose = readFileSync(join(B("audiobookshelf"), "docker-compose.yml"), "utf8");
  assert.match(compose, /test: \["CMD", "wget", "-qO-", "http:\/\/127\.0\.0\.1:80\/healthcheck"\]/, "wget, the tool the image has");
  assert.equal(compose.includes('"curl"'), false, "the probe that could never report healthy is gone");

  const manifest = manifestOf("audiobookshelf");
  assert.equal(manifest.refreshFiles.includes("docker-compose.yml"), true, "an installed copy receives the fixed compose");
});

// ── nothing may outlive the protocol timeout ──────────────────────────────────────

const budgetOf = (script, name) => {
  const line = script.split("\n").find((l) => l.trimStart().startsWith(`${name}=$((SECONDS + `));
  assert.ok(line, `${name} is a $SECONDS budget`);
  return Number(/SECONDS \+ (\d+)\)/.exec(line)[1]);
};

/** A $SECONDS budget the app may not have: 0 when the script never sets it. */
const budgetOrZero = (script, name) => {
  const line = script.split("\n").find((l) => l.trimStart().startsWith(`${name}=$((SECONDS + `));
  return line ? Number(/SECONDS \+ (\d+)\)/.exec(line)[1]) : 0;
};

const manifestOf = (id) => JSON.parse(readFileSync(join(B(id), "manifest.json"), "utf8"));

/** Every per-request time bound a curl config hands curl (`max-time`). */
const requestBounds = (script) =>
  [
    ...script
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n")
      .matchAll(/max-time (?:= )?(\d+)/g),
  ].map((m) => Number(m[1]));

/** The body of one embedded snippet (`NAME='…'`), as the script carries it. */
function snippetOf(script, name) {
  const m = new RegExp(`^${name}='([\\s\\S]*?)'$`, "m").exec(script);
  assert.ok(m, `${name} snippet is in the script`);
  return m[1];
}

for (const [app, a] of Object.entries(APPS)) {
  test(`${app}: the waits, the proof loop and every request bound fit the manifest timeout`, () => {
    const script = readFileSync(join(B(app), "scripts", "first-admin.sh"), "utf8");
    const timeout = manifestOf(app).firstAdmin.setup.timeout_s;
    const wait = budgetOf(script, "wait_deadline");
    const proof = budgetOf(script, "proof_deadline");
    // Jellyfin's wizard is read again after an unclear step, with a budget of its own.
    const recheck = budgetOrZero(script, "recheck_deadline");
    if (app === "jellyfin") assert.equal(recheck > 0, true, "the re-check after an unclear step is its own small budget");
    assert.equal(wait < timeout, true, `${app}: the health wait (${wait}s) is inside the ${timeout}s the runner allows`);
    const bounds = app === "audiobookshelf"
      ? [Number(/timeout: (\d+)/.exec(snippetOf(script, "HTTP_REQUEST"))[1]) / 1000]
      : requestBounds(script);
    assert.equal(bounds.length > 0, true, `${app}: every request carries its own time bound`);
    // The worst case: every $SECONDS budget runs out AND every request that ran can take its
    // own bound. It has to fit what the runner allows, or the runner kills a run that is
    // still working and the operator is told nothing.
    const worst = wait + recheck + proof + bounds.reduce((x, y) => x + y, 0);
    assert.equal(
      worst < timeout,
      true,
      `${app}: worst case ${wait} + ${recheck} + ${proof} + ${bounds.join(" + ")} = ${worst}s inside ${timeout}s`,
    );
    // With the re-check counted, Jellyfin's worst case stays well (30s+) under the timeout.
    if (app === "jellyfin") assert.equal(worst <= timeout - 30, true, `${app}: ${worst}s leaves the runner ${timeout - worst}s of slack`);
    assert.equal(bounds.every((b) => b > 0 && b <= 15), true, `${app}: no single request may take more than 15s`);
  });
}

for (const app of ["jellyfin", "navidrome", "kavita"]) {
  test(`${app}: every request carries max-time, names a loopback URL, and only a read follows a redirect`, () => {
    const r = run(app);
    assert.equal(r.status, 0, r.stderr);
    const requests = r.calls.filter((c) => c.argv.includes("curl"));
    assert.equal(requests.length >= 3, true, `${app}: the probe, the create and the proof all use a config`);
    for (const call of requests) {
      assert.match(call.stdin, /^max-time = \d+$/m, `${app}: ${call.argv} carries max-time`);
      assert.match(call.stdin, /^url = "http:\/\/127\.0\.0\.1:\d+\//m, `${app}: and names a loopback URL inside the container`);
      assert.equal(/"(localhost|0\.0\.0\.0)/.test(call.stdin), false, `${app}: never the container's own localhost name`);
      // A POST that a redirect answers must be seen as that answer: never replayed onward.
      if (methodOf(call) === "POST") {
        assert.equal(call.argv.includes(" -L "), false, `${app}: a POST must not follow a redirect`);
        assert.equal(configLines(call.stdin).some((l) => l.key === "location"), false, `${app}: nor ask for it in its config`);
      }
    }
    const reads = requests.filter((c) => methodOf(c) === "GET");
    assert.equal(reads.length >= 1, true, `${app}: the detection is a read`);
    for (const call of reads) assert.equal(call.argv.includes(" -L "), true, `${app}: a read may follow a redirect`);
  });
}

// ── the declarations that put those scripts to work ───────────────────────────────

const CONVERTED = {
  jellyfin: { user: "admin", secretEnv: "JELLYFIN_ADMIN_PASSWORD", userEnv: undefined, timeout_s: 240 },
  navidrome: { user: "admin", secretEnv: "NAVIDROME_PASSWORD", userEnv: "NAVIDROME_USERNAME", timeout_s: 180 },
  audiobookshelf: { user: "admin", secretEnv: "AUDIOBOOKSHELF_ADMIN_PASSWORD", userEnv: undefined, timeout_s: 180 },
  kavita: { user: "admin", secretEnv: "KAVITA_PASSWORD", userEnv: "KAVITA_USERNAME", timeout_s: 180 },
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
    assert.equal(manifest.firstAdmin.user, want.user, `${id}: the account Crow creates`);
    assert.equal(manifest.firstAdmin.secretEnv, want.secretEnv, `${id}: where the keychain keeps the password`);
    assert.equal(manifest.firstAdmin.userEnv, want.userEnv, `${id}: userEnv only where .env carries the username`);
    assert.equal(manifest.firstAdmin.setup.timeout_s, want.timeout_s, `${id}: enough time for a slow first start`);
    assert.equal(manifest.firstAdmin.note, undefined, `${id}: a crow-created login has no note to read`);

    // The names the runner writes into the bundle's .env have to be DECLARED, or the app's
    // own MCP server never sees the login; a keychain-only entry is not written there.
    const declared = new Set((manifest.env_vars || []).map((v) => v.name));
    assert.equal(declared.has(want.secretEnv), want.userEnv !== undefined, `${id}: secretEnv is declared only when .env carries it`);
    if (want.userEnv) assert.equal(declared.has(want.userEnv), true, `${id}: userEnv is a declared env var`);

    const script = readFileSync(join(B(id), manifest.firstAdmin.setup.script), "utf8");
    assert.match(script, /^#!\/usr\/bin\/env bash/, `${id}: the script is bash`);
    assert.match(script, /set -euo pipefail/, `${id}: fail fast`);
    assert.match(script, /IFS= read -r PW/, `${id}: reads the password from stdin`);
    assert.equal(script.includes("[[ \"$ADMIN_USER\" =~ ^[A-Za-z0-9._-]+$ ]]"), true, `${id}: the admin account is validated before any docker call`);
    assert.equal(script.includes("CROW_FA_CONTAINER"), true, `${id}: the container name is overridable for tests`);
    assert.equal(script.includes("the password Crow generated"), true, `${id}: it says what the login now holds`);
    assert.equal(script.includes(PASSWORD), false, `${id}: no password is baked into the script`);
    assert.match(script, /\[ "\$\{#PW\}" -ge 12 \]/, `${id}: a password shorter than 12 characters is refused`);
    assert.match(script, /wait_deadline=\$\(\(SECONDS \+ \d+\)\)/, `${id}: the wait is a $SECONDS budget`);
    assert.match(script, /proof_deadline=\$\(\(SECONDS \+ \d+\)\)/, `${id}: and so is the proof`);

    const exit5 = script.split("\n").filter((line) => /^\s*die ".*" 5$/.test(line));
    assert.equal(exit5.length > 0, true, `${id}: has an exit-5 path`);
    for (const line of exit5) {
      assert.match(line, /Crow kept the new password; use the login in Settings → Passwords/, `${id}: the password is already Crow's, so say where the login is`);
    }
  }
});

test("the admin passwords Crow fills are not fields an install blocks on", () => {
  // The password is generated and saved by the setup script, so demanding one from the
  // operator would block the very install that creates it.
  for (const [id, name] of [["navidrome", "NAVIDROME_PASSWORD"], ["kavita", "KAVITA_PASSWORD"]]) {
    const manifest = manifestOf(id);
    const spec = (manifest.env_vars || []).find((v) => v.name === name);
    assert.ok(spec, `${id}: ${name} is still declared, or the app's MCP server never sees the login`);
    assert.equal(spec.required, false, `${id}: ${name} must not be required`);
    assert.equal(spec.secret, true, `${id}: ${name} stays a secret`);
    assert.equal((manifest.requires.env || []).includes(name), false, `${id}: and it is not in requires.env`);
    assert.match(spec.description, /Crow generates it/, `${id}: the description says where it comes from`);
  }
  // The username the script creates is still a normal field, and it now has a default that
  // matches the account the script makes.
  for (const [id, name] of [["navidrome", "NAVIDROME_USERNAME"], ["kavita", "KAVITA_USERNAME"]]) {
    const spec = (manifestOf(id).env_vars || []).find((v) => v.name === name);
    assert.equal(spec.default, "admin", `${id}: ${name} defaults to the account Crow creates`);
    assert.match(spec.description, /Crow creates `admin`/, `${id}: and says so`);
    assert.match(spec.description, /leave it as `admin`/, `${id}: the form says Crow fills it in, so nobody renames it`);
  }
});

test("the committed registry carries the same declarations (it is generated from the manifests)", () => {
  const registry = JSON.parse(readFileSync(join(REPO, "registry", "add-ons.json"), "utf8"))["add-ons"];
  for (const id of Object.keys(CONVERTED)) {
    const entry = registry.find((e) => e.id === id);
    assert.ok(entry, `registry/add-ons.json has an entry for ${id}`);
    // Serialized, not just deep-equal: build-registry writes JSON.stringify(manifest + official),
    // so the key ORDER is part of what the drift check compares.
    assert.equal(JSON.stringify(entry), JSON.stringify({ ...manifestOf(id), official: true }), `${id}: the registry entry is what build-registry would write`);
  }
});

test("the docs tell the operator who creates the admin, in both languages", () => {
  const pages = Object.keys(CONVERTED).flatMap((id) => [
    { path: join(REPO, "docs", "integrations", `${id}.md`), card: /Set it up for me/, passwords: /Settings.*Passwords/ },
    { path: join(REPO, "docs", "es", "integrations", `${id}.md`), card: /Set it up for me/, passwords: /Ajustes.*Contraseñas/ },
  ]);
  for (const { path, card, passwords } of pages) {
    const doc = readFileSync(path, "utf8");
    assert.match(doc, /`admin`/, `${path}: names the account Crow creates`);
    assert.match(doc, passwords, `${path}: says where the password is kept`);
    assert.match(doc, card, `${path}: and how an older install is set up`);
    assert.equal(/Create an admin account through the web UI on first launch|create an admin account and configure libraries/i.test(doc), false, `${path}: no longer sends the operator to the claimable page`);
  }
});