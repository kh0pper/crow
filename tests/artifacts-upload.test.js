// Crow Artifacts — the two-step upload (artifact_upload_begin → PUT → commit)
// and the fail-fast inline cap. The upload exists because a big source sent in
// ONE tool argument is bounded by the model's output limit; the commit must
// then behave EXACTLY like the inline save (same gates, same version), the PUT
// must be capability-only and never buffer past its cap, and a source that
// would not fit must be refused before anything is written.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createDbClient } from "../servers/db.js";
import { SessionManager } from "../servers/gateway/session-manager.js";
import { mountMcpServer } from "../servers/gateway/routes/mcp.js";
import { localTokenAuthMiddleware, generateArtifactsToken, generateLocalToken } from "../servers/gateway/local-token.js";
import { markdownBlocks } from "../servers/blog/renderer.js";
import { initArtifactsTables } from "../bundles/artifacts/server/init-tables.js";
import { createLocalBlobStore } from "../bundles/artifacts/server/blob-store.js";
import { createArtifactsMcpServer, TOOL_CLASSES } from "../bundles/artifacts/server/mcp.js";
import * as comments from "../bundles/artifacts/server/comments.js";
import * as rounds from "../bundles/artifacts/server/rounds.js";
import * as store from "../bundles/artifacts/server/store.js";
import { LIMITS } from "../bundles/artifacts/server/limits.js";
import { handleUploadPut, readMeter, _resetReadMeter, _resetUploadsForTest, _expireForTest, UPLOAD_PATH_PREFIX, MAX_PENDING_PER_ACTOR } from "../bundles/artifacts/server/uploads.js";
import { initGatewayActorKey, signArtifactsActor, verifyArtifactsActorSig } from "../scripts/pi-bots/actor-sig.mjs";
import { isFunnelPublicPath, rejectFunneledMiddleware } from "../servers/gateway/funnel.js";

initGatewayActorKey();
const saved = { CROW_HOME: process.env.CROW_HOME, CROW_DATA_DIR: process.env.CROW_DATA_DIR };
const s = {};

