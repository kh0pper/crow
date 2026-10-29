/**
 * Redesign P4, Task 4.6: the Make tab in a real browser.
 *
 * The REAL dashboard router is mounted over a scratch CROW_DATA_DIR with the vendored Turbo 8,
 * and a private headless Chrome drives /dashboard/make at phone 390×844 and desktop 1280×800,
 * en and es, light and dark, over three fixtures: both bundles installed, Artifacts only, and
 * neither. Fake bundles are an installed.json entry plus a manifest in the scratch CROW_HOME;
 * the Workspace listing is a stub dav.js in the scratch bundle (there is no Nextcloud).
 *
 * Previews: a real PNG is pre-written where make/previews.js looks for it, and the preview deps
 * are replaced with stubs, so the page only ever SERVES that file. No Docker, no renderer.
 *
 * Set SHELL_SHOTS_DIR to also save phone + desktop, light + dark screenshots.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import Database from "better-sqlite3";
import { createCanvas } from "@napi-rs/canvas";
import { startHeadlessChrome } from "./fixtures/headless-chrome.mjs";
import { actAsServe, serveHeaders } from "./fixtures/serve-peer.mjs";
actAsServe(); // this process's HTTP client stands in for tailscaled (the Serve socket owner)

const dir = mkdtempSync(join(tmpdir(), "make-live-"));
process.env.CROW_DATA_DIR = dir;
const HOME = join(dir, "home");
process.env.CROW_HOME = HOME;
mkdirSync(HOME, { recursive: true });
delete process.env.CROW_DB_PATH;
process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");
writeFileSync(join(dir, "instance-id"), "instance-make-live");
const REPO = new URL("..", import.meta.url).pathname;
const HASH = (c) => c.repeat(64);

let server, base, chrome, setLang, setPreviews, P;

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** Fake bundles: installed.json + a manifest, and (Workspace) a stub listing. */
function fixture(name) {
  const ids = name === "both" ? ["artifacts", "workspace"] : name === "artifacts" ? ["artifacts"] : [];
  writeFileSync(join(HOME, "installed.json"), JSON.stringify(ids.map((id) => ({ id }))));
  for (const id of ids) {
    mkdirSync(join(HOME, "bundles", id), { recursive: true });
    writeFileSync(join(HOME, "bundles", id, "manifest.json"), JSON.stringify({ id, version: "0.0.0" }));
  }
  if (ids.includes("workspace")) {
    const sv = join(HOME, "bundles", "workspace", "server");
    mkdirSync(join(sv, "nc"), { recursive: true });
    writeFileSync(join(sv, "config.js"), "export const getConfig = () => ({});\n");
    writeFileSync(join(sv, "nc", "dav.js"), `export async function listRecent() { return [
      { name: "Menu plan", fileId: 7701, isFolder: false, mime: ${JSON.stringify(DOCX)}, modified: "2026-10-26T09:00:00.000Z" },
      { name: "Budget", fileId: 7702, isFolder: false, mime: ${JSON.stringify(XLSX)}, modified: "2026-10-26T08:00:00.000Z" },
    ]; }\n`);
  }
}

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env }, stdio: "pipe", cwd: REPO });
  const { hashToken } = await import("../servers/gateway/dashboard/auth.js");
  const c = new Database(join(dir, "crow.db"));
  c.prepare("INSERT INTO project_spaces (slug, name, type, status) VALUES ('garden','Garden','general','active')").run();
  c.prepare("INSERT INTO oauth_tokens (token, token_type, client_id, expires_at, created_at) VALUES (?, 'access', 'dashboard', datetime('now','+1 day'), '2026-06-01 00:00:00')").run(hashToken("new-sess"));
  c.close();

  const { createDbClient } = await import("../servers/db.js");
  const { writeSetting } = await import("../servers/gateway/dashboard/settings/registry.js");
  const { setPreviewsEnabled } = await import("../servers/gateway/preview/renderer.js");
  const db = createDbClient();
  await writeSetting(db, "shell_since", "2026-01-01 00:00:00");
  db.close();
  setLang = async (lang) => { const d = createDbClient(); try { await writeSetting(d, "language", lang); } finally { d.close(); } };
  setPreviews = async (on) => { const d = createDbClient(); try { await setPreviewsEnabled(d, on); } finally { d.close(); } };

  // Artifacts: one trusted page with a stored preview (fills its tile); the rest are received
  // (untrusted), so they never render and show the type tile.
  const { initArtifactsTables } = await import("../bundles/artifacts/server/init-tables.js");
  const adb = createDbClient();
  await initArtifactsTables(adb);
  P = await import("../servers/gateway/make/previews.js");
  const mk = async (id, title, type, received, mins) => {
    await adb.execute({ sql: "INSERT INTO artifacts (id,title,type,current_version,received,title_tainted,updated_at) VALUES (?,?,?,1,?,0,datetime('now', ?))", args: [id, title, type, received, `-${mins} minutes`] });
    await adb.execute({ sql: `INSERT INTO artifact_versions (artifact_id,n,state,files_json,size,content_hash,made_by,untrusted_input) VALUES (?,1,'current','[]',1,?,'bot',0)`, args: [id, HASH("abcdef0123456789"[mins % 16])] });
    return HASH("abcdef0123456789"[mins % 16]);
  };
  const hReady = await mk("art_ready001", "Garden plan", "page", 0, 1);
  await mk("art_plain001", "Seed list", "page", 1, 2);
  await mk("art_plain002", "Flow chart", "diagram", 1, 3);
  await mk("art_plain003", "Notes page", "document", 1, 4);
  await mk("art_plain004", "Recipe page", "page", 1, 5);
  await mk("art_plain005", "Layout sketch", "diagram", 1, 6);
  adb.close();
  const file = P.previewFile(dir, "art_ready001", 1, hReady);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, createCanvas(640, 400).toBuffer("image/png"));
  // Stubs only: a listing with a file on disk is served without touching the renderer.
  P._setPreviewDepsForTest({
    dataDir: dir, queue: P.createPreviewQueue(), renderer: { lastOff: () => null, async acquire() { return { off: "start_failed" }; }, async prepare() {}, clearBackoff() {} },
    fetcher: null, tokens: null, info: null, now: Date.now, jobDb: null, workspacePreview: async () => null,
  });

  const { default: dashboardRouter } = await import("../servers/gateway/dashboard/index.js");
  const { default: express } = await import("express");
  const app = express();
  app.use(express.static(new URL("../servers/gateway/public", import.meta.url).pathname));
  app.use(dashboardRouter((req, res, next) => next()));
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = "http://127.0.0.1:" + server.address().port;
  chrome = await startHeadlessChrome();
});

