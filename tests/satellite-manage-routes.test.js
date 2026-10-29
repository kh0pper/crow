// Satellite management routes on crow (SAT-5, spec §7.1, §8, §9.1, §11.1): owner-only, every
// call signed through satelliteFetch; host picker rules (one host per bundle id, satellite-eligible
// bundles only); consent relay; tool list + pin approval; install/uninstall records; protocol
// gate ("update first"); rename, update, logs, env, backups, peers; unpair removes add-on
// entries and skills.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import http from "node:http";
import express from "express";

const HOME = mkdtempSync(join(tmpdir(), "satmgr-home-"));
process.env.CROW_HOME = HOME;
process.env.CROW_DATA_DIR = mkdtempSync(join(tmpdir(), "satmgr-data-"));
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
const dirs = [HOME, process.env.CROW_DATA_DIR];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const { createDbClient } = await import("../servers/db.js");
const { SATELLITE_DDL } = await import("../servers/shared/satellite-schema.js");
const P = await import("../servers/shared/satellite-protocol.js");
const store = await import("../servers/gateway/satellites/store.js");
const I = await import("../servers/gateway/satellites/installs.js");
const { default: satellitesRouter } = await import("../servers/gateway/routes/satellites.js");
const { createSatelliteManager } = await import("../servers/gateway/satellites/manage.js");
const { createPairingService } = await import("../servers/gateway/satellites/pairing.js");
const { createMgmtFake, makeSatelliteRow, demoTools, toolsHash } = await import("./helpers/fake-satellite-mgmt.js");

const BOOT = "d".repeat(40);
const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };

function appBundles() {
  const app = tmp("satmgr-app-");
  const mk = (id, m, skill) => {
    mkdirSync(join(app, id, "skills"), { recursive: true });
    writeFileSync(join(app, id, "manifest.json"), JSON.stringify({ id, name: id, version: "1.0.0", ...m, ...(skill ? { skills: [`skills/${id}.md`] } : {}) }));
    if (skill) writeFileSync(join(app, id, "skills", `${id}.md`), `# ${id}\n`);
  };
  mk("demo", { satellite: { min_ram_mb: 100 }, mcp: { mem_mb: 40 } }, true);
  mk("local-only", {});
  mk("priv", { satellite: { min_ram_mb: 100 }, privileged: true });
  return app;
}

/** Job + consent behaviour on top of the generic fake. */
function bundleRoutes(fake) {
  const jobs = new Map();
  let n = 0;
  const challenges = new Set();
  const tokens = new Set();
  Object.assign(fake.table, {
    "POST /satellite/v1/bundles/install": ({ body }) => {
      if (body.id === "priv") {
        if (!body.consent_token) { const token = "c".repeat(31) + String(n++ % 10); challenges.add(token); return { status: 403, json: { error: "consent_required", challenge: { token, message: "Needs consent", privileged: true } } }; }
        if (!tokens.has(body.consent_token)) return { status: 403, json: { error: "consent_invalid" } };
      }
      const id = String(1000000000000000 + n++).padStart(16, "0");
      jobs.set(id, { id, bundle_id: body.id, action: "install", status: "complete", log: ["ok"] });
      fake.state.tools[body.id] = fake.state.tools[body.id] || demoTools();
      fake.state.lastInstallBody = body;
      return { status: 202, json: { job_id: id } };
    },
    "POST /satellite/v1/bundles/uninstall": ({ body }) => {
      const id = String(2000000000000000 + n++).padStart(16, "0");
      jobs.set(id, { id, bundle_id: body.id, action: "uninstall", status: "complete", log: ["gone"] });
      return { status: 202, json: { job_id: id } };
    },
    "POST /satellite/v1/bundles/:id/consent": ({ params, body }) => {
      if (!challenges.has(body.token)) return { status: 403, json: { error: "consent_invalid" } };
      challenges.delete(body.token);
      if (body.accept !== true) return { status: 400, json: { error: "consent_declined" } };
      const t = "e".repeat(32); tokens.add(t);
      return { status: 200, json: { ok: true, consent_token: t, bundle: params.id } };
    },
    "GET /satellite/v1/jobs/:id": ({ params }) => (jobs.has(params.id) ? { status: 200, json: jobs.get(params.id) } : { status: 404, json: { error: "unknown_job" } }),
    "POST /satellite/v1/bundles/:id/restart": () => ({ status: 200, json: { ok: true } }),
    "GET /satellite/v1/bundles/:id/env": () => ({ status: 200, json: { keys: [{ name: "DEMO_TOKEN", set: false, secret: true, generated: false }] } }),
    "PUT /satellite/v1/bundles/:id/env": ({ body }) => ({ status: 200, json: { ok: true, restart_needed: true, got: Object.keys(body.env) } }),
    "GET /satellite/v1/bundles/:id/logs": ({ query }) => ({ status: 200, json: { log: `tail=${query.tail}`, truncated: false } }),
    "GET /satellite/v1/bundles/:id/backups": () => ({ status: 200, json: { backups: [] } }),
  });
  return { jobs };
}

