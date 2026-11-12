/**
 * Crow creates Wallabag's OAuth client itself (manifest `firstAdmin.setup.token`).
 *
 * Wallabag's API needs an OAuth2 client id and secret, which an account creates under
 * Developer → Create a new client and pastes into the extension. Wallabag has no environment
 * variable for either, and the image's own `fos:oauth-server:create-client` console command is
 * broken (its Client has no user), so the bundle now ships `scripts/api-token.sh` +
 * `scripts/api-client.php`: the client is created through the app's own kernel, as the app's
 * own user, with the admin password Crow generated arriving on stdin. TWO values come back,
 * because this extension needs two — one `NAME=value` line per declared env var on fd 3:
 *
 *   WALLABAG_CLIENT_ID=…
 *   WALLABAG_CLIENT_SECRET=…
 *
 * What these tests hold down:
 *
 *   1. a fresh install: exit 0, fd 3 is exactly those two lines, and neither value (nor the
 *      admin password) is in any argv a docker call was given, or in stdout/stderr,
 *   2. the PHP program is Crow's own file, piped into the container on stdin and run as the
 *      app's unprivileged user — it reads the account name as its argument and no secret,
 *   3. a re-run reuses the client: the program looks the account's "Crow" client up first,
 *   4. docker missing / the container not running / another install's container: exit 4,
 *      nothing on fd 3, nothing created,
 *   5. no password on stdin, or a missing account: exit 1, fd 3 empty,
 *   6. an answer that is not a client id/secret pair: exit 1, fd 3 empty,
 *   7. a client Wallabag refuses to issue a token for: exit 5, nothing handed back,
 *   8. the static rules: bash, fail-fast, executable, fd 3 written exactly once and only after
 *      the proof, every external command with fd 3 closed, never `docker compose`,
 *   9. the manifest: the version bump, the token block with BOTH env names and the stdin
 *      password, both entries declared secret, and a clean contract check,
 *  10. the form body: every value is percent-encoded with bash builtins before it is piped,
 *      so a password carrying `&`, `+`, `%`, `=` and a space reaches the app intact and is
 *      never in an argv.
 *
 * No docker and no network here: a `docker` executable written into a temp dir sits first on
 * PATH, records every argv and the stdin it received, and replays canned answers.
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
const BUNDLE = join(REPO, "bundles", "wallabag");
const SCRIPT = join(BUNDLE, "scripts", "api-token.sh");
const PHP_FILE = join(BUNDLE, "scripts", "api-client.php");

/**
 * Wallabag-shaped: the public id is `<numeric id>_<random>` (the shape the app really mints —
 * `Client::getPublicId()` prefixes the row id and an underscore) and the secret is a lowercase
 * base36 string. Parsing the id as `[A-Za-z0-9]*` fails on exactly this, so the underscore is
 * part of the fixture on purpose.
 */
const CLIENT_ID = "1_dgqk33xxf1koo4oo4cwk4s08o8gg8o4kgoo8oocwg8kogog4c";
const CLIENT_SECRET = "1m2n3o4p5q6r7s8t9u0v1w2x3y4z5a6";
/** An older row can carry an id with no underscore at all; that must parse too. */
const CLIENT_ID_NO_UNDERSCORE = "3pbcwp0qzw0ss8c4k0kskw0ws0w0sw0";
/** Crow's generated admin password is base64url. The form body is percent-encoded anyway. */
const PASSWORD = "gen-Secret_ABC123xy-z45";

const TMP = mkdtempSync(join(tmpdir(), "crow-wallabag-token-"));
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
  '      *"com.docker.compose.project.working_dir"*) next OWNER "$(pwd -P)"; printf "%s\\n" "$NEXT"; exit 0 ;;',
  "    esac",
  '    printf "fake docker: unsupported inspect: %s\\n" "$*" >&2; exit 99 ;;',
  "  exec) ;;",
  '  *) printf "fake docker: unsupported: %s\\n" "$*" >&2; exit 99 ;;',
  "esac",
  "",
  'args="$*"',
  'case "$args" in',
  // The token-endpoint proof, the kernel-booting client program, then the wait for the web UI.
  '  *"/oauth/v2/token"*) next PROOF 0; exit "$NEXT" ;;',
  `  *"php -- "*) next CLIENT "CLIENT=${CLIENT_ID}:${CLIENT_SECRET}"; printf "%s\\n" "$NEXT"; exit 0 ;;`,
  '  *"127.0.0.1:80/"*) next UP 0; exit "$NEXT" ;;',
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

