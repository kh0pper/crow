import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFrame, parseFrame, PLAN1_KINDS } from "../servers/sharing/c2c/frames.js";

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
