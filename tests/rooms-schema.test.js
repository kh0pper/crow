import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function freshLibsql() {
  const dir = mkdtempSync(join(tmpdir(), "crowroom-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return { dir, db, cleanup() { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}

test("contact_groups has room_uid/host_crow_id/mode; room_messages exists", async () => {
  const { db, cleanup } = freshLibsql();
  try {
    const cg = await db.execute("PRAGMA table_info(contact_groups)");
    const cols = cg.rows.map((r) => r.name);
    assert.ok(cols.includes("room_uid"), "room_uid");
    assert.ok(cols.includes("host_crow_id"), "host_crow_id");
    assert.ok(cols.includes("mode"), "mode");

    const rm = await db.execute("PRAGMA table_info(room_messages)");
    const rcols = rm.rows.map((r) => r.name);
    for (const c of ["group_id", "msg_uid", "sender_contact_id", "sender_label", "author_kind", "content", "direction", "nostr_event_id", "is_read"]) {
      assert.ok(rcols.includes(c), "room_messages." + c);
    }
    // Partial unique index on room_uid: two NULLs allowed, dup non-null rejected.
    await db.execute("INSERT INTO contact_groups (name) VALUES ('a')");
    await db.execute("INSERT INTO contact_groups (name) VALUES ('b')"); // both room_uid NULL — OK
    await db.execute("INSERT INTO contact_groups (name, room_uid) VALUES ('r1','u1')");
    await assert.rejects(
      db.execute("INSERT INTO contact_groups (name, room_uid) VALUES ('r2','u1')"),
      /UNIQUE|constraint/i, "duplicate room_uid rejected"
    );
  } finally { cleanup(); }
});
