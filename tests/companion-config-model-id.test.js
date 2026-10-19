/**
 * The AI Companion names the router's dedicated model id, so /llm/v1 can tell its turns (which get the [Now]/[Dates]
 * turn context) from any other client naming no model or a bare fast/escalate id.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMPANION_TURN_MODEL } from "../servers/gateway/routes/llm-router.js";

function havePython() {
  try { execFileSync("python3", ["-c", "import yaml"], { stdio: "ignore" }); return true; } catch { return false; }
}

test("generate-config.py routes through the gateway with the dedicated companion model id", { skip: !havePython() && "python3/pyyaml unavailable" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "companion-model-id-"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("COMPANION_")));
  execFileSync("python3", ["bundles/companion/scripts/generate-config.py"], {
    env: { ...env, APP_DIR: dir, CROW_DB_PATH: join(dir, "none.db"), HOME: dir, COMPANION_PROXY_URL: "http://localhost:3001/llm/v1" }, stdio: "pipe",
  });
  const conf = readFileSync(join(dir, "conf.yaml"), "utf8");
  assert.match(conf, new RegExp(`^\\s*model: ${COMPANION_TURN_MODEL}$`, "m"));
});
