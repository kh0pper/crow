/**
 * crow_add_note records provenance and checks quotes against the source's fetched text.
 * Fixtures are inserted straight into the scratch crow.db; nothing touches the network.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const ROOT = join(import.meta.dirname, "..");
const HOME = mkdtempSync(join(tmpdir(), "crow-noteprov-"));
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
const { OWNER } = await import("../servers/research/actor.js");
const { FETCHED_TEXT_MAX } = await import("../servers/shared/fetch-page.js");

const text = (r) => (r.content || []).map((c) => c.text).join("\n");
async function connect(server) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(ct);
  return client;
}
const client = await connect(createProjectServer(CORE, { actor: OWNER }));
const addNote = (args) => client.callTool({ name: "crow_add_note", arguments: args });

function raw() { return new Database(CORE); }
function insertSource(cols) {
  const d = raw();
  try {
    const all = { title: "S", source_type: "web_article", citation_apa: "c", ...cols };
    const keys = Object.keys(all);
    return Number(d.prepare(`INSERT INTO research_sources (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`)
      .run(...keys.map((k) => all[k])).lastInsertRowid);
  } finally { d.close(); }
}
const fetchedSource = (fetched_text, status = "fetched") => insertSource({ url: "https://example.com/x", fetch_status: status, fetched_text });
function noteRow(r) {
  const id = Number(text(r).match(/id: (\d+)/)[1]);
  const d = raw();
  try { return d.prepare("SELECT * FROM research_notes WHERE id = ?").get(id); } finally { d.close(); }
}

test("quote and summary notes must state provenance", async () => {
  for (const note_type of ["quote", "summary"]) {
    const r = await addNote({ content: "x", note_type });
    assert.ok(r.isError, text(r));
    assert.match(text(r), /fetched/);
    assert.match(text(r), /snippet/);
    assert.match(text(r), /derived/);
  }
});

test("analysis and insight default to derived; note and question may omit it", async () => {
  for (const note_type of ["analysis", "insight"]) {
    const r = await addNote({ content: "mine", note_type });
    assert.ok(!r.isError, text(r));
    assert.equal(noteRow(r).provenance, "derived");
  }
  for (const note_type of ["question", "note"]) {
    const r = await addNote({ content: "q", note_type });
    assert.ok(!r.isError, text(r));
    assert.equal(noteRow(r).provenance, null);
  }
});

test("provenance fetched needs a source Crow fetched", async () => {
  const none = await addNote({ content: "x", note_type: "summary", provenance: "fetched" });
  assert.ok(none.isError); assert.match(text(none), /needs a source Crow fetched/);
  for (const status of ["failed", "not_applicable", null]) {
    const id = insertSource({ fetch_status: status });
    const r = await addNote({ content: "x", note_type: "summary", provenance: "fetched", source_id: id });
    assert.ok(r.isError, `${status}: ${text(r)}`);
    assert.match(text(r), /needs a source Crow fetched/);
  }
  const ok = await addNote({ content: "x", note_type: "summary", provenance: "fetched", source_id: fetchedSource(null, "fetched_no_text") });
  assert.ok(!ok.isError, text(ok));
  assert.equal(noteRow(ok).provenance, "fetched");
});

test("a correct quote is checked and found", async () => {
  const id = fetchedSource("The committee will meet every Tuesday in the main hall.");
  const r = await addNote({ content: "will meet every Tuesday", note_type: "quote", provenance: "fetched", source_id: id });
  assert.ok(!r.isError, text(r));
  assert.equal(noteRow(r).quote_found, 1);
  assert.match(text(r), /Quote checked: found/);
});

test("a misquote is flagged", async () => {
  const id = fetchedSource("The committee will meet every Tuesday in the main hall.");
  const r = await addNote({ content: "will meet every Friday at dawn", note_type: "quote", provenance: "fetched", source_id: id });
  assert.equal(noteRow(r).quote_found, 0);
  assert.ok(text(r).includes(`WARNING: this quote is NOT on the page Crow fetched (source #${id})`), text(r));
});

test("a quote on a truncated page is not checked (NULL)", async () => {
  const id = fetchedSource("a".repeat(FETCHED_TEXT_MAX));
  const r = await addNote({ content: "words that are nowhere to be seen", note_type: "quote", provenance: "fetched", source_id: id });
  assert.ok(!r.isError, text(r));
  assert.equal(noteRow(r).quote_found, null);
  assert.match(text(r), /not checked/);
});

test("a quote without source_id is NULL", async () => {
  const r = await addNote({ content: "some words", note_type: "quote", provenance: "derived" });
  assert.ok(!r.isError, text(r));
  assert.equal(noteRow(r).quote_found, null);
});

test("a snippet note is stored with a reminder", async () => {
  const r = await addNote({ content: "from a search result", note_type: "summary", provenance: "snippet" });
  assert.ok(!r.isError, text(r));
  assert.equal(noteRow(r).provenance, "snippet");
  assert.ok(text(r).includes("cannot be cited in prose until a fetched source backs it"), text(r));
});

test("a missing source_id is not found", async () => {
  const r = await addNote({ content: "x", note_type: "note", source_id: 999999 });
  assert.ok(r.isError);
  assert.match(text(r), /Source #999999 not found/);
});

test("locator is stored", async () => {
  const r = await addNote({ content: "x", note_type: "note", locator: "p. 4" });
  assert.equal(noteRow(r).locator, "p. 4");
});
