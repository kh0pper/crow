/**
 * Follow-up B (queue item 30): outside Crow's home the install security check admits
 * only folders the OWNER allowed (folder grants, servers/gateway/folder-grants.js). A grant
 * is made only from this machine's own dashboard (a local password session), only for a
 * value the owner typed (never a default, an example or a retained value), and counts only
 * while the key still names that folder. Compose up/pull is stubbed; `compose config` is
 * real (the docker cases skip without it).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

process.env.CROW_HOME = mkdtempSync(join(tmpdir(), "crow-grants-home-"));
process.env.CROW_DATA_DIR = mkdtempSync(join(tmpdir(), "crow-grants-data-"));
process.env.CROW_AUTO_UPDATE = "0";
process.env.CROW_DISABLE_HEALTH_MONITOR = "1";
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
process.env.CROW_DISABLE_NOSTR = "1";
const CROW_HOME = process.env.CROW_HOME;
const DATA = process.env.CROW_DATA_DIR;
const MEDIA = mkdtempSync(join(tmpdir(), "crow-grants-media-"));
const OTHER = mkdtempSync(join(tmpdir(), "crow-grants-other-"));
const LEGACY = mkdtempSync(join(tmpdir(), "crow-grants-legacy-"));

// A record-less installed bundle from before this change (romm/dozzle on a real host):
// set up BEFORE the router's one-time migration runs.
mkdirSync(join(CROW_HOME, "bundles", "fx-legacy"), { recursive: true });
writeFileSync(join(CROW_HOME, "bundles", "fx-legacy", "docker-compose.yml"), "services:\n  app:\n    image: busybox\n    volumes:\n      - ${LIB:?set LIB}:/lib:ro\n");
writeFileSync(join(CROW_HOME, "bundles", "fx-legacy", ".env"), `LIB=${LEGACY}\n`);
writeFileSync(join(CROW_HOME, "bundles", "fx-legacy", "manifest.json"), JSON.stringify({ id: "fx-legacy", name: "fx-legacy", version: "0.1.0", type: "bundle" }));

const B = await import("../servers/gateway/routes/bundles.js");
const FG = await import("../servers/gateway/folder-grants.js");
const BC = await import("../servers/gateway/bundles-config.js");
const FIXTURES = mkdtempSync(join(tmpdir(), "crow-grants-app-"));
B._setAppBundlesForTest(FIXTURES);
const upCalls = [];
B._setComposeRunnerForTest(async (args) => { upCalls.push(args); return { stdout: "", stderr: "" }; });
B._setDockerRunnerForTest(async () => ({ stdout: "", stderr: "" }));
// Who is the owner: the test header, standing in for the oauth_tokens scopes lookup.
B._setOwnerCheckForTest((req) => req.headers?.["x-test-who"] === "owner" && !req.crossHostAuth);
after(() => {
  B._setComposeRunnerForTest(null);
  B._setDockerRunnerForTest(null);
  B._setOwnerCheckForTest(null);
  for (const d of [CROW_HOME, DATA, FIXTURES, MEDIA, OTHER, LEGACY]) rmSync(d, { recursive: true, force: true });
});

let HAVE_COMPOSE = false;
try { execFileSync("docker", ["compose", "version"], { stdio: "pipe" }); HAVE_COMPOSE = true; } catch { /* skip */ }
const dockerTest = (name, fn) => test(name, { skip: HAVE_COMPOSE ? false : "docker compose not available" }, fn);

const COMPOSE = "services:\n  app:\n    image: busybox\n    volumes:\n      - ${MEDIA_DIR:-./media}:/media:ro\n";
function stage(id, { def, secret = false, example } = {}) {
  const dir = join(FIXTURES, id);
  mkdirSync(dir, { recursive: true });
  const manifest = { id, name: id, description: "d", type: "bundle", category: "media", version: "0.1.0", docker: { composefile: "docker-compose.yml" },
    env_vars: [{ name: "MEDIA_DIR", description: "Your media folder", required: false, ...(def ? { default: def } : {}), ...(secret ? { secret: true } : {}) }] };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, "docker-compose.yml"), COMPOSE);
  if (example) writeFileSync(join(dir, ".env.example"), `MEDIA_DIR=${example}\n`);
  return manifest;
}
const grants = () => FG.readGrants(CROW_HOME);

