/**
 * N3-4 phase 2d — Crow creates the admin login for Uptime Kuma, Gitea and Forgejo, and
 * closes the git apps' open web installer.
 *
 * Each of the three bundles now ships `scripts/first-admin.sh` and declares
 * `firstAdmin: { mode: "crow", via: "setup", ... }`, so the installer runs the script once
 * after `compose up` with the generated password as ONE line on stdin. What these tests
 * hold down:
 *
 *   1. a fresh app: exit 0, the password delivered on stdin and NEVER in a docker argument
 *      (that is what a process list would show), and the login proved once,
 *   2. an app that already has its own admin: exit 3, and no create call at all,
 *   3. docker missing / the container not running: exit 4, nothing changed,
 *   4. a password the protocol refuses (short, empty): exit 1, and docker is not even asked,
 *   5. an admin username that is not a plain account name: exit 1, docker not asked either,
 *   6. an unreadable detection step: exit 4, never a change,
 *   7. a login the app never accepts after the account was created: exit 5 — for Uptime
 *      Kuma only when the app itself said it made the account with Crow's password, and for
 *      the git apps only once the app has taken Crow's password (a PATCH that answered 200,
 *      or a proof login that already worked); an account that merely appeared is never
 *      reported as 5,
 *   8. a create step whose answer the script cannot use: the app's own state is asked again,
 *      so an account that exists is proved (0, or the honest failure when its password could
 *      not be set) and one that does not is exit 1,
 *   9. the git apps: neither create carries a token flag — each mints its setup token with
 *      `admin user generate-access-token --scopes all --raw` — and the password and that
 *      token reach the API inside a curl config on stdin, never on a command line; a first
 *      attempt whose PATCH or proof fails is retried once with `crow-setup-2`, both are
 *      deleted again (named in a note when the app refuses, because its token route needs
 *      the new password), a run where both attempts fail ends at 1 naming the
 *      change-password command, the account is never deleted (the app refuses to drop its
 *      last admin), and both compose files set INSTALL_LOCK so /install is closed,
 *  10. Uptime Kuma's in-container snippets (the fake docker never runs them) say what they
 *      must: needSetup, only a real true is FRESH, res.ok === true is CREATED/LOGIN-OK, and
 *      two timers bound every run (a 15 s UNKNOWN and an unconditional exit),
 *  11. nothing inside a container may outlive the protocol timeout: every curl config
 *      carries max-time, every wait loop is a $SECONDS budget inside the manifest's
 *      timeout_s, and the health probe is bounded as well,
 *  12. the three manifests carry what the contract, the runner and the card need (including
 *      the note that self-registration turns off at an existing install's next restart), and
 *      the generated registry carries the same declarations.
 *
 * No docker here: a `docker` executable written into a temp dir sits first on PATH, records
 * every argv and the stdin it received, and replays canned answers. The scripts only ever
 * reach a container through `docker exec`/`inspect`.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import vm from "node:vm";
import { validateManifest } from "../scripts/lib/bundle-contract.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const B = (id) => join(REPO, "bundles", id);

/** A generated-password-shaped value: URL- and shell-safe, 22 characters. */
const PASSWORD = "gen-Secret_ABC123xy-z45";
/** The 40-hex token shape both git apps hand back. */
const TOKEN = "0123456789abcdef0123456789abcdef01234567";

const TMP = mkdtempSync(join(tmpdir(), "crow-fa-scripts-3-"));
const BIN = join(TMP, "bin");
const NO_DOCKER = join(TMP, "no-docker");
/** By absolute path: the "no docker at all" case runs the script with an empty PATH. */
const BASH = existsSync("/bin/bash") ? "/bin/bash" : "bash";
mkdirSync(BIN, { recursive: true });
mkdirSync(NO_DOCKER, { recursive: true });

/** Gitea's own `admin user list` table: a header and no data rows means no admin yet. */
const HEADER = "ID   Username   Email   IsActive   IsAdmin";
const ROW = "1    someone    someone@localhost.localdomain    true    true";
/** What the second look after a create finds: the account the create just made. */
const CROW_ROW = "1    crow-admin    crow-admin@localhost.localdomain    true    true";

/**
 * The stand-in docker. Every call is recorded as `<dir>/call.<n>.argv` (the arguments
 * joined by spaces) plus `<dir>/call.<n>.stdin`, and answered from `FAKE_<KEY>_<i>` env
 * vars — the i-th answer for that KEY, falling back to the KEY's default. An answer of
 * `<<exit1>>` makes the call fail, which is how an app that refuses the CLI is played.
 * The defaults that are not a single word (the two shapes of the admin user list, the raw
 * token a mint prints) come in as `FAKE_LIST_FRESH` / `FAKE_LIST_EXISTS` / `FAKE_TOKEN`,
 * written by run(). `GEN_TOKEN` is shared by both apps: only one of them runs per run.
 */
