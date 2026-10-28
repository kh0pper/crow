/** Comment loop Phase 1, Task 8: the Settings card and the mode route (off | shadow; "on" is refused). */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";

const ROOT = join(import.meta.dirname, "..");
const V = await import("../bundles/workspace/server/comments/settings-view.js");
let server, base, home, db, ST, t = 1_800_000_000_000;

before(async () => {
  home = mkdtempSync(join(tmpdir(), "ws-cset-")); mkdirSync(join(home, "bundles", "workspace"), { recursive: true }); mkdirSync(join(home, "data"), { recursive: true });
  writeFileSync(join(home, "bundles", "workspace", ".env"), "WORKSPACE_BOOTSTRAP_DONE=1\nWORKSPACE_PUBLIC_HOST=crow.test\nWORKSPACE_BOT_APP_PASSWORD=pw-secret-123\nWORKSPACE_ONLYOFFICE_JWT_SECRET=jwt\n", { mode: 0o600 });
  Object.assign(process.env, { CROW_HOME: home, CROW_DATA_DIR: join(home, "data") });
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
after(() => server.close());
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