/** Run the token script the way Crow does: the admin password on stdin, fd 3 as a pipe. */
function run({ password = `${PASSWORD}\n`, env = {}, withDocker = true } = {}) {
  const callsDir = mkdtempSync(join(TMP, "calls-"));
  const cwd = mkdtempSync(join(TMP, "cwd-"));
  const res = spawnSync(BASH, [SCRIPT], {
    input: password,
    encoding: "utf8",
    timeout: 120_000,
    cwd,
    stdio: ["pipe", "pipe", "pipe", "pipe"],
    env: {
      PATH: withDocker ? `${BIN}:/usr/bin:/bin` : NO_DOCKER,
      HOME: TMP,
      CROW_FA_CONTAINER: "crow-wallabag",
      CROW_FA_SKIP_OWNER_CHECK: "1",
      FAKE_DOCKER_DIR: callsDir,
      ...env,
    },
  });
  const answer = typeof res.output?.[3] === "string" ? res.output[3] : "";
  return {
    status: res.status,
    stdout: res.stdout || "",
    stderr: res.stderr || "",
    answer,
    calls: readCalls(callsDir),
    fd3Open: existsSync(join(callsDir, "fd3-open")),
    cwd,
  };
}

const argvText = (r) => r.calls.map((c) => c.argv).join("\n");
const stdinText = (r) => r.calls.map((c) => c.stdin).join("");
const ran = (r, needle) => r.calls.some((c) => c.argv.includes(needle));

/** The whole point: neither value, nor the password, is in an argument list or a log line. */
function assertNothingLeaked(r) {
  for (const secret of [CLIENT_ID, CLIENT_SECRET, PASSWORD]) {
    assert.equal(argvText(r).includes(secret), false, "no docker argument may carry a secret");
    assert.equal(String(r.stdout).includes(secret), false, "the script must not print a secret");
    assert.equal(String(r.stderr).includes(secret), false, "the script must not print a secret");
  }
}

// ── 1. a fresh install ─────────────────────────────────────────────────────────────

test("wallabag: the client id and secret come back on fd 3, one line each and nowhere else", () => {
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    r.answer,
    `WALLABAG_CLIENT_ID=${CLIENT_ID}\nWALLABAG_CLIENT_SECRET=${CLIENT_SECRET}\n`,
    "fd 3 holds one NAME=value line per declared env var, and nothing else",
  );
  assertNothingLeaked(r);
  assert.match(r.stdout, /Crow created Wallabag's OAuth client for wallabag\./);

  assert.equal(r.calls[0].argv.startsWith("inspect"), true, "the container is checked first");
  assert.equal(r.calls[0].argv.includes("crow-wallabag"), true);

  const client = r.calls.find((c) => c.argv.includes("php -- "));
  assert.ok(client, "the client is created by Crow's own PHP program");
  assert.match(client.argv, /su -s \/bin\/sh nobody/, "run as the app's own unprivileged user");
  assert.match(client.argv, /cd \/var\/www\/wallabag/, "from the app directory");
  assert.match(client.argv, /php -- wallabag$/, "the account name is the program's one argument");
  assert.equal(client.stdin, readFileSync(PHP_FILE, "utf8"), "the program itself is piped in on stdin (no docker cp)");

  // The proof: the form body goes in on stdin, never in an argument.
  const proof = r.calls.find((c) => c.argv.includes("/oauth/v2/token"));
  assert.ok(proof, "the client is proved against Wallabag's own token endpoint");
  assert.equal(proof.argv.includes("--data @-"), true, "curl reads the form body from stdin");
  assert.match(
    proof.stdin,
    new RegExp(`grant_type=password&client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}&username=wallabag&password=${PASSWORD}`),
  );
});

