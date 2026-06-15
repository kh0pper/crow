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
  await idx.emitFixIt(db, "peer-exposure:denied", { capability: "funkwhale", requestingInstance: "peer-x" });
  const item = (await store.listPending(db))[0];
  let redirected = null;
  const req = { body: { action: "remedy", item_id: String(item.id), action_id: "expose-capability" } };
  const res = { redirectAfterPost: (u) => { redirected = u; } };
  await idx.handleFixItAction(req, res, { db });
  assert.match(redirected, /flash=/);
  assert.equal((await store.getItem(db, item.id)).status, "resolved");
  const { getExposedCapabilities } = await import("../servers/gateway/peer-exposure.js");
  assert.ok((await getExposedCapabilities(db)).has("funkwhale"));
});

test("handleFixItAction dismiss suppresses the card", async () => {
  await idx.emitFixIt(db, "peer-exposure:denied", { capability: "funkwhale", requestingInstance: "peer-x" });
  const item = (await store.listPending(db))[0];
  const res = { redirectAfterPost: () => {} };
  await idx.handleFixItAction({ body: { action: "dismiss", item_id: String(item.id) } }, res, { db });
  assert.equal((await store.listPending(db)).length, 0);
});
