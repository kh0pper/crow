/**
 * ElevenLabs TTS adapter — streaming audio via REST.
 *
 * config.apiKey     — xi-api-key
 * config.baseUrl    — override (defaults to https://api.elevenlabs.io)
 * config.defaultVoice — default voice_id
 */

const DEFAULT_BASE_URL = "https://api.elevenlabs.io";

export default function createElevenLabsTtsAdapter(config) {
  const baseUrl = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const apiKey = config.apiKey;

  return {
    name: "elevenlabs",
    supportsStreaming: true,

    async *synthesize(text, voice, options = {}) {
      const voiceId = voice || config.defaultVoice || "EXAVITQu4vr4xnSDxMaL";
      const model = options.model || "eleven_turbo_v2_5";
      const format = options.format || "mp3_44100_128";
      const url = `${baseUrl}/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=${encodeURIComponent(format)}`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "xi-api-key": apiKey || "",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text,
          model_id: model,
          voice_settings: options.voiceSettings || { stability: 0.5, similarity_boost: 0.75 },
        }),
        signal: options.signal,
      });
      if (!res.ok) {
        const err = await res.text().catch(() => "");
        throw Object.assign(new Error(`ElevenLabs ${res.status}: ${err.slice(0, 200)}`), { code: "provider_error" });
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
      if (!apiKey) return [];
      try {
        const res = await fetch(`${baseUrl}/v1/voices`, {
          headers: { "xi-api-key": apiKey, Accept: "application/json" },
        });
        if (!res.ok) return [];
        const data = await res.json();
        return (data.voices || []).map(v => ({
          id: v.voice_id,
          name: v.name,
          gender: v.labels?.gender,
          description: v.labels?.description,
        }));
      } catch { return []; }
    },
  };
}
