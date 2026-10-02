/**
 * scripts/ops/grackle-d3-import.mjs — the D3 importer (grackle → crow main).
 * Spec: docs/superpowers/specs/2026-10-02-grackle-decommission-d3-d5-design.md
 * §4, §5.3 and §9; plan Task 1 ("Rules pinned by tests").
 *
 * Every DB here is a scratch file built from the repo's own schema
 * (tests/fixtures/grackle-d3/build.mjs). Nothing touches ~/.crow.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync, copyFileSync, writeFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { run, sha256File, idGate } from "../scripts/ops/grackle-d3-import.mjs";
import { emitOrQueue, _setEligibilityForTest } from "../servers/shared/sync-emit.js";
import { SCHEMA_GENERATION } from "../servers/shared/schema-version.js";
import { buildPair, CROW_ID } from "./fixtures/grackle-d3/build.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO, "scripts/ops/grackle-d3-import.mjs");

const OK_PROBES = { gatewayState: () => "inactive", holders: () => [] };
const emitter = { emitOrQueue };

const roots = [];
function scratch() {
  const d = mkdtempSync(join(tmpdir(), "grackle-d3-test-"));
  roots.push(d);
  return d;
}
after(() => { for (const d of roots) rmSync(d, { recursive: true, force: true }); _setEligibilityForTest(null); });
before(() => _setEligibilityForTest(() => true));

function fileState(p) {
  return { sha: createHash("sha256").update(readFileSync(p)).digest("hex"), mtime: statSync(p).mtimeMs };
}

function counts(path) {
  const db = new Database(path, { readonly: true });
  try {
    const out = {};
    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
      try { out[name] = db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n; } catch { /* virtual w/o module */ }
    }
    return out;
  } finally { db.close(); }
}

function query(path, sql, ...args) {
  const db = new Database(path, { readonly: true });
  try { return db.prepare(sql).all(...args); } finally { db.close(); }
}

/** A fixture pair + the apply options that pass every preflight. */
async function setup(buildOpts = {}) {
  const root = scratch();
  const pair = await buildPair(root, buildOpts);
  process.env.CROW_DATA_DIR = pair.crowDataDir;
  const backup = join(root, "crow-pre-d3.db");
  copyFileSync(pair.target, backup);
  const applyOpts = {
    mode: "apply",
    source: pair.source,
    target: pair.target,
    report: join(root, "report.json"),
    extract: join(root, "extract.db"),
    expectSha: sha256File(pair.source),
    backupOk: backup,
    peerMaxMemoryId: ["black-swan=1", "raven=0"],
    peerMaxId: [],
  };
  return { root, ...pair, backup, applyOpts };
}

/* ------------------------------------------------------------------ plan */

describe("plan mode", () => {
  it("writes only the report and leaves source and target byte-identical", async () => {
    const s = await setup();
    const src0 = fileState(s.source);
    const tgt0 = fileState(s.target);
    const before = readdirSync(s.root).sort();
    const res = await run({ ...s.applyOpts, mode: "plan", backupOk: undefined }, { emitter });
    assert.equal(res.exitCode, 0);
    assert.deepEqual(fileState(s.source), src0);
    assert.deepEqual(fileState(s.target), tgt0);
    const nowFiles = readdirSync(s.root).sort();
    assert.deepEqual(nowFiles.filter((f) => !before.includes(f)), ["report.json"], "plan writes nothing but the report");
    const report = JSON.parse(readFileSync(s.applyOpts.report, "utf8"));
    for (const k of ["source_sha", "target_before_counts", "target_after_counts", "per_table", "remaps", "extract_tables", "skipped", "emits", "wallet"]) {
      assert.ok(k in report, `report has ${k}`);
    }
    assert.equal(report.source_sha, s.applyOpts.expectSha);
    assert.equal(report.per_table.memories.inserted, 5);
  });
});

