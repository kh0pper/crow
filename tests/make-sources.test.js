import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { initArtifactsTables } from "../bundles/artifacts/server/init-tables.js";
import { SHELL_ITEMS_DDL } from "../scripts/migrations/0010-shell-items.mjs";
import { setItemProject } from "../servers/shared/shell-items.js";
import {
  installedBundle, artifactType, filterOf, justMadeArtifact, listArtifactItems, listMakeItems, listWorkspaceItems,
} from "../servers/gateway/make/sources.js";

const s = {};
before(async () => {
  s.dir = mkdtempSync(join(tmpdir(), "make-sources-"));
  s.db = createDbClient(join(s.dir, "crow.db"));
  await s.db.executeMultiple(`
    CREATE TABLE project_spaces (id INTEGER PRIMARY KEY, slug TEXT, name TEXT, type TEXT NOT NULL DEFAULT 'general',
      status TEXT NOT NULL DEFAULT 'active', archived_at TEXT);
    INSERT INTO project_spaces (id, slug, name) VALUES (2,'p2','P2'),(3,'p3','P3');
    ${SHELL_ITEMS_DDL}`);
  await initArtifactsTables(s.db);
  s.home = join(s.dir, "home");
  mkdirSync(s.home, { recursive: true });
});
after(() => { try { s.db.close(); } catch {} rmSync(s.dir, { recursive: true, force: true }); });

const addArtifact = async (id, { type = "document", session = null, received = 0, contact = null, bot = "bobby", madeBy = "bot", ver = 1, created = "2026-10-26 10:00:00" } = {}) => {
  await s.db.execute({ sql: "INSERT INTO artifacts (id,title,type,created_by_bot,origin_session,received,origin_contact,current_version,updated_at) VALUES (?,?,?,?,?,?,?,?,?)", args: [id, `T ${id}`, type, bot, session, received, contact, ver, created] });
  await s.db.execute({ sql: "INSERT INTO artifact_versions (artifact_id,n,state,files_json,size,content_hash,made_by,created_at) VALUES (?,?,'current','[]',1,'h',?,?)", args: [id, ver, madeBy, created] });
};
const install = (home, ids, dirs = ids) => {
  writeFileSync(join(home, "installed.json"), JSON.stringify(ids.map((id) => ({ id }))));
  for (const d of dirs) { mkdirSync(join(home, "bundles", d), { recursive: true }); writeFileSync(join(home, "bundles", d, "manifest.json"), "{}"); }
};

test("installedBundle needs both the listing and the files", () => {
  const h = join(s.dir, "ib");
  mkdirSync(h, { recursive: true });
  assert.equal(installedBundle(h, "artifacts"), false);
  writeFileSync(join(h, "installed.json"), JSON.stringify([{ id: "artifacts" }]));
  assert.equal(installedBundle(h, "artifacts"), false, "listed but no manifest");
  mkdirSync(join(h, "bundles", "artifacts"), { recursive: true });
  writeFileSync(join(h, "bundles", "artifacts", "manifest.json"), "{}");
  assert.equal(installedBundle(h, "artifacts"), true);
  assert.equal(installedBundle(h, "workspace"), false);
  writeFileSync(join(h, "installed.json"), "not json");
  assert.equal(installedBundle(h, "artifacts"), false, "never throws");
  assert.equal(installedBundle(null, "artifacts"), false);
});

test("artifactType and filterOf map every DB type", () => {
  const want = { page: "page", document: "document", diagram: "diagram", data: "page", slides: "deck", pdf: "document", image: "page", docx: "document", map: "page" };
  for (const [t, ty] of Object.entries(want)) {
    assert.equal(artifactType({ type: t }), ty, t);
    assert.ok(["documents", "pages"].includes(filterOf(ty)), t);
  }
  assert.equal(filterOf("document"), "documents");
  assert.equal(filterOf("spreadsheet"), "documents");
  assert.equal(filterOf("deck"), "documents");
  assert.equal(filterOf("diagram"), "pages");
  assert.equal(artifactType({ type: "weird" }), "other");
});

test("justMade is real state", () => {
  const now = Date.parse("2026-10-27T12:00:00Z");
  const base = { madeBy: "bot", versionN: 3, versionCreatedAt: "2026-10-26 12:00:00", seenVersion: 2 };
  assert.equal(justMadeArtifact(base, now), true);
  assert.equal(justMadeArtifact({ ...base, seenVersion: 3 }, now), false);
  assert.equal(justMadeArtifact({ ...base, seenVersion: null }, now), true);
  assert.equal(justMadeArtifact({ ...base, madeBy: "user" }, now), false);
  assert.equal(justMadeArtifact({ ...base, versionCreatedAt: "2026-10-19 11:00:00" }, now), false);
});

