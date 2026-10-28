/**
 * Fetch-before-cite, peer-originated rows: what another instance sends us is never citable here,
 * and the provenance a note carries stays on the instance that judged it.
 *
 *   - instance sync: research_notes.provenance / quote_found / locator are stripped on emit, and an
 *     un-upgraded or hostile peer's copy of them is dropped on apply AFTER the signature check (the
 *     signature covers the row as sent) and BEFORE _checkConflict (no spurious conflict rows).
 *   - share import (boot.js "source" branch): goes through insertSharedSource, which names real
 *     columns (the old INSERT named citation/notes, which do not exist) and no 0013 column.
 *   - project clone: the bundle never carries fetched text or provenance, and the applied copy is
 *     verified = 0 with no fetch facts.
 *
 * Both inserts run inside initSharingRuntime, which the stdio crow-sharing server also starts
 * without ensureProvenanceSchema, so they must work on a pre-0013 DB (makePre0013Db).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createDbClient } from "../servers/db.js";
import { InstanceSyncManager, EXCLUDED_COLUMNS, INBOUND_DROPPED_COLUMNS } from "../servers/sharing/instance-sync.js";
import { sign } from "../servers/sharing/identity.js";
import { insertSharedSource, SHARED_SUMMARY_MAX, SHARED_CITATION_MAX } from "../servers/sharing/shared-source-insert.js";
import { createCloneBundleHelpers } from "../servers/sharing/clone-bundle.js";
import { deliverPendingShares, initSharingRuntime } from "../servers/sharing/boot.js";
import { registerShareInboxTools } from "../servers/sharing/tools/share-inbox.js";
import { SOURCE_TYPES } from "../servers/research/source-types.js";
import { PROVENANCE_COLUMNS, NOTE_WITHDRAWAL_COLUMNS } from "../servers/research/provenance-schema.js";
import { run as run0013 } from "../scripts/migrations/0013-research-provenance.mjs";
import { makePre0013Db, openFixtureDb } from "./helpers/research-fixtures.js";
import * as ed from "../node_modules/@noble/ed25519/index.js";

const REPO = join(import.meta.dirname, "..");
const dirs = [];
function tmp(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function initDb(prefix) {
  const dir = tmp(prefix);
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir },
    stdio: "pipe",
    cwd: REPO,
  });
  return join(dir, "crow.db");
}

const SYNC_DB = initDb("peer-rows-sync-");

// Every research_notes column that stays on this instance: 0013's provenance plus 0015's
// authorship and withdrawal.
const NOTE_PROV = ["created_by", "locator", "provenance", "quote_found", "withdrawn_at", "withdrawn_by", "withdrawn_reason"];
const SOURCE_FETCH = ["fetch_status", "fetched_at", "final_url", "http_status", "content_sha256",
  "fetched_text", "fetch_error", "verification_method", "verified_by"];
const ALL_0013 = PROVENANCE_COLUMNS.map((c) => c.column);

const TEST_PRIV = Buffer.alloc(32, 0x5d);
const TEST_PUB_HEX = Buffer.from(await ed.getPublicKey(TEST_PRIV)).toString("hex");
const IDENTITY = { ed25519Priv: TEST_PRIV, ed25519Pubkey: TEST_PUB_HEX };
const REMOTE_ID = "cccccccc-0000-0000-0000-00000000a013";

let seq = 0;
function makeManager() {
  const db = createDbClient(SYNC_DB);
  const mgr = new InstanceSyncManager(IDENTITY, db, `peer-rows-test-${++seq}`);
  mgr.feedsDisabled = false;
  const entries = [];
  mgr.outFeeds = new Map([["peer-1", { append: async (e) => { entries.push(e); } }]]);
  return { mgr, db, entries };
}

function signedEntry(table, op, row, lamport_ts, instance_id = REMOTE_ID) {
  const e = { table, op, row, lamport_ts, instance_id };
  e.signature = sign(JSON.stringify(e), IDENTITY.ed25519Priv);
  return e;
}

async function conflictCount(db, rowId) {
  const { rows } = await db.execute({
    sql: "SELECT COUNT(*) AS n FROM sync_conflicts WHERE table_name = 'research_notes' AND row_id = ?",
    args: [String(rowId)],
  });
  return Number(rows[0].n);
}

// better-sqlite3 → the db.execute shape the sharing helpers use (as tests/fts-text-caps.test.js).
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
      const txn = bsDb.transaction((ss) => ss.map((s) => (typeof s === "string" ? executeOne(s, []) : executeOne(s.sql, s.args))));
      return txn(stmts);
    },
    close() { try { bsDb.close(); } catch {} },
  };
}

function columnsOf(bsDb, table) {
  return bsDb.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

/**
 * A pre-0013 fixture with the project tables the clone apply also writes (copied verbatim from a
 * scratch init-db DB, so their shape is the real one). The research tables stay pre-0013.
 */
function pre0013WithProjectTables(prefix) {
  const path = makePre0013Db(join(tmp(prefix), "crow.db"));
  const ref = new Database(initDb(`${prefix}ref-`), { readonly: true });
  const ddl = ref.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name IN ('project_spaces','project_members','project_audit_log','data_backends','storage_files')",
  ).all().map((r) => r.sql);
  ref.close();
  const db = openFixtureDb(path);
  for (const sql of ddl) db.exec(sql);
  return db;
}

