/**
 * The live pi driver's configuration guards: pure functions, no process spawned. The file never
 * assigns to process.env; env-dependent guards take the env as an argument.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DriverRefusal, checkEndpoints, checkBotDef, checkScratchHome, checkExtraEnv, checkToolSurface, childEnv,
  PARENT_ENV_ALLOW,
} from "../scripts/lib/live-pi-driver.mjs";
import { SECRET_NAME_RE } from "../servers/shared/bot-env.js";

const mk = (baseUrl, extra = {}) => ({ providers: { stub: { baseUrl, api: "openai-completions", apiKey: "stub", models: [{ id: "m1" }], ...extra } } });
const tmps = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "lpd-guard-")); tmps.push(d); return d; };
const withDb = (d) => { mkdirSync(join(d, "data"), { recursive: true }); writeFileSync(join(d, "data", "crow.db"), ""); return d; };
test.after(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });

test("loopback endpoint passes", () => {
  checkEndpoints(mk("http://127.0.0.1:8010/v1"), { gatewayPort: undefined });
});

test("gateway-shaped loopback endpoints are refused", () => {
  for (const url of ["http://localhost:3001/v1", "http://127.0.0.1:8010/llm/v1", "http://[::1]:3002", "HTTP://LOCALHOST:3001"]) {
    assert.throws(() => checkEndpoints(mk(url), { gatewayPort: undefined }), (e) => e instanceof DriverRefusal && /stub/.test(e.message), url);
  }
  assert.throws(() => checkEndpoints(mk("http://127.0.0.1:9/proxy/x"), {}), DriverRefusal);
  assert.throws(() => checkEndpoints(mk("http://127.0.0.1:4555/v1"), { gatewayPort: "4555" }), DriverRefusal);
  assert.throws(() => checkEndpoints(mk("http://127.0.0.1:4556/v1"), { gatewayPorts: [4556] }), DriverRefusal);
});

test("remote host refused unless allowlisted", () => {
  const m = mk("http://192.0.2.10:8030/v1");
  assert.throws(() => checkEndpoints(m, {}), DriverRefusal);
  checkEndpoints(m, { allowHosts: ["192.0.2.10:8030"] });
});

test("IPv6 and default ports", () => {
  checkEndpoints(mk("http://[::1]:8010/v1"), {});
  checkEndpoints(mk("http://198.51.100.5/v1"), { allowHosts: ["198.51.100.5:80"] });
  assert.throws(() => checkEndpoints(mk("http://198.51.100.5/v1"), { allowHosts: ["198.51.100.5:8080"] }), DriverRefusal);
});

test("provider without baseUrl refused", () => {
  assert.throws(() => checkEndpoints({ providers: { stub: { models: [] } } }, {}), (e) => e instanceof DriverRefusal && /stub/.test(e.message));
});

const models = mk("http://127.0.0.1:8010/v1");
test("bot def model must exist in models", () => {
  checkBotDef({ id: "b", models: { default: "stub/m1" } }, models, tmp());
  assert.throws(() => checkBotDef({ id: "b", models: { default: "stub/m1", quick: "other/m1" } }, models, tmp()), DriverRefusal);
  assert.throws(() => checkBotDef({ id: "b", models: { default: "stub/nope" } }, models, tmp()), DriverRefusal);
});

test("bot def without models.default refused", () => {
  assert.throws(() => checkBotDef({ id: "b", models: { quick: "stub/m1" } }, models, tmp()), DriverRefusal);
  assert.throws(() => checkBotDef({ id: "b" }, models, tmp()), DriverRefusal);
  assert.throws(() => checkBotDef({ id: "", models: { default: "stub/m1" } }, models, tmp()), DriverRefusal);
});

test("session_dir outside scratch refused", () => {
  const home = tmp();
  const def = { id: "b", models: { default: "stub/m1" } };
  checkBotDef({ ...def, session_dir: join(home, "pi-bots", "b") }, models, home);
  assert.throws(() => checkBotDef({ ...def, session_dir: tmpdir() }, models, home), DriverRefusal);
  assert.throws(() => checkBotDef({ ...def, session_dir: home }, models, home), DriverRefusal);
});

test("scratch home: accepted with crow.db, refused without", () => {
  const home = withDb(tmp());
  assert.equal(checkScratchHome(home), realpathSync(home));
  assert.throws(() => checkScratchHome(tmp()), DriverRefusal);
  assert.throws(() => checkScratchHome(tmpdir()), DriverRefusal);
});

test("symlinked scratch home is refused", () => {
  const fake = withDb(tmp());
  const holder = tmp();
  const link = join(holder, "link");
  symlinkSync(fake, link);
  const env = { CROW_SUITE_PROTECTED_ROOTS: fake };
  assert.throws(() => checkScratchHome(link, env), /protected/);
  checkScratchHome(link, {}); // control: the same link passes when nothing is protected
});

test("extra env allowlist", () => {
  assert.deepEqual(checkExtraEnv({ CROW_SESSION_BRIEFING: "0" }), { CROW_SESSION_BRIEFING: "0" });
  for (const bad of [{ CROW_DB_PATH: "/x" }, { FOO: "1" }, { CROW_SESSION_BRIEFING: 0 }, { CROW_HOME: "/x" }]) {
    assert.throws(() => checkExtraEnv(bad), DriverRefusal, JSON.stringify(bad));
  }
});

test("tool surface", () => {
  const home = tmp();
  // A symlink INSIDE the scratch that points OUT of it: realish resolves it before the check.
  const outside = tmp();
  symlinkSync(outside, join(home, "out-link"));
  const ok = () => ({
    id: "b", models: { default: "stub/m1" },
    permission_policy: { bash: "deny", write_paths: [join(home, "w")], read_paths: [join(home, "r")] },
    tools: { pi_builtin: ["read", "write", "edit"], crow_mcp: ["crow-projects", "crow-projects/crow_add_source"] },
    spawn_env: {}, pi_extensions: [], skills: ["research-pipeline"],
  });
  const opts = { allowServers: ["crow-projects"], allowSkills: ["research-pipeline"], scratchHome: home };
  checkToolSurface(ok(), opts);
  checkToolSurface({ id: "b", permission_policy: { bash: "deny" } }, opts);
  const mut = (f) => { const d = ok(); f(d); return d; };
  const bads = {
    "bash ask": mut((d) => { d.permission_policy.bash = "ask"; }),
    "pi_builtin bash": mut((d) => { d.tools.pi_builtin = ["bash"]; }),
    "write_paths /tmp": mut((d) => { d.permission_policy.write_paths = ["/tmp"]; }),
    "write_paths home itself": mut((d) => { d.permission_policy.write_paths = [home]; }),
    "read_paths /tmp": mut((d) => { d.permission_policy.read_paths = ["/tmp"]; }),
    "read_paths /": mut((d) => { d.permission_policy.read_paths = ["/"]; }),
    "read_paths home itself": mut((d) => { d.permission_policy.read_paths = [home]; }),
    "read_paths outside": mut((d) => { d.permission_policy.read_paths = [outside]; }),
    "read_paths symlink out": mut((d) => { d.permission_policy.read_paths = [join(home, "out-link")]; }),
    "read_paths below a symlink out": mut((d) => { d.permission_policy.read_paths = [join(home, "out-link", "secrets")]; }),
    "read_paths not a string": mut((d) => { d.permission_policy.read_paths = [7]; }),
    "server not allowed": mut((d) => { d.tools.crow_mcp = ["other"]; }),
    "server/tool not allowed": mut((d) => { d.tools.crow_mcp = ["other/crow_x"]; }),
    "board": mut((d) => { d.tools.crow_mcp = ["board"]; }),
    "spawn_env": mut((d) => { d.spawn_env = { A: "1" }; }),
    "tools.pi_extensions": mut((d) => { d.tools.pi_extensions = ["x"]; }),
    "top pi_extensions": mut((d) => { d.pi_extensions = ["x"]; }),
    "policy skill_learning auto": mut((d) => { d.permission_policy.skill_learning = "auto"; }),
    "top skill_learning auto": mut((d) => { d.skill_learning = "auto"; }),
    "policy self_authoring": mut((d) => { d.permission_policy.self_authoring = true; }),
    "top self_authoring": mut((d) => { d.self_authoring = true; }),
    "remote_mcp": mut((d) => { d.tools.remote_mcp = [{ name: "x" }]; }),
    "multi_agent": mut((d) => { d.permission_policy.multi_agent = true; }),
    "project_id": mut((d) => { d.project_id = 1; }),
    "skill not allowed": mut((d) => { d.skills = ["other"]; }),
  };
  for (const [name, d] of Object.entries(bads)) assert.throws(() => checkToolSurface(d, opts), DriverRefusal, name);
  assert.throws(() => checkToolSurface(mut((d) => { d.tools.crow_mcp = ["board"]; }), { ...opts, allowServers: ["board"] }), DriverRefusal);
});

const baseArgs = { home: "/tmp/h", botId: "b", runId: "run1", piCli: "/opt/pi/cli.js", turnTimeoutMs: 90000 };
test("child env is an allowlist", () => {
  const parent = {
    PATH: "/usr/bin", LANG: "C", LC_ALL: "C", CROW_GATEWAY_URL: "http://127.0.0.1:3001", CROW_BOT_ENV_PASSTHROUGH: "1",
    CROW_BOT_ENV_ALLOW: "X", PI_LOCAL_MODELS_SETTINGS: "/x", GITHUB_TOKEN: "t", FOO: "1",
    PIBOT_MCP_CONFIG_DELIVERY: "env", CROW_PI_SANDBOX: "1",
  };
  const e = childEnv({ ...baseArgs, parent, extraEnv: { CROW_SESSION_BRIEFING: "0" } });
  assert.equal(e.CROW_GATEWAY_URL, "http://127.0.0.1:1");
  assert.equal(e.CROW_BOT_ENV_ALLOW, "CROW_EVAL_RUN_ID", "the parent's X is dropped; the pinned marker allow stays");
  for (const k of ["CROW_BOT_ENV_PASSTHROUGH", "PI_LOCAL_MODELS_SETTINGS", "GITHUB_TOKEN", "FOO", "PIBOT_MCP_CONFIG_DELIVERY", "CROW_PI_SANDBOX"]) assert.equal(k in e, false, k);
  assert.equal(e.CROW_SESSION_BRIEFING, "0");
  assert.equal(e.PIBOT_PI_CLI, "/opt/pi/cli.js");
  assert.equal(e.PIBOT_TURN_TIMEOUT_MS, "90000");
  assert.equal(e.PIBOT_PROMPT_ACK_TIMEOUT_MS, "60000");
  assert.equal(e.PIBOT_MAX_PI, "99");
  assert.equal(e.CROW_EVAL_RUN_ID, "run1");
  assert.equal(e.PI_CODING_AGENT_DIR, "/tmp/h/pi-agent");
  assert.equal(e.PI_MODELS_JSON, "/tmp/h/pi-agent/models.json");
  const documented = new Set([...PARENT_ENV_ALLOW, "NODE_TEST_CONTEXT", "HOME", "CROW_HOME", "CROW_DATA_DIR", "CROW_DB_PATH", "CROW_APP_ENV_PATH",
    "CROW_DISABLE_NOSTR", "CROW_DISABLE_INSTANCE_SYNC", "CROW_RESEARCH_EVAL", "CROW_ACTOR_KIND", "CROW_ACTOR_BOT_ID", "CROW_JOURNAL_MODE",
    "PI_CODING_AGENT_DIR", "PI_MODELS_JSON", "PIBOT_WARM_GATEWAY_URL", "PIBOT_WARM_TIMEOUT_MS", "CROW_GATEWAY_PORT", "CROW_GATEWAY_URL",
    "PIBOT_MAX_PI", "PIBOT_TURN_TIMEOUT_MS", "PIBOT_PROMPT_ACK_TIMEOUT_MS", "CROW_EVAL_RUN_ID", "CROW_BOT_ENV_ALLOW", "PIBOT_PI_CLI", "CROW_SESSION_BRIEFING"]);
  for (const k of Object.keys(e)) assert.ok(documented.has(k) || k.startsWith("LC_"), `undocumented key ${k}`);
  assert.equal(e.LC_ALL, "C");
});

test("child env pins CROW_BOT_ENV_ALLOW to the run marker; a parent value never lands", () => {
  assert.equal(childEnv({ ...baseArgs, parent: { PATH: "/p" } }).CROW_BOT_ENV_ALLOW, "CROW_EVAL_RUN_ID");
  const e = childEnv({ ...baseArgs, parent: { PATH: "/p", CROW_BOT_ENV_ALLOW: "X", X: "leak", NODE_TEST_CONTEXT: "child-v8" } });
  assert.equal(e.CROW_BOT_ENV_ALLOW, "CROW_EVAL_RUN_ID");
  assert.equal("X" in e, false);
});

test("child env never targets a gateway warm", () => {
  const e = childEnv({ ...baseArgs, parent: { PATH: "/usr/bin", CROW_SUPERVISED: "1", INVOCATION_ID: "x", BRAVE_API_KEY: "k", PIBOT_WARM_GATEWAY_URL: "http://gw" } });
  assert.equal(e.PIBOT_WARM_GATEWAY_URL, "http://127.0.0.1:1");
  assert.equal(e.PIBOT_WARM_TIMEOUT_MS, "1000");
  for (const k of ["CROW_SUPERVISED", "INVOCATION_ID", "BRAVE_API_KEY"]) assert.equal(k in e, false, k);
});

test("child env: PIBOT_TEST_ keys pass only under NODE_TEST_CONTEXT; no secret-named parent key survives", () => {
  const without = childEnv({ ...baseArgs, parent: { PATH: "/p", PIBOT_TEST_HANG: "1", SSL_CERT_FILE: "/c" } });
  assert.equal("PIBOT_TEST_HANG" in without, false);
  assert.equal(without.SSL_CERT_FILE, "/c");
  const withCtx = childEnv({ ...baseArgs, parent: { PATH: "/p", PIBOT_TEST_HANG: "1", NODE_TEST_CONTEXT: "child-v8" } });
  assert.equal(withCtx.PIBOT_TEST_HANG, "1");
  assert.equal(withCtx.NODE_TEST_CONTEXT, "child-v8");
  const e = childEnv({ ...baseArgs, parent: { PATH: "/p", LC_SESSION_X: "1", TERM: "x" } });
  assert.equal("LC_SESSION_X" in e, false);
});

test("child env requires an absolute piCli and refuses bad extra env", () => {
  assert.throws(() => childEnv({ ...baseArgs, piCli: "pi", parent: {} }), DriverRefusal);
  assert.throws(() => childEnv({ ...baseArgs, extraEnv: { CROW_DB_PATH: "/x" }, parent: {} }), DriverRefusal);
});

test("SECRET_NAME_RE sanity: the allowed flags would trip it (why the parent-only rule exists)", () => {
  assert.ok(SECRET_NAME_RE.test("CROW_SESSION_BRIEFING"));
});

test("the driver module imports no bridge, database or server db code", () => {
  const src = readFileSync(new URL("../scripts/lib/live-pi-driver.mjs", import.meta.url), "utf8");
  for (const m of src.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
    assert.doesNotMatch(m[1], /bridge|better-sqlite3|servers\/db/, m[1]);
  }
});

test("hardening: case, userinfo, non-array options, bad runId/timeout", () => {
  assert.throws(() => checkEndpoints(mk("http://127.0.0.1:8010/LLM/v1"), {}), DriverRefusal);
  assert.throws(() => checkEndpoints(mk("http://127.0.0.1:8010/Proxy/x"), {}), DriverRefusal);
  assert.throws(() => checkEndpoints(mk("http://user:pw@127.0.0.1:8010/v1"), {}), DriverRefusal);
  assert.throws(() => checkEndpoints(mk("http://user@127.0.0.1:8010/v1"), {}), DriverRefusal);
  assert.throws(() => checkEndpoints(mk("http://127.0.0.1:8010/v1"), { gatewayPorts: 3 }), DriverRefusal);
  assert.throws(() => checkEndpoints(mk("http://127.0.0.1:8010/v1"), { allowHosts: "x" }), DriverRefusal);
  const home = tmp();
  const def = { permission_policy: { bash: "deny" } };
  const good = { allowServers: [], allowSkills: [], scratchHome: home };
  assert.throws(() => checkToolSurface(def, { ...good, allowServers: "a" }), DriverRefusal);
  assert.throws(() => checkToolSurface(def, { ...good, allowSkills: "a" }), DriverRefusal);
  assert.throws(() => checkToolSurface({ ...def, tools: { crow_mcp: "crow-projects" } }, good), DriverRefusal);
  assert.throws(() => checkToolSurface({ ...def, tools: { pi_builtin: "read" } }, good), DriverRefusal);
  for (const turnTimeoutMs of [0, -1, NaN, Infinity, "90000", undefined]) assert.throws(() => childEnv({ ...baseArgs, turnTimeoutMs, parent: {} }), DriverRefusal, String(turnTimeoutMs));
  for (const runId of ["", undefined, 5]) assert.throws(() => childEnv({ ...baseArgs, runId, parent: {} }), DriverRefusal, String(runId));
});
