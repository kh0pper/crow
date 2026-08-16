/**
 * tests/sync-outbox-e2e.test.js — Task 6 of the stdio-sync-outbox plan: the
 * multi-process e2e + mixed-doors race. See docs/superpowers/specs/
 * 2026-08-15-stdio-sync-outbox-design.md, "Testing" — binding authority for
 * both scenarios below.
 *
 * Test 1 is the proving test this defect family never had: a REAL stdio
 * MCP child process (servers/memory/index.js, the actual production entry
 * point — no in-process stub) stores a memory with no live
 * InstanceSyncManager in that process. emitOrQueue (Task 2) must durably
 * queue the write; a gateway-shaped drain (Task 4) must then deliver it to
 * a paired peer carrying the CHILD's own write-time lamport, not a
 * drain-time mint.
 *
 * Test 2 is the mixed-doors race (spec finding-1): a stdio-shaped queued
 * write (older content, lamport L1) races a live gateway write of the same
 * row (newer content, lamport L2 > L1). Drain must preserve L1 on the
 * queued entry (not re-mint) and must NOT re-stamp the local row (which
 * must keep L2). Feeding both wire entries into a second, independent
 * instance — in the actual wire-arrival order (L2 arrives before L1,
 * because the live write went out immediately while the queued write
 * waited for drain) — must converge on the L2 content: this is the
 * exact defect the spec's round-1 review replaced the mechanism over
 * (drain-time re-minting would resurrect stale content on peers).
 *
 * HARD SAFETY RULE: nothing here may ever touch the real ~/.crow. Every db
 * — the child's and the in-process ones — lives under its own mkdtemp
 * CROW_DATA_DIR; the child additionally gets a scratch CROW_HOME/HOME so it
 * can't fall back to any real per-user path. The suite env exports
 * CROW_DISABLE_INSTANCE_SYNC=1 (scripts/run-suite.mjs) — inherited by any
 * spawned child unless explicitly stripped, and read into feedsDisabled by
 * every in-process manager unless force-overridden; both traps are named
 * explicitly at each point below (the item-2a vacuous-test tell).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createDbClient } from "../servers/db.js";
import { InstanceSyncManager } from "../servers/sharing/instance-sync.js";
import { drainOnce } from "../servers/sharing/sync-outbox-drain.js";
import { emitOrQueue } from "../servers/shared/sync-emit.js";
import { getOrCreateLocalInstanceId } from "../servers/gateway/instance-registry.js";
import * as ed from "../node_modules/@noble/ed25519/index.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const MEMORY_SERVER_ENTRY = fileURLToPath(new URL("../servers/memory/index.js", import.meta.url));

// One shared ed25519 identity — instance-sync verifies every applied entry
// against `this.identity.ed25519Pubkey`, and a user's own instances (and,
// here, a stdio-mounted process + a gateway-shaped drain manager standing
// in for the primary) share one identity. Same pattern as
// tests/group-tombstones.test.js / tests/instance-sync.test.js.
const TEST_PRIV = Buffer.alloc(32, 0x6e);
const TEST_PUB_HEX = Buffer.from(await ed.getPublicKey(TEST_PRIV)).toString("hex");
const IDENTITY = { ed25519Priv: TEST_PRIV, ed25519Pubkey: TEST_PUB_HEX };

// ── shared helpers ──────────────────────────────────────────────────────

function mkScratch(label) {
  return mkdtempSync(join(tmpdir(), `crow-sync-e2e-${label}-`));
}

/** Real init-db.js against a scratch CROW_DATA_DIR — never the real ~/.crow.
 *  CROW_DB_PATH is blanked defensively (init-db.js prefers it over
 *  CROW_DATA_DIR — tests/group-tombstones.test.js:56 names the same trap:
 *  an ambient shell export would otherwise run migrations against a real db). */
function runInitDb(dataDir) {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    cwd: REPO_ROOT,
    env: { ...process.env, CROW_DATA_DIR: dataDir, CROW_DB_PATH: "" },
    stdio: "pipe",
  });
}

/** Pre-seed the db-persisted eligibility setting emitOrQueue's real
 *  (non-test-override) gate reads — global dashboard_settings row, the
 *  exact shape servers/gateway/dashboard/settings/registry.js's
 *  writeSetting() upserts for an allowlisted/global key (mirrored here
 *  rather than imported, matching tests/sync-emit.test.js's setGate()). */
