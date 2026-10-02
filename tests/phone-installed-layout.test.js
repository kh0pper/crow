/**
 * phone-installed-layout — the gateway imports the Phone bundle's server
 * modules by PATH from the INSTALLED copy (~/.crow/bundles/phone/server),
 * outside the app repo, where Node cannot resolve the app's node_modules.
 * Every server module must import cleanly from such a copy (no bare package
 * imports; app code is reached via app-root.js / CROW_APP_ROOT, and the MCP
 * SDK + zod are injected by servers/gateway/boot/mcp-mounts.js).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "bundles", "phone", "server");
const MODULES = ["mcp.js", "init-tables.js", "store.js", "plan.js", "deliver.js", "dispatcher.js", "runner-client.js", "authority.js", "secrets.js", "card.js"];
const saved = process.env.CROW_APP_ROOT;
let tmp, dir;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "phone-installed-"));
  dir = join(tmp, "bundles", "phone", "server");
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(SRC)) if (f.endsWith(".js")) copyFileSync(join(SRC, f), join(dir, f));
  process.env.CROW_APP_ROOT = ROOT; // production: the gateway exports CROW_APP_ROOT
});

after(() => {
  rmSync(tmp, { recursive: true, force: true });
  if (saved === undefined) delete process.env.CROW_APP_ROOT; else process.env.CROW_APP_ROOT = saved;
});

test("the installed copy lives outside the app repo", () => {
  assert.equal(dir.startsWith(ROOT), false);
});

for (const f of MODULES) {
  test(`installed ${f} imports without ERR_MODULE_NOT_FOUND`, async () => {
    await import(pathToFileURL(join(dir, f)).href);
  });
}

test("installed mcp.js builds a server with the injected McpServer and z", async () => {
  const { createPhoneMcpServer } = await import(pathToFileURL(join(dir, "mcp.js")).href);
  const server = createPhoneMcpServer({ db: {}, McpServer, z });
  assert.ok(server instanceof McpServer);
});

test("bundle version 0.2.3 (phone polish P1–P14) — the manifest and the MCP server agree", async () => {
  const { readFileSync } = await import("node:fs");
  const manifest = JSON.parse(readFileSync(join(ROOT, "bundles", "phone", "manifest.json"), "utf8"));
  assert.equal(manifest.version, "0.2.3");
  const mcpSrc = readFileSync(join(SRC, "mcp.js"), "utf8");
  assert.match(mcpSrc, /new McpServer\(\{ name: "crow-phone", version: "0\.2\.3" \}\)/);
});
