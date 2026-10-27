/**
 * PT-1 unit tests (private engineering notes: peer-trust fix, §3 "Unit").
 * Real init-db scratch DBs only; run through npm test / scripts/run-suite.mjs.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeRealDb, addPeerRow } from "./fixtures/sync-fleet.mjs";
import { TRUSTED_PEER_SQL, peerTrust, _resetPeerTrustLogForTest } from "../servers/shared/peer-trust.js";
import { getPeerTrustHealth, _resetPeerTrustHealth } from "../servers/shared/peer-trust-health.js";

let dir, db;
before(async () => {
  dir = mkdtempSync(join(tmpdir(), "peer-trust-"));
  db = await makeRealDb(dir);
  await addPeerRow(db, "p-active", { status: "active", trusted: 1 });
  await addPeerRow(db, "p-offline", { status: "offline", trusted: 1 });
  await addPeerRow(db, "p-untrusted", { status: "active", trusted: 0 });
  await addPeerRow(db, "p-paused", { status: "paused", trusted: 1 });
  await addPeerRow(db, "p-revoked", { status: "revoked", trusted: 1 });
});
after(() => { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });

describe("peerTrust (one trust predicate)", () => {
  test("TRUSTED_PEER_SQL is the documented predicate", () => {
    assert.equal(TRUSTED_PEER_SQL, "trusted = 1 AND status IN ('active','offline')");
  });

  test("active and offline trusted rows pass", async () => {
    for (const id of ["p-active", "p-offline"]) {
      const r = await peerTrust(db, id);
      assert.equal(r.ok, true, id);
      assert.equal(r.row.id, id);
      assert.equal(r.reason, null);
    }
  });

  test("each refusal carries its reason", async () => {
    assert.deepEqual(
      [await peerTrust(db, "p-untrusted"), await peerTrust(db, "p-paused"), await peerTrust(db, "p-revoked"), await peerTrust(db, "nope")]
        .map((r) => [r.ok, r.reason]),
      [[false, "untrusted"], [false, "paused"], [false, "revoked"], [false, "unknown"]],
    );
  });

  test("a missing id is unknown without touching the DB", async () => {
    let touched = false;
    const r = await peerTrust({ execute: async () => { touched = true; return { rows: [] }; } }, "");
    assert.equal(r.reason, "unknown");
    assert.equal(touched, false);
  });

  test("U4: a DB error retries once on a fresh client", async () => {
    const throwing = { execute: async () => { throw new Error("database disk image is malformed"); } };
    let made = 0;
    const r = await peerTrust(throwing, "p-active", { freshClient: () => { made++; return { execute: (s) => db.execute(s), close() {} }; } });
    assert.equal(made, 1);
    assert.equal(r.ok, true);
  });

  test("U4: a double DB error fails closed, logs once per id per minute, and raises a health item", async () => {
    _resetPeerTrustLogForTest();
    _resetPeerTrustHealth();
    const throwing = { execute: async () => { throw new Error("boom"); }, close() {} };
    const errs = [];
    const orig = console.error;
    console.error = (...a) => errs.push(a.join(" "));
    try {
      let now = 1_000_000;
      const opts = { freshClient: () => throwing, now: () => now };
      const r1 = await peerTrust(throwing, "p-x", opts);
      const r2 = await peerTrust(throwing, "p-x", opts);
      now += 61_000;
      const r3 = await peerTrust(throwing, "p-x", opts);
      for (const r of [r1, r2, r3]) { assert.equal(r.ok, false); assert.equal(r.reason, "trust_lookup_failed"); }
      assert.equal(errs.filter((l) => l.includes("trust_lookup_failed") && l.includes("p-x")).length, 2);
      const h = getPeerTrustHealth(now);
      assert.ok(h.lookupFailures["p-x"], "health records the failing id");
    } finally { console.error = orig; }
  });
});

// ---------------------------------------------------------------------------
// U7: the credential store is written under one lock
// ---------------------------------------------------------------------------
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";

const PEER_CREDS_URL = new URL("../servers/shared/peer-credentials.js", import.meta.url).href;

function runChild(code, env) {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    c.stderr.on("data", (d) => { err += d; });
    c.on("error", reject);
    c.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`child exit ${code}: ${err}`))));
  });
}

describe("U7: peer-tokens.json store lock", () => {
  test("concurrent writers in separate processes lose nothing; no tmp left; mode 0600", { timeout: 120_000 }, async () => {
    const d = mkdtempSync(join(tmpdir(), "peer-store-"));
    const path = join(d, "peer-tokens.json");
    const env = { CROW_PEER_TOKENS_PATH: path };
    try {
      // The revoked id the deleter keeps removing.
      await runChild(`import { setPeerCreds } from ${JSON.stringify(PEER_CREDS_URL)}; setPeerCreds("revoked-x", { auth_token: "a", signing_key: "b" });`, env);
      const N = Number(process.env.PT1_U7_WRITERS || 8);
      const writers = Array.from({ length: N }, (_, w) => runChild(
        `import { setPeerCreds } from ${JSON.stringify(PEER_CREDS_URL)};
         for (let i = 0; i < 50; i++) setPeerCreds("w${w}-" + i, { auth_token: "t" + i, signing_key: "k" + i });`, env));
      const deleter = runChild(
        `import { deletePeerCreds } from ${JSON.stringify(PEER_CREDS_URL)};
         for (let i = 0; i < 200; i++) deletePeerCreds("revoked-x");`, env);
      await Promise.all([...writers, deleter]);
      const all = JSON.parse(readFileSync(path, "utf8"));
      for (let w = 0; w < N; w++) for (let i = 0; i < 50; i++) assert.ok(all[`w${w}-${i}`], `w${w}-${i} survived`);
      assert.equal(all["revoked-x"], undefined);
      assert.equal(Object.keys(all).length, N * 50);
      assert.deepEqual(readdirSync(d).filter((f) => f !== "peer-tokens.json"), [], "no tmp or lock file remains");
      assert.equal(statSync(path).mode & 0o777, 0o600);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  test("a stale lock (dead pid, older than 30 s) is broken with a warning", async () => {
    const d = mkdtempSync(join(tmpdir(), "peer-store-"));
    const path = join(d, "peer-tokens.json");
    try {
      const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]);
      const deadPid = Number(String(dead.stdout));
      writeFileSync(path + ".lock", JSON.stringify({ pid: deadPid, ts: Date.now() - 31_000 }));
      await runChild(`import { setPeerCreds } from ${JSON.stringify(PEER_CREDS_URL)}; setPeerCreds("p", { auth_token: "a", signing_key: "b" });`, { CROW_PEER_TOKENS_PATH: path });
      assert.ok(JSON.parse(readFileSync(path, "utf8")).p);
      assert.equal(existsSync(path + ".lock"), false);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });

  test("a store with loose permissions is never overwritten by a writer", async () => {
    const d = mkdtempSync(join(tmpdir(), "peer-store-"));
    const path = join(d, "peer-tokens.json");
    try {
      writeFileSync(path, JSON.stringify({ keep: { auth_token: "a", signing_key: "b" } }), { mode: 0o644 });
      await assert.rejects(runChild(`import { setPeerCreds } from ${JSON.stringify(PEER_CREDS_URL)}; setPeerCreds("p", { auth_token: "a", signing_key: "b" });`, { CROW_PEER_TOKENS_PATH: path }));
      assert.deepEqual(Object.keys(JSON.parse(readFileSync(path, "utf8"))), ["keep"]);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});

// ---------------------------------------------------------------------------
// U2: the bearer check requires a trusted, live row
// ---------------------------------------------------------------------------
import { createHash } from "node:crypto";
import { validateInstanceToken } from "../servers/gateway/instance-registry.js";

describe("U2: validateInstanceToken", () => {
  const sha = (t) => createHash("sha256").update(t).digest("hex");
  test("trusted active/offline rows authenticate; trusted=0, paused and revoked do not", async () => {
    const d = mkdtempSync(join(tmpdir(), "pt-u2-"));
    const xdb = await makeRealDb(d);
    try {
      const rows = [["u2-active", "active", 1], ["u2-offline", "offline", 1], ["u2-untrusted", "active", 0], ["u2-paused", "paused", 1]];
      for (const [id, status, trusted] of rows) {
        await addPeerRow(xdb, id, { status, trusted });
        await xdb.execute({ sql: "UPDATE crow_instances SET auth_token_hash = ? WHERE id = ?", args: [sha(`tok-${id}`), id] });
      }
      assert.equal((await validateInstanceToken(xdb, "tok-u2-active"))?.id, "u2-active");
      assert.equal((await validateInstanceToken(xdb, "tok-u2-offline"))?.id, "u2-offline");
      assert.equal(await validateInstanceToken(xdb, "tok-u2-untrusted"), null);
      assert.equal(await validateInstanceToken(xdb, "tok-u2-paused"), null);
      const { revokeInstance } = await import("../servers/gateway/instance-registry.js");
      await revokeInstance(xdb, "u2-active");
      assert.equal(await validateInstanceToken(xdb, "tok-u2-active"), null);
    } finally { try { xdb.close(); } catch {} rmSync(d, { recursive: true, force: true }); }
  });
});

// ---------------------------------------------------------------------------
// U1: crossHostVerifyMiddleware checks the row, binds the bearer, and refuses
// with one uniform body (the specific reason lands in the audit row only).
// ---------------------------------------------------------------------------
import express from "express";
import { signRequest, crossHostVerifyMiddleware, _resetNonceCache } from "../servers/shared/cross-host-auth.js";

describe("U1: crossHostVerifyMiddleware on real rows", () => {
  let u1dir, u1db, server, base, storePath;
  const KEY = "dd".repeat(32);
  const tok = (id) => `bearer-${id}`;
  const sha = (t) => createHash("sha256").update(t).digest("hex");
  const ROWS = [["u1-active", "active", 1], ["u1-offline", "offline", 1], ["u1-untrusted", "active", 0], ["u1-paused", "paused", 1], ["u1-revoked", "revoked", 1]];

  before(async () => {
    u1dir = mkdtempSync(join(tmpdir(), "pt-u1-"));
    u1db = await makeRealDb(u1dir);
    storePath = join(u1dir, "peer-tokens.json");
    const store = {};
    for (const [id, status, trusted] of ROWS) {
      await addPeerRow(u1db, id, { status, trusted });
      await u1db.execute({ sql: "UPDATE crow_instances SET auth_token_hash = ? WHERE id = ?", args: [status === "revoked" ? null : sha(tok(id)), id] });
      store[id] = { auth_token: tok(id), signing_key: KEY, created_at: new Date().toISOString(), rotated_at: null };
    }
    store["u1-missing-row"] = { auth_token: tok("u1-missing-row"), signing_key: KEY, created_at: new Date().toISOString(), rotated_at: null };
    writeFileSync(storePath, JSON.stringify(store), { mode: 0o600 });
    process.env.CROW_PEER_TOKENS_PATH = storePath;
    const app = express();
    app.use(express.json());
    app.get("/x", crossHostVerifyMiddleware(u1db, { audit: "u1.x", emptyBodyString: "" }), (req, res) => res.json({ reached: true }));
    await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    server?.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    delete process.env.CROW_PEER_TOKENS_PATH;
    try { u1db.close(); } catch {}
    rmSync(u1dir, { recursive: true, force: true });
  });

  async function call(id, { bearer = tok(id) } = {}) {
    _resetNonceCache();
    const h = signRequest({ method: "GET", path: "/x", body: "", authToken: "placeholder", signingKey: KEY, sourceInstanceId: id });
    if (bearer === null) delete h.Authorization; else h.Authorization = `Bearer ${bearer}`;
    const r = await fetch(`${base}/x`, { headers: h });
    return { status: r.status, body: await r.json() };
  }
  async function lastAuditError(id) {
    const { rows } = await u1db.execute({ sql: "SELECT error, hmac_valid FROM cross_host_calls WHERE source_instance_id = ? ORDER BY id DESC LIMIT 1", args: [id] });
    return rows[0]?.error ?? null;
  }

  test("trusted active and offline rows pass (positive control)", async () => {
    for (const id of ["u1-active", "u1-offline"]) {
      const r = await call(id);
      assert.equal(r.status, 200, id);
      assert.equal(r.body.reached, true);
    }
  });

  test("untrusted, paused, revoked and missing rows get the same 401 body; the audit row has the reason", async () => {
    const want = { "u1-untrusted": "peer_not_trusted:untrusted", "u1-paused": "peer_not_trusted:paused", "u1-revoked": "peer_not_trusted:revoked", "u1-missing-row": "peer_not_trusted:unknown" };
    for (const [id, reason] of Object.entries(want)) {
      const r = await call(id);
      assert.equal(r.status, 401, id);
      assert.deepEqual(r.body, { error: "peer_auth_failed" }, id);
      assert.equal(await lastAuditError(id), reason, id);
    }
  });

  test("a valid HMAC with a wrong or missing bearer is refused (bearer binding)", async () => {
    const wrong = await call("u1-active", { bearer: "not-the-bearer" });
    assert.equal(wrong.status, 401);
    assert.deepEqual(wrong.body, { error: "peer_auth_failed" });
    assert.equal(await lastAuditError("u1-active"), "bearer_mismatch");
    const missing = await call("u1-active", { bearer: null });
    assert.equal(missing.status, 401);
    assert.equal(await lastAuditError("u1-active"), "bearer_mismatch");
  });

  test("a bad HMAC and an unknown source share the uniform body", async () => {
    _resetNonceCache();
    const h = signRequest({ method: "GET", path: "/other", body: "", authToken: tok("u1-active"), signingKey: KEY, sourceInstanceId: "u1-active" });
    const r = await fetch(`${base}/x`, { headers: h });
    assert.equal(r.status, 401);
    assert.deepEqual(await r.json(), { error: "peer_auth_failed" });
    assert.equal(await lastAuditError("u1-active"), "hmac_mismatch");
  });

  test("an audit-write failure still yields 401, never 500", async () => {
    const app = express();
    const brokenAudit = {
      execute: async (stmt) => {
        if (/INSERT INTO cross_host_calls/.test(stmt.sql)) throw new Error("disk I/O error");
        return u1db.execute(stmt);
      },
    };
    app.get("/x", crossHostVerifyMiddleware(brokenAudit, { audit: "u1.x", emptyBodyString: "" }), (req, res) => res.json({ reached: true }));
    let s2;
    await new Promise((r) => { s2 = app.listen(0, "127.0.0.1", r); });
    try {
      _resetNonceCache();
      const h = signRequest({ method: "GET", path: "/x", body: "", authToken: tok("u1-paused"), signingKey: KEY, sourceInstanceId: "u1-paused" });
      const r = await fetch(`http://127.0.0.1:${s2.address().port}/x`, { headers: h });
      assert.equal(r.status, 401);
    } finally { s2.closeAllConnections?.(); await new Promise((r) => s2.close(r)); }
  });
});

// ---------------------------------------------------------------------------
// U3 + U11: only a re-pair un-revokes, and it writes the re-pair fence
// ---------------------------------------------------------------------------
import { updateInstance, reactivateOnRepair, getInstance, revokeInstance as revokeRow } from "../servers/gateway/instance-registry.js";
import { InstanceSyncManager } from "../servers/sharing/instance-sync.js";
import { makeSharedIdentity } from "./fixtures/sync-fleet.mjs";

const LOCAL = "local-self";
async function appliedBlob(xdb) {
  const { rows } = await xdb.execute({ sql: "SELECT last_applied_seq_per_peer AS b FROM sync_state WHERE instance_id = ?", args: [LOCAL] });
  return rows[0] ? JSON.parse(rows[0].b || "{}") : null;
}

describe("U3: updateInstance never un-revokes", () => {
  test("every edit to a revoked row is refused; setting revoked is refused; reactivateOnRepair flips it and sets the fence", async () => {
    const d = mkdtempSync(join(tmpdir(), "pt-u3-"));
    const xdb = await makeRealDb(d);
    try {
      await addPeerRow(xdb, "u3-peer", { status: "active", trusted: 1 });
      await assert.rejects(updateInstance(xdb, "u3-peer", { status: "revoked" }), (e) => e.code === "use_revoke");
      await revokeRow(xdb, "u3-peer");
      for (const f of [{ status: "active" }, { name: "x" }, { trusted: 1 }, { auth_token_hash: "ab" }]) {
        await assert.rejects(updateInstance(xdb, "u3-peer", f), (e) => e.code === "instance_revoked", JSON.stringify(f));
      }
      assert.equal((await getInstance(xdb, "u3-peer")).status, "revoked");
      // A live row still edits normally (positive control).
      await addPeerRow(xdb, "u3-live", { status: "active", trusted: 1 });
      await updateInstance(xdb, "u3-live", { name: "renamed", status: "paused" });
      assert.equal((await getInstance(xdb, "u3-live")).status, "paused");

      await reactivateOnRepair(xdb, "u3-peer", { authTokenHash: "cd".repeat(32), localInstanceId: LOCAL });
      const row = await getInstance(xdb, "u3-peer");
      assert.equal(row.status, "active");
      assert.equal(Number(row.trusted), 1);
      assert.equal(row.auth_token_hash, "cd".repeat(32));
      assert.equal((await appliedBlob(xdb))["u3-peer"].ff, 1);
    } finally { try { xdb.close(); } catch {} rmSync(d, { recursive: true, force: true }); }
  });

  test("crow_update_instance surfaces the re-pair error", async () => {
    const src = readFileSync(new URL("../servers/sharing/tools/instances.js", import.meta.url), "utf8");
    assert.match(src, /re-pair to restore a revoked instance/);
  });
});

describe("U11: the re-pair fence is written in every record shape and survives checkpoints", () => {
  async function scenario(prep) {
    const d = mkdtempSync(join(tmpdir(), "pt-u11-"));
    const xdb = await makeRealDb(d);
    await addPeerRow(xdb, "u11-peer", { status: "revoked", trusted: 1 });
    await prep(xdb);
    return { d, xdb, done() { try { xdb.close(); } catch {} rmSync(d, { recursive: true, force: true }); } };
  }
  const shapes = {
    "(a) NULL blob": async (xdb) => { await xdb.execute({ sql: "INSERT INTO sync_state (instance_id, local_counter, last_applied_seq_per_peer) VALUES (?, 0, NULL)", args: [LOCAL] }); },
    "(b) no record for the peer": async (xdb) => { await xdb.execute({ sql: "INSERT INTO sync_state (instance_id, local_counter, last_applied_seq_per_peer) VALUES (?, 0, ?)", args: [LOCAL, JSON.stringify({ other: { k: "z", s: 3 } })] }); },
    "(c) legacy bare-number record": async (xdb) => { await xdb.execute({ sql: "INSERT INTO sync_state (instance_id, local_counter, last_applied_seq_per_peer) VALUES (?, 0, ?)", args: [LOCAL, JSON.stringify({ "u11-peer": 7 })] }); },
    "(d) no sync_state row": async () => {},
  };
  for (const [name, prep] of Object.entries(shapes)) {
    test(name, async () => {
      const s = await scenario(prep);
      try {
        await reactivateOnRepair(s.xdb, "u11-peer", { authTokenHash: "ef".repeat(32), localInstanceId: LOCAL });
        const rec = (await appliedBlob(s.xdb))["u11-peer"];
        assert.equal(rec.ff, 1, JSON.stringify(rec));
        assert.equal((await getInstance(s.xdb, "u11-peer")).status, "active");
        if (name.startsWith("(b)")) assert.deepEqual((await appliedBlob(s.xdb)).other, { k: "z", s: 3 });
      } finally { s.done(); }
    });
  }

  test("a fence write that does not land aborts reactivation; the row stays revoked", async () => {
    const s = await scenario(async () => {});
    try {
      const sabotaged = {
        execute: (st) => s.xdb.execute(st),
        batch: (stmts, mode) => s.xdb.batch(stmts.map((st) => (/UPDATE sync_state/.test(st.sql) ? { sql: "UPDATE sync_state SET updated_at = updated_at WHERE 0", args: [] } : st)), mode),
      };
      await assert.rejects(reactivateOnRepair(sabotaged, "u11-peer", { authTokenHash: "ef".repeat(32), localInstanceId: LOCAL }));
      const row = await getInstance(s.xdb, "u11-peer");
      assert.equal(row.status, "revoked");
      assert.equal(row.auth_token_hash, null);
    } finally { s.done(); }
  });

  test("_setLastAppliedSeq and _reconcileAppliedSeqAtOpen carry ff forward", async () => {
    const s = await scenario(async () => {});
    try {
      await reactivateOnRepair(s.xdb, "u11-peer", { authTokenHash: "ef".repeat(32), localInstanceId: LOCAL });
      const mgr = new InstanceSyncManager(await makeSharedIdentity(), s.xdb, LOCAL);
      await mgr._setLastAppliedSeq("u11-peer", 5, "aa");
      assert.deepEqual((await appliedBlob(s.xdb))["u11-peer"], { k: "aa", s: 5, ff: 1 });
      await mgr._reconcileAppliedSeqAtOpen("u11-peer", { key: Buffer.from("bb", "hex"), length: 9 });
      assert.equal((await appliedBlob(s.xdb))["u11-peer"].ff, 1, "a feed-key change keeps the fence");
      assert.equal((await appliedBlob(s.xdb))["u11-peer"].k, "bb");
    } finally { s.done(); }
  });
});

// ---------------------------------------------------------------------------
// U8: the sync apply gate fails closed; the fence is consumed by fast-forward
// ---------------------------------------------------------------------------
describe("U8: _isPeerTrusted and fence consumption in the apply loop", () => {
  const FEED_KEY = Buffer.alloc(32, 7);
  function stubFeed(length, { update } = {}) {
    const got = [];
    return {
      key: FEED_KEY, length, peers: [{}], got,
      async get(seq) { got.push(seq); return { table: "nope", op: "insert", row: {} }; },
      ...(update ? { update } : { async update() { return true; } }),
    };
  }
  async function setup(status, trusted) {
    const d = mkdtempSync(join(tmpdir(), "pt-u8-"));
    const xdb = await makeRealDb(d);
    await addPeerRow(xdb, "u8-peer", { status, trusted });
    const mgr = new InstanceSyncManager(await makeSharedIdentity(), xdb, LOCAL);
    return { d, xdb, mgr, done() { try { xdb.close(); } catch {} rmSync(d, { recursive: true, force: true }); } };
  }

  test("a trusted peer's entries apply (positive control); untrusted and paused do not", async () => {
    for (const [status, trusted, applies] of [["active", 1, true], ["offline", 1, true], ["active", 0, false], ["paused", 1, false], ["revoked", 1, false]]) {
      const s = await setup(status, trusted);
      try {
        const feed = stubFeed(3);
        await s.mgr._processNewEntriesInner("u8-peer", feed);
        assert.equal(feed.got.length, applies ? 3 : 0, `${status}/${trusted}`);
        assert.equal(await s.mgr._getLastAppliedSeq("u8-peer", feed), applies ? 3 : 0);
      } finally { s.done(); }
    }
  });

  test("a DB error in the trust check applies nothing and does not advance the seq", async () => {
    const s = await setup("active", 1);
    try {
      const real = s.xdb;
      s.mgr.db = { execute: async (st) => { if (/FROM crow_instances/.test(st.sql)) throw new Error("database disk image is malformed"); return real.execute(st); }, batch: (...a) => real.batch(...a) };
      const feed = stubFeed(3);
      await s.mgr._processNewEntriesInner("u8-peer", feed);
      assert.equal(feed.got.length, 0);
      s.mgr.db = real;
      assert.equal(await s.mgr._getLastAppliedSeq("u8-peer", feed), 0);
    } finally { s.done(); }
  });

  test("a fenced record fast-forwards to the remote length without applying, then later entries apply", async () => {
    const s = await setup("revoked", 1);
    try {
      await reactivateOnRepair(s.xdb, "u8-peer", { authTokenHash: "aa".repeat(32), localInstanceId: LOCAL });
      const feed = stubFeed(5);
      await s.mgr._processNewEntriesInner("u8-peer", feed);
      assert.equal(feed.got.length, 0, "nothing from the revoked window is applied");
      assert.deepEqual((await appliedBlob(s.xdb))["u8-peer"], { k: FEED_KEY.toString("hex"), s: 5 });
      feed.length = 7;
      await s.mgr._processNewEntriesInner("u8-peer", feed);
      assert.deepEqual(feed.got, [5, 6], "entries after the fence apply");
    } finally { s.done(); }
  });

  test("a fence whose remote-length update fails stays, and nothing applies", async () => {
    const s = await setup("revoked", 1);
    try {
      await reactivateOnRepair(s.xdb, "u8-peer", { authTokenHash: "aa".repeat(32), localInstanceId: LOCAL });
      const feed = stubFeed(5, { update: async () => { throw new Error("no peers"); } });
      await s.mgr._processNewEntriesInner("u8-peer", feed);
      assert.equal(feed.got.length, 0);
      assert.equal((await appliedBlob(s.xdb))["u8-peer"].ff, 1);
    } finally { s.done(); }
  });
});

// ---------------------------------------------------------------------------
// U10: a revoked row is frozen (its updated_at stays the revoke time)
// ---------------------------------------------------------------------------
import { heartbeatInstance } from "../servers/gateway/instance-registry.js";
import { markInstanceConnectionSeen } from "../servers/shared/instance-status.js";

const REVOKED_ROW_WRITER_ALLOWLIST = [
  // [file, a substring unique to the allowed statement]
  ["servers/gateway/instance-registry.js", "SET status = 'revoked', auth_token_hash = NULL"], // revokeInstance
  ["servers/gateway/instance-registry.js", "status = CASE WHEN status = 'revoked' THEN 'active' ELSE status END"], // reactivateOnRepair
  ["servers/gateway/routes/instance-enroll.js", "status = CASE WHEN status = 'revoked' THEN 'active' ELSE status END"], // enroll CAS
];

/** Every `UPDATE crow_instances` statement in a source text (multiline, any quote). */
function crowInstancesUpdates(src) {
  const out = [];
  const re = /UPDATE\s+crow_instances\b/g;
  let m;
  while ((m = re.exec(src))) {
    let i = m.index - 1;
    while (i >= 0 && !['"', "`", "'"].includes(src[i])) i--;
    const q = src[i];
    const end = src.indexOf(q, m.index);
    out.push(src.slice(m.index, end === -1 ? undefined : end));
  }
  return out;
}
function unguarded(file, src) {
  return crowInstancesUpdates(src).filter((stmt) => {
    if (/status\s*!=\s*'revoked'/.test(stmt)) return false;
    return !REVOKED_ROW_WRITER_ALLOWLIST.some(([f, needle]) => f === file && stmt.replace(/\s+/g, " ").includes(needle));
  });
}

