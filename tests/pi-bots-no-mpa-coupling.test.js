import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const MODULES = [
  "bridge.mjs", "bridge_tick.mjs", "tracker.mjs", "skill_promote.mjs",
  "skill_provenance.mjs", "model_resolver.mjs", "mcp_writer.mjs",
  "discord_gateway.mjs", "gateways/gateway_runner.mjs",
];

for (const m of MODULES) {
  test(`${m} has no hardcoded ~/.crow-mpa DB literal`, () => {
    const src = readFileSync(new URL(`../scripts/pi-bots/${m}`, import.meta.url), "utf8");
    assert.ok(!src.includes(".crow-mpa/data/crow.db"), `${m} still hardcodes crow.db`);
    assert.ok(!src.includes(".crow-mpa/data/tasks.db"), `${m} still hardcodes tasks.db`);
    assert.ok(src.includes("instance-paths.mjs"), `${m} must import the resolver`);
  });
}

const PANELS = ["bot-builder.js", "bot-board.js"];
for (const p of PANELS) {
  test(`panel ${p} has no hardcoded ~/.crow-mpa DB literal`, () => {
    const src = readFileSync(new URL(`../servers/gateway/dashboard/panels/${p}`, import.meta.url), "utf8");
    assert.ok(!src.includes(".crow-mpa/data/tasks.db"), `${p} still hardcodes tasks.db`);
    assert.ok(!src.includes(".crow-mpa/data/crow.db"), `${p} still hardcodes crow.db`);
  });
}
