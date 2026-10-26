/**
 * The secret values list and file behind maskSecrets() and pi-lab's
 * PI_BOT_SECRET_VALUES_FILE (contract 2026-10-26). Every value here is an
 * obvious fake built at runtime; every path is a scratch dir.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, lstatSync, readdirSync, symlinkSync, chmodSync, existsSync, renameSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, createHash as createHashFn } from "node:crypto";
import Database from "better-sqlite3";

const SV = await import("../servers/shared/secret-values.js");
const { collectSecretValues, collectSecretValueSets, confirmManualEntriesForCards, listManualEntriesForCards, refreshSecretValuesFile, parseEnvPairs } = await import("../servers/shared/secret-values-collect.js");
const { sealSecret } = await import("../servers/sharing/secret-box.js");
const { KEYCHAIN_DDL } = await import("../servers/gateway/keychain/schema.js");

const fake = (tag) => "fake-" + tag + "-" + "0000";
/** A generated-secret-shaped fake (base64url, 40+ chars), as the installer mints. */
const gen = (tag) => "fakeGen" + tag + "Ab3x".repeat(9);

/** Manual keychain entries (operator-typed) in a scratch instance's crow.db. */
function addManual(I, values) {
  const seed = randomBytes(32);
  mkdirSync(join(I.home, "secrets"), { recursive: true });
  writeFileSync(join(I.home, "secrets", "keychain.key"), JSON.stringify({ v: 1, id: "0123456789abcdef", key: seed.toString("base64") }), { mode: 0o600 });
  const db = new Database(join(I.data, "crow.db"));
  db.exec(KEYCHAIN_DDL);
  db.exec("DELETE FROM crow_keychain");
  for (const v of values) db.prepare("INSERT INTO crow_keychain (kind,label,secret_sealed,key_id,origin) VALUES ('manual','m',?,?,'manual')").run(sealSecret(v, { seed }), "0123456789abcdef");
  db.close();
  SV.recordCardSecret(values, I.env);                  // what the keychain UI records on save
}

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
  // a keychain value with a space still counts (masked on display paths;
  // the card rule drops shell-shaped values at mask time)
  for (const [label, val] of [["sudo", v.keychainManual], ["short", v.keychainShort], ["spaced", "fake keychain spaced"]]) {
    db.prepare("INSERT INTO crow_keychain (kind,label,secret_sealed,key_id,origin) VALUES ('manual',?,?,?,'manual')").run(label, sealSecret(val, { seed }), "0123456789abcdef");
  }
  db.prepare("INSERT INTO crow_keychain (kind,label,secret_sealed,key_id,origin) VALUES ('manual','old',?,?,'manual')").run(sealSecret(fake("otherkey"), { seed: randomBytes(32) }), "ffffffffffffffff");
  db.prepare("INSERT INTO providers VALUES ('p1','http://x',?)").run(dropped.provider);
  db.close();

  const vals = collectSecretValues({ env: { ...I.env, SOME_API_KEY: dropped.procEnv } });
  for (const [k, val] of Object.entries(v)) assert.ok(vals.includes(val), k);
  for (const [k, val] of Object.entries(dropped)) assert.equal(vals.includes(val), false, k);
  assert.ok(vals.includes("fake keychain spaced"), "spaced keychain value kept for display");
  for (const not of [fake("otherkey"), "/srv/media/library", "postgres", "some-plain-words-here"]) {
    assert.equal(vals.includes(not), false, not);
  }
});

