// Satellite owner-only routes (SAT-1): every /api/satellites route refuses a non-owner, a signed
// peer (crossHostAuth / instanceAuth) and a peer-SSO session; not_migrated answers 503; the
// install command is built from the one repo constant.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import http from "node:http";
import express from "express";

const HOME = mkdtempSync(join(tmpdir(), "satroutes-home-"));
process.env.CROW_HOME = HOME;
process.env.CROW_DATA_DIR = mkdtempSync(join(tmpdir(), "satroutes-data-"));
process.env.CROW_DISABLE_INSTANCE_SYNC = "1";

const { createDbClient } = await import("../servers/db.js");
const { SATELLITE_DDL } = await import("../servers/shared/satellite-schema.js");
const P = await import("../servers/shared/satellite-protocol.js");
const { default: satellitesRouter } = await import("../servers/gateway/routes/satellites.js");
const { SATELLITE_REPO, buildInstallCommand } = await import("../servers/gateway/satellites/install-command.js");
const { createPairingService } = await import("../servers/gateway/satellites/pairing.js");
const { createFakeSatellite, fakeIdentity, FAKE_HOST } = await import("./helpers/fake-satellite.js");

const dirs = [HOME, process.env.CROW_DATA_DIR];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

async function freshDb(withTables = true) {
  const dir = mkdtempSync(join(tmpdir(), "satroutes-db-"));
  dirs.push(dir);
  const db = createDbClient(join(dir, "crow.db"));
  if (withTables) await db.executeMultiple(SATELLITE_DDL);
  return db;
}

const CODE = P.generatePairCode().code;
const SHA = "b".repeat(40);
const SCRIPT = Buffer.from("#!/bin/bash\necho satellite\n");

function start({ db, fake, owner = true, decorate = () => {}, gitShowImpl = async () => SCRIPT, bootSha = SHA } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { decorate(req); next(); });
  const service = createPairingService({
    fetchImpl: fake?.fetchImpl ?? (async () => { throw new TypeError("fetch failed"); }),
    whoisImpl: async () => null,
    identityFn: () => fakeIdentity(),
    instanceIdFn: () => "inst-primary",
    primaryUrlFn: async () => "https://crow.example.ts.net:8444",
    targetShaFn: () => SHA,
  });
  app.use(satellitesRouter({
    dbFactory: () => new Proxy(db, { get: (t, k) => (k === "close" ? () => {} : Reflect.get(t, k)) }),
    sessionGate: (req, _res, next) => next(),
    ownerCheck: async () => owner,
    service,
    installOpts: { gitShowImpl, bootShaFn: () => bootSha },
  }));
  return new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
}

function call(server, method, path, body, extraHeaders = {}) {
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port: server.address().port, path, method,
      headers: { ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}), ...extraHeaders },
    }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => { let json = null; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, json }); });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function withServer(opts, fn) {
  const s = await start(opts);
  try { return await fn(s); } finally { s.close(); }
}

const ROUTES = [
  ["GET", "/api/satellites"],
  ["POST", "/api/satellites/pair/start", { host: FAKE_HOST }],
  ["POST", "/api/satellites/pair/complete", { pairing_id: "0".repeat(32), code: CODE, name: "x" }],
  ["POST", "/api/satellites/sat_aaaaaaaaaaaaaaaaaaaa/unpair", {}],
  ["GET", "/api/satellites/install-command"],
  ["GET", "/API/Satellites/"],
];

test("non-owner, signed peer, instance peer: 403 on every route, no network", async () => {
  const db = await freshDb();
  const fake = createFakeSatellite({ code: CODE });
  const cases = [
    { owner: false },
    { decorate: (req) => { req.crossHostAuth = { instance: "peer" }; } },
    { decorate: (req) => { req.instanceAuth = { instance: { id: "peer" } }; } },
  ];
  for (const c of cases) {
    await withServer({ db, fake, ...c }, async (s) => {
      for (const [m, p, b] of ROUTES) {
        const r = await call(s, m, p, b);
        assert.equal(r.status, 403, `${m} ${p}`);
        assert.equal(r.json.error, "owner_only");
      }
    });
  }
  assert.equal(fake.state.requests.length, 0);
});

