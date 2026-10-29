/**
 * The peer credential store and the peer-relay token live in the instance's
 * hidden secrets dir (<CROW_HOME>/secrets, 700; files 600), the dir the pi
 * sandbox puts behind a tmpfs. A same-uid bot with an open shell inside the
 * sandbox must not be able to open either file.
 *
 * Covers: the one-time boot migration (fresh, both present and identical,
 * both present and different, a crash mid-copy and after the rename), the
 * PT-1 snapshot files moving along, a store an older process re-created at
 * the old path (merged under the lock), concurrent writers during the move,
 * the CROW_PEER_TOKENS_PATH override, the relay token's move, the
 * `sync-pair-pin --fingerprint` CLI, and a real PiRpc child behind the
 * sandbox (with the old path as the positive control).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, statSync, chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";

const REPO = resolve(import.meta.dirname, "..");
const PC = await import("../servers/shared/peer-credentials.js");
const LT = await import("../servers/gateway/local-token.js");
const { probePiSandbox, _resetPiSandboxForTest } = await import("../scripts/pi-bots/pi_sandbox.mjs");

const ENV_KEYS = ["CROW_HOME", "CROW_PEER_TOKENS_PATH", "CROW_DATA_DIR", "CROW_DB_PATH"];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const scratch = mkdtempSync(join(tmpdir(), "peer-creds-secrets-"));
after(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(scratch, { recursive: true, force: true });
});

let n = 0;
/** A fresh CROW_HOME for one case; the override is cleared. */
function home() {
  const h = join(scratch, `home-${++n}`);
  mkdirSync(h, { recursive: true });
  process.env.CROW_HOME = h;
  delete process.env.CROW_PEER_TOKENS_PATH;
  return h;
}
const entry = (k, ts = "2026-10-01T00:00:00.000Z") => ({ auth_token: k.repeat(64).slice(0, 64), signing_key: k.repeat(64).slice(0, 64), created_at: ts, rotated_at: null });
const json = (o) => JSON.stringify(o, null, 2);
const mode = (p) => statSync(p).mode & 0o777;
const legacy = (h) => join(h, "peer-tokens.json");
const moved = (h) => join(h, "secrets", "peer-tokens.json");

function captureWarn(fn) {
  const lines = [];
  const w = console.warn, e = console.error;
  console.warn = (...a) => lines.push(a.join(" "));
  console.error = (...a) => lines.push(a.join(" "));
  try { return { out: fn(), lines }; } finally { console.warn = w; console.error = e; }
}

test("the store and the relay token resolve under <CROW_HOME>/secrets", () => {
  const h = home();
  assert.equal(PC.peerTokensPath(), moved(h));
  assert.equal(LT.peerRelayTokenPath(), join(h, "secrets", "peer-relay-token"));
});

test("a writer creates the store 600 in a 700 secrets dir", () => {
  const h = home();
  PC.setPeerCreds("inst-a", entry("a"));
  assert.equal(mode(moved(h)), 0o600);
  assert.equal(mode(join(h, "secrets")), 0o700);
  assert.ok(!existsSync(legacy(h)), "nothing is written at the old path");
});

test("migration, fresh: the old store is copied (600, same bytes), the old file removed, PT-1 files moved along", () => {
  const h = home();
  const bytes = json({ "inst-a": entry("a"), "inst-b": entry("b") });
  writeFileSync(legacy(h), bytes, { mode: 0o600 });
  writeFileSync(legacy(h) + ".pre-pt1.done", "2026-10-01T00:00:00.000Z\n", { mode: 0o600 });
  writeFileSync(legacy(h) + ".pre-pt1.1759276800000", bytes, { mode: 0o600 });
  const r = PC.migratePeerCredsStore();
  assert.equal(r.action, "moved");
  assert.equal(readFileSync(moved(h), "utf8"), bytes, "byte-identical");
  assert.equal(mode(moved(h)), 0o600);
  assert.equal(mode(join(h, "secrets")), 0o700);
  assert.ok(!existsSync(legacy(h)), "old store removed");
  assert.ok(existsSync(moved(h) + ".pre-pt1.done"), "PT-1 marker moved");
  assert.equal(readFileSync(moved(h) + ".pre-pt1.1759276800000", "utf8"), bytes, "PT-1 snapshot moved");
  assert.equal(mode(moved(h) + ".pre-pt1.1759276800000"), 0o600);
  assert.deepEqual(readdirSync(h).filter((f) => f.startsWith("peer-tokens")), [], "nothing left at the old place");
  assert.equal(PC.getPeerCreds("inst-b").signing_key, entry("b").signing_key);
  assert.equal(PC.migratePeerCredsStore().action, "none", "idempotent");
});

