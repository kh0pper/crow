/**
 * `--tools` is ALWAYS pinned.
 *
 * pi falls back to defaultActiveToolNames when the flag is ABSENT
 * (dist/cli/args.js:85-89 -> dist/core/sdk.js:133-136), so a bot with an empty
 * envelope used to receive bash, edit, write, and every tool registered by
 * every inherited MCP server. Three enabled r4 bots were in that state.
 *
 * Uses the PiRpc nodeBin/cliPath seam with a stub that records its argv, so no
 * real pi is spawned. Asserts the ACTUAL spawn args, never a mirror of the
 * branch under test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { PiRpc } = await import("../scripts/pi-bots/bridge.mjs");

/** Spawn PiRpc against a stub that dumps argv, and return the args pi saw. */
async function spawnArgs(def, narrowedTools, extraEnv = {}) {
  const scratch = mkdtempSync(join(tmpdir(), "crow-tools-"));
  mkdirSync(join(scratch, "sessions"), { recursive: true });
  const out = join(scratch, "argv.json");
  const stub = join(scratch, "stub-pi.mjs");
  writeFileSync(stub,
    'import { writeFileSync } from "node:fs";\n' +
    'writeFileSync(process.env.CROW_TEST_ARGV_OUT, JSON.stringify(process.argv.slice(2)));\n' +
    'process.exit(0);\n');
  const pi = new PiRpc({
    def,
    sessionDir: scratch,
    resolved: { provider: "stub", model: "stub", key: "stub/stub" },
    nodeBin: process.execPath,
    cliPath: stub,
    narrowedTools,
    extraEnv: { CROW_TEST_ARGV_OUT: out, ...extraEnv },
  });
  for (let i = 0; i < 100 && !existsSync(out); i++) await new Promise((r) => setTimeout(r, 50));
  try { pi.close(); } catch { /* already exited */ }
  assert.ok(existsSync(out), "stub pi never recorded its argv");
  return JSON.parse(readFileSync(out, "utf8"));
}

/** The value pi received for --tools, or undefined when the flag was omitted. */
function toolsFlag(argv) {
  const i = argv.indexOf("--tools");
  return i === -1 ? undefined : argv[i + 1];
}

test("an empty tool envelope pins --tools \"\" instead of omitting the flag", async () => {
  const argv = await spawnArgs({ tools: { pi_builtin: [], crow_mcp: [] } });
  assert.notEqual(toolsFlag(argv), undefined,
    "omitting --tools hands pi its full default surface — an empty envelope would WIDEN");
  assert.equal(toolsFlag(argv), "");
});

test("a normal envelope still pins its allowlist", async () => {
  const argv = await spawnArgs({ tools: { pi_builtin: ["read"], crow_mcp: ["tasks/tasks_list"] } });
  assert.equal(toolsFlag(argv), "read,mcp__tasks__tasks_list");
});

test("narrowing every tool away still pins --tools \"\"", async () => {
  const argv = await spawnArgs(
    { tools: { pi_builtin: ["read"], crow_mcp: [] } },
    JSON.stringify(["read"]));
  assert.equal(toolsFlag(argv), "");
});

// ---------------------------------------------------------------------------
// PL-3 completion: ask_user rides ONLY the interactive spawn — exactly where
// pi-lab's ask-user extension registers it (PI_BOT_INTERACTIVE=1 → askUserPath
// "ui"). A channel csv that grew the name would be a dangling entry at best
// and a lie about the envelope at worst; an interactive csv WITHOUT it filters
// the registered tool away, which is the bug this pins shut.
// ---------------------------------------------------------------------------

test("an interactive spawn appends ask_user; the channel spawn's csv is byte-identical without it", async () => {
  const def = { tools: { pi_builtin: ["read"], crow_mcp: ["tasks/tasks_list"] } };
  const channel = await spawnArgs(def);
  assert.equal(toolsFlag(channel), "read,mcp__tasks__tasks_list",
    "no marker, no append — every channel caller stays exactly as before");
  const interactive = await spawnArgs(def, undefined, { PI_BOT_INTERACTIVE: "1" });
  assert.equal(toolsFlag(interactive), "read,mcp__tasks__tasks_list,ask_user");
});

test("an empty envelope still gains ask_user on an interactive spawn", async () => {
  const argv = await spawnArgs({ tools: { pi_builtin: [], crow_mcp: [] } },
    undefined, { PI_BOT_INTERACTIVE: "1" });
  assert.equal(toolsFlag(argv), "ask_user",
    "the join must not leave a leading comma on an otherwise-empty csv");
});

test("a session can narrow ask_user away — it joins the csv BEFORE narrowing", async () => {
  const argv = await spawnArgs({ tools: { pi_builtin: ["read"], crow_mcp: [] } },
    JSON.stringify(["ask_user"]), { PI_BOT_INTERACTIVE: "1" });
  assert.equal(toolsFlag(argv), "read",
    "narrowing only ever removes, and it can remove this too — the envelope model holds");
});

test("a def cannot fake the marker: spawn_env hygiene strips PI_BOT_* before the append decision", async () => {
  // C-12 strips engine-reserved keys from def.spawn_env; the append reads
  // opts.extraEnv (the engine's own channel), never the def-merged env — so a
  // bot def claiming PI_BOT_INTERACTIVE cannot grant itself ask_user on a
  // channel turn.
  const argv = await spawnArgs({
    tools: { pi_builtin: ["read"], crow_mcp: [] },
    spawn_env: { PI_BOT_INTERACTIVE: "1" },
  });
  assert.equal(toolsFlag(argv), "read");
});