// ── instance sync ───────────────────────────────────────────────────────────

test("EXCLUDED_COLUMNS.research_notes strips the provenance and withdrawal columns", () => {
  assert.deepEqual([...EXCLUDED_COLUMNS.research_notes].sort(), NOTE_PROV);
  assert.deepEqual([...INBOUND_DROPPED_COLUMNS.research_notes].sort(), [...NOTE_PROV, "source_id"].sort());
});

test("an emitted research_notes entry carries no provenance keys", async () => {
  const { mgr, entries } = makeManager();
  await mgr.emitChange("research_notes", "insert",
    { id: 1, content: "x", provenance: "fetched", quote_found: 1, locator: "p2",
      created_by: "bot:x", withdrawn_at: "2026-10-28T00:00:00Z", withdrawn_by: "owner", withdrawn_reason: "misquote" });
  assert.equal(entries.length, 1, "exactly one entry on the wire");
  const payload = entries[0].row;
  for (const k of NOTE_PROV) assert.ok(!(k in payload), `payload must not carry ${k}: ${JSON.stringify(payload)}`);
  assert.equal(payload.content, "x");
});

test("a signed inbound note with extra keys still verifies, applies, and never writes provenance", async () => {
  const { mgr, db } = makeManager();

  // Insert: signed over the FULL row, provenance keys included.
  await mgr._applyEntry(REMOTE_ID, signedEntry("research_notes", "insert", {
    id: 7101, content: "peer note", note_type: "quote",
    provenance: "fetched", quote_found: 1, locator: "p1",
  }, 40));
  let row = (await db.execute({ sql: "SELECT * FROM research_notes WHERE id = 7101" })).rows[0];
  assert.ok(row, "the signature verified and the note applied");
  assert.equal(row.content, "peer note");
  assert.equal(row.provenance, null);
  assert.equal(row.quote_found, null);
  assert.equal(row.locator, null);

  // Update on a local note whose provenance is our own judgment: newer lamport applies the
  // content, leaves provenance alone.
  await db.execute({
    sql: "INSERT INTO research_notes (id, content, note_type, provenance, quote_found, locator, lamport_ts) VALUES (7102, 'local', 'quote', 'snippet', 0, 'p9', 10)",
  });
  await mgr._applyEntry(REMOTE_ID, signedEntry("research_notes", "update", {
    id: 7102, content: "edited on the peer", provenance: "fetched", quote_found: 1, locator: "p1",
  }, 50));
  row = (await db.execute({ sql: "SELECT * FROM research_notes WHERE id = 7102" })).rows[0];
  assert.equal(row.content, "edited on the peer", "the update itself applied (LWW)");
  assert.equal(row.provenance, "snippet");
  // the peer's quote_found is never written; the local one is cleared because the text changed
  assert.equal(row.quote_found, null);
  assert.equal(row.locator, "p9");
  assert.equal(await conflictCount(db, 7102), 0);

  // Re-delivery of an older entry that differs ONLY in provenance: equivalent once stripped,
  // so no conflict row.
  await db.execute({
    sql: "INSERT INTO research_notes (id, content, note_type, provenance, lamport_ts) VALUES (7103, 'same', 'note', 'snippet', 100)",
  });
  await mgr._applyEntry(REMOTE_ID, signedEntry("research_notes", "update", {
    id: 7103, content: "same", note_type: "note", provenance: "fetched", quote_found: 1, locator: "p3",
  }, 60));
  row = (await db.execute({ sql: "SELECT * FROM research_notes WHERE id = 7103" })).rows[0];
  assert.equal(row.provenance, "snippet");
  assert.equal(await conflictCount(db, 7103), 0, "a provenance-only difference must not log a conflict");
});

