/**
 * Kevin ruling 2026-10-08 (revision b): a bot's pi process gets an explicit
 * ALLOWLIST of environment variables — the gateway's .env secrets never reach
 * it, so a bot shell's `env` cannot show them. MCP servers still get what
 * they need through their own config blocks (core blocks carry explicit env).
 * While the scrub is off (operator escape hatch CROW_BOT_ENV_PASSTHROUGH=1) a
 * bot cannot be given a shell: the validator refuses ask/auto/allowlist and
 * the bridge clamps any stored one to deny at spawn.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const k of Object.keys(process.env)) if (/^(PI_|PIBOT_)/.test(k)) delete process.env[k];
process.env.CROW_PI_SANDBOX = "off";
// gateway-like env: .env secrets loaded into process.env at runtime
Object.assign(process.env, {
  GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_fake_for_test", CROW_LOCAL_MCP_TOKEN: "tok_fake", PHONE_RUNNER_SECRET: "s_fake",
  CROW_BROWSER_VNC_PASSWORD: "pw_fake", MAKER_LAB_LLM_ENDPOINT: "http://127.0.0.1:1/v1", SOME_RANDOM_SETTING: "x",
  CROW_HOME: "/tmp/crow-home-fake", LANG: "en_US.UTF-8", LC_ALL: "C.UTF-8",
});

const { buildBotBaseEnv, botEnvScrubbed, SECRET_NAME_RE } = await import("../servers/shared/bot-env.js");
const { validatePermissionPolicy } = await import("../servers/shared/bot-permission-policy.js");
const { PiRpc } = await import("../scripts/pi-bots/bridge.mjs");

test("base env: allowlisted names only; every secret-like name dropped, even if extra-allowed", () => {
  const env = buildBotBaseEnv(process.env, { extraAllow: "SOME_RANDOM_SETTING,GITHUB_PERSONAL_ACCESS_TOKEN" });
  for (const k of ["GITHUB_PERSONAL_ACCESS_TOKEN", "CROW_LOCAL_MCP_TOKEN", "PHONE_RUNNER_SECRET", "CROW_BROWSER_VNC_PASSWORD", "MAKER_LAB_LLM_ENDPOINT"]) {
    assert.equal(k in env, false, k);
  }
  assert.equal(env.SOME_RANDOM_SETTING, "x"); // operator extra-allow, not secret-like
  assert.equal(env.CROW_HOME, "/tmp/crow-home-fake");
  assert.equal(env.LANG, "en_US.UTF-8");
  assert.equal(env.LC_ALL, "C.UTF-8");
  assert.ok(env.PATH && env.HOME);
  assert.ok(SECRET_NAME_RE.test("ANTHROPIC_API_KEY") && SECRET_NAME_RE.test("X_PASSWD") && !SECRET_NAME_RE.test("LANG"));
});

test("passthrough switch: scrub off => no shell may be granted", () => {
  assert.equal(botEnvScrubbed({}), true);
  assert.equal(botEnvScrubbed({ CROW_BOT_ENV_PASSTHROUGH: "1" }), false);
  for (const bash of ["ask", "auto", "allowlist"]) {
    assert.deepEqual(validatePermissionPolicy({ bash }, { env: {} }), []);
    assert.match(validatePermissionPolicy({ bash }, { env: { CROW_BOT_ENV_PASSTHROUGH: "1" } }).join(), /environment/);
  }
  assert.deepEqual(validatePermissionPolicy({ bash: "deny" }, { env: { CROW_BOT_ENV_PASSTHROUGH: "1" } }), []);
});

function scratch() { const d = mkdtempSync(join(tmpdir(), "crow-env-scrub-")); mkdirSync(join(d, "sessions"), { recursive: true }); return d; }
async function shellEnvOfBot(def) {
  const dir = scratch();
  const stub = join(dir, "stub-pi.mjs");
  // what pi's bash tool does: a child shell inheriting pi's environment
  writeFileSync(stub, [
    'import { execFileSync } from "node:child_process";',
    'import { writeFileSync } from "node:fs";',
    `writeFileSync(${JSON.stringify(join(dir, "env.txt"))}, execFileSync("/bin/sh", ["-c", "env"], { encoding: "utf8" }));`,
    `writeFileSync(${JSON.stringify(join(dir, "policy.json"))}, process.env.PI_BOT_PERMISSION_POLICY || "");`,
    "setTimeout(() => process.exit(0), 30);",
  ].join("\n"));
  const pi = new PiRpc({ def, sessionDir: dir, resolved: { provider: "p", model: "m", key: "p/m" },
    nodeBin: process.execPath, cliPath: stub, diagLog: () => {} });
  await new Promise((r) => pi.proc.on("exit", r));
  return { env: readFileSync(join(dir, "env.txt"), "utf8"), policy: JSON.parse(readFileSync(join(dir, "policy.json"), "utf8")) };
}

test("a bot shell's `env` shows none of the gateway secrets", async () => {
  const { env } = await shellEnvOfBot({ permission_policy: { bash: "auto", write_paths: [] } });
  for (const k of ["GITHUB_PERSONAL_ACCESS_TOKEN", "CROW_LOCAL_MCP_TOKEN", "PHONE_RUNNER_SECRET", "CROW_BROWSER_VNC_PASSWORD", "SOME_RANDOM_SETTING"]) {
    assert.equal(new RegExp("^" + k + "=", "m").test(env), false, k);
  }
  for (const v of ["ghp_fake_for_test", "tok_fake", "s_fake", "pw_fake"]) assert.equal(env.includes(v), false, v);
  assert.match(env, /^PI_BOT_PERMISSION_POLICY=/m);
  assert.match(env, /^CROW_HOME=/m);
});

test("stored sandbox runs as DENY at spawn until the owner confirms; unknown runs as deny", async () => {
  assert.equal((await shellEnvOfBot({ permission_policy: { bash: "sandbox", write_paths: [] } })).policy.bash, "deny");
  assert.equal((await shellEnvOfBot({ permission_policy: { bash: "weird", write_paths: [] } })).policy.bash, "deny");
});

test("with the scrub switched off, a shell policy is clamped to deny at spawn", async () => {
  process.env.CROW_BOT_ENV_PASSTHROUGH = "1";
  try {
    const r = await shellEnvOfBot({ permission_policy: { bash: "auto", write_paths: [] } });
    assert.equal(r.policy.bash, "deny");
  } finally { delete process.env.CROW_BOT_ENV_PASSTHROUGH; }
});
