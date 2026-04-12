/**
 * faster-whisper-server adapter — OpenAI-compatible self-host.
 *
 * https://github.com/fedirz/faster-whisper-server exposes an
 * /v1/audio/transcriptions endpoint with the same schema as OpenAI.
 * GPU-accelerated; great for grackle.
 *
 * config.baseUrl — e.g. http://grackle:8000/v1
 * config.defaultModel — e.g. "Systran/faster-whisper-large-v3"
 */

export default function createFasterWhisperAdapter(config) {
  const baseUrl = (config.baseUrl || "http://localhost:8000/v1").replace(/\/+$/, "");
  const apiKey = config.apiKey || "not-needed";

  return {
    name: "fasterwhisper",
    supportsStreaming: false,

    async transcribe(audioBuffer, options = {}) {
      const model = options.model || config.defaultModel || "Systran/faster-whisper-large-v3";
      const filename = options.filename || "audio.wav";
      const contentType = options.contentType || "audio/wav";

      const form = new FormData();
      form.append("file", new Blob([audioBuffer], { type: contentType }), filename);
      form.append("model", model);
      if (options.language) form.append("language", options.language);
      form.append("response_format", "verbose_json");

      const res = await fetch(`${baseUrl}/audio/transcriptions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
        signal: options.signal,
      });
      if (!res.ok) {
        const err = await res.text().catch(() => "");
        throw Object.assign(new Error(`faster-whisper ${res.status}: ${err.slice(0, 200)}`), { code: "provider_error" });
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