after(async () => {
  P?._setPreviewDepsForTest();
  server?.closeAllConnections?.();
  server?.close();
  if (chrome) await chrome.close();
  rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const READY = "!!window.Turbo && document.readyState === 'complete' && !!document.querySelector('.content-header') && !document.documentElement.hasAttribute('aria-busy')";
const TWO_FRAMES = "new Promise(function(r){requestAnimationFrame(function(){requestAnimationFrame(function(){r(1);});});})";

/** A tab at a viewport, signed in, sending the headers Tailscale Serve sets. */
async function open(path, { width = 390, height = 844, dark = false } = {}) {
  const t = await (await fetch(chrome.cdp + "/json/new?about:blank", { method: "PUT" })).json();
  const { default: WebSocket } = await import("ws");
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
  let id = 0;
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mine = ++id;
    const on = (raw) => { const m = JSON.parse(raw); if (m.id !== mine) return; ws.off("message", on); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result || {}); };
    ws.on("message", on); ws.send(JSON.stringify({ id: mine, method, params }));
  });
  const ev = async (expression) => {
    const o = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (o.exceptionDetails) throw new Error("page threw: " + JSON.stringify(o.exceptionDetails));
    return o.result.value;
  };
  const errors = [];
  ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    if (m.method === "Runtime.exceptionThrown") errors.push((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text);
  });
  const until = async (expression, what, ms = 10000) => {
    const end = Date.now() + ms;
    for (;;) {
      let v = null;
      try { v = await ev(expression); } catch { /* mid-navigation */ }
      if (v) return v;
      if (Date.now() > end) {
        let where = "";
        try { where = await ev("location.href"); } catch {}
        throw new Error("timed out waiting for " + what + " (" + expression + ") at " + where + (errors.length ? "; page errors: " + errors.slice(-5).join(" | ") : ""));
      }
      await sleep(80);
    }
  };
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable");
  await send("Network.clearBrowserCookies");
  await send("Network.setExtraHTTPHeaders", { headers: serveHeaders("operator@example.com") });
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 900 });
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] });
  for (const ck of [{ name: "crow_session", value: "new-sess" }, { name: "crow_csrf", value: "tok" }]) await send("Network.setCookie", { ...ck, url: base, path: "/" });
  await send("Page.navigate", { url: base + path });
  await until(READY, "the page");
  await ev(TWO_FRAMES);
  const center = async (sel) => ev(`(function(){ var e=document.querySelector(${JSON.stringify(sel)}); if(!e) return null; var b=e.getBoundingClientRect(); return {x:b.left+b.width/2,y:b.top+b.height/2}; })()`);
  const click = async (sel) => {
    const p = await center(sel);
    assert.ok(p, "no element " + sel);
    for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: p.x, y: p.y, button: "left", clickCount: 1 });
  };
  const settled = async () => { await until(READY, "the page to settle"); await ev(TWO_FRAMES); };
  return { send, ev, until, click, settled, errors, close: async () => { ws.close(); await fetch(chrome.cdp + "/json/close/" + t.id).catch(() => {}); } };
}

