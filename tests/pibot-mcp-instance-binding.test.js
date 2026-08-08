import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeBotMcp } from "../scripts/pi-bots/mcp_writer.mjs";

/**
 * A canonical config pinned to instance A, and a crowHome of instance B.
 * The invariant is that nothing active in the output may reference A.
 */
function twoInstances() {
  const dir = mkdtempSync(join(tmpdir(), "twoinst-"));
  const A = join(dir, ".crow-a");
  const B = join(dir, ".crow-b");
  mkdirSync(join(A, "bundles", "tasks"), { recursive: true });
  mkdirSync(join(A, "bundles", "rookery"), { recursive: true });
  mkdirSync(join(B, "bundles", "tasks"), { recursive: true });
  mkdirSync(join(B, "data"), { recursive: true });
  writeFileSync(join(B, "mcp-addons.json"), JSON.stringify({
    tasks: { command: "node", args: ["server/index.js"], env: { CROW_TASKS_DB_PATH: join(A, "data", "tasks.db") } },
  }));
  const canonicalPath = join(dir, "canonical.json");
  writeFileSync(canonicalPath, JSON.stringify({ mcpServers: {
    "crow-memory":  { command: "n", args: ["servers/memory/index.js"], cwd: "/repo", env: { CROW_DB_PATH: join(A, "data", "crow.db") } },
    "crow-tasks":   { command: "n", args: ["server/index.js"], cwd: join(A, "bundles", "tasks"), env: { CROW_TASKS_DB_PATH: join(A, "data", "tasks.db") } },
    "crow-rookery": { command: "n", args: ["server/index.js"], cwd: join(A, "bundles", "rookery"), env: {} },
    "brave-search": { command: "npx", args: ["-y", "srv"], cwd: "/home/x", env: { BRAVE_API_KEY: "k" } },
    "gws":          { command: "g", args: [], optIn: true, env: {} },
  } }));
  const sessionDir = join(dir, "session");
  mkdirSync(sessionDir, { recursive: true });
  const binding = {
    CROW_HOME: B,
    CROW_DATA_DIR: join(B, "data"),
    CROW_DB_PATH: join(B, "data", "crow.db"),
    CROW_TASKS_DB_PATH: join(B, "data", "tasks.db"),
  };
  return { dir, A, B, canonicalPath, sessionDir, binding };
}

function write(def, f) {
  const res = writeBotMcp(def, {
    sessionDir: f.sessionDir, canonicalPath: f.canonicalPath, crowHome: f.B, binding: f.binding,
  });
  return { res, json: JSON.parse(readFileSync(join(f.sessionDir, ".mcp.json"), "utf8")) };
}

/** Every string anywhere in a block — cwd, command, args, env values. */
function strings(block) {
  const out = [];
  const walk = (v) => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(block);
  return out;
}

test("THE INVARIANT: no active block references the other instance", () => {
  const f = twoInstances();
  const { json } = write({ tools: { crow_mcp: ["crow-memory", "tasks", "brave-search"] } }, f);
  for (const [name, block] of Object.entries(json.mcpServers)) {
    if (block && block.disabled === true) continue;
    for (const s of strings(block)) {
      assert.ok(!s.includes("/.crow-a"), `${name} leaks instance A via ${s}`);
    }
  }
});

test("a selected core server is rebound to this instance's database", () => {
  const f = twoInstances();
  const { json } = write({ tools: { crow_mcp: ["crow-memory"] } }, f);
  assert.equal(json.mcpServers["crow-memory"].env.CROW_DB_PATH, join(f.B, "data", "crow.db"));
  assert.equal(json.mcpServers["crow-memory"].env.CROW_JOURNAL_MODE, "DELETE");
});

test("closed-world: every unselected canonical server is disabled", () => {
  const f = twoInstances();
  const { json, res } = write({ tools: { crow_mcp: ["crow-memory"] } }, f);
  for (const name of ["crow-tasks", "crow-rookery", "brave-search", "gws"]) {
    assert.deepEqual(json.mcpServers[name], { disabled: true }, `${name} must be disabled`);
  }
  assert.ok(res.disabled.includes("brave-search"));
  assert.deepEqual(res.servers, ["crow-memory"], "servers lists ACTIVE names only");
});

