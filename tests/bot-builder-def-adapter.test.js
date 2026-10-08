/**
 * Bot Builder simplification — the pure adapters between the stored bot
 * definition and the four-tab editor's controls.
 *
 * The editor is a PROJECTION of the stored definition: every control is
 * computed from stored fields, and a control the operator did not change
 * never rewrites the fields under it (preserve-unless-changed). These tests
 * pin both directions for each composite control.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyTool, sourceMode, expandSourceMode, sourceLabel, readToolNames,
} from "../servers/gateway/dashboard/panels/bot-builder/tool-access.js";
import {
  BASH_UI_TO_STORED, BASH_MODES_LIVE, storedToBashUi, applyCommandsMode,
} from "../servers/gateway/dashboard/panels/bot-builder/bash-mode.js";
import {
  filesMode, applyFilesMode, learningMode, applyLearningMode,
  confirmView, applyConfirm, applySourceModes, defRev,
} from "../servers/gateway/dashboard/panels/bot-builder/def-adapter.js";

// ---- tool classification ----

test("classifyTool: MCP annotations may only narrow (never turn a write into a read)", () => {
  assert.equal(classifyTool({ name: "gmail_send_to_self", readOnlyHint: true }), "write");
  assert.equal(classifyTool({ name: "frobnicate", readOnlyHint: true }), "write", "an unknown name stays write");
  assert.equal(classifyTool({ name: "gmail_get_thread", readOnlyHint: true }), "read");
  assert.equal(classifyTool({ name: "gmail_search_threads", readOnlyHint: false }), "write");
  assert.equal(classifyTool({ name: "gdrive_list_folder", destructiveHint: true }), "write");
});

test("classifyTool: name heuristic on real tool names", () => {
  const read = [
    "gmail_search_threads", "gmail_get_thread", "gmail_list_labels", "gdocs_read_section",
    "gdocs_get_structure", "gdocs_list_comments", "gdrive_get_permissions", "gdrive_search",
    "sheets_get_tabs", "gcal_list_events", "crow_recall_by_context", "crow_search_memories",
    "crow_memory_stats", "crow_get_context", "crow_check_notifications", "crow_deep_recall",
    "crow_browser_extract_text", "crow_browser_screenshot",
    "crow_browser_status", "tasks_list", "tasks_get", "brave_web_search", "looker_search_assets",
  ];
  const write = [
    "gmail_create_draft", "gmail_send_to_self", "gmail_archive", "gdocs_resolve_comment",
    "gdocs_rewrite_passages", "gdrive_trash_file", "gdrive_download_file", "gdrive_export",
    "gcal_respond_to_event", "crow_store_memory", "crow_delete_memory", "crow_dismiss_notification",
    "crow_browser_click", "crow_browser_fill_form", "crow_browser_evaluate", "tasks_update",
    "tasks_complete", "sheets_write", "crow_dream", "bigquery_query", "apps_script_run",
    // read-sounding names that change or share something (verified in source)
    "crow_kiosk_show", "crow_kavita_want_to_read", "crow_calibreweb_reading_status",
    "crow_browser_paginate", "crow_browser_navigate", "crow_get_file_url",
    "crow_browser_scroll_extract", "crow_browser_scrape", "crow_browser_wait_for",
  ];
  for (const n of read) assert.equal(classifyTool({ name: n }), "read", n);
  for (const n of write) assert.equal(classifyTool({ name: n }), "write", n);
});

test("classifyTool: an unrecognised name is write (Read-only never grants it)", () => {
  assert.equal(classifyTool({ name: "frobnicate" }), "write");
  assert.equal(classifyTool({ name: "" }), "write");
  assert.equal(classifyTool({}), "write");
});

// ---- source modes ----

const CAT = [
  { name: "a_list", access: "read" },
  { name: "b_get", access: "read" },
  { name: "c_create", access: "write" },
];

test("sourceMode derives Off / Read-only / All / Custom from the stored selection", () => {
  assert.equal(sourceMode("s", [], CAT), "off");
  assert.equal(sourceMode("s", ["other/x"], CAT), "off");
  assert.equal(sourceMode("s", ["s/a_list", "s/b_get"], CAT), "read");
  assert.equal(sourceMode("s", ["s/b_get", "s/a_list", "s/c_create"], CAT), "all");
  assert.equal(sourceMode("s", ["s/a_list"], CAT), "custom");
  assert.equal(sourceMode("s", ["s/c_create"], CAT), "custom");
  // a stored name the catalog no longer lists makes it custom (honest)
  assert.equal(sourceMode("s", ["s/a_list", "s/b_get", "s/c_create", "s/gone"], CAT), "custom");
});

test("sourceMode: a source whose tools are all writes has no distinct Read-only", () => {
  const w = [{ name: "x_send", access: "write" }];
  assert.equal(sourceMode("s", [], w), "off");
  assert.equal(sourceMode("s", ["s/x_send"], w), "all");
});

test("expandSourceMode turns a mode into the concrete tool keys", () => {
  assert.deepEqual(expandSourceMode("s", "off", CAT), []);
  assert.deepEqual(expandSourceMode("s", "read", CAT), ["s/a_list", "s/b_get"]);
  assert.deepEqual(expandSourceMode("s", "all", CAT), ["s/a_list", "s/b_get", "s/c_create"]);
  assert.equal(readToolNames(CAT).length, 2);
});

test("sourceLabel: friendly (translated) name; account = the operator's label, else the server name for a second instance", () => {
  assert.equal(sourceLabel("crow-memory").name, "Crow memory");
  assert.equal(sourceLabel("crow-memory", "es").name, "Memoria de Crow");
  assert.equal(sourceLabel("browser", "es").name, "Navegador");
  assert.equal(sourceLabel("google-workspace", "es").name, "Google Workspace", "product names are not translated");
  assert.equal(sourceLabel("google-workspace").account, "");
  assert.equal(sourceLabel("google-workspace", "en", { account: "alex@example.com" }).account, "alex@example.com");
  assert.equal(sourceLabel("google-workspace-work").name, "Google Workspace");
  assert.equal(sourceLabel("google-workspace-work").account, "google-workspace-work", "no label: the server name");
  assert.equal(sourceLabel("google-workspace-work", "en", { account: " Work mail " }).account, "Work mail");
  assert.equal(sourceLabel("some-new-thing").name, "some-new-thing");
  assert.equal(sourceLabel("some-new-thing").account, "");
});

test("applySourceModes: changed sources rewrite only their own keys; unchanged and unrendered are kept", () => {
  const stored = ["s/a_list", "s/zombie", "t/x", "gone/y"];
  const catalog = { s: CAT, t: [{ name: "x", access: "read" }, { name: "w_set", access: "write" }] };
  // s: was custom, now all  -> s/* = all tools (zombie dropped: the operator chose All)
  // t: unchanged (read -> read) -> kept exactly
  // gone: not rendered -> kept
  const out = applySourceModes(stored, catalog, {
    s: { mode: "all", was: "custom", custom: [] },
    t: { mode: "read", was: "read", custom: [] },
  });
  assert.deepEqual(out.sort(), ["gone/y", "s/a_list", "s/b_get", "s/c_create", "t/x"].sort());
});

test("applySourceModes: custom keeps stored names the catalog no longer lists", () => {
  const out = applySourceModes(["s/a_list", "s/zombie"], { s: CAT }, {
    s: { mode: "custom", was: "custom", custom: ["s/a_list", "s/c_create"] },
  });
  assert.deepEqual(out.sort(), ["s/a_list", "s/c_create", "s/zombie"]);
});

test("applySourceModes: a custom post naming a tool of ANOTHER source is ignored", () => {
  const out = applySourceModes([], { s: CAT, t: [{ name: "x", access: "read" }] }, {
    s: { mode: "custom", was: "off", custom: ["t/x", "s/b_get"] },
  });
  assert.deepEqual(out, ["s/b_get"]);
});

test("applySourceModes: off clears the source", () => {
  const out = applySourceModes(["s/a_list", "t/x"], { s: CAT }, { s: { mode: "off", was: "custom", custom: [] } });
  assert.deepEqual(out, ["t/x"]);
});

// ---- commands (bash) ----

test("bash adapter: stored values map to UI modes; sandbox / unknown show Off", () => {
  assert.equal(storedToBashUi({ bash: "deny" }), "off");
  assert.equal(storedToBashUi({}), "off");
  assert.equal(storedToBashUi({ bash: "sandbox" }), "off");
  assert.equal(storedToBashUi({ bash: "weird" }), "off");
  assert.equal(storedToBashUi({ bash: "allowlist" }), "list");
  assert.equal(storedToBashUi({ bash: "ask" }), "ask");
  assert.equal(storedToBashUi({ bash: "auto" }), "auto");
  assert.deepEqual(BASH_UI_TO_STORED, { off: "deny", ask: "ask", auto: "auto", list: "allowlist" });
  assert.ok(BASH_MODES_LIVE.has("off") && BASH_MODES_LIVE.has("list"));
});

test("applyCommandsMode: unchanged keeps sandbox and the builtin set byte-identical", () => {
  const def = { tools: { pi_builtin: ["read", "bash"] }, permission_policy: { bash: "sandbox", bash_allow: ["ls"] } };
  const r = applyCommandsMode(def, { mode: "off", was: "off", allowText: "ls" });
  assert.equal(r.ok, true);
  assert.deepEqual(def.tools.pi_builtin, ["read", "bash"]);
  assert.equal(def.permission_policy.bash, "sandbox");
});

test("applyCommandsMode: Off removes bash from the builtins and stores deny", () => {
  const def = { tools: { pi_builtin: ["read", "bash", "edit"] }, permission_policy: { bash: "allowlist", bash_allow: ["git status"] } };
  applyCommandsMode(def, { mode: "off", was: "list", allowText: "git status" });
  assert.deepEqual(def.tools.pi_builtin, ["read", "edit"]);
  assert.equal(def.permission_policy.bash, "deny");
  assert.deepEqual(def.permission_policy.bash_allow, ["git status"], "the list is kept for later");
});

test("applyCommandsMode: list adds bash and stores the allow list", () => {
  const def = { tools: { pi_builtin: ["read"] }, permission_policy: { bash: "deny" } };
  applyCommandsMode(def, { mode: "list", was: "off", allowText: "git status\n\n ls -la \n" });
  assert.deepEqual(def.tools.pi_builtin, ["read", "bash"]);
  assert.equal(def.permission_policy.bash, "allowlist");
  assert.deepEqual(def.permission_policy.bash_allow, ["git status", "ls -la"]);
});

test("applyCommandsMode: a mode that is not live yet is refused unless already stored", () => {
  const def = { tools: { pi_builtin: ["read"] }, permission_policy: { bash: "deny" } };
  if (!BASH_MODES_LIVE.has("auto")) {
    const r = applyCommandsMode(def, { mode: "auto", was: "off", allowText: "" });
    assert.equal(r.ok, false);
    assert.equal(def.permission_policy.bash, "deny", "nothing written");
  }
  const kept = { tools: { pi_builtin: ["read", "bash"] }, permission_policy: { bash: "auto" } };
  assert.equal(applyCommandsMode(kept, { mode: "auto", was: "auto", allowText: "" }).ok, true);
  assert.equal(kept.permission_policy.bash, "auto");
});

test("applyCommandsMode: an unknown posted mode is refused", () => {
  const def = { tools: { pi_builtin: ["read"] }, permission_policy: { bash: "deny" } };
  assert.equal(applyCommandsMode(def, { mode: "rm-rf", was: "off" }).ok, false);
});

// ---- files ----

test("filesMode projects the builtin set", () => {
  assert.equal(filesMode(["read", "edit", "write"]), "edit");
  assert.equal(filesMode(["read", "edit", "write", "bash"]), "edit");
  assert.equal(filesMode(["read"]), "read");
  assert.equal(filesMode(["read", "list", "glob", "grep"]), "read");
  assert.equal(filesMode(["read", "grep", "find", "ls"]), "read");
  assert.equal(filesMode([]), "read", "an empty set ran as read before (save fell back to read)");
  assert.equal(filesMode(["write"]), "edit");
});

test("applyFilesMode: unchanged keeps the stored set exactly (list/glob survive)", () => {
  const def = { tools: { pi_builtin: ["read", "list", "glob", "bash"] } };
  applyFilesMode(def, { mode: "read", was: "read" });
  assert.deepEqual(def.tools.pi_builtin, ["read", "list", "glob", "bash"]);
});

test("applyFilesMode: read and edit write real pi tool names and keep bash", () => {
  const def = { tools: { pi_builtin: ["read", "list", "bash"] } };
  applyFilesMode(def, { mode: "edit", was: "read" });
  assert.deepEqual(def.tools.pi_builtin, ["read", "grep", "find", "ls", "edit", "write", "bash"]);
  applyFilesMode(def, { mode: "read", was: "edit" });
  assert.deepEqual(def.tools.pi_builtin, ["read", "grep", "find", "ls", "bash"]);
});

// ---- learning ----

test("learningMode: three canonical states, anything else is custom", () => {
  assert.equal(learningMode({}), "off");
  assert.equal(learningMode({ self_authoring: false, skill_learning: "off" }), "off");
  assert.equal(learningMode({ self_authoring: true, skill_learning: "propose" }), "propose");
  assert.equal(learningMode({ self_authoring: true, skill_learning: "auto" }), "auto");
  assert.equal(learningMode({ self_authoring: true, skill_learning: "off" }), "custom");
  assert.equal(learningMode({ self_authoring: false, skill_learning: "auto" }), "custom");
});

test("applyLearningMode: unchanged custom is kept; a choice writes both fields", () => {
  const pp = { self_authoring: true, skill_learning: "off" };
  applyLearningMode(pp, { mode: "custom", was: "custom" });
  assert.deepEqual(pp, { self_authoring: true, skill_learning: "off" });
  applyLearningMode(pp, { mode: "auto", was: "custom" });
  assert.deepEqual(pp, { self_authoring: true, skill_learning: "auto" });
  applyLearningMode(pp, { mode: "off", was: "auto" });
  assert.deepEqual(pp, { self_authoring: false, skill_learning: "off" });
  assert.equal(applyLearningMode(pp, { mode: "custom", was: "off" }).ok, false, "custom cannot be chosen fresh");
});

// ---- always ask before (confirm) ----

const WRITE_TOOLS = [
  { key: "google-workspace/gmail_create_draft", server: "google-workspace", name: "gmail_create_draft" },
  { key: "crow-memory/crow_store_memory", server: "crow-memory", name: "crow_store_memory" },
];

test("confirmView: a tool counts as checked when either vocabulary names it; others are kept aside", () => {
  const v = confirmView(["gmail_create_draft", "mcp__crow-memory__crow_store_memory", "gmail_send", "mcp__x__y"], WRITE_TOOLS);
  assert.deepEqual(v.checked.sort(), ["crow-memory/crow_store_memory", "google-workspace/gmail_create_draft"]);
  assert.deepEqual(v.other, ["gmail_send", "mcp__x__y"]);
});

test("applyConfirm: a checked tool stores both names; unchanged entries keep their order", () => {
  const before = ["gmail_send"];
  const out = applyConfirm(before, WRITE_TOOLS, {
    checked: ["google-workspace/gmail_create_draft"],
    otherText: "gmail_send",
  });
  assert.deepEqual(out, ["gmail_send", "mcp__google-workspace__gmail_create_draft", "gmail_create_draft"]);
});

test("applyConfirm: two accounts share a bare name — unticking one keeps the other asked (chat and voice)", () => {
  const two = [
    { key: "google-workspace/gmail_create_draft", server: "google-workspace", name: "gmail_create_draft" },
    { key: "google-workspace-work/gmail_create_draft", server: "google-workspace-work", name: "gmail_create_draft" },
  ];
  const out = applyConfirm(["gmail_create_draft"], two, { checked: ["google-workspace-work/gmail_create_draft"], otherText: "" });
  assert.ok(out.includes("gmail_create_draft"), "the voice name stays while one account still wants it");
  assert.ok(out.includes("mcp__google-workspace-work__gmail_create_draft"), "the kept account gets its own pi name");
  assert.ok(!out.includes("mcp__google-workspace__gmail_create_draft"));
  assert.deepEqual(applyConfirm(out, two, { checked: [], otherText: "" }), []);
});

test("applyConfirm: unchecking removes both names; no change returns the same array content", () => {
  const before = ["mcp__google-workspace__gmail_create_draft", "gmail_create_draft", "other_tool"];
  const same = applyConfirm(before, WRITE_TOOLS, { checked: ["google-workspace/gmail_create_draft"], otherText: "other_tool" });
  assert.deepEqual(same, before);
  const out = applyConfirm(before, WRITE_TOOLS, { checked: [], otherText: "other_tool" });
  assert.deepEqual(out, ["other_tool"]);
});

// ---- def_rev ----

test("defRev is stable for the same text and changes with it", () => {
  assert.equal(defRev('{"a":1}'), defRev('{"a":1}'));
  assert.notEqual(defRev('{"a":1}'), defRev('{"a":2}'));
  assert.match(defRev(""), /^[0-9a-f]{16}$/);
});

// ---- the live probe carries MCP tool annotations ----

test("probeServerTools carries readOnlyHint / destructiveHint when a server declares them", async () => {
  const { probeServerTools } = await import("../scripts/pi-bots/mcp_writer.mjs");
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "btb-probe-ann-"));
  const srv = join(dir, "srv.mjs");
  writeFileSync(srv, [
    "import { createInterface } from 'node:readline';",
    "const rl = createInterface({ input: process.stdin });",
    "const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
    "rl.on('line', (l) => { const m = JSON.parse(l); if (m.id == null) return;",
    "  if (m.method === 'initialize') out({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'ann' } } });",
    "  else if (m.method === 'tools/list') out({ jsonrpc: '2.0', id: m.id, result: { tools: [",
    "    { name: 'zap_things', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },",
    "    { name: 'peek', inputSchema: { type: 'object' }, annotations: { destructiveHint: true, readOnlyHint: 'yes' } },",
    "    { name: 'plain', inputSchema: { type: 'object' } } ] } }); });",
  ].join("\n"));
  try {
    const r = await probeServerTools({ command: process.execPath, args: [srv] }, { timeoutMs: 8000 });
    assert.equal(r.ok, true, r.error);
    const by = Object.fromEntries(r.tools.map((t) => [t.name, t]));
    assert.equal(by.zap_things.readOnlyHint, true);
    assert.equal(classifyTool(by.zap_things), "write", "a readOnlyHint cannot widen an unrecognised name");
    assert.equal(by.peek.destructiveHint, true);
    assert.equal("readOnlyHint" in by.peek, false, "a non-boolean hint is dropped");
    assert.equal("readOnlyHint" in by.plain, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bash adapter writes only the shared stored vocabulary (parity with servers/shared/bot-bash-policy.js when present)", async () => {
  const { BASH_STORED_VALUES } = await import("../servers/gateway/dashboard/panels/bot-builder/bash-mode.js");
  for (const v of Object.values(BASH_UI_TO_STORED)) assert.ok(BASH_STORED_VALUES.includes(v), v);
  let shared = null;
  try { shared = await import("../servers/shared/bot-bash-policy.js"); } catch { shared = null; }
  if (shared) {
    assert.deepEqual([...BASH_STORED_VALUES].sort(), [...shared.BASH_POLICIES].sort());
    for (const v of Object.values(BASH_UI_TO_STORED)) assert.ok(shared.isValidBashPolicy(v), v);
  }
});