test("a note's source_id is a local FK: null on the wire, never written from a peer", async () => {
  const { mgr, db, entries } = makeManager();
  await mgr.emitChange("research_notes", "insert", { id: 2, content: "x", source_id: 42, project_id: 9 });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].row.source_id, null, "source_id is nulled like project_id");
  assert.equal(entries[0].row.project_id, null);

  const mkSource = async (id, method) => db.execute({
    sql: `INSERT INTO research_sources (id, title, source_type, url, citation_apa, verified, fetch_status, fetched_text, verification_method, verified_by)
          VALUES (?, 'S', 'web_article', ?, 'C', ?, 'fetched', 'We will ship weekly.', ?, ?)`,
    args: [id, `https://example.com/sync-${id}`, method ? 1 : 0, method, method ? "owner" : null],
  });
  await mkSource(7301, "quotes_checked"); // verified: its quotes are on its page
  await mkSource(7302, null);
  await db.execute({
    sql: "INSERT INTO research_notes (id, source_id, content, note_type, quote_found, lamport_ts) VALUES (7311, 7302, 'not on the page', 'quote', 0, 10)",
  });
  // A peer retargets the note at the verified source: the update applies (LWW) but not its source_id.
  await mgr._applyEntry(REMOTE_ID, signedEntry("research_notes", "update", {
    id: 7311, source_id: 7301, content: "not on the page", note_type: "quote",
  }, 50));
  let n = (await db.execute({ sql: "SELECT * FROM research_notes WHERE id = 7311" })).rows[0];
  assert.equal(n.source_id, 7302, "a peer cannot move a note to another local source");
  let s = (await db.execute({ sql: "SELECT * FROM research_sources WHERE id = 7301" })).rows[0];
  assert.equal(s.verification_method, "quotes_checked", "the verified source is untouched");
  assert.equal(s.verified, 1);

  // A peer edits the text of a quote on the verified source: the local check no longer holds.
  await db.execute({
    sql: "INSERT INTO research_notes (id, source_id, content, note_type, quote_found, lamport_ts) VALUES (7312, 7301, 'We will ship weekly.', 'quote', 1, 10)",
  });
  await mgr._applyEntry(REMOTE_ID, signedEntry("research_notes", "update", {
    id: 7312, content: "We will ship hourly.", note_type: "quote",
  }, 60));
  n = (await db.execute({ sql: "SELECT * FROM research_notes WHERE id = 7312" })).rows[0];
  assert.equal(n.content, "We will ship hourly.");
  assert.equal(n.source_id, 7301);
  assert.equal(n.quote_found, null, "the stale quote_found is cleared, not kept as found");
  s = (await db.execute({ sql: "SELECT * FROM research_sources WHERE id = 7301" })).rows[0];
  assert.equal(s.verified, 0, "a quotes_checked source never keeps a quote it did not check");
  assert.equal(s.verification_method, null);

  // An identical newer re-delivery changes nothing and clears nothing.
  await db.execute({ sql: "UPDATE research_sources SET verified = 1, verification_method = 'manual_owner' WHERE id = 7301" });
  await mgr._applyEntry(REMOTE_ID, signedEntry("research_notes", "update", {
    id: 7312, content: "We will ship hourly.", note_type: "quote",
  }, 70));
  s = (await db.execute({ sql: "SELECT * FROM research_sources WHERE id = 7301" })).rows[0];
  assert.equal(s.verification_method, "manual_owner", "only quotes_checked is ever cleared");
});

test("inbound notes never write the withdrawal columns", async () => {
  const { mgr, db } = makeManager();
  // Signed over the FULL row: a peer (or a hostile one) claims a local bot wrote it and that it
  // was withdrawn. The signature still verifies, the note applies, and none of it is stored.
  await mgr._applyEntry(REMOTE_ID, signedEntry("research_notes", "insert", {
    id: 7401, content: "peer note", note_type: "quote",
    created_by: "bot:x", withdrawn_at: "2026-10-28T00:00:00Z", withdrawn_by: "bot:x", withdrawn_reason: "peer says so",
  }, 40));
  const row = (await db.execute({ sql: "SELECT * FROM research_notes WHERE id = 7401" })).rows[0];
  assert.ok(row, "the signature verified and the note applied");
  assert.equal(row.content, "peer note");
  assert.equal(row.created_by, null, "bot x is never this note's author here");
  assert.equal(row.withdrawn_at, null);
  assert.equal(row.withdrawn_by, null);
  assert.equal(row.withdrawn_reason, null);
});

test("a peer edit leaves a withdrawn note alone", async () => {
  const { mgr, db } = makeManager();
  const mkVerified = async (id) => db.execute({
    sql: `INSERT INTO research_sources (id, title, source_type, url, citation_apa, verified, fetch_status, fetched_text, verification_method, verified_by)
          VALUES (?, 'S', 'web_article', ?, 'C', 1, 'fetched', 'We will ship weekly.', 'quotes_checked', 'owner')`,
    args: [id, `https://example.com/wd-${id}`],
  });
  const source = async (id) => (await db.execute({ sql: "SELECT verified, verification_method FROM research_sources WHERE id = ?", args: [id] })).rows[0];
  const note = async (id) => (await db.execute({ sql: "SELECT content, quote_found FROM research_notes WHERE id = ?", args: [id] })).rows[0];

  // Withdrawn here: its quote_found is frozen and it no longer counts toward the verification.
  await mkVerified(7501);
  await db.execute({
    sql: `INSERT INTO research_notes (id, source_id, content, note_type, quote_found, withdrawn_at, withdrawn_by, withdrawn_reason, lamport_ts)
          VALUES (7511, 7501, 'We will ship weekly.', 'quote', 1, '2026-10-28T00:00:00Z', 'owner', 'misquote', 10)`,
  });
  await mgr._applyEntry(REMOTE_ID, signedEntry("research_notes", "update", {
    id: 7511, content: "We will ship hourly.", note_type: "quote",
  }, 50));
  assert.deepEqual({ ...(await note(7511)) }, { content: "We will ship hourly.", quote_found: 1 }, "the edit applied, quote_found untouched");
  assert.deepEqual({ ...(await source(7501)) }, { verified: 1, verification_method: "quotes_checked" }, "still verified");

  // Control: the same edit on a live note still invalidates.
  await mkVerified(7502);
  await db.execute({
    sql: "INSERT INTO research_notes (id, source_id, content, note_type, quote_found, lamport_ts) VALUES (7512, 7502, 'We will ship weekly.', 'quote', 1, 10)",
  });
  await mgr._applyEntry(REMOTE_ID, signedEntry("research_notes", "update", {
    id: 7512, content: "We will ship hourly.", note_type: "quote",
  }, 50));
  assert.deepEqual({ ...(await note(7512)) }, { content: "We will ship hourly.", quote_found: null });
  assert.deepEqual({ ...(await source(7502)) }, { verified: 0, verification_method: null });
});

