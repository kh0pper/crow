/**
 * PT-2a Task 5b (private engineering notes): a Nostr `bot_relay` task runs
 * once, and only while fresh.
 *
 * Our own old self-signed bot_relay events stay on relays, and the in-memory
 * seenEventIds set is fresh per subscribeToIncoming call, so a restart, a
 * re-run of the receive wiring, a re-publish by anyone, or a second process on
 * the same DB could run a task again. routeBotRelay now
 *   - drops an event whose created_at is more than 600 s from now (both sides),
 *   - claims `bot_relay:<relay_id>` in the LOCAL processed_control_events table
 *     (fail closed: an insert error means "not ours"), after the target check.
 *
 * Real init-db scratch DBs. The run is the real handleIncomingBotRelay with
 * the runOneShot option set to the production "no provider" error, so a run
 * shows up as the `sharing:bot_relay_manual` notification. B-R2's second leg
 * uses a real NostrManager on the local relay fixture (127.0.0.1); B-R3 uses
 * a child process (tests/fixtures/bot-relay-node.mjs) on the same DB.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { makeRealDb, addPeerRow } from "./fixtures/sync-fleet.mjs";
import { startNostrRelay } from "./fixtures/nostr-relay.mjs";
import { startBotRelayNode, stopAllBotRelayNodes, until } from "./fixtures/bot-relay-node.mjs";
import { deriveInstanceIdentity } from "../servers/sharing/identity.js";
import { routeBotRelay, BOT_RELAY_MAX_SKEW_S } from "../servers/sharing/bot-relay.js";
import { claimOnce, _resetClaimOnceForTest } from "../servers/sharing/processed-events.js";
import { NostrManager } from "../servers/sharing/nostr.js";

const LOCAL = "desk";
let dir, db;
const own = deriveInstanceIdentity(randomBytes(32));
const xonly = (id) => id.secp256k1Pubkey.slice(2);
const nowS = () => Math.floor(Date.now() / 1000);
const newId = () => randomBytes(16).toString("hex");
const noProvider = async () => { throw Object.assign(new Error("No AI provider configured."), { code: "not_configured" }); };
const sent = [];
const nostrStub = { sendSelfMessage: async (c) => { sent.push(c); return { relays: [] }; } };

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "bot-relay-replay-"));
  db = await makeRealDb(dir);
  await addPeerRow(db, "laptop", { status: "active", trusted: 1 });
});
after(async () => {
  await stopAllBotRelayNodes();
  try { db.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

function relayPayload(relayId, extra = {}) {
  return { relay_id: relayId, task: `task ${relayId.slice(0, 6)}`, target_instance: LOCAL, sender_instance: "laptop", sender_name: "laptop", ...extra };
}

function route(payload, opts = {}) {
  const { useDb = db, subtype = "bot_relay" } = opts;
  const eventCreatedAt = "eventCreatedAt" in opts ? opts.eventCreatedAt : nowS();
  return routeBotRelay({
    subtype, payload, senderPubkey: xonly(own), db: useDb, identity: own, nostrManager: nostrStub,
    localName: LOCAL, eventCreatedAt, runOneShot: noProvider,
  });
}

async function manualCount(task) {
  const { rows } = await db.execute({
    sql: "SELECT COUNT(*) AS n FROM notifications WHERE source = 'sharing:bot_relay_manual' AND body = ?", args: [task],
  });
  return Number(rows[0].n);
}
async function ledger(key) {
  const { rows } = await db.execute({ sql: "SELECT event_id, kind FROM processed_control_events WHERE event_id = ?", args: [key] });
  return rows[0] || null;
}
const settle = () => new Promise((r) => setTimeout(r, 300));

test("BOT_RELAY_MAX_SKEW_S is 600", () => {
  assert.equal(BOT_RELAY_MAX_SKEW_S, 600);
});

test("B-R1 positive control: a fresh own-key bot_relay runs once and leaves its ledger row", async () => {
  const id = newId();
  const p = relayPayload(id);
  assert.equal(await route(p), "handled");
  assert.ok(await until(async () => (await manualCount(p.task)) === 1, 5_000), "one manual notification");
  const row = await ledger(`bot_relay:${id}`);
  assert.ok(row, "ledger row bot_relay:<id>");
  assert.equal(row.kind, "bot_relay");
});

test("B-R2 the same event again in-process gets no second run", async () => {
  const id = newId();
  const p = relayPayload(id);
  const createdAt = nowS();
  assert.equal(await route(p, { eventCreatedAt: createdAt }), "handled");
  assert.ok(await until(async () => (await manualCount(p.task)) === 1, 5_000));
  assert.equal(await route(p, { eventCreatedAt: createdAt }), "ignored");
  await settle();
  assert.equal(await manualCount(p.task), 1);
});

test("B-R2 a second subscribeToIncoming (fresh seenEventIds, the relay re-delivers) gets no second run", async () => {
  const relay = await startNostrRelay();
  const RealWS = globalThis.WebSocket;
  const prevDisable = process.env.CROW_DISABLE_NOSTR;
  // Only the local relay may be dialled from this process.
  globalThis.WebSocket = class extends RealWS {
    constructor(url, ...rest) {
      if (!String(url).startsWith(relay.url)) throw new Error(`test guard: refused ${url}`);
      super(url, ...rest);
    }
  };
  process.env.CROW_DISABLE_NOSTR = "0";
  const nm = new NostrManager(own, db);
  nm.getConfiguredRelays = async () => [relay.url];
  try {
    const id = newId();
    const p = relayPayload(id);
    const seen = [];
    const onSocial = async (subtype, payload, senderPubkey, eventCreatedAt) => {
      seen.push(subtype);
      await routeBotRelay({ subtype, payload, senderPubkey, db, identity: own, nostrManager: nostrStub, localName: LOCAL, eventCreatedAt, runOneShot: noProvider });
    };
    await nm.subscribeToIncoming(null, onSocial, null);
    await nm.sendSelfMessage(JSON.stringify({ type: "crow_social", version: 1, subtype: "bot_relay", payload: p }));
    assert.ok(await until(async () => (await manualCount(p.task)) === 1, 10_000), "the first delivery runs (created_at reaches routeBotRelay)");
    const before = seen.length;
    await nm.subscribeToIncoming(null, onSocial, null);
    assert.ok(await until(() => seen.length > before, 10_000), "the relay re-delivered the stored event");
    await settle();
    assert.equal(await manualCount(p.task), 1, "no second run");
  } finally {
    try { await nm.destroy(); } catch {}
    try { clearInterval(nm._retryTimer); clearTimeout(nm._retryTimer); } catch {}
    globalThis.WebSocket = RealWS;
    if (prevDisable === undefined) delete process.env.CROW_DISABLE_NOSTR; else process.env.CROW_DISABLE_NOSTR = prevDisable;
    await relay.close();
  }
});

test("B-R3 the same relay_id from a child process on the same DB (cold module graph) gets no run", async () => {
  const id = newId();
  const p = relayPayload(id);
  assert.equal(await route(p), "handled");
  assert.ok(await until(async () => (await manualCount(p.task)) === 1, 5_000));
  assert.ok(await ledger(`bot_relay:${id}`), "ledger row before the child");

  // The child opens the same scratch home (dir is its data dir) with its own
  // module graph. Its local instance name is resolved from its own DB rows, so
  // name it explicitly via crow_instances: point its instance-id at a row named LOCAL.
  const instId = `inst-${newId().slice(0, 8)}`;
  await db.execute({ sql: "INSERT INTO crow_instances (id, name, crow_id, status, trusted) VALUES (?, ?, 'crow:x', 'active', 1)", args: [instId, LOCAL] });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(dir, "instance-id"), `${instId}\n`);
  writeFileSync(join(dir, ".env"), "# no AI provider\n");
  const child = await startBotRelayNode({ label: "same-db", home: dir, dataDir: dir });
  const r = await child.route({ subtype: "bot_relay", payload: p, eventCreatedAt: nowS() });
  assert.equal(r, "ignored", "the child lost the claim");
  // Positive control in the same child: a fresh id runs there.
  const fresh = relayPayload(newId());
  assert.equal(await child.route({ subtype: "bot_relay", payload: fresh, eventCreatedAt: nowS() }), "handled");
  assert.ok(await until(async () => (await manualCount(fresh.task)) === 1, 10_000), "the child can run a fresh relay");
  await child.stop();
  assert.equal(await manualCount(p.task), 1, "still exactly one run");
  assert.ok(await ledger(`bot_relay:${id}`), "ledger row still present");
});

test("B-R4 created_at 601 s old or 601 s ahead is ignored; ±599 s is handled", async () => {
  for (const skew of [-601, 601]) {
    const p = relayPayload(newId());
    assert.equal(await route(p, { eventCreatedAt: nowS() + skew }), "ignored", `skew ${skew}`);
    await settle();
    assert.equal(await manualCount(p.task), 0, `skew ${skew}: no run`);
    assert.equal(await ledger(`bot_relay:${p.relay_id}`), null, `skew ${skew}: no claim`);
  }
  for (const skew of [-599, 599]) {
    const p = relayPayload(newId());
    assert.equal(await route(p, { eventCreatedAt: nowS() + skew }), "handled", `skew ${skew}`);
    assert.ok(await until(async () => (await manualCount(p.task)) === 1, 5_000), `skew ${skew}: runs`);
  }
});

test("B-R4 a missing or malformed created_at or relay_id is ignored", async () => {
  for (const eventCreatedAt of [undefined, null, 0, -5, 1.5, "1700000000"]) {
    const p = relayPayload(newId());
    assert.equal(await route(p, { eventCreatedAt }), "ignored", `created_at ${String(eventCreatedAt)}`);
  }
  for (const relay_id of ["r1", "", "ABCDEF".padEnd(32, "0"), "a".repeat(31), undefined]) {
    const p = relayPayload("0".repeat(32), { relay_id, task: `bad id ${String(relay_id)}` });
    assert.equal(await route(p), "ignored", `relay_id ${String(relay_id)}`);
    await settle();
    assert.equal(await manualCount(p.task), 0);
  }
});

test("B-R5 a claim insert error fails closed (no run) and is logged", async () => {
  _resetClaimOnceForTest();
  const broken = {
    execute: async (stmt) => {
      if (/INSERT OR IGNORE INTO processed_control_events/i.test(stmt.sql || stmt)) throw new Error("database is locked");
      return db.execute(stmt);
    },
  };
  const warns = [];
  const realWarn = console.warn;
  console.warn = (...a) => { warns.push(a.join(" ")); };
  try {
    const p = relayPayload(newId());
    assert.equal(await route(p, { useDb: broken }), "ignored");
    await settle();
    assert.equal(await manualCount(p.task), 0, "no run");
    assert.ok(warns.some((w) => /claim failed/.test(w) && /database is locked/.test(w)), `logged: ${warns.join(" | ")}`);
  } finally {
    console.warn = realWarn;
  }
});

test("B-R5 (m2) the insert succeeds and the prune throws: the task still runs once and the row exists", async () => {
  _resetClaimOnceForTest();
  let pruneCalls = 0;
  const prunesBroken = {
    execute: async (stmt) => {
      if (/DELETE FROM processed_control_events/i.test(stmt.sql || stmt)) { pruneCalls += 1; throw new Error("disk I/O error"); }
      return db.execute(stmt);
    },
  };
  const realWarn = console.warn;
  const warns = [];
  console.warn = (...a) => { warns.push(a.join(" ")); };
  try {
    const p = relayPayload(newId());
    assert.equal(await route(p, { useDb: prunesBroken }), "handled");
    assert.ok(await until(async () => (await manualCount(p.task)) === 1, 5_000), "runs once");
    assert.equal(pruneCalls, 1, "the prune was attempted");
    assert.ok(await ledger(`bot_relay:${p.relay_id}`), "ledger row exists");
    assert.ok(warns.some((w) => /prune failed/.test(w)), "the prune error is logged");
  } finally {
    console.warn = realWarn;
  }
});

test("claimOnce: true once per key, then false; the kind is not part of the key", async () => {
  const key = `bot_relay:${newId()}`;
  assert.equal(await claimOnce(db, key, "bot_relay"), true);
  assert.equal(await claimOnce(db, key, "bot_relay"), false);
  assert.equal(await claimOnce(db, key, "other"), false);
  assert.equal(await claimOnce(db, "", "bot_relay"), false);
  assert.equal(await claimOnce(null, key, "bot_relay"), false);
});

test("B-R6 a bot_relay for another target creates no ledger row", async () => {
  const p = relayPayload(newId(), { target_instance: "elsewhere" });
  assert.equal(await route(p), "ignored");
  await settle();
  assert.equal(await ledger(`bot_relay:${p.relay_id}`), null);
  assert.equal(await manualCount(p.task), 0);
});

test("B-R6 a bot_relay_result for another target creates no ledger row", async () => {
  const id = newId();
  const res = { relay_id: id, status: "success", result: "done", target_instance: "elsewhere", responder_instance: "laptop" };
  assert.equal(await route(res, { subtype: "bot_relay_result" }), "ignored");
  assert.equal(await ledger(`bot_relay_result:${id}`), null);
});
