/**
 * provider-health — the zero-import per-process residency state module
 * (F-HEALTH-1 Task 1). Mirrors tests/messages-health-signal.test.js in shape:
 * reset the singleton at the top of every test, inject the clock explicitly via
 * `nowMs`, and assert on the shape returned by getProviderHealth().
 *
 * The load-bearing invariants under test: firstOwnedAt records the START of
 * ownership and never moves on a repeat not-ready; lastReadyAt records the LAST
 * success and is what the outage clock restarts from; pruneResidency drops only
 * UNDECLARED names (never a declared-but-not-ready one — the reviewed CRITICAL);
 * and getProviderHealth() hands back a copy that callers cannot use to mutate
 * module state.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  setResidencyInitialized, recordResidency, releaseResidency,
  pruneResidency, getProviderHealth, _resetProviderHealth,
} from "../servers/gateway/provider-health.js";

test("fresh state → initialized:false, providers empty", () => {
  _resetProviderHealth();
  const h = getProviderHealth();
  assert.equal(h.initialized, false);
  assert.deepEqual(h.providers, {});
});

test("setResidencyInitialized() flips initialized", () => {
  _resetProviderHealth();
  setResidencyInitialized();
  assert.equal(getProviderHealth().initialized, true);
});

test("first recordResidency ready:false → owned, firstOwnedAt stamped, lastReadyAt null", () => {
  _resetProviderHealth();
  recordResidency("crow-voice", {
    ready: false, nowMs: 1000, baseUrl: "http://x:8011/v1",
  });
  const p = getProviderHealth().providers["crow-voice"];
  assert.equal(p.owned, true);
  assert.equal(p.firstOwnedAt, 1000);
  assert.equal(p.lastReadyAt, null);
  assert.equal(p.ready, false);
  assert.equal(p.checkedAt, 1000);
  assert.equal(p.baseUrl, "http://x:8011/v1");
});

test("second ready:false does not move firstOwnedAt or lastReadyAt, but advances checkedAt", () => {
  _resetProviderHealth();
  recordResidency("crow-voice", { ready: false, nowMs: 1000, baseUrl: "http://x/v1" });
  recordResidency("crow-voice", { ready: false, nowMs: 5000, baseUrl: "http://x/v1" });
  const p = getProviderHealth().providers["crow-voice"];
  assert.equal(p.firstOwnedAt, 1000); // outage clock keeps running from the start
  assert.equal(p.lastReadyAt, null);
  assert.equal(p.checkedAt, 5000);
});

test("ready:true stamps lastReadyAt and clears lastError", () => {
  _resetProviderHealth();
  recordResidency("crow-voice", {
    ready: false, nowMs: 1000, baseUrl: "http://x/v1", error: new Error("boom"),
  });
  assert.equal(getProviderHealth().providers["crow-voice"].lastError, "boom");
  recordResidency("crow-voice", { ready: true, nowMs: 2000, baseUrl: "http://x/v1" });
  const p = getProviderHealth().providers["crow-voice"];
  assert.equal(p.ready, true);
  assert.equal(p.lastReadyAt, 2000);
  assert.equal(p.lastError, null);
});

test("later ready:false leaves lastReadyAt at the last success time", () => {
  _resetProviderHealth();
  recordResidency("crow-voice", { ready: false, nowMs: 1000, baseUrl: "http://x/v1" });
  recordResidency("crow-voice", { ready: true, nowMs: 2000, baseUrl: "http://x/v1" });
  recordResidency("crow-voice", { ready: false, nowMs: 9000, baseUrl: "http://x/v1" });
  const p = getProviderHealth().providers["crow-voice"];
  // clock restarts from the last success (2000), not firstOwnedAt (1000)
  assert.equal(p.firstOwnedAt, 1000);
  assert.equal(p.lastReadyAt, 2000);
  assert.equal(p.ready, false);
});

test("error recorded as string from Error and from bare string; cleared on success", () => {
  _resetProviderHealth();
  recordResidency("a", { ready: false, nowMs: 1, baseUrl: "u", error: new Error("kaboom") });
  assert.equal(getProviderHealth().providers["a"].lastError, "kaboom");
  recordResidency("a", { ready: false, nowMs: 2, baseUrl: "u", error: "plain string" });
  assert.equal(getProviderHealth().providers["a"].lastError, "plain string");
  recordResidency("a", { ready: false, nowMs: 3, baseUrl: "u" }); // no error given
  assert.equal(getProviderHealth().providers["a"].lastError, null);
  recordResidency("a", { ready: false, nowMs: 4, baseUrl: "u", error: "again" });
  recordResidency("a", { ready: true, nowMs: 5, baseUrl: "u" });
  assert.equal(getProviderHealth().providers["a"].lastError, null);
});

test("embed is stored and coerced to boolean", () => {
  _resetProviderHealth();
  recordResidency("emb", { ready: true, nowMs: 1, baseUrl: "u", embed: 1 });
  assert.equal(getProviderHealth().providers["emb"].embed, true);
  recordResidency("emb", { ready: true, nowMs: 2, baseUrl: "u", embed: 0 });
  assert.equal(getProviderHealth().providers["emb"].embed, false);
  recordResidency("emb2", { ready: true, nowMs: 1, baseUrl: "u" }); // default
  assert.equal(getProviderHealth().providers["emb2"].embed, false);
});

test("releaseResidency deletes the entry; next record stamps a FRESH firstOwnedAt", () => {
  _resetProviderHealth();
  recordResidency("crow-voice", { ready: true, nowMs: 1000, baseUrl: "http://x/v1" });
  releaseResidency("crow-voice");
  assert.equal(getProviderHealth().providers["crow-voice"], undefined);
  recordResidency("crow-voice", { ready: false, nowMs: 7000, baseUrl: "http://y/v1" });
  const p = getProviderHealth().providers["crow-voice"];
  assert.equal(p.firstOwnedAt, 7000);
  assert.equal(p.lastReadyAt, null);
});

test("pruneResidency drops undeclared names, keeps declared (array and Set)", () => {
  _resetProviderHealth();
  recordResidency("a", { ready: true, nowMs: 1, baseUrl: "u" });
  recordResidency("b", { ready: true, nowMs: 1, baseUrl: "u" });
  recordResidency("c", { ready: true, nowMs: 1, baseUrl: "u" });
  pruneResidency(["a", "b"]);
  assert.ok(getProviderHealth().providers["a"]);
  assert.ok(getProviderHealth().providers["b"]);
  assert.equal(getProviderHealth().providers["c"], undefined);
  pruneResidency(new Set(["a"]));
  assert.ok(getProviderHealth().providers["a"]);
  assert.equal(getProviderHealth().providers["b"], undefined);
});

test("pruneResidency does NOT drop a declared name that is currently not-ready", () => {
  _resetProviderHealth();
  recordResidency("down", { ready: false, nowMs: 1000, baseUrl: "u" });
  pruneResidency(["down"]);
  const p = getProviderHealth().providers["down"];
  assert.ok(p, "declared-but-down provider must survive prune (reviewed CRITICAL)");
  assert.equal(p.firstOwnedAt, 1000); // outage clock intact
  assert.equal(p.ready, false);
});

test("getProviderHealth returns a copy: mutating or deleting does not affect state", () => {
  _resetProviderHealth();
  recordResidency("a", { ready: true, nowMs: 1, baseUrl: "u" });
  const first = getProviderHealth();
  first.providers["a"].ready = false;
  delete first.providers["a"];
  first.initialized = true;
  const second = getProviderHealth();
  assert.ok(second.providers["a"], "entry must still exist");
  assert.equal(second.providers["a"].ready, true, "ready must be untouched");
  assert.equal(second.initialized, false, "top-level must be untouched");
});

test("_resetProviderHealth restores the initial shape", () => {
  _resetProviderHealth();
  setResidencyInitialized();
  recordResidency("a", { ready: true, nowMs: 1, baseUrl: "u" });
  _resetProviderHealth();
  const h = getProviderHealth();
  assert.equal(h.initialized, false);
  assert.deepEqual(h.providers, {});
});
