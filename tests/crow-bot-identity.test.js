import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveBotIdentity, loadInstanceSeed } from "../servers/sharing/identity.js";

const SEED = Buffer.alloc(32, 7); // fixed, deterministic

test("deriveBotIdentity is deterministic and bot-distinct", () => {
  const a1 = deriveBotIdentity(SEED, "bot-alpha");
  const a2 = deriveBotIdentity(SEED, "bot-alpha");
  const b = deriveBotIdentity(SEED, "bot-beta");
  assert.equal(a1.crowId, a2.crowId);
  assert.equal(a1.secp256k1Pubkey, a2.secp256k1Pubkey);
  assert.notEqual(a1.crowId, b.crowId);
  assert.notEqual(a1.secp256k1Pubkey, b.secp256k1Pubkey);
});

test("deriveBotIdentity shape: crow: id, hex keys, compressed secp (66 hex)", () => {
  const id = deriveBotIdentity(SEED, "bot-alpha");
  assert.match(id.crowId, /^crow:[0-9a-z]{10}$/);
  assert.equal(id.secp256k1Pubkey.length, 66);
  assert.equal(id.ed25519Pubkey.length, 64);
  assert.ok(Buffer.isBuffer(id.secp256k1Priv));
});

test("deriveBotIdentity requires seed + botId", () => {
  assert.throws(() => deriveBotIdentity(null, "x"));
  assert.throws(() => deriveBotIdentity(SEED, ""));
});

test("loadInstanceSeed reads the unencrypted seed from a given data dir", () => {
  const d = mkdtempSync(join(tmpdir(), "seed-"));
  try {
    const seedHex = Buffer.alloc(32, 5).toString("hex");
    writeFileSync(join(d, "identity.json"), JSON.stringify({ seed: seedHex }));
    assert.equal(loadInstanceSeed(d).toString("hex"), seedHex);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("loadInstanceSeed throws on an encrypted identity (no passphrase in host)", () => {
  const d = mkdtempSync(join(tmpdir(), "seed-enc-"));
  try {
    writeFileSync(join(d, "identity.json"), JSON.stringify({ encrypted: { salt: "x" } }));
    assert.throws(() => loadInstanceSeed(d), /encrypted/i);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
