/**
 * short-invite-tools — P2/C2 Task 3. Proves the two new MCP tools
 * (crow_generate_short_invite, crow_accept_short_invite) wire short-code.js +
 * shortcode-ledger.js + the two new NostrManager rendezvous methods correctly,
 * and that the extracted acceptInviteCore is a VERBATIM, behavior-preserving
 * move (crow_accept_invite still works identically, with no inviteId key).
 *
 * Stub-driven: nostrManager.publishRendezvousEvent / fetchRendezvousByAuthor /
 * sendMessage are method-stubbed (delivery-receipt-emit.test.js pattern) — no
 * live relays. The MCP tool harness follows message-request-gates.test.js's
 * captureTools() + freshLibsql() pattern (the lightest existing harness for
 * registerContactsTools).
 *
 * Test-speed note: crow_generate_short_invite / crow_accept_short_invite use
 * FULL-STRENGTH scrypt internally (no N override — that's production-only).
 * Empirically ~150-250ms per derivation on this hardware (the module's "~1-2s"
 * docstring figure is a conservative upper bound for weaker hardware), so
 * every test that reaches deriveShortCodeKeys pays that cost. Only the garbage
 * -code case (normalizeShortCode fails before any derivation) is derivation-
 * free. A module-level FIXED_CODE/fixedKeys pair amortizes one derivation
 * across all the accept-path tests that need to build a matching rendezvous
 * event (buildRendezvousEvent needs keys derived at the SAME strength the tool
 * will re-derive, or parseRendezvousEvent's pubkey check silently drops the
 * event as "not ours").
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createClient } from "@libsql/client";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerContactsTools } from "../servers/sharing/tools/contacts.js";
import { deriveInstanceIdentity, generateInviteCode, parseInviteCode } from "../servers/sharing/identity.js";
import {
  SHORTCODE_EXPIRY_MS,
  normalizeShortCode,
  deriveShortCodeKeys,
  buildRendezvousEvent,
} from "../servers/sharing/short-code.js";

function freshLibsql() {
  const dir = mkdtempSync(join(tmpdir(), "short-invite-tools-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return { dir, db, cleanup() { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}

// Capture registered MCP tool handlers by name (message-request-gates.test.js pattern).
function captureTools(registerFn, ctx) {
  const tools = {};
  const server = { tool: (name, _desc, _schema, handler) => { tools[name] = handler; } };
  registerFn(server, ctx);
  return tools;
}

function makeNostrStub(overrides = {}) {
  return {
    relays: new Map([["stub://r1", {}]]), // non-empty: sendMessage/acceptInviteCore skip reconnect
    async connectRelays() { return [...this.relays.keys()]; },
    async subscribeToContact() {},
    sendMessage: overrides.sendMessage || (async () => ({ eventId: "e", relays: ["stub://r1"] })),
    sendInviteAccepted: overrides.sendInviteAccepted || overrides.sendMessage || (async () => ({ eventId: "e", relays: ["stub://r1"] })),
    publishRendezvousEvent: overrides.publishRendezvousEvent || (async () => ["stub://r1"]),
    fetchRendezvousByAuthor: overrides.fetchRendezvousByAuthor || (async () => ({ events: [] })),
  };
}

const stubPeerManager = { joinContact: async () => {} };
const stubSyncManager = { initContact: async () => {} };

// Shared fixed code for the accept-path tests (derived ONCE at module scope,
// full-strength, so buildRendezvousEvent's keys match what the tool itself
// re-derives for the SAME code).
const FIXED_CODE = "K7Q4M2X93FHT";
const fixedKeys = await deriveShortCodeKeys(FIXED_CODE);

// --- 1. generate: formatted code + ledger + rendezvous publish, 10-min inner expiry ---
test("crow_generate_short_invite: formatted code, ledger record, rendezvous publish w/ 10-min inner expiry", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    const identity = deriveInstanceIdentity(randomBytes(32));
    const published = [];
    const nostrManager = makeNostrStub({
      publishRendezvousEvent: async (event) => { published.push(event); return ["stub://r1"]; },
    });
    const tools = captureTools(registerContactsTools, {
      db, identity, peerManager: stubPeerManager, syncManager: stubSyncManager, nostrManager,
    });

    const res = await tools.crow_generate_short_invite({});
    assert.ok(!res.isError, `generate should succeed: ${res.content?.[0]?.text}`);
    const text = res.content.map((c) => c.text).join("\n");

    const m = text.match(/[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}/);
    assert.ok(m, "a formatted XXXX-XXXX-XXXX code appears in the tool output");
    const normalized = normalizeShortCode(m[0]);
    assert.equal(normalized.length, 12, "displayed code parses via normalizeShortCode");

    assert.equal(published.length, 1, "exactly one rendezvous event published");
    const event = published[0];
    assert.equal(event.kind, 4, "rendezvous event is kind:4");
    const identityXOnly = identity.secp256k1Pubkey.length === 66
      ? identity.secp256k1Pubkey.slice(2) : identity.secp256k1Pubkey;
    assert.notEqual(event.pubkey, identityXOnly, "authored by the derived code key, NOT the identity's own key");
    assert.equal(event.pubkey.length, 64, "x-only 64-hex pubkey");

    // Independently re-derive the same code's keys (deterministic) to decrypt
    // the envelope and verify the inner invite code's expiry is short.
    const { parseRendezvousEvent } = await import("../servers/sharing/short-code.js");
    const keys = await deriveShortCodeKeys(normalized);
    const parsedEnvelope = parseRendezvousEvent(event, keys);
    const envelopeTtl = parsedEnvelope.expires - Date.now();
    assert.ok(envelopeTtl > 8 * 60 * 1000 && envelopeTtl <= SHORTCODE_EXPIRY_MS, "envelope expires ~10 min out");

    const innerParsed = parseInviteCode(parsedEnvelope.inviteCode); // validates + returns {crowId, ed25519Pubkey, secp256k1Pubkey, inviteId} — no `expires` (see identity.js:340-345)
    assert.ok(innerParsed.inviteId, "inner invite carries an inviteId");
    // parseInviteCode doesn't expose `expires` on its return value (shortcode-ledger.test.js
    // pattern: read it straight off the base64url payload instead).
    const innerRaw = JSON.parse(Buffer.from(parsedEnvelope.inviteCode.split(".")[1], "base64url").toString());
    const innerTtl = innerRaw.expires - Date.now();
    assert.ok(innerTtl > 8 * 60 * 1000 && innerTtl <= 10 * 60 * 1000,
      "inner invite code expires in ~10 min, NOT 24h — proves C1 fix (a) is wired (finding 9a)");

    const ledgerRow = await db.execute({
      sql: "SELECT value FROM dashboard_settings WHERE key = 'sharing:shortcode_invites'", args: [],
    });
    assert.equal(ledgerRow.rows.length, 1, "ledger row recorded");
    const ledger = JSON.parse(ledgerRow.rows[0].value);
    assert.ok(ledger[innerParsed.inviteId], "ledger tracks the generated inviteId");
    assert.equal(ledger[innerParsed.inviteId].state, "outstanding");
  } finally { cleanup(); }
});

// --- 2. generate with 0-relay publish → isError ---
test("crow_generate_short_invite: 0-relay publish → isError", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    const identity = deriveInstanceIdentity(randomBytes(32));
    const nostrManager = makeNostrStub({ publishRendezvousEvent: async () => [] });
    const tools = captureTools(registerContactsTools, {
      db, identity, peerManager: stubPeerManager, syncManager: stubSyncManager, nostrManager,
    });
    const res = await tools.crow_generate_short_invite({});
    assert.equal(res.isError, true, "0-relay publish is an error result");
  } finally { cleanup(); }
});

// --- 3. accept happy path ---
test("crow_accept_short_invite: happy path — contact inserted, invite_accepted carries inviteId", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    const identity = deriveInstanceIdentity(randomBytes(32));
    const inviter = deriveInstanceIdentity(randomBytes(32));
    const inviteId = "short-happy-1";
    const innerCode = generateInviteCode(inviter, { inviteId, expiresInMs: SHORTCODE_EXPIRY_MS });
    const envelopePayload = { inviteCode: innerCode, expires: Date.now() + SHORTCODE_EXPIRY_MS };
    const event = buildRendezvousEvent(fixedKeys, envelopePayload);

    const sent = [];
    const nostrManager = makeNostrStub({
      fetchRendezvousByAuthor: async (authorHex) => {
        assert.equal(authorHex, fixedKeys.pub, "fetch queried by the derived code pubkey");
        return { events: [event] };
      },
      sendMessage: async (contact, content) => { sent.push({ contact, content }); return { eventId: "e", relays: ["stub://r1"] }; },
    });
    const tools = captureTools(registerContactsTools, {
      db, identity, peerManager: stubPeerManager, syncManager: stubSyncManager, nostrManager,
    });

    const res = await tools.crow_accept_short_invite({ short_code: FIXED_CODE });
    assert.ok(!res.isError, `accept should succeed: ${res.content?.[0]?.text}`);

    const { rows } = await db.execute({ sql: "SELECT * FROM contacts WHERE crow_id = ?", args: [inviter.crowId] });
    assert.equal(rows.length, 1, "contact inserted");
    assert.equal(rows[0].secp256k1_pubkey, inviter.secp256k1Pubkey);

    assert.equal(sent.length, 1, "invite_accepted sent back to the inviter");
    const acceptancePayload = JSON.parse(sent[0].content);
    assert.equal(acceptancePayload.type, "invite_accepted");
    assert.equal(acceptancePayload.inviteId, inviteId, "acceptancePayload echoes the generated inviteId");
  } finally { cleanup(); }
});

// --- 4. accept with garbage code → isError, no derivation attempted (fast) ---
test("crow_accept_short_invite: garbage code → isError, no derivation attempted (fast)", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    const identity = deriveInstanceIdentity(randomBytes(32));
    const nostrManager = makeNostrStub();
    const tools = captureTools(registerContactsTools, {
      db, identity, peerManager: stubPeerManager, syncManager: stubSyncManager, nostrManager,
    });
    const start = Date.now();
    const res = await tools.crow_accept_short_invite({ short_code: "not-a-real-code!!" });
    const elapsed = Date.now() - start;
    assert.equal(res.isError, true);
    const text = res.content.map((c) => c.text).join("\n");
    assert.match(text, /doesn't look like a Crow short code/i);
    assert.ok(elapsed < 400, `garbage code should short-circuit before scrypt derivation (took ${elapsed}ms)`);
  } finally { cleanup(); }
});

// --- 5. accept when fetch returns { events: [] } ---
test("crow_accept_short_invite: fetch returns no events → isError not found/expired", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    const identity = deriveInstanceIdentity(randomBytes(32));
    const nostrManager = makeNostrStub({ fetchRendezvousByAuthor: async () => ({ events: [] }) });
    const tools = captureTools(registerContactsTools, {
      db, identity, peerManager: stubPeerManager, syncManager: stubSyncManager, nostrManager,
    });
    const res = await tools.crow_accept_short_invite({ short_code: FIXED_CODE });
    assert.equal(res.isError, true);
    const text = res.content.map((c) => c.text).join("\n");
    assert.match(text, /not found|expired/i);
  } finally { cleanup(); }
});

// --- 6. accept when envelope expired ---
test("crow_accept_short_invite: expired rendezvous envelope → isError", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    const identity = deriveInstanceIdentity(randomBytes(32));
    const event = buildRendezvousEvent(fixedKeys, { inviteCode: "crow:whatever.eyJ4IjoxfQ.sig", expires: Date.now() - 1000 });
    const nostrManager = makeNostrStub({ fetchRendezvousByAuthor: async () => ({ events: [event] }) });
    const tools = captureTools(registerContactsTools, {
      db, identity, peerManager: stubPeerManager, syncManager: stubSyncManager, nostrManager,
    });
    const res = await tools.crow_accept_short_invite({ short_code: FIXED_CODE });
    assert.equal(res.isError, true);
    const text = res.content.map((c) => c.text).join("\n");
    assert.match(text, /not found|expired/i);
  } finally { cleanup(); }
});

// --- 6b. I1 FAIL-CLOSED: two distinct rendezvous payloads under one code key ---
test("crow_accept_short_invite: I1 FAIL-CLOSED — two distinct rendezvous payloads under one code key → isError, no contact inserted", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    const identity = deriveInstanceIdentity(randomBytes(32));
    const inviterA = deriveInstanceIdentity(randomBytes(32));
    const inviterB = deriveInstanceIdentity(randomBytes(32));
    const codeA = generateInviteCode(inviterA, { inviteId: "a1", expiresInMs: SHORTCODE_EXPIRY_MS });
    const codeB = generateInviteCode(inviterB, { inviteId: "b1", expiresInMs: SHORTCODE_EXPIRY_MS });
    const e1 = buildRendezvousEvent(fixedKeys, { inviteCode: codeA, expires: Date.now() + SHORTCODE_EXPIRY_MS });
    const e2 = buildRendezvousEvent(fixedKeys, { inviteCode: codeB, expires: Date.now() + SHORTCODE_EXPIRY_MS });

    const nostrManager = makeNostrStub({ fetchRendezvousByAuthor: async () => ({ events: [e1, e2] }) });
    const tools = captureTools(registerContactsTools, {
      db, identity, peerManager: stubPeerManager, syncManager: stubSyncManager, nostrManager,
    });

    const res = await tools.crow_accept_short_invite({ short_code: FIXED_CODE });
    assert.equal(res.isError, true, "fails closed on a competing rendezvous event");
    const text = res.content.map((c) => c.text).join("\n");
    assert.match(text, /compromis/i);

    const { rows } = await db.execute({ sql: "SELECT COUNT(*) AS c FROM contacts", args: [] });
    assert.equal(Number(rows[0].c), 0, "no contact row inserted on the fail-closed path");
  } finally { cleanup(); }
});

// --- 7. VERBATIM guard: crow_accept_invite still works end-to-end on a plain invite ---
test("crow_accept_invite (plain, non-short) still works end-to-end — VERBATIM guard", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    const identity = deriveInstanceIdentity(randomBytes(32));
    const inviter = deriveInstanceIdentity(randomBytes(32));
    const plainCode = generateInviteCode(inviter); // legacy call: no opts → no inviteId, 24h expiry

    const sent = [];
    const nostrManager = makeNostrStub({
      sendMessage: async (contact, content) => { sent.push({ contact, content }); return { eventId: "e", relays: ["stub://r1"] }; },
    });
    const tools = captureTools(registerContactsTools, {
      db, identity, peerManager: stubPeerManager, syncManager: stubSyncManager, nostrManager,
    });

    const res = await tools.crow_accept_invite({ invite_code: plainCode });
    assert.ok(!res.isError, `plain accept should succeed: ${res.content?.[0]?.text}`);
    const text = res.content.map((c) => c.text).join("\n");
    assert.match(text, /Safety Number/i, "safety number shown, same as today");

    const { rows } = await db.execute({ sql: "SELECT * FROM contacts WHERE crow_id = ?", args: [inviter.crowId] });
    assert.equal(rows.length, 1, "contact inserted");

    assert.equal(sent.length, 1);
    const acceptancePayload = JSON.parse(sent[0].content);
    assert.equal(acceptancePayload.type, "invite_accepted");
    assert.ok(!("inviteId" in acceptancePayload), "plain accept: acceptancePayload carries NO inviteId key");
  } finally { cleanup(); }
});
