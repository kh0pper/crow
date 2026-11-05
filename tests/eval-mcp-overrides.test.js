/**
 * The eval MCP override seam's pure half (scripts/lib/eval-guard.mjs): the one reviewed table, the
 * check a caller's opts.mcpOverrides must pass, and the rewrite that replaces exactly one block.
 * No server code, no network, no scratch instance; the bridge-side tests are in
 * tests/live-pi-driver-mcp-overrides.test.js.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import {
  EVAL_MCP_OVERRIDES, FIXTURE_SERVER, FIXTURE_START_MARKER, applyMcpOverrides, checkMcpOverrides, checkOverridePath,
} from "../scripts/lib/eval-guard.mjs";
import { realish } from "../scripts/lib/protected-paths.mjs";

const homes = [];
function scratch() {
  const home = mkdtempSync(join(tmpdir(), "crow-mcpo-"));
  homes.push(home);
  return home;
}
test.after(() => { for (const h of homes) rmSync(h, { recursive: true, force: true }); });

/** The only override the table allows, for one sealed home. */
const valid = (home) => ({
  "crow-projects": {
    command: process.execPath,
    args: [FIXTURE_SERVER],
    env: {
      CROW_RESEARCH_EVAL: "1", CROW_HOME: home, CROW_RESEARCH_EVAL_CASE: join(home, "case.json"),
      CROW_RESEARCH_EVAL_FETCH_LOG: join(home, "fetch.jsonl"), TMPDIR: tmpdir(),
    },
  },
});

/** A plausible mcp config: the crow-projects block plus a disabled one and a url one. */
const config = (home) => ({
  mcpServers: {
    "crow-projects": {
      command: process.execPath, args: ["servers/research/index.js"], cwd: "/repo",
      env: { CROW_DB_PATH: join(home, "data", "crow.db"), CROW_JOURNAL_MODE: "DELETE", CROW_ACTOR_KIND: "bot", CROW_ACTOR_BOT_ID: "research-eval" },
    },
    "crow-memory": { command: process.execPath, args: ["servers/memory/index.js"], env: { CROW_DB_PATH: join(home, "data", "crow.db") } },
    board: { disabled: true },
    phone: { url: "http://127.0.0.1:3001/phone/mcp", headers: { "X-Crow-Actor-Id": "research-eval" } },
  },
});

test("the table names one block, the fixture server, and a fixed env rule set", () => {
  assert.deepEqual(Object.keys(EVAL_MCP_OVERRIDES), ["crow-projects"]);
  assert.ok(FIXTURE_SERVER.endsWith("research-eval/fixture-server.mjs"));
  const spec = EVAL_MCP_OVERRIDES["crow-projects"];
  assert.deepEqual([...spec.args], [FIXTURE_SERVER]);
  assert.deepEqual(spec.env, {
    CROW_RESEARCH_EVAL: "1", CROW_HOME: "sealed", CROW_RESEARCH_EVAL_CASE: "path",
    CROW_RESEARCH_EVAL_FETCH_LOG: "path", TMPDIR: "tmpdir",
  });
  assert.deepEqual([...spec.requiredEnv], ["CROW_RESEARCH_EVAL", "CROW_HOME", "CROW_RESEARCH_EVAL_CASE", "CROW_RESEARCH_EVAL_FETCH_LOG"]);
  assert.equal(FIXTURE_START_MARKER, "fixture-start.json");
  assert.ok(Object.isFrozen(EVAL_MCP_OVERRIDES) && Object.isFrozen(spec) && Object.isFrozen(spec.env));
});

test("checkMcpOverrides accepts exactly the crow-projects fixture override, and freezes its copy", () => {
  const home = realish(scratch());
  const got = checkMcpOverrides(valid(home), home);
  assert.deepEqual(Object.keys(got), ["crow-projects"]);
  assert.equal(got["crow-projects"].command, process.execPath);
  assert.deepEqual([...got["crow-projects"].args], [FIXTURE_SERVER]);
  assert.equal(got["crow-projects"].env.CROW_HOME, home);
  assert.ok(Object.isFrozen(got) && Object.isFrozen(got["crow-projects"]) && Object.isFrozen(got["crow-projects"].env));
});

test("checkMcpOverrides resolves a symlinked home on both sides (realish)", () => {
  const target = scratch();
  const holder = scratch();
  const link = join(holder, "link");
  symlinkSync(target, link);
  // The sealed home is the realpath; the caller may still name the symlink.
  assert.doesNotThrow(() => checkMcpOverrides(valid(link), realish(target)));
  assert.doesNotThrow(() => checkMcpOverrides(valid(realish(target)), realish(target)));
  assert.throws(() => checkMcpOverrides(valid(target), realish(scratch())), /must be the sealed home/);
});

