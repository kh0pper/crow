import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startFakeNextcloud } from "./helpers/workspace-fake-nextcloud.js";
import { connectWorkspace } from "./helpers/workspace-client.js";

let fake, call, close;
before(async () => {
  fake = await startFakeNextcloud({ secret: "jwt" });
  fake.addFolder("Shared with Crow/Casa Nueva", { owner: "admin" });
  fake.addFile("Shared with Crow/Casa Nueva/Menú.xlsx", Buffer.from("PK"), { owner: "admin" });
  fake.addFile("Shared with Crow/Casa Nueva/notes.md", Buffer.from("# hi"), { owner: "admin", lock: { type: 1, owner: "onlyoffice", displayName: "ONLYOFFICE" } });
  ({ call, close } = await connectWorkspace(fake));
});
after(async () => { await close(); fake.close(); });

test("ws_drive_list_folder lists children with lock state", async () => {
  const r = await call("ws_drive_list_folder", { path: "Shared with Crow/Casa Nueva" });
  assert.equal(r.success, true);
  const names = r.data.items.map((i) => i.name).sort();
  assert.deepEqual(names, ["Menú.xlsx", "notes.md"]);
  assert.equal(r.data.items.find((i) => i.name === "notes.md").locked, true);
  assert.match(r.data.items[0].web_url, /^https:\/\/crow\.test:8456\/f\/\d+$/);
});

test("ws_drive_search escapes LIKE wildcards and XML", async () => {
  const r = await call("ws_drive_search", { query: "Men<ú>%" });
  assert.equal(r.success, true);
  assert.match(fake.lastSearchBody(), /Men&lt;ú&gt;\\%/);
});

test("ws_drive_find_folder finds by exact name", async () => {
  const r = await call("ws_drive_find_folder", { name: "Casa Nueva" });
  assert.equal(r.data.found, true);
  assert.equal(r.data.path, "Shared with Crow/Casa Nueva");
});

test("ws_drive_get_metadata and get_permissions", async () => {
  const m = await call("ws_drive_get_metadata", { path: "Shared with Crow/Casa Nueva/notes.md" });
  assert.equal(m.data.owner.id, "admin");
  assert.equal(m.data.lock.type, "editor");
  const p = await call("ws_drive_get_permissions", { path: "Shared with Crow/Casa Nueva/notes.md" });
  assert.equal(p.data.crow_bot.can_write, true);
  assert.match(p.data.note, /cannot see other people's shares/);
});

test("bad paths fail without a request", async () => {
  const before = fake.calls.length;
  const r = await call("ws_drive_list_folder", { path: "../etc" });
  assert.equal(r.code, "bad_path");
  assert.equal(fake.calls.length, before);
});

test("an ONLYOFFICE editor lock has a NULL lock-owner and still reads as an editor lock", async () => {
  fake.addFile("Shared with Crow/Casa Nueva/open.docx", Buffer.from("PK"), { owner: "admin" });
  fake.openInEditor("Shared with Crow/Casa Nueva/open.docx", ["admin"]);
  const m = await call("ws_drive_get_metadata", { path: "Shared with Crow/Casa Nueva/open.docx" });
  assert.equal(m.data.lock.type, "editor");
  assert.equal(m.data.locked, true);
});

test("fake: extraRoutes run before the built-in branches; principal carries calendar-user-address-set", async () => {
  const url = `${fake.ncUrl}/remote.php/dav/principals/users/crow-bot/`;
  const hdr = { Authorization: `Basic ${Buffer.from("crow-bot:pw").toString("base64")}`, Depth: "0" };
  const body = await (await fetch(url, { method: "PROPFIND", headers: hdr })).text();
  assert.match(body, /calendar-user-address-set[\s\S]*mailto:crow-bot@/);
  fake.extraRoutes = async (req, res) => { if (req.url.includes("/principals/")) { res.writeHead(200); res.end("override"); return true; } return false; };
  assert.equal(await (await fetch(url, { method: "PROPFIND", headers: hdr })).text(), "override");
  fake.extraRoutes = null;
});

test("listing the drive root requests exactly .../files/crow-bot/ (no double slash)", async () => {
  const n = fake.calls.length;
  const r = await call("ws_drive_list_folder", {});
  assert.equal(r.success, true);
  const pf = fake.calls.slice(n).find((c) => c.method === "PROPFIND");
  assert.equal(pf.url, "/remote.php/dav/files/crow-bot/");
});

test("get_permissions: an OCS failure yields shares_by_crow_bot null plus a note, not a silent empty list", async () => {
  fake.extraRoutes = async (req, res) => { if (req.url.startsWith("/ocs/v2.php/apps/files_sharing")) { res.writeHead(500); res.end("x"); return true; } return false; };
  try {
    const p = await call("ws_drive_get_permissions", { path: "Shared with Crow/Casa Nueva/notes.md" });
    assert.equal(p.success, true);
    assert.equal(p.data.shares_by_crow_bot, null);
    assert.match(p.data.note, /could not be read/);
  } finally { fake.extraRoutes = null; }
});
