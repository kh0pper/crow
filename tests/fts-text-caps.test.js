/**
 * Tests for W4-4 commit 4: FTS5 text caps in clone-bundle + boot.js peer source.
 *
 * Uses a real init-db.js DB (captures FTS5 triggers) to verify that:
 *   1. full_text > CROW_CLONE_FULLTEXT_MAX is truncated with the fixed marker.
 *   2. abstract > 50_000 is truncated with the fixed marker.
 *   3. content_summary > 50_000 is truncated with the fixed marker.
 *   4. Fields at exactly the cap limit are NOT truncated (off-by-one).
 *   5. Fields under the cap are stored verbatim.
 *   6. The truncated stored length = cap + marker length.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "../node_modules/better-sqlite3/lib/index.js";
import { createCloneBundleHelpers } from "../servers/sharing/clone-bundle.js";

const dir = mkdtempSync(join(tmpdir(), "fts-caps-"));
execFileSync(process.execPath, ["scripts/init-db.js"], {
  env: { ...process.env, CROW_DATA_DIR: dir },
  stdio: "pipe",
});

const rawDb = new Database(join(dir, "crow.db"));
after(() => {
  rawDb.close();
  rmSync(dir, { recursive: true, force: true });
});

function wrapDb(bsDb) {
  function executeOne(sql, args = []) {
    const stmt = bsDb.prepare(sql);
    const a = Array.isArray(args) ? args : [args];
    if (stmt.reader) {
      const rows = stmt.all(...a);
      return { rows, columns: rows.length > 0 ? Object.keys(rows[0]) : [], rowsAffected: 0, lastInsertRowid: 0 };
    }
    const info = stmt.run(...a);
    return { rows: [], columns: [], rowsAffected: info.changes, lastInsertRowid: info.lastInsertRowid };
  }
  return {
    async execute(arg) {
      if (typeof arg === "string") return executeOne(arg, []);
      return executeOne(arg.sql, arg.args);
    },
    async batch(stmts) {
      const txn = bsDb.transaction((ss) => ss.map((s) => {
        if (typeof s === "string") return executeOne(s, []);
        return executeOne(s.sql, s.args);
      }));
      return txn(stmts);
    },
    async executeMultiple(sql) { bsDb.exec(sql); return []; },
    close() { try { bsDb.close(); } catch {} },
  };
}

const db = wrapDb(rawDb);
const { applyProjectCloneBundle } = createCloneBundleHelpers({ db });

// Default caps from env (match clone-bundle.js defaults).
const FULLTEXT_MAX = parseInt(process.env.CROW_CLONE_FULLTEXT_MAX || "200000", 10);
const SUMMARY_MAX = 50000;
const TRUNC_MARKER_PREFIX = "\n[truncated at clone import: original ";

// Minimal valid bundle factory.
function makeBundle(sourceOverrides = {}) {
  return {
    bundle_version: 1,
    project: { name: "FTS Caps Test Project", slug: "fts-caps-test", description: null, type: "general", tags: null },
    sources: [{ id: 1, title: "Test Source", source_type: "other", url: null, ...sourceOverrides }],
    notes: [],
    audit_log: [],
    backends: [],
    file_manifest: [],
    origin_instance_id: "test-origin",
    snapshot_at: new Date().toISOString(),
  };
}

async function getLastSource() {
  const { rows } = await db.execute("SELECT full_text, abstract, content_summary FROM research_sources ORDER BY id DESC LIMIT 1");
  return rows[0];
}

test("fts-caps: full_text over cap is truncated with marker", async () => {
  const oversized = "A".repeat(FULLTEXT_MAX + 500);
  await applyProjectCloneBundle(makeBundle({ full_text: oversized }), null);
  const row = await getLastSource();
  assert.ok(row, "source row must exist");
  assert.ok(row.full_text.startsWith("A".repeat(FULLTEXT_MAX)), "stored text starts with capped prefix");
  assert.ok(row.full_text.includes(TRUNC_MARKER_PREFIX), "stored text contains truncation marker");
  // Final stored length = cap + marker (marker includes original length number + suffix)
  assert.ok(row.full_text.length > FULLTEXT_MAX, "stored text is longer than cap (marker appended)");
  assert.ok(row.full_text.length < oversized.length, "stored text is shorter than oversized original");
  assert.equal(row.full_text.slice(0, FULLTEXT_MAX), "A".repeat(FULLTEXT_MAX), "first FULLTEXT_MAX chars are the original content");
});

test("fts-caps: abstract over 50000 is truncated with marker", async () => {
  const oversized = "B".repeat(SUMMARY_MAX + 100);
  await applyProjectCloneBundle(makeBundle({ abstract: oversized }), null);
  const row = await getLastSource();
  assert.ok(row.abstract.includes(TRUNC_MARKER_PREFIX), "abstract contains truncation marker");
  assert.equal(row.abstract.slice(0, SUMMARY_MAX), "B".repeat(SUMMARY_MAX), "first SUMMARY_MAX chars preserved");
});

test("fts-caps: content_summary over 50000 is truncated with marker", async () => {
  const oversized = "C".repeat(SUMMARY_MAX + 200);
  await applyProjectCloneBundle(makeBundle({ content_summary: oversized }), null);
  const row = await getLastSource();
  assert.ok(row.content_summary.includes(TRUNC_MARKER_PREFIX), "content_summary contains truncation marker");
  assert.equal(row.content_summary.slice(0, SUMMARY_MAX), "C".repeat(SUMMARY_MAX), "first SUMMARY_MAX chars preserved");
});

test("fts-caps: exact-cap full_text is NOT truncated (off-by-one check)", async () => {
  const exactCap = "D".repeat(FULLTEXT_MAX);
  await applyProjectCloneBundle(makeBundle({ full_text: exactCap }), null);
  const row = await getLastSource();
  assert.equal(row.full_text, exactCap, "exact-cap full_text must be stored verbatim (no truncation)");
  assert.ok(!row.full_text.includes(TRUNC_MARKER_PREFIX), "no marker for exact-cap text");
});

test("fts-caps: under-cap fields stored verbatim", async () => {
  const shortText = "Short text under cap";
  const shortAbstract = "Short abstract";
  const shortSummary = "Short summary";
  await applyProjectCloneBundle(makeBundle({
    full_text: shortText,
    abstract: shortAbstract,
    content_summary: shortSummary,
  }), null);
  const row = await getLastSource();
  assert.equal(row.full_text, shortText, "short full_text stored verbatim");
  assert.equal(row.abstract, shortAbstract, "short abstract stored verbatim");
  assert.equal(row.content_summary, shortSummary, "short content_summary stored verbatim");
});

test("fts-caps: null fields remain null (no marker injection)", async () => {
  await applyProjectCloneBundle(makeBundle({ full_text: null, abstract: null, content_summary: null }), null);
  const row = await getLastSource();
  assert.equal(row.full_text, null, "null full_text stays null");
  assert.equal(row.abstract, null, "null abstract stays null");
  assert.equal(row.content_summary, null, "null content_summary stays null");
});
