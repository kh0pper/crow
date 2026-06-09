import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import section from "../servers/gateway/dashboard/settings/sections/bot-runtime.js";

function setup() {
  const tmp = mkdtempSync(join(tmpdir(), "f3b-"));
  process.env.CROW_DATA_DIR = tmp; process.env.CROW_DB_PATH = join(tmp, "crow.db");
  return tmp;
}

test("toggle round-trips bot_runtime and preserves other flags", async () => {
  setup();
  const { execSync } = await import("node:child_process");
  execSync("node scripts/init-db.js", { env: process.env, stdio: "ignore" });
  const { createDbClient } = await import("../servers/db.js");
  const db = createDbClient();
  // seed another flag to prove merge-preserve
  const { writeSetting } = await import("../servers/gateway/dashboard/settings/registry.js");
  await writeSetting(db, "feature_flags", JSON.stringify({ smart_chat: true }), { scope: "local" });

  const res = { redirectAfterPost() {} };
  await section.handleAction({ req: { body: { action: "set_bot_runtime", enabled: "on" } }, res, db, action: "set_bot_runtime" });
  const { readSetting } = await import("../servers/gateway/dashboard/settings/registry.js");
  const flags = JSON.parse(await readSetting(db, "feature_flags"));
  assert.equal(flags.bot_runtime, true);
  assert.equal(flags.smart_chat, true, "other flags preserved");

  assert.equal(await section.getPreview({ settings: { feature_flags: JSON.stringify({ bot_runtime: true }) } }), "enabled");
  assert.equal(await section.getPreview({ settings: {} }), "disabled");
});
