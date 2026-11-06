import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { enforcePeerExposure, getExposedCapabilities, getPeerGrantedCapabilities } from "../servers/gateway/peer-exposure.js";
import * as store from "../servers/shared/fix-it/store.js";
import { pairingTag } from "../servers/shared/peer-id.js";

let dir, db, idx;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "fixit-e2e-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: join(import.meta.dirname, ".."),
  });
  process.env.CROW_DATA_DIR = dir;
  db = createDbClient();
  idx = await import("../servers/gateway/fix-it/index.js");
});
after(() => { try { db.close(); } catch {} try { rmSync(dir, { recursive: true, force: true }); } catch {} });

function mkRes() {
  return { _status: null, headersSent: false,
    status(c) { this._status = c; return this; },
    json() { this.headersSent = true; return this; } };
}

// Deterministic wait: poll until the card lands or a hard deadline trips.
// The chokepoint emit is fire-and-forget (not awaited), so a fixed sleep is
// racy; poll instead and FAIL LOUDLY at the deadline.
async function waitForPending(predicate, deadlineMs = 2000) {
  const start = Date.now();
  for (;;) {
    const pending = await store.listPending(db);
    if (predicate(pending)) return pending;
    if (Date.now() - start > deadlineMs) {
      assert.fail(`card did not materialize within ${deadlineMs}ms (saw ${pending.length})`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("denied call → card appears → remedy → next check allowed for THAT peer only", async () => {
  // Review round 2 (N-a): a card can only be allowed for a peer that is
  // currently trusted here, and in production the card exists because that peer
  // authenticated — so the fixture gives it a trusted row. Fix round 3: the row
  // carries the bearer hash, and the card is bound to the tag of that pairing
  // (the gate reads the hash off the verified row).
  await db.execute({
    sql: "INSERT OR REPLACE INTO crow_instances (id, name, crow_id, status, trusted, auth_token_hash) VALUES (?, ?, ?, 'active', 1, ?)",
    args: ["peer-9", "Peer peer-9", "crow-test", "test-token-hash-peer-9"],
  });
  const connected = new Map([["funkwhale", { status: "connected", tools: [{ name: "fw_play" }] }]]);
  const req = { instanceAuth: { instance: { id: "peer-9" } }, body: { method: "tools/call", params: { name: "fw_play" }, id: 1 } };

  // 1. Denied (nothing exposed) — uses the real emitFixIt (default emitFn).
  const denied = await enforcePeerExposure({ prefix: "tools", req, res: mkRes(), db, connectedServers: connected, auditFn: async () => {} });
  assert.equal(denied, false);

  // 2. The emit is fire-and-forget; poll deterministically until the card lands.
  const pending = await waitForPending((p) => p.length === 1);
  assert.equal(pending[0].context.capability, "funkwhale");
  assert.equal(pending[0].context.requestingInstance, "peer-9", "the card is scoped to the verified peer");
  assert.equal(pending[0].context.pairingTag, pairingTag("test-token-hash-peer-9"),
    "and bound to the pairing the gate verified (fix round 3)");

  // 3. Run the remedy via the action handler.
  const res2 = { redirectAfterPost: () => {} };
  await idx.handleFixItAction({ body: { action: "remedy", item_id: String(pending[0].id), action_id: "expose-capability-30d" } }, res2, { db });
  // N1b-8: the grant is per-peer, NOT an all-peer exposure.
  assert.ok((await getPeerGrantedCapabilities(db, "peer-9")).has("funkwhale"));
  assert.ok(!(await getExposedCapabilities(db)).has("funkwhale"), "one peer's Allow must not expose it to every peer");
  assert.equal((await store.listPending(db)).length, 0); // card cleared

  // 4. The next enforcement check for the same capability is now allowed — for
  //    the peer that asked…
  const allowed = await enforcePeerExposure({ prefix: "tools", req, res: mkRes(), db, connectedServers: connected, auditFn: async () => {} });
  assert.equal(allowed, true);

  // …and still refused for a different peer.
  const other = { instanceAuth: { instance: { id: "peer-10" } }, body: req.body };
  const otherRes = mkRes();
  const refused = await enforcePeerExposure({ prefix: "tools", req: other, res: otherRes, db, connectedServers: connected, auditFn: async () => {}, emitFn: async () => {} });
  assert.equal(refused, false);
  assert.equal(otherRes._status, 403);
});
