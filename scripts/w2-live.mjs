#!/usr/bin/env node
// Operator helper for W2 live acceptance: drives the INSTALLED Workspace MCP server as crow-bot.
// usage: node scripts/w2-live.mjs setup | append "<text>" | status [change_id] | read | cleanup   (env: CROW_HOME)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { join, dirname } from "node:path"; import { homedir } from "node:os"; import { readFileSync } from "node:fs"; import { fileURLToPath } from "node:url";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOME = process.env.CROW_HOME || join(homedir(), ".crow"); const DIR = join(HOME, "bundles", "workspace");
const client = new Client({ name: "w2-live", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["server/index.js"], cwd: DIR, env: { ...process.env, CROW_HOME: HOME, CROW_APP_ROOT: ROOT } }));
const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
const F = "Shared with Crow/W2 acceptance"; const FIX = join(ROOT, "tests", "fixtures", "workspace");
const [cmd, a1] = process.argv.slice(2);
let out;
if (cmd === "setup") {
  await call("ws_drive_create_folder", { parent: "Shared with Crow", name: "W2 acceptance" }).catch(() => null);
  out = await call("ws_drive_upload_file", { folder: F, name: "live.docx", base64: readFileSync(join(FIX, "oo-rich.docx")).toString("base64") });
} else if (cmd === "append") out = await call("ws_docs_append", { path: `${F}/live.docx`, markdown: a1 || "Line from Crow." });
else if (cmd === "status") out = await call("ws_change_status", a1 ? { change_id: a1 } : { path: `${F}/live.docx` });
else if (cmd === "read") { const r = await call("ws_docs_read", { path: `${F}/live.docx` }); out = { success: r.success, tail: r.data?.markdown?.slice(-300) }; }
else if (cmd === "cleanup") out = await call("ws_drive_trash_file", { path: `${F}/live.docx`, wait_s: 0 });
console.log(JSON.stringify(out, null, 1).slice(0, 1500));
await client.close();
