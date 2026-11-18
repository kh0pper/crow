// tests/llm-door-identity.test.js
//
// Satellite-exposure phase A1: the model door names WHO is calling it
// (servers/gateway/models/door-identity.js) and records a bounded, deduped,
// token-free "would refuse" event for every caller that is only at the door on
// a tailnet address. SHADOW MODE: nothing this file drives may change an
// answer the door gives today, except with CROW_LLM_DOOR_ENFORCE=1, which is
// exercised separately and ships OFF.
//
// Placeholder addresses only: 192.0.2.x / 198.51.100.x stand in for a LAN,
// 100.64.20.x for the tailnet, and "owner@example.com" for the owner's login.
process.env.COMPANION_FAST_MODEL = "crow-voice/qwen3.5-4b";
process.env.COMPANION_ESCALATION_MODEL = "crow-voice/qwen3.5-4b";

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import llmRouterRouter from "../servers/gateway/routes/llm-router.js";
import {
  classifyDoorCaller, DOOR_CLASS, doorEnforceOn, ownerTailnetLogin,
  recordDoorShadow, doorShadowSummary, resetDoorShadow, doorShadowKeyCount, doorShadowRingSize,
  resetDoorCredentialMemo, DOOR_SHADOW_WINDOW_MS, DOOR_SHADOW_MAX_KEYS, DOOR_SHADOW_RING,
} from "../servers/gateway/models/door-identity.js";

const OWNER = "owner@example.com";
const LOCAL = "local-token-abc";
const MODELS = "models-token-def";
const PEER = "peer-token-ghi";
const GARBAGE = "garbage-token-zzz";
const GOOD = LOCAL; // what this harness' doorAuthFn accepts (today's bearer path)

// ---------------------------------------------------------------------------
// Part 1 — the classifier's truth table (no HTTP, no DB)
// ---------------------------------------------------------------------------

/** A request shape good enough for the classifier. */
function req({ addr = "127.0.0.1", headers = {}, peer } = {}) {
  return { socket: { remoteAddress: addr }, headers, ...(peer ? { crowPeer: peer } : {}) };
}
const bearer = (token) => ({ authorization: `Bearer ${token}` });
const servePeer = (login, client = "100.64.20.5") => ({ via: "serve", client, tailnetLogin: login });

/** The deps a production router wires, minus the DB: LOCAL/MODELS tokens, one
 *  paired peer, and the owner's login. */
function resolverDeps(extra = {}) {
  return {
    localTokenFn: async (t) => t === LOCAL || t === MODELS,
    peerTokenFn: async (t) => (t === PEER ? { id: "peer-1", name: "laptop" } : null),
    ownerLogin: OWNER,
    ...extra,
  };
}
const cls = async (request, deps = resolverDeps()) => (await classifyDoorCaller(request, deps)).cls;

test("loopback: a direct loopback socket is loopback, and no credential is ever read", async () => {
  let reads = 0;
  const spyDeps = {
    localTokenFn: async () => { reads++; return true; },
    peerTokenFn: async () => { reads++; return { id: "x" }; },
    ownerLogin: OWNER,
  };
  assert.equal(await cls(req(), spyDeps), DOOR_CLASS.LOOPBACK);
  assert.equal(await cls(req({ headers: bearer(GARBAGE) }), spyDeps), DOOR_CLASS.LOOPBACK, "a bearer adds nothing to loopback");
  assert.equal(reads, 0, "a loopback caller never touches a token check");
  const v = await classifyDoorCaller(req(), spyDeps);
  assert.equal(v.via, "local"); // the real peer classifier agrees it is local
  assert.equal(v.source, "127.0.0.1");
});

test("Serve: the owner's own login through a verified Serve socket is owner-login", async () => {
  const r = req({
    headers: { "x-forwarded-for": "100.64.20.5", "tailscale-user-login": OWNER },
    peer: servePeer(OWNER),
  });
  const v = await classifyDoorCaller(r, resolverDeps());
  assert.equal(v.cls, DOOR_CLASS.OWNER_LOGIN);
  assert.equal(v.login, OWNER);
  assert.equal(v.source, "100.64.20.5", "the census names the Serve client, not the loopback socket");
  // Case-insensitively, as tailnet logins are.
  const upper = req({ headers: { "x-forwarded-for": "100.64.20.5" }, peer: servePeer("Owner@Example.com") });
  assert.equal(await cls(upper), DOOR_CLASS.OWNER_LOGIN);
});

