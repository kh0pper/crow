/**
 * Meeting Recorder — session storage.
 *
 * One directory per recording under $CROW_HOME/data/meeting-recorder/<id>/:
 *   audio.webm | audio.<ext>   the recording (appended chunk by chunk, or uploaded)
 *   audio.wav                  16 kHz mono, what the transcriber reads
 *   meta.json                  title, timings, state, results
 *   transcript.json            segments with start, end, text
 *   transcript.md              the readable transcript
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const dataDir = () =>
  join(process.env.CROW_HOME || join(homedir(), ".crow"), "data", "meeting-recorder");

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Reject anything path-shaped before it reaches the filesystem. */
export function sessionDir(id) {
  if (!ID_RE.test(id || "")) throw new Error("bad session id");
  return join(dataDir(), id);
}

export function newId() {
  const t = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}-${p(t.getHours())}${p(t.getMinutes())}${p(t.getSeconds())}`;
  return `${stamp}-${Math.random().toString(16).slice(2, 8)}`;
}

export function readMeta(id) {
  const p = join(sessionDir(id), "meta.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
}

export function writeMeta(id, fields) {
  const dir = sessionDir(id);
  mkdirSync(dir, { recursive: true });
  const meta = { ...readMeta(id), ...fields };
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2));
  return meta;
}

export function listSessions(limit = 25) {
  const root = dataDir();
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => ID_RE.test(name) && existsSync(join(root, name, "meta.json")))
    .sort()
    .reverse()
    .slice(0, limit)
    .map((name) => {
      try {
        return readMeta(name);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/** The recorder writes audio.webm; an upload keeps its own suffix. */
export function findSource(id) {
  const dir = sessionDir(id);
  const preferred = join(dir, "audio.webm");
  if (existsSync(preferred)) return preferred;
  const other = readdirSync(dir).find(
    (f) => f.startsWith("audio.") && !f.endsWith(".wav") && !f.endsWith(".json")
  );
  if (!other) throw new Error(`no source audio in ${dir}`);
  return join(dir, other);
}
