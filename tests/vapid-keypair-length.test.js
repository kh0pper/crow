import { test } from "node:test";
import assert from "node:assert/strict";
import { createECDH } from "node:crypto";
import { newVapidKeypair } from "../servers/gateway/bundle-env-secrets.js";

const raw = (s) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

// About 1 in 256 P-256 private keys has a leading zero byte, which ECDH.getPrivateKey()
// drops. 3000 draws make a short key near-certain, so this fails if the key isn't padded.
test("newVapidKeypair always encodes a 32-byte private key that matches its public key", () => {
  for (let i = 0; i < 3000; i++) {
    const { privateKey, publicKey } = newVapidKeypair();
    const priv = raw(privateKey);
    assert.equal(priv.length, 32, `draw ${i}: private key is ${priv.length} bytes`);
    const ecdh = createECDH("prime256v1"); ecdh.setPrivateKey(priv);
    assert.ok(ecdh.getPublicKey().equals(raw(publicKey)), `draw ${i}: public key mismatch`);
  }
});
