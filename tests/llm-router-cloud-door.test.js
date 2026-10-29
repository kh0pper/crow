// tests/llm-router-cloud-door.test.js — the cloud door /llm/c (roles phase 2,
// Task 16). A loopback-only, token-gated forwarder for cloud provider rows this
// box consented to; the real key is added inside the gateway, on the upstream
// leg only.
//
// The fake upstream listens on 127.0.0.1 but is addressed by the NAME
// up.example.test. The seams are narrow: `lookupFn` answers 127.0.0.1 for the
// test names only, and safeRequest's address check is told to accept exactly
// that answer for the two fake upstream names (`allowAddressFn`). Every other
// name and every literal goes through the real checks.
process.env.COMPANION_FAST_MODEL = "crow-voice/qwen3.5-4b";
process.env.COMPANION_ESCALATION_MODEL = "crow-chat/qwen3.6-35b-a3b";

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import zlib from "node:zlib";
import express from "express";
import llmRouterRouter from "../servers/gateway/routes/llm-router.js";
import {
  resolveCloudTarget, isCloudTarget as realIsCloudTarget, CLOUD_OPS, REQUEST_HEADER_ALLOW, RESPONSE_HEADER_ALLOW,
} from "../servers/gateway/models/cloud-door.js";
import { cloudDoorUrl } from "../servers/gateway/models/door.js";
import { extractUsageFromAnthropicStream, recordUsageEvent } from "../servers/shared/metering.js";
import { readFileSync } from "node:fs";
import { isLocalPeer } from "../servers/shared/peer-class.js";
import { grantCloudConsent, readCloudConsent, readCloudConsentSalt, ensureCloudConsentSalt, CLOUD_CONSENT_KEY } from "../servers/shared/cloud-consent.js";
import { normalizeBaseUrl } from "../servers/shared/provider-presets.js";

const UP_KEY = "fixture-up-key";
const UP_KEY_B = "fixture-up-key-b";
const DOOR_TOKEN = "fixture-cloud-door-token";

// ---------------------------------------------------------------- fakes

/** An in-memory stand-in for the two tables cloud-consent.js touches. */
function fakeDb(rows) {
  const settings = new Map();
  const raw = (id) => {
    const p = rows[id];
    if (!p) return null;
    return {
      id, base_url: p.baseUrl, api_key: p.apiKey ?? null, host: "cloud", bundle_id: null,
      provider_type: p.provider_type ?? null, description: null, models: JSON.stringify(p.models || []),
      gpu_policy: p.gpuPolicy ? JSON.stringify(p.gpuPolicy) : null, disabled: p.disabled ? 1 : 0,
    };
  };
  return {
    settings,
    async execute({ sql, args = [] }) {
      if (/FROM providers WHERE id = \?/.test(sql)) { const r = raw(args[0]); return { rows: r ? [r] : [] }; }
      if (/^SELECT value FROM dashboard_settings/.test(sql)) return { rows: settings.has(args[0]) ? [{ value: settings.get(args[0]) }] : [] };
      if (/INSERT OR IGNORE INTO dashboard_settings/.test(sql)) { if (!settings.has(args[0])) settings.set(args[0], args[1]); return { rows: [] }; }
      if (/INSERT INTO dashboard_settings/.test(sql)) { settings.set(args[0], args[1]); return { rows: [] }; }
      throw new Error(`fakeDb: unexpected sql ${sql}`);
    },
  };
}

let up, up2, upPort, up2Port, hits, up2Hits, upHandler;
let srv, appUrl, remote, rows, db, usage, logs;
const origLog = { log: console.log, warn: console.warn, error: console.error };

const lookupFn = (host, opts, cb) => {
  if (typeof opts === "function") { cb = opts; opts = {}; }
  if (["up.example.test", "up2.example.test", "internal.example.com"].includes(host)) {
    return opts && opts.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4);
  }
  cb(Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" }));
};
// The two fake upstream names, and only their one answer. internal.example.com
// is NOT allowed: its loopback answer must hit the real refusal.
const allowAddressFn = (name, addr) => (name === "up.example.test" || name === "up2.example.test") && addr === "127.0.0.1";
const isCloudTargetFn = (u) => u.startsWith("http://up.example.test:") || realIsCloudTarget(u);
// The fake upstreams speak plain http; every other http row meets the real https rule.
const allowInsecureFn = (u) => u.startsWith("http://up.example.test:") || u.startsWith("http://up2.example.test:");

function readBody(req) {
  return new Promise((resolve) => { let b = ""; req.on("data", (c) => { b += c; }); req.on("end", () => resolve(b)); });
}

function baseRows() {
  return {
    "cloud-a": { baseUrl: `http://up.example.test:${upPort}/v1`, apiKey: UP_KEY, provider_type: "openai", models: [{ id: "c1" }, { id: "e1" }] },
    "cloud-b": { baseUrl: `http://up.example.test:${upPort}`, apiKey: UP_KEY_B, provider_type: "anthropic", models: [{ id: "m-b" }] },
    "Cloud A": { baseUrl: `http://up.example.test:${upPort}/v1`, apiKey: UP_KEY, provider_type: "openai", models: [{ id: "c1" }] },
    "cloud-n": { baseUrl: "https://internal.example.com/v1", apiKey: UP_KEY, provider_type: "openai", models: [{ id: "c1" }] },
    "cloud-r": { baseUrl: `http://up.example.test:${upPort}/redir/v1`, apiKey: UP_KEY, provider_type: "openai", models: [{ id: "c1" }] },
    "cloud-p": { baseUrl: `http://up.example.test:${upPort}/v1`, apiKey: UP_KEY, provider_type: "openai", models: [{ id: "c1" }] },
    "cloud-nokey": { baseUrl: `http://up.example.test:${upPort}/v1`, apiKey: "", provider_type: "openai", models: [{ id: "c1" }] },
    "cloud-lo": { baseUrl: `http://up.example.test:${upPort}/v1`, apiKey: UP_KEY, provider_type: "openai", models: [{ id: "c1" }], gpuPolicy: { local_only: true } },
    "cloud-off": { baseUrl: `http://up.example.test:${upPort}/v1`, apiKey: UP_KEY, provider_type: "openai", models: [{ id: "c1" }], disabled: true },
    "lit-0": { baseUrl: `http://0.0.0.0:${upPort}/v1`, apiKey: UP_KEY, provider_type: "openai", models: [{ id: "c1" }] },
    "lit-6": { baseUrl: `http://[::]:${upPort}/v1`, apiKey: UP_KEY, provider_type: "openai", models: [{ id: "c1" }] },
    "lit-64": { baseUrl: `http://[64:ff9b::7f00:1]:${upPort}/v1`, apiKey: UP_KEY, provider_type: "openai", models: [{ id: "c1" }] },
    "meta": { baseUrl: "http://169.254.169.254/v1", apiKey: UP_KEY, provider_type: "openai", models: [{ id: "c1" }] },
    "local-chat": { baseUrl: "http://127.0.0.1:8003/v1", apiKey: UP_KEY, provider_type: "openai", models: [{ id: "c1" }] },
    "cloud-h": { baseUrl: "http://api.example.com/v1", apiKey: UP_KEY, provider_type: "openai", models: [{ id: "c1" }] },
  };
}

