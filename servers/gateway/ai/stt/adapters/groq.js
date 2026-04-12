/**
 * Groq Whisper adapter — OpenAI-compatible schema, much faster + cheaper.
 *
 * Recommended models: `whisper-large-v3`, `whisper-large-v3-turbo`.
 * Batch-only.
 */

const DEFAULT_BASE_URL = "https://api.groq.com/openai/v1";

export default function createGroqSttAdapter(config) {
  const baseUrl = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const apiKey = config.apiKey;

  return {
    name: "groq-stt",
    supportsStreaming: false,

    async transcribe(audioBuffer, options = {}) {
      const model = options.model || config.defaultModel || "whisper-large-v3-turbo";
      const filename = options.filename || "audio.wav";
      const contentType = options.contentType || "audio/wav";

      const form = new FormData();
      form.append("file", new Blob([audioBuffer], { type: contentType }), filename);
      form.append("model", model);
      if (options.language) form.append("language", options.language);
      if (options.prompt) form.append("prompt", options.prompt);
      form.append("response_format", "verbose_json");

      const res = await fetch(`${baseUrl}/audio/transcriptions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
        signal: options.signal,
      });
      if (!res.ok) {
        const err = await res.text().catch(() => "");
        throw Object.assign(new Error(`Groq STT ${res.status}: ${err.slice(0, 200)}`), { code: "provider_error" });
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