test("migration, both present and byte-identical: the old one is removed", () => {
  const h = home();
  const bytes = json({ "inst-a": entry("a") });
  mkdirSync(join(h, "secrets"), { mode: 0o700 });
  writeFileSync(moved(h), bytes, { mode: 0o600 });
  writeFileSync(legacy(h), bytes, { mode: 0o600 });
  assert.equal(PC.migratePeerCredsStore().action, "removed-identical");
  assert.ok(!existsSync(legacy(h)));
  assert.equal(readFileSync(moved(h), "utf8"), bytes);
});

test("migration, both present and different (never migrated): both kept, the new one is used, loudly logged", () => {
  const h = home();
  mkdirSync(join(h, "secrets"), { mode: 0o700 });
  writeFileSync(moved(h), json({ "inst-new": entry("n") }), { mode: 0o600 });
  writeFileSync(legacy(h), json({ "inst-old": entry("o") }), { mode: 0o600 });
  const { out, lines } = captureWarn(() => PC.migratePeerCredsStore());
  assert.equal(out.action, "kept-both");
  assert.ok(lines.some((l) => /both/i.test(l) && l.includes(legacy(h))), "loud log names the old file: " + lines.join(" | "));
  assert.ok(existsSync(legacy(h)) && existsSync(moved(h)));
  assert.deepEqual(Object.keys(captureWarn(() => PC.loadPeerCreds()).out), ["inst-new"], "readers use the new store");
});

/** Run the migration in a child that dies at `stage` (a real crash: process.exit, no cleanup). */
function crashAt(h, stage) {
  const code = `
    const PC = await import(${JSON.stringify(join(REPO, "servers/shared/peer-credentials.js"))});
    PC._setPeerCredsFaultForTest((s) => { if (s === ${JSON.stringify(stage)}) process.exit(9); });
    PC.migratePeerCredsStore();
    process.exit(0);`;
  return new Promise((res) => {
    const c = spawn(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, CROW_HOME: h }, stdio: "ignore" });
    c.on("exit", (status) => res(status));
  });
}

/** The crashed child's locks, aged past the stale window (as at a later boot). */
function ageLocks(h) {
  for (const f of [moved(h) + ".lock", legacy(h) + ".lock"]) {
    if (!existsSync(f)) continue;
    const l = JSON.parse(readFileSync(f, "utf8"));
    writeFileSync(f, JSON.stringify({ ...l, ts: Date.now() - 120_000 }));
  }
}

test("migration, crash mid-copy (tmp written, not renamed): the old store is intact and the next boot finishes the move", async () => {
  const h = home();
  const bytes = json({ "inst-a": entry("a") });
  writeFileSync(legacy(h), bytes, { mode: 0o600 });
  assert.equal(await crashAt(h, "tmp-written"), 9, "the child died mid-copy");
  assert.equal(readFileSync(legacy(h), "utf8"), bytes, "old store untouched");
  assert.ok(!existsSync(moved(h)), "no half-written store at the new path");
  assert.ok(readdirSync(join(h, "secrets")).some((f) => f.endsWith(".tmp")), "precondition: the crash left a tmp file");
  assert.ok(existsSync(moved(h) + ".lock"), "precondition: the crash left its lock");
  ageLocks(h);
  assert.equal(PC.migratePeerCredsStore().action, "moved");
  assert.equal(readFileSync(moved(h), "utf8"), bytes);
  assert.ok(!existsSync(legacy(h)));
  assert.deepEqual(readdirSync(join(h, "secrets")).filter((f) => f.endsWith(".tmp")), [], "the crashed writer's tmp file is removed under the lock");
});

test("migration, crash after the rename (before the old file is removed): the next boot removes the identical old one", async () => {
  const h = home();
  const bytes = json({ "inst-a": entry("a") });
  writeFileSync(legacy(h), bytes, { mode: 0o600 });
  assert.equal(await crashAt(h, "renamed"), 9);
  assert.ok(existsSync(legacy(h)) && existsSync(moved(h)), "precondition: both present");
  ageLocks(h);
  assert.equal(PC.migratePeerCredsStore().action, "removed-identical");
  assert.ok(!existsSync(legacy(h)));
  assert.equal(readFileSync(moved(h), "utf8"), bytes);
});

