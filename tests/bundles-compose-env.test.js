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

test("compose env preserves the caller's other variables", () => {
  const env = composeEnv({ PATH: "/usr/bin", SOME_TOKEN: "abc" });
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.SOME_TOKEN, "abc");
});

test("an explicit CROW_HOME from the caller does not win over the resolved one", () => {
  const env = composeEnv({ CROW_HOME: "/wrong/instance" });
  assert.equal(env.CROW_HOME, CROW_HOME,
    "the resolved instance home must be authoritative — a stale inherited value is exactly the bug");
});