test("wallabag: every form value is percent-encoded, so & + % = and a space survive", () => {
  // A password the OPERATOR set is not base64url: it may carry the characters a form body
  // treats as syntax. Each value is encoded with bash builtins before it is piped, so the body
  // reaches curl on stdin unchanged in meaning, and no value ever appears in an argv.
  const password = "p&w+d%e=f g'q";
  const r = run({ password: `${password}\n` });
  assert.equal(r.status, 0, r.stderr);
  const proof = r.calls.find((c) => c.argv.includes("/oauth/v2/token"));
  assert.ok(proof, "the client is still proved against the token endpoint");
  assert.equal(proof.argv.includes("--data @-"), true, "curl still reads the body from stdin");
  assert.equal(
    proof.stdin,
    `grant_type=password&client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}&username=wallabag&password=p%26w%2Bd%25e%3Df%20g%27q`,
    "each value is encoded, and only the script's own `&`s separate the fields",
  );
  assert.equal(argvText(r).includes(password), false, "the raw password is never an argument");
  assert.equal(argvText(r).includes("p%26w%2Bd%25e%3Df%20g%27q"), false, "nor the encoded one");
  assert.equal(String(r.stdout).includes(password), false, "and the script prints no value");
  assert.equal(String(r.stderr).includes(password), false);
});

test("wallabag: the id's underscore is part of the id, and one without it still parses", () => {
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.answer.split("\n")[0], `WALLABAG_CLIENT_ID=${CLIENT_ID}`, "the whole `1_dgqk33…` id, underscore included");
  assert.equal(CLIENT_ID.includes("_"), true, "the fixture really is the shape the app mints");

  const plain = run({ env: { FAKE_CLIENT_0: `CLIENT=${CLIENT_ID_NO_UNDERSCORE}:${CLIENT_SECRET}` } });
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(
    plain.answer,
    `WALLABAG_CLIENT_ID=${CLIENT_ID_NO_UNDERSCORE}\nWALLABAG_CLIENT_SECRET=${CLIENT_SECRET}\n`,
    "an id with no underscore is still an id",
  );
});

test("wallabag: the program is Crow's own copy, and it creates exactly what the extension needs", () => {
  const php = readFileSync(PHP_FILE, "utf8");
  assert.match(php, /AppKernel\("prod", false\)/, "it boots the app's own production kernel");
  assert.match(php, /Wallabag\\\\UserBundle\\\\Entity\\\\User/, "the account is looked up by name");
  assert.match(php, /Wallabag\\\\ApiBundle\\\\Entity\\\\Client/, "the client is the app's own entity");
  assert.match(php, /findOneBy\(array\("user" => \$user, "name" => "Crow"\)\)/, "an existing client is reused");
  assert.match(php, /new \\Wallabag\\ApiBundle\\Entity\\Client\(\$user\)/, "a new one belongs to that account");
  assert.match(php, /setName\("Crow"\)/);
  assert.match(php, /setAllowedGrantTypes\(array\("password", "refresh_token"\)\)/, "the grants the extension uses");
  assert.match(php, /getPublicId\(\)/, "the id and the secret are what it prints");
  assert.match(php, /getSecret\(\)/);
});

test("wallabag: neither value survives in a docker command line (what a process list shows)", () => {
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  for (const call of r.calls) {
    assert.equal(call.argv.includes(CLIENT_SECRET), false, call.argv.slice(0, 100));
    assert.equal(call.argv.includes(CLIENT_ID), false, call.argv.slice(0, 100));
  }
});

// ── 2. not running, or no docker at all ────────────────────────────────────────────

