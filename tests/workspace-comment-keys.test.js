import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isoSecond, normQuote, flatten, fingerprint, slotOf, pairKey, threadKey, snapshot, diff, fromLive,
} from "../bundles/workspace/server/comments/keys.js";

const parse = (t) => [...String(t).matchAll(/@(\w+)/g)].map((m) => m[1]);
const fpOf = (threads) => fingerprint(flatten(threads)[0]);
const T = (o) => ({ durableId: null, author: "admin", date: "2026-10-28T03:20:55Z", text: "x", quoted_text: "q", resolved: false, replies: [], ...o });

test("live ms → saved second", () => {
  const live = flatten(fromLive({ Time: "1793157655325", UserName: "admin", Text: "@hank test", QuoteText: "q" }))[0];
  assert.equal(fingerprint(live), fingerprint({ author: "admin", date: "2026-10-28T03:20:55Z", text: "@hank test", quoted: "q", occ: 0 }));
  assert.equal(isoSecond(1793157655325), "2026-10-28T03:20:55Z");
  assert.equal(isoSecond("nope"), null);
});

test("fp: NFC, emoji ZWJ and RTL text match live↔saved", () => {
  const live = fromLive({ Time: 1793157655000, UserName: "admin", Text: "Café 👩‍💻 שלום ‏@hank", QuoteText: "q" });
  const saved = [T({ text: "Café 👩‍💻 שלום ‏@hank" })];
  assert.equal(fpOf(live), fpOf(saved));
});

test("quote whitespace: \\n vs \\r vs double space normalise equal", () => {
  assert.equal(normQuote("a\nb"), normQuote("a\rb"));
  assert.equal(normQuote("a\nb"), normQuote("a  b"));
  assert.equal(normQuote("  a b "), "a b");
});

test("R-WS-5: multi-paragraph live QuoteText equals saved quote", () => {
  assert.equal(normQuote("line one\r\nline two\r\n"), normQuote("line one line two"));
  const live = fromLive({ Time: 1793157655000, UserName: "admin", Text: "t", QuoteText: "line one\r\nline two\r\n" });
  const saved = [T({ text: "t", quoted_text: "line one line two" })];
  assert.equal(fpOf(live), fpOf(saved));
});

test("paste duplicates: occ 0 and 1, different fps, distinct slots", () => {
  const f = flatten([T({ text: "same" }), T({ text: "same" })]);
  assert.deepEqual(f.map((c) => c.occ), [0, 1]);
  assert.notEqual(fingerprint(f[0]), fingerprint(f[1]));
  assert.notEqual(slotOf(f[0]), slotOf(f[1]));
});

test("edit vs new: same slot + new @token → edited.newTokens=['hank']; same token reworded → newTokens=[]", () => {
  const a = snapshot([T({ text: "plain" })], parse);
  const b = snapshot([T({ text: "@hank plain" })], parse);
  let d = diff(a, b);
  assert.equal(d.added.length, 0);
  assert.deepEqual(d.edited[0].newTokens, ["hank"]);
  d = diff(b, snapshot([T({ text: "@hank reworded" })], parse));
  assert.deepEqual(d.edited[0].newTokens, []);
  d = diff(b, snapshot([T({ text: "@hank plain" }), T({ author: "coworker", text: "new" })], parse));
  assert.equal(d.added.length, 1);
  assert.equal(d.edited.length, 0);
});

test("re-key: durableId vanished, same root fp under a new id → rekeys; two candidates → ambiguous", () => {
  const prev = snapshot([T({ durableId: "A" })], parse);
  const next = snapshot([T({ durableId: "B" })], parse);
  assert.deepEqual(diff(prev, next).rekeys, [{ from: "d:A", to: "d:B", ambiguous: false }]);
  // occ makes real duplicates differ, so build the two-candidate case from snapshots directly
  const b = next[0];
  const two = [b, { ...b, key: "d:C" }];
  const r = diff(prev, two).rekeys;
  assert.equal(r.length, 1);
  assert.equal(r[0].ambiguous, true);
});

test("thread key falls back to fp: when durableId is null", () => {
  assert.equal(threadKey({ durableId: null }, "abc"), "fp:abc");
  assert.equal(threadKey({ durableId: "Z" }, "abc"), "d:Z");
  assert.match(snapshot([T()], parse)[0].key, /^fp:[0-9a-f]{64}$/);
});

test("pairKey is 16 hex and second-precision", () => {
  assert.match(pairKey("f1", "admin", "2026-10-28T03:20:55Z"), /^[0-9a-f]{16}$/);
  assert.equal(pairKey("f1", "admin", 1793157655325), pairKey("f1", "admin", "2026-10-28T03:20:55Z"));
});

test("fromLive honours plugin occs: 2nd pasted duplicate matches saved occ 1", () => {
  const saved = flatten([T({ text: "same" }), T({ text: "same" })]);
  const live = { Time: 1793157655000, UserName: "admin", Text: "same", QuoteText: "q" };
  assert.equal(fingerprint(flatten(fromLive(live, [1]))[0]), fingerprint(saved[1]));
  assert.equal(fingerprint(flatten(fromLive(live, [0]))[0]), fingerprint(saved[0]));
  assert.notEqual(fingerprint(saved[0]), fingerprint(saved[1]));
});

test("re-key after deleting the first of two duplicates is ambiguous", () => {
  const prev = snapshot([T({ durableId: "A", text: "s" }), T({ durableId: "A2", text: "s" })], parse);
  const next = snapshot([T({ durableId: "B", text: "s" })], parse);
  const r = diff(prev, next).rekeys;
  assert.equal(r.length, 1);
  assert.equal(r[0].ambiguous, true);
});
