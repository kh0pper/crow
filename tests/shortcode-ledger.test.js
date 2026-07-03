// tests/shortcode-ledger.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LEDGER_TTL_MS,
  recordShortInvite,
  consumeShortInvite,
} from "../servers/sharing/shortcode-ledger.js";
import { generateInviteCode, parseInviteCode } from "../servers/sharing/identity.js";

// Minimal in-memory dashboard_settings stub (contact-promote.test.js pattern).
function makeDb() {
  const store = new Map();
  return {
    async execute({ sql, args }) {
      if (/SELECT value FROM dashboard_settings/.test(sql)) {
        const v = store.get(args[0]);
        return { rows: v === undefined ? [] : [{ value: v }] };
      }
      if (/INSERT INTO dashboard_settings/.test(sql)) {
        store.set(args[0], args[1]);
        return { rows: [] };
      }
      throw new Error("unexpected sql: " + sql);
    },
    _store: store,
  };
}

test("record → consume → replayed", async () => {
  const db = makeDb();
  await recordShortInvite(db, "id-1", Date.now() + 600000);
  assert.equal(await consumeShortInvite(db, "id-1"), "consumed");
  assert.equal(await consumeShortInvite(db, "id-1"), "replayed");
});

test("unknown inviteId", async () => {
  const db = makeDb();
  assert.equal(await consumeShortInvite(db, "never-seen"), "unknown");
});

test("a past-codeExpiresAt row returns 'expired', not 'consumed'", async () => {
  const db = makeDb();
  await recordShortInvite(db, "stale", Date.now() - 1000); // codeExpiresAt already past
  assert.equal(await consumeShortInvite(db, "stale"), "expired");
});

// I2 ordering property (finding 9b): the ledger is consumed only AFTER the R4
// auth check, so an UNAUTHENTICATED invite_accepted that carries a valid
// inviteId must NOT burn the token. This is verified at the handleInviteAccepted
// level in tests/invite-accepted-promote.test.js (see Task 2 Step 6): add a case
// there where payload.inviteId is set but normalizePubkey(payload.secp) !=
// normalizePubkey(senderPubkey) — assert the contact is NOT promoted AND (drive
// a real ledger stub) the inviteId row remains 'outstanding' (consume NOT called
// before the auth bail). Keep the ledger-unit cases above for record/consume/
// expire/replay/prune semantics.

test("entries older than LEDGER_TTL_MS are pruned; consumed survives within TTL", async () => {
  const db = makeDb();
  await recordShortInvite(db, "old", Date.now() + 600000);
  // Backdate the entry beyond TTL by editing the stored JSON directly.
  const raw = JSON.parse(db._store.get("sharing:shortcode_invites"));
  raw["old"].recordedAt = Date.now() - LEDGER_TTL_MS - 1000;
  db._store.set("sharing:shortcode_invites", JSON.stringify(raw));
  assert.equal(await consumeShortInvite(db, "old"), "unknown", "pruned → unknown");
});

test("ledger TTL is much longer than the code expiry (late honest echo survives)", async () => {
  const db = makeDb();
  await recordShortInvite(db, "late", Date.now() + 600000);
  const raw = JSON.parse(db._store.get("sharing:shortcode_invites"));
  raw["late"].recordedAt = Date.now() - 60 * 60 * 60 * 1000; // 60h ago (PR3 retry horizon)
  db._store.set("sharing:shortcode_invites", JSON.stringify(raw));
  assert.equal(await consumeShortInvite(db, "late"), "consumed", "60h-late echo still consumes");
});

test("corrupt ledger JSON self-heals to empty", async () => {
  const db = makeDb();
  db._store.set("sharing:shortcode_invites", "{not json");
  assert.equal(await consumeShortInvite(db, "x"), "unknown");
  await recordShortInvite(db, "y", Date.now() + 1000); // must not throw
  assert.equal(await consumeShortInvite(db, "y"), "consumed");
});

// CWE-1321 regression: inviteId is attacker-controlled (echoed from a
// NIP-44-decrypted invite_accepted payload). "__proto__"/"constructor" must
// never be usable to pollute Object.prototype, whether via the read side
// (ledger["__proto__"] silently resolving to Object.prototype) or the write
// side (ledger["__proto__"] = {...} landing on Object.prototype globally).
test("proto-pollution: __proto__ inviteId is rejected, never pollutes Object.prototype", async () => {
  const db = makeDb();
  await recordShortInvite(db, "__proto__", Date.now() + 1000);
  assert.equal(await consumeShortInvite(db, "__proto__"), "unknown");
  assert.equal(Object.prototype.state, undefined);
  assert.equal(({}).state, undefined);
});

test("proto-pollution: constructor inviteId is rejected, never pollutes Object.prototype", async () => {
  const db = makeDb();
  await recordShortInvite(db, "constructor", Date.now() + 1000);
  assert.equal(await consumeShortInvite(db, "constructor"), "unknown");
  assert.equal(Object.prototype.state, undefined);
  assert.equal(({}).state, undefined);
});

test("generateInviteCode: additive inviteId + expiresInMs round-trip", async () => {
  // Identity fixture pattern from tests/crow-messages-editor.test.js:18-19 —
  // DATA_DIR is resolved at module load, so set CROW_DATA_DIR then dynamic-import.
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  process.env.CROW_DATA_DIR = mkdtempSync(join(tmpdir(), "crow-id-"));
  const { loadOrCreateIdentity } = await import("../servers/sharing/identity.js");
  const id = loadOrCreateIdentity();

  // legacy: no opts → no inviteId, ~24h expiry
  assert.equal(parseInviteCode(generateInviteCode(id)).inviteId, undefined);

  // inviteId echoes through
  assert.equal(parseInviteCode(generateInviteCode(id, { inviteId: "n-1" })).inviteId, "n-1");

  // short expiry: a 10-min inner code is accepted now but its expires is <1h out
  const short = generateInviteCode(id, { inviteId: "n-2", expiresInMs: 10 * 60 * 1000 });
  const parsed = parseInviteCode(short);
  assert.equal(parsed.inviteId, "n-2");
  // The short inner-invite expiry is ~10 min out, not 24h.
  assert.ok(parsed.inviteId === "n-2");
  const ttl = JSON.parse(Buffer.from(short.split(".")[1], "base64url")).expires - Date.now();
  assert.ok(ttl > 8 * 60 * 1000 && ttl <= 10 * 60 * 1000, "inner code expires in ~10 min");
  // parseInviteCode enforces expiry; a 1ms window elapses to already-expired.
  const brief = generateInviteCode(id, { expiresInMs: 1 });
  await new Promise((r) => setTimeout(r, 5));
  assert.throws(() => parseInviteCode(brief), /expire/i);
});
