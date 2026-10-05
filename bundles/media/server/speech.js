/**
 * Spoken audio for the media bundle: one function, `synthesizeToFile`, over the gateway's TTS
 * adapters. LOCAL VOICE ONLY: the profile must be a self-hosted engine on a loopback, private or
 * tailnet address. With no such profile, or when it does not answer, there is no audio and no
 * other voice is tried; the caller publishes text with the reason.
 *
 * The file is complete or absent: bytes are checked as MP3 frames, written to "<name>.part" and
 * renamed into place. Duration is counted from the frames, never estimated.
 */
import { existsSync, mkdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { dirname, join, sep } from "node:path";
import { appImport } from "./app-root.js";
import { resolveDataDir } from "./db.js";
import { readLocalSetting, TTS_PROFILE_KEY, TTS_VOICE_ES_KEY } from "./settings.js";

export const LOCAL_PROVIDERS = ["kokoro", "piper"];
const DEFAULT_URL = { kokoro: "http://localhost:8880", piper: "http://localhost:5000" };
export const MAX_REQUEST_CHARS = 1200;

/** `<data dir>/media/audio`, created on demand. Every audio file the bundle makes lives here. */
export function resolveAudioDir() {
  const dir = join(resolveDataDir(), "media", "audio");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** True only for an existing, non-empty .mp3 whose real path is inside the audio directory. */
export function insideAudioDir(p, audioDir = resolveAudioDir()) {
  if (typeof p !== "string" || !p.toLowerCase().endsWith(".mp3")) return false;
  try {
    const real = realpathSync(p);
    if (!real.startsWith(realpathSync(audioDir) + sep)) return false;
    const st = statSync(real);
    return st.isFile() && st.size > 0;
  } catch { return false; }
}

/** Loopback, RFC 1918, CGNAT/tailnet (100.64/10), IPv6 loopback, unique-local and link-local. */
export function isLocalAddress(ip) {
  const s = String(ip || "").toLowerCase();
  const v4 = s.startsWith("::ffff:") ? s.slice(7) : s;
  if (isIP(v4) === 4) {
    const [a, b] = v4.split(".").map(Number);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (isIP(s) !== 6) return false;
  return s === "::1" || s.startsWith("fc") || s.startsWith("fd") || /^fe[89ab]/.test(s);
}

/** Does this base URL point at this host or the operator's own network? Names are resolved; every address must be local. */
export async function hostIsLocal(baseUrl, lookup = dnsLookup) {
  let host;
  try {
    const u = new URL(baseUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    host = u.hostname.replace(/^\[|\]$/g, "");
  } catch { return false; }
  if (isIP(host)) return isLocalAddress(host);
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  try {
    const found = await Promise.race([
      lookup(host, { all: true }),
      new Promise((_, reject) => { const t = setTimeout(() => reject(new Error("dns timeout")), 2000); t.unref?.(); }),
    ]);
    return Array.isArray(found) && found.length > 0 && found.every((a) => isLocalAddress(a.address));
  } catch { return false; }
}

/**
 * The profile the media bundle may speak through, or the reason there is none.
 * `profileId` (the media_tts_profile_id setting) narrows the choice; it never widens the policy.
 * The instance's DEFAULT profile is deliberately not consulted: it may be a cloud voice.
 */
export async function pickLocalProfile(profiles, { profileId = null, lookup } = {}) {
  const list = Array.isArray(profiles) ? profiles : [];
  const local = (p) => p && LOCAL_PROVIDERS.includes(p.provider);
  const chosen = profileId ? list.find((p) => p.id === profileId) : list.find(local);
  if (!chosen) return { error: "no_local_voice", detail: profileId ? "the chosen voice profile does not exist" : "no local voice profile is set up" };
  if (!local(chosen)) return { error: "no_local_voice", detail: `"${chosen.name || chosen.id}" is not a local voice engine` };
  const url = chosen.baseUrl || DEFAULT_URL[chosen.provider];
  if (!(await hostIsLocal(url, lookup))) return { error: "no_local_voice", detail: `"${chosen.name || chosen.id}" is not on this host or your own network` };
  return { profile: chosen };
}

/** Split text into requests of at most `max` characters, at sentence ends where possible. */
export function splitForSpeech(text, max = MAX_REQUEST_CHARS) {
  const out = [];
  let cur = "";
  const push = (piece) => {
    if (cur && cur.length + 1 + piece.length > max) { out.push(cur); cur = ""; }
    cur = cur ? `${cur} ${piece}` : piece;
  };
  for (const sentence of String(text ?? "").split(/(?<=[.!?…])\s+/)) {
    const s = sentence.trim();
    if (!s) continue;
    if (s.length <= max) { push(s); continue; }
    for (const word of s.split(/\s+/)) {
      for (let i = 0; i < word.length; i += max) push(word.slice(i, i + max));
    }
  }
  if (cur) out.push(cur);
  return out;
}

const BITRATES = { 1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], 2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160] };
const RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

/**
 * Walk the MPEG Layer III frames of one synthesis response.
 * → { audio (frames only: tag blocks and any Xing/Info header frame dropped), duration_sec, frames },
 *   or null when the bytes are not MP3 (a WAV, an error page, an empty body).
 */
export function scanMp3(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input ?? []);
  let off = 0;
  if (buf.length > 10 && buf.toString("latin1", 0, 3) === "ID3") {
    off = 10 + ((buf[6] & 0x7f) << 21 | (buf[7] & 0x7f) << 14 | (buf[8] & 0x7f) << 7 | (buf[9] & 0x7f)) + ((buf[5] & 0x10) ? 10 : 0);
  }
  const start = off;
  const parts = [];
  let frames = 0, seconds = 0;
  while (off + 4 <= buf.length) {
    const b1 = buf[off + 1], b2 = buf[off + 2];
    if (buf[off] !== 0xff || (b1 & 0xe0) !== 0xe0) break;
    const ver = (b1 >> 3) & 3, layer = (b1 >> 1) & 3, br = b2 >> 4, sr = (b2 >> 2) & 3;
    if (ver === 1 || layer !== 1 || br === 0 || br === 15 || sr === 3) break;
    const rate = RATES[ver][sr];
    const len = Math.floor((ver === 3 ? 144 : 72) * BITRATES[ver === 3 ? 1 : 2][br] * 1000 / rate) + ((b2 >> 1) & 1);
    if (off + len > buf.length) break;
    const head = buf.toString("latin1", off + 4, Math.min(off + 44, off + len));
    if (!(frames === 0 && (head.includes("Xing") || head.includes("Info")))) {
      parts.push(buf.subarray(off, off + len));
      seconds += (ver === 3 ? 1152 : 576) / rate;
    }
    frames++;
    off += len;
  }
  const rest = buf.length - off;
  const tail = rest === 128 && buf.toString("latin1", off, off + 3) === "TAG";
  if (parts.length === 0 || (rest > 0 && !tail && off - start < (buf.length - start) * 0.9)) return null;
  return { audio: Buffer.concat(parts), duration_sec: seconds, frames: parts.length };
}

let queue = Promise.resolve();

/**
 * Synthesize `segments` (strings; each becomes one or more requests) with the local voice and write
 * one MP3 to `outPath`.
 * → { ok: true, path, duration_sec, file_size, offsets (start second of each segment), provider, profile, voice }
 * → { ok: false, error: "no_local_voice" | "voice_timeout" | "voice_failed" | "voice_format" | "empty", detail }
 * Expected failures are returned, never thrown, and leave no file behind. One synthesis runs at a time per process.
 */
export function synthesizeToFile(db, opts, deps = {}) {
  const run = queue.then(() => synthesize(db, opts, deps));
  queue = run.catch(() => {});
  return run;
}

async function synthesize(db, { segments, lang = "en", outPath, voice = null }, deps) {
  const log = deps.log || ((line) => console.error(line));
  const requestTimeoutMs = deps.requestTimeoutMs ?? 120_000;
  const deadline = Date.now() + (deps.totalTimeoutMs ?? 900_000);
  const texts = (segments || []).map((s) => String(s ?? "").trim());
  if (!outPath || !texts.some(Boolean)) return { ok: false, error: "empty", detail: "nothing to say" };

  const tts = deps.tts || await appImport("servers/gateway/ai/tts/index.js");
  const profiles = await tts.getTtsProfiles(db, { includeKeys: true });
  const picked = await pickLocalProfile(profiles, { profileId: await readLocalSetting(db, TTS_PROFILE_KEY), lookup: deps.lookup });
  if (picked.error) { log(`[media] no audio: ${picked.detail}`); return { ok: false, ...picked }; }
  const profile = picked.profile;

  const part = `${outPath}.part`;
  try {
    const { adapter } = await tts.createTtsAdapter(profile);
    let useVoice = profile.defaultVoice || "";
    if (lang === "es") useVoice = (await readLocalSetting(db, TTS_VOICE_ES_KEY)) || (profile.provider === "kokoro" ? "ef_dora" : useVoice);
    if (voice) {
      const known = await adapter.listVoices().catch(() => []);
      if (known.some((v) => v.id === voice)) useVoice = voice;   // a tool may pass a word like "female": ignored
    }
    log(`[media] voice profile=${profile.name || profile.id} provider=${profile.provider} voice=${useVoice}`);

    const bufs = [];
    const offsets = [];
    let seconds = 0;
    for (const text of texts) {
      offsets.push(Math.round(seconds * 100) / 100);
      for (const piece of splitForSpeech(text)) {
        const left = deadline - Date.now();
        if (left <= 0) throw Object.assign(new Error("the briefing took too long to voice"), { name: "TimeoutError" });
        const chunks = [];
        for await (const c of adapter.synthesize(piece, useVoice, { format: "mp3", signal: AbortSignal.timeout(Math.min(requestTimeoutMs, left)) })) chunks.push(Buffer.from(c));
        const scanned = scanMp3(Buffer.concat(chunks));
        if (!scanned) return { ok: false, error: "voice_format", detail: `"${profile.name || profile.id}" did not return MP3 audio` };
        bufs.push(scanned.audio);
        seconds += scanned.duration_sec;
      }
    }
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(part, Buffer.concat(bufs));
    renameSync(part, outPath);
    return { ok: true, path: outPath, duration_sec: Math.round(seconds * 10) / 10, file_size: statSync(outPath).size, offsets, provider: profile.provider, profile: profile.name || profile.id, voice: useVoice };
  } catch (err) {
    const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
    log(`[media] no audio: ${timedOut ? "the local voice timed out" : "the local voice did not answer"} (${String(err?.message || err).slice(0, 160)})`);
    return { ok: false, error: timedOut ? "voice_timeout" : "voice_failed", detail: String(err?.message || err).slice(0, 200) };
  } finally {
    if (existsSync(part)) rmSync(part, { force: true });
  }
}
