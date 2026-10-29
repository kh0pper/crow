import { test } from "node:test";
import assert from "node:assert/strict";
import { REDACTED, redactSecrets, redactHeaderValue, redactThenTruncate, maxSecretBytes } from "../servers/shared/redact-secrets.js";

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
