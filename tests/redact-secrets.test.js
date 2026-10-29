import { test } from "node:test";
import assert from "node:assert/strict";
import { REDACTED, redactSecrets, redactHeaderValue, redactThenTruncate, maxSecretBytes, redactAcross } from "../servers/shared/redact-secrets.js";

test("replaces every occurrence of a secret", () => {
  assert.equal(redactSecrets("a sk-secret-1 b sk-secret-1", ["sk-secret-1"]), `a ${REDACTED} b ${REDACTED}`);
  assert.equal(REDACTED, "[redacted]");
});

test("replaces several secrets", () => {
  assert.equal(redactSecrets("one-key-AAA and two-key-BBB", ["one-key-AAA", "two-key-BBB"]), `${REDACTED} and ${REDACTED}`);
});

test("secrets shorter than 4 characters are ignored", () => {
  assert.equal(redactSecrets("abc abc", ["abc", "", "a"]), "abc abc");
  assert.equal(redactSecrets("abcd abc", ["abcd"]), `${REDACTED} abc`);
  assert.equal(redactSecrets("abcdefg", ["abcdefg"], { minLen: 8 }), "abcdefg");
});

test("non-string input and non-string secrets", () => {
  assert.equal(redactSecrets(12345678, ["1234"]), REDACTED + "5678");
  assert.equal(redactSecrets(null, ["null"]), REDACTED);
  assert.equal(redactSecrets(undefined, [undefined, null, 42, "undefined"]), REDACTED);
  assert.equal(redactSecrets("text", undefined), "text");
  assert.equal(maxSecretBytes(["abcd", 5, "abcdef"]), 6);
});

test("header values: strings and arrays", () => {
  assert.equal(redactHeaderValue("Bearer sk-secret-1", ["sk-secret-1"]), `Bearer ${REDACTED}`);
  assert.deepEqual(redactHeaderValue(["sk-secret-1", "ok"], ["sk-secret-1"]), [REDACTED, "ok"]);
});

test("a secret straddling the cap is redacted, never cut into a prefix", () => {
  const key = "sk-straddle-secret-key";
  const cap = 1000;
  for (const before of [cap - 5, cap - 1, cap - key.length + 1]) {
    for (const input of ["x".repeat(before) + key + "tail".repeat(50), Buffer.from("x".repeat(before) + key + "tail".repeat(50))]) {
      const out = redactThenTruncate(input, [key], cap);
      assert.ok(Buffer.isBuffer(out));
      assert.ok(out.length <= cap);
      const text = out.toString("utf8");
      for (let n = 4; n <= key.length; n++) assert.ok(!text.includes(key.slice(0, n)), `a ${n}-character prefix leaked (offset ${before})`);
    }
  }
});

test("redactThenTruncate leaves short input whole", () => {
  assert.equal(redactThenTruncate("hello sk-secret-1", ["sk-secret-1"], 100).toString(), `hello ${REDACTED}`);
});

test("a secret that contains another is redacted whole, in either order", () => {
  const short = "abcd", long = "abcd-LONGSECRET-xyz";
  for (const list of [[short, long], [long, short]]) {
    const out = redactSecrets(`x ${long} y ${short} z`, list);
    assert.equal(out, `x ${REDACTED} y ${REDACTED} z`);
    assert.ok(!out.includes("LONGSECRET"), "no remainder of the longer secret survives");
  }
});

test("regex characters in a secret are matched literally, and duplicates are harmless", () => {
  assert.equal(redactSecrets("a.b*c(d) and aXbbc(d)", ["a.b*c(d)", "a.b*c(d)"]), `${REDACTED} and aXbbc(d)`);
  assert.equal(redactSecrets("p$&q$1r", ["p$&q$1r"]), REDACTED);
});

test("redactAcross: a secret split across pieces is redacted, the piece count is kept", () => {
  const S = "fake-live-ABCDEFGHIJ";
  assert.deepEqual(redactAcross(["head fake-live-A", "BCDEFGHIJ tail"], [S]), [`head ${REDACTED}`, " tail"]);
  assert.deepEqual(redactAcross(["fake-", "live-", "ABCDEFGHIJ"], [S]), [REDACTED, "", ""], "across three pieces");
  assert.deepEqual(redactAcross([`a ${S} b`, "c"], [S]), [`a ${REDACTED} b`, "c"], "inside one piece, as redactSecrets");
  assert.deepEqual(redactAcross([`${S}`, `${S}x`], [S]), [REDACTED, `${REDACTED}x`]);
  assert.deepEqual(redactAcross(["plain", "text"], [S]), ["plain", "text"]);
  assert.deepEqual(redactAcross(["abc", "def"], ["abc"]), ["abc", "def"], "below the length floor");
  assert.deepEqual(redactAcross([], [S]), []);
  for (const parts of [["x fake-live-ABC", "DEFGHIJ y", "z"], ["fake-live-ABCDEFGHIJfake-li", "ve-ABCDEFGHIJ"]]) {
    const out = redactAcross(parts, [S]);
    assert.equal(out.length, parts.length);
    assert.ok(!out.join("").includes(S));
    assert.equal(out.join(""), redactSecrets(parts.join(""), [S]), "same text as redacting the joined pieces");
  }
});
