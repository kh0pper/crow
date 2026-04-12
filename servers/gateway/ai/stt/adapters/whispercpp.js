/**
 * whisper.cpp HTTP server adapter (self-hosted, CPU-friendly).
 *
 * The whisper.cpp `server` binary (`./server -m <model>`) exposes
 * POST /inference with multipart audio. Response JSON has `text` field.
 *
 * config.baseUrl     — e.g. http://grackle:9000
 * config.defaultModel — ignored (model is whatever the server was started with)
 */

export default function createWhisperCppAdapter(config) {
  const baseUrl = (config.baseUrl || "http://localhost:9000").replace(/\/+$/, "");

  return {
    name: "whispercpp",
    supportsStreaming: false,

    async transcribe(audioBuffer, options = {}) {
      const filename = options.filename || "audio.wav";
      const contentType = options.contentType || "audio/wav";

      const form = new FormData();
      form.append("file", new Blob([audioBuffer], { type: contentType }), filename);
      if (options.language) form.append("language", options.language);
      form.append("response_format", "json");
      if (options.temperature !== undefined) form.append("temperature", String(options.temperature));

      const res = await fetch(`${baseUrl}/inference`, {
        method: "POST",
        body: form,
        signal: options.signal,
      });
      if (!res.ok) {
        const err = await res.text().catch(() => "");
        throw Object.assign(new Error(`whisper.cpp ${res.status}: ${err.slice(0, 200)}`), { code: "provider_error" });
      }
      const data = await res.json();
      return {
        text: (data.text || "").trim(),
        language: data.language,
      };
    },
  };
}
