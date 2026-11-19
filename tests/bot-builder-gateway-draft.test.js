/**
 * W1-4 regression: selecting a device-bound gateway type in the Gateways tab posts a
 * type-only save BEFORE a device is chosen (the dropdown's auto-submit). The handler used
 * to drop the record entirely (`def.gateways = []`) when no device id was present, so the
 * re-render — which derives the dropdown from def.gateways[0].type — snapped back to gmail
 * and the type's fields were unreachable. The type must persist as a device-less draft
 * record.
 *
 * Both device-bound types are RETIRED now (glasses answer as Crow; the AI Companion was
 * removed), so what this file pins has shifted: a save of either type is a NO-OP that
 * neither rewrites the stored record, nor binds a device, nor pairs a companion-kind one.
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

test("a companion save is a no-op: the record is kept, nothing is bound and no device is created", async () => {
  const { listDevices } = await import("../servers/shared/device-store.js");
  const priorDef = await readDef();
  const priorDevices = JSON.stringify(await listDevices(db));
  for (const extra of [{}, { gw_new_kiosk_name: "Kitchen Tablet" }, { gw_device_id: "kiosk-kitchen-tablet" }, { gw_face_tracking: "on" }]) {
    const res = mkRes();
    await handleBotBuilderPost({ body: { action: "save_gateways", bot_id: "draft-bot", gw_type: "companion", ...extra } }, res, { db });
    assert.match(res.redirected, /saved=1/, "save must succeed: " + res.redirected);
    const def = await readDef();
    assert.deepEqual(def.gateways, priorDef.gateways, "a retired channel never rewrites the stored record");
    assert.deepEqual(def.companion_features, priorDef.companion_features, "companion_features is no longer written");
  }
  assert.equal(JSON.stringify(await listDevices(db)), priorDevices, "no companion-kind device is ever created");
  assert.equal((await listDevices(db)).some((d) => d.device_kind === "companion"), false);
});

test("a stored companion record with a device_id loads and saves without error (tolerance rule)", async () => {
  // A public install may still carry one. It must read and re-save: the channel is
  // retired, not rejected as unknown.
  await db.execute({
    sql: "UPDATE pi_bot_defs SET definition = ? WHERE bot_id = 'draft-bot'",
    args: [JSON.stringify({ gateways: [{ type: "companion", device_id: "kiosk-legacy" }], companion_features: { avatar: "heron" }, tools: {}, models: {} })],
  });
  const res = mkRes();
  await handleBotBuilderPost({ body: { action: "save_gateways", bot_id: "draft-bot", gw_type: "companion" } }, res, { db });
  assert.match(res.redirected, /saved=1/, "save must succeed: " + res.redirected);
  const def = await readDef();
  assert.equal(def.gateways[0]?.type, "companion", "the stored record survives a save");
  assert.equal(def.gateways[0]?.device_id, "kiosk-legacy");
  await db.execute({
    sql: "UPDATE pi_bot_defs SET definition = ? WHERE bot_id = 'draft-bot'",
    args: [JSON.stringify({ gateways: [{ type: "gmail", address: "x@y.z", allowlist: [] }], tools: {}, models: {} })],
  });
});

test("glasses are retired: a glasses save (with or without a device) neither stores a record nor binds a device", async () => {
  const { updateDeviceProfiles, pairDevice, findDevice } = await import("../servers/shared/device-store.js");
  await pairDevice(db, { id: "glasses-keep", name: "Glasses", generation: "unknown" });
  await updateDeviceProfiles(db, "glasses-keep", { bound_bot_id: "someone-else" });
  const before = JSON.stringify(await findDevice(db, "glasses-keep"));
  const priorDef = await readDef();
  for (const extra of [{}, { gw_device_id: "glasses-keep", gw_tts_profile_id: "t" }]) {
    const res = mkRes();
    await handleBotBuilderPost({ body: { action: "save_gateways", bot_id: "draft-bot", gw_type: "glasses", ...extra } }, res, { db });
    assert.match(res.redirected, /saved=1/);
    assert.deepEqual((await readDef()).gateways, priorDef.gateways, "no glasses record");
    assert.equal(JSON.stringify(await findDevice(db, "glasses-keep")), before, "the device is untouched");
  }
});

test("a retired companion channel is never offered to a NEW bot (render check)", async () => {
  const { CHANNEL_TYPES } = await import("../servers/gateway/dashboard/panels/bot-builder/tab-basics.js");
  // Still a known type (a stored record must render read-only), but the editor filters it
  // out of the picker unless the bot already has it.
  assert.ok(CHANNEL_TYPES.includes("companion"), "the type stays known");
  const { GATEWAY_REQUIRED_FIELDS } = await import("../servers/gateway/dashboard/panels/bot-builder/gateway-fields.js");
  assert.deepEqual(GATEWAY_REQUIRED_FIELDS.companion, [], "a retired record needs nothing to be 'complete'");
});

test("switching back to gmail still works after a retired-channel save", async () => {
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
  assert.match(res.redirected, /tab=basics/, "redirects to the Basics tab (where the channel lives)");
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
