// 0017-staged-sends: the staged_sends table (one row per provider draft waiting for the operator's
// yes) on both rails — init-db's CREATE and this numbered migration. DDL only; additive, no
// SCHEMA_GENERATION bump, independent of 0016. The table is local-only: it holds addresses and
// bodies, so it never replicates to a paired instance.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import * as mod from "../scripts/migrations/0017-staged-sends.mjs";
import { discoverMigrations } from "../scripts/migrations/runner.mjs";

const { run, id, STAGED_SENDS_DDL } = mod;
const REPO = new URL("..", import.meta.url).pathname;
const SYNC = await import("../servers/sharing/instance-sync.js");

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function tmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const INDEXES = [
  "idx_staged_sends_card", "idx_staged_sends_draft", "idx_staged_sends_session",
  "idx_staged_sends_state", "idx_staged_sends_thread",
];

// The plan's column list, in order: the row is the whole record of one staged draft.
const COLUMNS = [
  "id", "session_id", "thread_id", "bot_id", "card_id", "job_id", "channel", "cred_ref",
  "provider_draft_id", "provider_thread_id", "snapshot", "content_hash", "state", "fail_reason",
  "tainted", "new_recipients", "source_flags", "sent_at", "provider_message_id", "created_at",
  "updated_at",
];

function shape(dbPath) {
  const d = new Database(dbPath, { readonly: true });
  const out = {
    cols: d.prepare("PRAGMA table_info(staged_sends)").all(),
    idx: d.prepare("PRAGMA index_list(staged_sends)").all().map(({ seq, ...rest }) => rest)
      .sort((a, b) => a.name.localeCompare(b.name)),
    idxCols: Object.fromEntries(INDEXES.map((n) => [n, d.prepare(`PRAGMA index_info(${n})`).all().map((c) => c.name)])),
    sql: d.prepare("SELECT name, sql FROM sqlite_master WHERE tbl_name='staged_sends' ORDER BY name").all(),
  };
  d.close();
  return out;
}

test("migration parity with init-db", () => {
  assert.equal(id, "0017-staged-sends");
  assert.ok(discoverMigrations(join(REPO, "scripts", "migrations")).some((p) => p.endsWith("/0017-staged-sends.mjs")));

  const dir = tmp("ss-init-");
  execFileSync(process.execPath, ["scripts/init-db.js"], { env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: REPO });
  const want = shape(join(dir, "crow.db"));
  assert.ok(want.cols.length > 0, "init-db created staged_sends");
  assert.deepEqual(want.cols.map((c) => c.name), COLUMNS);
  assert.equal(want.idx.find((i) => i.name === "idx_staged_sends_card").partial, 1, "the card index is partial");

  const fresh = join(tmp("ss-fresh-"), "crow.db");
  new Database(fresh).close();
  assert.equal(run({ dbPath: fresh, log: () => {} }).applied, true);
  assert.deepEqual(shape(fresh), want);

  // Byte-identical to init-db's block, so the two rails cannot drift.
  const init = readFileSync(new URL("../scripts/init-db.js", import.meta.url), "utf8");
  assert.ok(init.includes(`await initTable("staged_sends table", \`${STAGED_SENDS_DDL}\`);`));
});

test("local-only", () => {
  assert.ok(SYNC.LOCAL_ONLY_TABLES.includes("staged_sends"));
  assert.ok(!SYNC.SYNCED_TABLES.includes("staged_sends"));
  assert.doesNotThrow(() => SYNC.assertLocalOnlyDisjoint(SYNC.SYNCED_TABLES, SYNC.LOCAL_ONLY_TABLES));
  assert.throws(() => SYNC.assertLocalOnlyDisjoint(["memories", "staged_sends"], SYNC.LOCAL_ONLY_TABLES), /local-only/);
  assert.equal(SYNC.shouldSyncRowForTest("staged_sends", { id: "ss-1" }), false);
});

test("the DDL is additive, idempotent and never drops or deletes", () => {
  const dbPath = join(tmp("ss-idem-"), "crow.db");
  new Database(dbPath).close();
  const first = run({ dbPath, log: () => {} });
  const db = new Database(dbPath);
  db.prepare(`INSERT INTO staged_sends (id, channel, provider_draft_id, snapshot, content_hash, created_at, updated_at)
              VALUES ('ss-1','gmail','d1','{}','h',1,1)`).run();
  db.close();
  const second = run({ dbPath, log: () => {} });
  const after = new Database(dbPath, { readonly: true });
  assert.equal(after.prepare("SELECT COUNT(*) AS n FROM staged_sends").get().n, 1);
  after.close();
  assert.equal(first.applied, true);
  assert.equal(second.applied, true);
  const src = readFileSync(new URL("../scripts/migrations/0017-staged-sends.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src, /\bDROP\b/);
  assert.doesNotMatch(src, /\bDELETE\b/);
});