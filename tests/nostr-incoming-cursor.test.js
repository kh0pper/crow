/**
 * nostr-incoming-cursor — R4 Task 1. The broad incoming Nostr subscription
 * must resume from a PERSISTED cursor instead of a fixed 24h window, so a late
 * invite_accepted isn't guillotined by the clock. Asserts: default when unset,
 * persisted-minus-overlap when set, monotonic advance (never backwards), and
 * never-throws on a bad db.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readIncomingSince, persistIncomingCursor } from "../servers/sharing/contact-promote.js";

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "cursor-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return { db, cleanup() { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}

test("default is now-86400 when no cursor persisted", async () => {
  const { db, cleanup } = freshDb();
  try {
    const now = 1_800_000_000;
    assert.equal(await readIncomingSince(db, now), now - 86400);
  } finally { cleanup(); }
});

test("a recent cursor still back-fills the full 24h floor (never regress)", async () => {
  const { db, cleanup } = freshDb();
  try {
    const now = 1_800_000_000;
    await persistIncomingCursor(db, now - 3600); // cursor 1h old (busy gateway)
    // desired = (now-3600)-3600 is newer than now-86400 → clamp to the 24h floor.
    assert.equal(await readIncomingSince(db, now), now - 86400);
  } finally { cleanup(); }
});

test("an older cursor widens the window (cursor minus 1h overlap)", async () => {
  const { db, cleanup } = freshDb();
  try {
    const now = 1_800_000_000;
    const stored = now - 2 * 86400; // 2 days offline
    await persistIncomingCursor(db, stored);
    assert.equal(await readIncomingSince(db, now), stored - 3600);
  } finally { cleanup(); }
});

test("a very stale cursor is capped at 30 days (bound the relay flood)", async () => {
  const { db, cleanup } = freshDb();
  try {
    const now = 1_800_000_000;
    await persistIncomingCursor(db, now - 100 * 86400); // 100 days old
    assert.equal(await readIncomingSince(db, now), now - 30 * 86400);
  } finally { cleanup(); }
});

test("cursor advances but never moves backwards", async () => {
  const { db, cleanup } = freshDb();
  try {
    await persistIncomingCursor(db, 1_700_000_000);
    await persistIncomingCursor(db, 1_700_000_500); // advance
    await persistIncomingCursor(db, 1_600_000_000); // stale — must be ignored
    const { rows } = await db.execute({
      sql: "SELECT value FROM dashboard_settings WHERE key = 'sharing:incoming_since'", args: [],
    });
    assert.equal(Number(rows[0].value), 1_700_000_500);
  } finally { cleanup(); }
});

test("never throws on a broken db", async () => {
  const brokenDb = { execute: async () => { throw new Error("boom"); } };
  assert.equal(await readIncomingSince(brokenDb, 1_800_000_000), 1_800_000_000 - 86400);
  await persistIncomingCursor(brokenDb, 1_700_000_000); // must not throw
});
