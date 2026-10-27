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