describe("U10: revoked-row writers", () => {
  test("positive control: a planted unguarded UPDATE (template string, split lines) is caught", () => {
    const planted = "await db.execute({\n  sql: `UPDATE crow_instances\n     SET sync_url = ?, updated_at = datetime('now')\n   WHERE id = ?`,\n});\n" +
      "await db.execute({ sql: \"UPDATE crow_instances SET x = 1 WHERE id = ? AND status != 'revoked'\" });";
    const bad = unguarded("servers/planted.js", planted);
    assert.equal(bad.length, 1);
    assert.match(bad[0], /sync_url/);
  });

  test("every UPDATE crow_instances under servers/ is guarded or allowlisted", () => {
    const root = new URL("../", import.meta.url);
    const files = spawnSync("git", ["ls-files", "servers"], { cwd: root, encoding: "utf8" }).stdout.split("\n").filter((f) => /\.(m?js)$/.test(f));
    const offenders = [];
    const allowHits = new Map();
    let total = 0;
    for (const f of files) {
      const src = readFileSync(new URL(f, root), "utf8");
      const stmts = crowInstancesUpdates(src);
      total += stmts.length;
      for (const [af, needle] of REVOKED_ROW_WRITER_ALLOWLIST) {
        if (af !== f) continue;
        const k = `${af}|${needle}`;
        allowHits.set(k, (allowHits.get(k) || 0) + stmts.filter((s) => s.replace(/\s+/g, " ").includes(needle)).length);
      }
      for (const s of unguarded(f, src)) offenders.push(`${f}: ${s.replace(/\s+/g, " ").slice(0, 120)}`);
    }
    assert.ok(total >= 15, `scanner found ${total} statements (expected the known writers)`);
    assert.deepEqual(offenders, []);
    for (const [k, n] of allowHits) assert.equal(n, 1, `allowlist entry matches exactly one statement: ${k}`);
    assert.equal(allowHits.size, REVOKED_ROW_WRITER_ALLOWLIST.length);
  });

  test("runtime: liveness writers leave a revoked row's updated_at alone", async () => {
    const d = mkdtempSync(join(tmpdir(), "pt-u10-"));
    const xdb = await makeRealDb(d);
    try {
      await addPeerRow(xdb, "u10-peer", { status: "revoked", trusted: 1 });
      await xdb.execute({ sql: "UPDATE crow_instances SET updated_at = '2001-01-01 00:00:00' WHERE id = ?", args: ["u10-peer"] });
      await heartbeatInstance(xdb, "u10-peer");
      await heartbeatInstance(xdb, "u10-peer", { status: "active" });
      await markInstanceConnectionSeen(xdb, { matchedIds: ["u10-peer"] });
      const row = await getInstance(xdb, "u10-peer");
      assert.equal(row.updated_at, "2001-01-01 00:00:00");
      assert.equal(row.status, "revoked");
    } finally { try { xdb.close(); } catch {} rmSync(d, { recursive: true, force: true }); }
  });
});

