/**
 * Meeting Recorder — the transcription worker.
 *
 *   node server/transcribe.js <session-id>
 *
 * Runs detached from the request that started it, so a ninety-minute meeting
 * finishes even if the page is closed. Audio goes to the transcription endpoint
 * in slices rather than one request: a single upload of a long meeting is a
 * fragile thing, and slices give the page something to show while it waits.
 * Slice timestamps are offset back into meeting time before anything is written.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { findSource, readMeta, sessionDir, writeMeta } from "./store.js";

const WHISPER_URL = process.env.WHISPER_URL || "http://localhost:8004/v1/audio/transcriptions";
const WHISPER_MODEL = process.env.WHISPER_MODEL || "Systran/faster-whisper-large-v3";
const SLICE_SECONDS = Number(process.env.WHISPER_SLICE_SECONDS || 600);
const EXPORT_DIR = process.env.MEETING_RECORDER_EXPORT_DIR || "";

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}: ${err.slice(0, 400)}`))
    );
  });
}

const toWav = (src, dest) =>
  run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", src,
    "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", dest]).then(() => dest);

async function durationSeconds(path) {
  const out = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1", path]);
  return Number(out.trim()) || 0;
}

async function postSlice(path) {
  const form = new FormData();
  form.append("model", WHISPER_MODEL);
  form.append("response_format", "verbose_json");
  form.append("file", new Blob([readFileSync(path)], { type: "audio/wav" }), basename(path));
  const res = await fetch(WHISPER_URL, { method: "POST", body: form });
  if (!res.ok) throw new Error(`transcription endpoint returned ${res.status}`);
  return res.json();
}

async function transcribeWav(wav, id, total) {
  const segments = [];
  const sliceDir = join(sessionDir(id), "slices");
  mkdirSync(sliceDir, { recursive: true });
  for (let start = 0; start < Math.max(total, 1); start += SLICE_SECONDS) {
    const part = join(sliceDir, `part-${String(start / SLICE_SECONDS).padStart(3, "0")}.wav`);
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y",
      "-ss", String(start), "-t", String(SLICE_SECONDS), "-i", wav,
      "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", part]);
    if (!existsSync(part) || statSync(part).size < 2000) {
      rmSync(part, { force: true });
      break;
    }
    writeMeta(id, {
      progress: `transcribing minute ${Math.round(start / 60)} of ${Math.round(total / 60)}`,
    });
    const result = await postSlice(part);
    for (const seg of result.segments || []) {
      segments.push({
        start: Math.round((Number(seg.start || 0) + start) * 100) / 100,
        end: Math.round((Number(seg.end || 0) + start) * 100) / 100,
        text: (seg.text || "").trim(),
      });
    }
    if (!(result.segments || []).length && result.text) {
      segments.push({ start, end: start, text: result.text.trim() });
    }
    rmSync(part, { force: true });
  }
  rmSync(sliceDir, { recursive: true, force: true });
  return segments;
}

export function clock(seconds) {
  const s = Math.floor(seconds || 0);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return s >= 3600 ? `${Math.floor(s / 3600)}:${mm}:${ss}` : `${Math.floor(s / 60)}:${ss}`;
}

export function toMarkdown(meta, segments) {
  const lines = [
    `# ${meta.title || "Untitled meeting"}`,
    "",
    `Recorded ${(meta.started_at || "").slice(0, 19).replace("T", " ")}. ` +
      `Duration ${clock(meta.duration_seconds)}. Transcribed locally with ` +
      `${WHISPER_MODEL.split("/").pop()}, session \`${meta.id}\`.`,
    "",
    "Machine transcript. Speaker labels are absent and names are often misheard; " +
      "check any quotation against the audio before it travels.",
    "",
  ];
  if (meta.notes) lines.push("## Notes taken while listening", "", meta.notes.trim(), "");
  lines.push("## Transcript", "");
  let para = [];
  let paraStart = null;
  for (const seg of segments) {
    if (paraStart === null) paraStart = seg.start;
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

function exportCopy(meta, markdown) {
  if (!EXPORT_DIR) return "";
  const day = (meta.started_at || new Date().toISOString()).slice(0, 10);
  const dir = join(EXPORT_DIR, `${day}-${slug(meta.title)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "transcript.md"), markdown);
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2));
  return join(dir, "transcript.md");
}

export async function transcribeSession(id) {
  const started = Date.now();
  const dir = sessionDir(id);
  try {
    writeMeta(id, { state: "transcribing", progress: "preparing audio" });
    const wav = await toWav(findSource(id), join(dir, "audio.wav"));
    const total = await durationSeconds(wav);
    writeMeta(id, { audio_seconds: Math.round(total * 10) / 10 });
    const segments = await transcribeWav(wav, id, total);
    writeFileSync(join(dir, "transcript.json"), JSON.stringify(segments, null, 2));
    const meta = readMeta(id);
    if (!meta.duration_seconds) meta.duration_seconds = Math.round(total);
    const markdown = toMarkdown(meta, segments);
    writeFileSync(join(dir, "transcript.md"), markdown);
    const exported = exportCopy(meta, markdown);
    writeMeta(id, {
      state: "done",
      duration_seconds: meta.duration_seconds,
      word_count: segments.reduce((n, s) => n + s.text.split(/\s+/).filter(Boolean).length, 0),
      segment_count: segments.length,
      transcribe_seconds: Math.round((Date.now() - started) / 100) / 10,
      transcript_path: join(dir, "transcript.md"),
      export_path: exported,
      progress: "",
    });
  } catch (err) {
    writeMeta(id, { state: "failed", error: String(err.message || err).slice(0, 500) });
    throw err;
  }
}

// Run as a detached child by the panel routes: `node server/transcribe.js <id>`.
if (process.argv[1] && process.argv[1].endsWith("transcribe.js")) {
  const id = process.argv[2];
  if (!id) {
    console.error("usage: node server/transcribe.js <session-id>");
    process.exit(2);
  }
  try {
    await transcribeSession(id);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