const FAKE_DOCKER = [
  "#!/usr/bin/env bash",
  "set -uo pipefail",
  'dir="$FAKE_DOCKER_DIR"',
  "n=0",
  'while [ -f "$dir/call.$n.argv" ]; do n=$((n + 1)); done',
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
  "# nextd KEY FIRST LATER: like next, but the first call of KEY gets FIRST and every",
  "# later one LATER. The admin user list is the one step asked twice in a run (before and",
  "# after the create), and the second look finds the account the create just made.",
  "nextd() {",
  '  local key="$1" first="$2" later="$3" cf="$dir/counter.$1" i=0',
  '  if [ -f "$cf" ]; then i=$(cat "$cf"); fi',
  '  printf "%s\\n" "$((i + 1))" > "$cf"',
  '  local var="FAKE_${key}_${i}"',
  '  if [ -n "${!var+x}" ]; then NEXT="${!var}"; elif [ "$i" = "0" ]; then NEXT="$first"; else NEXT="$later"; fi',
  "}",
  "# emit: the answer as stdout; <<exit1>> is a call that failed instead.",
  "emit() {",
  '  if [ "$NEXT" = "<<exit1>>" ]; then exit 1; fi',
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
  'args="$*"',
  // The wildcards stay UNQUOTED (a fully quoted pattern matches its asterisks literally);
  // only the spaces inside a multi-word command are quoted.
  'case "$args" in',
  // ── Gitea: the API calls first (they are told apart by their URL), then the CLI.
  //    The token mint comes before the DELETE branch: both name a token, only one mints.
  '  *crow-gitea*"admin user generate-access-token"*) next GEN_TOKEN "${FAKE_TOKEN:-}"; emit ;;',
  '  *crow-gitea*tokens/*) next GITEA_DELETE 204; emit ;;',
  '  *crow-gitea*admin/users/*) next GITEA_PATCH 200; emit ;;',
  '  *crow-gitea*"admin user create"*) next GITEA_CREATE "New user crow-admin has been successfully created!"; emit ;;',
  '  *crow-gitea*"admin user list"*) nextd GITEA_STATE "${FAKE_LIST_FRESH:-}" "${FAKE_LIST_EXISTS:-}"; emit ;;',
  '  *crow-gitea*api/healthz*) next GITEA_UP 0; exit "$NEXT" ;;',
  '  *crow-gitea*api/v1/user*) next GITEA_LOGIN 200; emit ;;',
  // ── Forgejo: the same shape (its token is minted separately too, with scopes). ─────
  '  *crow-forgejo*"admin user generate-access-token"*) next GEN_TOKEN "${FAKE_TOKEN:-}"; emit ;;',
  '  *crow-forgejo*tokens/*) next FORGEJO_DELETE 204; emit ;;',
  '  *crow-forgejo*admin/users/*) next FORGEJO_PATCH 200; emit ;;',
  '  *crow-forgejo*"admin user create"*) next FORGEJO_CREATE "New user crow-admin has been successfully created!"; emit ;;',
  '  *crow-forgejo*"admin user list"*) nextd FORGEJO_STATE "${FAKE_LIST_FRESH:-}" "${FAKE_LIST_EXISTS:-}"; emit ;;',
  '  *crow-forgejo*api/healthz*) next FORGEJO_UP 0; exit "$NEXT" ;;',
  '  *crow-forgejo*api/v1/user*) next FORGEJO_LOGIN 200; emit ;;',
  // ── Uptime Kuma: the login proof mentions "login", the health check is its own script,
  //    and detect/create are told apart by the stdin pipe (-i is the create). ──────────
  '  *crow-uptime-kuma*login*) next KUMA_LOGIN "LOGIN-OK"; emit ;;',
  '  *crow-uptime-kuma*healthcheck*) next KUMA_UP 0; exit "$NEXT" ;;',
  '  *crow-uptime-kuma*needSetup*)',
  '    if [[ " $args " == *" -i "* ]]; then next KUMA_CREATE "CREATED"; else next KUMA_STATE "FRESH"; fi',
  "    emit ;;",
  '  *) printf "fake docker: no answer for: %s\\n" "$args" >&2; exit 98 ;;',
  "esac",
  "",
].join("\n");
writeFileSync(join(BIN, "docker"), FAKE_DOCKER, { mode: 0o755 });
// The harness is bash too: a syntax error in it looks exactly like an app that never
// answers, so it is checked before anything relies on it.
test("the stand-in docker is valid bash", () => {
  const parsed = spawnSync(BASH, ["-n", join(BIN, "docker")], { encoding: "utf8" });
  assert.equal(parsed.status, 0, parsed.stderr);
});

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

/** Run a bundle's setup script with the password on stdin, as the installer does. */
function run(bundle, { password = `${PASSWORD}\n`, env = {}, withDocker = true } = {}) {
  const callsDir = mkdtempSync(join(TMP, "calls-"));
  const cwd = mkdtempSync(join(TMP, "cwd-"));
  const res = spawnSync(BASH, [join(B(bundle), "scripts", "first-admin.sh")], {
    input: password,
    encoding: "utf8",
    timeout: 20_000,
    cwd,
    env: {
      PATH: withDocker ? `${BIN}:/usr/bin:/bin` : `${NO_DOCKER}`,
      HOME: TMP,
      CROW_FIRST_ADMIN_USER: "crow-admin",
      FAKE_DOCKER_DIR: callsDir,
      // The defaults the stand-in docker replays for the app's own output: an empty admin
      // user list (fresh), the same list with the account Crow just made (after a create),
      // and a raw token for a mint.
      FAKE_LIST_FRESH: HEADER,
      FAKE_LIST_EXISTS: `${HEADER}\n${CROW_ROW}`,
      FAKE_TOKEN: TOKEN,
      ...env,
    },
  });
  return { status: res.status, stdout: res.stdout || "", stderr: res.stderr || "", calls: readCalls(callsDir) };
}

const argvText = (r) => r.calls.map((c) => c.argv).join("\n");
const stdinText = (r) => r.calls.map((c) => c.stdin).join("\n");
const count = (r, needle) => r.calls.filter((c) => c.argv.includes(needle)).length;

/**
 * Every `key = "value"` line of a curl config, unescaped exactly as curl reads it (`\\`
 * and `\"`), so a test sees the value curl would hand the app — not the bytes on the pipe.
 * Repeated keys (two `header` lines) are kept in order.
 */
function configLines(text) {
  const out = [];
  for (const line of String(text).split("\n")) {
    const m = /^([A-Za-z]+) = "(.*)"$/.exec(line);
    if (m) out.push({ key: m[1], value: m[2].replace(/\\(.)/g, "$1") });
  }
  return out;
}
const configValue = (text, key) => (configLines(text).find((l) => l.key === key) || {}).value;

