/** Bitwarden-CLI vault save against a FAKE bw (Task 5). No network, no real vault. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, utimesSync, statSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const V = await import("../servers/gateway/keychain/vault-save.js");

// The fake bw: behaviour from mode.txt beside it, one JSON line per call to calls.jsonl.
const FAKE_BW = String.raw`
const fs = require("node:fs"), path = require("node:path");
const dir = __dirname;
const mode = fs.existsSync(path.join(dir, "mode.txt")) ? fs.readFileSync(path.join(dir, "mode.txt"), "utf8").trim() : "ok";
const args = process.argv.slice(2);
let stdin = "";
try { stdin = fs.readFileSync(0, "utf8"); } catch {}
const appdata = process.env.BITWARDENCLI_APPDATA_DIR || "";
let seed = null, seedMode = null;
if (appdata && fs.existsSync(path.join(appdata, "data.json"))) {
  seed = fs.readFileSync(path.join(appdata, "data.json"), "utf8");
  seedMode = fs.statSync(path.join(appdata, "data.json")).mode & 0o777;
}
if (appdata) fs.writeFileSync(path.join(appdata, "data.json"), JSON.stringify({ ...(seed ? JSON.parse(seed) : {}), touchedBy: args[0] }));
fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify({
  args, stdin, appdata, home: process.env.HOME || null, seed, seedMode, envKeys: Object.keys(process.env).sort(),
  master: process.env.CROW_BW_MASTER || null, session: process.env.BW_SESSION || null,
}) + "\n");
const cmd = args[0];
if (mode === "hang" && cmd === "login") setTimeout(() => {}, 1e9);
else if (cmd === "login" && mode === "wrong") { process.stderr.write("Username or password is incorrect. Try again\n"); process.exit(1); }
else if (cmd === "login" && mode === "twostep") { process.stderr.write("Code is required.\n"); process.exit(1); }
else if (cmd === "login" && mode === "down") { process.stderr.write("request to http://127.0.0.1:18097/identity/connect/token failed, reason: connect ECONNREFUSED\n"); process.exit(1); }
else if (cmd === "login" && mode === "insecure") { process.stderr.write("Unable to fetch ServerConfig from http://localhost:18097/api InsecureUrlNotAllowedError: Insecure URL not allowed. All URLs must use HTTPS.\n"); process.exit(1); }
else if (cmd === "login") { process.stdout.write("FAKE-SESSION-KEY\n"); }
else if (cmd === "create" && mode === "createfail") { process.stderr.write("boom\n"); process.exit(1); }
else if (cmd === "create") { process.stdout.write("{\"id\":\"x\"}\n"); }
`;

function fakeCli(mode = "ok") {
  const dir = mkdtempSync(join(tmpdir(), "crow-fakebw-"));
  writeFileSync(join(dir, "bw.cjs"), FAKE_BW);
  writeFileSync(join(dir, "mode.txt"), mode);
  const tmpRoot = mkdtempSync(join(tmpdir(), "crow-bwtmp-"));
  const crowHome = mkdtempSync(join(tmpdir(), "crow-bwhome-"));
  const calls = () => (existsSync(join(dir, "calls.jsonl")) ? readFileSync(join(dir, "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  return { cliPath: join(dir, "bw.cjs"), tmpRoot, crowHome, calls };
}

const ITEM = { name: "Workspace admin", username: "admin", password: "p a$s'w\"d", url: "https://ws.example:8456", notes: "Saved by Crow" };
const BASE = { serverUrl: "https://vault.example.invalid:8461", email: "k@example.invalid", masterPassword: "Master-PW-1", item: ITEM };

test("happy path: config server → login (password via env) → create item (stdin) → logout", async () => {
  const f = fakeCli("ok");
  const out = await V.saveToVault({ ...BASE, cliPath: f.cliPath, tmpRoot: f.tmpRoot, crowHome: f.crowHome });
  assert.deepEqual(out, { ok: true });
  const c = f.calls();
  assert.deepEqual(c.map((x) => x.args[0]), ["config", "login", "create", "logout"]);
  assert.deepEqual(c[0].args, ["config", "server", "https://vault.example.invalid:8461"]);
  assert.deepEqual(c[1].args, ["login", "k@example.invalid", "--passwordenv", "CROW_BW_MASTER", "--raw"]);
  assert.equal(c[1].master, "Master-PW-1");
  assert.equal(c[2].session, "FAKE-SESSION-KEY");
  const item = JSON.parse(Buffer.from(c[2].stdin.trim(), "base64").toString("utf8"));
  assert.equal(item.type, 1);
  assert.equal(item.name, "Workspace admin");
  assert.equal(item.login.username, "admin");
  assert.equal(item.login.password, "p a$s'w\"d");
  assert.deepEqual(item.login.uris, [{ match: null, uri: "https://ws.example:8456" }]);
  for (const x of c) {
    assert.ok(!x.args.join(" ").includes("Master-PW-1"), "master password never in argv");
    assert.ok(!x.args.join(" ").includes("p a$s"), "item password never in argv");
    assert.ok(!x.envKeys.includes("CROW_SESSION") && !x.envKeys.includes("CROW_HOME"), "minimal env");
  }
  assert.equal(c[0].master, null, "the master password is only in the login step's env");
});

test("REVIEW FOCUS 5 — failures are sentences; secrets never in argv; temp dir removed", async () => {
  for (const [mode, re] of [["wrong", /email or master password/i], ["twostep", /two-step login/i], ["down", /could not reach/i], ["createfail", /could not create/i]]) {
    const f = fakeCli(mode);
    const out = await V.saveToVault({ ...BASE, cliPath: f.cliPath, tmpRoot: f.tmpRoot, crowHome: f.crowHome });
    assert.equal(out.ok, false, mode);
    assert.match(out.reason, re, mode);
    assert.ok(!out.reason.includes("Master-PW-1") && !out.reason.includes("ECONNREFUSED") && !out.reason.includes("boom"), "no CLI output echoed");
    assert.deepEqual(readdirSync(f.tmpRoot), [], `${mode}: the private appdata dir is gone`);
    for (const x of f.calls()) assert.ok(!x.args.join(" ").includes("Master-PW-1"));
  }
});

test("S4 — a hung CLI is killed at the overall deadline and reported", async () => {
  const f = fakeCli("hang");
  const t0 = Date.now();
  const out = await V.saveToVault({ ...BASE, cliPath: f.cliPath, tmpRoot: f.tmpRoot, crowHome: f.crowHome, deadlineMs: 800 });
  assert.equal(out.ok, false);
  assert.match(out.reason, /took too long/i);
  assert.ok(Date.now() - t0 < 5000);
  assert.deepEqual(readdirSync(f.tmpRoot), []);
});

test("missing CLI or bad input → a reason, never a throw", async () => {
  assert.match((await V.saveToVault({ ...BASE, cliPath: "/nonexistent/bw.js" })).reason, /Bitwarden command-line tool/i);
  assert.match((await V.saveToVault({ ...BASE, cliPath: fakeCli().cliPath, email: "" })).reason, /email and master password/i);
});

test("vaultwardenStatus: installed + CLI present + decoded VAULTWARDEN_URL", () => {
  const bundles = mkdtempSync(join(tmpdir(), "crow-vwstatus-"));
  assert.deepEqual(V.vaultwardenStatus({ bundlesDir: bundles }), { installed: false, cliPath: null, serverUrl: null, secure: false, serverOutdated: null });
  const vw = join(bundles, "vaultwarden");
  mkdirSync(join(vw, "node_modules", "@bitwarden", "cli", "build"), { recursive: true });
  writeFileSync(join(vw, ".env"), "VAULTWARDEN_URL='http://127.0.0.1:18097/'\n");
  assert.equal(V.vaultwardenStatus({ bundlesDir: bundles }).cliPath, null, "no bw.js yet");
  writeFileSync(join(vw, "node_modules", "@bitwarden", "cli", "build", "bw.js"), "");
  const st = V.vaultwardenStatus({ bundlesDir: bundles });
  assert.equal(st.installed, true);
  assert.match(st.cliPath, /@bitwarden\/cli\/build\/bw\.js$/);
  assert.equal(st.serverUrl, "http://127.0.0.1:18097");
  assert.equal(st.secure, false, "R-B: the CLI refuses http://");
});

test("S3 — stale crow-bw-* dirs (a crashed save's tokens) are swept; fresh ones are left alone", () => {
  const root = mkdtempSync(join(tmpdir(), "crow-bwsweep-"));
  for (const n of ["crow-bw-old", "crow-bw-new", "other"]) mkdirSync(join(root, n));
  const old = new Date(Date.now() - 11 * 60 * 1000);
  utimesSync(join(root, "crow-bw-old"), old, old);
  utimesSync(join(root, "other"), old, old);
  assert.equal(V.sweepStaleVaultDirs(root), 1);
  assert.deepEqual(readdirSync(root).sort(), ["crow-bw-new", "other"]);
});

test("the default temp root is <CROW_HOME>/tmp, not /tmp", () => {
  const src = readFileSync(new URL("../servers/gateway/keychain/vault-save.js", import.meta.url), "utf8");
  assert.match(src, /tmpRoot = join\(CROW_HOME, "tmp"\)/);
  assert.match(src, /--core=0/, "core dumps off when prlimit exists");
});

test("m4 — an install still on an old Vaultwarden image is reported as needing a reinstall", () => {
  const bundles = mkdtempSync(join(tmpdir(), "crow-vwold-"));
  const vw = join(bundles, "vaultwarden");
  mkdirSync(vw, { recursive: true });
  writeFileSync(join(vw, "docker-compose.yml"), "services:\n  vaultwarden:\n    image: vaultwarden/server:1.32.7\n");
  assert.match(V.vaultwardenStatus({ bundlesDir: bundles }).serverOutdated, /Reinstall the Vaultwarden extension.*1\.32\.7/);
  writeFileSync(join(vw, "docker-compose.yml"), "services:\n  vaultwarden:\n    image: vaultwarden/server:1.37.3\n");
  assert.equal(V.vaultwardenStatus({ bundlesDir: bundles }).serverOutdated, null);
});

// ---------------------------------------------------------------------------
// Post-spike rulings (Task 6 live spike, CLI pinned at 2026.8.0)
// ---------------------------------------------------------------------------
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REASONS = () => new Set(Object.values(V.VAULT_REASONS));

test("R-B — vaultwardenStatus uses VAULTWARDEN_DOMAIN (the URL the CLI needs) else VAULTWARDEN_URL, and reports secure", () => {
  const bundles = mkdtempSync(join(tmpdir(), "crow-vwdomain-"));
  const vw = join(bundles, "vaultwarden");
  mkdirSync(vw, { recursive: true });
  assert.deepEqual([V.vaultwardenStatus({ bundlesDir: bundles }).serverUrl, V.vaultwardenStatus({ bundlesDir: bundles }).secure], ["http://localhost:8097", false], "default");
  writeFileSync(join(vw, ".env"), "VAULTWARDEN_URL=http://localhost:8097\nVAULTWARDEN_DOMAIN='https://crow.example.ts.net:8461/'\n");
  let st = V.vaultwardenStatus({ bundlesDir: bundles });
  assert.equal(st.serverUrl, "https://crow.example.ts.net:8461");
  assert.equal(st.secure, true);
  writeFileSync(join(vw, ".env"), "VAULTWARDEN_URL=HTTPS://vault.example.invalid//\nVAULTWARDEN_DOMAIN=\n");
  st = V.vaultwardenStatus({ bundlesDir: bundles });
  assert.equal(st.serverUrl, "HTTPS://vault.example.invalid", "empty DOMAIN falls back to URL");
  assert.equal(st.secure, true, "https:// is case-insensitive");
  writeFileSync(join(vw, ".env"), "VAULTWARDEN_DOMAIN=http://localhost:8097\nVAULTWARDEN_URL=https://vault.example.invalid\n");
  assert.equal(V.vaultwardenStatus({ bundlesDir: bundles }).secure, false, "DOMAIN wins even when it is the insecure one");
});

test("R-B — a non-https server URL is refused with insecureUrl and nothing is spawned", async () => {
  assert.equal(V.VAULT_REASONS.insecureUrl, "Vault saving needs Vaultwarden on a secure https address — see the Vaultwarden setup page.");
  for (const serverUrl of ["http://localhost:8097", "localhost:8097", "ftp://x", "  https://x"]) {
    const f = fakeCli("ok");
    const out = await V.saveToVault({ ...BASE, serverUrl, cliPath: f.cliPath, tmpRoot: f.tmpRoot, crowHome: f.crowHome });
    assert.deepEqual(out, { ok: false, reason: V.VAULT_REASONS.insecureUrl }, serverUrl);
    assert.deepEqual(f.calls(), [], `${serverUrl}: no bw process ran`);
    assert.deepEqual(readdirSync(f.tmpRoot), [], "no temp appdata dir");
    assert.ok(!existsSync(join(f.crowHome, "secrets")), "no device id minted");
  }
});

test("R-C — classifyLogin maps the exact 2026.8.0 texts", () => {
  assert.equal(V.classifyLogin("Username or password is incorrect. Try again"), V.VAULT_REASONS.wrongCredentials);
  assert.equal(V.classifyLogin("Username or password is incorrect. Try again\n"), V.VAULT_REASONS.wrongCredentials);
  assert.equal(V.classifyLogin("Code is required."), V.VAULT_REASONS.twoStep);
  assert.equal(V.classifyLogin("Unable to fetch ServerConfig from http://localhost:18097/api InsecureUrlNotAllowedError: Insecure URL not allowed. All URLs must use HTTPS."), V.VAULT_REASONS.insecureUrl);
  assert.equal(V.classifyLogin("Insecure URL not allowed"), V.VAULT_REASONS.insecureUrl);
  assert.equal(V.classifyLogin("request to https://x/identity/connect/token failed, reason: connect ECONNREFUSED"), V.VAULT_REASONS.unreachable);
  assert.equal(V.classifyLogin("something else entirely"), V.VAULT_REASONS.failed);
});

test("R-C/R-E — fake-bw login failures with the exact texts come back as fixed VAULT_REASONS sentences only", async () => {
  for (const [mode, want] of [["wrong", "wrongCredentials"], ["twostep", "twoStep"], ["insecure", "insecureUrl"], ["down", "unreachable"], ["createfail", "createFailed"], ["hang", "timeout"]]) {
    const f = fakeCli(mode);
    const out = await V.saveToVault({ ...BASE, cliPath: f.cliPath, tmpRoot: f.tmpRoot, crowHome: f.crowHome, deadlineMs: mode === "hang" ? 800 : 90_000 });
    assert.equal(out.ok, false, mode);
    assert.equal(out.reason, V.VAULT_REASONS[want], mode);
    assert.ok(REASONS().has(out.reason), `${mode}: the reason is a fixed sentence, never CLI output`);
    assert.deepEqual(Object.keys(out).sort(), ["ok", "reason"], `${mode}: nothing else leaks out`);
  }
  assert.ok(REASONS().has(V.classifyLogin("Error: secret-ish CLI text p a$s'w\"d")));
});

test("R-D — one stable device GUID per instance: seeded data.json on every spawn, same GUID across saves, 600/700, temp dirs gone", async () => {
  const f = fakeCli("ok");
  assert.deepEqual(await V.saveToVault({ ...BASE, cliPath: f.cliPath, tmpRoot: f.tmpRoot, crowHome: f.crowHome }), { ok: true });
  const idFile = join(f.crowHome, "secrets", "vault-device-id");
  assert.equal(V.vaultDeviceIdPath(f.crowHome), idFile);
  const guid = readFileSync(idFile, "utf8");
  assert.match(guid.trim(), UUID_RE);
  assert.equal(guid, `${guid.trim()}\n`, "the secrets file holds nothing but the GUID");
  assert.equal(statSync(idFile).mode & 0o777, 0o600);
  assert.equal(statSync(join(f.crowHome, "secrets")).mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(join(f.crowHome, "secrets")), ["vault-device-id"], "no temp file left behind");
  const first = f.calls();
  assert.equal(first.length, 4);
  for (const x of first) {
    assert.ok(x.appdata && x.appdata.startsWith(f.tmpRoot), "BITWARDENCLI_APPDATA_DIR on every spawn");
    assert.equal(x.home, x.appdata, "HOME = the private appdata dir on every spawn");
  }
  // The seed is what the FIRST bw process sees (later steps see the CLI's own writes).
  assert.deepEqual(JSON.parse(first[0].seed), { stateVersion: V.BW_STATE_VERSION, global_applicationId_appId: guid.trim() });
  assert.equal(V.BW_STATE_VERSION, 83);
  assert.equal(first[0].seedMode, 0o600);
  for (const x of first) assert.equal(JSON.parse(x.seed).global_applicationId_appId, guid.trim());
  assert.deepEqual(readdirSync(f.tmpRoot), [], "the temp appdata dir is gone");

  assert.deepEqual(await V.saveToVault({ ...BASE, cliPath: f.cliPath, tmpRoot: f.tmpRoot, crowHome: f.crowHome }), { ok: true });
  const second = f.calls().slice(4);
  assert.equal(second.length, 4);
  assert.notEqual(second[0].appdata, first[0].appdata, "a fresh appdata dir per save");
  assert.equal(JSON.parse(second[0].seed).global_applicationId_appId, guid.trim(), "the same GUID across saves");
  assert.equal(readFileSync(idFile, "utf8"), guid);
  assert.deepEqual(readdirSync(f.tmpRoot), []);
  for (const x of [...first, ...second]) {
    assert.ok(!x.seed.includes("Master-PW-1") && !x.seed.includes("p a$s"), "the seed carries no secrets");
  }
});

test("R-D — an invalid device-id file is moved aside and replaced, never trusted", async () => {
  const f = fakeCli("ok");
  const secrets = join(f.crowHome, "secrets");
  mkdirSync(secrets, { recursive: true });
  writeFileSync(join(secrets, "vault-device-id"), "not-a-guid\n");
  assert.deepEqual(await V.saveToVault({ ...BASE, cliPath: f.cliPath, tmpRoot: f.tmpRoot, crowHome: f.crowHome }), { ok: true });
  const guid = readFileSync(join(secrets, "vault-device-id"), "utf8").trim();
  assert.match(guid, UUID_RE);
  assert.equal(JSON.parse(f.calls()[0].seed).global_applicationId_appId, guid);
  const aside = readdirSync(secrets).filter((n) => n.startsWith("vault-device-id.invalid-"));
  assert.equal(aside.length, 1, "the bad file is moved aside");
  assert.equal(readFileSync(join(secrets, aside[0]), "utf8"), "not-a-guid\n");
  assert.equal(statSync(secrets).mode & 0o777, 0o700);
});

test("R-D — an existing valid GUID file is reused as-is (another writer won the race)", async () => {
  const f = fakeCli("ok");
  const secrets = join(f.crowHome, "secrets");
  mkdirSync(secrets, { recursive: true, mode: 0o755 });
  chmodSync(secrets, 0o755);
  const theirs = "0f8fad5b-d9cb-469f-a165-70867728950e";
  writeFileSync(join(secrets, "vault-device-id"), `${theirs}\n`, { mode: 0o600 });
  assert.equal(V.ensureVaultDeviceId({ crowHome: f.crowHome }), theirs);
  assert.equal(statSync(secrets).mode & 0o777, 0o700, "the dir is tightened to 700");
  assert.deepEqual(await V.saveToVault({ ...BASE, cliPath: f.cliPath, tmpRoot: f.tmpRoot, crowHome: f.crowHome }), { ok: true });
  assert.equal(JSON.parse(f.calls()[0].seed).global_applicationId_appId, theirs);
});
