// Crow Artifacts — the owner's "Import file": POST /api/artifacts/:id/import.
// The file's TEXT becomes the artifact's next version, shaped by its type
// (page: html, document: markdown, diagram: svg — or a Design-kit diagram's
// {engine, source}). Owner session + CSRF only; every refusal is a static
// string. The viewer's toolbar button and the client's POST are pinned
// statically (textContent only, no innerHTML).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import express from "express";
import { createDbClient } from "../servers/db.js";
import { markdownBlocks } from "../servers/blog/renderer.js";
import { csrfMiddleware } from "../servers/gateway/dashboard/shared/csrf.js";
import * as runtime from "../servers/gateway/artifact-origin/runtime.js";
import * as policy from "../servers/gateway/artifact-origin/policy.js";
import { createLocalBlobStore } from "../bundles/artifacts/server/blob-store.js";
import { initArtifactsTables } from "../bundles/artifacts/server/init-tables.js";
import { LIMITS, _overrideLimitsForTest } from "../bundles/artifacts/server/limits.js";
import * as store from "../bundles/artifacts/server/store.js";
import * as comments from "../bundles/artifacts/server/comments.js";
import artifactsRouter from "../bundles/artifacts/panel/routes.js";
import { VIEWER_STRINGS, renderViewerPage } from "../bundles/artifacts/panel/viewer-page.js";

const RENDERED = '<svg viewBox="0 0 10 10"><rect id="n1" width="5" height="5"><title>Node one</title></rect></svg>';
const REPO = fileURLToPath(new URL("..", import.meta.url));
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="5" height="5"/></svg>';
const s = { engine: [], notes: [] };
// The Design kit seam: a diagram's { engine, source } renders through it, so
// an import that keeps the engine is observable here.
const fakeKit = {
  themes: new Map(),
  resolve: () => ({ files: [], refs: [], entries: [] }),
  render: async (engine, src) => { s.engine.push([engine, src]); return RENDERED; },
};
const renderDeps = { markdownBlocks, design: { kit: async () => fakeKit } };

before(async () => {
  s.dir = mkdtempSync(join(tmpdir(), "artifacts-import-"));
  s.db = createDbClient(join(s.dir, "crow.db"));
  await initArtifactsTables(s.db);
  s.blobs = createLocalBlobStore(join(s.dir, "blobs"));
  runtime._resetForTest();
  const dashboardAuth = (req, res, next) => (/crow_session=good/.test(req.headers.cookie || "") ? next() : res.status(401).json({ error: "login" }));
  const app = express();
  // servers/gateway/index.js's split, with the REAL predicate (read from its
  // source, the idiom the other gateway tests use): the global 1mb parser skips
  // the paths whose router parses its own body — the import route's own
  // json({limit:"60mb"}) must be the one that sees a multi-megabyte file.
  const indexSrc = readFileSync(join(REPO, "servers/gateway/index.js"), "utf8");
  const predicate = /const _hasOwnParser = \(p\) => ([^\n]*\n[^\n]*);/.exec(indexSrc);
  assert.ok(predicate, "index.js's _hasOwnParser is where it was");
  const hasOwnParser = new Function("p", `return ${predicate[1]};`);
  s.hasOwnParser = hasOwnParser;
  const globalJson = express.json({ limit: "1mb" });
  app.use((req, res, next) => (hasOwnParser(req.path) ? next() : globalJson(req, res, next)));
  app.use(artifactsRouter(dashboardAuth, {
    db: s.db, blobs: s.blobs, runtime, policy, csrf: csrfMiddleware, renderDeps,
    design: null,             // the fake kit above is the only one this harness has
    createBoardCard: null,
    notify: async (n) => s.notes.push(n),
  }));
  s.http = app.listen(0, "127.0.0.1"); await new Promise((r) => s.http.once("listening", r));
  s.port = s.http.address().port;
  s.host = `127.0.0.1:${s.port}`;
});
after(() => { s.http.close(); runtime._resetForTest(); try { s.db.close(); } catch {} rmSync(s.dir, { recursive: true, force: true }); });