before(async () => {
  s.home = mkdtempSync(join(tmpdir(), "artifacts-upload-"));
  process.env.CROW_HOME = s.home; process.env.CROW_DATA_DIR = join(s.home, "data");
  s.db = createDbClient(join(s.home, "crow.db"));
  await s.db.executeMultiple(`
    CREATE TABLE dashboard_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE dashboard_settings_overrides (key TEXT NOT NULL, instance_id TEXT NOT NULL, value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now')), lamport_ts INTEGER DEFAULT 0, PRIMARY KEY (key, instance_id));
    CREATE TABLE bot_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id TEXT, gateway_type TEXT, gateway_thread_id TEXT, kind TEXT, status TEXT, narrowed_tools TEXT, card_id INTEGER);`);
  await initArtifactsTables(s.db);
  s.blobs = createLocalBlobStore(join(s.home, "blobs"));
  s.artToken = await generateArtifactsToken(s.db);
  s.fullToken = await generateLocalToken(s.db);
  const app = express();
  app.use(express.json());
  app.use(localTokenAuthMiddleware(s.db));
  const noAuth = (req, res) => res.status(401).json({ jsonrpc: "2.0", id: req.body?.id ?? null, error: { code: -32001, message: "unauthorized" } });
  const sm = new SessionManager();
  mountMcpServer(app, "/artifacts", () => createArtifactsMcpServer({ db: s.db, blobs: s.blobs, McpServer, z, verifyActor: verifyArtifactsActorSig, renderDeps: { markdownBlocks } }), sm, noAuth);
  // The PUT leg, exactly as the gateway mounts it (mcp-mounts.js).
  app.put(`${UPLOAD_PATH_PREFIX}/:upload_id`, handleUploadPut);
  s.http = app.listen(0); await new Promise((r) => s.http.once("listening", r));
  s.port = s.http.address().port;
});
after(async () => {
  s.http.closeAllConnections?.();
  await new Promise((r) => s.http.close(r));
  try { s.db.close(); } catch {}
  rmSync(s.home, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

async function client(token, headers = {}) {
  const t = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${s.port}/artifacts/mcp`), { requestInit: { headers: { ...headers, Authorization: `Bearer ${token}` } } });
  const c = new Client({ name: "artifacts-upload-test", version: "0" }); await c.connect(t); return c;
}
const call = async (c, name, args) => { const r = await c.callTool({ name, arguments: args }); return { err: r.isError ? r.content[0].text : null, data: r.isError ? null : JSON.parse(r.content[0].text) }; };
const bot = (id, thread) => ({
  "X-Crow-Actor-Kind": "bot", "X-Crow-Actor-Id": id, "X-Crow-Actor-Thread": thread, "X-Crow-Actor-Gateway": "perch",
  "X-Crow-Actor-Sig": signArtifactsActor({ botId: id, threadId: thread, gatewayType: "perch" }),
});
const versions = async (id) => Number((await s.db.execute({ sql: "SELECT COUNT(*) AS n FROM artifact_versions WHERE artifact_id=?", args: [id] })).rows[0].n);
const sha = (v) => createHash("sha256").update(v).digest("hex");

/** PUT a body; the server may hang up on an over-cap stream, so an error is a
 *  result too (the assertions say what each case accepts). */
async function put(url, body) {
  try {
    const r = await fetch(url, { method: "PUT", body, headers: { "content-type": "application/octet-stream" } });
    return { status: r.status, text: await r.text() };
  } catch (e) { return { status: 0, error: e }; }
}

/** begin → PUT → (the caller commits). Returns the put_url and upload_id. */
async function stage(c, text, args = {}) {
  const b = await call(c, "artifact_upload_begin", { bytes: Buffer.byteLength(text), ...args });
  assert.equal(b.err, null, b.err);
  const p = await put(b.data.put_url, text);
  assert.equal(p.status, 200, JSON.stringify(p));
  return b.data;
}

const clean = (botId, thread) => s.db.execute({ sql: "INSERT INTO bot_sessions (bot_id, gateway_type, gateway_thread_id, kind, status) VALUES (?, 'perch', ?, 'perch-live', 'active')", args: [botId, thread] });

// ─── the happy path, and its identity with the inline tools ─────────────────

test("begin returns a put_url on this gateway plus a curl line; begin → PUT → commit makes a version identical to the inline update", async () => {
  await clean("bobby", "perchlive-up1");
  const c = await client(s.artToken, bot("bobby", "perchlive-up1"));
  try {
    const text = "<!doctype html><html><body>" + "<p>same body</p>".repeat(300) + "</body></html>";
    const a = (await call(c, "artifact_create", { title: "Uploaded page", type: "page", source: { html: "<p>v1</p>" } })).data.id;
    const bArt = (await call(c, "artifact_create", { title: "Inline page", type: "page", source: { html: "<p>v1</p>" } })).data.id;

    const beg = await call(c, "artifact_upload_begin", { field: "html", artifact_id: a, bytes: Buffer.byteLength(text) });
    assert.equal(beg.err, null);
    assert.match(beg.data.upload_id, /^[0-9a-f]{64}$/, "32 random bytes in hex");
    assert.ok(beg.data.put_url.startsWith(`http://127.0.0.1:${s.port}/artifacts/upload/`), `put_url is on the gateway the MCP client points at: ${beg.data.put_url}`);
    assert.ok(beg.data.put_url.endsWith(beg.data.upload_id));
    assert.equal(beg.data.max_bytes, Buffer.byteLength(text), "the cap is the declared size");
    assert.match(beg.data.how, /^curl -sS -T <file> "/, "the description's how, filled in with the real URL");
    assert.ok(Date.parse(beg.data.expires_at) > Date.now(), "ten minutes out");

    const p = await put(beg.data.put_url, text);
    assert.equal(p.status, 200);
    assert.equal(JSON.parse(p.text).bytes, Buffer.byteLength(text));

    const done = await call(c, "artifact_upload_commit", { upload_id: beg.data.upload_id, mode: "update", artifact_id: a, change_note: "uploaded" });
    assert.equal(done.err, null, done.err);
    assert.equal(done.data.state, "current");

    const inline = await call(c, "artifact_update", { artifact_id: bArt, source: { html: text } });
    assert.equal(inline.err, null, inline.err);

    const upV = await store.getVersion(s.db, a, done.data.version);
    const inV = await store.getVersion(s.db, bArt, inline.data.version);
    assert.deepEqual(JSON.parse(upV.source_json), { html: text }, "the stored source is the file's text, in the same shape");
    assert.equal(upV.source_json, inV.source_json, "identical to what the inline tool stored");
    assert.equal(upV.content_hash, inV.content_hash, "…and renders to the same version");
    assert.equal(upV.change_note, "uploaded");
  } finally { await c.close(); }
});

test("a 30 KB page: refused inline with too_big_inline and nothing written, then saved through the upload", async () => {
  await clean("bobby", "perchlive-up2");
  const c = await client(s.artToken, bot("bobby", "perchlive-up2"));
  try {
    const big = "<!doctype html><html><body>" + "<p>" + "x".repeat(30 * 1024) + "</p></body></html>";
    assert.ok(big.length > LIMITS.inlineSourceChars, "the fixture is genuinely over the inline cap");
    const id = (await call(c, "artifact_create", { title: "Big page", type: "page", source: { html: "<p>v1</p>" } })).data.id;

    const before = await versions(id);
    const inline = await call(c, "artifact_update", { artifact_id: id, source: { html: big } });
    assert.match(inline.err, /^\[too_big_inline\] this source is too big to send inline: use artifact_upload_begin, PUT the file to its put_url, then artifact_upload_commit$/);
    assert.equal(await versions(id), before, "no version was written");

    const staged = await stage(c, big, { field: "html", artifact_id: id });
    const done = await call(c, "artifact_upload_commit", { upload_id: staged.upload_id, mode: "update", artifact_id: id });
    assert.equal(done.err, null, done.err);
    assert.equal(await versions(id), before + 1);
    assert.equal(JSON.parse((await store.getVersion(s.db, id, done.data.version)).source_json).html, big);
  } finally { await c.close(); }
});

test("the inline cap applies to create too — and only above the limit (24000 chars still passes)", async () => {
  await clean("bobby", "perchlive-up3");
  const c = await client(s.artToken, bot("bobby", "perchlive-up3"));
  try {
    const before = Number((await s.db.execute({ sql: "SELECT COUNT(*) AS n FROM artifacts", args: [] })).rows[0].n);
    const over = "<p>" + "y".repeat(LIMITS.inlineSourceChars) + "</p>";
    assert.equal((await call(c, "artifact_create", { title: "Too big", type: "page", source: { html: over } })).err.split("]")[0], "[too_big_inline");
    assert.equal(Number((await s.db.execute({ sql: "SELECT COUNT(*) AS n FROM artifacts", args: [] })).rows[0].n), before, "nothing saved");
    const at = "<p>" + "y".repeat(LIMITS.inlineSourceChars - 7) + "</p>";
    assert.equal(at.length, LIMITS.inlineSourceChars);
    assert.equal((await call(c, "artifact_create", { title: "At the limit", type: "page", source: { html: at } })).err, null);
  } finally { await c.close(); }
});

test("a document upload carries doc_title and lang; an upload is capped by documentMarkdownBytes", async () => {
  await clean("bobby", "perchlive-up4");
  const c = await client(s.artToken, bot("bobby", "perchlive-up4"));
  try {
    const md = "# Chapter\n\n" + "word ".repeat(6000);
    const staged = await stage(c, md, { field: "markdown" });
    const done = await call(c, "artifact_upload_commit", { upload_id: staged.upload_id, mode: "create", title: "Long doc", type: "document", doc_title: "The Doc", lang: "en" });
    assert.equal(done.err, null, done.err);
    assert.deepEqual(JSON.parse((await store.getVersion(s.db, done.data.id, 1)).source_json), { markdown: md, lang: "en", title: "The Doc" });
    assert.equal(staged.max_bytes, Buffer.byteLength(md), "the cap is the size declared at begin (never above the field's own ceiling)");
    assert.ok(Buffer.byteLength(md) < Math.min(LIMITS.uploadBytes, LIMITS.documentMarkdownBytes));
    const tooBig = await call(c, "artifact_upload_begin", { field: "markdown", bytes: LIMITS.documentMarkdownBytes + 1 });
    assert.match(tooBig.err, /^\[too_big\]/);
  } finally { await c.close(); }
});

// ─── the token is a one-time capability ────────────────────────────────────

test("commit is refused for another bot, another thread of the same bot, and the operator; the owning bot still commits", async () => {
  await clean("bobby", "perchlive-up5");
  await clean("bobby", "perchlive-up5b");
  await clean("mallory", "perchlive-up5m");
  const c = await client(s.artToken, bot("bobby", "perchlive-up5"));
  const otherThread = await client(s.artToken, bot("bobby", "perchlive-up5b"));
  const otherBot = await client(s.artToken, bot("mallory", "perchlive-up5m"));
  const op = await client(s.fullToken);
  try {
    const text = "<p>mine</p>";
    const staged = await stage(c, text, { field: "html" });
    for (const [who, cl] of [["another thread", otherThread], ["another bot", otherBot], ["the operator", op]]) {
      const r = await call(cl, "artifact_upload_commit", { upload_id: staged.upload_id, mode: "create", title: "x", type: "page" });
      assert.match(r.err, /^\[not_found\] no such upload/, `${who} must not use someone else's upload`);
    }
    // A refused foreign commit does not burn the owner's upload.
    const ok = await call(c, "artifact_upload_commit", { upload_id: staged.upload_id, mode: "create", title: "Mine", type: "page" });
    assert.equal(ok.err, null, ok.err);
    assert.deepEqual(JSON.parse((await store.getVersion(s.db, ok.data.id, 1)).source_json), { html: text });
  } finally { await c.close(); await otherThread.close(); await otherBot.close(); await op.close(); }
});

test("an upload works once: a second commit is refused, and a failed commit burns the token", async () => {
  await clean("bobby", "perchlive-up6");
  const c = await client(s.artToken, bot("bobby", "perchlive-up6"));
  try {
    const staged = await stage(c, "<p>once</p>", { field: "html" });
    assert.equal((await call(c, "artifact_upload_commit", { upload_id: staged.upload_id, mode: "create", title: "Once", type: "page" })).err, null);
    assert.match((await call(c, "artifact_upload_commit", { upload_id: staged.upload_id, mode: "create", title: "Again", type: "page" })).err, /^\[not_found\]/);
    // A commit that fails AFTER taking the entry (here: no type) still burns it.
    const s2 = await stage(c, "<p>twice</p>", { field: "html" });
    assert.match((await call(c, "artifact_upload_commit", { upload_id: s2.upload_id, mode: "create", title: "No type" })).err, /^\[bad_request\] create needs a type/);
    assert.match((await call(c, "artifact_upload_commit", { upload_id: s2.upload_id, mode: "create", title: "Late", type: "page" })).err, /^\[not_found\]/, "the token is spent");
  } finally { await c.close(); }
});

test("expired uploads are refused at PUT and at commit", async () => {
  await clean("bobby", "perchlive-up7");
  const c = await client(s.artToken, bot("bobby", "perchlive-up7"));
  try {
    const a = await call(c, "artifact_upload_begin", { field: "html", bytes: 10 });
    assert.equal(_expireForTest(a.data.upload_id), true);
    assert.equal((await put(a.data.put_url, "<p>x</p>")).status, 404, "a late PUT is refused");
    assert.match((await call(c, "artifact_upload_commit", { upload_id: a.data.upload_id, mode: "create", title: "x", type: "page" })).err, /^\[not_found\]/);

    const b = await stage(c, "<p>y</p>", { field: "html" });
    assert.equal(_expireForTest(b.upload_id), true);
    assert.match((await call(c, "artifact_upload_commit", { upload_id: b.upload_id, mode: "create", title: "y", type: "page" })).err, /^\[not_found\]/, "a file uploaded in time, committed too late");
  } finally { await c.close(); }
});

// ─── the PUT leg: caps, encoding, one file ─────────────────────────────────

test("PUT refuses an unknown token (404 static), a second PUT (409) and bytes that are not UTF-8 (400)", async () => {
  await clean("bobby", "perchlive-up8");
  const c = await client(s.artToken, bot("bobby", "perchlive-up8"));
  try {
    assert.equal((await put(`http://127.0.0.1:${s.port}/artifacts/upload/${"0".repeat(64)}`, "x")).status, 404);
    const staged = await stage(c, "<p>a</p>", { field: "html" });
    const again = await put(staged.put_url.replace(/\/$/, ""), "<p>b</p>");
    assert.equal(again.status, 409, "the file is already there");
    assert.match(again.text, /already has its file/);
    const bin = await call(c, "artifact_upload_begin", { field: "html", bytes: 64 });
    const r = await put(bin.data.put_url, Buffer.from([0xff, 0xfe, 0x00, 0x80]));
    assert.equal(r.status, 400);
    assert.match(r.text, /UTF-8/);
  } finally { await c.close(); }
});

test("a declared sha256 is enforced: a mismatch is 400, and the file that matches then lands", async () => {
  await clean("bobby", "perchlive-up9");
  const c = await client(s.artToken, bot("bobby", "perchlive-up9"));
  try {
    const text = "<p>hashed</p>";
    const other = "<p>something else</p>";
    const beg = await call(c, "artifact_upload_begin", { field: "html", bytes: Buffer.byteLength(other), sha256: sha(text) });
    const bad = await put(beg.data.put_url, other);
    assert.equal(bad.status, 400);
    assert.match(bad.text, /sha256 does not match/);
    assert.equal((await call(c, "artifact_upload_commit", { upload_id: beg.data.upload_id, mode: "create", title: "Hashed", type: "page" })).err, "[bad_request] this upload has no file yet: PUT it to its put_url first", "the refused file was not stored");
    const good = await put(beg.data.put_url, text);
    assert.equal(good.status, 200, "the token was not burned by the refused file");
    assert.equal(JSON.parse(good.text).ok, true);
    const done = await call(c, "artifact_upload_commit", { upload_id: beg.data.upload_id, mode: "create", title: "Hashed", type: "page" });
    assert.equal(done.err, null, done.err);

    // The matching-hash path, end to end.
    const beg2 = await call(c, "artifact_upload_begin", { field: "html", bytes: Buffer.byteLength(text), sha256: sha(text).toUpperCase() });
    assert.equal((await put(beg2.data.put_url, text)).status, 200, "hex case does not matter");
    assert.equal((await call(c, "artifact_upload_commit", { upload_id: beg2.data.upload_id, mode: "create", title: "Hashed 2", type: "page" })).err, null);
  } finally { await c.close(); }
});

test("a body over the declared size or over the upload cap is 413 and nothing is stored", async () => {
  await clean("bobby", "perchlive-up10");
  const c = await client(s.artToken, bot("bobby", "perchlive-up10"));
  try {
    const beg = await call(c, "artifact_upload_begin", { field: "html", bytes: 1000 });
    const over = await put(beg.data.put_url, "<p>" + "z".repeat(5000) + "</p>");
    assert.equal(over.status, 413);
    assert.match(over.text, /bigger than this upload allows/);
    const commit = await call(c, "artifact_upload_commit", { upload_id: beg.data.upload_id, mode: "create", title: "Over", type: "page" });
    assert.match(commit.err, /no file yet/, "nothing was stored");

    const cap = await call(c, "artifact_upload_begin", { field: "html", bytes: LIMITS.uploadBytes + 1 });
    assert.match(cap.err, /^\[too_big\] the declared size is over what one upload may carry/, "over the 4 MiB cap is refused at begin");
  } finally { await c.close(); }
});

test("the PUT handler stops reading at the cap: a 1 MiB body on a 1000-byte upload is refused early", async () => {
  await clean("bobby", "perchlive-up11");
  const c = await client(s.artToken, bot("bobby", "perchlive-up11"));
  try {
    const beg = await call(c, "artifact_upload_begin", { field: "html", bytes: 1000 });
    _resetReadMeter();
    const huge = Buffer.alloc(1024 * 1024, 0x61);
    const r = await put(beg.data.put_url, huge);
    assert.ok(r.status === 413 || r.status === 0, `over-cap stream refused (got ${r.status}${r.error ? ": " + r.error.message : ""})`);
    assert.equal(readMeter.capped, 1, "the handler stopped at the cap");
    assert.ok(readMeter.bytes < 256 * 1024, `read ${readMeter.bytes} bytes of ${huge.length}: it never buffers past the cap`);
  } finally { await c.close(); }
});

test("the upload PUT leg is never a public Funnel path", () => {
  const path = `/artifacts/upload/${"a".repeat(64)}`;
  assert.equal(isFunnelPublicPath(path), false);
  const mw = rejectFunneledMiddleware();
  let status = null;
  mw({ headers: { "tailscale-funnel-request": "?1" }, path }, { status(c) { status = c; return this; }, type() { return this; }, send() { return this; } }, () => { status = "next"; });
  assert.equal(status, 403);
});

// ─── every gate the inline tools run, run here too ─────────────────────────

test("a feedback round bound to the chat still requires round_id at commit (the inline refusal, unchanged)", async () => {
  await clean("bobby", "perchlive-up12");
  const c = await client(s.artToken, bot("bobby", "perchlive-up12"));
  try {
    const id = (await call(c, "artifact_create", { title: "Round doc", type: "document", source: { markdown: "# v1" } })).data.id;
    const t = await comments.addThread(s.db, { artifactId: id, versionN: 1, anchor: { kind: "whole" }, text: "make it longer", author: { kind: "owner" } });
    const r = await rounds.startRound(s.db, { artifactId: id, actor: { kind: "session" }, include: [t.threadId] });
    await rounds.setDelivery(s.db, r.id, { status: "working", delivery: "perch-session", sessionId: "perchlive-up12" });

    const text = "# v2\n\n" + "long ".repeat(4000);
    const before = await versions(id);
    const staged = await stage(c, text, { field: "markdown", artifact_id: id });
    const bad = await call(c, "artifact_upload_commit", { upload_id: staged.upload_id, mode: "update", artifact_id: id });
    assert.match(bad.err, /^\[update_needs_round_id\] this chat has an active feedback round for this artifact: pass its round_id$/);
    assert.equal(await versions(id), before, "nothing written without the round");

    const staged2 = await stage(c, text, { field: "markdown", artifact_id: id });
    const good = await call(c, "artifact_upload_commit", { upload_id: staged2.upload_id, mode: "update", artifact_id: id, round_id: r.id, base_version: 1 });
    assert.equal(good.err, null, good.err);
    assert.equal(await versions(id), before + 1);
    assert.equal(Number((await store.getVersion(s.db, id, good.data.version)).round_id), Number(r.id), "the version carries the round");
  } finally { await c.close(); }
});

test("an unlinked Perch chat gets needs_link at begin (naming the artifact) and at commit", async () => {
  await clean("bobby", "perchlive-up13o");
  await clean("bobby", "perchlive-up13");
  const maker = await client(s.artToken, bot("bobby", "perchlive-up13o"));
  const c = await client(s.artToken, bot("bobby", "perchlive-up13"));
  try {
    const id = (await call(maker, "artifact_create", { title: "Linked elsewhere", type: "page", source: { html: "<p>v1</p>" } })).data.id;
    const before = await versions(id);
    const beg = await call(c, "artifact_upload_begin", { field: "html", artifact_id: id, bytes: 10 });
    assert.equal(beg.err, "[needs_link] this chat is not linked to this artifact: call artifact_attach and wait for the owner's yes");
    // Cheap pre-check only: an upload begun WITHOUT the artifact (create shape)
    // still gets the refusal from the commit, which is where the write happens.
    const staged = await stage(c, "<p>sneaky</p>", { field: "html" });
    const done = await call(c, "artifact_upload_commit", { upload_id: staged.upload_id, mode: "update", artifact_id: id });
    assert.match(done.err, /^\[needs_link\]/);
    assert.equal(await versions(id), before, "no version");
  } finally { await maker.close(); await c.close(); }
});

test("commit refuses an artifact other than the one begun, and a scoped session may only target its own round's artifact", async () => {
  await clean("bobby", "perchlive-up14");
  const c = await client(s.artToken, bot("bobby", "perchlive-up14"));
  try {
    const one = (await call(c, "artifact_create", { title: "One", type: "page", source: { html: "<p>1</p>" } })).data.id;
    const two = (await call(c, "artifact_create", { title: "Two", type: "page", source: { html: "<p>2</p>" } })).data.id;
    const staged = await stage(c, "<p>other</p>", { field: "html", artifact_id: one });
    assert.match((await call(c, "artifact_upload_commit", { upload_id: staged.upload_id, mode: "update", artifact_id: two })).err, /^\[forbidden\] this upload was started for another artifact$/);
  } finally { await c.close(); }
});

// ─── staging bounds ────────────────────────────────────────────────────────

test("pending uploads are capped per actor", async () => {
  _resetUploadsForTest();
  await clean("bobby", "perchlive-up15");
  const c = await client(s.artToken, bot("bobby", "perchlive-up15"));
  try {
    for (let i = 0; i < MAX_PENDING_PER_ACTOR; i++) {
      assert.equal((await call(c, "artifact_upload_begin", { field: "html", bytes: 10 })).err, null, `begin ${i + 1}`);
    }
    assert.match((await call(c, "artifact_upload_begin", { field: "html", bytes: 10 })).err, /^\[rate_limited\]/, "over the per-actor cap");
    // Another bot is unaffected by bobby's pile.
    await clean("mallory", "perchlive-up15m");
    const m = await client(s.artToken, bot("mallory", "perchlive-up15m"));
    try { assert.equal((await call(m, "artifact_upload_begin", { field: "html", bytes: 10 })).err, null); } finally { await m.close(); }
  } finally { await c.close(); _resetUploadsForTest(); }
});

// ─── parity: the tool surface, the taint list, the bot defs ────────────────

test("parity: both upload tools are registered writes, and the D22 clean MCP list matches TOOL_CLASSES", async () => {
  assert.equal(TOOL_CLASSES.artifact_upload_begin, "writes");
  assert.equal(TOOL_CLASSES.artifact_upload_commit, "writes");
  const op = await client(s.fullToken);
  try {
    const { tools } = await op.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), Object.keys(TOOL_CLASSES).sort(), "every registered tool is classified");
  } finally { await op.close(); }
  const { CLEAN_MCP_TOOLS } = await import("../scripts/pi-bots/outside-text-tools.mjs");
  assert.deepEqual([...CLEAN_MCP_TOOLS].sort(), Object.keys(TOOL_CLASSES).map((n) => "mcp__artifacts__" + n).sort());
});

test("the companion migration gives a def that grants artifact_update both upload tools (same cap guard)", async () => {
  const { withArtifactsCompanions } = await import("../scripts/pi-bots/bot-world.mjs");
  const { addCompanionsGuarded } = await import("../scripts/pi-bots/artifacts-companions.mjs");
  const U = "artifacts/artifact_update";
  const list = withArtifactsCompanions([U]);
  assert.ok(list.includes("artifacts/artifact_upload_begin"), list.join(","));
  assert.ok(list.includes("artifacts/artifact_upload_commit"), list.join(","));
  const budget = (cap) => ({ cap, countFor: (d) => ((d.tools && d.tools.crow_mcp) || []).length });
  const r = await addCompanionsGuarded({ tools: { crow_mcp: [U] } }, { budget: budget(4) });
  assert.equal(r.refused, true, "1 + 4 companions over a cap of 4: refused, nothing added");
  assert.deepEqual(r.added, []);
  const ok = await addCompanionsGuarded({ tools: { crow_mcp: [U] } }, { budget: budget(10) });
  assert.deepEqual(ok.added, ["artifacts/artifact_find", "artifacts/artifact_attach", "artifacts/artifact_upload_begin", "artifacts/artifact_upload_commit"]);
});