test("Serve: another tailnet user's login is unidentified", async () => {
  const r = req({ headers: { "tailscale-user-login": "someone@example.com" }, peer: servePeer("someone@example.com") });
  const v = await classifyDoorCaller(r, resolverDeps());
  assert.equal(v.cls, DOOR_CLASS.UNIDENTIFIED);
  assert.equal(v.login, "someone@example.com");
});

test("Serve: a client-supplied Tailscale-User-Login on an UNVERIFIED socket buys nothing", async () => {
  // The real classifier withholds tailnetLogin unless it verified a Serve socket
  // (peer-class.js). A forged header therefore cannot earn owner-login.
  for (const peer of [{ via: "unverified", client: "127.0.0.1", tailnetLogin: null }, undefined]) {
    const r = req({ headers: { "x-forwarded-for": "100.64.20.5", "tailscale-user-login": OWNER, ...bearer(GARBAGE) }, peer });
    const v = await classifyDoorCaller(r, resolverDeps());
    assert.equal(v.cls, DOOR_CLASS.UNIDENTIFIED, `peer=${JSON.stringify(peer)}`);
    assert.equal(v.login, null);
  }
});

test("Serve: owner-login never matches when CROW_OWNER_TAILNET_LOGIN is unset", async () => {
  const r = req({ headers: { "tailscale-user-login": OWNER }, peer: servePeer(OWNER) });
  assert.equal(await cls(r, resolverDeps({ ownerLogin: null })), DOOR_CLASS.UNIDENTIFIED);
  // …and the module's own default reads the (absent) env var.
  const saved = process.env.CROW_OWNER_TAILNET_LOGIN;
  delete process.env.CROW_OWNER_TAILNET_LOGIN;
  try {
    assert.equal(ownerTailnetLogin(), null);
    assert.equal(await cls(r, resolverDeps({ ownerLogin: undefined })), DOOR_CLASS.UNIDENTIFIED);
  } finally { if (saved !== undefined) process.env.CROW_OWNER_TAILNET_LOGIN = saved; }
});

test("tailnet: no credential is unidentified; each credential names its class", async () => {
  const tailnet = "100.64.20.7";
  assert.equal(await cls(req({ addr: tailnet })), DOOR_CLASS.UNIDENTIFIED, "a tailnet address alone");
  assert.equal(await cls(req({ addr: tailnet, headers: bearer(LOCAL) })), DOOR_CLASS.LOCAL_TOKEN, "the local MCP token");
  assert.equal(await cls(req({ addr: tailnet, headers: bearer(MODELS) })), DOOR_CLASS.LOCAL_TOKEN, "the models token");
  const peer = await classifyDoorCaller(req({ addr: tailnet, headers: bearer(PEER) }), resolverDeps());
  assert.equal(peer.cls, DOOR_CLASS.PEER_TOKEN);
  assert.equal(peer.instanceId, "peer-1", "the paired instance is recorded, never the token");
  assert.equal(await cls(req({ addr: tailnet, headers: bearer("revoked-token") })), DOOR_CLASS.UNIDENTIFIED, "a revoked peer token");
  assert.equal(await cls(req({ addr: tailnet, headers: bearer("untrusted-token") })), DOOR_CLASS.UNIDENTIFIED, "a paired-but-untrusted token");
  assert.equal(await cls(req({ addr: tailnet, headers: bearer(GARBAGE) })), DOOR_CLASS.UNIDENTIFIED, "a garbage bearer");
  assert.equal(await cls(req({ addr: "fd7a:115c:a1e0::20" })), DOOR_CLASS.UNIDENTIFIED, "tailnet IPv6");
});

