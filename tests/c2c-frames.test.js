import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFrame, parseFrame, PLAN1_KINDS, BODY_CAPS } from "../servers/sharing/c2c/frames.js";

const U = "a".repeat(32), E = "b".repeat(32);
const base = { projectUuid: U, fromInstanceId: "i-a", toInstanceId: "i-b" };
const bodies = {
  "project.invite": { name: "Proj", role: "editor", owner_instance_id: "i-a" },
  "project.accept": { visitor_instance_id: "i-b" },
  "project.decline": { reason: "left" },
  "project.role": { role: "viewer" },
  "project.unshare": {},
  "project.ack": { seqs: [1, 2, 3] },
  "project.refuse": { seq: 4, reason: "gap", detail: "x" },
};
const mk = (kind, over = {}) => {
  const noSeq = kind === "project.ack" || kind === "project.refuse";
  return buildFrame({ ...base, kind, epoch: noSeq ? undefined : E, seq: noSeq ? undefined : 1, body: bodies[kind], ...over });
};

for (const kind of PLAN1_KINDS) {
  test(`${kind} round-trips`, () => {
    const f = mk(kind);
    const r = parseFrame(JSON.parse(JSON.stringify(f)));
    assert.equal(r.ok, true);
    assert.deepEqual(r.frame, f);
  });
}

test("an oversized body is bad_frame", () => {
  const r = parseFrame(mk("project.invite", { body: { ...bodies["project.invite"], pad: "x".repeat(5000) } }));
  assert.deepEqual(r, { ok: false, reason: "bad_frame" });
});
test("an unknown kind is unsupported", () => {
  assert.deepEqual(parseFrame(mk("project.invite", { kind: "project.teleport" })), { ok: false, reason: "unsupported" });
});
test("a non-integer seq is bad_frame", () => {
  assert.equal(parseFrame(mk("project.role", { seq: 1.5 })).reason, "bad_frame");
  assert.equal(parseFrame(mk("project.role", { seq: 0 })).reason, "bad_frame");
});
test("a role outside viewer|commenter|editor is bad_frame", () => {
  assert.equal(parseFrame(mk("project.role", { body: { role: "owner" } })).reason, "bad_frame");
});
test("an invite name over 200 chars is bad_frame", () => {
  assert.equal(parseFrame(mk("project.invite", { body: { ...bodies["project.invite"], name: "n".repeat(201) } })).reason, "bad_frame");
});
test("weird input never throws", () => {
  for (const x of [null, undefined, 5, "s", [], { type: "c2c", v: 1, kind: {} }]) assert.equal(parseFrame(x).ok, false);
});

const BAD = { ok: false, reason: "bad_frame" };

