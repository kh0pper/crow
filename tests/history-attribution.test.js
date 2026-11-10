/**
 * Version history, Task 2: the write context and stamping.
 *
 * The capture triggers (Task 1) record WHAT changed; nothing in SQL can know WHO
 * changed it, because they fire for every writer — including a bot on its own
 * sqlite3 connection, which is the case this feature exists for. So the author
 * travels out of band: a unit of work opens a write context
 * (servers/shared/history/write-context.js), and servers/db.js stamps the versions
 * its write produced inside the same immediate transaction.
 *
 * These tests are about exactly three things:
 *   - who gets stamped, and that a write with no context stays 'unattributed'
 *     (never 'owner');
 *   - that the stamp cannot reach anybody else's rows, cannot survive a failed
 *     write, and cannot attribute anything twice;
 *   - that a change applied from a paired instance is stamped as that peer and
 *     queues no outbound sync event (review focus 2).
 *
 * Fixtures are a real scripts/init-db.js crow.db in its own temp dir with the
 * additive 0024 migration applied (the production shape), as in
 * tests/history-capture.test.js.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import Database from "better-sqlite3";

import { createDbClient } from "../servers/db.js";
import { run as migrate } from "../scripts/migrations/0024-item-versions.mjs";
import {
  currentWriteContext,
  withWriteContext,
  jobIdFor,
  ownerWriteContext,
  botWriteContext,
  peerWriteContext,
  systemWriteContext,
  botActorWriteContext,
  sessionHash8,
} from "../servers/shared/history/write-context.js";

const REPO = new URL("..", import.meta.url).pathname;

/** A fresh crow.db (init-db.js) in its own temp dir, with 0024 applied. */
function fixture(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir, CROW_DB_PATH: "" },
    cwd: REPO,
    stdio: "pipe",
  });
  const dbPath = join(dir, "crow.db");
  migrate({ dbPath, log: () => {} });
  return {
    dir,
    dbPath,
    dispose() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The version rows for one item, oldest first. */
async function versionsOf(client, itemType, itemId) {
  const { rows } = await client.execute({
    sql: `SELECT op, author_kind, author_id, job_id, origin_instance
            FROM item_versions WHERE item_type = ? AND item_id = ? ORDER BY id`,
    args: [itemType, String(itemId)],
  });
  return rows;
}

/** A second, raw connection — a bot's own sqlite3 client (no write context). */
function rawHandle(dbPath) {
  const raw = new Database(dbPath);
  raw.pragma("busy_timeout = 10000");
  return raw;
}

const insertMemory = (client, content) =>
  client.execute({ sql: "INSERT INTO memories (content, category) VALUES (?, 'general')", args: [content] });

/* ------------------------------------------------ who gets stamped */

test("a write inside withWriteContext({authorKind:'bot', authorId:'b1', jobId:'card:7'}) is stamped bot/b1/card:7", async () => {
  const fx = fixture("hist-attr-bot-");
  const db = createDbClient(fx.dbPath);
  try {
    let seen = null;
    const res = await withWriteContext({ authorKind: "bot", authorId: "b1", jobId: "card:7" }, () => {
      seen = currentWriteContext();
      return insertMemory(db, "a note a bot wrote");
    });
    assert.deepEqual(
      seen,
      { authorKind: "bot", authorId: "b1", jobId: "card:7", originInstance: null },
      "the context is readable inside the work it wraps",
    );

    const rows = await versionsOf(db, "memory", res.lastInsertRowid);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].op, "insert");
    assert.equal(rows[0].author_kind, "bot");
    assert.equal(rows[0].author_id, "b1");
    assert.equal(rows[0].job_id, "card:7");
    assert.equal(rows[0].origin_instance, null, "a local write has no origin machine");
  } finally {
    db.close();
    fx.dispose();
  }
});

