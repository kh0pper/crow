// An in-test PAIRED satellite for crow's management code (SAT-5): a `fetchImpl` (no sockets)
// that verifies every signed request against the pinned mgmt key (§5.1) and signs every JSON
// answer (§5.2). Routes are a map "METHOD /path" → (ctx) => {status, json} | {status, raw,
// contentType} | {drop:true} (handled, answer lost); tests override any of them. /health is
// unsigned. Every request is recorded.
//
// makeSatelliteRow() also makes crow's side: a satellites row, a mgmt key file (mgmt-keys.js)
// and a cert issued by a fake root identity, so a route test starts from "paired".
import {
  generateKeypair, satelliteIdFromPub, verifyRequest, signResponse, sha256Hex, canonicalJson, AGENT_PROTOCOL,
} from "../../servers/shared/satellite-protocol.js";
import { createMgmtKey } from "../../servers/gateway/satellites/mgmt-keys.js";
import { issueCert } from "../../servers/gateway/satellites/certs.js";
import { insertSatellite } from "../../servers/gateway/satellites/store.js";
import { fakeIdentity } from "./fake-satellite.js";

export const MGMT_HOST = "satellite.example.ts.net";
export const PRIMARY_URL = "https://crow.example.ts.net:8444";

export const toolsHash = (tools) => sha256Hex(canonicalJson(tools));

export function demoTools(extra = []) {
  return [
    { name: "demo_list", description: "List things", inputSchema: { type: "object", properties: {} } },
    { name: "demo_create", description: "Create a thing", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
    ...extra,
  ];
}

// `clock` is the satellite clock /health reports; signatures are checked against real time
// (crow signs with Date.now()), as the real agent would on a synced box.
export function createMgmtFake({ host = MGMT_HOST, routes = {}, clock = () => Date.now(), verifyNow = () => Date.now() } = {}) {
  const key = generateKeypair();
  const satId = satelliteIdFromPub(key.pubHex);
  const state = {
    mgmtPub: null, requests: [], unreachable: false, tools: { demo: demoTools() }, toolVersion: { demo: "1.0.0" },
    psi: 0.5, healthTime: null, certs: [],
  };
  const json = (status, obj, headers = {}) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", ...headers } });

  const statusBody = () => ({
    satellite_id: satId, agent_protocol: AGENT_PROTOCOL, sha: "c".repeat(40),
    cert: null,
    mem: { MemTotal: 1000 * 1048576, MemAvailable: 400 * 1048576, SwapTotal: 2048 * 1048576, SwapFree: 2000 * 1048576 },
    psi_memory_some_avg10: state.psi, disk_free_bytes: 20e9, uptime_s: 1000,
    installed: Object.keys(state.tools).map((id) => ({ id, version: state.toolVersion[id] })),
    tools: Object.fromEntries(Object.entries(state.tools).map(([id, t]) => [id, t === null
      ? { version: state.toolVersion[id], error: "tools_too_large" }
      : { version: state.toolVersion[id], sha256: toolsHash(t) }])),
  });

  const defaults = {
    "GET /satellite/v1/status": () => ({ status: 200, json: statusBody() }),
    "POST /satellite/v1/cert": ({ body }) => { state.certs.push(body.cert); state.mgmtPub = body.cert.payload.mgmt_pubkey; return { status: 200, json: { ok: true, serial: body.cert.payload.serial, expires_at: body.cert.payload.expires_at, rotated: false } }; },
    "POST /satellite/v1/unpair": () => ({ status: 200, json: { ok: true } }),
    "POST /satellite/v1/update": ({ body }) => ({ status: 202, json: { ok: true, from: "c".repeat(40), to: body.target_sha, npm: false } }),
    "POST /satellite/v1/mcp/:bundle": ({ params, body }) => {
      const t = state.tools[params.bundle];
      if (t === undefined) return { status: 404, json: { error: "unknown_bundle" } };
      if (body.method === "tools/list") return { status: 200, json: { jsonrpc: "2.0", id: body.id, result: { tools: t } } };
      return { status: 200, json: { jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "nope" } } };
    },
  };
  const table = { ...defaults, ...routes };

  function match(method, path) {
    for (const [k, fn] of Object.entries(table)) {
      const [m, pat] = k.split(" ");
      if (m !== method) continue;
      const names = [];
      const re = new RegExp("^" + pat.replace(/:([a-z_]+)/g, (_x, n) => { names.push(n); return "([^/]+)"; }) + "$");
      const mm = re.exec(path);
      if (mm) return { fn, params: Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(mm[i + 1])])) };
    }
    return null;
  }

  async function fetchImpl(url, init = {}) {
    const u = new URL(url);
    const method = (init.method || "GET").toUpperCase();
    const body = typeof init.body === "string" ? init.body : init.body == null ? "" : String(init.body);
    state.requests.push({ url: String(url), method, path: u.pathname, search: u.search, headers: { ...(init.headers || {}) }, body });
    if (state.unreachable || u.host !== host || u.protocol !== "https:") throw new TypeError("fetch failed");
    if (u.pathname === "/health") return json(200, { ok: true, protocol: AGENT_PROTOCOL, time: new Date(state.healthTime ?? clock()).toISOString() });
    const v = verifyRequest(state.mgmtPub, { method, pathQuery: u.pathname + u.search, body, headers: init.headers || {}, satelliteId: satId, now: verifyNow() });
    const signedJson = (status, obj, nonce) => {
      const text = JSON.stringify(obj);
      const sig = signResponse(key.privHex, { requestNonce: nonce, status, bodySha256: sha256Hex(text) });
      return new Response(text, { status, headers: { "content-type": "application/json", "x-crow-sat-resp-sig": sig } });
    };
    // Like the real agent, a refusal of a request with a well-formed nonce is signed.
    if (!v.ok) {
      const n = (init.headers || {})["X-Crow-Sat-Nonce"];
      return /^[0-9a-f]{32}$/.test(n || "") ? signedJson(401, { error: v.code }, n) : json(401, { error: v.code });
    }
    const hit = match(method, u.pathname);
    const out = hit ? await hit.fn({ params: hit.params, body: body ? JSON.parse(body) : {}, caller: v.caller, query: Object.fromEntries(u.searchParams), state }) : { status: 404, json: { error: "not_found" } };
    if (out.drop) throw new TypeError("fetch failed"); // processed, but the answer is lost
    if (out.raw !== undefined) return new Response(out.raw, { status: out.status, headers: { "content-type": out.contentType || "application/octet-stream" } });
    return signedJson(out.status, out.json, v.nonce);
  }

  return { fetchImpl, state, satId, key, host, table, statusBody };
}

