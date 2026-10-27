#!/usr/bin/env node
/**
 * Storage engine copier + verifier CLI (MinIO -> Garage, and the rollback).
 * Engine: servers/storage/engine-copy.js. Plan: the private engineering notes
 * (Garage migration, §5).
 *
 * Credentials come from the environment only, never the command line:
 *   COPY_FROM_ACCESS_KEY / COPY_FROM_SECRET_KEY   for --from
 *   COPY_TO_ACCESS_KEY   / COPY_TO_SECRET_KEY     for --to
 *
 * Commands:
 *   copy     --from URL --to URL (--all | --bucket a,b) --state FILE
 *            [--delta] [--propagate-deletes] [--max-delete-pct 1] [--max-delete-keys 100]
 *            [--concurrency 8] [--dry-run] [--summary FILE]
 *   reverse  --from GARAGE_URL --to MINIO_URL (--all | --bucket a,b) --state FORWARD_STATE
 *            --reverse-state FILE [--max-delete-pct 1] [--max-delete-keys 100] [--dry-run]
 *   verify   --from URL --to URL (--all | --bucket a,b) --state FILE --report FILE
 *            [--checksums BUCKET=FILE ...] [--reread-source] [--concurrency 8]
 *   abort-incomplete --state FILE [--from URL] [--to URL]
 *            aborts exactly the multipart uploads this tool opened and left open
 *            (read from FILE.uploads.jsonl); for the deadman.
 *   check-dir DIR
 *            every regular file's name is the sha256 of its content (artifacts store)
 *
 * reverse ALWAYS carries deletes (MinIO keys missing on Garage are removed,
 * guarded), so a forward copy/delta whose summary has ok=false (failed,
 * refused or delete-refused keys) must block the cutover: fix it first.
 *
 * Exit codes: 0 ok; 1 failures/refusals/verify FAIL; 2 usage; 3 interrupted.
 */
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  makeMinioEndpoint, StateLog, UploadLog, copyAll, reverseAll, verifyAll, abortOpenUploads,
  checkContentAddressedDir, parseChecksums, writeJsonAtomic, DEFAULT_CONCURRENCY, PART_SIZE,
} from "../../servers/storage/engine-copy.js";

const USAGE = readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1).filter((l) => l.startsWith(" *")).map((l) => l.slice(3)).join("\n");

export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const a = { cmd, checksums: [], positional: [] };
  const flags = new Set(["all", "delta", "propagate-deletes", "dry-run", "reread-source", "help"]);
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (!t.startsWith("--")) { a.positional.push(t); continue; }
    const name = t.slice(2);
    if (flags.has(name)) { a[name] = true; continue; }
    const v = rest[++i];
    if (v == null || v.startsWith("--")) throw new Error(`--${name} needs a value`);
    if (name === "checksums") a.checksums.push(v); else a[name] = v;
  }
  return a;
}

function endpoint(side, url, region) {
  if (!url) return null;
  const pfx = side === "from" ? "COPY_FROM" : "COPY_TO";
  return makeMinioEndpoint({ url, accessKey: process.env[`${pfx}_ACCESS_KEY`], secretKey: process.env[`${pfx}_SECRET_KEY`], region });
}

function bucketsArg(a) {
  if (a.all && a.bucket) throw new Error("use --all or --bucket, not both");
  if (a.all) return null;
  if (!a.bucket) throw new Error("--all or --bucket is required");
  return a.bucket.split(",").map((s) => s.trim()).filter(Boolean);
}

const num = (v, d) => (v == null ? d : Number(v));
const log = (m) => console.error(`${new Date().toISOString()} ${m}`);

