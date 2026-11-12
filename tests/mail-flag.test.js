/**
 * Crow Mail is a gateway-only, owner-only feature behind one exact-string flag, and it adds no
 * bot-visible surface: no mail module may register an MCP tool.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { mailEnabled } from "../servers/gateway/mail/flag.js";

const GATEWAY = new URL("../servers/gateway/", import.meta.url).pathname;
const MAIL_DIR = join(GATEWAY, "mail");
const ROUTES_DIR = join(GATEWAY, "routes");

const MCP_SURFACE = /registerTool|McpServer|mountMcpServer|server\.tool\(/;

function* jsFiles(dir) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* jsFiles(p);
    else if (name.endsWith(".js")) yield p;
  }
}

function mailModuleFiles() {
  const out = [];
  if (existsSync(MAIL_DIR)) out.push(...jsFiles(MAIL_DIR));
  if (existsSync(ROUTES_DIR)) {
    for (const name of readdirSync(ROUTES_DIR)) {
      if (/^mail-api.*\.js$/.test(name)) out.push(join(ROUTES_DIR, name));
    }
  }
  return out;
}

test("mailEnabled is true only for the exact string \"1\"", () => {
  assert.equal(mailEnabled({}), false);
  assert.equal(mailEnabled({ CROW_MAIL: "1" }), true);
  assert.equal(mailEnabled({ CROW_MAIL: "true" }), false);
  assert.equal(mailEnabled({ CROW_MAIL: "0" }), false);
  assert.equal(mailEnabled({ CROW_MAIL: "1 " }), false);
});

test("no mail module registers an MCP tool", () => {
  const files = mailModuleFiles();
  assert.ok(files.length >= 1, "no mail module was scanned — the guard would pass on an empty set");
  for (const file of files) {
    assert.doesNotMatch(readFileSync(file, "utf8"), MCP_SURFACE, `${file} registers an MCP tool`);
  }
});