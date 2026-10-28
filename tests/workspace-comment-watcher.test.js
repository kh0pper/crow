/** Comment loop Phase 1, Task 6 (§3.2, §3.5, §3.6, §12 I-2 + C1 nit): the saved-file watcher in shadow mode. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeNextcloud } from "./helpers/workspace-fake-nextcloud.js";
import { commentDocx } from "./helpers/workspace-comment-docx.js";

const ROOT = join(import.meta.dirname, "..");
const T0 = 1_800_000_000_000;
const HOUR = 3600_000, DAY = 24 * HOUR;
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const ENV_BASE = "WORKSPACE_BOOTSTRAP_DONE=1\nWORKSPACE_PUBLIC_HOST=crow.test\nWORKSPACE_BOT_APP_PASSWORD=pw-secret-123\nWORKSPACE_ONLYOFFICE_JWT_SECRET=jwt\n";

let home, template, W, ST, S, K, OO, getConfig, createDbClient, initWorkspaceTables, n = 0;
const fakes = [];
const writeEnv = (extra = "") => writeFileSync(join(home, "bundles", "workspace", ".env"), ENV_BASE + extra, { mode: 0o600 });

before(async () => {
  home = mkdtempSync(join(tmpdir(), "ws-watch-"));
  mkdirSync(join(home, "bundles", "workspace"), { recursive: true });
  mkdirSync(join(home, "data"), { recursive: true });
  process.env.CROW_HOME = home;
  process.env.CROW_DATA_DIR = join(home, "data");
  writeEnv();
  template = join(home, "data", "template.db");
  execFileSync(process.execPath, [join(ROOT, "scripts", "init-db.js")], { cwd: ROOT, env: { ...process.env, CROW_HOME: home, CROW_DATA_DIR: join(home, "data"), CROW_DB_PATH: template, CROW_DISABLE_NOSTR: "1", CROW_DISABLE_INSTANCE_SYNC: "1" }, stdio: "pipe" });
  ({ createDbClient } = await import("../servers/db.js"));
  ({ initWorkspaceTables } = await import("../bundles/workspace/server/init-tables.js"));
  ({ getConfig } = await import("../bundles/workspace/server/config.js"));
  W = await import("../bundles/workspace/server/comments/watcher.js");
  ST = await import("../bundles/workspace/server/comments/store.js");
  S = await import("../bundles/workspace/server/comments/sessions.js");
  K = await import("../bundles/workspace/server/comments/keys.js");
  OO = await import("../bundles/workspace/server/nc/onlyoffice.js");
});
after(() => { for (const f of fakes) f.close(); });

/** A fresh fake Nextcloud + crow.db per test. The owner's display name is literally "admin" (spike E12). */
async function setup({ mode = "shadow", watchSince = T0 - HOUR, seams } = {}) {
  OO.setNcInstanceId(null); // the instance id is learnt per test, from this test's editor sessions (or the env)
  const fake = await startFakeNextcloud(); fakes.push(fake);
  const names = { admin: "admin", coworker: "coworker", "crow-bot": "Crow bot" };
  // Crow bot's full-match autocomplete, as Nextcloud does it: a case-insensitive EXACT match (no NFC, no trim),
  // outside the owner's group too. `onCall` runs (awaited) at the start of each autocomplete request.
  const ac = { users: [], down: false, onCall: null };
  fake.extraRoutes = async (req, res, body, { send, ms }) => {
    if (req.url.startsWith("/ocs/v2.php/core/autocomplete/get")) {
      if (ac.onCall) await ac.onCall();
      if (ac.down) { send(503); return true; }
      const q = (new URL(req.url, "http://x").searchParams.get("search") || "").toLowerCase();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ocs: { meta: { status: "ok", statuscode: 200 }, data: ac.users.filter((u) => u.label.toLowerCase() === q) } }));
      return true;
    }
    const pm = req.url.match(/^\/remote\.php\/dav\/principals\/users\/([^/]+)\/$/);
    if (pm && req.method === "PROPFIND" && names[pm[1]]) { send(207, ms(`<d:response><d:href>${req.url}</d:href><d:propstat><d:prop><d:displayname>${names[pm[1]]}</d:displayname></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`)); return true; }
    return fake.failRoute ? fake.failRoute(req, res, send) : false;
  };
  process.env.WORKSPACE_NC_INTERNAL_URL = fake.ncUrl;
  process.env.WORKSPACE_OO_INTERNAL_URL = fake.ooUrl;
  fake.addFolder("D", { owner: "admin" });
  const path = join(home, "data", `t${++n}.db`);
  copyFileSync(template, path);
  if (existsSync(`${template}-wal`)) copyFileSync(`${template}-wal`, `${path}-wal`);
  const db = createDbClient(path);
  await initWorkspaceTables(db);
  await db.execute("INSERT OR REPLACE INTO pi_bot_defs(bot_id, display_name, enabled) VALUES ('hank', 'Hank', 1)");
  const clock = { t: T0, now() { return this.t; } };
  fake.state.realisticMtime = () => Math.floor(clock.t / 1000); // version ids follow the test clock
  if (mode !== "off") await ST.setMode(db, mode, watchSince);
  const tick = W.makeCommentTick({ db, getConfig, clock, seams });
  const doc = (p, threads = [], people = { admin: "ocinst_admin" }, opts = {}) => fake.addFile(`D/${p}`, commentDocx({ threads, people }), { owner: "admin", mime: S.DOCX_MIME, ...opts });
  const save = (node, threads, people = { admin: "ocinst_admin" }, author = "admin") => fake.editorSave(node.path, commentDocx({ threads, people }), { author });
  const open = (node, users = ["admin"]) => fake.openInEditor(node.path, users, { releaseAfterMs: 1e9 });
  const events = async (kind, fileId) => (await db.execute("SELECT * FROM workspace_comment_events ORDER BY id")).rows
    .filter((r) => (!kind || r.kind === kind) && (fileId === undefined || Number(r.file_id) === fileId))
    .map((r) => ({ kind: r.kind, fileId: Number(r.file_id), ...JSON.parse(r.detail_json) }));
  const verdicts = async (fileId) => (await events(undefined, fileId)).filter((e) => ["would_fire", "unverified", "history"].includes(e.kind));
  const advance = (ms) => { clock.t += ms; };
  return { ac, names, fake, db, clock, tick, doc, save, open, events, verdicts, advance };
}
const hankRoot = (date, text = "@hank please tidy this section", extra = {}) => ({ author: "admin", date: iso(date), text, quoted: "con", durableId: "1A2B3C4D", ...extra });

