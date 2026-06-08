import { test } from "node:test";
import assert from "node:assert/strict";

// Functions read process.env at call time, so set/clear around each call.
const ENV_KEYS = ["CROW_DB_PATH", "CROW_TASKS_DB_PATH", "CROW_DATA_DIR"];
function clearEnv() { for (const k of ENV_KEYS) delete process.env[k]; }

const { botsDbPath, tasksDbPath, botsWorkspaceRoot } =
  await import("../scripts/pi-bots/instance-paths.mjs");

test("CROW_DB_PATH is honored verbatim and anchors siblings", () => {
  clearEnv();
  process.env.CROW_DB_PATH = "/home/kh0pp/.crow-mpa/data/crow.db";
  assert.equal(botsDbPath(), "/home/kh0pp/.crow-mpa/data/crow.db");
  assert.equal(tasksDbPath(), "/home/kh0pp/.crow-mpa/data/tasks.db");
  assert.equal(botsWorkspaceRoot(), "/home/kh0pp/.crow-mpa/pi-bots");
});

test("falls back to CROW_DATA_DIR when CROW_DB_PATH is unset", () => {
  clearEnv();
  process.env.CROW_DATA_DIR = "/tmp/f3/data";
  assert.equal(botsDbPath(), "/tmp/f3/data/crow.db");
  assert.equal(tasksDbPath(), "/tmp/f3/data/tasks.db");
  assert.equal(botsWorkspaceRoot(), "/tmp/f3/pi-bots");
});

test("explicit CROW_TASKS_DB_PATH overrides the derived tasks path", () => {
  clearEnv();
  process.env.CROW_DB_PATH = "/tmp/f3/data/crow.db";
  process.env.CROW_TASKS_DB_PATH = "/tmp/other/tasks.db";
  assert.equal(tasksDbPath(), "/tmp/other/tasks.db");
});

test("never returns a ~/.crow-mpa literal when env points elsewhere", () => {
  clearEnv();
  process.env.CROW_DATA_DIR = "/tmp/general/data";
  assert.ok(!botsDbPath().includes(".crow-mpa"));
  assert.ok(!botsWorkspaceRoot().includes(".crow-mpa"));
});
