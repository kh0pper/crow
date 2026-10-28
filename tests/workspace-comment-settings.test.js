/** Comment loop Phase 1, Task 8: the Settings card and the mode route (off | shadow; "on" is refused). */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { createServer } from "node:http";

const ROOT = join(import.meta.dirname, "..");
const V = await import("../bundles/workspace/server/comments/settings-view.js");
let server, base, home, db, ST, nc, t = 1_800_000_000_000;
const ncState = { users: [], down: false }; // the fake Nextcloud: autocomplete answers


before(async () => {
  home = mkdtempSync(join(tmpdir(), "ws-cset-")); mkdirSync(join(home, "bundles", "workspace"), { recursive: true }); mkdirSync(join(home, "data"), { recursive: true });
  writeFileSync(join(home, "bundles", "workspace", ".env"), "WORKSPACE_BOOTSTRAP_DONE=1\nWORKSPACE_PUBLIC_HOST=crow.test\nWORKSPACE_BOT_APP_PASSWORD=pw-secret-123\nWORKSPACE_ONLYOFFICE_JWT_SECRET=jwt\n", { mode: 0o600 });
  nc = createServer((req, res) => {
    req.resume();
    if (req.url.startsWith("/ocs/v2.php/core/autocomplete/get")) {
      if (ncState.down) { res.writeHead(503); return res.end(); }
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ocs: { meta: { status: "ok", statuscode: 200 }, data: ncState.users } }));
    }
    if (req.method === "PROPFIND" && /principals\/users\/admin\/$/.test(req.url)) {
      res.writeHead(207, { "Content-Type": "application/xml" });
      return res.end(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>${req.url}</d:href><d:propstat><d:prop><d:displayname>admin</d:displayname></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`);
    }
    res.writeHead(404); res.end();
  }).listen(0);
  await new Promise((r) => nc.once("listening", r));
  Object.assign(process.env, { WORKSPACE_NC_INTERNAL_URL: `http://127.0.0.1:${nc.address().port}`, CROW_HOME: home, CROW_DATA_DIR: join(home, "data") });
  const dbPath = join(home, "data", "crow.db");
  execFileSync(process.execPath, [join(ROOT, "scripts", "init-db.js")], { cwd: ROOT, env: { ...process.env, CROW_DB_PATH: dbPath, CROW_DISABLE_NOSTR: "1", CROW_DISABLE_INSTANCE_SYNC: "1" }, stdio: "pipe" });
  db = await (await import("../bundles/workspace/server/db.js")).openWorkspaceDb(dbPath);
  ST = await import("../bundles/workspace/server/comments/store.js");
  const { default: router } = await import("../bundles/workspace/panel/routes.js");
  const app = express();
  const auth = (req, res, next) => (req.headers.cookie?.includes("crow_session=ok") ? next() : res.status(401).end());
  app.use(router(auth, { clock: { now: () => t }, startWorker: false, csrf: (req, res, next) => (req.body?._csrf === "tok" ? next() : res.status(403).end("csrf")) }));
  server = app.listen(0); base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); nc.close(); });
const post = (form, cookie = "crow_session=ok") => fetch(`${base}/api/workspace/comments/mode`, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie }, body: new URLSearchParams(form).toString() });
const notice = (r) => new URL(r.headers.get("location"), base).searchParams.get("notice");

test("card: en/es string parity, labels, 44px radios, no script, watch_since shown, blocked sentence shown, all escaped", () => {
  assert.deepEqual(Object.keys(V.COMMENT_STRINGS.en).sort(), Object.keys(V.COMMENT_STRINGS.es).sort());
  for (const lang of ["en", "es"]) for (const [k, v] of Object.entries(V.COMMENT_STRINGS[lang])) assert.ok(String(v).trim(), `${lang}.${k}`);
  const en = V.renderCommentSettings({ lang: "en", csrf: "tok<&>", watch: { mode: "shadow", watch_since: Date.UTC(2026, 9, 28, 12) }, blocked: "duplicate_display_name" });
  assert.ok(en.includes(">Off<") && en.includes("Shadow (logs only)"));
  assert.ok(en.includes("Crow only sees documents shared with Crow bot."));
  assert.ok(en.includes("Paused:") && en.includes("another account has the same display name as the owner."));
  assert.ok(en.includes("2026-10-28"));
  assert.equal((en.match(/width:44px;height:44px/g) || []).length, 2);
  assert.match(en, /name="mode" value="shadow"[^>]*checked/);
  assert.match(en, /name="_csrf" value="tok&lt;&amp;&gt;"/);
  assert.doesNotMatch(en, /<script/i);
  const es = V.renderCommentSettings({ lang: "es", csrf: "t", watch: { mode: "off", watch_since: null }, blocked: "", notice: "not_yet" });
  assert.ok(es.includes("Apagado") && es.includes("Sombra (solo registra)") && es.includes("aún no está disponible"));
  assert.doesNotMatch(es, /Vigilando desde|En pausa/);
  assert.match(es, /name="mode" value="off"[^>]*checked/);
  assert.ok(V.renderCommentSettings({ lang: "en", csrf: "t", watch: { mode: "off" }, blocked: "<b>x</b>" }).includes("a safety check failed."), "an unknown code never shows raw");
});