test("_invalidateNoteQuoteCheck still invalidates on a pre-0015 DB (no withdrawn_at)", async () => {
  const path = makePre0013Db(join(tmp("peer-rows-pre0015-"), "crow.db"));
  assert.equal(run0013({ dbPath: path, log: () => {} }).applied, true);
  const fx = openFixtureDb(path);
  try {
    assert.ok(!columnsOf(fx, "research_notes").includes("withdrawn_at"), "fixture is pre-0015");
    // The fixture's note 1 quotes source 1; make that a quotes_checked verification.
    fx.prepare("UPDATE research_sources SET verification_method = 'quotes_checked', verified_by = 'owner' WHERE id = 1").run();
    fx.prepare("UPDATE research_notes SET quote_found = 1, note_type = 'quote' WHERE id = 1").run();
    const mgr = new InstanceSyncManager(IDENTITY, wrapDb(fx), `peer-rows-test-${++seq}`);
    await mgr._invalidateNoteQuoteCheck(
      { id: 1, content: "Something else entirely." },
      { content: "Something the first source said.", note_type: "quote" },
    );
    assert.equal(fx.prepare("SELECT quote_found FROM research_notes WHERE id = 1").get().quote_found, null,
      "the guarded UPDATE failed on the missing column and the unguarded retry ran");
    assert.deepEqual({ ...fx.prepare("SELECT verified, verification_method, verified_by FROM research_sources WHERE id = 1").get() },
      { verified: 0, verification_method: null, verified_by: null });
    assert.equal(fx.prepare("SELECT verified FROM research_sources WHERE id = 2").get().verified, 1, "only the note's source");
  } finally { fx.close(); }
});

// ── share import ────────────────────────────────────────────────────────────

test("the old share-import SQL names columns that do not exist (confirms the boot.js bug)", () => {
  const bs = new Database(initDb("peer-rows-oldsql-"));
  try {
    assert.throws(() => bs.prepare(
      `INSERT INTO research_sources (project_id, title, url, source_type, citation, notes)
                  VALUES (NULL, ?, ?, ?, ?, ?)`,
    ).run("T", "", "other", "", ""), /no column named citation|no such column/);
  } finally { bs.close(); }
});

test("insertSharedSource stores a non-citable row", async () => {
  const bs = new Database(initDb("peer-rows-share-"));
  const db = wrapDb(bs);
  try {
    const id = await insertSharedSource(db, {
      title: "T", url: "https://example.com/a", source_type: "web_article", citation: "C", notes: "N",
    });
    assert.equal(typeof id, "number");
    const row = bs.prepare("SELECT * FROM research_sources WHERE id = ?").get(id);
    assert.equal(row.title, "T");
    assert.equal(row.url, "https://example.com/a");
    assert.equal(row.source_type, "web_article");
    assert.equal(row.citation_apa, "C");
    assert.equal(row.content_summary, "N");
    assert.equal(row.fetch_status, null, "unknown, not citable");
    assert.equal(row.verified, 0);
    assert.equal(row.project_id, null);

    const id2 = await insertSharedSource(db, { source_type: "not-a-type" });
    const row2 = bs.prepare("SELECT * FROM research_sources WHERE id = ?").get(id2);
    assert.equal(row2.source_type, "other");
    assert.equal(row2.citation_apa, "(no citation)");
    assert.equal(row2.title, "Shared source");
    assert.equal(row2.content_summary, null);

    const id3 = await insertSharedSource(db, { title: "x".repeat(1500) });
    assert.equal(bs.prepare("SELECT length(title) AS n FROM research_sources WHERE id = ?").get(id3).n, 1000);

    // The peer-supplied summary is capped like a clone's (it is FTS-indexed too).
    assert.equal(SHARED_SUMMARY_MAX, 50000);
    const id4 = await insertSharedSource(db, { notes: "s".repeat(SHARED_SUMMARY_MAX + 5000) });
    const sum = bs.prepare("SELECT content_summary FROM research_sources WHERE id = ?").get(id4).content_summary;
    assert.ok(sum.startsWith("s".repeat(SHARED_SUMMARY_MAX)));
    assert.ok(sum.length < SHARED_SUMMARY_MAX + 100, `capped (${sum.length})`);
    assert.match(sum, /\[truncated at share import: original 55000 chars\]$/);
    const id5 = await insertSharedSource(db, { notes: "s".repeat(SHARED_SUMMARY_MAX) });
    assert.equal(bs.prepare("SELECT length(content_summary) AS n FROM research_sources WHERE id = ?").get(id5).n, SHARED_SUMMARY_MAX, "at the cap: unchanged");
  } finally { bs.close(); }

  // No 0013 column named: it works on a pre-0013 DB.
  const fx = openFixtureDb(makePre0013Db(join(tmp("peer-rows-share-pre-"), "crow.db")));
  try {
    const cols = columnsOf(fx, "research_sources");
    for (const c of ALL_0013) assert.ok(!cols.includes(c), `fixture is pre-0013 (has ${c})`);
    const id = await insertSharedSource(wrapDb(fx), { title: "Old shape", citation: "C" });
    const row = fx.prepare("SELECT * FROM research_sources WHERE id = ?").get(id);
    assert.equal(row.title, "Old shape");
    assert.equal(row.verified, 0);
  } finally { fx.close(); }
});

