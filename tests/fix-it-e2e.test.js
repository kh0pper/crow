import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { enforcePeerExposure, getExposedCapabilities } from "../servers/gateway/peer-exposure.js";
import * as store from "../servers/shared/fix-it/store.js";

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

test("denied call → card appears → remedy → next check allowed", async () => {
  const connected = new Map([["funkwhale", { tools: [{ name: "fw_play" }] }]]);
  const req = { instanceAuth: { instance: { id: "peer-9" } }, body: { method: "tools/call", params: { name: "fw_play" }, id: 1 } };

  // 1. Denied (nothing exposed) — uses the real emitFixIt (default emitFn).
  const denied = await enforcePeerExposure({ prefix: "tools", req, res: mkRes(), db, connectedServers: connected, auditFn: async () => {} });
  assert.equal(denied, false);

  // 2. The emit is fire-and-forget; poll deterministically until the card lands.
  const pending = await waitForPending((p) => p.length === 1);
  assert.equal(pending[0].context.capability, "funkwhale");

  // 3. Run the remedy via the action handler.
  const res2 = { redirectAfterPost: () => {} };
  await idx.handleFixItAction({ body: { action: "remedy", item_id: String(pending[0].id), action_id: "expose-capability" } }, res2, { db });
  assert.ok((await getExposedCapabilities(db)).has("funkwhale"));
  assert.equal((await store.listPending(db)).length, 0); // card cleared

  // 4. The next enforcement check for the same capability is now allowed.
  const allowed = await enforcePeerExposure({ prefix: "tools", req, res: mkRes(), db, connectedServers: connected, auditFn: async () => {} });
  assert.equal(allowed, true);
});