test("wallabag: a container that is not running, or no docker at all, is exit 4", () => {
  const stopped = run({ env: { FAKE_RUNNING_0: "false" } });
  assert.equal(stopped.status, 4, stopped.stderr);
  assert.match(stopped.stderr, /Wallabag is not running; nothing was changed\./);
  assert.equal(stopped.answer, "", "fd 3 is empty");
  assert.equal(stopped.calls.length, 1, "only the state check ran");

  const noDocker = run({ withDocker: false });
  assert.equal(noDocker.status, 4, noDocker.stderr);
  assert.match(noDocker.stderr, /docker is not available here/);
  assert.equal(noDocker.answer, "");
  assert.equal(noDocker.calls.length, 0);
});

test("wallabag: another install's crow-wallabag is refused before anything runs inside it", () => {
  const r = run({ env: { CROW_FA_SKIP_OWNER_CHECK: "", FAKE_OWNER_0: "/srv/another-crow/bundles/wallabag" } });
  assert.equal(r.status, 4, r.stderr);
  assert.match(r.stderr, /^The running Wallabag container does not belong to this install; nothing was changed\.$/m);
  assert.equal(r.answer, "", "fd 3 is empty");
  assert.equal(r.calls.length, 2, "the state and the label were read, and nothing else");
  assert.equal(ran(r, "php -- "), false, "the container was never entered");
});

test("wallabag: the label check passes when the container really is this install's", () => {
  const r = run({ env: { CROW_FA_SKIP_OWNER_CHECK: "" } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.answer.split("\n")[0], `WALLABAG_CLIENT_ID=${CLIENT_ID}`);
  assert.ok(r.calls.find((c) => c.argv.includes("com.docker.compose.project.working_dir")));
});

// ── 3. the inputs the script refuses ──────────────────────────────────────────────

test("wallabag: no password on stdin is exit 1, and docker is never asked", () => {
  for (const password of ["", "\n"]) {
    const r = run({ password });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /No admin password arrived on stdin; Wallabag was not touched\./);
    assert.equal(r.answer, "");
    assert.equal(r.calls.length, 0, "nothing is reached without a password");
  }
});

test("wallabag: an account name that is not a plain account name is refused before docker", () => {
  const r = run({ env: { CROW_FIRST_ADMIN_USER: "admin; rm -rf /" } });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /not a plain account name; Wallabag was not touched\./);
  assert.equal(r.calls.length, 0);
});

test("wallabag: no account of that name is exit 1, and fd 3 stays empty", () => {
  const r = run({ env: { FAKE_CLIENT_0: "NOUSER" } });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /^Wallabag has no account named wallabag; nothing was changed\.$/m);
  assert.equal(r.answer, "");
  assert.equal(ran(r, "/oauth/v2/token"), false, "nothing to prove");
});

test("wallabag: an answer that is not a client id/secret pair is exit 1, never a half-read one", () => {
  const answers = [
    "",
    "PHP Fatal error: Uncaught RuntimeException",
    "CLIENT=onlyanid",
    `CLIENT=${CLIENT_ID}:`,
    `CLIENT=:${CLIENT_SECRET}`,
    `CLIENT=${CLIENT_ID}:${CLIENT_SECRET}:extra`,
  ];
  for (const answer of answers) {
    const r = run({ env: { FAKE_CLIENT_0: answer } });
    assert.equal(r.status, 1, `${JSON.stringify(answer)}: ${r.stderr}`);
    assert.match(r.stderr, /did not report an OAuth client for wallabag; nothing was changed\./);
    assert.equal(r.answer, "", `${JSON.stringify(answer)}: fd 3 must stay empty`);
    assert.equal(ran(r, "/oauth/v2/token"), false, "an unusable answer is never proved");
  }
});

test("wallabag: a client the app refuses is exit 5, and nothing is handed back", () => {
  const r = run({ env: { FAKE_PROOF_0: "22" } });
  assert.equal(r.status, 5, r.stderr);
  assert.match(r.stderr, /^Wallabag did not accept the OAuth client Crow created; nothing was saved\.$/m);
  assert.equal(r.answer, "", "an unproved client is never written to fd 3");
  assert.equal(ran(r, "php -- "), true, "the client really was created before it was refused");
});

