/**
 * Tests for servers/shared/sync-stamp.js — the shared stamping module
 * (stdio-sync-outbox Task 1).
 *
 * Scope: the module's own behavior in isolation — instance-sync.js's
 * delegation is proven byte-identical separately by the existing
 * tests/instance-sync.test.js run (see task-1-report.md for that evidence).
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync, symlinkSync, lstatSync, existsSync,
  utimesSync, lutimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { createDbClient } from "../servers/db.js";
import { getOrCreateLocalInstanceId } from "../servers/gateway/instance-registry.js";
import {
  ensureSyncTables,
  mintLamport,
  advanceCounter,
  stampSql,
  seedCounterSql,
  bumpCounterSql,
} from "../servers/shared/sync-stamp.js";

const tmpDir = mkdtempSync(join(tmpdir(), "crow-sync-stamp-test-"));

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Collapse whitespace so SQL-string assertions aren't brittle to indentation. */
function normSql(sql) {
  return sql.replace(/\s+/g, " ").trim();
}

// ── ensureSyncTables ─────────────────────────────────────────────────────

test("ensureSyncTables: creates sync_state + sync_outbox, idempotent on re-run", async () => {
  const dbPath = join(tmpDir, "ensure.db");
  const db = createDbClient(dbPath);

  await ensureSyncTables(db);
  await ensureSyncTables(db); // must not throw — IF NOT EXISTS

  const { rows } = await db.execute({
    sql: "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('sync_state','sync_outbox') ORDER BY name",
    args: [],
  });
  assert.deepEqual(rows.map((r) => r.name), ["sync_outbox", "sync_state"]);
  db.close();
});

// ── mintLamport ──────────────────────────────────────────────────────────

test("mintLamport: monotonic + unique across two SEPARATE createDbClient connections, and advanceCounter MAX-floor never regresses", async () => {
  const dbPath = join(tmpDir, "mint.db");
  const dbA = createDbClient(dbPath);
  const dbB = createDbClient(dbPath);
  await ensureSyncTables(dbA);

  const instanceId = "inst-mint-1";

  // Interleave 25 mints from each of two independent connections to the
  // same db file — the in-process approximation of the cross-process shape
  // (gateway process + stdio-mounted process both minting against one db).
  const results = await Promise.all([
    ...Array.from({ length: 25 }, () => mintLamport(dbA, instanceId)),
    ...Array.from({ length: 25 }, () => mintLamport(dbB, instanceId)),
  ]);

  const unique = new Set(results);
  assert.equal(unique.size, 50, "all 50 mints must be unique");
  assert.deepEqual(
    [...results].sort((a, b) => a - b),
    Array.from({ length: 50 }, (_, i) => i + 1),
    "mints must cover 1..50 with no gaps",
  );

  const current = Math.max(...results); // 50

  // A floor BELOW the current counter must not regress it (MAX, not SET).
  await advanceCounter(dbA, instanceId, 10);
  const afterLowFloor = await mintLamport(dbB, instanceId);
  assert.equal(afterLowFloor, current + 1, "a low floor must not regress the counter");

  // A floor ABOVE the current counter must push future mints past it.
  await advanceCounter(dbA, instanceId, 1000);
  const afterHighFloor = await mintLamport(dbB, instanceId);
  assert.equal(afterHighFloor, 1002, "a high floor must strictly exceed the floor value");

  dbA.close();
  dbB.close();
});

test("mintLamport: mints against a fresh (unseeded) instance_id without a pre-existing sync_state row", async () => {
  const dbPath = join(tmpDir, "mint-fresh.db");
  const db = createDbClient(dbPath);
  await ensureSyncTables(db);

  const first = await mintLamport(db, "brand-new-instance");
  assert.equal(first, 1, "first mint against an unseeded row must be 1, not NULL/skip");

  db.close();
});

// ── seedCounterSql / bumpCounterSql (statement builders Task 2 composes from) ──

