/**
 * A project-scoped crow.md section across two REAL gateways (the stdio door,
 * the outbox drain, tailnet sync on 127.0.0.1), new↔new and mixed with the
 * tree from before the fix.
 *
 * Projects: A has id 3 = uuid U. B has id 7 = uuid U, and an UNRELATED project
 * with id 3 (uuid V) that holds B's own section "k" ("B-decoy"). A raw id 3
 * from A must never touch it.
 *
 * Sections are written through each tree's own memory MCP server
 * (callMemoryTool), queued in sync_outbox and delivered by the gateway's
 * drain. Every negative is asserted after a barrier: a global section the
 * author wrote LATER, seen on the receiver (one feed, applied in order).
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { bootPair, until, useLoopbackSync, callMemoryTool, outboxAuditRows, watchOutbox } from "./fixtures/peer-pair.mjs";
import { oldTree } from "./fixtures/old-tree.mjs";

/** The tree before the fix (receiver applied the wire project_id verbatim). */
const PRE_FIX_SHA = "7ffbb3e68783be93ea3e4914bac70a6f70fe34b0";
const T = { timeout: 900_000 };
// One drain tick plus, for an old-tree child, production's dial backoff (capped at 60 s).
const FLOW_MS = 180_000;
const GATE = { CROW_CONTEXT_PROJECT_SYNC: "1" };
const U = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const V = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const tag = () => randomBytes(4).toString("hex");
// "Gate unset" must mean unset, whatever the runner's env holds (every child copies process.env).
delete process.env.CROW_CONTEXT_PROJECT_SYNC;

const section = (inst, key, projectId) =>
  inst.sql("SELECT content FROM crow_context WHERE section_key = ? AND device_id IS NULL AND project_id IS ?", [key, projectId])[0]?.content ?? null;
const keyRows = (inst, key) => inst.sql("SELECT device_id, project_id, content FROM crow_context WHERE section_key = ? ORDER BY project_id", [key]);
const syncLines = (text) => text.split("\n").filter((l) => /\[(tailnet-sync|instance-sync|sync-outbox-drain)\]/.test(l)).slice(-30).join("\n");

function seedProjects(A, B) {
  A.sql("INSERT INTO project_spaces (id, uuid, slug, name) VALUES (3, ?, 'shared', 'shared')", [U]);
  B.sql("INSERT INTO project_spaces (id, uuid, slug, name) VALUES (7, ?, 'shared', 'shared')", [U]);
  B.sql("INSERT INTO project_spaces (id, uuid, slug, name) VALUES (3, ?, 'b-unrelated', 'b-unrelated')", [V]);
}

function seedSection(inst, key, content, projectId) {
  inst.sql("INSERT INTO crow_context (section_key, section_title, content, sort_order, device_id, project_id) VALUES (?, 'K', ?, 100, NULL, ?)", [key, content, projectId]);
}

/** Add a section on `from` through its stdio door; returns once its outbox row was recorded. */
async function addSection(from, args, extraEnv) {
  const before = outboxAuditRows(from, "crow_context").length;
  const { queued } = await callMemoryTool(from, "crow_add_context_section", { section_title: "K", ...args }, {
    extraEnv, queuedWhen: () => outboxAuditRows(from, "crow_context").length > before,
  });
  return queued;
}

/** A global section written on `from` after everything else reaches `to`: the feed applied past it. */
async function barrier(from, to, extraEnv) {
  const key = `barrier_${tag()}`;
  assert.ok(await addSection(from, { section_key: key, content: "barrier" }, extraEnv), `${from.name}: the barrier was queued`);
  assert.ok(await until(() => section(to, key, null) === "barrier", FLOW_MS, 500),
    `${from.name}'s barrier never reached ${to.name}\n--- ${from.name}\n${syncLines(from.log)}\n--- ${to.name}\n${syncLines(to.log)}`);
}

async function bootSyncPair(opts, envA = {}, envB = {}) {
  const P = await bootPair({ sameIdentity: true, ...opts });
  await useLoopbackSync(P.A, P.B);
  seedProjects(P.A, P.B);
  watchOutbox(P.A);
  watchOutbox(P.B);
  await P.B.boot({ extraEnv: envB });
  await P.A.boot({ extraEnv: envA });
  return P;
}

let old;
before(async () => { old = await oldTree(PRE_FIX_SHA); }, { timeout: 600_000 });
after(() => { old?.cleanup(); });

