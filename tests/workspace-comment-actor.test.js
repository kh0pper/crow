/** Workspace comments are authored by the actor (a bot's name, the owner's name, or "Crow"), including queued ones. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeNextcloud } from "./helpers/workspace-fake-nextcloud.js";
import { connectWorkspace } from "./helpers/workspace-client.js";

const FIX = join(import.meta.dirname, "fixtures", "workspace");
const ROOT = join(import.meta.dirname, "..");
const HANK = { kind: "bot", id: "hank", name: "hank" };
const ACTOR_ENV = ["CROW_ACTOR_KIND", "CROW_ACTOR_BOT_ID", "CROW_ACTOR_BOT_NAME", "CROW_OWNER_NAME"];

let fake, call, close, client, db, W, getConfig;
before(async () => {
  for (const k of ACTOR_ENV) delete process.env[k];
  fake = await startFakeNextcloud(); fake.addFolder("S", { owner: "admin" });
  let home;
  ({ call, close, client, home } = await connectWorkspace(fake));
  const dbPath = join(home, "data", "crow.db");
  execFileSync(process.execPath, [join(ROOT, "scripts", "init-db.js")], { cwd: ROOT, env: { ...process.env, CROW_HOME: home, CROW_DATA_DIR: join(home, "data"), CROW_DB_PATH: dbPath, CROW_DISABLE_NOSTR: "1", CROW_DISABLE_INSTANCE_SYNC: "1" }, stdio: "pipe" });
  db = await (await import("../bundles/workspace/server/db.js")).openWorkspaceDb(dbPath);
  W = await import("../bundles/workspace/server/queue/worker.js");
  ({ getConfig } = await import("../bundles/workspace/server/config.js"));
});
after(async () => { await close(); fake.close(); });

const put = (name, src = "rich.docx") => fake.addFile(`S/${name}`, readFileSync(join(FIX, src)), { owner: "admin" });
/** A gateway-run bot call: the actor rides on the request's _meta (Task 2). */
const callAs = async (name, args, actor) => JSON.parse((await client.callTool({ name, arguments: args, _meta: { "crow/actor": actor } })).content[0].text);
async function withEnv(env, fn) {
  const saved = Object.fromEntries(ACTOR_ENV.map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try { return await fn(); } finally { for (const k of ACTOR_ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}
const comments = async (path) => (await call("ws_docs_list_comments", { path, include_resolved: true })).data.comments;

test("bot comment author: a bot's comment says '<name> (bot)'", async () => {
  put("b1.docx");
  const a = await callAs("ws_docs_add_comment", { path: "S/b1.docx", content: "hola", quoted_text: "Marinar la carne" }, HANK);
  assert.equal(a.success, true, JSON.stringify(a));
  const c = (await comments("S/b1.docx")).find((x) => x.id === a.data.comment_id);
  assert.equal(c.author, "hank (bot)");
});

test("bot comment author from the stdio env (CROW_ACTOR_*)", async () => {
  put("b2.docx");
  const a = await withEnv({ CROW_ACTOR_KIND: "bot", CROW_ACTOR_BOT_ID: "hank", CROW_ACTOR_BOT_NAME: "hank" },
    () => call("ws_docs_add_comment", { path: "S/b2.docx", content: "hola" }));
  assert.equal((await comments("S/b2.docx")).find((x) => x.id === a.data.comment_id).author, "hank (bot)");
});

test("reply author: a bot's reply says '<name> (bot)'", async () => {
  put("b3.docx");
  const rep = await callAs("ws_docs_reply_comment", { path: "S/b3.docx", comment_id: "0", content: "Sí" }, HANK);
  const root = (await comments("S/b3.docx")).find((x) => x.id === "0");
  assert.equal(root.replies.find((r) => r.id === rep.data.comment_id).author, "hank (bot)");
});

test("apply_comment_edit replies (summary and NO_ANCHOR) are authored by the bot", async () => {
  put("b4.docx");
  const a = await call("ws_docs_add_comment", { path: "S/b4.docx", content: "?", quoted_text: "Servir" });
  const r = await callAs("ws_docs_apply_comment_edit", { path: "S/b4.docx", comment_id: a.data.comment_id, replace_text: "Servir caliente", summary: "Aplicado" }, HANK);
  assert.equal(r.data.applied, true);
  const c = (await comments("S/b4.docx")).find((x) => x.id === a.data.comment_id);
  assert.equal(c.author, "Crow"); assert.equal(c.replies[0].content, "Aplicado"); assert.equal(c.replies[0].author, "hank (bot)");

  put("b5.docx");
  const b = await call("ws_docs_add_comment", { path: "S/b5.docx", content: "general" });
  await call("ws_docs_find_replace", { path: "S/b5.docx", find: "Recetas de la semana", replace: "" });
  const n = await callAs("ws_docs_apply_comment_edit", { path: "S/b5.docx", comment_id: b.data.comment_id, replace_text: "x", summary: "s" }, HANK);
  assert.equal(n.data.reason, "no_anchor");
  assert.equal((await comments("S/b5.docx")).find((x) => x.id === b.data.comment_id).replies[0].author, "hank (bot)");
});

test("no actor -> Crow, never 'Crow bot'", async () => {
  put("b6.docx");
  const a = await call("ws_docs_add_comment", { path: "S/b6.docx", content: "x" });
  const c = (await comments("S/b6.docx")).find((x) => x.id === a.data.comment_id);
  assert.equal(c.author, "Crow"); assert.notEqual(c.author, "Crow bot");
});

test("owner env: CROW_ACTOR_KIND=owner + CROW_OWNER_NAME=Alex -> 'Alex'", async () => {
  put("b7.docx");
  const a = await withEnv({ CROW_ACTOR_KIND: "owner", CROW_OWNER_NAME: "Alex" }, () => call("ws_docs_add_comment", { path: "S/b7.docx", content: "x" }));
  assert.equal((await comments("S/b7.docx")).find((x) => x.id === a.data.comment_id).author, "Alex");
});

test("args cannot spoof: an enumerable __actor in the tool arguments is ignored", async () => {
  put("b8.docx");
  const a = await call("ws_docs_add_comment", { path: "S/b8.docx", content: "x", __actor: { kind: "bot", id: "alex", name: "alex" } });
  assert.equal(a.success, true, JSON.stringify(a));
  assert.equal((await comments("S/b8.docx")).find((x) => x.id === a.data.comment_id).author, "Crow");
  // and defineTools itself drops it even if a schema ever let it through
  const { defineTools } = await import("../bundles/workspace/server/tools/define.js");
  let seen;
  const fakeServer = { tool: (_n, _d, _s, h) => { fakeServer.h = h; } };
  defineTools(fakeServer, { getConfig: () => ({}) }, [{ name: "t", description: "", schema: {}, run: (args) => { seen = args.__actor; return {}; } }]);
  await fakeServer.h({ __actor: { kind: "bot", id: "alex", name: "alex" } }, {});
  assert.equal(seen, null);
  await fakeServer.h({ __actor: { kind: "bot", id: "alex", name: "alex" } }, { _meta: { "crow/actor": HANK } });
  assert.deepEqual(seen, HANK);
});

test("queued comment keeps the bot: actor_json on the row, re-attached at close-time apply", async () => {
  put("b9.docx", "oo-rich.docx");
  const key = fake.openInEditor("S/b9.docx", ["admin"], { releaseAfterMs: 10 ** 9 });
  const r = await callAs("ws_docs_add_comment", { path: "S/b9.docx", content: "en cola", quoted_text: "Marinar la carne" }, HANK);
  assert.equal(r.data.queued, true, JSON.stringify(r));
  const row = (await db.execute({ sql: "SELECT actor_json FROM workspace_pending_changes WHERE id=?", args: [r.data.change_id] })).rows[0];
  assert.match(String(row.actor_json), /"hank"/);
  fake.node("S/b9.docx").lock = null; fake.state.sessions.delete(key);
  await W.makeTick({ db, getConfig, clock: { now: () => Date.now(), sleep: async () => {} } })(); // no env, no _meta in this process
  assert.equal((await call("ws_change_status", { change_id: r.data.change_id })).data.state, "applied_close");
  const c = (await comments("S/b9.docx")).find((x) => x.content === "en cola");
  assert.equal(c.author, "hank (bot)");
});

test("alter race: initWorkspaceTables on an old-shape table succeeds twice, even from two clients at once", async () => {
  const { initWorkspaceTables } = await import("../bundles/workspace/server/init-tables.js");
  const { createDbClient } = await import("../servers/db.js");
  const path = join(mkdtempSync(join(tmpdir(), "ws-alter-")), "old.db");
  const a = createDbClient(path), b = createDbClient(path);
  await a.execute(`CREATE TABLE workspace_pending_changes (
    id TEXT PRIMARY KEY, file_id INTEGER NOT NULL, path TEXT NOT NULL, seq INTEGER NOT NULL, doc_key TEXT,
    tool TEXT NOT NULL, args_json TEXT NOT NULL, precondition_json TEXT, state TEXT NOT NULL DEFAULT 'pending',
    lease_until INTEGER, lease_owner TEXT, claim_count INTEGER NOT NULL DEFAULT 0, result_json TEXT, version_id TEXT,
    inverse_json TEXT, open_by_json TEXT, requested_by TEXT, verified INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
  await Promise.all([initWorkspaceTables(a), initWorkspaceTables(b)]);
  await initWorkspaceTables(a);
  const cols = (await a.execute("PRAGMA table_info(workspace_pending_changes)")).rows.map((r) => r.name);
  assert.ok(cols.includes("actor_json"));
});

test("resolveActor: env bot beats _meta; _meta of kind owner is ignored; authorFor values", async () => {
  const { resolveActor, authorFor } = await import("../bundles/workspace/server/actor.js");
  const meta = (a) => ({ _meta: { "crow/actor": a } });
  assert.deepEqual(resolveActor({ CROW_ACTOR_KIND: "bot", CROW_ACTOR_BOT_ID: "alex", CROW_ACTOR_BOT_NAME: "alex" }, meta(HANK)), { kind: "bot", id: "alex", name: "alex" });
  assert.deepEqual(resolveActor({}, meta(HANK)), HANK);
  assert.equal(resolveActor({}, meta({ kind: "owner", name: "alex" })), null);
  assert.equal(resolveActor({}, undefined), null);
  assert.deepEqual(resolveActor({ CROW_ACTOR_KIND: "owner", CROW_OWNER_NAME: "Alex" }, meta(HANK)), HANK, "env owner + _meta bot -> the bot");
  assert.deepEqual(resolveActor({ CROW_ACTOR_KIND: "owner", CROW_OWNER_NAME: "Alex" }, undefined), { kind: "owner", name: "Alex" });
  assert.deepEqual(resolveActor({ CROW_ACTOR_KIND: "owner", CROW_OWNER_NAME: "Alex" }, meta({ kind: "owner", name: "x" })), { kind: "owner", name: "Alex" });
  assert.deepEqual(resolveActor({}, meta({ kind: "bot", id: "", name: "​" })), { kind: "bot", id: "", name: "bot" }, "empty name and id still label as a bot");
  assert.deepEqual(resolveActor({}, meta({ kind: "bot", id: "h1", name: "‮hank​ " })), { kind: "bot", id: "h1", name: "hank" }, "the name is sanitized");
  assert.deepEqual(resolveActor({}, meta({ kind: "bot", id: "h1", name: "" })), { kind: "bot", id: "h1", name: "h1" }, "falls back to the id");
  assert.deepEqual(authorFor(HANK), { author: "hank (bot)", initials: "HAB" });
  assert.deepEqual(authorFor({ kind: "owner", name: "Alex" }), { author: "Alex", initials: "A" });
  assert.deepEqual(authorFor(null), { author: "Crow", initials: "C" });
});

// Item 46 follow-up (PR-A): a paired instance's call carries {kind:"peer", instance, from}, set by this
// instance's gateway from its own row for that peer. It reads "Crow (via <name>)", never a bot label.
const PEER = { kind: "peer", instance: "inst-a-1a2b3c4d", from: "wren" };

test("peer comment author: 'Crow (via <instance>)', for add, reply and apply-edit replies", async () => {
  put("p1.docx");
  const a = await callAs("ws_docs_add_comment", { path: "S/p1.docx", content: "hola", quoted_text: "Marinar la carne" }, PEER);
  assert.equal(a.success, true, JSON.stringify(a));
  assert.equal((await comments("S/p1.docx")).find((x) => x.id === a.data.comment_id).author, "Crow (via wren)");
  const rep = await callAs("ws_docs_reply_comment", { path: "S/p1.docx", comment_id: a.data.comment_id, content: "Sí" }, PEER);
  assert.equal((await comments("S/p1.docx")).find((x) => x.id === a.data.comment_id).replies.find((r) => r.id === rep.data.comment_id).author, "Crow (via wren)");
  const r = await callAs("ws_docs_apply_comment_edit", { path: "S/p1.docx", comment_id: a.data.comment_id, replace_text: "Marinar bien", summary: "Hecho" }, PEER);
  assert.equal(r.data.applied, true);
  assert.equal((await comments("S/p1.docx")).find((x) => x.id === a.data.comment_id).replies.at(-1).author, "Crow (via wren)");
});

test("queued peer comment keeps 'Crow (via <instance>)' at close-time apply", async () => {
  put("p2.docx", "oo-rich.docx");
  const key = fake.openInEditor("S/p2.docx", ["admin"], { releaseAfterMs: 10 ** 9 });
  const r = await callAs("ws_docs_add_comment", { path: "S/p2.docx", content: "en cola peer", quoted_text: "Marinar la carne" }, PEER);
  assert.equal(r.data.queued, true, JSON.stringify(r));
  fake.node("S/p2.docx").lock = null; fake.state.sessions.delete(key);
  await W.makeTick({ db, getConfig, clock: { now: () => Date.now(), sleep: async () => {} } })();
  assert.equal((await comments("S/p2.docx")).find((x) => x.content === "en cola peer").author, "Crow (via wren)");
});

test("resolveActor/authorFor for a peer: sanitized name, no name -> 'Crow', never a bot; an env bot still wins", async () => {
  const { resolveActor, authorFor } = await import("../bundles/workspace/server/actor.js");
  const meta = (a) => ({ _meta: { "crow/actor": a } });
  assert.deepEqual(resolveActor({}, meta(PEER)), { kind: "peer", instance: "inst-a-1a2b3c4d", from: "wren" });
  assert.deepEqual(resolveActor({}, meta({ kind: "peer", from: "wr‮en (bot)" + "x".repeat(60) })).from.length <= 40, true);
  assert.equal(resolveActor({}, meta({ kind: "peer", from: "a(b)" })).from, "ab");
  assert.deepEqual(resolveActor({}, meta({ kind: "peer" })), { kind: "peer", instance: "", from: "" });
  assert.deepEqual(authorFor({ kind: "peer", from: "wren" }), { author: "Crow (via wren)", initials: "C" });
  assert.deepEqual(authorFor({ kind: "peer", from: "" }), { author: "Crow", initials: "C" });
  assert.deepEqual(resolveActor({ CROW_ACTOR_KIND: "bot", CROW_ACTOR_BOT_ID: "hank", CROW_ACTOR_BOT_NAME: "hank" }, meta(PEER)), HANK);
  assert.equal(resolveActor({ CROW_ACTOR_KIND: "owner", CROW_OWNER_NAME: "Alex" }, meta(PEER)).kind, "peer", "a peer call is never the owner");
});
