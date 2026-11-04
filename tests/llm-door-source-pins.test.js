// tests/llm-door-source-pins.test.js
//
// The door's source rule, pinned exactly as it behaves TODAY (the first PR of
// the satellite-exposure work), plus the shadow census line that must confirm,
// before the rule is narrowed to loopback + tailnet with no bearer exception,
// that nothing reaches a door on a credential alone.
//
// Every pin runs the same case twice: through isTrustedDoorRequest() directly,
// and through the real routers — the /llm/v1 and /llm/p source gate plus the
// /llm/acquire inline check, on a router built with injected remoteAddressFn
// and doorAuthFn. The /llm/models cases are mounted through llmModelsRouter on
// their own app: that file carries its own Funnel guard and no source check, so
// a request that never reached it would prove only a 404.
//
// Placeholder addresses only: 192.0.2.x / 198.51.100.x stand in for a LAN,
// 100.64.20.x and fd7a:115c:a1e0::20 for the tailnet.
process.env.COMPANION_FAST_MODEL = "crow-voice/qwen3.5-4b";
process.env.COMPANION_ESCALATION_MODEL = "crow-chat/qwen3.6-35b-a3b";

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import llmRouterRouter, { DOOR_CENSUS_WINDOW_MS, DOOR_CENSUS_MAX_KEYS, doorCensusSize, resetDoorCensus } from "../servers/gateway/routes/llm-router.js";
import llmModelsRouter from "../servers/gateway/routes/llm-models.js";
import { isTrustedDoorRequest } from "../servers/gateway/models/door-resolve.js";
import { normalizeAddr } from "../servers/shared/peer-class.js";

const GOOD = "good-token";
const BEARER = { authorization: `Bearer ${GOOD}` };
const CHAT = { model: "qwen3.5-4b", messages: [{ role: "user", content: "hi" }] };
const DOOR_CHAT = { model: "qwen3.6-35b-a3b", messages: [] };

let up, upUrl, srv, appUrl, mSrv, modelsUrl;
let remote = "100.64.20.5";       // the golden source: the tailnet, no bearer
let now = 1_700_000_000_000;      // the census clock
let acquired = [], forwarded = 0, authCalls = 0;
let started = [], stoppedList = [];
let logLines = [];                // cleared by every census test
const everyLine = [];             // never cleared: the "no token in any log" pin

/** Every request reports this address as its TCP peer. The models router has no
 * source seam of its own, so the harness shadows the socket's accessor (test
 * only); the door router reads the same value through remoteAddressFn. */
const asRemote = (req, _res, next) => {
  Object.defineProperty(req.socket, "remoteAddress", { value: remote, configurable: true });
  next();
};

let providers;
const lifecycle = {
  ownInstanceIdFn: () => "me",
  readReservationFn: () => null,
  snapshotOfFn: () => null,
  siblingsOfFn: () => [],
  externalHealthFn: () => ({}),
  acquireFn: async (name) => { started.push(name); return true; },
  stopFn: async (name) => { stoppedList.push(name); return { stopped: true }; },
};