// ---------------------------------------------------------------------------
// The pair CLI's manual-paste path: the pasted answer must be the peer the
// operator named, and only a named id is ever reactivated.
// ---------------------------------------------------------------------------
describe("pair CLI --manual-paste vets the pasted answer", () => {
  const CLI = new URL("../scripts/cli/instance-pair.js", import.meta.url).pathname;
  async function home() {
    const d = mkdtempSync(join(tmpdir(), "pt-pair-"));
    const xdb = await makeRealDb(d);
    await addPeerRow(xdb, "peer-revoked-1", { status: "revoked", trusted: 1 });
    await addPeerRow(xdb, "peer-other-2", { status: "revoked", trusted: 1 });
    return { d, xdb };
  }
  function runPair(d, args, answer) {
    return spawnSync(process.execPath, [CLI, "--manual-paste", ...args], {
      input: JSON.stringify(answer),
      env: { ...process.env, CROW_HOME: d, CROW_DATA_DIR: d, CROW_DB_PATH: join(d, "crow.db"), CROW_PEER_TOKENS_PATH: join(d, "peer-tokens.json"), CROW_DISABLE_NOSTR: "1" },
      encoding: "utf8",
      timeout: 60_000,
    });
  }
  const base = ["--peer-name", "n", "--peer-url", "http://100.64.20.9:3001"];

  test("an answer for a different id than --peer-id is refused and writes nothing", async () => {
    const { d, xdb } = await home();
    try {
      const r = runPair(d, ["--peer-id", "peer-other-2", ...base], { peer_instance_id: "peer-revoked-1", peer_outbound_bearer: "b".repeat(64) });
      assert.notEqual(r.status, 0, r.stdout);
      assert.match(r.stderr, /not the --peer-id/);
      assert.equal((await getInstance(xdb, "peer-revoked-1")).status, "revoked");
      assert.equal((await getInstance(xdb, "peer-other-2")).status, "revoked");
      assert.equal(existsSync(join(d, "peer-tokens.json")), false);
    } finally { try { xdb.close(); } catch {} rmSync(d, { recursive: true, force: true }); }
  });

  test("an answer with no peer_instance_id is refused", async () => {
    const { d, xdb } = await home();
    try {
      const r = runPair(d, ["--peer-id", "peer-revoked-1", ...base], { peer_outbound_bearer: "b".repeat(64) });
      assert.notEqual(r.status, 0);
      assert.equal((await getInstance(xdb, "peer-revoked-1")).status, "revoked");
    } finally { try { xdb.close(); } catch {} rmSync(d, { recursive: true, force: true }); }
  });

  test("positive control: the named revoked id is re-paired, with the fence", async () => {
    const { d, xdb } = await home();
    try {
      const r = runPair(d, ["--peer-id", "peer-revoked-1", ...base], { peer_instance_id: "peer-revoked-1", peer_outbound_bearer: "b".repeat(64) });
      assert.equal(r.status, 0, r.stderr);
      const row = await getInstance(xdb, "peer-revoked-1");
      assert.equal(row.status, "active");
      const { rows } = await xdb.execute({ sql: "SELECT last_applied_seq_per_peer AS b FROM sync_state", args: [] });
      assert.equal(JSON.parse(rows[0].b)["peer-revoked-1"].ff, 1);
    } finally { try { xdb.close(); } catch {} rmSync(d, { recursive: true, force: true }); }
  });
});

