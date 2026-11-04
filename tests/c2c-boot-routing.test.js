/**
 * Task 5 fix wave, boot side: F1's lazy owner/visitor handler loader, and F7's
 * routing proof that a `type:"c2c"` payload reaches the receive pipeline and
 * never the share branches below it.
 *
 * The loader is driven with injected modules (no filesystem); the routing test
 * boots the REAL sharing runtime with stub managers over a scratch DB, so the
 * real `onPeerData` wiring runs without a socket.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { C2C_TABLES_SQL } from "../scripts/migrations/0016-crow-to-crow.mjs";
import {
  initSharingRuntime, createC2cHandlerLoader, C2C_HANDLER_RETRY_MS,
} from "../servers/sharing/boot.js";
import { buildFrame } from "../servers/sharing/c2c/frames.js";

const CROW = "crow:peer";
const LOCAL = "inst-local";
const PEER = "inst-peer";
const P1 = "1".repeat(32);
const EPOCH = "a".repeat(32);

/* --------------------------------------------------- F1: the handler loader */

const missingModule = (spec) => {
  const err = new Error(`Cannot find module '/srv/servers/sharing/${spec.replace("./", "")}' imported from /srv/servers/sharing/boot.js`);
  err.code = "ERR_MODULE_NOT_FOUND";
  return err;
};

test("F1: a missing handler module is retried, at most once per 30 s, and a partial load is not cached", async () => {
  let now = 1_000_000;
  let ownerExists = false;
  const imported = [];
  const load = createC2cHandlerLoader({
    specs: ["./c2c/owner.js", "./c2c/visitor.js"],
    now: () => now,
    importModule: async (spec) => {
      imported.push(spec);
      if (spec === "./c2c/owner.js" && !ownerExists) throw missingModule(spec);
      if (spec === "./c2c/owner.js") return { onInvite: async () => {}, onAccept: async () => {} };
      return { onRole: async () => {} };
    },
    // The handler file itself is absent until `ownerExists`; visitor.js is there.
    handlerModuleExists: (spec) => spec !== "./c2c/owner.js" || ownerExists,
  });

  const first = await load();
  assert.deepEqual(imported, ["./c2c/owner.js", "./c2c/visitor.js"], "both modules are attempted");
  assert.equal(typeof first.onRole, "function", "the module that DID load is usable meanwhile");
  assert.equal(first.onInvite, undefined, "the missing module's kind stays unloaded (the pipeline says busy)");

  // Inside the window: no retry, and the frame keeps getting the partial handlers.
  imported.length = 0;
  await load();
  await load();
  assert.deepEqual(imported, [], "at most one load attempt per 30 s");

  // owner.js lands; the next window picks it up, and only then is the load cached.
  ownerExists = true;
  now += C2C_HANDLER_RETRY_MS;
  const third = await load();
  assert.deepEqual(imported, ["./c2c/owner.js", "./c2c/visitor.js"]);
  assert.equal(typeof third.onInvite, "function");
  imported.length = 0;
  const fourth = await load();
  assert.equal(fourth, third, "a complete load is cached");
  assert.deepEqual(imported, [], "no further attempts");
});

test("F1: a missing DEPENDENCY of a handler module is logged, not swallowed", async () => {
  const warnings = [];
  const real = console.warn;
  console.warn = (...a) => { warnings.push(a.map(String).join(" ")); };
  try {
    const load = createC2cHandlerLoader({
      specs: ["./c2c/owner.js"],
      now: () => 1,
      importModule: async () => {
        // owner.js exists; the package IT imports does not.
        const err = new Error("Cannot find package 'left-pad' imported from /srv/servers/sharing/c2c/owner.js");
        err.code = "ERR_MODULE_NOT_FOUND";
        throw err;
      },
      handlerModuleExists: () => true,
    });
    const handlers = await load();
    assert.deepEqual(handlers, {}, "the kind stays unloaded");
    assert.equal(warnings.length, 1, JSON.stringify(warnings));
    assert.match(warnings[0], /^\[c2c\] handler module \.\/c2c\/owner\.js failed: /);
    assert.match(warnings[0], /left-pad/);
  } finally {
    console.warn = real;
  }
});

test("F1: an unexpected import failure is logged and never wedges the receive path", async () => {
  const warnings = [];
  const real = console.warn;
  console.warn = (...a) => { warnings.push(a.map(String).join(" ")); };
  try {
    const load = createC2cHandlerLoader({
      specs: ["./c2c/owner.js"],
      now: () => 1,
      importModule: async () => { throw new SyntaxError("Unexpected token"); },
      handlerModuleExists: () => true,
    });
    assert.deepEqual(await load(), {});
    assert.match(warnings[0], /handler module \.\/c2c\/owner\.js failed: Unexpected token/);
  } finally {
    console.warn = real;
  }
});