test("config: ownerUids from WORKSPACE_OWNER_UIDS, else WORKSPACE_ADMIN_USER, else admin; commentLoopBlocked", async () => {
  writeEnv();
  assert.deepEqual([...getConfig().ownerUids], ["admin"]);
  assert.equal(getConfig().commentLoopBlocked, "");
  writeEnv("WORKSPACE_ADMIN_USER=owner1\n");
  assert.deepEqual([...getConfig().ownerUids], ["owner1"]);
  writeEnv("WORKSPACE_ADMIN_USER=owner1\nWORKSPACE_OWNER_UIDS= admin , owner2,,\nWORKSPACE_COMMENT_LOOP_BLOCKED=duplicate_display_name\n");
  assert.deepEqual([...getConfig().ownerUids], ["admin", "owner2"]);
  assert.equal(getConfig().commentLoopBlocked, "duplicate_display_name");
  writeEnv();
});

test("mode off: no Nextcloud call at all", async () => {
  const s = await setup({ mode: "off" });
  const f = s.doc("a.docx", [hankRoot(T0)]); s.open(f);
  const before = s.fake.calls.length;
  const r = await s.tick();
  assert.equal(s.fake.calls.length, before, "zero Nextcloud / editor calls");
  assert.equal(r.ran, false);
  // blocked (by the watch row or by config) is the same: nothing is called
  await ST.setMode(s.db, "shadow", T0);
  await ST.setBlocked(s.db, "duplicate_display_name");
  await s.tick();
  assert.equal(s.fake.calls.length, before);
  await ST.setBlocked(s.db, null);
  writeEnv("WORKSPACE_COMMENT_LOOP_BLOCKED=duplicate_display_name\n");
  await s.tick();
  assert.equal(s.fake.calls.length, before);
  writeEnv();
  assert.equal((await s.tick()).ran, true, "control: unblocked, it runs");
  assert.ok(s.fake.calls.length > before);
});

test("new doc with a fresh @hank by the sole owner → would_fire (sole:true)", async () => {
  const s = await setup();
  const f = s.doc("new.docx"); s.open(f);
  s.advance(2000);
  const r1 = await s.tick();
  assert.equal(r1.ran, true);
  assert.equal(r1.nextMs, W.LIVE_TICK_MS, "a live docx session → the 5 s tick");
  assert.equal((await s.events()).length, 0, "an empty doc logs nothing");
  s.advance(5000);
  s.save(f, [hankRoot(s.clock.t - 1000)]);
  s.advance(1000);
  await s.tick();
  const v = await s.verdicts(f.fileId);
  assert.equal(v.length, 1);
  assert.equal(v[0].kind, "would_fire");
  assert.equal(v[0].sole, true);
  assert.equal(v[0].bot, "hank");
  assert.equal(v[0].source, "saved");
  assert.equal(typeof v[0].age_s, "number");
  const scans = await s.events("scan_new", f.fileId);
  assert.equal(scans.length, 1);
  assert.equal(scans[0].pair, K.pairKey(f.fileId, "admin", iso(s.clock.t - 2000)));
  // nothing new on the next tick
  s.advance(15000);
  await s.tick();
  assert.equal((await s.verdicts(f.fileId)).length, 1);
});

test("reopen of an old doc: mentions before watch_since → history; zero would_fire", async () => {
  const s = await setup({ watchSince: T0 - HOUR });
  const f = s.doc("old.docx", [hankRoot(T0 - 3 * DAY), { author: "admin", date: iso(T0 - 2 * DAY), text: "@hank and this one", quoted: "con", durableId: "2B3C4D5E" }]);
  s.open(f);
  s.advance(3000);
  await s.tick();
  const v = await s.verdicts(f.fileId);
  assert.equal(v.length, 2);
  assert.ok(v.every((e) => e.kind === "history"), JSON.stringify(v));
  assert.equal((await s.events("would_fire")).length, 0);
});

test("first sighting: date before min(session first_seen, prev version mtime) - 60 s → history; neither known → unverified reason date_unknown", async () => {
  const s = await setup({ watchSince: T0 - 10 * DAY });
  // A: two versions; the comment predates the previous version → history
  s.clock.t = T0 - 2 * HOUR;
  const a = s.doc("a.docx", [hankRoot(T0 - DAY)]);
  s.clock.t = T0;
  s.save(a, [hankRoot(T0 - DAY)]);
  // C: one version; the session that produced it was first seen 30 min ago; the comment is from 1 h ago → history
  s.advance(1000);
  const c = s.doc("c.docx", [hankRoot(T0 - HOUR, "@hank c")]);
  await S.recordSession(s.db, { key: "kc-old", fileId: c.fileId, uids: ["admin"], at: T0 - 30 * 60_000 });
  await S.recordSession(s.db, { key: "kc-old", fileId: c.fileId, uids: ["admin"], at: s.clock.t + 1000 });
  // B: one version, never seen in an editor, comment after watch_since → unknown → unverified date_unknown
  s.advance(1000);
  const b = s.doc("b.docx", [hankRoot(T0 - HOUR, "@hank b")]);
  // D: same as C but the comment is fresh (after first_seen - 60 s) → not history
  s.advance(1000);
  const d = s.doc("d.docx", [hankRoot(T0 - 31 * 60_000 + 30_000, "@hank d")]);
  await S.recordSession(s.db, { key: "kd", fileId: d.fileId, uids: ["admin"], at: T0 - 31 * 60_000 });
  await S.recordSession(s.db, { key: "kd", fileId: d.fileId, uids: ["admin"], at: s.clock.t + 1000 });
  s.advance(2000);
  await s.tick();
  const [va, vb, vc, vd] = await Promise.all([a, b, c, d].map((x) => s.verdicts(x.fileId)));
  assert.equal(va.length, 1); assert.equal(va[0].kind, "history", JSON.stringify(va));
  assert.equal(vc.length, 1); assert.equal(vc[0].kind, "history", JSON.stringify(vc));
  assert.equal(vb.length, 1); assert.equal(vb[0].kind, "unverified"); assert.equal(vb[0].reason, "date_unknown");
  assert.equal(vd.length, 1); assert.notEqual(vd[0].kind, "history", JSON.stringify(vd));
});