// ---------------------------------------------------------------------------
// U6: peer-owned MCP sessions can be closed
// ---------------------------------------------------------------------------
import { SessionManager, closeSessionsOwnedByEverywhere, countSessionsOwnedByEverywhere } from "../servers/gateway/session-manager.js";

describe("U6: SessionManager.closeSessionsOwnedBy", () => {
  test("closes only that owner's transports, in every store", async () => {
    const sm = new SessionManager();
    const closed = [];
    const t = (name) => ({ close: async () => { closed.push(name); } });
    sm.getStore("memory", "streamable").set("s1", { transport: t("s1"), server: null, owner: "instance:B" });
    sm.getStore("memory", "sse").set("s2", { transport: t("s2"), server: null, owner: "instance:B" });
    sm.getStore("tools", "streamable").set("s3", { transport: t("s3"), server: null, owner: "instance:C" });
    sm.getStore("tools", "streamable").set("s4", { transport: t("s4"), server: null, owner: null });
    assert.equal(sm.countSessionsOwnedBy("instance:B"), 2);
    assert.equal(countSessionsOwnedByEverywhere("instance:B"), 2);
    assert.equal(await closeSessionsOwnedByEverywhere("instance:B"), 2);
    assert.deepEqual(closed.sort(), ["s1", "s2"]);
    assert.equal(sm.getStore("memory", "streamable").size, 0);
    assert.equal(sm.getStore("tools", "streamable").size, 2);
    assert.equal(sm.countSessionsOwnedBy("instance:B"), 0);
    sm.dispose();
    assert.equal(countSessionsOwnedByEverywhere("instance:C"), 0, "a disposed manager is no longer reachable");
  });

  test("the MCP routes record the session owner", () => {
    const src = readFileSync(new URL("../servers/gateway/routes/mcp.js", import.meta.url), "utf8");
    assert.equal((src.match(/owner: sessionOwner\(req\)/g) || []).length, 2, "streamable and SSE both record the owner");
  });
});

