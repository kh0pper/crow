/**
 * The secret values list and file behind maskSecrets() and pi-lab's
 * PI_BOT_SECRET_VALUES_FILE (contract 2026-10-26). Every value here is an
 * obvious fake built at runtime; every path is a scratch dir.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, lstatSync, readdirSync, symlinkSync, chmodSync, existsSync, renameSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";

const SV = await import("../servers/shared/secret-values.js");
const { collectSecretValues, refreshSecretValuesFile, parseEnvPairs } = await import("../servers/shared/secret-values-collect.js");
const { sealSecret } = await import("../servers/sharing/secret-box.js");
const { KEYCHAIN_DDL } = await import("../servers/gateway/keychain/schema.js");

const fake = (tag) => "fake-" + tag + "-" + "0000";
/** A generated-secret-shaped fake (base64url, 40+ chars), as the installer mints. */
const gen = (tag) => "fakeGen" + tag + "Ab3x".repeat(9);

function scratchInstance() {
  const root = mkdtempSync(join(tmpdir(), "crow-secret-values-"));
  const home = join(root, "home");
  const data = join(home, "data");
  const app = join(root, "app");
  mkdirSync(data, { recursive: true });
  mkdirSync(app, { recursive: true });
  return { root, home, data, app, env: { CROW_HOME: home, CROW_DATA_DIR: data, CROW_APP_ROOT: app } };
}

test("isSecretEnvName: credential names in, ordinary and look-alike names out", () => {
  for (const n of ["MINIO_ROOT_PASSWORD", "PGPASSWORD", "GITHUB_PERSONAL_ACCESS_TOKEN", "CROW_LOCAL_MCP_TOKEN", "PHONE_RUNNER_SECRET",
    "PW", "SUDO_PW", "KEY_A", "OPENAI_API_KEY", "MY_APIKEY", "SMTP_PASSWD", "ADMIN_PASS", "SENTRY_DSN", "GITHUBTOKEN", "AWS_CREDENTIALS"]) {
    assert.equal(SV.isSecretEnvName(n), true, n);
  }
  for (const n of ["MAX_TOKENS", "PWD", "OLDPWD", "CROW_GATEWAY_PORT", "KEYBOARD", "MONKEY_COUNT", "CROW_SESSION_TTL", "AUTH_MODE", "LANG", ""]) {
    assert.equal(SV.isSecretEnvName(n), false, n);
  }
});

test("plausibleSecretValue: placeholders, words, numbers and paths are not secrets", () => {
  for (const v of ["required", "lm-studio", "sk-no-key-required", "changeme123", "8080", "true", "/home/x/.crow/secret", "${OTHER}", "abc12", "your-token-here"]) {
    assert.equal(SV.plausibleSecretValue(v), false, v);
  }
  for (const v of [fake("pw"), "Zq8xP2mA", "a1b2c3d4e5"]) assert.equal(SV.plausibleSecretValue(v), true, v);
});

test("normalizeValues: 6+ chars, one line, deduped, longest first; long lines of a multi-line value", () => {
  const multi = "line-one-is-long-enough-x\nshort\nline-two-is-long-enough-y";
  assert.deepEqual(SV.normalizeValues(["abcdefgh", "abcdefgh", "abc", 7, "abcdefghij", multi]),
    ["line-one-is-long-enough-x", "line-two-is-long-enough-y", "abcdefghij", "abcdefgh"]);
});