test("a selected bundle absent on this instance is disabled with a reason", () => {
  const f = twoInstances();
  const { json, res } = write({ tools: { crow_mcp: ["crow-rookery"] } }, f);
  assert.deepEqual(json.mcpServers["crow-rookery"], { disabled: true });
  assert.ok(res.warnings.some((w) => /rookery/.test(w) && /not installed/.test(w)),
    "the reason is surfaced, not swallowed: " + JSON.stringify(res.warnings));
});

test("optIn never survives into an active block", () => {
  const f = twoInstances();
  const { json } = write({ tools: { crow_mcp: ["gws"] } }, f);
  assert.ok(!("optIn" in json.mcpServers.gws), "a copied optIn block would never load");
});

test("a non-Crow server is carried through untouched", () => {
  const f = twoInstances();
  const { json } = write({ tools: { crow_mcp: ["brave-search"] } }, f);
  assert.equal(json.mcpServers["brave-search"].env.BRAVE_API_KEY, "k");
  assert.equal(json.mcpServers["brave-search"].cwd, "/home/x");
});

test("minted: a catalog server also present in canonical is NOT minted", () => {
  const f = twoInstances();
  const { res } = write({ tools: { crow_mcp: ["crow-memory"] } }, f);
  assert.ok(!res.minted.includes("crow-memory"),
    "crow-memory is in canonical too — 'minted from extensions' would be false: " + JSON.stringify(res.minted));
});

test("minted: a catalog server absent from canonical IS minted", () => {
  const f = twoInstances();
  const { res } = write({ tools: { crow_mcp: ["tasks"] } }, f);
  assert.ok(res.minted.includes("tasks"),
    "'tasks' only exists via mcp-addons.json, not canonical: " + JSON.stringify(res.minted));
});

test("journalGuarded: a crow.db-touching catalog server is reported", () => {
  const f = twoInstances();
  const { res } = write({ tools: { crow_mcp: ["crow-memory"] } }, f);
  assert.ok(res.journalGuarded.includes("crow-memory"),
    "the WAL-unlink guard must be observable for the catalog path too: " + JSON.stringify(res.journalGuarded));
});

import { toolAllowlist, applySessionNarrowing } from "../scripts/pi-bots/bridge.mjs";

/**
 * Mirrors the --tools branch in the PiRpc constructor. A bot with no builtin
 * and no MCP tools yields "", and omitting the flag hands pi
 * defaultActiveToolNames — bash, edit, write, and every tool registered by
 * every inherited server (pi dist/cli/args.js:85-89 -> dist/core/sdk.js:133-136).
 */
function toolsArgs(def, narrowedTools) {
  const tools = toolAllowlist(def);
  const narrowed = applySessionNarrowing(tools, narrowedTools);
  const args = [];
  if (narrowed !== tools) args.push("--tools", narrowed);
  else args.push("--tools", tools);
  return args;
}

test("an empty tool envelope pins --tools \"\" instead of omitting the flag", () => {
  const def = { tools: { pi_builtin: [], crow_mcp: [] } };
  assert.equal(toolAllowlist(def), "", "precondition: the envelope really is empty");
  assert.deepEqual(toolsArgs(def), ["--tools", ""],
    "omitting the flag would WIDEN an empty envelope to pi's full default surface");
});

test("a normal envelope still pins its allowlist", () => {
  const def = { tools: { pi_builtin: ["read"], crow_mcp: ["tasks/tasks_list"] } };
  assert.deepEqual(toolsArgs(def), ["--tools", "read,mcp__tasks__tasks_list"]);
});

test("narrowing to nothing still pins --tools \"\"", () => {
  const def = { tools: { pi_builtin: ["read"], crow_mcp: [] } };
  assert.deepEqual(toolsArgs(def, JSON.stringify(["read"])), ["--tools", ""]);
});
