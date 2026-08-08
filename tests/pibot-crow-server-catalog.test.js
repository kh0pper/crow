import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INSTANCE_ENV_KEYS,
  instanceBinding,
  rebindBlock,
  crowServerCatalog,
} from "../scripts/pi-bots/crow-server-catalog.mjs";

/** An instance home with a tasks bundle dir and an mcp-addons.json. */
function instanceB() {
  const dir = mkdtempSync(join(tmpdir(), "instB-"));
  const home = join(dir, ".crow-b");
  mkdirSync(join(home, "bundles", "tasks"), { recursive: true });
  mkdirSync(join(home, "data"), { recursive: true });
  writeFileSync(join(home, "mcp-addons.json"), JSON.stringify({
    tasks: { command: "node", args: ["server/index.js"], env: { CROW_TASKS_DB_PATH: "/wrong/tasks.db" } },
    ghost: { command: "node", args: ["server/index.js"] },
  }));
  return { dir, home };
}

const BINDING_B = (home) => ({
  CROW_HOME: home,
  CROW_DATA_DIR: join(home, "data"),
  CROW_DB_PATH: join(home, "data", "crow.db"),
  CROW_TASKS_DB_PATH: join(home, "data", "tasks.db"),
});

test("INSTANCE_ENV_KEYS is exactly the four instance-scoped vars", () => {
  assert.deepEqual([...INSTANCE_ENV_KEYS].sort(),
    ["CROW_DATA_DIR", "CROW_DB_PATH", "CROW_HOME", "CROW_TASKS_DB_PATH"]);
});

test("instanceBinding normalizes a file: tasks URI", () => {
  const b = instanceBinding("/home/x/.crow-r4", { tasksDbPath: "file:/home/x/.crow-r4/data/tasks.db" });
  assert.equal(b.CROW_TASKS_DB_PATH, "/home/x/.crow-r4/data/tasks.db");
});

test("rebindBlock rewrites every instance-scoped env key", () => {
  const { home } = instanceB();
  const block = { command: "n", args: ["a.js"], cwd: "/repo",
    env: { CROW_DB_PATH: "/home/x/.crow-mpa/data/crow.db", UNRELATED: "keep" } };
  const r = rebindBlock("crow-memory", block, BINDING_B(home), home);
  assert.equal(r.env, undefined, "returns a wrapper, not a bare block");
  assert.equal(r.block.env.CROW_DB_PATH, join(home, "data", "crow.db"));
  assert.equal(r.block.env.UNRELATED, "keep");
  assert.equal(r.block.env.CROW_JOURNAL_MODE, "DELETE", "WAL scar guard applied");
  assert.deepEqual(r.rebound, ["CROW_DB_PATH"]);
});

test("rebindBlock retargets a cross-instance bundle cwd that exists here", () => {
  const { home } = instanceB();
  const block = { command: "n", args: ["server/index.js"], cwd: "/home/x/.crow-mpa/bundles/tasks", env: {} };
  const r = rebindBlock("crow-tasks", block, BINDING_B(home), home);
  assert.equal(r.block.cwd, join(home, "bundles", "tasks"));
  assert.ok(r.rebound.includes("cwd"));
});

test("rebindBlock disables a bundle absent on this instance, with a reason", () => {
  const { home } = instanceB();
  const block = { command: "n", args: ["server/index.js"], cwd: "/home/x/.crow-mpa/bundles/rookery", env: {} };
  const r = rebindBlock("crow-rookery", block, BINDING_B(home), home);
  assert.equal(r.disabled, true);
  assert.match(r.reason, /rookery/);
  assert.match(r.reason, /not installed/);
});

test("rebindBlock leaves the repo cwd alone — the repo is instance-neutral", () => {
  const { home } = instanceB();
  const block = { command: "n", args: ["x.js"], cwd: "/home/kh0pp/crow/bundles/browser", env: {} };
  const r = rebindBlock("crow-browser", block, BINDING_B(home), home);
  assert.equal(r.block.cwd, "/home/kh0pp/crow/bundles/browser");
  assert.deepEqual(r.rebound, []);
});

test("rebindBlock strips optIn — selection is the opt-in", () => {
  const { home } = instanceB();
  const r = rebindBlock("gws", { command: "n", args: [], optIn: true, env: {} }, BINDING_B(home), home);
  assert.ok(!("optIn" in r.block));
});

test("catalog binds core servers to this instance and serves them from the repo", () => {
  const { home } = instanceB();
  const { servers } = crowServerCatalog(home, { binding: BINDING_B(home) });
  const mem = servers["crow-memory"];
  assert.ok(mem, "crow-memory catalogued");
  assert.equal(mem.env.CROW_DB_PATH, join(home, "data", "crow.db"));
  assert.equal(mem.env.CROW_JOURNAL_MODE, "DELETE");
  assert.match(mem.cwd, /crow$/, "core servers run from the repo root");
});

test("catalog binds bundle servers from this instance's mcp-addons.json", () => {
  const { home } = instanceB();
  const { servers } = crowServerCatalog(home, { binding: BINDING_B(home) });
  assert.equal(servers.tasks.cwd, join(home, "bundles", "tasks"), "cwd defaulted under this instance");
  assert.equal(servers.tasks.env.CROW_TASKS_DB_PATH, join(home, "data", "tasks.db"),
    "the addon's own wrong path is rebound, not trusted");
});

test("catalog reports an addon whose bundle dir is missing as unconfigured", () => {
  const { home } = instanceB();
  const { servers, unconfigured } = crowServerCatalog(home, { binding: BINDING_B(home) });
  assert.ok(!servers.ghost, "ghost is not offered as spawnable");
  assert.match(unconfigured.ghost, /not installed/);
});

test("crow-storage is catalogued as unconfigured when MinIO env is absent", () => {
  const { home } = instanceB();
  const { servers, unconfigured } = crowServerCatalog(home, { binding: BINDING_B(home) });
  assert.ok(!servers["crow-storage"], "not offered as spawnable without MinIO settings");
  assert.match(unconfigured["crow-storage"], /MINIO_ENDPOINT/);
});