async function withApp(who, fn) {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => {
    req.dashboardSession = "test-session";
    if (who === "peer") req.crossHostAuth = { sourceInstanceId: "peer-x" };
    next();
  });
  app.use(B.default());
  const server = app.listen(0, "127.0.0.1"); await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body) => { const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", "x-test-who": who }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  try { return await fn(post); } finally { server.close(); }
}
async function install(id, env, { owner = true } = {}) {
  const manifest = JSON.parse(readFileSync(join(FIXTURES, id, "manifest.json"), "utf8"));
  const job = B._createJobForTest(id, "install");
  const out = await B.runInstallJob(id, env, { job, installedSnapshot: [], consentVerified: false, manifest, ownerEnv: owner ? env : null });
  return { ...out, log: (job.log || []).join("\n") };
}

dockerTest("the router's one-time migration grandfathers folders installed bundles already use (with or without a record)", async () => {
  await withApp("owner", async (post) => {
    assert.equal(grants()._migrated, 1);
    assert.equal(grants()["fx-legacy"].LIB.value, LEGACY);
    const r = await post("/bundles/api/start", { bundle_id: "fx-legacy" });
    assert.notEqual(r.status, 403, JSON.stringify(r.body));
  });
});

dockerTest("the owner's typed folder is allowed at install and kept for Start", async () => {
  stage("fx-g1");
  const out = await install("fx-g1", { MEDIA_DIR: MEDIA });
  assert.equal(out.ok, true, out.reason);
  assert.equal(grants()["fx-g1"].MEDIA_DIR.value, MEDIA);
  await withApp("owner", async (post) => {
    upCalls.length = 0;
    const r = await post("/bundles/api/start", { bundle_id: "fx-g1" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(upCalls.some((a) => a[0] === "up"));
  });
});

dockerTest("not the owner's choice: a request without the owner, a manifest default, an example, a secret key — refused before any up", async () => {
  const cases = [
    ["fx-g2", {}, { MEDIA_DIR: MEDIA }, false],
    ["fx-g3", { def: MEDIA }, { MEDIA_DIR: MEDIA }, true],
    ["fx-g4", { example: MEDIA }, { MEDIA_DIR: MEDIA }, true],
    ["fx-g5", { secret: true }, { MEDIA_DIR: MEDIA }, true],
  ];
  for (const [id, opts, env, owner] of cases) {
    stage(id, opts);
    upCalls.length = 0;
    const out = await install(id, env, { owner });
    assert.equal(out.ok, false, `${id} must be refused`);
    assert.match(out.reason, /not a folder you allowed/, id);
    assert.equal(upCalls.filter((a) => a[0] === "up" || a[0] === "pull").length, 0, id);
    assert.equal(grants()[id], undefined, id);
  }
});

dockerTest("Configure: a peer cannot set a folder outside Crow's home; the owner can, and a hand edit is not allowed", async () => {
  stage("fx-g6");
  assert.equal((await install("fx-g6", {})).ok, true, "installs with its in-bundle default");
  await withApp("peer", async (post) => {
    const r = await post("/bundles/api/env", { bundle_id: "fx-g6", env_vars: { MEDIA_DIR: OTHER } });
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.code, "folder_needs_owner");
    assert.doesNotMatch(readFileSync(join(CROW_HOME, "bundles", "fx-g6", ".env"), "utf8"), new RegExp(OTHER), "nothing written");
  });
  await withApp("owner", async (post) => {
    assert.equal((await post("/bundles/api/env", { bundle_id: "fx-g6", env_vars: { MEDIA_DIR: MEDIA } })).status, 200);
    assert.equal(grants()["fx-g6"].MEDIA_DIR.value, MEDIA);
    assert.equal((await post("/bundles/api/start", { bundle_id: "fx-g6" })).status, 200);
    // A hand edit to another folder: not allowed, and Configure now lists the key.
    writeFileSync(join(CROW_HOME, "bundles", "fx-g6", ".env"), `MEDIA_DIR=${OTHER}\n`);
    const s = await post("/bundles/api/start", { bundle_id: "fx-g6" });
    assert.equal(s.status, 403, JSON.stringify(s.body));
    assert.match(s.body.error, /Configure/);
    assert.ok(BC.needsConfigKeys("fx-g6").includes("MEDIA_DIR"), "Configure offers the folder");
    // The owner enters it in Configure: allowed, Start works, nothing left to configure.
    assert.equal((await post("/bundles/api/env", { bundle_id: "fx-g6", env_vars: { MEDIA_DIR: OTHER } })).status, 200);
    assert.equal((await post("/bundles/api/start", { bundle_id: "fx-g6" })).status, 200);
    assert.ok(!BC.needsConfigKeys("fx-g6").includes("MEDIA_DIR"));
    // The owner sets it back inside the bundle: the grant goes.
    assert.equal((await post("/bundles/api/env", { bundle_id: "fx-g6", env_vars: { MEDIA_DIR: "./media" } })).status, 200);
    assert.equal(grants()["fx-g6"].MEDIA_DIR, undefined);
  });
  // A peer can't set a folder setting at all, even a relative or interpolated one (Compose
  // resolves ../../ and ${X} to the same folders); settings the compose file doesn't mount
  // still work.
  await withApp("peer", async (post) => {
    for (const v of ["/srv/x", "./a/../../../../../srv/x", "../srv", "${HOME}/x", "$HOME/x", "~/x"]) {
      assert.equal((await post("/bundles/api/env", { bundle_id: "fx-g6", env_vars: { MEDIA_DIR: v } })).status, 403, v);
    }
    assert.equal((await post("/bundles/api/env", { bundle_id: "fx-g6", env_vars: { UNRELATED: "x/y" } })).status, 200);
    // Ordinary values of a setting the compose file uses stay settable: a sub-folder of the bundle.
    assert.equal((await post("/bundles/api/env", { bundle_id: "fx-g6", env_vars: { MEDIA_DIR: "./media2" } })).status, 200);
  });
});

dockerTest("a reinstall over the kept .env keeps the allowed folder", async () => {
  stage("fx-g7");
  assert.equal((await install("fx-g7", { MEDIA_DIR: MEDIA })).ok, true);
  const out = await install("fx-g7", {}, { owner: false });
  assert.equal(out.ok, true, out.reason);
});

dockerTest("after uninstall, a reinstall that restores the retained folder still starts (the grant is kept)", async () => {
  const id = "fx-g10";
  const dir = join(FIXTURES, id);
  stage(id);
  const man = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  man.env_vars[0].default_in_crow_home = "fx-g10-media";
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(man));
  const lib = join(OTHER, "lib10");
  mkdirSync(lib, { recursive: true });
  assert.equal((await install(id, { MEDIA_DIR: lib })).ok, true);
  // Uninstall: the bundle folder goes, the value is retained (as uninstall keeps it).
  rmSync(join(CROW_HOME, "bundles", id), { recursive: true, force: true });
  const { retainedEnvPath } = await import("../servers/gateway/bundle-env-secrets.js");
  mkdirSync(join(retainedEnvPath(CROW_HOME, id), ".."), { recursive: true });
  writeFileSync(retainedEnvPath(CROW_HOME, id), `MEDIA_DIR=${lib}\n`);
  const out = await install(id, {}, { owner: false });
  assert.equal(out.ok, true, out.reason);
  assert.match(readFileSync(join(CROW_HOME, "bundles", id, ".env"), "utf8"), new RegExp(lib));
});

