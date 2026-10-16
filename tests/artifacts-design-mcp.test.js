// Artifacts × Design kit over the real MCP rail (spec §4.1–§4.3, §6): libs on
// create/update, the design result, refusals that carry no authored text.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
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
import { localTokenAuthMiddleware, generateArtifactsToken } from "../servers/gateway/local-token.js";
import { markdownBlocks } from "../servers/blog/renderer.js";
import { initArtifactsTables } from "../bundles/artifacts/server/init-tables.js";
import { createLocalBlobStore } from "../bundles/artifacts/server/blob-store.js";
import { createArtifactsMcpServer } from "../bundles/artifacts/server/mcp.js";
import * as comments from "../bundles/artifacts/server/comments.js";
import * as store from "../bundles/artifacts/server/store.js";
import { openKit } from "../bundles/design-kit/server/kit.js";
import { initGatewayActorKey, signArtifactsActor, verifyArtifactsActorSig } from "../scripts/pi-bots/actor-sig.mjs";

initGatewayActorKey();
const KIT_DIR = new URL("../bundles/design-kit", import.meta.url).pathname;
const saved = { CROW_HOME: process.env.CROW_HOME, CROW_DATA_DIR: process.env.CROW_DATA_DIR };
const s = { kitOn: true, reply: { status: 200, body: { svg: '<svg viewBox="0 0 4 2"><rect id="r"/></svg>' } }, houseStyle: {} };