test("SOURCE_TYPES matches the research_sources CHECK constraint", () => {
  assert.ok(Object.isFrozen(SOURCE_TYPES));
  const bs = new Database(initDb("peer-rows-types-"));
  try {
    const ddl = bs.prepare("SELECT sql FROM sqlite_master WHERE name = 'research_sources'").get().sql;
    const inCheck = ddl.match(/source_type IN \(([^)]*)\)/)[1].match(/'([^']+)'/g).map((s) => s.slice(1, -1));
    assert.deepEqual([...SOURCE_TYPES].sort(), inCheck.sort());
  } finally { bs.close(); }
});

test("a multi-line shared citation is flattened to one line, marker included", async () => {
  const bs = new Database(initDb("peer-rows-oneline-"));
  const db = wrapDb(bs);
  try {
    const long = `Line one\n\nLine two\r\n${"c".repeat(SHARED_CITATION_MAX + 500)}`;
    const id = await insertSharedSource(db, { citation_apa: long, content_summary: "keep\nlines" });
    const row = bs.prepare("SELECT citation_apa, content_summary FROM research_sources WHERE id = ?").get(id);
    assert.ok(!/[\r\n]/.test(row.citation_apa), "no newline in the citation");
    assert.ok(row.citation_apa.startsWith("Line one Line two "));
    assert.match(row.citation_apa, / \[truncated at share import: original \d+ chars\]$/);
    assert.equal(row.content_summary, "keep\nlines", "the summary keeps its lines");
  } finally { bs.close(); }
});

test("a share preview note count skips withdrawn notes", async () => {
  const { bs, sid } = seedPlainShare("peer-rows-notecount");
  try {
    const pid = Number(bs.prepare("INSERT INTO project_spaces (uuid, slug, name, type) VALUES ('u-nc', 'nc-proj', 'NC', 'general')").run().lastInsertRowid);
    bs.prepare("INSERT INTO project_members (project_id, contact_id, role) VALUES (?, NULL, 'owner')").run(pid);
    bs.prepare("INSERT INTO research_notes (project_id, content, note_type) VALUES (?, 'live', 'note')").run(pid);
    bs.prepare("INSERT INTO research_notes (project_id, content, note_type, withdrawn_at) VALUES (?, 'gone', 'note', '2026-10-28T00:00:00Z')").run(pid);
    bs.prepare("INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey) VALUES ('crow:ncpeer', 'NC', 'ed-n', 'secp-n')").run();
    const handlers = {};
    registerShareInboxTools({ tool: (name, _d, _s, h) => { handlers[name] = h; } }, {
      db: wrapDb(bs), identity: { crowId: "crow:self" },
      peerManager: { isConnected: () => true, send: () => {} },
      buildProjectCloneBundle: async () => { throw new Error("not a clone"); },
    });
    const preview = await handlers.crow_share({ contact: "crow:ncpeer", share_type: "project", item_id: pid, permissions: "read", confirm_token: "", sharing_mode: "clone" });
    assert.match(preview.content[0].text, /Bundle: \d+ sources, 1 notes,/, preview.content[0].text);
  } finally { bs.close(); }
});

test("boot.js imports through insertSharedSource", () => {
  const src = readFileSync(join(REPO, "servers/sharing/boot.js"), "utf8");
  assert.ok(src.includes("insertSharedSource("), "boot.js calls insertSharedSource");
  assert.ok(!src.includes("citation, notes)"), "the broken column list is gone");
});

// ── project clone ───────────────────────────────────────────────────────────

test("a clone bundle never carries fetched text or provenance", async () => {
  const bs = new Database(initDb("peer-rows-bundle-"));
  try {
    const pid = Number(bs.prepare(
      "INSERT INTO project_spaces (uuid, slug, name, type) VALUES ('u-proj-bundle', 'bundle-proj', 'Bundle', 'general')",
    ).run().lastInsertRowid);
    const sid = Number(bs.prepare(
      `INSERT INTO research_sources (project_id, title, source_type, url, citation_apa, verified,
         fetch_status, fetched_at, final_url, http_status, content_sha256, fetched_text, fetch_error,
         verification_method, verified_by)
       VALUES (?, 'Fetched', 'web_article', 'https://example.com/f', 'C', 1,
         'fetched', '2026-10-28T00:00:00Z', 'https://example.com/f', 200, 'abc', ?, NULL,
         'quotes_checked', 'owner')`,
    ).run(pid, "t".repeat(1000)).lastInsertRowid);
    bs.prepare(
      "INSERT INTO research_notes (project_id, source_id, content, note_type, provenance, quote_found, locator) VALUES (?, ?, 'q', 'quote', 'fetched', 1, 'p2')",
    ).run(pid, sid);

    const { buildProjectCloneBundle } = createCloneBundleHelpers({ db: wrapDb(bs) });
    const bundle = await buildProjectCloneBundle(pid);
    assert.equal(bundle.sources.length, 1);
    assert.equal(bundle.notes.length, 1);
    for (const k of SOURCE_FETCH) assert.ok(!(k in bundle.sources[0]), `bundle source must not carry ${k}`);
    for (const k of NOTE_PROV) assert.ok(!(k in bundle.notes[0]), `bundle note must not carry ${k}`);
    assert.equal(bundle.sources[0].title, "Fetched", "the rest of the source still ships");
    assert.equal(bundle.notes[0].content, "q");
  } finally { bs.close(); }
});

