/**
 * Compose-exact bundle .env codec (Crow keychain, Task 1).
 * The docker test runs real `docker compose config` and is skipped when compose is absent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { randomInt } from "node:crypto";
import express from "express";

process.env.CROW_HOME = mkdtempSync(join(tmpdir(), "crow-codec-home-"));
process.env.CROW_DATA_DIR = mkdtempSync(join(tmpdir(), "crow-codec-data-"));
process.env.CROW_AUTO_UPDATE = "0";
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";

const C = await import("../servers/gateway/bundle-env-codec.js");
const S = await import("../servers/gateway/bundle-env-secrets.js");
const B = await import("../servers/gateway/routes/bundles.js");

const BT = "\u0060";
const TILDES = ["~", "~+", "~-", "~root", "~/x", "a:~/y", "x=~", "~~", "p~q"];
const WIDE = [
  "", "plain", "Correct-Horse-1", "a=b", "p a$s'w\"d#1", "$argon2id$v=19$m=65540,t=3,p=4$abc$def",
  "it's $HOME", "a\\'b", "x\\", "\\", "  lead", "trail  ", "#hash", "a #b", "${A}", "$(id)",
  "back" + BT + "tick", "tab\there", "é😀ü", "{}~!@%^&*()[]|;:,.<>?/", ...TILDES,
];

function randomPrintable() {
  const pool = [];
  for (let c = 0x20; c < 0x7f; c++) pool.push(String.fromCharCode(c));
  pool.push("é", "😀", "\t");
  let s = "";
  const n = randomInt(1, 30);
  for (let i = 0; i < n; i++) s += pool[randomInt(pool.length)];
  // A third of the values get a tilde in a position bash would expand (C2).
  const r = randomInt(3);
  if (r === 0) s = "~" + s;
  else if (r === 1) s = s + ":~" + s;
  return s;
}

test("bare-safe values are written byte-identically to before (no churn of existing .env files)", () => {
  for (const v of ["", "abc", "Correct-Horse-1", "http://localhost:8097", "a=b", "x.y/z:1@2%3+4,5^7!8?9*0-_"]) {
    assert.equal(C.encodeEnvValue(v), v);
  }
});

test("single quotes when possible, double quotes with \\ \" $ escapes otherwise", () => {
  assert.equal(C.encodeEnvValue("p a$s#1"), "'p a$s#1'");
  assert.equal(C.encodeEnvValue("$argon2id$v=19$m=1$a$b"), "'$argon2id$v=19$m=1$a$b'");
  assert.equal(C.encodeEnvValue("it's $HOME"), "\"it's \\$HOME\"");
  assert.equal(C.encodeEnvValue("x\\"), "\"x\\\\\"");
  assert.equal(C.encodeEnvValue("say \"hi\" it's"), "\"say \\\"hi\\\" it's\"");
});

test("C2 — every tilde form is quoted, except a `~/…` value in a declared path field", () => {
  for (const v of TILDES) assert.equal(C.encodeEnvValue(v), `'${v}'`, v);
  assert.equal(C.encodeEnvValue("~/x", { path: true }), "~/x", "path fields keep bash's $HOME expansion");
  assert.equal(C.encodeEnvValue("~root/x", { path: true }), "'~root/x'", "only the ~/ shape stays bare");
  assert.equal(C.encodeEnvValue("~/a b", { path: true }), "'~/a b'");
  const keys = C.pathEnvKeys({ env_vars: [{ name: "DATA", default: "~/.crow/x" }, { name: "P2", path: true }, { name: "PW", secret: true }] });
  assert.deepEqual([...keys].sort(), ["DATA", "P2"]);
});

test("refusals: CR, LF, NUL, and a backtick that would need double quotes", () => {
  assert.match(C.envValueProblem("a\nb"), /line break or NUL/);
  assert.match(C.envValueProblem("a\rb"), /line break or NUL/);
  assert.match(C.envValueProblem("a\0b"), /line break or NUL/);
  assert.match(C.envValueProblem("it's" + BT), /backtick/);
  assert.match(C.envValueProblem(BT + "x\\"), /backtick/);
  assert.equal(C.envValueProblem("only" + BT + "tick"), null, "a backtick alone single-quotes fine");
  assert.throws(() => C.encodeEnvValue("a\nb"), /line break/);
});

test("decode(encode(v)) === v for the wide set and 500 random printable values", () => {
  const vals = [...WIDE, ...Array.from({ length: 500 }, randomPrintable)].filter((v) => !C.envValueProblem(v));
  for (const v of vals) assert.equal(C.decodeEnvValue(C.encodeEnvValue(v)), v, JSON.stringify(v));
});

test("parseEnvText: export prefix, comments, CRLF, trailing #comment on bare, last occurrence wins", () => {
  const env = C.parseEnvText("# c\nexport A=1\r\nB=x #note\nC='q #not a comment'\nB=two\n\nD=\"a\\zb\"\n");
  assert.deepEqual(env, { A: "1", B: "two", C: "q #not a comment", D: "a\\zb" });
});

test("formatEnvLines skips undefined/null, keeps empty as KEY=, newline-terminated", () => {
  assert.equal(C.formatEnvLines({ A: "x", B: undefined, C: null, D: "" }), "A=x\nD=\n");
  assert.equal(C.formatEnvLines({}), "");
  assert.equal(C.formatEnvLines({ P: "~/d", Q: "~/d" }, { pathKeys: new Set(["P"]) }), "P=~/d\nQ='~/d'\n");
});

const LEGACY = [
  "# operator comment — keep me",
  "P=p$ss",
  "Q=\"a\\nb\"",
  "R=it's" + BT + "x",
  "DATA=~/.crow/data",
  "KEEP=1",
  "",
].join("\n");

test("C4 — updateEnvText is line-preserving: untouched legacy lines stay byte-for-byte", () => {
  const out = C.updateEnvText(LEGACY, { KEEP: "2", NEW: "a b" }, { remove: [] });
  assert.equal(out, LEGACY.replace("KEEP=1", "KEEP=2") + "NEW='a b'\n");
  assert.equal(C.updateEnvText("A=1\nA=2\n", { A: "3" }), "A=1\nA=3\n", "the LAST occurrence (compose's) is updated");
  assert.equal(C.updateEnvText("A=1\nB=2\n", {}, { remove: ["A"] }), "B=2\n");
  assert.equal(C.updateEnvText("", { A: "" }), "A=\n");
});

test("bundle-env-secrets re-exports the codec's parseEnvText", () => {
  assert.equal(S.parseEnvText, C.parseEnvText);
});

test("findInvalidEnv refuses with the codec's reason and names only the key", () => {
  assert.deepEqual(B.findInvalidEnv({ OK: "p a$s'w\"d" }), null);
  const bad = B.findInvalidEnv({ PW: "it's" + BT + "x" });
  assert.equal(bad.key, "PW");
  assert.match(bad.why, /backtick/);
  assert.ok(!JSON.stringify(bad).includes("it's"), "the value is never echoed");
});

test("writeInstallEnv writes encoded lines that parse back to the exact values", () => {
  const dir = mkdtempSync(join(tmpdir(), "crow-codec-dest-"));
  const vals = Object.fromEntries(WIDE.filter((v) => v !== "" && !C.envValueProblem(v)).map((v, i) => [`K${i}`, v]));
  B.writeInstallEnv(dir, vals, { env_vars: [] });
  assert.deepEqual(C.parseEnvText(readFileSync(join(dir, ".env"), "utf8")), vals);
});

test("C4 — writeInstallEnv with a base text keeps the base's lines and only sets the given keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "crow-codec-base-"));
  B.writeInstallEnv(dir, { NEW: "x y", KEEP: "9" }, { env_vars: [{ name: "DATA", default: "~/.crow/data" }] }, () => {}, { baseText: LEGACY });
  assert.equal(readFileSync(join(dir, ".env"), "utf8"), LEGACY.replace("KEEP=1", "KEEP=9") + "NEW='x y'\n");
});

test("C4 — a Configure save never rewrites (or 500s on) untouched legacy lines", async () => {
  const id = "codec-legacy";
  const dir = join(process.env.CROW_HOME, "bundles", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ id, name: id, type: "bundle", version: "0.1.0", env_vars: [{ name: "KEEP" }, { name: "PW", secret: true }] }));
  writeFileSync(join(dir, ".env"), LEGACY);
  const app = express(); app.use(express.json()); app.use(B.default());
  const server = app.listen(0, "127.0.0.1"); await new Promise((r) => server.once("listening", r));
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/bundles/api/env`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ bundle_id: id, env_vars: { PW: "new pass $1" } }),
    });
    assert.equal(r.status, 200, await r.text());
  } finally { server.close(); }
  assert.equal(readFileSync(join(dir, ".env"), "utf8"), LEGACY + "PW='new pass $1'\n");
});

const hasCompose = spawnSync("docker", ["compose", "version"], { encoding: "utf8" }).status === 0;

test("REVIEW FOCUS 1 — compose sees the exact value (real docker compose config)", { skip: !hasCompose && "docker compose not available" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "crow-codec-compose-"));
  const vals = [...WIDE, ...Array.from({ length: 150 }, randomPrintable)].filter((v) => !C.envValueProblem(v));
  const vars = Object.fromEntries(vals.map((v, i) => [`K${i}`, v]));
  writeFileSync(join(dir, ".env"), C.formatEnvLines(vars));
  writeFileSync(join(dir, "docker-compose.yml"),
    "services:\n  t:\n    image: busybox\n    env_file: .env\n    environment:\n"
    + Object.keys(vars).map((k) => `      ${k}x: \${${k}}\n`).join(""));
  const r = spawnSync("docker", ["compose", "config", "--format", "json"], { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const env = JSON.parse(r.stdout).services.t.environment;
  // `config` re-escapes a literal $ as $$ in its output; undo that one transformation.
  const seen = (s) => (s === undefined ? "<unset>" : String(s).replace(/\$\$/g, "$"));
  for (const [k, v] of Object.entries(vars)) {
    assert.equal(seen(env[k]), v, `env_file ${k} ${JSON.stringify(v)}`);
    assert.equal(seen(env[`${k}x`]), v, `interpolated ${k} ${JSON.stringify(v)}`);
  }
});

test("REVIEW FOCUS 1 (bash) — `set -a; . ./.env` sees the exact value, tildes included", () => {
  const dir = mkdtempSync(join(tmpdir(), "crow-codec-bash-"));
  const vals = [...WIDE, ...Array.from({ length: 150 }, randomPrintable)].filter((v) => !C.envValueProblem(v));
  const vars = Object.fromEntries(vals.map((v, i) => [`K${i}`, v]));
  writeFileSync(join(dir, ".env"), C.formatEnvLines(vars));
  const r = spawnSync("bash", ["-c", "set -a; . ./.env; set +a; node -e 'const o={};for(const[k,v]of Object.entries(process.env))if(/^K[0-9]+$/.test(k))o[k]=v;process.stdout.write(JSON.stringify(o))'"], { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), vars);
});
