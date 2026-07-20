import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";

const MODULES = [
  "bridge.mjs", "bridge_tick_lib.mjs", "tracker.mjs", "skill_promote.mjs",
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

// Collect panel source files: the top-level .js file plus any extracted
// submodules in a same-named subdirectory (e.g. panels/bot-board/).
function panelSources(name) {
  const base = new URL(`../servers/gateway/dashboard/panels/`, import.meta.url);
  const files = [];
  const topFile = new URL(`${name}`, base);
  if (existsSync(topFile)) files.push(topFile);
  // Walk the subdirectory (name without .js extension) if it exists
  const subName = name.replace(/\.js$/, "");
  const subDir = new URL(`${subName}/`, base);
  if (existsSync(subDir)) {
    for (const entry of readdirSync(subDir)) {
      if (entry.endsWith(".js")) files.push(new URL(`${subName}/${entry}`, base));
    }
  }
  return files;
}

const PANELS = ["bot-builder.js", "bot-board.js"];
for (const p of PANELS) {
  const sources = panelSources(p);
  for (const src of sources) {
    const label = src.pathname.split("/servers/gateway/dashboard/panels/")[1];
    test(`panel ${label} has no hardcoded ~/.crow-mpa DB literal`, () => {
      const code = readFileSync(src, "utf8");
      assert.ok(!code.includes(".crow-mpa/data/tasks.db"), `${label} still hardcodes tasks.db`);
      assert.ok(!code.includes(".crow-mpa/data/crow.db"), `${label} still hardcodes crow.db`);
    });
  }
}