function req(method, path, { body, cookie = "crow_session=good; crow_csrf=tok", csrf = "tok", origin = `http://${s.host}` } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(csrf ? { "x-crow-csrf": csrf } : {}), ...(origin ? { origin } : {}) };
    const r = http.request({ host: "127.0.0.1", port: s.port, path, method, headers }, (res) => {
      let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode, body: j }); });
    });
    r.on("error", reject); if (data) r.write(data); r.end();
  });
}

const mk = (type, source, title = "Doc") => store.createArtifact(s.db, s.blobs, { title, type, source, actor: { kind: "session" } }, renderDeps);
const versions = async (id) => (await s.db.execute({ sql: "SELECT n, state, source_json, change_note FROM artifact_versions WHERE artifact_id=? ORDER BY n", args: [id] })).rows;
const currentOf = async (id) => Number((await s.db.execute({ sql: "SELECT current_version FROM artifacts WHERE id=?", args: [id] })).rows[0].current_version);
const sourceOf = async (id, n) => JSON.parse((await s.db.execute({ sql: "SELECT source_json FROM artifact_versions WHERE artifact_id=? AND n=?", args: [id, n] })).rows[0].source_json);
const imp = (id, body, opts) => req("POST", `/api/artifacts/${id}/import`, { body, ...opts });