dockerTest("a folder inside Crow's home that symlinks outside it needs a grant too, and Configure offers it", async () => {
  const { symlinkSync } = await import("node:fs");
  stage("fx-g11");
  mkdirSync(join(CROW_HOME, "media"), { recursive: true });
  const drive = join(OTHER, "drive11");
  mkdirSync(drive, { recursive: true });
  symlinkSync(drive, join(CROW_HOME, "media", "ext11"));
  const viaHome = join(CROW_HOME, "media", "ext11");
  assert.equal((await install("fx-g11", { MEDIA_DIR: viaHome }, { owner: false })).ok, false, "not the owner's: refused");
  assert.equal((await install("fx-g11", { MEDIA_DIR: viaHome })).ok, true, "the owner's: allowed");
  assert.equal(grants()["fx-g11"].MEDIA_DIR.real.endsWith("drive11"), true);
});

test("the owner check: only a local password session (not a peer sign-in, not a signed peer request)", async () => {
  const { createDbClient } = await import("../servers/db.js");
  const { createHash } = await import("node:crypto");
  const { isLocalPasswordSession } = await import("../servers/gateway/dashboard/local-session.js");
  const db = createDbClient();
  const h = (t) => createHash("sha256").update(t).digest("hex");
  try {
    await db.execute("CREATE TABLE IF NOT EXISTS oauth_tokens (token TEXT PRIMARY KEY, token_type TEXT, client_id TEXT, scopes TEXT, expires_at TEXT)");
    const later = new Date(Date.now() + 3600_000).toISOString();
    for (const [t, scopes, exp] of [["local", "dashboard", later], ["sso", "dashboard sso", later], ["old", "dashboard", "2000-01-01T00:00:00Z"]]) {
      await db.execute({ sql: "INSERT OR REPLACE INTO oauth_tokens (token, token_type, client_id, scopes, expires_at) VALUES (?, 'access', 'dashboard', ?, ?)", args: [h(t), scopes, exp] });
    }
  } finally { db.close(); }
  assert.equal(await isLocalPasswordSession({ dashboardSession: "local" }), true);
  assert.equal(await isLocalPasswordSession({ dashboardSession: "sso" }), false, "a peer sign-in session");
  assert.equal(await isLocalPasswordSession({ dashboardSession: "old" }), false, "expired");
  assert.equal(await isLocalPasswordSession({ dashboardSession: "local", crossHostAuth: {} }), false, "a signed peer request");
  assert.equal(await isLocalPasswordSession({ dashboardSession: "nope" }), false);
  assert.equal(await isLocalPasswordSession({}), false);
});

