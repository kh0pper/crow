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