test("owner: start, complete, list, unpair through the routes", async () => {
  const db = await freshDb();
  const fake = createFakeSatellite({ code: CODE });
  await withServer({ db, fake }, async (s) => {
    const st = await call(s, "POST", "/api/satellites/pair/start", { host: FAKE_HOST });
    assert.equal(st.status, 200);
    assert.equal(st.json.satellite_id, fake.satId);
    assert.deepEqual(st.json.whois, { unknown: true });
    const bad = await call(s, "POST", "/api/satellites/pair/complete", { pairing_id: st.json.pairing_id, code: P.generatePairCode().code, name: "x" });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error, "pairing_refused");
    const st2 = await call(s, "POST", "/api/satellites/pair/start", { host: FAKE_HOST });
    const ok = await call(s, "POST", "/api/satellites/pair/complete", { pairing_id: st2.json.pairing_id, code: CODE, name: "Office" });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    const list = await call(s, "GET", "/api/satellites");
    assert.equal(list.status, 200);
    assert.equal(list.json.satellites.length, 1);
    const one = list.json.satellites[0];
    assert.equal(one.id, fake.satId);
    assert.equal(one.status, "active");
    assert.equal(one.fingerprint, P.formatFingerprint(fake.satId));
    assert.equal("cert_json" in one, false);
    const un = await call(s, "POST", `/api/satellites/${fake.satId}/unpair`, { reason: "owner" });
    assert.equal(un.status, 200);
    assert.equal(un.json.reached, true);
    const bogus = await call(s, "POST", "/api/satellites/not-an-id/unpair", {});
    assert.equal(bogus.status, 400);
  });
});

test("not migrated: list is empty, writers answer 503 not_migrated", async () => {
  const db = await freshDb(false);
  const fake = createFakeSatellite({ code: CODE });
  await withServer({ db, fake }, async (s) => {
    const list = await call(s, "GET", "/api/satellites");
    assert.equal(list.status, 200);
    assert.deepEqual(list.json.satellites, []);
    const st = await call(s, "POST", "/api/satellites/pair/start", { host: FAKE_HOST });
    const c = await call(s, "POST", "/api/satellites/pair/complete", { pairing_id: st.json.pairing_id, code: CODE, name: "x" });
    assert.equal(c.status, 503);
    assert.equal(c.json.error, "not_migrated");
    const u = await call(s, "POST", `/api/satellites/${fake.satId}/unpair`, {});
    assert.equal(u.status, 503);
    assert.equal(u.json.error, "not_migrated");
  });
});

test("install command: built from the one repo constant, crow's boot sha and the script's sha256", async () => {
  assert.equal(SATELLITE_REPO, "kh0pper/crow");
  const db = await freshDb();
  const sum = createHash("sha256").update(SCRIPT).digest("hex");
  let asked = null;
  await withServer({ db, gitShowImpl: async (sha, path) => { asked = [sha, path]; return SCRIPT; } }, async (s) => {
    const r = await call(s, "GET", "/api/satellites/install-command");
    assert.equal(r.status, 200);
    assert.deepEqual(asked, [SHA, "scripts/satellite-install.sh"]);
    assert.equal(r.json.sha, SHA);
    assert.equal(r.json.sha256, sum);
    assert.equal(r.json.command,
      `curl -fsSL https://raw.githubusercontent.com/${SATELLITE_REPO}/${SHA}/scripts/satellite-install.sh -o satellite-install.sh\n` +
      `echo "${sum}  satellite-install.sh" | sha256sum -c - && bash satellite-install.sh --sha ${SHA}`);
  });
  await withServer({ db, gitShowImpl: async () => null }, async (s) => {
    const r = await call(s, "GET", "/api/satellites/install-command");
    assert.equal(r.status, 404);
    assert.equal(r.json.error, "not_available");
  });
  await withServer({ db, bootSha: null }, async (s) => {
    const r = await call(s, "GET", "/api/satellites/install-command");
    assert.equal(r.status, 404);
  });
  // A different repo constant would flow through: the builder takes it as data, not a literal.
  const built = await buildInstallCommand({ sha: SHA, gitShowImpl: async () => SCRIPT, repo: "example-org/crow" });
  assert.match(built.command, /raw\.githubusercontent\.com\/example-org\/crow\//);
});

test("CSRF: a session-cookie POST without the matching header is refused before any network", async () => {
  const db = await freshDb();
  const fake = createFakeSatellite({ code: CODE });
  await withServer({ db, fake }, async (s) => {
    const cookie = "crow_session=sess; crow_csrf=tok123";
    const no = await call(s, "POST", "/api/satellites/pair/start", { host: FAKE_HOST }, { cookie });
    assert.equal(no.status, 403);
    assert.equal(fake.state.requests.length, 0);
    const yes = await call(s, "POST", "/api/satellites/pair/start", { host: FAKE_HOST }, { cookie, "x-crow-csrf": "tok123" });
    assert.equal(yes.status, 200);
  });
});

test("the gateway mounts the satellites router", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../servers/gateway/boot/feature-mounts.js", import.meta.url), "utf8");
  assert.ok(src.includes('await import("../routes/satellites.js")'));
  assert.ok(src.includes("app.use(satellitesRouter());"));
});
