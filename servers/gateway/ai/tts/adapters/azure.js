/**
 * Azure Cognitive Services TTS adapter.
 *
 * Streams audio from POST {endpoint}/cognitiveservices/v1 with SSML body.
 *
 * config.apiKey    — Azure Speech subscription key
 * config.baseUrl   — region endpoint, e.g. "https://eastus.tts.speech.microsoft.com"
 * config.defaultVoice
 */

function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export default function createAzureTtsAdapter(config) {
  const baseUrl = (config.baseUrl || "").replace(/\/+$/, "");
  const apiKey = config.apiKey;

  return {
    name: "azure-tts",
    supportsStreaming: true,

    async *synthesize(text, voice, options = {}) {
      if (!baseUrl) {
        throw Object.assign(
          new Error("Azure TTS requires a region endpoint in profile baseUrl (e.g. https://eastus.tts.speech.microsoft.com)"),
          { code: "invalid_profile" }
        );
      }
      const v = voice || config.defaultVoice || "en-US-JennyNeural";
      const locale = v.split("-").slice(0, 2).join("-") || "en-US";
      const format = options.format || "audio-24khz-48kbitrate-mono-mp3";
      const ssml = `<speak version='1.0' xml:lang='${locale}'><voice xml:lang='${locale}' name='${escapeXml(v)}'>${escapeXml(text)}</voice></speak>`;

      const res = await fetch(`${baseUrl}/cognitiveservices/v1`, {
        method: "POST",
        headers: {
          "Ocp-Apim-Subscription-Key": apiKey || "",
          "Content-Type": "application/ssml+xml",
          "X-Microsoft-OutputFormat": format,
          "User-Agent": "crow-gateway",
        },
        body: ssml,
        signal: options.signal,
      });
      if (!res.ok) {
        const err = await res.text().catch(() => "");
        throw Object.assign(new Error(`Azure TTS ${res.status}: ${err.slice(0, 200)}`), { code: "provider_error" });
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
      if (!baseUrl || !apiKey) return [];
      try {
        const res = await fetch(`${baseUrl}/cognitiveservices/voices/list`, {
          headers: { "Ocp-Apim-Subscription-Key": apiKey },
        });
        if (!res.ok) return [];
        const data = await res.json();
        return (data || []).map(v => ({
          id: v.ShortName,
          name: v.DisplayName || v.ShortName,
          locale: v.Locale,
          gender: v.Gender,
        }));
      } catch { return []; }
    },
  };
}
