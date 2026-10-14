// Crow Artifacts — the D23 trust split (spec v1.6 §7.3; plan PR-3 Task 3.1).
//   isLocked(bot, thread):  may this chat receive a TRUSTED round at all?
//   isTainted(bot, thread): does what it writes save untrusted?
// isLocked must be AT LEAST AS STRICT as mcp.js scopeOf (round-2 B9): the
// parity below is ONE-WAY on a shared fixture matrix (scopeOf scoped ⇒
// isLocked), plus pins for isLocked's own extra fail-closed arms. An
// equality test is deliberately absent — it would force isLocked to copy
// scopeOf's latest-round-only behaviour.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { initArtifactsTables } from "../bundles/artifacts/server/init-tables.js";
import { isLocked, isTainted, sessionIsClean, markSessionTainted } from "../bundles/artifacts/server/trust.js";
import { scopeOf } from "../bundles/artifacts/server/mcp.js";

const s = {};
before(async () => {
  s.dir = mkdtempSync(join(tmpdir(), "artifacts-trust-"));
  s.db = createDbClient(join(s.dir, "crow.db"));
  await s.db.executeMultiple(`CREATE TABLE IF NOT EXISTS bot_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id TEXT, gateway_thread_id TEXT, narrowed_tools TEXT);`);
  await initArtifactsTables(s.db);
  await s.db.execute({ sql: "INSERT INTO artifacts (id,title,type,created_by_bot,current_version,received) VALUES ('art_trust01','T','document','bobby',1,0)", args: [] });
});
after(() => { try { s.db.close(); } catch {} rmSync(s.dir, { recursive: true, force: true }); });

const row = (thread, nt) => s.db.execute({ sql: "INSERT INTO bot_sessions (bot_id, gateway_thread_id, narrowed_tools) VALUES ('bobby',?,?)", args: [thread, nt] });
const round = (thread, untrusted, status = "done") => s.db.execute({ sql: "INSERT INTO artifact_rounds (artifact_id,kind,base_version,thread_ids_json,untrusted_input,bot_id,session_id,status) VALUES ('art_trust01','ask',1,'[]',?,'bobby',?,?)", args: [untrusted, thread, status] });
const LOCKED_JSON = JSON.stringify(["crow:locked", "crow:only:mcp__artifacts__"]);

// The shared fixture matrix: [name, setup, expect isLocked].
const MATRIX = [
  ["clean row, no rounds", async (t) => { await row(t, null); }, false],
  ["clean array row", async (t) => { await row(t, JSON.stringify(["mcp__crow-memory__x"])); }, false],
  ["locked marker", async (t) => { await row(t, LOCKED_JSON); await round(t, 1); }, true],
  ["locked marker, no round", async (t) => { await row(t, LOCKED_JSON); }, true],
  ["latest round untrusted", async (t) => { await row(t, null); await round(t, 1); }, true],
  ["older untrusted round behind a newer trusted one", async (t) => { await row(t, null); await round(t, 1); await round(t, 0); }, true],
  ["untrusted_input NULL counts as untrusted", async (t) => { await row(t, null); await s.db.execute({ sql: "INSERT INTO artifact_rounds (artifact_id,kind,base_version,thread_ids_json,untrusted_input,bot_id,session_id,status) VALUES ('art_trust01','ask',1,'[]',0,'bobby',?,'done')", args: [t] }); await s.db.execute({ sql: "UPDATE artifact_rounds SET untrusted_input=2 WHERE session_id=?", args: [t] }); }, true],
  ["only trusted rounds", async (t) => { await row(t, null); await round(t, 0); await round(t, 0); }, false],
  ["no bot_sessions row", async () => {}, true],
  ["corrupt narrowed_tools", async (t) => { await row(t, "{not json"); }, true],
  ["narrowed_tools not an array", async (t) => { await row(t, '{"a":1}'); }, true],
  ["tainted only (D22) — not locked", async (t) => { await row(t, null); await markSessionTainted(s.db, "bobby", t, "read-contact"); }, false],
];

let n = 0;
for (const [name, setup, expectLocked] of MATRIX) {
  test(`isLocked: ${name} → ${expectLocked}`, async () => {
    const thread = `perchlive-tr${String(++n).padStart(4, "0")}`;
    await setup(thread);
    assert.equal(await isLocked(s.db, "bobby", thread), expectLocked);
    // ONE-WAY parity with scopeOf: anything scopeOf scopes (or refuses) is locked.
    let scoped;
    try { scoped = (await scopeOf(s.db, { kind: "bot", id: "bobby", thread, gateway: "perch" })) != null; } catch { scoped = true; }
    if (scoped) assert.equal(await isLocked(s.db, "bobby", thread), true, `scopeOf scopes "${name}" so isLocked must too`);
  });
}

test("isTainted: the D22 taint record (and nothing else) makes a chat tainted; sessionIsClean = !isLocked && !isTainted", async () => {
  await row("perchlive-tt000001", null);
  assert.equal(await isTainted(s.db, "bobby", "perchlive-tt000001"), false);
  assert.equal(await sessionIsClean(s.db, "bobby", "perchlive-tt000001"), true);
  await markSessionTainted(s.db, "bobby", "perchlive-tt000001", "read-contact");
  assert.equal(await isTainted(s.db, "bobby", "perchlive-tt000001"), true);
  assert.equal(await isLocked(s.db, "bobby", "perchlive-tt000001"), false, "D23: a tainted chat can still receive trusted rounds");
  assert.equal(await sessionIsClean(s.db, "bobby", "perchlive-tt000001"), false, "but it never saves clean");
  // A locked chat is never clean either, even with no taint row.
  await row("perchlive-tt000002", LOCKED_JSON);
  assert.equal(await isTainted(s.db, "bobby", "perchlive-tt000002"), false);
  assert.equal(await sessionIsClean(s.db, "bobby", "perchlive-tt000002"), false);
});

test("fail closed: no bot / no thread, and a database that cannot answer, read as locked AND tainted", async () => {
  for (const [b, t] of [[null, "perchlive-x"], ["bobby", null], ["", ""]]) {
    assert.equal(await isLocked(s.db, b, t), true);
    assert.equal(await isTainted(s.db, b, t), true);
    assert.equal(await sessionIsClean(s.db, b, t), false);
  }
  const broken = { execute: async () => { throw new Error("SQLITE_BUSY"); } };
  assert.equal(await isLocked(broken, "bobby", "perchlive-x"), true);
  assert.equal(await isTainted(broken, "bobby", "perchlive-x"), true);
  assert.equal(await sessionIsClean(broken, "bobby", "perchlive-x"), false);
});

test("review L1: a lock marker anywhere in narrowed_tools locks, even in a shape the array check would miss (as strict as scopeOf's substring test)", async () => {
  await row("perchlive-tl000001", JSON.stringify([["crow:locked"]]));
  assert.equal(await isLocked(s.db, "bobby", "perchlive-tl000001"), true);
  await row("perchlive-tl000002", JSON.stringify(["prefix-crow:locked-suffix"]));
  assert.equal(await isLocked(s.db, "bobby", "perchlive-tl000002"), true);
});