// ---------------------------------------------------------------------------
// U5: boot reconcile (minted-before rule) + revokePeer kills the key
// ---------------------------------------------------------------------------
import { reconcilePeerCreds, snapshotStoreOnce, teardownUntrustedPeers } from "../servers/gateway/peer-trust-sweeper.js";
import { revokePeer, storeMatchesDb } from "../servers/sharing/revoke-peer.js";

/** Run `fn` with this process pointed at one scratch instance home. */
async function withHome(fn) {
  const d = mkdtempSync(join(tmpdir(), "pt-home-"));
  const dataDir = join(d, "data");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(dataDir, { recursive: true });
  const xdb = await makeRealDb(dataDir);
  const saved = Object.fromEntries(["CROW_HOME", "CROW_DATA_DIR", "CROW_DB_PATH", "CROW_PEER_TOKENS_PATH"].map((k) => [k, process.env[k]]));
  Object.assign(process.env, { CROW_HOME: d, CROW_DATA_DIR: dataDir, CROW_DB_PATH: join(dataDir, "crow.db"), CROW_PEER_TOKENS_PATH: join(d, "peer-tokens.json") });
  try { return await fn({ d, dataDir, xdb, store: join(d, "peer-tokens.json") }); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    try { xdb.close(); } catch {}
    rmSync(d, { recursive: true, force: true });
  }
}
const iso = (ms) => new Date(ms).toISOString();
const sqliteTs = (ms) => iso(ms).replace("T", " ").slice(0, 19);

