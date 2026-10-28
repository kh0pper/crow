/** Comment loop Phase 1, Task 5 (§3.3, I-6): editor-session sampling and lock-aware key resolution. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { startFakeNextcloud } from "./helpers/workspace-fake-nextcloud.js";
import { connectWorkspace } from "./helpers/workspace-client.js";

const ROOT = join(import.meta.dirname, "..");
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const sign = (payload, secret = "jwt") => { const h = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}`; return `${h}.${createHmac("sha256", secret).update(h).digest("base64url")}`; };
// The plugin's session token (E10): document.key, permissions and the user; no referenceData, no file id.
const editorJwt = (k, uid = "admin") => sign({ document: { key: k, permissions: { edit: true } }, editorConfig: { user: { id: `ocinst_${uid}`, name: uid } }, exp: Math.floor(Date.now() / 1000) + 2592000 });
const PV = "pv=0.2.0";

let fake, close, db, S, base, server, getConfig;
const docx = (path, opts = {}) => fake.addFile(path, "PK-fake", { owner: "admin", ...opts, mime: opts.mime || S.DOCX_MIME });
const pending = (key, { hint, uid } = {}) => fetch(`${base}/pending?key=${key}&${PV}`, { headers: { Authorization: `Bearer ${editorJwt(key, uid)}`, ...(hint !== undefined ? { "X-Crow-File-Hint": String(hint) } : {}) } });

before(async () => {
  fake = await startFakeNextcloud(); fake.addFolder("D", { owner: "admin" });
  let home;
  ({ close, home } = await connectWorkspace(fake));
  const dbPath = join(home, "data", "crow.db");
  execFileSync(process.execPath, [join(ROOT, "scripts", "init-db.js")], { cwd: ROOT, env: { ...process.env, CROW_HOME: home, CROW_DATA_DIR: join(home, "data"), CROW_DB_PATH: dbPath, CROW_DISABLE_NOSTR: "1", CROW_DISABLE_INSTANCE_SYNC: "1" }, stdio: "pipe" });
  db = await (await import("../bundles/workspace/server/db.js")).openWorkspaceDb(dbPath);
  S = await import("../bundles/workspace/server/comments/sessions.js");
  ({ getConfig } = await import("../bundles/workspace/server/config.js"));
  const { liveRouter } = await import("../bundles/workspace/server/live/routes-live.js");
  const app = express(); app.use(liveRouter({ Router: express.Router, json: express.json, db, getConfig, clock: { now: () => Date.now() } }));
  server = app.listen(0); base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); await close(); fake.close(); });

test("recordSession unions uids, keeps first_seen", async () => {
  await S.recordSession(db, { key: "ku1", fileId: 9001, uids: ["admin"], at: 1000 });
  await S.recordSession(db, { key: "ku1", fileId: 9001, uids: ["coworker"], at: 5000 });
  await S.recordSession(db, { key: "ku1", fileId: 9001, uids: ["admin"], at: 3000 });
  const r = await S.sessionByKey(db, "ku1");
  assert.deepEqual(JSON.parse(r.uids_json), ["admin", "coworker"]);
  assert.equal(Number(r.first_seen), 1000);
  assert.equal(Number(r.last_seen), 5000);
  assert.equal(await S.sessionByKey(db, "no-such"), null);
});

test("a coworker sampled once then gone still taints the key", async () => {
  await S.recordSession(db, { key: "ku2", fileId: 9002, uids: ["admin", "coworker"], at: 1000 });
  await S.recordSession(db, { key: "ku2", fileId: 9002, uids: ["admin"], at: 2000 });
  const r = await S.sessionByKey(db, "ku2");
  assert.equal(S.everNonOwner(r, ["admin"]), true);
  await S.recordSession(db, { key: "ku3", fileId: 9003, uids: ["admin"], at: 1000 });
  assert.equal(S.everNonOwner(await S.sessionByKey(db, "ku3"), ["admin"]), false);
  assert.equal(S.everNonOwner(null, ["admin"]), false);
});

test("soleOwnerWindowAt: inside ±30 s → true; coworker window → false; no row → false", async () => {
  // owner alone 100..200 s; a coworker session 1000..1100 s
  await S.recordSession(db, { key: "kw1", fileId: 9010, uids: ["admin"], at: 100_000 });
  await S.recordSession(db, { key: "kw1", fileId: 9010, uids: ["admin"], at: 200_000 });
  await S.recordSession(db, { key: "kw2", fileId: 9010, uids: ["admin", "coworker"], at: 1_000_000 });
  await S.recordSession(db, { key: "kw2", fileId: 9010, uids: ["admin"], at: 1_100_000 });
  assert.equal(await S.soleOwnerWindowAt(db, 9010, 150, ["admin"]), true);
  assert.equal(await S.soleOwnerWindowAt(db, 9010, 229, ["admin"]), true, "inside the 30 s slack");
  assert.equal(await S.soleOwnerWindowAt(db, 9010, 71, ["admin"]), true, "inside the 30 s slack before");
  assert.equal(await S.soleOwnerWindowAt(db, 9010, 231, ["admin"]), false, "outside the slack: no row");
  assert.equal(await S.soleOwnerWindowAt(db, 9010, 1050, ["admin"]), false, "a coworker was in that session");
  assert.equal(await S.soleOwnerWindowAt(db, 9999, 150, ["admin"]), false, "no row for the file");
});

test("sweep samples only locked (type 1) docx among the newest 60", async () => {
  const files = [];
  for (let i = 0; i < 61; i++) files.push(docx(`D/s${i}.docx`)); // s0 is the oldest, s60 the newest
  const oldest = files[0], live = files[60], ended = files[59], userLocked = files[58];
  const kOld = fake.openInEditor(oldest.path, ["admin"], { releaseAfterMs: 1e9 });
  const kLive = fake.openInEditor(live.path, ["admin"], { releaseAfterMs: 1e9 });
  fake.setSessionUsers(kLive, ["admin", "coworker"]);
  const kEnded = fake.openInEditor(ended.path, ["admin"], { releaseAfterMs: 1e9 });
  fake.viewerLeft(ended.path, kEnded, { locked: true }); // locked, key cached, nobody in it
  fake.setLock(userLocked.path, { type: 0, owner: "admin", time: 1 }); // a user lock: not the editor's
  const xl = fake.addFile("D/t.xlsx", "PK", { owner: "admin", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  fake.openInEditor(xl.path, ["admin"], { releaseAfterMs: 1e9 });
  const ocsBefore = fake.calls.filter((c) => c.url.includes("/apps/onlyoffice/api/v1/config/")).length;

  const r = await S.sweepSessions({ db, getConfig, clock: { now: () => 7_000_000 }, limit: 60 });
  assert.match(fake.lastSearchBody(), /<d:nresults>60<\/d:nresults>/);
  assert.match(fake.lastSearchBody(), new RegExp(`<d:literal>${S.DOCX_MIME.replace(/\./g, "\\.")}</d:literal>`));
  assert.deepEqual(r, { sampled: 2, anyLive: true }, "the live one and the ended one were asked");
  const asked = fake.calls.filter((c) => c.url.includes("/apps/onlyoffice/api/v1/config/")).slice(ocsBefore).map((c) => Number(c.url.match(/config\/(\d+)/)[1]));
  assert.deepEqual(asked.sort(), [ended.fileId, live.fileId].sort());
  const row = await S.sessionByKey(db, kLive);
  assert.equal(Number(row.file_id), live.fileId);
  assert.equal(row.uids_json, '["admin","coworker"]', "prefix-stripped");
  assert.equal(await S.sessionByKey(db, kEnded), null, "a session with nobody in it is not recorded");
  assert.equal(await S.sessionByKey(db, kOld), null, "the 61st file is outside the sweep");
});

test("a session outside the top 60 resolves via the X-Crow-File-Hint header or a sampled key; neither → 401", async () => {
  const oldest = fake.node("D/s0.docx"); // outside the newest 60 (see the sweep test), no queued work
  const k = fake.state.keys.get(oldest.fileId);
  assert.equal(await S.sessionByKey(db, k), null);
  assert.equal((await pending(k)).status, 401, "no hint, never sampled");
  for (const bad of ["0", "-1", "abc", "1e3", "99999999999999999"]) assert.equal((await pending(k, { hint: bad })).status, 401, `malformed hint ${bad}`);
  const viaHint = await pending(k, { hint: oldest.fileId });
  assert.equal(viaHint.status, 200);
  assert.deepEqual(await viaHint.json(), []);
  // that authorised request recorded the key → the next one resolves without the hint
  assert.equal(Number((await S.sessionByKey(db, k)).file_id), oldest.fileId);
  const viaSample = await pending(k);
  assert.equal(viaSample.status, 200);
  assert.deepEqual(await viaSample.json(), []);
  // the hint is still only a candidate: a viewer (not in info.users) with the right hint stays out
  assert.equal((await pending(k, { hint: oldest.fileId, uid: "mallory" })).status, 401);
});

test("auth records the sample (prefix-stripped uids)", async () => {
  const f = docx("D/rec.docx");
  const k = fake.openInEditor(f.path, ["admin"], { releaseAfterMs: 1e9 });
  const r = await pending(k, { hint: f.fileId });
  assert.equal(r.status, 200);
  const row = await S.sessionByKey(db, k);
  assert.equal(row.uids_json, '["admin"]');
  assert.equal(Number(row.file_id), f.fileId);
});

test("fileHint never authorises alone: a hint naming another file whose key differs → 401", async () => {
  const a = docx("D/a.docx"), b = docx("D/b.docx");
  const ka = fake.openInEditor(a.path, ["admin"], { releaseAfterMs: 1e9 });
  fake.openInEditor(b.path, ["admin"], { releaseAfterMs: 1e9 });
  // a's key with b's file id: b's live key differs → refused, and nothing is recorded for a's key
  assert.equal((await pending(ka, { hint: b.fileId })).status, 401);
  assert.equal(await S.sessionByKey(db, ka), null);
  // an unopened file and a missing file as hints
  const c = docx("D/c.docx");
  assert.equal((await pending(ka, { hint: c.fileId })).status, 401);
  assert.equal((await pending(ka, { hint: 987654 })).status, 401);
  // a stale sampled row pointing at the wrong file does not authorise either
  await S.recordSession(db, { key: "forged-key", fileId: b.fileId, uids: ["admin"], at: 1 });
  assert.equal((await pending("forged-key")).status, 401);
});

test("editorSave writes a version with its author", async () => {
  const f = docx("D/v.docx");
  fake.editorSave(f.path, "PK-2", { author: "coworker" });
  assert.equal(fake.versionsOf(f.path).at(-1).author, "coworker");
});
