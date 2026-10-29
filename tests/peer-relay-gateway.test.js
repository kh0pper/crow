/**
 * Item 46 PR-B (B4) smoke: on ONE real gateway (its own child process and
 * scratch home), the peer relay is mounted, the relay token file is minted at
 * boot, and nothing earlier in the middleware stack lets a request through
 * without the relay token and a signed actor. No board or local token opens it.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { Instance } from "./fixtures/peer-pair.mjs";

let A;
before(async () => {
  A = new Instance("alpha", "100.64.20.11");
  await A.init();
  await A.boot();
});
after(async () => { await A?.cleanup(); });

const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } };
async function post(headers) {
  const r = await fetch(`http://127.0.0.1:${A.port}/peer-relay/inst-bravo-0002/memory/mcp`, {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(INIT),
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}

test("the relay is live behind its own token and actor check", async () => {
  const tokenPath = join(A.dir, "secrets", "peer-relay-token");
  assert.ok(existsSync(tokenPath), "relay token minted at boot");
  assert.equal(statSync(tokenPath).mode & 0o777, 0o600);
  const relayToken = readFileSync(tokenPath, "utf8").trim();
  const boardToken = readFileSync(join(A.dir, "board-token"), "utf8").trim();

  let r = await post({});
  assert.equal(r.status, 401, r.text);
  assert.match(r.json.error.message, /relay token/);
  r = await post({ Authorization: `Bearer ${boardToken}` });
  assert.equal(r.status, 401, "the board token does not open the relay: " + r.text);
  assert.match(r.json.error.message, /relay token/);
  r = await post({ Authorization: `Bearer ${relayToken}` });
  assert.equal(r.status, 401, r.text);
  assert.match(r.json.error.message, /actor/);
  r = await post({ Authorization: `Bearer ${relayToken}`, "X-Crow-Actor-Id": "hank", "X-Crow-Actor-Sig": "0".repeat(64) });
  assert.equal(r.status, 401, r.text);
  assert.match(r.json.error.message, /actor/);

  // The relay token authenticates no MCP mount.
  const m = await fetch(`http://127.0.0.1:${A.port}/memory/mcp`, {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", Authorization: `Bearer ${relayToken}` }, body: JSON.stringify(INIT),
  });
  assert.equal(m.status, 401, "the relay token is not an MCP credential");
});

// B6: the loopback signing relay is mounted on the real gateway, nothing earlier
// in the stack answers for it, and a caller that is not a bot host unit's main
// process (this test process) gets no signature.
test("the signing relay is live and refuses a process that is not a bot host", async () => {
  const ask = async (headers = {}) => {
    const r = await fetch(`http://127.0.0.1:${A.port}/internal/actor-sign`, {
      method: "POST", headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ botId: "hank", sessionId: "1", threadId: "t", gatewayType: "gmail", kinds: ["peer-relay"] }),
    });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text };
  };
  const r = await ask();
  assert.equal(r.status, 403, r.text);
  assert.match(r.json.error, /bot host/);
  assert.equal(r.json.sigs, undefined);
  const fwd = await ask({ "X-Forwarded-For": "100.64.20.7" });
  assert.equal(fwd.status, 404, fwd.text);
});