test("seedCounterSql / bumpCounterSql: return {sql, args} shapes usable standalone in a db.batch()", async () => {
  const dbPath = join(tmpDir, "builders.db");
  const db = createDbClient(dbPath);
  await ensureSyncTables(db);

  const instanceId = "inst-builders-1";
  const seed = seedCounterSql(instanceId);
  const bump = bumpCounterSql(instanceId);

  assert.equal(typeof seed.sql, "string");
  assert.deepEqual(seed.args, [instanceId]);
  assert.equal(typeof bump.sql, "string");
  assert.deepEqual(bump.args, [instanceId]);

  // Composing them manually (as Task 2's batch will) must behave the same
  // as calling mintLamport.
  await db.batch([seed, bump]);
  const { rows } = await db.execute({
    sql: "SELECT local_counter FROM sync_state WHERE instance_id = ?",
    args: [instanceId],
  });
  assert.equal(Number(rows[0].local_counter), 1);

  db.close();
});

// ── stampSql ─────────────────────────────────────────────────────────────

test("stampSql: dashboard_settings stamps by key", () => {
  const result = stampSql("dashboard_settings", { key: "theme", value: "dark" }, 42);
  assert.equal(normSql(result.sql), normSql("UPDATE dashboard_settings SET lamport_ts = ? WHERE key = ?"));
  assert.deepEqual(result.args, [42, "theme"]);
});

test("stampSql: crow_context stamps by composite key w/ MAX(COALESCE())", () => {
  const result = stampSql(
    "crow_context",
    { section_key: "identity", device_id: null, project_id: "proj-1" },
    7,
  );
  assert.equal(
    normSql(result.sql),
    normSql(`UPDATE crow_context SET lamport_ts = MAX(COALESCE(lamport_ts, 0), ?)
              WHERE section_key = ? AND device_id IS ? AND project_id IS ?`),
  );
  assert.deepEqual(result.args, [7, "identity", null, "proj-1"]);
});

test("stampSql: falls back to stamping by id for a generic table", () => {
  const result = stampSql("memories", { id: 5, content: "hi" }, 3);
  assert.equal(normSql(result.sql), normSql("UPDATE memories SET lamport_ts = ? WHERE id = ?"));
  assert.deepEqual(result.args, [3, 5]);
});

test("stampSql: returns null for a delete-shaped row (no id, no key, no section_key)", () => {
  assert.equal(stampSql("contacts", { crow_id: "abc-123" }, 9), null);
});

test("stampSql: returns null for an unknown table with no id", () => {
  assert.equal(stampSql("some_unmapped_table", { name: "x" }, 1), null);
});

// ── getOrCreateLocalInstanceId: first-ever-boot race + the empty-file window ──

/**
 * getOrCreateLocalInstanceId publishes <data dir>/instance-id ATOMICALLY (temp file
 * + link) and RETRIES an empty read, so a second process racing a first-ever boot
 * can never observe a half-written id. The CI failure these tests pin: the old
 * O_EXCL create made the file exist empty and wrote the id afterwards, so the loser
 * read "" and threw INSTANCE_ID_UNREADABLE.
 */

/** Fresh data dirs (= fresh first-ever boots) crossed by two racer processes each. */
const RACE_ROUNDS = 10;

/** The CROW_* identity env this file borrows and must put back. */
const IDENTITY_ENV_KEYS = ["CROW_DATA_DIR", "CROW_LOCAL_INSTANCE_ID"];

/**
 * Run `fn` with CROW_DATA_DIR → dir and NO CROW_LOCAL_INSTANCE_ID: a suite-wide env
 * id would otherwise answer for a file the test needs the reader to read.
 */
