import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SERVING_CLASSES, SINGLE_BOX_RAM_MB, servingClassOf, ServingClassError,
  servingClassRefusal, startAffordance,
} from "../servers/gateway/models/serving-class.js";

const e = (cls) => ({ id: "m", serving: { class: cls } });

test("vocabulary and constant", () => {
  assert.deepEqual(SERVING_CLASSES, ["resident", "windowed", "wedge-risk"]);
  assert.equal(SINGLE_BOX_RAM_MB, 126976);
});

test("servingClassOf: valid class, else null", () => {
  assert.equal(servingClassOf(e("windowed")), "windowed");
  assert.equal(servingClassOf(e("bogus")), null);
  assert.equal(servingClassOf({ id: "m" }), null);
  assert.equal(servingClassOf(null), null);
  assert.equal(servingClassOf({ serving: "wedge-risk" }), null);
});

test("refusal matrix: resident/uncurated always allowed; others need the exact class as override", () => {
  assert.equal(servingClassRefusal(e("resident"), "p", undefined), null);
  assert.equal(servingClassRefusal(null, "p", undefined), null, "uncurated → allowed (D6)");
  assert.equal(servingClassRefusal({ id: "m" }, "p", undefined), null);
  for (const cls of ["windowed", "wedge-risk"]) {
    const err = servingClassRefusal(e(cls), "prov-x", undefined);
    assert.ok(err instanceof ServingClassError);
    assert.equal(err.code, "serving_class_refused");
    assert.equal(err.http, 409);
    assert.equal(err.servingClass, cls);
    assert.equal(err.provider, "prov-x");
    assert.match(err.message, new RegExp(cls));
    assert.equal(servingClassRefusal(e(cls), "p", cls), null, "exact override allows");
    assert.ok(servingClassRefusal(e(cls), "p", true) instanceof ServingClassError, "boolean override is not an override");
  }
  assert.ok(servingClassRefusal(e("wedge-risk"), "p", "windowed") instanceof ServingClassError, "cross-class override refused");
  assert.ok(servingClassRefusal(e("windowed"), "p", "wedge-risk") instanceof ServingClassError, "cross-class override refused");
});

test("startAffordance", () => {
  assert.equal(startAffordance("resident"), "start");
  assert.equal(startAffordance(null), "start");
  assert.equal(startAffordance("windowed"), "window-only");
  assert.equal(startAffordance("wedge-risk"), "never");
});
