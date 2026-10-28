/**
 * PT-2.0 (private engineering notes, F2): a Nostr `bot_relay` task runs the
 * local AI with tools, so it is accepted only when
 *   1. the Nostr sender is this Crow ID's OWN key (sibling instances share the
 *      seed, and sendBotRelay sends with sendSelfMessage), and
 *   2. the named sender_instance is a trusted, live paired row (PT-1's
 *      peerTrust predicate).
 * `bot_relay_result` gets the same check (it raises a high-priority
 * notification). Real init-db scratch DB; the AI run is a spy.
 *
 * PT-2a: every event here is fresh (created_at = now) and carries its own
 * relay_id, since a relay_id is claimed once (tests/bot-relay-replay.test.js).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { makeRealDb, addPeerRow } from "./fixtures/sync-fleet.mjs";
import { deriveInstanceIdentity } from "../servers/sharing/identity.js";
import { routeBotRelay, isOwnNostrSender } from "../servers/sharing/bot-relay.js";

const LOCAL = "desk";
let dir, db;
const own = deriveInstanceIdentity(randomBytes(32));
const stranger = deriveInstanceIdentity(randomBytes(32));
// Nostr events carry x-only keys (64 hex); identity stores the 33-byte compressed form.
const xonly = (id) => id.secp256k1Pubkey.slice(2);

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "bot-relay-sender-"));
  db = await makeRealDb(dir);
  await addPeerRow(db, "laptop", { status: "active", trusted: 1 });
  await addPeerRow(db, "attic", { status: "offline", trusted: 1 });
  await addPeerRow(db, "old-box", { status: "revoked", trusted: 1 });
  await addPeerRow(db, "loose-box", { status: "active", trusted: 0 });
});
after(() => { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });

const newId = () => randomBytes(16).toString("hex");
const nowS = () => Math.floor(Date.now() / 1000);

function relay(sender, extra = {}) {
  return { relay_id: newId(), task: "list my notes", target_instance: LOCAL, sender_instance: sender, sender_name: sender, ...extra };
}

async function route(subtype, payload, senderPubkey) {
  const runs = [];
  const notes = [];
  const r = await routeBotRelay({
    subtype, payload, senderPubkey, db, identity: own, nostrManager: {},
    localName: LOCAL, eventCreatedAt: nowS(),
    run: async (...a) => { runs.push(a); },
    notify: async (n) => { notes.push(n); },
  });
  return { r, runs, notes };
}

test("isOwnNostrSender compares x-only keys, either form", () => {
  assert.equal(isOwnNostrSender(xonly(own), own.secp256k1Pubkey), true);
  assert.equal(isOwnNostrSender(own.secp256k1Pubkey, own.secp256k1Pubkey), true);
  assert.equal(isOwnNostrSender(xonly(stranger), own.secp256k1Pubkey), false);
  assert.equal(isOwnNostrSender("", own.secp256k1Pubkey), false);
  assert.equal(isOwnNostrSender(undefined, own.secp256k1Pubkey), false);
});

test("B-1 positive control: our own key + a trusted live sibling runs the task", async () => {
  for (const name of ["laptop", "attic"]) {
    const { r, runs } = await route("bot_relay", relay(name), xonly(own));
    assert.equal(r, "handled", name);
    assert.equal(runs.length, 1, `${name}: one AI run`);
  }
});

test("B-2 a stranger's Nostr key naming a valid sibling gets no AI run", async () => {
  const { r, runs } = await route("bot_relay", relay("laptop"), xonly(stranger));
  assert.equal(r, "ignored");
  assert.equal(runs.length, 0);
});

test("B-3 our own key naming a revoked or untrusted instance gets no AI run", async () => {
  for (const name of ["old-box", "loose-box", "never-paired"]) {
    const { r, runs } = await route("bot_relay", relay(name), xonly(own));
    assert.equal(r, "ignored", name);
    assert.equal(runs.length, 0, name);
  }
});

test("B-4 a task for another instance is not ours", async () => {
  const { r, runs } = await route("bot_relay", relay("laptop", { target_instance: "elsewhere" }), xonly(own));
  assert.equal(r, "ignored");
  assert.equal(runs.length, 0);
});

test("B-5 bot_relay_result: only our own key and a trusted responder raise a notification", async () => {
  const res = (responder) => ({ relay_id: newId(), status: "success", result: "done", target_instance: LOCAL, responder_instance: responder });
  const ok = await route("bot_relay_result", res("laptop"), xonly(own));
  assert.equal(ok.r, "handled");
  assert.equal(ok.notes.length, 1);
  assert.equal(ok.notes[0].source, "sharing:bot_relay_result");

  const fromStranger = await route("bot_relay_result", res("laptop"), xonly(stranger));
  assert.equal(fromStranger.r, "ignored");
  assert.equal(fromStranger.notes.length, 0);

  const fromRevoked = await route("bot_relay_result", res("old-box"), xonly(own));
  assert.equal(fromRevoked.r, "ignored");
  assert.equal(fromRevoked.notes.length, 0);
});

test("B-6 a trust lookup error fails closed", async () => {
  // The claim (processed_control_events) succeeds; only the trust lookup breaks.
  const broken = {
    execute: async (stmt) => {
      if (/processed_control_events/.test(stmt?.sql || "")) return db.execute(stmt);
      throw new Error("database disk image is malformed");
    },
  };
  const runs = [];
  const payload = relay("laptop");
  const r = await routeBotRelay({
    subtype: "bot_relay", payload, senderPubkey: xonly(own), db: broken, identity: own,
    nostrManager: {}, localName: LOCAL, eventCreatedAt: nowS(), run: async () => { runs.push(1); },
    freshClient: () => broken,
  });
  assert.equal(r, "ignored");
  assert.equal(runs.length, 0);
  const { rows } = await db.execute({ sql: "SELECT 1 FROM processed_control_events WHERE event_id = ?", args: [`bot_relay:${payload.relay_id}`] });
  assert.equal(rows.length, 1, "the claim ran, so the refusal came from the trust check");
});