/** Consent through the real grant (the URL and key this box "just wrote"). */
async function grant(id) {
  const r = await grantCloudConsent(db, id, { actor: "test", expect: { baseUrl: rows[id].baseUrl, apiKey: rows[id].apiKey } });
  assert.equal(r.ok, true, `grant ${id}: ${r.reason}`);
}
/** Consent for a row the real grant refuses (literal, metadata, local): the
 * entry a grant would write had the row been accepted, so the door's OWN
 * checks are what refuse it. */
async function forceConsent(id) {
  const shadow = `${id}--shadow`;
  rows[shadow] = { ...rows[id], baseUrl: "https://api.example.com/v1" };
  await grant(shadow);
  const map = await readCloudConsent(db);
  map[id] = { ...map[shadow], target: normalizeBaseUrl(rows[id].baseUrl) };
  delete map[shadow];
  delete rows[shadow];
  db.settings.set(CLOUD_CONSENT_KEY, JSON.stringify(map));
}

function makeRouter(extra = {}) {
  const opts = {
    acquireFn: async () => true,
    resolveKeyFn: async () => { throw new Error("not used"); },
    probeReadyFn: async () => true,
    loadProvidersFn: () => ({ providers: {} }),
    remoteAddressFn: () => remote,
    doorAuthFn: async () => false,
    recordUsageFn: async (e) => { usage.push(e); },
    cloudTokenAuthFn: async (t) => t === DOOR_TOKEN,
    cloudProvidersFn: async (id) => (rows[id] ? { [id]: { id, ...rows[id] } } : {}),
    consentFn: async () => ({ consent: await readCloudConsent(db), salt: await readCloudConsentSalt(db) }),
    isCloudTargetFn,
    allowInsecureFn,
    lookupFn,
    allowAddressFn,
    ...extra,
  };
  // An explicit undefined means "use the router's real default".
  for (const k of Object.keys(opts)) if (opts[k] === undefined) delete opts[k];
  return llmRouterRouter(opts);
}

before(async () => {
  up = http.createServer(async (req, res) => {
    const body = await readBody(req);
    hits.push({ method: req.method, url: req.url, headers: req.headers, body });
    if (upHandler) return upHandler(req, res, body);
    res.writeHead(200, { "content-type": "application/json", "x-ratelimit-remaining-requests": "41", "set-cookie": "s=1", "x-internal": "no" });
    res.end(JSON.stringify({ ok: true, echo: body ? JSON.parse(body) : null }));
  });
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  upPort = up.address().port;
  up2 = http.createServer((req, res) => { up2Hits++; res.end("{}"); });
  await new Promise((r) => up2.listen(0, "127.0.0.1", r));
  up2Port = up2.address().port;

  const app = express();
  app.use(makeRouter());
  srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  appUrl = `http://127.0.0.1:${srv.address().port}`;
});
after(() => { srv?.close(); up?.close(); up2?.close(); Object.assign(console, origLog); });

beforeEach(async () => {
  hits = []; up2Hits = 0; upHandler = null; usage = []; remote = "127.0.0.1"; logs = [];
  rows = baseRows();
  db = fakeDb(rows);
  await ensureCloudConsentSalt(db);
  for (const id of ["cloud-a", "cloud-b", "Cloud A", "cloud-n", "cloud-r", "cloud-nokey", "cloud-lo", "cloud-h"]) await grant(id);
  for (const id of ["lit-0", "lit-6", "lit-64", "meta", "local-chat"]) await forceConsent(id);
  // Capture every log line: the real key must never appear in one.
  for (const k of ["log", "warn", "error"]) console[k] = (...a) => { logs.push(a.map(String).join(" ")); };
});

/** A raw request (so the test controls hop-by-hop headers fetch would forbid). */
function call(path, { body = { model: "c1", messages: [{ role: "user", content: "hi" }] }, headers = {}, base = appUrl, raw } = {}) {
  const u = new URL(base + path);
  const payload = raw ?? JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: "POST",
      headers: Object.fromEntries(Object.entries({ "content-type": "application/json", authorization: `Bearer ${DOOR_TOKEN}`, ...headers }).filter(([, v]) => v !== undefined)),
    }, (res) => {
      const parts = [];
      res.on("data", (c) => { parts.push(c); });
      const out = (extra) => { const buf = Buffer.concat(parts); const b = buf.toString("utf8"); return { status: res.statusCode, headers: res.headers, buf, body: b, json() { return JSON.parse(b); }, ...extra }; };
      res.on("end", () => resolve(out()));
      res.on("error", (e) => resolve(out({ aborted: e })));
    });
    req.on("error", reject);
    req.end(payload);
  });
}

function assertNoKeyAnywhere(r) {
  for (const k of [UP_KEY, UP_KEY_B]) {
    assert.ok(!r.body.includes(k), "key in the response body");
    assert.ok(!JSON.stringify(r.headers).includes(k), "key in a response header");
    assert.ok(!logs.join("\n").includes(k), "key in a log line");
  }
}

// ---------------------------------------------------------------- forwarding

