import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { NostrManager, DEFAULT_RELAYS } from "../servers/sharing/nostr.js";

const identity = { secp256k1Pubkey: "a".repeat(64), secp256k1Priv: new Uint8Array(32) };

let dir, db;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "nostr-relay-config-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: join(import.meta.dirname, ".."),
  });
  process.env.CROW_DATA_DIR = dir;
  db = createDbClient();
});
after(() => { try { db.close(); } catch {} try { rmSync(dir, { recursive: true, force: true }); } catch {} });

test("DEFAULT_RELAYS is a resilient set of more than 2 relays", () => {
  assert.ok(Array.isArray(DEFAULT_RELAYS));
  assert.ok(DEFAULT_RELAYS.length > 2, `expected >2 default relays, got ${DEFAULT_RELAYS.length}`);
  assert.ok(DEFAULT_RELAYS.includes("wss://relay.damus.io"));
  assert.ok(DEFAULT_RELAYS.includes("wss://nos.lol"));
  // The self-hosted long-retention relay ships as a default so every install
  // gets offline-message retention (R5 / loss-mode L1) with no config.
  assert.ok(
    DEFAULT_RELAYS.includes("wss://nostr.crow.maestro.press"),
    "self-hosted long-retention relay present in defaults",
  );
});

test("getConfiguredRelays returns full DEFAULT_RELAYS when relay_config is empty", async () => {
  const mgr = new NostrManager(identity, db);
  const relays = await mgr.getConfiguredRelays();
  for (const url of DEFAULT_RELAYS) {
    assert.ok(relays.includes(url), `expected default ${url} present`);
  }
  assert.equal(relays.length, DEFAULT_RELAYS.length);
});

test("getConfiguredRelays MERGES an enabled config row with defaults (does not replace)", async () => {
  await db.execute({
    sql: `INSERT INTO relay_config (relay_url, relay_type, enabled) VALUES (?, 'nostr', 1)`,
    args: ["wss://custom.example"],
  });

  const mgr = new NostrManager(identity, db);
  const relays = await mgr.getConfiguredRelays();

  // All defaults must still be present — the merge, not replace.
  for (const url of DEFAULT_RELAYS) {
    assert.ok(relays.includes(url), `expected default ${url} still present after adding custom relay`);
  }
  assert.ok(relays.includes("wss://custom.example"), "expected custom relay to be added");
  assert.equal(relays.length, DEFAULT_RELAYS.length + 1);

  await db.execute({
    sql: `DELETE FROM relay_config WHERE relay_url = ?`,
    args: ["wss://custom.example"],
  });
});

test("getConfiguredRelays dedups a config row that duplicates a default", async () => {
  const dupUrl = DEFAULT_RELAYS[0];
  await db.execute({
    sql: `INSERT INTO relay_config (relay_url, relay_type, enabled) VALUES (?, 'nostr', 1)`,
    args: [dupUrl],
  });

  const mgr = new NostrManager(identity, db);
  const relays = await mgr.getConfiguredRelays();

  const occurrences = relays.filter((r) => r.toLowerCase() === dupUrl.toLowerCase()).length;
  assert.equal(occurrences, 1, "duplicate default should appear exactly once");
  assert.equal(relays.length, DEFAULT_RELAYS.length);

  await db.execute({
    sql: `DELETE FROM relay_config WHERE relay_url = ?`,
    args: [dupUrl],
  });
});

test("getConfiguredRelays disabled config rows are ignored", async () => {
  await db.execute({
    sql: `INSERT INTO relay_config (relay_url, relay_type, enabled) VALUES (?, 'nostr', 0)`,
    args: ["wss://disabled.example"],
  });

  const mgr = new NostrManager(identity, db);
  const relays = await mgr.getConfiguredRelays();
  assert.ok(!relays.includes("wss://disabled.example"));

  await db.execute({
    sql: `DELETE FROM relay_config WHERE relay_url = ?`,
    args: ["wss://disabled.example"],
  });
});

test("getConfiguredRelays never throws on a broken db — falls back to DEFAULT_RELAYS", async () => {
  const brokenDb = {
    async execute() {
      throw new Error("database is locked");
    },
  };
  const mgr = new NostrManager(identity, brokenDb);
  const relays = await mgr.getConfiguredRelays();
  assert.deepEqual(relays, DEFAULT_RELAYS);
});

test("getConfiguredRelays returns DEFAULT_RELAYS when no db is set", async () => {
  const mgr = new NostrManager(identity, null);
  const relays = await mgr.getConfiguredRelays();
  assert.deepEqual(relays, DEFAULT_RELAYS);
});

test("connectedRelayUrls returns the currently connected relay URLs", async () => {
  const mgr = new NostrManager(identity, null);
  assert.deepEqual(mgr.connectedRelayUrls(), []);
  mgr.relays.set("wss://a", {});
  mgr.relays.set("wss://b", {});
  assert.deepEqual(mgr.connectedRelayUrls().sort(), ["wss://a", "wss://b"]);
});