const NO_H_SCROLL = "document.documentElement.scrollWidth <= window.innerWidth";
/** {count, bad}: the visible elements matching `sel`, and those smaller than 44×44 as "class:text:w×h". */
const small = (sel) => `(function(){ var bad=[], count=0;
  document.querySelectorAll(${JSON.stringify(sel)}).forEach(function(el){
    var cs=getComputedStyle(el); if(cs.display==='none'||cs.visibility==='hidden') return;
    var r=el.getBoundingClientRect(); if(!r.width&&!r.height) return;
    count++;
    if(r.width<44||r.height<44) bad.push((el.className||el.tagName)+':'+(el.textContent||el.getAttribute('aria-label')||'').trim().slice(0,24)+':'+Math.round(r.width)+'x'+Math.round(r.height));
  }); return { count: count, bad: bad }; })()`;
async function assertTargets(p, groups, tag) {
  for (const [sel, min, what] of groups) {
    const r = await p.ev(small(sel));
    assert.ok(r.count >= min, `${what}: found ${r.count} visible, expected at least ${min} (${tag})`);
    assert.deepEqual(r.bad, [], `${what} ≥ 44 (${tag})`);
  }
}
const OPEN_SHEET = (id) => `(function(){ return !!document.getElementById(${JSON.stringify(id)}).open; })()`;
/** Distinct column count of the tile grid (distinct left edges of the tiles). */
const COLUMNS = "(function(){ var s={}; document.querySelectorAll('.mk-grid .mk-cell').forEach(function(c){ s[Math.round(c.getBoundingClientRect().left)]=1; }); return Object.keys(s).length; })()";

