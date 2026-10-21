// Step 0 of the sandboxing migration (queue item 19): secrets can reach a
// gateway as systemd credentials (LoadCredential=) instead of Environment= /
// EnvironmentFile=. A credential is a file the service reads once; its value
// lives in process memory, never in `systemctl show` or the process's initial
// /proc/<pid>/environ.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyCredentialFiles, credentialRoots } from "../servers/shared/credentials-env.js";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "crow-cred-")));
after(() => rmSync(scratch, { recursive: true, force: true }));

let n = 0;
function credDir(files = {}) {
  const dir = join(scratch, "creds-" + (++n));
  mkdirSync(dir, { recursive: true });
  for (const [k, v] of Object.entries(files)) writeFileSync(join(dir, k), v, { mode: 0o600 });
  return dir;
}
function quietLog() {
  const lines = [];
  const push = (...a) => lines.push(a.join(" "));
  return { lines, log: { log: push, warn: push, error: push } };
}
const roots = [scratch];

test("applies credential files named like env keys, trimming one trailing newline", () => {
  const dir = credDir({ KB_FEEDBACK_REMOTE_TOKEN: "abc123\n", OTHER_SECRET: "x\r\n", PLAIN: "no-newline" });
  const env = { CREDENTIALS_DIRECTORY: dir };
  const { lines, log } = quietLog();
  const r = applyCredentialFiles(env, { roots, log });
  assert.deepEqual(r.applied.sort(), ["KB_FEEDBACK_REMOTE_TOKEN", "OTHER_SECRET", "PLAIN"]);
  assert.equal(env.KB_FEEDBACK_REMOTE_TOKEN, "abc123");
  assert.equal(env.OTHER_SECRET, "x");
  assert.equal(env.PLAIN, "no-newline");
  const out = lines.join("\n");
  assert.match(out, /KB_FEEDBACK_REMOTE_TOKEN/);
  for (const v of ["abc123", "no-newline"]) assert.ok(!out.includes(v), "never logs a value");
});

test("an explicit environment value wins; the credential is skipped with a warning naming only the key", () => {
  const dir = credDir({ A_TOKEN: "from-cred" });
  const env = { CREDENTIALS_DIRECTORY: dir, A_TOKEN: "from-env" };
  const { lines, log } = quietLog();
  const r = applyCredentialFiles(env, { roots, log });
  assert.equal(env.A_TOKEN, "from-env");
  assert.deepEqual(r.applied, []);
  assert.deepEqual(r.skipped.map((s) => s.name), ["A_TOKEN"]);
  assert.match(lines.join("\n"), /A_TOKEN/);
  assert.ok(!lines.join("\n").includes("from-cred") && !lines.join("\n").includes("from-env"));
});

test("names that are not env-key shaped are ignored silently (systemd may add its own files)", () => {
  const dir = credDir({ "board-actor-secret": "zzz", "lower_case": "y", "OK_KEY": "1" });
  const env = { CREDENTIALS_DIRECTORY: dir };
  const r = applyCredentialFiles(env, { roots, log: quietLog().log });
  assert.deepEqual(r.applied, ["OK_KEY"]);
  assert.equal(env["board-actor-secret"], undefined);
  assert.equal(env.lower_case, undefined);
});

test("refuses symlinks, FIFOs, directories, oversize, empty and NUL-bearing files", () => {
  const dir = credDir({ GOOD: "g", BIG: "x".repeat(70 * 1024), EMPTY: "", NUL: "a\0b" });
  writeFileSync(join(scratch, "outside-target"), "leak");
  symlinkSync(join(scratch, "outside-target"), join(dir, "LINKED"));
  mkdirSync(join(dir, "ADIR"));
  execFileSync("mkfifo", [join(dir, "PIPE")]);
  const env = { CREDENTIALS_DIRECTORY: dir };
  const r = applyCredentialFiles(env, { roots, log: quietLog().log });
  assert.deepEqual(r.applied, ["GOOD"]);
  const reasons = Object.fromEntries(r.skipped.map((s) => [s.name, s.reason]));
  for (const k of ["LINKED", "ADIR", "PIPE", "BIG", "EMPTY", "NUL"]) assert.ok(reasons[k], k + " skipped");
  for (const k of ["LINKED", "ADIR", "PIPE", "BIG", "EMPTY", "NUL"]) assert.equal(env[k], undefined);
});

test("a credentials directory outside the accepted roots is refused as a whole", () => {
  const dir = credDir({ X_TOKEN: "v" });
  const env = { CREDENTIALS_DIRECTORY: dir };
  const r = applyCredentialFiles(env, { roots: ["/run/credentials"], log: quietLog().log });
  assert.deepEqual(r.applied, []);
  assert.match(r.problem, /not under/);
  assert.equal(env.X_TOKEN, undefined);
});

