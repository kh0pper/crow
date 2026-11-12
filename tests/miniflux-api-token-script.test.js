/**
 * Crow takes Miniflux's API key from Miniflux itself (manifest `firstAdmin.token`, the sibling
 * of `secretEnv` because Miniflux's admin comes from the environment).
 *
 * Miniflux has no environment variable for an API key, so the last "Finish setup" step of this
 * bundle used to be a human copying a key out of Settings → API Keys. The bundle now ships
 * `scripts/api-token.sh`, and the installer (and the boot catch-up) runs it once the app is up:
 * the admin password Crow generated arrives as ONE line on stdin — never in an argument — and
 * the key comes back on fd 3, one line, while stdout and stderr stay the run's log. What these
 * tests hold down:
 *
 *   1. a fresh install: exit 0, fd 3 is exactly "<64 chars>\n", and neither the key nor the
 *      password is in any argument / log line of docker OR curl,
 *   2. no credential is ever an argument: the header is built on the Crow host
 *      (`user:password | base64`) and handed to the HOST's own curl on stdin (`-H @-`, one
 *      header per line), and nothing runs inside the container for these calls — so no
 *      credential can appear in a process list, on either side,
 *   3. a re-run REUSES the "Crow" key: the list is asked first and nothing is created,
 *   4. docker missing / the container not running / another install's container: exit 4,
 *      nothing on fd 3, nothing created,
 *   5. no password on stdin, or a list/create that answers with nothing usable: exit 1, fd 3
 *      empty,
 *   6. a key Miniflux refuses: exit 5, and nothing is handed back,
 *   7. the static rules: bash, fail-fast, executable, fd 3 written exactly once and only after
 *      the proof, every external command with fd 3 closed, never `docker compose`,
 *   8. the manifest: the version bump, the token block beside secretEnv with the stdin
 *      password, `MINIFLUX_API_KEY` secret, and a clean contract check.
 *
 * No docker and no network here: a `docker` executable and a `curl` executable written into a
 * temp dir sit first on PATH, record every argv and the stdin they received, and replay canned
 * answers — including `docker port`'s `127.0.0.1:18085` for the container's 8080. The fake curl
 * fails loudly if a credential ever shows up in its arguments, reads the headers from stdin and
 * answers list/create/me the way Miniflux does.
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
const BUNDLE = join(REPO, "bundles", "miniflux");
const SCRIPT = join(BUNDLE, "scripts", "api-token.sh");

/** Miniflux-shaped: 64 characters, printable ASCII, no whitespace. */
const KEY = "a1b2c3d4e5f6".repeat(5) + "abcd";
/** Crow's generated admin password is base64url. */
const PASSWORD = "gen-Secret_ABC123xy-z45";
const USER = "admin";
/** The host port the fake `docker port` publishes (compose maps container 8080). */
const PORT = "18085";

const TMP = mkdtempSync(join(tmpdir(), "crow-miniflux-token-"));
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
  "  port)",
  `    next PORT "127.0.0.1:${PORT}"; printf "%s\\n" "$NEXT"; exit 0 ;;`,
  "  exec) ;;",
  '  *) printf "fake docker: unsupported: %s\\n" "$*" >&2; exit 99 ;;',
  "esac",
  "",
  'args="$*"',
  'case "$args" in',
  // The only docker call left that answers is the health probe (the wait) — Miniflux's real
  // endpoint is /healthcheck (/health redirects to the login page); the API calls are the
  // HOST's curl, so docker is never asked to run one.
  '  *"8080/healthcheck"*) next UP 0; exit "$NEXT" ;;',
  '  *) printf "fake docker: no answer for: %s\\n" "$args" >&2; exit 98 ;;',
  "esac",
  "",
].join("\n");
// The create answer is a JSON object; it is injected through the fake's own environment so the
// KEY never appears in the fake's source or in any argument.
const DEFAULT_CREATED = JSON.stringify({ id: 7, user_id: 1, description: "Crow", token: KEY, created_at: "2026-11-12T09:00:00Z" });
writeFileSync(join(BIN, "docker"), FAKE_DOCKER, { mode: 0o755 });

/**
 * The stand-in curl: the script's API calls go through THIS host, at the port `docker port`
 * published. It records `<dir>/curl.<n>.argv` and `<dir>/curl.<n>.stdin`, and it refuses — the
 * way the real rule is meant to hold — to run at all when a credential is in its arguments.
 */
