/**
 * Meeting Recorder — panel routes.
 *
 * Everything is scoped under /dashboard/meeting-recorder-api and behind the
 * dashboard's own auth middleware, so a recording inherits the session the
 * operator already has. Nothing here is public.
 *
 * Audio arrives as a raw body (audio/webm chunks while recording, an arbitrary
 * media file on upload) and is streamed to disk. The gateway's global JSON
 * parser ignores those content types, so the request stream reaches the handler
 * untouched.
 */

import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, openSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Router } from "express";

import { listSessions, newId, readMeta, sessionDir, writeMeta } from "../server/store.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const MAX_CHUNK = 32 * 1024 * 1024;
const MAX_UPLOAD = 4 * 1024 * 1024 * 1024;
const SAFE_SUFFIX = /^\.[a-z0-9]{1,8}$/;

/**
 * The worker lives beside this file in the repo and in the installed copy, so
 * resolve it relative to the panel rather than to any app root.
 */
function workerPath() {
  const installed = join(HERE, "..", "server", "transcribe.js");
  if (existsSync(installed)) return installed;
  return join(HERE, "..", "server", "transcribe.js");
}

function startTranscription(id) {
  const log = openSync(join(sessionDir(id), "transcribe.log"), "a");
  const child = spawn(process.execPath, [workerPath(), id], {
    detached: true,
    stdio: ["ignore", log, log],
    env: process.env,
  });
  child.unref();
}

/** Stream a request body to a file, refusing anything past `cap`. */
function streamToFile(req, path, cap, append = false) {
  return new Promise((resolve, reject) => {
    let written = 0;
    let aborted = false;
    const out = createWriteStream(path, { flags: append ? "a" : "w" });
    req.on("data", (chunk) => {
      written += chunk.length;
      if (written > cap && !aborted) {
        aborted = true;
        out.destroy();
        reject(new Error("too large"));
      }
    });
    req.on("error", reject);
    out.on("error", reject);
    out.on("close", () => (aborted ? undefined : resolve(written)));
    req.pipe(out);
  });
}

export default function meetingRecorderRouter(authMiddleware) {
  const router = Router();
  const base = "/dashboard/meeting-recorder-api";

  // Path-scoped, per the gateway's mount-time check on unpathed middleware.
  router.use(base, authMiddleware);

  router.post(`${base}/session`, (req, res) => {
    const body = req.body || {};
    const id = newId();
    mkdirSync(sessionDir(id), { recursive: true });
    res.json(
      writeMeta(id, {
        id,
        title: String(body.title || "Untitled meeting").slice(0, 200),
        started_at: new Date().toISOString(),
        state: "recording",
        bytes: 0,
        chunks: 0,
        sources: Array.isArray(body.sources) ? body.sources : [],
      })
    );
  });

  router.post(`${base}/chunk`, async (req, res) => {
    const id = String(req.query.id || "");
    let dir;
    try {
      dir = sessionDir(id);
    } catch {
      return res.status(400).json({ error: "bad session id" });
    }
    if (!existsSync(dir)) return res.status(404).json({ error: "unknown session" });
    try {
      const written = await streamToFile(req, join(dir, "audio.webm"), MAX_CHUNK, true);
      const meta = readMeta(id);
      res.json(
        writeMeta(id, {
          bytes: (meta.bytes || 0) + written,
          chunks: (meta.chunks || 0) + 1,
          last_chunk_at: new Date().toISOString(),
        })
      );
    } catch (err) {
      res.status(err.message === "too large" ? 413 : 500).json({ error: err.message });
    }
  });

  router.post(`${base}/finish`, (req, res) => {
    const id = String(req.query.id || "");
    let dir;
    try {
      dir = sessionDir(id);
    } catch {
      return res.status(400).json({ error: "bad session id" });
    }
    if (!existsSync(dir)) return res.status(404).json({ error: "unknown session" });
    const body = req.body || {};
    const meta = writeMeta(id, {
      state: "transcribing",
      ended_at: new Date().toISOString(),
      duration_seconds: Number(body.duration_seconds) || 0,
      notes: String(body.notes || "").slice(0, 4000),
    });
    startTranscription(id);
    res.json(meta);
  });

  // A recording made some other way: a call app's own local recording, a phone
  // voice memo, an old meeting. Same path from here on.
  router.post(`${base}/upload`, async (req, res) => {
    const name = String(req.query.name || "recording");
    const suffix = SAFE_SUFFIX.test(extname(name).toLowerCase())
      ? extname(name).toLowerCase()
      : ".bin";
    const id = newId();
    mkdirSync(sessionDir(id), { recursive: true });
    try {
      const written = await streamToFile(req, join(sessionDir(id), `audio${suffix}`), MAX_UPLOAD);
      const meta = writeMeta(id, {
        id,
        title: String(req.query.title || name).slice(0, 200),
        started_at: new Date().toISOString(),
        ended_at: new Date().toISOString(),
        state: "transcribing",
        bytes: written,
        chunks: 0,
        sources: ["file"],
        original_filename: name.slice(0, 200),
        notes: String(req.query.notes || "").slice(0, 4000),
      });
      startTranscription(id);
      res.json(meta);
    } catch (err) {
      res.status(err.message === "too large" ? 413 : 500).json({ error: err.message });
    }
  });

  router.get(`${base}/status`, (req, res) => {
    try {
      res.json(readMeta(String(req.query.id || "")));
    } catch {
      res.status(400).json({ error: "bad session id" });
    }
  });

  router.get(`${base}/sessions`, (_req, res) => {
    res.json({ sessions: listSessions(25) });
  });

  return router;
}
