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
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createWallContext } from "../scripts/addon-sandbox/gateway-wall.mjs";
import { wrapAddonSpawn } from "../scripts/addon-sandbox/spawn.mjs";
import { applyCredentialFiles, _resetCredentialKeysForTest } from "../servers/shared/credentials-env.js";
import { wallChildEnv, wallResiduals, STORAGE_RESIDUAL } from "../scripts/addon-sandbox/wall-env.mjs";
import { addonBaseEnv, isDeniedAddonKey } from "../servers/gateway/addon-env.js";

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
    const BASE_KEYS = addonBaseEnv(process.env);
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
          assert.ok(key in BASE_KEYS || key in k.ownEnv || key in PLAN.env, `${k.kind}: unexpected key ${key}`);
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

const FIRST_PARTY = (id) => (id === "frigate" ? { id, origin: "first-party", server: { envKeys: ["FRIGATE_PASSWORD", "CROW_LOCAL_MCP_TOKEN"] }, env_vars: [] } : null);

test("wallChildEnv: a registry-declared key passes for a bundle add-on, a deny-listed one never does", () => {
  const base = { PATH: "/usr/bin", FRIGATE_PASSWORD: "fake-frigate-0105", ...SECRETS, RANDOM_GATEWAY_KEY: "x" };
  const env = wallChildEnv({ id: "frigate", kind: "addon", baseEnv: base, ownEnv: { OWN: "1" }, credentialKeys: [], registryFor: FIRST_PARTY });
  assert.equal(env.FRIGATE_PASSWORD, "fake-frigate-0105");
  assert.equal(env.OWN, "1");
  assert.equal(env.PATH, "/usr/bin");
  assert.equal("RANDOM_GATEWAY_KEY" in env, false);
  assert.ok(isDeniedAddonKey("CROW_LOCAL_MCP_TOKEN"));
  assertNoSecrets(env, "a declared-key add-on");
});

test("wallChildEnv: a service child or a built-in never takes a declared key from the gateway env", () => {
  const base = { PATH: "/usr/bin", FRIGATE_PASSWORD: "fake-frigate-0111" };
  for (const kind of ["service", "builtin"]) {
    const env = wallChildEnv({ id: "frigate", kind, baseEnv: base, credentialKeys: [], registryFor: FIRST_PARTY });
    assert.equal("FRIGATE_PASSWORD" in env, false, kind);
  }
});

test("a key the gateway took from systemd credentials is never passed, even declared; CREDENTIALS_DIRECTORY never is", () => {
  const root = join(T, "run-credentials");
  const dir = join(root, "crow-gateway.service");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "FRIGATE_PASSWORD"), "fake-cred-frigate-0106\n", { mode: 0o600 });
  // Names are recorded only when applied to the real process env (as the gateway does).
  const saved = { FRIGATE_PASSWORD: process.env.FRIGATE_PASSWORD, CREDENTIALS_DIRECTORY: process.env.CREDENTIALS_DIRECTORY };
  delete process.env.FRIGATE_PASSWORD;
  process.env.CREDENTIALS_DIRECTORY = dir;
  _resetCredentialKeysForTest();
  try {
    const r = applyCredentialFiles(process.env, { dir, roots: [root], log: { warn() {}, log() {} } });
    assert.deepEqual(r.applied, ["FRIGATE_PASSWORD"]);
    const env = wallChildEnv({ id: "frigate", kind: "addon", baseEnv: process.env, ownEnv: { CREDENTIALS_DIRECTORY: "/x" }, registryFor: FIRST_PARTY });
    assert.equal("FRIGATE_PASSWORD" in env, false, "a credential-applied key stays in the gateway");
    assert.equal(Object.values(env).includes("fake-cred-frigate-0106"), false);
    assert.equal("CREDENTIALS_DIRECTORY" in env, false, "the credentials path never reaches the child, not even from its own env");
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    _resetCredentialKeysForTest();
  }
});