test("an artifact made in a filed chat lands in that chat's project", async () => {
  await setItemProject(s.db, "perch_thread", "perchlive-a", 2, { setBy: "operator" });
  await addArtifact("art_filed01", { session: "perchlive-a" });
  const inP2 = await listArtifactItems(s.db, { projectId: 2 });
  assert.ok(inP2.some((i) => i.ref === "art_filed01"));
  const row = (await s.db.execute("SELECT project_id, set_by FROM shell_items WHERE item_kind='artifact' AND item_ref='art_filed01'")).rows[0];
  assert.equal(Number(row.project_id), 2);
  assert.equal(row.set_by, "origin");
  const it = inP2.find((i) => i.ref === "art_filed01");
  assert.equal(it.projectId, 2);
  assert.equal(it.openUrl, "/dashboard/make/open/artifact/art_filed01");
  assert.equal(it.kind, "artifact");
  assert.equal(it.shared, false);
  assert.ok(!(await listArtifactItems(s.db, { projectId: 3 })).some((i) => i.ref === "art_filed01"));
  assert.ok((await listArtifactItems(s.db, { unassigned: true })).every((i) => i.ref !== "art_filed01"));
});

test("an operator's move wins over the chat's project", async () => {
  await addArtifact("art_moved01", { session: "perchlive-a" });
  await setItemProject(s.db, "artifact", "art_moved01", 3, { setBy: "operator" });
  const inP3 = await listArtifactItems(s.db, { projectId: 3 });
  assert.ok(inP3.some((i) => i.ref === "art_moved01"));
  assert.ok(!(await listArtifactItems(s.db, { projectId: 2 })).some((i) => i.ref === "art_moved01"));
});

test("an unfiled artifact is unassigned and listed once under all", async () => {
  await addArtifact("art_loose01");
  assert.ok((await listArtifactItems(s.db, { unassigned: true })).some((i) => i.ref === "art_loose01"));
  const all = await listArtifactItems(s.db, { all: true });
  assert.equal(all.filter((i) => i.ref === "art_loose01").length, 1);
});

test("a received artifact is shared", async () => {
  await addArtifact("art_recv0001", { received: 1, contact: "alex", bot: null });
  await addArtifact("art_recv0002", { received: 1, contact: null, bot: null });
  const all = await listArtifactItems(s.db, { all: true });
  assert.equal(all.find((i) => i.ref === "art_recv0001").shared, true);
  assert.equal(all.find((i) => i.ref === "art_recv0002").shared, false);
});

test("a deleted artifact is not listed", async () => {
  await addArtifact("art_gone0001");
  await s.db.execute("UPDATE artifacts SET deleted_at=datetime('now') WHERE id='art_gone0001'");
  assert.ok(!(await listArtifactItems(s.db, { all: true })).some((i) => i.ref === "art_gone0001"));
});

test("Workspace missing: items still list artifacts and report workspace missing", async () => {
  install(s.home, ["artifacts"]);
  const r = await listMakeItems(s.db, { all: true }, { crowHome: s.home });
  assert.equal(r.artifacts, "installed");
  assert.equal(r.workspace, "missing");
  assert.ok(r.items.some((i) => i.ref === "art_filed01"));
  const docs = await listMakeItems(s.db, { all: true }, { crowHome: s.home, filter: "documents" });
  assert.ok(docs.items.every((i) => i.filter === "documents"));
  const shared = await listMakeItems(s.db, { all: true }, { crowHome: s.home, filter: "shared" });
  assert.ok(shared.items.length && shared.items.every((i) => i.shared));
});

test("Workspace not set up: not_ready, no throw", async () => {
  const h = join(s.dir, "ws-home");
  mkdirSync(join(h, "bundles", "workspace", "server"), { recursive: true });
  install(h, ["artifacts", "workspace"]);
  // Use the repo's real workspace server code with an empty .env, so getConfig throws not_ready.
  const real = join(process.cwd(), "bundles", "workspace", "server");
  const prev = process.env.CROW_HOME;
  process.env.CROW_HOME = h;
  try {
    rmSync(join(h, "bundles", "workspace", "server"), { recursive: true, force: true });
    (await import("node:fs")).symlinkSync(real, join(h, "bundles", "workspace", "server"));
    const ws = await listWorkspaceItems(s.db, { all: true }, { crowHome: h });
    assert.deepEqual([...ws], []);
    assert.equal(ws.status, "not_ready");
    const r = await listMakeItems(s.db, { all: true }, { crowHome: h });
    assert.equal(r.workspace, "not_ready");
    assert.ok(r.items.length > 0);
  } finally {
    if (prev === undefined) delete process.env.CROW_HOME; else process.env.CROW_HOME = prev;
  }
});

