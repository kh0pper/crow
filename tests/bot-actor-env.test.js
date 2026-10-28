/**
 * Pi bots' stdio MCP servers learn which bot is calling (CROW_ACTOR_*),
 * written by the gateway into the per-turn config, never from tool arguments.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBotMcp, writeBotMcp } from "../scripts/pi-bots/mcp_writer.mjs";
import { sanitizeActorName, actorEnvFor } from "../scripts/pi-bots/actor-env.mjs";
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
  const s = build(mk({ CROW_ACTOR_BOT_ID: "alex" }), { botId: "hank", displayName: "Hank" });
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
  const n = sanitizeActorName("x\n🤖 alex (bot): " + "y".repeat(80), "hank");
  assert.ok(!n.includes("\n"));
  assert.ok(Array.from(n).length <= 40);
  assert.equal(sanitizeActorName("", "hank"), "hank");
  assert.equal(sanitizeActorName(null, "hank"), "hank");
  assert.equal(sanitizeActorName("   ", "hank"), "hank");
  assert.equal(sanitizeActorName("ha‮nk", "x"), "hank");
  assert.equal(sanitizeActorName("h​a‍nk﻿", "x"), "hank");
});

test("spawn_env cannot carry CROW_ACTOR_*", () => {
  const out = filterSpawnEnv({ spawn_env: { CROW_ACTOR_BOT_ID: "alex", CROW_ACTOR_KIND: "user", FOO: "bar", PI_BOT_X: "1" } });
  assert.deepEqual(out, { FOO: "bar" });
});

test("CROW_ACTOR_THREAD: present only for a non-empty string, sanitized and capped", () => {
  assert.equal(actorEnvFor({ botId: "hank", displayName: "Hank", threadId: "t-1" }).CROW_ACTOR_THREAD, "t-1");
  for (const t of [undefined, null, "", 42, "\u200b\n"]) {
    assert.ok(!("CROW_ACTOR_THREAD" in actorEnvFor({ botId: "hank", displayName: "Hank", threadId: t })), String(t));
  }
  assert.equal(actorEnvFor({ botId: "h", threadId: "a\nb\u202ec" }).CROW_ACTOR_THREAD, "abc");
  assert.equal(Array.from(actorEnvFor({ botId: "h", threadId: "x".repeat(500) }).CROW_ACTOR_THREAD).length, 200);
});

test("thread env reaches stdio blocks and is overwritten; absent -> key absent", () => {
  const s = build(mk({ CROW_ACTOR_THREAD: "stale" }), { botId: "hank", displayName: "Hank", threadId: "t-9" });
  assert.equal(s.memory.env.CROW_ACTOR_THREAD, "t-9");
  assert.equal(s.remote.env, undefined);
  const n = build(mk(), { botId: "hank", displayName: "Hank" });
  assert.ok(!("CROW_ACTOR_THREAD" in n.memory.env));
});

test("writeBotMcp derives the actor from opts.botId/displayName/threadId", () => {
  const home = mkdtempSync(join(tmpdir(), "bot-actor-"));
  const run = (o) => writeBotMcp(def, {
    sessionDir: join(home, "s"), crowHome: home, canonical: mk(), binding: null, extraServers: {}, write: false, ...o,
  }).json.mcpServers.memory.env;
  const e = run({ botId: "hank", displayName: "Hank", threadId: "t-7" });
  assert.equal(e.CROW_ACTOR_KIND, "bot");
  assert.equal(e.CROW_ACTOR_BOT_ID, "hank");
  assert.equal(e.CROW_ACTOR_BOT_NAME, "Hank");
  assert.equal(e.CROW_ACTOR_THREAD, "t-7");
  const f = run({ botId: "hank" });
  assert.equal(f.CROW_ACTOR_BOT_NAME, "hank", "falls back to the id");
  assert.ok(!("CROW_ACTOR_THREAD" in f));
  const g = run({});
  assert.ok(!("CROW_ACTOR_KIND" in g), "no botId -> no actor env");
});