async function seedSyncDeploymentEnabled(db) {
  await db.execute({
    sql: `INSERT INTO dashboard_settings (key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    args: ["sync_deployment_enabled", "1"],
  });
}

/** Register a peer row so it's part of the drain's "currently paired"
 *  target set (crow_instances status IN ('active','offline')) — without
 *  this the delivery-accounting / delete-on-full-coverage assertions go
 *  quietly inert (spec round-2 finding 9, named again in the task brief). */
async function registerPeer(db, id, status = "active") {
  await db.execute({
    sql: "INSERT INTO crow_instances (id, name, crow_id, status) VALUES (?, ?, ?, ?)",
    args: [id, id, `crow:${id}`, status],
  });
}

async function outboxRows(db, table = "memories") {
  const { rows } = await db.execute({
    sql: "SELECT * FROM sync_outbox WHERE table_name = ? ORDER BY id ASC",
    args: [table],
  });
  return rows;
}

async function memoryRow(db, id) {
  const { rows } = await db.execute({ sql: "SELECT * FROM memories WHERE id = ?", args: [id] });
  return rows[0] || null;
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms: ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Poll until fn() returns a truthy value or timeoutMs elapses — the child's
 *  emitOrQueue call is fire-and-forget (`.catch(() => {})`, not awaited by
 *  the tool handler), so the outbox row can land a beat after the tool
 *  response returns; a fixed sleep would be both slower and flakier under
 *  the suite's 3×3 concurrent load than a short poll. */
async function waitFor(fn, { timeoutMs = 8000, intervalMs = 100, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await fn();
    if (result) return result;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// ══════════════════════════════════════════════════════════════════════
// Test 1: real stdio child — write → durable queue → gateway-shaped drain
// ══════════════════════════════════════════════════════════════════════

test(
  "e2e: real stdio memory-server child queues a write with no live manager; drain delivers it carrying the child's write-time lamport",
  { timeout: 60_000 },
  async () => {
    const dataDir = mkScratch("child-data");
    const crowHome = mkScratch("child-home"); // hard rule: scratch HOME too, never real ~/.crow
    runInitDb(dataDir);

    // Pre-seed eligibility BEFORE the child boots (own short-lived client,
    // closed before spawn to avoid two writers contending on the file).
    const seedDb = createDbClient(join(dataDir, "crow.db"));
    await seedSyncDeploymentEnabled(seedDb);
    seedDb.close();

    // Child env surgery (task brief, verbatim): children inherit run-suite's
    // CROW_DISABLE_INSTANCE_SYNC=1 export — strip it, or the child's own
    // (nonexistent, since it never constructs a manager) gate logic aside,
    // isDeploymentEligible's env-fallback branch would still be reachable on
    // a host where the db setting were ever absent. Scratch CROW_DATA_DIR +
    // CROW_HOME/HOME — the real incident this class of test caused once.
    const env = { ...process.env };
    delete env.CROW_DISABLE_INSTANCE_SYNC;
    env.CROW_DATA_DIR = dataDir;
    env.CROW_DB_PATH = "";
    env.CROW_HOME = crowHome;
    env.HOME = crowHome;

    let transport = null;
    let client = null;
    let db = null;
    const stderrChunks = [];

    try {
      transport = new StdioClientTransport({
        command: process.execPath,
        args: [MEMORY_SERVER_ENTRY],
        env,
        cwd: REPO_ROOT,
        stderr: "pipe",
      });
      transport.stderr?.on("data", (chunk) => stderrChunks.push(chunk));

      client = new Client({ name: "crow-sync-outbox-e2e-test", version: "0.1.0" });

      await withTimeout(client.connect(transport), 30_000, "child MCP connect");

      const toolResult = await withTimeout(
        client.callTool({
          name: "crow_store_memory",
          arguments: {
            content: "sync-outbox e2e: stdio child write",
            category: "general",
            importance: 5,
            source: "sync-outbox-e2e-test",
          },
        }),
        20_000,
        "crow_store_memory tool call",
      );

      const text = (toolResult.content || []).map((c) => c.text || "").join("\n");
      assert.match(text, /Memory stored/i, `unexpected tool result: ${text}`);
      const idMatch = text.match(/id:\s*(\d+)/);
      assert.ok(idMatch, `could not extract memory id from tool result: ${text}`);
      const memoryId = Number(idMatch[1]);

      // Open a SEPARATE db client from the parent process to observe what
      // the child committed — real cross-process SQLite reads (this is why
      // servers/db.js moved off @libsql/client; see its header comment).
      db = createDbClient(join(dataDir, "crow.db"));

      // Poll: emitOrQueue is fire-and-forget from the tool handler.
      const outboxRow = await waitFor(
        async () => {
          const rows = await outboxRows(db, "memories");
          return rows.find((r) => {
            try {
              return JSON.parse(r.row_json).id === memoryId;
            } catch {
              return false;
            }
          });
        },
        { label: "sync_outbox row for the stdio-written memory" },
      );
      assert.equal(outboxRow.op, "insert");
      const queuedLamport = Number(outboxRow.lamport_ts);
      assert.ok(Number.isFinite(queuedLamport) && queuedLamport > 0, `bad queued lamport: ${outboxRow.lamport_ts}`);

      // The lamport-equality observable: the OUTBOX row's lamport and the
      // STAMPED memories row's lamport must be the exact same value — real
      // db rows on both sides, not a helper's return value.
      const stampedRow = await waitFor(
        async () => {
          const row = await memoryRow(db, memoryId);
          return row && Number(row.lamport_ts) > 0 ? row : null;
        },
        { label: "memories row stamped with a lamport_ts" },
      );
      assert.equal(
        Number(stampedRow.lamport_ts),
        queuedLamport,
        "outbox row lamport must equal the stamped memories row lamport",
      );

      // Now drain — construct a gateway-shaped manager on the SAME db. The
      // manager's own instanceId MUST equal what the child's emitOrQueue
      // resolved (getOrCreateLocalInstanceId() reading the child's
      // CROW_DATA_DIR/instance-id file) — otherwise the drain manager would
      // mint against a DIFFERENT sync_state row than the one the child
      // stamped against, and every "write-time lamport" assertion below
      // would be checking two unrelated counters. Resolve it by pointing
      // THIS process's CROW_DATA_DIR at the same scratch dir the child
      // used, so getOrCreateLocalInstanceId() reads the file the child
      // already created (never writes a new one — the file exists).
      const prevDataDir = process.env.CROW_DATA_DIR;
      process.env.CROW_DATA_DIR = dataDir;
      let childInstanceId;
      try {
        childInstanceId = getOrCreateLocalInstanceId();
      } finally {
        if (prevDataDir === undefined) delete process.env.CROW_DATA_DIR;
        else process.env.CROW_DATA_DIR = prevDataDir;
      }

      const mgr = new InstanceSyncManager(IDENTITY, db, childInstanceId);
      mgr.feedsDisabled = false; // suite-env override trap (see file header)

      const PEER_ID = "peer-e2e-drain-target";
      await registerPeer(db, PEER_ID, "active");
      const captured = [];
      mgr.outFeeds.set(PEER_ID, { append: async (e) => captured.push(JSON.parse(JSON.stringify(e))) });

      const drainResult = await drainOnce(mgr, db, {});
      assert.equal(drainResult.deleted, 1, `drain should have delivered+deleted exactly 1 row: ${JSON.stringify(drainResult)}`);
      assert.equal(captured.length, 1, "the stub feed must have received exactly one entry");
      assert.equal(captured[0].table, "memories");
      assert.equal(captured[0].op, "insert");
      assert.equal(captured[0].row.id, memoryId);
      assert.equal(
        Number(captured[0].lamport_ts),
        queuedLamport,
        "the drained entry must carry the CHILD's write-time lamport (preserve-mode), not a fresh drain-time mint",
      );

      const afterDrain = await outboxRows(db, "memories");
      assert.equal(afterDrain.length, 0, "the outbox row must be gone once delivery covered every currently-paired peer");
    } catch (err) {
      if (stderrChunks.length > 0) {
        console.error("[sync-outbox-e2e] child stderr:\n" + Buffer.concat(stderrChunks).toString("utf8"));
      }
      throw err;
    } finally {
      // Kill the child even on failure — no leaked processes (hard rule).
      const pid = transport?.pid ?? null;
      try {
        if (client) await withTimeout(client.close(), 5000, "client.close()").catch(() => {});
      } catch {}
      try {
        if (transport) await withTimeout(transport.close(), 5000, "transport.close()").catch(() => {});
      } catch {}
      if (pid) {
        try {
          process.kill(pid, 0); // still alive?
          try {
            process.kill(pid, "SIGKILL");
          } catch {}
        } catch {
          // ESRCH — already gone, good.
        }
      }
      try {
        db?.close();
      } catch {}
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(crowHome, { recursive: true, force: true });
    }
  },
);

// ══════════════════════════════════════════════════════════════════════
// Test 2: mixed-doors race (spec finding-1) — preserve-mode drain +
// order-independent LWW convergence on a second instance
// ══════════════════════════════════════════════════════════════════════

test(
  "mixed-doors race: a stdio-queued stale write and a live newer write converge on the newer content regardless of wire-arrival order",
  { timeout: 20_000 },
  async () => {
    const dir1 = mkScratch("race-origin");
    runInitDb(dir1);
    const db1 = createDbClient(join(dir1, "crow.db"));
    await seedSyncDeploymentEnabled(db1);

    // emitOrQueue and InstanceSyncManager MUST mint off the SAME sync_state
    // row for L2 to be guaranteed > L1 — emitOrQueue resolves its instanceId
    // via getOrCreateLocalInstanceId() (process.env.CROW_DATA_DIR-driven);
    // the manager's instanceId is an explicit ctor arg. Point this process's
    // CROW_DATA_DIR at dir1 for the whole test and construct the manager
    // with THAT resolved id, or the two doors would silently maintain two
    // independent counters and the "L2 > L1" guarantee this whole race test
    // rests on would be an accident, not a mechanism.
    const prevDataDir = process.env.CROW_DATA_DIR;
    process.env.CROW_DATA_DIR = dir1;

    let db2 = null;
    let dir2 = null;

    try {
      const instanceId1 = getOrCreateLocalInstanceId();
      const mgr1 = new InstanceSyncManager(IDENTITY, db1, instanceId1);
      mgr1.feedsDisabled = false; // suite-env override trap

      const INSTANCE_ID_2 = "peer-mixed-doors-2";
      await registerPeer(db1, INSTANCE_ID_2, "active");
      const wire = [];
      mgr1.outFeeds.set(INSTANCE_ID_2, { append: async (e) => wire.push(JSON.parse(JSON.stringify(e))) });

      // Baseline row X, already "synced" at some earlier lamport — realistic
      // pre-race state (both the stdio queue and the live emit are UPDATEs
      // to an existing row, not fresh inserts).
      const insertResult = await db1.execute({
        sql: "INSERT INTO memories (content, category, lamport_ts) VALUES (?, ?, ?)",
        args: ["baseline", "general", 0],
      });
      const rowId = Number(insertResult.lastInsertRowid);

      // ── T0: stdio-shaped queue of OLDER content (the app-level write
      // happens first, exactly like a real call site; emitOrQueue only
      // stamps lamport_ts, never content — see servers/shared/sync-emit.js
      // subselectStampSql). null manager: the stdio door has none. ──
      await db1.execute({ sql: "UPDATE memories SET content = ? WHERE id = ?", args: ["stdio-old", rowId] });
      const queueResult = await emitOrQueue(null, db1, "memories", "update", {
        id: rowId,
        content: "stdio-old",
        category: "general",
        context: null,
        tags: null,
        source: "sync-outbox-e2e-test",
        importance: 5,
        instance_id: null,
        project_id: null,
      });
      assert.ok(queueResult && queueResult.queued === true, `expected a queue result, got: ${JSON.stringify(queueResult)}`);
      const L1 = queueResult.lamport;
      assert.ok(Number.isFinite(L1) && L1 > 0, `bad L1: ${L1}`);

      const queuedRows = await outboxRows(db1);
      assert.equal(queuedRows.length, 1);
      assert.equal(Number(queuedRows[0].lamport_ts), L1);
      assert.equal(JSON.parse(queuedRows[0].row_json).content, "stdio-old");

      const afterQueueRow = await memoryRow(db1, rowId);
      assert.equal(Number(afterQueueRow.lamport_ts), L1, "local row must be stamped L1 right after the queue write");

      // ── T1: live gateway write of NEWER content — mints L2 > L1 off the
      // SAME counter, and (non-preserve mode) DOES re-stamp the local row. ──
      await db1.execute({ sql: "UPDATE memories SET content = ? WHERE id = ?", args: ["gateway-new", rowId] });
      const ts2 = await mgr1.emitChange("memories", "update", {
        id: rowId,
        content: "gateway-new",
        category: "general",
        context: null,
        tags: null,
        source: "sync-outbox-e2e-test",
        importance: 5,
        instance_id: null,
        project_id: null,
      });
      assert.equal(typeof ts2, "number");
      const L2 = ts2;
      assert.ok(L2 > L1, `live emit must mint strictly above the queued lamport: L2=${L2} L1=${L1}`);

      assert.equal(wire.length, 1, "the live emit must have broadcast exactly one entry so far");
      assert.equal(Number(wire[0].lamport_ts), L2);
      assert.equal(wire[0].row.content, "gateway-new");

      const afterLiveRow = await memoryRow(db1, rowId);
      assert.equal(Number(afterLiveRow.lamport_ts), L2, "local row must be re-stamped to L2 by the live (non-preserve) emit");

      // ── T2: drain the queued row. Preserve-mode: the drained entry must
      // carry L1 verbatim (NOT a fresh drain-time mint), and the local row
      // must NOT be touched (stays at L2, the live write's stamp). ──
      const drainResult = await drainOnce(mgr1, db1, {});
      assert.equal(drainResult.deleted, 1, `drain should deliver+delete the queued row: ${JSON.stringify(drainResult)}`);

      const afterDrainOutbox = await outboxRows(db1);
      assert.equal(afterDrainOutbox.length, 0);

      assert.equal(wire.length, 2, "drain must have appended exactly one more entry to the feed");
      const drainedEntry = wire.find((e) => Number(e.lamport_ts) === L1);
      assert.ok(drainedEntry, `expected a wire entry carrying L1=${L1}, got lamports: ${wire.map((e) => e.lamport_ts)}`);
      assert.equal(drainedEntry.row.content, "stdio-old", "drain must preserve the queued row's OWN content, not the row's current (L2) content");

      const afterDrainRow = await memoryRow(db1, rowId);
      assert.equal(
        Number(afterDrainRow.lamport_ts),
        L2,
        "THE KEY ASSERTION: the local row must still carry the live write's L2 stamp after drain — preserve-mode must never re-stamp it",
      );

      // ── Second, independent instance: feed BOTH wire entries through its
      // real apply path, in the ACTUAL wire-arrival order (L2 went out live
      // at T1; L1 only reached the wire at T2, via drain — so L2 arrives
      // FIRST at a peer). A naive "last write wins by arrival" apply would
      // let the stale L1 entry clobber L2 here; real LWW-by-lamport must
      // reject it. ──
      dir2 = mkScratch("race-peer");
      runInitDb(dir2);
      db2 = createDbClient(join(dir2, "crow.db"));
      const mgr2 = new InstanceSyncManager(IDENTITY, db2, INSTANCE_ID_2);
      mgr2.feedsDisabled = false;

      await db2.execute({
        sql: "INSERT INTO memories (id, content, category, lamport_ts) VALUES (?, ?, ?, ?)",
        args: [rowId, "baseline", "general", 0],
      });

      const entryL2 = wire.find((e) => Number(e.lamport_ts) === L2);
      const entryL1 = wire.find((e) => Number(e.lamport_ts) === L1);
      assert.ok(entryL2 && entryL1, "both wire entries must be present before feeding the second instance");

      await mgr2._applyEntry(instanceId1, JSON.parse(JSON.stringify(entryL2)));
      const midRow = await memoryRow(db2, rowId);
      assert.equal(midRow.content, "gateway-new");
      assert.equal(Number(midRow.lamport_ts), L2);

      await mgr2._applyEntry(instanceId1, JSON.parse(JSON.stringify(entryL1)));
      const finalRow = await memoryRow(db2, rowId);
      assert.equal(
        finalRow.content,
        "gateway-new",
        "THE CONVERGENCE ASSERTION: the second instance must still hold the L2 content after the stale L1 entry arrives",
      );
      assert.equal(Number(finalRow.lamport_ts), L2, "the stale L1 apply must not move the local lamport backward");
    } finally {
      if (prevDataDir === undefined) delete process.env.CROW_DATA_DIR;
      else process.env.CROW_DATA_DIR = prevDataDir;
      try {
        db1?.close();
      } catch {}
      try {
        db2?.close();
      } catch {}
      rmSync(dir1, { recursive: true, force: true });
      if (dir2) rmSync(dir2, { recursive: true, force: true });
    }
  },
);
