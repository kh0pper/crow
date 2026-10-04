import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startFakeNextcloud } from "./helpers/workspace-fake-nextcloud.js";
import { connectWorkspace } from "./helpers/workspace-client.js";

let fake, call, close;
before(async () => {
  fake = await startFakeNextcloud({ secret: "jwt" });
  fake.addFolder("S", { owner: "admin" });
  fake.addFile("S/r.docx", Buffer.from("PK"), { owner: "admin" });
  fake.addFile("S/n.txt", Buffer.from("one"), { owner: "admin" });
  ({ call, close } = await connectWorkspace(fake));
});
after(async () => { await close(); fake.close(); });

test("create_folder is idempotent", async () => {
  assert.equal((await call("ws_drive_create_folder", { name: "Recetas", parent: "S" })).data.created, true);
  assert.equal((await call("ws_drive_create_folder", { name: "Recetas", parent: "S" })).data.created, false);
});

test("upload_file never overwrites; base64 and text; 10 MB cap", async () => {
  const a = await call("ws_drive_upload_file", { folder: "S", name: "a.txt", text: "hola" });
  assert.equal(a.success, true); assert.ok(a.data.version_id);
  assert.equal((await call("ws_drive_upload_file", { folder: "S", name: "a.txt", text: "x" })).code, "exists");
  assert.equal((await call("ws_drive_upload_file", { folder: "S", name: "b.bin", base64: "!!notb64" })).code, "bad_content");
  assert.equal((await call("ws_drive_upload_file", { folder: "S", name: "c.txt", text: "a", base64: "YQ==" })).code, "bad_content");
});

test("upload_new_version refuses office files (no full-document replace)", async () => {
  const r = await call("ws_drive_upload_new_version", { path: "S/r.docx", text: "x" });
  assert.equal(r.code, "full_replace_refused"); assert.match(r.error, /ws_docs_find_replace/);
  const ok = await call("ws_drive_upload_new_version", { path: "S/n.txt", text: "two" });
  assert.equal(ok.success, true);
  assert.equal(fake.node("S/n.txt").bytes.toString(), "two");
});

test("copy de-duplicates names; rename and move", async () => {
  const c1 = await call("ws_drive_copy_file", { path: "S/n.txt" });
  assert.equal(c1.data.path, "S/n (2).txt");
  assert.equal((await call("ws_drive_rename", { path: "S/n (2).txt", new_name: "m.txt" })).data.name, "m.txt");
  assert.equal((await call("ws_drive_move_file", { path: "S/m.txt", new_parent: "S/Recetas" })).data.moved, true);
  assert.equal((await call("ws_drive_rename", { path: "S/Recetas/m.txt", new_name: "../x" })).code, "bad_path");
});

test("export converts via the connector into the drive, never overwriting", async () => {
  const r = await call("ws_drive_export", { path: "S/r.docx", format: "pdf" });
  assert.equal(r.data.path, "S/r.pdf");
  const r2 = await call("ws_drive_export", { path: "S/r.docx", format: "pdf" });
  assert.equal(r2.data.path, "S/r (2).pdf");
  assert.equal((await call("ws_drive_export", { path: "S/r.docx", format: "xlsx" })).code, "bad_format");
});

test("share: user shares only, permissions by role", async () => {
  const r = await call("ws_drive_share", { path: "S/r.docx", user: "alex", role: "writer" });
  assert.equal(r.success, true);
  assert.deepEqual(fake.state.shares.at(-1), { id: "1", path: "/S/r.docx", share_with: "alex", share_type: 0, permissions: 3 });
  assert.equal((await call("ws_drive_share", { path: "S/r.docx", user: "bad user/../", role: "reader" })).code, "bad_user");
});

test("versions: list, restore (undoable), undo via ws_undo_last_change", async () => {
  const w = await call("ws_drive_upload_new_version", { path: "S/n.txt", text: "three" });
  const list = await call("ws_drive_list_versions", { path: "S/n.txt" });
  assert.ok(list.data.versions.length >= 3);
  const u = await call("ws_undo_last_change", { path: "S/n.txt", version_id: w.data.version_id });
  assert.equal(u.success, true);
  assert.equal(fake.node("S/n.txt").bytes.toString(), "two");
  const oldest = list.data.versions.at(-1).version_id;
  const rs = await call("ws_drive_restore_version", { path: "S/n.txt", version_id: oldest });
  assert.equal(fake.node("S/n.txt").bytes.toString(), "one"); assert.ok(rs.data.version_id);
});

test("after an undo, list_versions flags the restored row as current and still lists the undone content (B1)", async () => {
  fake.addFile("S/b1.txt", Buffer.from("x1"));
  const w = await call("ws_drive_upload_new_version", { path: "S/b1.txt", text: "x2" });
  await call("ws_undo_last_change", { path: "S/b1.txt", version_id: w.data.version_id });
  const l = (await call("ws_drive_list_versions", { path: "S/b1.txt" })).data.versions;
  const cur = l.filter((v) => v.current);
  assert.equal(cur.length, 1); assert.notEqual(cur[0].version_id, l[0].version_id, "current is not the newest id after an undo");
  assert.ok(l.some((v) => !v.current && fake.versionsOf("S/b1.txt").find((x) => String(x.id) === v.version_id).bytes.toString() === "x2"));
});

