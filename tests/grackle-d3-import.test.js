/**
 * scripts/ops/grackle-d3-import.mjs — the D3 importer (grackle → crow main).
 * Spec in the private engineering notes
 * §4, §5.3 and §9; plan Task 1 ("Rules pinned by tests"); review fix round 1
 * (C1, I1–I8, minors).
 *
 * Every DB here is a scratch file built from the repo's own schema
 * (tests/fixtures/grackle-d3/build.mjs), or a scratch COPY of crow's API
 * backup. Nothing touches ~/.crow.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  mkdtempSync, rmSync, existsSync, statSync, readFileSync, copyFileSync, writeFileSync, readdirSync, linkSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir, homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { run, sha256File, idGate, ackProblems, rebaseBotDefinition, resolveTargetCrowHome } from "../scripts/ops/grackle-d3-import.mjs";
import { emitOrQueue, _setEligibilityForTest } from "../servers/shared/sync-emit.js";
import { SCHEMA_GENERATION } from "../servers/shared/schema-version.js";
import {
  buildPair, buildSource, fixturePeerFlags, CROW_ID, GRACKLE_ID, BLACK_SWAN_ID, RAVEN_ID, MPA_ID, UNCLASSIFIED_WITH_ROWS,
} from "./fixtures/grackle-d3/build.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO, "scripts/ops/grackle-d3-import.mjs");

const OK_PROBES = { gatewayState: () => ({ load: "loaded", active: "inactive" }), holders: () => [], uid: () => process.getuid() };
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

function exec(path, sql) {
  const db = new Database(path);
  try { db.exec(sql); } finally { db.close(); }
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
    ackUnclassified: [UNCLASSIFIED_WITH_ROWS.join(",")],
    ...fixturePeerFlags(),
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
    for (const k of ["source_sha", "target_before_counts", "target_after_counts", "per_table", "remaps", "extract_tables", "skipped", "emits", "wallet", "go_no_go"]) {
      assert.ok(k in report, `report has ${k}`);
    }
    assert.equal(report.source_sha, s.applyOpts.expectSha);
    assert.equal(report.per_table.memories.inserted, 5);
    assert.ok(report.versions.bundles.ramble, "bundle versions recorded");
  });

  it("the go/no-go section names unclassified tables, extract-only tables with counts, and drift", async () => {
    const s = await setup();
    const res = await run({ ...s.applyOpts, mode: "plan", backupOk: undefined }, { emitter });
    const g = res.report.go_no_go;
    assert.deepEqual(g.unclassified_with_rows, { job_search_sites: 1 });
    assert.equal(g.extract_only_tables.bot_runs, 1);
    assert.equal(g.extract_only_tables.pir_requests, 2);
    assert.equal(g.extract_only_tables.media_articles, 2);
    assert.equal(g.content_drift.memories.count, 1);
    assert.deepEqual(g.imported_schedules.map((r) => r.task).sort(), ["blog-digest", "pipeline:botcron:grackle-assistant"]);
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
    const s = await setup({ grackleStatus: "active" });
    const src0 = fileState(s.source);
    const tgt0 = fileState(s.target);
    const tgtCounts0 = counts(s.target);
    const tmpBefore = new Set(readdirSync(tmpdir()).filter((f) => f.startsWith("grackle-d3-rehearse-")));
    const res = await run({ ...s.applyOpts, mode: "rehearse", backupOk: undefined, importMedia: true, importDataDashboard: true }, { emitter, probes: OK_PROBES });
    assert.equal(res.exitCode, 0);
    assert.deepEqual(fileState(s.source), src0);
    assert.deepEqual(fileState(s.target), tgt0);
    assert.deepEqual(counts(s.target), tgtCounts0);
    assert.equal(query(s.target, "SELECT status FROM crow_instances WHERE id = ?", GRACKLE_ID)[0].status, "active", "the revoke is simulated on the copy only");
    assert.ok(!existsSync(s.applyOpts.extract), "rehearse never writes the real --extract");
    const r = res.report.rehearse;
    assert.equal(r.simulated_source_revoke, true);
    assert.equal(r.integrity, "ok");
    assert.deepEqual(r.new_fk_violations, []);
    assert.deepEqual(r.count_diffs_vs_plan, []);
    for (const [name, f] of Object.entries(r.fts)) assert.ok(f.ok, `FTS ${name} consistent: ${JSON.stringify(f)}`);
    assert.equal(r.ok, true);
    assert.ok(res.report.emits.items.every((i) => i.status === "queued"), "phase B exercised on the copy");
    const leftover = readdirSync(tmpdir()).filter((f) => f.startsWith("grackle-d3-rehearse-") && !tmpBefore.has(f));
    assert.deepEqual(leftover, [], "scratch copy removed");
  });

  it("refuses when the instance-id file is missing (it is never created)", async () => {
    const s = await setup();
    rmSync(join(s.crowDataDir, "instance-id"));
    const res = await run({ ...s.applyOpts, mode: "rehearse", backupOk: undefined }, { emitter, probes: OK_PROBES });
    assert.equal(res.exitCode, 2);
    assert.match(res.refused.join("\n"), /instance-id file missing/);
    assert.ok(!existsSync(join(s.crowDataDir, "instance-id")));
  });
});

/* real-shaped rehearse: a scratch COPY of crow's newest API backup (skipped where absent, e.g. CI) */
describe("rehearse against a copy of crow's real API backup", () => {
  // Nothing outside the scratch env is even stat'ed unless the operator opts in.
  const optedIn = process.env.CROW_TEST_REAL_BACKUP === "1";
  const dir = join(homedir(), "backups", "crow");
  const newest = optedIn && existsSync(dir) ? readdirSync(dir).filter((f) => /^primary-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().pop() : null;
  const idFile = join(homedir(), ".crow", "data", "instance-id");
  // Opt-in (2026-10-04): this reads the HOST's live backup dir + instance-id,
  // so its outcome tracked prod state, not the code. It went red on crow when
  // r4's nightly backup started overwriting main's at the same
  // ~/backups/crow/primary-<date>.db path. Run it deliberately as an operator
  // rehearsal: CROW_TEST_REAL_BACKUP=1 npm test -- tests/grackle-d3-import.test.js
  const skip = !optedIn
    ? "real-backup rehearsal is opt-in (CROW_TEST_REAL_BACKUP=1)"
    : (!newest || !existsSync(idFile) ? "no crow API backup / instance-id on this host" : false);

  it("rehearse succeeds when grackle's own local-owner rows (other uuids) meet crow's (C1 on real data)", { skip }, async () => {
    const root = scratch();
    const target = join(root, "crow-copy.db");
    copyFileSync(join(dir, newest), target); // the real file is only read
    const dataDir = join(root, "data");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(dataDir);
    const selfId = readFileSync(idFile, "utf8").trim();
    writeFileSync(join(dataDir, "instance-id"), selfId);
    process.env.CROW_DATA_DIR = dataDir;
    // grackle-shaped source: the same schema and projects, but every
    // project_members row created independently (fresh uuids), grackle as
    // its own home, plus a grant to a contact crow has never seen.
    const source = join(root, "grackle.db");
    copyFileSync(target, source);
    exec(source, `
      PRAGMA journal_mode = DELETE;
      UPDATE project_members SET uuid = 'g-' || uuid;
      UPDATE crow_instances SET is_home = CASE WHEN id = '${GRACKLE_ID}' THEN 1 ELSE 0 END;
      INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey, origin) VALUES ('crow:g-test-bot', 'bot', 'e', 's', 'local-bot');
      INSERT INTO project_members (uuid, project_id, contact_id, role)
        SELECT 'g-bot-grant', (SELECT MIN(id) FROM project_spaces), (SELECT id FROM contacts WHERE crow_id = 'crow:g-test-bot'), 'editor';
    `);
    const members = query(target, "SELECT COUNT(*) AS n FROM project_members")[0].n;
    const peers = query(target, "SELECT id FROM crow_instances WHERE status IN ('active','offline')").map((r) => r.id)
      .filter((id) => id !== selfId && id !== GRACKLE_ID);
    const peerMaxId = [];
    for (const t of ["memories", "research_notes", "glasses_note_sessions"]) for (const p of peers) peerMaxId.push(`${t}:${p}=0`);
    const res = await run({ mode: "rehearse", source, target, report: join(root, "r.json"), peerMaxId }, { emitter, probes: { holders: () => [] } });
    assert.equal(res.exitCode, 0, JSON.stringify(res.refused));
    assert.equal(res.report.rehearse.ok, true, JSON.stringify(res.report.rehearse));
    const pm = res.report.per_table.project_members;
    assert.equal(pm.matched_existing, members, "every independently-created row matched crow's by its unique index");
    assert.equal(pm.inserted, 0);
    assert.equal(pm.fk_skipped, 1, "the grant to an unknown (local-bot) contact went to the extract, not NULL");
  });
});

/* --------------------------------------------------------- apply refusals */

describe("apply refuses (exit 2, nothing written)", () => {
  async function expectRefusal(mutate, pattern, deps = {}, buildOpts = {}) {
    const s = await setup(buildOpts);
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
    expectRefusal(() => {}, /crow-gateway is active/, { probes: { ...OK_PROBES, gatewayState: () => ({ load: "loaded", active: "active" }) } }));
  it("when the crow-gateway unit is not loaded (wrong name or host)", () =>
    expectRefusal(() => {}, /LoadState=not-found/, { probes: { ...OK_PROBES, gatewayState: () => ({ load: "not-found", active: "inactive" }) } }));
  it("when the gateway state cannot be determined", () =>
    expectRefusal(() => {}, /cannot determine crow-gateway state/, { probes: { ...OK_PROBES, gatewayState: () => null } }));
  it("when another process holds the target — and before reading it", async () => {
    let probed = false;
    await expectRefusal(() => {}, /held by other process.*4242/, { probes: { ...OK_PROBES, holders: () => { probed = true; return [4242]; } } });
    assert.ok(probed);
  });
  it("when holders cannot be verified", () =>
    expectRefusal(() => {}, /cannot verify target holders/, {
      probes: { ...OK_PROBES, holders: () => { throw new Error("lsof unavailable"); } },
    }));
  it("on a user_version mismatch between source and target", () =>
    expectRefusal((s) => {
      exec(s.target, `PRAGMA user_version = ${SCHEMA_GENERATION - 1}`);
      copyFileSync(s.target, s.backup);
    }, /user_version mismatch/));
  it("when both versions agree but differ from SCHEMA_GENERATION", () =>
    expectRefusal((s, opts) => {
      for (const p of [s.source, s.target]) exec(p, `PRAGMA user_version = ${SCHEMA_GENERATION + 1}`);
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
    expectRefusal((s) => { exec(s.backup, "INSERT INTO memories (content) VALUES ('only in the backup')"); }, /does not match the target/));
  it("when the target was written after the --backup-ok was taken", () =>
    expectRefusal(async (s) => {
      await new Promise((r) => setTimeout(r, 20));
      exec(s.target, "INSERT INTO memories (content) VALUES ('late write'); DELETE FROM memories WHERE content = 'late write';");
    }, /older than the target's last write/));
  it("when --backup-ok IS the target (I1)", () =>
    expectRefusal((s, opts) => { opts.backupOk = s.target; }, /resolves to the target itself/));
  it("when --backup-ok is a hardlink to the target (I1)", () =>
    expectRefusal((s, opts) => { const l = join(s.root, "link.db"); linkSync(s.target, l); opts.backupOk = l; }, /resolves to the target itself/));
  it("when a live peer has no --peer-max-id (I3)", () =>
    expectRefusal((s, opts) => { opts.peerMaxId = opts.peerMaxId.filter((v) => !v.includes(RAVEN_ID)); }, new RegExp(`no --peer-max-id memories:${RAVEN_ID}`)));
  it("when MPA is neither covered nor excluded (I3)", () =>
    expectRefusal((s, opts) => { opts.peerExclude = []; }, new RegExp(`--peer-exclude ${MPA_ID}`)));
  it("when a --peer-max-id names an unknown instance (typo) (I3)", () =>
    expectRefusal((s, opts) => { opts.peerMaxId = [...opts.peerMaxId, "memories:black_swan=1"]; }, /black_swan is not a live peer/));
  it("when running as root (I5)", () =>
    expectRefusal(() => {}, /running as root/, { probes: { ...OK_PROBES, uid: () => 0 } }));
  it("when the target is owned by another user (I5)", () =>
    expectRefusal(() => {}, /owned by uid/, { probes: { ...OK_PROBES, uid: () => process.getuid() + 1 } }));
  it("when the instance-id file is missing (I5)", () =>
    expectRefusal((s) => rmSync(join(s.crowDataDir, "instance-id")), /instance-id file missing/));
  it("when the instance id is not a crow_instances row (I5)", () =>
    expectRefusal((s) => writeFileSync(join(s.crowDataDir, "instance-id"), "ffffffffffffffffffffffffffffffff"), /not a row in the target's crow_instances/));
  it("without --ack-unclassified (I6)", () =>
    expectRefusal((s, opts) => { opts.ackUnclassified = []; }, /--ack-unclassified must list exactly.*missing \[job_search_sites\]/));
  it("when --ack-unclassified lists a table that is not unclassified (I6)", () =>
    expectRefusal((s, opts) => { opts.ackUnclassified = ["job_search_sites,memories"]; }, /not unclassified \[memories\]/));
});

describe("ackProblems", () => {
  it("accepts exactly the set, in any order and split across flags", () => {
    assert.deepEqual(ackProblems({ a: 1, b: 2 }, ["b", "a"]), []);
    assert.deepEqual(ackProblems({ a: 1, b: 2 }, ["b,a"]), []);
    assert.equal(ackProblems({ a: 1 }, []).length, 1);
    assert.deepEqual(ackProblems({}, []), []);
  });
});

/* ------------------------------------------------------- apply: the data */

describe("apply: what lands where", () => {
  let s, report;
  before(async () => {
    s = await setup();
    const res = await run({ ...s.applyOpts, importMedia: true, importDataDashboard: true }, { probes: OK_PROBES, emitter });
    assert.equal(res.exitCode, 0, JSON.stringify(res.refused));
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
    assert.deepEqual(ex.map((r) => [r.column_name, r.value]), [["file_path", "/home/alex/pdfs/r1.pdf"], ["s3_key", "capstone/r1.pdf"]]);
  });

  it("memories: content matches skipped, fresh ids above every peer, embeddings follow, FTS consistent", () => {
    const m = report.per_table.memories;
    assert.equal(m.source_rows, 7);
    assert.equal(m.matched_existing, 2); // content match (1) + id/created_at match (4)
    assert.equal(m.inserted, 5);
    assert.equal(m.kept_ids, 0);
    assert.equal(m.remapped_ids, 5);
    assert.ok(Object.values(report.remaps.memories).filter((id) => id !== 1 && id !== 4).every((id) => id > 8));
    const two = report.remaps.memories["2"];
    assert.equal(query(s.target, "SELECT content FROM memories WHERE id = ?", two)[0].content, "grackle memory two");
    assert.equal(query(s.target, "SELECT content FROM memories WHERE id = 2")[0].content, "crow memory two", "crow's row untouched");
    assert.deepEqual(query(s.target, "SELECT hex(vec) AS v FROM memory_embeddings_blob WHERE memory_id = ?", two), [{ v: "02020202" }]);
    assert.deepEqual(query(s.target, "SELECT hex(vec) AS v FROM memory_embeddings_blob WHERE memory_id = ?", report.remaps.memories["7"]), [{ v: "07070707" }]);
    assert.equal(query(s.target, "SELECT COUNT(*) AS n FROM memories WHERE content = 'shared memory'")[0].n, 1);
    const n = query(s.target, "SELECT COUNT(*) AS n FROM memories")[0].n;
    assert.equal(n, 4 + 5);
    assert.equal(query(s.target, "SELECT COUNT(*) AS n FROM memories_fts_docsize")[0].n, n);
    assert.equal(query(s.target, "SELECT COUNT(*) AS n FROM memories_fts WHERE memories_fts MATCH 'seven'")[0].n, 1);
  });

  it("a replicated-then-edited memory (same id + created_at) is NOT duplicated; crow's version is kept and the drift reported (I2)", () => {
    assert.equal(query(s.target, "SELECT content FROM memories WHERE id = 4")[0].content, "replicated memory, crow edit");
    assert.equal(query(s.target, "SELECT COUNT(*) AS n FROM memories WHERE content LIKE 'replicated memory%'")[0].n, 1);
    const d = report.go_no_go.content_drift.memories;
    assert.equal(d.count, 1);
    assert.deepEqual(d.rows[0].fields, ["content"]);
    assert.equal(d.rows[0].crow_updated_at, "2026-03-01 00:00:00");
    assert.equal(d.rows[0].source_updated_at, "2026-04-01 00:00:00");
    assert.ok(!JSON.stringify(d).includes("grackle edit"), "the report never carries content");
  });

  it("project_spaces: grackle 6 merges into crow 6, children follow, 1 and 5 inserted, slug clash renamed", () => {
    assert.equal(query(s.target, "SELECT COUNT(*) AS n FROM project_spaces WHERE slug = 'tea-data'")[0].n, 1);
    assert.equal(report.per_table.project_spaces.matched_existing, 1);
    assert.deepEqual(query(s.target, "SELECT id, slug FROM project_spaces WHERE id IN (1,5) ORDER BY id"), [{ id: 1, slug: "proj-one" }, { id: 5, slug: "proj-five" }]);
    assert.equal(query(s.target, "SELECT project_id FROM research_sources WHERE title = 'TEA report'")[0].project_id, 6);
    assert.equal(query(s.target, "SELECT project_id FROM storage_files WHERE s3_key = 'files/a.pdf'")[0].project_id, 6);
    assert.equal(query(s.target, "SELECT slug FROM project_spaces WHERE uuid = 'g-uuid-7'")[0].slug, "clash-grackle");
    assert.equal(query(s.target, "SELECT slug FROM project_spaces WHERE id = 2")[0].slug, "clash", "crow's project untouched");
    assert.equal(report.go_no_go.renamed_project_slugs.length, 1);
  });

  it("project_members (C1): local-owner rows match per project, remote rows per (project, contact); no grant ever becomes NULL", () => {
    // exactly one active local owner per project, crow's own row on 6
    for (const pid of [1, 5, 6]) {
      assert.equal(query(s.target, "SELECT COUNT(*) AS n FROM project_members WHERE project_id = ? AND contact_id IS NULL AND revoked_at IS NULL", pid)[0].n, 1, `project ${pid}`);
    }
    assert.equal(query(s.target, "SELECT uuid FROM project_members WHERE project_id = 6 AND contact_id IS NULL")[0].uuid, "crow-own-6");
    // Alex: same contact, different role → matched, crow's role kept
    assert.deepEqual(query(s.target, "SELECT role FROM project_members WHERE project_id = 6 AND contact_id = 3"), [{ role: "viewer" }]);
    // a contact crow lacked but would sync: imported, and the grant points at it
    const nobody = query(s.target, "SELECT id, verified FROM contacts WHERE crow_id = 'crow:nobody'")[0];
    assert.equal(nobody.verified, 0, "per-device verification is never imported");
    assert.deepEqual(query(s.target, "SELECT project_id, contact_id, role FROM project_members WHERE uuid = 'g-pm-2'"), [{ project_id: 1, contact_id: nobody.id, role: "viewer" }]);
    // a grant to a local-bot contact goes to the extract, never NULL
    assert.equal(query(s.target, "SELECT COUNT(*) AS n FROM project_members WHERE uuid = 'g-pm-3'")[0].n, 0);
    assert.equal(query(s.target, "SELECT COUNT(*) AS n FROM contacts WHERE crow_id = 'crow:gbot'")[0].n, 0);
    const why = query(s.applyOpts.extract, "SELECT reason FROM _not_imported_rows WHERE table_name = 'project_members' ORDER BY reason");
    assert.equal(why.length, 2);
    assert.match(why[0].reason, /contact_id=11/);
    assert.equal(why[1].reason, "tombstoned");
    assert.equal(query(s.target, "SELECT COUNT(*) AS n FROM project_members WHERE contact_id IS NULL AND role != 'owner'")[0].n, 0);
  });

  it("already-synced tables: grackle rows missing on crow are imported by sync key and reported (I7)", () => {
    const m = report.go_no_go.synced_tables_missing_on_crow;
    assert.deepEqual(m.messages.keys, [{ nostr_event_id: "ev-grackle" }]);
    assert.deepEqual(m.crow_context.keys, [{ section_key: "grackle_notes", device_id: null, project_id: null }]);
    assert.deepEqual(m.ramble_eggs.keys, [{ egg_id: "egg-g1" }, { egg_id: "egg-g2" }]);
    assert.deepEqual(m.ramble_marks.keys, [{ mark_id: "mark-g1" }]);
    assert.deepEqual(m.ramble_settings.keys, [{ key: "only_grackle" }]);
    assert.deepEqual(m.contacts.keys, [{ crow_id: "crow:nobody" }]);
    // the message lands on crow's Alex (remapped contact), crow's rows win on a clash
    assert.equal(query(s.target, "SELECT contact_id FROM messages WHERE nostr_event_id = 'ev-grackle'")[0].contact_id, 3);
    assert.equal(query(s.target, "SELECT COUNT(*) AS n FROM messages WHERE nostr_event_id = 'ev-bot'")[0].n, 0);
    assert.equal(query(s.target, "SELECT value FROM ramble_settings WHERE key = 'shared'")[0].value, "crow-value");
    assert.equal(query(s.target, "SELECT mood FROM ramble_pet WHERE owner = 'self'")[0].mood, "crow-mood");
    // the imported egg the nest claim points at is there; its lamport_origin is NULL (and lamport_ts 0)
    assert.deepEqual(query(s.target, "SELECT lamport_origin, lamport_ts FROM ramble_eggs WHERE egg_id = 'egg-g1'"), [{ lamport_origin: null, lamport_ts: 0 }]);
    assert.equal(query(s.target, "SELECT COUNT(*) AS n FROM ramble_marks_fts WHERE ramble_marks_fts MATCH 'grackle'")[0].n, 1);
  });

  it("newly mapped core tables: schedules, setlists, blog comments, crosspost rules (I6)", () => {
    assert.equal(query(s.target, "SELECT COUNT(*) AS n FROM schedules WHERE task = 'blog-digest'")[0].n, 1);
    const item = query(s.target, "SELECT i.post_id, p.slug FROM songbook_setlist_items i JOIN blog_posts p ON p.id = i.post_id")[0];
    assert.equal(item.slug, "post-nine");
    assert.deepEqual(query(s.target, "SELECT contact_id, content FROM blog_comments WHERE content = 'nice'"), [{ contact_id: 3, content: "nice" }]);
    assert.equal(query(s.target, "SELECT COUNT(*) AS n FROM crosspost_rules")[0].n, 1);
    assert.equal(query(s.target, "SELECT COUNT(*) AS n FROM bot_runs")[0].n, 0, "bot history is extract-only");
    assert.equal(query(s.applyOpts.extract, "SELECT COUNT(*) AS n FROM bot_runs")[0].n, 1);
    assert.equal(query(s.applyOpts.extract, "SELECT COUNT(*) AS n FROM job_search_sites")[0].n, 1, "the acked table is archived");
  });

  it("storage_files.reference_id follows its remapped blog post (minor 3)", () => {
    assert.deepEqual(query(s.target, "SELECT reference_type, reference_id FROM storage_files"), [{ reference_type: "blog_post", reference_id: 20 }]);
  });

  it("ramble: insert-or-ignore on natural keys; crow's rows never change; wallet delta = inserted sum; clash reported", () => {
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
    assert.deepEqual(report.go_no_go.content_drift.ramble_wallet.rows[0].key, { kind: "earn", key: "visit:9vg4zzz" });
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

  it("settings: blog_* moves to crow; other keys only fill gaps; skipped keys named; secrets redacted in the extract", () => {
    assert.equal(query(s.target, "SELECT value FROM dashboard_settings WHERE key = 'blog_title'")[0].value, "Maestro Press");
    assert.equal(query(s.target, "SELECT value FROM dashboard_settings WHERE key = 'blog_custom_css'")[0].value, "body{}");
    assert.equal(query(s.target, "SELECT value FROM dashboard_settings WHERE key = 'tts_voice'")[0].value, "crow-voice");
    assert.equal(query(s.target, "SELECT value FROM dashboard_settings WHERE key = 'theme'")[0].value, "crow-theme");
    assert.equal(query(s.target, "SELECT value FROM dashboard_settings WHERE key = 'meta_glasses_devices'")[0].value, "[]");
    assert.deepEqual(query(s.target, "SELECT instance_id, value FROM dashboard_settings_overrides WHERE key = 'meta_glasses_default_project_id'"),
      [{ instance_id: CROW_ID, value: "5" }]);
    assert.ok(report.settings.skipped_keys.includes("theme"));
    assert.deepEqual(query(s.applyOpts.extract, "SELECT key, value, redacted FROM _settings_not_imported WHERE key IN ('theme','integration_api_key') ORDER BY key"),
      [{ key: "integration_api_key", value: null, redacted: 1 }, { key: "theme", value: "grackle-theme", redacted: 0 }]);
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
    const saved = JSON.parse(readFileSync(s.applyOpts.report, "utf8"));
    assert.ok(saved.emits.items.every((i) => i.status === "queued"), "progress persisted");
  });

  it("the integrity of the result holds", () => {
    assert.deepEqual(query(s.target, "PRAGMA integrity_check"), [{ integrity_check: "ok" }]);
    assert.deepEqual(query(s.target, "PRAGMA foreign_key_check"), []);
  });
});

/* ------------------------------------------------------- fix round 2 */

describe("fix round 2", () => {
  let s, report;
  before(async () => {
    s = await setup();
    const res = await run(s.applyOpts, { probes: OK_PROBES, emitter });
    assert.equal(res.exitCode, 0, JSON.stringify(res.refused));
    report = res.report;
  });
  const reasons = (table) => query(s.applyOpts.extract, "SELECT reason FROM _not_imported_rows WHERE table_name = ?", table).map((r) => r.reason);

  it("N1: a contact tombstoned on crow is not resurrected; its messages, comments and grants go to the extract as 'tombstoned'", () => {
    assert.equal(query(s.target, "SELECT COUNT(*) AS n FROM contacts WHERE crow_id = 'crow:deleted'")[0].n, 0);
    assert.equal(query(s.target, "SELECT COUNT(*) AS n FROM messages WHERE nostr_event_id = 'ev-deleted'")[0].n, 0);
    assert.equal(query(s.target, "SELECT COUNT(*) AS n FROM blog_comments WHERE content = 'gone'")[0].n, 0);
    assert.equal(query(s.target, "SELECT COUNT(*) AS n FROM project_members WHERE uuid = 'g-pm-4'")[0].n, 0);
    for (const t of ["contacts", "messages", "blog_comments", "project_members"]) assert.ok(reasons(t).includes("tombstoned"), `${t}: ${reasons(t)}`);
    assert.deepEqual(report.go_no_go.tombstoned_contacts, [{ crow_id: "crow:deleted" }]);
  });

  it("N2: schedules import disabled with next_run cleared, and are listed for Casey", () => {
    const rows = query(s.target, "SELECT task, enabled, next_run FROM schedules ORDER BY task");
    assert.deepEqual(rows, [
      { task: "blog-digest", enabled: 0, next_run: null },
      { task: "pipeline:botcron:grackle-assistant", enabled: 0, next_run: null },
    ]);
    assert.deepEqual(report.go_no_go.imported_schedules.map((r) => [r.task, r.enabled_on_grackle]).sort(),
      [["blog-digest", 1], ["pipeline:botcron:grackle-assistant", 1]]);
  });

  it("N2 (minor e): cross-post rules import inactive and are listed", () => {
    assert.deepEqual(query(s.target, "SELECT active FROM crosspost_rules"), [{ active: 0 }]);
    assert.deepEqual(report.go_no_go.imported_crosspost_rules.map((r) => [r.source_app, r.target_app, r.active_on_grackle]), [["blog", "mastodon", 1]]);
  });

  it("N3: a missing incubating egg is shelved (shelf_origin 'sync') when crow already incubates one", () => {
    assert.deepEqual(query(s.target, "SELECT egg_id FROM ramble_eggs WHERE status = 'incubating'"), [{ egg_id: "egg-c1" }]);
    assert.deepEqual(query(s.target, "SELECT status, shelf_origin FROM ramble_eggs WHERE egg_id = 'egg-g2'"), [{ status: "shelf", shelf_origin: "sync" }]);
    assert.deepEqual(report.go_no_go.eggs_shelved, [{ egg_id: "egg-g2", kept_incubating: "egg-c1" }]);
  });

  it("minor b: a setlist item matches on (setlist, post) — another position does not abort phase A", () => {
    assert.deepEqual(query(s.target, "SELECT setlist_id, post_id, position FROM songbook_setlist_items"), [{ setlist_id: 3, post_id: 20, position: 5 }]);
    assert.equal(report.per_table.songbook_setlist_items.matched_existing, 1);
  });

  it("minor c: a comment from a contact not on crow keeps the comment, contact NULL, author name preserved", () => {
    assert.deepEqual(query(s.target, "SELECT contact_id, author_name FROM blog_comments WHERE content = 'beep'"), [{ contact_id: null, author_name: "A bot" }]);
  });

  it("minor d: a slug-matched post that is a DIFFERENT post adopts no children", () => {
    assert.deepEqual(query(s.target, "SELECT title FROM blog_posts WHERE slug = 'post-eight'"), [{ title: "Crow eight" }]);
    assert.equal(query(s.target, "SELECT COUNT(*) AS n FROM blog_comments WHERE post_id = 21")[0].n, 0);
    assert.equal(query(s.target, "SELECT COUNT(*) AS n FROM blog_post_embeddings WHERE post_id = 21")[0].n, 0);
    assert.equal(query(s.applyOpts.extract, "SELECT COUNT(*) AS n FROM blog_posts WHERE slug = 'post-eight'")[0].n, 1, "grackle's post archived");
    assert.deepEqual(report.go_no_go.blog_slug_conflicts.map((c) => c.slug), ["post-eight"]);
  });

  it("minor a: emit-only skips items the drain already delivered (unless requeue is asked for)", async () => {
    exec(s.target, "DELETE FROM sync_outbox"); // the gateway drain delivered and removed them
    const r = await run({ mode: "emit-only", target: s.target, report: s.applyOpts.report, expectSha: s.applyOpts.expectSha }, { emitter, probes: OK_PROBES });
    assert.equal(r.exitCode, 0, JSON.stringify(r.refused));
    assert.equal(query(s.target, "SELECT COUNT(*) AS n FROM sync_outbox")[0].n, 0);
    const rq = await run({ mode: "emit-only", target: s.target, report: s.applyOpts.report, expectSha: s.applyOpts.expectSha, requeue: true }, { emitter, probes: OK_PROBES });
    assert.equal(rq.exitCode, 0);
    assert.equal(query(s.target, "SELECT COUNT(*) AS n FROM sync_outbox")[0].n, 13);
  });
});

/* ---------------------------------------------------------- phase B gates */

describe("phase B gates", () => {
  it("idGate: open below every peer max, closed on overlap or unknown range", () => {
    assert.equal(idGate("memories", [9, 10], { memories: { a: 1, b: 0 } }), null);
    assert.match(idGate("memories", [6, 9], { memories: { a: 6 } }), /peer-id-overlap/);
    assert.equal(idGate("memories", [6], {}), "peer-id-range-unknown");
  });

  it("I4: with crow's grackle row not revoked, phase A commits but NOTHING is queued; emit-only queues after the revoke", async () => {
    const s = await setup({ grackleStatus: "active" });
    const res = await run(s.applyOpts, { probes: OK_PROBES, emitter });
    assert.equal(res.exitCode, 0);
    assert.match(res.report.phase_b_refused, /'active', not 'revoked'/);
    assert.ok(res.report.emits.items.every((i) => i.status === "gated" && /source-not-revoked/.test(i.reason)));
    assert.equal(query(s.target, "SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'sync_outbox'")[0].n, 0);
    const again = await run({ mode: "emit-only", target: s.target, report: s.applyOpts.report, expectSha: s.applyOpts.expectSha }, { emitter, probes: OK_PROBES });
    assert.equal(again.exitCode, 0);
    assert.equal(query(s.target, "SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'sync_outbox'")[0].n, 0, "still not revoked → still nothing");
    exec(s.target, `UPDATE crow_instances SET status = 'revoked' WHERE id = '${GRACKLE_ID}'`);
    const after = await run({ mode: "emit-only", target: s.target, report: s.applyOpts.report, expectSha: s.applyOpts.expectSha }, { emitter, probes: OK_PROBES });
    assert.equal(after.exitCode, 0);
    assert.equal(query(s.target, "SELECT COUNT(*) AS n FROM sync_outbox")[0].n, 13);
  });

  it("emit-only re-evaluates the range gate: an overlapping peer keeps memories gated, a clear range queues them", async () => {
    const s = await setup();
    const res = await run({ ...s.applyOpts, ...fixturePeerFlags({ blackSwan: 1 }) }, { probes: OK_PROBES, emitter });
    const lowest = Math.min(...res.report.emits.items.filter((i) => i.table === "memories").map((i) => i.key.id));
    exec(s.target, "DELETE FROM sync_outbox WHERE table_name = 'memories'");
    for (const it of res.report.emits.items) if (it.table === "memories") { it.status = "pending"; it.lamport = null; }
    writeFileSync(s.applyOpts.report, JSON.stringify(res.report));
    const overlap = await run({ mode: "emit-only", target: s.target, report: s.applyOpts.report, expectSha: s.applyOpts.expectSha,
      ...fixturePeerFlags({ blackSwan: lowest }) }, { emitter, probes: OK_PROBES });
    assert.equal(overlap.exitCode, 0);
    assert.ok(overlap.report.emits.items.filter((i) => i.table === "memories").every((i) => i.status === "gated" && /peer-id-overlap/.test(i.reason)));
    assert.equal(query(s.target, "SELECT COUNT(*) AS n FROM sync_outbox WHERE table_name = 'memories'")[0].n, 0);
    const clear = await run({ mode: "emit-only", target: s.target, report: s.applyOpts.report, expectSha: s.applyOpts.expectSha,
      ...fixturePeerFlags({ blackSwan: lowest - 1 }) }, { emitter, probes: OK_PROBES });
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
      run({ ...s.applyOpts, importMedia: true }, { probes: OK_PROBES, emitter, failAfterTables: 20 }),
      /injected failure after 20 tables/,
    );
    assert.deepEqual(counts(s.target), before);
    assert.equal(query(s.target, "SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'media_playlists'")[0].n, 0, "bundle init rolled back too");
    assert.equal(query(s.target, "SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'sync_outbox'")[0].n, 0, "phase B never ran");
  });
});

/* ------------------------------------------------------- idempotency / I8 */

describe("idempotency and emit-only", () => {
  it("a second apply is a no-op: nothing inserted, counts and outbox unchanged", async () => {
    const s = await setup();
    const first = await run({ ...s.applyOpts, importMedia: true, importDataDashboard: true }, { probes: OK_PROBES, emitter });
    assert.equal(first.exitCode, 0);
    const mid = counts(s.target);
    copyFileSync(s.target, s.backup); // a fresh cold backup for the second window
    const second = await run({ ...s.applyOpts, importMedia: true, importDataDashboard: true }, { probes: OK_PROBES, emitter });
    assert.equal(second.exitCode, 0, JSON.stringify(second.refused));
    for (const [t, st] of Object.entries(second.report.per_table)) assert.equal(st.inserted, 0, `${t} inserts nothing on re-run`);
    assert.deepEqual(counts(s.target), mid);
    assert.equal(second.report.emits.items.length, 0);
  });

  it("emit-only twice adds no outbox rows", async () => {
    const s = await setup();
    const res = await run(s.applyOpts, { probes: OK_PROBES, emitter });
    assert.equal(res.exitCode, 0);
    const ob0 = query(s.target, "SELECT table_name, row_json, lamport_ts FROM sync_outbox ORDER BY id");
    for (let i = 0; i < 2; i++) {
      const r = await run({ mode: "emit-only", target: s.target, report: s.applyOpts.report, expectSha: s.applyOpts.expectSha }, { emitter, probes: OK_PROBES });
      assert.equal(r.exitCode, 0, JSON.stringify(r.refused));
    }
    assert.deepEqual(query(s.target, "SELECT table_name, row_json, lamport_ts FROM sync_outbox ORDER BY id"), ob0);
  });

  it("emit-only --requeue re-queues an item whose outbox row is gone, keeping its lamport", async () => {
    const s = await setup();
    await run(s.applyOpts, { probes: OK_PROBES, emitter });
    const victim = query(s.target, "SELECT id, lamport_ts FROM sync_outbox WHERE table_name = 'ramble_cells' LIMIT 1")[0];
    exec(s.target, `DELETE FROM sync_outbox WHERE id = ${victim.id}`);
    const r = await run({ mode: "emit-only", target: s.target, report: s.applyOpts.report, expectSha: s.applyOpts.expectSha, requeue: true }, { emitter, probes: OK_PROBES });
    assert.equal(r.exitCode, 0);
    assert.equal(query(s.target, "SELECT COUNT(*) AS n FROM sync_outbox WHERE table_name = 'ramble_cells' AND lamport_ts = ?", victim.lamport_ts)[0].n, 1);
  });

  it("I8: a crash mid phase B leaves a per-item report; emit-only finishes without re-queuing what was queued", async () => {
    const s = await setup();
    let calls = 0;
    const crashing = { emitOrQueue: async (...a) => { if (++calls === 4) throw new Error("deadman SIGTERM (simulated)"); return emitOrQueue(...a); } };
    await assert.rejects(run(s.applyOpts, { probes: OK_PROBES, emitter: crashing }), /deadman SIGTERM/);
    const saved = JSON.parse(readFileSync(s.applyOpts.report, "utf8"));
    assert.equal(saved.phase_a, "committed");
    assert.equal(saved.emits.items.filter((i) => i.status === "queued").length, 3, "the 3 queued items were saved with their lamports");
    const before = query(s.target, "SELECT COUNT(*) AS n FROM sync_outbox")[0].n;
    assert.equal(before, 3);
    const r = await run({ mode: "emit-only", target: s.target, report: s.applyOpts.report, expectSha: s.applyOpts.expectSha }, { emitter, probes: OK_PROBES });
    assert.equal(r.exitCode, 0);
    assert.equal(query(s.target, "SELECT COUNT(*) AS n FROM sync_outbox")[0].n, 13, "10 more, none twice");
    const dup = query(s.target, "SELECT table_name, row_json, COUNT(*) AS n FROM sync_outbox GROUP BY table_name, row_json HAVING n > 1");
    assert.deepEqual(dup, []);
  });

  it("I8: emit-only refuses a plan report, another target's report, a wrong sha, and a root run", async () => {
    const s = await setup();
    await run({ ...s.applyOpts, mode: "plan", backupOk: undefined }, { emitter });
    const plan = await run({ mode: "emit-only", target: s.target, report: s.applyOpts.report, expectSha: s.applyOpts.expectSha }, { emitter, probes: OK_PROBES });
    assert.equal(plan.exitCode, 2);
    assert.match(plan.refused.join("\n"), /mode 'plan', not apply/);

    await run(s.applyOpts, { probes: OK_PROBES, emitter });
    const other = join(s.root, "other.db");
    copyFileSync(s.target, other);
    const wrongTarget = await run({ mode: "emit-only", target: other, report: s.applyOpts.report, expectSha: s.applyOpts.expectSha }, { emitter, probes: OK_PROBES });
    assert.equal(wrongTarget.exitCode, 2);
    assert.match(wrongTarget.refused.join("\n"), /report is for target/);
    const wrongSha = await run({ mode: "emit-only", target: s.target, report: s.applyOpts.report, expectSha: "1".repeat(64) }, { emitter, probes: OK_PROBES });
    assert.equal(wrongSha.exitCode, 2);
    assert.match(wrongSha.refused.join("\n"), /!= the report's source_sha/);
    const root = await run({ mode: "emit-only", target: s.target, report: s.applyOpts.report, expectSha: s.applyOpts.expectSha }, { emitter, probes: { ...OK_PROBES, uid: () => 0 } });
    assert.equal(root.exitCode, 2);
    assert.match(root.refused.join("\n"), /running as root/);
  });
});

/* ------------------------------------------- bot world roots (IMPORTER-BOT-PATHS) */

describe("pi bot definitions: world roots rebase onto the target", () => {
  const GRACKLE_ROOT = "/home/alex/.crow-mpa/pi-bots/home-search";
  const DEF = JSON.stringify({
    engine: "pi",
    session_dir: GRACKLE_ROOT,
    permission_policy: {
      bash: "deny",
      write_paths: [GRACKLE_ROOT, `${GRACKLE_ROOT}/outputs`, "/srv/shared-projects/alpha"],
      read_paths: [`${GRACKLE_ROOT}/notes/`],
    },
  });

  it("unit: session_dir and every path under it move; foreign paths are kept and reported", () => {
    const r = rebaseBotDefinition(DEF, "home-search", "/home/alex/.crow");
    const def = JSON.parse(r.definition);
    assert.equal(def.session_dir, "/home/alex/.crow/pi-bots/home-search");
    assert.deepEqual(def.permission_policy.write_paths, [
      "/home/alex/.crow/pi-bots/home-search", "/home/alex/.crow/pi-bots/home-search/outputs", "/srv/shared-projects/alpha",
    ]);
    assert.deepEqual(def.permission_policy.read_paths, ["/home/alex/.crow/pi-bots/home-search/notes"]);
    assert.equal(def.permission_policy.bash, "deny", "other fields untouched");
    assert.equal(r.changes.length, 4);
    assert.deepEqual(r.foreign, [{ field: "permission_policy.write_paths", path: "/srv/shared-projects/alpha" }]);
  });

  it("unit: no session_dir → the root is found in the policy by its /pi-bots/<bot> tail; a sibling bot's path is not", () => {
    const def = { permission_policy: { write_paths: ["/x/.crow/pi-bots/other-bot", "/x/.crow/pi-bots/b1/out"] } };
    const r = rebaseBotDefinition(JSON.stringify(def), "b1", "/t");
    // "/x/.crow/pi-bots/b1/out" does not END in /pi-bots/b1, so no root is inferred.
    assert.equal(r.changes.length, 0);
    const def2 = { permission_policy: { write_paths: ["/x/.crow/pi-bots/other-bot", "/x/.crow/pi-bots/b1"] } };
    const r2 = rebaseBotDefinition(JSON.stringify(def2), "b1", "/t");
    assert.deepEqual(JSON.parse(r2.definition).permission_policy.write_paths, ["/x/.crow/pi-bots/other-bot", "/t/pi-bots/b1"]);
  });

  it("unit: a custom session_dir (not <home>/pi-bots/<bot>) is never treated as the world root", () => {
    const d = JSON.stringify({ session_dir: "/home/alex/projects/foo", permission_policy: { write_paths: ["/home/alex/projects/foo/out"] } });
    const r = rebaseBotDefinition(d, "b1", "/t");
    assert.equal(r.definition, d);
    assert.deepEqual(r.foreign.map((f) => f.field), ["session_dir"]);
    assert.equal(rebaseBotDefinition(DEF, "../evil", "/t").definition, DEF, "unsafe bot id refused");
  });

  it("unit: empty / non-JSON / pathless definitions pass through byte-identical", () => {
    for (const d of ["{}", "not json", null, JSON.stringify({ engine: "pi" })]) {
      assert.equal(rebaseBotDefinition(d, "b", "/t").definition, d);
    }
  });

  it("resolveTargetCrowHome: flag > CROW_HOME > parent of the target data dir", () => {
    const prevHome = process.env.CROW_HOME;
    const prevData = process.env.CROW_DATA_DIR;
    try {
      delete process.env.CROW_HOME;
      process.env.CROW_DATA_DIR = "/srv/inst/data";
      assert.equal(resolveTargetCrowHome({}), "/srv/inst");
      process.env.CROW_HOME = "/srv/home2";
      assert.equal(resolveTargetCrowHome({}), "/srv/home2");
      assert.equal(resolveTargetCrowHome({ targetCrowHome: "/srv/flag" }), "/srv/flag");
    } finally {
      if (prevHome === undefined) delete process.env.CROW_HOME; else process.env.CROW_HOME = prevHome;
      if (prevData === undefined) delete process.env.CROW_DATA_DIR; else process.env.CROW_DATA_DIR = prevData;
    }
  });

  it("apply: the imported row carries the TARGET's world root, still disabled, and the report lists the rebase", async () => {
    const s = await setup();
    exec(s.source, `UPDATE pi_bot_defs SET definition = '${DEF.replace(/'/g, "''")}' WHERE bot_id = 'home-search'`);
    const targetHome = join(s.root, "crow-home");
    const opts = { ...s.applyOpts, expectSha: sha256File(s.source), targetCrowHome: targetHome };
    const res = await run(opts, { probes: OK_PROBES, emitter });
    assert.equal(res.exitCode, 0, JSON.stringify(res.refused));
    const [row] = query(s.target, "SELECT definition, enabled FROM pi_bot_defs WHERE bot_id = 'home-search'");
    assert.equal(row.enabled, 0);
    const def = JSON.parse(row.definition);
    assert.equal(def.session_dir, join(targetHome, "pi-bots", "home-search"));
    assert.ok(!row.definition.includes(".crow-mpa"), "no source world-root path survives");
    assert.ok(def.permission_policy.write_paths.includes("/srv/shared-projects/alpha"), "foreign path kept");
    const rb = res.report.go_no_go.rebased_bot_paths;
    assert.deepEqual(rb.map((b) => b.bot_id), ["home-search"]);
    assert.ok(res.report.warnings.some((w) => /home-search.*\/srv\/shared-projects\/alpha/.test(w)));
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
    assert.deepEqual(fileState(s.target), tgt0);
    assert.ok(!existsSync(s.applyOpts.report));
  });

  it("an unknown argument is a usage error (64)", () => {
    const r = spawnSync(process.execPath, [SCRIPT, "--bogus"], { encoding: "utf8" });
    assert.equal(r.status, 64);
  });
});

// keep the imported ids referenced so a lint pass doesn't drop them
void BLACK_SWAN_ID;