test("a clone bundle skips withdrawn notes and note.withdraw audit rows", async () => {
  const bs = new Database(initDb("peer-rows-bundle-wd-"));
  try {
    const pid = Number(bs.prepare(
      "INSERT INTO project_spaces (uuid, slug, name, type) VALUES ('u-proj-wd', 'wd-proj', 'Withdrawn', 'general')",
    ).run().lastInsertRowid);
    bs.prepare("INSERT INTO research_notes (project_id, content, note_type, created_by) VALUES (?, 'live', 'note', 'owner')").run(pid);
    bs.prepare(
      `INSERT INTO research_notes (project_id, content, note_type, created_by, withdrawn_at, withdrawn_by, withdrawn_reason)
       VALUES (?, 'gone', 'quote', 'bot:x', '2026-10-28T00:00:00Z', 'owner', 'misquote')`,
    ).run(pid);
    const audit = bs.prepare("INSERT INTO project_audit_log (project_id, actor_type, actor_id, action, target) VALUES (?, 'local', 'owner', ?, ?)");
    audit.run(pid, "note.add", "note:1");
    audit.run(pid, "note.withdraw", "note:2");

    const { buildProjectCloneBundle } = createCloneBundleHelpers({ db: wrapDb(bs) });
    const bundle = await buildProjectCloneBundle(pid);
    assert.equal(bundle.notes.length, 1);
    assert.equal(bundle.notes[0].content, "live");
    for (const k of NOTE_PROV) assert.ok(!(k in bundle.notes[0]), `bundle note must not carry ${k}`);
    assert.ok(bundle.audit_log.some((r) => r.action === "note.add"), "other audit rows still ship");
    assert.ok(!bundle.audit_log.some((r) => r.action === "note.withdraw"), "no note.withdraw audit row ships");
  } finally { bs.close(); }

  // A pre-0015 DB (no withdrawn_at) still builds a bundle.
  const fx = pre0013WithProjectTables("peer-rows-bundle-pre0015-");
  try {
    const pid = Number(fx.prepare(
      "INSERT INTO project_spaces (uuid, slug, name, type) VALUES ('u-proj-pre', 'pre-proj', 'Pre', 'general')",
    ).run().lastInsertRowid);
    fx.prepare("UPDATE research_notes SET project_id = ? WHERE id = 1").run(pid);
    const { buildProjectCloneBundle } = createCloneBundleHelpers({ db: wrapDb(fx) });
    const bundle = await buildProjectCloneBundle(pid);
    assert.equal(bundle.notes.length, 1);
  } finally { fx.close(); }
});

function cloneBundle(slug) {
  return {
    bundle_version: 1,
    project: { name: `Peer clone ${slug}`, slug, description: null, type: "general", tags: null },
    sources: [{ id: 5, title: "S", source_type: "web_article", url: "https://example.com/s",
      verified: 1, verification_notes: "peer said",
      // a hostile or future peer may still send these; the clone insert never names them
      fetch_status: "fetched", verification_method: "quotes_checked", verified_by: "peer" }],
    notes: [{ id: 9, source_id: 5, content: "n", note_type: "quote", provenance: "fetched", quote_found: 1, locator: "p1" }],
    audit_log: [],
    backends: [],
    file_manifest: [],
    origin_instance_id: "test-origin",
    snapshot_at: new Date().toISOString(),
  };
}

test("a cloned source is never verified or citable here", async () => {
  const bs = new Database(initDb("peer-rows-clone-"));
  try {
    const { applyProjectCloneBundle } = createCloneBundleHelpers({ db: wrapDb(bs) });
    const res = await applyProjectCloneBundle(cloneBundle("peer-clone-a"), null);
    const row = bs.prepare("SELECT * FROM research_sources WHERE project_id = ?").get(res.project_id);
    assert.equal(row.verified, 0);
    assert.equal(row.verification_notes, "peer said", "only verified is reset");
    assert.equal(row.fetch_status, null);
    assert.equal(row.verification_method, null);
    assert.equal(row.verified_by, null);
    const note = bs.prepare("SELECT * FROM research_notes WHERE project_id = ?").get(res.project_id);
    assert.equal(note.source_id, row.id);
    assert.equal(note.provenance, null);
    assert.equal(note.quote_found, null);
    assert.equal(note.locator, null);
  } finally { bs.close(); }

  const fx = pre0013WithProjectTables("peer-rows-clone-pre-");
  try {
    assert.ok(!columnsOf(fx, "research_sources").includes("fetch_status"), "fixture is pre-0013");
    const { applyProjectCloneBundle } = createCloneBundleHelpers({ db: wrapDb(fx) });
    const res = await applyProjectCloneBundle(cloneBundle("peer-clone-b"), null);
    const row = fx.prepare("SELECT * FROM research_sources WHERE project_id = ?").get(res.project_id);
    assert.equal(row.title, "S");
    assert.equal(row.verified, 0);
  } finally { fx.close(); }
});

// ── plain (event-style) shares ──────────────────────────────────────────────

