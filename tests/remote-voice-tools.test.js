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