test("through the wall context: a third-party add-on declaring FRIGATE_PASSWORD gets nothing; first-party frigate gets its own", async () => {
  const saved = process.env.FRIGATE_PASSWORD;
  process.env.FRIGATE_PASSWORD = "fake-frigate-0108";
  try {
    const ctx = context();
    const crowHome = join(T, "home", ".crow");
    const inst = join(crowHome, "bundles", "acme-cam");
    mkdirSync(join(inst, "server"), { recursive: true });
    writeFileSync(join(inst, "manifest.json"), JSON.stringify({
      id: "acme-cam", name: "Acme cam", version: "1.0.0", type: "mcp-server",
      server: { command: "node", args: ["server/index.js"], envKeys: ["FRIGATE_PASSWORD"] },
      env_vars: [{ name: "FRIGATE_PASSWORD", description: "x" }],
    }));
    mkdirSync(join(crowHome, "data", "acme-cam"), { recursive: true, mode: 0o700 });
    const third = await ctx.startAddonWall({ id: "acme-cam", entry: {}, command: process.execPath, args: [], baseEnv: process.env, ownEnv: {}, kind: "addon" });
    assert.equal("FRIGATE_PASSWORD" in third.env, false, "an unpublished manifest declares nothing");

    mkdirSync(join(crowHome, "data", "frigate"), { recursive: true, mode: 0o700 });
    const first = await ctx.startAddonWall({ id: "frigate", entry: {}, command: process.execPath, args: [], baseEnv: process.env, ownEnv: {}, kind: "addon" });
    assert.equal(first.env.FRIGATE_PASSWORD, "fake-frigate-0108", "the published registry entry's own key reaches it");
  } finally {
    if (saved === undefined) delete process.env.FRIGATE_PASSWORD; else process.env.FRIGATE_PASSWORD = saved;
  }
});

const STORAGE_BASE = { PATH: "/usr/bin", S3_ENDPOINT: "http://127.0.0.1:9000", S3_ACCESS_KEY: "fake-s3-ak-0120", S3_SECRET_KEY: "fake-s3-sk-0121", MINIO_ROOT_USER: "fake-root-0122", MINIO_ROOT_PASSWORD: "fake-root-pw-0123" };
const PUBLISHED = (id) => ({ id, origin: "first-party", server: {}, env_vars: [] });

test("a walled add-on that is not a storage consumer gets no storage keys", () => {
  for (const id of ["kiosk", "paperless", "acme-cam"]) {
    const env = wallChildEnv({ id, kind: "addon", baseEnv: STORAGE_BASE, credentialKeys: [], registryFor: PUBLISHED });
    for (const k of ["S3_ENDPOINT", "S3_ACCESS_KEY", "S3_SECRET_KEY", "MINIO_ROOT_USER", "MINIO_ROOT_PASSWORD"]) {
      assert.equal(k in env, false, `${id} got ${k}`);
    }
    assert.deepEqual(wallResiduals({ id, kind: "addon" }), [], id);
  }
});

test("a storage consumer keeps the storage env (N1b-13) and is marked with the storage residual", () => {
  const env = wallChildEnv({ id: "studio", kind: "addon", baseEnv: STORAGE_BASE, credentialKeys: [], registryFor: PUBLISHED });
  assert.equal(env.S3_SECRET_KEY, "fake-s3-sk-0121", "Phase 0's accepted residual, unchanged inside the wall");
  assert.deepEqual(wallResiduals({ id: "studio", kind: "addon" }), [{ kind: "storage", label: "can use all of Crow's storage" }]);
  assert.equal(STORAGE_RESIDUAL.label, "can use all of Crow's storage");
  // A service child or a built-in of the same id takes no storage env and carries no residual.
  for (const kind of ["service", "builtin"]) {
    assert.equal("S3_SECRET_KEY" in wallChildEnv({ id: "studio", kind, baseEnv: STORAGE_BASE, credentialKeys: [], registryFor: PUBLISHED }), false, kind);
    assert.deepEqual(wallResiduals({ id: "studio", kind }), [], kind);
  }
});

test("through the wall context, a walled storage consumer's result carries the storage residual and a non-consumer's does not", async () => {
  const ctx = context();
  const crowHome = join(T, "home", ".crow");
  mkdirSync(join(crowHome, "data", "studio"), { recursive: true, mode: 0o700 });
  const studio = await ctx.startAddonWall({ id: "studio", entry: {}, command: process.execPath, args: [], baseEnv: {}, ownEnv: {}, kind: "addon" });
  assert.deepEqual(studio.residuals, [{ kind: "storage", label: "can use all of Crow's storage" }]);
  const kiosk = await ctx.startAddonWall({ id: "kiosk", entry: {}, command: process.execPath, args: [], baseEnv: {}, ownEnv: {}, kind: "addon" });
  assert.deepEqual(kiosk.residuals, []);
});
