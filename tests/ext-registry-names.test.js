// Bot Builder source names: an installed extension whose bundle has no capabilities block
// (knowledge-base, knowledge-base-mcp) is labelled by its manifest name, never its raw id.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listInstalledExtensions } from "../scripts/pi-bots/ext_registry.mjs";

function rig() {
  const root = mkdtempSync(join(tmpdir(), "ext-names-"));
  const home = join(root, "home"), bundles = join(root, "bundles");
  mkdirSync(home, { recursive: true });
  const bundle = (dir, id, manifest) => { mkdirSync(join(dir, id), { recursive: true }); writeFileSync(join(dir, id, "manifest.json"), JSON.stringify(manifest)); };
  bundle(bundles, "knowledge-base", { id: "knowledge-base", name: "Knowledge Base" });
  bundle(bundles, "knowledge-base-mcp", { id: "knowledge-base-mcp", name: "Knowledge Base (Python)" });
  bundle(bundles, "music", { id: "music", name: "Music Library", capabilities: { group: "Music", tools: [] } });
  // only in the instance's installed copy, not in the repo
  bundle(join(home, "bundles"), "local-only", { id: "local-only", name: "Local Thing" });
  const block = { command: "node", args: ["x.js"] };
  writeFileSync(join(home, "mcp-addons.json"), JSON.stringify({ "knowledge-base": block, "knowledge-base-mcp": block, music: block, "local-only": block, "no-manifest": block }));
  return { root, home, bundles };
}

test("an extension without a capabilities block takes its manifest name; the rest are unchanged", () => {
  const { root, home, bundles } = rig();
  try {
    const byId = Object.fromEntries(listInstalledExtensions(home, bundles).map((e) => [e.id, e]));
    assert.equal(byId["knowledge-base"].name, "Knowledge Base");
    assert.equal(byId["knowledge-base-mcp"].name, "Knowledge Base (Python)");
    assert.equal(byId["local-only"].name, "Local Thing", "the installed copy's manifest counts too");
    assert.equal(byId["no-manifest"].name, "no-manifest", "no manifest anywhere: the id, as before");
    assert.equal(byId.music.name, "Music Library");
    assert.equal(byId.music.group, "Music", "a capabilities group is unchanged");
    assert.equal(byId["knowledge-base"].group, "knowledge-base", "group keeps its old fallback (tool keys depend on it)");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
