/**
 * The environment an add-on's stdio child starts with: the allowlisted base, the
 * keys its reviewed repo manifest declares, and its own config env — never the
 * gateway's whole environment. Also the dev/test read logger.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ADDON_BASE_KEYS, ADDON_DENY_KEYS, addonBaseEnv, declaredEnvKeys, declaredPassthrough, isDeniedAddonKey,
} from "../servers/gateway/addon-env.js";
import { getManifest } from "../servers/gateway/bundles-config.js";
import { addonStdioEnv, integrationChildEnv } from "../servers/gateway/proxy.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const LOGGER = join(ROOT, "scripts", "dev", "addon-env-read-logger.mjs");

/** A gateway environment holding every kind of secret the deny list names, plus noise. */
const GATEWAY_ENV = {
  PATH: "/usr/bin:/bin",
  HOME: "/home/someone",
  LANG: "en_US.UTF-8",
  NODE_ENV: "production",
  CROW_HOME: "/home/someone/.crow",
  CROW_APP_ROOT: "/home/someone/crow",
  CROW_DATA_DIR: "/home/someone/.crow/data",
  CROW_DB_PATH: "/home/someone/.crow/data/crow.db",
  CROW_GATEWAY_PORT: "3001",
  PORT: "3001",
  CROW_LOCAL_MCP_TOKEN: "tok_local",
  GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_aaaa",
  GITHUB_TOKEN: "ghp_bbbb",
  PHONE_RUNNER_SECRET: "phone-secret-placeholder-aaaaaaaaaaaaaaaa",
  CROW_BROWSER_VNC_PASSWORD: "vnc-placeholder",
  MINIO_ROOT_USER: "crowadmin",
  MINIO_ROOT_PASSWORD: "minio-placeholder-aaaaaaaa",
  SOME_DB_ROOT_PASSWORD: "dbroot-placeholder",
  BRAVE_API_KEY: "brave-placeholder",
  FRIGATE_USER: "frigate-user",
  FRIGATE_PASSWORD: "frigate-placeholder",
  CROW_SMTP_HOST: "mail.invalid",
  CROW_SMTP_PORT: "587",
  CROW_SMTP_USER: "crow@invalid",
  CROW_SMTP_PASS: "smtp-placeholder",
  CROW_SMTP_FROM: "crow@invalid",
  RENDER_API_KEY: "render-placeholder",
  PGPASSWORD: "pg-placeholder",
  FOO_TOKEN: "foo-placeholder",
  RANDOM_SETTING: "x",
};

test("the base is the allowlist: system basics, Crow instance keys, and nothing else", () => {
  const base = addonBaseEnv(GATEWAY_ENV);
  for (const key of ADDON_BASE_KEYS) assert.equal(base[key], GATEWAY_ENV[key], key);
  assert.equal(base.PATH, GATEWAY_ENV.PATH);
  assert.equal(base.HOME, GATEWAY_ENV.HOME);
  assert.equal(base.LANG, GATEWAY_ENV.LANG);
  assert.equal(base.NODE_ENV, "production");
  for (const key of ADDON_DENY_KEYS) assert.equal(base[key], undefined, key + " is not in the base");
  for (const key of ["BRAVE_API_KEY", "FRIGATE_PASSWORD", "FOO_TOKEN", "SOME_DB_ROOT_PASSWORD", "RANDOM_SETTING"]) {
    assert.equal(base[key], undefined, key + " is not in the base");
  }
});

test("the bot env module's full-environment mode cannot leak into the base", () => {
  const full = { ...GATEWAY_ENV, CROW_BOT_ENV_PASSTHROUGH: "1", CROW_BOT_ENV_ALLOW: "FOO_TOKEN,RANDOM_SETTING" };
  const base = addonBaseEnv(full);
  assert.equal(base.GITHUB_TOKEN, undefined);
  assert.equal(base.GITHUB_PERSONAL_ACCESS_TOKEN, undefined);
  assert.equal(base.CROW_LOCAL_MCP_TOKEN, undefined);
  assert.equal(base.FOO_TOKEN, undefined, "CROW_BOT_ENV_ALLOW cannot widen the base either");
  assert.equal(base.RANDOM_SETTING, undefined);
  assert.equal(base.CROW_BOT_ENV_PASSTHROUGH, undefined, "the switch itself is not handed on");
  assert.equal(base.PATH, full.PATH);
});