test("a write outside any context stays unattributed, never the owner", async () => {
  const fx = fixture("hist-attr-none-");
  const db = createDbClient(fx.dbPath);
  try {
    assert.equal(currentWriteContext(), null, "no context is active to begin with");
    const res = await insertMemory(db, "written by nobody in particular");
    const rows = await versionsOf(db, "memory", res.lastInsertRowid);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].author_kind, "unattributed");
    assert.equal(rows[0].author_id, null);
    assert.equal(rows[0].job_id, null);
  } finally {
    db.close();
    fx.dispose();
  }
});

test("a raw second better-sqlite3 connection stays unattributed even while a context is active on the gateway connection", async () => {
  const fx = fixture("hist-attr-raw-");
  const db = createDbClient(fx.dbPath);
  try {
    let rawId = null;
    const through = await withWriteContext({ authorKind: "bot", authorId: "b1", jobId: "card:7" }, async () => {
      // A bot writing with its own sqlite3 client: no context can reach it, which
      // is precisely why an unattributed version must stay honest rather than be
      // guessed at.
      const raw = rawHandle(fx.dbPath);
      try {
        rawId = raw.prepare("INSERT INTO memories (content) VALUES (?)").run("straight to the file").lastInsertRowid;
      } finally {
        raw.close();
      }
      return insertMemory(db, "through the gateway");
    });

    const rawRows = await versionsOf(db, "memory", rawId);
    assert.equal(rawRows.length, 1, "the raw write is still captured by the trigger");
    assert.equal(rawRows[0].author_kind, "unattributed", "a raw connection is never stamped");
    assert.equal(rawRows[0].author_id, null);

    const gatewayRows = await versionsOf(db, "memory", through.lastInsertRowid);
    assert.equal(gatewayRows[0].author_kind, "bot", "the same context stamped the gateway's own write");
    assert.equal(gatewayRows[0].author_id, "b1");
  } finally {
    db.close();
    fx.dispose();
  }
});

test("a failed write in a context stamps nothing", async () => {
  const fx = fixture("hist-attr-fail-");
  const db = createDbClient(fx.dbPath);
  try {
    const before = (await db.execute({ sql: "SELECT COUNT(*) AS n FROM item_versions", args: [] })).rows[0].n;

    await withWriteContext({ authorKind: "bot", authorId: "b1", jobId: "card:7" }, async () => {
      // memories.content is NOT NULL: this write fails at SQLite.
      await assert.rejects(
        () => db.execute({ sql: "INSERT INTO memories (content) VALUES (?)", args: [null] }),
        /NOT NULL|constraint/i,
      );
      // A batch that fails on its second statement rolls back the whole batch,
      // including the version the first statement's trigger wrote.
      await assert.rejects(
        () =>
          db.batch([
            { sql: "INSERT INTO memories (content) VALUES ('half a batch')", args: [] },
            { sql: "INSERT INTO memories (content) VALUES (?)", args: [null] },
          ]),
        /NOT NULL|constraint/i,
      );
    });

    const after = (await db.execute({ sql: "SELECT COUNT(*) AS n FROM item_versions", args: [] })).rows[0].n;
    assert.equal(Number(after), Number(before), "no version row survived a failed write");
    const memories = (await db.execute({ sql: "SELECT COUNT(*) AS n FROM memories", args: [] })).rows[0].n;
    assert.equal(Number(memories), 0, "and nothing was written, so there is nothing to stamp");
  } finally {
    db.close();
    fx.dispose();
  }
});