test("mode route: session + CSRF required; shadow sets watch_since; off keeps it; on and junk are refused", async () => {
  assert.equal((await post({ mode: "shadow", _csrf: "tok" }, "")).status, 401);
  assert.equal((await post({ mode: "shadow", _csrf: "bad" })).status, 403);
  assert.equal((await ST.getWatch(db)).mode, "off");
  const on = await post({ mode: "on", _csrf: "tok" });
  assert.equal(on.status, 303); assert.equal(notice(on), "not_yet");
  assert.equal((await ST.getWatch(db)).mode, "off", "on changed nothing");
  const junk = await post({ mode: "bogus", _csrf: "tok" });
  assert.equal(junk.status, 303); assert.equal(notice(junk), "bad_mode");
  const sh = await post({ mode: "shadow", _csrf: "tok" });
  assert.equal(sh.status, 303); assert.equal(notice(sh), "saved");
  let w = await ST.getWatch(db);
  assert.equal(w.mode, "shadow"); assert.equal(Number(w.watch_since), t);
  t += 5000;
  await post({ mode: "shadow", _csrf: "tok" });
  assert.equal(Number((await ST.getWatch(db)).watch_since), t - 5000, "shadow to shadow keeps watch_since");
  await post({ mode: "off", _csrf: "tok" });
  w = await ST.getWatch(db); assert.equal(w.mode, "off");
});

const postTo = (path, form, cookie = "crow_session=ok") => fetch(`${base}/api/workspace/comments/${path}`, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie }, body: new URLSearchParams(form).toString() });

test("mode route: while blocked only off is accepted (shadow is refused, nothing stored, watch_since untouched)", async () => {
  await post({ mode: "off", _csrf: "tok" });
  const before = await ST.getWatch(db);
  await ST.setBlocked(db, "duplicate_display_name");
  const r = await post({ mode: "shadow", _csrf: "tok" });
  assert.equal(r.status, 303); assert.equal(notice(r), "blocked");
  const w = await ST.getWatch(db);
  assert.equal(w.mode, "off"); assert.equal(w.watch_since, before.watch_since);
  assert.equal(notice(await post({ mode: "off", _csrf: "tok" })), "saved", "off is always allowed");
  await ST.setBlocked(db, null);
});

test("recheck route: CSRF/session required; clears a duplicate_display_name block only on an explicit no-clash", async () => {
  const rc = (cookie) => postTo("recheck", { _csrf: "tok" }, cookie);
  await ST.setBlocked(db, "duplicate_display_name");
  assert.equal((await rc("")).status, 401);
  assert.equal((await postTo("recheck", { _csrf: "bad" })).status, 403);
  assert.equal((await ST.getWatch(db)).blocked_reason, "duplicate_display_name", "a refused request changes nothing");
  // true: another account has the owner's name -> block stays
  ncState.down = false; ncState.users = [{ id: "alex", label: "ADMIN" }];
  let r = await rc("crow_session=ok");
  assert.equal(r.status, 303); assert.equal(new URL(r.headers.get("location"), base).pathname, "/dashboard/workspace"); assert.equal(notice(r), "still_blocked");
  assert.equal((await ST.getWatch(db)).blocked_reason, "duplicate_display_name");
  // null: could not tell -> block stays, with the notice
  ncState.down = true;
  r = await rc("crow_session=ok");
  assert.equal(notice(r), "recheck_failed");
  assert.equal((await ST.getWatch(db)).blocked_reason, "duplicate_display_name");
  // false -> cleared
  ncState.down = false; ncState.users = [];
  r = await rc("crow_session=ok");
  assert.equal(notice(r), "unblocked");
  assert.equal((await ST.getWatch(db)).blocked_reason, null);
  // another blocked_reason is never touched by this route
  await ST.setBlocked(db, "something_else");
  await rc("crow_session=ok");
  assert.equal((await ST.getWatch(db)).blocked_reason, "something_else");
  await ST.setBlocked(db, null);
});

test("recheck route: clearing a block while the mode is shadow moves watch_since to now", async () => {
  await ST.setMode(db, "off", t); await ST.setMode(db, "shadow", t);
  const since = t;
  await ST.setBlocked(db, "duplicate_display_name");
  t += 60_000;
  ncState.down = false; ncState.users = [];
  const r = await postTo("recheck", { _csrf: "tok" });
  assert.equal(notice(r), "unblocked");
  const w = await ST.getWatch(db);
  assert.equal(w.blocked_reason, null);
  assert.equal(Number(w.watch_since), t, `watch_since moved from ${since} to the clear time`);
  await ST.setMode(db, "off", t);
});

test("card: the Check again button and remedy show only for a duplicate-name block, en and es", () => {
  const en = V.renderCommentSettings({ lang: "en", csrf: "t", watch: { mode: "off" }, blocked: "duplicate_display_name" });
  assert.ok(en.includes("Change that account&#39;s display name, then press Check again."));
  assert.match(en, /action="\/api\/workspace\/comments\/recheck"/); assert.ok(en.includes("Check again</button>"));
  const es = V.renderCommentSettings({ lang: "es", csrf: "t", watch: { mode: "off" }, blocked: "duplicate_display_name" });
  assert.ok(es.includes("Revisar de nuevo</button>"));
  for (const b of ["", "other_reason"]) assert.doesNotMatch(V.renderCommentSettings({ lang: "en", csrf: "t", watch: { mode: "off" }, blocked: b }), /recheck/);
});
