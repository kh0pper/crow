import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveBotIdentity, loadInstanceSeed, generateBotInviteCode, parseBotInviteCode } from "../servers/sharing/identity.js";

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

test("bot invite code round-trips address + token + relays", () => {
  const bot = deriveBotIdentity(SEED, "bot-alpha");
  const code = generateBotInviteCode(bot, "tok-123", ["wss://relay.example"]);
  const parsed = parseBotInviteCode(code);
  assert.equal(parsed.botCrowId, bot.crowId);
  assert.equal(parsed.ed25519Pubkey, bot.ed25519Pubkey);
  assert.equal(parsed.secp256k1Pubkey, bot.secp256k1Pubkey);
  assert.equal(parsed.token, "tok-123");
  assert.deepEqual(parsed.relays, ["wss://relay.example"]);
});

test("parseBotInviteCode rejects a tampered crow_id", () => {
  const bot = deriveBotIdentity(SEED, "bot-alpha");
  const other = deriveBotIdentity(SEED, "bot-beta");
  const code = generateBotInviteCode(bot, "tok-123");
  // Splice another bot's crow_id onto the front → integrity check must fail.
  const parts = code.split(".");
  const bad = [other.crowId, parts[1], parts[2]].join(".");
  assert.throws(() => parseBotInviteCode(bad), /mismatch|match/i);
});

test("parseBotInviteCode rejects a tampered payload (ed25519 signature)", () => {
  const bot = deriveBotIdentity(SEED, "bot-alpha");
  const code = generateBotInviteCode(bot, "tok-123", []);
  const [crowId, payloadB64, sig] = code.split(".");
  // Tamper a field the crowId↔ed25519 check does NOT cover (the secp key + token),
  // keeping crowId/ed25519Pub consistent → only the signature can catch it.
  const data = JSON.parse(Buffer.from(payloadB64, "base64url").toString());
  data.secp256k1Pub = "0".repeat(66);
  data.token = "stolen";
  const tampered = Buffer.from(JSON.stringify(data)).toString("base64url");
  const bad = [crowId, tampered, sig].join(".");
  assert.throws(() => parseBotInviteCode(bad), /signature/i);
});
