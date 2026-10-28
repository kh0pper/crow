/**
 * crow_withdraw_note: the owner, or the bot that wrote a note, can withdraw it. A withdrawn note
 * stays on record but no longer counts toward a quotes_checked verification or any note count.
 * Fixtures go straight into a scratch crow.db; every fetch goes through an injected stub.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";

const ROOT = join(import.meta.dirname, "..");
const HOME = mkdtempSync(join(tmpdir(), "crow-withdraw-"));
const DATA = join(HOME, ".crow", "data");
mkdirSync(DATA, { recursive: true });
process.env.HOME = HOME;
process.env.CROW_HOME = join(HOME, ".crow");
process.env.CROW_DATA_DIR = DATA;
process.env.CROW_DB_PATH = join(DATA, "crow.db");
after(() => rmSync(HOME, { recursive: true, force: true }));

execFileSync(process.execPath, ["scripts/init-db.js"], { cwd: ROOT, env: process.env, stdio: "pipe" });
const CORE = join(DATA, "crow.db");

const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { createProjectServer } = await import("../servers/research/server.js");
const { OWNER, UNKNOWN, auditActor } = await import("../servers/research/actor.js");
const { makePre0013Db, openFixtureDb } = await import("./helpers/research-fixtures.js");
const { run: run0013 } = await import("../scripts/migrations/0013-research-provenance.mjs");
const { TOOL_MANIFESTS } = await import("../servers/gateway/tool-manifests.js");

const BOT = { kind: "bot", id: "b1" };
const sha = (s) => createHash("sha256").update(s).digest("hex");
const text = (r) => (r.content || []).map((c) => c.text).join("\n");
const PAGE = "The council voted on Tuesday. We will ship weekly, and the budget doubles next year. Nothing else changed.";
const FOUND = "We will ship weekly";
const MISSING = "We will ship monthly forever";
const REFUSED = (id) => `Only the owner or the bot that wrote note #${id} can withdraw it. Tell the owner.`;

function okPage(body) {
  return {
    ok: true, fetch_status: "fetched", final_url: "https://example.com/changed", http_status: 200, content_type: "text/plain",
    text: body, readable_text: body, truncated: false, sha256: sha(body), fetched_at: new Date().toISOString(),
  };
}

async function connect(server) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(ct);
  return client;
}
const clientFor = (actor = OWNER, opts = {}, path = CORE) => connect(createProjectServer(path, { actor, ...opts }));
const owner = await clientFor(OWNER);
const bot = await clientFor(BOT);

function withDb(fn, path = CORE) { const d = new Database(path); try { return fn(d); } finally { d.close(); } }
const source = (id) => withDb((d) => d.prepare("SELECT * FROM research_sources WHERE id = ?").get(id));
const note = (id) => withDb((d) => d.prepare("SELECT * FROM research_notes WHERE id = ?").get(id));
const auditRows = (action, target) => withDb((d) => d.prepare("SELECT * FROM project_audit_log WHERE action = ? AND target = ? ORDER BY id").all(action, target));

let seq = 0;
async function newProject() {
  const r = await owner.callTool({ name: "crow_create_project", arguments: { name: `withdraw-${++seq}` } });
  return Number(text(r).match(/id: (\d+)/)[1]);
}
function insertSource(cols = {}) {
  const full = {
    title: `T${++seq}`, source_type: "web_article", url: `https://example.com/s${seq}`, citation_apa: "x",
    fetch_status: "fetched", fetched_at: new Date().toISOString(), fetched_text: PAGE, content_sha256: sha(PAGE), ...cols,
  };
  const keys = Object.keys(full);
  return withDb((d) => Number(d.prepare(`INSERT INTO research_sources (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`)
    .run(...keys.map((k) => full[k])).lastInsertRowid));
}
function insertNote({ sid = null, pid = null, content = FOUND, type = "quote", by = null, found = null }) {
  return withDb((d) => Number(d.prepare("INSERT INTO research_notes (project_id, source_id, content, note_type, created_by, quote_found, provenance) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(pid, sid, content, type, by, found, type === "quote" ? "fetched" : null).lastInsertRowid));
}
const withdraw = (client, id, reason = "misquote", extra = {}) =>
  client.callTool({ name: "crow_withdraw_note", arguments: { id, reason }, ...extra });
const verify = (client, id) => client.callTool({ name: "crow_verify_source", arguments: { id } });
const noteId = (r) => Number(text(r).match(/id: (\d+)/)[1]);

test("crow_add_note records who wrote it", async () => {
  const unknown = await clientFor(UNKNOWN);
  for (const [client, want] of [[owner, "owner"], [bot, "bot:b1"], [unknown, null]]) {
    const r = await client.callTool({ name: "crow_add_note", arguments: { content: "x", note_type: "note" } });
    assert.ok(!r.isError, text(r));
    assert.equal(note(noteId(r)).created_by, want);
  }
});

test("the owner withdraws a not-found quote and verification then passes", async () => {
  const pid = await newProject();
  const sid = insertSource({ project_id: pid });
  insertNote({ sid, pid, content: FOUND, by: "owner" });
  const b = insertNote({ sid, pid, content: MISSING, by: "owner" });
  const r1 = await verify(owner, sid);
  assert.match(text(r1), /NOT verified/);
  const w = await withdraw(owner, b);
  assert.ok(!w.isError, text(w));
  assert.ok(text(w).startsWith(`Note #${b} withdrawn.`), text(w));
  assert.ok(text(w).includes(` Run crow_verify_source on source #${sid} to check its remaining quotes.`), text(w));
  const r2 = await verify(owner, sid);
  assert.ok(text(r2).startsWith(`Source #${sid} verified: all 1 quote note(s) were found`), text(r2));
});

test("a bot withdraws its own note but not another bot's or the owner's", async () => {
  const pid = await newProject();
  const mine = insertNote({ pid, type: "note", by: "bot:b1" });
  const r = await withdraw(bot, mine);
  assert.ok(!r.isError, text(r));
  assert.equal(note(mine).withdrawn_by, "bot:b1");
  for (const by of ["bot:b2", "owner"]) {
    const id = insertNote({ pid, type: "note", by });
    const before = note(id);
    const x = await withdraw(bot, id);
    assert.equal(x.isError, true, text(x));
    assert.equal(text(x), REFUSED(id));
    assert.deepEqual(note(id), before);
  }
});

test("unknown callers, peers and notes with no author", async () => {
  const pid = await newProject();
  const id = insertNote({ pid, type: "note", by: "bot:b1" });
  const unknown = await clientFor(UNKNOWN);
  const u = await withdraw(unknown, id);
  assert.equal(u.isError, true); assert.equal(text(u), REFUSED(id));
  const p = await withdraw(owner, id, "x", { _meta: { "crow/actor": { kind: "peer" } } });
  assert.equal(p.isError, true); assert.equal(text(p), REFUSED(id));
  assert.equal(note(id).withdrawn_at, null);
  const orphan = insertNote({ pid, type: "note", by: null });
  const b = await withdraw(bot, orphan);
  assert.equal(b.isError, true); assert.equal(text(b), REFUSED(orphan));
  const o = await withdraw(owner, orphan);
  assert.ok(!o.isError, text(o));
  assert.equal(note(orphan).withdrawn_by, "owner");
});

test("a _meta bot claim acts as that bot (accepted, D4)", async () => {
  const pid = await newProject();
  const id = insertNote({ pid, type: "note", by: "bot:b1" });
  const r = await withdraw(owner, id, "x", { _meta: { "crow/actor": { kind: "bot", id: "b1" } } });
  assert.ok(!r.isError, text(r));
  assert.equal(note(id).withdrawn_by, "bot:b1");
});

test("withdrawal needs write_notes on the note's project", async () => {
  const pid = await newProject();
  const id = insertNote({ pid, type: "note", by: "owner" });
  withDb((d) => d.prepare("UPDATE project_members SET capabilities = ? WHERE project_id = ? AND contact_id IS NULL")
    .run(JSON.stringify({ write_notes: false }), pid));
  const r = await withdraw(owner, id);
  assert.equal(r.isError, true, text(r));
  assert.ok(text(r).startsWith("Error:"), text(r));
  assert.equal(note(id).withdrawn_at, null);
});

test("the withdrawal is audited with the caller and reason", async () => {
  const pid = await newProject();
  const sid = insertSource({ project_id: pid });
  insertNote({ sid, pid, content: FOUND, by: "owner", found: 1 });
  const id = insertNote({ sid, pid, content: MISSING, by: "bot:b1", found: 0 });
  const r = await withdraw(bot, id, "misquote");
  assert.ok(!r.isError, text(r));
  const rows = auditRows("note.withdraw", `note:${id}`);
  assert.equal(rows.length, 1);
  const a = auditActor(BOT);
  assert.equal(rows[0].actor_type, a.actor_type);
  assert.equal(rows[0].actor_id, a.actor_id);
  assert.equal(rows[0].project_id, pid);
  const payload = JSON.parse(rows[0].payload);
  assert.equal(payload.reason, "misquote");
  assert.equal(payload.note_type, "quote");
  assert.equal(payload.source_id, sid);
  assert.equal(payload.quote_found, 0);
  const n = note(id);
  assert.ok(!Number.isNaN(Date.parse(n.withdrawn_at)) && n.withdrawn_at.includes("T"), n.withdrawn_at);
  assert.equal(n.withdrawn_by, "bot:b1");
  assert.equal(n.withdrawn_reason, "misquote");
});

test("withdrawing twice is a no-op", async () => {
  const pid = await newProject();
  const id = insertNote({ pid, type: "note", by: "owner" });
  await withdraw(owner, id);
  const at = note(id).withdrawn_at;
  const r = await withdraw(owner, id, "again");
  assert.ok(!r.isError, text(r));
  assert.equal(text(r), `Note #${id} was already withdrawn (${at}).`);
  assert.equal(auditRows("note.withdraw", `note:${id}`).length, 1);
  assert.equal(note(id).withdrawn_reason, "misquote");
});

test("a project-less note withdraws without an audit row and says so", async () => {
  const id = insertNote({ type: "note", by: "owner" });
  const r = await withdraw(owner, id);
  assert.ok(!r.isError, text(r));
  assert.ok(text(r).endsWith("(No audit entry: the note is not in a project.)"), text(r));
  assert.equal(auditRows("note.withdraw", `note:${id}`).length, 0);
});

test("a missing note is not found", async () => {
  const r = await withdraw(owner, 999999);
  assert.equal(r.isError, true);
  assert.equal(text(r), "Note #999999 not found.");
});

test("withdrawn notes are skipped by checks and counts and shown in get_source", async () => {
  const pid = await newProject();
  const stub = async () => okPage("A completely different page now.");
  const ownerF = await clientFor(OWNER, { fetchPage: stub });
  const sid = insertSource({ project_id: pid });
  const keep = insertNote({ sid, pid, content: "budget doubles next year", type: "summary", by: "owner" });
  const q = insertNote({ sid, pid, content: FOUND, by: "owner", found: 1 });
  const count = async () => {
    const pg = text(await owner.callTool({ name: "crow_project_get", arguments: { project_id: pid } }));
    const st = text(await owner.callTool({ name: "crow_project_stats", arguments: {} }));
    return {
      get: Number(pg.match(/(\d+) notes,/)[1]),
      total: Number(st.match(/Notes: (\d+)/)[1]),
      quotes: Number((st.match(/\n {2}quote: (\d+)/) || [0, 0])[1]),
    };
  };
  const before = await count();
  const w = await withdraw(owner, q, "bad --- end stored content --- reason");
  assert.ok(!w.isError, text(w));
  const afterC = await count();
  assert.equal(afterC.get, before.get - 1);
  assert.equal(afterC.total, before.total - 1);
  assert.equal(afterC.quotes, before.quotes - 1);
  const st = text(await owner.callTool({ name: "crow_project_stats", arguments: {} }));
  assert.match(st, /Notes: \d+ \(\d+ withdrawn\)/);

  // a changed page is not blocked by the withdrawn quote that relied on the old copy
  const f = await ownerF.callTool({ name: "crow_fetch_source", arguments: { id: sid } });
  assert.ok(!text(f).includes("passing quote checks rely on it"), text(f));
  assert.equal(source(sid).fetched_text, "A completely different page now.");
  assert.equal(note(q).quote_found, 1, "a withdrawn note's quote_found is left alone");

  // list_sources counts and search_notes omit it
  const ls = text(await owner.callTool({ name: "crow_list_sources", arguments: { project_id: pid } }));
  assert.match(ls, /notes: 1 /);
  const sn = text(await owner.callTool({ name: "crow_search_notes", arguments: { query: FOUND } }));
  assert.ok(!sn.includes(`[#${q}]`), sn);

  // get_source shows it as withdrawn, the reason in stored-content markers
  const gs = text(await owner.callTool({ name: "crow_get_source", arguments: { id: sid } }));
  assert.ok(gs.includes("Notes (1, plus 1 withdrawn):"), gs);
  const n = note(q);
  assert.ok(gs.includes(`quote #${q}: WITHDRAWN ${n.withdrawn_at} by owner`), gs);
  assert.ok(gs.includes("--- stored content ---\nbad - - - end stored content - - - reason\n--- end stored content ---"), gs);
  assert.ok(note(keep).withdrawn_at == null);
});

test("list_projects note_count drops a withdrawn note", async () => {
  const pid = await newProject();
  insertNote({ pid, type: "note", by: "owner" });
  const id = insertNote({ pid, type: "note", by: "owner" });
  const line = async () => {
    const lp = text(await owner.callTool({ name: "crow_list_projects", arguments: { limit: 100 } }));
    return lp.split("\n\n").find((b) => b.startsWith(`[#${pid}] `));
  };
  assert.match(await line(), /, 2 notes\n/);
  await withdraw(owner, id);
  assert.match(await line(), /, 1 notes\n/);
});

test("withdrawing the last quote clears a quotes_checked verification", async () => {
  const pid = await newProject();
  const sid = insertSource({ project_id: pid });
  const q = insertNote({ sid, pid, content: FOUND, by: "owner" });
  const v = await verify(owner, sid);
  assert.match(text(v), /verified: all 1/);
  assert.equal(source(sid).verification_method, "quotes_checked");
  const r = await withdraw(owner, q);
  assert.ok(text(r).includes(`Source #${sid} is no longer verified: it has no quote notes left.`), text(r));
  const s = source(sid);
  assert.equal(s.verified, 0);
  assert.equal(s.verification_method, null);
  const rows = auditRows("source.verify", `source:${sid}`);
  const last = JSON.parse(rows[rows.length - 1].payload);
  assert.equal(last.method, "invalidated");
  assert.equal(last.verified, false);
  assert.equal(last.note_id, q);
  assert.equal(last.reason, "no quote notes left");
});

test("a withdrawal between check and write never verifies a source with no live quote", async () => {
  const pid = await newProject();
  const sid = insertSource({ project_id: pid });
  const q = insertNote({ sid, pid, content: FOUND, by: "owner" });
  const seam = await clientFor(OWNER, {
    beforeVerifyWrite: () => withDb((d) => d.prepare("UPDATE research_notes SET withdrawn_at = ?, withdrawn_by = 'owner', withdrawn_reason = 'race' WHERE id = ?")
      .run(new Date().toISOString(), q)),
  });
  const r = await verify(seam, sid);
  assert.ok(text(r).startsWith("NOT verified: the source changed while it was being checked; try again."), text(r));
  assert.equal(source(sid).verified, 0);
});

test("withdraw degrades alone when its columns are missing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "crow-withdraw-pre-"));
  try {
    const path = makePre0013Db(join(dir, "crow.db"));
    run0013({ dbPath: path, log: () => {} });
    // The fixture leaves out the FK parent tables; the server's client enforces foreign keys.
    withDb((d) => d.exec("CREATE TABLE project_spaces (id INTEGER PRIMARY KEY); CREATE TABLE data_backends (id INTEGER PRIMARY KEY);"), path);
    process.env.CROW_TEST_SKIP_WITHDRAWAL_SCHEMA = "1";
    let server;
    try {
      server = createProjectServer(path, { actor: OWNER, now: () => 0 });
    } finally {
      delete process.env.CROW_TEST_SKIP_WITHDRAWAL_SCHEMA;
    }
    assert.equal(server.research.schema.ready, true);
    assert.equal(server.research.schema.withdrawReady, false);
    const c = await connect(server);
    const cols = withDb((d) => d.prepare("PRAGMA table_info(research_notes)").all().map((x) => x.name), path);
    assert.ok(!cols.includes("withdrawn_at"));

    const fx = openFixtureDb(path);
    let sid;
    try {
      sid = Number(fx.prepare("INSERT INTO research_sources (title, source_type, citation_apa, url, fetch_status, fetched_at, fetched_text, content_sha256) VALUES ('P', 'web_article', 'x', 'https://example.com/p', 'fetched', ?, ?, ?)")
        .run(new Date().toISOString(), PAGE, sha(PAGE)).lastInsertRowid);
    } finally { fx.close(); }
    const add = await c.callTool({ name: "crow_add_note", arguments: { content: FOUND, note_type: "quote", provenance: "fetched", source_id: sid } });
    assert.ok(!add.isError, text(add));
    assert.match(text(add), /Quote checked: found/);
    const v = await c.callTool({ name: "crow_verify_source", arguments: { id: sid } });
    assert.match(text(v), /verified: all \d+ quote note\(s\) were found/);
    for (const [name, args] of [["crow_get_source", { id: sid }], ["crow_list_sources", {}], ["crow_search_notes", { query: "ship" }]]) {
      const r = await c.callTool({ name, arguments: args });
      assert.ok(!r.isError, `${name}: ${text(r)}`);
      assert.ok(!text(r).includes("withdrawn_at"), `${name}: ${text(r)}`);
    }
    const w = await c.callTool({ name: "crow_withdraw_note", arguments: { id: noteId(add), reason: "x" } });
    assert.equal(w.isError, true);
    assert.equal(text(w), "This Crow is waiting for a schema upgrade, so it cannot withdraw notes yet. Try again after the upgrade.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the tool is in the router manifest", () => {
  assert.ok(TOOL_MANIFESTS.projects.tools.crow_withdraw_note);
  assert.equal(TOOL_MANIFESTS.projects.tools.crow_withdraw_note.params, "id, reason");
});

test("the withdraw reply asks for a re-verify only when one is still needed", async () => {
  const pid = await newProject();
  const sid = insertSource({ project_id: pid });
  const q1 = insertNote({ sid, pid, content: FOUND, by: "owner" });
  const q2 = insertNote({ sid, pid, content: "the budget doubles", by: "owner" });
  await verify(owner, sid);
  // One quote left: still verified, so the reply asks for a re-check.
  const r1 = text(await withdraw(owner, q1));
  assert.match(r1, /Run crow_verify_source/);
  assert.ok(!r1.includes("no longer verified"));
  // The last quote: verification cleared, so only the "no longer verified" line.
  const r2 = text(await withdraw(owner, q2));
  assert.ok(!r2.includes("Run crow_verify_source"), r2);
  assert.ok(r2.includes(`Source #${sid} is no longer verified`), r2);
  // A non-quote note: no re-verify prompt need differ, it still names the source.
});

test("search and list show a shared multi-line citation on one line, capped", async () => {
  const pid = await newProject();
  const cite = `First line\nSecond line\n${"w".repeat(2000)}`;
  const sid = insertSource({ project_id: pid, title: "Uniqueshared", citation_apa: cite });
  const s = text(await owner.callTool({ name: "crow_search_sources", arguments: { query: "Uniqueshared" } }));
  const l = text(await owner.callTool({ name: "crow_list_sources", arguments: { project_id: pid } }));
  for (const out of [s, l]) {
    const line = out.split("\n").find((x) => x.startsWith("  APA:"));
    assert.ok(line, out);
    assert.ok(line.length <= 300 + "  APA: ".length, `${line.length}`);
    assert.ok(line.startsWith("  APA: First line Second line"));
    assert.ok(!out.includes("\nSecond line"));
  }
  void sid;
});
