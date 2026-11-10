/**
 * Project-service children through the wall (servers/gateway/services/children.js,
 * plan review item 1). A scratch Crow home and data dir (init-db), a real
 * connection whose installed add-on entry runs the hostile fixture, and the
 * wall seams `_setChildrenForTest({ wall: { mode, start } })`.
 *
 * The wall itself is a seam here; what the tests judge is the wiring: the mode
 * is asked once per start, a walled start hands the wrapper the service's own
 * `services/<uuid>` folder and runs its command line (not the raw entry), a
 * refused wall leaves the child unstarted in the existing failure state, and an
 * unwalled start is the spawn it was before.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rmScratch } from "./helpers/safe-rm.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(REPO, "tests", "fixtures", "addon-hostile", "server", "index.js");
const GH = "GITHUB_PERSONAL_ACCESS_TOKEN";
const BUNDLE = "github";

const HOME = mkdtempSync(join(tmpdir(), "crow-svcwall-home-"));
const DATA = mkdtempSync(join(tmpdir(), "crow-svcwall-data-"));
process.env.CROW_HOME = HOME;
process.env.CROW_DATA_DIR = DATA;
process.env.CROW_AUTO_UPDATE = "0";
process.env.CROW_DISABLE_HEALTH_MONITOR = "1";
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
process.env.CROW_DISABLE_NOSTR = "1";
delete process.env.CROW_ADDON_WALLS;
delete process.env.CROW_ADDON_WALLS_DEFAULT;
execFileSync(process.execPath, ["scripts/init-db.js"], { env: process.env, stdio: "pipe", cwd: REPO });

// The installed add-on: its folder, its version, its mcp-addons.json entry (the
// entry runs the hostile fixture, so a spawn is visible in its tool list).
mkdirSync(join(HOME, "bundles", BUNDLE), { recursive: true });
mkdirSync(join(DATA, BUNDLE), { recursive: true, mode: 0o700 });
writeFileSync(join(HOME, "installed.json"), JSON.stringify([{ id: BUNDLE, type: "mcp-server", version: "1.0.0" }]));
writeFileSync(join(HOME, "mcp-addons.json"), JSON.stringify({ [BUNDLE]: { command: "node", args: [FIXTURE], env: {} } }), { mode: 0o600 });

const C = await import("../servers/gateway/services/children.js");
const SENS = await import("../servers/shared/service-sensitivity.js");
const SC = await import("../servers/shared/service-connections.js");
const { createDbClient } = await import("../servers/db.js");
const { ensureWriteKey } = await import("../servers/gateway/keychain/store.js");
const { serviceById } = await import("../servers/shared/service-catalog.js");
const { AddonWallRefused } = await import("../scripts/addon-sandbox/spawn.mjs");

C._setChildrenForTest({ folder: { otherSecretsDirs: [] } });

after(async () => {
  await C.stopAllChildren();
  for (const dir of [HOME, DATA]) rmScratch(dir);
});

const db = () => createDbClient();
async function withDb(fn) {
  const d = db();
  try { return await fn(d); } finally { d.close(); }
}

/** Resolve once `check()` is true, or fail after `ms`. */
function waitFor(check, ms = 5000, what = "condition") {
  const deadline = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tick = () => {
      let ok = false;
      try { ok = check(); } catch { ok = false; }
      if (ok) return resolve();
      if (Date.now() > deadline) return reject(new Error("timed out waiting for " + what));
      setTimeout(tick, 10);
    };
    tick();
  });
}

let slugN = 0;
async function project() {
  return withDb(async (d) => {
    const slug = "w" + (++slugN);
    const r = await d.execute({ sql: "INSERT INTO project_spaces (slug, name) VALUES (?, ?) RETURNING id", args: [slug, slug] });
    return Number(r.rows[0].id);
  });
}

