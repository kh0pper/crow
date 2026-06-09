#!/usr/bin/env node
// rematch_unmatched.mjs — Re-match files in pir-incoming/_unmatched/ against
// pir_requests using the current matching ladder in ./pir_match.mjs.
//
// Why this exists: sync_pir_responses.mjs labels each Gmail message
// INGESTED-or-FAILED as soon as it has been processed once, so improving the
// matcher does NOT cause prior messages to be re-evaluated on subsequent runs.
// This script reads each _unmatched/<date>_<id>/_meta.txt sidecar, re-applies
// findPirCandidates with the up-to-date regex set and reference_number
// backfills, and on match: moves the files into pir-incoming/<pir_number>/
// and appends an inventory line to status_notes (idempotent — duplicate file
// names get a counter suffix).
//
// Operates entirely on local files + canvas.db — no Gmail access. Does NOT
// create bot_conversations rows for rematched messages; those are an explicit
// next-step decision (re-fetching the message body to thread the digest
// correctly).
//
// Usage:
//   node scripts/bots/rematch_unmatched.mjs            (apply moves)
//   node scripts/bots/rematch_unmatched.mjs --dry-run  (report only, no writes)

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { findPirCandidates } from "./pir_match.mjs";

const CANVAS_DB = "/home/kh0pp/spring-2026/canvas-companion/db/canvas.db";
const SOURCES_ROOT = "/home/kh0pp/spring-2026/insd-5941/sources";
const INCOMING_DIR = path.join(SOURCES_ROOT, "pir-incoming");
const UNMATCHED_DIR = path.join(INCOMING_DIR, "_unmatched");

const DRY_RUN = process.argv.includes("--dry-run");

function parseMeta(metaPath) {
  const text = fs.readFileSync(metaPath, "utf8");
  const out = { subject: "", from: "", threadId: "" };
  for (const line of text.split("\n")) {
    const i = line.indexOf(":");
    if (i < 0) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    const v = line.slice(i + 1).trim();
    if (k === "subject") out.subject = v;
    else if (k === "from") out.from = v;
    else if (k === "threadid" || k === "thread_id") out.threadId = v;
  }
  return out;
}

function extractSenderEmail(fromHeader) {
  const m = fromHeader.match(/<([^>]+)>/);
  return (m ? m[1] : fromHeader).trim().toLowerCase();
}

