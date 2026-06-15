import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as registry from "../servers/shared/fix-it/registry.js";

beforeEach(() => registry._clearRegistry());

test("emit dispatches only to detectors handling the event", async () => {
  const seen = [];
  registry.registerDetector({ source: "a", events: ["x"], onEvent: (e, p) => seen.push(["a", e, p.v]) });
  registry.registerDetector({ source: "b", events: ["y"], onEvent: (e, p) => seen.push(["b", e, p.v]) });
  await registry.emit("x", { v: 1 }, {});
  assert.deepEqual(seen, [["a", "x", 1]]);
});

test("a throwing detector does not break emit", async () => {
  let reached = false;
  registry.registerDetector({ source: "bad", events: ["x"], onEvent: () => { throw new Error("boom"); } });
  registry.registerDetector({ source: "good", events: ["x"], onEvent: () => { reached = true; } });
  await assert.doesNotReject(registry.emit("x", {}, {}));
  assert.equal(reached, true);
});

test("registerRemedy / getRemedy round-trip; unknown → null", async () => {
  const fn = async () => ({ resolved: true });
  registry.registerRemedy("do-thing", fn);
  assert.equal(registry.getRemedy("do-thing"), fn);
  assert.equal(registry.getRemedy("nope"), null);
});