for (const [width, height] of [[390, 844], [1280, 800]]) {
  for (const lang of ["en", "es"]) {
    test(`${width}×${height} ${lang}: grid, no sideways scroll, 44 px targets, the + sheet (both installed; light, dark)`, async (ctx) => {
      if (!chrome) return ctx.skip("no headless Chrome");
      await setLang(lang); fixture("both"); await setPreviews(true);
      try {
        for (const dark of [false, true]) {
          const tag = `${lang} ${dark ? "dark" : "light"}`;
          const p = await open("/dashboard/make", { width, height, dark });
          try {
            assert.equal(await p.ev("document.documentElement.lang"), lang);
            await p.until("document.querySelectorAll('.mk-grid .mk-cell').length >= 8", "the tiles");
            assert.equal(await p.ev("document.querySelectorAll('.mk-grid .mk-cell').length"), 8, "6 artifacts + 2 Workspace files");
            assert.equal(await p.ev(NO_H_SCROLL), true, `no horizontal page scroll (${tag})`);
            const cols = await p.ev(COLUMNS);
            if (width === 390) assert.equal(cols, 2, `two tiles per row on the phone (${tag})`);
            else assert.ok(cols >= 4, `more per row on the desktop, got ${cols} (${tag})`);
            await assertTargets(p, [
              [".mk-tile", 8, "tiles"],
              [".mk-chip", 4, "chips"],
              [".mk-start-btn", 1, "the + button"],
              [".mk-more", 8, "more buttons"],
            ], tag);
            // The + sheet: open it, check its rows, close it.
            await p.click(".mk-start-btn");
            await p.until(OPEN_SHEET("mk-start"), "the Start sheet");
            await p.ev(TWO_FRAMES);
            await assertTargets(p, [
              ["#mk-start .mk-start-type", 5, "sheet type rows"],
              ["#mk-start .mk-start-act", 3, "sheet Blank buttons"],
              ["#mk-start .mk-sheet-close", 1, "sheet close"],
            ], tag);
            const d = await p.ev("(function(){ var r=document.getElementById('mk-start').getBoundingClientRect(); return {l:r.left,r:r.right,t:r.top,b:r.bottom}; })()");
            assert.ok(d.l >= 0 && d.r <= width && d.t >= 0 && d.b <= height + 0.5, `sheet on screen ${JSON.stringify(d)} (${tag})`);
            assert.equal(await p.ev(NO_H_SCROLL), true, `no sideways scroll with the sheet open (${tag})`);
            await p.click("#mk-start .mk-sheet-close");
            await p.until("!document.getElementById('mk-start').open", "the sheet to close");
            assert.deepEqual(p.errors, [], `no page errors (${tag})`);
          } finally { await p.close(); }
        }
      } finally { await setLang("en"); }
    });
  }
}

test("a ready preview fills its tile, and a type tile is the same size (phone and desktop)", async (ctx) => {
  if (!chrome) return ctx.skip("no headless Chrome");
  fixture("both"); await setPreviews(true);
  for (const [width, height] of [[390, 844], [1280, 800]]) {
    const p = await open("/dashboard/make", { width, height });
    try {
      await p.until("document.querySelectorAll('.mk-grid .mk-cell').length >= 8", "the tiles");
      await p.until("(function(){ var i=document.querySelector('.mk-preview-img img'); return !!i && i.complete && i.naturalWidth>0; })()", "the preview image to load");
      const g = await p.ev(`(function(){
        var img=document.querySelector('.mk-preview-img img').getBoundingClientRect();
        var box=document.querySelector('.mk-preview-img').getBoundingClientRect();
        var type=document.querySelector('.mk-preview:not(.mk-preview-img)').getBoundingClientRect();
        return { imgW: img.width, imgH: img.height, boxW: box.width, boxH: box.height, typeW: type.width, typeH: type.height,
          imgs: document.querySelectorAll('.mk-preview-img img').length, types: document.querySelectorAll('.mk-preview:not(.mk-preview-img)').length }; })()`);
      assert.equal(g.imgs, 1, "exactly the one trusted page has a stored preview");
      assert.ok(g.types >= 7, `the rest are type tiles (${g.types})`);
      if (width === 390) assert.ok(g.imgH >= 120, `preview image ${g.imgH}px tall at 390 (≥ 120)`);
      assert.ok(Math.abs(g.imgW - g.typeW) <= 1 && Math.abs(g.boxH - g.typeH) <= 1, `type tile ${g.typeW}x${g.typeH} matches the preview ${g.boxW}x${g.boxH}`);
      assert.ok(Math.abs(g.imgH - g.boxH) <= 1, "the image fills its box");
    } finally { await p.close(); }
  }
});