test("I-2: newest version authored by coworker → unverified; 2 versions since last scan → multi_version; owner alone in window → would_fire", async () => {
  const s = await setup();
  const a = s.doc("a.docx"), b = s.doc("b.docx"), c = s.doc("c.docx");
  for (const x of [a, b, c]) s.open(x);
  s.advance(2000);
  await s.tick(); // first scans: no comments
  s.advance(5000);
  s.save(a, [hankRoot(s.clock.t - 1000, "@hank a")], undefined, "coworker");
  s.save(b, [hankRoot(s.clock.t - 1000, "@hank b-draft")]);
  s.save(c, [hankRoot(s.clock.t - 1000, "@hank c")]);
  s.advance(2000);
  s.save(b, [hankRoot(s.clock.t - 3000, "@hank b")]);
  s.advance(1000);
  await s.tick();
  const [va, vb, vc] = await Promise.all([a, b, c].map((x) => s.verdicts(x.fileId)));
  assert.equal(va.length, 1); assert.equal(va[0].kind, "unverified"); assert.equal(va[0].reason, "non_owner_version");
  assert.equal(vb.length, 1); assert.equal(vb[0].kind, "unverified"); assert.equal(vb[0].reason, "multi_version");
  assert.equal(vc.length, 1); assert.equal(vc[0].kind, "would_fire", JSON.stringify(vc)); assert.equal(vc[0].sole, true);
});

test("I-2: a version saved outside any sampled owner-only window → unverified", async () => {
  writeEnv("WORKSPACE_NC_INSTANCE_ID=ocinst\n"); // no editor session ever shows the instance id: config supplies it
  const s = await setup();
  const f = s.doc("w.docx"); // never opened in an editor: no session row covers the save
  s.advance(2000);
  await s.tick();
  s.advance(5000);
  s.save(f, [hankRoot(s.clock.t - 1000)]);
  s.advance(1000);
  await s.tick();
  const v = await s.verdicts(f.fileId);
  assert.equal(v.length, 1); assert.equal(v[0].kind, "unverified"); assert.equal(v[0].reason, "no_sole_owner_window");
  writeEnv();
});

test("instance id unknown (no editor session showed it, no WORKSPACE_NC_INSTANCE_ID) → unmapped_author", async () => {
  const s = await setup();
  const f = s.doc("u.docx"); // never opened: nothing reveals the instance id
  s.advance(2000);
  await s.tick();
  s.advance(5000);
  s.save(f, [hankRoot(s.clock.t - 1000)]);
  s.advance(1000);
  await s.tick();
  assert.equal(OO.getNcInstanceId(), null);
  const v = await s.verdicts(f.fileId);
  assert.equal(v.length, 1); assert.equal(v[0].kind, "unverified"); assert.equal(v[0].reason, "unmapped_author");
});

test("docSession learns the instance id from the connector's crow-bot user id", async () => {
  const s = await setup();
  const f = s.doc("i.docx"); s.open(f);
  assert.equal(OO.getNcInstanceId(), null);
  const sess = await OO.docSession(getConfig(), f.fileId);
  assert.deepEqual(sess.uids, ["admin"]);
  assert.equal(OO.getNcInstanceId(), "ocinst");
  OO.setNcInstanceId("bad_id"); assert.equal(OO.getNcInstanceId(), null, "only a plain alphanumeric id is kept");
});

test("people.xml uid with another instance's prefix → unmapped_author, even though the rest reads admin", async () => {
  const s = await setup();
  const f = s.doc("pp.docx"); s.open(f);
  s.advance(2000);
  await s.tick();
  s.advance(5000);
  s.save(f, [hankRoot(s.clock.t - 1000)], { admin: "ocx_admin" });
  s.advance(1000);
  await s.tick();
  const v = await s.verdicts(f.fileId);
  assert.equal(v.length, 1); assert.equal(v[0].kind, "unverified"); assert.equal(v[0].reason, "unmapped_author");
});

test("the GET's mtime is not in the versions list → non_owner_version (no fallback to the newest listed)", async () => {
  const s = await setup();
  const f = s.doc("nv.docx"); s.open(f);
  s.advance(2000);
  await s.tick();
  s.advance(5000);
  s.save(f, [hankRoot(s.clock.t - 1000)]);
  const vs = s.fake.versionsOf(f.path);
  vs.at(-1).id -= 3; // the current file is listed under some other id: an owner-authored version, but not this one
  s.advance(1000);
  await s.tick();
  const v = await s.verdicts(f.fileId);
  assert.equal(v.length, 1); assert.equal(v[0].kind, "unverified"); assert.equal(v[0].reason, "non_owner_version");
});

test("a non-Nextcloud failure in one file is that file's alone: marked error, logged, the next file still scanned", async () => {
  const boom = (threads, pm) => { if (JSON.stringify(threads).includes("boom")) throw new TypeError("parse blew up"); return K.snapshot(threads, pm); };
  const s = await setup({ seams: { snapshot: boom } });
  s.advance(1000);
  const good = s.doc("e2.docx", [hankRoot(s.clock.t - 500, "@hank fine")]);
  s.advance(1000);
  const bad = s.doc("e1.docx", [hankRoot(s.clock.t - 500, "@hank boom")]); // newest: listed (and scanned) first
  s.advance(1000);
  const r = await s.tick();
  assert.equal(r.ran, true); assert.notEqual(r.error, true, "no back-off");
  assert.equal((await ST.getState(s.db, bad.fileId)).skip_reason, "error");
  assert.ok((await ST.getState(s.db, good.fileId))?.scanned_at, "file 2 was still scanned");
  const errs = await s.events("scan_error", bad.fileId);
  assert.equal(errs.length, 1);
  assert.ok(!JSON.stringify(errs[0]).includes("boom"), "no comment text in the event");
  const rows = (await s.db.execute("SELECT kind, file_id FROM workspace_comment_events ORDER BY id")).rows;
  assert.equal(Number(rows[0].file_id), bad.fileId, "the failing file came first in the tick");
  assert.ok(rows.some((x) => x.kind === "scan_new" && Number(x.file_id) === good.fileId));
  s.advance(15_000);
  const n1 = s.fake.calls.length;
  await s.tick();
  assert.ok(s.fake.calls.length > n1, "no 60 s back-off: the next tick calls Nextcloud");
  assert.equal((await s.events("scan_error", bad.fileId)).length, 1, "not retried until its etag changes");
});

test("a comment by \"Crow\" (the gateway's authorFor(null)) naming @hank logs no verdict", async () => {
  const s = await setup();
  const f = s.doc("crow.docx"); s.open(f);
  s.advance(2000);
  await s.tick();
  s.advance(5000);
  s.save(f, [{ ...hankRoot(s.clock.t - 1000, "@hank over to you"), author: "Crow" }], { admin: "ocinst_admin" });
  s.advance(1000);
  await s.tick();
  assert.equal((await s.verdicts(f.fileId)).length, 0);
  assert.equal((await s.events("would_fire")).length, 0);
  assert.equal((await s.events(undefined, f.fileId)).length, 0, "no scan_new either");
});

