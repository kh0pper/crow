import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const put = (root, rel, c) => { const p = join(root, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, c); };
let HOME, repair;
before(async () => {
  HOME = mkdtempSync(join(tmpdir(), "crowhome-mcpreg-"));
  process.env.CROW_HOME = HOME;
  ({ repairInstalledBundleAssets: repair } = await import("../servers/gateway/routes/bundles.js"));
});
after(() => { delete process.env.CROW_HOME; });
const run = async () => ({ stdout: "", stderr: "" });

test("a version bump that adds `server` registers the MCP entry for an existing install", async () => {
  const repo = mkdtempSync(join(tmpdir(), "repo-"));
  put(repo, "dockerish/manifest.json", JSON.stringify({ id: "dockerish", version: "0.2.0", type: "bundle", docker: { composefile: "docker-compose.yml" },
    server: { command: "node", args: ["server/index.js"], envKeys: [] }, env_vars: [{ name: "PORTX", default: "8456" }, { name: "S", secret: true, generate: "secret" }] }));
  put(repo, "dockerish/server/index.js", "// v2\n");
  put(HOME, "bundles/dockerish/manifest.json", JSON.stringify({ id: "dockerish", version: "0.1.2", type: "bundle", docker: { composefile: "docker-compose.yml" } }));
  put(HOME, "installed.json", JSON.stringify([{ id: "dockerish" }]));
  put(HOME, "mcp-addons.json", JSON.stringify({ other: { command: "node", args: ["x.js"] } }));
  const { repaired } = await repair({ appBundles: repo, run });
  const addons = JSON.parse(readFileSync(join(HOME, "mcp-addons.json"), "utf8"));
  assert.deepEqual(addons.dockerish, { command: "node", args: ["server/index.js"], env: { PORTX: "8456" } });
  assert.deepEqual(addons.other, { command: "node", args: ["x.js"] });
  assert.match(repaired.join(" "), /mcp-addons entry/);
});

test("an existing entry is never rewritten by refresh", async () => {
  const repo = mkdtempSync(join(tmpdir(), "repo2-"));
  put(repo, "keepme/manifest.json", JSON.stringify({ id: "keepme", version: "2.0.0", type: "mcp-server", server: { command: "node", args: ["server/index.js"] } }));
  put(repo, "keepme/server/index.js", "// v2\n");
  put(HOME, "bundles/keepme/manifest.json", JSON.stringify({ id: "keepme", version: "1.0.0", type: "mcp-server" }));
  put(HOME, "installed.json", JSON.stringify([{ id: "keepme" }]));
  const custom = { command: "node", args: ["server/index.js"], env: { OPERATOR_SET: "1" }, cwd: "/custom" };
  put(HOME, "mcp-addons.json", JSON.stringify({ keepme: custom }));
  await repair({ appBundles: repo, run });
  assert.deepEqual(JSON.parse(readFileSync(join(HOME, "mcp-addons.json"), "utf8")).keepme, custom);
});

test("final M2: an mcp-addons.json that exists but does not parse is never rewritten (other add-ons are not wiped)", async () => {
  const repo = mkdtempSync(join(tmpdir(), "repo3-"));
  put(repo, "newsrv/manifest.json", JSON.stringify({ id: "newsrv", version: "2.0.0", type: "bundle", server: { command: "node", args: ["server/index.js"] } }));
  put(repo, "newsrv/server/index.js", "// v2\n");
  put(HOME, "bundles/newsrv/manifest.json", JSON.stringify({ id: "newsrv", version: "1.0.0", type: "bundle" }));
  put(HOME, "installed.json", JSON.stringify([{ id: "newsrv" }]));
  const broken = '{ "other": { "command": "node", "args": ["x.js"] }, '; // truncated mid-write
  put(HOME, "mcp-addons.json", broken);
  const warn = console.warn; const warned = []; console.warn = (...a) => warned.push(a.join(" "));
  let repaired;
  try { ({ repaired } = await repair({ appBundles: repo, run })); } finally { console.warn = warn; }
  assert.equal(readFileSync(join(HOME, "mcp-addons.json"), "utf8"), broken, "left byte-identical");
  assert.doesNotMatch(repaired.join(" "), /mcp-addons entry/);
  assert.ok(warned.some((w) => /mcp-addons\.json/.test(w)), "the skip is logged");
  assert.equal(JSON.parse(readFileSync(join(HOME, "bundles/newsrv/manifest.json"), "utf8")).version, "1.0.0", "installed manifest stays old → the next boot retries");
  // once the file is fixed, the next refresh registers the entry and keeps the others
  put(HOME, "mcp-addons.json", JSON.stringify({ other: { command: "node", args: ["x.js"] } }));
  await repair({ appBundles: repo, run });
  const addons = JSON.parse(readFileSync(join(HOME, "mcp-addons.json"), "utf8"));
  assert.ok(addons.newsrv); assert.deepEqual(addons.other, { command: "node", args: ["x.js"] });
});