// A fetched source and a provenance-carrying note on a real DB, plus a contact to share with.
function seedPlainShare(prefix) {
  const bs = new Database(initDb(prefix));
  const pid = Number(bs.prepare(
    "INSERT INTO project_spaces (uuid, slug, name, type) VALUES (?, ?, 'Plain', 'general')",
  ).run(`u-${prefix}`, prefix).lastInsertRowid);
  const sid = Number(bs.prepare(
    `INSERT INTO research_sources (project_id, title, source_type, url, citation_apa, verified,
       fetch_status, fetched_at, final_url, http_status, content_sha256, fetched_text, fetch_error,
       verification_method, verified_by)
     VALUES (?, 'Fetched', 'web_article', 'https://example.com/p', 'C', 1,
       'fetched', '2026-10-28T00:00:00Z', 'https://example.com/p', 200, 'abc', ?, NULL,
       'quotes_checked', 'owner')`,
  ).run(pid, "t".repeat(1000)).lastInsertRowid);
  const nid = Number(bs.prepare(
    "INSERT INTO research_notes (project_id, source_id, content, note_type, provenance, quote_found, locator, created_by) VALUES (?, ?, 'q', 'quote', 'fetched', 1, 'p2', 'bot:x')",
  ).run(pid, sid).lastInsertRowid);
  const cid = Number(bs.prepare(
    "INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey) VALUES ('crow:plainpeer', 'Peer', 'ed-p', 'secp-p')",
  ).run().lastInsertRowid);
  return { bs, sid, nid, cid };
}

function assertNo0013(payload, table) {
  for (const { table: t, column } of [...PROVENANCE_COLUMNS, ...NOTE_WITHDRAWAL_COLUMNS]) {
    if (t === table) assert.ok(!(column in payload), `a plain ${table} share must not carry ${column}`);
  }
}

test("a plain crow_share of a source or note sends none of the 0013 columns", async () => {
  const { bs, sid, nid } = seedPlainShare("peer-rows-plain-live");
  try {
    const sent = [];
    const handlers = {};
    registerShareInboxTools({ tool: (name, _d, _s, h) => { handlers[name] = h; } }, {
      db: wrapDb(bs),
      identity: { crowId: "crow:self" },
      peerManager: { isConnected: () => true, send: (_to, msg) => { sent.push(msg); } },
      buildProjectCloneBundle: async () => { throw new Error("not a clone"); },
    });
    for (const [share_type, item_id] of [["source", sid], ["note", nid]]) {
      const args = { contact: "crow:plainpeer", share_type, item_id, permissions: "read" };
      const preview = await handlers.crow_share({ ...args, confirm_token: "" });
      const token = preview.content[0].text.match(/confirm_token: "([^"]+)"/)[1];
      const res = await handlers.crow_share({ ...args, confirm_token: token });
      assert.ok(!res.isError, res.content[0].text);
    }
    assert.equal(sent.length, 2);
    assert.equal(sent[0].payload.title, "Fetched", "the rest of the source still ships");
    assertNo0013(sent[0].payload, "research_sources");
    assert.equal(sent[1].payload.content, "q");
    assertNo0013(sent[1].payload, "research_notes");
  } finally { bs.close(); }
});

test("a queued plain share of a source or note redelivers none of the 0013 columns", async () => {
  const { bs, sid, nid, cid } = seedPlainShare("peer-rows-plain-queued");
  try {
    for (const [t, id] of [["source", sid], ["note", nid]]) {
      bs.prepare(
        "INSERT INTO shared_items (contact_id, share_type, item_id, permissions, direction, delivery_status) VALUES (?, ?, ?, 'read', 'sent', 'pending')",
      ).run(cid, t, id);
    }
    const sent = [];
    await deliverPendingShares({
      db: wrapDb(bs),
      peerManager: { send: (_to, msg) => { sent.push(msg); } },
      contact: { id: cid, crow_id: "crow:plainpeer" },
      identityCrowId: "crow:self",
      buildProjectCloneBundle: async () => { throw new Error("not a clone"); },
    });
    assert.equal(sent.length, 2);
    const bySType = Object.fromEntries(sent.map((m) => [m.share_type, m.payload]));
    assert.equal(bySType.source.title, "Fetched");
    assertNo0013(bySType.source, "research_sources");
    assert.equal(bySType.note.content, "q");
    assertNo0013(bySType.note, "research_notes");
  } finally { bs.close(); }
});

// ── share import: citation and summary arrive (D7) ──────────────────────────

function stubSharingManagers(db) {
  return {
    db,
    identity: { crowId: "crow:local-test", secp256k1Pubkey: "a".repeat(64), secp256k1Priv: new Uint8Array(32) },
    peerManager: {
      start: () => Promise.resolve(),
      joinContact: async () => {},
      joinInstanceSync: async () => {},
    },
    syncManager: { initContact: async () => {} },
    instanceSyncManager: { localInstanceId: "inst-test", feedsDisabled: true },
    nostrManager: {
      subscribeToContact: async () => {},
      subscribeToIncoming: async () => {},
    },
  };
}

const CITE = "Doe, J. (2026). Title. example.com.";
const SUMMARY = "What the page says.";

