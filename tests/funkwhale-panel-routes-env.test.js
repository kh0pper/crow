/**
 * The Funkwhale panel's routes read the ADD-ON's settings (url, token, hostname) instead of the
 * gateway process environment, and no response body ever carries the token.
 *
 * The router is mounted on a throwaway express app with a pass-through auth and an injected
 * settings reader; global fetch is replaced by a recorder, so every upstream request this test
 * talks about is one the route actually made (the test's own call to the mounted app is handed
 * to the real fetch).
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// The panel routes resolve the gateway's modules from the app root; a checkout is the app root.
process.env.CROW_APP_ROOT = ROOT;

const { default: funkwhaleRouter } = await import("../bundles/funkwhale/panel/routes.js");
const { readFunkwhaleEnv } = await import("../servers/gateway/routes/audio-proxy.js");

const TOKEN = "SECRET-TOKEN";
const FW = { url: "http://fw.invalid", token: TOKEN, hostname: "music.example" };
const ENV_KEYS = ["FUNKWHALE_URL", "FUNKWHALE_ACCESS_TOKEN", "FUNKWHALE_HOSTNAME"];

const realFetch = globalThis.fetch;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

after(() => {
  globalThis.fetch = realFetch;
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function clearFunkwhaleEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}

/** A response shaped like the one the routes consume. */
function jsonResponse(value) {
  const text = JSON.stringify(value);
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers({ "content-type": "application/json" }),
    text: async () => text,
    json: async () => JSON.parse(text),
    body: null,
  };
}

/**
 * Replaces global fetch: upstream requests are recorded and answered by `answer`, the test's own
 * requests to the mounted app go to the real fetch.
 */
function stubFetch(answer) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    if (target.startsWith("http://127.0.0.1:")) return realFetch(url, init);
    calls.push({ url: target, headers: new Headers(init.headers || {}) });
    return answer(target, init);
  };
  return calls;
}

/** Mounts the router with a pass-through auth and hands the test a GET helper. */
async function withApp(fwEnv, run) {
  const app = express();
  app.use(funkwhaleRouter((_req, _res, next) => next(), { fwEnv }));
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const { port } = server.address();
  const get = (path) => realFetch(`http://127.0.0.1:${port}${path}`);
  try {
    return await run({ get });
  } finally {
    server.close();
    server.closeAllConnections?.();
  }
}

test("every read route calls the add-on's address with the add-on's token, and no body carries it", async () => {
  clearFunkwhaleEnv();
  const calls = stubFetch(() => jsonResponse({ count: 0, results: [] }));

  await withApp(() => FW, async ({ get }) => {
    const routes = [
      { path: "/api/funkwhale/status", upstream: "/api/v1/users/me/" },
      { path: "/api/funkwhale/libraries", upstream: "/api/v1/libraries/" },
      { path: "/api/funkwhale/listens", upstream: "/api/v1/history/listenings/" },
      { path: "/api/funkwhale/browse/artists", upstream: "/api/v1/artists/" },
      { path: "/api/funkwhale/search?q=ab", upstream: "/api/v1/search" },
    ];
    for (const route of routes) {
      calls.length = 0;
      const res = await get(route.path);
      const text = await res.text();
      assert.ok(res.status < 500, `${route.path} answered ${res.status}: ${text}`);
      assert.ok(!text.includes(TOKEN), `${route.path} sent the token in its body`);

      const expected = `http://fw.invalid${route.upstream}`;
      const call = calls.find((c) => c.url === expected || c.url.startsWith(`${expected}?`));
      assert.ok(call, `${route.path} did not reach ${expected} — saw ${calls.map((c) => c.url).join(", ")}`);
      assert.equal(call.headers.get("authorization"), `Bearer ${TOKEN}`, `${route.path} sent no bearer`);
    }
  });

  await withApp(() => FW, async ({ get }) => {
    const res = await get("/api/funkwhale/status");
    const body = await res.json();
    assert.equal(body.hostname, "music.example", "the status body shows the add-on's hostname");
    assert.ok(!JSON.stringify(body).includes(TOKEN));
  });
});