async function setup({ owner = true, decorate = () => {}, protocol = P.AGENT_PROTOCOL } = {}) {
  const dir = tmp("satmgr-db-");
  const db = createDbClient(join(dir, "crow.db"));
  await db.executeMultiple(SATELLITE_DDL);
  const fake = createMgmtFake();
  const made = await makeSatelliteRow(db, fake, { agent_protocol: protocol });
  const extra = bundleRoutes(fake);
  const crowHome = tmp("satmgr-crow-");
  const paths = I.installPaths(crowHome);
  const app = appBundles();
  const manager = createSatelliteManager({
    fetchImpl: fake.fetchImpl, appBundlesDir: () => app, paths, bootShaFn: () => BOOT,
    behindByFn: async (from, to) => (from === "c".repeat(40) && to === BOOT ? 3 : null),
    peersFn: async () => [{ name: "satellite.example.ts.net", online: true, tags: ["tag:vps"] }],
    skillMode: "on", watchJobs: false, identityFn: () => made.identity,
  });
  const service = createPairingService({ fetchImpl: fake.fetchImpl, identityFn: () => made.identity, whoisImpl: async () => null });
  const xapp = express();
  xapp.use(express.json());
  xapp.use((req, _res, next) => { decorate(req); next(); });
  xapp.use(satellitesRouter({
    dbFactory: () => new Proxy(db, { get: (t, k) => (k === "close" ? () => {} : Reflect.get(t, k)) }),
    sessionGate: (_q, _r, next) => next(), ownerCheck: async () => owner, service, manager,
  }));
  const server = await new Promise((r) => { const s = xapp.listen(0, "127.0.0.1", () => r(s)); });
  const call = (method, path, body) => new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: "127.0.0.1", port: server.address().port, path, method, headers: payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {} }, (res) => {
      let text = ""; res.on("data", (c) => (text += c));
      res.on("end", () => { let json = null; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, json }); });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
  return { db, fake, made, paths, app, manager, server, call, sat: fake.satId, jobs: extra.jobs, close: () => server.close() };
}

const readJ = (p) => JSON.parse(readFileSync(p, "utf8"));

