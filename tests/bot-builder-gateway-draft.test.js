/**
 * W1-4 regression: selecting a device-bound gateway type (companion/glasses)
 * in the Gateways tab posts a type-only save BEFORE a device is chosen (the
 * dropdown's auto-submit). The handler used to drop the record entirely
 * (`def.gateways = []`) when no device id was present, so the re-render —
 * which derives the dropdown from def.gateways[0].type — snapped back to
 * gmail and the companion fields were unreachable. The type must persist as
 * a device-less draft record.
 */
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "btb-gw-draft-"));
process.env.CROW_DATA_DIR = dir;

let db = null;
let handleBotBuilderPost = null;
let _setEngineStatusForTest = null;

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir },
    stdio: "pipe",
    cwd: new URL("..", import.meta.url).pathname,
  });
  const { createDbClient } = await import("../servers/db.js");
  db = createDbClient();
  ({ handleBotBuilderPost, _setEngineStatusForTest } =
    await import("../servers/gateway/dashboard/panels/bot-builder/api-handlers.js"));
  await db.execute({
    sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled) VALUES (?,?,?,1)",
    args: ["draft-bot", "Draft Bot", JSON.stringify({ gateways: [{ type: "gmail", address: "x@y.z", allowlist: [] }], tools: {}, models: {} })],
  });
});