test("forwards with the real key and only allowed headers", async () => {
  const r = await call("/llm/c/cloud-a/v1/chat/completions", {
    // Extra whitespace: the caller's length differs from the re-serialised body's.
    raw: '{ "model" : "c1",   "messages": [ {"role":"user","content":"hi"} ] }',
    headers: { cookie: "x", "x-custom": "y", connection: "keep-alive, x-custom", "proxy-authorization": "Basic zzz", accept: "application/json" },
  });
  assert.equal(r.status, 200);
  assert.equal(hits.length, 1);
  const h = hits[0];
  assert.equal(h.url, "/v1/chat/completions");
  assert.equal(h.headers.authorization, `Bearer ${UP_KEY}`);
  for (const k of ["cookie", "x-custom", "proxy-authorization", "x-api-key", "x-crow-door-hop", "tailscale-user-login"]) assert.equal(h.headers[k], undefined, k);
  // Node's own per-request socket says "close"; the caller's value never passes.
  assert.notEqual(h.headers.connection, "keep-alive, x-custom");
  assert.equal(h.headers["content-type"], "application/json");
  assert.equal(h.headers.accept, "application/json");
  assert.equal(Number(h.headers["content-length"]), Buffer.byteLength(h.body));
  assert.deepEqual(JSON.parse(h.body), { model: "c1", messages: [{ role: "user", content: "hi" }] });
  assert.ok(!JSON.stringify(h.headers).includes(DOOR_TOKEN), "the cloud token reached the upstream");
  // Response: the rate-limit header passes, set-cookie and unknown headers do not.
  assert.equal(r.headers["x-ratelimit-remaining-requests"], "41");
  assert.equal(r.headers["set-cookie"], undefined);
  assert.equal(r.headers["x-internal"], undefined);
  assert.deepEqual(r.json().echo, { model: "c1", messages: [{ role: "user", content: "hi" }] });
  assertNoKeyAnywhere(r);
});

test("the cloud token is also accepted as x-api-key, and never forwarded", async () => {
  const r = await call("/llm/c/cloud-a/v1/embeddings", { body: { model: "e1", input: "x" }, headers: { authorization: undefined, "x-api-key": DOOR_TOKEN } });
  assert.equal(r.status, 200);
  assert.equal(hits[0].url, "/v1/embeddings");
  assert.equal(hits[0].headers.authorization, `Bearer ${UP_KEY}`);
  assert.equal(hits[0].headers["x-api-key"], undefined);
});

test("anthropic swaps x-api-key and keeps ?beta=true, anthropic-version and anthropic-beta", async () => {
  const r = await call("/llm/c/cloud-b/v1/messages?beta=true", {
    body: { model: "m-b", max_tokens: 8, messages: [{ role: "user", content: "hi" }] },
    headers: { authorization: undefined, "x-api-key": DOOR_TOKEN, "anthropic-version": "2023-06-01", "anthropic-beta": "fine-grained-tool-streaming-2025-05-14", "x-stainless-os": "Linux" },
  });
  assert.equal(r.status, 200);
  assert.equal(hits.length, 1);
  const h = hits[0];
  assert.equal(h.url, "/v1/messages?beta=true");
  assert.equal(h.headers["x-api-key"], UP_KEY_B);
  assert.equal(h.headers.authorization, undefined);
  assert.equal(h.headers["anthropic-version"], "2023-06-01");
  assert.equal(h.headers["anthropic-beta"], "fine-grained-tool-streaming-2025-05-14");
  assert.equal(h.headers["x-stainless-os"], undefined);
  assertNoKeyAnywhere(r);
});

test("anthropic without the query or a beta header forwards neither; other query parameters never pass", async () => {
  await call("/llm/c/cloud-b/v1/messages?foo=1", { body: { model: "m-b", messages: [] }, headers: { "anthropic-version": "2023-06-01" } });
  assert.equal(hits[0].url, "/v1/messages");
  assert.equal(hits[0].headers["anthropic-beta"], undefined);
  await call("/llm/c/cloud-a/v1/chat/completions?beta=true&x=1");
  assert.equal(hits[1].url, "/v1/chat/completions");
});

test("id with a space", async () => {
  const r = await call("/llm/c/Cloud%20A/v1/chat/completions");
  assert.equal(r.status, 200);
  assert.equal(hits.length, 1);
  assert.equal(cloudDoorUrl(3001, "Cloud A", "openai"), "http://127.0.0.1:3001/llm/c/Cloud%20A/v1");
});

test("cloudDoorUrl: /v1 for openai types, none for anthropic", () => {
  assert.equal(cloudDoorUrl(3001, "cloud-a", "openai"), "http://127.0.0.1:3001/llm/c/cloud-a/v1");
  assert.equal(cloudDoorUrl(3008, "cloud-a", "openai-compat"), "http://127.0.0.1:3008/llm/c/cloud-a/v1");
  assert.equal(cloudDoorUrl(3001, "cloud-b", "anthropic"), "http://127.0.0.1:3001/llm/c/cloud-b");
});

test("upstream errors pass through with their body, stripped to the allowed headers", async () => {
  upHandler = (req, res) => {
    res.writeHead(429, { "content-type": "application/json", "retry-after": "7", "anthropic-ratelimit-requests-remaining": "0", "x-should-retry": "true", "request-id": "rq-1", "set-cookie": "s=2", "www-authenticate": "Bearer" });
    res.end(JSON.stringify({ error: { type: "rate_limit_error", message: "slow down" } }));
  };
  const r = await call("/llm/c/cloud-a/v1/chat/completions");
  assert.equal(r.status, 429);
  assert.equal(r.json().error.message, "slow down");
  assert.equal(r.headers["retry-after"], "7");
  assert.equal(r.headers["anthropic-ratelimit-requests-remaining"], "0");
  assert.equal(r.headers["x-should-retry"], "true");
  assert.equal(r.headers["request-id"], "rq-1");
  assert.equal(r.headers["set-cookie"], undefined);
  assert.equal(r.headers["www-authenticate"], undefined);
  assertNoKeyAnywhere(r);
});

test("redirect not followed", async () => {
  upHandler = (req, res) => { res.writeHead(307, { location: `http://up2.example.test:${up2Port}/v1/chat/completions` }); res.end(); };
  const r = await call("/llm/c/cloud-r/v1/chat/completions");
  assert.equal(r.status, 502);
  assert.equal(r.json().error.code, "UPSTREAM_REDIRECT");
  assert.equal(r.headers.location, undefined);
  assert.equal(up2Hits, 0);
});