test("non-owner and peers: 403 on every management route, nothing reaches the satellite", async () => {
  for (const c of [{ owner: false }, { decorate: (q) => { q.crossHostAuth = { instance: "p" }; } }, { decorate: (q) => { q.instanceAuth = { instance: { id: "p" } }; } }]) {
    const s = await setup(c);
    try {
      const routes = [
        ["GET", "/api/satellites/peers"], ["POST", `/api/satellites/${s.sat}/rename`, { name: "x" }],
        ["POST", `/api/satellites/${s.sat}/update`, {}], ["POST", `/api/satellites/${s.sat}/refresh`, {}],
        ["POST", `/api/satellites/${s.sat}/bundles/install`, { bundle: "demo" }],
        ["POST", `/api/satellites/${s.sat}/bundles/demo/consent`, { token: "x", accept: true }],
        ["POST", `/api/satellites/${s.sat}/bundles/demo/uninstall`, {}], ["POST", `/api/satellites/${s.sat}/bundles/demo/restart`, {}],
        ["GET", `/api/satellites/${s.sat}/bundles/demo/env`], ["PUT", `/api/satellites/${s.sat}/bundles/demo/env`, { env: {} }],
        ["GET", `/api/satellites/${s.sat}/bundles/demo/logs`], ["GET", `/api/satellites/${s.sat}/bundles/demo/backups`],
        ["GET", `/api/satellites/${s.sat}/bundles/demo/tools`], ["POST", `/api/satellites/${s.sat}/bundles/demo/approve-tools`, { tools_sha256: "x" }],
        ["GET", `/api/satellites/${s.sat}/jobs/0000000000000001`], ["POST", `/api/satellites/${s.sat}/renew-cert`, {}],
        ["POST", `/api/satellites/${s.sat}/rotate-key`, {}], ["GET", "/api/satellites/eligible"],
      ];
      for (const [m, p, b] of routes) {
        const r = await s.call(m, p, b);
        assert.equal(r.status, 403, `${m} ${p}`);
      }
      assert.equal(s.fake.state.requests.length, 0);
    } finally { s.close(); }
  }
});

test("install → job → records; tools + approval stores the pin; uninstall removes everything", async () => {
  const s = await setup();
  try {
    const ins = await s.call("POST", `/api/satellites/${s.sat}/bundles/install`, { bundle: "demo", env: { DEMO_TOKEN: "t0k" } });
    assert.equal(ins.status, 202, JSON.stringify(ins.json));
    assert.deepEqual(s.fake.state.lastInstallBody, { id: "demo", env: { DEMO_TOKEN: "t0k" } });
    const job = await s.call("GET", `/api/satellites/${s.sat}/jobs/${ins.json.job_id}`);
    assert.equal(job.status, 200);
    assert.equal(job.json.status, "complete");
    const rec = readJ(s.paths.installed).find((r) => r.id === "demo");
    assert.deepEqual([rec.mode, rec.host], ["satellite", s.sat]);
    assert.deepEqual(readJ(s.paths.addons).demo, { transport: "satellite", satellite_id: s.sat, bundle: "demo" });
    assert.ok(existsSync(join(s.paths.skillsDir, "demo.md")), "skill synced from crow's checkout");
    // Every satellite request was signed as owner-local.
    for (const q of s.fake.state.requests.filter((x) => x.path.startsWith("/satellite/"))) assert.equal(q.headers["X-Crow-Sat-Caller"], "owner-local");

    const tools = await s.call("GET", `/api/satellites/${s.sat}/bundles/demo/tools`);
    assert.equal(tools.status, 200);
    assert.deepEqual(tools.json.tools.map((t) => t.name), ["demo_list", "demo_create"]);
    assert.equal(tools.json.tools_sha256, toolsHash(demoTools()));
    assert.equal(tools.json.pin, null);
    const stale = await s.call("POST", `/api/satellites/${s.sat}/bundles/demo/approve-tools`, { tools_sha256: "0".repeat(64) });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.error, "tools_changed");
    const ok = await s.call("POST", `/api/satellites/${s.sat}/bundles/demo/approve-tools`, { tools_sha256: tools.json.tools_sha256 });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    const pin = await store.getToolPin(s.db, s.sat, "demo");
    assert.equal(pin.tools_sha256, toolsHash(demoTools()));
    assert.deepEqual(JSON.parse(pin.tools_json), demoTools());
    assert.equal(pin.version, "1.0.0");

    const list = await s.call("GET", "/api/satellites");
    const card = list.json.satellites[0].card;
    assert.equal(card.behind_by, 3);
    assert.equal(card.installed.find((b) => b.id === "demo").tools.state, "ok");
    assert.equal(list.json.crow.boot_sha, BOOT);

    const un = await s.call("POST", `/api/satellites/${s.sat}/bundles/demo/uninstall`, {});
    assert.equal(un.status, 202);
    await s.call("GET", `/api/satellites/${s.sat}/jobs/${un.json.job_id}`);
    assert.equal(readJ(s.paths.installed).some((r) => r.id === "demo"), false);
    assert.equal("demo" in readJ(s.paths.addons), false);
    assert.equal(await store.getToolPin(s.db, s.sat, "demo"), null);
    assert.ok(!existsSync(join(s.paths.skillsDir, "demo.md")));
  } finally { s.close(); }
});

