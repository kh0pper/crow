import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import * as store from "../servers/shared/fix-it/store.js";

let dir, db, idx;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "fixit-index-"));
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe", cwd: join(import.meta.dirname, ".."),
  });
  process.env.CROW_DATA_DIR = dir;
  db = createDbClient();
  idx = await import("../servers/gateway/fix-it/index.js");
});
after(() => { try { db.close(); } catch {} try { rmSync(dir, { recursive: true, force: true }); } catch {} });
beforeEach(async () => { await db.execute("DELETE FROM fix_it_items"); });

/**
 * Give `id` a crow_instances row that passes the peer-trust predicate. Review
 * round 2 (N-a): the Allow remedy refuses a peer that is not trusted here, and in
 * production only a peer that authenticated (i.e. has such a row) can raise a card.
 */
async function trustPeer(id) {
  await db.execute({
    sql: "INSERT OR REPLACE INTO crow_instances (id, name, crow_id, status, trusted) VALUES (?, ?, ?, 'active', 1)",
    args: [id, `Peer ${id}`, "crow-test"],
  });
}

test("emitFixIt turns a denial into one pending card (never throws)", async () => {
  await idx.emitFixIt(db, "peer-exposure:denied", { capability: "funkwhale", requestingInstance: "peer-x", toolName: "fw_play" });
  const pending = await store.listPending(db);
  assert.equal(pending.length, 1);
  assert.match(pending[0].title, /Music/);
});

test("emitFixIt swallows a bad payload without throwing", async () => {
  await assert.doesNotReject(idx.emitFixIt(db, "peer-exposure:denied", null));
});

test("renderFixItCards renders a card with a CSRF field, or empty when none", async () => {
  const req = { csrfToken: "tok123" };
  assert.equal(await idx.renderFixItCards(db, { lang: "en", req }), "");
  await idx.emitFixIt(db, "peer-exposure:denied", { capability: "funkwhale", requestingInstance: "peer-x" });
  const html = await idx.renderFixItCards(db, { lang: "en", req });
  assert.match(html, /Music/);
  assert.match(html, /name="_csrf" value="tok123"/);
  assert.match(html, /\/dashboard\/fix-it\/action/);
  assert.match(html, /Not now/);
});

test("handleFixItAction runs the remedy and resolves the card", async () => {
  await trustPeer("peer-x");
  await idx.emitFixIt(db, "peer-exposure:denied", { capability: "funkwhale", requestingInstance: "peer-x" });
  const item = (await store.listPending(db))[0];
  let redirected = null;
  const req = { body: { action: "remedy", item_id: String(item.id), action_id: "expose-capability-30d" } };
  const res = { redirectAfterPost: (u) => { redirected = u; } };
  await idx.handleFixItAction(req, res, { db });
  assert.match(redirected, /flash=/);
  assert.equal((await store.getItem(db, item.id)).status, "resolved");
  // N1b-8: the click grants the capability to the peer ON THE CARD, and does
  // not add it to the all-trusted-peers allowlist.
  const { getExposedCapabilities, getPeerGrantedCapabilities } = await import("../servers/gateway/peer-exposure.js");
  assert.ok((await getPeerGrantedCapabilities(db, "peer-x")).has("funkwhale"));
  assert.ok(!(await getExposedCapabilities(db)).has("funkwhale"));
});

test("handleFixItAction dismiss suppresses the card", async () => {
  await idx.emitFixIt(db, "peer-exposure:denied", { capability: "funkwhale", requestingInstance: "peer-x" });
  const item = (await store.listPending(db))[0];
  const res = { redirectAfterPost: () => {} };
  await idx.handleFixItAction({ body: { action: "dismiss", item_id: String(item.id) } }, res, { db });
  assert.equal((await store.listPending(db)).length, 0);
});

// N1b-8 review round 1 (N2): a remedy must not run for a card that is no longer
// pending. Before this guard the handler trusted the POST: a stale page, a
// double submit or a replayed form re-ran the remedy (re-granting an allowance
// the operator had already answered, or granting one for a card they dismissed).
test("handleFixItAction refuses a remedy on a card that is no longer pending", async () => {
  await idx.emitFixIt(db, "peer-exposure:denied", { capability: "funkwhale", requestingInstance: "peer-stale" });
  const item = (await store.listPending(db))[0];
  const req = { body: { action: "remedy", item_id: String(item.id), action_id: "expose-capability-30d" } };

  // 1. Already resolved (someone clicked it, or the fix landed elsewhere).
  await store.markResolved(db, item.id);
  let redirected = null;
  await idx.handleFixItAction(req, { redirectAfterPost: (u) => { redirected = u; } }, { db });
  assert.match(redirected, /flash=fixit_not_pending/, "the refusal says the card is not open");
  assert.equal((await store.getItem(db, item.id)).status, "resolved", "the card state is unchanged");

  const { getPeerGrantedCapabilities, getExposedCapabilities } = await import("../servers/gateway/peer-exposure.js");
  assert.equal((await getPeerGrantedCapabilities(db, "peer-stale")).size, 0, "nothing was granted");
  assert.ok(!(await getExposedCapabilities(db)).has("funkwhale"));

  // 2. Dismissed is not pending either.
  await idx.emitFixIt(db, "peer-exposure:denied", { capability: "crow-blog", capabilityKnown: true, requestingInstance: "peer-stale-2" });
  const dismissed = (await store.listPending(db))[0];
  await store.dismiss(db, dismissed.id, 7);
  redirected = null;
  await idx.handleFixItAction(
    { body: { action: "remedy", item_id: String(dismissed.id), action_id: "expose-capability-30d" } },
    { redirectAfterPost: (u) => { redirected = u; } }, { db },
  );
  assert.match(redirected, /flash=fixit_not_pending/);
  assert.equal((await getPeerGrantedCapabilities(db, "peer-stale-2")).size, 0, "a dismissed card grants nothing");
});
