/**
 * A bare server name in `crow_mcp` must reach the CHILD, not just toolAllowlist().
 *
 * pi-lab registers a local MCP server's tools one by one as `mcp__<server>__<tool>`, and
 * pi's `--tools` filter matches exact names — so the old spelling `mcp__studio` offered
 * the model nothing at all. This pins the launched `--tools` value: a def with
 * `crow_mcp: ["studio"]` whose spawn carries the listing snapshot (the map the rail's
 * primeBareServerTools returned, `piRpcOpts.bareServerTools`) is pinned with the per-tool
 * names and NOT the bare entry.
 *
 * Uses the PiRpc nodeBin/cliPath seam with a stub that records its argv, so no real pi
 * is spawned. Asserts the ACTUAL spawn args. `pi-scratch-home` first: a spawn's
 * hideFiles come from every Crow home the host has (the operator's real ~/.crow
 * included), so HOME must be scratch before bridge.mjs is imported.
 */
import "./helpers/pi-scratch-home.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { PiRpc } = await import("../scripts/pi-bots/bridge.mjs");
const { _resetBareServerToolsForTest } = await import("../scripts/pi-bots/bare-server-tools.mjs");

beforeEach(() => _resetBareServerToolsForTest());

/**
 * Spawn PiRpc against a stub that dumps argv, and return the args pi saw.
 * `bareServerTools` is the listing snapshot the spawn carries (piRpcOpts.bareServerTools
 * on a real turn).
 */
async function spawnArgs(def, { bareServerTools } = {}) {
  const scratch = mkdtempSync(join(tmpdir(), "crow-bare-launch-"));
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
    bareServerTools,
    extraEnv: { CROW_TEST_ARGV_OUT: out },
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

const STUDIO_TOOLS = ["studio_play", "studio_status"];

test("a bare server with a listing is pinned per tool — and never as the bare mcp__studio entry", async () => {
  const argv = await spawnArgs({ tools: { pi_builtin: ["read"], crow_mcp: ["studio"] } },
    { bareServerTools: { studio: STUDIO_TOOLS } });
  const csv = toolsFlag(argv);
  assert.equal(csv, "read,mcp__studio__studio_play,mcp__studio__studio_status");
  const names = csv.split(",");
  assert.ok(names.includes("mcp__studio__studio_play"));
  assert.ok(names.includes("mcp__studio__studio_status"));
  assert.ok(!names.includes("mcp__studio"), "the bare entry matches no tool pi-lab registers");
});

test("a per-tool entry is unchanged, with or without a listing", async () => {
  const def = { tools: { pi_builtin: ["read"], crow_mcp: ["studio/studio_play"] } };
  assert.equal(toolsFlag(await spawnArgs(def, { bareServerTools: { studio: STUDIO_TOOLS } })), "read,mcp__studio__studio_play");
  assert.equal(toolsFlag(await spawnArgs(def)), "read,mcp__studio__studio_play");
});

test("a bare server with no listing keeps today's spelling (nothing is invented for an unknown server)", async () => {
  const def = { tools: { pi_builtin: ["read"], crow_mcp: ["studio"] } };
  assert.equal(toolsFlag(await spawnArgs(def)), "read,mcp__studio", "no snapshot at all");
  assert.equal(toolsFlag(await spawnArgs(def, { bareServerTools: {} })), "read,mcp__studio",
    "an empty snapshot (every server failed to list) is the same case");
});

test("an injection-shaped listed name never becomes a csv entry of its own", async () => {
  const def = { tools: { crow_mcp: ["studio"] } };
  const argv = await spawnArgs(def, { bareServerTools: { studio: ["ok_tool,read", "with space"] } });
  assert.equal(toolsFlag(argv), "mcp__studio", "no valid name left, so the caller keeps its own spelling");
});