test("mixed versions: a store re-created at the old path after the move is set aside, never merged, and removed", () => {
  const h = home();
  writeFileSync(legacy(h), json({ "inst-a": entry("a") }), { mode: 0o600 });
  PC.migratePeerCredsStore();
  // An older pair CLI pairs a new peer, or a bot plants a newer key for inst-a.
  const recreated = json({
    "inst-c": entry("c", "2026-10-20T00:00:00.000Z"),
    "inst-a": { signing_key: "f".repeat(64), created_at: "2099-01-01T00:00:00.000Z", rotated_at: null },
  });
  writeFileSync(legacy(h), recreated, { mode: 0o600 });
  const { out: all, lines } = captureWarn(() => PC.loadPeerCreds());
  assert.deepEqual(Object.keys(all), ["inst-a"], "nothing from the old path enters the store");
  assert.equal(all["inst-a"].signing_key, entry("a").signing_key, "a planted key never replaces the store's");
  assert.ok(!existsSync(legacy(h)), "the re-created old file is removed");
  const aside = readdirSync(join(h, "secrets")).filter((f) => f.startsWith("peer-tokens.json.legacy-"));
  assert.equal(aside.length, 1, "kept aside in the hidden dir for the operator");
  assert.equal(readFileSync(join(h, "secrets", aside[0]), "utf8"), recreated);
  assert.equal(mode(join(h, "secrets", aside[0])), 0o600);
  const log = lines.join(" | ");
  assert.ok(log.includes("inst-c") && log.includes("NOT merged"), "logged with the peer ids: " + log);
  assert.ok(!log.includes("f".repeat(64)), "never the key");
});

test("mixed versions: a writer sets a re-created old file aside too, and its own write lands", () => {
  const h = home();
  PC.setPeerCreds("inst-a", entry("a"));
  writeFileSync(legacy(h), json({ "inst-z": entry("z") }), { mode: 0o600 });
  captureWarn(() => PC.setPeerCreds("inst-b", entry("b")));
  assert.deepEqual(Object.keys(PC.loadPeerCreds()).sort(), ["inst-a", "inst-b"]);
  assert.ok(!existsSync(legacy(h)));
});

test("on a fresh host the first boot fixes the new layout: a later old-path file is never adopted, even with no store yet", () => {
  const h = home();
  assert.equal(PC.migratePeerCredsStore().action, "none");
  assert.ok(existsSync(moved(h) + ".migrated"), "the layout marker is written at first boot");
  writeFileSync(legacy(h), json({ "inst-planted": entry("p") }), { mode: 0o600 });
  const { out } = captureWarn(() => PC.loadPeerCreds());
  assert.deepEqual(out, {}, "not read through the old-path fallback");
  assert.ok(!existsSync(moved(h)) || !PC.loadPeerCreds()["inst-planted"], "not adopted as the store");
  assert.ok(!existsSync(legacy(h)));
});

test("a lock planted beside the old path never blocks a write, and stalls a reader only briefly", () => {
  const h = home();
  PC.setPeerCreds("inst-a", entry("a"));
  writeFileSync(legacy(h), json({ "inst-z": entry("z") }), { mode: 0o600 });
  // A live pid and a timestamp in the future: never judged stale.
  writeFileSync(legacy(h) + ".lock", JSON.stringify({ pid: process.pid, ts: Date.now() + 3_600_000, nonce: "x" }));
  const t0 = Date.now();
  const { out } = captureWarn(() => PC.loadPeerCreds());
  assert.ok(Date.now() - t0 < 2_000, "the reader did not wait out the full lock timeout");
  assert.ok(out["inst-a"]);
  captureWarn(() => PC.setPeerCreds("inst-b", entry("b")));
  assert.ok(PC.loadPeerCreds()["inst-b"], "the write landed");
});

