# W2-2 (slice 1) — Shared HTTP timeout helper for turn-blocking call sites

**Date:** 2026-06-11
**Finding:** W2-2 in [`2026-06-10-overhaul-findings.md`](./2026-06-10-overhaul-findings.md), deliberately SLICED: the audit found 156 HTTP call sites, 81% without timeouts — but only **11 sites in 8 files are turn-blocking** (a hung upstream freezes a user-visible turn forever). Federation is already robust (`servers/shared/peer-forward.js` uses `AbortSignal.timeout` — the in-tree gold standard). This slice fixes the 11; the long tail (dashboard panels, fire-and-forget paths) is out of scope.

## Design

New module `servers/shared/http-timeout.js` (~40 LOC), formalizing the peer-forward pattern with one addition for streaming:

```js
/** Total-duration timeout — for BUFFERED calls (embeddings, voice lists, TTS). */
export function timeoutSignal(ms) {
  return AbortSignal.timeout(ms);
}

/**
 * Connect/first-byte timeout for STREAMING calls (LLM chat): aborts only if
 * response HEADERS haven't arrived within ms; once the response starts, the
 * timer is disarmed so long generations are never killed mid-stream.
 * Usage: const t = connectTimeout(ms); fetch(url, { signal: t.signal }).then(t.disarm)
 */
export function connectTimeout(ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new DOMException("Connect timeout", "TimeoutError")), ms);
  timer.unref?.();
  return {
    signal: ctrl.signal,
    disarm(res) { clearTimeout(timer); return res; },
  };
}

export function isTimeoutError(err) {
  return err?.name === "TimeoutError" || err?.cause?.name === "TimeoutError";
}
```

### Sites & timeout classes (revised after adversarial review)

| Class | Timeout | Sites |
|---|---|---|
| **Streaming LLM** — `connectTimeout`, disarm on headers | 20s to first byte | `routes/llm-router.js:~221`, `scripts/companion/model-proxy.mjs:~245` |
| **TTS synthesize** — `connectTimeout` (responses STREAM; a total cap would cut long utterances) | 10s to first byte | `ai/tts/adapters/kokoro.js:~36` (grackle:8880 — the likeliest-to-hang live upstream; reached from the live meta-glasses path), `elevenlabs.js:~24`, `azure.js:~40` |
| **Buffered embeddings** — total | 60s | `ai/provider.js:~285,303,317` (timeout surfaces as the existing `return null` contract — callers already handle it) |

**Dropped from the original inventory:** `ai/vision.js` (already protected — `AbortSignal.timeout` at :59); the three `listVoices` calls (dead code, zero callers — flag for a cleanup wave instead).

**Signal composition:** all three synth adapters accept `options.signal` per their contract (no live caller passes one today). Compose manually — `composeSignals(a, b)` helper using `addEventListener("abort")` — NOT `AbortSignal.any` (needs Node ≥20.3; package.json declares engines ≥18).

**Implementation trap (binding):** `disarm` must be applied in the same statement as the fetch (`const res = t.disarm(await fetch(url, { signal: t.signal }))`) — a later disarm would kill streams at the connect deadline.

On timeout: each site returns/throws its file's existing error shape with a clear message (`"upstream timeout after Ns"`), so callers' current error handling fires instead of hanging. No retry logic in this slice (YAGNI — the turn is interactive; the user retries).

### Env overrides (doc-only, no .env.example entries)
`CROW_HTTP_LLM_CONNECT_TIMEOUT_MS`, `CROW_HTTP_AI_TIMEOUT_MS`, `CROW_HTTP_TTS_TIMEOUT_MS`, `CROW_HTTP_VOICELIST_TIMEOUT_MS` — read once in the helper module with the defaults above, listed in `docs/developers/configuration.md` Advanced section.

## Compatibility
- Streaming behavior unchanged once a response begins (timer disarmed).
- Local-model cold starts: llama.cpp/vLLM on this fleet answer headers in <5s when up; 20s connect headroom is ample. A model that is DOWN currently hangs forever — after this change it errors in 20s (the improvement).
- model-proxy.mjs runs as its own service (companion-model-proxy.service on loopback :11435) — restart it on deploy along with the gateways.
- No schema changes; fleet-safe.

## Testing
`tests/http-timeout.test.js`: connectTimeout aborts a never-responding local server; disarm prevents abort after headers (serve headers with `res.flushHeaders()` — required so undici resolves before the window — then slow body must survive past it); timeoutSignal aborts; composeSignals propagates either source; isTimeoutError classification. Plus full suite + gateway boot + a live smoke: `curl -m 25 localhost:3001/llm/...` path still streams (manual, post-deploy).
