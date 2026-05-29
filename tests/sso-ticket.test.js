import { test } from "node:test";
import assert from "node:assert/strict";
import {
  signTicket,
  verifyTicket,
  deriveSsoKey,
  isSafeDestPath,
  _resetSsoNonceCache,
} from "../servers/shared/sso-ticket.js";
import { signRequest, verifyRequest, _resetNonceCache } from "../servers/shared/cross-host-auth.js";

// 32-byte hex signing key (as stored in peer-tokens.json)
const KEY = "a".repeat(64);
const OTHER_KEY = "b".repeat(64);
const SRC = "1111111111111111";
const DST = "2222222222222222";

function freshTicket(overrides = {}) {
  return signTicket({ src: SRC, dst: DST, dest: "/dashboard/nest", signingKey: KEY, ...overrides });
}

test("sign -> verify round-trip is valid", () => {
  _resetSsoNonceCache();
  const { payloadB64, sig } = freshTicket();
  const r = verifyTicket({ payloadB64, sig, signingKey: KEY, expectedDst: DST });
  assert.equal(r.valid, true);
  assert.equal(r.ticket.src, SRC);
  assert.equal(r.ticket.dest, "/dashboard/nest");
});

test("tampered payload -> hmac_mismatch", () => {
  _resetSsoNonceCache();
  const { payloadB64, sig } = freshTicket();
  // flip a char in the payload
  const bad = payloadB64.slice(0, -1) + (payloadB64.slice(-1) === "A" ? "B" : "A");
  const r = verifyTicket({ payloadB64: bad, sig, signingKey: KEY, expectedDst: DST });
  assert.equal(r.valid, false);
  // either hmac_mismatch (sig over different bytes) or bad_payload if decode breaks;
  // both are rejections, but the signature is checked first → hmac_mismatch.
  assert.equal(r.reason, "hmac_mismatch");
});

test("tampered signature -> hmac_mismatch", () => {
  _resetSsoNonceCache();
  const { payloadB64, sig } = freshTicket();
  const bad = sig.slice(0, -1) + (sig.slice(-1) === "a" ? "b" : "a");
  const r = verifyTicket({ payloadB64, sig: bad, signingKey: KEY, expectedDst: DST });
  assert.equal(r.valid, false);
  assert.equal(r.reason, "hmac_mismatch");
});

test("wrong signing key -> hmac_mismatch", () => {
  _resetSsoNonceCache();
  const { payloadB64, sig } = freshTicket();
  const r = verifyTicket({ payloadB64, sig, signingKey: OTHER_KEY, expectedDst: DST });
  assert.equal(r.valid, false);
  assert.equal(r.reason, "hmac_mismatch");
});

test("wrong expectedDst -> dst_mismatch", () => {
  _resetSsoNonceCache();
  const { payloadB64, sig } = freshTicket();
  const r = verifyTicket({ payloadB64, sig, signingKey: KEY, expectedDst: "9999999999999999" });
  assert.equal(r.valid, false);
  assert.equal(r.reason, "dst_mismatch");
});

test("expired ticket (past exp + skew) -> expired", () => {
  _resetSsoNonceCache();
  const t0 = 1_000_000_000_000;
  const { payloadB64, sig } = signTicket({ src: SRC, dst: DST, dest: "/dashboard/nest", signingKey: KEY, ttlMs: 60_000, now: t0 });
  // now far past exp + 60s skew
  const r = verifyTicket({ payloadB64, sig, signingKey: KEY, expectedDst: DST, now: t0 + 60_000 + 60_000 + 1 });
  assert.equal(r.valid, false);
  assert.equal(r.reason, "expired");
});

test("future iat beyond skew -> future_ticket", () => {
  _resetSsoNonceCache();
  const t0 = 1_000_000_000_000;
  const { payloadB64, sig } = signTicket({ src: SRC, dst: DST, dest: "/dashboard/nest", signingKey: KEY, ttlMs: 60_000, now: t0 });
  // verifier clock is well before iat - skew
  const r = verifyTicket({ payloadB64, sig, signingKey: KEY, expectedDst: DST, now: t0 - 60_000 - 1 });
  assert.equal(r.valid, false);
  assert.equal(r.reason, "future_ticket");
});