/** One real connection of `serviceId`, bound and fingerprinted the way the connect route does. */
async function connect(serviceId, { projectId, label = "work", secrets = {} } = {}) {
  const pid = projectId ?? (await project());
  return withDb(async (d) => {
    const key = await ensureWriteKey(d, { crowHome: HOME });
    const c = await SC.createConnection(d, { projectId: pid, serviceId, accountLabel: label, secrets, config: {}, testedAt: new Date() }, { key });
    SENS.recordConnectionBinding(c, { crowHome: HOME, service: serviceById(serviceId), values: { config: c.config, secrets } });
    return c;
  });
}
const github = (token = "test-token-9", o = {}) => connect(BUNDLE, { ...o, secrets: { [GH]: token } });

/** The wall seams: a mode decision and a start, both recorded. */
function fakeWall({ mode = "walled", start } = {}) {
  const starts = [];
  const calls = { cleanups: 0 };
  C._setChildrenForTest({
    wall: {
      mode: (o) => ({ mode, reason: null, source: mode === "walled" ? "walled" : "default", asked: o }),
      start: start || (async (o) => {
        starts.push(o);
        return {
          walled: true,
          tier: "walled",
          cmd: process.execPath,
          args: [FIXTURE],
          env: { PATH: process.env.PATH },
          stdioExtra: [],
          profile: {},
          relay: null,
          cleanup: () => { calls.cleanups += 1; },
        };
      }),
    },
  });
  return { starts, calls };
}

// ---- walled ---------------------------------------------------------------

test("a walled start hands the wrapper the service's own folder and runs the wall's command line", async () => {
  const { starts, calls } = fakeWall();
  try {
    const conn = await github("test-token-21");
    const { tools } = await withDb((d) => C.ensureChild(d, conn.uuid, { crowHome: HOME }));
    assert.ok(tools.map((t) => t.name).includes("probe_read"), "the wall's command line answered tools/list");

    assert.equal(starts.length, 1);
    const started = starts[0];
    assert.equal(started.kind, "service");
    assert.equal(started.id, BUNDLE);
    assert.equal(started.dataSubdir, "services/" + conn.uuid);
    assert.equal(started.command, process.execPath, "the resolved launcher, not the entry's bare name");
    assert.deepEqual(started.args, [FIXTURE]);
    assert.equal(started.ownEnv[GH], "test-token-21", "the connection's env is the wall's own-env input");
    assert.equal("CROW_ADDON_HOST" in started.ownEnv, true);
    assert.equal(started.baseEnv, process.env, "the gateway env goes in as baseEnv, read only through the allowlist");

    assert.equal(C.childState(conn.uuid), "running");
    await C.stopChild(conn.uuid);
    await waitFor(() => calls.cleanups >= 1, 5000, "the wall's cleanup");
    assert.equal(C.childState(conn.uuid), "stopped");
  } finally {
    await C.stopAllChildren();
    C._setChildrenForTest({ wall: null });
  }
});

test("two connections of one add-on get two different services/<uuid> folders", async () => {
  const { starts } = fakeWall();
  try {
    const pid = await project();
    const a = await github("test-token-31", { projectId: pid, label: "a" });
    const b = await github("test-token-32", { projectId: pid, label: "b" });
    assert.notEqual(a.uuid, b.uuid);
    await withDb((d) => C.ensureChild(d, a.uuid, { crowHome: HOME }));
    await withDb((d) => C.ensureChild(d, b.uuid, { crowHome: HOME }));
    const folders = starts.map((s) => s.dataSubdir);
    assert.deepEqual(folders, ["services/" + a.uuid, "services/" + b.uuid]);
    assert.equal(new Set(folders).size, 2);
  } finally {
    await C.stopAllChildren();
    C._setChildrenForTest({ wall: null });
  }
});