test("host picker rules: not satellite-eligible, unknown, installed locally → refused before any network", async () => {
  const s = await setup();
  try {
    writeFileSync(s.paths.installed, JSON.stringify([{ id: "demo", version: "1.0.0" }]));
    const loc = await s.call("POST", `/api/satellites/${s.sat}/bundles/install`, { bundle: "demo" });
    assert.equal(loc.status, 409);
    assert.equal(loc.json.error, "installed_locally");
    const ne = await s.call("POST", `/api/satellites/${s.sat}/bundles/install`, { bundle: "local-only" });
    assert.equal(ne.status, 400);
    assert.equal(ne.json.error, "not_satellite");
    const unk = await s.call("POST", `/api/satellites/${s.sat}/bundles/install`, { bundle: "nope" });
    assert.equal(unk.status, 404);
    const bad = await s.call("POST", `/api/satellites/${s.sat}/bundles/install`, { bundle: "../x" });
    assert.equal(bad.status, 400);
    assert.equal(s.fake.state.requests.filter((q) => q.path.includes("/bundles/")).length, 0);
    const el = await s.call("GET", "/api/satellites/eligible");
    assert.deepEqual(el.json.bundles, ["demo", "priv"]);
  } finally { s.close(); }
});

test("consent relay: the satellite's challenge reaches the owner; the signed answer gives a token; install proceeds", async () => {
  const s = await setup();
  try {
    const first = await s.call("POST", `/api/satellites/${s.sat}/bundles/install`, { bundle: "priv" });
    assert.equal(first.status, 403);
    assert.equal(first.json.error, "consent_required");
    assert.equal(first.json.challenge.message, "Needs consent");
    const no = await s.call("POST", `/api/satellites/${s.sat}/bundles/priv/consent`, { token: first.json.challenge.token, accept: false });
    assert.equal(no.status, 400);
    const again = await s.call("POST", `/api/satellites/${s.sat}/bundles/install`, { bundle: "priv" });
    const yes = await s.call("POST", `/api/satellites/${s.sat}/bundles/priv/consent`, { token: again.json.challenge.token, accept: true });
    assert.equal(yes.status, 200);
    const go = await s.call("POST", `/api/satellites/${s.sat}/bundles/install`, { bundle: "priv", consent_token: yes.json.consent_token });
    assert.equal(go.status, 202, JSON.stringify(go.json));
  } finally { s.close(); }
});

