/**
 * Meeting Recorder — the transcription worker.
 *
 *   node server/transcribe.js <session-id>
 *   node server/transcribe.js --retranscribe [--allow-gaps] <session-id>
 *
 * Runs detached from the request that started it, so a ninety-minute meeting finishes even if
 * the page is closed.
 *
 * Why chunks, not slices: faster-whisper-server keeps condition_on_previous_text on and takes a
 * single float temperature, so on a long slice the decoder can fall into a repetition loop that
 * nothing server-side ever falls back from (one four-minute slice held a worker for eighteen
 * minutes). The worker therefore cuts the audio at the quietest moment between 20 and 30 seconds
 * (one decoder window, so there is no previous text to condition on), sends each chunk on its own
 * at temperature 0, and climbs a temperature ladder for any chunk that comes back looking like a
 * loop (see stt-client.js and loop-guard.js). A chunk nothing can read becomes a marked gap
 * rather than costing the rest of the meeting.
 *
 * --retranscribe re-runs a finished session without touching its `state`. It commits only a run
 * with no gaps (unless --allow-gaps): the new files are written as *.next, the old transcript,
 * chunk records and meta are copied to *.v1-loop.* (later runs: *.prev-<UTC time>.*, never
 * overwriting an archive), the same is done in the export copy's folder, and only then are the new
 * files renamed into place. Nothing that existed before the run is deleted.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync,
  rmSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { frameEnergies, planChunks, readWavHeader, wavSeconds, wavSpan } from "./audio.js";
import { LADDER, transcribeChunk } from "./stt-client.js";
import { dataDir, findSource, readMeta, sessionDir, writeMeta } from "./store.js";

export const TRANSCRIBER_VERSION = "1.0.2";
const FRAME_MS = 100;
const MIN_CHUNK_S = 0.25;
// Node's fetch gives up on response headers at 300 s (undici's default) whatever the signal says.
const MAX_TIMEOUT_MS = 290000;
// No endpoint answering this many chunks in a row means it is down, not that the audio is bad.
const DEAD_STREAK = 5;
// With a fallback configured, the primary is skipped after this many consecutive down chunks and
// re-probed every PROBE_EVERY chunks.
const SKIP_AFTER = 2;
const PROBE_EVERY = 10;

function num(env, names, fallback, { min = -Infinity, max = Infinity } = {}) {
  for (const name of names) {
    const raw = env[name];
    if (raw === undefined || raw === "") continue;
    const v = Number(raw);
    if (!Number.isFinite(v) || v < min || v > max) throw new Error(`${name} must be a number in [${min}, ${max}]`);
    return v;
  }
  return fallback;
}

/** Settings from the environment. Defaults keep today's single loopback endpoint. */
export function config(env = process.env) {
  const model = env.WHISPER_MODEL || "Systran/faster-whisper-large-v3";
  const endpoints = [{
    engine: "primary",
    url: env.WHISPER_URL || "http://localhost:8004/v1/audio/transcriptions",
    model,
  }];
  if (env.WHISPER_FALLBACK_URL) {
    endpoints.push({ engine: "fallback", url: env.WHISPER_FALLBACK_URL, model: env.WHISPER_FALLBACK_MODEL || model });
  }
  const minS = num(env, ["WHISPER_CHUNK_MIN_S"], 20, { min: 1, max: 3600 });
  const maxS = num(env, ["WHISPER_CHUNK_MAX_S"], 30, { min: 2, max: 3600 });
  if (!(minS < maxS)) throw new Error("WHISPER_CHUNK_MIN_S must be below WHISPER_CHUNK_MAX_S");
  return {
    endpoints,
    minS,
    maxS,
    vad: String(env.WHISPER_VAD_FILTER ?? "true").toLowerCase() !== "false",
    language: env.WHISPER_LANGUAGE || "",
    // WHISPER_SLICE_* are the names earlier versions' local patches used; they still work.
    timeoutMs: Math.min(MAX_TIMEOUT_MS,
      num(env, ["WHISPER_CHUNK_TIMEOUT_MS", "WHISPER_SLICE_TIMEOUT_MS"], 90000, { min: 1 })),
    drainTimeoutMs: num(env, ["WHISPER_DRAIN_TIMEOUT_MS"], 600000, { min: 1 }),
    attempts: num(env, ["WHISPER_ATTEMPTS", "WHISPER_SLICE_ATTEMPTS"], 3, { min: 1, max: 10 }),
    backoffMs: num(env, ["WHISPER_BACKOFF_MS"], 5000, { min: 0 }),
    ratioMax: num(env, ["WHISPER_COMPRESSION_RATIO_MAX"], 2.4, { min: 1 }),
    exportDir: env.MEETING_RECORDER_EXPORT_DIR || "",
  };
}

