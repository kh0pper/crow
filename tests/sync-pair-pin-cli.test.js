/**
 * PT-2a Task 3c: the owner-run pair-pin CLI (scripts/cli/sync-pair-pin.js).
 * U-C1 clear removes exactly one row, U-C2 refusals, U-C3 fingerprint equals
 * the documented Python one-liner, U-C4 the cleared marker. All stores are
 * scratch dirs; nothing here reads ~/.crow.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../scripts/cli/sync-pair-pin.js";
import { markPairPinned } from "../servers/shared/sync-pair-binding.js";
import { SYNC_PB_KEY_PREFIX, SYNC_PB_CLEARED_PREFIX } from "../servers/shared/self-dial-address.js";
import { makeRealDb, addPeerRow } from "./fixtures/sync-fleet.mjs";

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const LOCAL = "inst-local-0000-0000-000000000001";
const PEER = "inst-peer-0000-0000-000000000002";
const OTHER = "inst-other-0000-0000-000000000003";
const SK = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const SK2 = "ff".repeat(32);

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "sync-pin-cli-"));
  dirs.push(dir);
  const db = await makeRealDb(dir);
  writeFileSync(join(dir, "instance-id"), LOCAL + "\n");
  const tokens = join(dir, "peer-tokens.json");
  writeFileSync(tokens, JSON.stringify({
    [PEER]: { auth_token: "t1", signing_key: SK },
    [OTHER]: { auth_token: "t2", signing_key: SK2 },
  }));
  chmodSync(tokens, 0o600);
  await addPeerRow(db, PEER);
  await addPeerRow(db, OTHER);
  for (const k of [`${SYNC_PB_KEY_PREFIX}${PEER}`, `${SYNC_PB_KEY_PREFIX}${OTHER}`, `tailnet_sync_cr:${PEER}`, `instance_hs_cb:abc`]) {
    await db.execute({ sql: "INSERT INTO dashboard_settings_overrides (key, instance_id, value) VALUES (?, ?, '1')", args: [k, LOCAL] });
  }
  const env = { PATH: process.env.PATH, HOME: dir, CROW_DATA_DIR: dir, CROW_DB_PATH: join(dir, "crow.db"), CROW_PEER_TOKENS_PATH: tokens, CROW_DISABLE_NOSTR: "1" };
  return { dir, db, env, tokens };
}

function run(env, argv, extra = {}) {
  let out = "", err = "";
  const stdout = { write: (s) => { out += s; } };
  const stderr = { write: (s) => { err += s; } };
  return main({ argv, env, stdout, stderr, ...extra }).then((code) => ({ code, out, err }));
}

async function snapshot(db) {
  const { rows } = await db.execute("SELECT key, instance_id, value, updated_at FROM dashboard_settings_overrides ORDER BY key, instance_id");
  return JSON.stringify(rows.map((r) => [r.key, r.instance_id, r.value, r.updated_at]));
}

test("U-C1 --clear removes exactly the pin, writes marker + notification, second run exits 2", async () => {
  const { db, env } = await setup();
  const before = await db.execute("SELECT key, value, updated_at FROM dashboard_settings_overrides WHERE key NOT LIKE 'sync_pair_bound:%' ORDER BY key");
  const r = await run(env, ["--clear", PEER]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, new RegExp(`${SYNC_PB_KEY_PREFIX}${PEER}`));
  const keys = (await db.execute("SELECT key FROM dashboard_settings_overrides ORDER BY key")).rows.map((x) => x.key);
  assert.ok(!keys.includes(`${SYNC_PB_KEY_PREFIX}${PEER}`));
  assert.ok(keys.includes(`${SYNC_PB_KEY_PREFIX}${OTHER}`), "another peer's pin stays");
  assert.ok(keys.includes(`tailnet_sync_cr:${PEER}`) && keys.includes("instance_hs_cb:abc"));
  const after_ = await db.execute("SELECT key, value, updated_at FROM dashboard_settings_overrides WHERE key NOT LIKE 'sync_pair_bound:%' AND key NOT LIKE 'sync_pair_cleared:%' ORDER BY key");
  assert.deepEqual(after_.rows.map((x) => [x.key, x.value, x.updated_at]), before.rows.map((x) => [x.key, x.value, x.updated_at]));
  const n = await db.execute("SELECT title, type FROM notifications");
  assert.equal(n.rows.length, 1);
  assert.match(n.rows[0].title, /pair-binding pin cleared for .* by the local CLI/);
  const snap = await snapshot(db);
  const again = await run(env, ["--clear", PEER]);
  assert.equal(again.code, 2);
  assert.equal(await snapshot(db), snap, "second run changes nothing");
  assert.equal((await db.execute("SELECT 1 FROM notifications")).rows.length, 1);
});

test("U-C2 refusals: bad ids, unknown id, wrong uid change nothing", async () => {
  const { db, env, dir } = await setup();
  const snap = await snapshot(db);
  for (const id of ["__proto__", "constructor", "inst-unknown-0000", "bad id!"]) {
    const r = await run(env, ["--clear", id]);
    assert.equal(r.code, 1, `${id}: ${r.out}${r.err}`);
  }
  const owner = statSync(join(dir, "crow.db")).uid;
  const wrong = await run(env, ["--clear", PEER], { uid: owner + 1 });
  assert.equal(wrong.code, 1);
  assert.match(wrong.err, /owner/i);
  const wrongList = await run(env, ["--list"], { uid: 0 === owner ? 1 : 0 });
  assert.equal(wrongList.code, 1);
  assert.equal(await snapshot(db), snap);
  assert.equal((await db.execute("SELECT 1 FROM notifications")).rows.length, 0);
});

test("U-C4 the cleared marker shows in --list and a new bound pin removes it", async () => {
  const { db, env } = await setup();
  await run(env, ["--clear", PEER]);
  const m = await db.execute({ sql: "SELECT value FROM dashboard_settings_overrides WHERE key = ? AND instance_id = ?", args: [`${SYNC_PB_CLEARED_PREFIX}${PEER}`, LOCAL] });
  assert.equal(m.rows.length, 1);
  assert.ok(!Number.isNaN(Date.parse(m.rows[0].value)), "value is an ISO time");
  const l = await run(env, ["--list"]);
  assert.equal(l.code, 0, l.err);
  const peerLine = l.out.split("\n").find((x) => x.startsWith(PEER));
  assert.ok(peerLine.includes(m.rows[0].value), peerLine);
  assert.match(peerLine, /\bno\b/);
  const otherLine = l.out.split("\n").find((x) => x.startsWith(OTHER));
  assert.match(otherLine, /\byes\b/);
  assert.doesNotMatch(l.out, /[0-9a-f]{64}/);
  assert.equal(await markPairPinned(db, LOCAL, PEER), true);
  const gone = await db.execute({ sql: "SELECT 1 FROM dashboard_settings_overrides WHERE key = ?", args: [`${SYNC_PB_CLEARED_PREFIX}${PEER}`] });
  assert.equal(gone.rows.length, 0);
});

test("U-C3 --fingerprint equals the Python one-liner and prints no 64-hex string", async () => {
  const { env, tokens } = await setup();
  const r = await run(env, ["--fingerprint", PEER]);
  assert.equal(r.code, 0, r.err);
  assert.doesNotMatch(r.out, /[0-9a-f]{64}/i);
  const py = spawnSync("python3", ["-c",
    "import json,hmac,hashlib,sys;k=json.load(open(sys.argv[1]))[sys.argv[2]]['signing_key'];s=hmac.new(bytes.fromhex(k),b'crow/sync-pair-binding/v1',hashlib.sha256).digest();print(hashlib.sha256(s).hexdigest()[:8])",
    tokens, PEER], { encoding: "utf8", timeout: 30000 });
  assert.equal(py.status, 0, py.stderr);
  assert.match(py.stdout.trim(), /^[0-9a-f]{8}$/);
  assert.equal(r.out.trim(), py.stdout.trim());
  assert.equal((await run(env, ["--fingerprint", "inst-unknown-0000"])).code, 1);
});

test("spawned as a real process: --list and --fingerprint work, bad args exit 1", async () => {
  const { env } = await setup();
  const go = (...a) => spawnSync(process.execPath, ["scripts/cli/sync-pair-pin.js", ...a], { env, encoding: "utf8", timeout: 60000 });
  const l = go("--list");
  assert.equal(l.status, 0, l.stderr);
  assert.match(l.stdout, new RegExp(PEER));
  const f = go("--fingerprint", PEER);
  assert.equal(f.status, 0, f.stderr);
  assert.match(f.stdout.trim(), /^[0-9a-f]{8}$/);
  const c = go("--clear", PEER);
  assert.equal(c.status, 0, c.stderr);
  assert.equal(go("--clear", PEER).status, 2);
  assert.equal(go().status, 1);
  assert.equal(go("--clear", PEER, "--list").status, 1);
});
