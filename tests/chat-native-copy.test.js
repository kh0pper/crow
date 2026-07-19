/**
 * chat.js's native-vs-Docker warming/failure copy (Item G, Task 10).
 *
 * `nativeWarmingEvent`/`providerNotReadyError` are pure helpers exported
 * from `servers/gateway/routes/chat.js` specifically so this split is
 * unit-testable without standing up the full SSE route (DB, conversation
 * row, provider adapter resolution, etc. — none of that is relevant to
 * "which copy gets picked"). The route itself (`chat.js` around its
 * `maybeAcquireLocalProvider` call site) just calls these two functions and
 * forwards their output verbatim to `sendEvent`.
 *
 * What's asserted:
 *   - Docker/cloud path (isNative=false) is BYTE-IDENTICAL to the
 *     pre-Task-10 behavior: `provider_warming` carries no `message`, and a
 *     timeout error keeps the exact `docker compose logs` hint + the
 *     `provider_not_ready` code.
 *   - Native path (isNative=true) NEVER surfaces the Docker hint, uses the
 *     new `chat.native_model_loading` / `chat.native_model_load_failed` i18n
 *     keys (real EN + ES, via the same `t()`/`fill()` the rest of the
 *     dashboard uses), and a distinct `native_provider_not_ready` code.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { nativeWarmingEvent, providerNotReadyError } from "../servers/gateway/routes/chat.js";
import { t, fill } from "../servers/gateway/dashboard/shared/i18n.js";

// --- Docker/cloud path: unchanged from pre-Task-10 behavior ----------------

test("nativeWarmingEvent: Docker/cloud provider gets provider_id only, no message field", () => {
  const evt = nativeWarmingEvent("crow-chat", false, "en");
  assert.deepEqual(evt, { provider_id: "crow-chat" });
});

test("providerNotReadyError: Docker/cloud provider keeps the exact docker-compose hint + provider_not_ready code", () => {
  const err = providerNotReadyError("crow-chat", false, "en");
  assert.equal(err.code, "provider_not_ready");
  assert.equal(
    err.message,
    'Local provider "crow-chat" did not become ready in time. Check "docker compose logs" for its bundle.',
  );
});

test("providerNotReadyError: Docker/cloud copy is unaffected by lang (never localized — matches its pre-Task-10 behavior)", () => {
  const en = providerNotReadyError("crow-chat", false, "en");
  const es = providerNotReadyError("crow-chat", false, "es");
  assert.equal(en.message, es.message);
});

// --- Native path: new i18n keys, never the Docker hint ----------------------

test("nativeWarmingEvent: native provider gets a translated message (EN)", () => {
  const evt = nativeWarmingEvent("qwen3-4b", true, "en");
  assert.equal(evt.provider_id, "qwen3-4b");
  assert.equal(evt.message, fill(t("chat.native_model_loading", "en"), { provider: "qwen3-4b" }));
  assert.match(evt.message, /qwen3-4b/, "the provider name is interpolated into the message");
});

test("nativeWarmingEvent: native provider gets a translated message (ES), distinct from EN", () => {
  const en = nativeWarmingEvent("qwen3-4b", true, "en").message;
  const es = nativeWarmingEvent("qwen3-4b", true, "es").message;
  assert.notEqual(en, es, "EN and ES copy must actually differ (real translation, not a stub)");
  assert.equal(es, fill(t("chat.native_model_loading", "es"), { provider: "qwen3-4b" }));
});

test("providerNotReadyError: native failure NEVER contains the docker-compose hint, in either language", () => {
  const en = providerNotReadyError("qwen3-4b", true, "en");
  const es = providerNotReadyError("qwen3-4b", true, "es");
  assert.equal(en.code, "native_provider_not_ready");
  assert.equal(es.code, "native_provider_not_ready");
  for (const err of [en, es]) {
    assert.doesNotMatch(err.message.toLowerCase(), /docker/, "native failure copy must never mention docker");
    assert.doesNotMatch(err.message.toLowerCase(), /compose/, "native failure copy must never mention compose");
  }
});

test("providerNotReadyError: native failure copy uses the chat.native_model_load_failed key (EN + real ES)", () => {
  const en = providerNotReadyError("qwen3-4b", true, "en");
  const es = providerNotReadyError("qwen3-4b", true, "es");
  assert.equal(en.message, fill(t("chat.native_model_load_failed", "en"), { provider: "qwen3-4b" }));
  assert.equal(es.message, fill(t("chat.native_model_load_failed", "es"), { provider: "qwen3-4b" }));
  assert.notEqual(en.message, es.message, "EN and ES copy must actually differ (real translation, not a stub)");
  assert.match(en.message, /qwen3-4b/);
  assert.match(es.message, /qwen3-4b/);
});

test("providerNotReadyError: an unsupported lang falls back to English (t()'s own fallback, not special-cased here)", () => {
  const fr = providerNotReadyError("qwen3-4b", true, "fr");
  const en = providerNotReadyError("qwen3-4b", true, "en");
  assert.equal(fr.message, en.message);
});
