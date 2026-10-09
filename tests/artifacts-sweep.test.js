// Crow Artifacts Task 3.6 — the round-done effects the mount runs when a bot
// calls artifact_round_done: an ended UNTRUSTED round's locked session stops
// at once (R-M3), and the owner hears "Version N is ready". The sweep itself
// (timeouts, queued retries, reconcile, reservation hold) is pinned by the
// model suite (R-M2/R-M3, R2-M5, R2-H1 A1, R3-M2).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { markdownBlocks } from "../servers/blog/renderer.js";
import { initArtifactsTables } from "../bundles/artifacts/server/init-tables.js";
import { createLocalBlobStore } from "../bundles/artifacts/server/blob-store.js";
import * as store from "../bundles/artifacts/server/store.js";
import * as comments from "../bundles/artifacts/server/comments.js";
import * as rounds from "../bundles/artifacts/server/rounds.js";
import { roundDoneEffects } from "../bundles/artifacts/server/sweep.js";

const s = {};
const OWNER = { kind: "session" };
const BOT = { kind: "bot", id: "bobby", thread: "perchlive-sweep", gateway: "perch" };

before(async () => {
  s.dir = mkdtempSync(join(tmpdir(), "artifacts-sweep-"));
  s.db = createDbClient(join(s.dir, "crow.db"));
  await initArtifactsTables(s.db);
  await s.db.executeMultiple(`CREATE TABLE IF NOT EXISTS bot_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id TEXT, gateway_thread_id TEXT, narrowed_tools TEXT);`);
  s.blobs = createLocalBlobStore(join(s.dir, "blobs"));
});
after(() => { try { s.db.close(); } catch {} rmSync(s.dir, { recursive: true, force: true }); });

async function makeRound({ untrusted, resultVersion = null }) {
  const a = await store.createArtifact(s.db, s.blobs, { title: "Sweep artifact", type: "document", source: { markdown: "x" }, actor: BOT }, { markdownBlocks });
  const author = untrusted ? { kind: "contact", id: "c1" } : { kind: "owner" };
  const t = await comments.addThread(s.db, { artifactId: a.id, versionN: 1, anchor: { kind: "whole" }, text: "words", author });
  const r = await rounds.startRound(s.db, { artifactId: a.id, actor: OWNER, include: [t.threadId] });
  assert.equal(!!r.untrusted, untrusted);
  await s.db.execute({ sql: "UPDATE artifact_rounds SET session_id='perchlive-sweep', status='working' WHERE id=?", args: [r.id] });
  if (resultVersion != null) await s.db.execute({ sql: "UPDATE artifact_rounds SET result_version=? WHERE id=?", args: [resultVersion, r.id] });
  return { artifact: a, round: await rounds.getRound(s.db, r.id) };
}

function fakeEngine() {
  const e = {
    stopped: [],
    sessions: [{ sessionId: "sid-1", botId: "bobby", threadId: "perchlive-sweep", state: "idle" }],
    async list() { return this.sessions; },
    async stop(id) { this.stopped.push(id); this.sessions = this.sessions.filter((x) => x.sessionId !== id); },
  };
  return e;
}

test("an ended untrusted round's locked session stops at once and is stamped", async () => {
  const { round } = await makeRound({ untrusted: true });
  const engine = fakeEngine();
  const out = await roundDoneEffects(s.db, round, { engine, notify: async () => {} });
  assert.equal(out.stopped, true);
  assert.deepEqual(engine.stopped, ["sid-1"]);
  const row = (await s.db.execute({ sql: "SELECT session_stopped_at FROM artifact_rounds WHERE id=?", args: [round.id] })).rows[0];
  assert.ok(row.session_stopped_at, "stamped");
  // Idempotent: a stamped round is not stopped again (the sweep shares the rule).
  const again = await roundDoneEffects(s.db, await rounds.getRound(s.db, round.id), { engine: fakeEngine(), notify: async () => {} });
  assert.equal(again.stopped, false);
});

test("a trusted round's session is NOT stopped (it is the owner's live session)", async () => {
  const { round } = await makeRound({ untrusted: false });
  const engine = fakeEngine();
  const out = await roundDoneEffects(s.db, round, { engine, notify: async () => {} });
  assert.equal(out.stopped, false);
  assert.deepEqual(engine.stopped, []);
});

test("\"Version N is ready\": the owner is notified with the artifact's title and a deep link; no version, no notification", async () => {
  const notes = [];
  const { artifact, round } = await makeRound({ untrusted: false, resultVersion: 3 });
  const out = await roundDoneEffects(s.db, round, { notify: async (n) => notes.push(n) });
  assert.equal(out.notified, true);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].title, "Version 3 is ready");
  assert.match(notes[0].body, /Sweep artifact/);
  assert.equal(notes[0].action_url, `/dashboard/artifacts?id=${encodeURIComponent(artifact.id)}`);
  assert.equal(notes[0].source, "artifacts");

  const noVersion = await makeRound({ untrusted: false });
  const out2 = await roundDoneEffects(s.db, noVersion.round, { notify: async (n) => notes.push(n) });
  assert.equal(out2.notified, false);
  assert.equal(notes.length, 1, "no result version → nothing to announce");
});

test("a failing notification or a missing engine never throws into the MCP call", async () => {
  const { round } = await makeRound({ untrusted: true, resultVersion: 2 });
  const out = await roundDoneEffects(s.db, round, { engine: null, notify: async () => { throw new Error("notify down"); } });
  assert.equal(out.notified, false);
  assert.equal(out.stopped, false, "no engine → nothing stopped (the sweep retries)");
  assert.equal(await roundDoneEffects(s.db, null, {}).then((o) => o.stopped), false);
});