test("LAN: a LAN source is unidentified (with or without a credential it does not hold)", async () => {
  assert.equal(await cls(req({ addr: "192.0.2.7" })), DOOR_CLASS.UNIDENTIFIED);
  assert.equal(await cls(req({ addr: "198.51.100.9", headers: bearer(GARBAGE) })), DOOR_CLASS.UNIDENTIFIED);
  // A loopback socket relaying a LAN client is the same caller, named by address.
  const relayed = await classifyDoorCaller(req({ headers: { "x-forwarded-for": "192.0.2.7" } }), resolverDeps());
  assert.equal(relayed.cls, DOOR_CLASS.UNIDENTIFIED);
  assert.equal(relayed.source, "192.0.2.7");
});

test("a loopback socket relaying a tailnet client with no login is unidentified (the real peer classifier)", async () => {
  // No req.crowPeer and no Serve uid to verify: peer-class says "unverified",
  // so the relayed client is never taken at its word.
  const r = req({ headers: { "x-forwarded-for": "100.64.20.5", "x-forwarded-host": "crow.example.ts.net" } });
  const v = await classifyDoorCaller(r, resolverDeps());
  assert.equal(v.cls, DOOR_CLASS.UNIDENTIFIED);
  assert.equal(v.via, "unverified");
  assert.equal(v.source, "100.64.20.5");
});

test("a credential verdict is memoised per token in shadow mode, and never while enforcing", async () => {
  resetDoorCredentialMemo();
  let calls = 0;
  const deps = () => ({ ...resolverDeps(), peerTokenFn: async () => { calls++; return { id: "peer-1" }; }, nowFn: () => 1_000 });
  assert.equal(await cls(req({ addr: "100.64.20.7", headers: bearer(PEER) }), deps()), DOOR_CLASS.PEER_TOKEN);
  assert.equal(await cls(req({ addr: "100.64.20.7", headers: bearer(PEER) }), deps()), DOOR_CLASS.PEER_TOKEN);
  assert.equal(calls, 1, "one lookup for one token's stream of requests");
  resetDoorCredentialMemo();
  const noMemo = () => ({ ...deps(), memoize: false });
  await cls(req({ addr: "100.64.20.7", headers: bearer(PEER) }), noMemo());
  await cls(req({ addr: "100.64.20.7", headers: bearer(PEER) }), noMemo());
  assert.equal(calls, 3, "with the memo off (enforcement) every request is checked");
  resetDoorCredentialMemo();
});

test("CROW_LLM_DOOR_ENFORCE is off unless it is exactly \"1\"; the owner login is trimmed", () => {
  for (const v of [undefined, "", "0", "true", "yes", " 0 "]) {
    assert.equal(doorEnforceOn({ CROW_LLM_DOOR_ENFORCE: v }), false, String(v));
  }
  assert.equal(doorEnforceOn({ CROW_LLM_DOOR_ENFORCE: "1" }), true);
  assert.equal(doorEnforceOn({ CROW_LLM_DOOR_ENFORCE: " 1 " }), true);
  assert.equal(ownerTailnetLogin({ CROW_OWNER_TAILNET_LOGIN: "  owner@example.com  " }), OWNER);
  assert.equal(ownerTailnetLogin({ CROW_OWNER_TAILNET_LOGIN: "   " }), null);
});

// ---------------------------------------------------------------------------
// Part 2 — the shadow census (module level: bounds, dedupe, summary)
// ---------------------------------------------------------------------------

test("census: one event per (class, source, route) per window, and the summary counts it", () => {
  resetDoorShadow();
  const t0 = 1_800_000_000_000;
  const lines = [];
  const log = (l) => lines.push(l);
  assert.equal(recordDoorShadow({ cls: "unidentified", source: "100.64.20.5", route: "POST /llm/v1/chat/completions", model: "m" }, t0, log), true);
  assert.equal(recordDoorShadow({ cls: "unidentified", source: "100.64.20.5", route: "POST /llm/v1/chat/completions", model: "m" }, t0 + 1000, log), false, "inside the window");
  assert.equal(recordDoorShadow({ cls: "unidentified", source: "100.64.20.5", route: "POST /llm/p/p/v1/chat/completions" }, t0 + 1000, log), true, "a different route is its own key");
  assert.equal(recordDoorShadow({ cls: "unidentified", source: "100.64.20.5", route: "POST /llm/v1/chat/completions" }, t0 + DOOR_SHADOW_WINDOW_MS, log), true, "the window has passed");
  assert.equal(lines.length, 3);
  const s = doorShadowSummary(t0 + DOOR_SHADOW_WINDOW_MS);
  assert.equal(s.total, 3);
  assert.equal(s.classes.unidentified, 3);
  const g = s.sources.find((x) => x.source === "100.64.20.5");
  assert.equal(g.count, 3);
  // Outside the 24 h window nothing is reported.
  assert.equal(doorShadowSummary(t0 + 25 * 60 * 60 * 1000).total, 0);
});

