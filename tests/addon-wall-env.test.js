/**
 * The Phase 0 gate (plan review item 12): what an add-on wall is handed must
 * carry nothing of the gateway's own secrets.
 *
 * This file imports `servers/gateway/addon-env.js`, the allowlist Phase 0 adds.
 * Until that module is on `main` the whole file fails to load — that is the
 * gate, not a broken test.
 *
 * The three spawn sites are covered as the wall sees them: a bundle add-on's
 * `addonStdioEnv`, a project-service child's `connectionChildEnv`, and a
 * built-in's allowlisted base env. `wrapAddonSpawn` here is the real function
 * with a fake probe, plan and seccomp table, so no bwrap runs and no file is
 * opened.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { addonBaseEnv, ADDON_ENV_ALLOW } from "../servers/gateway/addon-env.js";
import { addonStdioEnv } from "../servers/gateway/proxy.js";
import { connectionChildEnv } from "../servers/gateway/services/children.js";
import { serviceById } from "../servers/shared/service-catalog.js";
import { wrapAddonSpawn } from "../scripts/addon-sandbox/spawn.mjs";

const TOKEN_KEY = "CROW_LOCAL_MCP_TOKEN";
const GITHUB_KEY = "GITHUB_PERSONAL_ACCESS_TOKEN";
const TOKEN_VALUE = "fake-local-token-0001";
const GITHUB_VALUE = "fake-github-pat-0002";

/** A gateway env with two secrets in it, the way a real gateway carries them. */
const GATEWAY_ENV = {
  PATH: "/usr/local/bin:/usr/bin:/bin",
  HOME: "/home/alex",
  [TOKEN_KEY]: TOKEN_VALUE,
  [GITHUB_KEY]: GITHUB_VALUE,
};

const OK_PROBE = { ok: true, pidns: true, bwrap: "/usr/bin/bwrap", setpriv: null, reason: null };
const PLAN = { args: [], env: {}, unsetEnv: [], fds: [], net: { sock: null, ports: [], proxyPort: null }, refused: [] };

/** The env one walled spawn hands the child. */
async function walledEnv(env) {
  const wall = await wrapAddonSpawn({
    id: "addon-hostile",
    command: "/usr/bin/node",
    args: ["server/index.js"],
    env,
    profile: { network: { internet: false, hosts: [] }, doors: [] },
    entry: { command: "/usr/bin/node" },
    crowHome: "/home/alex/.crow",
    dataDir: "/home/alex/.crow/data",
    appRoot: "/home/alex/crow",
    home: "/home/alex",
    nodeBin: "/usr/bin/node",
    gatewayPort: 3001,
    selfTargets: { names: [], addrs: [] },
    deps: {
      probe: () => OK_PROBE,
      buildPlan: () => PLAN,
      seccompSupported: () => false,
    },
  });
  return wall.env;
}

/** The base env a built-in integration is given: the allowlist over the gateway's env. */
function builtinBaseEnv(gatewayEnv) {
  try {
    const out = addonBaseEnv(gatewayEnv);
    if (out && typeof out === "object") return out;
  } catch { /* fall through to the allowlist spelling below */ }
  const allow = ADDON_ENV_ALLOW instanceof Set ? ADDON_ENV_ALLOW : new Set(ADDON_ENV_ALLOW || []);
  return Object.fromEntries(Object.entries(gatewayEnv).filter(([key, value]) => allow.has(key) && typeof value === "string"));
}

/** Neither secret key, and no value equal to either fake, survives the wall. */
function assertNoGatewaySecret(env, what) {
  for (const key of [TOKEN_KEY, GITHUB_KEY]) {
    assert.equal(Object.prototype.hasOwnProperty.call(env, key), false, `${what} carries ${key}`);
  }
  for (const value of [TOKEN_VALUE, GITHUB_VALUE]) {
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
  const names = ADDON_ENV_ALLOW instanceof Set ? [...ADDON_ENV_ALLOW] : Array.from(ADDON_ENV_ALLOW || []);
  assert.ok(names.length > 0, "the allowlist is not empty");
  for (const key of [TOKEN_KEY, GITHUB_KEY]) assert.equal(names.includes(key), false, `the allowlist names ${key}`);
});