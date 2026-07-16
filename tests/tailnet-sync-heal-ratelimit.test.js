/**
 * Minor-pool item 1 (2026-07-16 spec): the 60s rescan's per-peer heal failure
 * warn must be rate-limited (log at #1, #10, #100, …) with a reset-on-recovery
 * line, instead of one warn per minute per wedged peer forever.
 *
 * Harness: startTailnetSyncClients exposes __refreshForTest; the stub peer row
 * carries no gateway_url so no PeerDialer is spawned, and the stub manager's
 * initInstance is the heal call the warn wraps.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { startTailnetSyncClients } from "../servers/sharing/tailnet-sync.js";

function makeCtx({ initInstance }) {
  const db = {
    execute: async () => ({
      rows: [{ id: "peer1234567890abcdef", gateway_url: null, tailscale_ip: null, sync_url: null, status: "active" }],
    }),
  };
  const instanceSyncManager = {
    localInstanceId: "self1234567890abcdef",
    initInstance,
    pendingEmitStats: () => ({}),
  };
  return { db, instanceSyncManager };
}

function captureWarns() {
  const lines = [];
  const orig = console.warn;
  console.warn = (...args) => { lines.push(args.join(" ")); };
  return { lines, restore: () => { console.warn = orig; } };
}

// The recovery line deliberately does NOT contain the failure-class string
// "refresh heal for" (grep/alert de-collision — see tailnet-sync.js comment).
const healLines = (lines) => lines.filter((l) => l.includes("refresh heal for"));
const recoveryLines = (lines) => lines.filter((l) => l.includes("heal recovered for"));

test("persistently failing heal logs at #1 and #10 only across 12 refreshes", async () => {
  const ctx = makeCtx({ initInstance: async () => { throw new Error("rocksdb lock held"); } });
  const cap = captureWarns();
  let handle;
  try {
    handle = await startTailnetSyncClients(ctx); // refresh #1 runs inline
    for (let i = 0; i < 11; i++) await handle.__refreshForTest();
    const heals = healLines(cap.lines);
    assert.equal(heals.length, 2, `expected 2 rate-limited heal warns, got ${heals.length}:\n${heals.join("\n")}`);
    assert.ok(heals[0].includes("#1"), `first warn should carry #1: ${heals[0]}`);
    assert.ok(heals[1].includes("#10"), `second warn should carry #10: ${heals[1]}`);
  } finally {
    cap.restore();
    handle?.stop();
  }
});

test("recovery resets the counter: recovered line once, then a fresh episode logs #1 again", async () => {
  let fail = true;
  const ctx = makeCtx({ initInstance: async () => { if (fail) throw new Error("still locked"); } });
  const cap = captureWarns();
  let handle;
  try {
    handle = await startTailnetSyncClients(ctx); // fail #1
    await handle.__refreshForTest(); // fail #2
    await handle.__refreshForTest(); // fail #3
    fail = false;
    await handle.__refreshForTest(); // success → recovery line + reset
    const recs = recoveryLines(cap.lines);
    assert.equal(recs.length, 1, `expected one recovery line, got:\n${cap.lines.join("\n")}`);
    assert.ok(recs[0].includes("3"), `recovery line should carry the failure count 3: ${recs[0]}`);
    await handle.__refreshForTest(); // success again → NO second recovery line
    assert.equal(recoveryLines(cap.lines).length, 1, "recovery must log once per episode, not on every success");
    fail = true;
    await handle.__refreshForTest(); // new episode → immediate #1
    const heals = healLines(cap.lines);
    assert.ok(heals[heals.length - 1].includes("#1"), `fresh episode should log #1 immediately: ${heals[heals.length - 1]}`);
  } finally {
    cap.restore();
    handle?.stop();
  }
});

test("out-of-scope peer's counter entry is dropped (no unbounded growth across re-pairs)", async () => {
  let rows = [{ id: "peer1234567890abcdef", gateway_url: null, tailscale_ip: null, sync_url: null, status: "active" }];
  const db = { execute: async () => ({ rows }) };
  const instanceSyncManager = {
    localInstanceId: "self1234567890abcdef",
    initInstance: async () => { throw new Error("locked"); },
    pendingEmitStats: () => ({}),
  };
  const cap = captureWarns();
  let handle;
  try {
    handle = await startTailnetSyncClients({ db, instanceSyncManager }); // fail #1 → warn
    rows = []; // peer revoked / out of scope
    await handle.__refreshForTest(); // cleanup pass
    rows = [{ id: "peer1234567890abcdef", gateway_url: null, tailscale_ip: null, sync_url: null, status: "active" }];
    await handle.__refreshForTest(); // peer re-paired: fresh episode → #1 again (counter was dropped, not resumed at #2)
    const heals = healLines(cap.lines);
    assert.equal(heals.length, 2, `expected #1 twice (fresh episodes), got:\n${heals.join("\n")}`);
    assert.ok(heals[1].includes("#1"), `re-paired peer should restart at #1: ${heals[1]}`);
  } finally {
    cap.restore();
    handle?.stop();
  }
});