describe("new↔new, CROW_CONTEXT_PROJECT_SYNC=1 on both", () => {
  let P;
  const K = `k_${tag()}`;
  before(async () => {
    P = await bootSyncPair({}, GATE, GATE);
    seedSection(P.B, K, "B-decoy", 3);
  }, { timeout: 600_000 });
  after(async () => { await P?.cleanup(); }, { timeout: 120_000 });

  test("context lands in the right project; the same-number unrelated project is untouched", T, async () => {
    const { A, B } = P;
    assert.ok(await addSection(A, { section_key: K, content: "A-proj", project_id: 3 }, GATE), "queued on A");
    const queuedRow = outboxAuditRows(A, "crow_context").find((r) => r.row.section_key === K);
    assert.equal(queuedRow.row.project_id, 3, "the queued row keeps A's local id (the stamp key)");
    assert.equal(queuedRow.row.project_uuid, U);
    assert.ok(await until(() => section(B, K, 7) === "A-proj", FLOW_MS, 500), `B filed it under its id for U\n${syncLines(B.log)}`);
    assert.equal(section(B, K, 3), "B-decoy", "B's unrelated project 3 is untouched");
    assert.equal(section(B, K, null), null, "nothing became B's global section");
    assert.equal(section(A, K, 3), "A-proj", "A keeps its own filing");
  });

  test("delete removes only the uuid's row on the peer", T, async () => {
    const { A, B } = P;
    const { result } = await callMemoryTool(A, "crow_delete_context_section", { section_key: K, project_id: 3 }, { extraEnv: GATE });
    assert.match(JSON.stringify(result.content), /deleted/);
    await barrier(A, B, GATE);
    assert.equal(section(B, K, 7), null, "B's row for U is gone");
    assert.equal(section(B, K, 3), "B-decoy", "B's unrelated project 3 still holds its section");
  });
});

describe("mixed: new A (gate unset), old B", () => {
  let P;
  const K = `k_${tag()}`;
  before(async () => {
    P = await bootSyncPair({ repoB: old.dir });
    seedSection(P.B, K, "B-global", null);
    seedSection(P.A, K, "A-own", 3);
  }, { timeout: 600_000 });
  after(async () => { await P?.cleanup(); }, { timeout: 120_000 });

  test("old receiver gets nothing project-scoped: its global section is never overwritten", T, async () => {
    const { A, B } = P;
    const K2 = `k2_${tag()}`;
    seedSection(B, K2, "B-global-2", null);
    // A's own project section (on its project 3): gate off, so never queued.
    const { result } = await callMemoryTool(A, "crow_add_context_section", { section_key: K2, section_title: "K", content: "A-proj", project_id: 3 });
    assert.match(JSON.stringify(result.content), /added/);
    await barrier(A, B);
    assert.equal(section(B, K2, null), "B-global-2", "B's global section is intact");
    assert.deepEqual(keyRows(B, K2).map((r) => [r.project_id, r.content]), [[null, "B-global-2"]], "B has no project row for it");
    assert.equal(outboxAuditRows(A, "crow_context").filter((r) => r.row.project_id != null || r.row.project_uuid != null).length, 0,
      "A queued nothing project-scoped");
  });

  test("an old sender's raw project_id is dropped, never filed under the same-number project", T, async () => {
    const { A, B } = P;
    // The old tree's memory server emits {project_id: 3} on the wire (B's project 3, uuid V).
    const { result } = await callMemoryTool(B, "crow_update_context_section", { section_key: K, content: "old-B" });
    assert.match(JSON.stringify(result.content), /updated/);
    const { result: r2 } = await callMemoryTool(B, "crow_add_context_section", { section_key: K, section_title: "K", content: "old-B-proj", project_id: 3 });
    assert.match(JSON.stringify(r2.content), /added/);
    assert.ok(outboxAuditRows(B, "crow_context").some((r) => r.row.section_key === K && r.row.project_id === 3), "the old sender really queued a raw id");
    await barrier(B, A);
    assert.equal(section(A, K, 3), "A-own", "A's own project 3 section is untouched");
    assert.equal(section(A, K, null), "old-B", "the global edit still crossed (positive control)");
    assert.deepEqual(keyRows(A, K).map((r) => [r.project_id, r.content]), [[null, "old-B"], [3, "A-own"]], "no new row on A");
  });
});