test("collect: only sources a sandboxed bot cannot write (keychain, the hidden secrets dir); every bot-writable source is dropped", () => {
  const I = scratchInstance();
  const strong = (tag) => "Zq8x" + tag + "P2mAk9Lw4tRy";
  const v = { retained: gen("retained"), keychainManual: fake("keychain-manual"), keychainShort: "s3cr@t" };
  // bot-writable under the default sandbox (--dev-bind / /): none of these may count
  const dropped = {
    homeEnv: strong("homeenv"), appEnv: strong("appenv"), extraEnv: strong("extraenv"), bundleGen: strong("bundlegen"),
    tokenFile: strong("tokenfile"), peer: strong("peer"), ntfy: "tk_" + "f".repeat(29), provider: strong("provider"), procEnv: strong("procenv"),
  };
  writeFileSync(join(I.home, ".env"), "SUDO_PW=" + dropped.homeEnv + "\n");
  writeFileSync(join(I.app, ".env"), "GH_TOKEN=" + dropped.appEnv + "\n");
  mkdirSync(join(I.home, "env"));
  writeFileSync(join(I.home, "env", "x.env"), "DB_PASSWORD=" + dropped.extraEnv + "\n");
  mkdirSync(join(I.home, "bundles", "demo"), { recursive: true });
  writeFileSync(join(I.home, "bundles", "demo", "manifest.json"), JSON.stringify({ env_vars: [{ name: "ROOT_PW_GEN", generate: "secret" }] }));
  writeFileSync(join(I.home, "bundles", "demo", ".env"), "ROOT_PW_GEN=" + dropped.bundleGen + "\n");
  writeFileSync(join(I.home, "board-token"), dropped.tokenFile + "\n");
  writeFileSync(join(I.home, "peer-tokens.json"), JSON.stringify({ peer1: { auth_token: dropped.peer } }));
  writeFileSync(join(I.data, "ntfy-push.json"), JSON.stringify({ topic: "t", appToken: dropped.ntfy }));
  mkdirSync(join(I.home, "secrets", "bundle-env"), { recursive: true });
  writeFileSync(join(I.home, "secrets", "bundle-env", "demo.env"), "SOME_GENERATED=" + v.retained + "\nFLAG_LIKE=--no-verify-x\nDOMAIN_LIKE=evil.example.com\nMEDIA_PATH=/srv/media/library\nDB_USER=postgres\nWORDY=some-plain-words-here\n");
  const seed = randomBytes(32);
  writeFileSync(join(I.home, "secrets", "keychain.key"), JSON.stringify({ v: 1, id: "0123456789abcdef", key: seed.toString("base64") }), { mode: 0o600 });
  const db = new Database(join(I.data, "crow.db"));
  db.exec(KEYCHAIN_DDL);
  db.exec("CREATE TABLE providers (id TEXT PRIMARY KEY, base_url TEXT, api_key TEXT)");
  // a keychain value with a space (or any shell-ish shape) does not count:
  // the trade-off for a poisoned backfill never hiding a command
  for (const [label, val] of [["sudo", v.keychainManual], ["short", v.keychainShort], ["spaced", "fake keychain spaced"]]) {
    db.prepare("INSERT INTO crow_keychain (kind,label,secret_sealed,key_id,origin) VALUES ('manual',?,?,?,'manual')").run(label, sealSecret(val, { seed }), "0123456789abcdef");
  }
  db.prepare("INSERT INTO crow_keychain (kind,label,secret_sealed,key_id,origin) VALUES ('manual','old',?,?,'manual')").run(sealSecret(fake("otherkey"), { seed: randomBytes(32) }), "ffffffffffffffff");
  db.prepare("INSERT INTO providers VALUES ('p1','http://x',?)").run(dropped.provider);
  db.close();

  const vals = collectSecretValues({ env: { ...I.env, SOME_API_KEY: dropped.procEnv } });
  for (const [k, val] of Object.entries(v)) assert.ok(vals.includes(val), k);
  for (const [k, val] of Object.entries(dropped)) assert.equal(vals.includes(val), false, k);
  for (const not of [fake("otherkey"), "--no-verify-x", "evil.example.com", "/srv/media/library", "postgres", "some-plain-words-here", "fake keychain spaced"]) {
    assert.equal(vals.includes(not), false, not);
  }
});

test("this process's own env (the operator's, not bot-writable at runtime) masks in memory, minus dot-, domain- and flag-shaped values", () => {
  const I = scratchInstance();
  SV.invalidateSecretValues();
  const env = { ...I.env, A_TOKEN: "Zq8xP2mAk9Lw4tRy", B_TOKEN: "evil.example.com", C_TOKEN: "--insecure-x", D_SECRET: "v1.2.3-build9", E_PASSWORD: "s3cr@t-pw" };
  const vals = SV.getSecretValues({ env });
  assert.ok(vals.includes("Zq8xP2mAk9Lw4tRy"));
  assert.ok(vals.includes("s3cr@t-pw"));
  for (const not of ["evil.example.com", "--insecure-x", "v1.2.3-build9"]) assert.equal(vals.includes(not), false, not);
  SV.invalidateSecretValues();
});

test("collect: a missing or damaged source is skipped, never thrown", () => {
  const I = scratchInstance();
  writeFileSync(join(I.data, "crow.db"), "not a database");
  writeFileSync(join(I.home, "peer-tokens.json"), "{broken");
  assert.deepEqual(collectSecretValues({ env: I.env }), []);
});

