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
  fake.state.shares.push({ id: "s1", path: "/S", share_with: "dayane", share_type: 0, permissions: 1 }, // read-only on the folder
    { id: "s2", path: "/S/r.docx", share_with: "eve", share_type: 0, permissions: 3 }, // can edit this file
    { id: "s3", path: "/S", share_with: "family", share_type: 1, permissions: 31 }); // a GROUP share: crow-bot cannot list members
  const k = fake.openInEditor("S/r.docx", ["admin", "dayane", "eve", "gina"], { releaseAfterMs: 10 ** 9 });
  const id = (await call("ws_docs_find_replace", { path: "S/r.docx", find: "Tortillas", replace: "Totopos" })).data.change_id;
  const pend = (uid) => req(`/api/workspace/live/v1/pending?key=${k}&${PV}`, editorJwt(k, {}, uid));
  assert.equal((await pend("dayane")).status, 401, "a viewer sees no change content");
  assert.equal((await pend("gina")).status, 401, "group-only rights are unverifiable → view-only");
  assert.deepEqual((await (await pend("eve")).json()).map((x) => x.change_id), [id]);
  assert.deepEqual((await (await pend("admin")).json()).map((x) => x.change_id), [id], "the owner");
  assert.equal((await claim(id, editorJwt(k, {}, "dayane"))).status, 401);
  // B3: a viewer cannot disturb a legitimate claim — its failed/applied_nothing ack is refused and changes nothing
  const { apply_token } = await (await claim(id, editorJwt(k, {}, "eve"))).json();
  assert.equal((await ack({ change_id: id, apply_token, outcome: "failed", applied_nothing: true }, editorJwt(k, {}, "dayane"))).status, 401);
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

test("fix C + fix2 X1: pre-auth buckets count only token FAILURES, keyed by the rightmost XFF hop; post-auth per (document, user) and per document", async () => {
  const { liveRouter } = await import("../bundles/workspace/server/live/routes-live.js");
  const { getConfig } = await import("../bundles/workspace/server/config.js");
  const mk = (limits) => { const a = express(); a.use(liveRouter({ Router: express.Router, json: express.json, db, getConfig, clock: { now: () => Date.now() }, limits })); const s = a.listen(0); return { s, b: `http://127.0.0.1:${s.address().port}` }; };
  const { s: s2, b: b2 } = mk({ perIp: 3, global: 5, perUser: 100, perDocument: 100 });
  try {
    const hit = (xff, jwt = "bad.token.x") => fetch(`${b2}/pending?key=${key}&${PV}`, { headers: { Authorization: `Bearer ${jwt}`, "X-Forwarded-For": xff } }).then((r) => r.status);
    const oo = fake.calls.filter((c) => c.method === "OO").length;
    // a client rotating a spoofed FIRST hop stays in one bucket: the rightmost hop is the one the proxy added
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
    for (let i = 0; i < 2; i++) assert.equal(await pend("dayane"), 401);
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
    { id: "pr", path: "/S/st.docx", share_with: "pres", share_type: 0, permissions: 3, status: { status: "offline", message: null } });
  const can = (uid) => userCanWrite(getConfig(), n.fileId, uid, "S/st.docx");
  assert.deepEqual([await can("pat"), await can("rex"), await can("ana"), await can("pres"), await can("admin")], [false, false, true, true, true]);
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
