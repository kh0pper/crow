/** Task 13 (K5): the live endpoints the Crow ONLYOFFICE plugin talks to (/api/workspace/live/v1/*). */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { startFakeNextcloud } from "./helpers/workspace-fake-nextcloud.js";
import { connectWorkspace } from "./helpers/workspace-client.js";

const ROOT = join(import.meta.dirname, "..");
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const sign = (payload, secret = "jwt", head = { alg: "HS256", typ: "JWT" }) => { const h = `${b64(head)}.${b64(payload)}`; return `${h}.${createHmac("sha256", secret).update(h).digest("base64url")}`; };
// The docservice SESSION token shape S9 recorded (claims identical for edit and view sessions; 30-day exp).
const editorJwt = (k, extra = {}) => sign({ document: { key: k, permissions: { edit: true } }, editorConfig: { user: { id: "ocinst_admin", name: "Kevin" } }, exp: Math.floor(Date.now() / 1000) + 2592000, ...extra });
const PV = "pv=0.2.0";
// the fake's session for S/l.docx has users ["ocinst_admin"] (openInEditor) → tokens for other users are refused
let fake, call, close, base, server, key, key2, changeId, db;
const doc = (name) => fake.addFile(`S/${name}`, readFileSync(join(ROOT, "tests", "fixtures", "workspace", "oo-rich.docx")), { owner: "admin" });
before(async () => {
  fake = await startFakeNextcloud(); fake.addFolder("S", { owner: "admin" });
  let home;
  ({ call, close, home } = await connectWorkspace(fake));
  // F1: an explicit db path inside the scratch home, with the real schema (notifications…) from scripts/init-db.js
  const dbPath = join(home, "data", "crow.db");
  execFileSync(process.execPath, [join(ROOT, "scripts", "init-db.js")], { cwd: ROOT, env: { ...process.env, CROW_HOME: home, CROW_DATA_DIR: join(home, "data"), CROW_DB_PATH: dbPath, CROW_DISABLE_NOSTR: "1", CROW_DISABLE_INSTANCE_SYNC: "1" }, stdio: "pipe" });
  db = await (await import("../bundles/workspace/server/db.js")).openWorkspaceDb(dbPath);
  doc("l.docx"); doc("m.docx"); doc("n.docx");
  key = fake.openInEditor("S/l.docx", ["admin"], { releaseAfterMs: 10 ** 9 });
  key2 = fake.openInEditor("S/m.docx", ["admin"], { releaseAfterMs: 10 ** 9 });
  changeId = (await call("ws_docs_find_replace", { path: "S/l.docx", find: "Tortillas", replace: "Totopos" })).data.change_id;
  const { default: router } = await import("../bundles/workspace/panel/routes.js");
  const app = express(); app.use(router((req, res) => res.status(401).end(), { startWorker: false }));
  server = app.listen(0); base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); await close(); fake.close(); });
const get = (path, jwt, headers = {}) => fetch(`${base}${path}`, { headers: { ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}), ...headers } });
const post = (path, jwt, body, headers = {}) => fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}), ...headers }, body: JSON.stringify(body) });
const claim = (id, jwt = editorJwt(key), pv = "0.2.0") => post("/api/workspace/live/v1/claim", jwt, { change_id: id, ...(pv ? { pv } : {}) });
const ack = (body, jwt = editorJwt(key)) => post("/api/workspace/live/v1/ack", jwt, body);
const row = async (id) => (await db.execute({ sql: "SELECT * FROM workspace_pending_changes WHERE id=?", args: [id] })).rows[0];

test("a validly signed token for a user NOT in the live session, or for an ended session, is refused (K5-C2)", async () => {
  const intruder = sign({ document: { key }, editorConfig: { user: { id: "ocinst_mallory" } }, exp: 9e9 });
  assert.equal((await get(`/api/workspace/live/v1/pending?key=${key}&${PV}`, intruder)).status, 401);
  assert.equal((await get(`/api/workspace/live/v1/pending?key=old-session-key&${PV}`, editorJwt("old-session-key"))).status, 401);
});

test("pending requires a valid editor JWT for THAT key; never the dashboard session; only HS256", async () => {
  assert.equal((await get(`/api/workspace/live/v1/pending?key=${key}&${PV}`)).status, 401);
  assert.equal((await get(`/api/workspace/live/v1/pending?key=${key}&${PV}`, sign({ document: { key }, exp: 9e9 }, "wrong"))).status, 401);
  assert.equal((await get(`/api/workspace/live/v1/pending?key=${key}&${PV}`, editorJwt("other-key"))).status, 401);
  assert.equal((await get(`/api/workspace/live/v1/pending?key=${key}&${PV}`, editorJwt(key, { exp: 1 }))).status, 401);
  assert.equal((await get(`/api/workspace/live/v1/pending?key=${key}&${PV}`, sign({ document: { key }, editorConfig: { user: { id: "ocinst_admin" } }, exp: 9e9 }, "jwt", { alg: "none" }))).status, 401);
  assert.equal((await get(`/api/workspace/live/v1/pending?key=${key}&${PV}`, "not.a.jwt")).status, 401);
  const ok = await get(`/api/workspace/live/v1/pending?key=${key}&${PV}`, editorJwt(key));
  assert.equal(ok.status, 200);
  const list = await ok.json();
  assert.deepEqual(list.map((x) => [x.change_id, x.tool]), [[changeId, "ws_docs_find_replace"]]);
  assert.doesNotMatch(JSON.stringify(list), /pw-secret|jwt|S\/l\.docx|file_id/, "no secrets, no paths");
});

