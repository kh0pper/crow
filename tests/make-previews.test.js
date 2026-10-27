/**
 * Task 4.5: real previews in Make, from the sandboxed preview renderer.
 *
 * Unit and route tests over a scratch CROW_DATA_DIR, with a stub renderer, a stub
 * render and a real view-token store: no Docker, no Chrome. The REAL dashboard router
 * is mounted (same harness as make-panel.test.js) for the panel, the preview routes and
 * the enable POST. The live render is in make-previews-live.test.js.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import Database from "better-sqlite3";
import { createCanvas } from "@napi-rs/canvas";
import { actAsServe, serveHeaders } from "./fixtures/serve-peer.mjs";
actAsServe(); // this process's HTTP client stands in for tailscaled (the Serve socket owner)

const dir = mkdtempSync(join(tmpdir(), "make-previews-"));
process.env.CROW_DATA_DIR = dir;
process.env.CROW_HOME = join(dir, "home");
mkdirSync(join(process.env.CROW_HOME, "bundles", "artifacts"), { recursive: true });
delete process.env.CROW_DB_PATH;
process.env.CROW_TASKS_DB_PATH = join(dir, "tasks.db");
writeFileSync(join(dir, "instance-id"), "instance-make-previews");
const REPO = new URL("..", import.meta.url).pathname;
cpSync(join(REPO, "bundles", "artifacts", "manifest.json"), join(process.env.CROW_HOME, "bundles", "artifacts", "manifest.json"));
writeFileSync(join(process.env.CROW_HOME, "installed.json"), JSON.stringify([{ id: "artifacts" }]));

const BASE_URL = "https://crow-artifacts.example.ts.net";
const INFO = { baseUrl: BASE_URL, port: 3059, bindHost: "127.0.0.1" };
const NET = serveHeaders("operator@example.com");
const JAR = { crow_session: "prev-sess", crow_csrf: "tok" };
const PNG = createCanvas(64, 40).toBuffer("image/png");
const HASH = (c) => c.repeat(64);

let db, server, base, P, MAIN_DOCUMENT_TYPES, createViewTokenStore, setPreviewsEnabled, readSetting, upsertSetting, t;

// ---- the stubs every test drives -------------------------------------------------------
const S = {};
function reset({ off = null, renderImpl = null, blank = false } = {}) {
  S.clock = Date.parse("2026-10-27T12:00:00Z");
  S.off = off;
  S.lastOff = null;
  S.leases = 0;
  S.maxLeases = 0;
  S.acquires = 0;
  S.releases = [];
  S.renders = [];
  S.leasesDuringRender = [];
  S.renderImpl = renderImpl;
  S.blank = blank;
  S.mints = [];
  S.revokes = [];
  S.prepares = 0;
  S.clears = 0;
  S.ws = null;
  const real = createViewTokenStore();
  S.tokens = {
    mint(g) { const m = real.mint(g); S.mints.push({ arg: g, out: m }); return m; },
    revokeToken(id) { S.revokes.push(id); return real.revokeToken(id); },
    check: (tok) => real.check(tok),
  };
  S.renderer = {
    async acquire() {
      S.acquires++;
      if (S.off) { S.lastOff = S.off; return { off: S.off }; }
      S.lastOff = null;
      S.leases++;
      S.maxLeases = Math.max(S.maxLeases, S.leases);
      let held = true;
      return { cdp: { stub: true }, release(o) { if (!held) return; held = false; S.leases--; S.releases.push(o); } };
    },
    lastOff: () => S.lastOff,
    async prepare() { S.prepares++; return "building"; },
    clearBackoff() { S.clears++; },
  };
  S.queue = P.createPreviewQueue();
  S.deps = {
    dataDir: dir, queue: S.queue, renderer: S.renderer, fetcher: { stub: "fetcher" }, tokens: S.tokens, info: INFO,
    now: () => S.clock, jobDb: db,
    render: async (cdp, o) => {
      S.renders.push(o);
      S.leasesDuringRender.push(S.leases);
      if (S.renderImpl) return S.renderImpl(o);
      return PNG;
    },
    nearBlank: async () => S.blank,
    workspacePreview: async (id) => (S.ws ? S.ws(id) : null),
  };
  P._resetPreviewStateForTest();
  P._setPreviewDepsForTest(S.deps);
}

let seq = 0;
/** An artifact with its versions; returns { id, hash16 } of the current version. */
async function art({ type = "document", received = 0, deleted = false, versions = [{}], current = null } = {}) {
  const id = `art_prev${String(++seq).padStart(4, "0")}`;
  const cur = current ?? versions.length;
  await db.execute({
    sql: `INSERT INTO artifacts (id,title,type,current_version,received,deleted_at) VALUES (?,?,?,?,?,${deleted ? "datetime('now')" : "NULL"})`,
    args: [id, `T ${id}`, type, cur, received],
  });
  let hash = null;
  for (let i = 0; i < versions.length; i++) {
    const v = versions[i];
    const n = i + 1;
    const h = v.hash || HASH("0123456789abcdef"[(seq + n) % 16]) ;
    if (n === cur) hash = h;
    await db.execute({
      sql: `INSERT INTO artifact_versions (artifact_id,n,state,files_json,size,content_hash,made_by,untrusted_input,trust_cleared_at,flagged_reason)
            VALUES (?,?,?,?,?,?,?,?,?,?)`,
      args: [id, n, n === cur ? "current" : "past", "[]", 1, h, "bot", v.untrusted ?? 0, v.cleared ?? null, v.flagged ?? null],
    });
  }
  return { id, n: cur, hash, h16: hash ? hash.slice(0, 16) : null };
}
const clearSwitch = async () => {
  await db.execute("DELETE FROM dashboard_settings WHERE key='previews_enabled'");
  await db.execute("DELETE FROM dashboard_settings_overrides WHERE key='previews_enabled'");
};
const ensure = (id) => P.ensureArtifactPreview(db, id, S.deps);
const settle = () => S.queue.idle();
const dirFiles = (id) => { try { return readdirSync(join(dir, "previews", id)); } catch { return []; } };

