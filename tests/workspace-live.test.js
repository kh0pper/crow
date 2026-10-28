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
const editorJwt = (k, extra = {}, uid = "admin") => sign({ document: { key: k, permissions: { edit: true } }, editorConfig: { user: { id: `ocinst_${uid}`, name: uid } }, exp: Math.floor(Date.now() / 1000) + 2592000, ...extra });
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
  assert.equal((await claim(changeId, editorJwt(key, { editorConfig: { mode: "view", user: { id: "ocinst_admin" } } }))).status, 401);
  assert.equal((await claim(changeId, editorJwt(key, { editorConfig: { ds_view: true, user: { id: "ocinst_admin" } } }))).status, 401);
  assert.equal((await claim(changeId, editorJwt(key, { document: { key, permissions: { edit: false } } }))).status, 401);
  const c1 = await claim(changeId); const c2 = await claim(changeId);
  assert.equal(c1.status, 200); assert.equal(c2.status, 409);
  const { apply_token, lease_until } = await c1.json();
  assert.ok(lease_until > Date.now());
  assert.equal((await ack({ change_id: changeId, apply_token: "forged", outcome: "applied" })).status, 403);
  assert.equal((await ack({ change_id: changeId, apply_token: `${lease_until}.AAAA`, outcome: "applied" })).status, 403);
  // the apply token is bound to the document key: another live document's editor cannot ack it
  assert.notEqual((await ack({ change_id: changeId, apply_token, outcome: "applied" }, editorJwt(key2))).status, 200);
  // fix A: a crafted inverse in the ack is NEVER stored (or executed): the undo is derived from Crow's own record
  const a = await ack({ change_id: changeId, apply_token, outcome: "applied", inverse: [{ tool: "ws_docs_find_replace", args: { path: "S/evil.docx", find: "Totopos", replace: "EVIL-CONTENT" } }] });
  assert.equal(a.status, 200);
  const st = (await call("ws_change_status", { change_id: changeId })).data;
  assert.equal(st.state, "applied_live"); assert.equal(st.verified, false, "an ack is never proof (R-LIVE)");
  const stored = (await row(changeId)).inverse_json;
  assert.doesNotMatch(stored, /EVIL|evil/);
  assert.deepEqual(JSON.parse(stored), [{ tool: "ws_docs_find_replace", args: { pairs: [{ find: "Totopos", replace: "Tortillas" }], expect_count: 1, path: "S/l.docx" } }]);
  // M1: the notification never states the live edit as fact
  const n = (await db.execute("SELECT title FROM notifications ORDER BY id DESC LIMIT 1")).rows[0];
  assert.match(n.title, /was applied in the open editor \(confirmed when the file is saved\)/);
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
  const { apply_token } = await (await claim(next, j2)).json();
  assert.equal((await ack({ change_id: next, apply_token, outcome: "applied", inverse: [{ tool: "ws_drive_trash_file", args: {} }] }, j2)).status, 200);
  assert.match((await row(next)).inverse_json, /"replace":"Tortillas"/, "derived from the row, the ack's inverse ignored");
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