test("displayName: a non-207 answer is null and not cached; a real answer is cached", async () => {
  const s = await setup();
  const { displayName } = await import("../bundles/workspace/server/nc/ocs.js");
  let fail = true, asked = 0;
  s.fake.failRoute = (req, res, send) => {
    if (req.method === "PROPFIND" && req.url === "/remote.php/dav/principals/users/dn-user/") {
      asked++;
      if (fail) { send(503); return true; }
      send(207, `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>${req.url}</d:href><d:propstat><d:prop><d:displayname>Dee Enn</d:displayname></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`); return true;
    }
    return false;
  };
  const cfg = getConfig();
  assert.equal(await displayName(cfg, "dn-user"), null, "an error answer is not the uid");
  fail = false;
  assert.equal(await displayName(cfg, "dn-user"), "Dee Enn", "the failure was not cached");
  assert.equal(await displayName(cfg, "dn-user"), "Dee Enn");
  assert.equal(asked, 2, "the real answer is cached");
});

test("startBackgroundWorkers: the queue worker starts first, and a watcher that fails to load does not stop it", async () => {
  const { startBackgroundWorkers } = await import("../bundles/workspace/panel/routes.js");
  const order = [];
  const mods = {
    "server/db.js": { openWorkspaceDb: async () => ({}) },
    "server/config.js": { getConfig: () => ({}) },
    "server/queue/worker.js": { startQueueWorker: () => order.push("queue") },
  };
  const load = async (rel) => { if (rel === "server/comments/watcher.js") { order.push("watcher-load"); throw new SyntaxError("bad module"); } return mods[rel]; };
  await startBackgroundWorkers({ clock: { now: () => T0 }, load }); // resolves: no retry of the whole start
  assert.deepEqual(order, ["queue", "watcher-load"]);
  // and a watcher that loads starts after the queue worker
  order.length = 0;
  await startBackgroundWorkers({ clock: { now: () => T0 }, load: async (rel) => rel === "server/comments/watcher.js" ? { startCommentWatcher: () => order.push("watcher") } : mods[rel] });
  assert.deepEqual(order, ["queue", "watcher"]);
  // Workspace not set up → it throws (the caller retries later) and nothing started
  order.length = 0;
  await assert.rejects(startBackgroundWorkers({ clock: { now: () => T0 }, load: async (rel) => rel === "server/config.js" ? { getConfig: () => { throw Object.assign(new Error("x"), { code: "not_ready" }); } } : mods[rel] }));
  assert.deepEqual(order, []);
});

test("coworker sampled on the key since last scan → coworker_in_session", async () => {
  const s = await setup();
  const f = s.doc("co.docx"); const key = s.open(f);
  s.advance(2000);
  await s.tick();
  s.fake.setSessionUsers(key, ["admin", "coworker"]);
  s.advance(5000);
  await s.tick(); // the sweep samples the coworker; the file is unchanged
  s.fake.setSessionUsers(key, ["admin"]);
  s.advance(5000);
  s.save(f, [hankRoot(s.clock.t - 1000)]);
  s.advance(1000);
  await s.tick();
  const v = await s.verdicts(f.fileId);
  assert.equal(v.length, 1); assert.equal(v[0].kind, "unverified"); assert.equal(v[0].reason, "coworker_in_session"); assert.equal(v[0].sole, false);
});

test("w:author = owner but people.xml uid = coworker → non_owner_author", async () => {
  const s = await setup();
  const f = s.doc("p.docx"); s.open(f);
  s.advance(2000);
  await s.tick();
  s.advance(5000);
  const root = hankRoot(s.clock.t - 1000);
  s.save(f, [root], { admin: "ocinst_coworker" });
  s.advance(1000);
  await s.tick();
  const v = await s.verdicts(f.fileId);
  assert.equal(v.length, 1); assert.equal(v[0].kind, "unverified"); assert.equal(v[0].reason, "non_owner_author");
  // and a w:author that is not an owner name at all
  s.advance(5000);
  s.save(f, [root, { author: "coworker", date: iso(s.clock.t - 500), text: "@hank mine", quoted: "con", durableId: "3C4D5E6F" }], { admin: "ocinst_admin", coworker: "ocinst_coworker" });
  s.advance(1000);
  await s.tick();
  const v2 = await s.verdicts(f.fileId);
  assert.equal(v2.length, 2); assert.equal(v2[1].kind, "unverified"); assert.equal(v2[1].reason, "non_owner_author");
});

test("a bot's own reply never logs a verdict", async () => {
  const s = await setup();
  const f = s.doc("bot.docx"); s.open(f);
  s.advance(2000);
  await s.tick();
  s.advance(5000);
  const root = hankRoot(s.clock.t - 1000);
  s.save(f, [root]);
  s.advance(1000);
  await s.tick();
  assert.equal((await s.verdicts(f.fileId)).length, 1, "the owner's root");
  const before = (await s.events(undefined, f.fileId)).length;
  s.advance(5000);
  s.save(f, [{ ...root, replies: [
    { author: "Hank (bot)", date: iso(s.clock.t - 800), text: "Done. Ask @hank again if needed" },
    { author: "Crow bot", date: iso(s.clock.t - 500), text: "@hank finished" },
  ] }], { admin: "ocinst_admin", "Crow bot": "ocinst_crow-bot" });
  s.advance(1000);
  await s.tick();
  assert.equal((await s.events(undefined, f.fileId)).length, before, "no scan_new and no verdict for bot replies");
});