function run(cmd, args) {
  return new Promise((ok, fail) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    child.on("error", fail);
    child.on("close", (code) =>
      code === 0 ? ok() : fail(new Error(`${cmd} exited ${code}: ${err.slice(0, 400)}`)));
  });
}

/** ffmpeg to a temp name, renamed over dest only once it is a readable WAV. */
async function toWav(src, dest) {
  const tmp = join(dirname(dest), ".audio.wav.tmp");
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", src,
    "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-f", "wav", tmp]);
  readWavHeader(tmp);
  renameSync(tmp, dest);
  return dest;
}

/** The existing audio.wav, if it is the 16 kHz mono 16-bit file this worker writes and as long as recorded. */
function usableWav(path, expectSeconds) {
  if (!existsSync(path)) return false;
  try {
    const h = readWavHeader(path);
    if (h.sampleRate !== 16000 || !(h.dataBytes > 0)) return false;
    return !(expectSeconds > 0) || Math.abs(wavSeconds(h) - expectSeconds) <= 1;
  } catch {
    return false;
  }
}

const r2 = (x) => Math.round(x * 100) / 100;
const wordCount = (text) => String(text || "").split(/\s+/).filter(Boolean).length;

export function clock(seconds) {
  const s = Math.floor(seconds || 0);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return s >= 3600 ? `${Math.floor(s / 3600)}:${mm}:${ss}` : `${Math.floor(s / 60)}:${ss}`;
}

/** UTC stamp for file names: 20261020T143000Z. */
const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

/** What a cached chunk depends on besides its boundaries. */
function fingerprint(wav, header, cfg) {
  const head = Buffer.alloc(Math.min(65536, header.dataBytes));
  const fd = openSync(wav, "r");
  try {
    readSync(fd, head, 0, head.length, header.dataOffset);
  } finally {
    closeSync(fd);
  }
  return JSON.stringify({
    version: TRANSCRIBER_VERSION,
    endpoints: cfg.endpoints.map((e) => [e.engine, e.model]),
    vad: cfg.vad, language: cfg.language, ratioMax: cfg.ratioMax, ladder: LADDER,
    minS: cfg.minS, maxS: cfg.maxS,
    audio: [header.dataBytes, createHash("sha256").update(head).digest("hex")],
  });
}

/** The chunk cache, moved aside (never deleted) when it was made under different settings. */
function openCache(id, fp) {
  const dir = join(sessionDir(id), "chunks");
  const settings = join(dir, "settings.json");
  if (existsSync(dir) && (!existsSync(settings) || readFileSync(settings, "utf8") !== fp)) {
    renameSync(dir, join(sessionDir(id), `chunks.stale-${stamp()}`));
  }
  mkdirSync(dir, { recursive: true });
  if (!existsSync(settings)) writeAtomic(settings, fp);
  return dir;
}

/** Write then rename, so a crash never leaves half a file under the real name. */
function writeAtomic(path, text) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/** A cached chunk, or null when there is none or it cannot be read (then it is simply redone). */
function readCached(path) {
  if (!existsSync(path)) return null;
  try {
    const v = JSON.parse(readFileSync(path, "utf8"));
    return v && v.result && v.record ? v : null;
  } catch {
    return null;
  }
}

/**
 * Cut, send and stitch. Finished chunks are cached under <session>/chunks/, keyed by index and
 * boundaries, so a re-run after a crash or a gap only pays for what is missing.
 */