before(async () => {
  up = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      forwarded++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  upUrl = `http://127.0.0.1:${up.address().port}/v1`;
  providers = {
    "crow-chat": { baseUrl: upUrl, doorUrl: "http://100.64.20.9:3001/llm/p/crow-chat/v1", apiKey: "none", models: [{ id: "qwen3.6-35b-a3b" }], gpuPolicy: { runtime: "native", owner: "me", port: 18102 } },
    "crow-voice": { baseUrl: upUrl, apiKey: "none", bundleId: "vllm-rocm-qwen35-4b", models: [{ id: "qwen3.5-4b" }] },
  };

  const doorApp = express();
  doorApp.use(asRemote);
  doorApp.use(llmRouterRouter({
    acquireFn: async (pid) => { acquired.push(pid); return true; },
    resolveKeyFn: async (key) => ({ baseUrl: upUrl, model: key.split("/")[1], apiKey: null }),
    probeReadyFn: async () => true,
    warmFn: async () => true,
    loadProvidersFn: () => ({ providers }),
    remoteAddressFn: () => remote,
    doorAuthFn: async (token) => { authCalls++; return token === GOOD; },
    resolveVoiceKeysFn: async () => ({ fast: "crow-voice/qwen3.5-4b", escalate: "crow-chat/qwen3.6-35b-a3b" }),
    recordUsageFn: async () => {},
    nowFn: () => now,
    logFn: (line) => { logLines.push(line); everyLine.push(line); },
  }));
  srv = http.createServer(doorApp);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  appUrl = `http://127.0.0.1:${srv.address().port}`;

  // /llm/models lives on its own app: llm-models.js owns its Funnel guard and
  // its bearer-only gate, and the door router's own /llm guard would answer
  // first if both were mounted together (which would pin the wrong thing).
  const modelsApp = express();
  modelsApp.use(asRemote);
  modelsApp.use(llmModelsRouter({
    authFn: async (token) => { authCalls++; return token === GOOD; },
    loadProvidersFn: () => ({ providers }),
    ...lifecycle,
  }));
  mSrv = http.createServer(modelsApp);
  await new Promise((r) => mSrv.listen(0, "127.0.0.1", r));
  modelsUrl = `http://127.0.0.1:${mSrv.address().port}`;
});
after(() => { srv?.close(); up?.close(); mSrv?.close(); });

async function withRemote(addr, fn) {
  const prev = remote;
  remote = addr;
  try { return await fn(); } finally { remote = prev; }
}

/** One request to the door app; counters reset so "nothing was started or
 * forwarded" is an assertion about THIS request only. */
async function door(path, { headers = {}, body, method = "POST" } = {}) {
  acquired = [];
  forwarded = 0;
  const h = { ...headers };
  let payload;
  if (body !== undefined) { h["content-type"] = "application/json"; payload = JSON.stringify(body); }
  return fetch(`${appUrl}${path}`, { method, headers: h, body: payload });
}

/** One request to the lifecycle app (/llm/models). */
function models(path, { headers = {}, method = "GET", body } = {}) {
  const h = { ...headers };
  let payload;
  if (body !== undefined) { h["content-type"] = "application/json"; payload = JSON.stringify(body); }
  return fetch(`${modelsUrl}${path}`, { method, headers: h, body: payload });
}

// ---------------------------------------------------------------------------
// Task S1.1 — the current rules, pinned
// ---------------------------------------------------------------------------

test("pin 1: a loopback socket with no forwarding header is allowed", async () => {
  assert.equal(isTrustedDoorRequest("127.0.0.1", {}), true);
  await withRemote("127.0.0.1", async () => {
    const r = await door("/llm/v1/chat/completions", { body: CHAT });
    assert.equal(r.status, 200);
    assert.deepEqual(acquired, ["crow-voice"]);
    assert.equal(forwarded, 1);
    assert.equal((await door("/llm/acquire", { body: { provider: "crow-chat" } })).status, 200);
  });
});

test("pin 2 (Serve-shaped): a loopback socket forwarding a tailnet client is allowed", async () => {
  for (const ff of ["100.64.20.5", "fd7a:115c:a1e0::20"]) {
    assert.equal(isTrustedDoorRequest("127.0.0.1", { "x-forwarded-for": ff }), true, ff);
  }
  await withRemote("127.0.0.1", async () => {
    for (const ff of ["100.64.20.5", "fd7a:115c:a1e0::20"]) {
      const r = await door("/llm/v1/chat/completions", { headers: { "x-forwarded-for": ff }, body: CHAT });
      assert.equal(r.status, 200, ff);
      assert.equal(forwarded, 1, ff);
    }
  });
});