test("ttl too long -> ttl_too_long", () => {
  _resetSsoNonceCache();
  const t0 = 1_000_000_000_000;
  // signer mints a 10-minute ticket; verifier clamps at 120s
  const { payloadB64, sig } = signTicket({ src: SRC, dst: DST, dest: "/dashboard/nest", signingKey: KEY, ttlMs: 600_000, now: t0 });
  const r = verifyTicket({ payloadB64, sig, signingKey: KEY, expectedDst: DST, now: t0 + 1000 });
  assert.equal(r.valid, false);
  assert.equal(r.reason, "ttl_too_long");
});

test("replay (second verify) -> nonce_replay", () => {
  _resetSsoNonceCache();
  const { payloadB64, sig } = freshTicket();
  const first = verifyTicket({ payloadB64, sig, signingKey: KEY, expectedDst: DST });
  assert.equal(first.valid, true);
  const second = verifyTicket({ payloadB64, sig, signingKey: KEY, expectedDst: DST });
  assert.equal(second.valid, false);
  assert.equal(second.reason, "nonce_replay");
});

test("domain separation: RPC signature does not verify as an SSO ticket", () => {
  _resetSsoNonceCache();
  // Build a real RPC signature with the same raw signing key.
  const headers = signRequest({
    method: "GET",
    path: "/dashboard/overview",
    body: "",
    authToken: "t".repeat(64),
    signingKey: KEY,
    sourceInstanceId: SRC,
  });
  // Feed the RPC signature + a plausible payload to the ticket verifier.
  const { payloadB64 } = freshTicket();
  const r = verifyTicket({ payloadB64, sig: headers["X-Crow-Signature"], signingKey: KEY, expectedDst: DST });
  assert.equal(r.valid, false);
  assert.equal(r.reason, "hmac_mismatch");
});

test("domain separation: SSO signature does not verify as an RPC request", () => {
  _resetNonceCache();
  const { payloadB64, sig } = freshTicket();
  const r = verifyRequest({
    method: "GET",
    path: "/dashboard/sso/accept",
    body: "",
    headers: {
      "x-crow-signature": sig,
      "x-crow-timestamp": String(Date.now()),
      "x-crow-nonce": "deadbeefdeadbeefdeadbeefdeadbeef",
      "x-crow-source": SRC,
    },
    signingKey: KEY,
  });
  assert.equal(r.valid, false);
});

test("deriveSsoKey differs from the raw signing key", () => {
  const sub = deriveSsoKey(KEY);
  assert.equal(Buffer.isBuffer(sub), true);
  assert.equal(sub.length, 32);
  assert.notEqual(sub.toString("hex"), KEY);
});

test("isSafeDestPath accepts safe local paths", () => {
  for (const ok of ["/dashboard/nest", "/dashboard/files", "/proxy/my-bundle/", "/dashboard/settings"]) {
    assert.equal(isSafeDestPath(ok), true, `expected safe: ${ok}`);
  }
});

test("isSafeDestPath rejects unsafe paths", () => {
  const bad = [
    "//evil.com",
    "https://evil.com",
    "http://x/y",
    "/a/../b",
    "/a%2e%2e/b",
    "/a\\b",
    "foo",
    "",
    "/with space",
    "/x?y=z",
    "/x#frag",
    "/with\r\nheader",
    "/colon:thing",
  ];
  for (const b of bad) {
    assert.equal(isSafeDestPath(b), false, `expected unsafe: ${JSON.stringify(b)}`);
  }
});

test("signTicket refuses an unsafe dest", () => {
  assert.throws(() => signTicket({ src: SRC, dst: DST, dest: "//evil.com", signingKey: KEY }));
});
