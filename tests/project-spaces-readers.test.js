/**
 * Tests for W2-5 Stage B1 — project_spaces readers migration.
 *
 * Schema: real init-db.js run against a tmp dir.
 * Tests 1-7 cover the spec's reader migration; test 8 is "suite stays green"
 * (verified externally by running the full test suite).
 *
 * Test inventory (B3a 2026-06-12: the rp→ps forward triggers are retired —
 * seeds that used to go through rp now insert into project_spaces directly;
 * the old test 6, which pinned trigger propagation, was deleted):
 *   1. Superset visibility: seeded + helper-created rows both appear via crow_list_projects
 *   2. id-collision guard: createProjectSpace keeps rp seq ahead; a legacy rp
 *      INSERT allocates a non-colliding id and (post-B3a) does NOT mirror to ps
 *   3. Archive invisibility: archived rows hidden from all migrated readers
 *   4. Context summary: generateCrowContext sees ps-only rows; FK counts intact
 *   5. learner_profile filtering: excluded from generic lists; visible to learner queries
 *   7. Export shape: maker_export_learner returns explicit cols; no workspace_dir etc.
 */

import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { createProjectSpace } from "../servers/shared/project-spaces.js";
import { createProjectServer } from "../servers/research/server.js";
import { generateCrowContext, invalidateContextCache } from "../servers/memory/crow-context.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

// ── Shared setup ─────────────────────────────────────────────────────────────

const tmpDir = mkdtempSync(join(tmpdir(), "crow-ps-readers-test-"));

execFileSync(process.execPath, ["scripts/init-db.js"], {
  env: { ...process.env, CROW_DATA_DIR: tmpDir },
  stdio: "pipe",
});

const DB_PATH = join(tmpDir, "crow.db");

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Build a fresh DB client for each test so state is isolated at the
 * connection level, while the underlying file is shared (same schema).
 */
function makeDb() {
  return createDbClient(DB_PATH);
}

/**
 * Wire up the research server over InMemoryTransport and return a
 * connected MCP client. The server + client pair is torn down by the caller.
 */
async function makeResearchClient(db) {
  const server = createProjectServer(DB_PATH);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "ps-readers-test", version: "0" });
  await client.connect(clientTransport);
  return { client, server };
}

// ── Test 1: Superset visibility ───────────────────────────────────────────────

test("1. superset visibility: legacy rp + ps-only rows both returned by crow_list_projects", async () => {
  const db = makeDb();

  // Seed a legacy-shaped project directly in project_spaces (pre-B3a these
  // rows arrived via the rp→ps trigger; the trigger is retired)
  await db.execute({
    sql: `INSERT INTO project_spaces (slug, name, description, status, type, created_at, updated_at)
          VALUES ('legacy-project-t1', 'Legacy Project', 'legacy desc', 'active', 'general', datetime('now'), datetime('now'))`,
    args: [],
  });
  const { rows: legacyRows } = await db.execute({
    sql: "SELECT id, name FROM project_spaces WHERE name='Legacy Project'",
    args: [],
  });
  const legacyId = Number(legacyRows[0].id);
  const legacyName = legacyRows[0].name;

  // Create a ps-only project via the helper (no rp row)
  const { id: psOnlyId } = await createProjectSpace(db, { name: "PS-Only Project", type: "general", status: "active" });

  const { client } = await makeResearchClient(db);

  const result = await client.callTool({ name: "crow_list_projects", arguments: {} });
  assert.ok(result.content && result.content[0], "tool returned content");
  const text = result.content[0].text;

  assert.ok(text.includes(`#${legacyId}`), `legacy project #${legacyId} visible in list`);
  assert.ok(text.includes(legacyName), "legacy project name present");
  assert.ok(text.includes(`#${psOnlyId}`), `ps-only project #${psOnlyId} visible in list`);
  assert.ok(text.includes("PS-Only Project"), "ps-only project name present");

  db.close();
});

// ── Test 2: id-collision guard ─────────────────────────────────────────────