// ---- T13 fix round 1 ----------------------------------------------------------------------------------------
const req = (path, jwt, { method = "GET", body, headers = {} } = {}) => fetch(`${base}${path}`, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}`, ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });

test("fix B: write permission is checked server-side on /pending, /claim and /ack (owner ok; read-only sharee and unverifiable rights get the same 401 as no session)", async () => {
  doc("r.docx");
  fake.state.shares.push({ id: "s1", path: "/S", share_with: "alex", share_type: 0, permissions: 1 }, // read-only on the folder
    { id: "s2", path: "/S/r.docx", share_with: "eve", share_type: 0, permissions: 3 }, // can edit this file
    { id: "s3", path: "/S", share_with: "family", share_type: 1, permissions: 31 }); // a GROUP share: crow-bot cannot list members
  const k = fake.openInEditor("S/r.docx", ["admin", "alex", "eve", "gina"], { releaseAfterMs: 10 ** 9 });
  const id = (await call("ws_docs_find_replace", { path: "S/r.docx", find: "Tortillas", replace: "Totopos" })).data.change_id;
  const pend = (uid) => req(`/api/workspace/live/v1/pending?key=${k}&${PV}`, editorJwt(k, {}, uid));
  assert.equal((await pend("alex")).status, 401, "a viewer sees no change content");
  assert.equal((await pend("gina")).status, 401, "group-only rights are unverifiable → view-only");
  assert.deepEqual((await (await pend("eve")).json()).map((x) => x.change_id), [id]);
  assert.deepEqual((await (await pend("admin")).json()).map((x) => x.change_id), [id], "the owner");
  assert.equal((await claim(id, editorJwt(k, {}, "alex"))).status, 401);
  // B3: a viewer cannot disturb a legitimate claim — its failed/applied_nothing ack is refused and changes nothing
  const { apply_token } = await (await claim(id, editorJwt(k, {}, "eve"))).json();
  assert.equal((await ack({ change_id: id, apply_token, outcome: "failed", applied_nothing: true }, editorJwt(k, {}, "alex"))).status, 401);
  assert.equal((await row(id)).state, "claimed_live");
  // Nextcloud's share API unreachable → unverifiable → fail closed (acks and claims check fresh)
  fake.state.shareApiDown = true;
  try { assert.equal((await ack({ change_id: id, apply_token, outcome: "applied" }, editorJwt(k, {}, "eve"))).status, 401); }
  finally { fake.state.shareApiDown = false; }
  assert.equal((await ack({ change_id: id, apply_token, outcome: "applied" }, editorJwt(k, {}, "eve"))).status, 200);
  assert.equal((await row(id)).state, "applied_live");
});

test("fix B3: a false 'applied' ack only delays — at close the saved file decides, and a missing change fails visibly", async () => {
  doc("p.docx");
  const k = fake.openInEditor("S/p.docx", ["admin"], { releaseAfterMs: 10 ** 9 });
  const id = (await call("ws_docs_append", { path: "S/p.docx", markdown: "Nunca escrito" })).data.change_id;
  const { apply_token } = await (await claim(id, editorJwt(k))).json();
  assert.equal((await ack({ change_id: id, apply_token, outcome: "applied" }, editorJwt(k))).status, 200); // nothing was written
  fake.node("S/p.docx").lock = null; fake.state.sessions.delete(k); // the editor closes
  const W = await import("../bundles/workspace/server/queue/worker.js");
  const { getConfig } = await import("../bundles/workspace/server/config.js");
  await W.makeTick({ db, getConfig, clock: { now: () => Date.now(), sleep: async () => {} } })();
  const r = await row(id);
  assert.equal(r.state, "failed"); assert.equal(JSON.parse(r.result_json).reason, "not_saved");
  assert.ok((await db.execute("SELECT title FROM notifications")).rows.some((n) => /p\.docx could not be applied/.test(n.title)));
});

test("fix I1: a write into a merged non-anchor cell is refused at queue time; a rewrite of a linked paragraph is never offered live", async () => {
  fake.addFile("S/g.xlsx", readFileSync(join(ROOT, "tests", "fixtures", "workspace", "oo-rich.xlsx")), { owner: "admin" });
  fake.openInEditor("S/g.xlsx", ["admin"], { releaseAfterMs: 10 ** 9 });
  const w = await call("ws_sheets_write", { path: "S/g.xlsx", range: "Recetas!B6", values: [["x"]] });
  assert.equal(w.success, false); assert.equal(w.code, "merged_cell");
  doc("h.docx");
  assert.equal((await call("ws_docs_append", { path: "S/h.docx", markdown: "[Receta](https://example.com) del día" })).success, true); // closed: written now
  const k = fake.openInEditor("S/h.docx", ["admin"], { releaseAfterMs: 10 ** 9 });
  const id = (await call("ws_docs_rewrite_passages", { path: "S/h.docx", passages: [{ match_prefix: "Receta del", new_text: "Otra receta" }] })).data.change_id;
  assert.equal(JSON.parse((await row(id)).precondition_json).plain, false);
  assert.deepEqual(await (await get(`/api/workspace/live/v1/pending?key=${k}&${PV}`, editorJwt(k))).json(), []);
  assert.equal((await claim(id, editorJwt(k))).status, 409);
});

test("fix A: derived inverses come from the row's args + pre only (exact or null)", async () => {
  const { deriveInverse } = await import("../bundles/workspace/server/live/derive-inverse.js");
  const r = (tool, args, pre) => ({ tool, path: "S/x", args_json: JSON.stringify({ path: "S/x", ...args }), precondition_json: JSON.stringify(pre) });
  const inv = (...a) => deriveInverse(r(...a));
  assert.deepEqual(inv("ws_docs_append", { markdown: "# Cena\n\nTacos al pastor\ncon piña" }, { text: "Cena", count: 0 }),
    [{ tool: "ws__docs_remove_paragraphs_exact", args: { texts: ["Cena", "Tacos al pastor con piña"], at_end: true, path: "S/x" } }]);
  assert.deepEqual(inv("ws_docs_insert_at_heading", { heading: "Menú", markdown: "Lunes" }, { text: "Lunes", count: 0 })[0].args, { texts: ["Lunes"], after_heading: "Menú", path: "S/x" });
  assert.equal(inv("ws_docs_append", { markdown: "| a |\n|---|\n| b |" }, {}), null, "a table is not paragraph-exact");
  assert.equal(inv("ws_docs_find_replace", { find: "a", replace: "b", match_case: true }, { fcount: 2, rcount: 1 }), null, "the replacement existed before");
  assert.equal(inv("ws_docs_find_replace", { find: "a", replace: "b", match_case: false }, { fcount: 2, rcount: 0 }), null);
  assert.deepEqual(inv("ws_docs_find_replace", { find: "a", replace: "b", match_case: true }, { fcount: 2, rcount: 0 })[0].args.expect_count, 2);
  assert.deepEqual(inv("ws_sheets_write", { range: "'Mi tab'!b2:c2", values: [["x", 1]] }, { cells: [["old", 3]] }),
    [{ tool: "ws_sheets_write", args: { range: "'Mi tab'!B2", values: [["old", 3]], value_input_option: "RAW", path: "S/x" } }]);
  assert.equal(inv("ws_sheets_write", { range: "T!A1", values: [["x"]] }, { cells: [["=A2"]] }), null);
  assert.deepEqual(inv("ws_sheets_append", { sheet_name: "Menu", values: [{ Plato: "Sopa" }] }, { header: ["Día", "Plato"], last_row: 4 })[0].args, { sheet: "Menu", from_row: 5, values: [["", "Sopa"]], path: "S/x" });
  assert.equal(inv("ws_sheets_set_number_format", { range: "T!A1:A2", format_type: "DATE" }, { s_attrs: [["0"], [null]] }), null, "N1: queue-time style indices are not exact after the editor re-saves styles → versions");
  assert.deepEqual(inv("ws_sheets_rename_tab", { title: "A", new_title: "B" }, {})[0].args, { title: "B", new_title: "A", path: "S/x" });
  assert.equal(inv("ws_docs_rewrite_passages", { passages: [{ match_prefix: "a", new_text: "b" }] }, { new_counts: {}, plain: true }), null, "the replaced text is not on Crow's record");
  assert.equal(inv("ws_sheets_add_tab", { title: "X" }, {}), null);
});

test("fix C + fix2 X1: pre-auth buckets count only token FAILURES, keyed by the gateway's classified client; post-auth per (document, user) and per document", async () => {
  const { liveRouter } = await import("../bundles/workspace/server/live/routes-live.js");
  const { getConfig } = await import("../bundles/workspace/server/config.js");
  const { resolveClientMiddleware } = await import("../servers/shared/peer-class.js");
  const { actAsServe } = await import("./fixtures/serve-peer.mjs");
  actAsServe(); // this process stands in for tailscaled (Serve's socket owner)
  const mk = (limits) => { const a = express(); a.use(resolveClientMiddleware()); a.use(liveRouter({ Router: express.Router, json: express.json, db, getConfig, clock: { now: () => Date.now() }, limits })); const s = a.listen(0); return { s, b: `http://127.0.0.1:${s.address().port}` }; };
  const { s: s2, b: b2 } = mk({ perIp: 3, global: 5, perUser: 100, perDocument: 100 });
  try {
    const hit = (xff, jwt = "bad.token.x") => fetch(`${b2}/pending?key=${key}&${PV}`, { headers: { Authorization: `Bearer ${jwt}`, "X-Forwarded-For": xff, "X-Forwarded-Host": "crow.example.ts.net:8457" } }).then((r) => r.status);
    const oo = fake.calls.filter((c) => c.method === "OO").length;
    // a client rotating a spoofed extra hop stays in one bucket: Serve writes exactly one XFF value, so a
    // multi-hop XFF is not Serve's and is keyed on the socket (P0 peer classifier)
    assert.deepEqual([await hit("1.1.1.1, 100.64.0.1"), await hit("2.2.2.2, 100.64.0.1"), await hit("3.3.3.3, 100.64.0.1"), await hit("4.4.4.4, 100.64.0.1")], [401, 401, 401, 429]);
    assert.equal(fake.calls.filter((c) => c.method === "OO").length, oo, "bad tokens never reach ONLYOFFICE");
    assert.deepEqual([await hit("100.64.0.2"), await hit("100.64.0.3"), await hit("100.64.0.4")], [401, 401, 429], "the global cap on failures (3 + 2 counted, the 6th refused)");
    // an unauthenticated flood filled both buckets: a valid editor (same address, too) is not affected
    assert.equal(await hit("100.64.0.1", editorJwt(key)), 200);
    assert.equal(await hit("100.64.0.9", editorJwt(key)), 200);
  } finally { s2.close(); }
  const { s: s3, b: b3 } = mk({ perIp: 100, global: 100, perUser: 2, perDocument: 3 });
  try {
    const k = fake.state.keys.get(fake.node("S/r.docx").fileId);
    const pend = (uid) => fetch(`${b3}/pending?key=${k}&${PV}`, { headers: { Authorization: `Bearer ${editorJwt(k, {}, uid)}` } }).then((r) => r.status);
    // N3: viewers polling never spend the per-document budget
    for (let i = 0; i < 2; i++) assert.equal(await pend("alex"), 401);
    assert.deepEqual([await pend("admin"), await pend("admin"), await pend("admin")], [200, 200, 429], "per (document, user)");
    assert.deepEqual([await pend("eve"), await pend("eve")], [200, 429], "the per-document ceiling (authorized editors only)");
  } finally { s3.close(); }
});