describe("U5: boot reconcile", () => {
  test("deletes a revoked peer's key minted before the revoke; keeps a re-pair's newer key and live keys byte-identical; snapshot once; idempotent", async () => {
    await withHome(async ({ xdb, store }) => {
      const now = Date.now();
      await addPeerRow(xdb, "old-revoked", { status: "revoked" });
      await addPeerRow(xdb, "repair-inflight", { status: "revoked" });
      await addPeerRow(xdb, "same-second", { status: "revoked" });
      await addPeerRow(xdb, "live", { status: "active" });
      await addPeerRow(xdb, "legacy-untrusted", { status: "active", trusted: 0 });
      const R = now - 60_000;
      for (const id of ["old-revoked", "repair-inflight", "same-second"]) {
        await xdb.execute({ sql: "UPDATE crow_instances SET updated_at = ? WHERE id = ?", args: [sqliteTs(R), id] });
      }
      const Rsec = Math.floor(R / 1000) * 1000;
      const entries = {
        "old-revoked": { auth_token: "a", signing_key: "k1", created_at: iso(R - 86_400_000), rotated_at: null },
        "repair-inflight": { auth_token: "b", signing_key: "k2", created_at: iso(R - 86_400_000), rotated_at: iso(R + 5_000) },
        "same-second": { auth_token: "c", signing_key: "k3", created_at: iso(Rsec + 400), rotated_at: null },
        "live": { auth_token: "d", signing_key: "k4", created_at: iso(R - 86_400_000), rotated_at: null },
        "legacy-untrusted": { auth_token: "e", signing_key: "k5" },
        "orphan": { auth_token: "f", signing_key: "k6", created_at: iso(R), rotated_at: null },
      };
      writeFileSync(store, JSON.stringify(entries), { mode: 0o600 });
      const snap = snapshotStoreOnce({ now: () => now });
      assert.ok(snap && existsSync(snap));
      assert.equal(statSync(snap).mode & 0o777, 0o600);
      assert.equal(snapshotStoreOnce({ now: () => now + 1 }), null, "the snapshot is taken once per host");

      const r1 = await reconcilePeerCreds(xdb);
      assert.deepEqual(r1.deleted, ["old-revoked"]);
      assert.deepEqual(r1.keptSameSecond, ["same-second"]);
      assert.deepEqual(r1.orphans, ["orphan"]);
      assert.deepEqual(r1.untrusted, ["legacy-untrusted"]);
      const after = JSON.parse(readFileSync(store, "utf8"));
      assert.equal(after["old-revoked"], undefined);
      assert.ok(after["repair-inflight"], "a key minted after the revoke (re-pair in flight) survives");
      assert.deepEqual(after.live, entries.live);
      assert.deepEqual(after["legacy-untrusted"], entries["legacy-untrusted"], "never auto-changed");
      assert.ok(after.orphan, "orphans are reported, never deleted");
      const r2 = await reconcilePeerCreds(xdb);
      assert.deepEqual(r2.deleted, []);
      const h = getPeerTrustHealth();
      assert.deepEqual(h.orphanKeys, ["orphan"]);
      assert.deepEqual(h.untrustedWithCreds.map((x) => x.id), ["legacy-untrusted"]);
    });
  });
});