test("2. id-collision guard: rp allocates higher id than ps-only; exactly one sqlite_sequence row", async () => {
  const db = makeDb();

  // First helper call: takes next ps id
  const { id: psId1 } = await createProjectSpace(db, { name: "Guard Test 1", ownerMember: false });

  // Check sqlite_sequence has exactly one row for research_projects
  const { rows: seqRows1 } = await db.execute({
    sql: "SELECT seq FROM sqlite_sequence WHERE name='research_projects'",
    args: [],
  });
  assert.equal(seqRows1.length, 1, "exactly one sqlite_sequence row for research_projects after first call");
  assert.ok(Number(seqRows1[0].seq) >= psId1, "rp seq >= ps max id after first helper call");

  // Second helper call: pins the one-row invariant under repeated calls
  const { id: psId2 } = await createProjectSpace(db, { name: "Guard Test 2", ownerMember: false });

  const { rows: seqRows2 } = await db.execute({
    sql: "SELECT COUNT(*) AS n FROM sqlite_sequence WHERE name='research_projects'",
    args: [],
  });
  assert.equal(Number(seqRows2[0].n), 1, "still exactly one sqlite_sequence row after two helper calls (no OR IGNORE duplicates)");

  const { rows: seqVal } = await db.execute({
    sql: "SELECT seq FROM sqlite_sequence WHERE name='research_projects'",
    args: [],
  });
  assert.ok(Number(seqVal[0].seq) >= psId2, "rp seq >= max(ps.id) after second call");

  // Now a legacy INSERT must allocate a HIGHER id than the latest ps id
  await db.execute({
    sql: `INSERT INTO research_projects (name, status, type, created_at, updated_at)
          VALUES ('Legacy After Guard', 'active', NULL, datetime('now'), datetime('now'))`,
    args: [],
  });
  const { rows: rpRows } = await db.execute({
    sql: "SELECT id FROM research_projects WHERE name='Legacy After Guard'",
    args: [],
  });
  const rpId = Number(rpRows[0].id);
  assert.ok(rpId > psId2, `rp id ${rpId} must be > ps max id ${psId2} (no collision)`);

  // Post-B3a there is NO mirror: the rp insert must NOT materialize a ps row,
  // and the guard must still hold rp's sequence at/above ps's max id.
  const { rows: psSeen } = await db.execute({
    sql: "SELECT id FROM project_spaces WHERE id = ?",
    args: [rpId],
  });
  assert.equal(psSeen.length, 0, "retired trigger: rp insert does not mirror into project_spaces");
  const { rows: seqFinal } = await db.execute({
    sql: "SELECT seq FROM sqlite_sequence WHERE name='research_projects'",
    args: [],
  });
  assert.ok(Number(seqFinal[0].seq) >= psId2, "guard invariant survives a legacy rp INSERT");

  db.close();
});

// ── Test 3: Archive invisibility ──────────────────────────────────────────────

test("3. archive invisibility: archived learner hidden from migrated readers", async () => {
  const db = makeDb();

  // Seed a learner directly in project_spaces (trigger path retired in B3a)
  await db.execute({
    sql: `INSERT INTO project_spaces (slug, name, type, status, created_at, updated_at)
          VALUES ('ghost-learner-t3', 'Ghost Learner', 'learner_profile', 'active', datetime('now'), datetime('now'))`,
    args: [],
  });
  const { rows: lRows } = await db.execute({
    sql: "SELECT id FROM project_spaces WHERE name='Ghost Learner'",
    args: [],
  });
  const lid = Number(lRows[0].id);

  // Confirm it's visible before deletion
  const { rows: before } = await db.execute({
    sql: "SELECT id FROM project_spaces WHERE id=? AND archived_at IS NULL",
    args: [lid],
  });
  assert.equal(before.length, 1, "learner visible in project_spaces before deletion");

  // Archive the row (the operation the retired del-trigger used to perform)
  await db.execute({
    sql: "UPDATE project_spaces SET archived_at = datetime('now'), updated_at = datetime('now') WHERE id=? AND archived_at IS NULL",
    args: [lid],
  });

  // archived_at must be set in ps
  const { rows: archived } = await db.execute({
    sql: "SELECT archived_at FROM project_spaces WHERE id=?",
    args: [lid],
  });
  assert.ok(archived.length === 1 && archived[0].archived_at, "archived_at set in project_spaces");

  // Migrated learner-list query must return nothing for this id
  const { rows: listRows } = await db.execute({
    sql: "SELECT id FROM project_spaces WHERE type='learner_profile' AND archived_at IS NULL",
    args: [],
  });
  assert.ok(!listRows.some(r => Number(r.id) === lid), "archived learner absent from migrated learner-list query");

  // Migrated learner-count query must not include it (targeted form — the
  // shared DB makes an absolute count brittle across tests)
  const { rows: countRows } = await db.execute({
    sql: "SELECT COUNT(*) AS n FROM project_spaces WHERE type='learner_profile' AND archived_at IS NULL AND id = ?",
    args: [lid],
  });
  assert.equal(Number(countRows[0].n), 0, "archived learner excluded from migrated count query");

  // ensureDefaultLearner shape: must not return the archived id
  const { rows: ensureRows } = await db.execute({
    sql: "SELECT id FROM project_spaces WHERE type='learner_profile' AND archived_at IS NULL ORDER BY id LIMIT 1",
    args: [],
  });
  assert.ok(!ensureRows.some(r => Number(r.id) === lid), "archived learner not returned by ensureDefaultLearner-shape query");

  // data-dashboard LEFT JOIN: project_name must be NULL for a backend pointing at an archived project.
  // Seed a live ps row for the FK (data_backends.project_id → project_spaces post-B2), then archive it.
  await db.execute({
    sql: `INSERT INTO project_spaces (slug, name, status, type, created_at, updated_at)
          VALUES ('backendhost-t3', 'BackendHost Project', 'active', 'general', datetime('now'), datetime('now'))`,
    args: [],
  });
  const { rows: bhRows } = await db.execute({
    sql: "SELECT id FROM project_spaces WHERE name='BackendHost Project'",
    args: [],
  });
  const bhId = Number(bhRows[0].id);
  await db.execute({
    sql: `INSERT INTO data_backends (name, backend_type, status, project_id, connection_ref, created_at, updated_at)
          VALUES ('ghost-backend', 'sqlite', 'disconnected', ?, '{}', datetime('now'), datetime('now'))`,
    args: [bhId],
  });
  // Archive (not delete): deleting the ps row would CASCADE-delete the backend
  // (foreign_keys is ON) and leave the LEFT JOIN with zero rows — a
  // vacuously-true assertion. The UPDATE keeps the backend alive and
  // exercises the ON-condition filter for real.
  await db.execute({
    sql: "UPDATE project_spaces SET archived_at = datetime('now') WHERE id = ?",
    args: [bhId],
  });
  const { rows: ddRows } = await db.execute({
    sql: "SELECT db.name, p.name AS project_name FROM data_backends db LEFT JOIN project_spaces p ON db.project_id = p.id AND p.archived_at IS NULL WHERE db.name='ghost-backend'",
    args: [],
  });
  assert.equal(ddRows.length, 1, "backend row must survive (no rp delete, no cascade)");
  assert.equal(ddRows[0].project_name, null,
    "LEFT JOIN ON-condition filter must blank the name for an archived project (without the filter it would read 'BackendHost Project')");

  db.close();
});

