/**
 * PT-2a: an instance-sync in-feed may speak only for its writer.
 * Observe mode counts + logs a mismatching entry and applies it; enforce mode
 * skips it (the seq still advances: the existing skip-and-continue rule).
 * Real sync-fleet pair, real Hypercore feeds. In both modes B's genuine entry,
 * appended right after the forged one, must apply (positive control).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { makeFleet, linkPeers, until, hasMemory, writeAndEmit } from "./fixtures/sync-fleet.mjs";
import { sign } from "../servers/sharing/identity.js";
import { entryOriginMode, _resetEntryOriginModeLog } from "../servers/sharing/instance-sync.js";

function forge(identity, id, content, claimed) {
  const entry = {
    table: "memories", op: "insert",
    row: { id, content, lamport_ts: null },
    lamport_ts: 1000, instance_id: claimed,
  };
  entry.signature = sign(JSON.stringify(entry), identity.ed25519Priv);
  return entry;
}

async function runCase(mode, expectApplied) {
  const prev = process.env.CROW_SYNC_ENTRY_ORIGIN;
  if (mode === undefined) delete process.env.CROW_SYNC_ENTRY_ORIGIN;
  else process.env.CROW_SYNC_ENTRY_ORIGIN = mode;
  const fleet = await makeFleet();
  const { a, b } = fleet;
  const logs = [];
  const origWarn = console.warn, origLog = console.log;
  const cap = (...x) => logs.push(x.join(" "));
  try {
    await a.mgr.initInstance(b.id, null); // arm before linking so feeds exist
    const link = await linkPeers(a, b);
    console.warn = cap; console.log = cap;
    await b.mgr.outFeeds.get(a.id).append(forge(fleet.identity, 9001, "forged", "inst-c"));
    await writeAndEmit(b, 9002, "genuine");
    assert.ok(await until(() => hasMemory(a.db, 9002)), "genuine entry applies");
    console.warn = origWarn; console.log = origLog;
    assert.equal(await hasMemory(a.db, 9001), expectApplied, `forged applied=${expectApplied}`);
    const seq = await a.mgr._getLastAppliedSeq(b.id, a.mgr.inFeeds.get(b.id));
    assert.ok(seq >= 2, "seq advanced past the forged entry");
    const lines = logs.filter((l) => l.includes("entry origin mismatch"));
    assert.equal(a.mgr.originMismatches.get(b.id), 1);
    assert.equal(lines.length, 1);
    assert.equal(lines[0], `[instance-sync] entry origin mismatch from ${b.id}: claims inst-c`);
    link.close();
  } finally {
    console.warn = origWarn; console.log = origLog;
    if (prev === undefined) delete process.env.CROW_SYNC_ENTRY_ORIGIN;
    else process.env.CROW_SYNC_ENTRY_ORIGIN = prev;
    await fleet.cleanup();
  }
}

describe("entryOriginMode (PT-2b default: enforce)", () => {
  it("unset and empty enforce; observe is the explicit escape; anything else is observe, warned once", () => {
    const warns = [];
    const orig = console.warn;
    console.warn = (...a) => warns.push(a.join(" "));
    try {
      _resetEntryOriginModeLog();
      assert.equal(entryOriginMode({}), "enforce");
      assert.equal(entryOriginMode({ CROW_SYNC_ENTRY_ORIGIN: "" }), "enforce");
      assert.equal(entryOriginMode({ CROW_SYNC_ENTRY_ORIGIN: "enforce" }), "enforce");
      assert.equal(entryOriginMode({ CROW_SYNC_ENTRY_ORIGIN: "observe" }), "observe");
      assert.equal(warns.length, 0, "valid values never warn");
      // A typo is a failed rollback: it must fail to the HARMLESS direction
      // (observe applies the entry; enforce consumes it for good), loudly.
      assert.equal(entryOriginMode({ CROW_SYNC_ENTRY_ORIGIN: "enforced" }), "observe");
      assert.equal(entryOriginMode({ CROW_SYNC_ENTRY_ORIGIN: "Enforce" }), "observe");
      assert.equal(warns.length, 1, "warned once per boot");
      assert.match(warns[0], /CROW_SYNC_ENTRY_ORIGIN/);
      assert.match(warns[0], /observe/);
    } finally {
      console.warn = orig;
      _resetEntryOriginModeLog();
    }
  });
});

describe("entry origin", () => {
  it("enforce (default): the forged entry is skipped, the seq still advances, the genuine entry right after applies", async () => {
    await runCase(undefined, false);
  });
  it("observe (the explicit escape): the forged entry applies, counted + logged once, and the genuine one applies", async () => {
    await runCase("observe", true);
  });
});

describe("origin mismatch log rate limit", () => {
  it("logs at most once per peer per hour (injected clock), still counts", async () => {
    const fleet = await makeFleet();
    const { a } = fleet;
    let t = 1_000_000;
    a.mgr._now = () => t;
    const logs = [];
    const origWarn = console.warn;
    console.warn = (...x) => logs.push(x.join(" "));
    try {
      const e = (n) => forge(fleet.identity, 9100 + n, "x", "inst-c");
      await a.mgr._applyEntry("instB", e(1));
      await a.mgr._applyEntry("instB", e(2));
      t += 3_600_001;
      await a.mgr._applyEntry("instB", e(3));
    } finally { console.warn = origWarn; await fleet.cleanup(); }
    assert.equal(a.mgr.originMismatches.get("instB"), 3);
    assert.equal(logs.filter((l) => l.includes("entry origin mismatch")).length, 2);
  });
});
