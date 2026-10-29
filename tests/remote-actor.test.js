/**
 * Item 46 PR-B Task B1: the pair subkey derivation and the gateway-signed
 * remote actor (servers/shared/pair-subkey.js, servers/shared/remote-actor.js).
 * Pure crypto: no gateway, no network. See the private engineering notes.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { pairSubkey } from "../servers/shared/sync-pair-binding.js";
import { PAIR_SUBKEY_LABELS, pairSubkeyFor } from "../servers/shared/pair-subkey.js";
import {
  REMOTE_ACTOR_HEADER, REMOTE_ACTOR_SIG_HEADER, canonicalJson, toolCallDigest,
  signRemoteActor, signingFetch, verifyRemoteActor, noteRemoteActorResult,
  _resetRemoteActorNonces, _resetRemoteActorLog,
} from "../servers/shared/remote-actor.js";

const KEY = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const KEY_C = "ff".repeat(32);
const ALPHA = "alpha-instance";
const BRAVO = "bravo-instance";
const CHARLIE = "charlie-instance";
const MOUNT = "/router";
const BODY = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "crow_x", arguments: { a: 1 } } };
const NOW = Date.now() + 5000;

beforeEach(() => { _resetRemoteActorNonces(); _resetRemoteActorLog(); });

function sign(over = {}) {
  const o = { signingKeyHex: KEY, bot: "hank", name: "Hank", src: ALPHA, aud: BRAVO, mount: MOUNT, body: BODY, now: NOW, ...over };
  return signRemoteActor(o);
}
function verify(headers, over = {}) {
  return verifyRemoteActor({
    headers, body: BODY, peerId: ALPHA, localId: BRAVO, mount: MOUNT,
    keyLookup: () => KEY, now: NOW, processStartMs: 0, ...over,
  });
}
// Hand-build a correctly MAC'd header from an arbitrary payload.
function forge(payload, key = KEY) {
  const value = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const k = pairSubkeyFor(key, PAIR_SUBKEY_LABELS.REMOTE_ACTOR);
  const sig = createHmac("sha256", k).update("crow-remote-actor/v1\n" + value).digest("hex");
  return { [REMOTE_ACTOR_HEADER]: value, [REMOTE_ACTOR_SIG_HEADER]: sig };
}
function goodPayload(over = {}) {
  return { v: 1, kind: "bot", bot: "hank", name: "Hank", src: ALPHA, aud: BRAVO, mount: MOUNT, ts: NOW,
    nonce: "ab".repeat(16), dig: toolCallDigest(BODY), ...over };
}

test("RA-K1 pair subkey vectors and guards", () => {
  assert.equal(pairSubkeyFor(KEY, PAIR_SUBKEY_LABELS.SYNC).toString("hex"), "9e315a6df835c83bac1e5a942f5f770b7d05e48b477f966a07556d12bcc98cd2");
  assert.equal(pairSubkeyFor(KEY, PAIR_SUBKEY_LABELS.REMOTE_ACTOR).toString("hex"), "ab6c7f1338dae736b4175acbafae4208697deb125407c65d33828357ea34b7a1");
  assert.deepEqual(pairSubkey(KEY), pairSubkeyFor(KEY, PAIR_SUBKEY_LABELS.SYNC));
  assert.throws(() => pairSubkeyFor(KEY, "crow/other/v1"), Error);
  assert.throws(() => pairSubkeyFor(KEY, "GET"), Error);
  assert.throws(() => pairSubkeyFor("abc", PAIR_SUBKEY_LABELS.SYNC), TypeError);
  assert.throws(() => pairSubkeyFor("", PAIR_SUBKEY_LABELS.SYNC), TypeError);
  assert.throws(() => pairSubkeyFor("zz", PAIR_SUBKEY_LABELS.SYNC), TypeError);
  assert.throws(() => { PAIR_SUBKEY_LABELS.X = "y"; }, TypeError);
});

test("RA-D1 canonicalJson vectors", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } }), '{"a":{"c":[3,{"y":2,"z":1}],"d":2},"b":1}');
  assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }));
  assert.equal(canonicalJson(JSON.parse('{"__proto__":{"x":1}}')), '{"__proto__":{"x":1}}');
  assert.notEqual(canonicalJson(JSON.parse('{"__proto__":{"x":1}}')), canonicalJson({}));
  assert.equal(canonicalJson(-0), "0");
  assert.equal(canonicalJson(1e21), "1e+21");
  assert.equal(canonicalJson("\ud800"), '"\\ud800"');
  assert.equal(canonicalJson([[1, [2]], []]), "[[1,[2]],[]]");
  assert.equal(canonicalJson({ a: undefined, b: () => 1, c: null, d: true }), '{"c":null,"d":true}');
  assert.equal(canonicalJson(NaN), "null");
  assert.equal(canonicalJson(Infinity), "null");
  let deep = 1;
  for (let i = 0; i < 70; i++) deep = [deep];
  assert.throws(() => canonicalJson(deep));
  let ok = 1;
  for (let i = 0; i < 60; i++) ok = [ok];
  assert.doesNotThrow(() => canonicalJson(ok));
});

test("RA-D2 digest covers method/name/arguments only", () => {
  const base = toolCallDigest(BODY);
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.equal(toolCallDigest({ ...BODY, id: 99, jsonrpc: "x", params: { ...BODY.params, _meta: { q: 1 }, task: { ttl: 5 } } }), base);
  assert.notEqual(toolCallDigest({ ...BODY, params: { ...BODY.params, name: "crow_y" } }), base);
  assert.notEqual(toolCallDigest({ ...BODY, params: { ...BODY.params, arguments: { a: 2 } } }), base);
  assert.notEqual(toolCallDigest({ ...BODY, params: { ...BODY.params, arguments: { a: 1, b: 1 } } }), base);
  assert.equal(
    toolCallDigest({ method: "tools/call", params: { name: "n" } }),
    toolCallDigest({ method: "tools/call", params: { name: "n", arguments: {} } }),
  );
});

test("RA-V1 round trip", () => {
  const h = sign();
  assert.ok(h[REMOTE_ACTOR_HEADER].length <= 2048);
  assert.match(h[REMOTE_ACTOR_SIG_HEADER], /^[0-9a-f]{64}$/);
  assert.deepEqual(verify(h), { ok: true, actor: { bot: "hank", name: "Hank", src: ALPHA } });
});

test("sign returns null on every invalid input (positive control above)", () => {
  assert.ok(sign());
  assert.equal(sign({ signingKeyHex: "" }), null);
  assert.equal(sign({ signingKeyHex: null }), null);
  assert.equal(sign({ signingKeyHex: "abc" }), null);
  assert.equal(sign({ body: [BODY] }), null);
  assert.equal(sign({ body: { ...BODY, method: "tools/list" } }), null);
  assert.equal(sign({ body: null }), null);
  assert.equal(sign({ mount: "" }), null);
  assert.equal(sign({ mount: "router" }), null);
  assert.equal(sign({ mount: undefined }), null);
  assert.equal(sign({ bot: "hank@other" }), null);
  assert.equal(sign({ src: "" }), null);
  assert.equal(sign({ aud: 5 }), null);
  assert.equal(sign({ name: "x".repeat(5000), bot: "hank", mount: "/" + "m".repeat(3000) }), null);
  assert.ok(sign({ name: "" }), "empty name is valid input");
  assert.equal(verify(sign({ name: "" })).actor.name, "hank");
});

test("RA-V2 absent / too_long / malformed headers", () => {
  const h = sign();
  assert.equal(verify({}).reason, "absent");
  assert.equal(verify({ [REMOTE_ACTOR_HEADER]: "x".repeat(2049), [REMOTE_ACTOR_SIG_HEADER]: h[REMOTE_ACTOR_SIG_HEADER] }).reason, "too_long");
  assert.equal(verify({ [REMOTE_ACTOR_HEADER]: h[REMOTE_ACTOR_HEADER] }).reason, "malformed");
  assert.equal(verify({ [REMOTE_ACTOR_HEADER]: h[REMOTE_ACTOR_HEADER], [REMOTE_ACTOR_SIG_HEADER]: "zz" }).reason, "malformed");
  assert.equal(verify({ [REMOTE_ACTOR_HEADER]: h[REMOTE_ACTOR_HEADER], [REMOTE_ACTOR_SIG_HEADER]: "a".repeat(63) }).reason, "malformed");
  assert.equal(verify({ [REMOTE_ACTOR_SIG_HEADER]: h[REMOTE_ACTOR_SIG_HEADER] }).reason, "malformed");
});

test("RA-V3 no_key", () => {
  assert.equal(verify(sign(), { keyLookup: () => null }).reason, "no_key");
  assert.equal(verify(sign(), { keyLookup: () => { throw new Error("db"); } }).reason, "no_key");
  assert.equal(verify(sign()).ok, true);
});

test("RA-V4 bad_sig, and a key for another peer cannot verify", () => {
  assert.equal(verify(sign({ signingKeyHex: "11".repeat(32) })).reason, "bad_sig");
  // A's header presented by peer C: verified under C's key -> bad_sig.
  const h = sign();
  assert.equal(verify(h, { peerId: CHARLIE, keyLookup: (id) => (id === CHARLIE ? KEY_C : KEY) }).reason, "bad_sig");
  // C signs src=A with C's key, bearer-authenticated as C: src_mismatch.
  const forged = sign({ signingKeyHex: KEY_C, src: ALPHA });
  assert.equal(verify(forged, { peerId: CHARLIE, keyLookup: () => KEY_C }).reason, "src_mismatch");
  // tampered header value
  const t = { ...h, [REMOTE_ACTOR_HEADER]: h[REMOTE_ACTOR_HEADER].slice(0, -2) + "AA" };
  assert.equal(verify(t).reason, "bad_sig");
});

test("RA-V5 malformed decode and field types", () => {
  const notJson = (() => {
    const value = Buffer.from("not json").toString("base64url");
    const k = pairSubkeyFor(KEY, PAIR_SUBKEY_LABELS.REMOTE_ACTOR);
    return { [REMOTE_ACTOR_HEADER]: value, [REMOTE_ACTOR_SIG_HEADER]: createHmac("sha256", k).update("crow-remote-actor/v1\n" + value).digest("hex") };
  })();
  assert.equal(verify(notJson).reason, "malformed");
  assert.equal(verify(forge([1, 2])).reason, "malformed");
  assert.equal(verify(forge(null)).reason, "malformed");
  assert.equal(verify(forge(goodPayload({ ts: 1.5 }))).reason, "malformed");
  assert.equal(verify(forge(goodPayload({ nonce: "a".repeat(1000) }))).reason, "malformed");
  // a 1900-char nonce pushes the encoded header past 2048: rejected earlier
  assert.equal(verify(forge(goodPayload({ nonce: "a".repeat(1900) }))).reason, "too_long");
  assert.equal(verify(forge(goodPayload({ nonce: "AB".repeat(16) }))).reason, "malformed");
  assert.equal(verify(forge(goodPayload({ dig: "ab" }))).reason, "malformed");
  assert.equal(verify(forge(goodPayload({ name: 5 }))).reason, "malformed");
  assert.equal(verify(forge(goodPayload({ mount: null }))).reason, "malformed");
  assert.equal(verify(forge(goodPayload())).ok, true);
});

test("RA-V6 unsupported / bad_kind / bad_bot", () => {
  assert.equal(verify(forge(goodPayload({ v: 2 }))).reason, "unsupported");
  assert.equal(verify(forge(goodPayload({ kind: "user" }))).reason, "bad_kind");
  assert.equal(verify(forge(goodPayload({ bot: "hank@other" }))).reason, "bad_bot");
  assert.equal(verify(forge(goodPayload({ bot: "" }))).reason, "bad_bot");
});

test("RA-V7 src / aud / mount mismatch", () => {
  assert.equal(verify(sign(), { peerId: CHARLIE }).reason, "src_mismatch");
  assert.equal(verify(sign({ aud: "other" })).reason, "aud_mismatch");
  assert.equal(verify(sign({ mount: "/memory" })).reason, "mount_mismatch");
  assert.equal(verify(sign()).ok, true);
});

test("RA-V8 stale in both directions, pre_boot", () => {
  assert.equal(verify(sign({ now: NOW - 61_000 })).reason, "stale");
  assert.equal(verify(sign({ now: NOW + 61_000 })).reason, "stale");
  assert.equal(verify(sign({ now: NOW - 59_000 })).ok, true);
  _resetRemoteActorNonces();
  assert.equal(verify(sign({ now: NOW + 59_000 })).ok, true);
  _resetRemoteActorNonces();
  assert.equal(verify(sign(), { processStartMs: NOW + 1 }).reason, "pre_boot");
  assert.equal(verify(sign(), { processStartMs: NOW }).ok, true);
});

test("RA-V9 name is sanitized on verify", () => {
  const h = forge(goodPayload({ name: "‮Evil (admin) [x]\u0007" }));
  const r = verify(h);
  assert.equal(r.ok, true);
  assert.equal(r.actor.name, "Evil admin x");
  assert.equal(verify(forge(goodPayload({ name: "()", nonce: "cd".repeat(16) }))).actor.name, "hank");
});

test("RA-V10 digest_mismatch", () => {
  const h = sign();
  assert.equal(verify(h, { body: { ...BODY, params: { ...BODY.params, arguments: { a: 2 } } } }).reason, "digest_mismatch");
  assert.equal(verify(h, { body: [BODY] }).reason, "digest_mismatch");
  assert.equal(verify(h, { body: { ...BODY, method: "tools/list" } }).reason, "digest_mismatch");
  assert.equal(verify(h, { body: null }).reason, "digest_mismatch");
  assert.equal(verify(h).ok, true);
});

test("replay: second verify of the same headers and body", () => {
  const h = sign();
  assert.equal(verify(h).ok, true);
  assert.equal(verify(h).reason, "replay");
  // a failed verification does not burn the nonce
  const h2 = sign({ now: NOW });
  assert.equal(verify(h2, { body: { ...BODY, method: "x" } }).reason, "digest_mismatch");
  assert.equal(verify(h2).ok, true);
});

test("RA-V14 per-source cap and TTL", () => {
  const nonce = (i) => i.toString(16).padStart(32, "0");
  for (let i = 0; i < 2000; i++) {
    assert.equal(verify(sign({ nonce: nonce(i) })).ok, true, `nonce ${i}`);
  }
  assert.equal(verify(sign({ nonce: nonce(2000) })).reason, "replay_cache_full");
  // another source is unaffected
  const c = sign({ signingKeyHex: KEY_C, src: CHARLIE });
  assert.equal(verify(c, { peerId: CHARLIE, keyLookup: () => KEY_C }).ok, true);
  // after the TTL, expired entries are pruned and A is accepted again
  const later = NOW + 121_000;
  assert.equal(verify(sign({ nonce: nonce(2000), now: later }), { now: later }).ok, true);
});

test("signingFetch signs tools/call POSTs, passes the rest through", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push({ url, init }); return { ok: true }; };
  let unsigned = 0;
  let key = KEY;
  const f = signingFetch({ keyLookup: () => key, src: ALPHA, aud: BRAVO, mount: MOUNT, bot: "hank", name: "Hank", fetchImpl, onUnsigned: () => { unsigned++; } });
  const body = JSON.stringify(BODY);
  await f("http://x/router/mcp", { method: "POST", body, headers: { "content-type": "application/json" } });
  const h1 = seen[0].init.headers;
  assert.ok(h1[REMOTE_ACTOR_HEADER] && h1[REMOTE_ACTOR_SIG_HEADER]);
  assert.equal(h1["content-type"], "application/json");
  assert.equal(verify(h1).ok, true);

  // key rotates between calls: looked up per call
  key = KEY_C;
  await f("http://x/router/mcp", { method: "POST", body, headers: {} });
  const h2 = seen[1].init.headers;
  assert.equal(verify(h2, { keyLookup: () => KEY }).reason, "bad_sig");
  assert.equal(verify(h2, { keyLookup: () => KEY_C }).ok, true);

  // pass-through, byte-identical init objects
  const passes = [
    { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) },
    { method: "POST", body: JSON.stringify({ ...BODY, method: "tools/list" }) },
    { method: "POST", body: JSON.stringify([BODY]) },
    { method: "POST", body: "not json" },
    { method: "GET" },
    undefined,
  ];
  for (const init of passes) {
    const before = seen.length;
    await f("http://x/router/mcp", init);
    assert.equal(seen[before].init, init);
  }
  assert.equal(unsigned, 0);

  // no key: unsigned, onUnsigned once per call
  key = null;
  await f("http://x/router/mcp", { method: "POST", body, headers: { a: "b" } });
  const last = seen[seen.length - 1].init.headers;
  assert.equal(last[REMOTE_ACTOR_HEADER], undefined);
  assert.equal(last.a, "b");
  assert.equal(unsigned, 1);
  await f("http://x/router/mcp", { method: "POST", body });
  assert.equal(unsigned, 2);
});

test("signingFetch preserves Headers instances, arrays, plain objects; onUnsigned never throws", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push(init); return {}; };
  const f = signingFetch({ keyLookup: () => KEY, src: ALPHA, aud: BRAVO, mount: MOUNT, bot: "hank", name: "Hank", fetchImpl });
  const body = JSON.stringify(BODY);
  await f("u", { method: "POST", body, headers: new Headers({ "X-Keep": "1" }) });
  await f("u", { method: "POST", body, headers: [["x-keep", "2"]] });
  await f("u", { method: "POST", body, headers: { "x-keep": "3" } });
  for (let i = 0; i < 3; i++) {
    const h = new Headers(seen[i].headers);
    assert.equal(h.get("x-keep"), String(i + 1));
    assert.ok(h.get(REMOTE_ACTOR_HEADER));
    assert.ok(h.get(REMOTE_ACTOR_SIG_HEADER));
  }
  const g = signingFetch({ keyLookup: () => null, src: ALPHA, aud: BRAVO, mount: MOUNT, bot: "hank", name: "Hank", fetchImpl, onUnsigned: () => { throw new Error("boom"); } });
  await assert.doesNotReject(() => g("u", { method: "POST", body }));
  const lk = signingFetch({ keyLookup: () => { throw new Error("db"); }, src: ALPHA, aud: BRAVO, mount: MOUNT, bot: "hank", name: "Hank", fetchImpl });
  await assert.doesNotReject(() => lk("u", { method: "POST", body }));
});

function captureConsole(fn) {
  const out = [];
  const ow = console.warn, ol = console.log;
  console.warn = (...a) => out.push(["warn", a.join(" ")]);
  console.log = (...a) => out.push(["log", a.join(" ")]);
  try { fn(); } finally { console.warn = ow; console.log = ol; }
  return out;
}

test("noteRemoteActorResult rate limits and never leaks", () => {
  const h = sign();
  const out = captureConsole(() => {
    noteRemoteActorResult({ sourceId: ALPHA, mount: MOUNT, result: { ok: false, reason: "bad_sig" } });
    noteRemoteActorResult({ sourceId: ALPHA, mount: MOUNT, result: { ok: false, reason: "bad_sig" } });
    noteRemoteActorResult({ sourceId: ALPHA, mount: MOUNT, result: { ok: false, reason: "stale" } });
    noteRemoteActorResult({ sourceId: ALPHA, mount: MOUNT, result: { ok: false, reason: "absent" } });
    noteRemoteActorResult({ sourceId: ALPHA, mount: MOUNT, result: { ok: true, actor: { bot: "hank", name: "Hank", src: ALPHA } } });
    noteRemoteActorResult({ sourceId: ALPHA, mount: MOUNT, result: { ok: true, actor: { bot: "hank", name: "Hank", src: ALPHA } } });
    noteRemoteActorResult({ sourceId: ALPHA, mount: "/memory", result: { ok: true, actor: { bot: "hank", name: "Hank", src: ALPHA } } });
  });
  assert.deepEqual(out.filter((o) => o[0] === "warn").map((o) => o[1]), [
    `[remote-actor] downgraded a call from ${ALPHA} on ${MOUNT}: bad_sig`,
    `[remote-actor] downgraded a call from ${ALPHA} on ${MOUNT}: stale`,
  ]);
  assert.deepEqual(out.filter((o) => o[0] === "log").map((o) => o[1]), [
    `[remote-actor] accepted bot hank from ${ALPHA} on ${MOUNT}`,
    `[remote-actor] accepted bot hank from ${ALPHA} on /memory`,
  ]);
  const all = out.map((o) => o[1]).join("\n");
  assert.ok(!all.includes(KEY));
  assert.ok(!all.includes(h[REMOTE_ACTOR_SIG_HEADER]));
  assert.ok(!all.includes(h[REMOTE_ACTOR_HEADER]));
  // reset re-arms the limiter
  _resetRemoteActorLog();
  const again = captureConsole(() => noteRemoteActorResult({ sourceId: ALPHA, mount: MOUNT, result: { ok: false, reason: "bad_sig" } }));
  assert.equal(again.length, 1);
});
