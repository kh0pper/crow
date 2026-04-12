/**
 * Kokoro-FastAPI adapter — OpenAI-compatible self-host.
 *
 * https://github.com/remsky/Kokoro-FastAPI — exposes an /v1/audio/speech
 * endpoint with the same shape as OpenAI TTS. We delegate to the same
 * streaming pattern as the openai adapter.
 *
 * config.baseUrl       — e.g. http://grackle:8880
 * config.defaultVoice  — e.g. af_bella
 */

export default function createKokoroTtsAdapter(config) {
  const baseUrl = (config.baseUrl || "http://localhost:8880").replace(/\/+$/, "");
  const apiKey = config.apiKey || "not-needed";

  return {
    name: "kokoro",
    supportsStreaming: true,

    async *synthesize(text, voice, options = {}) {
      const v = voice || config.defaultVoice || "af_bella";
      const body = {
        model: options.model || "kokoro",
        input: text,
        voice: v,
        response_format: options.format || "mp3",
        speed: options.speed || 1.0,
        stream: true,
      };
      const res = await fetch(`${baseUrl}/v1/audio/speech`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: options.signal,
      });
      if (!res.ok) {
        const err = await res.text().catch(() => "");
        throw Object.assign(new Error(`Kokoro ${res.status}: ${err.slice(0, 200)}`), { code: "provider_error" });
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
        const res = await fetch(`${baseUrl}/v1/audio/voices`, {
          headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
        });
        if (!res.ok) return [];
        const data = await res.json();
        const list = data.voices || data.data || data;
        if (!Array.isArray(list)) return [];
        return list.map(v => ({
          id: typeof v === "string" ? v : (v.id || v.name),
          name: typeof v === "string" ? v : (v.name || v.id),
        }));
      } catch { return []; }
    },
  };
}
