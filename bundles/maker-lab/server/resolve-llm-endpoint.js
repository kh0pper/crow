/**
 * Phase 4b — auto-detect the LLM engine Maker Lab should use.
 *
 * Resolution order:
 *   1. MAKER_LAB_LLM_ENDPOINT explicitly set  → use verbatim (operator override).
 *   2. vLLM live at http://localhost:8089/v1  → use + first served model.
 *   3. Ollama live at http://localhost:11434  → use + configured model.
 *   4. Hardcoded fallback: http://localhost:11434/v1 + llama3.2:3b.
 *
 * Auto-detection runs once at startup and is cached in-process for the
 * lifetime of the Maker Lab server. Caller re-resolves on container
 * restart. Probes are short-timeout (750ms each) so a missing service
 * doesn't block server start on a cold host.
 *
 * Why probe /v1/models instead of /health: /health is 200 while the
 * model is still loading for vLLM, and we need the model name anyway.
 */

const VLLM_PROBE_URL = process.env.MAKER_LAB_VLLM_PROBE || "http://localhost:8089/v1/models";
const OLLAMA_PROBE_URL = process.env.MAKER_LAB_OLLAMA_PROBE || "http://localhost:11434/api/tags";
const PROBE_TIMEOUT_MS = 750;

async function probe(url) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
    const resp = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

async function detectVllm() {
  const data = await probe(VLLM_PROBE_URL);
  if (!data || !Array.isArray(data.data) || data.data.length === 0) return null;
  const endpoint = VLLM_PROBE_URL.replace(/\/models$/, "");
  return { engine: "vllm", endpoint, model: data.data[0].id };
}

async function detectOllama() {
  const data = await probe(OLLAMA_PROBE_URL);
  if (!data || !Array.isArray(data.models) || data.models.length === 0) return null;
  // Ollama exposes /api/tags for model inventory and /v1/* for the OpenAI
  // shim — we call the shim at inference time.
  const endpoint = OLLAMA_PROBE_URL.replace(/\/api\/tags$/, "/v1");
  const preferred = process.env.MAKER_LAB_LLM_MODEL;
  const names = data.models.map((m) => m.name || m.model).filter(Boolean);
  const model = (preferred && names.includes(preferred)) ? preferred : (names[0] || "llama3.2:3b");
  return { engine: "ollama", endpoint, model };
}

let cached = null;

export async function resolveLlmEndpoint({ force = false } = {}) {
  if (!force && cached) return cached;

  // Operator override always wins — don't probe.
  const explicit = process.env.MAKER_LAB_LLM_ENDPOINT;
  if (explicit && explicit.trim()) {
    cached = {
      engine: "explicit",
      endpoint: explicit.trim().replace(/\/$/, ""),
      model: process.env.MAKER_LAB_LLM_MODEL || "llama3.2:3b",
      source: "MAKER_LAB_LLM_ENDPOINT",
    };
    return cached;
  }

  const vllm = await detectVllm();
  if (vllm) { cached = { ...vllm, source: "auto-detect" }; return cached; }

  const ollama = await detectOllama();
  if (ollama) { cached = { ...ollama, source: "auto-detect" }; return cached; }

  cached = {
    engine: "fallback",
    endpoint: "http://localhost:11434/v1",
    model: "llama3.2:3b",
    source: "hardcoded-default",
  };
  return cached;
}

export function getCachedResolution() {
  return cached;
}

export function clearCache() {
  cached = null;
}