async function inScratchDataDir(dir, fn) {
  const saved = IDENTITY_ENV_KEYS.map((key) => [key, process.env[key]]);
  process.env.CROW_DATA_DIR = dir;
  delete process.env.CROW_LOCAL_INSTANCE_ID;
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/**
 * Arm the delayed-writer worker: it reports "armed", and on "go" writes `id` into
 * `idPath` after `delayMs`. The caller runs the (synchronous) reader right after
 * arming, so the reader's first read lands in the empty window while the worker's
 * write lands comfortably inside its ~200 ms retry budget.
 */
async function armDelayedWriter({ idPath, id, delayMs }) {
  const worker = new Worker(new URL("./fixtures/instance-id-delayed-writer.mjs", import.meta.url), {
    workerData: { idPath, id, delayMs },
  });
  try {
    const armed = await new Promise((resolveArmed, reject) => {
      worker.once("message", resolveArmed);
      worker.once("error", reject);
      worker.once("exit", (code) => reject(new Error(`the delayed-writer fixture exited ${code} before arming`)));
    });
    assert.equal(armed, "armed", "the fixture must arm before the reader runs");
  } catch (err) {
    await worker.terminate();
    throw err;
  }
  worker.postMessage("go");
  return worker;
}

/** The racer fixture, run as its own process; `args` reach it as argv (e.g. --no-hardlinks). */
const RACER_FIXTURE = fileURLToPath(new URL("./fixtures/instance-id-racer.mjs", import.meta.url));

function runRacer(raceDir, args = []) {
  return new Promise((resolvePromise, reject) => {
    const env = { ...process.env, CROW_DATA_DIR: raceDir };
    // The file they race over must be the racers' only identity source, or a
    // broken read in the loser would be masked by the suite's env id.
    delete env.CROW_LOCAL_INSTANCE_ID;
    const child = spawn(process.execPath, [RACER_FIXTURE, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`racer exited ${code}: ${err}`));
      resolvePromise(out.trim());
    });
    child.on("error", reject);
  });
}

test(`getOrCreateLocalInstanceId: concurrent first-ever boot — both racers return the SAME id (${RACE_ROUNDS} fresh rounds)`, async () => {
  for (let round = 1; round <= RACE_ROUNDS; round++) {
    const raceDir = mkdtempSync(join(tmpdir(), "crow-instanceid-race-"));
    try {
      const [idA, idB] = await Promise.all([runRacer(raceDir), runRacer(raceDir)]);

      assert.match(idA, /^[0-9a-f]{32}$/, `round ${round}: racer A must return a 32-hex id, got ${JSON.stringify(idA)}`);
      assert.match(idB, /^[0-9a-f]{32}$/, `round ${round}: racer B must return a 32-hex id, got ${JSON.stringify(idB)}`);
      // The real assertion: both racers RETURN the same id. A file-content-only
      // check (reading instance-id after both exit) passes vacuously even when
      // the two in-flight processes disagreed — both "succeeded" with different
      // ids while whichever wrote last silently overwrote the file.
      assert.equal(idA, idB, `round ${round}: both concurrent racers must observe the SAME winning id`);
      assert.equal(
        readFileSync(join(raceDir, "instance-id"), "utf-8").trim(), idA,
        `round ${round}: the file on disk holds the id both racers returned`,
      );
      assert.deepEqual(
        readdirSync(raceDir).filter((name) => name.endsWith(".tmp")), [],
        `round ${round}: the atomic publish leaves no temp file behind`,
      );
    } finally {
      rmSync(raceDir, { recursive: true, force: true });
    }
  }
});