const FAKE_CURL = [
  "#!/usr/bin/env bash",
  "set -uo pipefail",
  'dir="$FAKE_CURL_DIR"',
  "n=0",
  'while [ -f "$dir/curl.$n.argv" ]; do n=$((n + 1)); done',
  'if [ -e /proc/self/fd/3 ]; then printf "%s\\n" FD3OPEN >> "$dir/fd3-open"; fi',
  'printf "%s" "$*" > "$dir/curl.$n.argv"',
  "# No credential may be in this argv (that is the whole point of the rewrite).",
  'case "$*" in',
  '  *Basic*|*X-Auth-Token*) printf "fake curl: a credential is in an argument: %s\\n" "$*" >&2; exit 97 ;;',
  "esac",
  'while IFS= read -r value; do',
  '  [ -n "$value" ] || continue',
  '  case "$*" in *"$value"*) printf "fake curl: a secret is in an argument: %s\\n" "$*" >&2; exit 97 ;; esac',
  'done <<< "${FAKE_FORBIDDEN_VALUES:-}"',
  "# Headers arrive on stdin (`-H @-`), one per line; the create body is a fixed literal.",
  'cat > "$dir/curl.$n.stdin"',
  "",
  'NEXT=""',
  "next() {",
  '  local key="$1" dflt="$2" cf="$dir/curlcounter.$1" i=0',
  '  if [ -f "$cf" ]; then i=$(cat "$cf"); fi',
  '  printf "%s\\n" "$((i + 1))" > "$cf"',
  '  local var="FAKE_${key}_${i}"',
  '  if [ -n "${!var+x}" ]; then NEXT="${!var}"; else NEXT="$dflt"; fi',
  "}",
  "",
  'args="$*"',
  'case "$args" in',
  // /v1/me proves a key; a create posts the fixed body; listing is the bare api-keys GET.
  '  *"/v1/me"*) next PROOF 0; exit "$NEXT" ;;',
  '  *"--data-raw"*) next CREATE "${DEFAULT_CREATED}"; printf "%s\\n" "$NEXT"; exit 0 ;;',
  '  *"/v1/api-keys"*) next LIST "[]"; printf "%s\\n" "$NEXT"; exit 0 ;;',
  '  *) printf "fake curl: no answer for: %s\\n" "$args" >&2; exit 98 ;;',
  "esac",
  "",
].join("\n");
writeFileSync(join(BIN, "curl"), FAKE_CURL, { mode: 0o755 });

after(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
});

/** The calls one fake made, in order: `<prefix>.<i>.argv` and what arrived on stdin. */
function readCalls(dir, prefix, kind) {
  const out = [];
  for (let i = 0; existsSync(join(dir, `${prefix}.${i}.argv`)); i++) {
    out.push({
      kind,
      argv: readFileSync(join(dir, `${prefix}.${i}.argv`), "utf8"),
      stdin: readFileSync(join(dir, `${prefix}.${i}.stdin`), "utf8"),
    });
  }
  return out;
}

/** The Basic-Auth value the script is expected to build, on the Crow host. */
const AUTH = Buffer.from(`${USER}:${PASSWORD}`, "utf8").toString("base64");

/** Run the token script the way Crow does: the admin password on stdin, fd 3 as a pipe. */
function run({ password = `${PASSWORD}\n`, env = {}, withDocker = true, cwdSeeded = null } = {}) {
  const callsDir = mkdtempSync(join(TMP, "calls-"));
  const cwd = mkdtempSync(join(TMP, "cwd-"));
  if (cwdSeeded) writeFileSync(join(cwd, ".env"), cwdSeeded);
  const res = spawnSync(BASH, [SCRIPT], {
    input: password,
    encoding: "utf8",
    timeout: 120_000,
    cwd,
    stdio: ["pipe", "pipe", "pipe", "pipe"],
    env: {
      PATH: withDocker ? `${BIN}:/usr/bin:/bin` : NO_DOCKER,
      HOME: TMP,
      CROW_FA_CONTAINER: "crow-miniflux",
      CROW_FA_SKIP_OWNER_CHECK: "1",
      FAKE_DOCKER_DIR: callsDir,
      FAKE_CURL_DIR: callsDir,
      FAKE_FORBIDDEN_VALUES: [KEY, PASSWORD, AUTH].join("\n"),
      DEFAULT_CREATED,
      ...env,
    },
  });
  const key = typeof res.output?.[3] === "string" ? res.output[3] : "";
  return {
    status: res.status,
    stdout: res.stdout || "",
    stderr: res.stderr || "",
    key,
    calls: [...readCalls(callsDir, "call", "docker"), ...readCalls(callsDir, "curl", "curl")],
    fd3Open: existsSync(join(callsDir, "fd3-open")),
    cwd,
  };
}

