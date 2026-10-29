/**
 * The shared secret detector (credential card Task 1): known key prefixes, "password: …"
 * phrasing and high-entropy tokens, and the surgical "[secret removed]" strip. The fake keys
 * below are built at run time from pieces, so no whole key-shaped literal sits in the repo.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { findSecrets, stripSecrets, detectorSource, SECRET_REMOVED } from "../servers/shared/secret-detect.js";

const rep = (s, n) => s.repeat(n);
const GH_TOKEN = "gh" + "p_" + rep("aB3dE5", 6);            // 36 chars after the prefix
const SK_KEY = "sk" + "-proj-" + rep("Zx9Qw2", 4);
const AWS_KEY = "AK" + "IA" + "Q7RT2XW9PL3MZ8KD";
const ENTROPY = "Tq8vR2mK9pXw4LzB7nYc3HsJ";                 // 24 chars, mixed case + digits

const kinds = (text) => findSecrets(text).map((h) => h.kind);
const spans = (text) => findSecrets(text).map((h) => text.slice(h.start, h.end));

test("prefix keys found", () => {
  for (const key of [GH_TOKEN, SK_KEY, AWS_KEY]) {
    const text = `here is my key ${key} thanks`;
    const hits = findSecrets(text);
    assert.equal(hits.length, 1, key);
    assert.equal(hits[0].kind, "prefix");
    assert.equal(text.slice(hits[0].start, hits[0].end), key);
  }
});

test("prefix keys are found on every call (the /g patterns are cloned, not shared)", () => {
  const text = `token ${GH_TOKEN}`;
  for (let i = 0; i < 5; i++) assert.deepEqual(spans(text), [GH_TOKEN], `call ${i}`);
});

test("password: phrasing found", () => {
  const cases = [
    ["my password: hunter2!x", "hunter2!x"],
    ["Password=correct-horse", "correct-horse"],
    ["pwd: s3cr3t!!", "s3cr3t!!"],
    ["the passcode : 864213", "864213"],
    ["api_key=abcdef", "abcdef"],
    ["API key: qwerty12", "qwerty12"],
    ["secret: opensesame", "opensesame"],
    ["token = abc.def.ghi", "abc.def.ghi"],
    ["my password is Hunter2Hunter2", "Hunter2Hunter2"],
    ["The API key is 9f8e7d6c5b", "9f8e7d6c5b"],
  ];
  for (const [text, value] of cases) {
    const hits = findSecrets(text);
    assert.equal(hits.length, 1, text);
    assert.equal(hits[0].kind, "phrase", text);
    assert.equal(text.slice(hits[0].start, hits[0].end), value, "only the value is the match, not the label: " + text);
  }
  assert.deepEqual(findSecrets("password: short"), [], "values under 6 characters are not flagged");
  for (const prose of ["The password is incorrect.", "my token is expired", "the secret is simple: be kind"]) {
    assert.deepEqual(findSecrets(prose), [], "the \"is\" form needs a digit in the value: " + prose);
  }
});

test("entropy token found", () => {
  const text = `use ${ENTROPY} for the login`;
  assert.deepEqual(kinds(text), ["entropy"]);
  assert.deepEqual(spans(text), [ENTROPY]);
  // Needs all three of upper, lower and digit.
  assert.deepEqual(findSecrets("tq8vr2mk9pxw4lzb7nyc3hsjqq"), [], "all lower case is left to the prefix list");
  const b64 = "dGhpcyBpcyBhIHNlY3JldCB0b2tlbjEyMw==";
  assert.deepEqual(spans(`blob ${b64}.`), [b64]);
  // A JWT: each dot-separated part is its own run, each flagged.
  const jwt = ["eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0", "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"];
  assert.deepEqual(spans("Bearer " + jwt.join(".")), jwt);
  assert.equal(stripSecrets("Bearer " + jwt.join(".")).text, "Bearer [secret removed].[secret removed].[secret removed]");
  // Random 32-character alphanumeric tokens (the canary's shape) are flagged. A fixed seed keeps
  // this deterministic: the structure signals miss roughly 1 in 5,000 such tokens by design.
  const AL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let seed = 0x5eed;
  const next = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 16;
  for (let i = 0; i < 300; i++) {
    let t = "";
    for (let j = 0; j < 32; j++) t += AL[next() % 62];
    if (!(/[A-Z]/.test(t) && /[a-z]/.test(t) && /[0-9]/.test(t))) continue;
    assert.deepEqual(kinds(`x ${t} y`), ["entropy"], t);
  }
  // A token-shaped segment of a path is still found on its own.
  assert.deepEqual(spans(`cat /tmp/${ENTROPY}/out`), [ENTROPY]);
});

test("ordinary prose not flagged", () => {
  const prose = [
    "Please book a table for four at seven tonight, and remind me to call the dentist.",
    "The password reset email never arrived; can you check the spam folder?",
    "Internationalization and counterrevolutionaries are long words but not secrets.",
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1",
    "abcdefghijklmnopqrstuvwxyzabcdef",        // no digit
    "123456789012345678901234567890",          // no letter
    "My token is in the keychain, not here.",
    "docs/2026-10-29-credential-card-map",     // dated path: lower case only
    "qwen3.6-35b-a3b-instruct-q4_k_m",         // model id: lower case only
    "see docs/2026-10-29-credential-card-map.md and load qwen3.6-35b-a3b-instruct-q4_k_m",
    "ALLCAPS0RUN1WITH2DIGITS3AND4NO5LOWER",    // no lower case
    // URLs and data: URIs are skipped whole.
    "https://docs.google.com/document/d/1PKMnwAbCdEfGhIjKlMnOpQrStUvWxYz123/edit",
    "open https://docs.google.com/document/d/1PKMnwAbCdEfGhIjKlMnOpQrStUvWxYz123/edit please",
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    // Paths are tested a segment at a time.
    "/home/kevin/Downloads/IMG_20261029_123456",
    "git push origin feat/R12-CredentialCard-Task1-review",
    // Names, not tokens: camelCase is mostly words; a GGUF name is short pieces joined.
    "getUserProfileById2FactorAuthentication",
    "6-35B-A3B-Instruct-UD-Q4_K_XL",
    "Qwen3.6-35B-A3B-Instruct-UD-Q4_K_XL.gguf",
  ];
  for (const text of prose) assert.deepEqual(findSecrets(text), [], text);
});

test("uuid and git sha not flagged", () => {
  const uuid = "550e8400-e29b-41d4-a716-446655440000";
  const sha = "8202fefcc4a1b2c3d4e5f60718293a4b5c6d7e8f";
  const upperSha = sha.toUpperCase();
  for (const text of [uuid, sha, upperSha, `commit ${sha} closes ${uuid}`]) {
    assert.deepEqual(findSecrets(text), [], text);
  }
  assert.equal(sha.length, 40);
  // Mixed-case hex is not hex-only: it is flagged by the same rule.
  assert.deepEqual(kinds("8202FEfcc4a1B2c3d4E5f60718293a4b5c6d7e8F"), ["entropy"]);
});

test("strip is surgical", () => {
  const text = `Hi! key ${GH_TOKEN}, password: hunter2!x and ${ENTROPY}. Bye.`;
  const out = stripSecrets(text);
  assert.equal(out.removed, 3);
  assert.equal(out.text, `Hi! key ${SECRET_REMOVED}, password: ${SECRET_REMOVED} and ${SECRET_REMOVED}. Bye.`);
  assert.equal(SECRET_REMOVED, "[secret removed]");
  assert.deepEqual(stripSecrets("nothing to see"), { text: "nothing to see", removed: 0 });
  // Overlapping rules collapse into one replacement.
  const both = `token: ${ENTROPY}`;
  assert.deepEqual(stripSecrets(both), { text: `token: ${SECRET_REMOVED}`, removed: 1 });
  assert.deepEqual(stripSecrets(""), { text: "", removed: 0 });
  assert.deepEqual(stripSecrets(null), { text: "", removed: 0 });
});

test("detectorSource rebuilds the same regexes (what the client will get)", () => {
  const src = detectorSource();
  assert.ok(Array.isArray(src.prefixes) && src.prefixes.length >= 18);
  for (const p of src.prefixes) {
    assert.equal(typeof p.name, "string");
    assert.doesNotThrow(() => new RegExp(p.source, p.flags), p.name);
  }
  const phrase = new RegExp(src.phrase.source, src.phrase.flags);
  assert.ok(phrase.test("password: hunter2!x"));
  const run = new RegExp(src.entropy.run.source, src.entropy.run.flags);
  assert.ok(run.test(ENTROPY));
  assert.ok(new RegExp(src.entropy.skip.source, src.entropy.skip.flags).test("https://example.com/x"));
  assert.equal(src.entropy.minLongestPiece, 10);
  assert.equal(src.entropy.maxMeanPiece, 3.5);
  assert.equal(src.entropy.minLength, 24);
  assert.equal(src.entropy.minBits, 3.5);
  assert.doesNotThrow(() => JSON.stringify(src));
  assert.ok(!JSON.stringify(src).includes("`"), "no backtick: the client embeds this in a template literal");
});
