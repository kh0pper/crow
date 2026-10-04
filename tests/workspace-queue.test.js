/** Task 12 (K5): the pending-change queue — exactly-once CAS states, close-time apply, notifications, status/cancel,
 * undo of queued and live-applied changes, and the internal exact-inverse ops. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { startFakeNextcloud } from "./helpers/workspace-fake-nextcloud.js";
import { connectWorkspace } from "./helpers/workspace-client.js";

const FIX = join(import.meta.dirname, "fixtures", "workspace");
const ROOT = join(import.meta.dirname, "..");
let fake, call, close, client, Q, W, C, db, getConfig;
before(async () => {
  fake = await startFakeNextcloud(); fake.addFolder("S", { owner: "admin" });
  let home;
  ({ call, close, client, home } = await connectWorkspace(fake));
  // F1: an explicit db path inside the scratch home, with the real schema (notifications…) from scripts/init-db.js
  const dbPath = join(home, "data", "crow.db");
  execFileSync(process.execPath, [join(ROOT, "scripts", "init-db.js")], { cwd: ROOT, env: { ...process.env, CROW_HOME: home, CROW_DATA_DIR: join(home, "data"), CROW_DB_PATH: dbPath, CROW_DISABLE_NOSTR: "1", CROW_DISABLE_INSTANCE_SYNC: "1" }, stdio: "pipe" });
  db = await (await import("../bundles/workspace/server/db.js")).openWorkspaceDb(dbPath);
  Q = await import("../bundles/workspace/server/queue/store.js");
  W = await import("../bundles/workspace/server/queue/worker.js");
  C = await import("../bundles/workspace/server/queue/conditions.js");
  ({ getConfig } = await import("../bundles/workspace/server/config.js"));
});
after(async () => { await close(); fake.close(); });
const put = (n) => fake.addFile(`S/${n}`, readFileSync(join(FIX, "oo-rich.docx")), { owner: "admin" });
const notifs = async () => (await db.execute("SELECT title, body FROM notifications ORDER BY id")).rows;
const tick = () => W.makeTick({ db, getConfig, clock: { now: () => Date.now(), sleep: async () => {} } })();
const status = async (id) => (await call("ws_change_status", { change_id: id })).data;
const closeSession = (path, key) => { fake.node(path).lock = null; fake.state.sessions.delete(key); };
const md = async (path) => (await call("ws_docs_read", { path })).data.markdown;
const editorSave = async (path, fn) => { // what ONLYOFFICE's own save does: new bytes, new etag
  const { openDocx } = await import("../bundles/workspace/server/ooxml/docx-model.js");
  const d = openDocx(fake.node(path).bytes); fn(d);
  fake.node(path).bytes = Buffer.from(d.pkg.save()); fake.node(path).etag = `"editor-${Math.random()}"`;
};
/** Simulate the live plugin: claim + ack (Task 13 does this through /claim and /ack). */
const liveAck = async (id, inverse = null) => {
  assert.equal(await Q.cas(db, id, "pending", "claimed_live", { lease_until: Date.now() + 60000, lease_owner: "plugin" }), true);
  assert.equal(await Q.cas(db, id, "claimed_live", "applied_live", { inverse_json: inverse ? JSON.stringify(inverse) : null }), true);
};

test("open file → queued (success, who, change_id), nothing written, notification created", async () => {
  put("q1.docx"); fake.openInEditor("S/q1.docx", ["dayane"]);
  const puts = fake.calls.filter((c) => c.method === "PUT").length;
  const r = await call("ws_docs_find_replace", { path: "S/q1.docx", find: "Tortillas", replace: "Totopos" });
  assert.equal(r.success, true); assert.equal(r.data.queued, true); assert.match(r.data.change_id, /^pc_/);
  assert.deepEqual(r.data.open_by, ["Dayane"]); assert.equal(r.data.apply, "live_or_on_close");
  assert.equal(fake.calls.filter((c) => c.method === "PUT").length, puts);
  assert.ok((await notifs()).some((n) => /change waiting for q1\.docx/.test(n.title)));
  assert.equal((await status(r.data.change_id)).state, "pending");
});

let q2b;
test("close-time: nothing while the session lives; after release it applies in seq order with an undo id, label Crow (queued)", async () => {
  put("q2.docx"); const key = fake.openInEditor("S/q2.docx", ["admin"], { releaseAfterMs: 10 ** 9 });
  const a = await call("ws_docs_find_replace", { path: "S/q2.docx", find: "Tortillas", replace: "Totopos" });
  const b = await call("ws_docs_find_replace", { path: "S/q2.docx", find: "Totopos", replace: "Tostadas" });
  await tick();
  assert.equal((await status(a.data.change_id)).state, "pending", "session alive → untouched");
  closeSession("S/q2.docx", key);
  await tick();
  const sa = await status(a.data.change_id), sb = await status(b.data.change_id);
  assert.equal(sa.state, "applied_close"); assert.equal(sb.state, "applied_close"); assert.match(sa.version_id, /^v1\./);
  assert.match(await md("S/q2.docx"), /Tostadas/);
  assert.ok((await notifs()).some((n) => /applied/.test(n.title) && /v1\./.test(n.body)));
  assert.ok(fake.versionsOf("S/q2.docx").some((v) => /^Crow \(queued\): /.test(v.label || "")), "close-time versions are labelled Crow (queued)");
  q2b = b.data.change_id;
});