test("checkMcpOverrides refuses every shape outside the table", () => {
  const home = scratch();
  const ok = valid(home);
  const bad = {
    "no overrides": null,
    "an array": [],
    "a string": "crow-projects",
    "two keys": { ...ok, "crow-memory": { ...ok["crow-projects"] } },
    "no keys": {},
    "an unknown block": { "crow-memory": { ...ok["crow-projects"] } },
    "a prototype key": { toString: { ...ok["crow-projects"] } },
    "an extra entry key": { "crow-projects": { ...ok["crow-projects"], cwd: "/repo" } },
    "no command": { "crow-projects": { args: [FIXTURE_SERVER], env: ok["crow-projects"].env } },
    "another command": { "crow-projects": { ...ok["crow-projects"], command: "/bin/sh" } },
    "another args": { "crow-projects": { ...ok["crow-projects"], args: ["servers/research/index.js"] } },
    "args plus one": { "crow-projects": { ...ok["crow-projects"], args: [FIXTURE_SERVER, "--x"] } },
    "an env key outside the table": { "crow-projects": { ...ok["crow-projects"], env: { ...ok["crow-projects"].env, BRAVE_API_KEY: "k" } } },
    "CROW_RESEARCH_EVAL not 1": { "crow-projects": { ...ok["crow-projects"], env: { ...ok["crow-projects"].env, CROW_RESEARCH_EVAL: "true" } } },
    "CROW_HOME another home": { "crow-projects": { ...ok["crow-projects"], env: { ...ok["crow-projects"].env, CROW_HOME: scratch() } } },
    "CROW_HOME a parent dir": { "crow-projects": { ...ok["crow-projects"], env: { ...ok["crow-projects"].env, CROW_HOME: "/" } } },
    "a missing required key": { "crow-projects": { ...ok["crow-projects"], env: { CROW_RESEARCH_EVAL: "1", CROW_HOME: home } } },
    "a relative case path": { "crow-projects": { ...ok["crow-projects"], env: { ...ok["crow-projects"].env, CROW_RESEARCH_EVAL_CASE: "case.json" } } },
    "a case path outside the home": { "crow-projects": { ...ok["crow-projects"], env: { ...ok["crow-projects"].env, CROW_RESEARCH_EVAL_CASE: join(tmpdir(), "elsewhere.json") } } },
    "a dot-dot case path": { "crow-projects": { ...ok["crow-projects"], env: { ...ok["crow-projects"].env, CROW_RESEARCH_EVAL_CASE: `${home}/a/../b.json` } } },
    "a fetch log at the home itself": { "crow-projects": { ...ok["crow-projects"], env: { ...ok["crow-projects"].env, CROW_RESEARCH_EVAL_FETCH_LOG: home } } },
    "TMPDIR elsewhere": { "crow-projects": { ...ok["crow-projects"], env: { ...ok["crow-projects"].env, TMPDIR: home } } },
    "a non-string value": { "crow-projects": { ...ok["crow-projects"], env: { ...ok["crow-projects"].env, CROW_RESEARCH_EVAL: 1 } } },
    "a symbol key": { [Symbol("x")]: { ...ok["crow-projects"] } },
  };
  for (const [name, v] of Object.entries(bad)) assert.throws(() => checkMcpOverrides(v, home), /^Error: eval mcp override refused: /, name);
  assert.throws(() => checkMcpOverrides(new Proxy(ok, {}), home), /must not be a Proxy/);
  assert.throws(() => checkMcpOverrides(Object.assign(Object.create({}), ok), home), /must be a plain object/);
  assert.throws(() => checkMcpOverrides(ok, undefined), /no sealed home/);
  assert.throws(() => checkMcpOverrides(ok, "relative/path"), /no sealed home/);
});

test("checkMcpOverrides reads no env: a forged env inside the options is refused, process.env untouched", () => {
  const home = scratch();
  const before = JSON.stringify(process.env);
  // The env-looking keys are not override keys: the seam takes values, never an environment.
  const forged = {
    "crow-projects": {
      command: process.execPath, args: [FIXTURE_SERVER], env: valid(home)["crow-projects"].env,
      CROW_HOME: home, CROW_RESEARCH_EVAL: "1", processEnv: { CROW_HOME: home },
    },
  };
  assert.throws(() => checkMcpOverrides(forged, home), /unknown key/);
  checkMcpOverrides(valid(home), home);
  assert.equal(JSON.stringify(process.env), before);
});