test("pin 3: a loopback socket forwarding a LAN client is refused in all three header spellings", async () => {
  const headers = [
    { "x-forwarded-for": "192.0.2.7" },
    { "x-real-ip": "192.0.2.7" },
    { forwarded: "for=192.0.2.7" },
  ];
  for (const h of headers) assert.equal(isTrustedDoorRequest("127.0.0.1", h), false, JSON.stringify(h));
  await withRemote("127.0.0.1", async () => {
    for (const h of headers) {
      const r = await door("/llm/v1/chat/completions", { headers: h, body: CHAT });
      assert.equal(r.status, 403, JSON.stringify(h));
      assert.equal((await r.json()).error.code, "DOOR_SOURCE_REFUSED");
      assert.deepEqual(acquired, [], "nothing was started");
      assert.equal(forwarded, 0, "nothing was forwarded");
      assert.equal((await door("/llm/acquire", { headers: h, body: { provider: "crow-chat" } })).status, 403);
    }
  });
});

test("pin 4: a v4-mapped LAN address is refused as the socket and as a forwarded address", async () => {
  assert.equal(isTrustedDoorRequest("::ffff:192.0.2.7", {}), false);
  assert.equal(isTrustedDoorRequest("127.0.0.1", { "x-forwarded-for": "::ffff:192.0.2.7" }), false);
  await withRemote("::ffff:192.0.2.7", async () => {
    assert.equal((await door("/llm/v1/chat/completions", { body: CHAT })).status, 403);
    assert.equal((await door("/llm/acquire", { body: { provider: "crow-chat" } })).status, 403);
    assert.equal(forwarded, 0);
  });
  await withRemote("127.0.0.1", async () => {
    assert.equal((await door("/llm/v1/chat/completions", { headers: { "x-forwarded-for": "::ffff:192.0.2.7" }, body: CHAT })).status, 403);
    assert.equal(forwarded, 0);
  });
});

test("pin 5: the hex-mapped spelling of a LAN address is refused, and it fails at the classification, not at a parse", async () => {
  const hex = "::ffff:c000:0207";
  // It parses: normalizeAddr unwraps it to the same IPv4 the dotted spelling has.
  assert.equal(normalizeAddr(hex), "192.0.2.7");
  assert.equal(isTrustedDoorRequest(hex, {}), false, "as the socket");
  assert.equal(isTrustedDoorRequest("127.0.0.1", { "x-forwarded-for": hex }), false, "as a forwarded address");
  // Control: the DOTTED form of a tailnet address passes through the same path,
  // so the refusals above are the address class, not an unparseable value.
  assert.equal(normalizeAddr("::ffff:100.100.1.1"), "100.100.1.1");
  assert.equal(isTrustedDoorRequest("::ffff:100.100.1.1", {}), true);
  await withRemote(hex, async () => {
    assert.equal((await door("/llm/v1/chat/completions", { body: CHAT })).status, 403);
    assert.equal(forwarded, 0);
  });
  await withRemote("127.0.0.1", async () => {
    assert.equal((await door("/llm/v1/chat/completions", { headers: { "x-forwarded-for": hex }, body: CHAT })).status, 403);
    assert.equal(forwarded, 0);
  });
});

test("pin 6: a forwarded entry that is not an address is refused", async () => {
  for (const v of ["unknown", "obfuscated-2f9c41", "_hidden"]) {
    assert.equal(isTrustedDoorRequest("127.0.0.1", { "x-forwarded-for": v }), false, v);
  }
  await withRemote("127.0.0.1", async () => {
    for (const v of ["unknown", "obfuscated-2f9c41", "_hidden"]) {
      const r = await door("/llm/v1/chat/completions", { headers: { "x-forwarded-for": v }, body: CHAT });
      assert.equal(r.status, 403, v);
      assert.equal(forwarded, 0, v);
    }
  });
});

