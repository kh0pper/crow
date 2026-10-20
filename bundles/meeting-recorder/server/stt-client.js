/**
 * Meeting Recorder — one chunk, sent to an OpenAI-compatible transcription endpoint.
 *
 * faster-whisper-server takes a single float temperature and keeps condition_on_previous_text
 * on, so Whisper's own temperature fallback never runs server-side. This client runs it instead:
 * temperature 0 first, and if any returned segment compresses too well (Whisper's 2.4) or the
 * loop guard flags the text, the same chunk again at 0.2, 0.4 ... 1.0. The first result that
 * passes is kept; if none does, the least bad one is kept and the chunk is marked suspect.
 *
 * Endpoints are tried in order (primary, then an optional fallback). The fallback takes a chunk
 * the primary could not answer at all, or one the primary could only answer suspectly.
 */

import { encodeWav } from "./audio.js";
import { compressionRatio, loopCheck, LOOP_DEFAULTS } from "./loop-guard.js";

export const LADDER = Object.freeze([0, 0.2, 0.4, 0.6, 0.8, 1.0]);

export class SttError extends Error {
  constructor(kind, message) {
    super(message);
    // "timeout": no answer in time. "transport": refused, reset, 5xx, unreadable body.
    // "config": a 4xx, which no retry will fix (wrong model name, wrong path).
    this.kind = kind;
  }
}

async function postOnce(endpoint, wav, { temperature, vad, language, timeoutMs }) {
  const form = new FormData();
  form.append("model", endpoint.model);
  form.append("response_format", "verbose_json");
  form.append("temperature", String(temperature));
  form.append("vad_filter", vad ? "true" : "false");
  if (language) form.append("language", language);
  form.append("file", new Blob([wav], { type: "audio/wav" }), "chunk.wav");
  let res;
  try {
    res = await fetch(endpoint.url, { method: "POST", body: form, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const code = err && err.cause && err.cause.code;
    if (err && (err.name === "TimeoutError" || err.name === "AbortError" || code === "UND_ERR_HEADERS_TIMEOUT")) {
      throw new SttError("timeout", `no answer within ${Math.round(timeoutMs / 1000)} s`);
    }
    throw new SttError("transport", String(code || (err && err.message) || err));
  }
  if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
    throw new SttError("config", `transcription endpoint returned ${res.status} for ${endpoint.engine}; ` +
      "check its URL and model name");
  }
  if (!res.ok) throw new SttError("transport", `transcription endpoint returned ${res.status}`);
  let body;
  try {
    body = await res.json();
  } catch (err) {
    if (err && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new SttError("timeout", `no answer within ${Math.round(timeoutMs / 1000)} s`);
    }
    throw new SttError("transport", "transcription endpoint returned a body that is not JSON");
  }
  // Another engine may answer in another shape; anything that is not an object is not an answer.
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new SttError("transport", "transcription endpoint returned something other than a JSON object");
  }
  if (Array.isArray(body.segments)) {
    body.segments = body.segments.filter((x) => x && typeof x === "object");
  } else if (body.segments !== undefined) {
    delete body.segments;
  }
  return body;
}

/** Score one response: the worst segment ratio (the server's, else computed) and the loop guard. */
export function judge(result, seconds, { ratioMax = 2.4, loop = {} } = {}) {
  const segments = Array.isArray(result && result.segments) ? result.segments : [];
  const text = segments.length ? segments.map((s) => s.text || "").join(" ") : String((result && result.text) || "");
  let maxRatio = 0;
  for (const s of segments) {
    const r = Number.isFinite(Number(s.compression_ratio)) && s.compression_ratio !== null
      ? Number(s.compression_ratio)
      : compressionRatio(s.text);
    if (r > maxRatio) maxRatio = r;
  }
  if (!segments.length) maxRatio = compressionRatio(text);
  const check = loopCheck(text, seconds, loop);
  const outcome = maxRatio > ratioMax ? "ratio" : check.loop ? "loop" : "ok";
  return { outcome, maxRatio, check, text };
}

const round3 = (x) => Math.round(x * 1000) / 1000;
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

/** One second of silence, used to find out when the server has finished abandoned work. */
const SILENCE = encodeWav(new Int16Array(16000), 16000);

/**
 * Wait for the endpoint to go idle. An aborted request keeps decoding server-side, and
 * faster-whisper-server runs one request per model at a time, so the next rung would queue behind
 * the abandoned one and time out too. A tiny request queued behind it returns only once that work
 * is done.
 */
async function drain(endpoint, opts) {
  try {
    await postOnce(endpoint, SILENCE, { temperature: 0, vad: false, language: opts.language,
      timeoutMs: opts.drainTimeoutMs ?? 600000 });
    return true;
  } catch (err) {
    if (err.kind === "config") throw err;
    return false;
  }
}