test("precondition fails at close → failed: target_changed, file untouched, notified", async () => {
  fake.addFile("S/q3.xlsx", readFileSync(join(FIX, "oo-rich.xlsx")), { owner: "admin" });
  const key = fake.openInEditor("S/q3.xlsx", ["admin"], { releaseAfterMs: 10 ** 9 });
  const c = await call("ws_sheets_write", { path: "S/q3.xlsx", range: "Recetas!B2", values: [[9]] });
  const { openXlsx, writeRange } = await import("../bundles/workspace/server/ooxml/xlsx.js");
  const wb = openXlsx(fake.node("S/q3.xlsx").bytes); writeRange(wb, "Recetas!B2", [[5]], "RAW");
  fake.node("S/q3.xlsx").bytes = Buffer.from(wb.pkg.save()); fake.node("S/q3.xlsx").etag = '"human"'; // the person changed B2 meanwhile
  const before = fake.node("S/q3.xlsx").bytes;
  closeSession("S/q3.xlsx", key);
  await tick();
  const s = await status(c.data.change_id);
  assert.equal(s.state, "failed"); assert.equal(s.reason, "target_changed");
  assert.equal(fake.node("S/q3.xlsx").bytes, before, "file untouched");
  assert.ok((await notifs()).some((n) => /q3\.xlsx could not be applied/.test(n.title)));
});

let q4id;
test("exactly once: CAS claims; an expired live lease becomes unknown_after_claim and the postcondition decides", async () => {
  put("q4.docx"); const key = fake.openInEditor("S/q4.docx", ["admin"], { releaseAfterMs: 10 ** 9 });
  const r = await call("ws_docs_find_replace", { path: "S/q4.docx", find: "Tortillas", replace: "Totopos" });
  const id = r.data.change_id; q4id = id;
  assert.equal(await Q.cas(db, id, "pending", "claimed_live", { lease_until: Date.now() - 1, lease_owner: "plugin" }), true);
  assert.equal(await Q.cas(db, id, "pending", "applying_close", {}), false, "second claimer loses");
  // the plugin applied it in the editor, then crashed before ack; the editor saved:
  const { findReplace } = await import("../bundles/workspace/server/ooxml/docx-edit.js");
  await editorSave("S/q4.docx", (d) => findReplace(d, [{ find: "Tortillas", replace: "Totopos" }]));
  closeSession("S/q4.docx", key);
  await tick();
  const s = await status(id);
  assert.equal(s.state, "applied_live"); assert.equal(s.detected, true, "found by postcondition, NOT applied twice");
  assert.equal(((await md("S/q4.docx")).match(/Totopos/g) || []).length, 1);
});

test("unknown_after_claim whose precondition also fails → failed: ambiguous (never applied)", async () => {
  put("q9.docx"); const key = fake.openInEditor("S/q9.docx", ["admin"], { releaseAfterMs: 10 ** 9 });
  const id = (await call("ws_docs_find_replace", { path: "S/q9.docx", find: "Tortillas", replace: "Totopos" })).data.change_id;
  await Q.cas(db, id, "pending", "claimed_live", { lease_until: Date.now() - 1 });
  const { findReplace } = await import("../bundles/workspace/server/ooxml/docx-edit.js");
  await editorSave("S/q9.docx", (d) => findReplace(d, [{ find: "Tortillas", replace: "Harina" }])); // the person rewrote it
  closeSession("S/q9.docx", key);
  await tick();
  const s = await status(id);
  assert.equal(s.state, "failed"); assert.equal(s.reason, "ambiguous");
  assert.doesNotMatch(await md("S/q9.docx"), /Totopos/);
});

