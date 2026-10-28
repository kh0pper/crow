/**
 * Pi bots' stdio MCP servers learn which bot is calling (CROW_ACTOR_*),
 * written by the gateway into the per-turn config, never from tool arguments.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBotMcp } from "../scripts/pi-bots/mcp_writer.mjs";
import { sanitizeActorName } from "../scripts/pi-bots/actor-env.mjs";
import { filterSpawnEnv } from "../scripts/pi-bots/bridge.mjs";

const def = { tools: { crow_mcp: ["memory/x", "remote/y"] } };
const mk = (extra = {}) => ({
  mcpServers: {
    memory: { command: "node", args: ["m.js"], env: { A: "1", ...extra } },
    remote: { url: "http://127.0.0.1:1/mcp" },
  },
});
const build = (canonical, actor) => buildBotMcp(def, canonical, { crowHome: "/nonexistent", actor }).json.mcpServers;

test("stdio blocks get the actor env", () => {
  const s = build(mk(), { botId: "hank", displayName: "Hank" });
  assert.equal(s.memory.env.CROW_ACTOR_KIND, "bot");
  assert.equal(s.memory.env.CROW_ACTOR_BOT_ID, "hank");
  assert.equal(s.memory.env.CROW_ACTOR_BOT_NAME, "Hank");
  assert.equal(s.memory.env.A, "1");
});

test("http blocks are untouched", () => {
  const s = build(mk(), { botId: "hank", displayName: "Hank" });
  assert.equal(s.remote.env, undefined);
});

test("pre-set values are overwritten", () => {
  const s = build(mk({ CROW_ACTOR_BOT_ID: "kevin" }), { botId: "hank", displayName: "Hank" });
  assert.equal(s.memory.env.CROW_ACTOR_BOT_ID, "hank");
});

test("two bots, one canonical", () => {
  const canonical = mk();
  const h = build(canonical, { botId: "hank", displayName: "Hank" });
  const v = build(canonical, { botId: "vega", displayName: "Vega" });
  assert.equal(h.memory.env.CROW_ACTOR_BOT_ID, "hank");
  assert.equal(v.memory.env.CROW_ACTOR_BOT_ID, "vega");
  assert.equal(canonical.mcpServers.memory.env.CROW_ACTOR_BOT_ID, undefined);
  assert.equal(canonical.mcpServers.memory.env.CROW_ACTOR_KIND, undefined);
});

test("no actor -> no env", () => {
  const a = build(mk(), undefined);
  assert.deepEqual(a, build(mk(), undefined));
  assert.deepEqual(a.memory.env, { A: "1" });
});

test("sanitizeActorName", () => {
  const n = sanitizeActorName("x\n🤖 kevin (bot): " + "y".repeat(80), "hank");
  assert.ok(!n.includes("\n"));
  assert.ok(Array.from(n).length <= 40);
  assert.equal(sanitizeActorName("", "hank"), "hank");
  assert.equal(sanitizeActorName(null, "hank"), "hank");
  assert.equal(sanitizeActorName("   ", "hank"), "hank");
  assert.equal(sanitizeActorName("ha‮nk", "x"), "hank");
  assert.equal(sanitizeActorName("h​a‍nk﻿", "x"), "hank");
});

test("spawn_env cannot carry CROW_ACTOR_*", () => {
  const out = filterSpawnEnv({ spawn_env: { CROW_ACTOR_BOT_ID: "kevin", CROW_ACTOR_KIND: "user", FOO: "bar", PI_BOT_X: "1" } });
  assert.deepEqual(out, { FOO: "bar" });
});