/* ------------------------------------------------------- F7: the boot routing */

/** A scratch crow.db with only what the sharing boot path and the c2c path read. */
async function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "c2c-boot-"));
  const db = createDbClient(join(dir, "crow.db"));
  await db.executeMultiple(`
    CREATE TABLE contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, crow_id TEXT, display_name TEXT,
      is_blocked INTEGER DEFAULT 0, ed25519_pubkey TEXT, secp256k1_pubkey TEXT,
      request_status TEXT);
    CREATE TABLE shared_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, contact_id INTEGER, share_type TEXT,
      item_id INTEGER, permissions TEXT, direction TEXT, delivery_status TEXT);
    CREATE TABLE memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT, category TEXT,
      importance INTEGER, context TEXT, source TEXT, tags TEXT);
    CREATE TABLE dashboard_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
    CREATE TABLE dashboard_settings_overrides (
      key TEXT NOT NULL, instance_id TEXT NOT NULL, value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now')), lamport_ts INTEGER DEFAULT 0,
      PRIMARY KEY (key, instance_id));
  `);
  await db.executeMultiple(C2C_TABLES_SQL);
  await db.execute({
    sql: "INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey) VALUES (?, 'Peer', ?, ?)",
    args: [CROW, "a".repeat(64), "02" + "b".repeat(64)],
  });
  return {
    dir, db,
    dispose() { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); },
  };
}

test("F7: a type:'c2c' payload reaches handleC2cFrame and never the share branches", async () => {
  const s = await fresh();
  const sent = [];
  const managers = {
    db: s.db,
    identity: {
      crowId: "crow:local", ed25519Pubkey: "c".repeat(64),
      secp256k1Pubkey: "02" + "d".repeat(64), secp256k1Priv: new Uint8Array(32),
    },
    peerManager: {
      start: async () => {},
      joinContact: async () => {},
      joinInstanceSync: async () => {},
      getConnectedPeers: () => [],
      send: (crowId, frame) => { sent.push({ crowId, frame }); },
    },
    syncManager: { initContact: async () => {}, onEntry: null },
    instanceSyncManager: { localInstanceId: LOCAL, feedsDisabled: true },
    nostrManager: { subscribeToContact: async () => {}, subscribeToIncoming: async () => {} },
  };
  const memoryCount = async () => Number((await s.db.execute("SELECT COUNT(*) AS n FROM memories")).rows[0].n);

  try {
    await initSharingRuntime(managers, {
      applyProjectCloneBundle: async () => ({}),
      buildProjectCloneBundle: async () => ({}),
      bindingAdvertDelayMs: 60 * 60 * 1000, // never fires in the test
    });
    const onPeerData = managers.peerManager.onPeerData;
    assert.equal(typeof onPeerData, "function", "the runtime wired the peer data path");

    // A c2c frame that also carries share-shaped fields: the c2c branch must win
    // and return, so the share import below it never runs.
    const c2cPayload = {
      ...buildFrame({
        kind: "project.role", projectUuid: P1, epoch: EPOCH, seq: 1,
        fromInstanceId: PEER, toInstanceId: LOCAL, body: { role: "viewer" },
      }),
      share_type: "memory",
      payload: { content: "SHOULD-NOT-BE-IMPORTED" },
    };
    await onPeerData(CROW, c2cPayload, { proof: "cb", instanceId: PEER });

    assert.equal(sent.length, 1, "the receive pipeline answered");
    assert.equal(sent[0].crowId, CROW);
    assert.equal(sent[0].frame.kind, "project.refuse");
    assert.equal(sent[0].frame.body.reason, "busy",
      "F1: no handler module in this host yet, so the frame is HELD with busy");
    assert.equal(await memoryCount(), 0, "the share branches never ran for a c2c payload");

    // Control: the same handler DOES import a real share, so the assertion above
    // is about routing, not about a dead branch.
    await onPeerData(CROW, {
      type: "share", share_type: "memory", payload: { content: "hello" },
    }, { proof: "cb", instanceId: PEER });
    assert.equal(await memoryCount(), 1, "a type:'share' payload still reaches the share branch");
  } finally {
    managers.c2cFlushStop?.();
    s.dispose();
  }
});