test("pin 7: a mixed header (one tailnet entry, one LAN entry) is refused — a header can only take trust away", async () => {
  const mixed = { "x-forwarded-for": "100.64.20.5, 192.0.2.7" };
  assert.equal(isTrustedDoorRequest("127.0.0.1", mixed), false);
  await withRemote("127.0.0.1", async () => {
    const r = await door("/llm/v1/chat/completions", { headers: mixed, body: CHAT });
    assert.equal(r.status, 403);
    assert.equal((await r.json()).error.code, "DOOR_SOURCE_REFUSED");
    assert.deepEqual(acquired, []);
    assert.equal(forwarded, 0);
  });
});

test("pin 8: a tailnet socket with no bearer is allowed, in every spelling; the just-outside controls are refused", async () => {
  const tailnet = ["100.64.0.1", "100.127.255.254", "::ffff:100.100.1.1", "fd7a:115c:a1e0::20"];
  const outside = ["100.63.255.255", "100.128.0.1", "fd7a:115c:a1e1::1"];
  for (const a of tailnet) assert.equal(isTrustedDoorRequest(a, {}), true, a);
  for (const a of outside) assert.equal(isTrustedDoorRequest(a, {}), false, a);
  for (const a of tailnet) {
    await withRemote(a, async () => {
      assert.equal((await door("/llm/v1/chat/completions", { body: CHAT })).status, 200, a);
      assert.equal(forwarded, 1, a);
    });
  }
  for (const a of outside) {
    await withRemote(a, async () => {
      assert.equal((await door("/llm/v1/chat/completions", { body: CHAT })).status, 403, a);
      assert.equal(forwarded, 0, a);
    });
  }
});

test("pin 9: a Funnel-headed request is 403 FUNNEL_REFUSED on every door route and on /llm/models, bearer or not", async () => {
  const funnel = { "tailscale-funnel-request": "?1" };
  await withRemote("127.0.0.1", async () => {
    for (const path of ["/llm/v1/chat/completions", "/llm/p/crow-chat/v1/chat/completions"]) {
      const r = await door(path, { headers: funnel, body: DOOR_CHAT });
      assert.equal(r.status, 403, path);
      assert.equal((await r.json()).error.code, "FUNNEL_REFUSED", path);
      assert.equal(forwarded, 0, path);
    }
    const a = await door("/llm/acquire", { headers: funnel, body: { provider: "crow-chat" } });
    assert.equal(a.status, 403);
    assert.equal((await a.json()).error.code, "FUNNEL_REFUSED");
    // Even with a valid bearer from loopback: the Funnel guard runs first.
    const b = await door("/llm/v1/chat/completions", { headers: { ...funnel, ...BEARER }, body: CHAT });
    assert.equal(b.status, 403);
    assert.equal((await b.json()).error.code, "FUNNEL_REFUSED");
    assert.equal(forwarded, 0);
    // /llm/models' own guard, through llmModelsRouter (a Funnel-headed request
    // that never reached that file would be a 404, which would pin nothing).
    const m = await models("/llm/models", { headers: { ...funnel, ...BEARER } });
    assert.equal(m.status, 403);
    assert.equal((await m.json()).error.code, "FUNNEL_REFUSED");
  });
});

test("pin 10: a LAN socket with no bearer is 403 DOOR_SOURCE_REFUSED on all three door routes, with nothing started or forwarded", async () => {
  for (const a of ["192.0.2.7", "198.51.100.9", "::ffff:192.0.2.7", "172.17.0.2"]) {
    assert.equal(isTrustedDoorRequest(a, {}), false, a);
    await withRemote(a, async () => {
      const v1 = await door("/llm/v1/chat/completions", { body: CHAT });
      assert.equal(v1.status, 403, a);
      assert.equal((await v1.json()).error.code, "DOOR_SOURCE_REFUSED", a);
      assert.deepEqual(acquired, [], `${a}: nothing acquired`);
      assert.equal(forwarded, 0, `${a}: nothing forwarded`);

      const p = await door("/llm/p/crow-chat/v1/chat/completions", { body: DOOR_CHAT });
      assert.equal(p.status, 403, a);
      assert.equal((await p.json()).error.code, "DOOR_SOURCE_REFUSED", a);
      assert.deepEqual(acquired, [], `${a}: nothing acquired through the provider door`);
      assert.equal(forwarded, 0, `${a}: nothing forwarded through the provider door`);

      const acq = await door("/llm/acquire", { body: { provider: "crow-chat" } });
      assert.equal(acq.status, 403, a);
      assert.equal((await acq.json()).error, "DOOR_SOURCE_REFUSED", a);
    });
  }
});