after(async () => {
  try { db && db.close && db.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
});

// Hermeticity: this file isn't testing the engine-attach gate (that's
// bot-builder-engine-gate.test.js) — it's testing gateway-field
// persistence. The one test below that saves a COMPLETE gmail record must
// pin engineStatus() "ready" so it doesn't depend on whatever the host
// running the suite happens to have installed (a dev box with a global pi
// install resolves "ready" via rung 4; a clean CI runner resolves
// "absent" and the real gate would reject the save). Reset after every
// test regardless of which one pinned it.
afterEach(() => {
  _setEngineStatusForTest(null);
});

function mkRes() {
  const res = { redirected: null };
  res.redirectAfterPost = (url) => { res.redirected = url; };
  return res;
}

async function readDef() {
  const { rows } = await db.execute({ sql: "SELECT definition FROM pi_bot_defs WHERE bot_id='draft-bot'", args: [] });
  return JSON.parse(rows[0].definition);
}

test("device-less companion save persists the type as a draft (no gmail snap-back)", async () => {
  const res = mkRes();
  await handleBotBuilderPost(
    { body: { action: "save_gateways", bot_id: "draft-bot", gw_type: "companion", gw_hearing_style: "push_to_talk" } },
    res, { db }
  );
  assert.match(res.redirected, /saved=1/, "save must succeed: " + res.redirected);
  const def = await readDef();
  assert.equal(def.gateways[0]?.type, "companion", "type must persist without a device");
  assert.equal(def.gateways[0]?.device_id, undefined, "no device_id on a draft record");
  assert.equal(def.companion_features?.hearing_style, "push_to_talk");
});

test("companion save with gw_face_tracking=on persists face_tracking: true", async () => {
  const res = mkRes();
  await handleBotBuilderPost(
    { body: { action: "save_gateways", bot_id: "draft-bot", gw_type: "companion", gw_face_tracking: "on" } },
    res, { db }
  );
  assert.match(res.redirected, /saved=1/, "save must succeed: " + res.redirected);
  const def = await readDef();
  assert.equal(def.companion_features?.face_tracking, true, "checked box persists true");
});

test("companion save with gw_face_tracking absent persists face_tracking: false", async () => {
  const res = mkRes();
  await handleBotBuilderPost(
    { body: { action: "save_gateways", bot_id: "draft-bot", gw_type: "companion" } },
    res, { db }
  );
  assert.match(res.redirected, /saved=1/, "save must succeed: " + res.redirected);
  const def = await readDef();
  assert.equal(def.companion_features?.face_tracking, false, "absent checkbox persists false");
});

test("device-less glasses save persists the type as a draft", async () => {
  const res = mkRes();
  await handleBotBuilderPost(
    { body: { action: "save_gateways", bot_id: "draft-bot", gw_type: "glasses" } },
    res, { db }
  );
  assert.match(res.redirected, /saved=1/);
  const def = await readDef();
  assert.equal(def.gateways[0]?.type, "glasses");
});

test("typed kiosk name pairs + binds a companion device in one Save (no glasses bundle needed)", async () => {
  const res = mkRes();
  await handleBotBuilderPost(
    { body: { action: "save_gateways", bot_id: "draft-bot", gw_type: "companion", gw_new_kiosk_name: "Kitchen Tablet", gw_hearing_style: "wake_word" } },
    res, { db }
  );
  assert.match(res.redirected, /saved=1/, "save must succeed: " + res.redirected);
  const def = await readDef();
  assert.equal(def.gateways[0]?.type, "companion");
  assert.equal(def.gateways[0]?.device_id, "kiosk-kitchen-tablet", "device id derived from the name");
  const { listDevices } = await import("../bundles/meta-glasses/server/device-store.js");
  const devices = await listDevices(db);
  const d = devices.find((x) => x.id === "kiosk-kitchen-tablet");
  assert.ok(d, "device must exist in the store");
  assert.equal(d.device_kind, "companion");
  assert.equal(d.bound_bot_id, "draft-bot", "device must be bound to the bot");
  assert.equal(d.name, "Kitchen Tablet");
});

test("kiosk name collision gets a numeric suffix instead of re-pairing the existing device", async () => {
  const res = mkRes();
  await handleBotBuilderPost(
    { body: { action: "save_gateways", bot_id: "draft-bot", gw_type: "companion", gw_new_kiosk_name: "Kitchen Tablet" } },
    res, { db }
  );
  assert.match(res.redirected, /saved=1/);
  const { listDevices } = await import("../bundles/meta-glasses/server/device-store.js");
  const devices = await listDevices(db);
  assert.ok(devices.find((x) => x.id === "kiosk-kitchen-tablet-2"), "second device must get -2 suffix");
});

test("selected device wins over a typed name", async () => {
  const res = mkRes();
  await handleBotBuilderPost(
    { body: { action: "save_gateways", bot_id: "draft-bot", gw_type: "companion", gw_device_id: "kiosk-kitchen-tablet", gw_new_kiosk_name: "Ignored Name" } },
    res, { db }
  );
  assert.match(res.redirected, /saved=1/);
  const def = await readDef();
  assert.equal(def.gateways[0]?.device_id, "kiosk-kitchen-tablet");
  const { listDevices } = await import("../bundles/meta-glasses/server/device-store.js");
  const devices = await listDevices(db);
  assert.ok(!devices.find((x) => x.name === "Ignored Name"), "no device created when one was selected");
});

test("switching back to gmail still works after a draft", async () => {
  // Complete gmail record → the engine-attach gate (Task 7) would fire if
  // the engine resolved "absent"; pin "ready" so this test is hermetic on
  // any host, not just one with a global pi install.
  _setEngineStatusForTest({ state: "ready", source: "env", cliPath: "/fake/cli.js" });
  const res = mkRes();
  await handleBotBuilderPost(
    { body: { action: "save_gateways", bot_id: "draft-bot", gw_type: "gmail", gw_address: "a@b.c", gw_allowlist: "a@b.c" } },
    res, { db }
  );
  assert.match(res.redirected, /saved=1/);
  const def = await readDef();
  assert.equal(def.gateways[0]?.type, "gmail");
});

test("crow-messages saves type + allow_paired_instances toggle", async () => {
  let res = mkRes();
  await handleBotBuilderPost(
    { body: { action: "save_gateways", bot_id: "draft-bot", gw_type: "crow-messages", gw_allow_paired_instances: "on" } },
    res, { db }
  );
  assert.match(res.redirected, /saved=1/, "save must succeed: " + res.redirected);
  let def = await readDef();
  assert.equal(def.gateways[0]?.type, "crow-messages", "type persists");
  assert.equal(def.gateways[0]?.allow_paired_instances, true, "toggle on persists true");

  // Toggle off (checkbox absent in the body).
  res = mkRes();
  await handleBotBuilderPost(
    { body: { action: "save_gateways", bot_id: "draft-bot", gw_type: "crow-messages" } },
    res, { db }
  );
  def = await readDef();
  assert.equal(def.gateways[0]?.allow_paired_instances, false, "absent checkbox persists false");
});

test("gw_share mints an active invite; gw_newlink rotates it", async () => {
  const admin = await import("../servers/gateway/dashboard/panels/bot-builder/crow-messages-admin.js");
  let res = mkRes();
  await handleBotBuilderPost({ body: { action: "gw_share", bot_id: "draft-bot" } }, res, { db });
  assert.match(res.redirected, /tab=gateways/, "redirects to gateways tab");
  const first = await admin.getActiveInvite(db, "draft-bot");
  assert.ok(first && first.token, "an active invite exists after share");

  res = mkRes();
  await handleBotBuilderPost({ body: { action: "gw_newlink", bot_id: "draft-bot" } }, res, { db });
  const second = await admin.getActiveInvite(db, "draft-bot");
  assert.notEqual(second.token, first.token, "new link rotates the token");
});

test("gw_advanced_add then gw_remove edits the ACL", async () => {
  const admin = await import("../servers/gateway/dashboard/panels/bot-builder/crow-messages-admin.js");
  const pk = "e".repeat(64);
  let res = mkRes();
  await handleBotBuilderPost(
    { body: { action: "gw_advanced_add", bot_id: "draft-bot", sender_pubkey: pk, display_name: "Bob" } },
    res, { db }
  );
  let acl = await admin.listAcl(db, "draft-bot");
  assert.ok(acl.find((r) => r.sender_pubkey === pk && r.display_name === "Bob"), "manual ACL added");

  res = mkRes();
  await handleBotBuilderPost(
    { body: { action: "gw_remove", bot_id: "draft-bot", sender_pubkey: pk } }, res, { db }
  );
  acl = await admin.listAcl(db, "draft-bot");
  assert.ok(!acl.find((r) => r.sender_pubkey === pk), "ACL row removed");
});
