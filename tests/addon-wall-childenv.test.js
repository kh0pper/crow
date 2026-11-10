/**
 * The wall builds its child's env itself (defence in depth over the callers'
 * env hygiene): whatever env a spawn site holds — here the whole `process.env`,
 * carrying three gateway secrets — a walled add-on, a walled project-service
 * child and a walled built-in each get only the wall's allowlisted gateway
 * keys, the keys a reviewed repo manifest declares (bundle add-ons only), and
 * their own env.
 *
 * The real wall context and the real `wrapAddonSpawn` run; only the bwrap
 * probe, the plan and the seccomp table are faked, so no sandbox starts.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createWallContext } from "../scripts/addon-sandbox/gateway-wall.mjs";
import { wrapAddonSpawn } from "../scripts/addon-sandbox/spawn.mjs";
import { WALL_BASE_ENV_ALLOW, WALL_ENV_DENY, declaredEnvKeys, wallChildEnv } from "../scripts/addon-sandbox/wall-env.mjs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const T = realpathSync(mkdtempSync(join(tmpdir(), "addon-wall-childenv-")));
after(() => rmSync(T, { recursive: true, force: true }));

const SECRETS = {
  CROW_LOCAL_MCP_TOKEN: "fake-local-token-0101",
  GITHUB_PERSONAL_ACCESS_TOKEN: "fake-github-pat-0102",
  MINIO_ROOT_PASSWORD: "fake-minio-root-0103",
};

const OK_PROBE = { ok: true, pidns: true, bwrap: "/usr/bin/bwrap", setpriv: null, reason: null };
const PLAN = { args: [], env: { HOME: "/home/alex", TMPDIR: "/tmp" }, unsetEnv: [], fds: [], net: { sock: null, ports: [], proxyPort: null }, refused: [] };

/** A wall context over the real checkout's manifests, with no bwrap, docker or tailscale. */
function context() {
  const crowHome = join(T, "home", ".crow");
  const dataDir = join(crowHome, "data");
  mkdirSync(join(dataDir, "github"), { recursive: true, mode: 0o700 });
  return createWallContext({
    crowHome,
    appRoot: REPO,
    dataDir,
    home: join(T, "home"),
    nodeBin: process.execPath,
    gatewayPort: 3001,
    gatewayEnv: {},
    deps: {
      dockerView: { snapshot: async () => ({ publishes: [], containers: [], subnets: [], addonProjects: new Map() }) },
      tailscaleStatus: async () => null,
      interfaces: () => ({}),
      wrapAddonSpawn: (o) => wrapAddonSpawn({
        ...o,
        deps: { probe: () => OK_PROBE, buildPlan: () => PLAN, seccompSupported: () => false },
      }),
    },
  });
}

/** Run `fn` with the three secrets set in the real process.env, then restore it. */
async function withSecretsInProcessEnv(fn) {
  const saved = {};
  for (const [k, v] of Object.entries(SECRETS)) { saved[k] = process.env[k]; process.env[k] = v; }
  try { return await fn(); } finally {
    for (const k of Object.keys(SECRETS)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

function assertNoSecrets(env, what) {
  for (const [k, v] of Object.entries(SECRETS)) {
    assert.equal(Object.prototype.hasOwnProperty.call(env, k), false, `${what} carries ${k}`);
    assert.equal(Object.values(env).includes(v), false, `${what} carries the value of ${k}`);
  }
}

test("every walled spawn kind drops the gateway's secrets even when the caller passes process.env", async () => {
  await withSecretsInProcessEnv(async () => {
    const ctx = context();
    const kinds = [
      { kind: "addon", id: "kiosk", ownEnv: { CROW_ADDON_HOST: "gateway" } },
      { kind: "service", id: "github", ownEnv: { CROW_ADDON_HOST: "service" }, dataSubdir: "services/0a1b2c3d-0000-4000-8000-0000000000aa" },
      { kind: "builtin", id: "brave-search", ownEnv: { BRAVE_API_KEY: "fake-brave-0104" } },
    ];
    for (const k of kinds) {
      const wall = await ctx.startAddonWall({
        id: k.id, entry: {}, command: process.execPath, args: [],
        baseEnv: process.env, ownEnv: k.ownEnv, kind: k.kind, dataSubdir: k.dataSubdir,
      });
      assert.equal(wall.walled, true, k.kind);
      assertNoSecrets(wall.env, "a walled " + k.kind);
      assert.equal(wall.env.PATH, process.env.PATH, k.kind + ": an allowlisted gateway key still reaches it");
      for (const [key, value] of Object.entries(k.ownEnv)) assert.equal(wall.env[key], value, k.kind + ": its own " + key);
      // A service child and a built-in get nothing of the gateway env beyond the
      // allowlist (no declared keys for them); the plan's own env is the wall's.
      if (k.kind !== "addon") {
        for (const key of Object.keys(wall.env)) {
          assert.ok(WALL_BASE_ENV_ALLOW.includes(key) || key in k.ownEnv || key in PLAN.env, `${k.kind}: unexpected key ${key}`);
        }
      }
    }
  });
});

test("a project-service child never gets the gateway's own token for its service, even though the manifest declares it", async () => {
  await withSecretsInProcessEnv(async () => {
    const ctx = context();
    const wall = await ctx.startAddonWall({
      id: "github", entry: {}, command: process.execPath, args: [],
      baseEnv: process.env, ownEnv: { CROW_ADDON_HOST: "service" }, kind: "service",
      dataSubdir: "services/0a1b2c3d-0000-4000-8000-0000000000bb",
    });
    assert.equal("GITHUB_PERSONAL_ACCESS_TOKEN" in wall.env, false);
  });
});

test("wallChildEnv: the deny list wins over a declaration; an add-on's own value is its own", () => {
  const base = { PATH: "/usr/bin", FRIGATE_PASSWORD: "fake-frigate-0105", ...SECRETS, RANDOM_GATEWAY_KEY: "x" };
  const env = wallChildEnv({ baseEnv: base, ownEnv: { OWN: "1" }, declaredKeys: ["FRIGATE_PASSWORD", "CROW_LOCAL_MCP_TOKEN", "MINIO_ROOT_PASSWORD", "bad-name"] });
  assert.deepEqual(env, { PATH: "/usr/bin", FRIGATE_PASSWORD: "fake-frigate-0105", OWN: "1" });
  for (const k of ["CROW_LOCAL_MCP_TOKEN", "MINIO_ROOT_PASSWORD"]) assert.ok(WALL_ENV_DENY.includes(k));
  for (const k of Object.keys(SECRETS)) assert.equal(WALL_BASE_ENV_ALLOW.includes(k), false);
});

test("declaredEnvKeys: only a repo-sourced manifest declares anything", () => {
  const m = { server: { envKeys: ["A_KEY"] }, env_vars: [{ name: "B_KEY" }, { name: "not ok" }] };
  assert.deepEqual(declaredEnvKeys(m, "repo"), ["A_KEY", "B_KEY"]);
  assert.deepEqual(declaredEnvKeys(m, "installed"), []);
});
