/** Task 14: the ws_* MCP surface is exactly spec §4's 76 tools; instructions carry the guardrails; manifest declares the server. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startFakeNextcloud } from "./helpers/workspace-fake-nextcloud.js";
import { connectWorkspace } from "./helpers/workspace-client.js";

const EXPECTED = [
  "ws_drive_list_folder", "ws_drive_find_folder", "ws_drive_get_metadata", "ws_drive_get_permissions", "ws_drive_read_file", "ws_drive_search", "ws_drive_create_folder", "ws_drive_move_file", "ws_drive_copy_file", "ws_drive_rename", "ws_drive_trash_file", "ws_drive_upload_file", "ws_drive_upload_new_version", "ws_drive_export", "ws_drive_share", "ws_drive_list_versions", "ws_drive_restore_version",
  "ws_docs_read", "ws_docs_get_structure", "ws_docs_read_section", "ws_docs_find_replace", "ws_docs_append", "ws_docs_insert_at_heading", "ws_docs_replace_section", "ws_docs_create", "ws_docs_rewrite_passages", "ws_docs_format_text", "ws_docs_insert_image",
  "ws_docs_list_comments", "ws_docs_add_comment", "ws_docs_reply_comment", "ws_docs_resolve_comment", "ws_docs_apply_comment_edit",
  "ws_sheets_list", "ws_sheets_get_tabs", "ws_sheets_read", "ws_sheets_write", "ws_sheets_append", "ws_sheets_create", "ws_sheets_add_tab", "ws_sheets_rename_tab", "ws_sheets_delete_tab", "ws_sheets_set_number_format", "ws_sheets_batch_update",
  "ws_slides_read", "ws_slides_get_structure", "ws_slides_read_notes", "ws_slides_find_replace", "ws_slides_create", "ws_slides_add_slide", "ws_slides_duplicate_slide", "ws_slides_delete_slide", "ws_slides_reorder_slides", "ws_slides_add_text_box", "ws_slides_add_image", "ws_slides_format_text", "ws_slides_format_paragraph", "ws_slides_edit_text", "ws_slides_edit_notes", "ws_slides_batch_update",
  "ws_cal_list_calendars", "ws_cal_list_events", "ws_cal_get_event", "ws_cal_create_event", "ws_cal_update_event", "ws_cal_delete_event", "ws_cal_respond_to_event",
  "ws_contacts_list_addressbooks", "ws_contacts_search", "ws_contacts_get", "ws_contacts_create", "ws_contacts_update", "ws_contacts_delete",
  "ws_undo_last_change", "ws_change_status", "ws_cancel_change",
];
const FAMILIES = { drive: 17, docs: 16, sheets: 11, slides: 16, cal: 7, contacts: 6 };
const DESTRUCTIVE = ["ws_drive_trash_file", "ws_sheets_delete_tab", "ws_slides_delete_slide", "ws_cal_delete_event", "ws_contacts_delete"];
let fake, client, close;
before(async () => { fake = await startFakeNextcloud(); ({ client, close } = await connectWorkspace(fake)); });
after(async () => { await close(); fake.close(); });

test("exactly the 76 spec §4 tools are registered (no internal ws__ ops)", async () => {
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.equal(EXPECTED.length, 76);
  assert.equal(new Set(EXPECTED).size, 76, "no duplicates in the pinned list");
  for (const [fam, n] of Object.entries(FAMILIES)) assert.equal(EXPECTED.filter((x) => x.startsWith(`ws_${fam}_`)).length, n, fam);
  assert.deepEqual(names, [...EXPECTED].sort());
  assert.deepEqual(names.filter((n) => n.startsWith("ws__")), [], "internal inverse ops are never MCP tools");
});

test("descriptions: ≤1024 chars, destructive tools say confirm, useful first 120 chars", async () => {
  for (const t of (await client.listTools()).tools) {
    assert.ok(t.description.length <= 1024, t.name);
    assert.ok(t.description.slice(0, 120).trim().length >= 20, t.name);
    if (DESTRUCTIVE.includes(t.name)) assert.match(t.description, /confirm/i, t.name);
  }
});

test("instructions carry the guardrails (delivered to the client); the manifest declares the server with NO envKeys", async () => {
  const { WORKSPACE_INSTRUCTIONS } = await import("../bundles/workspace/server/server.js");
  assert.equal(client.getInstructions(), WORKSPACE_INSTRUCTIONS, "the MCP initialize result carries the instructions");
  for (const re of [/no full-document replace/i, /never inherits? heading styles/i, /comments are listed completely/i, /batch find\/replace is atomic/i,
    /heading-to-heading/i, /version_id/, /ws_undo_last_change/, /queued:true/, /ws_change_status/, /force_close/, /explicitly/i, /Crow bot/]) {
    assert.match(WORKSPACE_INSTRUCTIONS, re, String(re));
  }
  const m = JSON.parse(readFileSync(join(import.meta.dirname, "..", "bundles", "workspace", "manifest.json"), "utf8"));
  assert.equal(m.version, "0.2.1");
  assert.deepEqual(m.server, { command: "node", args: ["server/index.js"], envKeys: [], configureEnv: "envKeys-only" });
  assert.equal(m.npm_required, true);
  assert.deepEqual(m.skills, ["skills/workspace.md"]);
  assert.equal(m.panelRoutes, "panel/routes.js");
  assert.deepEqual(m.refreshFiles, ["docker-compose.yml", "onlyoffice-plugin"], "Task 13's refreshFiles is kept");
});

test("not_ready before bootstrap finished, naming the bootstrap command", async () => {
  const { call, home, close: c2 } = await connectWorkspace(fake);
  writeFileSync(join(home, "bundles", "workspace", ".env"), "WORKSPACE_PUBLIC_HOST=crow.test\n");
  const r = await call("ws_drive_list_folder", {});
  assert.equal(r.code, "not_ready"); assert.match(r.error, /bootstrap\.sh/);
  await c2();
});