async function receiveShare(msg) {
  const rdir = tmp("peer-rows-recv-");
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: rdir }, stdio: "pipe", cwd: REPO,
  });
  const rdb = createDbClient(join(rdir, "crow.db"));
  await rdb.execute({
    sql: "INSERT INTO contacts (crow_id, display_name, ed25519_pubkey, secp256k1_pubkey, is_blocked) VALUES ('crow:self', 'Self', 'ed-s', ?, 0)",
    args: ["b".repeat(64)],
  });
  const managers = stubSharingManagers(rdb);
  await initSharingRuntime(managers, { applyProjectCloneBundle: async () => {}, buildProjectCloneBundle: async () => {} });
  await managers.peerManager.onPeerData("crow:self", msg);
  const row = (await rdb.execute("SELECT * FROM research_sources ORDER BY id DESC LIMIT 1")).rows[0];
  const hit = (await rdb.execute({ sql: "SELECT rowid FROM sources_fts WHERE sources_fts MATCH 'Doe'", args: [] })).rows;
  return { row, hit };
}

function assertArrived({ row, hit }) {
  assert.ok(row, "a source row arrived");
  assert.equal(row.citation_apa, CITE);
  assert.equal(row.content_summary, SUMMARY);
  assert.equal(row.project_id, null);
  assert.equal(row.verified, 0);
  assert.equal(row.fetch_status, null);
  assert.ok(hit.some((h) => Number(h.rowid) === Number(row.id)), "findable through sources_fts");
}

test("a plain source share arrives with its citation and summary (live send → receive)", async () => {
  const { bs, sid } = seedPlainShare("peer-rows-arrive-live");
  try {
    bs.prepare("UPDATE research_sources SET citation_apa = ?, content_summary = ? WHERE id = ?").run(CITE, SUMMARY, sid);
    const sent = [];
    const handlers = {};
    registerShareInboxTools({ tool: (name, _d, _s, h) => { handlers[name] = h; } }, {
      db: wrapDb(bs),
      identity: { crowId: "crow:self" },
      peerManager: { isConnected: () => true, send: (_to, msg) => { sent.push(msg); } },
      buildProjectCloneBundle: async () => { throw new Error("not a clone"); },
    });
    const args = { contact: "crow:plainpeer", share_type: "source", item_id: sid, permissions: "read" };
    const preview = await handlers.crow_share({ ...args, confirm_token: "" });
    const token = preview.content[0].text.match(/confirm_token: "([^"]+)"/)[1];
    const res = await handlers.crow_share({ ...args, confirm_token: token });
    assert.ok(!res.isError, res.content[0].text);
    assert.equal(sent.length, 1);
    assertArrived(await receiveShare(sent[0]));
  } finally { bs.close(); }
});

test("a queued source share arrives with its citation and summary (deliverPendingShares → receive)", async () => {
  const { bs, sid, cid } = seedPlainShare("peer-rows-arrive-queued");
  try {
    bs.prepare("UPDATE research_sources SET citation_apa = ?, content_summary = ? WHERE id = ?").run(CITE, SUMMARY, sid);
    bs.prepare(
      "INSERT INTO shared_items (contact_id, share_type, item_id, permissions, direction, delivery_status) VALUES (?, 'source', ?, 'read', 'sent', 'pending')",
    ).run(cid, sid);
    const sent = [];
    await deliverPendingShares({
      db: wrapDb(bs),
      peerManager: { send: (_to, msg) => { sent.push(msg); } },
      contact: { id: cid, crow_id: "crow:plainpeer" },
      identityCrowId: "crow:self",
      buildProjectCloneBundle: async () => { throw new Error("not a clone"); },
    });
    assert.equal(sent.length, 1);
    assertArrived(await receiveShare(sent[0]));
  } finally { bs.close(); }
});

test("insertSharedSource prefers the real fields, keeps the legacy ones, and caps both", async () => {
  const bs = new Database(initDb("peer-rows-fields-"));
  const db = wrapDb(bs);
  const MARK = (n) => `\n[truncated at share import: original ${n} chars]`;
  const get = async (p) => bs.prepare("SELECT * FROM research_sources WHERE id = ?").get(await insertSharedSource(db, p));
  try {
    assert.equal(SHARED_CITATION_MAX, 2000);
    assert.equal((await get({ citation_apa: "A", citation: "B" })).citation_apa, "A");
    assert.equal((await get({ citation_apa: "", citation: "B" })).citation_apa, "B");
    assert.equal((await get({ citation_apa: 42 })).citation_apa, "(no citation)");
    assert.equal((await get({ content_summary: "S", notes: "N" })).content_summary, "S");
    assert.equal((await get({ notes: "N" })).content_summary, "N");

    const big = await get({ citation_apa: "c".repeat(10000) });
    assert.equal(big.citation_apa, "c".repeat(SHARED_CITATION_MAX) + MARK(10000).replace("\n", " "));
    const fts = bs.prepare("SELECT citation_apa FROM sources_fts WHERE rowid = ?").get(big.id);
    assert.equal(fts.citation_apa.length, big.citation_apa.length, "the FTS row is capped too");

    const sum = await get({ content_summary: "s".repeat(SHARED_SUMMARY_MAX + 10) });
    assert.equal(sum.content_summary, "s".repeat(SHARED_SUMMARY_MAX) + MARK(SHARED_SUMMARY_MAX + 10));

    const legacy = await get({ citation: "l".repeat(SHARED_CITATION_MAX + 5) });
    assert.equal(legacy.citation_apa, "l".repeat(SHARED_CITATION_MAX) + MARK(SHARED_CITATION_MAX + 5).replace("\n", " "));
  } finally { bs.close(); }
});
