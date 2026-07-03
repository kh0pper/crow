// tests/short-code.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SHORTCODE_EXPIRY_MS,
  generateShortCode,
  formatShortCode,
  normalizeShortCode,
  deriveShortCodeKeys,
  buildRendezvousEvent,
  parseRendezvousEvent,
} from "../servers/sharing/short-code.js";

// Small-N derivation for tests (documented test-only override) — full-strength
// N=2^17 would cost ~1s & 128MB per call; the derivation path is identical.
const T = { N: 2 ** 14 };

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const C1 = "K7Q4M2X93FHT"; // 12 Crockford chars
const C2 = "K7Q4M2X93FHW"; // differs in the last symbol

test("generateShortCode: 12 chars of the Crockford alphabet, no I/L/O/U", () => {
  for (let i = 0; i < 50; i++) {
    const c = generateShortCode();
    assert.equal(c.length, 12);
    for (const ch of c) assert.ok(ALPHABET.includes(ch), `bad char ${ch}`);
  }
});

test("formatShortCode groups in 4s", () => {
  assert.equal(formatShortCode(C1), "K7Q4-M2X9-3FHT");
});

test("normalizeShortCode: case, separators, confusables", () => {
  assert.equal(normalizeShortCode(" k7q4-m2x9-3fht "), "K7Q4M2X93FHT");
  assert.equal(normalizeShortCode("k7q4 m2x9 3fht"), "K7Q4M2X93FHT");
  assert.equal(normalizeShortCode("il0o23456789"), "11002345678" + "9", "I/L→1, O→0");
  assert.equal(normalizeShortCode("K7Q4M2X93FHU"), "", "U is not in the alphabet");
  assert.equal(normalizeShortCode("K7Q4M2X93FH"), "", "too short (11)");
  assert.equal(normalizeShortCode("K7Q4M2X93FHTT"), "", "too long (13)");
  assert.equal(normalizeShortCode(null), "");
});

test("deriveShortCodeKeys: deterministic, normalization-invariant, x-only pub", async () => {
  const a = await deriveShortCodeKeys(C1, T);
  const b = await deriveShortCodeKeys(" k7q4-m2x9-3fht ", T);
  assert.equal(a.pub, b.pub, "same code (post-normalization) → same key");
  assert.equal(a.pub.length, 64, "x-only hex pubkey");
  assert.ok(Buffer.isBuffer(a.priv) && a.priv.length === 32);
  const c = await deriveShortCodeKeys(C2, T);
  assert.notEqual(a.pub, c.pub, "different code → different key");
});

test("deriveShortCodeKeys rejects invalid codes", async () => {
  await assert.rejects(() => deriveShortCodeKeys("nope", T), /invalid short code/);
});

test("rendezvous envelope round-trips and binds to the code key", async () => {
  const keys = await deriveShortCodeKeys(C1, T);
  const payload = { inviteCode: "crow:abc123def0.eyJ4IjoxfQ.c2ln", expires: Date.now() + SHORTCODE_EXPIRY_MS };
  const event = buildRendezvousEvent(keys, payload);
  assert.equal(event.kind, 4, "kind:4 (relay allowlist)");
  assert.equal(event.pubkey, keys.pub, "authored by the code key");
  assert.deepEqual(event.tags, [["p", keys.pub]], "self p-tag");
  assert.ok(!event.content.includes(payload.inviteCode), "content is encrypted");
  const out = parseRendezvousEvent(event, keys);
  assert.deepEqual(out, payload);
});

test("wrong code cannot read the envelope", async () => {
  const keys = await deriveShortCodeKeys(C1, T);
  const wrong = await deriveShortCodeKeys(C2, T);
  const event = buildRendezvousEvent(keys, { inviteCode: "x", expires: Date.now() + 1000 });
  assert.throws(() => parseRendezvousEvent(event, wrong));
});

test("expired envelope is rejected", async () => {
  const keys = await deriveShortCodeKeys(C1, T);
  const event = buildRendezvousEvent(keys, { inviteCode: "x", expires: Date.now() - 1 });
  assert.throws(() => parseRendezvousEvent(event, keys), /expired/);
});

test("concurrent derivations resolve correctly (single-flight lock)", async () => {
  const [a, b] = await Promise.all([
    deriveShortCodeKeys(C1, T),
    deriveShortCodeKeys(C2, T),
  ]);
  assert.equal(a.pub.length, 64);
  assert.equal(b.pub.length, 64);
  assert.notEqual(a.pub, b.pub);
});
