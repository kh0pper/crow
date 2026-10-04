#!/usr/bin/env node
// W2 live acceptance: runs the INSTALLED Workspace MCP server as crow-bot against the real Workspace.
// Usage: node scripts/workspace-w2-acceptance.mjs [--lock-test] [--word=CROW]
// Env: CROW_HOME (default ~/.crow); W2_CALENDAR / W2_ADDRESSBOOK pick the calendar / address book shared with
// crow-bot (default "Menu" / "Contacts": a collection shared as "Menu (owner)" resolves from its base name);
// W2_TYPED_WORD (or --word=) is the word the operator types in the lock test (default CROW).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOME = process.env.CROW_HOME || join(homedir(), ".crow");
const WORD = (process.argv.find((a) => a.startsWith("--word=")) || "").slice(7) || process.env.W2_TYPED_WORD || "CROW";
const CALENDAR = CALENDAR, ADDRESSBOOK = ADDRESSBOOK;
const DIR = join(HOME, "bundles", "workspace");
const client = new Client({ name: "w2-acceptance", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["server/index.js"], cwd: DIR, env: { ...process.env, CROW_HOME: HOME, CROW_APP_ROOT: ROOT } }));
const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
const rows = []; const check = (name, ok, info = "") => { rows.push([ok ? "PASS" : "FAIL", name, info]); console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${info}`); };
const F = "Shared with Crow/W2 acceptance";
await call("ws_drive_create_folder", { parent: "Shared with Crow", name: "W2 acceptance" }).catch(() => null);
const FIX = join(ROOT, "tests", "fixtures", "workspace");

check("76 tools", (await client.listTools()).tools.length === 76);
const up = await call("ws_drive_upload_file", { folder: F, name: "acc.docx", base64: readFileSync(join(FIX, "oo-rich.docx")).toString("base64") });
check("upload", up.success, up.error);
const fr = await call("ws_docs_find_replace", { path: `${F}/acc.docx`, find: "Tortillas", replace: "Totopos" });
check("docs find_replace + version", fr.success && fr.data.total_changes === 1 && /^v1\./.test(fr.data.version_id));
const un = await call("ws_undo_last_change", { path: `${F}/acc.docx`, version_id: fr.data.version_id });
check("undo", un.success && (await call("ws_docs_read", { path: `${F}/acc.docx` })).data.markdown.includes("Tortillas"));
const sx = await call("ws_sheets_create", { title: "Índice de recetas", folder: F, tabs: ["Recetas"] });
const ap = await call("ws_sheets_append", { path: sx.data.path, sheet_name: "Recetas", values: [["Nombre", "Porciones"], ["Tacos", 4]] });
check("sheets create + append", sx.success && ap.success);
const sl = await call("ws_slides_create", { title: "Menú W2", folder: F });
check("slides create", sl.success);
const ex = await call("ws_drive_export", { path: `${F}/acc.docx`, format: "pdf" });
check("export via ONLYOFFICE", ex.success, ex.data?.path);
const ev = await call("ws_cal_create_event", { calendar: CALENDAR, summary: "W2: tacos (prueba)", start: "2026-10-08", end: "2026-10-08" });
check(`event in "${CALENDAR}"`, ev.success, ev.error);
const ct = await call("ws_contacts_create", { addressbook: ADDRESSBOOK, full_name: "Prueba W2", phones: ["+1 512 555 0100"] });
check("contact", ct.success, ct.error);
const ls = await call("ws_drive_list_versions", { path: `${F}/acc.docx` });
check("labels visible", ls.data.versions.some((v) => /Crow|Undo/.test(v.label)));

if (process.argv.includes("--lock-test")) {
  const before = (await call("ws_docs_read", { path: `${F}/acc.docx` })).data.markdown;
  if (before.toLowerCase().includes(WORD.toLowerCase())) { console.log(`"${WORD}" is already in the file; pick another word with --word=`); process.exit(2); }
  console.log(`\n[OPERATOR] Open "${F}/acc.docx" in Workspace on the laptop, type the word ${WORD} (any word works: pass yours with --word= or W2_TYPED_WORD), keep the tab open, then press Enter.`);
  await new Promise((r) => process.stdin.once("data", r));
  const t0 = Date.now();
  const w = await call("ws_docs_append", { path: `${F}/acc.docx`, markdown: "Línea del bot.", if_open: "wait", wait_s: 30 });
  check("open_in_editor names the operator within ~30 s", w.code === "open_in_editor" && w.data.open_by.length > 0 && Date.now() - t0 < 40000, JSON.stringify(w.data?.open_by));
  const p = await call("ws_docs_append", { path: `${F}/acc.docx`, markdown: "Línea del bot.", if_open: "force_close" });
  check("force_close → write lands", p.success, p.error);
  const md = (await call("ws_docs_read", { path: `${F}/acc.docx` })).data.markdown;
  check("the operator's typing kept and bot line on top", md.toLowerCase().includes(WORD.toLowerCase()) && md.includes("Línea del bot."));
  console.log("[OPERATOR] Describe what the editor tab showed, then press Enter:"); await new Promise((r) => process.stdin.once("data", r));
}

// cleanup (trash + delete; all recoverable)
for (const path of [`${F}/acc.docx`, ex.data?.path, sx.data?.path, sl.data?.path].filter(Boolean)) await call("ws_drive_trash_file", { path, wait_s: 0 });
if (ev.success) await call("ws_cal_delete_event", { calendar: CALENDAR, uid: ev.data.uid });
if (ct.success) await call("ws_contacts_delete", { addressbook: ADDRESSBOOK, uid: ct.data.uid });
await client.close();
console.log(`\n${rows.filter((r) => r[0] === "PASS").length}/${rows.length} passed`);
process.exit(rows.every((r) => r[0] === "PASS") ? 0 : 1);
