/**
 * G-F3-1 (2c follow-up F3) — the dashboard Restore button must be disabled
 * upfront for natural-key tables (contacts, contact_groups, crow_context):
 * the backend refuses these via NATURAL_KEY_RESTORE_REFUSALS, so rendering a
 * live button gives the user a click → refused flash instead of an honest
 * disabled state. A memories (numeric-id) row must still render the button.
 *
 * Tested through the section's render() with a real init-db database
 * (same harness pattern as tests/settings-sync-conflicts-limit.test.js).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import section from "../servers/gateway/dashboard/settings/sections/sync-conflicts.js";

const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "sync-conflicts-restore-ui-"));
  dirs.push(dir);
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir },
    stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
  return createClient({ url: "file:" + join(dir, "crow.db") });
}

async function seedConflict(db, { table, rowId, op }) {
  await db.execute({
    sql: `INSERT INTO sync_conflicts
            (table_name, row_id, winning_instance_id, losing_instance_id,
             winning_lamport_ts, losing_lamport_ts, winning_data, losing_data, resolved, op)
          VALUES (?, ?, 'inst-a', 'inst-b', 2, 1, '{}', '{}', 0, ?)`,
    args: [table, rowId, op],
  });
}

function fakeReq() {
  return { csrfToken: "test-csrf", query: {} };
}

/** Extract the rendered <tr> chunk containing the given (unique) row id. */
function rowChunk(html, rowId) {
  const chunks = html.split(/<tr[\s>]/);
  const hits = chunks.filter((c) => c.includes(rowId));
  assert.equal(hits.length, 1, `exactly one rendered row for ${rowId}`);
  return hits[0];
}

const RESTORE_ACTION = 'value="sync_conflicts_restore_other"';

test("G-F3-1: natural-key tables render no Restore form; memories still does", async () => {
  const db = fresh();
  try {
    // Natural-key tables, both ops the backend would refuse.
    await seedConflict(db, { table: "contacts", rowId: '{"crow_id":"c1"}-u', op: "update" });
    await seedConflict(db, { table: "contacts", rowId: '{"crow_id":"c2"}-d', op: "delete" });
    await seedConflict(db, { table: "contact_groups", rowId: '{"group_uid":"g1"}-u', op: "update" });
    await seedConflict(db, { table: "contact_groups", rowId: '{"group_uid":"g2"}-d', op: "delete" });
    await seedConflict(db, { table: "crow_context", rowId: '{"section_key":"s1"}-u', op: "update" });
    // Numeric-id table: Restore must stay available.
    await seedConflict(db, { table: "memories", rowId: "101-u", op: "update" });
    await seedConflict(db, { table: "memories", rowId: "102-d", op: "delete" });
    // op='insert' precedence stays first even on a natural-key table.
    await seedConflict(db, { table: "contacts", rowId: '{"crow_id":"c3"}-i', op: "insert" });

    const html = await section.render({ req: fakeReq(), db, lang: "en" });

    // contacts / contact_groups: NO restore form (RED today — button renders live).
    for (const rowId of [
      '{&quot;crow_id&quot;:&quot;c1&quot;}-u',
      '{&quot;crow_id&quot;:&quot;c2&quot;}-d',
      '{&quot;group_uid&quot;:&quot;g1&quot;}-u',
      '{&quot;group_uid&quot;:&quot;g2&quot;}-d',
    ]) {
      const chunk = rowChunk(html, rowId);
      assert.ok(
        !chunk.includes(RESTORE_ACTION),
        `natural-key row ${rowId} must not render a restore_other form`,
      );
    }

    // crow_context: no restore form, keeps its composite-key wording.
    const ctxChunk = rowChunk(html, "{&quot;section_key&quot;:&quot;s1&quot;}-u");
    assert.ok(!ctxChunk.includes(RESTORE_ACTION), "crow_context row must not render a restore form");
    assert.match(ctxChunk, /composite key/, "crow_context keeps its composite-key disabled label");

    // memories: restore form present for update AND delete ops.
    assert.ok(rowChunk(html, "101-u").includes(RESTORE_ACTION), "memories update row keeps the Restore button");
    assert.ok(rowChunk(html, "102-d").includes(RESTORE_ACTION), "memories delete row keeps the Restore button");

    // op='insert' precedence unchanged: insert wording, not the natural-key label.
    const insChunk = rowChunk(html, "{&quot;crow_id&quot;:&quot;c3&quot;}-i");
    assert.ok(!insChunk.includes(RESTORE_ACTION), "insert row has no restore form");
    assert.match(insChunk, /id collision/, "insert row keeps the insert-specific disabled wording");
  } finally {
    await db.close();
  }
});

test("NATURAL_KEY_RESTORE_TABLES export is the single source of truth (set ⟺ refusal)", async () => {
  const mod = await import("../servers/sharing/sync-conflict-resolve.js");
  const set = mod.NATURAL_KEY_RESTORE_TABLES;
  assert.ok(set instanceof Set, "NATURAL_KEY_RESTORE_TABLES must be an exported Set");
  assert.deepEqual(
    [...set].sort(),
    ["contact_groups", "contacts", "crow_context"],
    "set covers exactly the three natural-key tables",
  );

  // Every member of the set must actually be refused by restoreConflict
  // (invariant: set membership ⟺ a refusal message exists).
  const db = fresh();
  try {
    let id = 0;
    for (const table of set) {
      id += 1;
      await seedConflict(db, { table, rowId: `nk-${id}`, op: "update" });
      const { rows } = await db.execute({
        sql: "SELECT id FROM sync_conflicts WHERE row_id = ?",
        args: [`nk-${id}`],
      });
      const outcome = await mod.restoreConflict(db, rows[0].id, { instanceSync: null });
      assert.equal(outcome.status, "refused", `${table} restore must be refused`);
      assert.ok(outcome.message, `${table} refusal carries a per-table message`);
    }
  } finally {
    await db.close();
  }
});
