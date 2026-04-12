/**
 * Deepgram adapter — the one true streaming option in this set.
 *
 * Batch path: POST /v1/listen (multipart audio)
 * Stream path: WebSocket to wss://api.deepgram.com/v1/listen with
 *              linear16 PCM frames; server emits interim + final results.
 *
 * config.apiKey / baseUrl / defaultModel
 */

import WebSocket from "ws";

const DEFAULT_BASE_URL = "https://api.deepgram.com";
const DEFAULT_WS_URL = "wss://api.deepgram.com";

export default function createDeepgramSttAdapter(config) {
  const baseUrl = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const wsUrl = baseUrl.replace(/^http/, "ws");
  const apiKey = config.apiKey;

  return {
    name: "deepgram",
    supportsStreaming: true,

    async transcribe(audioBuffer, options = {}) {
      const model = options.model || config.defaultModel || "nova-3";
      const url = new URL(`${baseUrl}/v1/listen`);
      url.searchParams.set("model", model);
      if (options.language) url.searchParams.set("language", options.language);
      url.searchParams.set("punctuate", "true");
      url.searchParams.set("smart_format", "true");

      const res = await fetch(url.toString(), {
        method: "POST",
        headers: {
          Authorization: `Token ${apiKey}`,
          "Content-Type": options.contentType || "audio/wav",
        },
        body: audioBuffer,
        signal: options.signal,
      });
      if (!res.ok) {
        const err = await res.text().catch(() => "");
        throw Object.assign(new Error(`Deepgram STT ${res.status}: ${err.slice(0, 200)}`), { code: "provider_error" });
      }
      const data = await res.json();
      const alternative = data?.results?.channels?.[0]?.alternatives?.[0];
      return {
        text: alternative?.transcript || "",
        language: data?.results?.channels?.[0]?.detected_language,
        duration: data?.metadata?.duration,
      };
    },

    /**
     * Stream transcription.
     * @param {AsyncIterable<Uint8Array>} frames - linear16 PCM audio frames.
     * @param {object} options - { model, language, sampleRate, channels, signal }
     * @yields { type: "partial"|"final", text, language? }
     */
    async *transcribeStream(frames, options = {}) {
      const model = options.model || config.defaultModel || "nova-3";
      const sampleRate = options.sampleRate || 16000;
      const channels = options.channels || 1;
      const url = new URL(`${wsUrl}/v1/listen`);
      url.searchParams.set("model", model);
      url.searchParams.set("encoding", options.encoding || "linear16");
      url.searchParams.set("sample_rate", String(sampleRate));
      url.searchParams.set("channels", String(channels));
      url.searchParams.set("interim_results", "true");
      url.searchParams.set("punctuate", "true");
      url.searchParams.set("smart_format", "true");
      if (options.language) url.searchParams.set("language", options.language);

      const ws = new WebSocket(url.toString(), {
        headers: { Authorization: `Token ${apiKey}` },
      });

      // Pending messages queue, drained by the async iterator.
      const queue = [];
      let resolveWait = null;
      let closed = false;
      let errorEvent = null;

      ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString("utf8"));
          if (msg.type === "Results") {
            const alt = msg.channel?.alternatives?.[0];
            if (alt?.transcript) {
              queue.push({
                type: msg.is_final ? "final" : "partial",
                text: alt.transcript,
              });
              if (resolveWait) { resolveWait(); resolveWait = null; }
            }
          }
        } catch { /* ignore malformed */ }
      });
      ws.on("error", (err) => {
        errorEvent = err;
        closed = true;
        if (resolveWait) { resolveWait(); resolveWait = null; }
      });
      ws.on("close", () => {
        closed = true;
        if (resolveWait) { resolveWait(); resolveWait = null; }
      });

      // Abort wiring
      const onAbort = () => { try { ws.close(); } catch {} };
      if (options.signal) options.signal.addEventListener("abort", onAbort, { once: true });

      // Wait for open, then start pumping frames.
      await new Promise((resolve, reject) => {
        ws.on("open", resolve);
        ws.on("error", reject);
      });

      // Push frames in the background; send CloseStream marker on drain.
      (async () => {
        try {
          for await (const frame of frames) {
            if (ws.readyState !== WebSocket.OPEN) break;
            ws.send(frame);
          }
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "CloseStream" }));
          }
        } catch (err) {
          errorEvent = err;
        }
      })();

      // Yield transcripts as they arrive.
      try {
        while (!closed || queue.length > 0) {
          if (queue.length === 0) {
            await new Promise(r => { resolveWait = r; });
            continue;
          }
          yield queue.shift();
        }
        if (errorEvent) throw errorEvent;
      } finally {
        if (options.signal) options.signal.removeEventListener("abort", onAbort);
        try { ws.close(); } catch {}
      }
    },
  };
}
