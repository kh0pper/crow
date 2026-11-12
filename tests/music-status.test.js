/**
 * GET /api/music/status — the gateway's own answer to "is there a library?".
 *
 * The Music panel used to ask /api/funkwhale/status, which only exists while the
 * Funkwhale PANEL is registered: on an instance with the add-on installed and
 * configured but its panel not mounted, the panel concluded there was no library.
 * This route lives in the gateway and reads the addon env the gateway already has.
 *
 * The body is one word and nothing else — the address and the token must never
 * reach the browser, so the raw response text is asserted, not only the JSON.
 * Rendered pages would spin up a real server; here the router is mounted on a
 * throwaway express app with every dependency injected, so nothing is reached.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import musicStatusRouter from "../servers/gateway/routes/music-status.js";
import { readFunkwhaleEnv } from "../servers/gateway/routes/audio-proxy.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FW = { url: "http://fw.invalid", token: "SECRET-TOKEN" };

/** A dashboard session gate that answers JSON, like the gateway's. */
function dashboardAuth(req, res, next) {
  if (!req.headers["x-auth"]) return res.status(401).json({ error: "auth_required" });
  next();
}

/** Mounts the router on a throwaway app and hands the test a GET helper. */
async function withApp(deps, run) {
  const app = express();
  app.use(musicStatusRouter(dashboardAuth, deps));
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const { port } = server.address();
  const get = (headers = {}) => fetch(`http://localhost:${port}/api/music/status`, { headers });
  try {
    return await run({ get });
  } finally {
    server.close();
  }
}

/** An upstream answer shaped the way the route reads one. */
const upstream = (status) => ({ ok: status >= 200 && status < 300, status });

test("the route is behind dashboard auth", async () => {
  const fetchImpl = async () => upstream(200);
  await withApp({ fwEnv: () => FW, fetchImpl }, async ({ get }) => {
    assert.equal((await get()).status, 401, "no session, no answer");
    assert.equal((await get({ "x-auth": "1" })).status, 200, "with a session the route answers");
  });
});

test("a reachable library answers ready, and neither the token nor the address is in the body", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return upstream(200); };
  await withApp({ fwEnv: () => FW, fetchImpl }, async ({ get }) => {
    const res = await get({ "x-auth": "1" });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const text = await res.text();
    assert.deepEqual(JSON.parse(text), { state: "ready" }, "exactly one key");
    assert.ok(!text.includes("SECRET-TOKEN"), "the token is not echoed back");
    assert.ok(!text.toLowerCase().includes("fw.invalid"), "nor the address");

    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.endsWith("/api/v1/instance/nodeinfo/2.0/"), "NodeInfo is what is probed");
    assert.equal(calls[0].init?.headers, undefined, "no Authorization header is sent");
    assert.equal(calls[0].init?.redirect, "manual");
    assert.ok(calls[0].init?.signal, "the probe can time out");
  });
});

test("an upstream error status is unreachable", async () => {
  await withApp({ fwEnv: () => FW, fetchImpl: async () => upstream(500) }, async ({ get }) => {
    const res = await get({ "x-auth": "1" });
    assert.equal(res.status, 200, "a library that is down is not an HTTP error");
    assert.deepEqual(await res.json(), { state: "unreachable" });
  });
});

test("an upstream fetch that throws is unreachable", async () => {
  const fetchImpl = async () => { throw new Error("connect ECONNREFUSED"); };
  await withApp({ fwEnv: () => FW, fetchImpl }, async ({ get }) => {
    const res = await get({ "x-auth": "1" });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.deepEqual(JSON.parse(text), { state: "unreachable" });
    assert.ok(!text.includes("ECONNREFUSED"), "the driver error stays on the server");
  });
});

test("no Funkwhale entry is not_configured", async () => {
  let probed = false;
  const fetchImpl = async () => { probed = true; return upstream(200); };
  await withApp({ fwEnv: () => null, fetchImpl }, async ({ get }) => {
    const res = await get({ "x-auth": "1" });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { state: "not_configured" });
    assert.equal(probed, false, "nothing is probed when nothing is configured");
  });
});

test("an entry that cannot be read is not_configured, not a 500", async () => {
  const fetchImpl = async () => upstream(200);
  await withApp({ fwEnv: () => { throw new Error("addon entry unreadable"); }, fetchImpl }, async ({ get }) => {
    const res = await get({ "x-auth": "1" });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { state: "not_configured" });
  });
});

test("readFunkwhaleEnv drives the route end to end: configured answers ready, an empty home not_configured", async () => {
  const configured = mkdtempSync(join(tmpdir(), "crow-music-status-"));
  const empty = mkdtempSync(join(tmpdir(), "crow-music-status-empty-"));
  try {
    writeFileSync(join(configured, "mcp-addons.json"), JSON.stringify({
      funkwhale: { env: { FUNKWHALE_URL: "http://fw.invalid/", FUNKWHALE_ACCESS_TOKEN: "T" } },
    }));

    const urls = [];
    const fetchImpl = async (url) => { urls.push(url); return upstream(200); };

    await withApp({ fwEnv: () => readFunkwhaleEnv(configured), fetchImpl }, async ({ get }) => {
      const res = await get({ "x-auth": "1" });
      assert.deepEqual(await res.json(), { state: "ready" });
      assert.equal(urls[0], "http://fw.invalid/api/v1/instance/nodeinfo/2.0/",
        "the trailing slash of the saved URL is not doubled");
    });

    await withApp({ fwEnv: () => readFunkwhaleEnv(empty), fetchImpl }, async ({ get }) => {
      const res = await get({ "x-auth": "1" });
      assert.deepEqual(await res.json(), { state: "not_configured" });
    });
  } finally {
    rmSync(configured, { recursive: true, force: true });
    rmSync(empty, { recursive: true, force: true });
  }
});

test("the route file and this test file end with exactly one newline", () => {
  for (const path of [join(ROOT, "servers/gateway/routes/music-status.js"), join(ROOT, "tests/music-status.test.js")]) {
    const text = readFileSync(path, "utf8");
    assert.ok(text.endsWith("\n"), `${path} ends with a newline`);
    assert.ok(!text.endsWith("\n\n"), `${path} ends with only one`);
  }
});