test("move/rename/trash of an open file (or a folder with an open child) explain who has it open (re-review minor)", async () => {
  fake.addFile("S/mv.docx", Buffer.from("PK")); fake.openInEditor("S/mv.docx", ["alex"]);
  assert.equal((await call("ws_drive_rename", { path: "S/mv.docx", new_name: "x.docx" })).code, "open_in_editor");
  fake.addFolder("S/dir"); fake.addFile("S/dir/in.docx", Buffer.from("PK")); fake.openInEditor("S/dir/in.docx", ["alex"]);
  const t = await call("ws_drive_trash_file", { path: "S/dir", wait_s: 0 });
  assert.equal(t.code, "locked_inside"); assert.match(t.error, /open/);
});

test("trash refuses an open file and names who has it", async () => {
  fake.addFile("S/open.docx", Buffer.from("PK"));
  fake.openInEditor("S/open.docx", ["alex"]);
  const r = await call("ws_drive_trash_file", { path: "S/open.docx", wait_s: 0 });
  assert.equal(r.code, "open_in_editor"); assert.deepEqual(r.data.open_by, ["Alex"]);
});

test("no tool RESULT or ERROR ever contains the app password or JWT secret (spec §10.1)", async () => {
  const outs = [];
  outs.push(await call("ws_drive_list_folder", { path: "S" }));
  outs.push(await call("ws_drive_get_metadata", { path: "S/does-not-exist" }));
  fake.state.failNextWith = { status: 500, body: "boom pw-secret-123 jwt" };
  outs.push(await call("ws_drive_list_folder", { path: "S" }));
  for (const o of outs) assert.doesNotMatch(JSON.stringify(o), /pw-secret-123|"jwt"|Bearer|Basic /);
  for (const c of fake.calls) assert.doesNotMatch(c.url, /pw-secret-123/);
});

test("move/rename/trash results carry file_id (spec §4.1)", async () => {
  const f = fake.addFile("S/fid.txt", Buffer.from("x"));
  fake.addFolder("S/fdir");
  const rn = await call("ws_drive_rename", { path: "S/fid.txt", new_name: "fid2.txt" });
  assert.equal(rn.data.file_id, f.fileId);
  const mv = await call("ws_drive_move_file", { path: "S/fid2.txt", new_parent: "S/fdir" });
  assert.equal(mv.data.file_id, f.fileId); assert.equal(mv.data.path, "S/fdir/fid2.txt");
  const tr = await call("ws_drive_trash_file", { path: "S/fdir/fid2.txt" });
  assert.equal(tr.data.trashed, true); assert.equal(tr.data.file_id, f.fileId);
  assert.equal(fake.node("S/fdir/fid2.txt"), undefined);
});

test("trash refuses the top of a share (share_root) and deletes nothing", async () => {
  fake.addFolder("Shared/Alex docs", { owner: "alex" });
  fake.addFile("Shared/Alex docs/in.txt", Buffer.from("x"), { owner: "alex" });
  const r = await call("ws_drive_trash_file", { path: "Shared/Alex docs" });
  assert.equal(r.code, "share_root"); assert.match(r.error, /only remove Crow's access/);
  assert.ok(fake.node("Shared/Alex docs")); assert.ok(fake.node("Shared/Alex docs/in.txt"));
});

test("an upstream 500 echoing the secrets (plain, Basic base64, URL-encoded) never reaches a result", async () => {
  const basic = Buffer.from("crow-bot:pw-secret-123").toString("base64");
  fake.state.failNextWith = { status: 500, body: `boom pw-secret-123 ${basic} ${encodeURIComponent("pw-secret-123")} jwt` };
  const o = await call("ws_drive_upload_new_version", { path: "S/n.txt", text: "x" });
  assert.equal(o.success, false);
  assert.doesNotMatch(JSON.stringify(o), new RegExp(`pw-secret-123|${basic.replace(/[+/=]/g, "\\$&")}|Bearer|Basic `));
});

test("S2: upload_file mime sets the PUT Content-Type; a malformed mime is refused", async () => {
  const r = await call("ws_drive_upload_file", { folder: "S", name: "m.csv", text: "a,b", mime: "text/csv" });
  assert.equal(r.success, true);
  const put = fake.calls.filter((c) => c.method === "PUT" && c.url.endsWith("/S/m.csv")).at(-1);
  assert.equal(put.headers["content-type"], "text/csv");
  const d = await call("ws_drive_upload_file", { folder: "S", name: "d.bin", text: "x" });
  assert.equal(d.success, true);
  assert.equal(fake.calls.filter((c) => c.method === "PUT" && c.url.endsWith("/S/d.bin")).at(-1).headers["content-type"], "application/octet-stream");
  assert.equal((await call("ws_drive_upload_file", { folder: "S", name: "e.txt", text: "x", mime: "text/plain\r\nX-Evil: 1" })).code, "bad_mime");
});
