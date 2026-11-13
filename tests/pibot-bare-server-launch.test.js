/**
 * A bare server name in `crow_mcp` must reach the CHILD, not just toolAllowlist().
 *
 * pi-lab registers a local MCP server's tools one by one as `mcp__<server>__<tool>`, and
 * pi's `--tools` filter matches exact names — so the old spelling `mcp__studio` offered
 * the model nothing at all. This pins the launched `--tools` value: after the cache is
 * primed (the rails do this in prepareSpawn / before the PiRpc spawn), a def with
 * `crow_mcp: ["studio"]` is pinned with the per-tool names and NOT the bare entry.
 *
 * Uses the PiRpc nodeBin/cliPath seam with a stub that records its argv, so no real pi
 * is spawned. Asserts the ACTUAL spawn args.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { PiRpc } = await import("../scripts/pi-bots/bridge.mjs");
const { _resetBareServerToolsForTest, _setBareServerToolsForTest } = await import("../scripts/pi-bots/bare-server-tools.mjs");
// The co-host scan must not read the HOST's /etc (a dev box with a declared extra Crow
// home would change these spawns): point its /etc half at scratch, empty dirs.
const SCAN_ROOT = mkdtempSync(join(tmpdir(), "crow-bare-launch-scan-"));
process.on("exit", () => { try { rmSync(SCAN_ROOT, { recursive: true, force: true }); } catch { /* gone */ } });
const SCAN_UNITS = join(SCAN_ROOT, "units");
const SCAN_ENV = join(SCAN_ROOT, "etc-crow");
mkdirSync(SCAN_UNITS, { recursive: true });
mkdirSync(SCAN_ENV, { recursive: true });
const { _setSystemScanDirsForTest } = await import("../servers/shared/secret-values.js");
_setSystemScanDirsForTest({ unitDirs: [SCAN_UNITS], envFileDirs: [SCAN_ENV] });

beforeEach(() => _resetBareServerToolsForTest());

/** Spawn PiRpc against a stub that dumps argv, and return the args pi saw. */
async function spawnArgs(def) {
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

test("a primed bare server is pinned per tool — and never as the bare mcp__studio entry", async () => {
  _setBareServerToolsForTest("studio", STUDIO_TOOLS);
  const argv = await spawnArgs({ tools: { pi_builtin: ["read"], crow_mcp: ["studio"] } });
  const csv = toolsFlag(argv);
  assert.equal(csv, "read,mcp__studio__studio_play,mcp__studio__studio_status");
  const names = csv.split(",");
  assert.ok(names.includes("mcp__studio__studio_play"));
  assert.ok(names.includes("mcp__studio__studio_status"));
  assert.ok(!names.includes("mcp__studio"), "the bare entry matches no tool pi-lab registers");
});

test("a per-tool entry is unchanged, primed cache or not", async () => {
  _setBareServerToolsForTest("studio", STUDIO_TOOLS);
  const argv = await spawnArgs({ tools: { pi_builtin: ["read"], crow_mcp: ["studio/studio_play"] } });
  assert.equal(toolsFlag(argv), "read,mcp__studio__studio_play");
});

test("an unprimed bare server keeps today's spelling (nothing is invented for an unknown server)", async () => {
  const argv = await spawnArgs({ tools: { pi_builtin: ["read"], crow_mcp: ["studio"] } });
  assert.equal(toolsFlag(argv), "read,mcp__studio");
});