test("nested contexts: the inner one wins", async () => {
  const fx = fixture("hist-attr-nested-");
  const db = createDbClient(fx.dbPath);
  try {
    const outer = ownerWriteContext("a-session-token");
    const inner = systemWriteContext(9);

    let innerWrite;
    let afterInner;
    await withWriteContext(outer, async () => {
      innerWrite = await withWriteContext(inner, () => insertMemory(db, "the schedule's write"));
      afterInner = await insertMemory(db, "back in the request");
    });

    const innerRows = await versionsOf(db, "memory", innerWrite.lastInsertRowid);
    assert.equal(innerRows[0].author_kind, "system", "the inner context replaced the outer author");
    assert.equal(innerRows[0].author_id, "9");
    assert.equal(innerRows[0].job_id, "schedule:9");

    const outerRows = await versionsOf(db, "memory", afterInner.lastInsertRowid);
    assert.equal(outerRows[0].author_kind, "owner", "and the outer one is back afterwards");
    assert.equal(outerRows[0].author_id, outer.authorId);

    // Field by field: a nested context that names only the author keeps the outer
    // job, so an inner scope narrows the author without losing the unit of work.
    let narrowed;
    await withWriteContext(outer, async () => {
      narrowed = await withWriteContext({ authorKind: "bot", authorId: "b2" }, () =>
        insertMemory(db, "narrowed author"),
      );
    });
    const narrowedRows = await versionsOf(db, "memory", narrowed.lastInsertRowid);
    assert.equal(narrowedRows[0].author_kind, "bot");
    assert.equal(narrowedRows[0].author_id, "b2");
    assert.equal(narrowedRows[0].job_id, outer.jobId, "the outer job survives a context that names none");
  } finally {
    db.close();
    fx.dispose();
  }
});

test("a malformed context never throws and never attributes", async () => {
  const fx = fixture("hist-attr-malformed-");
  const db = createDbClient(fx.dbPath);
  try {
    for (const junk of [null, undefined, "bot", 42, [], {}, { authorKind: "admin" }, { authorKind: "unattributed" }]) {
      const res = await withWriteContext(junk, () => insertMemory(db, `junk ${JSON.stringify(junk)}`));
      const rows = await versionsOf(db, "memory", res.lastInsertRowid);
      assert.equal(rows[0].author_kind, "unattributed", `${JSON.stringify(junk)} attributed nothing`);
    }
    const res = await withWriteContext({ authorKind: "bot", authorId: "b1" }, () => 42);
    assert.equal(res, 42, "the work still runs and its result is returned");
  } finally {
    db.close();
    fx.dispose();
  }
});

