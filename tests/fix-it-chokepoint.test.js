import { test } from "node:test";
import assert from "node:assert/strict";
import { enforcePeerExposure } from "../servers/gateway/peer-exposure.js";

function mkRes() {
  return { _status: null, _json: null, headersSent: false,
    status(c) { this._status = c; return this; },
    json(o) { this._json = o; this.headersSent = true; return this; } };
}
const fakeDb = {}; // not read when exposedSetOverride is supplied
const connected = new Map([["funkwhale", { tools: [{ name: "fw_play" }] }]]);

test("a not_exposed deny emits peer-exposure:denied once with the canonical capability", async () => {
  const emits = [];
  const req = { instanceAuth: { instance: { id: "peer-1" } }, body: { method: "tools/call", params: { name: "fw_play" }, id: 7 } };
  const res = mkRes();
  const ok = await enforcePeerExposure({
    prefix: "tools", req, res, db: fakeDb, connectedServers: connected,
    exposedSetOverride: new Set(), // deny-all
    auditFn: async () => {},
    emitFn: async (db, ev, payload) => { emits.push([ev, payload]); },
  });
  assert.equal(ok, false);
  assert.equal(res._status, 403);
  assert.equal(emits.length, 1);
  assert.equal(emits[0][0], "peer-exposure:denied");
  assert.equal(emits[0][1].capability, "funkwhale");
  assert.equal(emits[0][1].requestingInstance, "peer-1");
  assert.equal(emits[0][1].toolName, "fw_play");
});

test("an ALLOWED call does not emit", async () => {
  const emits = [];
  const req = { instanceAuth: { instance: { id: "peer-1" } }, body: { method: "tools/call", params: { name: "fw_play" }, id: 1 } };
  const res = mkRes();
  const ok = await enforcePeerExposure({
    prefix: "tools", req, res, db: fakeDb, connectedServers: connected,
    exposedSetOverride: new Set(["funkwhale"]),
    auditFn: async () => {}, emitFn: async (db, ev, p) => emits.push([ev, p]),
  });
  assert.equal(ok, true);
  assert.equal(emits.length, 0);
});

test("a throwing emitFn never breaks the gate", async () => {
  const req = { instanceAuth: { instance: { id: "peer-1" } }, body: { method: "tools/call", params: { name: "fw_play" }, id: 2 } };
  const res = mkRes();
  const ok = await enforcePeerExposure({
    prefix: "tools", req, res, db: fakeDb, connectedServers: connected,
    exposedSetOverride: new Set(), auditFn: async () => {},
    emitFn: async () => { throw new Error("boom"); },
  });
  assert.equal(ok, false);
  assert.equal(res._status, 403);
});