async function req(method, path, { jar = JAR, body = null, headers = {} } = {}) {
  const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
  const r = await fetch(base + path, {
    method, redirect: "manual",
    headers: { ...NET, cookie, ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}), ...headers },
    body: body ? new URLSearchParams(body).toString() : undefined,
  });
  const buf = Buffer.from(await r.arrayBuffer());
  return { status: r.status, headers: r.headers, location: r.headers.get("location"), buf, body: buf.toString("utf8") };
}
/** The Make page, in `lang` (the panel reads the "language" setting). */
async function page(lang = "en") {
  await upsertSetting(db, "language", lang);
  try { return await req("GET", "/dashboard/make"); } finally { await upsertSetting(db, "language", "en"); }
}
const tileOf = (html, id) => {
  const i = html.indexOf(`data-mk-ref="${id}"`);
  assert.ok(i > 0, `tile for ${id}`);
  return html.slice(i, html.indexOf("</li>", i));
};

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env }, stdio: "pipe", cwd: REPO });
  const { hashToken } = await import("../servers/gateway/dashboard/auth.js");
  const c = new Database(join(dir, "crow.db"));
  c.prepare("INSERT INTO oauth_tokens (token, token_type, client_id, expires_at, created_at) VALUES (?, 'access', 'dashboard', datetime('now','+1 day'), '2026-06-01 00:00:00')").run(hashToken("prev-sess"));
  c.close();
  const { createDbClient } = await import("../servers/db.js");
  ({ readSetting, upsertSetting } = await import("../servers/gateway/dashboard/settings/registry.js"));
  const { writeSetting } = await import("../servers/gateway/dashboard/settings/registry.js");
  db = createDbClient();
  await writeSetting(db, "shell_since", "2026-01-01 00:00:00");
  const { initArtifactsTables } = await import("../bundles/artifacts/server/init-tables.js");
  await initArtifactsTables(db);

  P = await import("../servers/gateway/make/previews.js");
  ({ MAIN_DOCUMENT_TYPES } = await import("../servers/gateway/preview/render.js"));
  ({ createViewTokenStore } = await import("../servers/gateway/artifact-origin/view-tokens.js"));
  ({ setPreviewsEnabled } = await import("../servers/gateway/preview/renderer.js"));
  ({ t } = await import("../servers/gateway/dashboard/shared/i18n.js"));
  reset();

  const { renderLayout } = await import("../servers/gateway/dashboard/shared/layout.js");
  const { default: dashboardRouter } = await import("../servers/gateway/dashboard/index.js");
  const { default: express } = await import("express");
  const app = express();
  app.use(dashboardRouter((req, res, next) => next(), { renderLayout }));
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = "http://127.0.0.1:" + server.address().port;
});
after(() => {
  P?._setPreviewDepsForTest(null);
  if (server) server.close();
  try { db.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(async () => { reset(); await setPreviewsEnabled(db, true); });

// ---- eligibility ------------------------------------------------------------------------

test("received never renders, whatever its type", async () => {
  const clean = { untrusted_input: 0, trust_cleared_at: null, flagged_reason: null };
  for (const received of [1, 1n, "1", null, ""]) {
    for (const type of ["page", "document", "diagram"]) {
      assert.deepEqual(P.previewEligible({ id: "art_x00001", type, received, current_version: 1 }, clean), { ok: false, reason: "received" }, `received=${String(received)} ${type}`);
    }
  }
  assert.deepEqual(P.previewEligible({ id: "art_x00001", type: "page", received: 0, current_version: 1 }, clean), { ok: true });

  // Through the DB (the column is NOT NULL): 1 and 2 are received; neither renders, the tile is a
  // type tile, the route 404s.
  for (const received of [1, 2]) {
    const a = await art({ type: "page", received });
    assert.deepEqual(await ensure(a.id), { status: "off", reason: "received" });
    // Even a PNG planted at the exact path is never served.
    mkdirSync(join(dir, "previews", a.id), { recursive: true });
    writeFileSync(P.previewFile(dir, a.id, a.n, a.hash), PNG);
    const r = await req("GET", `/dashboard/make/preview/artifact/${a.id}?v=${a.n}&h=${a.h16}`);
    assert.equal(r.status, 404);
    const tile = tileOf((await page()).body, a.id);
    assert.doesNotMatch(tile, /<img|data-mk-pv-src/);
    assert.match(tile, /mk-type-page/);
  }
  await settle();
  assert.equal(S.renders.length, 0);
  assert.equal(S.acquires, 0);
});

test("no artifact origin: a type tile with no reason line, and nothing queued", async () => {
  const a = await art({ type: "page", received: 0 });
  for (const noOrigin of [{ fetcher: null }, { info: null }]) {
    const deps = { ...S.deps, ...noOrigin };
    assert.deepEqual(await P.ensureArtifactPreview(db, a.id, deps), { status: "off", reason: null });
    const tile = await P.itemPreview(db, { kind: "artifact", ref: a.id }, deps);
    assert.equal(tile.previewReason, null);
    assert.equal(tile.previewState, "off");
  }
  assert.equal(S.queue.size?.() ?? 0, 0);
  assert.equal(S.renders.length, 0);
});

test("only page, document and diagram render", async () => {
  for (const type of ["data", "slides", "pdf", "image", "docx", "map"]) {
    const a = await art({ type });
    assert.deepEqual(await ensure(a.id), { status: "off", reason: "type" }, type);
  }
  assert.equal(P.previewLineKey("type"), null);
  await settle();
  assert.equal(S.renders.length, 0);
  for (const type of ["page", "document", "diagram"]) {
    const a = await art({ type });
    assert.deepEqual(P.previewEligible({ id: a.id, type, received: 0, current_version: 1 }, { untrusted_input: 0 }), { ok: true });
    assert.equal((await ensure(a.id)).status, "pending", type);
  }
  await settle();
  assert.equal(S.renders.length, 3);
});

test("untrusted-round output never renders", async () => {
  const a = await art({ type: "document", versions: [{ untrusted: 1 }] });
  assert.deepEqual(await ensure(a.id), { status: "off", reason: "untrusted" });
  await settle();
  assert.equal(S.renders.length, 0);
  await db.execute({ sql: "UPDATE artifact_versions SET trust_cleared_at=datetime('now') WHERE artifact_id=?", args: [a.id] });
  assert.equal((await ensure(a.id)).status, "pending");
  await settle();
  assert.equal(S.renders.length, 1);
});

test("flagged is read from the current version", async () => {
  const a = await art({ versions: [{}, { flagged: "tripwire" }] });
  assert.deepEqual(await ensure(a.id), { status: "off", reason: "flagged" });
  // The other way round: an older flagged version doesn't matter.
  const b = await art({ versions: [{ flagged: "tripwire" }, {}] });
  assert.equal((await ensure(b.id)).status, "pending");
  await settle();
});

test("a deleted artifact is ineligible", async () => {
  const a = await art({ deleted: true });
  assert.deepEqual(await ensure(a.id), { status: "off", reason: "deleted" });
  assert.deepEqual(await ensure("art_nosuchthing"), { status: "off", reason: "deleted" });
  assert.deepEqual(P.previewEligible(null, null), { ok: false, reason: "deleted" });
  // no current version row
  await db.execute({ sql: "INSERT INTO artifacts (id,title,type,current_version,received) VALUES ('art_noversion','x','page',4,0)", args: [] });
  assert.deepEqual(await ensure("art_noversion"), { status: "off", reason: "no_version" });
});

// ---- storing, serving, sweeping ---------------------------------------------------------

test("a version flagged after its preview was stored stops showing", async () => {
  const a = await art({ type: "page" });
  assert.equal((await ensure(a.id)).status, "pending");
  await settle();
  const ready = await ensure(a.id);
  assert.equal(ready.status, "ready");
  assert.equal(ready.url, P.previewUrlFor(a.id, a.n, a.hash));
  assert.ok(existsSync(ready.file));
  let r = await req("GET", ready.url);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "image/png");
  assert.equal(r.headers.get("cache-control"), "private, max-age=31536000, immutable");
  assert.ok(r.buf.equals(PNG));
  await db.execute({ sql: "UPDATE artifact_versions SET flagged_reason='tripwire' WHERE artifact_id=?", args: [a.id] });
  r = await req("GET", ready.url);
  assert.equal(r.status, 404);
  const { removed } = await P.sweepPreviews(db, dir);
  assert.ok(removed >= 1);
  assert.equal(existsSync(ready.file), false);
  assert.equal(existsSync(join(dir, "previews", a.id)), false);
});

test("the route refuses a stale version or hash", async () => {
  const a = await art({ type: "page", versions: [{}, {}, {}] });
  assert.equal(a.n, 3);
  await ensure(a.id);
  await settle();
  assert.equal((await ensure(a.id)).status, "ready");
  assert.equal((await req("GET", `/dashboard/make/preview/artifact/${a.id}?v=3&h=${a.h16}`)).status, 200);
  assert.equal((await req("GET", `/dashboard/make/preview/artifact/${a.id}?v=2&h=${a.h16}`)).status, 404);
  assert.equal((await req("GET", `/dashboard/make/preview/artifact/${a.id}?v=3&h=${"f".repeat(16)}`)).status, 404);
  assert.equal((await req("GET", `/dashboard/make/preview/artifact/${a.id}?v=3`)).status, 404);
  assert.equal((await req("GET", `/dashboard/make/preview/artifact/..%2f..%2fcrow.db?v=3&h=${a.h16}`)).status, 404);
});

test("a page that turned ineligible during the render is discarded", async () => {
  const a = await art({ type: "page" });
  S.renderImpl = async () => {
    await db.execute({ sql: "UPDATE artifacts SET received=1 WHERE id=?", args: [a.id] });
    return PNG;
  };
  await ensure(a.id);
  await settle();
  assert.equal(S.renders.length, 1);
  assert.deepEqual(dirFiles(a.id), []);
  assert.deepEqual(await ensure(a.id), { status: "off", reason: "received" });
});

test("a near-blank capture becomes a type tile", async () => {
  S.blank = true;
  const a = await art({ type: "page" });
  await ensure(a.id);
  await settle();
  assert.deepEqual(dirFiles(a.id), [`${a.n}-${a.h16}.blank`]);
  assert.deepEqual(await ensure(a.id), { status: "off", reason: "blank" });
  assert.equal(P.previewLineKey("blank"), null);
  assert.equal(S.renders.length, 1);
  assert.equal((await req("GET", P.previewUrlFor(a.id, a.n, a.hash))).status, 404);
  const tile = tileOf((await page()).body, a.id);
  assert.doesNotMatch(tile, /<img|data-mk-pv-src|Preview on its way/);
  await settle();
});

test("a navigated, oversize or bad-status render writes no file", async () => {
  for (const code of ["preview_navigated", "preview_too_large", "preview_bad_status"]) {
    reset({ renderImpl: async () => { throw Object.assign(new Error(code), { code }); } });
    const a = await art({ type: "document" });
    await ensure(a.id);
    await settle();
    assert.equal(S.renders.length, 1, code);
    assert.deepEqual(dirFiles(a.id), [], code);
    assert.deepEqual(S.releases, [undefined], `${code}: a plain release`);
    S.clock += 59 * 60_000;
    const r59 = await ensure(a.id);
    assert.equal(r59.status, "off", code);
    assert.equal(P.previewLineKey(r59.reason), null, code);
    await settle();
    assert.equal(S.renders.length, 1, `${code}: nothing queued at 59 min`);
    S.clock += 2 * 60_000;
    assert.equal((await ensure(a.id)).status, "pending", code);
    await settle();
    assert.equal(S.renders.length, 2, `${code}: one render at 61 min`);
  }
});

test("a timed-out render writes nothing, feeds the breaker, and is tried again", async () => {
  S.renderImpl = async () => { throw Object.assign(new Error("slow"), { code: "preview_timeout" }); };
  const a = await art({ type: "page" });
  await ensure(a.id);
  await settle();
  assert.deepEqual(dirFiles(a.id), []);
  assert.deepEqual(S.releases, [{ timedOut: true }]);
  assert.equal(S.revokes.length, 1);
  assert.equal((await ensure(a.id)).status, "pending");
  await settle();
});

// ---- the token and the render -----------------------------------------------------------

test("the token is minted for this render and revoked after it", async () => {
  const a = await art({ type: "document", versions: [{}, {}, {}] });
  await ensure(a.id);
  await settle();
  assert.equal(S.mints.length, 1);
  assert.deepEqual(S.mints[0].arg, { artifactId: a.id, versionN: 3, type: "document", dashboardOrigin: null, scriptsOff: true });
  assert.deepEqual(S.revokes, [S.mints[0].out.tokenId]);
  assert.equal(S.tokens.check(S.mints[0].out.token), null);

  S.renderImpl = async () => { throw Object.assign(new Error("nav"), { code: "preview_navigated" }); };
  const b = await art({ type: "document" });
  await ensure(b.id);
  await settle();
  assert.equal(S.mints.length, 2);
  assert.deepEqual(S.revokes, [S.mints[0].out.tokenId, S.mints[1].out.tokenId]);
  assert.equal(S.tokens.check(S.mints[1].out.token), null);
});

test("the render is limited to this token's path", async () => {
  for (const type of ["page", "document", "diagram"]) {
    reset();
    const a = await art({ type });
    await ensure(a.id);
    await settle();
    const o = S.renders[0];
    const prefix = `${BASE_URL}/v/${S.mints[0].out.token}/`;
    assert.equal(o.url, prefix, type);
    assert.equal(o.allowPrefix, prefix, type);
    assert.equal(o.mainType, MAIN_DOCUMENT_TYPES[type], type);
    assert.equal(o.fetcher, S.deps.fetcher);
  }
});

test("the fetcher targets the bind address", async () => {
  const calls = [];
  const create = (o) => { calls.push(o); return { made: true }; };
  const f = P.previewFetcher({ info: { baseUrl: BASE_URL, port: 3059, bindHost: "127.0.0.1" }, create });
  assert.deepEqual(calls, [{ host: "127.0.0.1", port: 3059 }]);
  assert.deepEqual(f, { made: true });
  // One per gateway: asked again, the same fetcher.
  assert.equal(P.previewFetcher({ info: { baseUrl: BASE_URL, port: 3059, bindHost: "127.0.0.1" }, create }), f);
  assert.equal(calls.length, 1);
  assert.equal(P.previewFetcher({ info: null, create }), null);
});

// ---- what Make shows --------------------------------------------------------------------

const LINES = {
  no_docker: ["Previews are off: Docker isn't available on this machine.", "Las vistas previas están desactivadas: Docker no está disponible en esta máquina."],
  building: ["Setting up previews…", "Preparando las vistas previas…"],
  build_failed: ["Previews are off: the preview browser couldn't be set up. Crow will try again later.", "Las vistas previas están desactivadas: no se pudo preparar el navegador de vistas previas. Crow lo intentará de nuevo más tarde."],
  start_failed: ["Previews are off: the preview browser didn't start.", "Las vistas previas están desactivadas: el navegador de vistas previas no arrancó."],
  sandbox_unavailable: ["Previews are off: this machine doesn't allow the preview browser's sandbox.", "Las vistas previas están desactivadas: esta máquina no permite el aislamiento del navegador de vistas previas."],
  origin_unreachable: ["Previews are paused: the artifact viewer isn't answering.", "Las vistas previas están en pausa: el visor de artefactos no responde."],
};
const escHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const count = (hay, needle) => hay.split(needle).length - 1;

test("every renderer reason has its own line", async () => {
  for (const [reason, [en, es]] of Object.entries(LINES)) {
    reset({ off: reason });
    assert.ok(P.previewLineKey(reason), reason);
    assert.equal(t(P.previewLineKey(reason), "en"), en);
    assert.equal(t(P.previewLineKey(reason), "es"), es);
    const a = await art({ type: "page" });
    const b = await art({ type: "document" });
    await page();      // the first listing queues; the job finds the renderer off
    await settle();
    for (const [lang, line] of [["en", en], ["es", es]]) {
      const html = (await page(lang)).body;
      assert.equal(count(html, escHtml(line)), 1, `${reason} ${lang}: one line`);
      for (const id of [a.id, b.id]) assert.doesNotMatch(tileOf(html, id), /<img|data-mk-pv-src/);
    }
  }
});

test("an existing instance sees the button, not previews", async () => {
  await clearSwitch();
  const a = await art({ type: "page" });
  // A Workspace file alongside (R-P4-11): Nextcloud's preview is not behind the switch.
  const make = await import("../servers/gateway/dashboard/panels/make.js");
  const { listMakeItems } = await import("../servers/gateway/make/sources.js");
  make._setMakeSeamsForTest({
    list: async (d, scope, opts) => {
      const model = await listMakeItems(d, scope, opts);
      const ws = { kind: "workspace_file", ref: "4242", title: "Menu", type: "spreadsheet", filter: "documents", shared: false,
        updatedAt: "2026-10-26T10:00:00.000Z", version: null, cardId: null, projectId: null, justMade: false, openUrl: "/dashboard/make/open/workspace_file/4242" };
      Object.assign(ws, await opts.previews(ws));
      return { ...model, items: [ws, ...model.items], workspace: "installed" };
    },
  });
  try {
  for (const [lang, button, line] of [["en", "Turn on previews", "Previews are off."], ["es", "Activar vistas previas", "Las vistas previas están desactivadas."]]) {
    const html = (await page(lang)).body;
    assert.match(html, new RegExp(`<form[^>]*method="post"[^>]*action="/dashboard/make/previews/enable"`));
    assert.equal(count(html, button), 1);
    assert.ok(html.includes(escHtml(line)));
    assert.ok(html.includes(escHtml(t("shell.previewsDisclosure", lang))));
    assert.doesNotMatch(tileOf(html, a.id), /<img|data-mk-pv-src/);
    assert.ok(tileOf(html, "4242").includes('data-mk-pv-src="/dashboard/make/preview/workspace_file/4242"'), `${lang}: the Workspace tile tries Nextcloud's preview`);
  }
  } finally { make._setMakeSeamsForTest(); }
  await settle();
  assert.equal(S.renders.length, 0);
  assert.equal(S.acquires, 0);
  assert.equal(S.queue.size(), 0);
  // The Workspace path reads no renderer deps at all.
  assert.deepEqual(await P.itemPreview(db, { kind: "workspace_file", ref: "4242" }, null),
    { previewState: "workspace", previewUrl: "/dashboard/make/preview/workspace_file/4242", previewReason: null });
});

test("a throwing revoke still releases the lease", async () => {
  S.tokens.revokeToken = (id) => { S.revokes.push(id); throw new Error("revoke broke"); };
  const a = await art({ type: "page" });
  await ensure(a.id);
  await settle();
  assert.equal(S.revokes.length, 1);
  assert.deepEqual(S.releases, [undefined]);
  assert.equal(S.leases, 0);
  assert.equal((await ensure(a.id)).status, "ready");
});

test("the renderer is probed again once a minute, and queued jobs behind an off return before acquiring", async () => {
  reset({ off: "building" });
  const a = await art({ type: "page" });
  const b = await art({ type: "page" });
  const c = await art({ type: "page" });
  // Three queued at once: the first acquires and finds the renderer off; the two behind it skip.
  for (const x of [a, b, c]) assert.equal((await ensure(x.id)).status, "pending");
  await settle();
  assert.equal(S.acquires, 1);
  // Inside the minute: off, nothing queued.
  S.clock += 59_000;
  for (const x of [a, b, c]) assert.deepEqual(await ensure(x.id), { status: "off", reason: "building" });
  await settle();
  assert.equal(S.acquires, 1);
  // After it: one probe gets through (the listing queues; the first job acquires once more).
  S.clock += 2_000;
  for (const x of [a, b, c]) assert.equal((await ensure(x.id)).status, "pending");
  await settle();
  assert.equal(S.acquires, 2);
  assert.equal(S.renders.length, 0);
});

test("the button needs CSRF", async () => {
  await clearSwitch();
  let r = await req("POST", "/dashboard/make/previews/enable", { body: { back: "/dashboard/make?filter=pages" } });
  assert.equal(r.status, 403);
  assert.notEqual(await readSetting(db, "previews_enabled"), "true");
  assert.equal(S.prepares, 0);
  r = await req("POST", "/dashboard/make/previews/enable", { body: { _csrf: "tok", back: "/dashboard/make?filter=pages" } });
  assert.equal(r.status, 303);
  assert.equal(r.location, "/dashboard/make?filter=pages");
  assert.equal(await readSetting(db, "previews_enabled"), "true");
  assert.equal(S.prepares, 1);
  assert.equal(S.clears, 1, "the start backoff is cleared on enable");
  for (const back of ["//evil.example/x", "https://evil.example/", "/dashboard/../x", "/\\evil.example", "javascript:alert(1)", ""]) {
    r = await req("POST", "/dashboard/make/previews/enable", { body: { _csrf: "tok", back } });
    assert.equal(r.status, 303);
    assert.equal(r.location, "/dashboard/make", back);
  }
});

test("pending tiles say so and re-check once; ready tiles show the image", async () => {
  const a = await art({ type: "page" });
  let html = (await page()).body;
  let tile = tileOf(html, a.id);
  assert.match(tile, /Preview on its way/);
  assert.ok(tile.includes(`data-mk-pv-src="${escHtml(P.previewUrlFor(a.id, a.n, a.hash))}"`));
  assert.match(tile, /data-mk-pv-wait="10000"/);
  await settle();
  html = (await page()).body;
  tile = tileOf(html, a.id);
  assert.ok(tile.includes(`<img src="${escHtml(P.previewUrlFor(a.id, a.n, a.hash))}"`));
  assert.doesNotMatch(tile, /Preview on its way/);
  assert.match(html, /data-mk-pv-src/); // the client hook is on the page only via tiles
  assert.doesNotMatch(html.split("<script>").slice(1).join(""), /`/);
});

test("the preview key moves with the version", async () => {
  const h1 = HASH("a"), h2 = HASH("b");
  assert.notEqual(P.previewFile(dir, "art_keykey01", 3, h1), P.previewFile(dir, "art_keykey01", 4, h1));
  assert.notEqual(P.previewFile(dir, "art_keykey01", 3, h1), P.previewFile(dir, "art_keykey01", 3, h2));
  assert.equal(P.previewFile(dir, "art_keykey01", 3, h1), join(dir, "previews", "art_keykey01", `3-${"a".repeat(16)}.png`));
  assert.equal(P.previewUrlFor("art_keykey01", 3, h1), `/dashboard/make/preview/artifact/art_keykey01?v=3&h=${"a".repeat(16)}`);
  const a = await art({ type: "page" });
  await ensure(a.id);
  await settle();
  assert.equal((await ensure(a.id)).status, "ready");
  await db.execute({ sql: "UPDATE artifact_versions SET state='past' WHERE artifact_id=?", args: [a.id] });
  await db.execute({ sql: "INSERT INTO artifact_versions (artifact_id,n,state,files_json,size,content_hash,made_by,untrusted_input) VALUES (?,2,'current','[]',1,?,'bot',0)", args: [a.id, h2] });
  await db.execute({ sql: "UPDATE artifacts SET current_version=2 WHERE id=?", args: [a.id] });
  assert.equal((await ensure(a.id)).status, "pending");
  await settle();
  assert.deepEqual(dirFiles(a.id), [`2-${"b".repeat(16)}.png`]);
  assert.equal((await req("GET", P.previewUrlFor(a.id, 1, a.hash))).status, 404);
});

test("a render holds a lease", async () => {
  const a = await art({ type: "page" });
  await ensure(a.id);
  await settle();
  assert.deepEqual(S.leasesDuringRender, [1]);
  assert.equal(S.leases, 0);
  assert.deepEqual(S.releases, [undefined]);
  // Renderer off: the job records the reason and never renders.
  reset({ off: "building" });
  const b = await art({ type: "page" });
  assert.equal((await ensure(b.id)).status, "pending");
  await settle();
  assert.equal(S.renders.length, 0);
  assert.deepEqual(await ensure(b.id), { status: "off", reason: "building" });
  assert.equal(P.previewLineKey("building"), "shell.previewsBuilding");
});

test("the queue renders one at a time and caps", async () => {
  const q = P.createPreviewQueue({ max: 3 });
  let running = 0, most = 0;
  const gates = [];
  const job = () => async () => {
    running++; most = Math.max(most, running);
    await new Promise((r) => gates.push(r));
    running--;
  };
  assert.equal(q.add("a", job()), "queued");
  assert.equal(q.add("b", job()), "queued");
  assert.equal(q.add("c", job()), "queued");
  assert.equal(q.add("a", job()), "busy");
  assert.equal(q.has("b"), true);
  assert.equal(q.add("d", job()), "full");
  assert.equal(q.size(), 3);
  while (gates.length || q.size()) {
    await new Promise((r) => setImmediate(r));
    const g = gates.shift();
    if (g) g();
  }
  await q.idle();
  assert.equal(most, 1);
  assert.equal(q.has("a"), false);
  // A failing job never stops the queue.
  let ran = false;
  q.add("x", async () => { throw new Error("boom"); });
  q.add("y", async () => { ran = true; });
  await q.idle();
  assert.equal(ran, true);
  // A full queue leaves the tile a plain type tile, tried again on a later listing.
  reset();
  S.deps.queue = P.createPreviewQueue({ max: 0 });
  const a = await art({ type: "page" });
  const r = await ensure(a.id);
  assert.equal(r.status, "off");
  assert.equal(P.previewLineKey(r.reason), null);
});

test("workspace previews fall back", async () => {
  // The route: the image when Nextcloud has one, else 404.
  S.ws = () => null;
  let r = await req("GET", "/dashboard/make/preview/workspace_file/77");
  assert.equal(r.status, 404);
  S.ws = (id) => (id === 77 ? Object.assign(Buffer.from(PNG), { contentType: "image/png", etag: '"abc"' }) : null);
  r = await req("GET", "/dashboard/make/preview/workspace_file/77");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "image/png");
  assert.equal(r.headers.get("cache-control"), "private, no-cache");
  assert.equal(r.headers.get("etag"), '"abc"');
  assert.ok(r.buf.equals(PNG));
  assert.equal((await req("GET", "/dashboard/make/preview/workspace_file/0")).status, 404);
  assert.equal((await req("GET", "/dashboard/make/preview/workspace_file/abc")).status, 404);
  S.ws = () => { throw new Error("down"); };
  assert.equal((await req("GET", "/dashboard/make/preview/workspace_file/77")).status, 404);

  // The tile: a re-check hook, the type tile until the image loads.
  const d = await P.itemPreview(db, { kind: "workspace_file", ref: "77" }, S.deps);
  assert.deepEqual(d, { previewState: "workspace", previewUrl: "/dashboard/make/preview/workspace_file/77", previewReason: null });

  // fetchPreview against a stand-in Nextcloud.
  const seen = [];
  const nc = http.createServer((q, s) => {
    seen.push({ url: q.url, auth: q.headers.authorization });
    const id = new URL(q.url, "http://x").searchParams.get("fileId");
    if (id === "1") { s.writeHead(200, { "content-type": "image/png", etag: '"e1"' }); return s.end(PNG); }
    if (id === "2") { s.writeHead(200, { "content-type": "text/html" }); return s.end("<p>login</p>"); }
    s.writeHead(404); s.end();
  });
  await new Promise((res) => nc.listen(0, "127.0.0.1", res));
  try {
    const { fetchPreview } = await import("../bundles/workspace/server/nc/dav.js");
    const cfg = { ncUrl: `http://127.0.0.1:${nc.address().port}`, user: "crow-bot", appPassword: "app-pass-test" };
    const got = await fetchPreview(cfg, 1, { x: 640, y: 400 });
    assert.ok(Buffer.isBuffer(got) && got.equals(PNG));
    assert.equal(got.etag, '"e1"');
    assert.equal(got.contentType, "image/png");
    assert.equal(seen[0].url, "/index.php/core/preview?fileId=1&x=640&y=400&a=1");
    assert.equal(seen[0].auth, `Basic ${Buffer.from("crow-bot:app-pass-test").toString("base64")}`);
    assert.equal(await fetchPreview(cfg, 2, { x: 640, y: 400 }), null, "not an image");
    assert.equal(await fetchPreview(cfg, 3, { x: 640, y: 400 }), null, "404");
    assert.equal(await fetchPreview({ ...cfg, ncUrl: "http://127.0.0.1:1" }, 1, { x: 640, y: 400 }), null, "unreachable");
  } finally {
    nc.close();
  }
});

test("the sweep keeps only the current version's file", async () => {
  const a = await art({ type: "page" });
  await ensure(a.id);
  await settle();
  const keep = `${a.n}-${a.h16}.png`;
  writeFileSync(join(dir, "previews", a.id, `9-${"c".repeat(16)}.png`), PNG);
  writeFileSync(join(dir, "previews", a.id, `${a.n}-${"d".repeat(16)}.blank`), "");
  const gone = await art({ type: "page", deleted: true });
  mkdirSync(join(dir, "previews", gone.id), { recursive: true });
  writeFileSync(join(dir, "previews", gone.id, `1-${gone.h16}.png`), PNG);
  const { removed } = await P.sweepPreviews(db, dir);
  assert.ok(removed >= 3);
  assert.deepEqual(dirFiles(a.id), [keep]);
  assert.equal(existsSync(join(dir, "previews", gone.id)), false);
  assert.ok(readFileSync(join(dir, "previews", a.id, keep)).equals(PNG));
});