test("Workspace files map to items, filed or unassigned", async () => {
  const h = join(s.dir, "ws-stub");
  const srv = join(h, "bundles", "workspace", "server");
  mkdirSync(join(srv, "nc"), { recursive: true });
  install(h, ["workspace"]);
  writeFileSync(join(srv, "config.js"), "export const getConfig = () => ({});");
  writeFileSync(join(srv, "nc", "dav.js"), `export const listRecent = async (cfg, o) => [
    { fileId: 11, name: "plan.docx", isFolder: false, mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", modified: "2026-10-26T10:00:00.000Z" },
    { fileId: 12, name: "budget.xlsx", isFolder: false, mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", modified: "2026-10-25T10:00:00.000Z" }];`);
  await setItemProject(s.db, "workspace_file", "11", 2, { setBy: "operator" });
  const inP2 = await listWorkspaceItems(s.db, { projectId: 2 }, { crowHome: h });
  assert.deepEqual(inP2.map((i) => [i.ref, i.type, i.justMade, i.openUrl]), [["11", "document", false, "/dashboard/make/open/workspace_file/11"]]);
  const none = await listWorkspaceItems(s.db, { unassigned: true }, { crowHome: h });
  assert.deepEqual(none.map((i) => [i.ref, i.type]), [["12", "spreadsheet"]]);
});

// ---- the origin card leg (card -> thread -> bot) ----
const tasksStub = (map, { fail = false } = {}) => ({
  execute: async ({ args }) => {
    if (fail) throw new Error("unable to open database file");
    const ids = JSON.parse(args[0]);
    return { rows: ids.filter((i) => map.has(i)).map((i) => ({ id: i, project_id: map.get(i) })) };
  },
});
const projectRow = async (id) => (await s.db.execute({ sql: "SELECT project_id, card_id, set_by FROM shell_items WHERE item_kind='artifact' AND item_ref=?", args: [id] })).rows[0];

test("the origin card's project beats the chat's project", async () => {
  await setItemProject(s.db, "perch_thread", "perchlive-card", 2, { setBy: "operator" });
  await addArtifact("art_card0001", { session: "perchlive-card" });
  await s.db.execute("UPDATE artifacts SET origin_card=77 WHERE id='art_card0001'");
  const items = await listArtifactItems(s.db, { projectId: 3 }, { tasksDb: tasksStub(new Map([[77, 3]])) });
  const it = items.find((i) => i.ref === "art_card0001");
  assert.ok(it, "listed under the card's project");
  assert.equal(it.cardId, 77);
  assert.equal(Number((await projectRow("art_card0001")).project_id), 3);
});

test("tasks.db unreadable with an origin card: nothing is filed, a later listing files it", async () => {
  await addArtifact("art_card0002", { session: "perchlive-card" });
  await s.db.execute("UPDATE artifacts SET origin_card=78 WHERE id='art_card0002'");
  const warn = console.warn; console.warn = () => {};
  let first;
  try { first = await listArtifactItems(s.db, { all: true }, { tasksDb: tasksStub(new Map(), { fail: true }) }); } finally { console.warn = warn; }
  assert.equal(await projectRow("art_card0002"), undefined, "no row written");
  assert.equal(first.find((i) => i.ref === "art_card0002").projectId, null, "lists as Unassigned meanwhile");
  await listArtifactItems(s.db, { all: true }, { tasksDb: tasksStub(new Map([[78, 3]])) });
  assert.equal(Number((await projectRow("art_card0002")).project_id), 3);
});

test("at most `limit` fresh artifacts are filed per call", async () => {
  for (const n of [1, 2, 3]) await addArtifact(`art_cap0000${n}`);
  await listArtifactItems(s.db, { all: true }, { limit: 2 });
  const filed = (await s.db.execute("SELECT COUNT(*) AS n FROM shell_items WHERE item_ref LIKE 'art_cap%'")).rows[0].n;
  assert.equal(Number(filed), 2);
});

test("a project view overfetches Workspace files, then cuts to the limit", async () => {
  const h = join(s.dir, "ws-over");
  const srv = join(h, "bundles", "workspace", "server");
  mkdirSync(join(srv, "nc"), { recursive: true });
  install(h, ["workspace"]);
  writeFileSync(join(srv, "config.js"), "export const getConfig = () => ({});");
  writeFileSync(join(srv, "nc", "dav.js"), `export const listRecent = async (cfg, o) => { globalThis.__asked = o.limit; return [1,2,3,4].map((n) => ({ fileId: 100 + n, name: n + ".docx", isFolder: false, mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", modified: "2026-10-26T10:00:00.000Z" })); };`);
  for (const n of [1, 2, 3]) await setItemProject(s.db, "workspace_file", String(100 + n), 2, { setBy: "operator" });
  const got = await listWorkspaceItems(s.db, { projectId: 2 }, { crowHome: h, limit: 2 });
  assert.equal(globalThis.__asked, 6);
  assert.equal(got.length, 2);
  await listWorkspaceItems(s.db, { all: true }, { crowHome: h, limit: 2 });
  assert.equal(globalThis.__asked, 2);
});