test("R-LIVE: a live ack is not proof — an ack missing from the saved file → failed: not_saved (never re-applied); a real one is verified", async () => {
  put("q10.docx"); const key = fake.openInEditor("S/q10.docx", ["admin"], { releaseAfterMs: 10 ** 9 });
  const noop = (await call("ws_docs_find_replace", { path: "S/q10.docx", find: "Tortillas", replace: "Totopos" })).data.change_id;
  await liveAck(noop); // acked "applied", but nothing reached the saved file (view mode, Ctrl-Z, or closed unsaved)
  assert.equal((await status(noop)).verified, false);
  closeSession("S/q10.docx", key);
  const before = fake.node("S/q10.docx").bytes;
  await tick();
  const s = await status(noop);
  assert.equal(s.state, "failed"); assert.equal(s.reason, "not_saved"); // spec §5.7
  assert.equal(fake.node("S/q10.docx").bytes, before, "never applied a second time behind the person's back");
  assert.ok((await notifs()).some((n) => /q10\.docx could not be applied/.test(n.title) && /not in the saved file/.test(n.body)));
  // a real live apply: present in the saved file → verified, nothing written
  put("q10b.docx"); const k2 = fake.openInEditor("S/q10b.docx", ["admin"], { releaseAfterMs: 10 ** 9 });
  const real = (await call("ws_docs_find_replace", { path: "S/q10b.docx", find: "Tortillas", replace: "Totopos" })).data.change_id;
  await liveAck(real);
  const { findReplace } = await import("../bundles/workspace/server/ooxml/docx-edit.js");
  await editorSave("S/q10b.docx", (d) => findReplace(d, [{ find: "Tortillas", replace: "Totopos" }]));
  closeSession("S/q10b.docx", k2);
  const puts = fake.calls.filter((c) => c.method === "PUT").length;
  await tick();
  const s2 = await status(real);
  assert.equal(s2.state, "applied_live"); assert.equal(s2.verified, true);
  assert.equal(fake.calls.filter((c) => c.method === "PUT").length, puts, "verified live change is not written again");
});

test("a person's manual lock: queued, applied only after unlock; force_close refused", async () => {
  fake.addFile("S/q5.docx", readFileSync(join(FIX, "oo-rich.docx")), { lock: { type: 0, owner: "dayane", displayName: "Dayane" } });
  const r = await call("ws_docs_append", { path: "S/q5.docx", markdown: "Nota." });
  assert.equal(r.data.queued, true); assert.equal(r.data.apply, "on_close"); assert.equal(r.data.lock_type, "person");
  assert.equal((await call("ws_docs_append", { path: "S/q5.docx", markdown: "Nota.", if_open: "force_close" })).code, "locked_by_person");
  await tick();
  assert.equal((await status(r.data.change_id)).state, "pending", "a manual lock is never overridden");
  fake.node("S/q5.docx").lock = null;
  await tick();
  assert.equal((await status(r.data.change_id)).state, "applied_close");
  assert.match(await md("S/q5.docx"), /Nota\./);
});

test("a phone viewing the file (spike S9: nc:lock 1, owner type 1, owner NULL) is an EDITOR lock, not a person's lock: queued, applied at close", async () => {
  put("q19.docx"); const key = fake.openInEditor("S/q19.docx", ["dayane"], { releaseAfterMs: 10 ** 9 }); // what the phone's view-only session looks like
  const r = await call("ws_docs_append", { path: "S/q19.docx", markdown: "Desde Crow." });
  assert.equal(r.data.queued, true); assert.equal(r.data.lock_type, "editor"); assert.deepEqual(r.data.open_by, ["Dayane"]);
  assert.doesNotMatch(r.data.message, /locked/, "never described as a person's manual lock");
  await tick();
  assert.equal((await status(r.data.change_id)).state, "pending", "the phone session is still open");
  closeSession("S/q19.docx", key);
  await tick();
  assert.equal((await status(r.data.change_id)).state, "applied_close");
});

test("undo with a pc_ id: if queueing the inverse fails, the change is not left marked as undone", async () => {
  put("q18.docx"); const key = fake.openInEditor("S/q18.docx", ["admin"], { releaseAfterMs: 10 ** 9 });
  const id = (await call("ws_docs_find_replace", { path: "S/q18.docx", find: "Tortillas", replace: "Totopos" })).data.change_id;
  await liveAck(id, [{ tool: "ws_docs_find_replace", args: { find: "Totopos", replace: "Tortillas", expect_count: 1 } }]);
  await db.execute("CREATE TEMP TRIGGER t_q18 BEFORE INSERT ON workspace_pending_changes WHEN NEW.requested_by='undo' AND NEW.path='S/q18.docx' BEGIN SELECT RAISE(ABORT, 'disk full'); END");
  try { assert.equal((await call("ws_undo_last_change", { path: "S/q18.docx", version_id: id })).success, false); }
  finally { await db.execute("DROP TRIGGER t_q18"); }
  assert.equal((await status(id)).undone_by, undefined, "the undo claim was released");
  const u = await call("ws_undo_last_change", { path: "S/q18.docx", version_id: id });
  assert.equal(u.data.queued, true, JSON.stringify(u));
  closeSession("S/q18.docx", key);
});