describe("plan/rehearse never read a held (live) target", () => {
  for (const mode of ["plan", "rehearse"]) {
    it(`${mode} refuses when another process holds the target`, async () => {
      const s = await setup();
      const tgt0 = fileState(s.target);
      const res = await run({ ...s.applyOpts, mode, backupOk: undefined }, { probes: { ...OK_PROBES, holders: () => [777] }, emitter });
      assert.equal(res.exitCode, 2);
      assert.match(res.refused[0], /API backup copy/);
      assert.ok(!existsSync(s.applyOpts.report));
      assert.deepEqual(fileState(s.target), tgt0);
    });
  }
});

/* -------------------------------------------------------------- rehearse */

describe("rehearse mode", () => {
  it("applies to a tmpdir copy only: source and target untouched, checks pass, scratch removed", async () => {
    const s = await setup({ media: false });
    const src0 = fileState(s.source);
    const tgt0 = fileState(s.target);
    const tgtCounts0 = counts(s.target);
    const tmpBefore = new Set(readdirSync(tmpdir()).filter((f) => f.startsWith("grackle-d3-rehearse-")));
    const res = await run({ ...s.applyOpts, mode: "rehearse", backupOk: undefined, importMedia: true, importDataDashboard: true }, { emitter });
    assert.equal(res.exitCode, 0);
    assert.deepEqual(fileState(s.source), src0);
    assert.deepEqual(fileState(s.target), tgt0);
    assert.deepEqual(counts(s.target), tgtCounts0);
    assert.ok(!existsSync(s.applyOpts.extract), "rehearse never writes the real --extract");
    const r = res.report.rehearse;
    assert.equal(r.integrity, "ok");
    assert.deepEqual(r.new_fk_violations, []);
    assert.deepEqual(r.count_diffs_vs_plan, []);
    for (const [name, f] of Object.entries(r.fts)) assert.ok(f.ok, `FTS ${name} consistent: ${JSON.stringify(f)}`);
    assert.equal(r.ok, true);
    const leftover = readdirSync(tmpdir()).filter((f) => f.startsWith("grackle-d3-rehearse-") && !tmpBefore.has(f));
    assert.deepEqual(leftover, [], "scratch copy removed");
  });
});

/* --------------------------------------------------------- apply refusals */