test("etag change with identical comment parts (close-save) → no event, etag/mtime updated", async () => {
  const s = await setup();
  const f = s.doc("cs.docx"); s.open(f);
  s.advance(2000);
  await s.tick();
  s.advance(5000);
  const threads = [hankRoot(s.clock.t - 1000)];
  s.save(f, threads);
  s.advance(1000);
  await s.tick();
  const count = (await s.events()).length;
  assert.ok(count > 0);
  const scannedAt = Number((await ST.getState(s.db, f.fileId)).scanned_at);
  s.advance(5000);
  s.save(f, threads); // the close-save: new zip bytes (fresh paraIds), same comments
  const node = s.fake.node(f.path);
  s.advance(1000);
  await s.tick();
  assert.equal((await s.events()).length, count, "no event");
  const st = await ST.getState(s.db, f.fileId);
  assert.equal(st.etag, node.etag.replace(/"/g, ""));
  assert.equal(Number(st.mtime), node.mtime);
  assert.equal(Number(st.scanned_at), scannedAt, "etag and mtime only: the last scan time is kept");
});

test("a file over 20 MB is skipped once, by listing size", async () => {
  const s = await setup();
  const big = s.fake.addFile("D/big.docx", Buffer.alloc(W.MAX_BYTES + 1), { owner: "admin", mime: S.DOCX_MIME });
  const small = s.doc("small.docx", [hankRoot(T0 - 30_000)]);
  s.advance(1000);
  await s.tick();
  const gets = () => s.fake.calls.filter((c) => c.method === "GET" && c.url.includes("/remote.php/dav/files/"));
  assert.ok(gets().some((c) => c.url.endsWith("small.docx")), "control: the small file was downloaded");
  assert.equal(gets().filter((c) => c.url.endsWith("big.docx")).length, 0, "no GET of the big file");
  assert.equal((await ST.getState(s.db, big.fileId)).skip_reason, "too_large");
  s.advance(15000);
  await s.tick();
  assert.equal(gets().filter((c) => c.url.endsWith("big.docx")).length, 0, "second tick: still no GET");
});

test("Nextcloud fails mid-tick", async () => {
  const s = await setup();
  const files = ["m1.docx", "m2.docx", "m3.docx"].map((p) => { s.advance(1000); return s.doc(p, [hankRoot(s.clock.t - 500, `@hank ${p}`)]); });
  let gets = 0;
  s.fake.failRoute = (req, res, send) => {
    if (req.method === "GET" && req.url.includes("/remote.php/dav/files/") && ++gets === 2) { send(503); return true; }
    return false;
  };
  s.advance(1000);
  const r = await s.tick();
  assert.equal(r.ran, true);
  const states = await Promise.all(files.map((f) => ST.getState(s.db, f.fileId)));
  // newest first: m3 was downloaded and kept, m2 failed, m1 never reached
  assert.ok(states[2]?.scanned_at, "file 1 (newest) state saved");
  assert.equal(states[1], null, "file 2 untouched");
  assert.equal(states[0], null, "file 3 untouched");
  const n1 = s.fake.calls.length;
  s.advance(30_000);
  await s.tick();
  assert.equal(s.fake.calls.length, n1, "within the 60 s back-off: no call");
  s.advance(31_000);
  await s.tick();
  assert.match(s.fake.lastSearchBody(), /<d:nresults>200<\/d:nresults>/, "the first tick after an outage widens to 200");
  for (const f of files) assert.ok((await ST.getState(s.db, f.fileId))?.scanned_at, `${f.path} scanned on retry`);
  s.advance(15_000);
  await s.tick();
  assert.match(s.fake.lastSearchBody(), /<d:nresults>60<\/d:nresults>/, "then back to 60");
});

test("live_report then scan with a different fp for the same pair → fp_mismatch", async () => {
  const s = await setup();
  const f = s.doc("fp.docx"), g = s.doc("fp2.docx");
  for (const x of [f, g]) s.open(x);
  s.advance(2000);
  await s.tick();
  s.advance(5000);
  const date = s.clock.t - 1000;
  const rf = hankRoot(date, "@hank saved text"), rg = hankRoot(date, "@hank same");
  await ST.logEvent(s.db, { at: s.clock.t, fileId: f.fileId, kind: "live_report", detail: { source: "live", pair: K.pairKey(f.fileId, "admin", iso(date)), fp: "0".repeat(64) } });
  const fpG = K.fingerprint({ author: "admin", date: iso(date), text: rg.text, quoted: rg.quoted, occ: 0 });
  await ST.logEvent(s.db, { at: s.clock.t, fileId: g.fileId, kind: "live_report", detail: { source: "live", pair: K.pairKey(g.fileId, "admin", iso(date)), fp: fpG } });
  s.save(f, [rf]); s.save(g, [rg]);
  s.advance(1000);
  await s.tick();
  const m = await s.events("fp_mismatch");
  assert.equal(m.length, 1, JSON.stringify(m));
  assert.equal(m[0].fileId, f.fileId);
  assert.equal(m[0].pair, K.pairKey(f.fileId, "admin", iso(date)));
  assert.equal(m[0].live_fp, "0".repeat(64));
  assert.notEqual(m[0].fp, m[0].live_fp);
});

test("events store hash + ≤40-char snippet, never full text", async () => {
  const s = await setup();
  const f = s.doc("txt.docx"); s.open(f);
  s.advance(2000);
  await s.tick();
  s.advance(5000);
  const text = "@hank 👩‍💻 please rewrite the whole introduction so that it reads well for the board, and keep the numbers exactly as they are";
  s.save(f, [hankRoot(s.clock.t - 1000, text)]);
  s.advance(1000);
  await s.tick();
  const rows = (await s.db.execute({ sql: "SELECT kind, detail_json FROM workspace_comment_events WHERE file_id=?", args: [f.fileId] })).rows;
  assert.ok(rows.length >= 2, "scan_new + a verdict");
  for (const r of rows) {
    const d = JSON.parse(r.detail_json);
    assert.ok(!r.detail_json.includes(text.slice(0, 60)), `${r.kind} holds no long text`);
    if (r.kind === "scan_new" || r.kind === "would_fire") {
      assert.equal(d.hash, ST.textHash(text));
      assert.ok([...d.snippet].length <= 40);
      assert.ok(text.startsWith(d.snippet));
    }
  }
});

test("shadow never writes", async () => {
  const s = await setup();
  const a = s.doc("w1.docx"); const ka = s.open(a);
  const b = s.doc("w2.docx", [hankRoot(T0 - 2 * DAY)]); s.open(b, ["admin", "coworker"]);
  s.advance(2000);
  await s.tick();
  s.advance(5000);
  s.save(a, [hankRoot(s.clock.t - 1000)]);
  s.fake.setSessionUsers(ka, ["admin", "coworker"]);
  s.advance(1000);
  await s.tick();
  s.advance(5000);
  s.save(a, [hankRoot(s.clock.t - 7000), { author: "admin", date: iso(s.clock.t - 200), text: "@hank second", quoted: "con", durableId: "4D5E6F70" }]);
  s.advance(1000);
  await s.tick();
  assert.ok((await s.verdicts(a.fileId)).length >= 2, "control: the scenario logged verdicts");
  assert.ok(s.fake.calls.length > 0);
  for (const c of s.fake.calls) {
    assert.ok(["PROPFIND", "SEARCH", "GET", "OO"].includes(c.method), `${c.method} ${c.url}`);
    if (c.method === "OO") assert.equal(c.body?.c, "info", "only info on the command service (no forcesave, no drop)");
  }
});

test("second gateway: the lease holder ticks, the other skips", async () => {
  const s = await setup();
  const f = s.doc("l.docx", [hankRoot(T0 - 30_000)]); s.open(f);
  const other = W.makeCommentTick({ db: s.db, getConfig, clock: s.clock });
  s.advance(1000);
  assert.equal((await s.tick()).ran, true);
  const n1 = s.fake.calls.length;
  s.advance(5000);
  const r = await other();
  assert.equal(r.ran, false);
  assert.equal(s.fake.calls.length, n1, "the other gateway made no call");
  s.advance(5000);
  assert.equal((await s.tick()).ran, true, "the holder keeps ticking");
});

test("startCommentWatcher returns {stop}", async () => {
  const s = await setup({ mode: "off" });
  const w = W.startCommentWatcher({ db: s.db, getConfig, clock: s.clock });
  assert.equal(typeof w.stop, "function");
  w.stop();
  assert.equal(W.TICK_MS, 15000); assert.equal(W.LIVE_TICK_MS, 5000); assert.equal(W.MAX_DOWNLOADS, 5);
  assert.equal(W.MAX_BYTES, 20 * 1024 * 1024); assert.equal(W.BACKOFF_MS, 60000); assert.equal(W.RECENT_LIMIT, 60); assert.equal(W.OUTAGE_LIMIT, 200);
});

test("identity helpers: liveOwner rules (a)-(d), isBotAuthor, normName", async () => {
  const I = await import("../bundles/workspace/server/comments/identity.js");
  const base = { reporterUid: "admin", sessionUids: ["admin"], sessionRow: { uids_json: '["admin"]' }, payloadName: "admin", tokenName: " Admin ", ownerUids: ["admin"], ownerNames: ["admin"] };
  assert.deepEqual(I.liveOwner(base), { ok: true, reason: null, sole: true });
  assert.equal(I.liveOwner({ ...base, reporterUid: "coworker" }).reason, "non_owner_author");
  assert.equal(I.liveOwner({ ...base, reporterUid: "ocx_admin" }).reason, "non_owner_author", "session uids are compared as they are: no prefix strip");
  assert.equal(I.liveOwner({ ...base, sessionUids: ["admin", "coworker"] }).reason, "coworker_in_session");
  assert.equal(I.liveOwner({ ...base, sessionUids: ["ocx_admin"] }).sole, false, "a prefixed session uid is not the owner");
  assert.equal(I.liveOwner({ ...base, sessionRow: { uids_json: '["admin","coworker"]' } }).reason, "coworker_in_session");
  assert.equal(I.liveOwner({ ...base, payloadName: "coworker" }).reason, "unverified_author");
  assert.equal(I.isBotAuthor("Hank (bot)", null), true);
  assert.equal(I.isBotAuthor("Crow bot", "ocinst_crow-bot"), true);
  assert.equal(I.isBotAuthor("admin", "ocinst_admin"), false);
  assert.equal(I.isBotAuthor(" Crow ", "ocinst_admin"), true, "the gateway's authorFor(null), whatever the uid");
  assert.equal(I.isBotAuthor("Crowley", null), false);
  assert.equal(I.normName(" A\u0301dmin "), I.normName("\u00C1dmin"), "NFC: decomposed = composed");
  assert.equal(I.normName("  ADMIN "), "admin");
  assert.equal(I.historyOf({ date: "not a date", watchSince: 0, firstSighting: false }), "unknown");
});

test("historyOf: knownFp true → history, whatever the date and thresholds", async () => {
  const I = await import("../bundles/workspace/server/comments/identity.js");
  const fresh = iso(T0);
  assert.equal(I.historyOf({ date: fresh, watchSince: T0 - DAY, knownFp: false, firstSighting: false }), "new", "control");
  assert.equal(I.historyOf({ date: fresh, watchSince: T0 - DAY, knownFp: true, firstSighting: false }), "history");
  assert.equal(I.historyOf({ date: fresh, watchSince: T0 - DAY, knownFp: true, firstSighting: true }), "history", "even a first sighting with no thresholds");
  assert.equal(I.historyOf({ date: "garbage", watchSince: null, knownFp: true }), "history", "even an unreadable date");
});

test("peopleUidOf strips exactly \"<instanceid>_\"; VERDICT_REASONS is frozen and complete", async () => {
  const I = await import("../bundles/workspace/server/comments/identity.js");
  assert.equal(I.peopleUidOf("ocinst_admin", "ocinst"), "admin");
  assert.equal(I.peopleUidOf("ocinst_first_last", "ocinst"), "first_last", "only the instance prefix goes");
  assert.equal(I.peopleUidOf("ocx_admin", "ocinst"), null);
  assert.equal(I.peopleUidOf("admin", "ocinst"), null, "no prefix → unmapped");
  assert.equal(I.peopleUidOf("ocinst_", "ocinst"), null);
  assert.equal(I.peopleUidOf("ocinst_admin", null), null, "instance id unknown → unmapped");
  assert.ok(Object.isFrozen(I.VERDICT_REASONS));
  for (const r of ["history", "date_unknown", "owner_verified", "non_owner_author", "coworker_in_session", "unverified_author", "unmapped_author", "multi_version", "non_owner_version", "no_sole_owner_window", "unverified"]) assert.ok(Object.values(I.VERDICT_REASONS).includes(r), r);
});

test("savedOwner: exact-prefix people uid maps; version author compared as-is; unknown instance id → unmapped_author", async () => {
  const I = await import("../bundles/workspace/server/comments/identity.js");
  const s = await setup();
  const fileId = 999;
  await S.recordSession(s.db, { key: "kso", fileId, uids: ["admin"], at: T0 - 60_000 });
  await S.recordSession(s.db, { key: "kso", fileId, uids: ["admin"], at: T0 + 60_000 });
  const base = { author: "admin", peopleUid: "ocinst_admin", instanceId: "ocinst", newestVersion: { versionId: String(T0 / 1000), author: "admin" }, versionsSince: 1, db: s.db, fileId, sinceMs: T0 - HOUR, ownerUids: ["admin"], ownerNames: ["admin"] };
  assert.deepEqual(await I.savedOwner(base), { ok: true, reason: null, sole: true });
  assert.equal((await I.savedOwner({ ...base, instanceId: null })).reason, "unmapped_author");
  assert.equal((await I.savedOwner({ ...base, peopleUid: "ocx_admin" })).reason, "unmapped_author");
  assert.equal((await I.savedOwner({ ...base, peopleUid: "ocinst_coworker" })).reason, "non_owner_author");
  assert.equal((await I.savedOwner({ ...base, newestVersion: { ...base.newestVersion, author: "ocx_admin" } })).reason, "non_owner_version", "version author: no prefix strip");
});

test("a file whose GET always answers 403 (or 404/423) is skipped alone: scan_error, the next file still scanned, no back-off", async () => {
  for (const status of [403, 404, 423]) {
    const s = await setup();
    s.advance(1000);
    const good = s.doc(`ok${status}.docx`, [hankRoot(s.clock.t - 500, "@hank fine")]);
    s.advance(1000);
    const bad = s.doc(`no${status}.docx`, [hankRoot(s.clock.t - 500, "@hank secret words")]); // newest: listed first
    const badGets = () => s.fake.calls.filter((c) => c.method === "GET" && c.url.endsWith(`no${status}.docx`)).length;
    s.fake.failRoute = (req, res, send) => { if (req.method === "GET" && req.url.endsWith(`no${status}.docx`)) { send(status); return true; } return false; };
    s.advance(1000);
    const r = await s.tick();
    assert.equal(r.ran, true); assert.notEqual(r.error, true, `${status}: no whole-tick back-off`);
    assert.equal((await ST.getState(s.db, bad.fileId)).skip_reason, "error");
    assert.ok((await ST.getState(s.db, good.fileId))?.scanned_at, `${status}: the second file was still scanned`);
    const errs = await s.events("scan_error", bad.fileId);
    assert.equal(errs.length, 1);
    assert.deepEqual(errs[0], { kind: "scan_error", fileId: bad.fileId, source: "saved", code: { 403: "forbidden", 404: "not_found", 423: "locked" }[status] });
    assert.equal(badGets(), 1);
    s.advance(15_000);
    const n1 = s.fake.calls.length;
    await s.tick();
    assert.ok(s.fake.calls.length > n1, "the next tick runs (no 60 s back-off)");
    assert.equal(badGets(), 1, "not re-fetched until its etag changes");
  }
});

test("hash contract: a live report and the saved .docx comment built from the same text share fp, hash, snippet and pair", async () => {
  const { handleLiveReport, validateReport } = await import("../bundles/workspace/server/comments/live-report.js");
  const s = await setup();
  const f = s.doc("hc.docx"); const k = s.open(f);
  s.advance(2000);
  await s.tick(); // samples the session (first_seen)
  s.advance(5000);
  const time = s.clock.t - 1234; // ms that floor to the saved w:date second
  // spike E11: live text and quote use \r\n (the quote with a trailing one); the saved side has paragraphs
  const live = { Id: "1_1", Text: "@hank tidy\r\nthis section, ünïcode", Time: String(time), UserName: "admin", QuoteText: "con\r\n", Solved: false, Replies: [] };
  const v = validateReport({ key: k, pv: "0.3.0", kind: "add", thread: live, occ: [0] });
  assert.equal(v.ok, true);
  const out = await handleLiveReport({ db: s.db, getConfig, clock: s.clock, live: { editor: { userName: "admin" }, fileId: f.fileId, key: k, uid: "admin", uids: ["admin"], at: s.clock.t, path: f.path }, body: v.r });
  assert.deepEqual(out, { state: "shadow" });
  const [lr] = await s.events("live_report", f.fileId);
  s.save(f, [hankRoot(time, "@hank tidy\nthis section, ünïcode".normalize("NFD"), { quoted: "con" })]);
  s.advance(1000);
  await s.tick();
  const [sn] = await s.events("scan_new", f.fileId);
  assert.ok(lr && sn);
  for (const x of ["fp", "hash", "snippet", "pair", "bot"]) assert.equal(lr[x], sn[x], x);
  assert.equal(lr.hash, ST.textHash(K.normText("@hank tidy\r\nthis section, ünïcode")));
  assert.equal((await s.events("fp_mismatch")).length, 0);
  // the live verdict uses the watcher's reason names and detail schema
  const lv = (await s.events(undefined, f.fileId)).find((e) => e.source === "live" && e.kind !== "live_report");
  const sv = (await s.verdicts(f.fileId)).find((e) => e.source === "saved");
  assert.deepEqual(Object.keys(lv).sort(), Object.keys(sv).sort());
  assert.ok(Object.values((await import("../bundles/workspace/server/comments/identity.js")).VERDICT_REASONS).includes(lv.reason));
});

test("daily duplicate-name check: a clash blocks, nothing clears it, an outage neither sets nor clears, once a day", async () => {
  const s = await setup();
  const checks = () => s.fake.calls.filter((c) => c.url.includes("/core/autocomplete/get")).length;
  const blocked = async () => (await ST.getWatch(s.db)).blocked_reason;
  // an unreachable autocomplete: no block, retried within the hour (not every tick)
  s.ac.down = true;
  assert.equal((await s.tick()).ran, true);
  assert.equal(checks(), 1); assert.equal(await blocked(), null);
  s.advance(15000); await s.tick();
  assert.equal(checks(), 1, "the retry waits an hour");
  // no clash: the owner finds only itself (the owner uid is excluded)
  s.ac.down = false; s.ac.users = [{ id: "admin", label: "admin" }];
  s.advance(W.NAME_RETRY_MS); await s.tick();
  assert.equal(checks(), 2); assert.equal(await blocked(), null);
  s.advance(15000); await s.tick();
  assert.equal(checks(), 2, "then once a day");
  // a second account with the owner's name (case differs) → blocked, and the tick does nothing more
  s.ac.users.push({ id: "alex", label: "ADMIN" });
  s.advance(W.NAME_CHECK_MS);
  const before = s.fake.calls.length;
  const r = await s.tick();
  assert.equal(r.why, "blocked"); assert.equal(await blocked(), "duplicate_display_name");
  // M4: the owner's name is read fresh (no cache) for the check: one name PROPFIND + one autocomplete, then it stops
  assert.equal(s.fake.calls.length - before, 2, "a fresh name lookup and one autocomplete call, and the tick stops there");
});

test("daily duplicate-name check never clears a block (the check really runs while a block is present), and an unknown owner name means it cannot tell", async () => {
  for (const [label, answer] of [["no clash (false)", { users: [], down: false }], ["could not tell (null)", { users: [], down: true }]]) {
    const s = await setup();
    let ran = 0;
    // The block appears while the name check is in flight: the tick passed its blocked guard, so the check runs.
    s.ac.onCall = async () => { ran++; await ST.setBlocked(s.db, "duplicate_display_name"); };
    Object.assign(s.ac, answer);
    await s.tick();
    assert.ok(ran >= 1, `${label}: the name check ran`);
    assert.equal((await ST.getWatch(s.db)).blocked_reason, "duplicate_display_name", `${label}: the block survives`);
  }
  await setup(); // a fresh fake (the env points at it): autocomplete answers with nobody
  // ownerNameClash directly: unknown owner name → null (neither true nor false)
  const cfg = { ...getConfig(), ownerUids: Object.freeze(["nobody"]) };
  assert.equal(await W.ownerNameClash(cfg), null);
  assert.equal(await W.ownerNameClash(getConfig()), false);
});

// ---- final fix wave -----------------------------------------------------------------------------------------------
test("I1: editing the anchored text of an old @hank comment never fires it again (same author, second and text = known)", async () => {
  const s = await setup();
  const f = s.doc("q.docx"); s.open(f);
  s.advance(2000); await s.tick();
  s.advance(5000);
  const c = hankRoot(s.clock.t - 1000); // anchored on "con"
  s.save(f, [c]); s.advance(1000); await s.tick();
  assert.equal((await s.events("would_fire", f.fileId)).length, 1, "control: the fresh comment fires once");
  s.advance(5000);
  s.save(f, [{ ...c, quoted: "pastor con piña" }]); // the anchored text grew; the comment did not change
  s.advance(1000); await s.tick();
  const v = await s.verdicts(f.fileId);
  assert.equal(v.filter((e) => e.kind === "would_fire").length, 1, JSON.stringify(v));
  assert.equal(v.at(-1).kind, "history");
});

test("I1: deleting an earlier same-second duplicate shifts occ, and the remaining @hank comment does not re-fire", async () => {
  const s = await setup();
  const f = s.doc("o.docx"); s.open(f);
  s.advance(2000); await s.tick();
  s.advance(5000);
  const date = iso(s.clock.t - 1000);
  const a = { author: "admin", date, text: "a plain note", quoted: "con", durableId: "0A0A0A0A" };
  const b = { author: "admin", date, text: "@hank two", quoted: "con", durableId: "0B0B0B0B" };
  s.save(f, [a, b]); s.advance(1000); await s.tick();
  assert.equal((await s.events("would_fire", f.fileId)).length, 1, "control: b fires once");
  s.advance(5000);
  s.save(f, [b]); // a deleted: b moves from occ 1 to occ 0
  s.advance(1000); await s.tick();
  const v = await s.verdicts(f.fileId);
  assert.equal(v.filter((e) => e.kind === "would_fire").length, 1, JSON.stringify(v));
});

test("I1: a snapshot written before content keys existed falls back to the fingerprint rule", async () => {
  const s = await setup();
  const f = s.doc("bc.docx"); s.open(f);
  s.advance(2000); await s.tick();
  s.advance(5000);
  const c = hankRoot(s.clock.t - 1000);
  s.save(f, [c]); s.advance(1000); await s.tick();
  // strip the content keys, as an older build wrote the snapshot
  const st = await ST.getState(s.db, f.fileId);
  const old = JSON.parse(st.threads_json).map((t) => ({ ...t, comments: t.comments.map(({ ck, ...rest }) => rest) }));
  await ST.putState(s.db, { ...st, threads_json: JSON.stringify(old) });
  s.advance(5000);
  s.save(f, [c]); // same comments, new bytes: no new verdict
  s.advance(1000); await s.tick();
  assert.equal((await s.verdicts(f.fileId)).length, 1, "an unchanged comment stays known by its fingerprint");
  assert.ok(JSON.parse((await ST.getState(s.db, f.fileId)).threads_json)[0].comments[0].ck, "the rewritten snapshot carries content keys");
});

test("I3: a skipped version keeps the last scanned mtime, so the next scan counts every version since (multi_version)", async () => {
  const s = await setup();
  const f = s.doc("sk.docx"); s.open(f);
  s.advance(2000); await s.tick();
  const m1 = Number((await ST.getState(s.db, f.fileId)).mtime);
  s.advance(5000);
  s.fake.editorSave(f.path, Buffer.from("not a zip"), { author: "admin" });
  s.advance(1000); await s.tick();
  const st = await ST.getState(s.db, f.fileId);
  assert.equal(st.skip_reason, "unreadable");
  assert.equal(Number(st.mtime), m1, "a skip moves the etag only");
  s.advance(5000);
  s.save(f, [hankRoot(s.clock.t - 1000)]);
  s.advance(1000); await s.tick();
  const v = await s.verdicts(f.fileId);
  assert.equal(v.length, 1);
  assert.deepEqual([v[0].kind, v[0].reason], ["unverified", "multi_version"]);
});

test("I2: the session prune runs while the loop is off or blocked (DB only), at most hourly", async () => {
  const s = await setup({ mode: "off" });
  const keys = async () => (await s.db.execute("SELECT doc_key FROM workspace_editor_sessions ORDER BY doc_key")).rows.map((r) => r.doc_key);
  await S.recordSession(s.db, { key: "old1", fileId: 1, uids: ["admin"], at: T0 - 8 * DAY });
  await S.recordSession(s.db, { key: "new1", fileId: 1, uids: ["admin"], at: T0 });
  const before = s.fake.calls.length;
  assert.equal((await s.tick()).ran, false);
  assert.deepEqual(await keys(), ["new1"], "pruned while off");
  assert.equal(s.fake.calls.length, before, "still no Nextcloud call");
  await S.recordSession(s.db, { key: "old2", fileId: 1, uids: ["admin"], at: T0 - 8 * DAY });
  s.advance(60_000); await s.tick();
  assert.deepEqual(await keys(), ["new1", "old2"], "not again within the hour");
  await ST.setMode(s.db, "shadow", T0); await ST.setBlocked(s.db, "duplicate_display_name");
  s.advance(W.PRUNE_MS); await s.tick();
  assert.deepEqual(await keys(), ["new1"], "pruned while blocked");
  assert.equal(s.fake.calls.length, before);
});

test("M5: the lease is renewed after each file, so a slow tick keeps it", async () => {
  const s = await setup();
  for (const p of ["r1.docx", "r2.docx", "r3.docx"]) { s.advance(1000); s.doc(p, [hankRoot(s.clock.t - 500, `@hank ${p}`)]); }
  s.fake.failRoute = (req) => { if (req.method === "GET" && req.url.includes("/remote.php/dav/files/")) s.advance(50_000); return false; };
  s.advance(1000);
  assert.equal((await s.tick()).ran, true);
  const w = await ST.getWatch(s.db);
  assert.ok(Number(w.lease_until) > s.clock.t, `lease_until ${w.lease_until} is still ahead of ${s.clock.t}`);
});

test("M4: ownerNameClash asks Nextcloud for the owner's current name (no cache); displayName's cache lasts an hour", async () => {
  const s = await setup();
  const { displayName } = await import("../bundles/workspace/server/nc/ocs.js");
  const cfg = getConfig();
  s.names.admin = "admin";
  assert.equal(await displayName(cfg, "admin"), "admin"); // cached
  s.names.admin = "Zed Owner"; s.ac.users = [{ id: "other", label: "Zed Owner" }];
  assert.equal(await W.ownerNameClash(cfg), true, "the renamed owner's clash is seen");
  // the cache entry expires after an hour
  s.names.coworker = "Co One";
  const realNow = Date.now;
  try {
    assert.equal(await displayName(cfg, "coworker"), "Co One");
    s.names.coworker = "Co Two";
    assert.equal(await displayName(cfg, "coworker"), "Co One", "cached");
    const t = realNow(); Date.now = () => t + 3600_000 + 1000;
    assert.equal(await displayName(cfg, "coworker"), "Co Two", "expired after an hour");
  } finally { Date.now = realNow; }
  s.names.admin = "admin"; s.ac.users = [];
  await W.ownerNameClash(cfg); // re-reads (and re-caches) the owner's real name
});