test("cancel only while pending; non-queueable tools still answer open_in_editor; expiry after 7 days", async () => {
  put("q6.docx"); fake.openInEditor("S/q6.docx", ["admin"], { releaseAfterMs: 10 ** 9 });
  const r = await call("ws_docs_append", { path: "S/q6.docx", markdown: "x" });
  assert.equal((await call("ws_cancel_change", { change_id: r.data.change_id })).data.state, "cancelled");
  assert.equal((await call("ws_cancel_change", { change_id: r.data.change_id })).code, "not_pending");
  assert.equal((await call("ws_drive_rename", { path: "S/q6.docx", new_name: "z.docx" })).code, "open_in_editor");
  const r2 = await call("ws_docs_append", { path: "S/q6.docx", markdown: "y" });
  await Q.expireOld(db, Date.now() + 8 * 86400e3);
  assert.equal((await status(r2.data.change_id)).state, "expired");
  assert.equal((await call("ws_change_status", { change_id: "pc_nosuchchange0" })).code, "not_found");
});

test("spec §5.6 snapshots: the append header row and the replace_section text hash", async () => {
  fake.addFile("S/q11.xlsx", readFileSync(join(FIX, "oo-rich.xlsx")), { owner: "admin" });
  const k1 = fake.openInEditor("S/q11.xlsx", ["admin"], { releaseAfterMs: 10 ** 9 });
  const ap = (await call("ws_sheets_append", { path: "S/q11.xlsx", sheet_name: "Recetas", values: [["Tamales", 3, 9]] })).data.change_id;
  const { openXlsx, writeRange } = await import("../bundles/workspace/server/ooxml/xlsx.js");
  const wb = openXlsx(fake.node("S/q11.xlsx").bytes); writeRange(wb, "Recetas!C1", [["Precio"]], "RAW");
  fake.node("S/q11.xlsx").bytes = Buffer.from(wb.pkg.save()); fake.node("S/q11.xlsx").etag = '"hdr"';
  closeSession("S/q11.xlsx", k1);
  put("q12.docx"); const k2 = fake.openInEditor("S/q12.docx", ["admin"], { releaseAfterMs: 10 ** 9 });
  const rs = (await call("ws_docs_replace_section", { path: "S/q12.docx", heading: "Ingredientes", markdown: "- Maíz" })).data.change_id;
  const { findReplace } = await import("../bundles/workspace/server/ooxml/docx-edit.js");
  await editorSave("S/q12.docx", (d) => findReplace(d, [{ find: "Cebolla", replace: "Cebollín" }])); // the section changed
  closeSession("S/q12.docx", k2);
  await tick();
  assert.equal((await status(ap)).reason, "target_changed");
  assert.equal((await status(rs)).reason, "target_changed");
  // a change that could never apply is refused up front, not queued
  put("q13.docx"); fake.openInEditor("S/q13.docx", ["admin"], { releaseAfterMs: 10 ** 9 });
  assert.equal((await call("ws_docs_insert_at_heading", { path: "S/q13.docx", heading: "No existe", markdown: "x" })).code, "heading_not_found");
});

test("seq order: an earlier non-terminal change blocks later ones; recoverStranded turns applying_close into unknown_after_claim", async () => {
  const mk = (tool) => Q.enqueue(db, { fileId: 990001, path: "S/none.docx", tool, args: {}, precondition: null });
  const r1 = await mk("ws_docs_append"), r2 = await mk("ws_docs_append");
  assert.equal(Number(r2.seq), Number(r1.seq) + 1);
  assert.equal((await Q.nextApplicable(db, 990001)).id, r1.id);
  await Q.cas(db, r1.id, "pending", "claimed_live", { lease_until: Date.now() + 60000 });
  assert.equal(await Q.nextApplicable(db, 990001), null, "a live claim on #1 blocks #2");
  await Q.cas(db, r1.id, "claimed_live", "failed");
  assert.equal((await Q.nextApplicable(db, 990001)).id, r2.id, "a failed earlier change does not block");
  await Q.cas(db, r2.id, "pending", "applying_close");
  assert.deepEqual(await W.recoverStranded(db), [r2.id]);
  assert.equal((await Q.get(db, r2.id)).state, "unknown_after_claim");
  await Q.cas(db, r2.id, "unknown_after_claim", "failed"); // (no such file: keep later ticks quiet)
  for (const s of ["applied_live", "applied_close", "failed", "cancelled", "expired"]) assert.ok(Q.TERMINAL.has(s));
  assert.equal(Q.TERMINAL.size, 5);
});

test("a stale editor lock: changes wait, and its owner is told once how to Unlock", async () => {
  fake.addFile("S/q14.docx", readFileSync(join(FIX, "oo-rich.docx")), { owner: "admin", lock: { type: 1, owner: null } });
  const r = await call("ws_docs_append", { path: "S/q14.docx", markdown: "z" });
  assert.equal(r.data.queued, true);
  const n0 = (await notifs()).length;
  await tick(); await tick();
  const fresh = (await notifs()).slice(n0).filter((n) => /Unlock/.test(n.body));
  assert.equal(fresh.length, 1);
  assert.equal((await status(r.data.change_id)).state, "pending");
});