test("census: the dedupe map and the ring are capped, so a spray of sources cannot grow memory", () => {
  resetDoorShadow();
  const t0 = 1_800_000_000_000;
  const lines = [];
  const n = DOOR_SHADOW_MAX_KEYS + 60;
  for (let i = 0; i < n; i++) {
    // A distinct address per event, all at the same instant.
    recordDoorShadow({ cls: "unidentified", source: `198.51.${Math.floor(i / 254)}.${(i % 254) + 1}`, route: "POST /llm/v1/chat/completions" }, t0, (l) => lines.push(l));
  }
  assert.equal(lines.length, n, "every distinct source got its one line");
  assert.equal(doorShadowKeyCount(), DOOR_SHADOW_MAX_KEYS);
  assert.ok(doorShadowRingSize() <= DOOR_SHADOW_RING);
  resetDoorShadow();
});

test("census: a source that is not a plain address is logged as unknown, never echoed", () => {
  resetDoorShadow();
  const lines = [];
  for (const source of ["obfuscated-9f3a7c1d", "", null]) {
    resetDoorShadow();
    lines.length = 0;
    assert.equal(recordDoorShadow({ cls: "unidentified", source, route: "POST /llm/v1/chat/completions" }, 1_800_000_000_000, (l) => lines.push(l)), true);
    assert.match(lines[0], /source=unknown /);
    assert.equal(lines[0].includes("9f3a7c1d"), false);
  }
  // An IPv6 zone id is caller-chosen text: the address is kept, the zone never.
  resetDoorShadow();
  lines.length = 0;
  recordDoorShadow({ cls: "unidentified", source: "fe80::1%caller-chosen-text", route: "POST /llm/v1/chat/completions" }, 1_800_000_000_000, (l) => lines.push(l));
  assert.match(lines[0], /source=fe80::1 /);
  assert.equal(lines[0].includes("caller-chosen-text"), false);
  assert.equal(lines[0].includes("%"), false);
  resetDoorShadow();
});

test("census: an enforced refusal says so, and a throwing logger never throws", () => {
  resetDoorShadow();
  const lines = [];
  assert.equal(recordDoorShadow({ cls: "unidentified", source: "100.64.20.9", route: "POST /llm/acquire", enforced: true }, 1_800_000_000_000, (l) => lines.push(l)), true);
  assert.match(lines[0], /^\[llm-door\] refused an unidentified caller \(CROW_LLM_DOOR_ENFORCE=1\)/);
  assert.doesNotThrow(() => recordDoorShadow({ cls: "unidentified", source: "100.64.20.8", route: "POST /llm/acquire" }, 1_800_000_000_000, () => { throw new Error("boom"); }));
  resetDoorShadow();
});

// ---------------------------------------------------------------------------
// Part 3 — the real router: shadow mode changes no outcome, enforcement refuses
// ---------------------------------------------------------------------------

let up, srv, appUrl, upUrl;
let providers;
let remote = "127.0.0.1";
let peer = null;                 // classifyPeerFn override for the Serve cases
let now = 1_800_000_000_000;
let acquired = [];
let forwarded = 0;
let logs = [];

const asRemote = (req, _res, next) => {
  Object.defineProperty(req.socket, "remoteAddress", { value: remote, configurable: true });
  next();
};