function formatBytes(n) {
  if (n == null) return "unknown size";
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

function safeFilename(name) {
  return name.replace(/[\x00/\\]/g, "_").slice(0, 240);
}

function moveAttachments({ srcDir, destDir }) {
  fs.mkdirSync(destDir, { recursive: true });
  const moved = [];
  for (const name of fs.readdirSync(srcDir)) {
    if (name === "_meta.txt" || name.startsWith(".")) continue;
    const srcPath = path.join(srcDir, name);
    const stat = fs.statSync(srcPath);
    if (!stat.isFile()) continue;
    const safe = safeFilename(name);
    let destPath = path.join(destDir, safe);
    if (fs.existsSync(destPath)) {
      const ext = path.extname(safe);
      const base = safe.slice(0, safe.length - ext.length);
      for (let i = 1; i < 100; i++) {
        const candidate = path.join(destDir, `${base}-rematch-${i}${ext}`);
        if (!fs.existsSync(candidate)) {
          destPath = candidate;
          break;
        }
      }
    }
    if (DRY_RUN) {
      moved.push({ filename: path.basename(destPath), size: stat.size, path: destPath });
    } else {
      fs.renameSync(srcPath, destPath);
      moved.push({ filename: path.basename(destPath), size: stat.size, path: destPath });
    }
  }
  return moved;
}

function appendInventoryToStatusNotes(canvasDb, { pirId, savedFiles, sourceDate }) {
  if (!savedFiles.length) return;
  const fileList = savedFiles.map((f) => `${f.filename} (${formatBytes(f.size)})`).join(", ");
  const line = `[${sourceDate}] received ${savedFiles.length} attachment${savedFiles.length === 1 ? "" : "s"} (rematched from _unmatched): ${fileList}`;
  if (DRY_RUN) return;
  const row = canvasDb
    .prepare("SELECT status_notes FROM pir_requests WHERE id = ?")
    .get(pirId);
  if (!row) return;
  const next =
    row.status_notes && row.status_notes.trim().length
      ? `${row.status_notes.replace(/\s+$/, "")}\n${line}`
      : line;
  canvasDb
    .prepare("UPDATE pir_requests SET status_notes = ?, updated_at = datetime('now') WHERE id = ?")
    .run(next, pirId);
}

function main() {
  if (!fs.existsSync(UNMATCHED_DIR)) {
    console.error("[rematch] no _unmatched directory; nothing to do");
    return;
  }

  const canvasDb = new Database(CANVAS_DB, { readonly: DRY_RUN });
  canvasDb.pragma("busy_timeout = 5000");

  const dirs = fs
    .readdirSync(UNMATCHED_DIR)
    .map((name) => path.join(UNMATCHED_DIR, name))
    .filter((p) => fs.statSync(p).isDirectory())
    .sort();

  console.error(
    `[rematch] ${DRY_RUN ? "DRY-RUN: " : ""}walking ${dirs.length} unmatched director${dirs.length === 1 ? "y" : "ies"}`,
  );

  let matched = 0;
  let stillUnmatched = 0;
  let missingMeta = 0;
  const remaining = [];
  const matchedSummary = [];

  for (const dir of dirs) {
    const metaPath = path.join(dir, "_meta.txt");
    if (!fs.existsSync(metaPath)) {
      missingMeta++;
      remaining.push({ dir: path.basename(dir), reason: "no _meta.txt" });
      continue;
    }
    const meta = parseMeta(metaPath);
    const senderEmail = extractSenderEmail(meta.from);
    const pirRow = findPirCandidates(canvasDb, {
      subject: meta.subject,
      senderEmail,
    });
    if (!pirRow) {
      stillUnmatched++;
      remaining.push({
        dir: path.basename(dir),
        subject: meta.subject.slice(0, 90),
        from: senderEmail,
      });
      continue;
    }
    matched++;
    const baseName = path.basename(dir);
    const dateMatch = baseName.match(/^(\d{4}-\d{2}-\d{2})/);
    const sourceDate = dateMatch ? dateMatch[1] : new Date().toISOString().slice(0, 10);
    const destDir = path.join(INCOMING_DIR, pirRow.pir_number);
    const movedFiles = moveAttachments({ srcDir: dir, destDir });
    appendInventoryToStatusNotes(canvasDb, {
      pirId: pirRow.id,
      savedFiles: movedFiles,
      sourceDate,
    });
    matchedSummary.push({
      dir: path.basename(dir),
      pir: pirRow.pir_number,
      files: movedFiles.length,
      subject: meta.subject.slice(0, 70),
    });
    // Move _meta.txt with a renamed sidecar so the original dir can be removed
    if (!DRY_RUN) {
      const metaDest = path.join(destDir, `_rematch-meta-${baseName}.txt`);
      fs.renameSync(metaPath, metaDest);
      // Try to remove the now-empty dir
      try {
        fs.rmdirSync(dir);
      } catch {
        // Non-empty (had files we couldn't move) — leave it
      }
    }
  }

  console.error(`\n[rematch] MATCHED ${matched}:`);
  for (const m of matchedSummary) {
    console.error(`  ${m.dir} → ${m.pir} (${m.files} file${m.files === 1 ? "" : "s"}): ${m.subject}`);
  }

  console.error(`\n[rematch] STILL UNMATCHED ${stillUnmatched}:`);
  for (const r of remaining) {
    if (r.reason) {
      console.error(`  ${r.dir}: ${r.reason}`);
    } else {
      console.error(`  ${r.dir}: ${r.from} | ${r.subject}`);
    }
  }

  canvasDb.close();
  console.error(
    `\n[rematch] done: ${matched} matched, ${stillUnmatched} still unmatched, ${missingMeta} missing-meta${DRY_RUN ? " (dry-run, no writes)" : ""}`,
  );
}

main();
