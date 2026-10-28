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

import { padVapidPrivateKey, vapidPublicFromPrivate } from "../servers/gateway/bundle-env-secrets.js";

test("padVapidPrivateKey repairs a short stored key to the same 32-byte key, and leaves others alone", () => {
  let short;
  for (let i = 0; i < 5000 && !short; i++) {
    const ecdh = createECDH("prime256v1"); ecdh.generateKeys();
    const priv = ecdh.getPrivateKey();
    if (priv.length < 32) short = { priv, pub: ecdh.getPublicKey() };
  }
  assert.ok(short, "found a key with a dropped leading zero");
  const stored = short.priv.toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
  const fixed = padVapidPrivateKey(stored);
  assert.equal(raw(fixed).length, 32);
  assert.ok(raw(fixed).subarray(32 - short.priv.length).equals(short.priv), "same key, zero-padded");
  assert.equal(raw(vapidPublicFromPrivate(fixed)).toString("hex"), short.pub.toString("hex"), "same public key");
  const good = newVapidKeypair().privateKey;
  assert.equal(padVapidPrivateKey(good), good);
  assert.equal(padVapidPrivateKey(""), "");
  assert.equal(padVapidPrivateKey("not base64 !!"), "not base64 !!");
});
