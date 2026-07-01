import { test } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

function havePython() {
  try { execFileSync("python3", ["-c", "import yaml"], { stdio: "ignore" }); return true; }
  catch { return false; }
}

test("per-bot preset gates the crow router on memory_integration (opt-in)", { skip: !havePython() && "python3/pyyaml unavailable" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "t8-"));
  const dbPath = join(dir, "crow.db");
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE pi_bot_defs (bot_id TEXT PRIMARY KEY, display_name TEXT, definition TEXT, enabled INTEGER DEFAULT 1)`);
  const mk = (id, mem) => JSON.stringify({ display_name: id, system_prompt: "p", gateways: [{ type: "companion" }], companion_features: { memory_integration: mem } });
  db.prepare("INSERT INTO pi_bot_defs (bot_id, display_name, definition) VALUES (?,?,?)").run("mem-on", "mem-on", mk("mem-on", true));
  db.prepare("INSERT INTO pi_bot_defs (bot_id, display_name, definition) VALUES (?,?,?)").run("mem-off", "mem-off", mk("mem-off", false));
  db.close();
  // Strip host COMPANION_* vars — a leaked COMPANION_PROFILE_N_NAME would flip
  // household mode and invalidate the global-default assertions.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("COMPANION_")));
  execFileSync("python3", ["bundles/companion/scripts/generate-config.py"], {
    env: { ...env, APP_DIR: dir, CROW_DB_PATH: dbPath, HOME: dir }, stdio: "pipe",
  });
  const conf = readFileSync(join(dir, "conf.yaml"), "utf8");
  assert.ok(!/^\s*- crow$/m.test(conf), "global default (no household profiles) does NOT enable the crow router");
  const on = readFileSync(join(dir, "characters", "crow_bot_mem-on.yaml"), "utf8");
  assert.ok(/agent_config/.test(on) && /^\s*- crow$/m.test(on), "mem-on preset carries the override enabling crow");
  const off = join(dir, "characters", "crow_bot_mem-off.yaml");
  assert.ok(existsSync(off), "mem-off preset generated");
  assert.ok(!/agent_config/.test(readFileSync(off, "utf8")), "mem-off matches global default — no override block");
});