const argvText = (r) => r.calls.map((c) => c.argv).join("\n");
const stdinText = (r) => r.calls.map((c) => c.stdin).join("");
const ran = (r, needle) => r.calls.some((c) => c.argv.includes(needle));
/** The curl call whose arguments contain all of `needles` (never the docker fakes). */
const curlCall = (r, ...needles) =>
  r.calls.find((c) => c.kind === "curl" && needles.every((needle) => c.argv.includes(needle)));

/** The whole point: the key, the password and the Basic value are in no argument or log line. */
function assertNothingLeaked(r) {
  for (const secret of [KEY, PASSWORD, AUTH]) {
    assert.equal(argvText(r).includes(secret), false, "no docker or curl argument may carry a secret");
    assert.equal(String(r.stdout).includes(secret), false, "the script must not print a secret");
    assert.equal(String(r.stderr).includes(secret), false, "the script must not print a secret");
  }
  for (const call of r.calls) {
    assert.equal(call.argv.includes("Basic"), false, call.argv.slice(0, 100));
    assert.equal(call.argv.includes("X-Auth-Token"), false, call.argv.slice(0, 100));
  }
}

// ── 1. a fresh install ─────────────────────────────────────────────────────────────

test("miniflux: the admin's key comes back on fd 3, exactly once and only there", () => {
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.key, `${KEY}\n`, "fd 3 holds the key and one newline, nothing else");
  assertNothingLeaked(r);
  assert.match(r.stdout, /Crow read Miniflux's API key for admin\./);

  assert.equal(r.calls[0].argv.startsWith("inspect"), true, "the container is checked first");
  assert.equal(r.calls[0].argv.includes("crow-miniflux"), true);

  // The Basic-Auth header is built on the Crow host and handed to the host's own curl on stdin.
  const list = curlCall(r, "/v1/api-keys");
  assert.ok(list, "the account's keys are listed first (a second run reuses the Crow one)");
  assert.equal(list.stdin, `Authorization: Basic ${AUTH}\n`, "the header arrives on stdin, one per line");
  assert.match(list.argv, /-H @-/, "curl reads the header from stdin, never from an argument");
  assert.match(list.argv, new RegExp(`127\\.0\\.0\\.1:${PORT}/v1/api-keys`), "the host curl talks to the port Docker published");
  assert.equal(
    r.calls.filter((c) => c.kind === "docker").some((c) => c.argv.includes("/v1/")),
    false,
    "no API call runs inside the container: only the health wait goes through docker exec",
  );

  const create = curlCall(r, "--data-raw");
  assert.ok(create, "with no Crow key, one is created");
  assert.equal(create.stdin, `Authorization: Basic ${AUTH}\nContent-Type: application/json\n`, "both headers on stdin");
  assert.match(create.argv, /--data-raw \{"description":"Crow"\}/, "the body is the fixed literal, and it holds no secret");
  assert.match(create.argv, /-H @-/);

  // The proof: the key goes in on stdin too, so it is never an argument on either side.
  const proof = curlCall(r, "/v1/me");
  assert.ok(proof, "the key is proved against the app's own API before it is handed back");
  assert.equal(proof.stdin, `X-Auth-Token: ${KEY}\n`, "the key travels on a pipe");
  assert.match(proof.argv, /-H @-/);
});

test("miniflux: the password never reaches a docker or curl command line (what a process list shows)", () => {
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  for (const call of r.calls) {
    assert.equal(call.argv.includes(PASSWORD), false, call.argv.slice(0, 100));
    assert.equal(call.argv.includes(AUTH), false, call.argv.slice(0, 100));
    assert.equal(call.argv.includes(KEY), false, call.argv.slice(0, 100));
  }
});