async function transcribeWav(id, wav, cfg, progress) {
  const header = readWavHeader(wav);
  const total = wavSeconds(header);
  const plan = planChunks(frameEnergies(wav, header, FRAME_MS),
    { frameMs: FRAME_MS, minS: cfg.minS, maxS: cfg.maxS, totalS: total });
  const cacheDir = openCache(id, fingerprint(wav, header, cfg));
  const segments = [];
  const chunks = [];
  let dead = 0;
  let primaryDown = 0;
  for (let index = 0; index < plan.length; index++) {
    const [start, end] = plan[index];
    if (end - start < MIN_CHUNK_S) continue;
    const key = `c${String(index).padStart(4, "0")}-${Math.round(start * 1000)}-${Math.round(end * 1000)}.json`;
    const cached = join(cacheDir, key);
    let result = null;
    let record = null;
    const hit = readCached(cached);
    if (hit) {
      ({ result, record } = hit);
      dead = 0;
    } else {
      progress(`transcribing minute ${Math.floor(start / 60)} of ${Math.round(total / 60)}`);
      // With a fallback, stop paying for a primary that keeps failing; look again now and then.
      const skipPrimary = cfg.endpoints.length > 1 && primaryDown >= SKIP_AFTER &&
        (primaryDown - SKIP_AFTER + 1) % PROBE_EVERY !== 0;
      const endpoints = skipPrimary ? cfg.endpoints.slice(1) : cfg.endpoints;
      const t0 = Date.now();
      const out = await transcribeChunk(endpoints, wavSpan(wav, header, start, end), end - start, cfg);
      result = out.result;
      record = { ...out.record, wall_s: Math.round((Date.now() - t0) / 100) / 10 };
      primaryDown = skipPrimary || out.down.includes("primary") ? primaryDown + 1 : 0;
      dead = result ? 0 : dead + 1;
      if (result) writeAtomic(cached, JSON.stringify({ result, record }));
      if (dead >= DEAD_STREAK) {
        throw new Error(`no transcription endpoint answered ${DEAD_STREAK} chunks in a row ` +
          `(last: ${record.error}); finished chunks are kept for a re-run`);
      }
    }
    record = { index, start, end, ...record };
    chunks.push(record);
    if (!result) {
      segments.push({ start, end, text: `[transcription gap: ${clock(start)} to ${clock(end)}]`, chunk: index, gap: true });
      continue;
    }
    const mark = record.suspect ? { suspect: true } : {};
    const clamp = (t) => r2(Math.min(end, Math.max(start, Number(t || 0) + start)));
    const segs = Array.isArray(result.segments) ? result.segments : [];
    for (const seg of segs) {
      segments.push({ start: clamp(seg.start), end: clamp(seg.end), text: String(seg.text || "").trim(), chunk: index, ...mark });
    }
    if (!segs.length && result.text) {
      segments.push({ start, end, text: String(result.text).trim(), chunk: index, ...mark });
    }
  }
  return { segments, chunks, total, cacheDir };
}

function summarize(chunks, cfg) {
  const models = [...new Set(chunks.filter((c) => !c.gap).map((c) => c.model))];
  const languages = {};
  for (const c of chunks) if (c.language) languages[c.language] = (languages[c.language] || 0) + 1;
  return {
    version: TRANSCRIBER_VERSION,
    models: models.length ? models : [cfg.endpoints[0].model],
    chunks: chunks.length,
    retried: chunks.filter((c) => !c.gap && (c.temperature > 0 || c.engine !== "primary")).length,
    suspect: chunks.filter((c) => c.suspect).length,
    gaps: chunks.filter((c) => c.gap).length,
    languages,
  };
}