/** What each app's "detect", "create" and "prove" steps look like inside `docker exec`. */
const APP = {
  "uptime-kuma": {
    container: "crow-uptime-kuma",
    stateKey: "KUMA_STATE",
    stateMarker: "needSetup",
    createKey: "KUMA_CREATE",
    loginKey: "KUMA_LOGIN",
    // detect and create share the same snippet text; only the create gets stdin.
    createRan: (r) => r.calls.some((c) => c.argv.includes("needSetup") && ` ${c.argv} `.includes(" -i ")),
    detectCalls: (r) => r.calls.filter((c) => c.argv.includes("needSetup") && !` ${c.argv} `.includes(" -i ")).length,
    proveCalls: (r) => count(r, "login"),
    unreadable: ["", "UNKNOWN", "SOMETHING-ELSE"],
  },
  gitea: {
    container: "crow-gitea",
    stateKey: "GITEA_STATE",
    stateMarker: "admin user list",
    createKey: "GITEA_CREATE",
    loginKey: "GITEA_LOGIN",
    createRan: (r) => count(r, "admin user create") > 0,
    detectCalls: (r) => count(r, "admin user list"),
    // "/api/v1/user" is the login proof; the DELETE URL starts with "/api/v1/users".
    proveCalls: (r) => r.calls.filter((c) => c.argv.endsWith("/api/v1/user")).length,
    unreadable: ["", "<<exit1>>", "SOMETHING-ELSE", ROW],
  },
  forgejo: {
    container: "crow-forgejo",
    stateKey: "FORGEJO_STATE",
    stateMarker: "admin user list",
    createKey: "FORGEJO_CREATE",
    loginKey: "FORGEJO_LOGIN",
    createRan: (r) => count(r, "admin user create") > 0,
    detectCalls: (r) => count(r, "admin user list"),
    proveCalls: (r) => r.calls.filter((c) => c.argv.endsWith("/api/v1/user")).length,
    unreadable: ["", "<<exit1>>", "SOMETHING-ELSE", ROW],
  },
};
const APPS = Object.keys(APP);

/** The whole point: the password is on a pipe, never in a command line, never printed. */
function assertPasswordStayedOutOfSight(r, password = PASSWORD) {
  assert.equal(argvText(r).includes(password), false, "no docker argument may carry the password");
  assert.equal(String(r.stdout).includes(password), false, "the script must not print the password");
  assert.equal(String(r.stderr).includes(password), false, "the script must not print the password");
}

/** The body of one embedded js snippet (`DETECT='…'`), as the script carries it. */
function snippet(script, name) {
  const m = new RegExp(`^${name}='([\\s\\S]*?)'$`, "m").exec(script);
  assert.ok(m, `${name} snippet is in the script`);
  return m[1];
}

// ── every app: fresh install ────────────────────────────────────────────────────────

for (const app of APPS) {
  const a = APP[app];

  test(`${app}: a fresh install gets the generated password, delivered on stdin only`, () => {
    const r = run(app);
    assert.equal(r.status, 0, r.stderr);
    assertPasswordStayedOutOfSight(r);
    assert.equal(r.calls[0].argv.startsWith("inspect"), true, "the container is checked before it is touched");
    assert.equal(r.calls[0].argv.includes(a.container), true, "and the app's own container is the one named");
    assert.equal(a.createRan(r), true, "the account is created with the app's own tooling");
    assert.equal(stdinText(r).includes(PASSWORD), true, "the password arrived on a pipe");
    assert.equal(a.proveCalls(r), 1, "the new login is proved once");
  });

  test(`${app}: an install that already has its own admin is left alone (exit 3)`, () => {
    const r = run(app, { env: { [`FAKE_${a.stateKey}_0`]: app === "uptime-kuma" ? "EXISTS" : `${HEADER}\n${ROW}` } });
    assert.equal(r.status, 3, r.stderr);
    assert.match(r.stderr, /already has an admin/);
    assert.equal(a.createRan(r), false, "no account may be created");
    assert.equal(a.proveCalls(r), 0, "nothing to prove");
  });

  test(`${app}: a container that is not running, or no docker at all, is exit 4`, () => {
    const stopped = run(app, { env: { FAKE_RUNNING_0: "false" } });
    assert.equal(stopped.status, 4, stopped.stderr);
    assert.equal(stopped.calls.length, 1, "only the state check ran");
    const noDocker = run(app, { withDocker: false });
    assert.equal(noDocker.status, 4);
    assert.equal(noDocker.calls.length, 0);
  });

  test(`${app}: a password the protocol refuses never reaches docker`, () => {
    for (const password of ["", "\n", "short-pass\n"]) {
      const r = run(app, { password });
      assert.equal(r.status, 1, JSON.stringify(password));
      assert.equal(r.calls.length, 0, `${JSON.stringify(password)}: docker was not called`);
    }
  });

  test(`${app}: an admin username that is not a plain account name is refused before anything runs`, () => {
    for (const user of ['crow"admin', "crow admin", "", "crow-admin;rm -rf /"]) {
      const r = run(app, { env: { CROW_FIRST_ADMIN_USER: user } });
      assert.equal(r.status, 1, JSON.stringify(user));
      assert.equal(r.calls.length, 0, `${JSON.stringify(user)}: docker was not called`);
    }
  });

  test(`${app}: a detection step that answers with nothing usable changes nothing (exit 4)`, () => {
    for (const answer of a.unreadable) {
      const env = { [`FAKE_${a.stateKey}_0`]: answer };
      const r = run(app, { env });
      assert.equal(r.status, 4, `${JSON.stringify(answer)}: ${r.stderr}`);
      assert.match(r.stderr, /could not be read; nothing was changed/);
      assert.equal(a.createRan(r), false, `${JSON.stringify(answer)}: no create`);
      assert.equal(a.proveCalls(r), 0, `${JSON.stringify(answer)}: no proof`);
    }
  });

  test(`${app}: a login the app never accepts after the create is kept, not thrown away (exit 5)`, () => {
    const env = {
      [`FAKE_${a.loginKey}_0`]: app === "uptime-kuma" ? "LOGIN-FAIL" : "401",
      [`FAKE_${a.loginKey}_1`]: app === "uptime-kuma" ? "LOGIN-FAIL" : "401",
      [`FAKE_${a.loginKey}_2`]: app === "uptime-kuma" ? "LOGIN-FAIL" : "401",
    };
    const r = run(app, { env });
    assert.equal(r.status, 5, r.stderr);
    assert.match(r.stderr, /accepted the new password, but logging in with it did not succeed/);
    assert.equal(a.proveCalls(r), 3, "the proof is retried three times");
    assert.equal(a.createRan(r), true, "the account really was created before the proof");
    assertPasswordStayedOutOfSight(r);
  });
}

// ── Uptime Kuma: a create the script cannot read is re-checked, not thrown away ─────

