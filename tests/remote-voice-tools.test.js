import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCapabilityTools } from "../servers/gateway/ai/remote-voice-tools.js";

test("parseCapabilityTools groups tools under their capability id", () => {
  const text = [
    "External integration tools:",
    "",
    "  funkwhale:",
    "    - fw_play: Play a track or start a radio.",
    "    - fw_search: Search the library.",
    "",
    "  home-assistant:",
    "    - ha_turn_on: Turn on a device.",
  ].join("\n");
  const map = parseCapabilityTools(text);
  assert.deepEqual([...map.keys()], ["funkwhale", "home-assistant"]);
  assert.deepEqual(map.get("funkwhale"), [
    { name: "fw_play", description: "Play a track or start a radio." },
    { name: "fw_search", description: "Search the library." },
  ]);
});

test("parseCapabilityTools tolerates empty / no-integrations text", () => {
  assert.equal(parseCapabilityTools("").size, 0);
  assert.equal(parseCapabilityTools("No external integrations connected.").size, 0);
  assert.equal(parseCapabilityTools(null).size, 0);
});

import { selectRemoteToolset } from "../servers/gateway/ai/remote-voice-tools.js";

test("selectRemoteToolset advertises only selected capabilities' tools + builds route map", () => {
  const parsedByInstance = new Map([
    ["inst-A", new Map([
      ["funkwhale", [
        { name: "fw_play", description: "Play music." },
        { name: "fw_search", description: "Search." },
      ]],
      ["home-assistant", [{ name: "ha_turn_on", description: "On." }]],
    ])],
  ]);
  const { advertised, routeMap } = selectRemoteToolset(parsedByInstance, [
    { instanceId: "inst-A", canonicalId: "funkwhale" },
  ]);
  assert.deepEqual(advertised.map(t => t.name), ["fw_play", "fw_search"]);
  assert.equal(routeMap.has("ha_turn_on"), false);
  assert.deepEqual(routeMap.get("fw_play"), { instanceId: "inst-A", canonicalId: "funkwhale" });
  assert.equal(advertised[0].inputSchema.type, "object");
  assert.equal(advertised[0].inputSchema.additionalProperties, true);
});

test("selectRemoteToolset: unknown instance/capability yields nothing; first name wins on clash", () => {
  const parsed = new Map([
    ["A", new Map([["funkwhale", [{ name: "fw_play", description: "A" }]]])],
    ["B", new Map([["funkwhale", [{ name: "fw_play", description: "B" }]]])],
  ]);
  const { advertised, routeMap } = selectRemoteToolset(parsed, [
    { instanceId: "A", canonicalId: "funkwhale" },
    { instanceId: "B", canonicalId: "funkwhale" },
    { instanceId: "Z", canonicalId: "nope" },
  ]);
  assert.equal(advertised.length, 1);
  assert.deepEqual(routeMap.get("fw_play"), { instanceId: "A", canonicalId: "funkwhale" });
});

import { rewriteAudioResult } from "../servers/gateway/ai/remote-voice-tools.js";

test("rewriteAudioResult rewrites a single fw_play envelope to the proxy URL + crow-peer auth", () => {
  const result = { content: [{ type: "text", text: JSON.stringify({
    prose: "Playing Blue in Green.",
    _audio_stream: { url: "http://crow-funkwhale/api/v1/listen/abc12345-dead-beef-cafe-0123456789ab/?to=opus", codec: "opus", auth: "funkwhale" },
  }) }] };
  const out = rewriteAudioResult(result, "https://crow.example:8443", "crow-inst-1");
  const parsed = JSON.parse(out.content[0].text);
  assert.equal(parsed._audio_stream.url,
    "https://crow.example:8443/audio/stream?cap=funkwhale&id=abc12345-dead-beef-cafe-0123456789ab&codec=opus");
  assert.equal(parsed._audio_stream.auth, "crow-peer:crow-inst-1");
  assert.equal(parsed._audio_stream.codec, "opus");
});

test("rewriteAudioResult rewrites every track in an album queue", () => {
  const mk = (uuid) => ({ url: `http://crow-funkwhale/api/v1/listen/${uuid}/?to=mp3`, codec: "mp3", auth: "funkwhale", title: "t" });
  const result = { content: [{ type: "text", text: JSON.stringify({
    _audio_stream: { ...mk("11111111-1111-1111-1111-111111111111"),
      queue: [mk("22222222-2222-2222-2222-222222222222"), mk("33333333-3333-3333-3333-333333333333")] },
  }) }] };
  const out = rewriteAudioResult(result, "https://crow.example:8443", "c1");
  const env = JSON.parse(out.content[0].text)._audio_stream;
  assert.match(env.url, /id=11111111/);
  assert.equal(env.auth, "crow-peer:c1");
  assert.equal(env.queue.length, 2);
  assert.match(env.queue[0].url, /id=22222222/);
  assert.match(env.queue[1].url, /id=33333333/);
  assert.equal(env.queue[0].auth, "crow-peer:c1");
  assert.equal(env.queue[0].title, "t");
});

test("rewriteAudioResult leaves non-audio / non-funkwhale results untouched", () => {
  const plain = { content: [{ type: "text", text: JSON.stringify({ ok: true, data: 1 }) }] };
  assert.equal(rewriteAudioResult(plain, "https://x", "c1").content[0].text, JSON.stringify({ ok: true, data: 1 }));
  const odd = { content: [{ type: "text", text: JSON.stringify({ _audio_stream: { url: "https://elsewhere/x.mp3", codec: "mp3" } }) }] };
  assert.equal(JSON.parse(rewriteAudioResult(odd, "https://x", "c1").content[0].text)._audio_stream.url, "https://elsewhere/x.mp3");
});
