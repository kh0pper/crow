/**
 * Cluster C D1/D2 — the block actions tear down ALL live wiring (Nostr unsub +
 * feeds + DHT) via unwireContact; the unblock actions lazily re-wire via
 * wireSyncedContact. Both panels; includes the S5.4 req:-accepted shape.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { handleContactAction } from "../servers/gateway/dashboard/panels/contacts/api-handlers.js";
import { handlePostAction } from "../servers/gateway/dashboard/panels/messages/api-handlers.js";

const SECP = "02" + "a".repeat(64);

function freshDb(tag) {
  const dir = mkdtempSync(join(tmpdir(), `block-handlers-${tag}-`));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return { db, cleanup() { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}

function stubManagers() {
  const calls = [];
  return {
    calls,
    nostrManager: {
      unsubscribeFromContact: (crowId) => calls.push(["unsub", crowId]),
      subscribeToContact: async (c) => calls.push(["sub", c.crow_id || c.crowId]),
    },
    syncManager: {
      closeContactFeeds: async (id) => calls.push(["closeFeeds", id]),
      initContact: async (id) => calls.push(["initContact", id]),
    },
    peerManager: {
      leaveContact: async (crowId) => calls.push(["leave", crowId]),
      joinContact: async (c) => calls.push(["join", c.crowId]),
    },
  };
}

test("contacts panel: block → full teardown; unblock → re-wire; keyless manual stays inert", async () => {
  const { db, cleanup } = freshDb("contacts");
  try {
    const ins = await db.execute({
      sql: "INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey, display_name) VALUES ('crow:t1', 'ed', ?, 'T1')",
      args: [SECP],
    });
    const id = Number(ins.lastInsertRowid);

    const m1 = stubManagers();
    const out1 = await handleContactAction({ body: { action: "block", contact_id: String(id) } }, db, { managers: m1 });
    assert.ok(out1?.redirect, "block redirects");
    const k1 = m1.calls.map((c) => c[0]);
    assert.ok(k1.includes("unsub"), "block tears down the Nostr sub (the F-BLOCK-1 leg)");
    assert.ok(k1.includes("closeFeeds") && k1.includes("leave"), "feeds + DHT teardown preserved");
    const b = await db.execute({ sql: "SELECT is_blocked FROM contacts WHERE id = ?", args: [id] });
    assert.equal(Number(b.rows[0].is_blocked), 1);

    const m2 = stubManagers();
    await handleContactAction({ body: { action: "unblock", contact_id: String(id) } }, db, { managers: m2 });
    const k2 = m2.calls.map((c) => c[0]);
    assert.ok(k2.includes("initContact") && k2.includes("join") && k2.includes("sub"), "unblock re-wires (no restart needed)");

    // Keyless manual contact: block+unblock never touch wiring, never throw.
    const insM = await db.execute("INSERT INTO contacts (crow_id, ed25519_pubkey, secp256k1_pubkey, display_name, contact_type) VALUES ('manual:x', '', '', 'M', 'manual')");
    const mid = Number(insM.lastInsertRowid);
    const m3 = stubManagers();
    await handleContactAction({ body: { action: "block", contact_id: String(mid) } }, db, { managers: m3 });
    await handleContactAction({ body: { action: "unblock", contact_id: String(mid) } }, db, { managers: m3 });
    assert.ok(!m3.calls.some((c) => c[0] === "sub" || c[0] === "join" || c[0] === "initContact"), "keyless manual is never wired");
  } finally { cleanup(); }
});

test("messages panel: block/unblock by crow_id incl. the req:-accepted stranger shape", async () => {
  const { db, cleanup } = freshDb("messages");
  try {
    const reqSecp = "f".repeat(64);
    await db.execute({
      sql: "INSERT INTO contacts (crow_id, secp256k1_pubkey, ed25519_pubkey, request_status) VALUES (?, ?, '', 'accepted')",
      args: [`req:${reqSecp}`, reqSecp],
    });
    const res = { redirected: null, redirectAfterPost(u) { this.redirected = u; return u; } };

    const m1 = stubManagers();
    await handlePostAction({ body: { action: "block", crow_id: `req:${reqSecp}` } }, res, { db, _managers: m1 });
    assert.ok(m1.calls.some((c) => c[0] === "unsub" && c[1] === `req:${reqSecp}`), "req: accepted stranger's live sub torn down (S5.4)");

    const m2 = stubManagers();
    await handlePostAction({ body: { action: "unblock", crow_id: `req:${reqSecp}` } }, res, { db, _managers: m2 });
    assert.ok(m2.calls.some((c) => c[0] === "sub"), "unblock re-subscribes");
  } finally { cleanup(); }
});