test("the file: <CROW_HOME>/secrets, 600 in a 700 dir, one value per line, atomic, unchanged content not rewritten", () => {
  const I = scratchInstance();
  const retained = (text) => { mkdirSync(join(I.home, "secrets", "bundle-env"), { recursive: true }); writeFileSync(join(I.home, "secrets", "bundle-env", "x.env"), text); };
  retained("A=" + gen("one") + "\nB=" + gen("twolonger") + "\n");
  const r = refreshSecretValuesFile({ env: I.env });
  assert.equal(r.path, join(I.home, "secrets", "pi-bot-secret-values"));
  assert.equal(r.path, SV.secretValuesPath(I.env));
  assert.equal(r.count, 2);
  assert.equal(r.written, true);
  const st = lstatSync(r.path);
  assert.equal(st.isFile(), true);
  assert.equal(st.mode & 0o777, 0o600);
  assert.equal(st.uid, process.getuid());
  assert.equal(statSync(join(I.home, "secrets")).mode & 0o777, 0o700);
  assert.equal(readFileSync(r.path, "utf8"), gen("twolonger") + "\n" + gen("one") + "\n");
  // no temp file left beside it
  assert.deepEqual(readdirSync(join(I.home, "secrets")).filter((n) => n.includes(".tmp-")), []);
  const ino = st.ino;
  assert.equal(refreshSecretValuesFile({ env: I.env }).written, false);
  assert.equal(lstatSync(r.path).ino, ino);
  // a change is a NEW inode (rename), never an in-place rewrite
  retained("A=" + gen("three") + "\n");
  const r2 = refreshSecretValuesFile({ env: I.env });
  assert.equal(r2.written, true);
  assert.notEqual(lstatSync(r.path).ino, ino);
  assert.equal(readFileSync(r.path, "utf8"), gen("three") + "\n");
});

test("the file: a symlink or non-regular target is refused, not followed", () => {
  const I = scratchInstance();
  mkdirSync(join(I.home, "secrets"), { recursive: true, mode: 0o700 });
  const elsewhere = join(I.root, "elsewhere");
  writeFileSync(elsewhere, "untouched");
  symlinkSync(elsewhere, SV.secretValuesPath(I.env));
  mkdirSync(join(I.home, "secrets", "bundle-env"), { recursive: true });
  writeFileSync(join(I.home, "secrets", "bundle-env", "x.env"), "A=" + gen("one") + "\n");
  const logs = [];
  assert.equal(refreshSecretValuesFile({ env: I.env, log: (l) => logs.push(l) }), null);
  assert.equal(readFileSync(elsewhere, "utf8"), "untouched");
  assert.match(logs.join(), /not a regular file/);
});

test("concurrent writers (separate processes) never collide or leave a partial file", async () => {
  const I = scratchInstance();
  const path = SV.secretValuesPath(I.env);
  const mod = new URL("../servers/shared/secret-values.js", import.meta.url).href;
  const { execFile } = await import("node:child_process");
  const run = (i) => new Promise((res, rej) => execFile(process.execPath, ["--input-type=module", "-e",
    `const m = await import(${JSON.stringify(mod)}); for (let k = 0; k < 40; k++) m.writeSecretValuesFile(${JSON.stringify(path)}, ["fake-v${i}-" + k + "-aaaa", "fake-w${i}-" + k + "-bbbb"]);`],
    (err, so, se) => (err ? rej(new Error(se || err.message)) : res())));
  await Promise.all(Array.from({ length: 6 }, (_, i) => run(i)));
  const lines = readFileSync(path, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines.join(" "), /^fake-[vw]\d-\d+-(aaaa|bbbb) fake-[vw]\d-\d+-(aaaa|bbbb)$/);
  assert.equal(lstatSync(path).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(join(I.home, "secrets")).filter((n) => n.includes(".tmp-")), []);
});

test("readSecretValuesFile trust checks: mode 644, symlink and missing file are ignored", () => {
  const I = scratchInstance();
  const path = SV.secretValuesPath(I.env);
  SV.writeSecretValuesFile(path, [fake("trusted")]);
  assert.deepEqual(SV.readSecretValuesFile(path).values, [fake("trusted")]);
  chmodSync(path, 0o644);
  assert.equal(SV.readSecretValuesFile(path), null);
  assert.equal(SV.readSecretValuesFile(join(I.home, "nope")), null);
  const link = join(I.home, "link");
  symlinkSync(path, link);
  chmodSync(path, 0o600);
  assert.equal(SV.readSecretValuesFile(link), null);
});

test("getSecretValues: file + own env; a file another process replaced is seen on the next call", () => {
  const I = scratchInstance();
  const path = SV.secretValuesPath(I.env);
  SV.writeSecretValuesFile(path, [fake("first")]);
  const env = { ...I.env, MY_TOKEN: fake("ownenv") };
  const a = SV.getSecretValues({ env });
  assert.ok(a.includes(fake("first")) && a.includes(fake("ownenv")));
  assert.equal(SV.getSecretValues({ env }), a, "unchanged file: the cached list");
  // another process: a rename to a new inode, no cache priming here
  const tmp = path + ".other";
  writeFileSync(tmp, fake("second-value") + "\n", { mode: 0o600 });
  renameSync(tmp, path);
  assert.ok(SV.getSecretValues({ env }).includes(fake("second-value")));
  assert.equal(SV.getSecretValues({ env }).includes(fake("first")), false);
  SV.invalidateSecretValues();
});