function trapSignals(ctl) {
  const stop = (sig) => {
    if (ctl.stopped) return;
    log(`${sig}: stopping; aborting in-flight uploads`);
    ctl.stopped = sig;
    for (const b of ctl.bodies) b.destroy(new Error(`stopped by ${sig}`));
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
}

export async function main(argv = process.argv.slice(2)) {
  let a;
  try { a = parseArgs(argv); } catch (e) { console.error(e.message); return 2; }
  if (!a.cmd || a.help || a.cmd === "help") { console.log(USAGE); return a.cmd ? 0 : 2; }
  const region = a.region || "us-east-1";
  const ctl = { stopped: false, bodies: new Set() };
  try {
    if (a.cmd === "check-dir") {
      const dir = a.positional[0];
      if (!dir) throw new Error("check-dir DIR");
      const r = await checkContentAddressedDir(dir);
      console.log(JSON.stringify(r, null, 2));
      return r.ok ? 0 : 1;
    }
    if (!a.state) throw new Error("--state FILE is required");
    if (a.cmd === "abort-incomplete") {
      const r = await abortOpenUploads({ uploads: new UploadLog(`${a.state}.uploads.jsonl`), endpoints: [endpoint("from", a.from, region), endpoint("to", a.to, region)] });
      console.log(JSON.stringify(r, null, 2));
      return r.errors.length ? 1 : 0;
    }
    const src = endpoint("from", a.from, region);
    const dst = endpoint("to", a.to, region);
    if (!src || !dst) throw new Error("--from and --to are required");
    const buckets = bucketsArg(a);
    trapSignals(ctl);
    const common = { src, dst, buckets, concurrency: num(a.concurrency, DEFAULT_CONCURRENCY), ctl, log, maxDeletePct: num(a["max-delete-pct"], undefined), maxDeleteKeys: num(a["max-delete-keys"], undefined), dryRun: !!a["dry-run"] };
    if (a.cmd === "copy" || a.cmd === "reverse") {
      log(`part size ${PART_SIZE / 1048576} MiB x concurrency ${common.concurrency} = buffer cap ${(PART_SIZE * common.concurrency) / 1048576} MiB`);
      let summary;
      if (a.cmd === "copy") {
        const state = new StateLog(a.state);
        const uploads = new UploadLog(`${a.state}.uploads.jsonl`);
        try { summary = await copyAll({ ...common, state, uploads, delta: !!a.delta, propagateDeletes: !!a["propagate-deletes"] }); }
        finally { state.close(); uploads.closeFd(); }
      } else {
        if (!a["reverse-state"]) throw new Error("--reverse-state FILE is required");
        const forwardState = new StateLog(a.state, { readOnly: true });
        const state = new StateLog(a["reverse-state"]);
        const uploads = new UploadLog(`${a["reverse-state"]}.uploads.jsonl`);
        try { summary = await reverseAll({ ...common, forwardState, state, uploads }); }
        finally { state.close(); uploads.closeFd(); }
      }
      if (a.summary) writeJsonAtomic(a.summary, summary);
      console.log(JSON.stringify(summary, null, 2));
      return summary.interrupted ? 3 : summary.ok ? 0 : 1;
    }
    if (a.cmd === "verify") {
      if (!a.report) throw new Error("--report FILE is required");
      const checksums = {};
      for (const spec of a.checksums) {
        const eq = spec.indexOf("=");
        if (eq <= 0) throw new Error(`--checksums BUCKET=FILE, got ${spec}`);
        const bucket = spec.slice(0, eq);
        checksums[bucket] = parseChecksums(readFileSync(spec.slice(eq + 1), "utf8"), spec);
      }
      const state = new StateLog(a.state, { readOnly: true });
      if (state.size === 0) throw new Error(`state file ${a.state} has no records; nothing to verify against`);
      const report = await verifyAll({ ...common, state, checksums, rereadSource: !!a["reread-source"] });
      writeJsonAtomic(a.report, report);
      log(`verify ${report.ok ? "PASSED" : "FAILED"}: ${report.totals.hashed} objects, ${(report.totals.bytes_hashed / 1e9).toFixed(2)} GB hashed, report ${a.report}`);
      return report.interrupted ? 3 : report.ok ? 0 : 1;
    }
    throw new Error(`unknown command ${a.cmd}`);
  } catch (e) {
    console.error(`error: ${e.message}`);
    return /required|needs|unknown command|use --all|--checksums|check-dir DIR/.test(e.message) ? 2 : 1;
  }
}

/** True when argv1 (possibly a symlink or a path needing URL-encoding) is this file. */
export function isMainModule(metaUrl, argv1) {
  if (!argv1) return false;
  try { return pathToFileURL(realpathSync(argv1)).href === metaUrl; } catch { return false; }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main().then((code) => process.exit(code));
}