test("miniflux: a second run reuses the Crow key instead of creating another", () => {
  const existing = JSON.stringify([{ id: 7, user_id: 1, description: "Crow", token: KEY, created_at: "2026-11-12T09:00:00Z" }]);
  const r = run({ env: { FAKE_LIST_0: existing } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.key, `${KEY}\n`);
  assert.equal(ran(r, "--data-raw"), false, "nothing is created when the account already has Crow's key");
  assertNothingLeaked(r);
});

test("miniflux: a key described otherwise is not taken for Crow's", () => {
  const other = JSON.stringify([
    { id: 3, user_id: 1, description: "Crow notes", token: "z".repeat(64) },
    { id: 4, user_id: 1, description: "phone", token: "y".repeat(64) },
  ]);
  const r = run({ env: { FAKE_LIST_0: other } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.key, `${KEY}\n`, "the freshly created Crow key, not a lookalike description");
  assert.equal(ran(r, "--data-raw"), true);
});

test("miniflux: the account comes from the installed .env when the manifest names none", () => {
  const r = run({ cwdSeeded: "MINIFLUX_URL=http://localhost:8085\nMINIFLUX_ADMIN_USER=alex\n" });
  assert.equal(r.status, 0, r.stderr);
  const list = curlCall(r, "/v1/api-keys");
  assert.equal(list.stdin, `Authorization: Basic ${Buffer.from(`alex:${PASSWORD}`, "utf8").toString("base64")}\n`, "the .env account is the one signed in as");
});

// ── 2. not running, or no docker at all ────────────────────────────────────────────

test("miniflux: a container that is not running, or no docker at all, is exit 4", () => {
  const stopped = run({ env: { FAKE_RUNNING_0: "false" } });
  assert.equal(stopped.status, 4, stopped.stderr);
  assert.match(stopped.stderr, /Miniflux is not running; nothing was changed\./);
  assert.equal(stopped.key, "", "fd 3 is empty");
  assert.equal(stopped.calls.length, 1, "only the state check ran");

  const noDocker = run({ withDocker: false });
  assert.equal(noDocker.status, 4, noDocker.stderr);
  assert.match(noDocker.stderr, /docker is not available here/);
  assert.equal(noDocker.key, "");
  assert.equal(noDocker.calls.length, 0);
});

test("miniflux: a container whose port is not published on the host is exit 4, and nothing is written", () => {
  const r = run({ env: { FAKE_PORT_0: "" } });
  assert.equal(r.status, 4, r.stderr);
  assert.match(r.stderr, /^Miniflux's port is not published on this host, so its API cannot be reached; nothing was changed\.$/m);
  assert.equal(r.key, "", "fd 3 is empty");
  assert.equal(r.calls.some((c) => c.kind === "curl"), false, "without a port there is nothing to call");
  assert.equal(ran(r, "api-keys"), false);
});

test("miniflux: another install's crow-miniflux is refused before anything runs inside it", () => {
  const r = run({ env: { CROW_FA_SKIP_OWNER_CHECK: "", FAKE_OWNER_0: "/srv/another-crow/bundles/miniflux" } });
  assert.equal(r.status, 4, r.stderr);
  assert.match(r.stderr, /^The running Miniflux container does not belong to this install; nothing was changed\.$/m);
  assert.equal(r.key, "", "fd 3 is empty");
  assert.equal(r.calls.length, 2, "the state and the label were read, and nothing else");
  assert.equal(ran(r, "api-keys"), false, "the container was never entered");
});

test("miniflux: the label check passes when the container really is this install's", () => {
  const r = run({ env: { CROW_FA_SKIP_OWNER_CHECK: "" } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.key, `${KEY}\n`);
  assert.ok(r.calls.find((c) => c.argv.includes("com.docker.compose.project.working_dir")));
});

// ── 3. the inputs the script refuses ──────────────────────────────────────────────

test("miniflux: no password on stdin is exit 1, and docker is never asked", () => {
  for (const password of ["", "\n"]) {
    const r = run({ password });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /No admin password arrived on stdin; Miniflux was not touched\./);
    assert.equal(r.key, "");
    assert.equal(r.calls.length, 0, "nothing is reached without a password");
  }
});

test("miniflux: an account name that is not a plain account name is refused before docker", () => {
  const r = run({ cwdSeeded: "MINIFLUX_ADMIN_USER=ad min\n" });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /not a plain account name; Miniflux was not touched\./);
  assert.equal(r.calls.length, 0);
});

test("miniflux: a list and a create that answer with nothing usable is exit 1, never a half-read key", () => {
  const answers = [
    { list: "", create: "" },
    { list: "Unauthorized", create: "Unauthorized" },
    { list: "[]", create: "{}" },
    { list: JSON.stringify([{ description: "Crow", token: "short" }]), create: "{}" },
    { list: "[]", create: JSON.stringify({ id: 7, description: "Crow", token: "" }) },
  ];
  for (const answer of answers) {
    const r = run({ env: { FAKE_LIST_0: answer.list, FAKE_CREATE_0: answer.create } });
    assert.equal(r.status, 1, `${JSON.stringify(answer)}: ${r.stderr}`);
    assert.match(r.stderr, /did not report an API key for admin; nothing was changed\./);
    assert.equal(r.key, "", `${JSON.stringify(answer)}: fd 3 must stay empty`);
    assert.equal(ran(r, "X-Auth-Token"), false, "an unusable answer is never proved");
  }
});

test("miniflux: a key the app refuses is exit 5, and nothing is handed back", () => {
  const r = run({ env: { FAKE_PROOF_0: "8" } });
  assert.equal(r.status, 5, r.stderr);
  assert.match(r.stderr, /^Miniflux did not accept the API key Crow read; nothing was saved\.$/m);
  assert.equal(r.key, "", "an unproved key is never written to fd 3");
  assert.equal(ran(r, "api-keys"), true, "the key really was read before it was refused");
});

// ── 4. the static rules the protocol rests on ──────────────────────────────────────

const codeLines = (text) => text.split("\n").filter((line) => !/^\s*#/.test(line) && line.trim() !== "");

test("miniflux: the script is bash, fail-fast and executable", () => {
  const script = readFileSync(SCRIPT, "utf8");
  assert.match(script, /^#!\/usr\/bin\/env bash/);
  assert.match(script, /set -euo pipefail/);
  assert.notEqual(statSync(SCRIPT).mode & 0o111, 0, "a script declared as one is executable");
  const syntax = spawnSync(BASH, ["-n", SCRIPT], { encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
});

test("miniflux: fd 3 is written exactly once, after the proof, and never read", () => {
  const script = codeLines(readFileSync(SCRIPT, "utf8")).join("\n");
  assert.equal(script.match(/>&3/g)?.length, 1, "one write to fd 3 and no other");
  const write = script.indexOf(">&3");
  const proof = script.indexOf("did not accept the API key Crow read");
  assert.ok(proof > 0 && write > proof, "the key is proved before it is handed back");
  assert.equal(script.includes("<&3"), false, "nothing is ever read from fd 3");
});

test("miniflux: every external command runs with fd 3 closed, so no child can hold the pipe", () => {
  const script = readFileSync(SCRIPT, "utf8");
  // There are no container-side snippets any more: every API call is this host's own curl, so
  // every command that could hold fd 3 is a host command.
  const external = /(\bdocker\b|\bcurl\b|\bsed\b|\btail\b|\bseq\b|\bsleep\b|\btr\b|\bgrep\b|\bbase64\b)/;
  const offenders = codeLines(script).filter((line) => external.test(line) && !/command -v (docker|curl)/.test(line) && !line.includes("3>&-"));
  assert.deepEqual(offenders.map((l) => l.trim()), [], "every such line closes fd 3");
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.fd3Open, false, "no docker or curl call — and so no child — ever saw fd 3 open");
});

test("miniflux: the script never runs `docker compose` and never echoes a secret", () => {
  const code = codeLines(readFileSync(SCRIPT, "utf8")).join("\n");
  assert.equal(/docker\s+compose/.test(code), false, "no compose file in the folder is read at all");
  assert.equal(/\becho\b/.test(code), false, "echo is a way to leak by accident");
});

// ── 5. the declaration that puts the script to work ────────────────────────────────

const manifestOf = () => JSON.parse(readFileSync(join(BUNDLE, "manifest.json"), "utf8"));

test("miniflux: the manifest declares the token beside secretEnv, with the stdin password", () => {
  const manifest = manifestOf();
  assert.equal(manifest.version, "1.0.8", "the installed copy refreshes only on a version change");
  const fa = manifest.firstAdmin;
  assert.equal(fa.via, "env", "Miniflux's admin comes from the environment");
  assert.equal(fa.secretEnv, "MINIFLUX_ADMIN_PASSWORD", "the keychain row the token script signs in with");
  assert.deepEqual(
    { script: fa.token.script, env: fa.token.env, stdin: fa.token.stdin, timeout_s: fa.token.timeout_s },
    { script: "scripts/api-token.sh", env: "MINIFLUX_API_KEY", stdin: "admin-password", timeout_s: 120 },
  );
  assert.equal(existsSync(join(BUNDLE, fa.token.script)), true, "the script really ships");
});

test("miniflux: MINIFLUX_API_KEY is a declared secret Crow does not generate", () => {
  const spec = (manifestOf().env_vars || []).find((v) => v.name === "MINIFLUX_API_KEY");
  assert.ok(spec, "the env var the key goes in is declared");
  assert.equal(spec.secret, true, "it is a secret");
  assert.equal(spec.generate, undefined, "the app mints it, Crow does not");
});

test("miniflux: the manifest still passes the bundle contract, token step included", () => {
  const { errors } = validateManifest(manifestOf(), BUNDLE, { bundleExists: () => true });
  assert.deepEqual((errors || []).filter((e) => e.startsWith("firstAdmin")), [], "firstAdmin errors");
});