describe("apply refuses (exit 2, nothing written)", () => {
  async function expectRefusal(mutate, pattern, deps = {}) {
    const s = await setup();
    const opts = { ...s.applyOpts };
    await mutate(s, opts);
    const src0 = fileState(s.source);
    const tgt0 = fileState(s.target);
    const res = await run(opts, { probes: OK_PROBES, emitter, ...deps });
    assert.equal(res.exitCode, 2, "refused");
    assert.ok(res.refused.some((m) => pattern.test(m)), `a refusal matches ${pattern}: ${JSON.stringify(res.refused)}`);
    assert.deepEqual(fileState(s.source), src0);
    assert.deepEqual(fileState(s.target), tgt0);
    assert.ok(!existsSync(opts.report), "no report");
    assert.ok(!existsSync(s.applyOpts.extract), "no extract");
  }

  it("when crow-gateway is active", () =>
    expectRefusal(() => {}, /crow-gateway is active/, { probes: { ...OK_PROBES, gatewayState: () => "active" } }));
  it("when the gateway state cannot be determined", () =>
    expectRefusal(() => {}, /cannot determine crow-gateway state/, { probes: { ...OK_PROBES, gatewayState: () => null } }));
  it("when another process holds the target", () =>
    expectRefusal(() => {}, /held by other process.*4242/, { probes: { ...OK_PROBES, holders: () => [4242] } }));
  it("when holders cannot be verified", () =>
    expectRefusal(() => {}, /cannot verify target holders/, {
      probes: { ...OK_PROBES, holders: () => { throw new Error("lsof unavailable"); } },
    }));
  it("on a user_version mismatch between source and target", () =>
    expectRefusal((s) => {
      const db = new Database(s.target); db.pragma(`user_version = ${SCHEMA_GENERATION - 1}`); db.close();
      copyFileSync(s.target, s.backup);
    }, /user_version mismatch/));
  it("when both versions agree but differ from SCHEMA_GENERATION", () =>
    expectRefusal((s, opts) => {
      for (const p of [s.source, s.target]) { const db = new Database(p); db.pragma(`user_version = ${SCHEMA_GENERATION + 1}`); db.close(); }
      copyFileSync(s.target, s.backup);
      opts.expectSha = sha256File(s.source);
    }, /source user_version \d+ != SCHEMA_GENERATION/));
  it("on a source sha mismatch", () =>
    expectRefusal((s, opts) => { opts.expectSha = "0".repeat(64); }, /sha256 mismatch/));
  it("without --expect-sha", () =>
    expectRefusal((s, opts) => { delete opts.expectSha; }, /--expect-sha is required/));
  it("without --backup-ok", () =>
    expectRefusal((s, opts) => { delete opts.backupOk; }, /--backup-ok .* is required/));
  it("when the --backup-ok file does not exist", () =>
    expectRefusal((s, opts) => { opts.backupOk = join(s.root, "nope.db"); }, /--backup-ok file not found/));
  it("when the --backup-ok file fails integrity", () =>
    expectRefusal((s) => { writeFileSync(s.backup, "SQLite format 3\0 this is not a database at all"); }, /--backup-ok/));
  it("when the --backup-ok file is not a backup of this target", () =>
    expectRefusal((s) => {
      const db = new Database(s.backup); db.exec("INSERT INTO memories (content) VALUES ('only in the backup')"); db.close();
    }, /does not match the target/));
  it("when the target was written after the --backup-ok was taken", () =>
    expectRefusal(async (s) => {
      await new Promise((r) => setTimeout(r, 20));
      const db = new Database(s.target);
      db.exec("INSERT INTO memories (content) VALUES ('late write'); DELETE FROM memories WHERE content = 'late write';");
      db.close();
    }, /older than the target's last write/));
});

/* ------------------------------------------------------- apply: the data */

describe("apply: what lands where", () => {
  let s, report;
  before(async () => {
    s = await setup();
    const res = await run({ ...s.applyOpts, importMedia: true, importDataDashboard: true, peerMaxId: ["research_notes:black-swan=0", "glasses_note_sessions:black-swan=0"] }, { probes: OK_PROBES, emitter });
    assert.equal(res.exitCode, 0);
    report = res.report;
  });

  it("columns come from the intersection, by name (reordered chat_messages)", () => {
    const rows = query(s.target, "SELECT id, conversation_id, role, content FROM chat_messages ORDER BY id");
    assert.deepEqual(rows.map((r) => [r.role, r.content]), [["user", "hello"], ["assistant", "hi there"]]);
    assert.ok(rows.every((r) => r.conversation_id === 1));
  });

  it("source-only columns go to the report and the extract", () => {
    assert.deepEqual(report.source_only_columns.research_sources.columns.sort(), ["file_path", "s3_key"]);
    assert.equal(report.source_only_columns.research_sources.rows_with_values, 1);
    const ex = query(s.applyOpts.extract, "SELECT column_name, value FROM _source_only_columns WHERE table_name='research_sources' ORDER BY column_name");
    assert.deepEqual(ex.map((r) => [r.column_name, r.value]), [["file_path", "/home/kh0pp/pdfs/r1.pdf"], ["s3_key", "capstone/r1.pdf"]]);
  });

  it("memories: exact-content rows skipped, colliding ids fresh, free ids kept, embeddings follow, FTS consistent", () => {
    const m = report.per_table.memories;
    assert.equal(m.source_rows, 6);
    assert.equal(m.matched_existing, 1);
    assert.equal(m.inserted, 5);
    // id-keyed synced table: EVERY inserted row gets a fresh id above the
    // target, the source and every peer range (so the phase-B gate is open)
    assert.equal(m.kept_ids, 0);
    assert.equal(m.remapped_ids, 5);
    assert.ok(Object.values(report.remaps.memories).every((id) => id > 8));
    const two = report.remaps.memories["2"];
    const three = report.remaps.memories["3"];
    assert.ok(two > 8 && three > 8 && two !== three, `fresh ids above every known id: ${two}, ${three}`);
    assert.equal(query(s.target, "SELECT content FROM memories WHERE id = ?", two)[0].content, "grackle memory two");
    assert.equal(query(s.target, "SELECT content FROM memories WHERE id = 2")[0].content, "crow memory two", "crow's row untouched");
    assert.deepEqual(query(s.target, "SELECT hex(vec) AS v FROM memory_embeddings_blob WHERE memory_id = ?", two), [{ v: "02020202" }]);
    assert.deepEqual(query(s.target, "SELECT hex(vec) AS v FROM memory_embeddings_blob WHERE memory_id = ?", report.remaps.memories["7"]), [{ v: "07070707" }]);
    assert.equal(query(s.target, "SELECT COUNT(*) AS n FROM memories WHERE content = 'shared memory'")[0].n, 1);
    const n = query(s.target, "SELECT COUNT(*) AS n FROM memories")[0].n;
    assert.equal(n, 3 + 5);
    assert.equal(query(s.target, "SELECT COUNT(*) AS n FROM memories_fts_docsize")[0].n, n);
    assert.equal(query(s.target, "SELECT COUNT(*) AS n FROM memories_fts WHERE memories_fts MATCH 'seven'")[0].n, 1);
  });

  it("project_spaces: grackle 6 merges into crow 6, children follow, 1 and 5 inserted, slug clash renamed", () => {
    assert.equal(query(s.target, "SELECT COUNT(*) AS n FROM project_spaces WHERE slug = 'tea-data'")[0].n, 1);
    assert.equal(report.per_table.project_spaces.matched_existing, 1);
    assert.deepEqual(query(s.target, "SELECT id, slug FROM project_spaces WHERE id IN (1,5) ORDER BY id"), [{ id: 1, slug: "proj-one" }, { id: 5, slug: "proj-five" }]);
    assert.equal(query(s.target, "SELECT project_id FROM research_sources WHERE title = 'TEA report'")[0].project_id, 6);
    assert.equal(query(s.target, "SELECT project_id FROM storage_files WHERE s3_key = 'files/a.pdf'")[0].project_id, 6);
    const clash = query(s.target, "SELECT slug, workspace_dir FROM project_spaces WHERE uuid = 'g-uuid-7'")[0];
    assert.equal(clash.slug, "clash-grackle");
    assert.equal(query(s.target, "SELECT slug FROM project_spaces WHERE id = 2")[0].slug, "clash", "crow's project untouched");
    // members: the 6/Dayane/editor row matches crow's (contact remapped by crow_id); the other has no crow contact
    assert.equal(report.per_table.project_members.matched_existing, 1);
    assert.deepEqual(query(s.target, "SELECT project_id, contact_id, role FROM project_members WHERE uuid = 'g-pm-2'"), [{ project_id: 1, contact_id: null, role: "viewer" }]);
  });

  it("ramble: insert-or-ignore on natural keys; crow's rows never change; wallet delta = inserted sum", () => {
    assert.equal(query(s.target, "SELECT first_unlocked_at AS t FROM ramble_cells WHERE cell = '9vg4zzz'")[0].t, 100);
    assert.equal(query(s.target, "SELECT delta FROM ramble_wallet WHERE kind = 'earn' AND key = 'visit:9vg4zzz'")[0].delta, 5);
    assert.equal(report.per_table.ramble_cells.inserted, 2);
    assert.equal(report.per_table.ramble_wallet.inserted, 3);
    assert.equal(report.per_table.ramble_credits.inserted, 1);
    assert.equal(report.per_table.ramble_nest_claims.inserted, 1);
    for (const [kind, w] of Object.entries(report.wallet.per_kind)) {
      assert.equal(w.wallet_balance_after - w.wallet_balance_before, w.inserted_sum, `kind ${kind}`);
    }
    assert.equal(report.wallet.per_kind.earn.inserted_sum, 12);
    assert.equal(report.wallet.per_kind.spend.inserted_sum, -3);
  });

  it("pi_bot_defs import with enabled = 0, whatever the source said", () => {
    const rows = query(s.target, "SELECT bot_id, enabled FROM pi_bot_defs ORDER BY bot_id");
    assert.deepEqual(rows, [{ bot_id: "grackle-assistant", enabled: 0 }, { bot_id: "home-search", enabled: 0 }]);
  });

  it("unowned tables go to the extract and are never created in the target", () => {
    for (const t of ["pir_requests", "capstone_pir_files", "pipeline_runs", "tax_returns", "crowclaw_bots"]) {
      assert.equal(query(s.target, "SELECT COUNT(*) AS n FROM sqlite_master WHERE name = ?", t)[0].n, 0, `${t} not in target`);
      assert.ok(report.extract_tables[t], `${t} listed in extract_tables`);
    }
    assert.equal(query(s.applyOpts.extract, "SELECT COUNT(*) AS n FROM pir_requests")[0].n, 2);
  });

  it("media: tables created by the bundle's own init; manual playlists only; article items to the extract", () => {
    assert.ok(report.bundle_tables_created.some((c) => c.group === "media" && /initMediaTables/.test(c.via)));
    assert.deepEqual(query(s.target, "SELECT name FROM media_playlists"), [{ name: "Manual" }]);
    const items = query(s.target, "SELECT item_type, item_id FROM media_playlist_items");
    const briefing = query(s.target, "SELECT id FROM media_briefings WHERE title = 'Morning'")[0].id;
    assert.deepEqual(items, [{ item_type: "briefing", item_id: briefing }]);
    assert.equal(query(s.target, "SELECT COUNT(*) AS n FROM media_articles")[0].n, 0, "the rolling feed is not imported");
    assert.equal(query(s.applyOpts.extract, "SELECT COUNT(*) AS n FROM media_articles")[0].n, 2);
    assert.equal(query(s.applyOpts.extract, "SELECT COUNT(*) AS n FROM media_playlist_items")[0].n, 2);
  });

  it("data-dashboard: case study and section ids kept (figure names embed them)", () => {
    assert.deepEqual(query(s.target, "SELECT id, project_id FROM data_case_studies"), [{ id: 3, project_id: 6 }]);
    assert.deepEqual(query(s.target, "SELECT id, case_study_id FROM data_case_study_sections"), [{ id: 40, case_study_id: 3 }]);
  });

  it("skipped tables are listed with counts; credential tables stay out of the extract", () => {
    assert.equal(report.skipped.notifications.count, 3);
    assert.equal(report.skipped.oauth_clients.count, 1);
    assert.equal(query(s.applyOpts.extract, "SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'oauth_clients'")[0].n, 0);
  });

  it("settings: blog_* moves to crow; other keys only fill gaps; the glasses override follows its project", () => {
    assert.equal(query(s.target, "SELECT value FROM dashboard_settings WHERE key = 'blog_title'")[0].value, "Maestro Press");
    assert.equal(query(s.target, "SELECT value FROM dashboard_settings WHERE key = 'blog_custom_css'")[0].value, "body{}");
    assert.equal(query(s.target, "SELECT value FROM dashboard_settings WHERE key = 'tts_voice'")[0].value, "crow-voice");
    assert.equal(query(s.target, "SELECT value FROM dashboard_settings WHERE key = 'theme'")[0].value, "crow-theme");
    assert.equal(query(s.target, "SELECT value FROM dashboard_settings WHERE key = 'meta_glasses_devices'")[0].value, "[]");
    assert.deepEqual(query(s.target, "SELECT instance_id, value FROM dashboard_settings_overrides WHERE key = 'meta_glasses_default_project_id'"),
      [{ instance_id: CROW_ID, value: "5" }]);
  });

  it("phase B queues the synced rows into sync_outbox under crow's instance id", () => {
    assert.equal(report.emits.instance_id, CROW_ID);
    const ob = query(s.target, "SELECT table_name, COUNT(*) AS n FROM sync_outbox GROUP BY table_name ORDER BY table_name");
    assert.deepEqual(ob, [
      { table_name: "glasses_note_sessions", n: 1 },
      { table_name: "memories", n: 5 },
      { table_name: "ramble_cells", n: 2 },
      { table_name: "ramble_wallet", n: 3 },
      { table_name: "research_notes", n: 2 },
    ]);
    assert.ok(report.emits.items.every((i) => i.status === "queued" && Number.isFinite(i.lamport)));
  });

  it("the integrity of the result holds", () => {
    assert.deepEqual(query(s.target, "PRAGMA integrity_check"), [{ integrity_check: "ok" }]);
  });
});

/* ---------------------------------------------------------- phase B gate */

describe("memory emits are gated on the per-peer id range", () => {
  it("idGate: open below every peer max, closed on overlap or unknown range", () => {
    assert.equal(idGate("memories", [9, 10], { memories: { "black-swan": 1, raven: 0 } }), null);
    assert.match(idGate("memories", [6, 9], { memories: { "black-swan": 6 } }), /peer-id-overlap/);
    assert.equal(idGate("memories", [6], {}), "peer-id-range-unknown");
  });

  it("no peer range → memories stay un-queued (peer-id-range-unknown); ramble still queues", async () => {
    const s = await setup();
    const res = await run({ ...s.applyOpts, peerMaxMemoryId: [] }, { probes: OK_PROBES, emitter });
    assert.equal(res.exitCode, 0);
    const mem = res.report.emits.items.filter((i) => i.table === "memories");
    assert.equal(mem.length, 5);
    assert.ok(mem.every((i) => i.status === "gated" && i.reason === "peer-id-range-unknown"));
    assert.equal(query(s.target, "SELECT COUNT(*) AS n FROM sync_outbox WHERE table_name IN ('memories','research_notes','glasses_note_sessions')")[0].n, 0);
    assert.equal(query(s.target, "SELECT COUNT(*) AS n FROM sync_outbox WHERE table_name = 'ramble_cells'")[0].n, 2);
  });

  it("emit-only re-evaluates the gate: an overlapping peer keeps memories gated, a clear range queues them", async () => {
    const s = await setup();
    const res = await run({ ...s.applyOpts, peerMaxMemoryId: [] }, { probes: OK_PROBES, emitter });
    const lowest = Math.min(...res.report.emits.items.filter((i) => i.table === "memories").map((i) => i.key.id));
    const overlap = await run({ mode: "emit-only", target: s.target, report: s.applyOpts.report,
      peerMaxMemoryId: [`black-swan=${lowest}`], peerMaxId: [] }, { emitter });
    assert.equal(overlap.exitCode, 0);
    const mem = overlap.report.emits.items.filter((i) => i.table === "memories");
    assert.ok(mem.every((i) => i.status === "gated" && /peer-id-overlap/.test(i.reason)));
    assert.equal(query(s.target, "SELECT COUNT(*) AS n FROM sync_outbox WHERE table_name = 'memories'")[0].n, 0);
    const clear = await run({ mode: "emit-only", target: s.target, report: s.applyOpts.report,
      peerMaxMemoryId: [`black-swan=${lowest - 1}`, "raven=0"], peerMaxId: [] }, { emitter });
    assert.equal(clear.exitCode, 0);
    assert.equal(query(s.target, "SELECT COUNT(*) AS n FROM sync_outbox WHERE table_name = 'memories'")[0].n, 5);
  });
});

/* ------------------------------------------------------- all or nothing */

describe("phase A is all-or-nothing", () => {
  it("a failure injected after half the tables leaves the target's row counts unchanged (bundle DDL included)", async () => {
    const s = await setup();
    const before = counts(s.target);
    await assert.rejects(
      run({ ...s.applyOpts, importMedia: true }, { probes: OK_PROBES, emitter, failAfterTables: 14 }),
      /injected failure after 14 tables/,
    );
    assert.deepEqual(counts(s.target), before);
    assert.equal(query(s.target, "SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'media_playlists'")[0].n, 0, "bundle init rolled back too");
    assert.equal(query(s.target, "SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'sync_outbox'")[0].n, 0, "phase B never ran");
  });
});

/* ------------------------------------------------------- idempotency */

describe("idempotency", () => {
  it("a second apply is a no-op: nothing inserted, counts and outbox unchanged", async () => {
    const s = await setup();
    const first = await run({ ...s.applyOpts, importMedia: true, importDataDashboard: true }, { probes: OK_PROBES, emitter });
    assert.equal(first.exitCode, 0);
    const mid = counts(s.target);
    copyFileSync(s.target, s.backup); // a fresh cold backup for the second window
    const second = await run({ ...s.applyOpts, importMedia: true, importDataDashboard: true }, { probes: OK_PROBES, emitter });
    assert.equal(second.exitCode, 0);
    for (const [t, st] of Object.entries(second.report.per_table)) assert.equal(st.inserted, 0, `${t} inserts nothing on re-run`);
    assert.deepEqual(counts(s.target), mid);
    assert.equal(second.report.emits.items.length, 0);
  });

  it("emit-only re-queues from the report without duplicating (table, key, lamport)", async () => {
    const s = await setup();
    const res = await run(s.applyOpts, { probes: OK_PROBES, emitter });
    assert.equal(res.exitCode, 0);
    const ob0 = query(s.target, "SELECT table_name, row_json, lamport_ts FROM sync_outbox ORDER BY id");
    for (let i = 0; i < 2; i++) {
      const r = await run({ mode: "emit-only", target: s.target, report: s.applyOpts.report }, { emitter });
      assert.equal(r.exitCode, 0);
    }
    const ob = query(s.target, "SELECT table_name, row_json, lamport_ts FROM sync_outbox ORDER BY id");
    assert.deepEqual(ob, ob0);
  });

  it("emit-only re-queues an item whose outbox row is gone, keeping its lamport", async () => {
    const s = await setup();
    await run(s.applyOpts, { probes: OK_PROBES, emitter });
    const victim = query(s.target, "SELECT id, table_name, lamport_ts FROM sync_outbox WHERE table_name = 'ramble_cells' LIMIT 1")[0];
    const db = new Database(s.target); db.prepare("DELETE FROM sync_outbox WHERE id = ?").run(victim.id); db.close();
    const r = await run({ mode: "emit-only", target: s.target, report: s.applyOpts.report }, { emitter });
    assert.equal(r.exitCode, 0);
    assert.equal(query(s.target, "SELECT COUNT(*) AS n FROM sync_outbox WHERE table_name = 'ramble_cells' AND lamport_ts = ?", victim.lamport_ts)[0].n, 1);
  });
});

/* ------------------------------------------------------------------ CLI */

describe("CLI", () => {
  it("apply without --expect-sha exits 2 and writes nothing", async () => {
    const s = await setup();
    const tgt0 = fileState(s.target);
    const r = spawnSync(process.execPath, [SCRIPT, "--mode", "apply", "--source", s.source, "--target", s.target,
      "--report", s.applyOpts.report, "--extract", s.applyOpts.extract, "--backup-ok", s.backup], {
      encoding: "utf8", env: { ...process.env, CROW_DATA_DIR: s.crowDataDir },
    });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /REFUSED/);
    assert.match(r.stderr, /--expect-sha is required/);
    assert.deepEqual(fileState(s.target), tgt0);
    assert.ok(!existsSync(s.applyOpts.report));
  });

  it("an unknown argument is a usage error (64)", () => {
    const r = spawnSync(process.execPath, [SCRIPT, "--bogus"], { encoding: "utf8" });
    assert.equal(r.status, 64);
  });
});
