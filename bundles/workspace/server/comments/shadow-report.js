/**
 * Comment loop Phase 1 exit criteria (spec I-7): scores the shadow-mode event log. Read-only; never prints comment
 * text (the only strings it surfaces are the <=40-char snippets already in the events, for oldWouldFire).
 *
 * Counting rules: several editor tabs each log their own live_report and live verdict for one comment, so every
 * count of comments is by distinct (file_id, fp); pairs and fpMatchPct are by distinct pair.
 *
 * CLI: node shadow-report.js [--days N]   (default 7) prints the report as JSON.
 */
import { fileURLToPath } from "node:url";
import { EVENT_KINDS } from "./store.js";
import { VERDICT_REASONS } from "./identity.js";

const K = Object.fromEntries(EVENT_KINDS.map((k) => [k, k]));
const [LIVE, SAVED] = ["live", "saved"];
const DAY = 86400000;
const OLD_AGE_S = 600;
const EXIT = Object.freeze({ pairs: 30, fpMatchPct: 99, p95Ms: 3000 });

const parse = (s) => { try { return JSON.parse(s) ?? {}; } catch { return {}; } };
const fpKey = (e) => `${e.fileId}\u0000${e.d.fp}`;

/** Nearest-rank percentile of an ascending array. */
function pct(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

export async function shadowReport(db, { sinceMs = 0, nowMs = Date.now() } = {}) {
  const rows = (await db.execute({
    sql: "SELECT id, at, file_id, kind, detail_json FROM workspace_comment_events WHERE at >= ? AND at <= ? ORDER BY at, id",
    args: [sinceMs, nowMs],
  })).rows;
  const ev = rows.map((r) => ({ at: Number(r.at), fileId: r.file_id, kind: r.kind, d: parse(r.detail_json) }));

  // pairs: distinct pair values with both a live_report and a scan_new
  const livePairs = new Map(), savedPairs = new Map();
  const add = (m, k, v) => { if (!m.has(k)) m.set(k, new Set()); m.get(k).add(v); };
  let liveReports = 0, unresolvedKeys = 0;
  for (const e of ev) {
    if (e.kind === K.live_report) { liveReports++; if (e.d.pair) add(livePairs, e.d.pair, e.d.fp); }
    else if (e.kind === K.scan_new && e.d.source === SAVED && e.d.pair) add(savedPairs, e.d.pair, e.d.fp);
    else if (e.kind === K.unresolved_key) unresolvedKeys++;
  }
  let pairs = 0, matched = 0;
  for (const [pair, liveFps] of livePairs) {
    const savedFps = savedPairs.get(pair);
    if (!savedFps) continue;
    pairs++;
    // a match needs one live fp (all tabs agree) equal to the saved fp
    if (liveFps.size === 1 && savedFps.size === 1 && [...liveFps][0] === [...savedFps][0]) matched++;
  }
  const fpMatchPct = pairs ? (matched / pairs) * 100 : null;

  // would_fire: saved-side refires, live fan-out (info only), old ones for review
  const firedSaved = new Set(), liveFired = new Map();
  let refires = 0;
  const oldSeen = new Set(), oldWouldFire = [];
  for (const e of ev) {
    if (e.kind !== K.would_fire) continue;
    const key = fpKey(e);
    if (e.d.source === SAVED) {
      if (firedSaved.has(key)) refires++; else firedSaved.add(key);
    } else if (e.d.source === LIVE) {
      liveFired.set(key, (liveFired.get(key) ?? 0) + 1);
    }
    if (Number(e.d.age_s) > OLD_AGE_S) {
      const k = `${key}\u0000${e.d.source}`;
      if (!oldSeen.has(k)) { oldSeen.add(k); oldWouldFire.push({ fileId: e.fileId, source: e.d.source, age_s: e.d.age_s, snippet: e.d.snippet ?? null, reason: e.d.reason ?? null }); }
    }
  }
  let liveDuplicateFanout = 0;
  for (const n of liveFired.values()) liveDuplicateFanout += n - 1;

  // unverified share among sole verdicts, distinct (file_id, fp, source), date_unknown excluded
  const sole = { [K.unverified]: new Set(), [K.would_fire]: new Set() };
  for (const e of ev) {
    if (!(e.kind in sole) || e.d.sole !== true || e.d.reason === VERDICT_REASONS.DATE_UNKNOWN) continue;
    sole[e.kind].add(`${fpKey(e)}\u0000${e.d.source}`);
  }
  const denom = sole[K.unverified].size + sole[K.would_fire].size;
  const unverifiedSoleRate = denom ? sole[K.unverified].size / denom : null;

  // latency: live_report kind=add, earliest report per distinct (file_id, fp)
  const lat = new Map();
  for (const e of ev) {
    if (e.kind !== K.live_report || typeof e.d.latency_ms !== "number" || !Number.isFinite(e.d.latency_ms)) continue;
    const k = fpKey(e);
    if (!lat.has(k)) lat.set(k, e.d.latency_ms);
  }
  const sorted = [...lat.values()].sort((a, b) => a - b);
  const latency = { p50: pct(sorted, 50), p95: pct(sorted, 95), max: sorted.length ? sorted[sorted.length - 1] : null };

  return {
    pairs, fpMatchPct, refires, liveDuplicateFanout, oldWouldFire, unverifiedSoleRate, latency, liveReports, unresolvedKeys,
    exit: {
      pairs: pairs >= EXIT.pairs,
      fpMatch: fpMatchPct !== null && fpMatchPct >= EXIT.fpMatchPct,
      reopen: refires === 0,
      latency: latency.p95 !== null && latency.p95 <= EXIT.p95Ms,
      liveReport: liveReports > 0,
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const i = process.argv.indexOf("--days");
  const days = i > 0 ? Number(process.argv[i + 1]) : 7;
  if (!(days > 0)) { console.error("usage: shadow-report.js [--days N]"); process.exit(2); }
  const { openWorkspaceDb } = await import("../db.js");
  const db = await openWorkspaceDb();
  const nowMs = Date.now();
  console.log(JSON.stringify(await shadowReport(db, { sinceMs: nowMs - days * DAY, nowMs }), null, 2));
  process.exit(0);
}