test("concurrent writers during the move: every write and every migrated entry survives", async () => {
  const h = home();
  const seed = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`inst-seed${i}`, entry(String(i))]));
  writeFileSync(legacy(h), json(seed), { mode: 0o600 });
  const N = 8;
  const code = (i) => `
    const PC = await import(${JSON.stringify(join(REPO, "servers/shared/peer-credentials.js"))});
    for (let j = 0; j < 5; j++) PC.setPeerCreds("inst-w${i}-" + j, { auth_token: "${i}", signing_key: "${i}" });
    if (${i} % 2 === 0) PC.migratePeerCredsStore();`;
  const runs = Array.from({ length: N }, (_, i) => new Promise((res, rej) => {
    const c = spawn(process.execPath, ["--input-type=module", "-e", code(i)], { env: { ...process.env, CROW_HOME: h }, stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    c.stderr.on("data", (d) => { err += d; });
    c.on("exit", (s) => (s === 0 ? res() : rej(new Error(`writer ${i} exited ${s}: ${err}`))));
  }));
  await Promise.all(runs);
  const all = PC.loadPeerCreds();
  for (const id of Object.keys(seed)) assert.ok(all[id], `migrated ${id} survives`);
  for (let i = 0; i < N; i++) for (let j = 0; j < 5; j++) assert.ok(all[`inst-w${i}-${j}`], `write w${i}-${j} survives`);
  assert.ok(!existsSync(legacy(h)));
  assert.equal(mode(moved(h)), 0o600);
});

test("CROW_PEER_TOKENS_PATH is honoured: read and written there; the default-location files are never touched", () => {
  const h = home();
  const custom = join(scratch, `custom-${n}`, "tokens.json");
  process.env.CROW_PEER_TOKENS_PATH = custom;
  const other = json({ "inst-other": entry("o") });
  writeFileSync(legacy(h), other, { mode: 0o600 });
  try {
    assert.equal(PC.peerTokensPath(), custom);
    PC.setPeerCreds("inst-a", entry("a"));
    assert.deepEqual(Object.keys(PC.loadPeerCreds()), ["inst-a"]);
    assert.equal(PC.migratePeerCredsStore().action, "none");
    assert.equal(readFileSync(legacy(h), "utf8"), other, "the CROW_HOME file is not this process's store: untouched");
    assert.ok(!existsSync(moved(h)));
    assert.equal(mode(custom), 0o600);
  } finally { delete process.env.CROW_PEER_TOKENS_PATH; }
});

test("the PT-1 snapshot is not re-taken after the move (its marker moved along)", async () => {
  const h = home();
  writeFileSync(legacy(h), json({ "inst-a": entry("a") }), { mode: 0o600 });
  writeFileSync(legacy(h) + ".pre-pt1.done", "x\n", { mode: 0o600 });
  PC.migratePeerCredsStore();
  const { snapshotStoreOnce } = await import("../servers/gateway/peer-trust-sweeper.js");
  assert.equal(snapshotStoreOnce(), null, "no second snapshot");
});

test("the relay token moves into secrets/ at boot without being re-minted, and is minted there when absent", async () => {
  const { makeRealDb } = await import("./fixtures/sync-fleet.mjs");
  const h = home();
  const data = join(h, "data");
  mkdirSync(data, { recursive: true });
  process.env.CROW_DATA_DIR = data;
  const db = await makeRealDb(data);
  try {
    await LT.generatePeerRelayToken(db);
    const tok = readFileSync(LT.peerRelayTokenPath(), "utf8");
    assert.equal(mode(LT.peerRelayTokenPath()), 0o600);
    assert.equal(mode(join(h, "secrets")), 0o700);
    // An earlier version left it at the old place.
    writeFileSync(join(h, "peer-relay-token"), tok, { mode: 0o600 });
    rmSync(LT.peerRelayTokenPath());
    assert.deepEqual(await LT.ensurePeerRelayToken(db), { minted: false }, "moved, not re-minted");
    assert.equal(readFileSync(LT.peerRelayTokenPath(), "utf8"), tok);
    assert.ok(!existsSync(join(h, "peer-relay-token")));
    assert.equal(await LT.validatePeerRelayToken(db, tok), true);
    // A token planted at the old path (a bot shell can write there) is discarded, never adopted.
    rmSync(LT.peerRelayTokenPath());
    writeFileSync(join(h, "peer-relay-token"), "planted-token", { mode: 0o600 });
    assert.deepEqual(await LT.ensurePeerRelayToken(db), { minted: true }, "re-minted instead");
    assert.ok(!existsSync(join(h, "peer-relay-token")));
    assert.notEqual(readFileSync(LT.peerRelayTokenPath(), "utf8"), "planted-token");
    assert.equal(await LT.validatePeerRelayToken(db, "planted-token"), false);
  } finally { db.close(); delete process.env.CROW_DATA_DIR; }
});

