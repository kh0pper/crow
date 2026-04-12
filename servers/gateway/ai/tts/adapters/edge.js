/**
 * Edge TTS adapter — Microsoft's unauthenticated Bing readaloud endpoint.
 *
 * WARNING: This uses a public, rate-limited, unauthenticated endpoint that
 * Microsoft does not officially support for third-party use. Appropriate for
 * self-hosted / personal deployments. For commercial use, prefer `azure`.
 *
 * The service is WebSocket-based with proprietary framing. Rather than
 * reimplement the protocol here, we exec the ubiquitous `edge-tts` CLI
 * (python package) via subprocess. The CLI must be installed on the host
 * running the gateway; we degrade gracefully if it isn't.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const VOICE_LIST_URL = "https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=6A5AA1D4EAFF4E9FB37E23D68491D6F4";

let _voiceCache = null;
let _voiceCacheTime = 0;
const VOICE_CACHE_TTL = 24 * 60 * 60 * 1000;

function findEdgeTtsBinary() {
  // edge-tts is typically installed via pip; check common locations.
  const candidates = [
    "/usr/local/bin/edge-tts",
    "/usr/bin/edge-tts",
    `${process.env.HOME || ""}/.local/bin/edge-tts`,
  ];
  for (const p of candidates) {
    if (p && existsSync(p)) return p;
  }
  return "edge-tts"; // fall through to PATH resolution
}

export default function createEdgeTtsAdapter(_config) {
  const bin = findEdgeTtsBinary();

  return {
    name: "edge-tts",
    supportsStreaming: false, // edge-tts CLI writes a single MP3 file

    async *synthesize(text, voice, options = {}) {
      const v = voice || "en-US-JennyNeural";
      const rate = options.rate || "+0%";
      const volume = options.volume || "+0%";

      // Write audio to stdout (--write-media -) and read it as one buffer.
      const args = [
        "--voice", v,
        "--rate", rate,
        "--volume", volume,
        "--text", text,
        "--write-media", "/dev/stdout",
      ];

      const chunks = [];
      await new Promise((resolve, reject) => {
        const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
        let stderr = "";
        child.stdout.on("data", (c) => chunks.push(c));
        child.stderr.on("data", (c) => { stderr += c.toString(); });
        child.on("error", (err) => {
          reject(Object.assign(new Error(`edge-tts failed: ${err.message}. Install with: pip install edge-tts`), { code: "provider_error" }));
        });
        child.on("close", (code) => {
          if (code === 0) resolve();
          else reject(Object.assign(new Error(`edge-tts exited ${code}: ${stderr.slice(0, 200)}`), { code: "provider_error" }));
        });
      });

      // Yield the full buffer as a single chunk. Streaming would require
      // re-implementing the WSS protocol; not worth it for this adapter.
      yield Buffer.concat(chunks);
    },

    async listVoices() {
      if (_voiceCache && Date.now() - _voiceCacheTime < VOICE_CACHE_TTL) return _voiceCache;
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        const res = await fetch(VOICE_LIST_URL, { signal: controller.signal });
        clearTimeout(timeout);
        if (!res.ok) return _voiceCache || [];
        const raw = await res.json();
        _voiceCache = raw.map(v => ({
          id: v.ShortName,
          name: v.FriendlyName?.split(" - ")[0] || v.ShortName,
          locale: v.Locale,
          gender: v.Gender,
        }));
        _voiceCacheTime = Date.now();
        return _voiceCache;
      } catch {
        return _voiceCache || [];
      }
    },
  };
}