before(async () => {
  s.home = mkdtempSync(join(tmpdir(), "art-design-mcp-"));
  process.env.CROW_HOME = s.home; process.env.CROW_DATA_DIR = join(s.home, "data");
  s.db = createDbClient(join(s.home, "crow.db"));
  await s.db.executeMultiple(`
    CREATE TABLE dashboard_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE dashboard_settings_overrides (key TEXT NOT NULL, instance_id TEXT NOT NULL, value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now')), lamport_ts INTEGER DEFAULT 0, PRIMARY KEY (key, instance_id));
    CREATE TABLE bot_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id TEXT, gateway_type TEXT, gateway_thread_id TEXT, kind TEXT, status TEXT, narrowed_tools TEXT, card_id INTEGER);`);
  await initArtifactsTables(s.db);
  await s.db.execute({ sql: "INSERT INTO bot_sessions (bot_id, gateway_type, gateway_thread_id, kind, status) VALUES ('bobby','perch','perchlive-d1','perch-live','active')", args: [] });
  s.blobs = createLocalBlobStore(join(s.home, "blobs"));
  s.artToken = await generateArtifactsToken(s.db);
  s.kit = openKit(KIT_DIR, { fetchImpl: async () => ({ status: s.reply.status, json: async () => s.reply.body }) });
  const design = { kit: async () => (s.kitOn ? s.kit : null), houseStyleFor: async (botId) => s.houseStyle[botId] || null };
  const app = express();
  app.use(express.json({ limit: "5mb" }));
  app.use(localTokenAuthMiddleware(s.db));
  mountMcpServer(app, "/artifacts", () => createArtifactsMcpServer({ db: s.db, blobs: s.blobs, McpServer, z, verifyActor: verifyArtifactsActorSig, renderDeps: { markdownBlocks, design } }), new SessionManager(), (req, res) => res.status(401).end());
  s.http = app.listen(0); await new Promise((r) => s.http.once("listening", r));
  s.port = s.http.address().port;
});
after(async () => {
  s.http.closeAllConnections?.(); await new Promise((r) => s.http.close(r));
  try { s.db.close(); } catch {}
  rmSync(s.home, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

const hdr = (id, thread) => ({ "X-Crow-Actor-Kind": "bot", "X-Crow-Actor-Id": id, "X-Crow-Actor-Thread": thread, "X-Crow-Actor-Gateway": "perch", "X-Crow-Actor-Sig": signArtifactsActor({ botId: id, threadId: thread, gatewayType: "perch" }) });
async function client() {
  const t = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${s.port}/artifacts/mcp`), { requestInit: { headers: { ...hdr("bobby", "perchlive-d1"), Authorization: `Bearer ${s.artToken}` } } });
  const c = new Client({ name: "design-test", version: "0" }); await c.connect(t); return c;
}
const call = async (c, name, args) => { const r = await c.callTool({ name, arguments: args }); return { err: r.isError ? r.content[0].text : null, data: r.isError ? null : JSON.parse(r.content[0].text) }; };

test("create with libs: the files are in the version, the source keeps the names, the result lists the paths", async () => {
  const c = await client();
  try {
    const made = await call(c, "artifact_create", { title: "Card", type: "page", source: { html: "<p>x</p>", libs: ["css:pico"] }, libs: ["css:pico", "icons:lucide/coffee"] });
    assert.equal(made.err, null);
    assert.deepEqual(made.data.design.libs, ["__lib/css/pico/pico.min.css", "__lib/icons/lucide/coffee.svg"]);
    const got = await call(c, "artifact_get", { artifact_id: made.data.id });
    assert.deepEqual(got.data.version.source.libs, ["css:pico", "icons:lucide/coffee"], "merged, deduplicated, kept for the next round");
    const v = await store.getVersion(s.db, made.data.id, 1);
    assert.ok(JSON.parse(v.files_json).some((f) => f.path === "__lib/icons/lucide/coffee.svg"));
    s.pageId = made.data.id;
  } finally { await c.close(); }
});

test("update renders a diagram spec; the spec is the stored source", async () => {
  const c = await client();
  try {
    const made = await call(c, "artifact_create", { title: "Flow", type: "diagram", source: { engine: "d2", source: "a -> b" } });
    assert.equal(made.err, null);
    assert.equal(made.data.design.rendered, 1);
    const up = await call(c, "artifact_update", { artifact_id: made.data.id, source: { engine: "d2", source: "a -> b -> c" } });
    assert.equal(up.err, null);
    assert.equal(up.data.state, "current");
    assert.deepEqual((await call(c, "artifact_get", { artifact_id: made.data.id })).data.version.source, { engine: "d2", source: "a -> b -> c" });
  } finally { await c.close(); }
});

test("kit off: libs and {engine, source} refused with kit_missing; fences save as code (amended §4.3)", async () => {
  s.kitOn = false;
  const c = await client();
  try {
    assert.match((await call(c, "artifact_create", { title: "x", type: "page", source: { html: "x" }, libs: ["css:pico"] })).err, /^\[kit_missing\] the Design kit extension isn't installed/);
    assert.match((await call(c, "artifact_create", { title: "x", type: "diagram", source: { engine: "d2", source: "a -> b" } })).err, /^\[kit_missing\]/);
    const fenced = await call(c, "artifact_create", { title: "how-to", type: "document", source: { markdown: "```mermaid\nflowchart LR\n A-->B\n```" } });
    assert.equal(fenced.err, null);
    assert.equal(fenced.data.design, undefined, "no note: today's behaviour");
  } finally { s.kitOn = true; await c.close(); }
});

test("renderer down: a fenced document saves with the note; a diagram spec is a retryable refusal", async () => {
  s.reply = { status: 503, body: { error: { code: "busy" } } };
  const c = await client();
  try {
    const doc = await call(c, "artifact_create", { title: "chart doc", type: "document", source: { markdown: "# Q3\n\n```mermaid\nflowchart LR\n A-->B\n```" } });
    assert.equal(doc.err, null);
    assert.deepEqual(doc.data.design.notes.length, 1);
    assert.match(doc.data.design.notes[0], /^renderer_unavailable:/);
    assert.equal((await call(c, "artifact_create", { title: "d", type: "diagram", source: { engine: "d2", source: "a -> b" } })).err, "[render_unavailable] the chart and diagram renderer is not answering; try again in a minute");
  } finally { s.reply = { status: 200, body: { svg: '<svg viewBox="0 0 4 2"><rect id="r"/></svg>' } }; await c.close(); }
});

test("a client retry does not duplicate (review M10)", async () => {
  const c = await client();
  try {
    const args = { title: "Retry me", type: "document", source: { markdown: "# Same\n\nText." } };
    const a = await call(c, "artifact_create", args);
    const b = await call(c, "artifact_create", args);
    assert.equal(b.data.id, a.data.id, "same artifact");
    assert.equal(Number((await s.db.execute({ sql: "SELECT COUNT(*) AS n FROM artifacts WHERE title='Retry me'", args: [] })).rows[0].n), 1);
    const u1 = await call(c, "artifact_update", { artifact_id: a.data.id, source: { markdown: "# Same\n\nMore." } });
    const u2 = await call(c, "artifact_update", { artifact_id: a.data.id, source: { markdown: "# Same\n\nMore." } });
    assert.equal(u2.data.version, u1.data.version, "same version");
    assert.equal(Number((await s.db.execute({ sql: "SELECT COUNT(*) AS n FROM artifact_versions WHERE artifact_id=?", args: [a.data.id] })).rows[0].n), 2);
  } finally { await c.close(); }
});

test("error paths carry no authored or renderer text (Review Focus 3)", async () => {
  const SENT = "SENTINEL-DESIGN-ERR-404";
  await comments.addThread(s.db, { artifactId: s.pageId, versionN: 1, anchor: { kind: "whole" }, text: SENT, author: { kind: "contact", id: SENT + "-id" } });
  s.reply = { status: 422, body: { error: { code: "render_failed", category: SENT, line: 3, message: SENT } } };
  const c = await client();
  try {
    const cases = [
      ["artifact_create", { title: SENT, type: "document", source: { markdown: "```mermaid\nflowchart LR\n " + SENT + "\n```" } }],
      ["artifact_create", { title: SENT, type: "page", source: { html: SENT }, libs: [SENT.toLowerCase()] }],
      ["artifact_update", { artifact_id: s.pageId, source: { html: SENT, libs: ["vega-embed", SENT] } }],
      ["artifact_create", { title: SENT, type: "diagram", source: { engine: "vega-lite", source: JSON.stringify({ data: { url: SENT } }) } }],
    ];
    for (const [name, args] of cases) {
      const r = await c.callTool({ name, arguments: args });
      assert.equal(r.isError, true, name);
      assert.ok(!JSON.stringify(r).toLowerCase().includes(SENT.toLowerCase()), `${name} leaked ${JSON.stringify(r)}`);
    }
    assert.equal((await call(c, "artifact_create", { title: "x", type: "document", source: { markdown: "```mermaid\nflowchart LR\n A-->B\n```" } })).err, "[render_failed] mermaid: render error at line 3");
  } finally { s.reply = { status: 200, body: { svg: '<svg viewBox="0 0 4 2"><rect id="r"/></svg>' } }; await c.close(); }
});

test("ruling F11: an update is a retry only under the same round id (or both none)", async () => {
  const actor = { kind: "bot", id: "bobby", thread: "perchlive-d1", gateway: "perch" };
  const deps = { markdownBlocks, design: { kit: async () => s.kit, houseStyleFor: async () => null } };
  const made = await store.createArtifact(s.db, s.blobs, { title: "Rounds", type: "document", source: { markdown: "# R\n\nv1" }, actor }, deps);
  const src = { markdown: "# R\n\nv2" };
  const a = await store.addVersion(s.db, s.blobs, { artifactId: made.id, source: src, actor, roundId: 7 }, deps);
  assert.equal(a.duplicate, undefined);
  const same = await store.addVersion(s.db, s.blobs, { artifactId: made.id, source: src, actor, roundId: 7 }, deps);
  assert.equal(same.duplicate, true, "same round id: a retry");
  assert.equal(same.n, a.n);
  const other = await store.addVersion(s.db, s.blobs, { artifactId: made.id, source: src, actor, roundId: 8 }, deps);
  assert.equal(other.duplicate, undefined, "a different round id is never swallowed");
  assert.equal(other.n, a.n + 1);
  const none = await store.addVersion(s.db, s.blobs, { artifactId: made.id, source: src, actor }, deps);
  assert.equal(none.duplicate, undefined, "an absent round id never matches a round's version");
  assert.equal(none.n, other.n + 1);
});

test("idempotency runs after the link gate: an unlinked chat repeating the current content gets needs_link", async () => {
  const c = await client();
  let made;
  try {
    made = await call(c, "artifact_create", { title: "Gate first", type: "document", source: { markdown: "# G\n\nSame." } });
    assert.equal(made.err, null);
  } finally { await c.close(); }
  const t = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${s.port}/artifacts/mcp`), { requestInit: { headers: { ...hdr("bobby", "perchlive-d2"), Authorization: `Bearer ${s.artToken}` } } });
  const other = new Client({ name: "design-test-2", version: "0" }); await other.connect(t);
  try {
    const r = await call(other, "artifact_update", { artifact_id: made.data.id, source: { markdown: "# G\n\nSame." } });
    assert.match(r.err || "", /^\[needs_link\]/);
  } finally { await other.close(); }
});

