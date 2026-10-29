import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateManifest } from "../scripts/lib/bundle-contract.mjs";
import { translations } from "../servers/gateway/dashboard/shared/i18n.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const METHODS = {
  "home-assistant": "token",
  github: "token",
  "brave-search": "token",
  trello: "token",
  "canvas-lms": "token",
  notion: "token",
  discord: "token",
  zotero: "token",
  render: "token",
  obsidian: "folder",
  arxiv: "toggle",
};
const IDS = Object.keys(METHODS);
const NEW_IDS = IDS.filter((i) => i !== "home-assistant" && i !== "obsidian");
const manifest = (id) => JSON.parse(readFileSync(join(ROOT, "bundles", id, "manifest.json"), "utf8"));

test("every service bundle passes validateManifest with its connect method", () => {
  for (const id of IDS) {
    const m = manifest(id);
    const r = validateManifest(m, join(ROOT, "bundles", id));
    assert.equal(r.ok, true, `${id}: ${r.errors?.join("; ")}`);
    assert.equal(m.connect.method, METHODS[id], id);
  }
});

test("new bundles start at 1.0.0; home-assistant and obsidian are 1.1.0", () => {
  for (const id of NEW_IDS) {
    const m = manifest(id);
    assert.equal(m.version, "1.0.0", id);
    assert.equal(m.type, "mcp-server", id);
    assert.equal(m.author, "Crow", id);
  }
  assert.equal(manifest("home-assistant").version, "1.1.0");
  assert.equal(manifest("obsidian").version, "1.1.0");
});

test("dead packages and unverified bundles are absent", () => {
  for (const id of ["slack", "microsoft-teams", "mcp-research"]) {
    assert.equal(existsSync(join(ROOT, "bundles", id, "manifest.json")), false, id);
  }
  const reg = readFileSync(join(ROOT, "scripts/server-registry.js"), "utf8");
  assert.doesNotMatch(reg, /name:\s*"(slack|microsoft-teams)"/);
});

test("server commands match the retired integrations catalog", () => {
  const want = {
    trello: ["npx", ["-y", "mcp-server-trello"]],
    "canvas-lms": ["npx", ["-y", "mcp-canvas-lms"]],
    github: ["npx", ["-y", "@modelcontextprotocol/server-github"]],
    "brave-search": ["npx", ["-y", "@modelcontextprotocol/server-brave-search"]],
    notion: ["npx", ["-y", "@notionhq/notion-mcp-server"]],
    discord: ["npx", ["-y", "mcp-discord"]],
    zotero: ["uvx", ["zotero-mcp"]],
    arxiv: ["uvx", ["arxiv-mcp-server"]],
    render: ["npx", ["-y", "mcp-remote", "https://mcp.render.com/mcp", "--header", "Authorization:${AUTH_HEADER}"]],
  };
  for (const [id, [command, args]] of Object.entries(want)) {
    const m = manifest(id);
    assert.equal(m.server.command, command, id);
    assert.deepEqual(m.server.args, args, id);
  }
  assert.deepEqual(manifest("zotero").requires.bins, ["uvx"]);
  assert.deepEqual(manifest("arxiv").requires.bins, ["uvx"]);
  assert.equal(manifest("arxiv").connect.legacy_enable_env, "CROW_ENABLE_ARXIV");
});

test("every connect label and step resolves in en and es", () => {
  for (const id of IDS) {
    const c = manifest(id).connect;
    const keys = [...c.steps, ...c.fields.flatMap((f) => [f.label_key, f.help_key].filter(Boolean))];
    for (const k of keys) {
      assert.ok(translations[k]?.en, `${id}: ${k} missing en`);
      assert.ok(translations[k]?.es, `${id}: ${k} missing es`);
    }
  }
});

test("step_links keys are declared steps", () => {
  for (const id of IDS) {
    const c = manifest(id).connect;
    for (const k of Object.keys(c.step_links || {})) assert.ok(c.steps.includes(k), `${id}: ${k}`);
  }
});

test("the registry carries every service bundle with its connect block (tracked manifests only)", () => {
  const reg = JSON.parse(readFileSync(join(ROOT, "registry/add-ons.json"), "utf8"));
  const list = Array.isArray(reg) ? reg : reg.addons || reg["add-ons"] || Object.values(reg).find(Array.isArray);
  for (const id of IDS) {
    const e = list.find((x) => x.id === id);
    assert.ok(e, `${id} missing from registry/add-ons.json`);
    assert.deepEqual(e.connect, manifest(id).connect, id);
  }
});

test("build-registry --check exits 0", () => {
  execFileSync(process.execPath, ["scripts/build-registry.mjs", "--check"], { cwd: ROOT, stdio: "pipe" });
});
