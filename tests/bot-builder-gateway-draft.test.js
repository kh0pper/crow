/**
 * W1-4 regression: selecting a device-bound gateway type (companion/glasses)
 * in the Gateways tab posts a type-only save BEFORE a device is chosen (the
 * dropdown's auto-submit). The handler used to drop the record entirely
 * (`def.gateways = []`) when no device id was present, so the re-render —
 * which derives the dropdown from def.gateways[0].type — snapped back to
 * gmail and the companion fields were unreachable. The type must persist as
 * a device-less draft record.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "btb-gw-draft-"));
process.env.CROW_DATA_DIR = dir;

let db = null;
let handleBotBuilderPost = null;

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir },
    stdio: "pipe",
    cwd: new URL("..", import.meta.url).pathname,
  });
  const { createDbClient } = await import("../servers/db.js");
  db = createDbClient();
  ({ handleBotBuilderPost } = await import("../servers/gateway/dashboard/panels/bot-builder/api-handlers.js"));
  await db.execute({
    sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled) VALUES (?,?,?,1)",
    args: ["draft-bot", "Draft Bot", JSON.stringify({ gateways: [{ type: "gmail", address: "x@y.z", allowlist: [] }], tools: {}, models: {} })],
  });
});

after(async () => {
  try { db && db.close && db.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
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

test("switching back to gmail still works after a draft", async () => {
  const res = mkRes();
  await handleBotBuilderPost(
    { body: { action: "save_gateways", bot_id: "draft-bot", gw_type: "gmail", gw_address: "a@b.c", gw_allowlist: "a@b.c" } },
    res, { db }
  );
  assert.match(res.redirected, /saved=1/);
  const def = await readDef();
  assert.equal(def.gateways[0]?.type, "gmail");
});
