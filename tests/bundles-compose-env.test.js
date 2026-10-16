import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { composeEnv } from "../servers/gateway/routes/bundles.js";
import { CROW_HOME } from "../servers/gateway/bundles-config.js";

test("compose always receives a CROW_HOME, even when the gateway's env has none", () => {
  const env = composeEnv({ PATH: "/usr/bin" });
  assert.equal(env.CROW_HOME, CROW_HOME);
  assert.ok(env.CROW_HOME && env.CROW_HOME.length > 0);
});

test("compose env passes only an allowlist of the gateway's variables (a compose file could interpolate any of them into its container)", () => {
  const env = composeEnv({ PATH: "/usr/bin", HOME: "/h", LC_ALL: "C", DOCKER_HOST: "unix:///x", SOME_TOKEN: "abc", ANTHROPIC_API_KEY: "k", CROW_LOCAL_MCP_TOKEN: "t", CROW_DB_PATH: "/d" });
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/h");
  assert.equal(env.LC_ALL, "C");
  assert.equal(env.DOCKER_HOST, "unix:///x");
  assert.equal(env.CROW_DB_PATH, "/d", "instance paths (not secrets) pass, so co-hosted instances mount their own DB");
  for (const k of ["SOME_TOKEN", "ANTHROPIC_API_KEY", "CROW_LOCAL_MCP_TOKEN"]) assert.equal(env[k], undefined, k);
});

test("an explicit CROW_HOME from the caller does not win over the resolved one", () => {
  const env = composeEnv({ CROW_HOME: "/wrong/instance" });
  assert.equal(env.CROW_HOME, CROW_HOME,
    "the resolved instance home must be authoritative — a stale inherited value is exactly the bug");
});