test("an add-on with no repo manifest gets the base, its config env and the host marker — nothing else", () => {
  const env = addonStdioEnv({ env: { OWN_SETTING: "1" } }, GATEWAY_ENV, "not-a-bundle-in-the-repo");
  const expected = Object.keys(addonBaseEnv(GATEWAY_ENV)).sort();
  const got = Object.keys(env).sort();
  assert.deepEqual(got, [...expected, "OWN_SETTING", "CROW_ADDON_HOST"].sort());
  assert.equal(env.CROW_ADDON_HOST, "gateway");
  for (const key of Object.keys(GATEWAY_ENV)) {
    if (expected.includes(key)) continue;
    assert.equal(env[key], undefined, key + " reached an add-on that declares nothing");
  }
  assert.equal(addonStdioEnv({}, GATEWAY_ENV, null).GITHUB_TOKEN, undefined);
});

test("add-ons with no id at all declare nothing", () => {
  assert.deepEqual(declaredPassthrough(null, GATEWAY_ENV), {});
  assert.deepEqual(declaredPassthrough("", GATEWAY_ENV), {});
  assert.deepEqual(declaredEnvKeys(null), []);
});

test("frigate's own login reaches it; the Brave key and the GitHub token do not", () => {
  const env = addonStdioEnv({}, GATEWAY_ENV, "frigate");
  assert.equal(env.FRIGATE_USER, GATEWAY_ENV.FRIGATE_USER);
  assert.equal(env.FRIGATE_PASSWORD, GATEWAY_ENV.FRIGATE_PASSWORD);
  assert.equal(env.BRAVE_API_KEY, undefined);
  assert.equal(env.GITHUB_PERSONAL_ACCESS_TOKEN, undefined);
  assert.equal(env.MINIO_ROOT_PASSWORD, undefined);
  assert.equal(env.CROW_ADDON_HOST, "gateway");
});

test("media gets its Brave key and every CROW_SMTP_* key its server reads", () => {
  const env = addonStdioEnv({}, GATEWAY_ENV, "media");
  assert.equal(env.BRAVE_API_KEY, GATEWAY_ENV.BRAVE_API_KEY);
  for (const key of ["CROW_SMTP_HOST", "CROW_SMTP_PORT", "CROW_SMTP_USER", "CROW_SMTP_PASS", "CROW_SMTP_FROM"]) {
    assert.equal(env[key], GATEWAY_ENV[key], key);
  }
  assert.equal(env.FRIGATE_PASSWORD, undefined);
  assert.equal(env.GITHUB_PERSONAL_ACCESS_TOKEN, undefined);
});

test("render's derived header is still rendered, from its declared field", () => {
  const render = { command: "npx", args: ["-y", "mcp-remote"], env: { RENDER_API_KEY: "from-entry" } };
  const env = addonStdioEnv(render, GATEWAY_ENV, "render");
  assert.equal(env.AUTH_HEADER, "Bearer from-entry");
  const fromBase = addonStdioEnv({ command: "npx", args: [] }, GATEWAY_ENV, "render");
  assert.equal(fromBase.AUTH_HEADER, "Bearer render-placeholder", "the declared key is taken from the gateway env");
});