test("dns to loopback refused", async () => {
  const r = await call("/llm/c/cloud-n/v1/chat/completions");
  assert.equal(r.status, 502);
  assert.equal(r.json().error.code, "UPSTREAM_ADDRESS_REFUSED");
  assert.equal(hits.length, 0);
  assertNoKeyAnywhere(r);
});

test("literal non-public hosts refused", async () => {
  for (const id of ["lit-0", "lit-6", "lit-64"]) {
    const r = await call(`/llm/c/${id}/v1/chat/completions`);
    assert.equal(r.status, 400, id);
    assert.equal(r.json().error.code, "FORBIDDEN_TARGET", id);
  }
  assert.equal(hits.length, 0);
});

// ---------------------------------------------------------------- refusals

test("refusals never call upstream", async () => {
  const cases = [
    ["no token", "/llm/c/cloud-a/v1/chat/completions", { headers: { authorization: undefined } }, 401, "CLOUD_TOKEN_REFUSED"],
    ["wrong token", "/llm/c/cloud-a/v1/chat/completions", { headers: { authorization: "Bearer nope" } }, 401, "CLOUD_TOKEN_REFUSED"],
    ["wrong x-api-key", "/llm/c/cloud-a/v1/chat/completions", { headers: { authorization: undefined, "x-api-key": "nope" } }, 401, "CLOUD_TOKEN_REFUSED"],
    ["basic auth", "/llm/c/cloud-a/v1/chat/completions", { headers: { authorization: `Basic ${DOOR_TOKEN}` } }, 401, "CLOUD_TOKEN_REFUSED"],
    ["forwarded for a tailnet peer", "/llm/c/cloud-a/v1/chat/completions", { headers: { "x-forwarded-for": "100.64.20.9" } }, 403, "CLOUD_SOURCE_REFUSED"],
    ["forwarded for loopback", "/llm/c/cloud-a/v1/chat/completions", { headers: { "x-forwarded-for": "127.0.0.1" } }, 403, "CLOUD_SOURCE_REFUSED"],
    ["Forwarded header", "/llm/c/cloud-a/v1/chat/completions", { headers: { forwarded: "for=127.0.0.1" } }, 403, "CLOUD_SOURCE_REFUSED"],
    ["x-real-ip", "/llm/c/cloud-a/v1/chat/completions", { headers: { "x-real-ip": "127.0.0.1" } }, 403, "CLOUD_SOURCE_REFUSED"],
    ["x-forwarded-host", "/llm/c/cloud-a/v1/chat/completions", { headers: { "x-forwarded-host": "crow.example.ts.net" } }, 403, "CLOUD_SOURCE_REFUSED"],
    ["x-forwarded-proto", "/llm/c/cloud-a/v1/chat/completions", { headers: { "x-forwarded-proto": "https" } }, 403, "CLOUD_SOURCE_REFUSED"],
    ["http row (unseamed)", "/llm/c/cloud-h/v1/chat/completions", {}, 400, "INSECURE_TARGET"],
    ["Tailscale-User-Login", "/llm/c/cloud-a/v1/chat/completions", { headers: { "tailscale-user-login": "x" } }, 403, "CLOUD_SOURCE_REFUSED"],
    ["Tailscale-Headers-Info", "/llm/c/cloud-a/v1/chat/completions", { headers: { "tailscale-headers-info": "x" } }, 403, "CLOUD_SOURCE_REFUSED"],
    ["Funnel", "/llm/c/cloud-a/v1/chat/completions", { headers: { "tailscale-funnel-request": "1" } }, 403, "FUNNEL_REFUSED"],
    ["unknown model", "/llm/c/cloud-a/v1/chat/completions", { body: { model: "c9", messages: [] } }, 404, "MODEL_NOT_SERVED"],
    ["no model", "/llm/c/cloud-a/v1/chat/completions", { body: { messages: [] } }, 404, "MODEL_NOT_SERVED"],
    ["unknown provider", "/llm/c/nope/v1/chat/completions", {}, 404, "UNKNOWN_PROVIDER"],
    ["disabled provider", "/llm/c/cloud-off/v1/chat/completions", {}, 404, "UNKNOWN_PROVIDER"],
    ["local_only row", "/llm/c/cloud-lo/v1/chat/completions", {}, 400, "LOCAL_ONLY"],
    ["unconsented", "/llm/c/cloud-p/v1/chat/completions", {}, 403, "NOT_CONSENTED"],
    ["op not allowed", "/llm/c/cloud-a/v1/images/generations", {}, 400, "OP_NOT_ALLOWED"],
    ["anthropic op on an openai row", "/llm/c/cloud-a/v1/messages", {}, 400, "OP_NOT_ALLOWED"],
    ["openai op on an anthropic row", "/llm/c/cloud-b/v1/chat/completions", { body: { model: "m-b", messages: [] } }, 400, "OP_NOT_ALLOWED"],
    ["path tricks", "/llm/c/cloud-a/v1/chat/completions/../../models", {}, 400, "OP_NOT_ALLOWED"],
    ["no key", "/llm/c/cloud-nokey/v1/chat/completions", {}, 400, "NO_KEY"],
    ["metadata (unseamed)", "/llm/c/meta/v1/chat/completions", {}, 400, "FORBIDDEN_TARGET"],
    ["local-chat (unseamed)", "/llm/c/local-chat/v1/chat/completions", {}, 400, "NOT_CLOUD"],
    ["array body", "/llm/c/cloud-a/v1/chat/completions", { raw: "[1]" }, 400, "BAD_BODY"],
  ];
  for (const [name, path, opts, status, code] of cases) {
    hits = [];
    const r = await call(path, opts);
    assert.equal(r.status, status, `${name}: ${r.body}`);
    assert.equal(r.json().error.code, code, name);
    assert.equal(hits.length, 0, `${name} reached the upstream`);
  }
});

test("a tailnet socket is refused, even with a valid token", async () => {
  remote = "100.64.20.9";
  const r = await call("/llm/c/cloud-a/v1/chat/completions");
  assert.equal(r.status, 403);
  assert.equal(r.json().error.code, "CLOUD_SOURCE_REFUSED");
  remote = "10.0.0.50";
  assert.equal((await call("/llm/c/cloud-a/v1/chat/completions")).status, 403);
  remote = "::ffff:127.0.0.1";
  assert.equal((await call("/llm/c/cloud-a/v1/chat/completions")).status, 200);
  assert.equal(hits.length, 1);
});