test("a corrupt grants store fails closed: no grants, no second migration", () => {
  const other = mkdtempSync(join(tmpdir(), "crow-grants-corrupt-"));
  try {
    writeFileSync(join(other, "folder-grants.json"), "{not json");
    const g = FG.readGrants(other);
    assert.equal(g._migrated, 1);
    assert.equal(FG.migrateGrants({ crowHome: other }), false);
    assert.equal(readFileSync(join(other, "folder-grants.json"), "utf8"), "{not json", "left for the owner to fix");
    FG.recordGrants(other, "x", { K: { value: "/srv/a/b", real: "/srv/a/b" } });
    assert.equal(readFileSync(join(other, "folder-grants.json"), "utf8"), "{not json", "never overwritten by a save");
  } finally { rmSync(other, { recursive: true, force: true }); }
});

dockerTest("no folder may nest with another extension's allowed folder", async () => {
  stage("fx-g8");
  stage("fx-g9");
  mkdirSync(join(MEDIA, "inner"), { recursive: true });
  assert.equal((await install("fx-g8", { MEDIA_DIR: join(MEDIA, "inner") })).ok, false, "inside fx-g1's folder");
  assert.equal((await install("fx-g9", { MEDIA_DIR: MEDIA })).ok, true, "the same folder as fx-g1 is fine");
});

test("grantCandidates: mount-source keys only, path-like, outside Crow, not secret, not the bundle's own value, a valid root", () => {
  const manifest = { env_vars: [{ name: "A", default: "/srv/a/x" }, { name: "S", secret: true }, { name: "E" }] };
  const vols = (k) => `      - \${${k}}:/m\n`;
  const compose = "services:\n  app:\n    environment:\n      URLPATH: ${U}\n    volumes:\n" + ["A", "B", "S", "E", "IN", "R", "ROOT", "HOMEK", "SHALLOW"].map(vols).join("");
  const c = FG.grantCandidates({ manifest, composeText: compose, exampleEnv: { E: "/srv/e/x" }, retained: { R: "/srv/r/x" }, crowHome: CROW_HOME, dataDirs: [DATA],
    submitted: { A: "/srv/a/x", B: "/srv/b/x", S: "/srv/s/x", E: "/srv/e/x", IN: join(CROW_HOME, "x"), U: "/srv/u/x", R: "/srv/r/x", ROOT: "/", HOMEK: process.env.HOME || "/home/x", SHALLOW: "/srv" } });
  assert.deepEqual(Object.keys(c), ["B"]);
  assert.deepEqual([...FG.composeMountKeys(compose)].sort(), ["A", "B", "E", "HOMEK", "IN", "R", "ROOT", "S", "SHALLOW"]);
  assert.ok(!FG.composeMountKeys("    volumes:\n      - ${CROW_HOME:?x}/b:/b\n").has("CROW_HOME"), "gateway-supplied keys are not the .env's");
});

test("reachesHostPath: paths and interpolations yes; URLs, time zones, tokens and ./sub no", () => {
  for (const v of ["/srv", "~/x", "../x", "./a/../../x", "a/../../x", "${X}", "$X/y", "x${Y}"]) assert.equal(B.reachesHostPath(v), true, v);
  for (const v of ["https://lemmy.example.com/api", "America/Chicago", "abc+/def==", "./media", "media/sub", "pa$$word", "p$1", ""]) assert.equal(B.reachesHostPath(v), false, v);
});