test("the installed copy's manifest never widens what a child receives", (t) => {
  const id = "zz-installed-only-manifest-probe";
  const installedDir = join(process.env.CROW_HOME, "bundles", id);
  t.after(() => { rmSync(installedDir, { recursive: true, force: true }); });
  assert.equal(getManifest(id), null, "no repo manifest for this id");
  mkdirSync(installedDir, { recursive: true });
  writeFileSync(join(installedDir, "manifest.json"), JSON.stringify({
    id, version: "1.0.0", type: "mcp-server",
    server: { command: "node", args: ["server/index.js"], envKeys: ["GITHUB_PERSONAL_ACCESS_TOKEN", "BRAVE_API_KEY"] },
  }));
  assert.deepEqual(declaredPassthrough(id, GATEWAY_ENV), {}, "the installed copy is not read");
  const env = addonStdioEnv({}, GATEWAY_ENV, id);
  assert.equal(env.GITHUB_PERSONAL_ACCESS_TOKEN, undefined);
  assert.equal(env.BRAVE_API_KEY, undefined);
});

test("a repo manifest naming a deny-listed key it does not own gets nothing", () => {
  const manifest = { server: { envKeys: ["GITHUB_PERSONAL_ACCESS_TOKEN", "GITHUB_TOKEN", "SOME_DB_ROOT_PASSWORD", "BRAVE_API_KEY"] } };
  assert.deepEqual(declaredPassthrough("acme", GATEWAY_ENV, { manifestFor: () => manifest }),
    { BRAVE_API_KEY: GATEWAY_ENV.BRAVE_API_KEY }, "only the key that is not the gateway's own");
});

test("minio, phone and browser may receive the deny-listed key their own bundle declares", () => {
  // Real repo manifests: minio and phone declare their own credentials in env_vars.
  const minio = addonStdioEnv({}, GATEWAY_ENV, "minio");
  assert.equal(minio.MINIO_ROOT_USER, GATEWAY_ENV.MINIO_ROOT_USER);
  assert.equal(minio.MINIO_ROOT_PASSWORD, GATEWAY_ENV.MINIO_ROOT_PASSWORD);
  const phone = addonStdioEnv({}, GATEWAY_ENV, "phone");
  assert.equal(phone.PHONE_RUNNER_SECRET, GATEWAY_ENV.PHONE_RUNNER_SECRET);
  // The browser's own VNC password: its manifest no longer declares one (the
  // viewer has none since 1.4.0), so the ownership rule is what carries it.
  const browser = { server: { envKeys: ["CROW_BROWSER_VNC_PASSWORD"] } };
  assert.equal(declaredPassthrough("browser", GATEWAY_ENV, { manifestFor: () => browser }).CROW_BROWSER_VNC_PASSWORD,
    GATEWAY_ENV.CROW_BROWSER_VNC_PASSWORD);
  assert.deepEqual(declaredPassthrough("acme", GATEWAY_ENV, { manifestFor: () => browser }), {},
    "the same key for another bundle is refused");
  // And an unowned *_ROOT_PASSWORD key is refused even when declared.
  assert.equal(isDeniedAddonKey("SOME_DB_ROOT_PASSWORD", "SOME-DB"), true);
  assert.equal(isDeniedAddonKey("MINIO_ROOT_PASSWORD", "minio"), false);
});

test("an entry's own config env and the host marker still win, in that order", () => {
  const env = addonStdioEnv({ env: { CROW_LOCAL_MCP_TOKEN: "from-entry", CROW_ADDON_HOST: "elsewhere" } }, GATEWAY_ENV, "frigate");
  assert.equal(env.CROW_LOCAL_MCP_TOKEN, "from-entry", "config.env is the add-on's own value, not the gateway's secret");
  assert.equal(env.CROW_ADDON_HOST, "gateway", "the marker is set last");
});