export function toMarkdown(meta, segments, summary, chunks = []) {
  const models = [...new Set(summary.models.map((m) => m.split("/").pop()))];
  const lines = [
    `# ${meta.title || "Untitled meeting"}`,
    "",
    `Recorded ${(meta.started_at || "").slice(0, 19).replace("T", " ")}. ` +
      `Duration ${clock(meta.duration_seconds)}. Transcribed with ${models.join(" and ")}, ` +
      `session \`${meta.id}\`.`,
    "",
  ];
  if (summary.retried || summary.suspect || summary.gaps) {
    lines.push(`${summary.chunks} chunks; ${summary.retried} needed a retry at a higher temperature or on the ` +
      `fallback endpoint; ${summary.suspect} flagged as possible repetition; ` +
      `${summary.gaps} could not be transcribed.`, "");
  }
  lines.push(
    "Machine transcript. Speaker labels are absent and names are often misheard; " +
      "check any quotation against the audio before it travels.",
    "",
  );
  if (meta.notes) lines.push("## Notes taken while listening", "", meta.notes.trim(), "");
  lines.push("## Transcript", "");
  const spans = new Map(chunks.map((c) => [c.index, c]));
  let para = [];
  let paraStart = null;
  let marked = -1;
  for (const seg of segments) {
    if (paraStart === null) paraStart = seg.start;
    // The marker goes inline, right before the first words of the chunk it describes.
    if (seg.suspect && seg.chunk !== marked) {
      const c = spans.get(seg.chunk);
      para.push(`[possible repetition: ${clock(c ? c.start : seg.start)} to ${clock(c ? c.end : seg.end)}]`);
      marked = seg.chunk;
    }
    para.push(seg.text);
    // Break every ~45 seconds so the transcript reads in paragraphs.
    if (seg.end - paraStart > 45) {
      lines.push(`**[${clock(paraStart)}]** ${para.join(" ").trim()}`, "");
      para = [];
      paraStart = null;
    }
  }
  if (para.length) lines.push(`**[${clock(paraStart || 0)}]** ${para.join(" ").trim()}`, "");
  return lines.join("\n");
}

const slug = (text) =>
  (text || "meeting").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) ||
  "meeting";

const exportFolder = (meta, exportDir) =>
  join(exportDir, `${(meta.started_at || new Date().toISOString()).slice(0, 10)}-${slug(meta.title)}`);

function writeExport(dir, meta, markdown) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "transcript.md"), markdown);
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2));
  return join(dir, "transcript.md");
}

/**
 * Copy a set of files in `dir` aside under one label. Each entry is {name, prefix, suffix,
 * bytes?}; `bytes` replaces reading the file (used for meta.json as it was before the run). The
 * label is "v1-loop" when every target name is free, else one "prev-<stamp>" (with -2, -3 ... on a
 * collision) for the whole set. Writes use the "wx" flag, so an archive is never overwritten; any
 * failure throws before the caller changes anything.
 */
function archive(dir, files) {
  const present = files.filter((f) => f.bytes || existsSync(join(dir, f.name)));
  if (!present.length) return {};
  const nameFor = (f, label) => `${f.prefix}.${label}${f.suffix}`;
  const free = (label) => files.every((f) => !existsSync(join(dir, nameFor(f, label))));
  let label = "v1-loop";
  if (!free(label)) {
    const base = `prev-${stamp()}`;
    label = base;
    for (let n = 2; !free(label); n++) label = `${base}-${n}`;
  }
  const written = {};
  for (const f of present) {
    const dest = join(dir, nameFor(f, label));
    writeFileSync(dest, f.bytes || readFileSync(join(dir, f.name)), { flag: "wx" });
    written[f.name] = dest;
  }
  return written;
}

/** Is pid a live meeting-recorder worker? EPERM counts as alive; a reused pid running something else does not. */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (err) {
    if (err.code !== "EPERM") return false;
  }
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("transcribe.js");
  } catch {
    return true; // no /proc to ask: assume the worst
  }
}