test("Quick edit rows keep the Quick edit: label at close time", async () => {
  const { queueDescriptor } = await import("../bundles/workspace/server/queue/provider.js");
  const { withFileWrite } = await import("../bundles/workspace/server/write-protocol.js");
  const { openDocx } = await import("../bundles/workspace/server/ooxml/docx-model.js");
  const { appendMarkdown } = await import("../bundles/workspace/server/ooxml/docx-edit.js");
  put("q15.docx"); const key = fake.openInEditor("S/q15.docx", ["admin"], { releaseAfterMs: 10 ** 9 });
  const args = { path: "S/q15.docx", markdown: "Desde el teléfono." };
  const r = await withFileWrite(getConfig(), { path: args.path }, async (b) => { const d = openDocx(b); appendMarkdown(d, args.markdown); return { bytes: d.pkg.save(), changed: 1, summary: "x" }; },
    { label: "Quick edit", queue: queueDescriptor("ws_docs_append", args, { requestedBy: "quick_edit" }) });
  assert.equal(r.queued, true);
  closeSession("S/q15.docx", key);
  await tick();
  assert.equal((await status(r.change_id)).state, "applied_close");
  assert.ok(fake.versionsOf("S/q15.docx").some((v) => /^Quick edit: /.test(v.label || "")));
});

// ---- undo of queued changes (pc_ change ids) --------------------------------------------------------

test("undo with a pc_ id: applied_close → the normal file undo", async () => {
  const u = await call("ws_undo_last_change", { path: "S/q2.docx", version_id: q2b });
  assert.equal(u.success, true, JSON.stringify(u)); assert.match(u.data.version_id, /^v1\./);
  const m = await md("S/q2.docx");
  assert.match(m, /Totopos/); assert.doesNotMatch(m, /Tostadas/);
});

test("undo with a pc_ id: applied_live + exact inverse → the inverse is queued and applied at close; once only", async () => {
  put("q7.docx"); const key = fake.openInEditor("S/q7.docx", ["admin"], { releaseAfterMs: 10 ** 9 });
  const id = (await call("ws_docs_find_replace", { path: "S/q7.docx", find: "Tortillas", replace: "Totopos" })).data.change_id;
  await liveAck(id, [{ tool: "ws_docs_find_replace", args: { find: "Totopos", replace: "Tortillas", expect_count: 1, path: "S/elsewhere.docx" } }]);
  const { findReplace } = await import("../bundles/workspace/server/ooxml/docx-edit.js");
  await editorSave("S/q7.docx", (d) => findReplace(d, [{ find: "Tortillas", replace: "Totopos" }]));
  const u = await call("ws_undo_last_change", { path: "S/q7.docx", version_id: id });
  assert.equal(u.success, true, JSON.stringify(u)); assert.equal(u.data.queued, true); assert.equal(u.data.change_ids.length, 1);
  const inv = await Q.get(db, u.data.change_id);
  assert.equal(inv.requested_by, "undo"); assert.equal(JSON.parse(inv.args_json).path, "S/q7.docx", "the inverse is pinned to the same file");
  assert.equal((await call("ws_undo_last_change", { path: "S/q7.docx", version_id: id })).code, "already_undone");
  closeSession("S/q7.docx", key);
  await tick();
  assert.equal((await status(id)).verified, true);
  const s = await status(u.data.change_id);
  assert.equal(s.state, "applied_close", JSON.stringify(s));
  const m = await md("S/q7.docx");
  assert.match(m, /Tortillas/); assert.doesNotMatch(m, /Totopos/);
  assert.ok(fake.versionsOf("S/q7.docx").some((v) => /^Undo \(queued\): /.test(v.label || "")));
});

test("undo with a pc_ id: the text changed since → the inverse fails changed_since, file untouched", async () => {
  put("q8.docx"); const key = fake.openInEditor("S/q8.docx", ["admin"], { releaseAfterMs: 10 ** 9 });
  const id = (await call("ws_docs_find_replace", { path: "S/q8.docx", find: "Tortillas", replace: "Totopos" })).data.change_id;
  await liveAck(id, [{ tool: "ws_docs_find_replace", args: { find: "Totopos", replace: "Tortillas", expect_count: 1 } }]);
  const { findReplace } = await import("../bundles/workspace/server/ooxml/docx-edit.js");
  await editorSave("S/q8.docx", (d) => findReplace(d, [{ find: "Tortillas", replace: "Totopos" }]));
  const u = await call("ws_undo_last_change", { path: "S/q8.docx", version_id: id });
  await editorSave("S/q8.docx", (d) => findReplace(d, [{ find: "Totopos", replace: "Tostadas" }])); // the person typed on
  closeSession("S/q8.docx", key);
  await tick();
  const s = await status(u.data.change_id);
  assert.equal(s.state, "failed"); assert.equal(s.reason, "changed_since");
  assert.match(await md("S/q8.docx"), /Tostadas/);
});

