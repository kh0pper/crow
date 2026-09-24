/**
 * provider-engine — the external-engine marker (spec
 * docs/superpowers/specs/2026-09-23-external-engine-provider-design.md §2.1/§2.2).
 * Pure helpers, no I/O.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isExternalEngine, externalEngineInfo, engineShapeError,
  externalEngineConflict, ExternalEngineError, ENGINE_FIELD_MAX,
} from "../servers/shared/provider-engine.js";

const ENGINE = { managed: "external", host: "raven", label: "halogen" };

test("isExternalEngine truth table: only managed === \"external\" (exact string) marks a row", () => {
  const cases = [
    [undefined, false],
    [null, false],
    [{}, false],
    [{ gpuPolicy: null }, false],
    [{ gpuPolicy: {} }, false],
    [{ gpuPolicy: { engine: null } }, false],
    [{ gpuPolicy: { engine: {} } }, false],
    [{ gpuPolicy: { engine: { managed: "External", host: "raven" } } }, false],
    [{ gpuPolicy: { engine: { managed: "internal", host: "raven" } } }, false],
    [{ gpuPolicy: { engine: { managed: true, host: "raven" } } }, false],
    [{ gpuPolicy: { engine: "external" } }, false],
    [{ gpuPolicy: { engine: { managed: "external" } } }, true], // shape-invalid, but the orchestrator errs safe
    [{ gpuPolicy: { engine: ENGINE } }, true],
    [{ gpuPolicy: { engine: ENGINE, runtime: "native" } }, true],
  ];
  for (const [p, want] of cases) assert.equal(isExternalEngine(p), want, JSON.stringify(p));
});

test("externalEngineInfo: trimmed host/label for a marked row, null for an unmarked one", () => {
  assert.equal(externalEngineInfo({ gpuPolicy: {} }), null);
  assert.deepEqual(externalEngineInfo({ gpuPolicy: { engine: ENGINE } }), { host: "raven", label: "halogen" });
  assert.deepEqual(
    externalEngineInfo({ gpuPolicy: { engine: { managed: "external", host: "  raven ", label: "" } } }),
    { host: "raven", label: null },
  );
  assert.deepEqual(externalEngineInfo({ gpuPolicy: { engine: { managed: "external" } } }), { host: null, label: null });
});

test("engineShapeError: absent is fine, valid is fine, every malformed shape names its problem", () => {
  assert.equal(engineShapeError(undefined), null);
  assert.equal(engineShapeError(null), null);
  assert.equal(engineShapeError(ENGINE), null);
  assert.equal(engineShapeError({ managed: "external", host: "raven" }), null);
  assert.match(engineShapeError("external"), /must be an object/);
  assert.match(engineShapeError([]), /must be an object/);
  assert.match(engineShapeError({ managed: "External", host: "raven" }), /exactly "external"/);
  assert.match(engineShapeError({ managed: "external" }), /host/);
  assert.match(engineShapeError({ managed: "external", host: "   " }), /host/);
  assert.match(engineShapeError({ managed: "external", host: "x".repeat(ENGINE_FIELD_MAX + 1) }), /host/);
  assert.match(engineShapeError({ managed: "external", host: "raven", label: 7 }), /label/);
  assert.match(engineShapeError({ managed: "external", host: "raven", label: "y".repeat(ENGINE_FIELD_MAX + 1) }), /label/);
});

test("externalEngineConflict: marker + bundleId or marker + native runtime; nothing else", () => {
  assert.equal(externalEngineConflict({ bundleId: null, gpuPolicy: { engine: ENGINE } }), false);
  assert.equal(externalEngineConflict({ bundleId: "halogen", gpuPolicy: { engine: ENGINE } }), true);
  assert.equal(externalEngineConflict({ bundleId: null, gpuPolicy: { engine: ENGINE, runtime: "native" } }), true);
  assert.equal(externalEngineConflict({ bundleId: "b", gpuPolicy: { runtime: "native" } }), false); // unmarked: not this rule's business
  assert.equal(externalEngineConflict({ bundleId: "", gpuPolicy: { engine: ENGINE } }), false);
  assert.equal(externalEngineConflict({}), false);
});

test("ExternalEngineError carries code external_engine, the provider and the engine host", () => {
  const err = new ExternalEngineError("raven-flash-next", "raven");
  assert.ok(err instanceof Error);
  assert.equal(err.name, "ExternalEngineError");
  assert.equal(err.code, "external_engine");
  assert.equal(err.provider, "raven-flash-next");
  assert.equal(err.engineHost, "raven");
  assert.match(err.message, /raven-flash-next/);
  assert.match(err.message, /on raven/);
  assert.equal(new ExternalEngineError("x").engineHost, null);
});