/**
 * crow's side of an already-paired satellite: mgmt key file, cert, satellites row. The fake
 * pins the mgmt key. Returns {row, identity, mgmtKey, cert}.
 */
export async function makeSatelliteRow(db, fake, { name = "black-swan-test", env = process.env, now = Date.now(), identity = fakeIdentity(), status = "active", agent_protocol = AGENT_PROTOCOL, certNow = now } = {}) {
  const mgmtKey = createMgmtKey(fake.satId, { env, replace: true });
  const cert = issueCert({
    identity, instanceId: "inst-primary", primaryUrl: PRIMARY_URL, satellite_id: fake.satId,
    satellite_pubkey: fake.key.pubHex, mgmt_pubkey: mgmtKey.ed25519_pub, now: certNow,
  });
  fake.state.mgmtPub = mgmtKey.ed25519_pub;
  const row = {
    id: fake.satId, name, tailnet_host: fake.host, satellite_pubkey: fake.key.pubHex, mgmt_pubkey: mgmtKey.ed25519_pub,
    cert_json: JSON.stringify(cert), cert_serial: cert.payload.serial, cert_expires_at: cert.payload.expires_at,
    primary_url: PRIMARY_URL, agent_protocol, status, created_at: new Date(now).toISOString(), last_seen_at: new Date(now).toISOString(),
  };
  await insertSatellite(db, row);
  return { row, identity, mgmtKey, cert };
}
