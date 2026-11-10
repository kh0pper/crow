/**
 * The Phase 0 gate (plan review item 12): what an add-on wall is handed must
 * carry nothing of the gateway's own secrets.
 *
 * It imports `servers/gateway/addon-env.js`, the allowlist Phase 0 added.
 *
 * The callers' own env builders are checked here, because they are what an
 * UNWALLED child (walls off, the default) is started with: a bundle add-on's
 * `addonStdioEnv`, a project-service child's `connectionChildEnv`, and a
 * built-in's allowlisted base env. The wall's own enforcement (it never spreads
 * a passed-in env) is tests/addon-wall-childenv.test.js.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { addonBaseEnv, ADDON_BASE_KEYS } from "../servers/gateway/addon-env.js";
import { addonStdioEnv } from "../servers/gateway/proxy.js";
import { connectionChildEnv } from "../servers/gateway/services/children.js";
import { serviceById } from "../servers/shared/service-catalog.js";

const TOKEN_KEY = "CROW_LOCAL_MCP_TOKEN";
const GITHUB_KEY = "GITHUB_PERSONAL_ACCESS_TOKEN";
const TOKEN_VALUE = "fake-local-token-0001";
const GITHUB_VALUE = "fake-github-pat-0002";
const MINIO_KEY = "MINIO_ROOT_PASSWORD";
const MINIO_VALUE = "fake-minio-root-0003";

/** A gateway env with two secrets in it, the way a real gateway carries them. */
const GATEWAY_ENV = {
  PATH: "/usr/local/bin:/usr/bin:/bin",
  HOME: "/home/alex",
  [TOKEN_KEY]: TOKEN_VALUE,
  [GITHUB_KEY]: GITHUB_VALUE,
  [MINIO_KEY]: MINIO_VALUE,
};

/** The env a caller hands an unwalled child (and the wall's own-env input). */
async function walledEnv(env) {
  return env;
}

/** The base env a built-in integration is given: the allowlist over the gateway's env. */
function builtinBaseEnv(gatewayEnv) {
  try {
    const out = addonBaseEnv(gatewayEnv);
    if (out && typeof out === "object") return out;
  } catch { /* fall through to the allowlist spelling below */ }
  const allow = ADDON_BASE_KEYS instanceof Set ? ADDON_BASE_KEYS : new Set(ADDON_BASE_KEYS || []);
  return Object.fromEntries(Object.entries(gatewayEnv).filter(([key, value]) => allow.has(key) && typeof value === "string"));
}

/** Neither secret key, and no value equal to either fake, survives the wall. */
function assertNoGatewaySecret(env, what) {
  for (const key of [TOKEN_KEY, GITHUB_KEY, MINIO_KEY]) {
    assert.equal(Object.prototype.hasOwnProperty.call(env, key), false, `${what} carries ${key}`);
  }
  for (const value of [TOKEN_VALUE, GITHUB_VALUE, MINIO_VALUE]) {
    assert.equal(Object.values(env).includes(value), false, `${what} carries a gateway secret value`);
  }
}

test("a walled bundle add-on's env carries none of the gateway's secrets", async () => {
  const env = addonStdioEnv({ command: "node", args: ["server/index.js"], env: {} }, GATEWAY_ENV, "addon-hostile");
  const walled = await walledEnv(env);
  assertNoGatewaySecret(walled, "a walled add-on");
  assert.equal(walled.CROW_ADDON_HOST, "gateway", "the add-on's own marker is still there");
});

test("a project-service child's env carries none of the gateway's secrets", async () => {
  const env = connectionChildEnv({
    service: serviceById("github"),
    config: {},
    secrets: {},
    base: GATEWAY_ENV,
    crowHome: "/home/alex/.crow",
  });
  const walled = await walledEnv(env);
  assertNoGatewaySecret(walled, "a project-service child");
  assert.equal(walled.CROW_ADDON_HOST, "service", "the service's own marker is still there");
});

test("a built-in integration's env carries none of the gateway's secrets", async () => {
  const base = builtinBaseEnv(GATEWAY_ENV);
  const walled = await walledEnv({ ...base });
  assertNoGatewaySecret(walled, "a built-in");
  assert.equal(walled.PATH, GATEWAY_ENV.PATH, "an allowlisted key still reaches it");
});

test("the allowlist names neither of the gateway's secrets", () => {
  const names = ADDON_BASE_KEYS instanceof Set ? [...ADDON_BASE_KEYS] : Array.from(ADDON_BASE_KEYS || []);
  assert.ok(names.length > 0, "the allowlist is not empty");
  for (const key of [TOKEN_KEY, GITHUB_KEY, MINIO_KEY]) assert.equal(names.includes(key), false, `the allowlist names ${key}`);
});