test("an upstream error that repeats the token still reaches the browser without it", async () => {
  clearFunkwhaleEnv();
  stubFetch(() => { throw new Error(`upstream refused Authorization: Bearer ${TOKEN}`); });

  await withApp(() => FW, async ({ get }) => {
    for (const path of ["/api/funkwhale/browse/artists", "/api/funkwhale/libraries", "/api/funkwhale/search?q=ab"]) {
      const res = await get(path);
      const text = await res.text();
      assert.ok(!text.includes(TOKEN), `${path} echoed the token: ${text}`);
      const body = JSON.parse(text);
      assert.ok(body.error, `${path} answered with an error the panel can show`);
      assert.ok(!body.error.includes(TOKEN));
      assert.ok(!/Bearer\s+SECRET/i.test(body.error), `${path} echoed a bearer value`);
    }
  });
});

test("with no add-on settings and no env the routes answer, they do not crash", async () => {
  clearFunkwhaleEnv();
  const calls = stubFetch(() => jsonResponse({ software: { name: "funkwhale" } }));

  await withApp(() => null, async ({ get }) => {
    const artists = await get("/api/funkwhale/browse/artists");
    assert.equal(artists.status, 503);
    assert.match(await artists.text(), /error/);

    const libraries = await get("/api/funkwhale/libraries");
    assert.equal(libraries.status, 200);
    assert.match((await libraries.json()).error, /FUNKWHALE_ACCESS_TOKEN/);

    const search = await get("/api/funkwhale/search?q=ab");
    assert.equal(search.status, 503);

    const status = await get("/api/funkwhale/status");
    assert.equal(status.status, 200);
    assert.ok(!(await status.text()).includes(TOKEN));
  });

  // The compose default is still where an unconfigured run looks.
  assert.ok(
    calls.some((c) => c.url === "http://funkwhale-api:5000/api/v1/instance/nodeinfo/2.0/"),
    `saw ${calls.map((c) => c.url).join(", ")}`,
  );
});

test("a settings reader that cannot be read falls back to this process's env", async () => {
  process.env.FUNKWHALE_URL = "http://env.invalid/";
  process.env.FUNKWHALE_ACCESS_TOKEN = "env-token";
  process.env.FUNKWHALE_HOSTNAME = "env.example";
  const calls = stubFetch(() => jsonResponse({ count: 0, results: [] }));

  await withApp(() => { throw new Error("addon entry unreadable"); }, async ({ get }) => {
    const res = await get("/api/funkwhale/libraries");
    assert.equal(res.status, 200);
    assert.ok(!(await res.text()).includes("env-token"), "a token never reaches a body");
  });

  const call = calls.find((c) => c.url.startsWith("http://env.invalid/api/v1/libraries/"));
  assert.ok(call, `saw ${calls.map((c) => c.url).join(", ")}`);
  assert.equal(call.headers.get("authorization"), "Bearer env-token");
});

test("readFunkwhaleEnv carries the hostname saved with the add-on", () => {
  const home = mkdtempSync(join(tmpdir(), "crow-funkwhale-env-"));
  writeFileSync(join(home, "mcp-addons.json"), JSON.stringify({
    funkwhale: {
      env: {
        FUNKWHALE_URL: "http://fw.local/",
        FUNKWHALE_ACCESS_TOKEN: "LOCAL-TOKEN",
        FUNKWHALE_HOSTNAME: "music.example",
      },
    },
  }));

  const fw = readFunkwhaleEnv(home);
  assert.equal(fw.url, "http://fw.local", "the trailing slash is trimmed, as before");
  assert.equal(fw.token, "LOCAL-TOKEN");
  assert.equal(fw.hostname, "music.example");

  const without = mkdtempSync(join(tmpdir(), "crow-funkwhale-env-plain-"));
  writeFileSync(join(without, "mcp-addons.json"), JSON.stringify({
    funkwhale: { env: { FUNKWHALE_URL: "http://fw.local", FUNKWHALE_ACCESS_TOKEN: "LOCAL-TOKEN" } },
  }));
  assert.equal(readFunkwhaleEnv(without).hostname, "", "an entry with no hostname answers with an empty label");
});