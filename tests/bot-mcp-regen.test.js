import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveBotSessionDir } from "../servers/gateway/dashboard/panels/bot-mcp-regen.js";

function dbWith(rows) {
  return {
    async execute({ sql, args }) {
      if (/project_spaces/.test(sql)) return { rows: rows.project_spaces || [] };
      if (/pi_bot_defs/.test(sql)) return { rows: rows.pi_bot_defs || [] };
      return { rows: [] };
    },
  };
}

test("resolveBotSessionDir: project_id present → workspace/bots/<id>", async () => {
  const db = dbWith({ project_spaces: [{ workspace_dir: "/ws/proj" }] });
  const dir = await resolveBotSessionDir(db, "scout", { session_dir: "/legacy" }, 7);
  assert.equal(dir, "/ws/proj/bots/scout");
});

test("resolveBotSessionDir: no project_id → def.session_dir", async () => {
  const db = dbWith({});
  const dir = await resolveBotSessionDir(db, "scout", { session_dir: "/legacy" }, null);
  assert.equal(dir, "/legacy");
});
