// Crow Artifacts — the panel routes: owner session + CSRF on every write, view
// tokens bound to the dashboard Origin, flagged versions not re-framed, the
// tripwire report flags + revokes (spec §5.1, §7.2).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import express from "express";
import { createDbClient } from "../servers/db.js";
import { markdownBlocks } from "../servers/blog/renderer.js";
import { csrfMiddleware } from "../servers/gateway/dashboard/shared/csrf.js";
import * as runtime from "../servers/gateway/artifact-origin/runtime.js";
import * as policy from "../servers/gateway/artifact-origin/policy.js";
import { createLocalBlobStore } from "../bundles/artifacts/server/blob-store.js";
import { initArtifactsTables } from "../bundles/artifacts/server/init-tables.js";
import * as store from "../bundles/artifacts/server/store.js";
import artifactsRouter from "../bundles/artifacts/panel/routes.js";

const s = { notes: [] };
before(async () => {
  s.dir = mkdtempSync(join(tmpdir(), "artifacts-routes-"));
  s.db = createDbClient(join(s.dir, "crow.db"));
  await initArtifactsTables(s.db);
  s.blobs = createLocalBlobStore(join(s.dir, "blobs"));
  runtime._resetForTest();
  runtime._setInfoForTest({ baseUrl: "https://artifacts.example.ts.net", port: 0, configured: true });
  const dashboardAuth = (req, res, next) => (/crow_session=good/.test(req.headers.cookie || "") ? next() : res.status(401).json({ error: "login" }));
  const app = express();
  app.use(artifactsRouter(dashboardAuth, {
    db: s.db, blobs: s.blobs, runtime, policy, csrf: csrfMiddleware, renderDeps: { markdownBlocks },
    notify: async (n) => s.notes.push(n),
  }));
  s.http = app.listen(0, "127.0.0.1"); await new Promise((r) => s.http.once("listening", r));
  s.port = s.http.address().port;
  s.host = `127.0.0.1:${s.port}`;
  s.art = await store.createArtifact(s.db, s.blobs, { title: "Page", type: "page", source: { html: "<p>x</p>" }, actor: { kind: "bot", id: "bobby" } }, {});
});
after(() => { s.http.close(); runtime._resetForTest(); try { s.db.close(); } catch {} rmSync(s.dir, { recursive: true, force: true }); });

function req(method, path, { body, cookie = "crow_session=good; crow_csrf=tok", csrf = "tok", origin = `http://${s.host}` } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(csrf ? { "x-crow-csrf": csrf } : {}), ...(origin ? { origin } : {}) };
    const r = http.request({ host: "127.0.0.1", port: s.port, path, method, headers }, (res) => {
      let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode, body: j }); });
    });
    r.on("error", reject); if (data) r.write(data); r.end();
  });
}

test("no session → 401 on every route; a write without the CSRF header → 403", async () => {
  for (const [m, p] of [["GET", "/api/artifacts"], ["POST", `/api/artifacts/${s.art.id}/versions/1/view`], ["POST", `/api/artifacts/${s.art.id}/versions/1/approve`], ["POST", `/api/artifacts/${s.art.id}/versions/1/tripwire`]]) {
    assert.equal((await req(m, p, { cookie: null })).status, 401, `${m} ${p}`);
  }
  assert.equal((await req("POST", `/api/artifacts/${s.art.id}/versions/1/tripwire`, { body: { reason: "second-load" }, csrf: null })).status, 403);
  assert.equal((await req("POST", `/api/artifacts/${s.art.id}/versions/1/tripwire`, { body: { reason: "second-load" }, csrf: "wrong" })).status, 403);
});

test("view tokens: bound to the declared dashboard Origin (must match Host); grant shape matches the type", async () => {
  const ok = await req("POST", `/api/artifacts/${s.art.id}/versions/1/view`);
  assert.equal(ok.status, 200);
  assert.match(ok.body.url, /^https:\/\/artifacts\.example\.ts\.net\/v\/[A-Za-z0-9_-]{43}\/$/);
  assert.equal(ok.body.sandbox, "allow-scripts");
  assert.equal(ok.body.scripted, true);
  assert.equal(ok.body.isolation, "own-host");
  const token = ok.body.url.split("/v/")[1].slice(0, 43);
  assert.equal(runtime.viewTokens().check(token).dashboardOrigin, `http://${s.host}`);
  assert.equal((await req("POST", `/api/artifacts/${s.art.id}/versions/1/view`, { origin: "https://evil.example" })).status, 403);
  assert.equal((await req("POST", `/api/artifacts/${s.art.id}/versions/1/view`, { origin: null })).status, 403);
  assert.equal((await req("POST", `/api/artifacts/nope/versions/1/view`)).status, 404);
});

test("tripwire report: flags the version, revokes live tokens, notifies; the flagged version is not re-framed", async () => {
  const ok = await req("POST", `/api/artifacts/${s.art.id}/versions/1/view`);
  const token = ok.body.url.split("/v/")[1].slice(0, 43);
  const r = await req("POST", `/api/artifacts/${s.art.id}/versions/1/tripwire`, { body: { reason: "second-load" } });
  assert.equal(r.status, 200);
  assert.equal(runtime.viewTokens().check(token), null, "revoked");
  assert.equal(s.notes.length, 1);
  assert.equal((await req("POST", `/api/artifacts/${s.art.id}/versions/1/view`)).status, 409);
  const audit = (await s.db.execute({ sql: "SELECT action FROM artifact_audit WHERE artifact_id=? AND action='tripwire'", args: [s.art.id] })).rows;
  assert.equal(audit.length, 1);
});

test("static allow-list: the three exact names serve; prototype keys, traversal and unknown names are 404 (review L1)", async () => {
  for (const f of ["viewer.js", "panel-client.js", "panel.css"]) {
    assert.equal((await req("GET", `/artifacts/static/${f}`)).status, 200, f);
  }
  for (const f of ["__proto__", "constructor", "toString", "nope.js", "..%2fmanifest.json", "..%2f..%2fpackage.json", "viewer.js%00.png"]) {
    assert.equal((await req("GET", `/artifacts/static/${f}`)).status, 404, f);
  }
});

test("D20: a tainted page version mints script-free until the owner approves it", async () => {
  const v = await store.addVersion(s.db, s.blobs, { artifactId: s.art.id, source: { html: "<p>shaped by a contact</p>" }, actor: { kind: "session" }, untrusted: true }, {});
  const off = await req("POST", `/api/artifacts/${s.art.id}/versions/${v.n}/view`);
  assert.equal(off.status, 200);
  assert.deepEqual([off.body.sandbox, off.body.scripted, off.body.scriptsOff], ["", false, true]);
  assert.equal((await req("POST", `/api/artifacts/${s.art.id}/versions/${v.n}/approve`)).body.approved, true);
  const on = await req("POST", `/api/artifacts/${s.art.id}/versions/${v.n}/view`);
  assert.deepEqual([on.body.sandbox, on.body.scripted, on.body.scriptsOff], ["allow-scripts", true, false]);
});