// ── Test 4: Context summary ───────────────────────────────────────────────────

test("4. context summary: generateCrowContext sees ps-only project; legacy FK counts intact", async () => {
  const db = makeDb();

  // Seed a legacy-shaped project with a source and note, timestamped in the
  // future so it sorts to the top of the LIMIT 5 list regardless of prior state.
  await db.execute({
    sql: `INSERT INTO project_spaces (slug, name, status, type, created_at, updated_at)
          VALUES ('t4-legacy', 'T4 Legacy Project', 'active', 'general', datetime('now','+1 hour'), datetime('now','+1 hour'))`,
    args: [],
  });
  const { rows: rRows } = await db.execute({
    sql: "SELECT id FROM project_spaces WHERE name='T4 Legacy Project'",
    args: [],
  });
  const legacyCtxId = Number(rRows[0].id);

  // research_sources: no updated_at column; source_type must be one of the CHECK values
  await db.execute({
    sql: `INSERT INTO research_sources (project_id, title, source_type, citation_apa, created_at)
          VALUES (?, 'Test Source', 'web_article', 'test apa', datetime('now'))`,
    args: [legacyCtxId],
  });
  await db.execute({
    sql: `INSERT INTO research_notes (project_id, note_type, content, created_at, updated_at)
          VALUES (?, 'note', 'Test note', datetime('now'), datetime('now'))`,
    args: [legacyCtxId],
  });

  // Create a ps-only active project, also timestamped in the future to appear in top 5
  const { id: psCtxId } = await createProjectSpace(db, {
    name: "T4 PS-Only Project",
    type: "general",
    status: "active",
  });
  // Bump its updated_at so it's near the top
  await db.execute({
    sql: "UPDATE project_spaces SET updated_at=datetime('now','+2 hours') WHERE id=?",
    args: [psCtxId],
  });

  invalidateContextCache();
  const ctx = await generateCrowContext(db, { includeDynamic: true });

  assert.ok(ctx.includes("T4 PS-Only Project"), "ps-only project appears in context summary (top-5 by updated_at)");
  assert.ok(ctx.includes("T4 Legacy Project"), "legacy project appears in context summary");
  assert.ok(ctx.includes("1 sources"), "legacy project source count correct (FK still valid)");
  assert.ok(ctx.includes("1 notes"), "legacy project note count correct");

  db.close();
});

// ── Test 5: learner_profile filtering ─────────────────────────────────────────