test("a built-in integration gets the allowlist plus only what it declares", () => {
  const integration = { id: "brave-search", name: "Brave", command: "npx", args: [], envVars: ["BRAVE_API_KEY"] };
  const env = integrationChildEnv(integration, GATEWAY_ENV);
  assert.equal(env.BRAVE_API_KEY, GATEWAY_ENV.BRAVE_API_KEY);
  assert.equal(env.PATH, GATEWAY_ENV.PATH);
  assert.equal(env.CROW_HOME, GATEWAY_ENV.CROW_HOME);
  for (const key of ["GITHUB_PERSONAL_ACCESS_TOKEN", "CROW_LOCAL_MCP_TOKEN", "MINIO_ROOT_PASSWORD", "FOO_TOKEN", "RANDOM_SETTING"]) {
    assert.equal(env[key], undefined, key);
  }
  // A legacy source's own `env` is its declared env too, and widens nothing else.
  const legacy = { id: "github", name: "GitHub", command: "npx", args: [], env: { GITHUB_PERSONAL_ACCESS_TOKEN: "own" } };
  const gh = integrationChildEnv(legacy, GATEWAY_ENV);
  assert.equal(gh.GITHUB_PERSONAL_ACCESS_TOKEN, "own");
  assert.equal(gh.MINIO_ROOT_PASSWORD, undefined);
});

test("a data backend keeps the base env it was given", () => {
  const backend = { id: "backend-7", name: "Warehouse", command: "node", args: [], envVars: ["PGPASSWORD"], baseEnv: { PATH: "/usr/bin", DATABASE_URL: "postgres://x" } };
  const env = integrationChildEnv(backend, GATEWAY_ENV);
  assert.deepEqual(env, { PATH: "/usr/bin", DATABASE_URL: "postgres://x", PGPASSWORD: "pg-placeholder" });
});

test("the dev read logger names an undeclared key and never its value", () => {
  const script = "process.stdout.write([process.env.ALLOWED_ONE, process.env.UNDECLARED_SECRET, process.env.PATH ? 'path' : ''].join('|'));";
  const r = spawnSync(process.execPath, ["--import", LOGGER, "--input-type=module", "-e", script], {
    encoding: "utf8",
    timeout: 30_000,
    env: {
      PATH: process.env.PATH,
      ALLOWED_ONE: "one",
      UNDECLARED_SECRET: "value-that-must-not-be-printed",
      CROW_ADDON_ENV_ALLOW: "PATH,ALLOWED_ONE",
    },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "one|value-that-must-not-be-printed|path", "wrapping process.env does not change what the program reads");
  const lines = r.stderr.split("\n").filter((l) => l.startsWith("[addon-env]"));
  assert.deepEqual(lines, ["[addon-env] read of undeclared UNDECLARED_SECRET"]);
  assert.ok(!r.stderr.includes("value-that-must-not-be-printed"), "never a value");
});
test("a third-party add-on (no repo manifest, a community manifest, or a crafted id) declaring gateway keys gets nothing", () => {
  const base = { PATH: "/usr/bin", HOME: "/home/u", MINIO_ACCESS_KEY: "minio-key", BRAVE_API_KEY: "brave", FRIGATE_PASSWORD: "fp" };
  const thirdParty = { server: { envKeys: ["MINIO_ACCESS_KEY", "BRAVE_API_KEY"] }, env_vars: [{ name: "FRIGATE_PASSWORD" }] };
  // Installed-only (no repo copy): the lookup answers null.
  assert.deepEqual(declaredPassthrough("some-store-addon", base, { manifestFor: () => null }), {});
  // A community manifest, even if it were found in the repo.
  assert.deepEqual(declaredPassthrough("some-store-addon", base, { manifestFor: () => ({ ...thirdParty, origin: "community" }) }), {});
  // An id that is not a plain bundle id never reaches the lookup.
  let asked = false;
  assert.deepEqual(declaredPassthrough("../frigate", base, { manifestFor: () => { asked = true; return thirdParty; } }), {});
  assert.equal(asked, false, "a crafted id was looked up");
  // And through addonStdioEnv: an unknown id gets only the base, its config env and the marker.
  const env = addonStdioEnv({ env: { OWN: "1" } }, base, "not-a-repo-bundle-xyz");
  for (const k of ["MINIO_ACCESS_KEY", "BRAVE_API_KEY", "FRIGATE_PASSWORD"]) assert.equal(k in env, false, `${k} leaked`);
  assert.equal(env.OWN, "1");
});
