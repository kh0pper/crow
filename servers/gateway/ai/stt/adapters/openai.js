/**
 * OpenAI-compatible Whisper adapter.
 *
 * Covers OpenAI's `/v1/audio/transcriptions` and any provider implementing
 * the same multipart schema. Batch-only (no streaming).
 *
 * config.apiKey / baseUrl / defaultModel
 */

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

export default function createOpenAISttAdapter(config) {
  const baseUrl = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const apiKey = config.apiKey;

  return {
    name: "openai-stt",
    supportsStreaming: false,

    async transcribe(audioBuffer, options = {}) {
      const model = options.model || config.defaultModel || "whisper-1";
      const filename = options.filename || "audio.wav";
      const contentType = options.contentType || "audio/wav";

      const form = new FormData();
      form.append("file", new Blob([audioBuffer], { type: contentType }), filename);
      form.append("model", model);
      if (options.language) form.append("language", options.language);
      if (options.prompt) form.append("prompt", options.prompt);
      form.append("response_format", "verbose_json");
      if (options.temperature !== undefined) form.append("temperature", String(options.temperature));

      const res = await fetch(`${baseUrl}/audio/transcriptions`, {
        method: "POST",
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        body: form,
        signal: options.signal,
      });
      if (!res.ok) {
        const err = await res.text().catch(() => "");
        throw Object.assign(new Error(`OpenAI STT ${res.status}: ${err.slice(0, 200)}`), { code: "provider_error" });
      }
      const data = await res.json();
      return {
        text: data.text || "",
        language: data.language,
        duration: data.duration,
      };
    },
  };
}
