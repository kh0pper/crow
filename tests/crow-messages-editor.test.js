import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "cm-editor-"));
process.env.CROW_DATA_DIR = dir;

let db = null, renderBotEditor = null;

before(async () => {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir }, stdio: "pipe",
    cwd: new URL("..", import.meta.url).pathname,
  });
  const { loadOrCreateIdentity } = await import("../servers/sharing/identity.js");
  loadOrCreateIdentity();
  const { createDbClient } = await import("../servers/db.js");
  db = createDbClient();
  await db.execute({
    sql: "INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled) VALUES (?,?,?,1)",
    args: ["cm-bot", "CM Bot", JSON.stringify({ gateways: [{ type: "crow-messages", allow_paired_instances: true }], tools: {}, models: {} })],
  });
  ({ renderBotEditor } = await import("../servers/gateway/dashboard/panels/bot-builder/editor.js"));
});

after(async () => { try { db && db.close && db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });

test("gateways tab for crow-messages renders correct action names + csrf, no save_ prefix bug", async () => {
  // Seed an ACL row so the "Who can message" list renders a Remove form.
  await db.execute({
    sql: "INSERT INTO bot_message_acl (bot_id, sender_pubkey, crow_id, display_name, added_via) VALUES (?,?,?,?, 'invite')",
    args: ["cm-bot", "a".repeat(64), "crow:friend01", "Alice"],
  });

  let html = "";
  const res = { send: (s) => { html = s; } };
  const layout = ({ content }) => content;
  const req = { method: "GET", query: { bot: "cm-bot", tab: "gateways" }, cookies: {}, headers: {} };
  await renderBotEditor(req, res, { db, layout, lang: "en", PAGE_CSS: "", botId: "cm-bot", notice: "", q: req.query });
  assert.match(html, /name="action" value="gw_share"/, "Share button posts gw_share");
  assert.match(html, /name="action" value="gw_newlink"/, "New link posts gw_newlink");
  assert.match(html, /name="action" value="gw_advanced_add"/, "Advanced add posts gw_advanced_add");
  assert.ok(!/value="save_gw_/.test(html), "no save_-prefixed gw action (the hidden() bug)");
  assert.match(html, /name="gw_allow_paired_instances"[^>]*checked/, "paired toggle reflects saved true");
  // CSRF: the page must carry a _csrf field for the POST forms.
  assert.match(html, /name="_csrf"/, "csrf field present");
  // ACL row renders a Remove form with gw_remove action.
  assert.match(html, /name="action" value="gw_remove"/, "ACL row renders gw_remove form");
});
