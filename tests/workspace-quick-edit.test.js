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
const { openDocx } = await import("../bundles/workspace/server/ooxml/docx-model.js");
const { setParagraphText } = await import("../bundles/workspace/server/ooxml/docx-edit.js");
const { kids, NS } = await import("../bundles/workspace/server/ooxml/xml.js");
/** oo-rich.docx with some paragraphs (by index) set to other text. */
function docxWith(texts) {
  const d = openDocx(readFileSync(join(FIX, "oo-rich.docx"))); const ps = kids(d.body, NS.w, "p");
  for (const [i, text] of Object.entries(texts)) setParagraphText(d, ps[Number(i)], text);
  return d.pkg.save();
}
const pendingCount = async () => Number((await db.execute("SELECT COUNT(*) AS n FROM workspace_pending_changes")).rows[0].n);
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

test("XSS: a hostile file name and a <script> paragraph are escaped; an accented/emoji name round-trips through the link", async () => {
  const name = "<img src=x onerror=1> Menú 🌮.docx"; const path = `Shared with Crow/Casa/${name}`;
  fake.addFile(path, docxWith({ 1: "<script>alert(1)</script>" }), { owner: "admin" });
  const folder = await V.renderQuick({ lang: "en", csrf: "tok", query: { path: "Shared with Crow/Casa" } });
  assert.doesNotMatch(folder, /<img src=x/); assert.doesNotMatch(folder, /<script/i);
  assert.ok(folder.includes("&lt;img src=x onerror=1&gt; Menú 🌮.docx"));
  const hrefs = [...folder.matchAll(/href="([^"]+)"/g)].map((m) => new URL(m[1].replace(/&amp;/g, "&"), base));
  assert.ok(hrefs.some((u) => u.searchParams.get("path") === path), "the Open link carries the exact (NFC, emoji) path");
  const file = await V.renderQuick({ lang: "en", csrf: "tok", query: { path } });
  assert.doesNotMatch(file, /<script/i); assert.ok(file.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  const edit = await V.renderQuick({ lang: "en", csrf: "tok", query: { path, target: "1" } });
  assert.doesNotMatch(edit, /<script/i); assert.match(edit, /name="shown" value="&lt;script&gt;alert\(1\)&lt;\/script&gt;"/);
  assert.match(edit, /name="path" value="&lt;img src=x onerror=1&gt; Menú 🌮\.docx"|name="path" value="Shared with Crow\/Casa\/&lt;img src=x onerror=1&gt; Menú 🌮\.docx"/);
});

test("unknown notice codes show a generic text, never a message from the URL; the choice page is localized per lock kind", async () => {
  const page = await V.renderQuick({ lang: "es", csrf: "tok", query: { path: "Shared with Crow/Casa", notice: "weird_code", msg: "EVIL injected text" } });
  assert.doesNotMatch(page, /EVIL injected text/); assert.ok(page.includes(V.QUICK_STRINGS.es.err_generic));
  const form = { path: DOCX, kind: "docx", target: "1", value: "x", shown: P1 };
  const stale = V.renderChoice({ lang: "es", csrf: "tok", form, err: { code: "stale_editor_lock", message: "RAW lock text", data: { can_proceed: false } } });
  assert.ok(stale.includes(V.QUICK_STRINGS.es.err_stale_editor_lock)); assert.doesNotMatch(stale, /RAW lock text/);
  assert.ok(!stale.includes(V.QUICK_STRINGS.es.openBy), "a stale lock is not 'someone is editing'"); assert.doesNotMatch(stale, /force_close/);
  const person = V.renderChoice({ lang: "en", csrf: "tok", form, err: { code: "locked_by_person", message: "RAW", data: { open_by: ["Dayane"], can_proceed: false } } });
  assert.ok(person.includes(V.QUICK_STRINGS.en.err_locked_by_person)); assert.doesNotMatch(person, /RAW|force_close/);
  const open = V.renderChoice({ lang: "en", csrf: "tok", form, err: { code: "open_in_editor", message: "RAW", data: { open_by: ["Dayane"], can_proceed: true } } });
  assert.match(open, /Dayane/); assert.ok(open.includes(V.QUICK_STRINGS.en.openBy)); assert.match(open, /value="force_close"/); assert.doesNotMatch(open, /RAW|<script/i);
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

test("I1: an open file + a paragraph whose prefix also starts an EARLIER paragraph (or an empty one) is not queued — try-again page, nothing queued or written", async () => {
  const DUP = "Shared with Crow/Casa/dup.docx";
  fake.addFile(DUP, docxWith({ 4: "Tortillas", 5: "" }), { owner: "admin" }); // p3 "Tortillas" == p4 "Tortillas"; p5 empty
  fake.openInEditor(DUP, ["dayane"], { releaseAfterMs: 10 ** 9 });
  const n = puts(); const q0 = await pendingCount();
  for (const [target, shown] of [["4", "Tortillas"], ["5", ""]]) {
    const r = await post("/api/workspace/quick/save", { _csrf: "tok", path: DUP, kind: "docx", target, shown, value: "Totopos" });
    assert.equal(r.status, 200, `target ${target}`);
    const html = await r.text();
    assert.ok(html.includes(V.QUICK_STRINGS.en.notQueueable.replace(/'/g, "&#39;")), `target ${target}: explains why it can't wait`);
    assert.match(html, /Dayane/); assert.match(html, /action="\/api\/workspace\/quick\/save"/);
    assert.doesNotMatch(html, /quick\/cancel/, "nothing was queued, so nothing to cancel");
  }
  assert.equal(await pendingCount(), q0, "no pending change was created");
  assert.equal(puts(), n, "nothing written");
  // the first "Tortillas" (p3) is still queueable: its prefix picks itself
  const ok = await post("/api/workspace/quick/save", { _csrf: "tok", path: DUP, kind: "docx", target: "3", shown: "Tortillas", value: "Totopos" });
  assert.match(await ok.text(), /quick\/cancel/);
  assert.equal(await pendingCount(), q0 + 1);
});

test("I2: Apply now whose forced save fails puts the cancelled change back in the queue and says it is still waiting; a malformed cancel_first is refused", async () => {
  const W = "Shared with Crow/Casa/w.docx";
  fake.addFile(W, readFileSync(join(FIX, "oo-rich.docx")), { owner: "admin" });
  fake.openInEditor(W, ["dayane"], { releaseAfterMs: 10 ** 9 });
  const q = await post("/api/workspace/quick/save", { _csrf: "tok", path: W, kind: "docx", target: "1", shown: P1, value: "Tacos dorados." });
  const id = (await q.text()).match(/name="change_id" value="(pc_[0-9a-z]+)"/)[1];
  const n = puts();
  fake.state.failNextWith = { status: 503, body: "busy" }; // the forced save's first request fails
  const r = await post("/api/workspace/quick/save", { _csrf: "tok", path: W, kind: "docx", target: "1", shown: P1, value: "Tacos dorados.", if_open: "force_close", cancel_first: id });
  assert.equal(r.status, 303);
  assert.equal(loc(r).searchParams.get("notice"), "still_waiting");
  assert.equal((await rowOf(id)).state, "pending", "the change is waiting again, not lost");
  assert.equal(puts(), n);
  const page = await V.renderQuick({ lang: "en", csrf: "tok", query: Object.fromEntries(loc(r).searchParams) });
  assert.ok(page.includes(V.QUICK_STRINGS.en.err_still_waiting));
  const bad = await post("/api/workspace/quick/save", { _csrf: "tok", path: W, kind: "docx", target: "1", shown: P1, value: "x", if_open: "force_close", cancel_first: "nope'" });
  assert.equal(loc(bad).searchParams.get("notice"), "bad_args");
  assert.equal(puts(), n, "refused before anything was written");
  assert.equal((await rowOf(id)).state, "pending");
});

test("no session → 401; bad CSRF → 403; traversal path → error notice, no request", async () => {
  assert.equal((await post("/api/workspace/quick/save", { _csrf: "tok", path: "x", kind: "docx", target: "0", value: "y" }, "")).status, 401);
  assert.equal((await post("/api/workspace/quick/save", { _csrf: "bad", path: "x", kind: "docx", target: "0", value: "y" })).status, 403);
  const n = fake.calls.length;
  const r = await post("/api/workspace/quick/save", { _csrf: "tok", path: "../etc/passwd", kind: "docx", target: "0", value: "y" });
  assert.equal(loc(r).searchParams.get("notice"), "bad_path");
  assert.equal(fake.calls.length, n);
});

// ---- final whole-branch review fix wave ----------------------------------------------------------------
const { openXlsx, writeRange } = await import("../bundles/workspace/server/ooxml/xlsx.js");
const { openPptx, readDeck, editShapeText } = await import("../bundles/workspace/server/ooxml/pptx.js");
const C = await import("../bundles/workspace/server/queue/conditions.js");
const { passagePrefix, rewritePassages } = await import("../bundles/workspace/server/ooxml/docx-edit.js");
const { paragraphText } = await import("../bundles/workspace/server/ooxml/docx-model.js");

test("final I1: a queued xlsx Quick edit whose page is stale (the saved cell differs from what was shown) is refused stale_view — nothing queued or written", async () => {
  const X = "Shared with Crow/Casa/stale.xlsx";
  const wb = openXlsx(readFileSync(join(FIX, "oo-rich.xlsx"))); writeRange(wb, "Recetas!B2", [[7]], "RAW");
  fake.addFile(X, Buffer.from(wb.pkg.save()), { owner: "admin" }); // the person already saved 7; the phone page showed 4
  fake.openInEditor(X, ["dayane"], { releaseAfterMs: 10 ** 9 });
  const n = puts(); const q0 = await pendingCount();
  const r = await post("/api/workspace/quick/save", { _csrf: "tok", path: X, kind: "xlsx", target: "Recetas!B2", shown: "4", value: "5" });
  assert.equal(r.status, 303);
  assert.equal(loc(r).searchParams.get("notice"), "stale_view");
  assert.equal(await pendingCount(), q0, "never queued over the person's newer value");
  assert.equal(puts(), n);
  // the fresh view (shown = the saved value) still queues
  const ok = await post("/api/workspace/quick/save", { _csrf: "tok", path: X, kind: "xlsx", target: "Recetas!B2", shown: "7", value: "5" });
  assert.match(await ok.text(), /quick\/cancel/);
  assert.equal(await pendingCount(), q0 + 1);
});

test("final I1: a queued pptx Quick edit whose page is stale is refused stale_view — nothing queued or written", async () => {
  const P = "Shared with Crow/Casa/stale.pptx";
  const deck = openPptx(readFileSync(join(FIX, "oo-rich.pptx")));
  const id = readDeck(deck, false)[1].shapes[0].object_id; // "Jueves" in the fixture
  editShapeText(deck, id, "Sábado"); fake.addFile(P, Buffer.from(deck.pkg.save()), { owner: "admin" });
  fake.openInEditor(P, ["dayane"], { releaseAfterMs: 10 ** 9 });
  const n = puts(); const q0 = await pendingCount();
  const r = await post("/api/workspace/quick/save", { _csrf: "tok", path: P, kind: "pptx", target: id, shown: "Jueves", value: "Viernes" });
  assert.equal(loc(r).searchParams.get("notice"), "stale_view");
  assert.equal(await pendingCount(), q0); assert.equal(puts(), n);
});

test("final I1: the queued docx twin carries expect_text = shown — a paragraph edited after queueing (prefix kept) is refused at close and live", async () => {
  const D = "Shared with Crow/Casa/twin.docx";
  fake.addFile(D, readFileSync(join(FIX, "oo-rich.docx")), { owner: "admin" });
  fake.openInEditor(D, ["dayane"], { releaseAfterMs: 10 ** 9 });
  const q = await post("/api/workspace/quick/save", { _csrf: "tok", path: D, kind: "docx", target: "1", shown: P1, value: "Tacos dorados." });
  const id = (await q.text()).match(/name="change_id" value="(pc_[0-9a-z]+)"/)[1];
  const row = await rowOf(id);
  const args = JSON.parse(row.args_json);
  assert.equal(args.passages[0].expect_text, P1);
  // the person edits the same paragraph in the editor, keeping its first words
  const later = docxWith({ 1: `${P1} Y cebolla.` });
  assert.equal(C.checkPre(row.tool, args, JSON.parse(row.precondition_json || "null"), later).ok, false, "close-time: target_changed, never overwrites the person's edit");
  assert.equal(C.checkPre(row.tool, args, JSON.parse(row.precondition_json || "null"), fake.node(D).bytes).ok, true, "unchanged paragraph: still applies");
  const d = openDocx(later); const r = rewritePassages(d, args.passages);
  assert.equal(r.results[0].matched, false, "the file op itself refuses too");
  assert.equal(paragraphText(kids(d.body, NS.w, "p")[1]), `${P1} Y cebolla.`);
});

test("final I2: the queued docx twin's match_prefix is passagePrefix(shown) — a paragraph with >100 leading spaces still picks itself", async () => {
  const D = "Shared with Crow/Casa/spaces.docx";
  const text = `${" ".repeat(120)}Pozole rojo los sábados.`;
  fake.addFile(D, docxWith({ 1: text }), { owner: "admin" });
  fake.openInEditor(D, ["dayane"], { releaseAfterMs: 10 ** 9 });
  const shown = paragraphText(kids(openDocx(fake.node(D).bytes).body, NS.w, "p")[1]);
  assert.equal(shown, text, "fixture keeps the leading spaces");
  const q = await post("/api/workspace/quick/save", { _csrf: "tok", path: D, kind: "docx", target: "1", shown, value: "Menudo." });
  const id = (await q.text()).match(/name="change_id" value="(pc_[0-9a-z]+)"/)[1];
  const args = JSON.parse((await rowOf(id)).args_json);
  assert.equal(args.passages[0].match_prefix, passagePrefix(shown));
  const d = openDocx(fake.node(D).bytes); const r = rewritePassages(d, args.passages);
  assert.equal(r.results[0].matched, true);
  assert.equal(paragraphText(kids(d.body, NS.w, "p")[1]), "Menudo.");
});

test("final M1: Apply now whose PUT landed but a later step failed is NOT re-queued (the change is saved; the twin stays cancelled)", async () => {
  const W = "Shared with Crow/Casa/m1.docx";
  fake.addFile(W, readFileSync(join(FIX, "oo-rich.docx")), { owner: "admin" });
  fake.openInEditor(W, ["dayane"], { releaseAfterMs: 3000 }); // Apply now closes the editor, then saves
  const q = await post("/api/workspace/quick/save", { _csrf: "tok", path: W, kind: "docx", target: "1", shown: P1, value: "Tacos dorados." });
  const id = (await q.text()).match(/name="change_id" value="(pc_[0-9a-z]+)"/)[1];
  const n = puts();
  fake.state.afterPutHook = () => { fake.state.afterPutHook = null; fake.state.failNextWith = { status: 503, body: "busy" }; }; // the stat after the PUT fails
  const r = await post("/api/workspace/quick/save", { _csrf: "tok", path: W, kind: "docx", target: "1", shown: P1, value: "Tacos dorados.", if_open: "force_close", cancel_first: id });
  assert.equal(r.status, 303);
  assert.notEqual(loc(r).searchParams.get("notice"), "still_waiting", "never told it is still waiting after the save landed");
  assert.equal(puts(), n + 1, "the forced save was written");
  assert.equal((await rowOf(id)).state, "cancelled", "the twin is not put back (it would apply a second time)");
  assert.equal(paragraphText(kids(openDocx(fake.node(W).bytes).body, NS.w, "p")[1]), "Tacos dorados.");
});