test("undo with a pc_ id: no exact inverse (off-list tool, or detected) → undo_via_versions; not applied → not_applied", async () => {
  put("q16.docx"); const key = fake.openInEditor("S/q16.docx", ["admin"], { releaseAfterMs: 10 ** 9 });
  const id = (await call("ws_docs_find_replace", { path: "S/q16.docx", find: "Tortillas", replace: "Totopos" })).data.change_id;
  const pending = (await call("ws_docs_append", { path: "S/q16.docx", markdown: "Más." })).data.change_id;
  assert.equal((await call("ws_undo_last_change", { path: "S/q16.docx", version_id: pending })).code, "not_applied");
  await liveAck(id, [{ tool: "ws_drive_trash_file", args: {} }]); // never accepted as an inverse
  const v = await call("ws_undo_last_change", { path: "S/q16.docx", version_id: id });
  assert.equal(v.code, "undo_via_versions"); assert.equal(v.data.versions_tool, "ws_drive_list_versions");
  assert.match(String(v.data.before_version_id), /^\d+$/, "names the saved version from before the change");
  const d = await call("ws_undo_last_change", { path: "S/q4.docx", version_id: q4id }); // found by postcondition
  assert.equal(d.code, "undo_via_versions");
  assert.equal((await call("ws_undo_last_change", { path: "S/q1.docx", version_id: id })).code, "bad_version_id", "a change_id belongs to its own file");
  closeSession("S/q16.docx", key);
});

test("pinInverse: one allowed tool per live tool, same file, all-or-nothing", () => {
  const row = { tool: "ws_sheets_append", path: "S/a.xlsx" };
  assert.deepEqual(C.pinInverse(row, [{ tool: "ws__sheets_clear_rows_exact", args: { sheet: "T", from_row: 3, values: [[1]], path: "S/other.xlsx", file_id: 9 } }]),
    [{ tool: "ws__sheets_clear_rows_exact", args: { sheet: "T", from_row: 3, values: [[1]], path: "S/a.xlsx" } }]);
  assert.equal(C.pinInverse(row, [{ tool: "ws__sheets_clear_rows_exact", args: {} }, { tool: "ws_sheets_write", args: {} }]), null);
  assert.equal(C.pinInverse({ tool: "ws_docs_replace_section", path: "x" }, [{ tool: "ws_docs_replace_section", args: {} }]), null, "no inverse for close-time-only ops");
});

test("LIVE_OPS follow R-LIVE (no comment/format ops); internal ws__ ops are in ALL_DEFS but never MCP tools", async () => {
  assert.equal(C.LIVE_OPS.has("ws_docs_add_comment"), false); assert.equal(C.LIVE_OPS.has("ws_docs_format_text"), false);
  assert.equal(C.isLiveOp("ws_slides_find_replace", { scope: "notes" }), false);
  assert.equal(C.liveEligible("ws_docs_find_replace", { pairs: [{ find: "a", replace: "b" }, { find: "c", replace: "d" }] }, {}), false, "an undecidable postcondition is never offered live");
  const { ALL_DEFS } = await import("../bundles/workspace/server/tools/all.js");
  for (const n of C.INTERNAL_OPS) assert.ok(ALL_DEFS.has(n), n);
  assert.ok(ALL_DEFS.has("ws_undo_last_change"));
  const names = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(names.includes("ws_change_status") && names.includes("ws_cancel_change"));
  assert.equal(names.filter((n) => n.startsWith("ws__")).length, 0);
});

// ---- internal exact-inverse ops: apply op → apply inverse → the part XML equals the original ---------

const xmlOf = async (pkgOwner, part) => (await import("../bundles/workspace/server/ooxml/xml.js")).serializeXml(pkgOwner.pkg.xml(part));

