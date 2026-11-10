/**
 * N3-4 phase 2h — Crow creates the first admin of AdGuard Home, TriliumNext, Change
 * Detection and Kolibri, and the two bundles that could not start do start.
 *
 * All four apps leave their first-run page open on a loopback port: AdGuard Home's setup
 * wizard, TriliumNext's "set a password", Change Detection's "no password at all" settings
 * page and Kolibri's device-provisioning wizard. Whoever reaches one of them first owns the
 * app, so each bundle now ships `scripts/first-admin.sh` and declares
 * `firstAdmin: { mode: "crow", via: "setup", ... }`: the installer runs that script once
 * after `compose up` with the generated password as ONE line on stdin, and only while the
 * app itself reports that its setup is NOT done.
 *
 * What these tests hold down:
 *
 *   1. a fresh install: exit 0, the generated password delivered on stdin and NEVER in an
 *      argument (that is what a process list would show) and never printed, the account or
 *      password set once, and the new login proved,
 *   2. an install that already has its own admin/password: exit 3, no set call, and the
 *      password never even reaches the app,
 *   3. docker missing / the container not running: exit 4, nothing changed,
 *   4. a password the protocol refuses (empty, short) or an admin username that is not a
 *      plain account name: exit 1, and docker is not even asked,
 *   5. a detection that answers with nothing usable: exit 4, never a change,
 *   6. a change the app confirmed but a login it never accepts: exit 5, and the message says
 *      Crow kept the new password instead of sending the operator to set one by hand,
 *   7. a set step that answers unclearly is settled by the app's own state, never by the
 *      status code alone: an app that now has its admin is proved with a real login (0), and
 *      one whose login Crow's password does not open is not Crow's at all (3); an app that
 *      still reports "not set up" changed nothing (1),
 *   8. AdGuard Home: the configure body pins the admin web port to 3000 (the wizard default
 *      80 is not the port the compose maps), DNS to 53, and the proof makes at most TWO
 *      login attempts — five failures lock the account for 15 minutes,
 *   9. TriliumNext: a database that is initialised but has NO password is claimable too, and
 *      that path sets ONLY the password — no second database is created; the `/login`
 *      redirect is read from the headers and never followed, because the Location is the
 *      signal, and the manifest's username is never sent to an app that has none,
 *   10. Change Detection: the settings form is re-posted WHOLE — every input (hidden
 *      csrf_token included), checkboxes only when checked, each select's selected option and
 *      each textarea — with the new password and the save button added, because a partial
 *      body would wipe the owner's other settings; the password reaches the snippet on
 *      stdin, one status word comes back,
 *   11. Kolibri: the provisioning TASKS API is never used (it stores the plaintext password
 *      where the task list exposes it), the superuser is created through Kolibri's own
 *      `kolibri.core.device` provisioning instead, the facility name comes from the
 *      installed bundle's `.env` (`KOLIBRI_FACILITY_NAME`, default "Home Lab") since Kolibri
 *      itself does not read that variable, and the compose mounts the volume at `/kolibri`
 *      (the image's own KOLIBRI_HOME, where its entrypoint insists on a mount) with a python
 *      healthcheck — the curl one could never report healthy,
 *   12. Vikunja: the compose carries `VIKUNJA_SERVICE_PUBLICURL` derived from `VIKUNJA_URL`
 *      (Vikunja 2.8 aborts at start without it while cors is on) and probes health with its
 *      own binary, not curl; it stays `finish-setup` and its card says how to close
 *      registration,
 *   13. every request is bounded (host `timeout`, container-side max-time/T, snippet
 *      timeout) and the budgets plus every bound fit inside the manifest's timeout_s, so the
 *      runner never kills a run that is still working,
 *   14. the five manifests carry what the contract, the runner and the card need — including
 *      admin passwords an install must not block on, and `refreshFiles` for the two compose
 *      files that were fixed — the docs and skills say who creates the login, and the
 *      generated registry carries the same declarations.
 *
 * No docker and no network here: a `docker` executable written into a temp dir sits first on
 * PATH, records every argv and the stdin it received, and replays canned answers. An answer
 * is handed to the stand-in as a FILE (`<calls>/answers/<KEY>.<i>`), one per call of that
 * kind, which is how a test says "the first attempt answers this, the retry that" without
 * ever putting a secret in the environment. Inside a run the stand-in answers for the tool
 * each app's image actually ships: busybox wget for AdGuard Home (headers on stderr, body on
 * stdout), curl for TriliumNext (the request is a config on stdin), and a python snippet for
 * Change Detection and Kolibri (the action word is its last argument).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { validateManifest } from "../scripts/lib/bundle-contract.mjs";
import { ledgerKey, manifestSkillPaths, skillHash } from "../servers/gateway/bundle-skill-sync.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const B = (id) => join(REPO, "bundles", id);

/** A generated-password-shaped value: URL- and shell-safe, 22 characters. */
const PASSWORD = "gen-Secret_ABC123xy-z45";

const TMP = mkdtempSync(join(tmpdir(), "crow-fa-scripts-6-"));
const BIN = join(TMP, "bin");
const NO_TOOLS = join(TMP, "no-tools");
/** By absolute path: the "nothing on PATH" case runs the script with an empty PATH. */
const BASH = existsSync("/bin/bash") ? "/bin/bash" : "bash";
mkdirSync(BIN, { recursive: true });
mkdirSync(NO_TOOLS, { recursive: true });

// ── the canned answers each app's own tool answers with ────────────────────────────

/** An answer for the curl stand-in: the status, the redirect target, then the body. */
const reply = (code, body = "", redirect = "") => `${code}\n${redirect}\n${body}`;

const ADGUARD_OK = "200";
const ADGUARD_SETUP_EXISTS = "403";
const ADGUARD_CONFIGURED = "OK";
const ADGUARD_LOGIN_FAIL = "403";

const TRILIUM_FRESH_DB = reply(200, '{"isInitialized":false}');
const TRILIUM_HAS_DB = reply(200, '{"isInitialized":true}');
const TRILIUM_TOKEN = reply(201, '{"token":"tok-1"}');
const TRILIUM_LOGIN_FAIL = reply(401, '{"message":"wrong password"}');
/** TriliumNext's own `/login` answers a relative redirect: `.` = no password yet. */
const TRILIUM_NO_PASSWORD = reply(302, "", ".");
const TRILIUM_PASSWORD_SET = reply(302, "", "http://127.0.0.1:8080/login?login");
const TRILIUM_SAVED = reply(302, "", "http://127.0.0.1:8080/login");

const CD_PASSWORD_ON = "CONFIRMED";
const CD_LOGIN_FAIL = "LOGIN-FAIL";
const KL_PROVISIONED = "CREATED";
const KL_LOGIN_FAIL = "LOGIN-FAIL";

