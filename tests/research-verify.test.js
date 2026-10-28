/**
 * crow_verify_source is a real check: the source must exist, the caller must be allowed to write
 * it, and "verified" means every quote note was found on the page Crow fetched (or the owner
 * verified it by hand). Fixtures go straight into the scratch crow.db; every fetch goes through
 * the injected `fetchPage` stub, so nothing touches the network.
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
const HOME = mkdtempSync(join(tmpdir(), "crow-verify-"));
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
const { OWNER, UNKNOWN } = await import("../servers/research/actor.js");
const { createRouterServer } = await import("../servers/gateway/router.js");
const { createToolExecutor } = await import("../servers/gateway/ai/tool-executor.js");

const BOT = { kind: "bot", id: "b1" };
const DAY = 24 * 60 * 60 * 1000;
const sha = (s) => createHash("sha256").update(s).digest("hex");
const text = (r) => (r.content || []).map((c) => c.text).join("\n");

const PAGE = "The council voted on Tuesday. We will ship weekly, and the budget doubles next year. Nothing else changed.";

function okPage(finalUrl, body) {
  return {
    ok: true, fetch_status: "fetched", final_url: finalUrl, http_status: 200, content_type: "text/plain",
    text: body, readable_text: body, truncated: false, sha256: sha(body), fetched_at: new Date().toISOString(),
  };
}
/** A fetchPage stub: canned results by URL, every call recorded. */
function makeStub(pages = {}) {
  const fn = async (url) => {
    fn.calls.push(url);
    return fn.pages[url] || { ok: false, fetch_status: "failed", reason: "could not resolve the host", final_url: null, http_status: null };
  };
  fn.pages = pages;
  fn.calls = [];
  return fn;
}

async function connect(server) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(ct);
  return client;
}
const clientFor = (actor = OWNER, stub = makeStub(), opts = {}) => connect(createProjectServer(CORE, { fetchPage: stub, actor, ...opts }));

function withDb(fn) { const d = new Database(CORE); try { return fn(d); } finally { d.close(); } }
const source = (id) => withDb((d) => d.prepare("SELECT * FROM research_sources WHERE id = ?").get(id));
const note = (id) => withDb((d) => d.prepare("SELECT * FROM research_notes WHERE id = ?").get(id));
const audits = (pid) => withDb((d) => d.prepare("SELECT * FROM project_audit_log WHERE project_id = ? AND action = 'source.verify' ORDER BY id").all(pid));

let seq = 0;
async function newProject(client) {
  const r = await client.callTool({ name: "crow_create_project", arguments: { name: `verify-${++seq}` } });
  return Number(text(r).match(/id: (\d+)/)[1]);
}
function insertSource(cols) {
  const full = {
    title: "T", source_type: "web_article", url: `https://example.com/s${++seq}`, citation_apa: "x",
    fetch_status: "fetched", fetched_at: new Date().toISOString(), fetched_text: PAGE, content_sha256: sha(PAGE), ...cols,
  };
  const keys = Object.keys(full);
  return withDb((d) => Number(d.prepare(`INSERT INTO research_sources (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`)
    .run(...keys.map((k) => full[k])).lastInsertRowid));
}
function insertQuote(sourceId, projectId, content) {
  return withDb((d) => Number(d.prepare("INSERT INTO research_notes (project_id, source_id, content, note_type) VALUES (?, ?, ?, 'quote')")
    .run(projectId, sourceId, content).lastInsertRowid));
}
const verify = (client, args) => client.callTool({ name: "crow_verify_source", arguments: args });

