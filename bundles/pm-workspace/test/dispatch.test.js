import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { ensureDispatchTables, dispatch, result, disposition, telemetry } from "../server/dispatch.js";

let db;
before(async () => {
  db = createClient({ url: "file::memory:" });
  await db.execute("CREATE TABLE pi_bot_defs (bot_id TEXT PRIMARY KEY, definition TEXT, enabled INTEGER)");
  await db.execute("INSERT INTO pi_bot_defs VALUES ('t-bot', '{\"models\":{\"default\":\"m1\"}}', 1)");
  await ensureDispatchTables(db);
});

test("dispatch inserts a queued job row and a telemetry row", async () => {
  const r = await dispatch(db, { bot_id: "t-bot", duty: "doc-revision", goal: "Revise X", card_id: 7 });
  assert.ok(r.job_id.startsWith("job-"));
  const job = (await db.execute({ sql: "SELECT * FROM bot_jobs WHERE job_id=?", args: [r.job_id] })).rows[0];
  assert.equal(job.status, "queued");
  assert.match(String(job.goal), /DISPATCH .* duty: doc-revision/);
  const t = (await db.execute({ sql: "SELECT * FROM pm_bot_dispatches WHERE job_id=?", args: [r.job_id] })).rows[0];
  assert.equal(t.duty, "doc-revision");
  assert.equal(t.card_id, 7);
});

test("dispatch refuses an unknown or disabled bot", async () => {
  await assert.rejects(dispatch(db, { bot_id: "nope", duty: "d", goal: "g" }), /unknown or disabled/);
});

test("result on a completed job scans and redacts", async (t) => {
  const r = await dispatch(db, { bot_id: "t-bot", duty: "d2", goal: "g2" });
  await db.execute({ sql: "UPDATE bot_jobs SET status='completed', result=?, started_at=datetime('now') WHERE job_id=?",
    args: ["fine text plus ghp_" + "a".repeat(36), r.job_id] });
  const prev = process.env.PM_SCAN_RULES_FILE;
  process.env.PM_SCAN_RULES_FILE = writeTmpRules();
  t.after(() => {
    if (prev === undefined) delete process.env.PM_SCAN_RULES_FILE;
    else process.env.PM_SCAN_RULES_FILE = prev;
  });
  const out = await result(db, { job_id: r.job_id });
  assert.equal(out.scan_status, "findings");
  assert.ok(!out.result.includes("ghp_" + "a".repeat(36)));
});

test("disposition + telemetry math (edit counts as a miss)", async () => {
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await dispatch(db, { bot_id: "t-bot", duty: "d3", goal: "g" })).job_id);
  await disposition(db, { job_id: ids[0], disposition: "accepted" });
  await disposition(db, { job_id: ids[1], disposition: "edited" });
  await disposition(db, { job_id: ids[2], disposition: "rejected" });
  const s = await telemetry(db, {});
  assert.equal(s.decided, 3);
  assert.equal(s.accepted, 1);
  assert.ok(Math.abs(s.accept_rate - 1 / 3) < 1e-9);
  assert.ok(s.per_bot["t-bot"]);
  assert.equal(s.per_bot["t-bot"].decided, 3);
});

import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
function writeTmpRules() {
  const p = join(mkdtempSync(join(tmpdir(), "rules-")), "r.json");
  writeFileSync(p, JSON.stringify({ rules: [{ name: "github-token", pattern: "ghp_[A-Za-z0-9]{36}" }] }));
  return p;
}
