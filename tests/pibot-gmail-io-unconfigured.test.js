/**
 * gmail_io.mjs honest-failure guard (Item 4-PR4, A5).
 *
 * gmail_io used to bake the maintainer's google-workspace-mcp checkout and
 * creds paths; on a host without that install it died on a cryptic spawn
 * ENOENT. Now paths are env-overridable with HOME-derived defaults, and a
 * missing server binary exits 1 with a message naming the config knobs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const GIO = fileURLToPath(new URL("../scripts/pi-bots/gmail_io.mjs", import.meta.url));

test("missing google-workspace-mcp binary -> exit 1 with config guidance (no cryptic ENOENT)", () => {
  const scratch = mkdtempSync(join(tmpdir(), "crow-gio-"));
  const r = spawnSync(process.execPath, [GIO, "search", "--query", "x"], {
    env: {
      ...process.env,
      // Point BOTH knobs into empty scratch so no real install is found even
      // on the maintainer's machines.
      PIBOT_GWS_MCP_DIR: scratch,
      PIBOT_GWS_MCP_BIN: join(scratch, "no-such-bin"),
    },
    encoding: "utf8",
    timeout: 20000,
  });
  assert.equal(r.status, 1, `expected exit 1, got ${r.status}; stderr=${r.stderr}`);
  assert.match(r.stderr, /PIBOT_GWS_MCP_DIR/, "error must name the config env vars");
  assert.match(r.stderr, /google-workspace-mcp not found/, "error must say what is missing");
});