// ── 4. the static rules the protocol rests on ──────────────────────────────────────

const codeLines = (text) => text.split("\n").filter((line) => !/^\s*#/.test(line) && line.trim() !== "");

test("wallabag: the script is bash, fail-fast and executable", () => {
  const script = readFileSync(SCRIPT, "utf8");
  assert.match(script, /^#!\/usr\/bin\/env bash/);
  assert.match(script, /set -euo pipefail/);
  assert.notEqual(statSync(SCRIPT).mode & 0o111, 0, "a script declared as one is executable");
  const syntax = spawnSync(BASH, ["-n", SCRIPT], { encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
});

test("wallabag: fd 3 is written exactly once, after the proof, and never read", () => {
  const script = codeLines(readFileSync(SCRIPT, "utf8")).join("\n");
  assert.equal(script.match(/>&3/g)?.length, 1, "one write to fd 3 and no other");
  const write = script.indexOf(">&3");
  const proof = script.indexOf("did not accept the OAuth client Crow created");
  assert.ok(proof > 0 && write > proof, "the client is proved before it is handed back");
  assert.equal(script.includes("<&3"), false, "nothing is ever read from fd 3");
});

test("wallabag: every external command runs with fd 3 closed, so no child can hold the pipe", () => {
  const script = readFileSync(SCRIPT, "utf8");
  const external = /(\bdocker\b|\bsed\b|\btail\b|\bseq\b|\bsleep\b|\bcurl\b)/;
  const offenders = codeLines(script).filter((line) => external.test(line) && !/command -v docker/.test(line) && !line.includes("3>&-"));
  assert.deepEqual(offenders.map((l) => l.trim()), [], "every such line closes fd 3");
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.fd3Open, false, "no docker call — and so no child — ever saw fd 3 open");
});

test("wallabag: the script never runs `docker compose` and never echoes a secret", () => {
  const code = codeLines(readFileSync(SCRIPT, "utf8")).join("\n");
  assert.equal(/docker\s+compose/.test(code), false, "no compose file in the folder is read at all");
  assert.equal(/\becho\b/.test(code), false, "echo is a way to leak by accident");
});

// ── 5. the declaration that puts the script to work ────────────────────────────────

const manifestOf = () => JSON.parse(readFileSync(join(BUNDLE, "manifest.json"), "utf8"));

test("wallabag: the manifest declares BOTH values, the stdin password, and the version bump", () => {
  const manifest = manifestOf();
  assert.equal(manifest.version, "1.0.6", "the installed copy refreshes only on a version change");
  const token = manifest.firstAdmin.setup.token;
  assert.deepEqual(
    { script: token.script, env: token.env, stdin: token.stdin, timeout_s: token.timeout_s },
    {
      script: "scripts/api-token.sh",
      env: ["WALLABAG_CLIENT_ID", "WALLABAG_CLIENT_SECRET"],
      stdin: "admin-password",
      timeout_s: 180,
    },
    "two values, one line each, and the admin password on stdin",
  );
  assert.equal(existsSync(join(BUNDLE, token.script)), true, "the script really ships");
  assert.equal(existsSync(join(BUNDLE, "scripts", "api-client.php")), true, "and so does the program it pipes in");
});

test("wallabag: both env vars the client fills are declared secrets", () => {
  const manifest = manifestOf();
  for (const name of ["WALLABAG_CLIENT_ID", "WALLABAG_CLIENT_SECRET"]) {
    const spec = (manifest.env_vars || []).find((v) => v.name === name);
    assert.ok(spec, `${name} is declared`);
    assert.equal(spec.secret, true, `${name} is a secret`);
    assert.equal(spec.generate, undefined, `${name} is not a value Crow generates`);
  }
});

test("wallabag: the manifest still passes the bundle contract, token step included", () => {
  const { errors } = validateManifest(manifestOf(), BUNDLE, { bundleExists: () => true });
  assert.deepEqual((errors || []).filter((e) => e.startsWith("firstAdmin")), [], "firstAdmin errors");
});