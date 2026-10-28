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

let home, template, W, ST, S, K, getConfig, createDbClient, initWorkspaceTables, n = 0;
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
});
after(() => { for (const f of fakes) f.close(); });

/** A fresh fake Nextcloud + crow.db per test. The owner's display name is literally "admin" (spike E12). */
async function setup({ mode = "shadow", watchSince = T0 - HOUR } = {}) {
  const fake = await startFakeNextcloud(); fakes.push(fake);
  const names = { admin: "admin", coworker: "coworker", "crow-bot": "Crow bot" };
  fake.extraRoutes = async (req, res, body, { send, ms }) => {
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
  const tick = W.makeCommentTick({ db, getConfig, clock });
  const doc = (p, threads = [], people = { admin: "ocinst_admin" }, opts = {}) => fake.addFile(`D/${p}`, commentDocx({ threads, people }), { owner: "admin", mime: S.DOCX_MIME, ...opts });
  const save = (node, threads, people = { admin: "ocinst_admin" }, author = "admin") => fake.editorSave(node.path, commentDocx({ threads, people }), { author });
  const open = (node, users = ["admin"]) => fake.openInEditor(node.path, users, { releaseAfterMs: 1e9 });
  const events = async (kind, fileId) => (await db.execute("SELECT * FROM workspace_comment_events ORDER BY id")).rows
    .filter((r) => (!kind || r.kind === kind) && (fileId === undefined || Number(r.file_id) === fileId))
    .map((r) => ({ kind: r.kind, fileId: Number(r.file_id), ...JSON.parse(r.detail_json) }));
  const verdicts = async (fileId) => (await events(undefined, fileId)).filter((e) => ["would_fire", "unverified", "history"].includes(e.kind));
  const advance = (ms) => { clock.t += ms; };
  return { fake, db, clock, tick, doc, save, open, events, verdicts, advance };
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
  const base = { reporterUid: "ocinst_admin", sessionUids: ["ocinst_admin"], sessionRow: { uids_json: '["admin"]' }, payloadName: "admin", tokenName: " Admin ", ownerUids: ["admin"], ownerNames: ["admin"] };
  assert.deepEqual(I.liveOwner(base), { ok: true, reason: null, sole: true });
  assert.equal(I.liveOwner({ ...base, reporterUid: "ocinst_coworker" }).reason, "non_owner_author");
  assert.equal(I.liveOwner({ ...base, sessionUids: ["ocinst_admin", "ocinst_coworker"] }).reason, "coworker_in_session");
  assert.equal(I.liveOwner({ ...base, sessionRow: { uids_json: '["admin","coworker"]' } }).reason, "coworker_in_session");
  assert.equal(I.liveOwner({ ...base, payloadName: "coworker" }).reason, "unverified_author");
  assert.equal(I.isBotAuthor("Hank (bot)", null), true);
  assert.equal(I.isBotAuthor("Crow bot", "ocinst_crow-bot"), true);
  assert.equal(I.isBotAuthor("admin", "ocinst_admin"), false);
  assert.equal(I.normName(" A\u0301dmin "), I.normName("\u00C1dmin"), "NFC: decomposed = composed");
  assert.equal(I.normName("  ADMIN "), "admin");
  assert.equal(I.historyOf({ date: "not a date", watchSince: 0, firstSighting: false }), "unknown");
});