test("sync-pair-pin --fingerprint reads the key at the new location", async () => {
  const { main } = await import("../scripts/cli/sync-pair-pin.js");
  assert.equal(typeof main, "function", "the CLI exports main");
  const h = home();
  const data = join(h, "data");
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, "instance-id"), "inst-local-0001\n");
  const d = new Database(join(data, "crow.db"));
  d.exec(`CREATE TABLE crow_instances (id TEXT PRIMARY KEY, name TEXT, status TEXT, trusted INTEGER, auth_token_hash TEXT, gateway_url TEXT, updated_at TEXT)`);
  d.prepare("INSERT INTO crow_instances (id, name, status) VALUES (?, ?, ?)").run("inst-peer-0001", "peer", "active");
  d.close();
  const key = "ab".repeat(32);
  mkdirSync(join(h, "secrets"), { mode: 0o700 });
  writeFileSync(moved(h), json({ "inst-peer-0001": { auth_token: "c".repeat(64), signing_key: key } }), { mode: 0o600 });
  const { pairSubkey } = await import("../servers/shared/sync-pair-binding.js");
  const want = createHash("sha256").update(pairSubkey(key)).digest("hex").slice(0, 8);
  let out = "", err = "";
  const code = await main({ argv: ["--fingerprint", "inst-peer-0001"],
    env: { ...process.env, CROW_HOME: h, CROW_DATA_DIR: data },
    stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } },
  });
  assert.equal(code, 0, err + out);
  assert.equal(out.trim(), want);
});

// ---- a real PiRpc child behind the sandbox ----

_resetPiSandboxForTest();
const SANDBOX = probePiSandbox({ force: true });
const noSandbox = SANDBOX.ok ? false : "pi sandbox unavailable here: " + SANDBOX.reason;

test("integration: a sandboxed pi child cannot open the store or the relay token; it CAN open files at their old paths", { skip: noSandbox }, async () => {
  const h = home();
  const { PiRpc } = await import("../scripts/pi-bots/bridge.mjs");
  const CANARY = "canary-" + Math.random().toString(16).slice(2);
  PC.setPeerCreds("inst-canary", { auth_token: CANARY, signing_key: CANARY });
  mkdirSync(join(h, "secrets"), { recursive: true, mode: 0o700 });
  writeFileSync(LT.peerRelayTokenPath(), CANARY, { mode: 0o600 });
  // Positive control: the same bytes at the paths these files used to live at.
  writeFileSync(join(h, "control-peer-tokens.json"), CANARY, { mode: 0o600 });
  writeFileSync(join(h, "control-peer-relay-token"), CANARY, { mode: 0o600 });
  const dir = mkdtempSync(join(scratch, "pi-"));
  const stub = join(dir, "stub-pi.mjs");
  writeFileSync(stub, [
    'import { readFileSync } from "node:fs";',
    'const probe = (p) => { try { return readFileSync(p, "utf8").includes(process.env.PIBOT_TEST_CANARY) ? "read" : "other"; } catch (e) { return e.code || "denied"; } };',
    'const paths = JSON.parse(process.env.PIBOT_TEST_PATHS);',
    'process.stdout.write(JSON.stringify({ type: "report", res: Object.fromEntries(Object.entries(paths).map(([k, p]) => [k, probe(p)])) }) + "\\n");',
    'process.stdin.resume();',
  ].join("\n"));
  const paths = {
    store: PC.peerTokensPath(), relay: LT.peerRelayTokenPath(),
    oldStore: join(h, "control-peer-tokens.json"), oldRelay: join(h, "control-peer-relay-token"),
  };
  const prev = { p: process.env.PIBOT_TEST_PATHS, c: process.env.PIBOT_TEST_CANARY };
  process.env.PIBOT_TEST_PATHS = JSON.stringify(paths);
  process.env.PIBOT_TEST_CANARY = CANARY;
  const pi = new PiRpc({ def: {}, sessionDir: dir, resolved: { provider: "p", model: "m", key: "p/m" }, nodeBin: process.execPath, cliPath: stub });
  try {
    assert.equal(pi.sandboxed, true);
    const r = await pi.waitFor((m) => m.type === "report", 20000, "report");
    assert.equal(r.res.oldStore, "read", "control: a file where the store used to be IS readable inside");
    assert.equal(r.res.oldRelay, "read", "control: a file where the relay token used to be IS readable inside");
    assert.notEqual(r.res.store, "read", "the store is hidden: " + r.res.store);
    assert.notEqual(r.res.relay, "read", "the relay token is hidden: " + r.res.relay);
    assert.equal(readFileSync(paths.store, "utf8").includes(CANARY), true, "the parent still reads the store");
  } finally {
    await pi.close();
    for (const [k, v] of [["PIBOT_TEST_PATHS", prev.p], ["PIBOT_TEST_CANARY", prev.c]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});