test("this process's own env masks in memory with its full values (the card rule is applied at mask time)", () => {
  const I = scratchInstance();
  SV.invalidateSecretValues();
  const env = { ...I.env, A_TOKEN: "Zq8xP2mAk9Lw4tRy", B_TOKEN: "Dotted9.Token-value", E_PASSWORD: "pa$$" + " w0rd&x" };
  const vals = SV.getSecretValues({ env });
  for (const v of ["Zq8xP2mAk9Lw4tRy", "Dotted9.Token-value", "pa$$ w0rd&x"]) assert.ok(vals.includes(v), v);
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
  addManual(I, [gen("first"), gen("twolonger")]);
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
  assert.equal(readFileSync(r.path, "utf8"), gen("twolonger") + "\n" + gen("first") + "\n");
  // no temp file left beside it
  assert.deepEqual(readdirSync(join(I.home, "secrets")).filter((n) => n.includes(".tmp-")), []);
  const ino = st.ino;
  assert.equal(refreshSecretValuesFile({ env: I.env }).written, false);
  assert.equal(lstatSync(r.path).ino, ino);
  // a change is a NEW inode (rename), never an in-place rewrite
  addManual(I, [gen("three")]);
  SV.recordCardSecret(gen("three"), I.env);            // saved through the UI
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
  addManual(I, [gen("first")]);
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
  const path = SV.secretValuesDisplayPath(I.env);
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
  addManual(I, [gen("shareddisk")]);
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
  addManual(A, [gen("instancea")]);
  addManual(B, [gen("instanceb")]);
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

test("keychain: manual entries (operator-typed) count as they are; extension entries (backfill can seal a bot-written value) only when generated-shaped", () => {
  const I = scratchInstance();
  const seed = randomBytes(32);
  mkdirSync(join(I.home, "secrets"), { recursive: true });
  writeFileSync(join(I.home, "secrets", "keychain.key"), JSON.stringify({ v: 1, id: "0123456789abcdef", key: seed.toString("base64") }), { mode: 0o600 });
  const db = new Database(join(I.data, "crow.db"));
  db.exec(KEYCHAIN_DDL);
  const add = (kind, bundle, envKey, val, origin) => db.prepare("INSERT INTO crow_keychain (kind,label,bundle_id,env_key,secret_sealed,key_id,origin) VALUES (?,?,?,?,?,?,?)")
    .run(kind, "l", bundle, envKey, sealSecret(val, { seed }), "0123456789abcdef", origin);
  add("manual", null, null, "reboot99", "manual");
  add("extension", "demo", "A", "reboot98", "typed");
  add("extension", "demo", "B", "{rm,-rf,~}", "generated");
  add("extension", "demo", "C", gen("ext"), "generated");
  db.close();
  const vals = collectSecretValues({ env: I.env });
  assert.ok(vals.includes("reboot99"), "manual entry");
  assert.ok(vals.includes(gen("ext")), "generated-shaped extension entry");
  for (const not of ["reboot98", "{rm,-rf,~}"]) assert.equal(vals.includes(not), false, not);
});

test("two sets: display masking uses every trusted value; cards and the values file only manual keychain entries (shell-safe)", () => {
  const I = scratchInstance();
  const seed = randomBytes(32);
  mkdirSync(join(I.home, "secrets", "bundle-env"), { recursive: true });
  writeFileSync(join(I.home, "secrets", "keychain.key"), JSON.stringify({ v: 1, id: "0123456789abcdef", key: seed.toString("base64") }), { mode: 0o600 });
  writeFileSync(join(I.home, "secrets", "bundle-env", "demo.env"), "GEN=" + gen("retained") + "\n");
  const db = new Database(join(I.data, "crow.db"));
  db.exec(KEYCHAIN_DDL);
  const add = (kind, val) => db.prepare("INSERT INTO crow_keychain (kind,label,bundle_id,env_key,secret_sealed,key_id,origin) VALUES (?,?,?,?,?,?,?)")
    .run(kind, "l", kind === "manual" ? null : "demo", kind === "manual" ? null : "K" + val.length, sealSecret(val, { seed }), "0123456789abcdef", kind === "manual" ? "manual" : "generated");
  add("manual", "N0t_a-real_pw9");
  add("manual", "pa$$" + " w0rd&x");
  add("extension", gen("ext"));
  db.close();
  SV.recordCardSecret(["N0t_a-real_pw9", "pa$$" + " w0rd&x"], I.env);
  const sets = collectSecretValueSets({ env: I.env });
  for (const v of ["N0t_a-real_pw9", "pa$$ w0rd&x", gen("ext"), gen("retained")]) assert.ok(sets.display.includes(v), "display " + v);
  assert.deepEqual(sets.card, ["N0t_a-real_pw9"], "cards: manual and shell-safe only");
  const r = refreshSecretValuesFile({ env: I.env });
  assert.equal(readFileSync(r.path, "utf8"), "N0t_a-real_pw9\n", "the file pi-lab reads holds the card set");
  SV.invalidateSecretValues();
  assert.ok(SV.getSecretValues({ env: I.env }).includes(gen("retained")), "this process's display set (in memory)");
  assert.equal(SV.getCardValues({ env: I.env }).includes(gen("retained")), false);
  assert.ok(SV.getCardValues({ env: I.env }).includes("N0t_a-real_pw9"));
});

// ---- two files, operator hash list, in-memory card set, secrets-dir anchor ----

test("two files: the card set (named to pi) and the display set, side by side in the hidden dir", () => {
  const I = scratchInstance();
  addManual(I, ["N0t_a-real_pw9"]);
  mkdirSync(join(I.home, "secrets", "bundle-env"), { recursive: true });
  writeFileSync(join(I.home, "secrets", "bundle-env", "d.env"), "G=" + gen("display") + "\n");
  const r = refreshSecretValuesFile({ env: I.env });
  assert.equal(r.path, SV.secretValuesPath(I.env));
  assert.equal(readFileSync(SV.secretValuesPath(I.env), "utf8"), "N0t_a-real_pw9\n");
  const display = readFileSync(SV.secretValuesDisplayPath(I.env), "utf8").split("\n");
  assert.ok(display.includes("N0t_a-real_pw9") && display.includes(gen("display")));
  assert.equal(lstatSync(SV.secretValuesDisplayPath(I.env)).mode & 0o777, 0o600);
});

test("cards count only manual entries the operator recorded: no list means no card values (no first-run seeding); the one-time confirm records them; a row inserted later does not count", () => {
  const I = scratchInstance();
  const seed = randomBytes(32);
  mkdirSync(join(I.home, "secrets"), { recursive: true });
  writeFileSync(join(I.home, "secrets", "keychain.key"), JSON.stringify({ v: 1, id: "0123456789abcdef", key: seed.toString("base64") }), { mode: 0o600 });
  const db = new Database(join(I.data, "crow.db"));
  db.exec(KEYCHAIN_DDL);
  const ins = (v) => db.prepare("INSERT INTO crow_keychain (kind,label,secret_sealed,key_id,origin) VALUES ('manual','m',?,?,'manual')").run(sealSecret(v, { seed }), "0123456789abcdef");
  ins("Existing_pw-1");
  assert.deepEqual(collectSecretValueSets({ env: I.env }).card, [], "no list: nothing is trusted on cards");
  const nonce = randomBytes(32);
  assert.equal(confirmManualEntriesForCards({ env: I.env, nonce, pairs: listManualEntriesForCards({ env: I.env, nonce }).map((e) => ({ id: e.id, fingerprint: e.fingerprint })) }), 1, "the operator confirms each entry by id and fingerprint");
  assert.deepEqual(collectSecretValueSets({ env: I.env }).card, ["Existing_pw-1"]);
  ins("Planted_pw-2");                                   // a bot with crow.db write access
  const sets = collectSecretValueSets({ env: I.env });
  assert.deepEqual(sets.card, ["Existing_pw-1"]);
  assert.ok(sets.display.includes("Planted_pw-2"), "display paths may still mask it");
  ins("master");                                          // weak values never hide text on cards
  SV.recordCardSecret("master", I.env);
  assert.equal(collectSecretValueSets({ env: I.env }).card.includes("master"), false);
  db.close();
});

test("getCardValues uses only this process's collected card set, never a file", () => {
  const I = scratchInstance();
  SV.primeSecretValues([], []);
  SV.writeSecretValuesFile(SV.secretValuesPath(I.env), ["Planted_file-9"]);
  assert.equal(SV.getCardValues({ env: I.env }).includes("Planted_file-9"), false);
  SV.primeSecretValues(["Known_value-9"], ["Known_value-9"]);
  assert.ok(SV.getCardValues({ env: I.env }).includes("Known_value-9"));
  SV.primeSecretValues([], []);
});

test("a secrets dir renamed away and replaced after it was anchored is not trusted (its files are ignored)", () => {
  const I = scratchInstance();
  mkdirSync(join(I.home, "secrets"), { recursive: true, mode: 0o700 });
  SV.anchorSecretsDir(I.env);
  SV.writeSecretValuesFile(SV.secretValuesDisplayPath(I.env), ["Real_display-1"]);
  SV.invalidateSecretValues();
  assert.ok(SV.getSecretValues({ env: I.env }).includes("Real_display-1"));
  renameSync(join(I.home, "secrets"), join(I.home, "secrets-moved"));
  mkdirSync(join(I.home, "secrets"), { mode: 0o700 });
  writeFileSync(SV.secretValuesDisplayPath(I.env), "Planted_display-2\n", { mode: 0o600 });
  SV.invalidateSecretValues();
  const vals = SV.getSecretValues({ env: I.env });
  assert.equal(vals.includes("Planted_display-2"), false);
  assert.equal(SV.secretsDirTrusted(I.env), false);
  SV.invalidateSecretValues();
});

test("the operator confirm: an HMAC fingerprint under a per-run nonce (no character of the value); a sanitized label; confirm needs the same run's nonce and refuses any mismatch", () => {
  const I = scratchInstance();
  const seed = randomBytes(32);
  mkdirSync(join(I.home, "secrets"), { recursive: true });
  writeFileSync(join(I.home, "secrets", "keychain.key"), JSON.stringify({ v: 1, id: "0123456789abcdef", key: seed.toString("base64") }), { mode: 0o600 });
  const db = new Database(join(I.data, "crow.db"));
  db.exec(KEYCHAIN_DDL);
  const ins = (label, v) => Number(db.prepare("INSERT INTO crow_keychain (kind,label,secret_sealed,key_id,origin) VALUES ('manual',?,?,?,'manual')").run(label, sealSecret(v, { seed }), "0123456789abcdef").lastInsertRowid);
  const keep = ins("sudo on crow", "Keep_this-pw1-long");
  const evil = ins("GitHub token\u001b[2K\u009b" + "x".repeat(120), "Bot_flipped-pw2-long");
  db.close();
  const nonce = randomBytes(32);
  const listed = listManualEntriesForCards({ env: I.env, nonce });
  const k = listed.find((e) => e.id === keep);
  const e = listed.find((x) => x.id === evil);
  assert.match(k.fingerprint, /^[0-9a-f]{8}$/, "8 hex, nothing of the value");
  assert.notEqual(listManualEntriesForCards({ env: I.env, nonce: randomBytes(32) }).find((x) => x.id === keep).fingerprint, k.fingerprint, "a fingerprint is useless outside its run");
  assert.equal(/[\u0000-\u001f\u007f-\u009f]/.test(e.label), false, "control characters stripped");
  assert.ok(e.label.length <= 80, "label capped");
  assert.equal(confirmManualEntriesForCards({ env: I.env, nonce, pairs: [{ id: keep, fingerprint: e.fingerprint }] }), 0, "a mismatch records nothing");
  assert.equal(confirmManualEntriesForCards({ env: I.env, nonce: randomBytes(32), pairs: [{ id: keep, fingerprint: k.fingerprint }] }), 0, "another run's nonce records nothing");
  assert.deepEqual(collectSecretValueSets({ env: I.env }).card, []);
  assert.equal(confirmManualEntriesForCards({ env: I.env, nonce, pairs: [{ id: keep, fingerprint: k.fingerprint }] }), 1);
  assert.deepEqual(collectSecretValueSets({ env: I.env }).card, ["Keep_this-pw1-long"]);
});

test("the confirm CLI is interactive: it lists, reads id:fingerprint picks on stdin, records them; picks in argv are refused", async () => {
  const I = scratchInstance();
  const seed = randomBytes(32);
  mkdirSync(join(I.home, "secrets"), { recursive: true });
  writeFileSync(join(I.home, "secrets", "keychain.key"), JSON.stringify({ v: 1, id: "0123456789abcdef", key: seed.toString("base64") }), { mode: 0o600 });
  const db = new Database(join(I.data, "crow.db"));
  db.exec(KEYCHAIN_DDL);
  const id = Number(db.prepare("INSERT INTO crow_keychain (kind,label,secret_sealed,key_id,origin) VALUES ('manual','sudo',?,?,'manual')").run(sealSecret("Cli_confirm-pw9", { seed }), "0123456789abcdef").lastInsertRowid);
  db.close();
  const { spawn, spawnSync } = await import("node:child_process");
  const cli = new URL("../scripts/ops/keychain-card-secrets.mjs", import.meta.url).pathname;
  const env = { ...process.env, ...I.env, CROW_DB_PATH: join(I.data, "crow.db") };
  assert.notEqual(spawnSync(process.execPath, [cli, "confirm", id + ":deadbeef"], { env }).status, 0, "argv picks refused");
  const out = await new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [cli, "confirm"], { env });
    let o = "";
    let sent = false;
    c.stdout.on("data", (d) => {
      o += d;
      const m = o.match(new RegExp("^\\s*" + id + "\\s+([0-9a-f]{8})", "m"));
      if (m && !sent && /pick/i.test(o)) { sent = true; c.stdin.write(id + ":" + m[1] + "\n\n"); c.stdin.end(); }
    });
    c.on("exit", (code) => (code === 0 ? resolve(o) : reject(new Error("exit " + code + ": " + o))));
  });
  assert.match(out, /1 entry confirmed/);
  assert.equal(out.includes("Cli_confirm"), false, "never the value");
  assert.ok(readFileSync(join(I.home, "secrets", "card-secret-hashes"), "utf8").includes(createHashFn("sha256").update("Cli_confirm-pw9").digest("hex")));
});

