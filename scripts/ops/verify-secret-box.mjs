#!/usr/bin/env node
/**
 * Smoke test for servers/sharing/secret-box.js.
 *
 * Round-trips sealSecret/openSecret with a fixture seed, confirms:
 *  - sealed output has "enc:v1:" prefix
 *  - openSecret returns the original plaintext
 *  - tampered ciphertext throws (AES-GCM tag mismatch)
 *  - wrong-identity open throws
 *  - isSealed distinguishes plain vs sealed
 *
 * Run: node scripts/ops/verify-secret-box.mjs
 */
import { sealSecret, openSecret, isSealed } from "../../servers/sharing/secret-box.js";

const fixtureSeedA = Buffer.alloc(32, 0xa5);
const fixtureSeedB = Buffer.alloc(32, 0x3c);
const identityA = { seed: fixtureSeedA };
const identityB = { seed: fixtureSeedB };

const PLAINTEXTS = [
  "crowadmin",
  "8r00kly^",
  "",
  "a".repeat(4096),
  "unicode-ok: 🪶 ✓",
];

let failed = 0;
function assert(cond, label) {
  if (!cond) { console.error("FAIL:", label); failed++; }
  else { console.log("ok:", label); }
}

for (const pt of PLAINTEXTS) {
  const sealed = sealSecret(pt, identityA);
  assert(isSealed(sealed), `seals produce enc:v1: prefix (len=${pt.length})`);
  const opened = openSecret(sealed, identityA);
  assert(opened === pt, `round-trip preserves plaintext (len=${pt.length})`);
  assert(openSecret(pt, identityA) === null, `openSecret on non-sealed returns null (len=${pt.length})`);
}

// tamper
const sealed = sealSecret("sensitive", identityA);
const blob = Buffer.from(sealed.slice("enc:v1:".length), "base64");
blob[blob.length - 1] ^= 0xff;
const tamperedSealed = "enc:v1:" + blob.toString("base64");
let threw = false;
try { openSecret(tamperedSealed, identityA); } catch { threw = true; }
assert(threw, "tampered ciphertext throws");

// wrong identity
threw = false;
try { openSecret(sealed, identityB); } catch { threw = true; }
assert(threw, "wrong-identity open throws");

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nOK");
