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

  assert.equal(await section.getPreview({ db, settings: {}, lang: "en" }), "Enabled", "preview reads the real state");
});

// --- Settings audit 2026-10-20: the page must show the REAL runtime state and
// a Save must never change the runtime unless the operator changed the box. ---

async function freshDbAt(dataDir) {
  const { mkdirSync } = await import("node:fs");
  mkdirSync(dataDir, { recursive: true });
  process.env.CROW_DATA_DIR = dataDir; process.env.CROW_DB_PATH = join(dataDir, "crow.db");
  const { execSync } = await import("node:child_process");
  execSync("node scripts/init-db.js", { env: process.env, stdio: "ignore" });
  const { createDbClient } = await import("../servers/db.js");
  return createDbClient();
}

async function flagsOf(db) {
  const { readSetting } = await import("../servers/gateway/dashboard/settings/registry.js");
  const raw = await readSetting(db, "feature_flags");
  return raw ? JSON.parse(raw) : null;
}

test("default-on host (no explicit flag): page and preview show the runtime ON", async () => {
  const db = await freshDbAt(join(mkdtempSync(join(tmpdir(), "f3b-mpa-")), ".crow-mpa", "data"));
  const html = await section.render({ db, lang: "en" });
  assert.match(html, /name="enabled" checked/, "checkbox reflects the real (host-default) state");
  assert.match(html, /name="was" value="on"/);
  assert.equal(await section.getPreview({ db, settings: {}, lang: "en" }), "Enabled");
});

test("default-on host: Save without touching the box writes nothing and leaves bots running", async () => {
  const db = await freshDbAt(join(mkdtempSync(join(tmpdir(), "f3b-mpa-")), ".crow-mpa", "data"));
  const res = { redirectAfterPost() {} };
  await section.handleAction({ req: { body: { action: "set_bot_runtime", enabled: "on", was: "on" } }, res, db, action: "set_bot_runtime" });
  assert.equal(await flagsOf(db), null, "no feature_flags write");
  const { botRuntimeActive } = await import("../servers/gateway/dashboard/panels/bot-runtime-flag.js");
  assert.equal(await botRuntimeActive(db), true);
});

test("default-on host: an old page without `was` that submits the current state writes nothing", async () => {
  const db = await freshDbAt(join(mkdtempSync(join(tmpdir(), "f3b-mpa-")), ".crow-mpa", "data"));
  const res = { redirectAfterPost() {} };
  await section.handleAction({ req: { body: { action: "set_bot_runtime", enabled: "on" } }, res, db, action: "set_bot_runtime" });
  assert.equal(await flagsOf(db), null);
});

test("default-on host: unticking the box turns the runtime off", async () => {
  const db = await freshDbAt(join(mkdtempSync(join(tmpdir(), "f3b-mpa-")), ".crow-mpa", "data"));
  const res = { redirectAfterPost() {} };
  await section.handleAction({ req: { body: { action: "set_bot_runtime", was: "on" } }, res, db, action: "set_bot_runtime" });
  assert.equal((await flagsOf(db)).bot_runtime, false);
});

test("default-off host: Save with the box unticked writes nothing; ticking it turns the runtime on", async () => {
  const db = await freshDbAt(join(mkdtempSync(join(tmpdir(), "f3b-off-")), "data"));
  const res = { redirectAfterPost() {} };
  const html = await section.render({ db, lang: "en" });
  assert.doesNotMatch(html, /name="enabled" checked/);
  await section.handleAction({ req: { body: { action: "set_bot_runtime", was: "off" } }, res, db, action: "set_bot_runtime" });
  assert.equal(await flagsOf(db), null, "no write when nothing changed");
  await section.handleAction({ req: { body: { action: "set_bot_runtime", enabled: "on", was: "off" } }, res, db, action: "set_bot_runtime" });
  assert.equal((await flagsOf(db)).bot_runtime, true);
});

test("Bot Builder's one-click enable (enabled=on, no `was`) still turns the runtime on on a default-off host", async () => {
  const db = await freshDbAt(join(mkdtempSync(join(tmpdir(), "f3b-bb-")), "data"));
  const res = { redirectAfterPost() {} };
  await section.handleAction({ req: { body: { action: "set_bot_runtime", enabled: "on" } }, res, db, action: "set_bot_runtime" });
  assert.equal((await flagsOf(db)).bot_runtime, true);
});