test("the writer: a strict umask still yields 600; a looser existing dir is tightened; stale temps are swept", () => {
  const I = scratchInstance();
  mkdirSync(join(I.home, "secrets"), { mode: 0o755 });
  chmodSync(join(I.home, "secrets"), 0o755);
  const stale = join(I.home, "secrets", ".pi-bot-secret-values.tmp-1-old");
  writeFileSync(stale, "leftover");
  utimesSync(stale, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
  const old = process.umask(0o277);
  try { SV.writeSecretValuesFile(SV.secretValuesPath(I.env), [fake("umask")]); } finally { process.umask(old); }
  assert.equal(statSync(SV.secretValuesPath(I.env)).mode & 0o777, 0o600);
  assert.equal(statSync(join(I.home, "secrets")).mode & 0o777, 0o700);
  assert.equal(existsSync(stale), false);
});

test("parseEnvPairs: quotes, export, comments", () => {
  assert.deepEqual(parseEnvPairs("# c\nexport A='x y'\nB=\"z\"\nbad line\n=nokey\nC=plain\n"), { A: "x y", B: "z", C: "plain" });
});

test("the mask path never loads a database driver or the keychain", () => {
  for (const f of ["servers/shared/secret-mask.js", "servers/shared/secret-values.js"]) {
    const src = readFileSync(new URL("../" + f, import.meta.url), "utf8");
    const imports = [...src.matchAll(/^\s*import\s[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
    for (const i of imports) {
      assert.equal(/better-sqlite3|libsql|keychain|secret-values-collect|\/db\.js$/.test(i), false, f + " imports " + i);
    }
  }
  assert.ok(existsSync(new URL("../servers/shared/secret-values-collect.js", import.meta.url)));
});

test("two writers with different process envs write the SAME file: neither drops the other's values", () => {
  const I = scratchInstance();
  mkdirSync(join(I.home, "secrets", "bundle-env"), { recursive: true });
  writeFileSync(join(I.home, "secrets", "bundle-env", "x.env"), "SHARED=" + gen("shareddisk") + "\n");
  const a = refreshSecretValuesFile({ env: { ...I.env, ONLY_UNIT_A_TOKEN: fake("unit-a") } });
  const first = readFileSync(a.path, "utf8");
  const b = refreshSecretValuesFile({ env: { ...I.env, ONLY_UNIT_B_TOKEN: fake("unit-b") } });
  assert.equal(b.written, false, "unit B's write changes nothing");
  assert.equal(readFileSync(b.path, "utf8"), first);
  assert.equal(first, gen("shareddisk") + "\n");
  // each unit's own env values still mask in that unit's process
  assert.ok(SV.getSecretValues({ env: { ...I.env, ONLY_UNIT_A_TOKEN: fake("unit-a") } }).includes(fake("unit-a")));
});

test("each instance has its own file: a co-hosted instance's write never touches another's", () => {
  const A = scratchInstance();
  const B = scratchInstance();
  for (const [X, tag] of [[A, "instance-a"], [B, "instance-b"]]) {
    mkdirSync(join(X.home, "secrets", "bundle-env"), { recursive: true });
    writeFileSync(join(X.home, "secrets", "bundle-env", "x.env"), "K=" + gen(tag.replace("-", "")) + "\n");
  }
  const ra = refreshSecretValuesFile({ env: A.env });
  const rb = refreshSecretValuesFile({ env: B.env });
  assert.notEqual(ra.path, rb.path);
  assert.equal(readFileSync(ra.path, "utf8"), gen("instancea") + "\n");
  assert.equal(readFileSync(rb.path, "utf8"), gen("instanceb") + "\n");
});

test("readSecretValuesFile ignores a file reached through a symlinked directory", () => {
  const I = scratchInstance();
  const real = join(I.root, "realdir");
  mkdirSync(real, { mode: 0o700 });
  SV.writeSecretValuesFile(join(real, "v"), [fake("via-link")]);
  symlinkSync(real, join(I.root, "linkdir"));
  assert.equal(SV.readSecretValuesFile(join(I.root, "linkdir", "v")), null);
  assert.ok(SV.readSecretValuesFile(join(real, "v")));
});

test("no exact value from any source may contain whitespace or shell operators, be a path or a URL (a trusted row can be poisoned at backfill)", () => {
  for (const bad of ["&& rm -rf ~", "a b c d e f", "x;reboot9", "$(id)abc", "`id`abcd", "/tmp/evil-x", "~/evil-x", "./evil-x", "https://evil/x"]) {
    assert.equal(SV.safeShape(bad), false, bad);
  }
  for (const good of ["Zq8xP2mAk9Lw4tRy", "s3cr@t-pw", "N0t_a-real_pw!"]) assert.equal(SV.safeShape(good), true, good);
});
