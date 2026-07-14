/**
 * model_resolver unavailable-surface pin (Item 4-PR4, spec §2.1 item 7).
 *
 * On a fresh install (no models.json anywhere, no providers rows) an unknown
 * provider/model resolves fail-closed to LOCAL_FALLBACK with an attributed
 * source, and an explicit !escalate with nothing usable sets the
 * escalationRequestedButUnavailable flag the bridge surfaces in-band.
 * This pins that contract.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "crow-resolver-"));
// No models.json anywhere + no providers table: point both lookups at
// nonexistent scratch paths BEFORE importing the module.
process.env.PI_MODELS_JSON = join(scratch, "no-such-models.json");
process.env.CROW_DB_PATH = join(scratch, "no-such-crow.db");

const { test } = await import("node:test");
const { default: assert } = await import("node:assert/strict");
const { resolveModel, LOCAL_FALLBACK, splitKey } = await import("../scripts/pi-bots/model_resolver.mjs");

const fb = splitKey(LOCAL_FALLBACK);

test("unknown provider, no models.json -> falls to LOCAL_FALLBACK, source=fallback", async () => {
  const r = await resolveModel({ models: { default: "no-such-provider/no-such-model" } });
  assert.deepEqual(r, {
    provider: fb.provider,
    model: fb.model,
    key: LOCAL_FALLBACK,
    escalated: false,
    source: "fallback",
    escalationRequestedButUnavailable: false,
  });
});

test("escalate requested with nothing usable -> unavailable flag set", async () => {
  const r = await resolveModel({ models: { default: "no-such-provider/no-such-model" } }, { escalate: true });
  assert.equal(r.key, LOCAL_FALLBACK);
  assert.equal(r.source, "fallback");
  assert.equal(r.escalated, false);
  assert.equal(r.escalationRequestedButUnavailable, true);
});

test("no def.models at all -> fallback without throwing", async () => {
  const r = await resolveModel({});
  assert.equal(r.key, LOCAL_FALLBACK);
});