test("uptime-kuma: an unclear create whose account appeared is proved (0), and one Crow did not set is exit 1", () => {
  for (const answer of ["UNKNOWN", "REFUSED"]) {
    const created = run("uptime-kuma", { env: { FAKE_KUMA_CREATE_0: answer, FAKE_KUMA_STATE_1: "EXISTS" } });
    assert.equal(created.status, 0, `${answer}: ${created.stderr}`);
    assert.equal(APP["uptime-kuma"].detectCalls(created), 2, `${answer}: the app's own state is asked a second time`);
    assert.equal(APP["uptime-kuma"].proveCalls(created), 1, `${answer}: and the new login is proved`);

    // The proof fails: the account that is there may be somebody else's, made between the
    // create attempts. Nothing of Crow's was saved, so this is exit 1 — never 5.
    const unproved = run("uptime-kuma", {
      env: {
        FAKE_KUMA_CREATE_0: answer,
        FAKE_KUMA_STATE_1: "EXISTS",
        FAKE_KUMA_LOGIN_0: "LOGIN-FAIL",
        FAKE_KUMA_LOGIN_1: "LOGIN-FAIL",
        FAKE_KUMA_LOGIN_2: "LOGIN-FAIL",
      },
    });
    assert.equal(unproved.status, 1, `${answer}: ${unproved.stderr}`);
    assert.match(unproved.stderr, /An account appeared in Uptime Kuma that Crow did not set; nothing of Crow's was saved/);
    assert.match(unproved.stderr, /Check Uptime Kuma's own users/);
    assert.doesNotMatch(unproved.stderr, /accepted the new password/, `${answer}: Crow must not claim the app took its password`);
    assertPasswordStayedOutOfSight(unproved);
  }
});

test("uptime-kuma: only a CREATED answer can end in exit 5", () => {
  // The app said it made the account with Crow's password, so a login that never works is
  // kept and reported as 5 — that is the one path where 5 is honest.
  const made = run("uptime-kuma", {
    env: { FAKE_KUMA_CREATE_0: "CREATED", FAKE_KUMA_LOGIN_0: "LOGIN-FAIL", FAKE_KUMA_LOGIN_1: "LOGIN-FAIL", FAKE_KUMA_LOGIN_2: "LOGIN-FAIL" },
  });
  assert.equal(made.status, 5, made.stderr);
  assert.match(made.stderr, /accepted the new password, but logging in with it did not succeed/);
  assert.equal(APP["uptime-kuma"].proveCalls(made), 3);

  // REFUSED and UNKNOWN, even when an account exists afterwards, never reach 5.
  for (const answer of ["REFUSED", "UNKNOWN"]) {
    const r = run("uptime-kuma", {
      env: {
        FAKE_KUMA_CREATE_0: answer,
        FAKE_KUMA_STATE_1: "EXISTS",
        FAKE_KUMA_LOGIN_0: "LOGIN-FAIL",
        FAKE_KUMA_LOGIN_1: "LOGIN-FAIL",
        FAKE_KUMA_LOGIN_2: "LOGIN-FAIL",
      },
    });
    assert.notEqual(r.status, 5, `${answer}: exit 5 is only for an account Crow created`);
    assert.equal(r.status, 1, `${answer}: ${r.stderr}`);
  }
  assertPasswordStayedOutOfSight(made);
});

test("uptime-kuma: an unclear create with nothing there changes nothing, and an unreadable second look is exit 1", () => {
  const fresh = run("uptime-kuma", { env: { FAKE_KUMA_CREATE_0: "UNKNOWN" } });
  assert.equal(fresh.status, 1, fresh.stderr);
  assert.match(fresh.stderr, /did not create the account; nothing was changed/);
  assert.equal(APP["uptime-kuma"].proveCalls(fresh), 0, "no proof when no account was made");

  const unreadable = run("uptime-kuma", { env: { FAKE_KUMA_CREATE_0: "UNKNOWN", FAKE_KUMA_STATE_1: "UNKNOWN" } });
  assert.equal(unreadable.status, 1, unreadable.stderr);
  assert.match(unreadable.stderr, /own user list before trying again/);
  assert.equal(APP["uptime-kuma"].proveCalls(unreadable), 0);
  assertPasswordStayedOutOfSight(unreadable);
});

// ── Gitea / Forgejo: the password and the token go through a curl config on stdin ────

for (const app of ["gitea", "forgejo"]) {
  const a = APP[app];
  const patchKey = app === "gitea" ? "GITEA_PATCH" : "FORGEJO_PATCH";
  const stateKey = app === "gitea" ? "GITEA_STATE" : "FORGEJO_STATE";
  const deleteKey = app === "gitea" ? "GITEA_DELETE" : "FORGEJO_DELETE";

  test(`${app}: the PATCH config carries the password and the token on stdin, and its argv carries neither`, () => {
    const r = run(app);
    assert.equal(r.status, 0, r.stderr);
    const patch = r.calls.find((c) => c.argv.includes("/api/v1/admin/users/"));
    assert.ok(patch, "the password is set through the admin users API");
    assert.equal(configValue(patch.stdin, "request"), "PATCH", "the method is set in the config, not an argument");
    assert.deepEqual(
      configLines(patch.stdin).filter((l) => l.key === "header").map((l) => l.value),
      [`Authorization: token ${TOKEN}`, "Content-Type: application/json"],
      "the setup token reaches curl on the pipe",
    );
    // Read back the way curl does — one unescape — and the API's body is exactly this JSON.
    assert.deepEqual(JSON.parse(configValue(patch.stdin, "data")), {
      login_name: "crow-admin",
      source_id: 0,
      password: PASSWORD,
      must_change_password: false,
    });
    assert.equal(patch.argv.includes(TOKEN), false, "the token is never an argument");
    assert.equal(patch.argv.includes("PATCH"), false, "and the method is set in the config, not an argument");
    assertPasswordStayedOutOfSight(r);
  });

  test(`${app}: a password with a quote and a backslash still arrives as the same password`, () => {
    // curl ends a double-quoted config value at the first unescaped quote, so the body needs
    // two layers of escaping; the fake docker cannot run curl, so the config is read back here.
    const tricky = 'gen-"Bc\\k_12x-Yz';
    const r = run(app, { password: `${tricky}\n` });
    assert.equal(r.status, 0, r.stderr);
    const patch = r.calls.find((c) => c.argv.includes("/api/v1/admin/users/"));
    assert.equal(JSON.parse(configValue(patch.stdin, "data")).password, tricky);
    const proof = r.calls.find((c) => c.argv.endsWith("/api/v1/user"));
    assert.equal(configValue(proof.stdin, "user"), `crow-admin:${tricky}`, "basic auth carries it unchanged");
    const del = r.calls.find((c) => c.argv.includes("/tokens/crow-setup"));
    assert.equal(configValue(del.stdin, "user"), `crow-admin:${tricky}`, "and so does the token cleanup");
    assertPasswordStayedOutOfSight(r, tricky);
  });

  test(`${app}: the setup token is deleted again once the password is set`, () => {
    const r = run(app);
    const del = r.calls.find((c) => c.argv.includes("/tokens/crow-setup"));
    assert.ok(del, "the token this script minted is removed");
    assert.match(del.stdin, /request = "DELETE"/);
    assert.match(del.stdin, /^user = "crow-admin:/m, "with basic auth naming the new login");
    const patchIndex = r.calls.findIndex((c) => c.argv.includes("/api/v1/admin/users/"));
    assert.equal(r.calls.indexOf(del) > patchIndex, true, "removed after the password was set");
    assert.equal(r.calls.indexOf(del) < r.calls.findIndex((c) => c.argv.endsWith("/api/v1/user")), true, "and before the proof");
  });

  test(`${app}: a token that could not be deleted is a note, never a failure`, () => {
    const r = run(app, { env: { [`FAKE_${deleteKey}_0`]: "404" } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Note: remove the temporary setup token\(s\) crow-setup from /);
    assertPasswordStayedOutOfSight(r);
  });

  test(`${app}: a PATCH that does not say 200 is settled by one login attempt with the real password`, () => {
    // The answer was not 200, but the app took the password: the proof login decides, so a
    // second token is not spent.
    const written = run(app, { env: { [`FAKE_${patchKey}_0`]: "500" } });
    assert.equal(written.status, 0, written.stderr);
    assert.equal(count(written, "generate-access-token"), 1, "one token, and no retry");
    assert.equal(count(written, "/tokens/"), 1, "and it is still cleaned up");
    assert.equal(a.proveCalls(written), 2, "the login that settled the answer, then the final proof");
  });

  test(`${app}: a first attempt that fails twice over is retried once with crow-setup-2`, () => {
    const r = run(app, { env: { [`FAKE_${patchKey}_0`]: "500", [`FAKE_${a.loginKey}_0`]: "401" } });
    assert.equal(r.status, 0, r.stderr);
    const mints = r.calls.filter((c) => c.argv.includes("generate-access-token"));
    assert.equal(mints.length, 2, "a fresh token per attempt");
    assert.match(mints[1].argv, /--token-name crow-setup-2/);
    assert.equal(
      r.calls.filter((c) => c.argv.includes("/api/v1/admin/users/")).length,
      2,
      "the second attempt really PATCHed again",
    );
    const dels = r.calls.filter((c) => c.argv.includes("/tokens/"));
    assert.deepEqual(
      dels.map((c) => c.argv.slice(c.argv.indexOf("/tokens/") + "/tokens/".length)),
      ["crow-setup", "crow-setup-2"],
      "both tokens are removed, the retry's included",
    );
    assert.equal(r.stdout.includes("temporary setup token"), false, "both went, so none is named in a note");
    assert.equal(a.proveCalls(r), 2, "the failed attempt's proof, then the one that ends the run");
    assertPasswordStayedOutOfSight(r);
  });

  test(`${app}: with both attempts failing the run ends at 1 naming change-password, and the note names both tokens`, () => {
    const r = run(app, {
      env: {
        [`FAKE_${patchKey}_0`]: "500",
        [`FAKE_${patchKey}_1`]: "500",
        [`FAKE_${a.loginKey}_0`]: "401",
        [`FAKE_${a.loginKey}_1`]: "401",
        // The password was never set, so the token routes refuse the basic auth: the app
        // itself is why both tokens are left behind.
        [`FAKE_${deleteKey}_0`]: "401",
        [`FAKE_${deleteKey}_1`]: "401",
      },
    });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /created the admin account 'crow-admin', but Crow could not set its password/);
    assert.match(
      r.stderr,
      new RegExp(`Set one with '${app} admin user change-password --username crow-admin' inside the container`),
      "the operator is told how to set a password they can keep",
    );
    assert.match(r.stderr, /then save that login on the Extensions card/);
    assert.match(r.stdout, /Note: remove the temporary setup token\(s\) crow-setup crow-setup-2 from /);
    assert.equal(r.stdout.includes(TOKEN), false, "only the token names are ever printed");
    assert.equal(count(r, "admin user delete"), 0, "the account stays: the app refuses to delete its last admin");
    assert.equal(a.proveCalls(r), 2, "one proof per attempt");
    assertPasswordStayedOutOfSight(r);
  });

  test(`${app}: a mint that prints nothing usable fails that attempt without a PATCH`, () => {
    for (const answer of ["", "not a token!"]) {
      const r = run(app, { env: { FAKE_GEN_TOKEN_0: answer, [`FAKE_${a.loginKey}_0`]: "401" } });
      assert.equal(r.status, 0, `${JSON.stringify(answer)}: ${r.stderr}`);
      const mints = r.calls.filter((c) => c.argv.includes("generate-access-token"));
      assert.equal(mints.length, 2, `${JSON.stringify(answer)}: the run went on to crow-setup-2`);
      assert.match(mints[1].argv, /--token-name crow-setup-2/);
      const patches = r.calls.filter((c) => c.argv.includes("/api/v1/admin/users/"));
      assert.equal(patches.length, 1, `${JSON.stringify(answer)}: the unusable token never reached the API`);
      assert.equal(
        r.calls.indexOf(patches[0]) > r.calls.indexOf(mints[1]),
        true,
        `${JSON.stringify(answer)}: the only PATCH is the second attempt's`,
      );
      const dels = r.calls.filter((c) => c.argv.includes("/tokens/"));
      assert.equal(dels.length, 1, `${JSON.stringify(answer)}: the first attempt minted nothing, so nothing is named for removal`);
      assert.match(dels[0].argv, /crow-setup-2$/);
      assertPasswordStayedOutOfSight(r);
    }
  });

  test(`${app}: a create whose second look is FRESH ends at 1, with no token minted`, () => {
    const r = run(app, { env: { [`FAKE_${stateKey}_1`]: HEADER } });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /did not create the account; nothing was changed/);
    assert.equal(count(r, "admin user create"), 1, "the create really was attempted");
    assert.equal(count(r, "generate-access-token"), 0, "no token for an account that is not there");
    assert.equal(a.proveCalls(r), 0);
    assertPasswordStayedOutOfSight(r);

    // A second look that cannot be read is not "fresh" either: the operator is told to look.
    const unreadable = run(app, { env: { [`FAKE_${stateKey}_1`]: "SOMETHING-ELSE" } });
    assert.equal(unreadable.status, 1, unreadable.stderr);
    assert.match(unreadable.stderr, /own user list before trying again/);
    assert.equal(count(unreadable, "generate-access-token"), 0);
    assert.equal(a.proveCalls(unreadable), 0);
    assertPasswordStayedOutOfSight(unreadable);
  });

  test(`${app}: no run deletes the account on any path`, () => {
    const runs = [
      run(app),
      run(app, { env: { [`FAKE_${stateKey}_0`]: `${HEADER}\n${ROW}` } }),
      run(app, { env: { [`FAKE_${stateKey}_1`]: HEADER } }),
      run(app, {
        env: {
          [`FAKE_${patchKey}_0`]: "500",
          [`FAKE_${patchKey}_1`]: "500",
          [`FAKE_${a.loginKey}_0`]: "401",
          [`FAKE_${a.loginKey}_1`]: "401",
          [`FAKE_${deleteKey}_0`]: "401",
          [`FAKE_${deleteKey}_1`]: "401",
        },
      }),
    ];
    for (const r of runs) {
      assert.equal(argvText(r).includes("user delete"), false, "the app refuses to drop its last admin, so nothing tries");
    }
  });

  test(`${app}: the password and both token values stay out of every argument`, () => {
    // The second mint prints a different token, so a leak of either one is visible.
    const TOKEN_2 = "fedcba9876543210fedcba9876543210fedcba98";
    const r = run(app, {
      env: { [`FAKE_${patchKey}_0`]: "500", [`FAKE_${a.loginKey}_0`]: "401", FAKE_GEN_TOKEN_1: TOKEN_2 },
    });
    assert.equal(r.status, 0, r.stderr);
    const patches = r.calls.filter((c) => c.argv.includes("/api/v1/admin/users/"));
    assert.equal(patches.length, 2);
    const authHeader = (call) => (configLines(call.stdin).find((l) => l.key === "header") || {}).value;
    assert.equal(authHeader(patches[0]), `Authorization: token ${TOKEN}`, "the first attempt's token, on a pipe");
    assert.equal(authHeader(patches[1]), `Authorization: token ${TOKEN_2}`, "the retry's own token, on a pipe");
    for (const secret of [PASSWORD, TOKEN, TOKEN_2]) {
      assert.equal(argvText(r).includes(secret), false, "no docker argument may carry it");
      assert.equal(r.stdout.includes(secret), false, "the script must not print it");
      assert.equal(r.stderr.includes(secret), false, "the script must not print it");
    }
    assert.equal(stdinText(r).includes(PASSWORD), true, "the password travels on the pipe");
    assert.equal(stdinText(r).includes(TOKEN), true);
    assert.equal(stdinText(r).includes(TOKEN_2), true);
  });

  test(`${app}: the login proof is a plain GET /api/v1/user with basic auth from the config`, () => {
    const r = run(app);
    const proof = r.calls.find((c) => c.argv.endsWith("/api/v1/user"));
    assert.ok(proof, "the proof asks the API who the caller is");
    assert.match(proof.stdin, /^user = "crow-admin:/m);
    assert.equal(proof.stdin.includes(PASSWORD), true, "the password arrives on the pipe");
    assert.equal(proof.argv.includes(PASSWORD), false);
  });
}

// ── Gitea / Forgejo: what the create and the mint themselves carry ────────────────

test("gitea/forgejo: the create carries no token flag, only the account's own fields", () => {
  for (const app of ["gitea", "forgejo"]) {
    const r = run(app);
    assert.equal(r.status, 0, `${app}: ${r.stderr}`);
    const create = r.calls.find((c) => c.argv.includes("admin user create"));
    assert.ok(create, `${app}: the account is made with the app's own CLI`);
    assert.match(create.argv, /--admin/);
    assert.match(create.argv, /--username crow-admin/);
    assert.match(create.argv, /--email crow-admin@localhost\.localdomain/);
    assert.match(create.argv, /--random-password/, `${app}: the CLI mints the throwaway password itself`);
    assert.match(create.argv, /--must-change-password=false/, `${app}: the login works on the first try`);
    assert.equal(create.argv.includes("--access-token"), false, `${app}: no token flag at create time`);
    assert.equal(create.argv.includes("--token-name"), false, `${app}: and none of the token-name shape`);
    assert.equal(create.argv.includes("scopes"), false, `${app}: scopes belong to the mint, not the create`);
    assert.equal(create.stdin, "", `${app}: nothing is written to its stdin`);
    assert.equal(create.argv.includes(PASSWORD), false, `${app}: and the password is not an argument`);
  }
});

test("gitea/forgejo: the setup token is minted by its own command, with --scopes all --raw", () => {
  for (const app of ["gitea", "forgejo"]) {
    const r = run(app);
    const mint = r.calls.find((c) => c.argv.includes("generate-access-token"));
    assert.ok(mint, `${app}: the token is minted separately`);
    assert.match(mint.argv, /--username crow-admin/);
    assert.match(mint.argv, /--token-name crow-setup/);
    assert.match(mint.argv, /--scopes all/, `${app}: without scopes the admin API answers 403`);
    assert.match(mint.argv, /--raw/, `${app}: and the token is printed bare, so it can be parsed`);
    assert.equal(mint.stdin, "", `${app}: the CLI needs nothing on stdin`);
  }
});

// ── the web installer is closed in both compose files ──────────────────────────────

for (const [app, key] of [["gitea", "GITEA__security__INSTALL_LOCK"], ["forgejo", "FORGEJO__security__INSTALL_LOCK"]]) {
  test(`${app}: the compose file locks the installer, so /install answers nothing`, () => {
    const compose = readFileSync(join(B(app), "docker-compose.yml"), "utf8");
    assert.match(compose, new RegExp(`^\\s*-\\s*${key}=true$`, "m"), "INSTALL_LOCK is set for this app");
    const manifest = JSON.parse(readFileSync(join(B(app), "manifest.json"), "utf8"));
    assert.deepEqual(manifest.refreshFiles, ["docker-compose.yml"], "an existing install receives the new compose file");
    assert.equal(
      manifest.docker.composefile,
      "docker-compose.yml",
      "and refreshFiles names the compose file the manifest declares",
    );
  });
}

// ── Uptime Kuma: what the snippets themselves do (the fake docker never runs them) ──

test("uptime-kuma: every snippet is one status word, printed once, then the process exits", () => {
  const script = readFileSync(join(B("uptime-kuma"), "scripts", "first-admin.sh"), "utf8");
  for (const name of ["DETECT", "CREATE", "PROVE"]) {
    const code = snippet(script, name);
    assert.equal(/process\.exit\(0\)/.test(code), true, `${name}: the snippet ends the process itself`);
    assert.equal(code.includes('process.stdout.write(word + "\\n"'), true, `${name}: one line, flushed before the exit`);
    assert.equal(code.includes("setTimeout(() => finish(\"UNKNOWN\"), 15000)"), true, `${name}: a bounded wait, never a hang`);
    assert.equal(
      code.includes("setTimeout(() => process.exit(1), 20000)"),
      true,
      `${name}: and an unconditional exit behind it, so the docker exec cannot outlive ~20 s`,
    );
    assert.equal(code.includes("connect_error"), true, `${name}: a socket that cannot connect is UNKNOWN, not a crash`);
    // A syntax error inside the container would be a silent UNKNOWN, so compile it here.
    assert.doesNotThrow(() => new vm.Script(code), `${name}: the snippet parses`);
  }
  const detect = snippet(script, "DETECT");
  assert.match(detect, /sock\.emit\("needSetup"/);
  assert.match(detect, /if \(v === true\) finish\("FRESH"\)/, "only a real true means the instance is unclaimed");
  assert.match(detect, /else if \(v === false\) finish\("EXISTS"\)/);
  assert.match(detect, /else finish\("UNKNOWN"\)/, "anything else is UNKNOWN (the shell exits 4)");

  const create = snippet(script, "CREATE");
  assert.match(create, /sock\.emit\("needSetup"/, "the create re-checks in the same connection");
  assert.match(create, /if \(v === false\) finish\("EXISTS"\)/, "an account made in between is left alone");
  assert.match(create, /sock\.emit\("setup", user, password,/);
  assert.match(create, /if \(res && res\.ok === true\) finish\("CREATED"\)/);
  assert.match(create, /else if \(res && res\.ok === false\) finish\("REFUSED"\)/);
  assert.match(create, /lines\[0\]/, "the username is the first stdin line");
  assert.match(create, /lines\[1\]/, "the password is the second");

  const prove = snippet(script, "PROVE");
  assert.match(prove, /sock\.emit\("login", \{ username: user, password: password, token: "" \}/);
  assert.match(prove, /if \(res && res\.ok === true\) finish\("LOGIN-OK"\)/);
  assert.match(prove, /else finish\("LOGIN-FAIL"\)/);
});

test("uptime-kuma: the wait uses the image's own health check, the same one the compose file runs", () => {
  const compose = readFileSync(join(B("uptime-kuma"), "docker-compose.yml"), "utf8");
  assert.match(compose, /test: \["CMD", "node", "\/app\/extra\/healthcheck\.js"\]/);
  const script = readFileSync(join(B("uptime-kuma"), "scripts", "first-admin.sh"), "utf8");
  assert.match(script, /docker exec "\$CONTAINER" timeout 10 node \/app\/extra\/healthcheck\.js/);
});

test("the git apps wait on the same in-container health URL their compose file uses", () => {
  for (const app of ["gitea", "forgejo"]) {
    const compose = readFileSync(join(B(app), "docker-compose.yml"), "utf8");
    const testLine = compose.split("\n").find((l) => /^\s*test:\s*\[/.test(l)) || "";
    const probe = /http:\/\/localhost:(\d+)\/api\/healthz/.exec(testLine);
    assert.ok(probe, `${app}: the compose healthcheck carries a URL`);
    const script = readFileSync(join(B(app), "scripts", "first-admin.sh"), "utf8");
    assert.equal(script.includes(`http://localhost:${probe[1]}/api/healthz`), true, `${app}: the script waits on the same place`);
    assert.equal(/docker exec -u git "\$CONTAINER"/.test(script), true, `${app}: the admin CLI runs as the app's own user`);
  }
});

// ── the declarations that put those scripts to work ────────────────────────────────

const CONVERTED = {
  // Uptime Kuma's own MCP tools log in with basic auth, so the login is written into the
  // bundle's .env as well — both names are declared env_vars.
  "uptime-kuma": {
    user: "crow-admin",
    secretEnv: "UPTIMEKUMA_PASSWORD",
    userEnv: "UPTIMEKUMA_USERNAME",
    envDeclared: true,
    timeout_s: 180,
  },
  // The git apps' tools use a personal access token the operator makes, so the admin
  // password lives in the keychain only: secretEnv names the keychain entry, not an
  // env_vars entry, and the runner therefore writes nothing to .env.
  gitea: { user: "crow-admin", secretEnv: "GITEA_ADMIN_PASSWORD", userEnv: undefined, envDeclared: false, timeout_s: 240 },
  forgejo: { user: "crow-admin", secretEnv: "FORGEJO_ADMIN_PASSWORD", userEnv: undefined, envDeclared: false, timeout_s: 240 },
};

const manifestOf = (id) => JSON.parse(readFileSync(join(B(id), "manifest.json"), "utf8"));

test("each converted manifest passes the bundle contract and declares the setup script", () => {
  const bundleExists = (id) => existsSync(join(REPO, "bundles", id, "manifest.json"));
  for (const [id, want] of Object.entries(CONVERTED)) {
    const manifest = manifestOf(id);
    const { errors } = validateManifest(manifest, B(id), { bundleExists });
    assert.deepEqual((errors || []).filter((e) => e.startsWith("firstAdmin")), [], `${id}: firstAdmin`);
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
    assert.equal(declared.has(want.secretEnv), want.envDeclared, `${id}: secretEnv is declared only when .env carries it`);
    if (want.userEnv) assert.equal(declared.has(want.userEnv), true, `${id}: userEnv is a declared env var`);

    const script = readFileSync(join(B(id), manifest.firstAdmin.setup.script), "utf8");
    assert.match(script, /^#!\/usr\/bin\/env bash/, `${id}: the script is bash`);
    assert.match(script, /set -euo pipefail/, `${id}: fail fast`);
    assert.match(script, /IFS= read -r PW/, `${id}: reads the password from stdin`);
    assert.equal(
      script.includes('[[ "$ADMIN_USER" =~ ^[A-Za-z0-9._-]+$ ]]'),
      true,
      `${id}: the admin username is validated before any docker call`,
    );
    assert.equal(script.includes("CROW_FA_CONTAINER"), true, `${id}: the container name is overridable for tests`);
    assert.equal(script.includes("the password Crow generated"), true, `${id}: it says what the login now holds`);
  }
});

test("the committed registry carries the same declarations (it is generated from the manifests)", () => {
  const registry = JSON.parse(readFileSync(join(REPO, "registry", "add-ons.json"), "utf8"))["add-ons"];
  for (const id of Object.keys(CONVERTED)) {
    const entry = registry.find((e) => e.id === id);
    assert.ok(entry, `registry/add-ons.json has an entry for ${id}`);
    assert.deepEqual(entry, { ...manifestOf(id), official: true }, `${id}: registry copy of the manifest`);
  }
});
test("gitea/forgejo: self-registration is off by default, so the first web sign-up can't become admin", () => {
  for (const [id, prefix] of [["gitea", "GITEA"], ["forgejo", "FORGEJO"]]) {
    const compose = readFileSync(join(REPO, "bundles", id, "docker-compose.yml"), "utf8");
    assert.ok(compose.includes(`${prefix}__service__DISABLE_REGISTRATION=\${${prefix}_DISABLE_REGISTRATION:-true}`), id);
    const manifest = JSON.parse(readFileSync(join(REPO, "bundles", id, "manifest.json"), "utf8"));
    const v = manifest.env_vars.find((e) => e.name === `${prefix}_DISABLE_REGISTRATION`);
    assert.equal(v && v.default, "true", `${id}: declared, default true`);
  }
});

// ── nothing inside the container may outlive the protocol timeout ────────────────

const budgetOf = (script, name) => {
  const line = script.split("\n").find((l) => l.startsWith(`${name}=$((SECONDS + `));
  assert.ok(line, `${name} is a $SECONDS budget`);
  const m = /SECONDS \+ (\d+)\)/.exec(line);
  assert.ok(m, `${name}: the budget is a plain number of seconds`);
  return Number(m[1]);
};

for (const app of ["gitea", "forgejo"]) {
  test(`${app}: every call inside the container is bounded, well inside the manifest timeout`, () => {
    const script = readFileSync(join(B(app), "scripts", "first-admin.sh"), "utf8");
    const timeout = manifestOf(app).firstAdmin.setup.timeout_s;

    // The health wait is a $SECONDS budget, and the probe itself cannot hang either.
    const wait = budgetOf(script, "wait_deadline");
    assert.equal(wait <= 120, true, `${app}: the health wait is at most 120 s`);
    assert.equal(wait < timeout, true, `${app}: and inside the ${timeout} s the runner allows`);
    assert.match(
      script,
      /docker exec "\$CONTAINER" curl -fsS --max-time 5 -o \/dev\/null http:\/\/localhost:3000\/api\/healthz/,
      `${app}: one stuck health probe cannot outlive 5 s`,
    );

    // The proof loop is a $SECONDS budget too, and the budgets together fit the timeout.
    const proof = budgetOf(script, "proof_deadline");
    assert.equal(wait + proof < timeout, true, `${app}: the wait plus the proof loop fit the ${timeout} s`);

    // Every API call carries max-time in the curl config it feeds curl on stdin, so a
    // stuck request ends and the argv stays free of anything secret-shaped.
    const r = run(app);
    assert.equal(r.status, 0, r.stderr);
    const api = r.calls.filter((c) => ` ${c.argv} `.includes(" -K "));
    assert.equal(api.length >= 3, true, `${app}: the password PATCH, the proof and the token DELETE all use a config`);
    for (const call of api) {
      assert.match(call.stdin, /^max-time = 10$/m, `${app}: ${call.argv} carries max-time in its config`);
    }
  });
}

test("uptime-kuma: the health wait and every snippet are bounded, well inside the manifest timeout", () => {
  const script = readFileSync(join(B("uptime-kuma"), "scripts", "first-admin.sh"), "utf8");
  const timeout = manifestOf("uptime-kuma").firstAdmin.setup.timeout_s;

  const wait = budgetOf(script, "wait_deadline");
  assert.equal(wait <= 90, true, "the health wait is at most 90 s");
  assert.equal(wait < timeout, true, `and inside the ${timeout} s the runner allows`);
  // coreutils/busybox `timeout` in the image bounds the health check itself; where the applet
  // is missing the exec returns at once and the budget alone ends the wait.
  assert.match(script, /docker exec "\$CONTAINER" timeout 10 node \/app\/extra\/healthcheck\.js/);

  const proof = budgetOf(script, "proof_deadline");
  assert.equal(wait + proof < timeout, true, `the wait plus the proof loop fit the ${timeout} s`);
});

// ── the app's settings survive the compose refresh: say so where the operator reads it ──

test("gitea/forgejo: the notes say self-registration turns off for an existing install", () => {
  const sentence =
    "Self-registration is off by default: an existing install switches it off at its next restart. To keep people able to sign themselves up, set GITEA_DISABLE_REGISTRATION=false (Forgejo: FORGEJO_DISABLE_REGISTRATION=false) in this app's settings.";
  const registry = JSON.parse(readFileSync(join(REPO, "registry", "add-ons.json"), "utf8"))["add-ons"];
  for (const id of ["gitea", "forgejo"]) {
    const notes = manifestOf(id).notes;
    assert.equal(notes.includes(sentence), true, `${id}: the notes warn that the setting flips at the next restart`);
    assert.equal(registry.find((e) => e.id === id).notes, notes, `${id}: the registry entry carries the same notes`);
  }
});