test("the token is checked after the source: an off-box caller never reaches the token check", async () => {
  let checks = 0;
  const app = express();
  app.use(makeRouter({ cloudTokenAuthFn: async () => { checks++; return true; } }));
  const s = http.createServer(app);
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  try {
    remote = "100.64.20.9";
    const r = await call("/llm/c/cloud-a/v1/chat/completions", { base: `http://127.0.0.1:${s.address().port}` });
    assert.equal(r.status, 403);
    assert.equal(checks, 0);
  } finally { s.close(); }
});

test("host changed refused (a sync rewrite takes effect on the next request)", async () => {
  assert.equal((await call("/llm/c/cloud-a/v1/chat/completions")).status, 200);
  rows["cloud-a"].baseUrl = `http://up2.example.test:${up2Port}/v1`;
  hits = [];
  const r = await call("/llm/c/cloud-a/v1/chat/completions");
  assert.equal(r.status, 403);
  assert.equal(r.json().error.code, "HOST_CHANGED");
  assert.equal(hits.length, 0);
  assert.equal(up2Hits, 0);
});

test("key changed refused", async () => {
  rows["cloud-a"].apiKey = "fixture-other-key";
  const r = await call("/llm/c/cloud-a/v1/chat/completions");
  assert.equal(r.status, 403);
  assert.equal(r.json().error.code, "KEY_CHANGED");
  assert.equal(hits.length, 0);
});

test("a missing salt reads as key changed", async () => {
  db.settings.delete("llm_cloud_consent_salt");
  const r = await call("/llm/c/cloud-a/v1/chat/completions");
  assert.equal(r.status, 403);
  assert.equal(r.json().error.code, "KEY_CHANGED");
  assert.equal(hits.length, 0);
});

test("a revoked consent is refused on the very next request (no cache)", async () => {
  assert.equal((await call("/llm/c/cloud-a/v1/chat/completions")).status, 200);
  const map = await readCloudConsent(db);
  delete map["cloud-a"];
  db.settings.set(CLOUD_CONSENT_KEY, JSON.stringify(map));
  const r = await call("/llm/c/cloud-a/v1/chat/completions");
  assert.equal(r.status, 403);
  assert.equal(r.json().error.code, "NOT_CONSENTED");
});

test("a provider_type rewrite never changes the destination host", async () => {
  // A peer flips the type: the door still dials only the consented base URL.
  rows["cloud-a"].provider_type = "anthropic";
  rows["cloud-a"].models = [{ id: "c1" }];
  const r = await call("/llm/c/cloud-a/v1/messages", { body: { model: "c1", messages: [] } });
  assert.equal(r.status, 200);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].url, "/v1/v1/messages");
  assert.equal(up2Hits, 0);
});

test("a --no-auth style option is no bypass: the router has no auth switch", async () => {
  const app = express();
  app.use(makeRouter({ noAuth: true, cloudTokenAuthFn: undefined, consentFn: async () => ({ consent: {}, salt: null }) }));
  const s = http.createServer(app);
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  try {
    const base = `http://127.0.0.1:${s.address().port}`;
    // The default validator (the real cloud-token hash) rejects a made-up token.
    const r1 = await call("/llm/c/cloud-a/v1/chat/completions", { base, headers: { authorization: "Bearer made-up" } });
    assert.equal(r1.status, 401);
    const r2 = await call("/llm/c/cloud-a/v1/chat/completions", { base, headers: { authorization: undefined } });
    assert.equal(r2.status, 401);
    assert.equal(hits.length, 0);
  } finally { s.close(); }
});

test("other methods and paths under /llm/c answer 404 and never fall through", async () => {
  const r = await fetch(`${appUrl}/llm/c/cloud-a/v1/models`, { headers: { authorization: `Bearer ${DOOR_TOKEN}` } });
  assert.equal(r.status, 404);
  assert.equal(hits.length, 0);
});

// ---------------------------------------------------------------- streaming

test("streams SSE through without buffering the whole body", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  upHandler = async (req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"choices":[{"delta":{"content":"a"}}]}\n\n');
    await gate; // only continues once the CLIENT has seen the first frame
    res.end('data: {"choices":[{"delta":{"content":"b"}}]}\n\ndata: [DONE]\n\n');
  };
  const got = await new Promise((resolve, reject) => {
    const u = new URL(`${appUrl}/llm/c/cloud-a/v1/chat/completions`);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${DOOR_TOKEN}` } }, (res) => {
      let b = "";
      res.on("data", (c) => { b += c; if (b.includes('"a"')) release(); });
      res.on("end", () => resolve({ status: res.statusCode, ct: res.headers["content-type"], body: b }));
    });
    req.on("error", reject);
    const t = setTimeout(() => reject(new Error("the door buffered the stream")), 5000);
    req.on("close", () => clearTimeout(t));
    req.end(JSON.stringify({ model: "c1", stream: true, messages: [] }));
  });
  assert.equal(got.status, 200);
  assert.match(got.ct, /text\/event-stream/);
  assert.match(got.body, /"b"/);
  assert.match(got.body, /\[DONE\]/);
});

test("a long stream outlives the header deadline while bytes keep coming", async () => {
  const app = express();
  app.use(makeRouter({ cloudTimeouts: { headersMs: 300, idleMs: 300, totalMs: 10_000 } }));
  const s = http.createServer(app);
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  upHandler = async (req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (let i = 0; i < 9; i++) { res.write(`data: {"n":${i}}\n\n`); await new Promise((r) => setTimeout(r, 100)); }
    res.end("data: [DONE]\n\n");
  };
  try {
    const r = await call("/llm/c/cloud-a/v1/chat/completions", { base: `http://127.0.0.1:${s.address().port}` });
    assert.equal(r.status, 200);
    assert.match(r.body, /"n":8/);
    assert.match(r.body, /\[DONE\]/);
  } finally { s.close(); }
});