describe("revokePeer (both doors) kills the key and the SSO sessions", () => {
  test("revoke deletes the store entry, nulls the bearer, ends tagged + legacy SSO sessions, keeps other peers", async () => {
    await withHome(async ({ xdb, store }) => {
      await addPeerRow(xdb, "victim", { status: "active" });
      await addPeerRow(xdb, "other", { status: "active" });
      writeFileSync(store, JSON.stringify({ victim: { auth_token: "a", signing_key: "k" }, other: { auth_token: "b", signing_key: "k2" } }), { mode: 0o600 });
      const ins = (tok, scopes) => xdb.execute({ sql: "INSERT INTO oauth_tokens (token, token_type, client_id, scopes, expires_at) VALUES (?, 'access', 'dashboard', ?, ?)", args: [tok, scopes, iso(Date.now() + 3_600_000)] });
      await ins("t1", "dashboard sso src:victim");
      await ins("t2", "dashboard sso");
      await ins("t3", "dashboard sso src:other");
      await ins("t4", "dashboard");
      assert.equal(storeMatchesDb(), true);
      const r = await revokePeer(xdb, "victim", { instanceSyncManager: null });
      assert.equal(r.ok, true);
      assert.equal(r.creds_deleted, true);
      assert.deepEqual(Object.keys(JSON.parse(readFileSync(store, "utf8"))), ["other"]);
      const { rows } = await xdb.execute({ sql: "SELECT token FROM oauth_tokens ORDER BY token", args: [] });
      assert.deepEqual(rows.map((x) => x.token), ["t3", "t4"]);
      const row = await getInstance(xdb, "victim");
      assert.equal(row.status, "revoked");
    });
  });

  test("S6: a store that does not belong to the open DB is not touched (store_mismatch)", async () => {
    await withHome(async ({ xdb, store, d }) => {
      await addPeerRow(xdb, "victim", { status: "active" });
      writeFileSync(store, JSON.stringify({ victim: { auth_token: "a", signing_key: "k" } }), { mode: 0o600 });
      const other = mkdtempSync(join(tmpdir(), "pt-otherhome-"));
      const saved = process.env.CROW_PEER_TOKENS_PATH;
      process.env.CROW_PEER_TOKENS_PATH = join(other, "peer-tokens.json");
      writeFileSync(process.env.CROW_PEER_TOKENS_PATH, JSON.stringify({ victim: { auth_token: "x", signing_key: "y" } }), { mode: 0o600 });
      try {
        assert.equal(storeMatchesDb(), false);
        const r = await revokePeer(xdb, "victim", { instanceSyncManager: null });
        assert.equal(r.ok, true);
        assert.equal(r.creds_deleted, false);
        assert.equal(r.reason, "store_mismatch");
        assert.ok(JSON.parse(readFileSync(process.env.CROW_PEER_TOKENS_PATH, "utf8")).victim, "the wrong store is untouched");
      } finally { process.env.CROW_PEER_TOKENS_PATH = saved; rmSync(other, { recursive: true, force: true }); }
      // The owning instance's reconcile then finishes the job.
      await xdb.execute({ sql: "UPDATE crow_instances SET updated_at = datetime('now', '+2 seconds') WHERE id = 'victim'", args: [] });
      const r2 = await reconcilePeerCreds(xdb);
      assert.deepEqual(r2.deleted, ["victim"]);
      assert.equal(d.length > 0, true);
    });
  });

  test("S7: a key-only id is purged and reported as an orphan", async () => {
    await withHome(async ({ xdb, store }) => {
      writeFileSync(store, JSON.stringify({ ghost: { auth_token: "a", signing_key: "k" } }), { mode: 0o600 });
      const r = await revokePeer(xdb, "ghost", { instanceSyncManager: null });
      assert.equal(r.ok, true);
      assert.equal(r.orphan, true);
      assert.deepEqual(JSON.parse(readFileSync(store, "utf8")), {});
      assert.equal((await revokePeer(xdb, "nobody", { instanceSyncManager: null })).reason, "not_found");
    });
  });

  test("teardownUntrustedPeers closes a paused peer's sessions and feeds but not a trusted peer's", async () => {
    await withHome(async ({ xdb }) => {
      await addPeerRow(xdb, "paused-p", { status: "paused" });
      await addPeerRow(xdb, "good-p", { status: "active" });
      const sm = new SessionManager();
      const closed = [];
      sm.getStore("memory").set("a", { transport: { close: async () => closed.push("a") }, owner: "instance:paused-p" });
      sm.getStore("memory").set("b", { transport: { close: async () => closed.push("b") }, owner: "instance:good-p" });
      const torn = [];
      const mgr = { inFeeds: new Map([["paused-p", {}], ["good-p", {}]]), outFeeds: new Map(), hasActiveStream: () => false, teardownRevokedPeer: async (id) => torn.push(id) };
      const ids = await teardownUntrustedPeers(xdb, { instanceSyncManager: mgr, localInstanceId: "self" });
      sm.dispose();
      assert.deepEqual(ids, ["paused-p"]);
      assert.deepEqual(closed, ["a"]);
      assert.deepEqual(torn, ["paused-p"]);
    });
  });
});