test("v other than 1 is unsupported", () => {
  assert.deepEqual(parseFrame({ ...mk("project.role"), v: 2 }), { ok: false, reason: "unsupported" });
});
test("project.comment is unsupported", () => {
  assert.deepEqual(parseFrame(mk("project.role", { kind: "project.comment" })), { ok: false, reason: "unsupported" });
});
test("__proto__ and extra keys are stripped; Object.prototype untouched", () => {
  const raw = JSON.parse(`{"type":"c2c","v":1,"kind":"project.role","project_uuid":"${U}","epoch":"${E}","seq":1,
    "from_instance_id":"i-a","to_instance_id":"i-b","extra":1,"__proto__":{"polluted":1},
    "body":{"role":"editor","junk":2,"__proto__":{"polluted":1}}}`);
  const r = parseFrame(raw);
  assert.equal(r.ok, true);
  assert.notEqual(r.frame, raw);
  assert.deepEqual(r.frame.body, { role: "editor" });
  assert.equal(Object.hasOwn(r.frame, "__proto__"), false);
  assert.equal(Object.hasOwn(r.frame, "extra"), false);
  assert.equal(Object.getPrototypeOf(r.frame), Object.prototype);
  assert.equal({}.polluted, undefined);
});
test("non-plain objects are bad_frame", () => {
  assert.deepEqual(parseFrame(Object.create({ type: "c2c" })), BAD);
  assert.deepEqual(parseFrame(mk("project.role", { body: new Map() })), BAD);
});
test("ack seqs validation", () => {
  const ack = (seqs) => parseFrame(mk("project.ack", { body: { seqs } }));
  assert.equal(ack(Array.from({ length: 256 }, (_, i) => i + 1)).ok, true);
  assert.deepEqual(ack(Array.from({ length: 257 }, (_, i) => i + 1)), BAD);
  assert.deepEqual(ack([1, "2"]), BAD);
  assert.deepEqual(ack([0]), BAD);
  assert.deepEqual(ack("1,2"), BAD);
  assert.deepEqual(ack({ length: 1, 0: 1 }), BAD);
});
test("refuse validation", () => {
  const ref = (body) => parseFrame(mk("project.refuse", { body }));
  assert.equal(ref({ seq: 1, reason: "gap", detail: "d".repeat(200) }).ok, true);
  assert.deepEqual(ref({ seq: 1, reason: "gap", detail: "d".repeat(201) }), BAD);
  assert.deepEqual(ref({ seq: 1, reason: "nope" }), BAD);
  assert.deepEqual(ref({ seq: 0, reason: "gap" }), BAD);
  assert.deepEqual(ref({ seq: 1, reason: "gap", detail: "a\u0000b" }), BAD);
  assert.deepEqual(ref({ seq: 1, reason: "gap", detail: "a\ud800" }), BAD);
});
test("ack or refuse with an envelope seq is bad_frame", () => {
  assert.deepEqual(parseFrame(mk("project.ack", { seq: 1 })), BAD);
  assert.deepEqual(parseFrame(mk("project.refuse", { seq: 1 })), BAD);
});
test("missing epoch on a non-ack frame is bad_frame", () => {
  assert.deepEqual(parseFrame(mk("project.role", { epoch: undefined })), BAD);
});
test("uppercase hex is bad_frame", () => {
  assert.deepEqual(parseFrame(mk("project.role", { projectUuid: "A".repeat(32) })), BAD);
  assert.deepEqual(parseFrame(mk("project.role", { epoch: "B".repeat(32) })), BAD);
});
test("seq of wrong type or range is bad_frame", () => {
  for (const seq of ["1", NaN, Infinity, 2 ** 53, -1, null]) {
    assert.deepEqual(parseFrame(mk("project.role", { seq })), BAD, String(seq));
  }
});
test("instance ids are restricted", () => {
  for (const id of ["", "a b", "a\nb", "x".repeat(129), "é"]) {
    assert.deepEqual(parseFrame(mk("project.role", { fromInstanceId: id })), BAD);
    assert.deepEqual(parseFrame(mk("project.accept", { toInstanceId: id })), BAD);
  }
  assert.deepEqual(parseFrame(mk("project.invite", { body: { ...bodies["project.invite"], owner_instance_id: "a b" } })), BAD);
  assert.deepEqual(parseFrame(mk("project.accept", { body: { visitor_instance_id: "a/b" } })), BAD);
});
test("invite name rejects control chars and lone surrogates", () => {
  for (const name of ["a\u0007b", "a\u007f", "a\ud83d", "\udc00x"]) {
    assert.deepEqual(parseFrame(mk("project.invite", { body: { ...bodies["project.invite"], name } })), BAD);
  }
  assert.equal(parseFrame(mk("project.invite", { body: { ...bodies["project.invite"], name: "café \u{1F426}" } })).ok, true);
});
test("deeply nested body is bad_frame without throwing", () => {
  let o = {};
  for (let i = 0; i < 200000; i++) o = { a: o };
  assert.deepEqual(parseFrame(mk("project.unshare", { body: o })), BAD);
});
test("a throwing getter never throws", () => {
  const p = { type: "c2c", v: 1, get kind() { throw new Error("boom"); } };
  assert.deepEqual(parseFrame(p), BAD);
  const f = mk("project.role", { body: { role: "viewer" } });
  Object.defineProperty(f.body, "role", { get() { throw new Error("boom"); }, enumerable: true });
  assert.deepEqual(parseFrame(f), BAD);
});
test("every cap is exact: at the limit passes, one byte over fails", () => {
  for (const kind of PLAN1_KINDS) {
    const cap = BODY_CAPS[kind];
    const sized = (n) => {
      const body = { ...bodies[kind], p: "" };
      body.p = "x".repeat(n - Buffer.byteLength(JSON.stringify(body)));
      assert.equal(Buffer.byteLength(JSON.stringify(body)), n);
      return parseFrame(mk(kind, { body }));
    };
    const ok = sized(cap);
    assert.equal(ok.ok, true, kind);
    assert.equal(Object.hasOwn(ok.frame.body, "p"), false);
    assert.deepEqual(sized(cap + 1), BAD, kind);
  }
});