/** The normal path: the panel's detached worker for a session that just finished recording. */
export async function transcribeSession(id, { env = process.env, convert = toWav } = {}) {
  const started = Date.now();
  const dir = sessionDir(id);
  const holder = lockHolder(dir);
  if (holder) {
    // The panel already set "transcribing"; leave a state a later run will accept, not a stuck one.
    const message = `a retranscribe of ${id} is running (pid ${holder}); not starting a second worker`;
    writeMeta(id, { state: existsSync(join(dir, "transcript.md")) ? "done" : "failed", error: message,
      progress: "", worker_pid: null });
    throw new Error(message);
  }
  try {
    const cfg = config(env);
    writeMeta(id, { state: "transcribing", progress: "preparing audio", worker_pid: process.pid });
    const wav = await convert(findSource(id), join(dir, "audio.wav"));
    const { segments, chunks, total, cacheDir } =
      await transcribeWav(id, wav, cfg, (progress) => writeMeta(id, { progress }));
    const summary = summarize(chunks, cfg);
    if (summary.chunks && summary.gaps * 2 > summary.chunks) {
      throw new Error(`${summary.gaps} of ${summary.chunks} chunks could not be transcribed; ` +
        "finished chunks are kept for a re-run");
    }
    const meta = readMeta(id);
    if (!meta.duration_seconds) meta.duration_seconds = Math.round(total);
    const markdown = toMarkdown(meta, segments, summary, chunks);
    writeFileSync(join(dir, "transcript.json"), JSON.stringify(segments, null, 2));
    writeFileSync(join(dir, "chunks.json"), JSON.stringify(chunks, null, 2));
    writeFileSync(join(dir, "transcript.md"), markdown);
    const fields = finalFields(dir, meta, segments, chunks, summary, total, started);
    fields.export_path = cfg.exportDir
      ? writeExport(exportFolder(meta, cfg.exportDir), { ...meta, ...fields }, markdown) : "";
    writeMeta(id, fields);
    if (!summary.gaps) rmSync(cacheDir, { recursive: true, force: true });
  } catch (err) {
    writeMeta(id, { state: "failed", error: String(err.message || err).slice(0, 500), progress: "", worker_pid: null });
    throw err;
  }
}

function finalFields(dir, meta, segments, chunks, summary, total, started) {
  return {
    state: "done",
    duration_seconds: meta.duration_seconds,
    audio_seconds: Math.round(total * 10) / 10,
    word_count: segments.reduce((n, s) => n + (s.gap ? 0 : wordCount(s.text)), 0),
    segment_count: segments.length,
    transcribe_seconds: Math.round((Date.now() - started) / 100) / 10,
    transcript_path: join(dir, "transcript.md"),
    transcriber: summary,
    // Whole-field replacements: nothing from an earlier run survives the merge.
    gaps: chunks.filter((c) => c.gap).map((c) => ({ start: c.start, seconds: r2(c.end - c.start), error: c.error || "" })),
    suspect_chunks: chunks.filter((c) => c.suspect).map((c) => ({ start: c.start, end: c.end, reason: c.suspect_reason })),
    progress: "",
    error: "",
    worker_pid: null,
  };
}

const lockPath = (dir) => join(dir, "retranscribe.lock");

/** The pid holding a live retranscribe lock on this session, or 0. */
function lockHolder(dir) {
  try {
    const pid = Number(readFileSync(lockPath(dir), "utf8"));
    return pidAlive(pid) ? pid : 0;
  } catch {
    return 0;
  }
}

/** Take the session's retranscribe lock, or throw. A dead holder's lock is renamed aside (atomic) and retaken. */
function lock(dir) {
  const path = lockPath(dir);
  for (let i = 0; i < 2; i++) {
    try {
      writeFileSync(path, String(process.pid), { flag: "wx" });
      return () => {
        try {
          if (readFileSync(path, "utf8") === String(process.pid)) rmSync(path);
        } catch { /* already gone */ }
      };
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      if (lockHolder(dir)) throw new Error(`a retranscribe is already running (pid ${lockHolder(dir)})`);
      try {
        // Only one contender wins this rename; the other gets ENOENT and retries the wx open.
        renameSync(path, `${path}.stale-${process.pid}`);
        rmSync(`${path}.stale-${process.pid}`, { force: true });
      } catch { /* someone else took it over first */ }
    }
  }
  throw new Error("could not take the retranscribe lock");
}