test("a stalled stream is cut at the idle timeout, never waited on forever", async () => {
  const app = express();
  app.use(makeRouter({ cloudTimeouts: { headersMs: 2000, idleMs: 200, totalMs: 10_000 } }));
  const s = http.createServer(app);
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  let upstreamClosed = false;
  upHandler = (req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"n":0}\n\n');
    res.on("close", () => { upstreamClosed = true; });
    // ...and never another byte.
  };
  try {
    const t0 = Date.now();
    const r = await call("/llm/c/cloud-a/v1/chat/completions", { base: `http://127.0.0.1:${s.address().port}` }).catch((e) => ({ error: e }));
    assert.ok(Date.now() - t0 < 2000, "the idle timeout did not fire");
    assert.ok(r.error || r.aborted || !/\[DONE\]/.test(r.body || ""), "a cut stream must not look complete");
    await new Promise((r2) => setTimeout(r2, 50));
    assert.equal(upstreamClosed, true);
  } finally { s.close(); }
});

test("an upstream that never answers gets a 504 at the header deadline", async () => {
  const app = express();
  app.use(makeRouter({ cloudTimeouts: { headersMs: 200, idleMs: 200, totalMs: 10_000 } }));
  const s = http.createServer(app);
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  upHandler = () => { /* no answer */ };
  try {
    const r = await call("/llm/c/cloud-a/v1/chat/completions", { base: `http://127.0.0.1:${s.address().port}` });
    assert.equal(r.status, 504);
    assert.equal(r.json().error.code, "UPSTREAM_TIMEOUT");
  } finally { s.close(); }
});

// ---------------------------------------------------------------- metering

async function settled() { for (let i = 0; i < 50 && !usage.length; i++) await new Promise((r) => setTimeout(r, 10)); }

test("metering: an openai and an anthropic streamed turn each record usage from the stream", async () => {
  upHandler = (req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
    res.write('data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":5}}\n\n');
    res.end("data: [DONE]\n\n");
  };
  await call("/llm/c/cloud-a/v1/chat/completions", { body: { model: "c1", stream: true, messages: [] } });
  await settled();
  assert.equal(usage.length, 1);
  assert.equal(usage[0].providerId, "cloud-a");
  assert.equal(usage[0].modelId, "c1");
  assert.equal(usage[0].surface, "llm");
  assert.equal(usage[0].inputTokens, 12);
  assert.equal(usage[0].outputTokens, 5);

  usage = [];
  upHandler = (req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"m","usage":{"input_tokens":11,"output_tokens":1}}}\n\n');
    res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"' + "x".repeat(200_000) + '"}}\n\n');
    res.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}\n\n');
    res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
  };
  await call("/llm/c/cloud-b/v1/messages", { body: { model: "m-b", stream: true, messages: [] }, headers: { "anthropic-version": "2023-06-01" } });
  await settled();
  assert.equal(usage.length, 1);
  assert.equal(usage[0].providerId, "cloud-b");
  assert.equal(usage[0].providerType, "anthropic");
  assert.equal(usage[0].inputTokens, 11);
  assert.equal(usage[0].outputTokens, 7);
});

test("metering: an upstream error records nothing", async () => {
  upHandler = (req, res) => { res.writeHead(500, { "content-type": "application/json" }); res.end('{"usage":{"prompt_tokens":1,"completion_tokens":1}}'); };
  await call("/llm/c/cloud-a/v1/chat/completions");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(usage.length, 0);
});

test("extractUsageFromAnthropicStream: SSE, a whole JSON body, and nothing", () => {
  const sse = [
    'event: message_start', 'data: {"type":"message_start","message":{"usage":{"input_tokens":20,"output_tokens":1}}}', '',
    'event: ping', 'data: {"type":"ping"}', '',
    'event: message_delta', 'data: {"type":"message_delta","usage":{"output_tokens":3}}', '',
    'event: message_delta', 'data: {"type":"message_delta","usage":{"output_tokens":9}}', '',
  ].join("\n");
  assert.deepEqual(extractUsageFromAnthropicStream(sse), { input_tokens: 20, output_tokens: 9 });
  assert.deepEqual(extractUsageFromAnthropicStream('{"type":"message","usage":{"input_tokens":4,"output_tokens":2}}'), { input_tokens: 4, output_tokens: 2 });
  // A message_delta that reports input tokens too (newer API versions) wins.
  assert.deepEqual(extractUsageFromAnthropicStream('data: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\ndata: {"type":"message_delta","usage":{"input_tokens":6,"output_tokens":2}}\n'), { input_tokens: 6, output_tokens: 2 });
  assert.equal(extractUsageFromAnthropicStream("data: [DONE]\n"), null);
  assert.equal(extractUsageFromAnthropicStream(""), null);
  assert.equal(extractUsageFromAnthropicStream(null), null);
});

// ---------------------------------------------------------------- pure resolver

test("resolveCloudTarget: shapes and the allowlists", async () => {
  const consent = await readCloudConsent(db);
  const salt = await readCloudConsentSalt(db);
  const providers = { "cloud-a": { id: "cloud-a", ...rows["cloud-a"] }, "cloud-b": { id: "cloud-b", ...rows["cloud-b"] } };
  const a = resolveCloudTarget({ providers, consent, salt, providerId: "cloud-a", op: "chat/completions", model: "c1", isCloudTarget: isCloudTargetFn, allowInsecure: allowInsecureFn });
  assert.equal(a.kind, "forward");
  assert.equal(a.url, `http://up.example.test:${upPort}/v1/chat/completions`);
  assert.equal(a.authStyle, "bearer");
  assert.equal(a.host, "up.example.test");
  const b = resolveCloudTarget({ providers, consent, salt, providerId: "cloud-b", op: "messages", model: "m-b", isCloudTarget: isCloudTargetFn, allowInsecure: allowInsecureFn });
  assert.equal(b.url, `http://up.example.test:${upPort}/v1/messages`);
  assert.equal(b.authStyle, "anthropic");
  assert.deepEqual(CLOUD_OPS, { openai: ["chat/completions", "completions", "embeddings"], anthropic: ["messages"] });
  assert.deepEqual(REQUEST_HEADER_ALLOW, ["content-type", "accept"]);
  assert.deepEqual(RESPONSE_HEADER_ALLOW, ["content-type", "retry-after", "x-should-retry", "request-id", "x-request-id"]);
});

// ---------------------------------------------------------------- fix round 1