test("protocol gate: an older agent refuses management with update_first, but update/refresh/renew still go", async () => {
  const s = await setup({ protocol: 0 });
  try {
    for (const [m, p, b] of [["POST", `/api/satellites/${s.sat}/bundles/install`, { bundle: "demo" }], ["POST", `/api/satellites/${s.sat}/bundles/demo/restart`, {}], ["GET", `/api/satellites/${s.sat}/bundles/demo/logs`]]) {
      const r = await s.call(m, p, b);
      assert.equal(r.status, 409, `${m} ${p}`);
      assert.equal(r.json.error, "update_first");
    }
    const up = await s.call("POST", `/api/satellites/${s.sat}/update`, {});
    assert.equal(up.status, 202, JSON.stringify(up.json));
    const sent = s.fake.state.requests.find((q) => q.path === "/satellite/v1/update");
    assert.deepEqual(JSON.parse(sent.body), { target_sha: BOOT });
    const rf = await s.call("POST", `/api/satellites/${s.sat}/refresh`, {});
    assert.equal(rf.status, 200);
    const rn = await s.call("POST", `/api/satellites/${s.sat}/renew-cert`, {});
    assert.equal(rn.status, 200, JSON.stringify(rn.json));
    assert.equal(rn.json.renewed, true);
  } finally { s.close(); }
});

test("lifecycle, env (names only out), logs, backups, rename, peers; unreachable is 502", async () => {
  const s = await setup();
  try {
    assert.equal((await s.call("POST", `/api/satellites/${s.sat}/bundles/demo/restart`, {})).status, 200);
    const env = await s.call("GET", `/api/satellites/${s.sat}/bundles/demo/env`);
    assert.deepEqual(env.json.keys[0], { name: "DEMO_TOKEN", set: false, secret: true, generated: false });
    const put = await s.call("PUT", `/api/satellites/${s.sat}/bundles/demo/env`, { env: { DEMO_TOKEN: "v" } });
    assert.deepEqual(put.json.got, ["DEMO_TOKEN"]);
    const logs = await s.call("GET", `/api/satellites/${s.sat}/bundles/demo/logs?tail=50`);
    assert.equal(logs.json.log, "tail=50");
    const badTail = await s.call("GET", `/api/satellites/${s.sat}/bundles/demo/logs?tail=abc`);
    assert.equal(badTail.status, 400);
    assert.deepEqual((await s.call("GET", `/api/satellites/${s.sat}/bundles/demo/backups`)).json.backups, []);
    const rn = await s.call("POST", `/api/satellites/${s.sat}/rename`, { name: "Office box" });
    assert.equal(rn.status, 200);
    assert.equal((await store.getSatellite(s.db, s.sat)).name, "Office box");
    assert.equal((await s.call("POST", `/api/satellites/${s.sat}/rename`, { name: "" })).status, 400);
    const peers = await s.call("GET", "/api/satellites/peers");
    assert.deepEqual(peers.json.peers[0].tags, ["tag:vps"]);
    s.fake.state.unreachable = true;
    const un = await s.call("POST", `/api/satellites/${s.sat}/bundles/demo/restart`, {});
    assert.equal(un.status, 502);
    assert.equal(un.json.error, "unreachable");
    const unknown = await s.call("POST", "/api/satellites/sat_zzzzzzzzzzzzzzzzzzzz/bundles/demo/restart", {});
    assert.equal(unknown.status, 404);
  } finally { s.close(); }
});

test("unpair removes the satellite's add-on entries, skills and pins", async () => {
  const s = await setup();
  try {
    const ins = await s.call("POST", `/api/satellites/${s.sat}/bundles/install`, { bundle: "demo" });
    await s.call("GET", `/api/satellites/${s.sat}/jobs/${ins.json.job_id}`);
    assert.ok(existsSync(join(s.paths.skillsDir, "demo.md")));
    const un = await s.call("POST", `/api/satellites/${s.sat}/unpair`, {});
    assert.equal(un.status, 200, JSON.stringify(un.json));
    assert.equal(readJ(s.paths.installed).length, 0);
    assert.deepEqual(readJ(s.paths.addons), {});
    assert.ok(!existsSync(join(s.paths.skillsDir, "demo.md")));
    assert.equal((await store.getSatellite(s.db, s.sat)).status, "revoked");
    const after2 = await s.call("POST", `/api/satellites/${s.sat}/bundles/demo/restart`, {});
    assert.equal(after2.status, 409);
    assert.equal(after2.json.error, "revoked");
  } finally { s.close(); }
});