/** Everything a run answers with unless a test says otherwise (all four are fresh). */
const DEFAULTS = {
  FAKE_AG_STATE: ADGUARD_OK,
  FAKE_AG_CONFIGURE: ADGUARD_CONFIGURED,
  FAKE_AG_LOGIN: ADGUARD_OK,
  FAKE_TL_SETUP: TRILIUM_FRESH_DB,
  FAKE_TL_NEWDB: reply(204),
  FAKE_TL_SETPW: TRILIUM_SAVED,
  FAKE_TL_LOGIN: TRILIUM_NO_PASSWORD,
  FAKE_TL_ETAPI: TRILIUM_TOKEN,
  FAKE_CD_DETECT: "FRESH",
  FAKE_CD_SET: CD_PASSWORD_ON,
  FAKE_CD_PROVE: "LOGIN-OK",
  FAKE_KL_DETECT: "FRESH",
  FAKE_KL_PROVISION: KL_PROVISIONED,
  FAKE_KL_PROVE: "LOGIN-OK",
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
 * The apps are told apart by the tool their image ships, exactly as the bundle reaches them:
 *   - AdGuard Home: busybox wget, whose URL is an ARGUMENT and whose body travels on stdin
 *     (`--post-file=/dev/stdin`); with `-S` it prints the response headers on STDERR, which
 *     is where the status comes from;
 *   - TriliumNext: curl, whose whole request is a config on STDIN (URL, method, body/fields),
 *     printing body → status → redirect target, or the headers alone with `-D -`;
 *   - Change Detection and Kolibri: a python snippet whose ACTION WORD is its last argument,
 *     printing one status word.
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
  "",
  'case "${1:-}" in',
  '  inspect) next RUNNING true; printf "%s\\n" "$NEXT"; exit 0 ;;',
  "  exec) ;;",
  '  *) printf "fake docker: unsupported: %s\\n" "$*" >&2; exit 99 ;;',
  "esac",
  "",
  'args="$*"',
  "",
  // ── AdGuard Home: busybox wget, the URL as an argument ───────────────────────────
  'if [[ "$args" == *"wget"* ]]; then',
  '  url=""',
  '  for a in "$@"; do case "$a" in http://*) url="$a" ;; esac; done',
  '  status_mode=""',
  '  [[ " $args " == *" -O /dev/null "* ]] && status_mode=1',
  '  case "$url" in',
  '    */control/install/get_addresses) next AG_STATE "$FAKE_AG_STATE" ;;',
  '    */control/install/configure) next AG_CONFIGURE "$FAKE_AG_CONFIGURE" ;;',
  '    */control/login) next AG_LOGIN "$FAKE_AG_LOGIN" ;;',
  '    *) printf "fake docker: no answer for: %s\\n" "$url" >&2; exit 98 ;;',
  "  esac",
  '  if [ "$NEXT" = "<<fail>>" ]; then exit 7; fi',
  '  if [ -n "$status_mode" ]; then',
  // busybox wget -S prints the header block on stderr, and a 4xx is a nonzero exit — the
  // headers are printed either way.
  '    printf "Connecting to 127.0.0.1:3000\\n  HTTP/1.1 %s OK\\n  Content-Type: application/json\\n" "$NEXT" >&2',
  '    case "$NEXT" in 4*|5*) exit 1 ;; esac',
  "    exit 0",
  "  fi",
  '  printf "%s" "$NEXT"',
  "  exit 0",
  "fi",
  "",
  // ── TriliumNext: curl, the request is a config on stdin ──────────────────────────
  'if [[ "$args" == *"curl -sS"* ]]; then',
  '  cfg="$(cat "$stdinf")"',
  '  url="$(printf "%s\\n" "$cfg" | sed -n \'s/^url = "\\(.*\\)"$/\\1/p\' | head -n 1)"',
  '  case "$url" in',
  '    http://127.0.0.1:8080/api/setup/status) next TL_SETUP "$FAKE_TL_SETUP" ;;',
  '    "http://127.0.0.1:8080/api/setup/new-document?skipDemoDb") next TL_NEWDB "$FAKE_TL_NEWDB" ;;',
  '    http://127.0.0.1:8080/set-password) next TL_SETPW "$FAKE_TL_SETPW" ;;',
  '    http://127.0.0.1:8080/etapi/auth/login) next TL_ETAPI "$FAKE_TL_ETAPI" ;;',
  '    http://127.0.0.1:8080/login) next TL_LOGIN "$FAKE_TL_LOGIN" ;;',
  '    *) printf "fake docker: no answer for: %s\\n" "$url" >&2; exit 98 ;;',
  "  esac",
  '  if [ "$NEXT" = "<<fail>>" ]; then exit 7; fi',
  '  code="$(printf "%s\\n" "$NEXT" | sed -n 1p)"',
  '  where="$(printf "%s\\n" "$NEXT" | sed -n 2p)"',
  '  body="$(printf "%s\\n" "$NEXT" | sed -n \'3,$p\')"',
  // The one request that must NOT be followed: `-D -` prints the headers, Location and all.
  '  if [[ " $args " == *" -D - "* ]]; then',
  '    printf "HTTP/1.1 %s Found\\n" "$code"',
  '    [ -n "$where" ] && printf "Location: %s\\n" "$where"',
  '    printf "\\n"',
  "    exit 0",
  "  fi",
  '  printf "%s\\n%s\\n%s\\n" "$body" "$code" "$where"',
  "  exit 0",
  "fi",
  "",
  // ── Kolibri: its own management command, the values on stdin ─────────────────────
  'if [[ "$args" == *"kolibri manage shell"* ]]; then',
  '  next KL_PROVISION "$FAKE_KL_PROVISION"',
  '  printf "Running Kolibri with the following settings...\\n%s\\n" "$NEXT"',
  "  exit 0",
  "fi",
  "",
  // ── Change Detection and Kolibri: one python snippet, one status word ────────────
  'last="${!#}"',
  'if [[ "$args" == *" -c "* ]]; then',
  '  case "$args" in',
  '    *"Password protection enabled"*)',
  '      case "$last" in',
  '        detect) next CD_DETECT "$FAKE_CD_DETECT" ;;',
  '        set) next CD_SET "$FAKE_CD_SET" ;;',
  '        prove) next CD_PROVE "$FAKE_CD_PROVE" ;;',
  '        *) printf "fake docker: no action: %s\\n" "$last" >&2; exit 98 ;;',
  "      esac ;;",
  '    *"/api/auth/session/"*)',
  '      case "$last" in',
  '        detect) next KL_DETECT "$FAKE_KL_DETECT" ;;',
  '        prove) next KL_PROVE "$FAKE_KL_PROVE" ;;',
  '        *) printf "fake docker: no action: %s\\n" "$last" >&2; exit 98 ;;',
  "      esac ;;",
  '    *) printf "fake docker: unknown snippet\\n" >&2; exit 98 ;;',
  "  esac",
  '  if [ "$NEXT" = "<<fail>>" ]; then exit 7; fi',
  '  printf "%s\\n" "$NEXT"',
  "  exit 0",
  "fi",
  "",
  'printf "fake docker: no answer for: %s\\n" "$args" >&2',
  "exit 98",
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

/** The admin account each bundle's manifest declares. */
const USERS = {
  "adguard-home": "admin",
  trilium: "trilium",
  changedetection: "admin",
  kolibri: "admin",
};

/**
 * Run a bundle's setup script with the password on stdin, as the installer does: the admin
 * username in `CROW_FIRST_ADMIN_USER`, the installed bundle dir as the working directory
 * (Kolibri's facility name comes from its `.env` there) and nothing else of Crow's
 * environment.
 */
function run(bundle, { password = `${PASSWORD}\n`, answers = {}, mode = "full", user = USERS[bundle], envFiles = {}, cwd: cwdIn = null } = {}) {
  const callsDir = mkdtempSync(join(TMP, "calls-"));
  const cwd = cwdIn || mkdtempSync(join(TMP, "cwd-"));
  for (const [name, text] of Object.entries(envFiles)) writeFileSync(join(cwd, name), text, { mode: 0o600 });
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
  return { status: res.status, stdout: res.stdout || "", stderr: res.stderr || "", calls: readCalls(callsDir), cwd };
}

const argvText = (r) => r.calls.map((c) => c.argv).join("\n");
const stdinText = (r) => r.calls.map((c) => c.stdin).join("\n");

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

/** The body of one embedded snippet (`NAME='…'` or `NAME="…"`), as the script carries it. */
function snippetOf(script, name) {
  const m = new RegExp(`^${name}=(['"])([\\s\\S]*?)\\1$`, "m").exec(script);
  assert.ok(m, `${name} snippet is in the script`);
  return m[2];
}

/** The stdin lines a python snippet received. */
const stdinLines = (call) => call.stdin.split("\n");

const manifestOf = (id) => JSON.parse(readFileSync(join(B(id), "manifest.json"), "utf8"));

// ── the four converted apps, and how each one is asked ─────────────────────────────

const TRILIUM = {
  status: "http://127.0.0.1:8080/api/setup/status",
  newDocument: "http://127.0.0.1:8080/api/setup/new-document?skipDemoDb",
  setPassword: "http://127.0.0.1:8080/set-password",
  etapiLogin: "http://127.0.0.1:8080/etapi/auth/login",
  loginPage: "http://127.0.0.1:8080/login",
};

/** The calls that are one curl request (its URL lives in the config on the call's stdin). */
const curlCalls = (r, url) => r.calls.filter((c) => configValues(c.stdin, "url").includes(url));
/** The calls that are one python-snippet run (its action word is the last argument). */
const snippetCalls = (r, action) => r.calls.filter((c) => c.argv.trimEnd().endsWith(` ${action}`));

const APPS = {
  "adguard-home": {
    container: "crow-adguard",
    /** The answers that make the app report "its setup already happened". */
    done: { FAKE_AG_STATE: ADGUARD_SETUP_EXISTS },
    /** Answers no state can be read out of. */
    unreadable: [{ FAKE_AG_STATE: "500" }, { FAKE_AG_STATE: "404" }, { FAKE_AG_STATE: "302" }],
    /** The set request answered without saying what it did. */
    setUnclear: { FAKE_AG_CONFIGURE: "<html>bad request</html>" },
    recheckDone: { FAKE_AG_STATE_1: ADGUARD_SETUP_EXISTS },
    recheckFresh: { FAKE_AG_STATE_1: ADGUARD_OK },
    recheckUnreadable: { FAKE_AG_STATE_1: "500" },
    /** wget: the URL is an argument, the body is on the call's stdin. */
    setCalls: (r) => r.calls.filter((c) => c.argv.includes("/control/install/configure")),
    loginCalls: (r) => r.calls.filter((c) => c.argv.includes("/control/login")),
    proofTries: 2,
    setPasswordIn: (call) => JSON.parse(call.stdin).password,
    loginPasswordIn: (call) => JSON.parse(call.stdin).password,
    freshMessage: /did not finish its setup wizard, so nothing was changed/,
    unknownMessage: /did not report whether it kept the new setup/,
    alreadyMessage: /already has/,
  },
  trilium: {
    container: "crow-trilium",
    done: { FAKE_TL_SETUP: TRILIUM_HAS_DB, FAKE_TL_LOGIN: TRILIUM_PASSWORD_SET },
    unreadable: [
      { FAKE_TL_SETUP: reply(200, '{"isInitialized":"maybe"}') },
      { FAKE_TL_SETUP: reply(200, '{"other":true}') },
      { FAKE_TL_SETUP: reply(500, "") },
    ],
    setUnclear: { FAKE_TL_SETPW: reply(500, "") },
    // After an unclear set the login page is read for the FIRST time (a fresh database skips
    // it), so its counter starts at 0.
    recheckDone: { FAKE_TL_LOGIN_0: TRILIUM_PASSWORD_SET },
    recheckFresh: { FAKE_TL_LOGIN_0: TRILIUM_NO_PASSWORD },
    recheckUnreadable: { FAKE_TL_LOGIN_0: reply(200, "<html>no redirect here</html>") },
    setCalls: (r) => curlCalls(r, TRILIUM.setPassword),
    loginCalls: (r) => curlCalls(r, TRILIUM.etapiLogin),
    proofTries: 3,
    setPasswordIn: (call) => {
      const fields = configValues(call.stdin, "data-urlencode");
      const value = fields.find((f) => f.startsWith("password1="));
      return value === undefined ? null : value.slice("password1=".length);
    },
    loginPasswordIn: (call) => JSON.parse(configValue(call.stdin, "data")).password,
    freshMessage: /did not set the password, so nothing was changed/,
    unknownMessage: /did not report whether it set the password/,
    alreadyMessage: /already has its own admin password|already has an admin password that is not Crow's/,
  },
  changedetection: {
    container: "crow-changedetection",
    done: { FAKE_CD_DETECT: "DONE" },
    unreadable: [{ FAKE_CD_DETECT: "UNKNOWN" }, { FAKE_CD_DETECT: "garbage" }, { FAKE_CD_DETECT: "OFFLINE-ish" }],
    setUnclear: { FAKE_CD_SET: "UNKNOWN" },
    recheckDone: { FAKE_CD_DETECT_1: "DONE" },
    recheckFresh: { FAKE_CD_DETECT_1: "FRESH" },
    recheckUnreadable: { FAKE_CD_DETECT_1: "UNKNOWN" },
    setCalls: (r) => snippetCalls(r, "set"),
    loginCalls: (r) => snippetCalls(r, "prove"),
    proofTries: 3,
    setPasswordIn: (call) => stdinLines(call)[0],
    loginPasswordIn: (call) => stdinLines(call)[0],
    freshMessage: /did not take the new password, so nothing was changed/,
    unknownMessage: /did not report whether it took the new password/,
    alreadyMessage: /already has a password/,
  },
  kolibri: {
    container: "crow-kolibri",
    done: { FAKE_KL_DETECT: "DONE" },
    unreadable: [{ FAKE_KL_DETECT: "UNKNOWN" }, { FAKE_KL_DETECT: "garbage" }, { FAKE_KL_DETECT: "OFFLINE-ish" }],
    setUnclear: { FAKE_KL_PROVISION: "UNKNOWN" },
    recheckDone: { FAKE_KL_DETECT_1: "DONE" },
    recheckFresh: { FAKE_KL_DETECT_1: "FRESH" },
    recheckUnreadable: { FAKE_KL_DETECT_1: "UNKNOWN" },
    setCalls: (r) => r.calls.filter((c) => c.argv.includes("kolibri manage shell")),
    loginCalls: (r) => snippetCalls(r, "prove"),
    proofTries: 3,
    setPasswordIn: (call) => stdinLines(call)[0],
    loginPasswordIn: (call) => stdinLines(call)[1],
    freshMessage: /did not create the superuser, so nothing was changed/,
    unknownMessage: /did not report whether it created the superuser/,
    alreadyMessage: /already has its own superuser|already has a superuser that is not Crow's/,
  },
};

/** The answer a run gives when the app's login never accepts Crow's password. */
const LOGIN_FAILS = {
  "adguard-home": { FAKE_AG_LOGIN: ADGUARD_LOGIN_FAIL },
  trilium: { FAKE_TL_ETAPI: TRILIUM_LOGIN_FAIL },
  changedetection: { FAKE_CD_PROVE: CD_LOGIN_FAIL },
  kolibri: { FAKE_KL_PROVE: KL_LOGIN_FAIL },
};

// ── one fresh install per app, and the exits every app owes the protocol ───────────

for (const [app, a] of Object.entries(APPS)) {
  test(`${app}: a fresh install gets the generated password, delivered on stdin only`, () => {
    const r = run(app);
    assert.equal(r.status, 0, r.stderr);
    assertPasswordStayedOutOfSight(r);
    assert.equal(r.calls[0].argv.startsWith("docker inspect"), true, "the container is checked before it is touched");
    assert.equal(r.calls[0].argv.includes(a.container), true, "and the app's own container is the one named");

    const sets = a.setCalls(r);
    assert.equal(sets.length, 1, "the account or password is written exactly once");
    assert.equal(a.setPasswordIn(sets[0]), PASSWORD, "with the generated password, on the pipe");

    const logins = a.loginCalls(r);
    assert.equal(logins.length, 1, "and the new login is proved once");
    assert.equal(a.loginPasswordIn(logins[0]), PASSWORD, "with that same password, on the pipe");
  });

  test(`${app}: an install that already has its own admin is left alone (exit 3)`, () => {
    const r = run(app, { answers: a.done });
    assert.equal(r.status, 3, r.stderr);
    assert.match(r.stderr, a.alreadyMessage);
    assert.match(r.stderr, /nothing was changed/);
    assert.equal(a.setCalls(r).length, 0, "nothing may be written");
    assert.equal(a.loginCalls(r).length, 0, "and nothing has to be proved");
    assert.equal(stdinText(r).includes(PASSWORD), false, "the new password never even reaches the app");
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

  test(`${app}: a detection that answers nothing usable changes nothing (exit 4)`, () => {
    for (const answers of a.unreadable) {
      const r = run(app, { answers });
      assert.equal(r.status, 4, `${JSON.stringify(answers)}: ${r.stderr}`);
      assert.match(r.stderr, /nothing was changed/);
      assert.equal(a.setCalls(r).length, 0, `${JSON.stringify(answers)}: no set call`);
      assert.equal(argvText(r).includes(PASSWORD), false, `${JSON.stringify(answers)}: the password stayed home`);
    }
  });

  test(`${app}: a login the app never accepts after the change is kept, not thrown away (exit 5)`, () => {
    const r = run(app, { answers: LOGIN_FAILS[app] });
    assert.equal(r.status, 5, r.stderr);
    assert.match(r.stderr, /accepted the new password, but logging in with it did not succeed/);
    assert.match(r.stderr, /Crow kept the new password; use the login in Settings → Passwords/);
    assert.equal(a.loginCalls(r).length, a.proofTries, `the proof is tried ${a.proofTries} time(s)`);
    assert.equal(a.setCalls(r).length, 1, "the change really happened first");
    assertPasswordStayedOutOfSight(r);
  });

  test(`${app}: an unclear set that re-detects as "already set up" is proved with Crow's password`, () => {
    const r = run(app, { answers: { ...a.setUnclear, ...a.recheckDone } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(a.setCalls(r).length, 1, "the set is attempted once");
    assert.equal(a.loginCalls(r).length, 1, "the password the app may hold is proved");
    assertPasswordStayedOutOfSight(r);
  });

  test(`${app}: an unclear set re-detected as set up whose login fails is exit 3, nothing saved`, () => {
    const r = run(app, { answers: { ...a.setUnclear, ...a.recheckDone, ...LOGIN_FAILS[app] } });
    assert.equal(r.status, 3, r.stderr);
    assert.match(r.stderr, /not Crow's/);
    assert.match(r.stderr, /left alone, and nothing of Crow's was saved/);
    assert.equal(a.loginCalls(r).length, a.proofTries, "the login is tried before the password is dropped");
    assertPasswordStayedOutOfSight(r);
  });

  test(`${app}: an unclear set on an app that still has no admin changes nothing (exit 1)`, () => {
    const r = run(app, { answers: { ...a.setUnclear, ...a.recheckFresh } });
    assert.equal(r.status, 1, `${r.stderr}`);
    assert.match(r.stderr, a.freshMessage);
    assert.equal(a.loginCalls(r).length, 0, "no proof after a set that did not happen");
    assert.equal(/nothing of Crow's was saved/.test(r.stderr), false, "that is the exit-3 sentence, and here the app has no admin at all");
  });

  test(`${app}: an unreadable re-check after an unclear set changes nothing (exit 1)`, () => {
    const r = run(app, { answers: { ...a.setUnclear, ...a.recheckUnreadable } });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, a.unknownMessage);
    assert.equal(a.loginCalls(r).length, 0, "no proof without a state");
  });
}

// ── AdGuard Home: the wizard's ports, and the lockout-safe proof ───────────────────

test("adguard-home: the configure body keeps the admin UI on 3000 and DNS on 53 inside the container", () => {
  const r = run("adguard-home");
  assert.equal(r.status, 0, r.stderr);
  const configure = APPS["adguard-home"].setCalls(r)[0];
  const body = JSON.parse(configure.stdin);
  assert.deepEqual(body.web, { ip: "0.0.0.0", port: 3000 }, "the wizard default 80 is NOT the port this bundle maps");
  assert.deepEqual(body.dns, { ip: "0.0.0.0", port: 53 });
  assert.equal(body.username, "admin");
  assert.equal(body.password, PASSWORD);
  assert.equal(configure.argv.includes("--post-file=/dev/stdin"), true, "the body travels on wget's stdin");
  assert.equal(configure.argv.includes(PASSWORD), false, "and never as an argument");
});

test("adguard-home: the proof makes at most TWO login attempts (five failures lock the account)", () => {
  const r = run("adguard-home", { answers: LOGIN_FAILS["adguard-home"] });
  assert.equal(r.status, 5, r.stderr);
  assert.equal(APPS["adguard-home"].loginCalls(r).length, 2, "never more than two: the third would risk a 15-minute lockout");
  const script = readFileSync(join(B("adguard-home"), "scripts", "first-admin.sh"), "utf8");
  assert.match(script, /\[ "\$attempt" -ge 2 \]/, "the proof loop's own cap is two");
  assert.match(script, /at most TWO/, "and the script says why");
});

test("adguard-home: only a 200 on the install endpoint counts as fresh, only a 403 as set up", () => {
  const fresh = run("adguard-home", { answers: { FAKE_AG_STATE: ADGUARD_OK } });
  assert.equal(fresh.status, 0, fresh.stderr);
  for (const code of ["201", "204", "301"]) {
    const r = run("adguard-home", { answers: { FAKE_AG_STATE: code } });
    assert.equal(r.status, 4, `${code}: ${r.stderr}`);
    assert.equal(APPS["adguard-home"].setCalls(r).length, 0, `${code}: no configure call`);
  }
});

// ── TriliumNext: the password, not a username ──────────────────────────────────────

test("trilium: a database initialised WITHOUT a password sets only the password — no second database", () => {
  const r = run("trilium", { answers: { FAKE_TL_SETUP: TRILIUM_HAS_DB, FAKE_TL_LOGIN: TRILIUM_NO_PASSWORD } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(curlCalls(r, TRILIUM.newDocument).length, 0, "an existing database is never re-created");
  assert.equal(APPS.trilium.setCalls(r).length, 1, "only the password is written");
  assert.equal(APPS.trilium.loginCalls(r).length, 1, "and proved");
});

test("trilium: a fresh database is created once, then the password is set", () => {
  const r = run("trilium");
  assert.equal(r.status, 0, r.stderr);
  const newDocs = curlCalls(r, TRILIUM.newDocument);
  assert.equal(newDocs.length, 1, "one database is created");
  assert.equal(configValue(newDocs[0].stdin, "request"), "POST", "the method is in the config, not an argument");
  assert.deepEqual(JSON.parse(configValue(newDocs[0].stdin, "data")), {}, "with the empty body TriliumNext expects");
  assert.equal(r.calls.indexOf(newDocs[0]) < r.calls.indexOf(APPS.trilium.setCalls(r)[0]), true, "the database comes first");
});

test("trilium: the password reaches the app as two urlencoded form fields on the pipe", () => {
  const r = run("trilium");
  assert.equal(r.status, 0, r.stderr);
  const set = APPS.trilium.setCalls(r)[0];
  assert.deepEqual(configValues(set.stdin, "data-urlencode"), [`password1=${PASSWORD}`, `password2=${PASSWORD}`]);
  assert.equal(configValue(set.stdin, "request"), "POST");
  // The manifest's `user` is protocol-only: TriliumNext's API takes a password and no account.
  assert.equal(set.stdin.includes("trilium"), false, "the username is never sent to the app");
  assert.equal(APPS.trilium.loginCalls(r)[0].stdin.includes("trilium"), false, "nor to its ETAPI login");
  assert.deepEqual(JSON.parse(configValue(APPS.trilium.loginCalls(r)[0].stdin, "data")), { password: PASSWORD });
});

test("trilium: the /login redirect is READ as headers and never followed, and no POST follows one", () => {
  const r = run("trilium", { answers: { FAKE_TL_SETUP: TRILIUM_HAS_DB, FAKE_TL_LOGIN: TRILIUM_NO_PASSWORD } });
  assert.equal(r.status, 0, r.stderr);
  const reads = curlCalls(r, TRILIUM.loginPage);
  assert.equal(reads.length, 1, "one header read of the login page");
  assert.equal(reads[0].argv.includes(" -D - "), true, "the headers are what carry the Location");
  assert.equal(reads[0].argv.includes(" -L "), false, "and the redirect must not be followed: it IS the answer");

  const posts = r.calls.filter((c) => configValue(c.stdin, "request") === "POST");
  assert.equal(posts.length >= 2, true, "the database, the password and the proof are posts");
  for (const call of posts) assert.equal(call.argv.includes(" -L "), false, "a POST must never follow a redirect");
  const plainReads = r.calls.filter((c) => configValues(c.stdin, "url").length > 0 && configValue(c.stdin, "request") === undefined);
  assert.equal(plainReads.length >= 1, true, "the setup state is a plain read");
  for (const call of plainReads) {
    if (call === reads[0]) continue;
    assert.equal(call.argv.includes(" -L "), true, "a plain read may follow one");
  }
});

test("trilium: a login page whose Location says nothing readable is exit 4, not a guess", () => {
  for (const answer of [reply(200, "<html>plain page</html>"), reply(302, "", "http://127.0.0.1:8080/login?logout")]) {
    const r = run("trilium", { answers: { FAKE_TL_SETUP: TRILIUM_HAS_DB, FAKE_TL_LOGIN: answer } });
    assert.equal(r.status, 4, `${JSON.stringify(answer)}: ${r.stderr}`);
    assert.equal(APPS.trilium.setCalls(r).length, 0, "no password is written on a page we cannot read");
  }
});

// ── Change Detection: the whole settings form goes back ───────────────────────────

test("changedetection: the settings form is re-posted whole, with the password and the save button added", () => {
  const script = readFileSync(join(B("changedetection"), "scripts", "first-admin.sh"), "utf8");
  const snippet = snippetOf(script, "CD");
  // Every kind of field the settings form carries, with the value a browser would send.
  assert.match(snippet, /class Fields\(HTMLParser\)/, "the form is read with a real HTML parser");
  assert.match(snippet, /if tag == "input":/, "inputs are collected");
  assert.match(snippet, /kind in \("checkbox", "radio"\)/, "checkboxes and radios only when checked");
  assert.match(snippet, /elif tag == "select":/, "selects are collected");
  assert.match(snippet, /if "selected" in attrs:/, "with their selected option");
  assert.match(snippet, /elif tag == "textarea":/, "and textareas with their text");
  assert.match(snippet, /fields\.append\(\("application-password", password\)\)/, "the new password is added");
  assert.match(snippet, /fields\.append\(\("save_button", "Save"\)\)/, "and the save button, which the app keys on");
  assert.match(snippet, /urllib\.parse\.urlencode\(fields\)/, "the WHOLE collected list is posted back");
  // A partial body would wipe the owner's other settings, so nothing may be filtered out.
  assert.equal(/fields\.clear\(\)/.test(snippet), false, "nothing collected may be dropped");
  assert.match(snippet, /Password protection enabled/, "the confirmation is the app's own sentence");
  assert.equal(snippet.includes("'"), false, "the snippet is fixed text: no shell quoting can reach it");
  assert.equal(/\$\{?[A-Z_]/.test(snippet), false, "and no shell expansion is baked into it");
});

test("changedetection: the login proof re-reads the form's csrf token and posts it back", () => {
  const script = readFileSync(join(B("changedetection"), "scripts", "first-admin.sh"), "utf8");
  const snippet = snippetOf(script, "CD");
  assert.match(snippet, /if name == "csrf_token":/, "the login form's token is read");
  assert.match(snippet, /urllib\.parse\.urlencode\(\{"csrf_token": token, "password": password\}\)/, "and posted with the password");
  assert.match(snippet, /if where == "":/, "a final URL of / is the success signal");
  assert.match(snippet, /if where == "\/login":/, "and /login is the failure one");
});

test("changedetection: a set the app answers unclearly is settled by its own password state", () => {
  const sold = run("changedetection", { answers: { FAKE_CD_SET: "UNKNOWN", FAKE_CD_DETECT_1: "DONE" } });
  assert.equal(sold.status, 0, sold.stderr);
  assert.equal(APPS.changedetection.loginCalls(sold).length, 1, "the password the app may hold is proved");
  const nothing = run("changedetection", { answers: { FAKE_CD_SET: "UNKNOWN", FAKE_CD_DETECT_1: "FRESH" } });
  assert.equal(nothing.status, 1, nothing.stderr);
  assert.equal(APPS.changedetection.loginCalls(nothing).length, 0);
});

test("changedetection: the app's password is what is set — its API key is untouched", () => {
  const script = readFileSync(join(B("changedetection"), "scripts", "first-admin.sh"), "utf8");
  assert.equal(/api-key|api_key|apikey/i.test(script), false, "nothing here touches the API key the MCP tools use");
  // The interpreter is the one this image's own compose healthcheck already runs.
  assert.match(script, /^PYTHON=python$/m, "the snippet runs with the interpreter the image is known to have");
  const r = run("changedetection");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(APPS.changedetection.setCalls(r)[0].stdin, `${PASSWORD}\n`, "only the password arrives, on stdin");
});

// ── Kolibri: provisioning, the mount, and the healthcheck ─────────────────────────

test("kolibri: the superuser is created through Kolibri's own provisioning, never through the tasks API", () => {
  const script = readFileSync(join(B("kolibri"), "scripts", "first-admin.sh"), "utf8");
  // Comments may NAME the trap (that is how the next reader learns why); no code may use it.
  const code = script.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
  for (const text of [code, snippetOf(script, "HTTP"), snippetOf(script, "PROVISION")]) {
    assert.equal(/api\/tasks/.test(text), false, "the tasks API stores the plaintext password in a readable task record");
    assert.equal(/["']provisiondevice["']|kind["']?\s*:\s*["'][^"']*provisiondevice/.test(text), false, "and no provisiondevice TASK is queued (only its validate_options function is imported)");
  }
  const provision = snippetOf(script, "PROVISION");
  assert.match(provision, /from kolibri\.core\.device\.utils import device_provisioned, setup_device_and_facility/);
  assert.match(provision, /from kolibri\.core\.device\.management\.commands\.provisiondevice import validate_options/);
  assert.match(provision, /if device_provisioned\(\):\s*\n\s*print\("DONE"\)/, "a provisioned device is never provisioned again");
  assert.match(provision, /setup_device_and_facility\(\*args\)/);
  assert.match(provision, /"preset": "informal"/);
  assert.match(provision, /"language_id": "en"/);

  const r = run("kolibri");
  assert.equal(r.status, 0, r.stderr);
  const call = APPS.kolibri.setCalls(r)[0];
  assert.ok(call, "the provisioning runs through `kolibri manage shell -c`");
  assert.equal(call.argv.includes("-u kolibri"), true, "as the app's own user");
  assert.equal(call.argv.includes(PASSWORD), false, "the password is never an argument");
  assert.deepEqual(stdinLines(call).slice(0, 3), [PASSWORD, "admin", "Home Lab"], "password, user and facility arrive on stdin");
});

test("kolibri: the facility name comes from the installed bundle's .env", () => {
  const r = run("kolibri", { envFiles: { ".env": "KOLIBRI_HTTP_PORT=8041\nKOLIBRI_FACILITY_NAME=Room 4\n" } });
  assert.equal(r.status, 0, r.stderr);
  const call = APPS.kolibri.setCalls(r)[0];
  assert.deepEqual(stdinLines(call).slice(0, 3), [PASSWORD, "admin", "Room 4"], "the operator's facility name, not the default");
});

test("kolibri: the compose mounts the volume where the image insists, and probes health with python", () => {
  const compose = readFileSync(join(B("kolibri"), "docker-compose.yml"), "utf8");
  assert.match(compose, /- \$\{KOLIBRI_DATA_PATH:-kolibri-data\}:\/kolibri\n/, "the image's own KOLIBRI_HOME is the mount");
  assert.equal(compose.includes("/kolibrihome"), false, "the mount the entrypoint refused is gone");
  assert.match(compose, /test: \["CMD", "python3", "-c", "import urllib\.request,sys; urllib\.request\.urlopen\('http:\/\/127\.0\.0\.1:8080\/api\/public\/info\/', timeout=5\)"\]/);
  assert.equal(/"curl"/.test(compose), false, "the curl probe that could never report healthy is gone");
  assert.equal(compose.includes("KOLIBRI_FACILITY_NAME"), false, "Kolibri does not read that variable: only the setup script does");
  assert.equal(manifestOf("kolibri").refreshFiles.includes("docker-compose.yml"), true, "an installed copy receives the fixed compose");
  // The setup script's snippets run with the same interpreter the healthcheck names (Kolibri
  // is python3-based; python3 is the interpreter this script uses).
  assert.match(readFileSync(join(B("kolibri"), "scripts", "first-admin.sh"), "utf8"), /^PYTHON=python3$/m);
});

test("kolibri: an install that predates the mount fix kept no data, and the notes say so", () => {
  const manifest = manifestOf("kolibri");
  assert.match(manifest.notes, /never started a container at all, so changing the mount loses no content/);
});

// ── Vikunja: it starts again, and Crow creates its account then closes registration ─

test("vikunja: the compose carries the public URL Vikunja 2.8 aborts without, and probes with its own binary", () => {
  const compose = readFileSync(join(B("vikunja"), "docker-compose.yml"), "utf8");
  assert.match(compose, /VIKUNJA_SERVICE_PUBLICURL=\$\{VIKUNJA_URL:-http:\/\/localhost:3456\}\//, "service.publicurl is required while cors is on");
  assert.match(compose, /VIKUNJA_SERVICE_FRONTENDURL=\$\{VIKUNJA_URL:-http:\/\/localhost:3456\}\//, "and the frontend URL stays");
  assert.match(compose, /test: \["CMD", "\/app\/vikunja\/vikunja", "healthcheck"\]/, "the image ships its own healthcheck subcommand");
  assert.equal(compose.includes('"curl"'), false, "and no curl: the image is distroless");

  const manifest = manifestOf("vikunja");
  assert.equal(manifest.refreshFiles.includes("docker-compose.yml"), true, "an installed copy receives the fixed compose");
  // Crow registers the owner's account, then closes registration (operator ruling
  // "Crow creates, then closes"): the setup script creates `admin`, and the after-step
  // writes the switch and recreates the container once so Vikunja reads it.
  assert.deepEqual(
    { mode: manifest.firstAdmin.mode, via: manifest.firstAdmin.via, user: manifest.firstAdmin.user, script: manifest.firstAdmin.setup.script },
    { mode: "crow", via: "setup", user: "admin", script: "scripts/first-admin.sh" },
    "Crow creates the account itself",
  );
  assert.deepEqual(manifest.firstAdmin.setup.after, {
    env: { VIKUNJA_ENABLE_REGISTRATION: "false" },
    recreate: true,
  }, "then turns registration off and restarts Vikunja");
  // The switch the after-step writes has to be DECLARED, and the compose has to read it.
  const spec = (manifest.env_vars || []).find((v) => v.name === "VIKUNJA_ENABLE_REGISTRATION");
  assert.ok(spec, "VIKUNJA_ENABLE_REGISTRATION is a declared env var");
  assert.equal(spec.default, "true");
  assert.equal(spec.required, false);
  assert.equal(spec.secret, undefined);
  assert.match(compose, /VIKUNJA_SERVICE_ENABLEREGISTRATION=\$\{VIKUNJA_ENABLE_REGISTRATION:-true\}/);
});

/** The compose text of one service: from its 2-space key to the next top-level service. */
function serviceText(compose, name) {
  const start = compose.search(new RegExp(`^  ${name}:$`, "m"));
  if (start < 0) return null;
  const rest = compose.slice(start);
  const next = rest.slice(1).search(/^ {2}\S+:$/m);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

test("vikunja: a one-shot step hands both volumes to uid 1000 before Vikunja starts", () => {
  // Vikunja is distroless and Docker creates named volumes owned by root, so the app
  // cannot write its files or database until something chowns them. That step is a
  // separate service the compose runs once, before the app (read as text: no YAML dep).
  const compose = readFileSync(join(B("vikunja"), "docker-compose.yml"), "utf8");
  const helper = serviceText(compose, "vikunja-volume-owner");
  assert.ok(helper, "the one-shot volume-owner service is declared");
  assert.match(helper, /image: busybox:\S+@sha256:[0-9a-f]{64}/, "its image is pinned by digest");
  assert.match(helper, /^\s+network_mode: none$/m, "it needs no network");
  assert.match(helper, /^\s+restart: "no"$/m, "it runs once and is not restarted");
  assert.match(helper, /command: \["chown", "1000:1000", "\/app\/vikunja\/files", "\/db"\]/, "it chowns both volume targets");
  assert.match(helper, /^\s+- vikunja-data:\/app\/vikunja\/files$/m, "the files volume is the one Vikunja mounts");
  assert.match(helper, /^\s+- vikunja-db:\/db$/m, "and so is the database volume");
  const app = serviceText(compose, "vikunja");
  assert.ok(app, "the app service is declared");
  assert.match(app, /depends_on:\n\s+vikunja-volume-owner:\n\s+condition: service_completed_successfully/, "Vikunja starts only once the helper has finished");
});

// ── nothing may outlive the protocol timeout ──────────────────────────────────────

/** Every per-request bound a script hands its tools: host `timeout`, curl max-time, wget -T,
 *  and the python snippets' own TIMEOUT. */
const requestBounds = (script) => {
  const text = script.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
  return [
    ...[...text.matchAll(/\btimeout (\d+)\b/g)].map((m) => Number(m[1])),
    ...[...text.matchAll(/max-time = (\d+)/g)].map((m) => Number(m[1])),
    ...[...text.matchAll(/-T (\d+)\b/g)].map((m) => Number(m[1])),
    ...[...text.matchAll(/^TIMEOUT = (\d+)$/gm)].map((m) => Number(m[1])),
  ];
};

for (const app of Object.keys(APPS)) {
  test(`${app}: the waits, the proof loop and every request bound fit the manifest timeout`, () => {
    const script = readFileSync(join(B(app), "scripts", "first-admin.sh"), "utf8");
    const timeout = manifestOf(app).firstAdmin.setup.timeout_s;
    const budgets = [...script.matchAll(/^(\w+_deadline)=\$\(\(SECONDS \+ (\d+)\)\)$/gm)];
    assert.equal(budgets.length >= 2, true, `${app}: a wait and a proof budget`);
    const total = budgets.reduce((sum, m) => sum + Number(m[2]), 0);
    const bounds = requestBounds(script);
    assert.equal(bounds.length > 0, true, `${app}: every request carries its own time bound`);
    assert.equal(bounds.every((b) => b > 0 && b <= 45), true, `${app}: no single request may take more than 45s`);
    const sum = bounds.reduce((x, y) => x + y, 0);
    const worst = total + sum;
    assert.equal(worst < timeout, true, `${app}: worst case ${total} + ${sum} = ${worst}s inside ${timeout}s`);
    assert.equal(worst <= timeout - 20, true, `${app}: ${worst}s leaves the runner ${timeout - worst}s of slack`);
  });
}

test("no bundle lets the generated password reach an argument, an environment value or a log", () => {
  for (const app of Object.keys(APPS)) {
    const script = readFileSync(join(B(app), "scripts", "first-admin.sh"), "utf8");
    assert.equal(script.includes(PASSWORD), false, `${app}: no password is baked into the script`);
    assert.match(script, /^#!\/usr\/bin\/env bash/, `${app}: the script is bash`);
    assert.match(script, /set -euo pipefail/, `${app}: fail fast`);
    assert.match(script, /IFS= read -r PW/, `${app}: reads the password from stdin`);
    assert.equal(script.includes(`[[ "$ADMIN_USER" =~ ^[A-Za-z0-9._-]+$ ]]`), true, `${app}: the admin username is validated before any docker call`);
    assert.equal(script.includes("CROW_FA_CONTAINER"), true, `${app}: the container name is overridable for tests`);
    assert.match(script, /\[ "\$\{#PW\}" -ge 12 \]/, `${app}: a password shorter than 12 characters is refused`);
    const exit5 = script.split("\n").filter((line) => /^\s*die ".*" 5$/.test(line));
    assert.equal(exit5.length > 0, true, `${app}: has an exit-5 path`);
    for (const line of exit5) {
      assert.match(line, /Crow kept the new password; use the login in Settings → Passwords/, `${app}: the password is already Crow's, so say where the login is`);
    }
  }
});

// ── the declarations that put those scripts to work ───────────────────────────────

const CONVERTED = {
  "adguard-home": { user: "admin", secretEnv: "ADGUARD_PASSWORD", userEnv: "ADGUARD_USERNAME", timeout_s: 180 },
  trilium: { user: "trilium", secretEnv: "TRILIUM_PASSWORD", userEnv: undefined, timeout_s: 180 },
  changedetection: { user: "admin", secretEnv: "CHANGEDETECTION_PASSWORD", userEnv: undefined, timeout_s: 180 },
  kolibri: { user: "admin", secretEnv: "KOLIBRI_ADMIN_PASSWORD", userEnv: undefined, timeout_s: 240 },
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
    assert.equal(script.includes("CROW_FA_CONTAINER"), true, `${id}: the container name is overridable for tests`);
  }
});

test("the admin passwords Crow fills are not fields an install blocks on", () => {
  // The password is generated and saved by the setup script, so demanding one from the
  // operator would block the very install that creates it.
  const manifest = manifestOf("adguard-home");
  const spec = (manifest.env_vars || []).find((v) => v.name === "ADGUARD_PASSWORD");
  assert.ok(spec, "adguard-home: ADGUARD_PASSWORD is still declared, or the app's MCP server never sees the login");
  assert.equal(spec.required, false, "adguard-home: it must not be required");
  assert.equal(spec.secret, true, "adguard-home: it stays a secret");
  assert.equal((manifest.requires.env || []).includes("ADGUARD_PASSWORD"), false, "adguard-home: and it is not in requires.env");
  assert.match(spec.description, /Crow generates it/, "adguard-home: the description says where it comes from");

  // The username the script creates is still a normal field, and its default matches it.
  const username = (manifest.env_vars || []).find((v) => v.name === "ADGUARD_USERNAME");
  assert.equal(username.required, false, "adguard-home: ADGUARD_USERNAME is not a blocking field");
  assert.equal(username.default, "admin", "adguard-home: it defaults to the account Crow creates");
  assert.match(username.description, /Crow creates `admin`/, "adguard-home: and says so");
  assert.equal((manifest.requires.env || []).includes("ADGUARD_USERNAME"), false, "adguard-home: out of requires.env");

  // Kolibri's facility name is a plain, optional field: the script reads it, Kolibri does not.
  const facility = (manifestOf("kolibri").env_vars || []).find((v) => v.name === "KOLIBRI_FACILITY_NAME");
  assert.equal(facility.required, false);
  assert.match(facility.description, /Kolibri itself does not read this variable/);
});

test("the committed registry carries the same declarations (it is generated from the manifests)", () => {
  const registry = JSON.parse(readFileSync(join(REPO, "registry", "add-ons.json"), "utf8"))["add-ons"];
  for (const id of [...Object.keys(CONVERTED), "vikunja"]) {
    const entry = registry.find((e) => e.id === id);
    assert.ok(entry, `registry/add-ons.json has an entry for ${id}`);
    // Serialized, not just deep-equal: build-registry writes JSON.stringify(manifest + official),
    // so the key ORDER is part of what the drift check compares.
    assert.equal(JSON.stringify(entry), JSON.stringify({ ...manifestOf(id), official: true }), `${id}: the registry entry is what build-registry would write`);
  }
});

test("the docs and skills tell the operator who creates the login, in both languages", () => {
  for (const path of [
    join(REPO, "docs", "integrations", "trilium.md"),
    join(REPO, "docs", "es", "integrations", "trilium.md"),
  ]) {
    const doc = readFileSync(path, "utf8");
    assert.match(doc, /Settings → Passwords|Ajustes → Contraseñas/, `${path}: says where the password is kept`);
    assert.equal(
      /Complete the initial setup in the web UI|Completa la configuración inicial en la interfaz web/.test(doc),
      false,
      `${path}: no longer sends the operator to set the password by hand`,
    );
  }
  for (const path of [
    join(REPO, "docs", "integrations", "vikunja.md"),
    join(REPO, "docs", "es", "integrations", "vikunja.md"),
  ]) {
    const doc = readFileSync(path, "utf8");
    assert.match(doc, /VIKUNJA_ENABLE_REGISTRATION=false/, `${path}: says how a hand-set-up install closes registration`);
  }
  // Every converted bundle's skill says where the login now lives.
  for (const app of Object.keys(APPS)) {
    const skill = readFileSync(join(B(app), "skills", `${app}.md`), "utf8");
    assert.match(skill, /Settings → Passwords/, `${app}: the skill names where Crow keeps the login`);
  }
  // And the one that now closes registration itself says how a hand-set-up install does it.
  assert.match(readFileSync(join(B("vikunja"), "skills", "vikunja.md"), "utf8"), /VIKUNJA_ENABLE_REGISTRATION=false/);
});

test("every skill these bundles changed is in the ledger (an edited skill needs its new hash recorded)", () => {
  // `node scripts/build-skill-history.mjs` does this in CI; the copy installed on a host is
  // refreshed only when its hash is KNOWN, so a skill edit without a ledger entry would be
  // kept as if the operator had edited it.
  const ledger = JSON.parse(readFileSync(join(REPO, "bundles", "skill-history.json"), "utf8"));
  const missing = [];
  for (const id of [...Object.keys(APPS), "vikunja"]) {
    for (const path of manifestSkillPaths(manifestOf(id))) {
      const hash = skillHash(readFileSync(join(B(id), path)));
      const known = ledger[ledgerKey(id, path)] || [];
      if (!known.includes(hash)) missing.push(`${id}/${path} → ${hash}`);
    }
  }
  assert.deepEqual(missing, [], "run `node scripts/build-skill-history.mjs` for these skills");
});
// ── the python snippets themselves, run by a real interpreter (the fakes above only see words) ──

const PY = spawnSync("python3", ["--version"]).status === 0 ? "python3" : null;

test("changedetection: the settings form parser never re-sends a password input and drops the textarea's leading line break", { skip: !PY && "no python3 on this host" }, () => {
  const script = readFileSync(join(B("changedetection"), "scripts", "first-admin.sh"), "utf8");
  const cd = snippetOf(script, "CD");
  const parserPart = cd.slice(0, cd.indexOf("def opener("));
  const page = [
    '<form><input type="hidden" name="csrf_token" value="tok">',
    '<input name="application-password" type="password" value="">',
    '<input name="requests-time_between_check-minutes" type="text" value="5">',
    '<input type="checkbox" name="application-empty_pages_are_a_change" checked>',
    '<input type="checkbox" name="application-fetch_backend_off">',
    '<textarea name="application-notification_body">\r\nHello {{watch_url}}</textarea>',
    '<select name="application-fetch_backend"><option value="a">A</option><option value="b" selected>B</option></select>',
    "</form>",
  ].join("");
  const probe = `${parserPart}\nimport json\np = Fields()\np.feed(${JSON.stringify(page)})\nprint(json.dumps(p.fields))\n`;
  const r = spawnSync(PY, ["-c", probe], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const fields = JSON.parse(r.stdout.trim().split("\n").pop());
  const names = fields.map(([n]) => n);
  assert.equal(names.includes("application-password"), false, "the empty password input would shadow the real one");
  assert.deepEqual(fields.find(([n]) => n === "application-notification_body"), ["application-notification_body", "Hello {{watch_url}}"]);
  assert.equal(names.includes("application-fetch_backend_off"), false, "an unchecked checkbox is not sent");
  assert.deepEqual(fields.find(([n]) => n === "application-fetch_backend"), ["application-fetch_backend", "b"]);
  assert.deepEqual(fields.find(([n]) => n === "csrf_token"), ["csrf_token", "tok"]);
});

test("kolibri: the provisioning snippet uses 0.19.5's real functions and never provisions twice", { skip: !PY && "no python3 on this host" }, () => {
  const script = readFileSync(join(B("kolibri"), "scripts", "first-admin.sh"), "utf8");
  const provision = snippetOf(script, "PROVISION");
  const stub = mkdtempSync(join(tmpdir(), "kolibri-stub-"));
  const pkg = (rel, body) => { mkdirSync(join(stub, dirname(rel)), { recursive: true }); writeFileSync(join(stub, rel), body); };
  for (const d of ["kolibri", "kolibri/core", "kolibri/core/device", "kolibri/core/device/management", "kolibri/core/device/management/commands"]) pkg(`${d}/__init__.py`, "");
  pkg("kolibri/core/device/utils.py", [
    "import os, json",
    "def device_provisioned():",
    "    return os.environ.get('STUB_PROVISIONED') == '1'",
    "def setup_device_and_facility(*args):",
    "    open(os.environ['STUB_OUT'], 'w').write(json.dumps([len(args)]))",
  ].join("\n"));
  pkg("kolibri/core/device/management/commands/provisiondevice.py", [
    "def validate_options(o):",
    "    assert o['interactive'] is False and o['facility_settings'] == {} and o['device_settings'] == {}",
    "    return (o['facility'], o['preset'], o['superusername'], o['superuserpassword'], o['language_id'], {}, {})",
  ].join("\n"));
  try {
    const out = join(stub, "out.json");
    const fresh = spawnSync(PY, ["-c", provision], { input: `${"x".repeat(16)}\nadmin\nHome Lab\n`, encoding: "utf8", env: { ...process.env, PYTHONPATH: stub, STUB_OUT: out } });
    assert.equal(fresh.stdout.trim(), "CREATED", fresh.stderr);
    assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), [7], "setup_device_and_facility gets validate_options' seven values");
    const again = spawnSync(PY, ["-c", provision], { input: "pw\nadmin\nHome Lab\n", encoding: "utf8", env: { ...process.env, PYTHONPATH: stub, STUB_OUT: join(stub, "out2.json"), STUB_PROVISIONED: "1" } });
    assert.equal(again.stdout.trim(), "DONE");
    assert.equal(existsSync(join(stub, "out2.json")), false, "a provisioned device is never provisioned again");
  } finally { rmSync(stub, { recursive: true, force: true }); }
});

test("kolibri: the login proof gets the username first and the password second, matching prove(name, password)", () => {
  const script = readFileSync(join(B("kolibri"), "scripts", "first-admin.sh"), "utf8");
  assert.match(snippetOf(script, "HTTP"), /prove\(sys\.stdin\.readline\(\)\.rstrip\("\\n"\), sys\.stdin\.readline\(\)\.rstrip\("\\n"\)\)/);
  assert.match(script, /printf '%s\\n%s\\n' "\$ADMIN_USER" "\$PW" \| timeout 20 docker exec -i -u kolibri "\$CONTAINER" "\$PYTHON" -c "\$HTTP" prove/);
  const r = run("kolibri");
  assert.equal(r.status, 0, r.stderr);
  const proof = r.calls.filter((c) => /-c .* prove$/.test(c.argv) || c.argv.endsWith(" prove"));
  assert.ok(proof.length >= 1, "the proof ran");
  assert.equal(proof[0].stdin.split("\n")[0], "admin", "the first stdin line is the username");
});
