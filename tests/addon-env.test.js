/**
 * The environment an add-on's stdio child starts with: the allowlisted base, the
 * keys its registry entry declares, the storage env the four storage-reading
 * bundles keep, and its own config env — never the gateway's whole environment.
 * Also the dev/test read logger.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ADDON_BASE_KEYS, ADDON_DENY_KEYS, STORAGE_ENV_CONSUMERS, STORAGE_ENV_KEYS,
  addonBaseEnv, declaredEnvKeys, declaredPassthrough, isDeniedAddonKey, isStorageEnvConsumer,
  registryEntryFor, storagePassthrough,
} from "../servers/gateway/addon-env.js";
import { _setAppBundlesForTest, getManifest } from "../servers/gateway/bundles-config.js";
import { addonOwnEnv, addonStdioEnv, integrationChildEnv } from "../servers/gateway/proxy.js";
import { _resetCredentialKeysForTest, applyCredentialFiles } from "../servers/shared/credentials-env.js";

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
  S3_ENDPOINT: "s3.internal:3900",
  S3_ACCESS_KEY: "s3-access-placeholder",
  S3_SECRET_KEY: "s3-secret-placeholder",
  S3_USE_SSL: "false",
  S3_REGION: "us-east-1",
  MINIO_ENDPOINT: "minio.internal",
  MINIO_PORT: "9000",
  MINIO_USE_SSL: "false",
  VAPID_PRIVATE_KEY: "vapid-placeholder",
  CROW_OAUTH_CLIENT_SECRET: "oauth-placeholder",
  GOOGLE_CLIENT_SECRET: "google-placeholder",
  CLOUDFLARE_TUNNEL_TOKEN: "tunnel-placeholder",
  NTFY_AUTH_TOKEN: "ntfy-placeholder",
  CROW_BACKUP_TOKEN: "backup-placeholder",
  CROW_SETUP_TOKEN: "setup-placeholder",
  CROW_ENROLL_OTC: "enroll-placeholder",
  CROW_PEER_TOKENS_PATH: "/home/someone/.crow/peer-tokens.json",
  CREDENTIALS_DIRECTORY: "/run/credentials/crow-gateway.service",
  TURN_SECRET: "turn-placeholder",
};

/** A scratch dir that is removed when the test ends. */
function scratchDir(t, prefix = "crow-addon-env-") {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("the base is the allowlist: system basics, Crow instance keys, and nothing else", () => {
  const base = addonBaseEnv(GATEWAY_ENV);
  for (const key of ADDON_BASE_KEYS) assert.equal(base[key], GATEWAY_ENV[key], key);
  assert.equal(base.PATH, GATEWAY_ENV.PATH);
  assert.equal(base.HOME, GATEWAY_ENV.HOME);
  assert.equal(base.LANG, GATEWAY_ENV.LANG);
  assert.equal(base.NODE_ENV, "production");
  for (const key of ADDON_DENY_KEYS) assert.equal(base[key], undefined, key + " is not in the base");
  for (const key of ["BRAVE_API_KEY", "FRIGATE_PASSWORD", "FOO_TOKEN", "SOME_DB_ROOT_PASSWORD", "RANDOM_SETTING", "S3_SECRET_KEY", "MINIO_ROOT_PASSWORD"]) {
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

test("an add-on with no registry entry gets the base, its config env and the host marker — nothing else", () => {
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
  assert.equal(registryEntryFor(null), null);
  assert.equal(registryEntryFor("../frigate"), null);
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

test("an installed copy's manifest never widens what a child receives, and a checkout folder alone does not either", (t) => {
  const id = "zz-installed-only-manifest-probe";
  const scratch = scratchDir(t);
  const repoBundles = join(scratch, "repo-bundles");
  const home = join(scratch, "home");
  mkdirSync(join(repoBundles), { recursive: true });
  const restore = () => _setAppBundlesForTest(join(ROOT, "bundles"));
  t.after(restore);
  _setAppBundlesForTest(repoBundles);
  assert.equal(getManifest(id), null, "no repo manifest for this id");
  // The installed copy under CROW_HOME, which the bundle's own container can write.
  const installedDir = join(home, "bundles", id);
  mkdirSync(installedDir, { recursive: true });
  const manifest = {
    id, version: "1.0.0", type: "mcp-server",
    server: { command: "node", args: ["server/index.js"], envKeys: ["GITHUB_PERSONAL_ACCESS_TOKEN", "BRAVE_API_KEY", "MINIO_ROOT_PASSWORD"] },
  };
  writeFileSync(join(installedDir, "manifest.json"), JSON.stringify(manifest));
  assert.deepEqual(declaredPassthrough(id, GATEWAY_ENV), {}, "the installed copy is not read");
  const env = addonStdioEnv({}, GATEWAY_ENV, id);
  assert.equal(env.GITHUB_PERSONAL_ACCESS_TOKEN, undefined);
  assert.equal(env.BRAVE_API_KEY, undefined);
  assert.equal(env.MINIO_ROOT_PASSWORD, undefined);
  // And a manifest dropped into the checkout's bundles/ folder is not reviewed either: only the
  // tracked registry counts, so an untracked folder or a symlinked one gets nothing.
  mkdirSync(join(repoBundles, id), { recursive: true });
  writeFileSync(join(repoBundles, id, "manifest.json"), JSON.stringify(manifest));
  assert.deepEqual(getManifest(id)?.id, id, "getManifest does read a checkout folder");
  assert.deepEqual(declaredPassthrough(id, GATEWAY_ENV), {}, "an unpublished folder declares nothing");
  assert.equal(addonStdioEnv({}, GATEWAY_ENV, id).BRAVE_API_KEY, undefined);
});

test("the passthrough reads the registry entry, not the checkout's manifest", () => {
  const id = "frigate";
  const checkout = getManifest(id);
  assert.ok(checkout, "frigate has a repo manifest");
  // The reviewed entry is the only source: a fake entry's envKeys are what the passthrough follows.
  const entry = { id, server: { envKeys: ["BRAVE_API_KEY"] }, env_vars: [] };
  assert.deepEqual(declaredPassthrough(id, GATEWAY_ENV, { registryFor: () => entry }),
    { BRAVE_API_KEY: GATEWAY_ENV.BRAVE_API_KEY });
  // A registry that does not have the id -> no passthrough, even though the checkout has a manifest.
  assert.deepEqual(declaredPassthrough(id, GATEWAY_ENV, { registryFor: () => null }), {});
  // A community listing is not first-party, whatever the checkout holds.
  assert.deepEqual(declaredPassthrough(id, GATEWAY_ENV, { registryFor: () => ({ ...entry, origin: "community" }) }), {});
  // A crafted id never reaches the lookup at all.
  let asked = false;
  assert.deepEqual(declaredPassthrough("../frigate", GATEWAY_ENV, { registryFor: () => { asked = true; return entry; } }), {});
  assert.equal(asked, false, "a crafted id was looked up");
});

test("a registry entry naming a deny-listed key it does not own gets nothing", () => {
  const entry = { server: { envKeys: ["GITHUB_PERSONAL_ACCESS_TOKEN", "GITHUB_TOKEN", "SOME_DB_ROOT_PASSWORD", "BRAVE_API_KEY"] } };
  assert.deepEqual(declaredPassthrough("acme", GATEWAY_ENV, { registryFor: () => entry }),
    { BRAVE_API_KEY: GATEWAY_ENV.BRAVE_API_KEY }, "only the key that is not the gateway's own");
});

test("no deny-listed key reaches any add-on, even when its registry entry declares it", () => {
  const everything = { server: { envKeys: [...ADDON_DENY_KEYS, "SOME_DB_ROOT_PASSWORD"] }, env_vars: [] };
  for (const id of ["minio", "phone", "browser", "acme", ...STORAGE_ENV_CONSUMERS]) {
    assert.deepEqual(declaredPassthrough(id, GATEWAY_ENV, { registryFor: () => everything }), {},
      `${id}: the gateway's own secret was handed over`);
  }
  // The deny list has no owner exception: minio/phone/browser keep their own credentials through
  // their mcp-addons entry, never through the gateway's environment.
  for (const key of ["MINIO_ROOT_USER", "MINIO_ROOT_PASSWORD", "PHONE_RUNNER_SECRET", "CROW_BROWSER_VNC_PASSWORD"]) {
    assert.equal(isDeniedAddonKey(key), true, key);
  }
  assert.equal(isDeniedAddonKey("SOME_DB_ROOT_PASSWORD"), true);
  assert.equal(isDeniedAddonKey("CREDENTIALS_DIRECTORY"), true);
  // ...while an entry's own env still carries that bundle's value (item 5 of the docs' list).
  const minio = addonStdioEnv({ env: { MINIO_ROOT_PASSWORD: "own-value" } }, GATEWAY_ENV, "minio");
  assert.equal(minio.MINIO_ROOT_PASSWORD, "own-value", "the entry's own value, not the gateway's");
});

test("the four storage-reading bundles keep the storage env their s3-client reads, and nobody else gets it", () => {
  assert.deepEqual([...STORAGE_ENV_CONSUMERS].sort(), ["artifacts", "data-dashboard", "studio", "sunvox-studio"]);
  for (const id of STORAGE_ENV_CONSUMERS) {
    assert.equal(isStorageEnvConsumer(id), true, id);
    const env = addonStdioEnv({}, GATEWAY_ENV, id);
    for (const key of STORAGE_ENV_KEYS) assert.equal(env[key], GATEWAY_ENV[key], `${id}: ${key}`);
    // Including the deny-listed ones: they are this client's own credentials.
    assert.equal(env.MINIO_ROOT_PASSWORD, GATEWAY_ENV.MINIO_ROOT_PASSWORD, id);
    assert.equal(env.S3_SECRET_KEY, GATEWAY_ENV.S3_SECRET_KEY, id);
  }
  assert.equal(isStorageEnvConsumer("frigate"), false);
  assert.deepEqual(storagePassthrough("frigate", GATEWAY_ENV), {});
  // A bundle that is not a consumer gets nothing by declaring a storage key it does not use.
  const declares = { server: { envKeys: ["MINIO_ROOT_PASSWORD", "S3_SECRET_KEY", "BRAVE_API_KEY"] }, env_vars: [] };
  const other = addonStdioEnv({}, GATEWAY_ENV, "acme");
  assert.equal(other.MINIO_ROOT_PASSWORD, undefined);
  assert.equal(other.S3_SECRET_KEY, undefined);
  assert.deepEqual(declaredPassthrough("acme", GATEWAY_ENV, { registryFor: () => declares }),
    { BRAVE_API_KEY: GATEWAY_ENV.BRAVE_API_KEY }, "the deny list still wins for a non-consumer");
});

test("a key applied from systemd credentials is never in the passthrough", (t) => {
  const scratch = scratchDir(t, "crow-addon-cred-");
  const creds = join(scratch, "creds");
  mkdirSync(creds, { recursive: true });
  writeFileSync(join(creds, "FRIGATE_PASSWORD"), "from-credential\n", { mode: 0o600 });
  const quiet = { log() {}, warn() {}, error() {} };
  t.after(() => { delete process.env.FRIGATE_PASSWORD; _resetCredentialKeysForTest(); });
  applyCredentialFiles(process.env, { dir: creds, roots: [scratch], log: quiet });
  process.env.FRIGATE_PASSWORD = "applied-from-credential";
  // A base that still carries the name is the hostile case: the name was applied from a
  // credential, so the gateway hands it to nobody even when its own env has a value.
  const base = { ...GATEWAY_ENV, FRIGATE_PASSWORD: "applied-from-credential" };
  const out = addonStdioEnv({}, base, "frigate");
  assert.equal(out.FRIGATE_USER, GATEWAY_ENV.FRIGATE_USER, "an ordinary declared key still passes");
  assert.equal(out.FRIGATE_PASSWORD, undefined, "a credential-applied key is not the gateway's to give");
  assert.equal(out.CREDENTIALS_DIRECTORY, undefined, "and the credentials folder is never named");
  // The storage passthrough is guarded the same way.
  const storage = addonStdioEnv({}, base, "studio");
  assert.equal(storage.S3_SECRET_KEY, GATEWAY_ENV.S3_SECRET_KEY);
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

test("env_vars that are the installer's (propagate: false, or a generate kind) are not declared env", () => {
  const entry = {
    env_vars: [
      { name: "CROW_BROWSER_VNC_TOKEN", generate: "hex32", propagate: false },
      { name: "CROW_BROWSER_CDP_TOKEN", generate: "hex32", propagate: false },
      { name: "CROW_BROWSER_CDP_PORT", default: "9222" },
      { name: "CROW_BROWSER_DISPLAY", default: "99" },
      { name: "PHONE_RUNNER_SECRET", generate: "secret", propagate: true },
      { name: "KEPT_ONE" },
    ],
    server: { envKeys: ["CROW_BROWSER_CDP_PORT"] },
  };
  assert.deepEqual(declaredEnvKeys(entry), ["CROW_BROWSER_CDP_PORT", "CROW_BROWSER_DISPLAY", "KEPT_ONE"]);
  // The real browser entry: its two minted tokens are its own, not env a child gets.
  const browser = registryEntryFor("browser");
  const declared = declaredEnvKeys(browser);
  assert.ok(declared.includes("CROW_BROWSER_CDP_PORT"), "an ordinary setting is still declared");
  for (const key of ["CROW_BROWSER_VNC_TOKEN", "CROW_BROWSER_CDP_TOKEN"]) {
    assert.equal(declared.includes(key), false, key + " is never meant for the server");
  }
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
test("an entry's own loader names are stripped at spawn, and its ordinary keys are not", () => {
  // A manifest-declared loader name would run code before the add-on's server itself.
  const entry = {
    command: "node", args: ["server/index.js"],
    env: {
      LD_PRELOAD: "/x.so", DYLD_INSERT_LIBRARIES: "/x.dylib", NODE_OPTIONS: "--require /x.js",
      NODE_PATH: "/x/node_modules", PYTHONSTARTUP: "/x.py", BASH_ENV: "/x.sh", FOO: "bar",
    },
  };
  for (const [name, env] of [
    ["addonStdioEnv", addonStdioEnv(entry, GATEWAY_ENV, null)],
    ["addonOwnEnv", addonOwnEnv(entry, GATEWAY_ENV, null)],
  ]) {
    assert.equal(env.FOO, "bar", `${name}: an ordinary entry key still reaches the child`);
    for (const key of ["LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "NODE_OPTIONS", "NODE_PATH", "PYTHONSTARTUP", "BASH_ENV"]) {
      assert.equal(env[key], undefined, `${name}: the entry's ${key} reached the child`);
    }
    assert.equal(env.CROW_ADDON_HOST, "gateway", name);
  }
  // The base is a different story and this change does not touch it: addonBaseEnv is an allowlist
  // that never carries NODE_OPTIONS, so there is nothing to strip from it and nothing to assert.
  assert.equal(addonBaseEnv({ ...GATEWAY_ENV, NODE_OPTIONS: "--max-old-space-size=4096" }).NODE_OPTIONS, undefined,
    "the base allowlist does not carry NODE_OPTIONS");
  // A missing/non-object entry env is still no environment, not an unstripped one.
  assert.equal(addonStdioEnv({ env: null }, GATEWAY_ENV, null).LD_PRELOAD, undefined);
  assert.equal(addonOwnEnv({ env: null }, GATEWAY_ENV, null).LD_PRELOAD, undefined);
});

test("storage env goes only to the published first-party bundle under a consumer id", () => {
  const base = { MINIO_ROOT_PASSWORD: "root", S3_SECRET_KEY: "s3" };
  assert.deepEqual(storagePassthrough("studio", base, { registryFor: () => null }), {}, "unlisted id got storage keys");
  assert.deepEqual(storagePassthrough("studio", base, { registryFor: () => ({ id: "studio", origin: "community" }) }), {}, "community listing got storage keys");
  assert.equal(storagePassthrough("studio", base, { registryFor: () => ({ id: "studio" }) }).MINIO_ROOT_PASSWORD, "root");
});