test("a client abort before the upstream answers closes the upstream request at once", async () => {
  let upClosedAt = null;
  upHandler = (req, res) => { res.on("close", () => { upClosedAt = Date.now(); }); /* never answers */ };
  const u = new URL(`${appUrl}/llm/c/cloud-a/v1/chat/completions`);
  const creq = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${DOOR_TOKEN}` } });
  creq.on("error", () => {});
  creq.end(JSON.stringify({ model: "c1", messages: [] }));
  for (let i = 0; i < 100 && !hits.length; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(hits.length, 1, "the upstream was reached");
  const abortedAt = Date.now();
  creq.destroy();
  for (let i = 0; i < 100 && upClosedAt == null; i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(upClosedAt != null && upClosedAt - abortedAt < 1000, "the upstream request stayed open after the client left");
  // The slot is free again.
  upHandler = null;
  assert.equal((await call("/llm/c/cloud-a/v1/chat/completions")).status, 200);
});

test("a client abort mid-stream closes the upstream", async () => {
  let upClosedAt = null;
  upHandler = (req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"n":0}\n\n');
    res.on("close", () => { upClosedAt = Date.now(); });
  };
  let abortedAt;
  await new Promise((resolve) => {
    const u = new URL(`${appUrl}/llm/c/cloud-a/v1/chat/completions`);
    const creq = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${DOOR_TOKEN}` } }, (res) => {
      res.once("data", () => { abortedAt = Date.now(); creq.destroy(); resolve(); });
    });
    creq.on("error", () => {});
    creq.end(JSON.stringify({ model: "c1", stream: true, messages: [] }));
  });
  for (let i = 0; i < 100 && upClosedAt == null; i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(upClosedAt != null && upClosedAt - abortedAt < 1000);
});

test("an http row is refused before consent, with zero upstream hits", () => {
  const providers = { "cloud-h": { id: "cloud-h", ...rows["cloud-h"] } };
  const t = resolveCloudTarget({ providers, consent: {}, salt: null, providerId: "cloud-h", op: "chat/completions", model: "c1" });
  assert.equal(t.code, "INSECURE_TARGET");
  const ok = resolveCloudTarget({ providers: { x: { id: "x", baseUrl: "https://api.example.com/v1", apiKey: UP_KEY, models: [{ id: "c1" }] } }, consent: {}, salt: null, providerId: "x", op: "chat/completions", model: "c1" });
  assert.equal(ok.code, "NOT_CONSENTED", "an https row goes on to the consent check");
});

test("a compressed answer keeps its content-encoding, arrives intact, and is still metered", async () => {
  const sse = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\ndata: [DONE]\n\n';
  upHandler = (req, res) => { res.writeHead(200, { "content-type": "text/event-stream", "content-encoding": "gzip" }); res.end(zlib.gzipSync(sse)); };
  const r = await call("/llm/c/cloud-a/v1/chat/completions", { body: { model: "c1", stream: true, messages: [] } });
  assert.equal(r.status, 200);
  assert.equal(r.headers["content-encoding"], "gzip");
  assert.equal(zlib.gunzipSync(r.buf).toString("utf8"), sse);
  await settled();
  assert.equal(usage.length, 1);
  assert.equal(usage[0].inputTokens, 3);
  assert.equal(usage[0].outputTokens, 2);
});

test("a compressed error body is decoded, redacted and sent plain", async () => {
  upHandler = (req, res) => {
    res.writeHead(401, { "content-type": "application/json", "content-encoding": "gzip" });
    res.end(zlib.gzipSync(JSON.stringify({ error: { message: `bad key ${req.headers.authorization}` } })));
  };
  const r = await call("/llm/c/cloud-a/v1/chat/completions");
  assert.equal(r.status, 401);
  assert.equal(r.headers["content-encoding"], undefined);
  assert.equal(r.json().error.message, "bad key Bearer [redacted]");
  assertNoKeyAnywhere(r);
});

test("metering: a non-streamed body over 96 KB is still metered, for openai and anthropic", async () => {
  const big = "y".repeat(200_000);
  upHandler = (req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "x", choices: [{ message: { role: "assistant", content: big } }], usage: { prompt_tokens: 40, completion_tokens: 30000 } }));
  };
  await call("/llm/c/cloud-a/v1/chat/completions");
  await settled();
  assert.equal(usage.length, 1);
  assert.equal(usage[0].inputTokens, 40);
  assert.equal(usage[0].outputTokens, 30000);
  usage = [];
  upHandler = (req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "message", content: [{ type: "text", text: big }], usage: { input_tokens: 9, output_tokens: 31000 } }));
  };
  await call("/llm/c/cloud-b/v1/messages", { body: { model: "m-b", messages: [] } });
  await settled();
  assert.equal(usage.length, 1);
  assert.equal(usage[0].inputTokens, 9);
  assert.equal(usage[0].outputTokens, 31000);
});

test("metering: an openai stream without include_usage records the call with null counts", async () => {
  upHandler = (req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n');
  };
  await call("/llm/c/cloud-a/v1/chat/completions", { body: { model: "c1", stream: true, messages: [] } });
  await settled();
  assert.equal(usage.length, 1);
  assert.equal(usage[0].providerId, "cloud-a");
  assert.equal(usage[0].inputTokens, null);
  assert.equal(usage[0].outputTokens, null);
});

test("recordUsageEvent: null counts are written as an unpriced row, even when a rule matches", async () => {
  const inserts = [];
  const fake = {
    async execute(q) {
      if (typeof q === "string") return { rows: [{ provider_id: "cloud-a", provider_type: null, model_id: "*", input_cost_per_1m: 1, output_cost_per_1m: 1 }] };
      inserts.push(q.args);
      return { rows: [] };
    },
  };
  const r = await recordUsageEvent(fake, { surface: "llm", providerId: "cloud-a", modelId: "c1", inputTokens: null, outputTokens: null, cachedTokens: null });
  assert.deepEqual(r, { priced: false, cost: null });
  const a = inserts[0];
  assert.deepEqual([a[7], a[8], a[9], a[10], a[11]], [0, 0, 0, null, 0]);
  const known = await recordUsageEvent(fake, { surface: "llm", providerId: "cloud-a", modelId: "c1", inputTokens: 1_000_000, outputTokens: 0 });
  assert.equal(known.priced, true);
});

/** index.js's global-parser skip predicate, read from the source (as workspace-live.test.js does). */
function gatewayParserSkip() {
  const src = readFileSync(new URL("../servers/gateway/index.js", import.meta.url), "utf8");
  const m = /const _hasOwnParser = \(p\) => ([^\n]*\n[^\n]*);/.exec(src);
  assert.ok(m, "the predicate is where it was");
  return new Function("p", `return ${m[1]};`);
}