/** Another session in the data dir with a live worker, if any: two workers make each other time out. */
function otherLiveWorker(id) {
  const root = dataDir();
  for (const name of existsSync(root) ? readdirSync(root) : []) {
    if (name === id) continue;
    try {
      const m = readMeta(name);
      if (pidAlive(m.worker_pid) || lockHolder(join(root, name))) return name;
    } catch { /* not a session */ }
  }
  return "";
}

/**
 * Re-run a finished session. Returns {committed, gaps}. Until it commits it writes nothing in the
 * session but its own files (retranscribe.json for progress, retranscribe.lock, chunks/), so
 * meta.json, the transcript and `state` stay exactly as they were.
 */
export async function retranscribeSession(id, { env = process.env, convert = toWav, allowGaps = false } = {}) {
  const started = Date.now();
  const dir = sessionDir(id);
  const metaPath = join(dir, "meta.json");
  if (!existsSync(metaPath)) throw new Error(`no session ${id}`);
  const originalMeta = readFileSync(metaPath);
  const before = JSON.parse(originalMeta.toString("utf8"));
  if (before.state === "recording") throw new Error(`session ${id} is still recording`);
  if (before.state === "transcribing" && (!before.worker_pid || pidAlive(before.worker_pid))) {
    throw new Error(`session ${id} is already running (state transcribing, worker pid ${before.worker_pid || "unknown"})`);
  }
  if (!existsSync(join(dir, "transcript.md"))) {
    throw new Error(`session ${id} has no transcript to keep; run it without --retranscribe`);
  }
  const cfg = config(env);
  // The export copy lives where the session says it does, not where this shell's env points.
  const recorded = before.export_path || before.repo_path || "";
  let exportTarget = "";
  if (recorded) {
    exportTarget = dirname(recorded);
    if (basename(recorded) !== "transcript.md") throw new Error(`the session's export path ${recorded} is not a transcript.md`);
    if (!existsSync(exportTarget)) {
      throw new Error(`the session's export folder ${exportTarget} is missing; refusing to write a new one`);
    }
    const theirs = join(exportTarget, "meta.json");
    if (existsSync(theirs)) {
      let other = null;
      try {
        other = JSON.parse(readFileSync(theirs, "utf8")).id;
      } catch { /* unreadable: treated as a mismatch below */ }
      if (other !== id) throw new Error(`the export folder ${exportTarget} belongs to another session (${other})`);
    }
  } else if (cfg.exportDir) {
    exportTarget = exportFolder(before, cfg.exportDir);
  }

  const unlock = lock(dir);
  // Made only when audio.wav exists but is not reusable; this run's own file, removed when it ends.
  const scratchWav = join(dir, "audio.retranscribe.wav");
  // Checked under the lock, so two retranscribes started together cannot both pass.
  const busy = otherLiveWorker(id);
  if (busy) {
    unlock();
    throw new Error(`session ${busy} has a live worker; retranscribe when it is finished`);
  }
  const statusPath = join(dir, "retranscribe.json");
  const status = (fields) => {
    let cur = {};
    try {
      cur = JSON.parse(readFileSync(statusPath, "utf8"));
    } catch { /* first write */ }
    writeAtomic(statusPath, JSON.stringify({ ...cur, ...fields }, null, 2));
  };
  try {
    status({ state: "running", pid: process.pid, started_at: new Date().toISOString(), progress: "preparing audio", error: "" });
    // Reuse audio.wav when it is what the worker would make; otherwise convert beside it, never over it.
    const wavPath = join(dir, "audio.wav");
    const wav = usableWav(wavPath, before.audio_seconds) ? wavPath
      : await convert(findSource(id), existsSync(wavPath) ? scratchWav : wavPath);
    const { segments, chunks, total, cacheDir } = await transcribeWav(id, wav, cfg, (progress) => status({ progress }));
    const summary = summarize(chunks, cfg);
    if (summary.gaps && !allowGaps) {
      status({ state: "incomplete", pid: null, progress: "",
        error: `${summary.gaps} of ${summary.chunks} chunks could not be transcribed; nothing was replaced. ` +
          "Re-run to retry only those chunks, or pass --allow-gaps." });
      return { committed: false, gaps: summary.gaps };
    }
    const meta = { ...before };
    if (!meta.duration_seconds) meta.duration_seconds = Math.round(total);
    const markdown = toMarkdown(meta, segments, summary, chunks);
    // 1. New files under .next names.
    writeFileSync(join(dir, "transcript.next.json"), JSON.stringify(segments, null, 2));
    writeFileSync(join(dir, "chunks.next.json"), JSON.stringify(chunks, null, 2));
    writeFileSync(join(dir, "transcript.next.md"), markdown);
    // 2. Archive the old set, meta.json as read before the run. Throws before anything is replaced.
    const kept = archive(dir, [
      { name: "transcript.md", prefix: "transcript", suffix: ".md" },
      { name: "transcript.json", prefix: "transcript", suffix: ".json" },
      { name: "chunks.json", prefix: "chunks", suffix: ".json" },
      { name: "meta.json", prefix: "meta", suffix: ".json", bytes: originalMeta },
    ]);
    if (exportTarget && existsSync(exportTarget)) {
      archive(exportTarget, [
        { name: "transcript.md", prefix: "transcript", suffix: ".md" },
        { name: "meta.json", prefix: "meta", suffix: ".json" },
      ]);
    }
    // 3. Swap in, and make meta describe the new files straight away.
    renameSync(join(dir, "transcript.next.json"), join(dir, "transcript.json"));
    renameSync(join(dir, "chunks.next.json"), join(dir, "chunks.json"));
    renameSync(join(dir, "transcript.next.md"), join(dir, "transcript.md"));
    const fields = finalFields(dir, meta, segments, chunks, summary, total, started);
    fields.retranscribed_at = new Date().toISOString();
    fields.previous_transcript = {
      md: kept["transcript.md"] || "", json: kept["transcript.json"] || "",
      chunks: kept["chunks.json"] || "", meta: kept["meta.json"] || "",
      word_count: before.word_count ?? null, segment_count: before.segment_count ?? null,
    };
    writeMeta(id, fields);
    // 4. The export copy last; a failure there is recorded, it does not undo the commit.
    if (exportTarget) {
      try {
        writeMeta(id, { export_path: writeExport(exportTarget, readMeta(id), markdown), export_error: "" });
      } catch (err) {
        writeMeta(id, { export_error: String(err.message || err).slice(0, 500) });
      }
    }
    status({ state: "done", pid: null, progress: "", error: "", committed_at: new Date().toISOString() });
    if (!summary.gaps) rmSync(cacheDir, { recursive: true, force: true });
    return { committed: true, gaps: summary.gaps };
  } catch (err) {
    // Unless the swap happened, the old transcript is untouched and still valid.
    status({ state: "failed", pid: null, progress: "", error: String(err.message || err).slice(0, 500) });
    throw err;
  } finally {
    rmSync(scratchWav, { force: true });
    unlock();
  }
}

/** True when this file is the program node was asked to run (symlinked paths included). */
function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

// Run as a detached child by the panel routes (`node server/transcribe.js <id>`), or by hand.
if (isMainModule()) {
  const args = process.argv.slice(2);
  const re = args.includes("--retranscribe");
  const allowGaps = args.includes("--allow-gaps");
  const ids = args.filter((a) => a !== "--retranscribe" && a !== "--allow-gaps");
  if (ids.length !== 1 || ids[0].startsWith("-") || (allowGaps && !re)) {
    console.error("usage: node server/transcribe.js <session-id>\n" +
      "       node server/transcribe.js --retranscribe [--allow-gaps] <session-id>");
    process.exit(2);
  }
  try {
    if (re) {
      const out = await retranscribeSession(ids[0], { allowGaps });
      console.log(out.committed
        ? `retranscribed ${ids[0]}${out.gaps ? ` with ${out.gaps} gaps` : ""}; the old transcript is kept alongside`
        : `not committed: ${out.gaps} gaps; nothing was replaced (see retranscribe.json)`);
      process.exit(out.committed ? 0 : 3);
    } else {
      await transcribeSession(ids[0]);
    }
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
