/**
 * Piper HTTP adapter — self-hosted, low-latency, CPU-only.
 *
 * Expects either:
 *   - wyoming-piper's OpenAI-compatible HTTP wrapper, OR
 *   - rhasspy/wyoming-piper served via a simple HTTP shim
 *   - rhasspy/piper-http (POST /api/tts?voice=...&text=...)
 *
 * This adapter targets the common piper-http shape: GET or POST with
 * `text` and `voice` query/form params returning audio/wav.
 *
 * config.baseUrl     — e.g. http://grackle:5000
 * config.defaultVoice — e.g. en_US-amy-medium
 */

export default function createPiperTtsAdapter(config) {
  const baseUrl = (config.baseUrl || "http://localhost:5000").replace(/\/+$/, "");

  return {
    name: "piper",
    supportsStreaming: true,

    async *synthesize(text, voice, options = {}) {
      const v = voice || config.defaultVoice || "en_US-amy-medium";
      const params = new URLSearchParams({ text, voice: v });
      // piper-http supports both GET with query string and POST with form-encoded body.
      // POST is safer for long text.
      const res = await fetch(`${baseUrl}/api/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
        signal: options.signal,
      });
      if (!res.ok) {
        const err = await res.text().catch(() => "");
        throw Object.assign(new Error(`Piper ${res.status}: ${err.slice(0, 200)}`), { code: "provider_error" });
      }
      const reader = res.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value?.length) yield value;
        }
      } finally {
        reader.releaseLock();
      }
    },

    async listVoices() {
      try {
        const res = await fetch(`${baseUrl}/api/voices`, {
          headers: { Accept: "application/json" },
        });
        if (!res.ok) return [];
        const data = await res.json();
        if (Array.isArray(data)) {
          return data.map(v => ({ id: v.key || v.id || v, name: v.name || v.key || v }));
        }
        if (data && typeof data === "object") {
          return Object.keys(data).map(id => ({ id, name: id }));
        }
        return [];
      } catch { return []; }
    },
  };
}
