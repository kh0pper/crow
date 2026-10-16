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

test("resolveBotSessionDir: no project_id, no def.session_dir → the world root under crowHome (worldRootFor)", async () => {
  const { worldRootFor } = await import("../scripts/pi-bots/world-root.mjs");
  const db = dbWith({});
  const dir = await resolveBotSessionDir(db, "scout", {}, null, "/home/x/.crow");
  assert.equal(dir, worldRootFor({ workspaceDir: null, def: {}, crowHome: "/home/x/.crow", botId: "scout" }));
  assert.equal(dir, "/home/x/.crow/pi-bots/scout");
});

test("resolveBotSessionDir: a project with no workspace_dir falls back like worldRootFor", async () => {
  const db = dbWith({ project_spaces: [{ workspace_dir: null }] });
  assert.equal(await resolveBotSessionDir(db, "scout", { session_dir: "/legacy" }, 7), "/legacy");
});