test("a symlinked credentials directory is judged by its real path", () => {
  const real = credDir({ Y_TOKEN: "v" });
  const outsideRoot = mkdtempSync(join(tmpdir(), "crow-cred-out-"));
  try {
    const link = join(outsideRoot, "link");
    symlinkSync(real, link);
    const env = { CREDENTIALS_DIRECTORY: link };
    assert.deepEqual(applyCredentialFiles(env, { roots, log: quietLog().log }).applied, ["Y_TOKEN"], "real path inside the root");
    const env2 = { CREDENTIALS_DIRECTORY: real };
    assert.match(applyCredentialFiles(env2, { roots: [outsideRoot], log: quietLog().log }).problem || "", /not under/,
      "a real path outside the root is refused even if a symlink to it lives inside");
  } finally { rmSync(outsideRoot, { recursive: true, force: true }); }
});

test("no CREDENTIALS_DIRECTORY: nothing happens; a missing one is a problem, not a throw", () => {
  assert.deepEqual(applyCredentialFiles({}, { roots, log: quietLog().log }), { applied: [], skipped: [], problem: null });
  const r = applyCredentialFiles({ CREDENTIALS_DIRECTORY: join(scratch, "nope") }, { roots, log: quietLog().log });
  assert.deepEqual(r.applied, []);
  assert.match(r.problem, /does not exist/);
});

test("default roots: /run/credentials, plus $XDG_RUNTIME_DIR/credentials only under /run/user", () => {
  assert.deepEqual(credentialRoots({}), ["/run/credentials"]);
  const fakeReal = (p) => p;
  assert.deepEqual(credentialRoots({ XDG_RUNTIME_DIR: "/run/user/1000" }, { realpathFn: fakeReal }),
    ["/run/credentials", "/run/user/1000/credentials"]);
  assert.deepEqual(credentialRoots({ XDG_RUNTIME_DIR: "/tmp/evil" }, { realpathFn: fakeReal }), ["/run/credentials"]);
});

test("the instance-paths gate applies credentials BEFORE the checkout .env, so a credential beats a .env line", async () => {
  const { runInstancePathsGate } = await import("../servers/gateway/boot/instance-paths-gate.js");
  const dir = credDir({ SOME_API_TOKEN: "cred-value" });
  const envFile = join(scratch, "gw.env");
  writeFileSync(envFile, "SOME_API_TOKEN=dotenv-value\nOTHER=1\n");
  const env = { CREDENTIALS_DIRECTORY: dir };
  const { log } = quietLog();
  runInstancePathsGate({ env, envPath: envFile, log, exit: () => { throw new Error("exit"); }, credentialRoots: roots });
  assert.equal(env.SOME_API_TOKEN, "cred-value");
  assert.equal(env.OTHER, "1");
});

test("keys applied to process.env are dropped from the central child envs (add-on stdio, supervised children)", async () => {
  const { withoutCredentialKeys, credentialKeyNames, _resetCredentialKeysForTest } = await import("../servers/shared/credentials-env.js");
  const { addonStdioEnv } = await import("../servers/gateway/proxy.js");
  const dir = credDir({ CRED_STRIP_PROBE_TOKEN: "strip-me" });
  const prevDir = process.env.CREDENTIALS_DIRECTORY;
  try {
    process.env.CREDENTIALS_DIRECTORY = dir;
    applyCredentialFiles(process.env, { roots, log: quietLog().log });
    assert.equal(process.env.CRED_STRIP_PROBE_TOKEN, "strip-me", "this process holds it");
    assert.ok(credentialKeyNames().includes("CRED_STRIP_PROBE_TOKEN"));
    assert.equal(withoutCredentialKeys(process.env).CRED_STRIP_PROBE_TOKEN, undefined);
    assert.equal(addonStdioEnv({ env: { A: "1" } }).CRED_STRIP_PROBE_TOKEN, undefined, "add-on stdio children never get it");
    assert.equal(addonStdioEnv({ env: { A: "1" } }).A, "1");
    assert.equal(process.env.CREDENTIALS_DIRECTORY, dir, "the directory pointer stays (the board-secret reader needs it)");
  } finally {
    delete process.env.CRED_STRIP_PROBE_TOKEN;
    if (prevDir === undefined) delete process.env.CREDENTIALS_DIRECTORY; else process.env.CREDENTIALS_DIRECTORY = prevDir;
    _resetCredentialKeysForTest();
  }
  const plain = { X: "1" };
  assert.equal(withoutCredentialKeys(plain), plain, "nothing applied: the same object (inherit behaviour unchanged)");
});

test("applying to a non-process env does not mark keys for stripping", async () => {
  const { credentialKeyNames } = await import("../servers/shared/credentials-env.js");
  const dir = credDir({ LOCAL_ONLY_TOKEN: "v" });
  applyCredentialFiles({ CREDENTIALS_DIRECTORY: dir }, { roots, log: quietLog().log });
  assert.ok(!credentialKeyNames().includes("LOCAL_ONLY_TOKEN"));
});