test("getOrCreateLocalInstanceId: a reader that finds the file briefly EMPTY retries and returns the id (no throw)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "crow-instanceid-empty-"));
  const idPath = join(dir, "instance-id");
  const winnerId = "0123456789abcdef0123456789abcdef";
  // The exact shape an OLD (non-atomic) writer leaves in its window: the file
  // exists and is empty, and the id lands a moment later.
  writeFileSync(idPath, "");

  let worker;
  try {
    await inScratchDataDir(dir, async () => {
      worker = await armDelayedWriter({ idPath, id: winnerId, delayMs: 5 });
      // Start the reader's ~2 s "this entry is being written" window at the call, not
      // at worker startup: on a loaded box arming a worker can take a while, and the
      // empty file was created before it.
      lutimesSync(idPath, new Date(), new Date());
      assert.equal(existsSync(idPath), true, "precondition: the file exists");
      assert.equal(readFileSync(idPath, "utf-8"), "", "precondition: the reader starts from an empty file");

      const got = getOrCreateLocalInstanceId(); // blocks in the retry loop while the worker writes

      assert.equal(got, winnerId, "the reader must return the id written into the window, not throw INSTANCE_ID_UNREADABLE");
    });
  } finally {
    if (worker) await worker.terminate();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getOrCreateLocalInstanceId: a create loser (EEXIST) returns the winner's id, never a read of the empty winner", async () => {
  const dir = mkdtempSync(join(tmpdir(), "crow-instanceid-eexist-"));
  const idPath = join(dir, "instance-id");
  const winnerPath = join(dir, "winner-instance-id");
  const winnerId = "fedcba9876543210fedcba9876543210";
  // A DANGLING SYMLINK pins the EEXIST branch deterministically: existsSync() is
  // false (it follows the link to a missing target), so the create path runs,
  // while link(tmp, idPath) still sees the existing entry and fails EEXIST —
  // exactly what a losing racer sees. The winner's file then appears where the
  // link points, a moment later, and must be what the loser returns.
  symlinkSync(winnerPath, idPath);

  let worker;
  try {
    await inScratchDataDir(dir, async () => {
      assert.equal(existsSync(idPath), false, "precondition: existsSync() is false, so the create path runs");
      assert.equal(lstatSync(idPath).isSymbolicLink(), true, "precondition: the create target entry exists");

      worker = await armDelayedWriter({ idPath: winnerPath, id: winnerId, delayMs: 5 });
      // Same as above, for the LINK's own mtime (lutimes: never follows the target).
      lutimesSync(idPath, new Date(), new Date());

      const got = getOrCreateLocalInstanceId();

      assert.equal(got, winnerId, "the loser must return the id the winner published, never \"\"");
      assert.deepEqual(
        readdirSync(dir).filter((name) => name.endsWith(".tmp")), [],
        "the losing publish unlinks its temp file",
      );
    });
  } finally {
    if (worker) await worker.terminate();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getOrCreateLocalInstanceId: a create loser whose target never yields an id throws INSTANCE_ID_UNREADABLE, never \"\"", async () => {
  const dir = mkdtempSync(join(tmpdir(), "crow-instanceid-eexist-empty-"));
  const idPath = join(dir, "instance-id");
  symlinkSync(join(dir, "winner-never-written"), idPath);
  try {
    await inScratchDataDir(dir, async () => {
      assert.equal(existsSync(idPath), false, "precondition: the create path runs");

      let returned;
      assert.throws(
        () => { returned = getOrCreateLocalInstanceId(); },
        (err) => {
          assert.equal(err.code, "INSTANCE_ID_UNREADABLE", "an id-less target is the operator-facing failure, not a silent empty id");
          assert.match(err.message, /refusing to invent one/, "the operator-facing text is unchanged");
          return true;
        },
      );
      assert.equal(returned, undefined, "no value — in particular no empty id — escapes the loser");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getOrCreateLocalInstanceId: an empty id file AT REST is not waited on (no ~200 ms stall on a per-request path)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "crow-instanceid-at-rest-"));
  const idPath = join(dir, "instance-id");
  const envId = "0123456789abcdef0123456789abcdef";
  writeFileSync(idPath, "");
  // Nothing is writing this file: push its mtime well outside the ~2 s write window,
  // which is what a crash leftover or a genuinely empty id looks like at rest — and
  // what an add-on wall's masked /dev/null reads as too. This function is called on
  // every dashboard panel read, so waiting out the retry budget each time is a stall.
  const longAgo = new Date(Date.now() - 60_000);
  utimesSync(idPath, longAgo, longAgo);
  try {
    await inScratchDataDir(dir, async () => {
      let started = Date.now();
      assert.throws(() => getOrCreateLocalInstanceId(), { code: "INSTANCE_ID_UNREADABLE" });
      const thrownIn = Date.now() - started;
      assert.ok(thrownIn < 50, `an empty file at rest must not be retried; the call took ${thrownIn} ms`);

      process.env.CROW_LOCAL_INSTANCE_ID = envId;
      started = Date.now();
      assert.equal(getOrCreateLocalInstanceId(), envId, "the id the gateway handed this process answers, as before");
      const resolvedIn = Date.now() - started;
      assert.ok(resolvedIn < 50, `an empty file at rest must not be retried; the call took ${resolvedIn} ms`);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A link(2) that fails for a reason that is NOT a lost race (ENOSPC). With `winnerId`
 * set it also publishes that id first, which is the whole window being simulated: a
 * racer published while OUR publish failed for an unrelated reason.
 */
function failingLink(winnerId) {
  return (_tmpPath, idPath) => {
    if (winnerId) writeFileSync(idPath, winnerId, "utf-8");
    const err = new Error("ENOSPC: no space left on device, link");
    err.code = "ENOSPC";
    throw err;
  };
}

test("getOrCreateLocalInstanceId: a publish that FAILS for a non-race reason returns the id that is on disk", async () => {
  const dir = mkdtempSync(join(tmpdir(), "crow-instanceid-enospc-"));
  const winnerId = "abcdef0123456789abcdef0123456789";
  try {
    await inScratchDataDir(dir, async () => {
      assert.equal(existsSync(join(dir, "instance-id")), false, "precondition: the create path runs (no id file yet)");
      // The id on disk is the instance's identity. The in-memory mint must NOT be
      // returned over it: nobody saved that one, so every per-instance setting
      // would read as unset against it.
      const got = getOrCreateLocalInstanceId({ link: failingLink(winnerId) });
      assert.equal(got, winnerId, "the published id wins over an id nobody saved");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getOrCreateLocalInstanceId: a publish that fails with NO id on disk still returns the minted id (unchanged)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "crow-instanceid-enospc-empty-"));
  const idPath = join(dir, "instance-id");
  try {
    await inScratchDataDir(dir, async () => {
      const got = getOrCreateLocalInstanceId({ link: failingLink(null) });
      assert.match(got, /^[0-9a-f]{32}$/, "the unsaved minted id is the last resort");
      assert.equal(existsSync(idPath), false, "nothing was persisted");
      assert.deepEqual(
        readdirSync(dir).filter((name) => name.endsWith(".tmp")), [],
        "the failed publish unlinks its temp file",
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getOrCreateLocalInstanceId: without hard links the exclusive-create fallback still makes two racers agree", async () => {
  const NO_HARDLINK_ROUNDS = 5;
  for (let round = 1; round <= NO_HARDLINK_ROUNDS; round++) {
    const raceDir = mkdtempSync(join(tmpdir(), "crow-instanceid-race-nohl-"));
    try {
      const [idA, idB] = await Promise.all([
        runRacer(raceDir, ["--no-hardlinks"]),
        runRacer(raceDir, ["--no-hardlinks"]),
      ]);
      assert.match(idA, /^[0-9a-f]{32}$/, `round ${round}: racer A must return a 32-hex id, got ${JSON.stringify(idA)}`);
      assert.match(idB, /^[0-9a-f]{32}$/, `round ${round}: racer B must return a 32-hex id, got ${JSON.stringify(idB)}`);
      // The wx create is NOT atomic — the winner's file is empty for an instant — so
      // the loser must be reading it through the retry window, not on the first read.
      assert.equal(idA, idB, `round ${round}: both racers must observe the SAME id over the exclusive-create fallback`);
      assert.equal(
        readFileSync(join(raceDir, "instance-id"), "utf-8").trim(), idA,
        `round ${round}: the file on disk holds the id both racers returned`,
      );
      assert.deepEqual(
        readdirSync(raceDir).filter((name) => name.endsWith(".tmp")), [],
        `round ${round}: the fallback publish leaves no temp file behind`,
      );
    } finally {
      rmSync(raceDir, { recursive: true, force: true });
    }
  }
});