test("F8: /pending strips path and file_id from args; args_json keeps them for close-time apply", async () => {
  const [x] = await (await get(`/api/workspace/live/v1/pending?key=${key}&${PV}`, editorJwt(key))).json();
  assert.deepEqual(x.args, { find: "Tortillas", replace: "Totopos", match_case: true });
  assert.equal(JSON.parse((await row(changeId)).args_json).path, "S/l.docx");
});

test("plugin version (spec §11): pending and claim refuse a missing or old pv with 426", async () => {
  assert.equal((await get(`/api/workspace/live/v1/pending?key=${key}`, editorJwt(key))).status, 426);
  assert.equal((await get(`/api/workspace/live/v1/pending?key=${key}&pv=0.0.1`, editorJwt(key))).status, 426);
  assert.equal((await claim(changeId, editorJwt(key), null)).status, 426);
  assert.equal((await claim(changeId, editorJwt(key), "0.1.9")).status, 426);
  assert.equal((await row(changeId)).state, "pending", "nothing was claimed");
});

test("claim: one winner, view-mode JWT refused, apply token required on ack; ack applied → applied_live (unverified), inverse pinned", async () => {
  assert.equal((await claim(changeId, editorJwt(key, { editorConfig: { mode: "view", user: { id: "ocinst_admin" } } }))).status, 403);
  assert.equal((await claim(changeId, editorJwt(key, { editorConfig: { ds_view: true, user: { id: "ocinst_admin" } } }))).status, 403);
  assert.equal((await claim(changeId, editorJwt(key, { document: { key, permissions: { edit: false } } }))).status, 403);
  const c1 = await claim(changeId); const c2 = await claim(changeId);
  assert.equal(c1.status, 200); assert.equal(c2.status, 409);
  const { apply_token, lease_until } = await c1.json();
  assert.ok(lease_until > Date.now());
  assert.equal((await ack({ change_id: changeId, apply_token: "forged", outcome: "applied" })).status, 403);
  assert.equal((await ack({ change_id: changeId, apply_token: `${lease_until}.AAAA`, outcome: "applied" })).status, 403);
  // the apply token is bound to the document key: another live document's editor cannot ack it
  assert.notEqual((await ack({ change_id: changeId, apply_token, outcome: "applied" }, editorJwt(key2))).status, 200);
  const a = await ack({ change_id: changeId, apply_token, outcome: "applied", inverse: [{ tool: "ws_docs_find_replace", args: { path: "S/evil.docx", find: "Totopos", replace: "Tortillas" } }] });
  assert.equal(a.status, 200);
  const st = (await call("ws_change_status", { change_id: changeId })).data;
  assert.equal(st.state, "applied_live"); assert.equal(st.verified, false, "an ack is never proof (R-LIVE)");
  assert.deepEqual(JSON.parse((await row(changeId)).inverse_json), [{ tool: "ws_docs_find_replace", args: { find: "Totopos", replace: "Tortillas", path: "S/l.docx" } }]);
  assert.equal((await ack({ change_id: changeId, apply_token, outcome: "applied" })).status, 409, "a second ack changes nothing");
});

test("inverse ops are pinned: a ws_drive_* or foreign-path inverse is dropped (→ undo via versions) (K5-I7)", async () => {
  const { pinInverse } = await import("../bundles/workspace/server/queue/conditions.js");
  const r = { tool: "ws_docs_find_replace", path: "S/l.docx" };
  assert.equal(pinInverse(r, [{ tool: "ws_drive_restore_version", args: { path: "S/other.docx", version_id: "1" } }]), null);
  assert.deepEqual(pinInverse(r, [{ tool: "ws_docs_find_replace", args: { path: "S/evil.docx", pairs: [{ find: "a", replace: "b" }] } }])[0].args.path, "S/l.docx");
});

test("a failed live apply that changed nothing returns to pending ONCE (claim_count ≤ 1); it is not offered again", async () => {
  const id = (await call("ws_docs_append", { path: "S/l.docx", markdown: "Línea" })).data.change_id;
  const { apply_token } = await (await claim(id)).json();
  assert.equal((await ack({ change_id: id, apply_token, outcome: "failed", applied_nothing: true, reason: "api_error" })).status, 200);
  assert.equal((await call("ws_change_status", { change_id: id })).data.state, "pending");
  assert.equal((await claim(id)).status, 409, "no second live attempt");
  assert.deepEqual(await (await get(`/api/workspace/live/v1/pending?key=${key}&${PV}`, editorJwt(key))).json(), []);
});