test("fix2 N6: a valid token whose key matches no queued file is not re-asked of ONLYOFFICE within 30 s (same candidate files)", async () => {
  const { liveRouter } = await import("../bundles/workspace/server/live/routes-live.js");
  const { getConfig } = await import("../bundles/workspace/server/config.js");
  const a = express(); a.use(liveRouter({ Router: express.Router, json: express.json, db, getConfig, clock: { now: () => Date.now() } }));
  const s4 = a.listen(0); const b4 = `http://127.0.0.1:${s4.address().port}`;
  try {
    const go = () => fetch(`${b4}/claim`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${editorJwt("no-such-key")}` }, body: JSON.stringify({ change_id: "pc_x", pv: "0.2.0" }) }).then((r) => r.status);
    assert.equal(await go(), 401);
    const oo = fake.calls.filter((c) => c.method === "OO").length;
    assert.equal(await go(), 401);
    assert.equal(fake.calls.filter((c) => c.method === "OO").length, oo);
  } finally { s4.close(); }
});

test("fix2 N2: a share whose numeric status is not 'accepted' grants no write; a presence-status object is ignored", async () => {
  const { userCanWrite } = await import("../bundles/workspace/server/live/permissions.js");
  const { getConfig } = await import("../bundles/workspace/server/config.js");
  doc("st.docx"); const n = fake.node("S/st.docx");
  fake.state.shares.push({ id: "p0", path: "/S/st.docx", share_with: "pat", share_type: 0, permissions: 3, status: 0 },
    { id: "r2", path: "/S/st.docx", share_with: "rex", share_type: 0, permissions: 3, status: 2 },
    { id: "a1", path: "/S/st.docx", share_with: "ana", share_type: 0, permissions: 3, status: 1 },
    { id: "pr", path: "/S/st.docx", share_with: "pres", share_type: 0, permissions: 3, status: { status: "offline", message: null } },
    { id: "s0", path: "/S/st.docx", share_with: "sam", share_type: 0, permissions: 3, status: "0" }, // fix3 R3: numeric string
    { id: "s1", path: "/S/st.docx", share_with: "sue", share_type: 0, permissions: 3, status: "1" });
  const can = (uid) => userCanWrite(getConfig(), n.fileId, uid, "S/st.docx");
  assert.deepEqual([await can("pat"), await can("rex"), await can("ana"), await can("pres"), await can("admin"), await can("sam"), await can("sue")], [false, false, true, true, true, false, true]);
});

test("fix C3: the limiter's key set is bounded (least recently used evicted), counters of live keys survive", async () => {
  const { windowLimiter } = await import("../bundles/workspace/server/live/limits.js");
  let t = 0; const l = windowLimiter({ max: 2, windowMs: 1000, maxKeys: 2, now: () => t });
  assert.equal(l.hit("a"), true); assert.equal(l.hit("b"), true); assert.equal(l.hit("a"), true);
  assert.equal(l.hit("c"), true);
  assert.equal(l.size(), 2); assert.equal(l.has("b"), false, "b was least recently used"); assert.equal(l.hit("a"), false, "a kept its count");
  t = 1000; assert.equal(l.hit("a"), true, "a new window");
});

test("fix I2: delete_tab as an undo step refuses a tab that is not empty (changed_since)", async () => {
  const { checkPre } = await import("../bundles/workspace/server/queue/conditions.js");
  const X = await import("../bundles/workspace/server/ooxml/xlsx.js");
  const wb = X.openXlsx(readFileSync(join(ROOT, "tests", "fixtures", "workspace", "oo-rich.xlsx")));
  X.addTab(wb, "Vacía"); X.addTab(wb, "Llena"); X.writeRange(wb, "Llena!A1", [["dato"]]);
  const bytes = Buffer.from(wb.pkg.save());
  const pre = { undo_of: "pc_x", orig: null };
  assert.deepEqual(checkPre("ws_sheets_delete_tab", { title: "Vacía" }, { undo_of: "pc_x" }, bytes), { ok: true });
  assert.deepEqual(checkPre("ws_sheets_delete_tab", { title: "Llena" }, pre, bytes), { ok: false, reason: "changed_since" });
});

test("fix3 R1: a valid token is limited per (document, user) BEFORE any session lookup — no Nextcloud/ONLYOFFICE call once over; a viewer spends only its own bucket", async () => {
  const { liveRouter } = await import("../bundles/workspace/server/live/routes-live.js");
  const { getConfig } = await import("../bundles/workspace/server/config.js");
  const a = express(); a.use(liveRouter({ Router: express.Router, json: express.json, db, getConfig, clock: { now: () => Date.now() }, limits: { perIp: 100, global: 100, perUser: 2, perDocument: 100 } }));
  const s5 = a.listen(0); const b5 = `http://127.0.0.1:${s5.address().port}`;
  try {
    const k = fake.state.keys.get(fake.node("S/r.docx").fileId);
    const claimAs = (uid) => fetch(`${b5}/claim`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${editorJwt(k, {}, uid)}` }, body: JSON.stringify({ change_id: "pc_none", pv: "0.2.0" }) }).then((r) => r.status);
    assert.deepEqual([await claimAs("alex"), await claimAs("alex")], [401, 401], "a viewer: forced lookups, refused");
    const n = fake.calls.length;
    assert.equal(await claimAs("alex"), 429);
    assert.equal(fake.calls.length, n, "over the limit: no Nextcloud or ONLYOFFICE call at all");
    assert.deepEqual([await claimAs("admin"), await claimAs("admin"), await claimAs("admin")], [409, 409, 429], "the editor has its own bucket");
  } finally { s5.close(); }
});

test("fix3 R2: the gateway's global 1 MB JSON parser skips the live prefix (only the bundle's 256 KB parser runs, after the token check)", () => {
  const src = readFileSync(join(ROOT, "servers", "gateway", "index.js"), "utf8");
  const m = /const _hasOwnParser = \(p\) => ([^\n]*\n[^\n]*);/.exec(src);
  assert.ok(m, "the predicate is where it was");
  const pred = m[1];
  assert.ok(pred.includes('startsWith("/api/workspace/live/v1/")'));
  // final M3: Express routes case-insensitively, so the skip must too (else a mixed-case path is parsed by the 1 MB parser before the token check)
  const skip = new Function("p", `return ${pred};`);
  for (const p of ["/api/workspace/live/v1/claim", "/API/Workspace/Live/V1/claim", "/llm/v1/chat"]) assert.equal(skip(p), true, p);
  for (const p of ["/api/workspace/quick/save", "/dashboard"]) assert.equal(skip(p), false, p);
  assert.match(readFileSync(join(ROOT, "bundles", "workspace", "server", "live", "routes-live.js"), "utf8"), /router\.use\(preAuth, json\(\{ limit: "256kb" \}\), auth\)/);
});

test("fix3 R4: no set_number_format inverse exists any more (ws__sheets_restore_styles removed)", async () => {
  const C = await import("../bundles/workspace/server/queue/conditions.js");
  const { ALL_DEFS } = await import("../bundles/workspace/server/tools/all.js");
  assert.ok(!C.INTERNAL_OPS.includes("ws__sheets_restore_styles")); assert.ok(!ALL_DEFS.has("ws__sheets_restore_styles"));
  assert.equal(C.INVERSE_OF.ws_sheets_set_number_format, undefined);
  assert.equal(C.pinInverse({ tool: "ws_sheets_set_number_format", path: "S/a.xlsx" }, [{ tool: "ws__sheets_restore_styles", args: {} }]), null);
});

test("latency: a non-live session, a key that matched nothing and a user who joined after the cache are re-asked after NEGATIVE_TTL_MS (5 s), not 30 s", async () => {
  const { liveRouter, NEGATIVE_TTL_MS } = await import("../bundles/workspace/server/live/routes-live.js");
  const { getConfig } = await import("../bundles/workspace/server/config.js");
  assert.equal(NEGATIVE_TTL_MS, 5000);
  let now = Date.now();
  const a = express(); a.use(liveRouter({ Router: express.Router, json: express.json, db, getConfig, clock: { now: () => now } }));
  const s5 = a.listen(0); const b5 = `http://127.0.0.1:${s5.address().port}`;
  const pend = (k) => fetch(`${b5}/pending?key=${k}&${PV}`, { headers: { Authorization: `Bearer ${editorJwt(k)}` } }).then((r) => r.status);
  try {
    // a session someone else is in; the operator joins after the first poll cached it
    doc("rj.docx"); const kr = fake.openInEditor("S/rj.docx", ["bob"], { releaseAfterMs: 10 ** 9 });
    await call("ws_docs_append", { path: "S/rj.docx", markdown: "Hola." });
    assert.equal(await pend(kr), 401, "not in the session yet");
    fake.state.sessions.get(kr).users.push("ocinst_admin");
    assert.equal(await pend(kr), 401, "inside the negative window: cached");
    now += NEGATIVE_TTL_MS + 1000;
    assert.equal(await pend(kr), 200, "re-asked after 5 s");
    // a session whose last viewer left (key cached, nobody in it), then the operator opens it again
    doc("vl.docx"); const kv = fake.openInEditor("S/vl.docx", ["admin"], { releaseAfterMs: 10 ** 9 });
    await call("ws_docs_append", { path: "S/vl.docx", markdown: "Hola." });
    fake.viewerLeft("S/vl.docx", kv);
    assert.equal(await pend(kv), 401);
    fake.state.sessions.get(kv).users = ["ocinst_admin"];
    assert.equal(await pend(kv), 401, "cached miss");
    now += NEGATIVE_TTL_MS + 1000;
    assert.equal(await pend(kv), 200, "seen within ~5 s");
  } finally { s5.close(); }
});

// ---- Comment loop Phase 1, Task 7: POST /comments (shadow mode: log only) -------------------------------------
const HOUR_MS = 3600_000;
const ST_ = () => import("../bundles/workspace/server/comments/store.js");
const ownerJwt = (k, name = "Casey") => editorJwt(k, { editorConfig: { user: { id: "ocinst_admin", name } } });
const thread = ({ text = "@hank please tidy this", userName = "Casey", time = Date.now(), replies = [] } = {}) =>
  ({ Id: "1_1", Text: text, Time: String(time), UserName: userName, QuoteText: "con\r\n", Solved: false, Replies: replies });
const reportTo = (k, { jwt = ownerJwt(k), hint, kind = "add", th = thread(), occ, key: bodyKey = k } = {}) =>
  post("/api/workspace/live/v1/comments", jwt, { key: bodyKey, pv: "0.3.0", kind, thread: th, occ: occ ?? [0, ...(th.Replies || []).map(() => 0)] }, hint !== undefined ? { "X-Crow-File-Hint": String(hint) } : {});
const commentEvents = async (kind) => (await db.execute("SELECT * FROM workspace_comment_events ORDER BY id")).rows
  .filter((r) => !kind || r.kind === kind).map((r) => ({ kind: r.kind, fileId: r.file_id === null ? null : Number(r.file_id), raw: r.detail_json, ...JSON.parse(r.detail_json) }));
const hankBot = () => db.execute("INSERT OR REPLACE INTO pi_bot_defs(bot_id, display_name, enabled) VALUES ('hank', 'Hank', 1)");
const shadowOn = async () => { await hankBot(); const S = await ST_(); await S.setMode(db, "shadow", Date.now() - HOUR_MS); };
const commentOff = async () => { await hankBot(); const S = await ST_(); await S.setMode(db, "off", Date.now()); };
const clearEvents = () => db.execute("DELETE FROM workspace_comment_events");

test("/comments: same 401 for bad token, unknown key, viewer, read-only sharee; unresolved valid token logs unresolved_key", async () => {
  await shadowOn(); await clearEvents();
  doc("cv.docx"); const f = fake.node("S/cv.docx");
  fake.state.shares.push({ id: "cv1", path: "/S/cv.docx", share_with: "vic", share_type: 0, permissions: 1 });
  const k = fake.openInEditor("S/cv.docx", ["admin", "vic"], { releaseAfterMs: 10 ** 9 });
  // sampled once by the owner's editor, so a view token (whose hint is ignored) still reaches the session
  assert.equal((await get(`/api/workspace/live/v1/pending?key=${k}&${PV}`, editorJwt(k), { "X-Crow-File-Hint": String(f.fileId) })).status, 200);
  const answers = [
    await reportTo(k, { jwt: "bad.token.x", hint: f.fileId }),
    await reportTo(k, { jwt: sign({ document: { key: k }, editorConfig: { user: { id: "ocinst_admin" } }, exp: 9e9 }, "wrong"), hint: f.fileId }),
    await reportTo(k, { jwt: editorJwt(k, { editorConfig: { mode: "view", user: { id: "ocinst_admin", name: "Casey" } } }), hint: f.fileId }),
    await reportTo(k, { jwt: editorJwt(k, {}, "vic"), hint: f.fileId }),
    await reportTo(k, { jwt: editorJwt(k, {}, "mallory"), hint: f.fileId }),
  ];
  assert.equal((await commentEvents("unresolved_key")).length, 0, "a key that resolved is not 'unresolved'");
  answers.push(await reportTo("no-such-key-7", { jwt: ownerJwt("no-such-key-7") }));
  for (const a of answers) { assert.equal(a.status, 401); assert.deepEqual(await a.json(), { error: "unauthorized" }); }
  const un = await commentEvents("unresolved_key");
  assert.equal(un.length, 1);
  assert.equal(un[0].fileId, null, "no file id");
  assert.deepEqual({ source: un[0].source, hinted: un[0].hinted }, { source: "live", hinted: false });
  assert.doesNotMatch(un[0].raw, /no-such-key/, "the key is not stored");
  assert.equal((await commentEvents()).filter((e) => e.kind !== "unresolved_key").length, 0, "nothing else logged");
  // mode off: an unresolved report logs nothing
  await commentOff();
  assert.equal((await reportTo("no-such-key-8", { jwt: ownerJwt("no-such-key-8") })).status, 401);
  assert.equal((await commentEvents("unresolved_key")).length, 1);
});

test("/comments: mode off or blocked → the hint is not honoured (401), nothing logged; shadow → live_report + verdict", async () => {
  await commentOff(); await clearEvents();
  doc("cs.docx"); const f = fake.node("S/cs.docx");
  const k = fake.openInEditor("S/cs.docx", ["admin"], { releaseAfterMs: 10 ** 9 });
  const off = await reportTo(k, { hint: f.fileId });
  assert.equal(off.status, 401, "off: candidates come from queued work only (the pre-loop K5 path)");
  assert.equal((await commentEvents()).length, 0);
  const S = await ST_();
  await S.setMode(db, "shadow", Date.now() - HOUR_MS); await S.setBlocked(db, "duplicate_display_name");
  assert.equal((await reportTo(k, { hint: f.fileId })).status, 401, "blocked is off");
  assert.equal((await commentEvents()).length, 0);
  await S.setBlocked(db, null);
  const t0 = Date.now() - 800;
  const r = await reportTo(k, { hint: f.fileId, th: thread({ time: t0 }) });
  assert.deepEqual(await r.json(), { state: "shadow" });
  const ev = await commentEvents();
  assert.deepEqual(ev.map((e) => e.kind), ["live_report", "would_fire"]);
  const [lr, v] = ev;
  assert.equal(lr.fileId, f.fileId); assert.equal(lr.source, "live"); assert.equal(lr.bot, "hank");
  assert.ok(lr.latency_ms >= 800 && lr.latency_ms < 60000, `latency ${lr.latency_ms}`);
  for (const x of ["pair", "fp", "hash", "snippet", "bot"]) assert.equal(v[x], lr[x], x);
  assert.deepEqual({ source: v.source, reason: v.reason, sole: v.sole }, { source: "live", reason: "owner_verified", sole: true });
  assert.equal(typeof v.age_s, "number");
  // a "change" (a reply) carries no latency; a report with no bot mention logs nothing
  await clearEvents();
  const th = thread({ time: t0, replies: [{ Text: "@hank and this", Time: String(Date.now()), UserName: "Casey" }] });
  await reportTo(k, { hint: f.fileId, kind: "change", th });
  const ch = await commentEvents("live_report");
  assert.equal(ch.length, 1); assert.equal(ch[0].latency_ms, null); assert.equal(ch[0].snippet, "@hank and this", "the newest comment naming a bot");
  await clearEvents();
  assert.deepEqual(await (await reportTo(k, { hint: f.fileId, th: thread({ text: "@nobody here" }) })).json(), { state: "shadow" });
  assert.deepEqual(await (await reportTo(k, { hint: f.fileId, th: thread({ userName: "hank-p (bot)" }) })).json(), { state: "shadow" });
  assert.equal((await commentEvents()).length, 0, "unknown bot, or a bot's own comment: nothing");
  // the report's key must be the token's
  assert.equal((await reportTo(k, { hint: f.fileId, key: "someone-else" })).status, 401);
});

test("/comments: sole owner add → would_fire; coworker in info.users → unverified coworker_in_session; payload UserName ≠ token name → unverified_author", async () => {
  await shadowOn(); await clearEvents();
  doc("co1.docx"); doc("co2.docx");
  const solo = fake.node("S/co1.docx"), shared = fake.node("S/co2.docx");
  const ks = fake.openInEditor("S/co1.docx", ["admin"], { releaseAfterMs: 10 ** 9 });
  const kc = fake.openInEditor("S/co2.docx", ["admin", "alex"], { releaseAfterMs: 10 ** 9 });
  const verdict = async () => (await commentEvents()).filter((e) => ["would_fire", "unverified", "history"].includes(e.kind)).at(-1);
  assert.equal((await reportTo(ks, { hint: solo.fileId })).status, 200);
  assert.deepEqual([(await verdict()).kind, (await verdict()).reason], ["would_fire", "owner_verified"]);
  assert.equal((await reportTo(kc, { hint: shared.fileId })).status, 200);
  const v2 = await verdict();
  assert.deepEqual([v2.kind, v2.reason, v2.sole], ["unverified", "coworker_in_session", false]);
  assert.equal((await reportTo(ks, { hint: solo.fileId, jwt: ownerJwt(ks, "admin"), th: thread({ text: "@hank second one" }) })).status, 200);
  const v3 = await verdict();
  assert.deepEqual([v3.kind, v3.reason, v3.sole], ["unverified", "unverified_author", true]);
});

test("/comments: Text > 4096 or 51 replies → 400; a body never stored in full", async () => {
  await shadowOn(); await clearEvents();
  doc("big.docx"); const f = fake.node("S/big.docx");
  const k = fake.openInEditor("S/big.docx", ["admin"], { releaseAfterMs: 10 ** 9 });
  const long = `@hank ${"x".repeat(4100)}`;
  const bad = [
    await reportTo(k, { hint: f.fileId, th: thread({ text: long.slice(0, 4097) }) }),
    await reportTo(k, { hint: f.fileId, th: thread({ replies: Array.from({ length: 51 }, () => ({ Text: "ok", Time: String(Date.now()), UserName: "Casey" })) }) }),
    await reportTo(k, { hint: f.fileId, occ: [0, 0] }),
    await reportTo(k, { hint: f.fileId, kind: "remove" }),
  ];
  for (const r of bad) { assert.equal(r.status, 400); assert.deepEqual(await r.json(), { error: "bad_report" }); }
  assert.equal((await commentEvents()).length, 0);
  const fifty = Array.from({ length: 50 }, (_, i) => ({ Text: `reply ${i}`, Time: String(Date.now()), UserName: "Casey" }));
  assert.equal((await reportTo(k, { hint: f.fileId, kind: "change", th: thread({ text: long.slice(0, 4096), replies: fifty }) })).status, 200, "at the limits: accepted");
  const ev = await commentEvents();
  assert.ok(ev.length >= 2);
  for (const e of ev) { assert.ok(e.raw.length < 600, "hash + snippet only"); assert.doesNotMatch(e.raw, /x{41}/); assert.equal(e.snippet.length, 40); }
});

test("plugin 0.3.0 still claims and acks a queued change (existing live apply path)", async () => {
  doc("pz.docx");
  const k = fake.openInEditor("S/pz.docx", ["admin"], { releaseAfterMs: 10 ** 9 });
  const id = (await call("ws_docs_find_replace", { path: "S/pz.docx", find: "Tortillas", replace: "Totopos" })).data.change_id;
  assert.deepEqual((await (await get(`/api/workspace/live/v1/pending?key=${k}&pv=0.3.0`, editorJwt(k))).json()).map((x) => x.change_id), [id]);
  const c = await claim(id, editorJwt(k), "0.3.0");
  assert.equal(c.status, 200);
  const { apply_token } = await c.json();
  assert.equal((await ack({ change_id: id, apply_token, outcome: "applied" }, editorJwt(k))).status, 200);
  const r = await row(id);
  assert.equal(r.state, "applied_live"); assert.equal(Number(r.verified), 0);
});

test("MIN_PLUGIN_VERSION stays 0.2.0", async () => {
  const { MIN_PLUGIN_VERSION } = await import("../bundles/workspace/server/live/routes-live.js");
  assert.equal(MIN_PLUGIN_VERSION, "0.2.0");
});

test("a hint never lets a token reach another file's queue: hint B with key K_A on /pending → [] while B has a queued change", async () => {
  await shadowOn(); // hints are honoured only while the comment loop runs
  doc("ha.docx"); doc("hb.docx");
  const A = fake.node("S/ha.docx"), B = fake.node("S/hb.docx");
  const kA = fake.openInEditor("S/ha.docx", ["admin"], { releaseAfterMs: 10 ** 9 });
  const kB = fake.openInEditor("S/hb.docx", ["admin"], { releaseAfterMs: 10 ** 9 });
  assert.deepEqual(await (await get(`/api/workspace/live/v1/pending?key=${kA}&${PV}`, editorJwt(kA), { "X-Crow-File-Hint": String(A.fileId) })).json(), [], "A is sampled");
  const idB = (await call("ws_docs_append", { path: "S/hb.docx", markdown: "Solo B" })).data.change_id;
  const viaB = await get(`/api/workspace/live/v1/pending?key=${kA}&${PV}`, editorJwt(kA), { "X-Crow-File-Hint": String(B.fileId) });
  assert.equal(viaB.status, 200);
  assert.deepEqual(await viaB.json(), [], "K_A stays on file A");
  assert.notEqual((await post("/api/workspace/live/v1/claim", editorJwt(kA), { change_id: idB, pv: "0.3.0" }, { "X-Crow-File-Hint": String(B.fileId) })).status, 200);
  assert.equal((await row(idB)).state, "pending");
  assert.deepEqual((await (await get(`/api/workspace/live/v1/pending?key=${kB}&${PV}`, editorJwt(kB))).json()).map((x) => x.change_id), [idB], "control: B's own editor sees it");
});

test("hints: honoured only for an edit-capable token; at most 10 uncached hint lookups per key per minute; unchanged samples skipped within 15 s", async () => {
  await shadowOn();
  const { liveRouter, HINT_LOOKUPS_PER_MIN, SAMPLE_SKIP_MS } = await import("../bundles/workspace/server/live/routes-live.js");
  const { getConfig } = await import("../bundles/workspace/server/config.js");
  const { sessionByKey } = await import("../bundles/workspace/server/comments/sessions.js");
  assert.equal(HINT_LOOKUPS_PER_MIN, 10); assert.equal(SAMPLE_SKIP_MS, 15000);
  let now = Date.now();
  const a = express(); a.use(liveRouter({ Router: express.Router, json: express.json, db, getConfig, clock: { now: () => now } }));
  const s6 = a.listen(0); const b6 = `http://127.0.0.1:${s6.address().port}`;
  const pend = (k, hint, jwt = editorJwt(k)) => fetch(`${b6}/pending?key=${k}&${PV}`, { headers: { Authorization: `Bearer ${jwt}`, "X-Crow-File-Hint": String(hint) } }).then((r) => r.status);
  const configCalls = (id) => fake.calls.filter((c) => c.url.includes(`/apps/onlyoffice/api/v1/config/${id}`)).length;
  try {
    doc("hv.docx"); const v = fake.node("S/hv.docx");
    const kv = fake.openInEditor("S/hv.docx", ["admin"], { releaseAfterMs: 10 ** 9 });
    const n0 = configCalls(v.fileId);
    assert.equal(await pend(kv, v.fileId, editorJwt(kv, { document: { key: kv, permissions: { edit: false } } })), 401);
    assert.equal(configCalls(v.fileId), n0, "a view token's hint is never looked up");
    // ten uncached lookups (files that do not exist), then the right hint is ignored until the minute passes
    doc("hl.docx"); const l = fake.node("S/hl.docx");
    const kl = fake.openInEditor("S/hl.docx", ["admin"], { releaseAfterMs: 10 ** 9 });
    for (let i = 0; i < 10; i++) assert.equal(await pend(kl, 900100 + i), 401);
    assert.equal(await pend(kl, l.fileId), 401, "over the hint limit: behaves as an unresolved hint");
    assert.equal(configCalls(l.fileId), 0);
    now += 61_000;
    assert.equal(await pend(kl, l.fileId), 200, "a new minute");
    // samples: an unchanged one is not re-written within 15 s
    const first = Number((await sessionByKey(db, kl)).last_seen);
    now += 5000; assert.equal(await pend(kl, l.fileId), 200);
    assert.equal(Number((await sessionByKey(db, kl)).last_seen), first, "skipped within 15 s");
    now += 11_000; assert.equal(await pend(kl, l.fileId), 200);
    assert.equal(Number((await sessionByKey(db, kl)).last_seen), now, "written again after 15 s");
  } finally { s6.close(); }
});

test("fix1: a config-level commentLoopBlocked (or a throwing getConfig) means an unresolved /comments report logs nothing", async () => {
  const { liveRouter, LIMITS } = await import("../bundles/workspace/server/live/routes-live.js");
  const { getConfig } = await import("../bundles/workspace/server/config.js");
  await shadowOn(); await clearEvents();
  let mode = "ok"; // ok → real config; blocked → commentLoopBlocked set
  const cfg = () => (mode === "blocked" ? { ...getConfig(), commentLoopBlocked: "duplicate_display_name" } : getConfig());
  const a = express(); a.use(liveRouter({ Router: express.Router, json: express.json, db, getConfig: cfg, clock: { now: () => Date.now() }, limits: LIMITS }));
  const s = a.listen(0); const b = `http://127.0.0.1:${s.address().port}`;
  const rep = (k) => fetch(`${b}/comments`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerJwt(k)}` }, body: JSON.stringify({ key: k, pv: "0.3.0", kind: "add", thread: thread(), occ: [0] }) }).then((r) => r.status);
  try {
    assert.equal(await rep("no-such-key-c1"), 401);
    assert.equal((await commentEvents("unresolved_key")).length, 1, "control: unblocked, it is logged");
    mode = "blocked"; await clearEvents();
    assert.equal(await rep("no-such-key-c2"), 401);
    assert.equal((await commentEvents()).length, 0, "config-level block: nothing logged");
    await clearEvents();
    let thrown = false;
    const a2 = express(); a2.use(liveRouter({ Router: express.Router, json: express.json, db, clock: { now: () => Date.now() }, limits: LIMITS, getConfig: () => { if (/logUnresolved/.test(new Error().stack)) { thrown = true; throw new Error("config gone"); } return getConfig(); } }));
    const s2 = a2.listen(0);
    try {
      const st = await fetch(`http://127.0.0.1:${s2.address().port}/comments`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerJwt("no-such-key-c3")}` }, body: JSON.stringify({ key: "no-such-key-c3", pv: "0.3.0", kind: "add", thread: thread(), occ: [0] }) }).then((r) => r.status);
      assert.equal(st, 401);
      assert.ok(thrown, "the log path asked the config");
      assert.equal((await commentEvents()).length, 0, "a throwing getConfig is blocked: nothing logged");
    } finally { s2.close(); }
  } finally { s.close(); }
});

test("fix2: reporting the SECOND of two pasted duplicates with occ [1] logs the saved side's second fingerprint, not the first", async () => {
  await shadowOn(); await clearEvents();
  const { commentDocx } = await import("./helpers/workspace-comment-docx.js");
  const { openDocx } = await import("../bundles/workspace/server/ooxml/docx-model.js");
  const { readCommentThreads } = await import("../bundles/workspace/server/ooxml/docx-comments.js");
  const K = await import("../bundles/workspace/server/comments/keys.js");
  doc("dup.docx"); const f = fake.node("S/dup.docx");
  const k = fake.openInEditor("S/dup.docx", ["admin"], { releaseAfterMs: 10 ** 9 });
  const time = 1793157691225, iso = new Date(Math.floor(time / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const th = { ...thread({ text: "@hank dup", time }), QuoteText: "con" }; // the saved side below: author Casey, quote "con"
  const saved = K.flatten(readCommentThreads(openDocx(commentDocx({ threads: [0, 1].map(() => ({ author: "Casey", date: iso, text: "@hank dup", quoted: "con" })) }))).threads);
  const [fp0, fp1] = saved.map(K.fingerprint);
  assert.notEqual(fp0, fp1);
  assert.equal((await reportTo(k, { hint: f.fileId, th, occ: [1] })).status, 200);
  const [lr] = await commentEvents("live_report");
  assert.equal(lr.fp, fp1, "the saved side's second duplicate");
  assert.notEqual(lr.fp, fp0);
});

test("fix3: a global budget of FAILED hint lookups; successful hints never spend it; once spent, uncached hints are ignored", async () => {
  await shadowOn();
  const { liveRouter, LIMITS, HINT_FAILURES_PER_MIN } = await import("../bundles/workspace/server/live/routes-live.js");
  const { getConfig } = await import("../bundles/workspace/server/config.js");
  assert.equal(HINT_FAILURES_PER_MIN, 120);
  let now = Date.now();
  const a = express(); a.use(liveRouter({ Router: express.Router, json: express.json, db, getConfig, clock: { now: () => now }, limits: { ...LIMITS, perUser: 10000, perDocument: 10000, perDocumentRaw: 10000, hintLookups: 10000, hintFailures: 5 } }));
  const s = a.listen(0); const b = `http://127.0.0.1:${s.address().port}`;
  const pend = (k, hint) => fetch(`${b}/pending?key=${k}&${PV}`, { headers: { Authorization: `Bearer ${editorJwt(k)}`, "X-Crow-File-Hint": String(hint) } }).then((r) => r.status);
  const configCalls = (id) => fake.calls.filter((c) => c.url.includes(`/apps/onlyoffice/api/v1/config/${id}`)).length;
  try {
    doc("gb1.docx"); const g1 = fake.node("S/gb1.docx"); const k1 = fake.openInEditor("S/gb1.docx", ["admin"], { releaseAfterMs: 10 ** 9 });
    doc("gb2.docx"); const g2 = fake.node("S/gb2.docx"); const k2 = fake.openInEditor("S/gb2.docx", ["admin"], { releaseAfterMs: 10 ** 9 });
    // successful hints (and repeats of them) never spend the budget
    for (let i = 0; i < 8; i++) assert.equal(await pend(k1, g1.fileId), 200);
    // five failing lookups (files that are not live / do not exist) spend it
    for (let i = 0; i < 5; i++) assert.equal(await pend(k2, 900300 + i), 401);
    assert.ok(configCalls(900300) > 0, "the failing hints were looked up");
    // the sixth failing hint makes no docSession call
    assert.equal(await pend(k2, 900399), 401);
    assert.equal(configCalls(900399), 0, "over the global budget: ignored");
    // a fresh valid hint is ignored too (treated as no hint) ...
    const n = configCalls(g2.fileId);
    assert.equal(await pend(k2, g2.fileId), 401);
    assert.equal(configCalls(g2.fileId), n);
    // ... but a hint whose session is already known still works
    assert.equal(await pend(k1, g1.fileId), 200);
    now += 61_000;
    assert.equal(await pend(k2, g2.fileId), 200, "a new window");
  } finally { s.close(); }
});

test("fix4: each editor user gets a share of the failed-hint budget, so one account cannot spend everyone's", async () => {
  await shadowOn();
  const { liveRouter, LIMITS, HINT_FAILURES_PER_USER_PER_MIN } = await import("../bundles/workspace/server/live/routes-live.js");
  const { getConfig } = await import("../bundles/workspace/server/config.js");
  assert.equal(HINT_FAILURES_PER_USER_PER_MIN, 20);
  const a = express(); a.use(liveRouter({ Router: express.Router, json: express.json, db, getConfig, clock: { now: () => Date.now() }, limits: { ...LIMITS, perUser: 10000, perDocument: 10000, perDocumentRaw: 10000, hintLookups: 10000, hintFailures: 100, hintFailuresPerUser: 3 } }));
  const s = a.listen(0); const b = `http://127.0.0.1:${s.address().port}`;
  const pend = (k, hint, uid) => fetch(`${b}/pending?key=${k}&${PV}`, { headers: { Authorization: `Bearer ${editorJwt(k, {}, uid)}`, "X-Crow-File-Hint": String(hint) } }).then((r) => r.status);
  const configCalls = (id) => fake.calls.filter((c) => c.url.includes(`/apps/onlyoffice/api/v1/config/${id}`)).length;
  try {
    doc("pu1.docx"); const p1 = fake.node("S/pu1.docx");
    fake.state.shares.push({ id: "pu1s", path: "/S/pu1.docx", share_with: "vic", share_type: 0, permissions: 31 });
    const k1 = fake.openInEditor("S/pu1.docx", ["admin", "vic"], { releaseAfterMs: 10 ** 9 });
    // admin spends its own share on hints that fail
    for (let i = 0; i < 3; i++) assert.equal(await pend(k1, 900500 + i, "admin"), 401);
    assert.equal(await pend(k1, 900599, "admin"), 401);
    assert.equal(configCalls(900599), 0, "admin's share is spent: its next uncached hint is ignored");
    // vic still has a share: a failing hint of vic's is still looked up, and a valid one resolves
    assert.equal(await pend(k1, 900600, "vic"), 401);
    assert.ok(configCalls(900600) > 0, "another user's hint is still looked up");
    assert.equal(await pend(k1, p1.fileId, "vic"), 200);
  } finally { s.close(); }
});

// ---- final fix wave ---------------------------------------------------------------------------------------------
const configCallsOf = (id) => fake.calls.filter((c) => c.url.includes(`/apps/onlyoffice/api/v1/config/${id}`)).length;
const sessionRow = async (k) => (await db.execute({ sql: "SELECT * FROM workspace_editor_sessions WHERE doc_key=?", args: [k] })).rows[0] ?? null;

test("I2: mode off → a hinted /pending records no editor session and makes no docSession call for the hint; shadow → it does", async () => {
  await commentOff();
  doc("io.docx"); const f = fake.node("S/io.docx");
  const k = fake.openInEditor("S/io.docx", ["admin"], { releaseAfterMs: 10 ** 9 });
  const n0 = configCallsOf(f.fileId);
  assert.equal((await get(`/api/workspace/live/v1/pending?key=${k}&${PV}`, editorJwt(k), { "X-Crow-File-Hint": String(f.fileId) })).status, 401);
  assert.equal(await sessionRow(k), null, "no workspace_editor_sessions row");
  assert.equal(configCallsOf(f.fileId), n0, "the hint was never looked up");
  // blocked is the same as off
  const S = await ST_();
  await S.setMode(db, "shadow", Date.now() - HOUR_MS); await S.setBlocked(db, "duplicate_display_name");
  assert.equal((await get(`/api/workspace/live/v1/pending?key=${k}&${PV}`, editorJwt(k), { "X-Crow-File-Hint": String(f.fileId) })).status, 401);
  assert.equal(await sessionRow(k), null); assert.equal(configCallsOf(f.fileId), n0);
  await S.setBlocked(db, null);
  // shadow (a mode change in this process is seen at once)
  assert.equal((await get(`/api/workspace/live/v1/pending?key=${k}&${PV}`, editorJwt(k), { "X-Crow-File-Hint": String(f.fileId) })).status, 200);
  assert.ok(await sessionRow(k), "recorded in shadow mode");
  // a queued change still reaches its editor while off (the pre-loop K5 path)
  await commentOff();
  doc("iq.docx"); const kq = fake.openInEditor("S/iq.docx", ["admin"], { releaseAfterMs: 10 ** 9 });
  const id = (await call("ws_docs_append", { path: "S/iq.docx", markdown: "Hola." })).data.change_id;
  assert.deepEqual((await (await get(`/api/workspace/live/v1/pending?key=${kq}&${PV}`, editorJwt(kq))).json()).map((x) => x.change_id), [id]);
  assert.equal(await sessionRow(kq), null, "off: no session recorded even for an authorised editor");
});

test("I2: the watch row is read through a ~5 s cache (a change made by another gateway is seen within 5 s)", async () => {
  const { liveRouter, LIMITS, WATCH_TTL_MS } = await import("../bundles/workspace/server/live/routes-live.js");
  const { getConfig } = await import("../bundles/workspace/server/config.js");
  assert.equal(WATCH_TTL_MS, 5000);
  await shadowOn();
  let now = Date.now();
  const a = express(); a.use(liveRouter({ Router: express.Router, json: express.json, db, getConfig, clock: { now: () => now }, limits: { ...LIMITS, perUser: 10000, perDocument: 10000, perDocumentRaw: 10000 } }));
  const s = a.listen(0); const b = `http://127.0.0.1:${s.address().port}`;
  try {
    const open = (name) => { doc(name); const f = fake.node(`S/${name}`); return { f, k: fake.openInEditor(`S/${name}`, ["admin"], { releaseAfterMs: 10 ** 9 }) }; };
    const pend = ({ f, k }) => fetch(`${b}/pending?key=${k}&${PV}`, { headers: { Authorization: `Bearer ${editorJwt(k)}`, "X-Crow-File-Hint": String(f.fileId) } }).then((r) => r.status);
    assert.equal(await pend(open("wc1.docx")), 200);
    await db.execute("UPDATE workspace_comment_watch SET mode='off' WHERE id=1"); // another process: no in-process notice
    now += 1000; assert.equal(await pend(open("wc2.docx")), 200, "cached row: still shadow");
    now += 5000;
    const third = open("wc3.docx");
    assert.equal(await pend(third), 401, "re-read after 5 s: off");
    assert.equal(await sessionRow(third.k), null);
  } finally { s.close(); }
});

test("M2: at most 10 /comments reports per key per minute; over it 429 and nothing logged", async () => {
  const { liveRouter, LIMITS, COMMENT_REPORTS_PER_MIN } = await import("../bundles/workspace/server/live/routes-live.js");
  const { getConfig } = await import("../bundles/workspace/server/config.js");
  assert.equal(COMMENT_REPORTS_PER_MIN, 10);
  await shadowOn(); await clearEvents();
  let now = Date.now();
  const a = express(); a.use(liveRouter({ Router: express.Router, json: express.json, db, getConfig, clock: { now: () => now } }));
  const s = a.listen(0); const b = `http://127.0.0.1:${s.address().port}`;
  try {
    doc("rl.docx"); const f = fake.node("S/rl.docx");
    const k = fake.openInEditor("S/rl.docx", ["admin"], { releaseAfterMs: 10 ** 9 });
    const rep = () => fetch(`${b}/comments`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerJwt(k)}`, "X-Crow-File-Hint": String(f.fileId) }, body: JSON.stringify({ key: k, pv: "0.3.0", kind: "add", thread: thread(), occ: [0] }) }).then((r) => r.status);
    for (let i = 0; i < 10; i++) assert.equal(await rep(), 200);
    const n = (await commentEvents()).length;
    assert.ok(n >= 10);
    assert.equal(await rep(), 429);
    assert.equal((await commentEvents()).length, n, "nothing logged over the limit");
    now += 61_000;
    assert.equal(await rep(), 200, "a new minute");
  } finally { s.close(); }
});

test("M3: an unresolved /comments report logs unresolved_key only on attempt 0 (or none, or an invalid attempt)", async () => {
  await shadowOn(); await clearEvents();
  const send = (k, attempt) => post("/api/workspace/live/v1/comments", ownerJwt(k), { key: k, pv: "0.3.0", kind: "add", thread: thread(), occ: [0], ...(attempt === undefined ? {} : { attempt }) });
  for (const at of [1, 2]) assert.equal((await send(`no-such-key-m3-${at}`, at)).status, 401);
  assert.equal((await commentEvents("unresolved_key")).length, 0, "retries (attempt 1, 2) are not counted again");
  const counted = [0, undefined, 3, -1, 1.5, "1"];
  for (const [i, at] of counted.entries()) assert.equal((await send(`no-such-key-m3c-${i}`, at)).status, 401);
  assert.equal((await commentEvents("unresolved_key")).length, counted.length, "attempt 0, missing or invalid → logged");
});