test("applyMcpOverrides changes exactly one block; every other block and key is deep-equal", () => {
  const home = realish(scratch());
  mkdirSync(join(home, "data"), { recursive: true });
  const input = config(home);
  const snapshot = structuredClone(input);
  const checked = checkMcpOverrides(valid(home), home);
  const { config: out, changed } = applyMcpOverrides(input, checked, home);
  assert.deepEqual(changed, ["crow-projects"]);
  assert.deepEqual(input, snapshot, "the input is never mutated");
  assert.notEqual(out, input);
  assert.deepEqual(out.mcpServers["crow-memory"], input.mcpServers["crow-memory"]);
  assert.deepEqual(out.mcpServers.board, input.mcpServers.board);
  assert.deepEqual(out.mcpServers.phone, input.mcpServers.phone);
  const block = out.mcpServers["crow-projects"];
  assert.equal(block.command, process.execPath);
  assert.deepEqual(block.args, [FIXTURE_SERVER]);
  assert.equal(block.cwd, "/repo", "a key the override does not name is untouched");
  // The override's env merges on top of the block env; the actor env survives.
  assert.deepEqual(block.env, { ...input.mcpServers["crow-projects"].env, ...checked["crow-projects"].env });
  assert.equal(block.env.CROW_ACTOR_KIND, "bot");
});

test("applyMcpOverrides refuses a missing, url, disabled or unprotected block, and a null config", () => {
  const home = realish(scratch());
  mkdirSync(join(home, "data"), { recursive: true });
  const checked = checkMcpOverrides(valid(home), home);
  const base = config(home);
  const block = base.mcpServers["crow-projects"];
  const refuse = (c, re = /^Error: eval mcp override refused: /) => assert.throws(() => applyMcpOverrides(c, checked, home), re);
  refuse(null, /missing/);
  refuse(undefined, /missing/);
  refuse({}, /no mcpServers/);
  refuse({ mcpServers: [] }, /no mcpServers/);
  refuse({ mcpServers: {} }, /block crow-projects is missing/);
  refuse({ ...base, mcpServers: { ...base.mcpServers, "crow-projects": { disabled: true } } }, /is disabled/);
  refuse({ ...base, mcpServers: { ...base.mcpServers, "crow-projects": { url: "http://127.0.0.1:1/mcp" } } }, /is a url block/);
  refuse({ ...base, mcpServers: { ...base.mcpServers, "crow-projects": { ...block, env: {} } } }, /CROW_DB_PATH/);
  refuse({ ...base, mcpServers: { ...base.mcpServers, "crow-projects": { ...block, env: { CROW_DB_PATH: "/srv/real/crow.db" } } } }, /CROW_DB_PATH/);
  refuse({ ...base, mcpServers: { ...base.mcpServers, "crow-projects": { ...block, env: { ...block.env, BRAVE_API_KEY: "k" } } } }, /BRAVE_API_KEY/);
  // One override per call, at apply time too.
  assert.throws(() => applyMcpOverrides(base, { ...checked, "crow-memory": checked["crow-projects"] }, home), /exactly one override/);
  assert.throws(() => applyMcpOverrides(base, {}, home), /exactly one override/);
});

test("checkOverridePath: only an absolute, normalized path strictly inside the sealed home", () => {
  const home = realish(scratch());
  const inside = join(home, "sessions", ".mcp.json");
  assert.equal(checkOverridePath(inside, home), inside);
  for (const [p, re] of [["relative.json", /absolute, normalized/], [`${home}/a/../b.json`, /absolute, normalized/],
    [home, /strictly inside/], ["/etc/passwd", /strictly inside/]]) {
    assert.throws(() => checkOverridePath(p, home), re, p);
  }
  assert.throws(() => checkOverridePath(inside, undefined), /no sealed home/);
});

test("the guard module still imports only built-ins and protected-paths (the table adds nothing)", () => {
  const src = readFileSync(new URL("../scripts/lib/eval-guard.mjs", import.meta.url), "utf8");
  const specs = [...src.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s*"([^"]+)"/gms)].map((m) => m[1]);
  assert.ok(specs.length > 0);
  for (const s of specs) assert.ok(s.startsWith("node:") || s.endsWith("protected-paths.mjs"), s);
  // FIXTURE_SERVER is a path constant, never an import of the fixture server.
  assert.doesNotMatch(src, /^\s*import[^;]*fixture-server/m);
});