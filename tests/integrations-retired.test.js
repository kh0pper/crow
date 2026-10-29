/**
 * The hard-coded integrations list is gone; every Crow-wide source that spawned
 * from .env or an installed add-on still spawns the same way (Review Focus 5).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  legacyEnvSources, isLegacyConfiguredAddon, legacyIntegrationsView,
} from "../servers/gateway/services/legacy-sources.js";
import { crowServerCatalog } from "../scripts/pi-bots/crow-server-catalog.mjs";

const REPO_ROOT = join(import.meta.dirname, "..");

// Today's Notion envTransform output for NOTION_TOKEN "ntn_abc123", computed from
// the retired integrations list before it was deleted.
const NOTION_HEADERS = "{\"Authorization\":\"Bearer ntn_abc123\",\"Notion-Version\":\"2022-06-28\"}";

test("legacy env sources still spawn", () => {
  const env = { GITHUB_PERSONAL_ACCESS_TOKEN: "test-token-1", BRAVE_API_KEY: "test-token-2", CROW_ENABLE_ARXIV: "1" };
  const sources = legacyEnvSources(env);
  assert.deepEqual(sources.map((s) => s.id).sort(), ["arxiv", "brave-search", "github"]);

  const github = sources.find((s) => s.id === "github");
  assert.equal(github.command, "npx");
  assert.deepEqual(github.args, ["-y", "@modelcontextprotocol/server-github"]);
  assert.deepEqual(github.env, { GITHUB_PERSONAL_ACCESS_TOKEN: "test-token-1" });
  assert.deepEqual(github.requires, []);

  const brave = sources.find((s) => s.id === "brave-search");
  assert.deepEqual(brave.args, ["-y", "@modelcontextprotocol/server-brave-search"]);
  assert.deepEqual(brave.env, { BRAVE_API_KEY: "test-token-2" });

  const arxiv = sources.find((s) => s.id === "arxiv");
  assert.equal(arxiv.command, "uvx");
  assert.deepEqual(arxiv.args, ["arxiv-mcp-server"]);
  assert.deepEqual(arxiv.requires, ["uvx"]);
  assert.deepEqual(arxiv.env, { CROW_ENABLE_ARXIV: "1" });

  const [notion] = legacyEnvSources({ NOTION_TOKEN: "ntn_abc123" });
  assert.equal(notion.id, "notion");
  assert.deepEqual(notion.env, { NOTION_TOKEN: "ntn_abc123", OPENAPI_MCP_HEADERS: NOTION_HEADERS });
});

test("a source needs every field; render keeps its key out of argv", () => {
  assert.deepEqual(legacyEnvSources({ HA_URL: "http://ha.example" }), []);
  assert.deepEqual(legacyEnvSources({ TRELLO_API_KEY: "k" }), []);
  assert.deepEqual(legacyEnvSources({}), []);
  const [render] = legacyEnvSources({ RENDER_API_KEY: "test-token-3" });
  assert.equal(render.id, "render");
  assert.deepEqual(render.args, ["-y", "mcp-remote", "https://mcp.render.com/mcp", "--header", "Authorization:${AUTH_HEADER}"]);
  assert.equal(render.env.AUTH_HEADER, "Bearer test-token-3");
  assert.ok(!render.args.join(" ").includes("test-token-3"));
});

test("env google still spawns", () => {
  const sources = legacyEnvSources({ GOOGLE_CLIENT_ID: "test-id", GOOGLE_CLIENT_SECRET: "test-secret" });
  assert.equal(sources.length, 1);
  const g = sources[0];
  assert.equal(g.id, "google-workspace");
  assert.equal(g.command, "uvx");
  assert.deepEqual(g.args, ["workspace-mcp"]);
  assert.deepEqual(g.requires, ["uvx"]);
  assert.deepEqual(g.env, { GOOGLE_CLIENT_ID: "test-id", GOOGLE_CLIENT_SECRET: "test-secret" });
  assert.deepEqual(legacyEnvSources({ GOOGLE_CLIENT_ID: "test-id" }), []);
});

test("configured addon still loads", () => {
  const full = { command: "npx", args: ["-y", "hass-mcp"], env: { HA_URL: "http://ha.example", HA_TOKEN: "test-token-4" } };
  assert.equal(isLegacyConfiguredAddon("home-assistant", full, undefined, {}), true);
  const noToken = { ...full, env: { HA_URL: "http://ha.example" } };
  assert.equal(isLegacyConfiguredAddon("home-assistant", noToken, undefined, {}), false);
  assert.equal(isLegacyConfiguredAddon("funkwhale", { command: "node", args: [] }, undefined, {}), true);
  assert.equal(isLegacyConfiguredAddon("google-workspace", { command: "uvx", args: [] }, undefined, {}), true);
});

test("an addon configured only through process.env still loads (R10)", () => {
  const entry = { command: "npx", args: ["-y", "hass-mcp"] };
  const saved = { HA_URL: process.env.HA_URL, HA_TOKEN: process.env.HA_TOKEN };
  try {
    delete process.env.HA_URL;
    delete process.env.HA_TOKEN;
    assert.equal(isLegacyConfiguredAddon("home-assistant", entry), false);
    process.env.HA_URL = "http://ha.example";
    process.env.HA_TOKEN = "test-token-5";
    // The proxy calls it with the default env (process.env), as addonStdioEnv spawns.
    assert.equal(isLegacyConfiguredAddon("home-assistant", entry), true);
    // Mixed: one field in the entry, the other in the environment.
    delete process.env.HA_URL;
    assert.equal(isLegacyConfiguredAddon("home-assistant", { ...entry, env: { HA_URL: "http://ha.example" } }), true);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

function homeWithHa(haEnv) {
  const dir = mkdtempSync(join(tmpdir(), "services-retired-"));
  const home = join(dir, ".crow");
  mkdirSync(join(home, "bundles", "home-assistant"), { recursive: true });
  mkdirSync(join(home, "bundles", "funkwhale"), { recursive: true });
  mkdirSync(join(home, "data"), { recursive: true });
  writeFileSync(join(home, "mcp-addons.json"), JSON.stringify({
    "home-assistant": { command: "npx", args: ["-y", "hass-mcp"], env: haEnv },
    funkwhale: { command: "node", args: ["server/index.js"], env: { FUNKWHALE_URL: "http://fw.example" } },
  }));
  return home;
}

test("catalog skips unconfigured service", () => {
  const saved = process.env.HA_TOKEN;
  try {
    delete process.env.HA_TOKEN;
    const { servers, unconfigured } = crowServerCatalog(homeWithHa({ HA_URL: "http://ha.example" }));
    assert.equal(unconfigured["home-assistant"], "service: its account fields are not set");
    assert.equal(servers["home-assistant"], undefined);
    assert.notEqual(unconfigured.funkwhale, "service: its account fields are not set");

    // Configured through the environment instead: not skipped as a service.
    process.env.HA_TOKEN = "test-token-6";
    const again = crowServerCatalog(homeWithHa({ HA_URL: "http://ha.example" }));
    assert.notEqual(again.unconfigured["home-assistant"], "service: its account fields are not set");
  } finally {
    if (saved === undefined) delete process.env.HA_TOKEN; else process.env.HA_TOKEN = saved;
  }
});

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(m?js|md|ts)$/.test(name)) out.push(p);
  }
  return out;
}

test("no INTEGRATIONS left", async () => {
  await assert.rejects(import("../servers/gateway/integrations.js"));
  // R11a: only the retired module's own paths; the settings section file of the same name stays.
  const pattern = /gateway\/integrations\.js|from\s+["'](?:\.\.?\/)+integrations\.js["']|import\(\s*["'](?:\.\.?\/)+integrations\.js["']/;
  const hits = [];
  for (const top of ["servers", "scripts", "docs"]) {
    for (const file of walk(join(REPO_ROOT, top))) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => { if (pattern.test(line)) hits.push(`${file.slice(REPO_ROOT.length + 1)}:${i + 1}`); });
    }
  }
  assert.deepEqual(hits, []);
});

test("no dead cards", () => {
  const cards = legacyIntegrationsView();
  const ids = cards.map((c) => c.id);
  assert.ok(!ids.includes("slack"));
  assert.ok(!ids.includes("microsoft-teams"));
  for (const id of ["github", "brave-search", "notion", "home-assistant", "arxiv", "google-workspace"]) {
    assert.ok(ids.includes(id), id);
  }
  for (const c of cards) {
    assert.ok(["productivity", "communication", "development"].includes(c.category), c.id);
    assert.ok(Array.isArray(c.envVars) && c.envVars.length > 0, c.id);
  }
  const arxiv = cards.find((c) => c.id === "arxiv");
  assert.deepEqual(arxiv.envVars, ["CROW_ENABLE_ARXIV"]);
  assert.equal(arxiv.toggleEnv, "CROW_ENABLE_ARXIV");
  const gh = legacyIntegrationsView(undefined, { GITHUB_PERSONAL_ACCESS_TOKEN: "x" }).find((c) => c.id === "github");
  assert.equal(gh.configured, true);
  assert.equal(gh.keyUrl, "https://github.com/settings/tokens");
});

test("getProxyStatus keeps the card shape", async () => {
  const { getProxyStatus } = await import("../servers/gateway/proxy.js");
  const cards = getProxyStatus();
  const keys = ["id", "name", "description", "configured", "status", "toolCount", "error", "envVars",
    "keyUrl", "keyInstructions", "requiresMissing", "requires", "docsUrl"];
  const gh = cards.find((c) => c.id === "github");
  for (const k of keys) assert.ok(k in gh, k);
  assert.ok(!cards.some((c) => c.id === "slack" || c.id === "microsoft-teams"));
});

test("a service add-on's child gets its derived env; a non-service add-on is unchanged (I1)", async () => {
  const { addonStdioEnv } = await import("../servers/gateway/proxy.js");
  const render = { command: "npx", args: ["-y", "mcp-remote", "https://mcp.render.com/mcp", "--header", "Authorization:${AUTH_HEADER}"] };
  const fromEntry = addonStdioEnv({ ...render, env: { RENDER_API_KEY: "test-token-7" } }, {}, "render");
  assert.equal(fromEntry.AUTH_HEADER, "Bearer test-token-7");
  assert.equal(fromEntry.CROW_ADDON_HOST, "gateway");
  // The key only in the gateway's environment, as the child inherits it.
  assert.equal(addonStdioEnv(render, { RENDER_API_KEY: "test-token-8" }, "render").AUTH_HEADER, "Bearer test-token-8");
  // entry.env wins over the environment, the same precedence as the spawn.
  assert.equal(addonStdioEnv({ ...render, env: { RENDER_API_KEY: "entry" } }, { RENDER_API_KEY: "base" }, "render").AUTH_HEADER, "Bearer entry");
  const fw = { command: "node", args: ["server/index.js"], env: { FUNKWHALE_URL: "http://fw.example" } };
  assert.deepEqual(addonStdioEnv(fw, { PATH: "/bin" }, "funkwhale"), addonStdioEnv(fw, { PATH: "/bin" }));
  assert.deepEqual(addonStdioEnv(fw, { PATH: "/bin" }, "funkwhale"),
    { PATH: "/bin", FUNKWHALE_URL: "http://fw.example", CROW_ADDON_HOST: "gateway" });
});

test("the bot catalog gives a Render add-on its AUTH_HEADER (I1)", () => {
  const dir = mkdtempSync(join(tmpdir(), "services-render-"));
  const home = join(dir, ".crow");
  mkdirSync(join(home, "bundles", "render"), { recursive: true });
  mkdirSync(join(home, "bundles", "funkwhale"), { recursive: true });
  mkdirSync(join(home, "data"), { recursive: true });
  writeFileSync(join(home, "mcp-addons.json"), JSON.stringify({
    render: { command: "npx", args: ["-y", "mcp-remote", "https://mcp.render.com/mcp", "--header", "Authorization:${AUTH_HEADER}"], env: { RENDER_API_KEY: "test-token-9" } },
    funkwhale: { command: "node", args: ["server/index.js"], env: { FUNKWHALE_URL: "http://fw.example" } },
  }));
  const { servers, unconfigured } = crowServerCatalog(home);
  assert.ok(servers.render, `render unconfigured: ${unconfigured.render}`);
  assert.equal(servers.render.env.AUTH_HEADER, "Bearer test-token-9");
  assert.equal(servers.render.env.RENDER_API_KEY, "test-token-9");
  assert.ok(servers.funkwhale, `funkwhale unconfigured: ${unconfigured.funkwhale}`);
  assert.deepEqual(servers.funkwhale.env, { FUNKWHALE_URL: "http://fw.example", CROW_HOME: home });
});

test("the bot catalog never renders a derived secret from the environment into a block", () => {
  const dir = mkdtempSync(join(tmpdir(), "services-render-env-"));
  const home = join(dir, ".crow");
  mkdirSync(join(home, "bundles", "render"), { recursive: true });
  mkdirSync(join(home, "data"), { recursive: true });
  writeFileSync(join(home, "mcp-addons.json"), JSON.stringify({
    render: { command: "npx", args: ["-y", "mcp-remote", "https://mcp.render.com/mcp", "--header", "Authorization:${AUTH_HEADER}"] },
  }));
  const saved = process.env.RENDER_API_KEY;
  process.env.RENDER_API_KEY = "test-token-11";
  try {
    const { servers } = crowServerCatalog(home);
    const env = servers.render?.env || {};
    assert.equal(env.AUTH_HEADER, undefined, "no Bearer header built from the environment");
    assert.ok(!JSON.stringify(servers.render || {}).includes("test-token-11"), "the environment's key is not in the block");
  } finally {
    if (saved === undefined) delete process.env.RENDER_API_KEY; else process.env.RENDER_API_KEY = saved;
  }
});

test("proxy start: env sources first, then backends, then add-ons; a service add-on with no fields is skipped", async () => {
  const proxy = await import("../servers/gateway/proxy.js");
  const dir = mkdtempSync(join(tmpdir(), "services-wiring-"));
  const home = join(dir, ".crow");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "mcp-addons.json"), JSON.stringify({
    render: { command: "npx", args: ["-y", "mcp-remote"] },
    funkwhale: { command: "node", args: ["server/index.js"] },
  }));
  const saved = { CROW_HOME: process.env.CROW_HOME, RENDER_API_KEY: process.env.RENDER_API_KEY };
  const calls = [];
  const source = { id: "github", name: "GitHub", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], envVars: ["GITHUB_PERSONAL_ACCESS_TOKEN"], requires: [], env: { GITHUB_PERSONAL_ACCESS_TOKEN: "test-token-10" } };
  try {
    process.env.CROW_HOME = home;
    delete process.env.RENDER_API_KEY;
    proxy._setProxyDepsForTest({
      legacyEnvSources: () => { calls.push("legacyEnvSources"); return [source]; },
      connectToServer: async (i) => { calls.push(`env:${i.id}`); assert.deepEqual(i.env, source.env); return null; },
      loadDynamicBackends: async () => { calls.push("backends"); },
      connectAddonServer: async (id) => { calls.push(`addon:${id}`); return null; },
    });
    await proxy.initProxyServers();
    assert.deepEqual(calls, ["legacyEnvSources", "env:github", "backends", "addon:funkwhale"]);
  } finally {
    proxy._setProxyDepsForTest(null);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});