test("internal ws__ defs (as the close-time applier runs them): each reverses its tool on a real file; args are schema-checked", async () => {
  const { ALL_DEFS } = await import("../bundles/workspace/server/tools/all.js");
  const { systemClock } = await import("../bundles/workspace/server/write-protocol.js");
  const { openDocx } = await import("../bundles/workspace/server/ooxml/docx-model.js");
  const X = await import("../bundles/workspace/server/ooxml/xlsx.js");
  const ctx = { getConfig, clock: systemClock };
  const inv = (name, args) => ALL_DEFS.get(name).run(Object.defineProperties({ ...args, if_open: "wait" }, { __tool: { value: null } }), ctx);
  const docXml = async (p, part = "word/document.xml") => xmlOf(openDocx(fake.node(p).bytes), part);
  const sheetXml = async (p) => { const wb = X.openXlsx(fake.node(p).bytes); return xmlOf(wb, wb.sheets[0].part); };
  for (const n of C.INTERNAL_OPS) {
    assert.equal(typeof ALL_DEFS.get(n).schema, "object", `${n} declares a schema (Task 13 re-validates plugin inverses with it)`);
    await assert.rejects(inv(n, { path: "S/none.docx", bogus: 1 }), { code: "bad_args" }, `${n} rejects unknown/missing args`);
  }
  // append → ws__docs_remove_paragraphs_exact
  put("i1.docx"); const d0 = await docXml("S/i1.docx");
  assert.equal((await call("ws_docs_append", { path: "S/i1.docx", markdown: "Nota final." })).success, true);
  assert.equal((await inv("ws__docs_remove_paragraphs_exact", { path: "S/i1.docx", texts: ["Nota final."], at_end: true })).changed, 1);
  assert.equal(await docXml("S/i1.docx"), d0);
  // add_comment → ws__docs_delete_comment
  put("i2.docx"); const parts = ["word/document.xml", "word/comments.xml"]; const c0 = await Promise.all(parts.map((p) => docXml("S/i2.docx", p)));
  const cid = (await call("ws_docs_add_comment", { path: "S/i2.docx", content: "Revisar", quoted_text: "Cilantro" })).data.comment_id;
  await inv("ws__docs_delete_comment", { path: "S/i2.docx", comment_id: cid, content: "Revisar" });
  assert.deepEqual(await Promise.all(parts.map((p) => docXml("S/i2.docx", p))), c0);
  // sheets_append → ws__sheets_clear_rows_exact
  fake.addFile("S/i3.xlsx", readFileSync(join(FIX, "oo-rich.xlsx")), { owner: "admin" }); const s0 = await sheetXml("S/i3.xlsx");
  const dim = X.dimensionOf(X.openXlsx(fake.node("S/i3.xlsx").bytes), "Recetas");
  const ap = (await call("ws_sheets_append", { path: "S/i3.xlsx", sheet_name: "Recetas", values: [["Tamales", 3, 9]] })).data;
  const from = Number(/A(\d+)/.exec(ap.range)[1]);
  await inv("ws__sheets_clear_rows_exact", { path: "S/i3.xlsx", sheet: "Recetas", from_row: from, values: [["Tamales", 3, 9]], dimension: dim });
  assert.equal(await sheetXml("S/i3.xlsx"), s0);
  // set_number_format → ws__sheets_restore_styles
  fake.addFile("S/i4.xlsx", readFileSync(join(FIX, "oo-rich.xlsx")), { owner: "admin" }); const f0 = await sheetXml("S/i4.xlsx");
  const w4 = X.openXlsx(fake.node("S/i4.xlsx").bytes); const sAttrs = X.styleAttrs(w4, "Recetas!B2:C3"); const dim4 = X.dimensionOf(w4, "Recetas");
  await call("ws_sheets_set_number_format", { path: "S/i4.xlsx", range: "Recetas!B2:C3", pattern: "0.0" });
  await inv("ws__sheets_restore_styles", { path: "S/i4.xlsx", range: "Recetas!B2:C3", s_attrs: sAttrs, pattern: "0.0", dimension: dim4 });
  assert.equal(await sheetXml("S/i4.xlsx"), f0);
});

test("undo with a pc_ id: a live append is reversed by ws__docs_remove_paragraphs_exact at close", async () => {
  put("q17.docx"); const key = fake.openInEditor("S/q17.docx", ["admin"], { releaseAfterMs: 10 ** 9 });
  const id = (await call("ws_docs_append", { path: "S/q17.docx", markdown: "Comprar aguacates." })).data.change_id;
  await liveAck(id, [{ tool: "ws__docs_remove_paragraphs_exact", args: { texts: ["Comprar aguacates."], at_end: true } }]);
  const { appendMarkdown } = await import("../bundles/workspace/server/ooxml/docx-edit.js");
  await editorSave("S/q17.docx", (d) => appendMarkdown(d, "Comprar aguacates."));
  const u = await call("ws_undo_last_change", { path: "S/q17.docx", version_id: id });
  assert.equal(u.data.queued, true, JSON.stringify(u));
  closeSession("S/q17.docx", key);
  await tick();
  assert.equal((await status(u.data.change_id)).state, "applied_close");
  assert.doesNotMatch(await md("S/q17.docx"), /aguacates/);
});

