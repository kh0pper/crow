/**
 * Loopback mount helper smoke: on ONE real gateway (child process, scratch
 * home) the two family tokens (services, satellite-tools) are minted under
 * <home>/secrets/ at boot (0600), rotated on every boot, and refused by every
 * other door. No concrete mount exists in this change, so nothing answers a
 * family path with a 2xx. Characterization test: the behaviour pre-dates it.
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
const files = { services: "services-token", satellite: "satellite-tools-token" };
const readTok = (k) => readFileSync(join(A.dir, "secrets", files[k]), "utf8").trim();
async function post(path, token) {
  const r = await fetch(`http://127.0.0.1:${A.port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(INIT),
  });
  return { status: r.status, text: await r.text() };
}
const OTHER_DOORS = ["/board/mcp", "/memory/mcp", "/peer-relay/inst-bravo-0002/memory/mcp"];
const FAMILY_PATHS = [`/services-tools/00000000-0000-4000-8000-000000000000/mcp`, "/satellite-tools/a/b/mcp"];

test("both family tokens are minted under secrets/ at 0600", () => {
  for (const k of Object.keys(files)) {
    const p = join(A.dir, "secrets", files[k]);
    assert.ok(existsSync(p), `${files[k]} minted at boot`);
    assert.equal(statSync(p).mode & 0o777, 0o600);
    assert.match(readTok(k), /^[0-9a-f]{64}$/);
  }
  assert.notEqual(readTok("services"), readTok("satellite"));
  assert.match(A.log, /\[gateway\] services-tools token rotated/);
  assert.match(A.log, /\[gateway\] satellite-tools token rotated/);
});

test("every other door refuses both family tokens, and no family path answers 2xx", async () => {
  for (const k of Object.keys(files)) {
    for (const path of OTHER_DOORS) {
      const r = await post(path, readTok(k));
      assert.equal(r.status, 401, `${k} token at ${path}: ${r.text}`);
    }
  }
  for (const path of FAMILY_PATHS) {
    for (const tok of [null, readTok("services"), readTok("satellite")]) {
      const r = await post(path, tok);
      assert.ok(r.status < 200 || r.status >= 300, `${path} must not answer 2xx, got ${r.status}`);
    }
  }
});

test("a restart rotates both tokens and the old ones are refused", async () => {
  const old = { services: readTok("services"), satellite: readTok("satellite") };
  await A.boot();
  for (const k of Object.keys(files)) {
    const fresh = readTok(k);
    assert.match(fresh, /^[0-9a-f]{64}$/);
    assert.notEqual(fresh, old[k], `${k} token rotated on boot`);
    assert.equal(statSync(join(A.dir, "secrets", files[k])).mode & 0o777, 0o600);
    for (const path of OTHER_DOORS) {
      assert.equal((await post(path, old[k])).status, 401, `old ${k} token at ${path}`);
      assert.equal((await post(path, fresh)).status, 401, `new ${k} token at ${path}`);
    }
  }
  assert.match(A.log, /\[gateway\] services-tools token rotated/);
});