test("every Crow home on the host is found by the shape of its secrets dir, whatever its name and from either side", () => {
  const root = mkdtempSync(join(tmpdir(), "crow-homes-"));
  const home = join(root, "user");
  const mk = (dir) => { mkdirSync(join(dir, "secrets"), { recursive: true }); writeFileSync(join(dir, "secrets", "keychain.key"), "{}"); return dir; };
  const def = mk(join(home, ".crow"));
  const r4 = mk(join(home, ".crow-r4"));
  const odd = mk(join(home, "crow-r4-home"));
  const elsewhere = mk(join(root, "srv", "second-user-home"));
  mkdirSync(join(home, "not-crow", "secrets"), { recursive: true });              // no keychain.key: not a Crow home
  const realS = mk(join(root, "real-target"));
  mkdirSync(join(home, ".crow-linked"), { recursive: true });
  symlinkSync(join(realS, "secrets"), join(home, ".crow-linked", "secrets"));
  writeFileSync(join(home, ".crow-linked", "secrets", "keychain.key"), "{}");
  const units = join(root, "units");
  mkdirSync(join(units, "x.service.d"), { recursive: true });
  writeFileSync(join(units, "x.service.d", "override.conf"), "[Service]\nEnvironment=CROW_HOME=" + elsewhere + "\n");
  const opts = { home, unitDirs: [units], envFileDirs: [] };
  const fromR4 = SV.instanceSecretsDirs({ CROW_HOME: r4 }, opts);
  for (const d of [def, odd, elsewhere]) assert.ok(fromR4.includes(join(d, "secrets")), "R4 hides " + d);
  assert.ok(fromR4.includes(join(realS, "secrets")), "a symlinked secrets dir is hidden at its target");
  assert.equal(fromR4.includes(join(r4, "secrets")), false, "not its own (that one is hidden through its anchor)");
  assert.equal(fromR4.some((d) => d.includes("not-crow")), false);
  const fromDefault = SV.instanceSecretsDirs({ CROW_HOME: def }, opts);
  for (const d of [r4, odd, elsewhere]) assert.ok(fromDefault.includes(join(d, "secrets")), "default hides " + d);
  rmSync(root, { recursive: true, force: true });
});