test("390 px: the previews-off line is one line, at most 64 px tall, details collapsed", async (ctx) => {
  if (!chrome) return ctx.skip("no headless Chrome");
  for (const lang of ["en", "es"]) {
    await setLang(lang); fixture("artifacts"); await setPreviews(false);
    const p = await open("/dashboard/make", { width: 390, height: 844 });
    try {
      const h = await p.ev("document.querySelector('.mk-previews-off').getBoundingClientRect().height");
      assert.ok(h > 0 && h <= 64, `${lang}: off line is ${h}px`);
      assert.equal(await p.ev("document.querySelector('.mk-previews-what').open"), false);
      assert.ok(await p.ev("document.querySelector('.mk-previews-what summary').getBoundingClientRect().height") >= 44);
    } finally { await p.close(); }
  }
  await setLang("en");
});

test("Artifacts only: the Workspace offer shows with the tiles; previews off shows the switch (phone and desktop)", async (ctx) => {
  if (!chrome) return ctx.skip("no headless Chrome");
  fixture("artifacts"); await setPreviews(false);
  try {
    for (const [width, height] of [[390, 844], [1280, 800]]) {
      const p = await open("/dashboard/make", { width, height });
      const tag = `${width}`;
      try {
        assert.equal(await p.ev("document.querySelectorAll('.mk-grid .mk-cell').length"), 6);
        assert.equal(await p.ev(NO_H_SCROLL), true, `no horizontal scroll (${tag})`);
        assert.equal(await p.ev("document.querySelectorAll('.mk-offer').length"), 1);
        assert.equal(await p.ev("document.querySelector('.mk-offer a').getAttribute('href')"), "/dashboard/extensions?q=workspace");
        assert.equal(await p.ev("document.querySelectorAll('.mk-preview-img').length"), 0, "previews off: type tiles only");
        await assertTargets(p, [
          [".mk-offer .btn", 1, "offer button"],
          [".mk-previews-off .mk-start-act", 1, "enable previews button"],
          [".mk-tile", 6, "tiles"],
        ], tag);
        // The sheet offers Workspace types as links, not buttons.
        await p.click(".mk-start-btn");
        await p.until(OPEN_SHEET("mk-start"), "the Start sheet");
        await p.ev(TWO_FRAMES);
        await assertTargets(p, [
          ["#mk-start .mk-start-type", 2, "page and diagram rows"],
          ["#mk-start .mk-start-act", 3, "Workspace offer links"],
        ], tag);
        assert.equal(await p.ev("document.querySelectorAll('#mk-start a.mk-start-act[href=\"/dashboard/extensions?q=workspace\"]').length"), 3);
      } finally { await p.close(); }
    }
  } finally { await setPreviews(true); }
});

