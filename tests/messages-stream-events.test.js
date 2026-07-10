/**
 * messages-stream-events — Cluster A Task 4 (F-UI-4/6).
 *
 * The /dashboard/streams/messages route emits two NAMED SSE events
 * alongside the existing badge-only turbo-stream frame:
 *   - `crow-msg`     per messages:changed  (F-UI-4 — panel's own EventSource)
 *   - `crow-receipt` per messages:receipt  (F-UI-6 — live ✓→✓✓ tick)
 *
 * Named events are invisible to <turbo-stream-source> (it only consumes
 * default "message" events), so the badge-replace behavior is untouched —
 * asserted directly below.
 *
 * Harness note: tests/sse-cap.test.js's stub `res` does NOT transfer — its
 * `on()` is a no-op that drops listeners, and this route goes through
 * openAuthedStream (session-recheck timer) not the bare openStream tested
 * there. This file builds its own fake `res` satisfying openStream's full
 * surface (headersSent, writeHead, flushHeaders, write, writableEnded, on,
 * end) and captures the 'close'/'error' listeners so every test can fire
 * them at the end — clearing BOTH the 30s heartbeat (sse.js) AND the 5-min
 * session-recheck (authed-stream.js) timers, or the test runner hangs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bus from "../servers/shared/event-bus.js";
import streamsRouter from "../servers/gateway/routes/streams.js";
import { handleDeliveryReceipt } from "../servers/sharing/boot.js";

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "msg-stream-events-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
  const db = createClient({ url: "file:" + join(dir, "crow.db") });
  return { db, cleanup() { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); } };
}

const PK_REAL = "02" + "a".repeat(64);
const XONLY_REAL = "a".repeat(64);

async function seedReceiptFixture(db) {
  await db.execute({
    sql: `INSERT INTO contacts (id, crow_id, display_name, ed25519_pubkey, secp256k1_pubkey, contact_type) VALUES (1,'crow:real','Real','', ?, 'crow')`,
    args: [PK_REAL],
  });
  await db.execute({
    sql: `INSERT INTO messages (id, contact_id, nostr_event_id, content, direction, is_read, delivery_status, created_at) VALUES (12,1,'evt1','hi','sent',1,'relayed',datetime('now'))`,
    args: [],
  });
  await db.execute({
    sql: `INSERT INTO messages (id, contact_id, nostr_event_id, content, direction, is_read, delivery_status, created_at) VALUES (13,1,'evt2','yo','sent',1,'relayed',datetime('now'))`,
    args: [],
  });
}

// --- fake res: full openStream/openAuthedStream surface ---
function fakeRes() {
  let headersSent = false;
  let ended = false;
  const chunks = [];
  const listeners = { close: [], error: [] };
  const res = {
    get headersSent() { return headersSent; },
    get writableEnded() { return ended; },
    writeHead() { headersSent = true; },
    flushHeaders() {},
    write(data) { chunks.push(data); return true; },
    end() { ended = true; },
    on(event, listener) {
      if (listeners[event]) listeners[event].push(listener);
    },
  };
  return {
    res,
    chunks,
    fireClose() { for (const l of listeners.close) l(); },
  };
}

function getMessagesHandler() {
  // dashboardAuth is only wired via router.use(); we call the route handler
  // directly (bypassing the Express dispatch stack), so a no-op stub is fine.
  const router = streamsRouter((req, res, next) => next());
  const layer = router.stack.find((l) => l.route && l.route.path === "/dashboard/streams/messages");
  assert.ok(layer, "route /dashboard/streams/messages must be registered");
  return layer.route.stack[0].handle;
}

test("messages stream emits a crow-msg named event per messages:changed (F-UI-4)", () => {
  const handler = getMessagesHandler();
  const { res, chunks, fireClose } = fakeRes();
  const req = { dashboardSession: "tok-1" };
  handler(req, res);

  try {
    bus.emit("messages:changed", { contactId: 3, unread: 2 });

    const out = chunks.join("");
    assert.match(out, /event: crow-msg\ndata: \{"contactId":3,"unread":2\}\n\n/);
    // the badge turbo-stream frame is UNCHANGED and still present
    assert.match(out, /badge-peer-3/);
  } finally {
    // MUST run even on assertion failure — this clears BOTH the 30s
    // heartbeat (sse.js) and the 5-min session-recheck (authed-stream.js)
    // timers, or the test runner hangs.
    fireClose();
  }
});

test("messages stream forwards messages:receipt as crow-receipt (F-UI-6 live tick)", () => {
  const handler = getMessagesHandler();
  const { res, chunks, fireClose } = fakeRes();
  const req = { dashboardSession: "tok-2" };
  handler(req, res);

  try {
    bus.emit("messages:receipt", { contactId: 3, ids: [12, 13] });

    const out = chunks.join("");
    assert.match(out, /event: crow-receipt\ndata: \{"contactId":3,"ids":\[12,13\]\}\n\n/);
  } finally {
    fireClose();
  }
});

test("handleDeliveryReceipt emits messages:receipt with the local row ids", async () => {
  const { db, cleanup } = freshDb();
  try {
    await seedReceiptFixture(db);
    let got = null;
    const onReceipt = (p) => { got = p; };
    bus.once("messages:receipt", onReceipt);
    await handleDeliveryReceipt(db, ["evt1", "evt2"], XONLY_REAL);
    bus.off("messages:receipt", onReceipt);
    assert.deepEqual(got, { contactId: 1, ids: [12, 13] });
  } finally {
    cleanup();
  }
});

test("handleDeliveryReceipt does NOT emit messages:changed (badge-blanking guard)", async () => {
  const { db, cleanup } = freshDb();
  try {
    await seedReceiptFixture(db);
    let changed = false;
    const h = () => { changed = true; };
    bus.on("messages:changed", h);
    await handleDeliveryReceipt(db, ["evt1"], XONLY_REAL);
    bus.off("messages:changed", h);
    assert.equal(changed, false);
  } finally {
    cleanup();
  }
});