/** The temperature ladder on one endpoint. */
async function ladder(endpoint, wav, seconds, opts) {
  const limit = { ...LOOP_DEFAULTS, ...(opts.loop || {}) }.maxRepeats;
  const attempts = Math.max(1, opts.attempts ?? 3);
  const tried = [];
  let best = null;
  let lastError = "";
  let timeouts = 0;
  for (const temperature of opts.temperatures || LADDER) {
    let result = null;
    let outcome = "error";
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        result = await postOnce(endpoint, wav, { ...opts, temperature });
        outcome = "answered";
        break;
      } catch (err) {
        if (err.kind === "config") throw err;
        lastError = err.message;
        if (err.kind === "timeout") {
          // A 20-30 s chunk that takes this long is the loop signature; a different temperature is
          // the remedy, not the same request again.
          outcome = "timeout";
          break;
        }
        if (attempt < attempts) await sleep((opts.backoffMs ?? 5000) * attempt);
      }
    }
    if (outcome === "error") {
      tried.push([temperature, null, "error"]);
      // The endpoint is down for this chunk; climbing the ladder against it would only wait longer.
      return { endpoint, best, tried, down: !best, error: lastError };
    }
    if (outcome === "timeout") {
      tried.push([temperature, null, "timeout"]);
      timeouts++;
      const idle = await drain(endpoint, opts);
      if (!idle) return { endpoint, best, tried, down: !best, error: `${lastError}; the endpoint did not recover` };
      if (timeouts >= 2) break; // two wedges on one chunk: stop feeding it
      continue;
    }
    const verdict = judge(result, seconds, opts);
    tried.push([temperature, round3(verdict.maxRatio), verdict.outcome]);
    const candidate = { result, temperature, ...verdict };
    if (!best || better(candidate, best, limit)) best = candidate;
    if (verdict.outcome === "ok") return { endpoint, best: candidate, tried, down: false, error: "" };
  }
  // A ladder that ended on timeouts with nothing to show is a wedged endpoint: down, for the breaker.
  return { endpoint, best, tried, down: !best, error: best ? "" : lastError };
}

/**
 * Transcribe one chunk. Returns {result, record, error}: result is the endpoint's JSON (null when
 * nothing answered), record is what the worker writes to chunks.json.
 */
export async function transcribeChunk(endpoints, wav, seconds, opts = {}) {
  const limit = { ...LOOP_DEFAULTS, ...(opts.loop || {}) }.maxRepeats;
  const runs = [];
  let chosen = null;
  for (const endpoint of endpoints) {
    const run = await ladder(endpoint, wav, seconds, { vad: true, ...opts });
    runs.push(run);
    if (run.best && run.best.outcome === "ok") {
      chosen = run;
      break;
    }
    // Suspect or empty: let the next endpoint try, but keep this one if nothing beats it.
    if (run.best && (!chosen || better(run.best, chosen.best, limit))) chosen = run;
  }
  const tried = runs.flatMap((r) => r.tried.map((t) => [r.endpoint.engine, ...t]));
  const down = runs.filter((r) => r.down).map((r) => r.endpoint.engine);
  if (!chosen || !chosen.best) {
    const error = runs.map((r) => `${r.endpoint.engine}: ${r.error || "no usable result"}`).join("; ");
    return { result: null, down, record: { gap: true, suspect: false, tried, error }, error };
  }
  const b = chosen.best;
  return {
    result: b.result,
    down,
    error: "",
    record: {
      engine: chosen.endpoint.engine,
      model: chosen.endpoint.model,
      temperature: b.temperature,
      max_compression_ratio: round3(b.maxRatio),
      words: b.check.words,
      wps: round3(b.check.wps),
      max_ngram_repeats: b.check.maxRepeats,
      language: typeof b.result.language === "string" ? b.result.language : null,
      suspect: b.outcome !== "ok",
      suspect_reason: b.outcome === "ratio" ? `compression ratio ${b.maxRatio.toFixed(2)}`
        : b.outcome === "loop" ? b.check.reason : "",
      gap: false,
      tried,
    },
  };
}

/**
 * Rank results: passing first, then a ratio failure over a loop-guard failure. Among ratio
 * failures the lower ratio wins. Among loop-guard failures a real repeat (an n-gram over the
 * limit) is worse than speed alone, and otherwise the lower temperature wins: a fast but steady
 * speaker trips the speed check at every temperature, and T=0 is then the faithful one.
 */
function better(a, b, maxRepeats = LOOP_DEFAULTS.maxRepeats) {
  const cls = (c) => (c.outcome === "ok" ? 0 : c.outcome === "ratio" ? 1 : 2);
  if (cls(a) !== cls(b)) return cls(a) < cls(b);
  if (cls(a) === 1) return a.maxRatio < b.maxRatio;
  if (cls(a) === 2) {
    const rep = (c) => (c.check.maxRepeats > maxRepeats ? c.check.maxRepeats : 0);
    if (rep(a) !== rep(b)) return rep(a) < rep(b);
    return a.temperature < b.temperature;
  }
  return false;
}