test("ws__docs_remove_paragraphs_exact: append / insert_at_heading reversed exactly; ambiguous or changed → target_changed", async () => {
  const { openDocx } = await import("../bundles/workspace/server/ooxml/docx-model.js");
  const E = await import("../bundles/workspace/server/ooxml/docx-edit.js");
  const bytes = readFileSync(join(FIX, "oo-rich.docx"));
  const d0 = openDocx(bytes); const want = await xmlOf(d0, d0.part);
  const d = openDocx(bytes);
  E.appendMarkdown(d, "Nota final.\n\nOtra línea.");
  E.insertAtHeading(d, "Pasos", "Lavar las manos.");
  assert.equal(E.removeParagraphsExact(d, ["Nota final.", "Otra línea."], { atEnd: true }), 2);
  assert.equal(E.removeParagraphsExact(d, ["Lavar las manos."], { afterHeading: "Pasos" }), 1);
  assert.equal(await xmlOf(d, d.part), want);
  E.appendMarkdown(d, "Dos.\n\nDos.");
  assert.throws(() => E.removeParagraphsExact(d, ["Dos."]), { code: "target_changed" });
  assert.throws(() => E.removeParagraphsExact(d, ["Tres."], { atEnd: true }), { code: "target_changed" });
});

test("ws__docs_delete_comment: add_comment reversed exactly (body, comments, threading parts); a replied thread is refused", async () => {
  const { openDocx } = await import("../bundles/workspace/server/ooxml/docx-model.js");
  const K = await import("../bundles/workspace/server/ooxml/docx-comments.js");
  const bytes = readFileSync(join(FIX, "oo-rich.docx"));
  const d0 = openDocx(bytes);
  const parts = ["word/document.xml", "word/comments.xml", "word/commentsExtended.xml", "word/commentsIds.xml"];
  const want = await Promise.all(parts.map((p) => xmlOf(d0, p)));
  const d = openDocx(bytes);
  const { comment_id } = K.addComment(d, "Revisar esto", undefined);
  assert.throws(() => K.deleteComment(d, comment_id, { content: "otra cosa" }), { code: "target_changed" });
  K.deleteComment(d, comment_id, { content: "Revisar esto" });
  assert.deepEqual(await Promise.all(parts.map((p) => xmlOf(d, p))), want);
  const nfd = "Sin jalapeño"; // typed decomposed (a Mac/iPhone): matched as equal to its NFC form
  const c1 = K.addComment(d, nfd, undefined).comment_id;
  K.deleteComment(d, c1, { content: nfd });
  assert.deepEqual(await Promise.all(parts.map((p) => xmlOf(d, p))), want);
  const c2 = K.addComment(d, "Pregunta", "Cilantro").comment_id; K.replyComment(d, c2, "Respuesta de Dayane");
  assert.throws(() => K.deleteComment(d, c2), { code: "target_changed" });
});

test("ws__sheets_clear_rows_exact: append reversed exactly; other values or rows below → target_changed", async () => {
  const X = await import("../bundles/workspace/server/ooxml/xlsx.js");
  const bytes = readFileSync(join(FIX, "oo-rich.xlsx"));
  const w0 = X.openXlsx(bytes); const part = w0.sheets[0].part; const want = await xmlOf(w0, part);
  const wb = X.openXlsx(bytes); const dim = X.dimensionOf(wb, "Recetas"); // "" — this fixture has no <dimension>
  const r = X.appendRows(wb, "Recetas", [["Tamales", 3, 9], ["Sopes", 2, "=B8*C8"]]);
  const from = X.lastDataRow(wb, "Recetas") - 1;
  assert.match(r.range, new RegExp(`A${from}:`));
  assert.throws(() => X.clearRowsExact(wb, "Recetas", from, [["Tamales", 3, 10], ["Sopes", 2, "=B8*C8"]]), { code: "target_changed" });
  X.clearRowsExact(wb, "Recetas", from, [["Tamales", 3, 9], ["Sopes", 2, "=B8*C8"]], { dimension: dim });
  assert.equal(await xmlOf(wb, part), want);
  X.appendRows(wb, "Recetas", [["A", 1]]); X.appendRows(wb, "Recetas", [["B", 2]]);
  assert.throws(() => X.clearRowsExact(wb, "Recetas", from, [["A", 1]]), { code: "target_changed" }, "rows below → refused");
});

test("ws__sheets_restore_styles: set_number_format reversed exactly; a format changed since → target_changed", async () => {
  const X = await import("../bundles/workspace/server/ooxml/xlsx.js");
  const bytes = readFileSync(join(FIX, "oo-rich.xlsx"));
  const w0 = X.openXlsx(bytes); const part = w0.sheets[0].part; const want = await xmlOf(w0, part);
  const wb = X.openXlsx(bytes);
  const range = "Recetas!B2:C5"; // includes the empty row 5
  const before = X.styleAttrs(wb, range);
  X.setNumberFormat(wb, range, "0.0");
  assert.throws(() => X.restoreStyles(wb, range, before, { pattern: "0.000" }), { code: "target_changed" });
  X.restoreStyles(wb, range, before, { pattern: "0.0", dimension: X.dimensionOf(w0, "Recetas") });
  assert.equal(await xmlOf(wb, part), want);
  assert.throws(() => X.restoreStyles(wb, range, [["1"]]), { code: "bad_args" });
});
