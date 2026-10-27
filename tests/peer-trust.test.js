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