test("house style set: the theme is added on save and reported; kit gone: save works with no theme (Review Focus 2)", async () => {
  const [themeId] = s.kit.themes.keys();
  s.houseStyle.bobby = themeId;
  const c = await client();
  try {
    const made = await call(c, "artifact_create", { title: "Brief", type: "document", source: { markdown: "# Brief\n\nText." } });
    assert.equal(made.err, null);
    assert.equal(made.data.design.house_style, themeId);
    const v = await store.getVersion(s.db, made.data.id, 1);
    assert.ok(JSON.parse(v.files_json).some((f) => f.path === `__lib/themes/${themeId}.css`));
    s.kitOn = false;
    const plain = await call(c, "artifact_update", { artifact_id: made.data.id, source: { markdown: "# Brief\n\nMore." } });
    assert.equal(plain.err, null, "house style set but kit gone: save works, no theme");
    assert.equal(plain.data.design, undefined);
    assert.match((await call(c, "artifact_update", { artifact_id: made.data.id, source: { markdown: "# B", libs: ["css:pico"] } })).err, /^\[kit_missing\]/);
  } finally { s.kitOn = true; delete s.houseStyle.bobby; await c.close(); }
});

test("house style on a page: the save result names the files to link (review M3)", async () => {
  const [themeId] = s.kit.themes.keys();
  s.houseStyle.bobby = themeId;
  const c = await client();
  try {
    const made = await call(c, "artifact_create", { title: "Landing", type: "page", source: { html: "<h1>Hi</h1>" } });
    assert.equal(made.err, null);
    const t = s.kit.themes.get(themeId);
    const fonts = [...new Set([t.fonts.heading, t.fonts.body])];
    assert.deepEqual(made.data.design.house_style_links, [...fonts.map((f) => `__lib/font/${f.slice(5)}/font.css`), `__lib/themes/${themeId}.css`]);
    const files = JSON.parse((await store.getVersion(s.db, made.data.id, 1)).files_json).map((f) => f.path);
    for (const p of made.data.design.house_style_links) assert.ok(files.includes(p), `${p} is in the version`);
  } finally { delete s.houseStyle.bobby; await c.close(); }
});

test("final review M4: the gateway mount imports design.js on its own, and a failure leaves design = null instead of skipping the Artifacts mount", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../servers/gateway/boot/mcp-mounts.js", import.meta.url), "utf8");
  const all = src.match(/await Promise\.all\(\[("[^"]+\.js",? ?)+\]\.map\(imp\)\)/);
  assert.ok(all, "the bundle modules load together");
  assert.doesNotMatch(all[0], /design\.js/, "design.js is not in the all-or-nothing import");
  assert.match(src, /let design = null;\s*try \{ design = \(await imp\("design\.js"\)\)\.createDesign\(/);
  assert.match(src, /catch \(e\) \{ console\.warn\(`\[gateway\] artifacts: the Design kit seam could not be loaded/);
});