test("/LLM/C with the Funnel header is refused, and the body is never parsed", async () => {
  const hasOwnBodyParser = gatewayParserSkip();
  assert.equal(hasOwnBodyParser("/LLM/C/x/v1/chat/completions"), true);
  assert.equal(hasOwnBodyParser("/Llm/c"), true);
  assert.equal(hasOwnBodyParser("/api/chat"), false);
  // The gateway's layering: the global parser (skipped by the same predicate), then the router.
  let parsed = 0;
  const app = express();
  const json = express.json({ limit: "1mb" });
  app.use((req, res, next) => (hasOwnBodyParser(req.path) ? next() : (parsed++, json(req, res, next))));
  app.use(makeRouter());
  const s = http.createServer(app);
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  try {
    const base = `http://127.0.0.1:${s.address().port}`;
    // Not JSON: a parse would answer 400, never 403/401.
    const r1 = await call("/LLM/C/cloud-a/v1/chat/completions", { base, raw: "{not json", headers: { "tailscale-funnel-request": "?1" } });
    assert.equal(r1.status, 403);
    assert.equal(r1.json().error.code, "FUNNEL_REFUSED");
    const r2 = await call("/LLM/C/cloud-a/v1/chat/completions", { base, raw: "{not json", headers: { authorization: undefined } });
    assert.equal(r2.status, 401);
    assert.equal(r2.json().error.code, "CLOUD_TOKEN_REFUSED");
    assert.equal(parsed, 0);
    assert.equal(hits.length, 0);
  } finally { s.close(); }
});

test("an upstream that echoes the key and the caller's token gets them redacted", async () => {
  upHandler = (req, res) => {
    res.writeHead(401, { "content-type": "application/json", "x-ratelimit-echo": req.headers.authorization, "request-id": UP_KEY });
    res.end(JSON.stringify({ error: { message: `Incorrect API key provided: ${UP_KEY}`, headers: req.headers } }));
  };
  const r = await call("/llm/c/cloud-a/v1/chat/completions");
  assert.equal(r.status, 401);
  assert.equal(r.headers["x-ratelimit-echo"], "Bearer [redacted]");
  assert.equal(r.headers["request-id"], "[redacted]");
  assert.match(r.json().error.message, /provided: \[redacted\]$/);
  assertNoKeyAnywhere(r);
  // A 2xx answer's header values are redacted too (the body streams as is).
  upHandler = (req, res) => { res.writeHead(200, { "content-type": "application/json", "x-ratelimit-key": UP_KEY }); res.end("{}"); };
  const r2 = await call("/llm/c/cloud-a/v1/chat/completions");
  assert.equal(r2.headers["x-ratelimit-key"], "[redacted]");
  // The caller's own token, echoed, is redacted as well.
  upHandler = (req, res) => { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ seen: DOOR_TOKEN })); };
  const r3 = await call("/llm/c/cloud-a/v1/chat/completions");
  assert.equal(r3.json().seen, "[redacted]");
});

test("routing and egress body fields are stripped; provider tools are kept", async () => {
  await call("/llm/c/cloud-a/v1/chat/completions", { body: {
    model: "c1", messages: [], models: ["other/expensive"], route: "fallback", provider: { order: ["x"] },
    tools: [{ type: "function", function: { name: "f" } }],
  } });
  const sent = JSON.parse(hits[0].body);
  for (const k of ["models", "route", "provider"]) assert.equal(sent[k], undefined, k);
  assert.deepEqual(sent.tools, [{ type: "function", function: { name: "f" } }]);
  await call("/llm/c/cloud-b/v1/messages", { body: {
    model: "m-b", messages: [], mcp_servers: [{ type: "url", url: "https://mcp.example.com/sse", name: "x" }],
    tools: [{ type: "web_search_20250305", name: "web_search" }],
  }, headers: { "anthropic-version": "2023-06-01" } });
  const sentB = JSON.parse(hits[1].body);
  assert.equal(sentB.mcp_servers, undefined);
  assert.deepEqual(sentB.tools, [{ type: "web_search_20250305", name: "web_search" }]);
});

test("POST /llm/c with no trailing path answers 404 inside the door", async () => {
  for (const path of ["/llm/c", "/llm/c/"]) {
    const r = await call(path);
    assert.equal(r.status, 404, path);
    assert.equal(r.json().error.code, "NOT_FOUND", path);
  }
  assert.equal((await call("/llm/c", { headers: { authorization: undefined } })).status, 401);
  assert.equal(hits.length, 0);
});

test("isLocalPeer is the one source rule: every forwarding and tailscale header refuses", () => {
  assert.equal(isLocalPeer("127.0.0.1", {}), true);
  assert.equal(isLocalPeer("::1", {}), true);
  assert.equal(isLocalPeer("::ffff:127.0.0.1", { "content-type": "x" }), true);
  for (const h of ["x-forwarded-for", "x-real-ip", "forwarded", "x-forwarded-host", "x-forwarded-proto", "tailscale-user-login", "tailscale-headers-info", "tailscale-anything"]) {
    assert.equal(isLocalPeer("127.0.0.1", { [h]: h === "forwarded" ? "for=127.0.0.1" : "127.0.0.1" }), false, h);
  }
  for (const a of ["100.64.20.9", "10.0.0.50", "203.0.113.5", ""]) assert.equal(isLocalPeer(a, {}), false, a);
});

test("at most 8 requests at once; the ninth gets 429 DOOR_BUSY", async () => {
  const held = [];
  upHandler = (req, res) => { held.push(res); };
  const pending = [];
  for (let i = 0; i < 8; i++) pending.push(call("/llm/c/cloud-a/v1/chat/completions"));
  for (let i = 0; i < 200 && hits.length < 8; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(hits.length, 8);
  const r9 = await call("/llm/c/cloud-a/v1/chat/completions");
  assert.equal(r9.status, 429);
  assert.equal(r9.json().error.code, "DOOR_BUSY");
  assert.equal(hits.length, 8);
  for (const res of held) { res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); }
  for (const r of await Promise.all(pending)) assert.equal(r.status, 200);
  upHandler = null;
  assert.equal((await call("/llm/c/cloud-a/v1/chat/completions")).status, 200);
});
