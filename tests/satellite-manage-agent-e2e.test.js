// End to end against the REAL satellite agent (SAT-5): crow's owner routes drive an in-process
// agent (servers/satellite/agent.js, reached through the Serve-classification seam) to install a
// bundle, record it, read and approve its tool list (the pin hash must equal the hash the agent
// reports in GET status), see the card's tools state go "ok", read env and logs, and uninstall it.
// The bundle's MCP server is tests/fixtures/sat-fake-mcp-server.mjs; docker never runs.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import http from "node:http";
import express from "express";
import { actAsServe, serveHeaders } from "./fixtures/serve-peer.mjs";

const CROW_HOME = mkdtempSync(join(tmpdir(), "sate2e-crow-"));
process.env.CROW_HOME = CROW_HOME;
process.env.CROW_DATA_DIR = mkdtempSync(join(tmpdir(), "sate2e-data-"));
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";
actAsServe();

const P = await import("../servers/shared/satellite-protocol.js");
const { createDbClient } = await import("../servers/db.js");
const { SATELLITE_DDL } = await import("../servers/shared/satellite-schema.js");
const store = await import("../servers/gateway/satellites/store.js");
const I = await import("../servers/gateway/satellites/installs.js");
const { createMgmtKey } = await import("../servers/gateway/satellites/mgmt-keys.js");
const { issueCert } = await import("../servers/gateway/satellites/certs.js");
const { createSatelliteManager } = await import("../servers/gateway/satellites/manage.js");
const { default: satellitesRouter } = await import("../servers/gateway/routes/satellites.js");
const { fakeIdentity } = await import("./helpers/fake-satellite.js");
const { startAgent } = await import("../servers/satellite/agent.js");
const { ensureSatelliteKey, writeCert, writePinned } = await import("../servers/satellite/keys.js");
const { readTextOrNull } = await import("../servers/satellite/status.js");

