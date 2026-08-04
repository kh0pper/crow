/**
 * WAL-generation tripwire (servers/db.js).
 *
 * While a process holds connections, the -wal inode must never change; a
 * change means something unlinked the live WAL (the 2026-08-04 corruption
 * mechanism). checkWalCoherence() must report ok while the inode is stable
 * and !ok after an unlink+recreate.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CROW_WAL_TRIPWIRE_MS = process.env.CROW_WAL_TRIPWIRE_MS || "30000";

const { createDbClient, checkWalCoherence, _walTripwires } = await import("../servers/db.js");

test("tripwire arms on WAL keeper and detects a wal inode swap", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "crow-tripwire-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "trip.db");

  const db = createDbClient(dbPath);
  await db.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
  await db.execute({ sql: "INSERT INTO t (v) VALUES (?)", args: ["a"] });

  assert.ok(existsSync(dbPath + "-wal"), "WAL file exists after a write");
  const armed = checkWalCoherence(dbPath);
  assert.equal(armed.armed, true, "tripwire armed for the keeper path");
  assert.equal(armed.ok, true, "coherent while the wal inode is stable");
  assert.equal(armed.baselineIno, statSync(dbPath + "-wal").ino);

  // Simulate the failure: unlink + recreate the wal behind the process's back.
  rmSync(dbPath + "-wal");
  writeFileSync(dbPath + "-wal", "not a real wal");
  const after = checkWalCoherence(dbPath);
  assert.equal(after.armed, true);
  assert.equal(after.ok, false, "inode swap must be detected");
  assert.notEqual(after.currentIno, after.baselineIno);

  db.close();
});

test("tripwire adopts a late-appearing wal as baseline", async () => {
  // A keeper on a path whose wal is missing at arm time must adopt the
  // first observed inode instead of tripping forever.
  const dir = mkdtempSync(join(tmpdir(), "crow-tripwire2-"));
  const dbPath = join(dir, "late.db");
  const db = createDbClient(dbPath);
  try {
    // Force the recorded baseline to "missing" regardless of arm timing.
    const tw = _walTripwires.get(dbPath);
    if (tw) tw.baselineIno = null;
    await db.execute("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    await db.execute("INSERT INTO t DEFAULT VALUES");
    const res = checkWalCoherence(dbPath);
    assert.equal(res.armed, true);
    assert.equal(res.ok, true, "first observed inode becomes the baseline");
    assert.equal(res.baselineIno, statSync(dbPath + "-wal").ino);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