// ---------------------------------------------------------------------------
// SSO: every SSO session mint (accept, both 2FA completions) re-checks trust
// immediately before minting, and tags the session with its source.
// ---------------------------------------------------------------------------
describe("mintSsoSession re-checks the source peer", () => {
  test("a trusted peer mints a tagged session; paused, revoked, untrusted and unknown sources mint nothing", async () => {
    await withHome(async ({ xdb }) => {
      const { mintSsoSession } = await import("../servers/gateway/dashboard/auth.js");
      await addPeerRow(xdb, "sso-good", { status: "active" });
      await addPeerRow(xdb, "sso-paused", { status: "paused" });
      await addPeerRow(xdb, "sso-revoked", { status: "revoked" });
      await addPeerRow(xdb, "sso-untrusted", { status: "active", trusted: 0 });
      const { token } = await mintSsoSession("sso-good");
      assert.ok(token);
      for (const id of ["sso-paused", "sso-revoked", "sso-untrusted", "sso-nobody", null]) {
        await assert.rejects(mintSsoSession(id), (e) => e.code === "sso_refused", String(id));
      }
      const { rows } = await xdb.execute({ sql: "SELECT scopes FROM oauth_tokens WHERE client_id = 'dashboard'", args: [] });
      assert.deepEqual(rows.map((r) => r.scopes), ["dashboard sso src:sso-good"]);
    });
  });
});

// ---------------------------------------------------------------------------
// U9: every peer-credential verifier applies the one trust predicate
// ---------------------------------------------------------------------------
const VERIFIERS = [
  ["servers/shared/cross-host-auth.js", "export function crossHostVerifyMiddleware"],
  ["servers/gateway/instance-registry.js", "export async function validateInstanceToken"],
  ["servers/gateway/dashboard/auth.js", "export async function mintSsoSession"], // SSO accept + both 2FA completions mint here
  ["servers/gateway/routes/instance-enroll.js", "const proofOk ="], // enroll re-pair proof
  ["servers/sharing/instance-sync.js", "  async _isPeerTrusted("],
  ["servers/shared/peer-forward.js", "export async function forwardSignedRequest"],
];
const TRUST_TOKENS = /\b(peerTrust|TRUSTED_PEER_SQL|rowIsTrusted)\b/;

function bodyOf(src, def) {
  const i = src.indexOf(def);
  if (i === -1) return null;
  const rest = src.slice(i + def.length);
  const next = rest.search(/\n(export |async function |function |  async \w+\(|  \w+\([^)]*\) \{\n)/);
  return def + (next === -1 ? rest : rest.slice(0, next));
}

describe("U9: verifier inventory", () => {
  for (const [file, def] of VERIFIERS) {
    test(`${file} :: ${def.trim()}`, () => {
      const body = bodyOf(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), def);
      assert.ok(body, "verifier not found (renamed? update the inventory)");
      assert.match(body, TRUST_TOKENS);
    });
  }
  test("positive control: a verifier without the predicate is caught", () => {
    const src = "export async function fakeVerifier(db, id) {\n  return db.execute('SELECT * FROM crow_instances WHERE id = ?');\n}\nexport function other() { peerTrust(); }\n";
    assert.doesNotMatch(bodyOf(src, "export async function fakeVerifier"), TRUST_TOKENS);
  });
  test("every route that mounts crossHostVerifyMiddleware passes it the instance DB", () => {
    for (const f of ["servers/gateway/routes/federation.js", "servers/gateway/routes/bundles.js"]) {
      const src = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
      assert.match(src, /crossHostVerifyMiddleware\((dbForAudit|dbForXhost)/, f);
    }
  });
});

describe("the fence covers every move into trust; pause is not fenced", () => {
  test("reactivateOnRepair from trusted=0 writes the fence; from paused it keeps paused and writes none", async () => {
    const d = mkdtempSync(join(tmpdir(), "pt-fence-moves-"));
    const xdb = await makeRealDb(d);
    try {
      await addPeerRow(xdb, "legacy", { status: "active", trusted: 0 });
      await addPeerRow(xdb, "held", { status: "paused", trusted: 1 });
      await addPeerRow(xdb, "live", { status: "active", trusted: 1 });
      for (const id of ["legacy", "held", "live"]) await reactivateOnRepair(xdb, id, { authTokenHash: "ab".repeat(32), localInstanceId: LOCAL });
      const blob = (await appliedBlob(xdb)) || {};
      assert.equal(blob.legacy?.ff, 1, "trusted=0 → trusted is fenced");
      assert.equal(blob.held, undefined, "a paused (trusted) peer is not fenced");
      assert.equal((await getInstance(xdb, "held")).status, "paused", "a re-pair does not lift a pause");
      assert.equal(blob.live, undefined, "a live trusted re-pair (key rotation) is not fenced");
    } finally { try { xdb.close(); } catch {} rmSync(d, { recursive: true, force: true }); }
  });
});