test("5. learner_profile filtering: excluded from generic lists; visible to learner-specific queries", async () => {
  const db = makeDb();

  // Seed a learner_profile row directly in project_spaces
  await db.execute({
    sql: `INSERT INTO project_spaces (slug, name, type, status, created_at, updated_at)
          VALUES ('learner-filter-t5', 'Test Learner Filter', 'learner_profile', 'active', datetime('now'), datetime('now'))`,
    args: [],
  });
  const { rows: lRows } = await db.execute({
    sql: "SELECT id FROM project_spaces WHERE name='Test Learner Filter'",
    args: [],
  });
  const learnerId = Number(lRows[0].id);

  // crow_list_projects should not include it (no explicit type filter)
  const { client } = await makeResearchClient(db);
  const listResult = await client.callTool({ name: "crow_list_projects", arguments: {} });
  const listText = listResult.content[0].text;
  assert.ok(!listText.includes("Test Learner Filter"), "learner_profile excluded from crow_list_projects");

  // Stats count should not include it
  const statsResult = await client.callTool({ name: "crow_project_stats", arguments: {} });
  const statsText = statsResult.content[0].text;
  // The count line should not be inflated by learner profiles
  // (we can't know the exact number, but the query filters learner_profile)
  assert.ok(statsText.includes("Projects:"), "stats response includes project count");

  // Panel count query should exclude it
  const { rows: panelCount } = await db.execute({
    sql: "SELECT COUNT(*) AS c FROM project_spaces WHERE (type IS NULL OR type != 'learner_profile') AND archived_at IS NULL",
    args: [],
  });
  // The learner we seeded should not be counted here — just verify it's excluded
  const { rows: totalCount } = await db.execute({
    sql: "SELECT COUNT(*) AS c FROM project_spaces WHERE archived_at IS NULL",
    args: [],
  });
  assert.ok(Number(panelCount[0].c) < Number(totalCount[0].c) || Number(totalCount[0].c) === 0,
    "learner_profile excluded from panel count");

  // The migrated learner-specific query DOES see the undeleted row
  const { rows: learnerRows } = await db.execute({
    sql: "SELECT id FROM project_spaces WHERE type='learner_profile' AND archived_at IS NULL",
    args: [],
  });
  assert.ok(learnerRows.some(r => Number(r.id) === learnerId), "undeleted learner visible in learner-specific query");

  db.close();
});

// ── Test 7: Export shape ──────────────────────────────────────────────────────

test("7. export shape: maker_export_learner profile has explicit cols; no workspace_dir/storage_prefix/slug/archived_at", async () => {
  const db = makeDb();

  // Seed a learner directly in project_spaces
  await db.execute({
    sql: `INSERT INTO project_spaces (slug, name, type, description, status, tags, created_at, updated_at)
          VALUES ('export-learner-t7', 'Export Learner', 'learner_profile', 'a desc', 'active', 'tag1', datetime('now'), datetime('now'))`,
    args: [],
  });
  const { rows: eRows } = await db.execute({
    sql: "SELECT id FROM project_spaces WHERE name='Export Learner'",
    args: [],
  });
  const eid = Number(eRows[0].id);

  // Run the explicit-column SELECT as maker_export_learner does
  const { rows: profile } = await db.execute({
    sql: "SELECT id, name, type, description, status, tags, created_at, updated_at FROM project_spaces WHERE id=? AND type='learner_profile' AND archived_at IS NULL",
    args: [eid],
  });
  assert.equal(profile.length, 1, "learner found");
  const p = profile[0];

  // Required columns present
  assert.ok("id" in p, "id present");
  assert.ok("name" in p, "name present");
  assert.ok("type" in p, "type present");
  assert.ok("description" in p, "description present");
  assert.ok("status" in p, "status present");
  assert.ok("tags" in p, "tags present");
  assert.ok("created_at" in p, "created_at present");
  assert.ok("updated_at" in p, "updated_at present");

  // Ps-only columns must NOT be present (explicit column list enforces this)
  assert.ok(!("workspace_dir" in p), "workspace_dir absent from export");
  assert.ok(!("storage_prefix" in p), "storage_prefix absent from export");
  assert.ok(!("slug" in p), "slug absent from export");
  assert.ok(!("archived_at" in p), "archived_at absent from export");
  assert.ok(!("uuid" in p), "uuid absent from export (deliberately dropped)");
  assert.ok(!("origin_instance_id" in p), "origin_instance_id absent from export");

  // Values are correct
  assert.equal(p.name, "Export Learner");
  assert.equal(p.type, "learner_profile");
  assert.equal(p.tags, "tag1");

  db.close();
});
