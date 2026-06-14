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

import { connectTimeout, composeSignals, TTS_TIMEOUT_MS } from "../../../../shared/http-timeout.js";

export default function createKokoroTtsAdapter(config) {
  // Normalize: strip trailing slashes AND a trailing `/v1` so the same profile
  // works whether its baseUrl includes /v1 or not. The companion (OLVV) needs
  // /v1 in the profile baseUrl, but this adapter appends /v1/audio/speech itself
  // — without this strip, a shared /v1 profile would hit /v1/v1/audio/speech.
  const baseUrl = (config.baseUrl || "http://localhost:8880")
    .replace(/\/+$/, "")
    .replace(/\/v1$/, "");
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
      const t = connectTimeout(TTS_TIMEOUT_MS);
      const res = t.disarm(await fetch(`${baseUrl}/v1/audio/speech`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: composeSignals(options.signal, t.signal),
      }));
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
