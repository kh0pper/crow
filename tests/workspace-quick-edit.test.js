/** Task 14 (spec §8): Office › Quick edit — server-rendered phone edits as crow-bot, PRG, CSRF, K5 queue. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { startFakeNextcloud } from "./helpers/workspace-fake-nextcloud.js";

const ROOT = join(import.meta.dirname, "..");
const FIX = join(ROOT, "tests", "fixtures", "workspace");
const DOCX = "Shared with Crow/Casa/r.docx", XLSX = "Shared with Crow/Casa/r.xlsx", PPTX = "Shared with Crow/Casa/r.pptx";
const P1 = "Tacos al pastor con piña y jalapeño.";
let fake, base, server, V, home, db, t = 1_800_000_000_000;
before(async () => {
  fake = await startFakeNextcloud();
  fake.addFolder("Shared with Crow/Casa", { owner: "admin" });
  for (const e of ["docx", "xlsx", "pptx"]) fake.addFile(`Shared with Crow/Casa/r.${e}`, readFileSync(join(FIX, `oo-rich.${e}`)), { owner: "admin" });
  home = mkdtempSync(join(tmpdir(), "ws-quick-")); mkdirSync(join(home, "bundles", "workspace"), { recursive: true }); mkdirSync(join(home, "data"), { recursive: true });
  writeFileSync(join(home, "bundles", "workspace", ".env"), "WORKSPACE_BOOTSTRAP_DONE=1\nWORKSPACE_PUBLIC_HOST=crow.test\nWORKSPACE_BOT_APP_PASSWORD=pw-secret-123\nWORKSPACE_ONLYOFFICE_JWT_SECRET=jwt\n");
  Object.assign(process.env, { CROW_HOME: home, CROW_DATA_DIR: join(home, "data"), WORKSPACE_NC_INTERNAL_URL: fake.ncUrl, WORKSPACE_OO_INTERNAL_URL: fake.ooUrl });
  // F1: an explicit db path inside the scratch home, with the real schema (notifications…) from scripts/init-db.js
  const dbPath = join(home, "data", "crow.db");
  execFileSync(process.execPath, [join(ROOT, "scripts", "init-db.js")], { cwd: ROOT, env: { ...process.env, CROW_DB_PATH: dbPath, CROW_DISABLE_NOSTR: "1", CROW_DISABLE_INSTANCE_SYNC: "1" }, stdio: "pipe" });
  db = await (await import("../bundles/workspace/server/db.js")).openWorkspaceDb(dbPath);
  V = await import("../bundles/workspace/server/quick/view.js");
  const { default: router } = await import("../bundles/workspace/panel/routes.js");
  const app = express();
  const auth = (req, res, next) => (req.headers.cookie?.includes("crow_session=ok") ? next() : res.status(401).end());
  // Virtual clock at a realistic wall time (the fake's mtimes are ~1.79e9 s), so the mtime-spacing rule settles at once.
  const clock = { now: () => t, sleep: async (ms) => { t += ms; fake.advance(ms); } };
  app.use(router(auth, { clock, startWorker: false, csrf: (req, res, next) => (req.body?._csrf === "tok" ? next() : res.status(403).end("csrf")) }));
  server = app.listen(0); base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); fake.close(); });
const post = (path, form, cookie = "crow_session=ok") => fetch(`${base}${path}`, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie }, body: new URLSearchParams(form).toString() });
const loc = (r) => new URL(r.headers.get("location"), base);
const puts = () => fake.calls.filter((c) => c.method === "PUT").length;
const rowOf = async (id) => (await db.execute({ sql: "SELECT * FROM workspace_pending_changes WHERE id=?", args: [id] })).rows[0];

test("en/es string parity; no secret ever rendered; CSRF field present; values escaped", async () => {
  assert.deepEqual(Object.keys(V.QUICK_STRINGS.en).sort(), Object.keys(V.QUICK_STRINGS.es).sort());
  for (const lang of ["en", "es"]) for (const [k, v] of Object.entries(V.QUICK_STRINGS[lang])) assert.ok(String(v).trim(), `${lang}.${k}`);
  const html = await V.renderQuick({ lang: "es", csrf: "tok", query: { view: "quick", path: DOCX } });
  assert.doesNotMatch(html, /pw-secret-123|jwt/);
  assert.match(html, /Recetas de la semana/);
  // a fresh file has no older versions (so no Restore forms); the edit form always carries the token
  const edit = await V.renderQuick({ lang: "es", csrf: "tok", query: { view: "quick", path: DOCX, target: "0" } });
  assert.match(edit, /name="_csrf" value="tok"/);
  assert.doesNotMatch(edit, /pw-secret-123|jwt/);
  assert.doesNotMatch(html, /<script/i, "server-rendered, no client script");
  const evil = await V.renderQuick({ lang: "en", csrf: "tok", query: { view: "quick", path: "Shared with Crow/<img src=x>" } });
  assert.doesNotMatch(evil, /<img src=x>/);
});

test("browse: folders and office files only, phone-sized buttons; a cell and a paragraph render an edit form that posts back what it showed", async () => {
  const root = await V.renderQuick({ lang: "en", csrf: "tok", query: { view: "quick", path: "Shared with Crow/Casa" } });
  for (const n of ["r.docx", "r.xlsx", "r.pptx"]) assert.ok(root.includes(n), n);
  assert.match(root, /min-height:44px/);
  const para = await V.renderQuick({ lang: "en", csrf: "tok", query: { view: "quick", path: DOCX, target: "1" } });
  assert.match(para, /action="\/api\/workspace\/quick\/save"/); assert.match(para, /name="shown" value="Tacos al pastor/); assert.match(para, /<textarea name="value"/);
  const sheet = await V.renderQuick({ lang: "en", csrf: "tok", query: { view: "quick", path: XLSX } });
  assert.match(sheet, /Porciones/); assert.match(sheet, /Menú semanal/);
  const cell = await V.renderQuick({ lang: "es", csrf: "tok", query: { view: "quick", path: XLSX, target: "Recetas!B2" } });
  assert.match(cell, /name="shown" value="4"/); assert.match(cell, /=/);
});

test("save a paragraph → 303 back with an undo handle; label is Quick edit; undo", async () => {
  const r = await post("/api/workspace/quick/save", { _csrf: "tok", path: DOCX, kind: "docx", target: "1", shown: P1, value: "Tacos dorados." });
  assert.equal(r.status, 303);
  const l = loc(r);
  assert.equal(l.pathname, "/dashboard/workspace"); assert.equal(l.searchParams.get("notice"), "saved"); assert.match(l.searchParams.get("v"), /^v1\./);
  assert.ok(fake.versionsOf(DOCX).some((v) => /^Quick edit:/.test(v.label || "")));
  const page = await V.renderQuick({ lang: "en", csrf: "tok", query: Object.fromEntries(l.searchParams) });
  assert.match(page, /action="\/api\/workspace\/quick\/undo"/); assert.match(page, /Saved\./); assert.match(page, /action="\/api\/workspace\/quick\/restore"/);
  const u = await post("/api/workspace/quick/undo", { _csrf: "tok", path: DOCX, version_id: l.searchParams.get("v") });
  assert.equal(loc(u).searchParams.get("notice"), "undone");
});

test("save a cell and a slide shape", async () => {
  assert.equal(loc(await post("/api/workspace/quick/save", { _csrf: "tok", path: XLSX, kind: "xlsx", target: "Recetas!B2", shown: "4", value: "5" })).searchParams.get("notice"), "saved");
  const { openPptx, readDeck } = await import("../bundles/workspace/server/ooxml/pptx.js");
  const id = readDeck(openPptx(fake.node(PPTX).bytes), false)[1].shapes[0].object_id;
  assert.equal(loc(await post("/api/workspace/quick/save", { _csrf: "tok", path: PPTX, kind: "pptx", target: id, shown: "Jueves", value: "Viernes" })).searchParams.get("notice"), "saved");
});

test("CRLF from the browser is normalized: a two-line shape saves, no stray \\r (review r2)", async () => {
  const { openPptx, readDeck } = await import("../bundles/workspace/server/ooxml/pptx.js");
  const sh = readDeck(openPptx(fake.node(PPTX).bytes), false)[1].shapes.find((x) => x.text.includes("\n"));
  const r = await post("/api/workspace/quick/save", { _csrf: "tok", path: PPTX, kind: "pptx", target: sh.object_id, shown: sh.text.replace(/\n/g, "\r\n"), value: "Uno\r\nDos" });
  assert.equal(loc(r).searchParams.get("notice"), "saved");
  const after = readDeck(openPptx(fake.node(PPTX).bytes), false)[1].shapes.find((x) => x.object_id === sh.object_id);
  assert.equal(after.text, "Uno\nDos");
});

test("stale view and paragraphs with links/images are refused with a friendly notice, nothing written (review I6)", async () => {
  const n = puts();
  const r = await post("/api/workspace/quick/save", { _csrf: "tok", path: DOCX, kind: "docx", target: "1", shown: "old text", value: "x" });
  assert.equal(loc(r).searchParams.get("notice"), "stale_view");
  const img = await post("/api/workspace/quick/save", { _csrf: "tok", path: DOCX, kind: "docx", target: "13", shown: "", value: "x" });
  assert.equal(img.status, 303, "never a 500");
  assert.equal(loc(img).searchParams.get("notice"), "not_plain_text");
  assert.equal(puts(), n);
  const page = await V.renderQuick({ lang: "es", csrf: "tok", query: Object.fromEntries(loc(img).searchParams) });
  assert.ok(page.includes(V.QUICK_STRINGS.es.err_not_plain_text), "the refusal is explained in the user's language");
  assert.doesNotMatch(page, /ws_docs_find_replace/, "no tool names on the phone page");
});

test("file open in the editor → queued page naming who, with Cancel and a confirm-gated Apply now (K5)", async () => {
  fake.openInEditor(DOCX, ["dayane"], { releaseAfterMs: 3000, typed: null });
  const n = puts(); const t0 = t;
  const r = await post("/api/workspace/quick/save", { _csrf: "tok", path: DOCX, kind: "docx", target: "1", shown: P1, value: "x" });
  assert.equal(r.status, 200);
  assert.ok(t - t0 >= 10_000, "a phone waits 10 s for the editor to close before queueing (F16)");
  const html = await r.text();
  assert.match(html, /Dayane/); assert.match(html, /waiting/i); assert.match(html, /action="\/api\/workspace\/quick\/cancel"/);
  assert.match(html, /name="if_open" value="force_close"/); assert.match(html, /data-turbo="false"/);
  assert.doesNotMatch(html, /<script/i);
  assert.equal(puts(), n, "queued, not written");
  const id = html.match(/name="change_id" value="(pc_[0-9a-z]+)"/)[1];
  const row = await rowOf(id);
  assert.equal(row.tool, "ws_docs_rewrite_passages"); assert.equal(row.requested_by, "quick_edit"); assert.equal(row.state, "pending");
  // "Yes, apply now" cancels the queued twin first, so it can never apply a second time.
  const p = await post("/api/workspace/quick/save", { _csrf: "tok", path: DOCX, kind: "docx", target: "1", shown: P1, value: "x", if_open: "force_close", cancel_first: id });
  assert.equal(p.status, 303);
  assert.equal(loc(p).searchParams.get("notice"), "saved");
  assert.equal((await rowOf(id)).state, "cancelled");
});

test("restore of an open file queues ws_drive_restore_version {path, version_id} (F13); Cancel change cancels it", async () => {
  const vid = String(fake.versionsOf(XLSX)[0].id);
  fake.openInEditor(XLSX, ["dayane"], { releaseAfterMs: 10 ** 9 });
  const r = await post("/api/workspace/quick/restore", { _csrf: "tok", path: XLSX, version_id: vid });
  assert.equal(r.status, 200);
  const id = (await r.text()).match(/name="change_id" value="(pc_[0-9a-z]+)"/)[1];
  const row = await rowOf(id);
  assert.equal(row.tool, "ws_drive_restore_version");
  assert.deepEqual(JSON.parse(row.args_json), { path: XLSX, version_id: vid });
  const c = await post("/api/workspace/quick/cancel", { _csrf: "tok", path: XLSX, change_id: id });
  assert.equal(loc(c).searchParams.get("notice"), "cancelled");
  assert.equal((await rowOf(id)).state, "cancelled");
  assert.equal(loc(await post("/api/workspace/quick/restore", { _csrf: "tok", path: XLSX, version_id: "not-a-version" })).searchParams.get("notice"), "bad_version_id");
});

test("no session → 401; bad CSRF → 403; traversal path → error notice, no request", async () => {
  assert.equal((await post("/api/workspace/quick/save", { _csrf: "tok", path: "x", kind: "docx", target: "0", value: "y" }, "")).status, 401);
  assert.equal((await post("/api/workspace/quick/save", { _csrf: "bad", path: "x", kind: "docx", target: "0", value: "y" })).status, 403);
  const n = fake.calls.length;
  const r = await post("/api/workspace/quick/save", { _csrf: "tok", path: "../etc/passwd", kind: "docx", target: "0", value: "y" });
  assert.equal(loc(r).searchParams.get("notice"), "bad_path");
  assert.equal(fake.calls.length, n);
});
