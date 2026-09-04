// tests/mcp-writer-ensure-servers.test.js
//
// Track 3 acceptance F2: a card-bound session must be able to call
// board_report_result even when the bot's def never selected board/* —
// the dispatch brief ends the run with that call, so a session with no
// board entry can only ever time out. `ensureServers` is the mcp_writer
// seam: names unioned into the selection BEFORE catalog resolution, so the
// entry rides the exact same catalog/unconfigured plumbing (and the same
// soft warning when the token is missing) as a selected server.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBotMcp } from "../scripts/pi-bots/mcp_writer.mjs";

const canonical = { mcpServers: { tasks: { command: "node", args: ["x"] } } };
const catalog = {
  tasks: { command: "node", args: ["server/index.js"], env: {} },
  board: { url: "http://127.0.0.1:3001/board/mcp", headers: { Authorization: "Bearer t" } },
};

test("ensureServers adds the board entry even when the def never selected board/*", () => {
  const def = { tools: { crow_mcp: ["tasks/tasks_list"] } };
  const r = buildBotMcp(def, canonical, { catalog, unconfigured: {}, ensureServers: ["board"] });
  assert.deepEqual(r.json.mcpServers.board, catalog.board);
  assert.ok(r.servers.includes("board"));
});

test("without ensureServers the board entry is NOT minted (unchanged closed-world behavior)", () => {
  const def = { tools: { crow_mcp: ["tasks/tasks_list"] } };
  const r = buildBotMcp(def, canonical, { catalog, unconfigured: {} });
  assert.equal(r.json.mcpServers.board, undefined);
});

test("ensureServers with an unconfigured board (no token) disables it with the catalog's reason, never throws", () => {
  const def = { tools: { crow_mcp: [] } };
  const r = buildBotMcp(def, canonical, { catalog: { tasks: catalog.tasks }, unconfigured: { board: "board token not found" }, ensureServers: ["board"] });
  assert.deepEqual(r.json.mcpServers.board, { disabled: true });
  assert.ok(r.warnings.some((w) => /board token not found/.test(w)));
});

test("ensureServers dedupes against the def's own selection and ignores non-string junk", () => {
  const def = { tools: { crow_mcp: ["board/board_report_result"] } };
  const r = buildBotMcp(def, canonical, { catalog, unconfigured: {}, ensureServers: ["board", "", null, 7] });
  assert.equal(r.servers.filter((n) => n === "board").length, 1);
});