before(async () => {
  up = http.createServer((rq, res) => {
    rq.resume();
    rq.on("end", () => {
      forwarded++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  upUrl = `http://127.0.0.1:${up.address().port}/v1`;
  providers = {
    "crow-voice": { baseUrl: upUrl, apiKey: "none", bundleId: "vllm-rocm-qwen35-4b", models: [{ id: "qwen3.5-4b" }] },
  };
  const app = express();
  app.use(asRemote);
  app.use(llmRouterRouter({
    acquireFn: async (pid) => { acquired.push(pid); return true; },
    resolveKeyFn: async (key) => ({ baseUrl: upUrl, model: key.split("/")[1], apiKey: null }),
    probeReadyFn: async () => true,
    warmFn: async (pid) => { acquired.push(pid); return true; },
    loadProvidersFn: () => ({ providers }),
    remoteAddressFn: () => remote,
    // Today's bearer rule: the local/models token.
    doorAuthFn: async (token) => token === LOCAL || token === MODELS,
    localTokenFn: async (token) => token === LOCAL || token === MODELS,
    peerTokenFn: async (token) => (token === PEER ? { id: "peer-1" } : null),
    // The Serve path in production is decided by peer-class.js (socket uid +
    // headers); here the peer is injected, exactly as req.crowPeer would be.
    classifyPeerFn: () => peer || { via: "direct", client: remote },
    // ownerLoginFn and enforceFn stay REAL: they read CROW_OWNER_TAILNET_LOGIN
    // and CROW_LLM_DOOR_ENFORCE, which every test sets explicitly.
    nowFn: () => now,
    logFn: (line) => logs.push(line),
    recordUsageFn: async () => {},
    resolveVoiceKeysFn: async () => ({ fast: "crow-voice/qwen3.5-4b", escalate: "crow-voice/qwen3.5-4b" }),
  }));
  srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  appUrl = `http://127.0.0.1:${srv.address().port}`;
});
after(() => { srv?.close(); up?.close(); });

function resetState() {
  resetDoorShadow();
  resetDoorCredentialMemo();
  logs = [];
  acquired = [];
  forwarded = 0;
  peer = null;
  remote = "127.0.0.1";
}

function withEnv(name, value, fn) {
  const saved = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  return Promise.resolve().then(fn).finally(() => {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  });
}

async function call(path, { headers = {}, body, method = "POST" } = {}) {
  acquired = [];
  forwarded = 0;
  const h = { ...headers };
  let payload;
  if (body !== undefined) { h["content-type"] = "application/json"; payload = JSON.stringify(body); }
  return fetch(`${appUrl}${path}`, { method, headers: h, body: payload });
}

const CHAT = { model: "crow-voice/qwen3.5-4b", messages: [{ role: "user", content: "hi" }] };
const P_CHAT = { model: "qwen3.5-4b", messages: [{ role: "user", content: "hi" }] };
const DOOR_PATHS = {
  v1: { path: "/llm/v1/chat/completions", body: CHAT },
  provider: { path: "/llm/p/crow-voice/v1/chat/completions", body: P_CHAT },
};
const shadowLines = () => logs.filter((l) => l.startsWith("[llm-door]"));
const summary = () => doorShadowSummary(now);

test("shadow: every caller admitted today is still admitted, on all three doors", async () => {
  await withEnv("CROW_OWNER_TAILNET_LOGIN", OWNER, async () => {
    resetState();
    // loopback, no credential
    for (const [name, d] of Object.entries(DOOR_PATHS)) {
      assert.equal((await call(d.path, { body: d.body })).status, 200, name);
    }
    assert.equal((await call("/llm/acquire", { body: { provider: "crow-voice" } })).status, 200);
    assert.deepEqual(shadowLines(), [], "loopback is never a would-refuse");

    // tailnet, no credential (today's 100.64/10 rule)
    resetState();
    remote = "100.64.20.5";
    for (const [name, d] of Object.entries(DOOR_PATHS)) {
      assert.equal((await call(d.path, { body: d.body })).status, 200, `${name}: still admitted in shadow mode`);
    }
    assert.equal((await call("/llm/acquire", { body: { provider: "crow-voice" } })).status, 200);

    // Serve-forwarded owner login (the dashboard/kiosk path)
    resetState();
    peer = { via: "serve", client: "100.64.20.5", tailnetLogin: OWNER };
    for (const [name, d] of Object.entries(DOOR_PATHS)) {
      const r = await call(d.path, { headers: { "x-forwarded-for": "100.64.20.5", "tailscale-user-login": OWNER }, body: d.body });
      assert.equal(r.status, 200, `${name}: the owner is admitted`);
    }

    // LAN with the credentials the door accepts today
    resetState();
    remote = "192.0.2.7";
    for (const token of [LOCAL, MODELS]) {
      const r = await call(DOOR_PATHS.v1.path, { headers: bearer(token), body: CHAT });
      assert.equal(r.status, 200, `${token}: the LAN bearer rule is untouched`);
    }
    assert.equal((await call("/llm/acquire", { headers: bearer(PEER), body: { provider: "crow-voice" } })).status, 403, "a peer token is not a door bearer today, and shadow mode does not add one");
  });
});

test("shadow: a caller today's rule refuses is still refused (403), never 401", async () => {
  await withEnv("CROW_OWNER_TAILNET_LOGIN", OWNER, async () => {
    resetState();
    remote = "192.0.2.7";
    const v1 = await call(DOOR_PATHS.v1.path, { body: CHAT });
    assert.equal(v1.status, 403);
    assert.equal((await v1.json()).error.code, "DOOR_SOURCE_REFUSED");
    assert.equal(forwarded, 0, "nothing was forwarded");
    const acq = await call("/llm/acquire", { body: { provider: "crow-voice" } });
    assert.equal(acq.status, 403);
    assert.equal((await acq.json()).error, "DOOR_SOURCE_REFUSED");
    // An owner-login class does NOT widen the source rule: a Serve-forwarded LAN
    // client is still refused, because the source check runs first.
    resetState();
    remote = "127.0.0.1";
    peer = { via: "serve", client: "192.0.2.7", tailnetLogin: OWNER };
    const relayed = await call(DOOR_PATHS.v1.path, { headers: { "x-forwarded-for": "192.0.2.7", "tailscale-user-login": OWNER }, body: CHAT });
    assert.equal(relayed.status, 403);
  });
});

test("shadow: the would-refuse event is recorded only for an unidentified caller, with source, route and model", async () => {
  resetState();
  remote = "100.64.20.5";
  const r = await call(DOOR_PATHS.v1.path, { body: CHAT });
  assert.equal(r.status, 200);
  const lines = shadowLines();
  assert.equal(lines.length, 1);
  assert.match(lines[0], /would refuse an unidentified caller/);
  assert.match(lines[0], /unidentified source=100\.64\.20\.5 login=- route=POST \/llm\/v1\/chat\/completions model=crow-voice\/qwen3\.5-4b$/);
  assert.equal(summary().total, 1);
  assert.equal(summary().sources[0].source, "100.64.20.5");

  // The provider door names its own route and model.
  resetState();
  remote = "100.64.20.6";
  assert.equal((await call(DOOR_PATHS.provider.path, { body: P_CHAT })).status, 200);
  assert.match(shadowLines()[0], /route=POST \/llm\/p\/crow-voice\/v1\/chat\/completions model=qwen3\.5-4b$/);

  // /llm/acquire, whose body is parsed before its gate.
  resetState();
  remote = "100.64.20.7";
  assert.equal((await call("/llm/acquire", { body: { provider: "crow-voice" } })).status, 200);
  assert.match(shadowLines()[0], /route=POST \/llm\/acquire model=-$/);

  // Nothing for a caller that holds a credential the door will keep accepting.
  for (const token of [LOCAL, MODELS, PEER]) {
    resetState();
    remote = "100.64.20.5";
    assert.equal((await call(DOOR_PATHS.v1.path, { headers: bearer(token), body: CHAT })).status, 200, token);
    assert.deepEqual(shadowLines(), [], `${token}: admitted on a credential, not a would-refuse`);
    assert.equal(summary().total, 0);
  }

  // Nothing for the owner through Serve, and nothing for loopback.
  resetState();
  peer = { via: "serve", client: "100.64.20.5", tailnetLogin: OWNER };
  await withEnv("CROW_OWNER_TAILNET_LOGIN", OWNER, async () => {
    assert.equal((await call(DOOR_PATHS.v1.path, { headers: { "x-forwarded-for": "100.64.20.5" }, body: CHAT })).status, 200);
  });
  assert.deepEqual(shadowLines(), []);
  resetState();
  assert.equal((await call(DOOR_PATHS.v1.path, { body: CHAT })).status, 200);
  assert.deepEqual(shadowLines(), []);
});

test("shadow: a Serve-forwarded non-owner login IS a would-refuse, but is not refused", async () => {
  resetState();
  peer = { via: "serve", client: "100.64.20.5", tailnetLogin: "someone@example.com" };
  const r = await call(DOOR_PATHS.v1.path, { headers: { "x-forwarded-for": "100.64.20.5", "tailscale-user-login": "someone@example.com" }, body: CHAT });
  assert.equal(r.status, 200, "shadow mode refuses nobody");
  assert.match(shadowLines()[0], /login=someone@example\.com/);
});

test("shadow: dedupe — one line per source+route per 10 min, and no token ever reaches a log line", async () => {
  resetState();
  remote = "100.64.20.5";
  const send = (headers = {}) => call(DOOR_PATHS.v1.path, { headers, body: CHAT });
  await send();
  await send();
  assert.equal(shadowLines().length, 1, "the same source and route inside the window logs once");
  // A different route from the same source is its own key.
  await call(DOOR_PATHS.provider.path, { body: P_CHAT });
  assert.equal(shadowLines().length, 2);
  // After the window it logs again.
  now += DOOR_SHADOW_WINDOW_MS;
  try {
    await send();
    assert.equal(shadowLines().length, 3, "the window has passed");
  } finally { now -= DOOR_SHADOW_WINDOW_MS; }

  // A garbage bearer must never appear in any line (nor an obfuscated forwarding
  // value, which is logged as "unknown" only).
  resetState();
  now += 1;
  try {
    await call(DOOR_PATHS.v1.path, { headers: { ...bearer(GARBAGE), "x-forwarded-for": `obfuscated-${GARBAGE}` }, body: CHAT });
  } finally { now -= 1; }
  const all = logs.join("\n");
  assert.equal(all.includes(GARBAGE), false, "no token and no obfuscated header value in the logs");
  for (const token of [LOCAL, MODELS, PEER]) assert.equal(all.includes(token), false, token);
  assert.equal(all.includes("hi"), false, "no request body in the logs");
});

test("enforce=1: unidentified callers get 401 on all three doors; every other class is admitted", async () => {
  await withEnv("CROW_OWNER_TAILNET_LOGIN", OWNER, () => withEnv("CROW_LLM_DOOR_ENFORCE", "1", async () => {
    resetState();
    remote = "100.64.20.5";
    for (const [name, d] of Object.entries(DOOR_PATHS)) {
      const r = await call(d.path, { body: d.body });
      assert.equal(r.status, 401, `${name}: refused`);
      assert.equal((await r.json()).error.code, "DOOR_CREDENTIAL_REQUIRED", name);
      assert.equal(forwarded, 0, `${name}: nothing forwarded`);
      assert.deepEqual(acquired, [], `${name}: nothing acquired`);
    }
    const acq = await call("/llm/acquire", { body: { provider: "crow-voice" } });
    assert.equal(acq.status, 401);
    const body = await acq.json();
    assert.equal(body.ok, false);
    assert.equal(body.error, "DOOR_CREDENTIAL_REQUIRED");
    assert.deepEqual(acquired, [], "no model was started");
    assert.match(shadowLines()[0], /refused an unidentified caller/);

    // Every other class is still admitted, whatever the source address is.
    const admitted = [
      ["loopback", {}, "127.0.0.1"],
      ["local token", bearer(LOCAL), "100.64.20.5"],
      ["models token", bearer(MODELS), "100.64.20.5"],
      ["peer token", bearer(PEER), "100.64.20.5"],
    ];
    for (const [name, headers, addr] of admitted) {
      remote = addr;
      for (const [door, d] of Object.entries(DOOR_PATHS)) {
        const r = await call(d.path, { headers, body: d.body });
        assert.equal(r.status, 200, `${name} on ${door}`);
      }
      assert.equal((await call("/llm/acquire", { headers, body: { provider: "crow-voice" } })).status, 200, `${name} on acquire`);
    }
    // The owner through Serve.
    resetState();
    remote = "127.0.0.1";
    peer = { via: "serve", client: "100.64.20.5", tailnetLogin: OWNER };
    assert.equal((await call(DOOR_PATHS.v1.path, { headers: { "x-forwarded-for": "100.64.20.5" }, body: CHAT })).status, 200);
    assert.deepEqual(shadowLines(), [], "the owner is not a would-refuse");
  }));
});

test("enforce=1 leaves today's 403 alone: a caller the source rule refuses is not a 401", async () => {
  await withEnv("CROW_LLM_DOOR_ENFORCE", "1", async () => {
    resetState();
    remote = "192.0.2.7";
    const r = await call(DOOR_PATHS.v1.path, { body: CHAT });
    assert.equal(r.status, 403);
    assert.equal((await r.json()).error.code, "DOOR_SOURCE_REFUSED");
  });
});

// ---------------------------------------------------------------------------
// Part 4 — the Nest item
// ---------------------------------------------------------------------------

test("Nest: the shadow summary lands as one info item, in en and es, and only when somebody was seen", async () => {
  const hs = await import("../servers/gateway/dashboard/panels/nest/health-signals.js");
  const { t } = await import("../servers/gateway/dashboard/shared/i18n.js");
  // Keep the machine's own facts out of this: no tailscale CLI, no docker, no
  // git in the integrity check.
  hs._setTailscaleReader(() => { throw new Error("no tailscale"); });
  hs._setDockerPortsReader(() => { throw new Error("no docker"); });
  hs._setFirewallReader(() => { throw new Error("ENOENT"); });
  hs._setContainerReader(() => false);
  hs._setIntegrityReaders({ git: () => { throw new Error("no git"); }, appRoot: "/nonexistent-crow-root" });
  const db = {
    async execute({ sql }) {
      if (sql.includes("pi_bot_defs")) return { rows: [{ c: 0 }] };
      if (sql.includes("auto_update")) return { rows: [] };
      if (sql.includes("COUNT(")) return { rows: [{ n: 0, c: 0, ips: 0 }] };
      return { rows: [] };
    },
  };
  const fixed = 1_800_000_000_000;
  const collect = async (lang) => {
    hs.invalidateHealthCache();
    return hs.collectHealthSignals(db, { now: () => fixed, lang, uptimeMs: 60_000 });
  };
  const find = (r) => r.issues.find((i) => i.id === "llm-door:unidentified-callers");

  resetDoorShadow();
  assert.equal(find(await collect("en")), undefined, "no card when nobody has been seen");

  recordDoorShadow({ cls: "unidentified", source: "100.64.20.5", route: "POST /llm/v1/chat/completions", model: "m" }, fixed);
  recordDoorShadow({ cls: "unidentified", source: "192.0.2.7", route: "POST /llm/acquire" }, fixed);

  const en = await collect("en");
  const item = find(en);
  assert.ok(item, "the item is there");
  assert.equal(item.severity, "info", "info: strip-only, never a push");
  assert.match(item.label, /Some devices use your models without a Crow credential; this will be refused soon/);
  assert.match(item.label, /100\.64\.20\.5 ×1/);
  assert.match(item.label, /192\.0\.2\.7 ×1/);
  assert.equal(en.issues.some((i) => i.id.startsWith("llm-door:") && i.severity === "warn"), false, "never a warning: nothing is refused yet");
  const card = en.details.find((d) => d.id === "llm-door:unidentified-callers");
  assert.ok(card, "the summary is a Nest reading too");
  assert.equal(card.state, "info");
  assert.match(card.value, /2 sources/);

  const es = await collect("es");
  assert.match(find(es).label, /sin una credencial de Crow/);
  assert.equal(t("signals.llmDoor.unidentified", "es").includes("{list}"), true);
  resetDoorShadow();
});