const FIXTURE = join(import.meta.dirname, "fixtures", "sat-fake-mcp-server.mjs");
const dirs = [CROW_HOME, process.env.CROW_DATA_DIR];
const closers = [];
after(async () => {
  for (const c of closers.reverse()) await c();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
const HOST = "satellite.example.ts.net";
const meminfo = (mb) => `MemTotal: 999424 kB\nMemAvailable: ${mb * 1024} kB\nSwapTotal: 2097152 kB\nSwapFree: 2097152 kB\n`;

function writeBundle(root, id) {
  const dir = join(root, id);
  mkdirSync(join(dir, "server"), { recursive: true });
  mkdirSync(join(dir, "skills"), { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({
    id, name: id, version: "1.0.0", type: "bundle", satellite: { min_ram_mb: 120 }, mcp: { mem_mb: 40 },
    server: { command: "node", args: ["server/index.js"], envKeys: [] }, skills: [`skills/${id}.md`],
  }, null, 2));
  writeFileSync(join(dir, "server", "index.js"), `import ${JSON.stringify(pathToFileURL(FIXTURE).href)};\n`);
  writeFileSync(join(dir, "skills", `${id}.md`), `# ${id}\n`);
}

test("crow installs, pins, reads env and logs, and uninstalls a bundle on the real agent", { timeout: 120000 }, async () => {
  // The satellite: a paired SAT_HOME whose pin names crow's mgmt key.
  const satHome = tmp("sate2e-sat-");
  const key = ensureSatelliteKey(satHome);
  const identity = fakeIdentity();
  const mgmt = createMgmtKey(key.satellite_id, { replace: true });
  const cert = issueCert({
    identity, instanceId: "inst-primary", primaryUrl: "https://crow.example.ts.net:8444",
    satellite_id: key.satellite_id, satellite_pubkey: key.ed25519_pub, mgmt_pubkey: mgmt.ed25519_pub,
  });
  writePinned(satHome, { crow_id: cert.payload.crow_id, root_pubkey: cert.payload.root_pubkey, mgmt_pubkey: mgmt.ed25519_pub, primary_url: cert.payload.primary_url, primary_instance_id: "inst-primary", target_sha: null });
  writeCert(satHome, cert);
  writeBundle(join(satHome, "app", "bundles"), "demo");
  const agent = await startAgent({
    env: { CROW_HOME: satHome, CROW_SATELLITE_PORT: "0" }, out: () => {}, authLog: () => {}, sha: "a".repeat(40),
    bundleDeps: {
      composeRunner: async () => { throw new Error("compose must not run"); },
      dockerRunner: async () => ({ stdout: "" }),
      readText: (p) => (p === "/proc/meminfo" ? meminfo(800) : readTextOrNull(p)),
      npmRunner: async () => { throw new Error("npm must not run"); },
    },
  });
  closers.push(() => agent.close());
  // Tailscale Serve in front of the agent's loopback port.
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    assert.equal(u.host, HOST);
    return fetch(`http://127.0.0.1:${agent.port}${u.pathname}${u.search}`, { ...init, headers: { ...init.headers, ...serveHeaders(null, "100.64.20.5") } });
  };

  // crow: the satellites row, its own checkout of the same bundle, the owner routes.
  const db = createDbClient(join(tmp("sate2e-db-"), "crow.db"));
  await db.executeMultiple(SATELLITE_DDL);
  await store.insertSatellite(db, {
    id: key.satellite_id, name: "test-box", tailnet_host: HOST, satellite_pubkey: key.ed25519_pub, mgmt_pubkey: mgmt.ed25519_pub,
    cert_json: JSON.stringify(cert), cert_serial: cert.payload.serial, cert_expires_at: cert.payload.expires_at,
    primary_url: cert.payload.primary_url, agent_protocol: P.AGENT_PROTOCOL, status: "active", created_at: new Date().toISOString(),
  });
  const crowApp = tmp("sate2e-crowapp-");
  writeBundle(crowApp, "demo");
  const paths = I.installPaths(tmp("sate2e-crowhome-"));
  const manager = createSatelliteManager({ fetchImpl, appBundlesDir: () => crowApp, paths, bootShaFn: () => "a".repeat(40), behindByFn: async () => 0, skillMode: "on", watchJobs: false, identityFn: () => identity });
  const app = express();
  app.use(express.json());
  app.use(satellitesRouter({
    dbFactory: () => new Proxy(db, { get: (t, k) => (k === "close" ? () => {} : Reflect.get(t, k)) }),
    sessionGate: (_q, _r, next) => next(), ownerCheck: async () => true, manager,
  }));
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  closers.push(() => new Promise((r) => server.close(r)));
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
  const S = `/api/satellites/${key.satellite_id}`;
  const waitJob = async (jobId) => {
    const end = Date.now() + 60000;
    for (;;) {
      const j = await call("GET", `${S}/jobs/${jobId}`);
      assert.equal(j.status, 200, JSON.stringify(j.json));
      if (j.json.status !== "running") return j.json;
      assert.ok(Date.now() < end, "job did not finish");
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  // Status first: the card is filled from a real signed status.
  assert.equal((await call("POST", `${S}/refresh`, {})).json.ok, true);

  const ins = await call("POST", `${S}/bundles/install`, { bundle: "demo" });
  assert.equal(ins.status, 202, JSON.stringify(ins.json));
  const job = await waitJob(ins.json.job_id);
  assert.equal(job.status, "complete", JSON.stringify(job.log));
  const rec = JSON.parse(readFileSync(paths.installed, "utf8")).find((r) => r.id === "demo");
  assert.deepEqual([rec.mode, rec.host], ["satellite", key.satellite_id]);
  assert.deepEqual(JSON.parse(readFileSync(paths.addons, "utf8")).demo, { transport: "satellite", satellite_id: key.satellite_id, bundle: "demo" });
  assert.ok(existsSync(join(paths.skillsDir, "demo.md")));

  const tools = await call("GET", `${S}/bundles/demo/tools`);
  assert.equal(tools.status, 200, JSON.stringify(tools.json));
  assert.ok(tools.json.tools.some((t) => t.name === "demo_echo"));
  assert.deepEqual(tools.json.check.problems, []);
  const ok = await call("POST", `${S}/bundles/demo/approve-tools`, { tools_sha256: tools.json.tools_sha256 });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.state, "ok", "crow's pin hash equals the hash the agent reports in GET status");

  const list = await call("GET", "/api/satellites");
  const card = list.json.satellites[0].card;
  assert.equal(card.installed.find((b) => b.id === "demo").tools.state, "ok");
  assert.equal(card.behind_by, 0);
  assert.equal(typeof card.skew_ms, "number");
  assert.ok(card.mem && card.mem.MemTotal > 0);

  const env = await call("GET", `${S}/bundles/demo/env`);
  assert.equal(env.status, 200, JSON.stringify(env.json));
  const logs = await call("GET", `${S}/bundles/demo/logs?tail=10`);
  assert.ok([200, 404, 409].includes(logs.status), JSON.stringify(logs.json)); // compose-less bundle: no container log

  const un = await call("POST", `${S}/bundles/demo/uninstall`, {});
  assert.equal(un.status, 202, JSON.stringify(un.json));
  assert.equal((await waitJob(un.json.job_id)).status, "complete");
  assert.equal(JSON.parse(readFileSync(paths.installed, "utf8")).some((r) => r.id === "demo"), false);
  assert.equal(await store.getToolPin(db, key.satellite_id, "demo"), null);
  assert.ok(!existsSync(join(paths.skillsDir, "demo.md")));
});