test("a missing id is not found, never a false success", async () => {
  const client = await clientFor(OWNER);
  const before = withDb((d) => d.prepare("SELECT COUNT(*) AS n FROM research_sources WHERE verified = 1").get().n);
  for (const method of ["quotes_checked", "manual_owner"]) {
    const r = await verify(client, { id: 9999, method });
    assert.equal(r.isError, true, text(r));
    assert.match(text(r), /Source #9999 not found/);
  }
  const r = await verify(client, { id: 9999, verified: false });
  assert.equal(r.isError, true);
  assert.equal(withDb((d) => d.prepare("SELECT COUNT(*) AS n FROM research_sources WHERE verified = 1").get().n), before);
});

test("verify needs write_sources on the source's project", async () => {
  const client = await clientFor(BOT);
  const pid = await newProject(client);
  const sid = insertSource({ project_id: pid });
  insertQuote(sid, pid, "We will ship weekly");
  withDb((d) => d.prepare("UPDATE project_members SET capabilities = ? WHERE project_id = ? AND contact_id IS NULL")
    .run(JSON.stringify({ write_sources: false }), pid));
  const r = await verify(client, { id: sid });
  assert.equal(r.isError, true, text(r));
  assert.match(text(r), /write_sources/);
  assert.equal(source(sid).verified, 0);
  // The owner is bound by the same ACL.
  const owner = await clientFor(OWNER);
  const r2 = await verify(owner, { id: sid, method: "manual_owner" });
  assert.equal(r2.isError, true, text(r2));
  assert.equal(source(sid).verified, 0);
});

test("project-less sources: only the owner may verify", async () => {
  const sid = insertSource({ project_id: null, fetch_status: "not_applicable", fetched_text: null, source_type: "book", url: null });
  for (const actor of [BOT, UNKNOWN]) {
    const r = await verify(await clientFor(actor), { id: sid, method: "manual_owner" });
    assert.equal(r.isError, true, text(r));
    assert.match(text(r), /only the owner/);
  }
  // A quote check is refused too: a bot cannot reach a project-less source at all.
  const sid2 = insertSource({ project_id: null });
  insertQuote(sid2, null, "We will ship weekly");
  const rq = await verify(await clientFor(BOT), { id: sid2 });
  assert.equal(rq.isError, true, text(rq));
  assert.match(text(rq), /only the owner/);
  assert.equal(source(sid2).verified, 0);

  const r = await verify(await clientFor(OWNER), { id: sid, method: "manual_owner" });
  assert.ok(!r.isError, text(r));
  const s = source(sid);
  assert.equal(s.verified, 1);
  assert.equal(s.verification_method, "manual_owner");
  assert.equal(s.verified_by, "owner");
  assert.match(text(r), /no audit entry/i);
});

test("quotes_checked verifies when every quote note is found", async () => {
  const client = await clientFor(BOT);
  const pid = await newProject(client);
  const sid = insertSource({ project_id: pid });
  const n1 = insertQuote(sid, pid, "We will ship weekly");
  const n2 = insertQuote(sid, pid, "the budget doubles next year");
  const r = await verify(client, { id: sid, notes: "checked both" });
  assert.ok(!r.isError, text(r));
  assert.match(text(r), /^Source #\d+ verified/);
  const s = source(sid);
  assert.equal(s.verified, 1);
  assert.equal(s.verification_method, "quotes_checked");
  assert.equal(s.verified_by, "bot:b1");
  assert.equal(s.verification_notes, "checked both");
  assert.equal(note(n1).quote_found, 1);
  assert.equal(note(n2).quote_found, 1);
  const a = audits(pid);
  assert.equal(a.length, 1);
  assert.equal(a[0].actor_type, "bot");
  assert.equal(a[0].actor_id, "b1");
  assert.equal(a[0].target, `source:${sid}`);
  const payload = JSON.parse(a[0].payload);
  assert.equal(payload.method, "quotes_checked");
  assert.equal(payload.verified, true);
});

test("one missing quote blocks verification and names the note", async () => {
  const client = await clientFor(BOT);
  const pid = await newProject(client);
  const sid = insertSource({ project_id: pid });
  const good = insertQuote(sid, pid, "We will ship weekly");
  const bad = insertQuote(sid, pid, "We will ship hourly and never sleep");
  const r = await verify(client, { id: sid });
  assert.ok(!r.isError, text(r));
  assert.ok(text(r).startsWith("NOT verified:"), text(r));
  assert.match(text(r), new RegExp(`#${bad}\\b`));
  assert.doesNotMatch(text(r), new RegExp(`#${good}\\b`));
  const s = source(sid);
  assert.equal(s.verified, 0);
  assert.equal(s.verification_method, null);
  assert.equal(note(bad).quote_found, 0);
  assert.equal(note(good).quote_found, 1);
  const a = audits(pid);
  assert.equal(a.length, 1);
  assert.equal(JSON.parse(a[0].payload).verified, false);
});

test("no quote notes: nothing to check", async () => {
  const client = await clientFor(BOT);
  const pid = await newProject(client);
  const sid = insertSource({ project_id: pid });
  withDb((d) => d.prepare("INSERT INTO research_notes (project_id, source_id, content, note_type) VALUES (?, ?, 'a plain note', 'note')").run(pid, sid));
  const r = await verify(client, { id: sid });
  assert.ok(!r.isError, text(r));
  assert.ok(text(r).startsWith("NOT verified:"), text(r));
  assert.match(text(r), /add a quote note/);
  assert.equal(source(sid).verified, 0);
});

test("not fetched (failed/legacy/not_applicable/fetched_no_text) cannot be quotes_checked", async () => {
  const client = await clientFor(OWNER);
  const pid = await newProject(client);
  for (const status of ["failed", "legacy", "not_applicable", "fetched_no_text", null]) {
    const sid = insertSource({ project_id: pid, fetch_status: status, fetched_text: status === "legacy" ? PAGE : null });
    insertQuote(sid, pid, "We will ship weekly");
    const r = await verify(client, { id: sid });
    assert.ok(!r.isError, text(r));
    assert.ok(text(r).startsWith("NOT verified:"), `${status}: ${text(r)}`);
    assert.equal(source(sid).verified, 0, String(status));
  }
  // fetched with an empty text is not checkable either
  const sid = insertSource({ project_id: pid, fetched_text: "" });
  insertQuote(sid, pid, "We will ship weekly");
  const r = await verify(client, { id: sid });
  assert.ok(text(r).startsWith("NOT verified:"), text(r));
  assert.equal(source(sid).verified, 0);
});

test("legacy_flag rows stay as they are", async () => {
  const client = await clientFor(BOT);
  const pid = await newProject(client);
  const sid = insertSource({ project_id: pid, fetch_status: "legacy", verified: 1, verification_method: "legacy_flag", fetched_text: null });
  insertQuote(sid, pid, "We will ship weekly");
  const r = await verify(client, { id: sid });
  assert.ok(text(r).startsWith("NOT verified:"), text(r));
  const s = source(sid);
  assert.equal(s.verified, 1);
  assert.equal(s.verification_method, "legacy_flag");
});

test("stale text is re-fetched; a page that changed under a passing quote blocks verification", async () => {
  const old = new Date(Date.now() - 31 * DAY).toISOString();
  const url = "https://example.com/stale";
  const changed = "The council voted on Tuesday. The release schedule is under review.";
  const stub = makeStub({ [url]: okPage(url, changed) });
  const client = await clientFor(BOT, stub);
  const pid = await newProject(client);
  const sid = insertSource({ project_id: pid, url, fetched_at: old });
  const n = insertQuote(sid, pid, "We will ship weekly");
  withDb((d) => d.prepare("UPDATE research_notes SET quote_found = 1 WHERE id = ?").run(n));

  const r = await verify(client, { id: sid });
  assert.deepEqual(stub.calls, [url]);
  assert.ok(!r.isError, text(r));
  assert.ok(text(r).startsWith("NOT verified:"), text(r));
  assert.match(text(r), new RegExp(`#${n}\\b`));
  let s = source(sid);
  assert.equal(s.verified, 0);
  assert.equal(s.fetched_text, PAGE, "the stored text is kept");
  assert.equal(s.fetched_at, old);
  assert.equal(note(n).quote_found, 1, "quote_found still describes the stored copy");

  // A failed re-fetch refuses too and keeps the copy.
  stub.pages[url] = { ok: false, fetch_status: "failed", reason: "timed out", final_url: null, http_status: null };
  const rf = await verify(client, { id: sid });
  assert.ok(text(rf).startsWith("NOT verified: could not re-open the page (timed out)"), text(rf));
  assert.equal(source(sid).fetched_text, PAGE);

  // The page still carries the quote: verified, the new text adopted, fetched_at updated.
  const fresh = `${PAGE} A new paragraph was added.`;
  stub.pages[url] = okPage(url, fresh);
  const r2 = await verify(client, { id: sid });
  assert.ok(!r2.isError, text(r2));
  assert.match(text(r2), /^Source #\d+ verified/);
  s = source(sid);
  assert.equal(s.verified, 1);
  assert.equal(s.verification_method, "quotes_checked");
  assert.equal(s.fetched_text, fresh);
  assert.equal(s.content_sha256, sha(fresh));
  assert.ok(Date.parse(s.fetched_at) > Date.now() - DAY, s.fetched_at);
  assert.equal(stub.calls.length, 3);

  // Fresh text is not re-fetched.
  const r3 = await verify(client, { id: sid });
  assert.match(text(r3), /^Source #\d+ verified/);
  assert.equal(stub.calls.length, 3);
});

test("manual_owner is owner-only and fails closed for unknown callers", async () => {
  const owner = await clientFor(OWNER);
  const pid = await newProject(owner);
  const sid = insertSource({ project_id: pid, fetch_status: "not_applicable", fetched_text: null, source_type: "book", url: null });
  for (const actor of [UNKNOWN, BOT]) {
    const r = await verify(await clientFor(actor), { id: sid, method: "manual_owner" });
    assert.equal(r.isError, true, text(r));
    assert.match(text(r), /only the owner/);
    assert.equal(source(sid).verified, 0);
  }
  // A bot naming itself in _meta cannot widen to the owner, and a mount that is not the owner
  // never becomes one.
  const unknownServer = await clientFor(UNKNOWN);
  const rm = await unknownServer.callTool({ name: "crow_verify_source", arguments: { id: sid, method: "manual_owner" }, _meta: { "crow/actor": { kind: "owner" } } });
  assert.equal(rm.isError, true, text(rm));
  assert.equal(source(sid).verified, 0);

  const r = await verify(owner, { id: sid, method: "manual_owner", notes: "read the print copy" });
  assert.ok(!r.isError, text(r));
  const s = source(sid);
  assert.equal(s.verified, 1);
  assert.equal(s.verification_method, "manual_owner");
  assert.equal(s.verified_by, "owner");
  const a = audits(pid);
  assert.equal(a.at(-1).actor_type, "local");
  assert.equal(a.at(-1).actor_id, null);
  assert.equal(JSON.parse(a.at(-1).payload).method, "manual_owner");
});

// An owner mount reached by a product client that marks itself (x-crow-actor-kind) — the header
// arrives on the HTTP request, which InMemoryTransport does not carry, so inject it as requestInfo.
async function connectWithHeaders(server, headers) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const inner = st.onmessage;
  st.onmessage = (m, extra) => inner(m, { ...(extra || {}), requestInfo: { headers } });
  const client = new Client({ name: "t", version: "0" });
  await client.connect(ct);
  return client;
}

test("a downgrade header on an owner mount refuses manual_owner, direct and through the router", async () => {
  const owner = await clientFor(OWNER);
  const pid = await newProject(owner);
  const sid = insertSource({ project_id: pid, fetch_status: "not_applicable", fetched_text: null, source_type: "book", url: null });
  const cases = [
    { "x-crow-actor-kind": "unknown" },
    { "x-crow-actor-kind": "bot", "x-crow-actor-id": "companion-bot" },
  ];
  for (const headers of cases) {
    const direct = await connectWithHeaders(createProjectServer(CORE, { fetchPage: makeStub(), actor: OWNER }), headers);
    const r = await verify(direct, { id: sid, method: "manual_owner" });
    assert.equal(r.isError, true, text(r));
    assert.match(text(r), /only the owner/);
    assert.equal(source(sid).verified, 0);

    const routed = await connectWithHeaders(createRouterServer({ actor: OWNER }), headers);
    const rr = await routed.callTool({ name: "crow_projects", arguments: { action: "verify_source", params: { id: sid, method: "manual_owner" } } });
    assert.match(text(rr), /only the owner/);
    assert.equal(source(sid).verified, 0);
  }
  // a header claiming owner on an unknown mount is ignored
  const claim = await connectWithHeaders(createProjectServer(CORE, { fetchPage: makeStub(), actor: UNKNOWN }), { "x-crow-actor-kind": "owner" });
  const rc = await verify(claim, { id: sid, method: "manual_owner" });
  assert.equal(rc.isError, true, text(rc));
  assert.equal(source(sid).verified, 0);
});

test("--no-auth mounts are never the owner", async () => {
  const owner = await clientFor(OWNER);
  const pid = await newProject(owner);
  const sid = insertSource({ project_id: pid, fetch_status: "not_applicable", fetched_text: null, source_type: "book", url: null });
  const call = (c) => c.callTool({ name: "crow_projects", arguments: { action: "verify_source", params: { id: sid, method: "manual_owner" } } });

  const noAuth = await connect(createRouterServer({ actor: UNKNOWN }));
  const r = await call(noAuth);
  assert.ok(r.isError || /only the owner/.test(text(r)), text(r));
  assert.match(text(r), /only the owner/);
  assert.equal(source(sid).verified, 0);
  // A router built with no actor at all is unknown too.
  const bare = await connect(createRouterServer({}));
  await call(bare);
  assert.equal(source(sid).verified, 0);

  const authed = await connect(createRouterServer({ actor: OWNER }));
  const r2 = await call(authed);
  assert.doesNotMatch(text(r2), /only the owner|error/i);
  assert.equal(source(sid).verified, 1);
  assert.equal(source(sid).verification_method, "manual_owner");
});

test("a gateway-bound bot cannot verify by hand", async () => {
  const owner = await clientFor(OWNER);
  const pid = await newProject(owner);
  const sid = insertSource({ project_id: pid, fetch_status: "not_applicable", fetched_text: null, source_type: "book", url: null });
  const exec = createToolExecutor({ botDef: { bot_id: "b7", display_name: "B" } });
  const r = await exec.executeTool("crow_verify_source", { id: sid, method: "manual_owner" });
  assert.equal(r.isError, true, r.result);
  assert.match(r.result, /only the owner/);
  assert.equal(source(sid).verified, 0);
  const rp = await exec.executeTool("crow_projects", { action: "verify_source", params: { id: sid, method: "manual_owner" } });
  assert.equal(rp.isError, true, rp.result);
  assert.equal(source(sid).verified, 0);
});

test("unverify clears the method and is audited", async () => {
  const client = await clientFor(BOT);
  const pid = await newProject(client);
  const sid = insertSource({ project_id: pid, verified: 1, verification_method: "manual_owner", verified_by: "owner", verification_notes: "old" });
  const r = await verify(client, { id: sid, verified: false, notes: "page moved" });
  assert.ok(!r.isError, text(r));
  assert.match(text(r), /unverified/);
  const s = source(sid);
  assert.equal(s.verified, 0);
  assert.equal(s.verification_method, null);
  assert.equal(s.verified_by, null);
  assert.equal(s.verification_notes, "page moved");
  const a = audits(pid);
  assert.equal(a.length, 1);
  assert.equal(a[0].actor_type, "bot");
  assert.equal(JSON.parse(a[0].payload).verified, false);
});

// ---------------------------------------------------------------- fix round 1: the invariant

test("a failed re-check clears a quotes_checked verification, not manual_owner or legacy_flag", async () => {
  const client = await clientFor(BOT);
  const pid = await newProject(client);
  const sid = insertSource({ project_id: pid });
  insertQuote(sid, pid, "We will ship weekly");
  assert.match(text(await verify(client, { id: sid })), /^Source #\d+ verified/);
  assert.equal(source(sid).verification_method, "quotes_checked");
  // A misquote that did not come through crow_add_note (e.g. a synced row).
  const bad = insertQuote(sid, pid, "We will ship hourly and never sleep");
  const r = await verify(client, { id: sid });
  assert.ok(text(r).startsWith("NOT verified:"), text(r));
  assert.match(text(r), new RegExp(`#${bad}\\b`));
  assert.match(text(r), /no longer verified/);
  const s = source(sid);
  assert.equal(s.verified, 0);
  assert.equal(s.verification_method, null);
  assert.equal(s.verified_by, null);
  assert.equal(JSON.parse(audits(pid).at(-1).payload).invalidated, true);

  for (const how of ["manual_owner", "legacy_flag"]) {
    const sid2 = insertSource({ project_id: pid, verified: 1, verification_method: how, verified_by: how === "manual_owner" ? "owner" : null });
    insertQuote(sid2, pid, "We will ship hourly and never sleep");
    const r2 = await verify(client, { id: sid2 });
    assert.ok(text(r2).startsWith("NOT verified:"), text(r2));
    assert.doesNotMatch(text(r2), /no longer verified/);
    assert.equal(source(sid2).verified, 1, how);
    assert.equal(source(sid2).verification_method, how);
  }
});

test("a stale page that changed under a quote clears a quotes_checked verification", async () => {
  const url = "https://example.com/stale-verified";
  const stub = makeStub({ [url]: okPage(url, "Different text entirely.") });
  const client = await clientFor(BOT, stub);
  const pid = await newProject(client);
  const sid = insertSource({ project_id: pid, url, fetched_at: new Date(Date.now() - 40 * DAY).toISOString(), verified: 1, verification_method: "quotes_checked", verified_by: "bot:b1" });
  insertQuote(sid, pid, "We will ship weekly");
  const r = await verify(client, { id: sid });
  assert.ok(text(r).startsWith("NOT verified:"), text(r));
  assert.match(text(r), /no longer verified/);
  assert.equal(source(sid).verified, 0);
  assert.equal(source(sid).fetched_text, PAGE);
});

test("crow_add_note: a quote not on the page clears a quotes_checked verification and is audited", async () => {
  const client = await clientFor(BOT);
  const pid = await newProject(client);
  const sid = insertSource({ project_id: pid });
  insertQuote(sid, pid, "We will ship weekly");
  assert.match(text(await verify(client, { id: sid })), /^Source #\d+ verified/);
  const addNote = (args) => client.callTool({ name: "crow_add_note", arguments: { note_type: "quote", provenance: "fetched", project_id: pid, ...args } });

  const ok = await addNote({ source_id: sid, content: "the budget doubles next year" });
  assert.doesNotMatch(text(ok), /no longer verified/);
  assert.equal(source(sid).verified, 1, "a found quote keeps the verification");

  const r = await addNote({ source_id: sid, content: "We will ship hourly and never sleep" });
  assert.ok(!r.isError, text(r));
  assert.match(text(r), new RegExp(`source #${sid} is no longer verified: this quote was not found on the page`, "i"));
  const s = source(sid);
  assert.equal(s.verified, 0);
  assert.equal(s.verification_method, null);
  assert.equal(s.verified_by, null);
  const a = audits(pid).at(-1);
  assert.equal(a.actor_type, "bot");
  assert.equal(a.actor_id, "b1");
  assert.equal(JSON.parse(a.payload).method, "invalidated");

  for (const how of ["manual_owner", "legacy_flag"]) {
    const sid2 = insertSource({ project_id: pid, verified: 1, verification_method: how });
    const r2 = await addNote({ source_id: sid2, content: "We will ship hourly and never sleep" });
    assert.doesNotMatch(text(r2), /no longer verified/);
    assert.equal(source(sid2).verified, 1, how);
    assert.equal(source(sid2).verification_method, how);
  }
});

test("crow_fetch_source force: new text a quote no longer matches clears a quotes_checked verification", async () => {
  const url = "https://example.com/forced";
  const stub = makeStub({ [url]: okPage(url, "Different text entirely.") });
  const client = await clientFor(OWNER, stub);
  const pid = await newProject(client);
  const sid = insertSource({ project_id: pid, url, verified: 1, verification_method: "quotes_checked", verified_by: "owner" });
  const n = insertQuote(sid, pid, "We will ship weekly");
  withDb((d) => d.prepare("UPDATE research_notes SET quote_found = 1 WHERE id = ?").run(n));
  const r = await client.callTool({ name: "crow_fetch_source", arguments: { id: sid, force: true } });
  assert.match(text(r), /no longer verified/);
  assert.equal(source(sid).verified, 0);
  assert.equal(source(sid).verification_method, null);
});

test("a quote note added between the check and the write blocks verification", async () => {
  let hook = null;
  const stub = makeStub();
  const client = await clientFor(BOT, stub, { beforeVerifyWrite: async (info) => { if (hook) await hook(info); } });
  const pid = await newProject(client);

  // Fresh path: an unchecked quote note lands after the check.
  const sid = insertSource({ project_id: pid });
  insertQuote(sid, pid, "We will ship weekly");
  hook = () => { insertQuote(sid, pid, "something unchecked"); };
  const r = await verify(client, { id: sid });
  assert.equal(text(r), "NOT verified: the source changed while it was being checked; try again.");
  assert.equal(source(sid).verified, 0);
  // Even a note that reads as found is refused: it was not part of the check.
  const sidB = insertSource({ project_id: pid });
  insertQuote(sidB, pid, "We will ship weekly");
  hook = () => withDb((d) => d.prepare("INSERT INTO research_notes (project_id, source_id, content, note_type, quote_found) VALUES (?, ?, 'x', 'quote', 1)").run(pid, sidB));
  assert.match(text(await verify(client, { id: sidB })), /changed while it was being checked/);
  assert.equal(source(sidB).verified, 0);

  // Stale path: a note lands during the re-fetch window; the new copy is not adopted.
  const url = "https://example.com/race";
  const fresh = `${PAGE} Plus a new line.`;
  stub.pages[url] = okPage(url, fresh);
  const old = new Date(Date.now() - 31 * DAY).toISOString();
  const sid2 = insertSource({ project_id: pid, url, fetched_at: old });
  insertQuote(sid2, pid, "We will ship weekly");
  hook = () => withDb((d) => d.prepare("INSERT INTO research_notes (project_id, source_id, content, note_type, quote_found) VALUES (?, ?, 'x', 'quote', 1)").run(pid, sid2));
  const r2 = await verify(client, { id: sid2 });
  assert.match(text(r2), /^NOT verified: the source changed while it was being checked/);
  let s = source(sid2);
  assert.equal(s.verified, 0);
  assert.equal(s.fetched_text, PAGE);
  assert.equal(s.fetched_at, old);

  // Stale path: the stored text changed underneath (another fetch adopted a copy).
  const sid3 = insertSource({ project_id: pid, url, fetched_at: old });
  insertQuote(sid3, pid, "We will ship weekly");
  hook = () => withDb((d) => d.prepare("UPDATE research_sources SET fetched_text = ?, content_sha256 = ? WHERE id = ?").run("other", sha("other"), sid3));
  assert.match(text(await verify(client, { id: sid3 })), /changed while it was being checked/);
  s = source(sid3);
  assert.equal(s.verified, 0);
  assert.equal(s.fetched_text, "other");

  // No interference: the same paths verify when nothing changes.
  hook = null;
  const sid4 = insertSource({ project_id: pid, url, fetched_at: old });
  insertQuote(sid4, pid, "We will ship weekly");
  assert.match(text(await verify(client, { id: sid4 })), /^Source #\d+ verified/);
  assert.equal(source(sid4).fetched_text, fresh);
});

// ---------------------------------------------------------------- fix round 2: add_note TOCTOU

test("crow_add_note: page text replaced between the match and the insert is re-matched", async () => {
  let hook = null;
  const client = await clientFor(BOT, makeStub(), { beforeNoteInsert: async (info) => { if (hook) await hook(info); } });
  const pid = await newProject(client);
  const sid = insertSource({ project_id: pid });
  insertQuote(sid, pid, "We will ship weekly");
  assert.match(text(await verify(client, { id: sid })), /^Source #\d+ verified/);
  // Matches the stored copy, but a concurrent adopt swaps in text without it before the insert.
  const newText = "We will ship weekly. The council voted on Tuesday.";
  hook = () => withDb((d) => d.prepare("UPDATE research_sources SET fetched_text = ?, content_sha256 = ? WHERE id = ?").run(newText, sha(newText), sid));
  const r = await client.callTool({ name: "crow_add_note", arguments: {
    note_type: "quote", provenance: "fetched", project_id: pid, source_id: sid, content: "the budget doubles next year",
  } });
  assert.ok(!r.isError, text(r));
  assert.match(text(r), /NOT on the page/);
  assert.match(text(r), new RegExp(`Source #${sid} is no longer verified: this quote was not found on the page`));
  const n = withDb((d) => d.prepare("SELECT quote_found FROM research_notes WHERE source_id = ? AND content = 'the budget doubles next year'").get(sid));
  assert.equal(n.quote_found, 0);
  const s = source(sid);
  assert.equal(s.verified, 0);
  assert.equal(s.verification_method, null);

  // Control: an unchanged copy keeps the first match and the verification.
  hook = null;
  const sid2 = insertSource({ project_id: pid });
  insertQuote(sid2, pid, "We will ship weekly");
  assert.match(text(await verify(client, { id: sid2 })), /^Source #\d+ verified/);
  const r2 = await client.callTool({ name: "crow_add_note", arguments: {
    note_type: "quote", provenance: "fetched", project_id: pid, source_id: sid2, content: "the budget doubles next year",
  } });
  assert.match(text(r2), /Quote checked: found/);
  assert.equal(source(sid2).verified, 1);
});

test("the not-found message does not tell bots to edit or remove notes (they cannot)", async () => {
  const client = await clientFor(BOT);
  const pid = await newProject(client);
  const sid = insertSource({ project_id: pid });
  const bad = insertQuote(sid, pid, "We will ship hourly and never sleep");
  const r = await verify(client, { id: sid });
  assert.ok(text(r).startsWith("NOT verified:"), text(r));
  assert.match(text(r), new RegExp(`#${bad}\\b`));
  assert.match(text(r), /Notes can't be removed, so tell the owner; add correct quotes copied character for character in new notes for later sources\./);
  assert.doesNotMatch(text(r), /Fix or remove/);
});