for (const [width, height] of [[390, 844], [1280, 800]]) {
  for (const lang of ["en", "es"]) {
    test(`${width}×${height} ${lang}: neither installed shows both install offers (light, dark)`, async (ctx) => {
      if (!chrome) return ctx.skip("no headless Chrome");
      await setLang(lang); fixture("neither");
      try {
        for (const dark of [false, true]) {
          const tag = `${lang} ${dark ? "dark" : "light"}`;
          const p = await open("/dashboard/make", { width, height, dark });
          try {
            assert.equal(await p.ev("document.querySelectorAll('.mk-grid').length"), 0);
            assert.equal(await p.ev("document.querySelectorAll('.mk-empty .mk-offer').length"), 2, `both offers (${tag})`);
            assert.deepEqual(await p.ev("Array.from(document.querySelectorAll('.mk-offer a')).map(function(a){return a.getAttribute('href');})"),
              ["/dashboard/extensions?q=artifacts", "/dashboard/extensions?q=workspace"]);
            assert.equal(await p.ev(NO_H_SCROLL), true, `no horizontal scroll (${tag})`);
            await assertTargets(p, [[".mk-offer .btn", 2, "offer buttons"], [".mk-chip", 4, "chips"], [".mk-start-btn", 1, "the + button"]], tag);
            await p.click(".mk-start-btn");
            await p.until(OPEN_SHEET("mk-start"), "the Start sheet");
            await p.ev(TWO_FRAMES);
            await assertTargets(p, [["#mk-start a.mk-start-act", 5, "every sheet row is an install offer"]], tag);
            assert.equal(await p.ev("document.querySelectorAll('#mk-start .mk-start-type').length"), 0);
            assert.equal(await p.ev(NO_H_SCROLL), true);
          } finally { await p.close(); }
        }
      } finally { await setLang("en"); }
    });
  }
}

test("Turbo navigation from Make to Board and back keeps the filter", async (ctx) => {
  if (!chrome) return ctx.skip("no headless Chrome");
  fixture("both"); await setPreviews(true);
  for (const [width, height] of [[390, 844], [1280, 800]]) {
    const p = await open("/dashboard/make", { width, height });
    const on = "(function(){ var a=document.querySelectorAll('.mk-chip-on'); return a.length===1 ? a[0].getAttribute('href') : a.length; })()";
    try {
      assert.equal(await p.ev(on), "/dashboard/make");
      await p.click(".mk-chip[href='/dashboard/make?filter=pages']");
      await p.until("location.search === '?filter=pages'", "the Pages filter");
      await p.settled();
      assert.equal(await p.ev(on), "/dashboard/make?filter=pages");
      assert.equal(await p.ev("document.querySelectorAll('.mk-grid .mk-cell[data-mk-kind=\"workspace_file\"]').length"), 0, "Pages hides the Workspace files");
      await p.ev("window.__mkMark = 1; true");
      await p.click(".shell-tab[href='/dashboard/board']");
      await p.until("location.pathname === '/dashboard/board' && !!document.querySelector('.sb-board')", "Board");
      await p.settled();
      await p.ev("history.back(); true");
      await p.until("location.pathname === '/dashboard/make' && location.search === '?filter=pages' && !!document.querySelector('.mk-chip-on')", "Make again");
      await p.settled();
      assert.equal(await p.ev(on), "/dashboard/make?filter=pages", "the Pages chip is still active");
      assert.equal(await p.ev("window.__mkMark"), 1, "Board and back were Turbo visits, not full loads");
      assert.equal(await p.ev("document.querySelectorAll('.shell-tabs').length"), 1);
    } finally { await p.close(); }
  }
});

test("screenshots for review (only with SHELL_SHOTS_DIR)", async (ctx) => {
  const out = process.env.SHELL_SHOTS_DIR;
  if (!chrome || !out) return ctx.skip("set SHELL_SHOTS_DIR to save screenshots");
  mkdirSync(out, { recursive: true });
  for (const fx of ["both", "neither"]) {
    fixture(fx); await setPreviews(true);
    for (const [name, width, height] of [["phone", 390, 844], ["desktop", 1280, 800]]) {
      for (const dark of [false, true]) {
        const p = await open("/dashboard/make", { width, height, dark });
        try {
          await p.ev(TWO_FRAMES);
          const { data } = await p.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
          writeFileSync(join(out, `make-${fx}-${name}-${dark ? "dark" : "light"}.png`), Buffer.from(data, "base64"));
        } finally { await p.close(); }
      }
    }
  }
});