test("a page import makes a new current version from the file's text and carries open threads forward", async () => {
  const art = await mk("page", { html: "<!doctype html><p id=b>v1</p>" }, "Page");
  const th = await comments.addThread(s.db, { artifactId: art.id, versionN: 1, anchor: { kind: "whole" }, text: "look at this", author: { kind: "owner" } });
  const r = await imp(art.id, { text: "<!doctype html><p id=b>imported</p><p>v2</p>" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { version: 2, state: "current" });
  assert.deepEqual(await sourceOf(art.id, 2), { html: "<!doctype html><p id=b>imported</p><p>v2</p>" });
  assert.equal(await currentOf(art.id), 2, "the import is the current version");
  const rows = await versions(art.id);
  assert.equal(rows.at(-1).state, "current");
  assert.equal(rows.at(-1).change_note, "Imported from a file", "the default change note");
  const moved = (await s.db.execute({ sql: "SELECT version_n FROM artifact_threads WHERE id=?", args: [th.threadId] })).rows[0];
  assert.equal(Number(moved.version_n), 2, "the open thread came forward");
});

test("the owner's own change note is stored as given", async () => {
  const art = await mk("page", { html: "<p>v1</p>" }, "Page note");
  const r = await imp(art.id, { text: "<p>v2</p>", change_note: "from my editor" });
  assert.equal(r.status, 200);
  assert.equal((await versions(art.id)).at(-1).change_note, "from my editor");
});

test("a document import becomes the new markdown", async () => {
  const art = await mk("document", { markdown: "# One" }, "Doc");
  const r = await imp(art.id, { text: "# Imported\n\nBody **text**." });
  assert.equal(r.status, 200);
  assert.equal(r.body.state, "current");
  assert.deepEqual(await sourceOf(art.id, 2), { markdown: "# Imported\n\nBody **text**." });
  assert.equal(await currentOf(art.id), 2);
});

test("a diagram import becomes the new svg", async () => {
  const art = await mk("diagram", { svg: SVG }, "Diagram");
  const next = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><circle cx="5" cy="5" r="4"/></svg>';
  const r = await imp(art.id, { text: next });
  assert.equal(r.status, 200);
  assert.deepEqual(await sourceOf(art.id, 2), { svg: next });
});

test("a Design-kit diagram keeps its engine: the file is the spec, not an svg", async () => {
  const art = await mk("diagram", { engine: "mermaid", source: "flowchart LR\n  a --> b" }, "Kit diagram");
  assert.equal(s.engine.at(-1)[0], "mermaid", "v1 rendered through the kit");
  const r = await imp(art.id, { text: "flowchart TD\n  x --> y" });
  assert.equal(r.status, 200);
  assert.deepEqual(await sourceOf(art.id, 2), { engine: "mermaid", source: "flowchart TD\n  x --> y" });
  assert.deepEqual(s.engine.at(-1), ["mermaid", "flowchart TD\n  x --> y"], "rendered with the kept engine");
});

test("over the upload cap → 413, no version is written; a document's markdown cap is tighter", async () => {
  const art = await mk("page", { html: "<p>v1</p>" }, "Cap");
  const doc = await mk("document", { markdown: "# d" }, "Cap doc");
  const restore = _overrideLimitsForTest({ uploadBytes: 64, documentMarkdownBytes: 32 });
  try {
    const big = await imp(art.id, { text: "<p>" + "x".repeat(100) + "</p>" });
    assert.equal(big.status, 413);
    assert.equal(big.body.error, "too_large");
    assert.equal((await versions(art.id)).length, 1, "no version");
    assert.equal(await currentOf(art.id), 1);
    const md = await imp(doc.id, { text: "y".repeat(40) });
    assert.equal(md.status, 413, "under uploadBytes, over documentMarkdownBytes");
    assert.equal((await versions(doc.id)).length, 1);
  } finally { restore(); }
});

test("a 2 MB file gets through the gateway's global 1 MB parser (the route parses its own body); a 5 MB one is the route's own 413", async () => {
  // The viewer offers up to 4 MiB. The global express.json({limit:"1mb"}) in
  // servers/gateway/index.js would 413 that long before the router's own parser
  // ran, so `_hasOwnParser` names this route — the harness above wires the real
  // predicate, so this is the prod path, not a stand-in.
  assert.equal(s.hasOwnParser("/api/artifacts/art_abc12345/import"), true, "the import route parses its own body");
  assert.equal(s.hasOwnParser("/API/Artifacts/art_abc12345/Import"), true, "…case-insensitively");
  assert.equal(s.hasOwnParser("/api/artifacts/art_abc12345/import/"), true, "…and with a trailing slash (Express is non-strict)");
  assert.equal(s.hasOwnParser("/api/artifacts/art_abc12345/versions"), false, "every other artifact route keeps the global parser");
  assert.equal(s.hasOwnParser("/api/artifacts/import"), false, "…and so does a look-alike path with no id");

  const art = await mk("page", { html: "<p>v1</p>" }, "Two megabytes");
  const big = "<p>" + "x".repeat(2 * 1024 * 1024) + "</p>";
  const r = await imp(art.id, { text: big });
  assert.equal(r.status, 200, "2 MB of text is over the 1 MB global parser and under the route's 4 MiB cap");
  assert.equal(r.body.state, "current");
  assert.equal((await sourceOf(art.id, 2)).html.length, big.length, "nothing was truncated on the way");

  const over = await imp(art.id, { text: "<p>" + "y".repeat(5 * 1024 * 1024) + "</p>" });
  assert.equal(over.status, 413, "5 MB is the ROUTE's own answer, not the parser's");
  assert.equal(over.body.error, "too_large", "…with the route's JSON code, so the parser never saw it");
  assert.equal(await currentOf(art.id), 2, "no version beyond the good import");
});

test("a Design-kit diagram's spec is capped at diagramSourceBytes (the upload path's own ceiling); an svg import is not", async () => {
  const kit = await mk("diagram", { engine: "mermaid", source: "flowchart LR\n  a --> b" }, "Kit cap");
  const svgArt = await mk("diagram", { svg: SVG }, "Svg cap");
  const spec = "flowchart LR\n" + "  a --> b\n".repeat(Math.ceil(LIMITS.diagramSourceBytes / 10) + 4);
  assert.ok(Buffer.byteLength(spec) > LIMITS.diagramSourceBytes, "the fixture is over the spec cap");
  assert.ok(Buffer.byteLength(spec) < LIMITS.uploadBytes, "…and well under the 4 MiB upload cap");
  const r = await imp(kit.id, { text: spec });
  assert.equal(r.status, 413);
  assert.equal(r.body.error, "too_large");
  assert.equal((await versions(kit.id)).length, 1, "no version was written");
  // The same size as an SVG is fine: a finished drawing is a page-sized file.
  const rect = '<rect x="1" y="1" width="2" height="2"/>';
  const bigSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' + rect.repeat(Math.ceil((LIMITS.diagramSourceBytes + 1024) / rect.length)) + '</svg>';
  assert.ok(Buffer.byteLength(bigSvg) > LIMITS.diagramSourceBytes);
  assert.equal((await imp(svgArt.id, { text: bigSvg })).status, 200, "an svg diagram keeps the 4 MiB cap");
  // …and a spec just under the cap still lands.
  const ok = "flowchart TD\n  x --> y";
  assert.equal((await imp(kit.id, { text: ok })).status, 200);
  assert.deepEqual(await sourceOf(kit.id, 2), { engine: "mermaid", source: ok });
});

test("an over-long change note is refused with 400 (never silently truncated)", async () => {
  const art = await mk("page", { html: "<p>v1</p>" }, "Note cap");
  const long = "n".repeat(LIMITS.changeNoteChars + 1);
  const r = await imp(art.id, { text: "<p>v2</p>", change_note: long });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "too_long");
  assert.equal(r.body.message, `a change note is limited to ${LIMITS.changeNoteChars} characters`);
  assert.equal((await versions(art.id)).length, 1, "nothing was written");
  // Exactly the cap is allowed, and stored whole.
  const atCap = "m".repeat(LIMITS.changeNoteChars);
  assert.equal((await imp(art.id, { text: "<p>v2</p>", change_note: atCap })).status, 200);
  assert.equal((await versions(art.id)).at(-1).change_note, atCap);
});