test("only the next change in seq order, only live-eligible ones; another document's editor cannot claim it", async () => {
  const multi = (await call("ws_docs_find_replace", { path: "S/m.docx", pairs: [{ find: "Tortillas", replace: "a" }, { find: "Cebolla", replace: "b" }] })).data.change_id;
  const next = (await call("ws_docs_find_replace", { path: "S/m.docx", find: "Tortillas", replace: "Tostadas" })).data.change_id;
  const j2 = editorJwt(key2);
  assert.deepEqual(await (await get(`/api/workspace/live/v1/pending?key=${key2}&${PV}`, j2)).json(), [], "a multi-pair find/replace is undecidable live → close-time; it also blocks later changes");
  assert.equal((await claim(multi, j2)).status, 409);
  assert.equal((await claim(next, j2)).status, 409, "not the next change in order");
  await call("ws_cancel_change", { change_id: multi });
  assert.equal((await claim(next, editorJwt(key))).status, 409, "a token for another live document cannot claim this file's change");
  const list = await (await get(`/api/workspace/live/v1/pending?key=${key2}&${PV}`, j2)).json();
  assert.deepEqual(list.map((x) => x.change_id), [next]);
  // an ack whose inverse fails the inverse tool's own schema stores NO inverse (→ undo via versions)
  const { apply_token } = await (await claim(next, j2)).json();
  assert.equal((await ack({ change_id: next, apply_token, outcome: "applied", inverse: [{ tool: "ws_docs_find_replace", args: { pairs: "nope" } }] }, j2)).status, 200);
  assert.equal((await row(next)).inverse_json, null);
});

test("a failed live apply that may have changed something → unknown_after_claim (postcondition decides at close)", async () => {
  const id = (await call("ws_docs_find_replace", { path: "S/m.docx", find: "Tostadas", replace: "Tlayudas" })).data.change_id;
  const j2 = editorJwt(key2);
  const { apply_token } = await (await claim(id, j2)).json();
  assert.equal((await ack({ change_id: id, apply_token, outcome: "failed", reason: "postcondition" }, j2)).status, 200);
  const r = await row(id);
  assert.equal(r.state, "unknown_after_claim"); assert.equal(JSON.parse(r.result_json).live_failed, "postcondition");
});

test("Funnel-tagged requests never reach the live API; old plugin versions get 426", async () => {
  assert.equal((await get(`/api/workspace/live/v1/pending?key=${key}&${PV}`, editorJwt(key), { "Tailscale-Funnel-Request": "?1" })).status, 403);
  assert.equal((await get(`/api/workspace/live/v1/pending?key=${key}&pv=0.0.1`, editorJwt(key))).status, 426);
});

test("rate limiting: the live prefix is exempt from the gateway's general limiter; its own limit is 60/min per document", async () => {
  const src = readFileSync(join(ROOT, "servers", "gateway", "middleware", "rate-limit.js"), "utf8");
  assert.match(src, /GENERAL_LIMITER_SKIP_PREFIXES[\s\S]*"\/api\/workspace\/live\/"/);
  const k3 = fake.openInEditor("S/n.docx", ["admin"], { releaseAfterMs: 10 ** 9 });
  await call("ws_docs_append", { path: "S/n.docx", markdown: "Hola" });
  const j3 = editorJwt(k3); const codes = [];
  for (let i = 0; i < 61; i++) codes.push((await get(`/api/workspace/live/v1/pending?key=${k3}&${PV}`, j3)).status);
  assert.deepEqual([codes[0], codes[59], codes[60]], [200, 200, 429]);
  assert.equal((await get(`/api/workspace/live/v1/pending?key=${key}&${PV}`, editorJwt(key))).status, 200, "the limit is per document");
});

test("one plugin version everywhere: config.json, crow-live.js and the server's minimum", async () => {
  const { MIN_PLUGIN_VERSION, versionAtLeast } = await import("../bundles/workspace/server/live/routes-live.js");
  const dir = join(ROOT, "bundles", "workspace", "onlyoffice-plugin");
  const cfg = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
  assert.equal(cfg.guid, "asc.{6F1C2A5E-0C5D-4C8B-9B57-C0DE0C0FFEE1}");
  assert.equal(/VERSION = "([^"]+)"/.exec(readFileSync(join(dir, "crow-live.js"), "utf8"))[1], cfg.version);
  assert.ok(versionAtLeast(cfg.version, MIN_PLUGIN_VERSION));
  assert.equal(versionAtLeast("0.10.0", "0.2.0"), true); assert.equal(versionAtLeast("0.2", "0.2.0"), false); assert.equal(versionAtLeast(undefined), false);
  const html = readFileSync(join(dir, "index.html"), "utf8");
  assert.deepEqual([...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]), ["./../v1/plugins.js", "./../v1/plugins-ui.js", "ops.js", "crow-live.js"], "no external scripts");
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")), { type: "commonjs" });
});