test("a store without item_versions writes exactly as before", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hist-attr-nomig-"));
  try {
    execFileSync(process.execPath, ["scripts/init-db.js"], {
      env: { ...process.env, CROW_DATA_DIR: dir, CROW_DB_PATH: "" },
      cwd: REPO,
      stdio: "pipe",
    });
    const db = createDbClient(join(dir, "crow.db"));
    try {
      const res = await withWriteContext({ authorKind: "bot", authorId: "b1" }, () =>
        insertMemory(db, "before the migration ran"),
      );
      assert.ok(Number(res.lastInsertRowid) > 0, "the write succeeds on an unmigrated store");
      const row = (await db.execute({ sql: "SELECT content FROM memories WHERE id = ?", args: [res.lastInsertRowid] })).rows[0];
      assert.equal(row.content, "before the migration ran");
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a batch and a RETURNING write inside a context are stamped, in the same transaction", async () => {
  const fx = fixture("hist-attr-batch-");
  const db = createDbClient(fx.dbPath);
  try {
    const ctx = { authorKind: "bot", authorId: "b3", jobId: "handoff:2" };

    // batch(): every statement AND the stamp are one transaction.
    const batch = await withWriteContext(ctx, () =>
      db.batch([
        { sql: "INSERT INTO memories (content) VALUES ('batch one')", args: [] },
        { sql: "INSERT INTO memories (content) VALUES ('batch two')", args: [] },
      ]),
    );
    assert.equal(batch.length, 2);
    for (const row of batch) {
      assert.equal(row.rowsAffected, 1);
      const versions = await versionsOf(db, "memory", row.lastInsertRowid);
      assert.equal(versions[0].author_kind, "bot");
      assert.equal(versions[0].author_id, "b3");
      assert.equal(versions[0].job_id, "handoff:2");
    }

    // INSERT ... RETURNING is a reader to better-sqlite3 but still a write.
    const returned = await withWriteContext(ctx, () =>
      db.execute({ sql: "INSERT INTO memories (content) VALUES (?) RETURNING id", args: ["returning write"] }),
    );
    const id = returned.rows[0].id;
    const returningVersions = await versionsOf(db, "memory", id);
    assert.equal(returningVersions.length, 1);
    assert.equal(returningVersions[0].author_kind, "bot", "a RETURNING write is stamped too");
    assert.equal(returningVersions[0].author_id, "b3");
  } finally {
    db.close();
    fx.dispose();
  }
});

/* ------------------------------------------------------------ sync */

test("a sync-applied memory update is stamped peer with origin_instance, and the outbound sync queue gains no new event (review focus 2)", async () => {
  const fx = fixture("hist-attr-sync-");
  const seed = rawHandle(fx.dbPath);
  const info = seed
    .prepare("INSERT INTO memories (content, category, lamport_ts) VALUES ('local words', 'general', 1)")
    .run();
  seed.close();
  const memoryId = Number(info.lastInsertRowid);

  const { InstanceSyncManager, SYNCED_TABLES } = await import("../servers/sharing/instance-sync.js");
  const { sign } = await import("../servers/sharing/identity.js");
  const ed = await import("../node_modules/@noble/ed25519/index.js");

  const priv = Buffer.alloc(32, 0xab); // deterministic test identity, as in tests/instance-sync.test.js
  const identity = { ed25519Priv: priv, ed25519Pubkey: Buffer.from(await ed.getPublicKey(priv)).toString("hex") };
  const LOCAL_ID = "aaaaaaaa-0000-0000-0000-000000000001";
  const PEER_ID = "bbbbbbbb-0000-0000-0000-000000000002";

  const db = createDbClient(fx.dbPath);
  try {
    const mgr = new InstanceSyncManager(identity, db, LOCAL_ID);
    mgr.feedsDisabled = false; // the scratch env disables feeds; these are stub feeds
    const emitted = [];
    const origEmit = mgr.emitChange.bind(mgr);
    mgr.emitChange = (...args) => {
      emitted.push(args[0]);
      return origEmit(...args);
    };
    // PT-1: entries apply only from a trusted, live paired peer. Pair the stub
    // peer for this test (fixture, not gate).
    await db.execute({
      sql: "INSERT OR IGNORE INTO crow_instances (id, name, crow_id, status, trusted) VALUES (?, ?, 'crow:stub', 'active', 1)",
      args: [PEER_ID, PEER_ID],
    });

    const entry = {
      table: "memories",
      op: "update",
      row: { id: memoryId, content: "edited on the other machine", category: "general" },
      lamport_ts: 100,
      instance_id: PEER_ID,
    };
    const signed = { ...entry, signature: sign(JSON.stringify(entry), priv) };
    const key = Buffer.alloc(32, 0x07);
    const feed = {
      key,
      entries: [signed],
      get length() {
        return feed.entries.length;
      },
      async get(seq) {
        return feed.entries[seq];
      },
    };
    await mgr._processNewEntries(PEER_ID, feed);

    const local = (await db.execute({ sql: "SELECT content FROM memories WHERE id = ?", args: [memoryId] })).rows[0];
    assert.equal(local.content, "edited on the other machine", "the peer's change was applied");

    const rows = await versionsOf(db, "memory", memoryId);
    const update = rows.at(-1);
    assert.equal(update.op, "update");
    assert.equal(update.author_kind, "peer", "a change from another machine is never the owner's");
    assert.equal(update.author_id, PEER_ID, "the author is the peer instance id");
    assert.equal(update.origin_instance, PEER_ID, "and so is the origin");
    assert.ok(
      rows.every((r) => r.author_kind !== "owner"),
      "nothing in an applied change is attributed to the owner",
    );

    assert.deepEqual(emitted, [], "applying a peer's change queues no outbound event");
    assert.ok(!SYNCED_TABLES.includes("item_versions"), "item_versions itself never syncs");
  } finally {
    db.close();
    fx.dispose();
  }
});

/* ------------------------------------------------------- job ids & authors */

test("jobIdFor follows the precedence", () => {
  assert.equal(jobIdFor({ cardId: 7, handoffId: 3, threadId: "t-1", sessionHash: "abcd1234" }), "card:7");
  assert.equal(jobIdFor({ handoffId: 3, threadId: "t-1", sessionHash: "abcd1234" }), "handoff:3");
  assert.equal(jobIdFor({ threadId: "t-1", sessionHash: "abcd1234" }), "turn:t-1");
  assert.equal(jobIdFor({ sessionHash: "abcd1234" }), "session:abcd1234");
  assert.equal(jobIdFor({}), null, "no job is no job, not an invented one");
  assert.equal(jobIdFor(), null);
  assert.equal(jobIdFor({ cardId: "", threadId: "  " }), null, "blank ids name nothing");

  // The three context builders the four sources use.
  assert.equal(botActorWriteContext({ kind: "bot", id: "hank", jobId: "12", thread: null }).jobId, "card:12");
  assert.equal(
    botActorWriteContext({ kind: "bot", id: "hank", jobId: null, thread: { id: "perch-3", gateway: "perch" } }).jobId,
    "turn:perch-3",
  );
  assert.equal(botActorWriteContext({ kind: "bot", id: "", jobId: "12" }), null, "an unverified actor has no author");
  assert.equal(botActorWriteContext({ kind: "session", id: null }), null, "a token holder is not an author on this rail");
  assert.deepEqual(peerWriteContext("inst-b"), { authorKind: "peer", authorId: "inst-b", originInstance: "inst-b" });
  assert.deepEqual(systemWriteContext(4), { authorKind: "system", authorId: "4", jobId: "schedule:4" });
  assert.deepEqual(systemWriteContext(), { authorKind: "system" }, "a system sweep with no schedule names no job");
  assert.equal(botWriteContext(null), null);
});

test("the dashboard author is a session hash prefix, never a name", async () => {
  const token = randomBytes(32).toString("hex"); // what the session cookie holds
  const hash = createHash("sha256").update(token).digest("hex");
  const ctx = ownerWriteContext(token);

  assert.equal(ctx.authorKind, "owner");
  assert.equal(ctx.authorId, hash.slice(0, 8));
  assert.match(ctx.authorId, /^[0-9a-f]{8}$/, "an 8-hex prefix, nothing more");
  assert.equal(ctx.jobId, `session:${hash.slice(0, 8)}`, "the owner's edits group per sign-in");
  assert.notEqual(ctx.authorId, token, "never the raw session id");
  assert.ok(!ctx.authorId.includes(token.slice(0, 8)), "and never a slice of it either");
  assert.equal(ownerWriteContext(undefined), null, "a request with no session has no author");
  assert.equal(sessionHash8(""), null);

  // Two sign-ins are two authors, and the same sign-in is stable.
  const other = ownerWriteContext(randomBytes(32).toString("hex"));
  assert.notEqual(other.authorId, ctx.authorId);
  assert.equal(ownerWriteContext(token).authorId, ctx.authorId);

  // End to end through the real dashboard middleware: the request's write — made
  // on a client opened inside the request, as the panels do — is stamped with that
  // prefix. No socket is opened: the middleware is called with a request shaped
  // like the tailnet one Express hands it (the network gate is tests/auth-network.test.js).
  const fx = fixture("hist-attr-dashboard-");
  const { dashboardAuth, hashToken } = await import("../servers/gateway/dashboard/auth.js");
  const seed = rawHandle(fx.dbPath);
  seed
    .prepare(
      "INSERT INTO oauth_tokens (token, token_type, client_id, scopes, expires_at) VALUES (?, 'access', 'dashboard', 'dashboard', datetime('now', '+1 day'))",
    )
    .run(hashToken(token));
  seed.close();

  const previousDbPath = process.env.CROW_DB_PATH;
  process.env.CROW_DB_PATH = fx.dbPath; // verifySession() opens its own client
  try {
    const req = {
      headers: { cookie: `crow_session=${token}` },
      get(name) {
        return this.headers[String(name).toLowerCase()];
      },
      socket: { remoteAddress: "100.64.20.5" }, // the owner's tailnet client
      connection: { remoteAddress: "100.64.20.5" },
    };
    const res = { redirectAfterPost: (to) => assert.fail(`redirected to ${to} instead of running the request`) };
    let writtenId = null;
    await new Promise((resolve, reject) => {
      dashboardAuth(req, res, () => {
        const db = createDbClient();
        insertMemory(db, "saved in the dashboard")
          .then((r) => {
            writtenId = Number(r.lastInsertRowid);
            db.close();
            resolve();
          }, reject);
      });
    });
    assert.ok(writtenId, "the request ran");

    const db = createDbClient(fx.dbPath);
    try {
      const rows = await versionsOf(db, "memory", writtenId);
      assert.equal(rows[0].author_kind, "owner");
      assert.equal(rows[0].author_id, hash.slice(0, 8), "the session hash prefix, and nothing else");
      assert.equal(rows[0].job_id, `session:${hash.slice(0, 8)}`);
      assert.ok(!JSON.stringify(rows[0]).includes(token), "the session token is never written to history");
    } finally {
      db.close();
    }
  } finally {
    if (previousDbPath === undefined) delete process.env.CROW_DB_PATH;
    else process.env.CROW_DB_PATH = previousDbPath;
    fx.dispose();
  }
});

/* ------------------------------------------------------------ performance */

test("the stamp adds less than 1 ms per write", async () => {
  const fx = fixture("hist-attr-perf-");
  const db = createDbClient(fx.dbPath);
  try {
    const seed = await insertMemory(db, "perf seed");
    const id = Number(seed.lastInsertRowid);
    const update = (content) => db.execute({ sql: "UPDATE memories SET content = ? WHERE id = ?", args: [content, id] });
    for (let i = 0; i < 20; i++) await update(`warm-up ${i}`); // JIT / page-cache warm-up

    const N = 500;
    const versionsBefore = Number(
      (await db.execute({ sql: "SELECT COUNT(*) AS n FROM item_versions", args: [] })).rows[0].n,
    );

    const t0 = performance.now();
    for (let i = 0; i < N; i++) await update(`unattributed edit ${i}`);
    const plainPerWrite = (performance.now() - t0) / N;

    const t1 = performance.now();
    await withWriteContext({ authorKind: "bot", authorId: "b1", jobId: "card:7" }, async () => {
      for (let i = 0; i < N; i++) await update(`stamped edit ${i}`);
    });
    const stampedPerWrite = (performance.now() - t1) / N;

    const versionsAfter = Number(
      (await db.execute({ sql: "SELECT COUNT(*) AS n FROM item_versions", args: [] })).rows[0].n,
    );
    const stampedRows = (
      await db.execute({
        sql: "SELECT COUNT(*) AS n FROM item_versions WHERE author_kind = 'bot' AND author_id = 'b1'",
        args: [],
      })
    ).rows[0].n;

    // Both numbers are the report: the budget is about the delta.
    console.log(
      `[history-attribution] ${N} writes — no context: ${plainPerWrite.toFixed(4)} ms/write, ` +
        `with a context: ${stampedPerWrite.toFixed(4)} ms/write, ` +
        `stamp overhead: ${(stampedPerWrite - plainPerWrite).toFixed(4)} ms/write ` +
        `(${versionsAfter - versionsBefore} new version rows, ${stampedRows} of them stamped)`,
    );

    assert.equal(versionsAfter - versionsBefore, N * 2, "every write was captured (both loops)");
    assert.equal(Number(stampedRows), N, "every write inside the context was stamped");
    assert.ok(
      stampedPerWrite - plainPerWrite < 1,
      `the stamp must stay under ~1 ms/write, measured ${(stampedPerWrite - plainPerWrite).toFixed(4)} ms`,
    );
  } finally {
    db.close();
    fx.dispose();
  }
});