test("pin 11: a LAN socket WITH a valid bearer is admitted today — the reversal, PR S2, flips exactly this", async () => {
  // Written to TODAY's behaviour on purpose: a source the rule refuses is still
  // admitted when it presents a valid local/models bearer. PR S2 (the reversal)
  // changes this test to expect 403, and touches it deliberately.
  await withRemote("192.0.2.7", async () => {
    const v1 = await door("/llm/v1/chat/completions", { headers: BEARER, body: CHAT });
    assert.equal(v1.status, 200);
    assert.deepEqual(acquired, ["crow-voice"]);
    assert.equal(forwarded, 1, "a LAN bearer caller was forwarded to the engine");

    const p = await door("/llm/p/crow-chat/v1/chat/completions", { headers: BEARER, body: DOOR_CHAT });
    assert.equal(p.status, 200);
    assert.equal(forwarded, 1);

    const acq = await door("/llm/acquire", { headers: BEARER, body: { provider: "crow-chat" } });
    assert.equal(acq.status, 200);
    assert.equal((await acq.json()).ok, true);
  });
});

test("pin 12: /llm/models from a LAN socket with a valid bearer is allowed today and can start and evict models (operator gate G2)", async () => {
  // /llm/models has NO source check at all: the bearer is the only gate, so the
  // source address cannot change the outcome (the harness reports a LAN peer).
  // Pinned as is; whether this lifecycle API gets the door's source rule is
  // operator gate G2, a later PR.
  await withRemote("192.0.2.7", async () => {
    const listed = await models("/llm/models", { headers: BEARER });
    assert.equal(listed.status, 200);

    started = [];
    const start = await models("/llm/models/crow-chat/start", { headers: BEARER, method: "POST" });
    assert.equal(start.status, 202);
    const { job_id } = await start.json();
    for (let i = 0; i < 40; i++) {
      const job = await (await models(`/llm/models/jobs/${job_id}`, { headers: BEARER })).json();
      if (["resident", "failed", "blocked_by_reservation"].includes(job.state)) { assert.equal(job.state, "resident"); break; }
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.deepEqual(started, ["crow-chat"]);

    stoppedList = [];
    const stop = await models("/llm/models/crow-chat/stop", { headers: BEARER, method: "POST" });
    assert.equal(stop.status, 200);
    assert.deepEqual(stoppedList, ["crow-chat"], "a LAN bearer holder can evict a running model");
  });
});

// ---------------------------------------------------------------------------
// Task S1.2 — the shadow census
// ---------------------------------------------------------------------------

const CENSUS_PREFIX = "[llm-router] bearer admitted from a non-tailnet source";
const censusLines = () => logLines.filter((l) => l.startsWith(CENSUS_PREFIX));

function resetCensus() {
  resetDoorCensus();
  logLines = [];
}

// A LAN address the door refuses, carrying a valid bearer: one line, naming the
// LAN address and its class rather than the loopback socket that relayed it.
test("census: a loopback socket relaying a LAN client logs exactly ONE line, naming the LAN address and class lan", async () => {
  resetCensus();
  await withRemote("127.0.0.1", async () => {
    const r = await door("/llm/v1/chat/completions", { headers: { "x-forwarded-for": "192.0.2.7", ...BEARER, "x-crow-client": "pin-test" }, body: CHAT });
    assert.equal(r.status, 200);
  });
  const lines = censusLines();
  assert.equal(lines.length, 1);
  assert.match(lines[0], /: lan 192\.0\.2\.7 route=POST \/llm\/v1\/chat\/completions client=pin-test$/);
  assert.equal(lines[0].includes("127.0.0.1"), false, "the loopback socket is not the source the line names");
});

test("census: a repeat inside the window logs nothing; the same key logs again in a new window", async () => {
  resetCensus();
  const send = () => withRemote("127.0.0.1", () => door("/llm/v1/chat/completions", { headers: { "x-forwarded-for": "192.0.2.7", ...BEARER }, body: CHAT }));
  await send();
  assert.equal(censusLines().length, 1);
  await send();
  assert.equal(censusLines().length, 1, "one line per (class, address) inside the window");
  now += DOOR_CENSUS_WINDOW_MS;
  try {
    await send();
    assert.equal(censusLines().length, 2, "the window has passed, so it logs again");
  } finally { now -= DOOR_CENSUS_WINDOW_MS; }
});

test("census: a tailnet source with a bearer logs nothing (the source check passed, the bearer is never even read)", async () => {
  resetCensus();
  const before = authCalls;
  await withRemote("100.64.20.5", async () => {
    assert.equal((await door("/llm/v1/chat/completions", { headers: BEARER, body: CHAT })).status, 200);
  });
  assert.equal(censusLines().length, 0);
  assert.equal(authCalls, before, "the bearer check never ran");
});

test("census: a LAN source with no bearer logs nothing (it is refused, not admitted)", async () => {
  resetCensus();
  await withRemote("192.0.2.7", async () => {
    assert.equal((await door("/llm/v1/chat/completions", { body: CHAT })).status, 403);
    assert.equal((await door("/llm/acquire", { body: { provider: "crow-chat" } })).status, 403);
  });
  assert.equal(censusLines().length, 0);
});

test("census: an entry that is not an address logs the class invalid only, and the token is never logged", async () => {
  resetCensus();
  const tokenLike = "tok-9f3a7c1d";
  await withRemote("127.0.0.1", async () => {
    const r = await door("/llm/v1/chat/completions", {
      headers: { "x-forwarded-for": `obfuscated-${tokenLike}`, ...BEARER, "x-crow-client": "pin-test" },
      body: CHAT,
    });
    assert.equal(r.status, 200);
  });
  const lines = censusLines();
  assert.equal(lines.length, 1);
  assert.match(lines[0], /: invalid route=/);
  assert.equal(lines[0].includes(tokenLike), false, "the header value never reaches the line");
  assert.equal(everyLine.join("\n").includes(GOOD), false, "the bearer is never logged");
  assert.equal(everyLine.join("\n").includes(tokenLike), false);
});

test("census: the rate-limit map is capped — a spray of distinct addresses cannot grow it", async () => {
  resetCensus();
  const addrs = [];
  for (let i = 1; i <= 254; i++) addrs.push(`192.0.2.${i}`);
  for (let i = 1; i <= 50; i++) addrs.push(`198.51.100.${i}`);
  assert.ok(addrs.length > DOOR_CENSUS_MAX_KEYS);
  await withRemote("127.0.0.1", async () => {
    for (const a of addrs) {
      const r = await door("/llm/v1/chat/completions", { headers: { "x-forwarded-for": a, ...BEARER }, body: CHAT });
      assert.equal(r.status, 200, a);
    }
  });
  assert.equal(censusLines().length, addrs.length, "every distinct address got its one line");
  assert.equal(doorCensusSize(), DOOR_CENSUS_MAX_KEYS);
  // The oldest keys were evicted, so the first address of the spray logs again.
  const before = censusLines().length;
  await withRemote("127.0.0.1", async () => {
    await door("/llm/v1/chat/completions", { headers: { "x-forwarded-for": addrs[0], ...BEARER }, body: CHAT });
  });
  assert.equal(censusLines().length, before + 1);
  assert.equal(doorCensusSize(), DOOR_CENSUS_MAX_KEYS);
});