/**
 * The result-requester registry (PR 5, Task 5.1): which rail gets a card's final report. A kind registers
 * { notice, restore, owns }; a card is claimed in memory, else the first kind whose `owns` finds it in the DB
 * claims it [rv1 C7]; a kind that throws or answers with a non-object gives null, so the generic board notice
 * goes out. The registry lives on a globalThis symbol, so two module instances share one set of claims (P30).
 * Pure: a fake cdb object stands in for crow.db.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const RR = await import("../servers/gateway/board/result-requesters.js");
const { registerResultKind, claimResult, releaseResult, requesterOf, resultNoticeFor, restoreResultRequesters, _resetResultRequestersForTest } = RR;

const CDB = { tag: "cdb" };
const ctxFor = (id, over = {}) => ({ card: { id, title: "t" }, outcome: "success", summaryMd: "done", resultId: 1, actor: { kind: "bot", id: "writer" }, ...over });
const stub = (over = {}) => ({ notice: async () => ({ title: "stub" }), restore: async () => [], owns: async () => false, ...over });

beforeEach(() => _resetResultRequestersForTest());

test("registerResultKind validates the kind and the shape, and a re-registration replaces", async () => {
  assert.throws(() => registerResultKind("Voice", stub()), /kind/);
  assert.throws(() => registerResultKind("a".repeat(33), stub()), /kind/);
  assert.throws(() => registerResultKind("voice", { notice: async () => null }), /restore|owns/);
  registerResultKind("voice", stub({ notice: async () => ({ title: "first" }) }));
  registerResultKind("voice", stub({ notice: async () => ({ title: "second" }) }));
  claimResult(1, "voice");
  assert.deepEqual(await resultNoticeFor(CDB, ctxFor(1)), { title: "second" });
});

test("resultNoticeFor: the claimed kind's notice, with the context passed through", async () => {
  const seen = [];
  registerResultKind("voice", stub({ notice: async (cdb, ctx) => { seen.push([cdb, ctx]); return { title: "voice", action_url: "/x" }; } }));
  claimResult(7, "voice");
  const ctx = ctxFor(7);
  assert.deepEqual(await resultNoticeFor(CDB, ctx), { title: "voice", action_url: "/x" });
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], CDB);
  assert.equal(seen[0][1], ctx);
});

test("resultNoticeFor: an unclaimed card goes to the first kind that owns it, which then holds the claim [rv1 C7]", async () => {
  const asked = [];
  registerResultKind("delegate", stub({ owns: async (_cdb, id) => { asked.push(["delegate", id]); return false; } }));
  registerResultKind("voice", stub({ owns: async (_cdb, id) => { asked.push(["voice", id]); return id === 7; }, notice: async () => ({ title: "voice" }) }));
  assert.equal(requesterOf(7), null);
  assert.deepEqual(await resultNoticeFor(CDB, ctxFor(7)), { title: "voice" });
  assert.deepEqual(asked, [["delegate", 7], ["voice", 7]]);
  assert.equal(requesterOf(7), "voice", "the owning kind now holds the claim");
  // A card nobody owns: null, and no claim.
  assert.equal(await resultNoticeFor(CDB, ctxFor(8)), null);
  assert.equal(requesterOf(8), null);
});

test("resultNoticeFor: a claim is consulted before any owns, and a card id string is a card id", async () => {
  let owned = 0;
  registerResultKind("voice", stub({ owns: async () => { owned++; return true; }, notice: async () => ({ title: "voice" }) }));
  registerResultKind("delegate", stub({ notice: async () => ({ title: "delegate" }) }));
  claimResult("9", "delegate");
  assert.deepEqual(await resultNoticeFor(CDB, ctxFor(9)), { title: "delegate" });
  assert.equal(owned, 0);
});

test("resultNoticeFor: a kind that throws, or answers with a non-object, gives null and is logged", async () => {
  const logs = [];
  registerResultKind("voice", stub({ notice: async () => { throw new Error("boom"); } }));
  registerResultKind("delegate", stub({ notice: async () => "not an object" }));
  registerResultKind("other", stub({ notice: async () => null }));
  claimResult(1, "voice");
  claimResult(2, "delegate");
  claimResult(3, "other");
  assert.equal(await resultNoticeFor(CDB, ctxFor(1), { log: (m) => logs.push(m) }), null);
  assert.equal(await resultNoticeFor(CDB, ctxFor(2), { log: (m) => logs.push(m) }), null);
  assert.equal(await resultNoticeFor(CDB, ctxFor(3), { log: (m) => logs.push(m) }), null);
  assert.equal(logs.length, 2, "a throw and a non-object are logged; a null is a plain no");
  assert.match(logs[0], /voice.*boom/);
  assert.match(logs[1], /delegate/);
  assert.equal(requesterOf(1), "voice", "a failing notice never drops the claim: the kind decides that");
});

test("resultNoticeFor: an owns that throws is skipped (logged), and the next kind is still asked", async () => {
  const logs = [];
  registerResultKind("delegate", stub({ owns: async () => { throw new Error("no table"); } }));
  registerResultKind("voice", stub({ owns: async () => true, notice: async () => ({ title: "voice" }) }));
  assert.deepEqual(await resultNoticeFor(CDB, ctxFor(5), { log: (m) => logs.push(m) }), { title: "voice" });
  assert.equal(logs.length, 1);
  assert.match(logs[0], /delegate.*no table/);
});

test("resultNoticeFor: a claim for a kind that is not registered, or a context without a card id, is null", async () => {
  const logs = [];
  claimResult(4, "ghost");
  assert.equal(await resultNoticeFor(CDB, ctxFor(4), { log: (m) => logs.push(m) }), null);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /ghost/);
  registerResultKind("voice", stub({ owns: async () => true, notice: async () => ({ title: "voice" }) }));
  assert.equal(await resultNoticeFor(CDB, { card: null }), null);
  assert.equal(await resultNoticeFor(CDB, { card: { id: "abc" } }), null);
  assert.equal(await resultNoticeFor(CDB, null), null);
});

test("restoreResultRequesters warms the claims from every kind, keeps an earlier claim, skips bad ids, and survives a throw", async () => {
  const logs = [];
  registerResultKind("voice", stub({ restore: async () => [1, "2", 0, -1, "x", null] }));
  registerResultKind("delegate", stub({ restore: async () => [2, 3] }));
  registerResultKind("broken", stub({ restore: async () => { throw new Error("down"); } }));
  claimResult(3, "voice");
  const n = await restoreResultRequesters(CDB, { log: (m) => logs.push(m) });
  assert.equal(n, 2, "1 and 2 for voice; 3 was already claimed; 2 is not re-claimed for delegate");
  assert.equal(requesterOf(1), "voice");
  assert.equal(requesterOf(2), "voice");
  assert.equal(requesterOf(3), "voice");
  assert.equal(logs.length, 1);
  assert.match(logs[0], /broken.*down/);
});

test("claim, release, requesterOf, and the reset clears claims and kinds alike", async () => {
  registerResultKind("voice", stub({ notice: async () => ({ title: "voice" }) }));
  claimResult(1, "voice");
  assert.equal(requesterOf(1), "voice");
  releaseResult(1);
  assert.equal(requesterOf(1), null);
  assert.throws(() => claimResult(0, "voice"), /card id/);
  assert.throws(() => claimResult(1, "Bad Kind"), /kind/);
  claimResult(1, "voice");
  _resetResultRequestersForTest();
  assert.equal(requesterOf(1), null);
  claimResult(1, "voice");
  assert.equal(await resultNoticeFor(CDB, ctxFor(1)), null, "the kinds are gone too");
});

test("two module instances share one registry (P30)", async () => {
  const other = await import("../servers/gateway/board/result-requesters.js?instance=2");
  other.registerResultKind("voice", stub({ notice: async () => ({ title: "from the other instance" }) }));
  claimResult(11, "voice");
  assert.equal(other.requesterOf(11), "voice");
  assert.deepEqual(await resultNoticeFor(CDB, ctxFor(11)), { title: "from the other instance" });
  other.releaseResult(11);
  assert.equal(requesterOf(11), null);
});