test("a refused wall leaves the child unstarted, in the failure state a failed start already has", async () => {
  const { starts, calls } = fakeWall({
    start: async (o) => {
      starts.push(o);
      throw new AddonWallRefused("nope");
    },
  });
  try {
    const conn = await github("test-token-41");
    await assert.rejects(
      withDb((d) => C.ensureChild(d, conn.uuid, { crowHome: HOME })),
      (err) => err && err.code === "child_unavailable",
    );
    assert.equal(starts.length, 1, "the wall was attempted once");
    assert.equal(calls.cleanups, 0);
    assert.equal(C.childState(conn.uuid), "error");
    const kids = C.listChildren().filter((k) => k.uuid === conn.uuid);
    assert.equal(kids.length, 1);
    assert.equal(kids[0].pid, null, "no process was started");
    assert.equal(existsSync(join(DATA, BUNDLE, "services")), false, "a refused wall created no folder");
    // One failed start is retried, exactly as a child that never connected is:
    // the row keeps its status and the failure count is in memory.
    const row = await withDb((d) => SC.getConnection(d, conn.uuid));
    assert.equal(row.status, "active");
    assert.equal(await withDb((d) => C.ensureChild(d, conn.uuid, { crowHome: HOME }).then(() => "started", (err) => err.code)), "child_unavailable");
    assert.equal(starts.length, 2, "the retry asked the wall again");
  } finally {
    await C.stopAllChildren();
    C._setChildrenForTest({ wall: null });
  }
});

// ---- unwalled -------------------------------------------------------------

test("an unwalled start is the spawn it was before and never asks for a wall", async () => {
  let starts = 0;
  C._setChildrenForTest({
    wall: {
      mode: () => ({ mode: "unwalled", reason: "walls are off on this computer", source: "default" }),
      start: async () => { starts += 1; throw new Error("the wall must not be started"); },
    },
  });
  try {
    const conn = await github("test-token-51");
    const { tools } = await withDb((d) => C.ensureChild(d, conn.uuid, { crowHome: HOME }));
    assert.ok(tools.map((t) => t.name).includes("probe_read"));
    assert.equal(starts, 0, "no wall for an unwalled child");
    const kids = C.listChildren().filter((k) => k.uuid === conn.uuid);
    assert.equal(kids[0].state, "running");
    assert.ok(kids[0].pid > 0);
  } finally {
    await C.stopAllChildren();
    C._setChildrenForTest({ wall: null });
  }
});

/** A small guard: the connection's token never reaches a command line (the fixture's argv). */
test("the connection's token is not in the child's argv", async () => {
  fakeWall();
  try {
    const conn = await github("test-token-61");
    await withDb((d) => C.ensureChild(d, conn.uuid, { crowHome: HOME }));
    const kid = C.listChildren().find((k) => k.uuid === conn.uuid);
    assert.ok(kid.pid > 0);
    const cmdline = readFileSync(`/proc/${kid.pid}/cmdline`, "utf8");
    assert.equal(cmdline.includes("test-token-61"), false);
  } finally {
    await C.stopAllChildren();
    C._setChildrenForTest({ wall: null });
  }
});
test("a walled service child's stderr never reaches the console (it may carry the connection's values)", async () => {
  fakeWall();
  const seen = [];
  const orig = { error: console.error, warn: console.warn, log: console.log };
  for (const k of Object.keys(orig)) console[k] = (...a) => { seen.push(a.map(String).join(" ")); };
  try {
    const conn = await github("test-token-51");
    await withDb((d) => C.ensureChild(d, conn.uuid, { crowHome: HOME }));
    // The fixture writes one stderr line at start; give it time to arrive.
    await waitFor(() => C.listChildren().some((k) => k.uuid === conn.uuid && k.pid), 5000, "the child");
    await new Promise((r) => setTimeout(r, 300));
    await C.stopChild(conn.uuid);
  } finally {
    Object.assign(console, orig);
    await C.stopAllChildren();
    C._setChildrenForTest({ wall: null });
  }
  assert.equal(seen.some((l) => l.includes("hostile-started")), false, seen.join("\n"));
});