test("an empty (or non-string) text is refused with 400", async () => {  const art = await mk("page", { html: "<p>v1</p>" }, "Empty");
  assert.equal((await imp(art.id, { text: "   \n " })).status, 400);
  assert.equal((await imp(art.id, {})).status, 400);
  assert.equal((await versions(art.id)).length, 1);
});

test("owner-only: no session → 401; missing or wrong CSRF → 403; nothing written", async () => {
  const art = await mk("page", { html: "<p>v1</p>" }, "Auth");
  const body = { text: "<p>v2</p>" };
  assert.equal((await imp(art.id, body, { cookie: null })).status, 401);
  assert.equal((await imp(art.id, body, { csrf: null })).status, 403);
  assert.equal((await imp(art.id, body, { csrf: "wrong" })).status, 403);
  assert.equal((await versions(art.id)).length, 1);
});

test("an unknown artifact → 404", async () => {
  const r = await imp("art_nosuchid", { text: "<p>x</p>" });
  assert.equal(r.status, 404);
});

test("a received artifact is refused (addVersion's rule), with a static message", async () => {
  const art = await mk("page", { html: "<p>received</p>" }, "Received");
  await s.db.execute({ sql: "UPDATE artifacts SET received=1 WHERE id=?", args: [art.id] });
  const r = await imp(art.id, { text: "<p>mine now</p>" });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, "forbidden");
  assert.equal(r.body.message, "a received artifact cannot be edited");
  assert.equal((await versions(art.id)).length, 1);
});

test("static: the viewer page carries the Import button and the file input (en + es)", () => {
  const en = renderViewerPage({ lang: "en", id: "art_abc12345" });
  assert.match(en, /<button type="button" class="cv-import" id="cv-import-btn" hidden>Import file<\/button>/);
  assert.match(en, /<input type="file" id="cv-import-file" accept="\.html,\.htm,\.md,\.markdown,\.svg,\.txt,text\/\*,image\/svg\+xml" hidden/);
  const es = renderViewerPage({ lang: "es", id: "art_abc12345" });
  assert.match(es, /id="cv-import-btn" hidden>Importar archivo<\/button>/);
  assert.equal(VIEWER_STRINGS.en.import_file, "Import file");
  assert.equal(VIEWER_STRINGS.es.import_file, "Importar archivo");
  assert.notEqual(VIEWER_STRINGS.es.import_failed, VIEWER_STRINGS.en.import_failed);
});

test("static: the client posts to /import with the CSRF header and never uses innerHTML", () => {
  const src = readFileSync(new URL("../bundles/artifacts/panel/static/viewer-client.js", import.meta.url), "utf8");
  assert.match(src, /api\("POST", BASE \+ "\/import", \{ text: text, change_note: note \}\)/);
  assert.match(src, /"x-crow-csrf": csrf\(\)/, "the shared helper sends the CSRF header");
  assert.match(src, /if \(f\.size > IMPORT_MAX\) \{ banner\(T\.import_too_large, "warn"\); return; \}/, "refused client-side over 4 MiB");
  assert.match(src, /reader\.readAsText\(f\)/, "read as text");
  assert.match(src, /banner\(fmt\(T\.import_failed, \{ e: \(e && e\.message\) \|\| "" \}\), "warn"\)/, "errors in the message area");
  assert.doesNotMatch(src, /innerHTML/, "nothing is placed with innerHTML");
});