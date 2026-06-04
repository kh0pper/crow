#!/usr/bin/env node
// pir-pipeline-score.mjs — mechanical objective checks over captured bench runs.
// Reads results/pir-pipeline/<tag>/<pir>/run*/{meta.json,staging/*} and emits a
// per-run table + per-(tag,pir) pass-rates + speed medians. The count-accuracy
// check (2503540 = 27 no-impact / 8 major; 2502592 = CSV row counts) is the
// headline enumeration metric.

import fs from "node:fs";
import path from "node:path";

const RESULTS = "/home/kh0pp/crow/scripts/bench/results/pir-pipeline";
const TAGS = process.argv.slice(2);
if (!TAGS.length) { console.error("usage: pir-pipeline-score.mjs <tag> [tag...]"); process.exit(1); }

const GT = { "2503540": { no_impact: 27, major: 8 } };

function readText(dir) {
  // combine reply_text (meta) + staging review/reply files for searching
  let t = "";
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
  if (meta.reply_text) t += meta.reply_text + "\n";
  const sdir = path.join(dir, "staging");
  if (fs.existsSync(sdir)) {
    for (const f of fs.readdirSync(sdir)) {
      if (/\.(md|txt|json)$/.test(f)) t += "\n" + fs.readFileSync(path.join(sdir, f), "utf8");
    }
  }
  return { meta, text: t, sdir };
}

function nearInt(text, anchorRe, window = 60) {
  // find an integer within `window` chars before/after a match of anchorRe
  const m = text.match(anchorRe);
  if (!m) return null;
  const i = m.index;
  const seg = text.slice(Math.max(0, i - window), i + window);
  const nums = [...seg.matchAll(/\b(\d{1,3})\b/g)].map((x) => +x[1]).filter((n) => n >= 1 && n <= 99);
  return nums.length ? nums : null;
}

function scoreReply2503540({ meta, text }) {
  const noImpactNums = nearInt(text, /no[- ]?significant|not expected to adversely|significant degree|no[- ]?impact/i, 30) || [];
  const majorNums = nearInt(text, /major[- ]?impact/i, 30) || [];
  // Reframed metric: the harm is FABRICATING a wrong tally; stating nothing is OK.
  const correct = noImpactNums.includes(27) && majorNums.includes(8);
  const statedWrong = (noImpactNums.length && !noImpactNums.includes(27)) || (majorNums.length && !majorNums.includes(8));
  const count_state = correct ? "correct" : (statedWrong ? "WRONG" : "absent");
  const no_hallucinated_count = count_state !== "WRONG";
  const reask = /produce the (?:impact )?notification|confirm in writing that (?:none|tcpa)|still (?:outstanding|missing|unaddressed|a gap)/i.test(text)
    && /tcpa|texas college preparatory|221-?801/i.test(text);
  const tcpa_resolved = /no (?:tec )?§?\s*12\.1101 notifications|qualif\w+ (?:for )?expansion under|no notifications.*tcpa|tcpa.*no notifications|never (?:created|qualified|generated)|did not have expansion/i.test(text);
  const iltexas_confirmed = /(?:confirm|cover).*international leadership|ilt(?:exas)?.*057-?848|057-?848/i.test(text);
  const has_reply = meta.staging_files.includes("correspondence_reply.txt");
  const classification_ok = meta.case_type === "correspondence" && !meta.staging_files.includes("loader.py");
  return {
    count_no_impact: noImpactNums.join("|") || "—", count_major: majorNums.join("|") || "—", count_state,
    no_hallucinated_count, no_reask: !reask, tcpa_resolved, iltexas_confirmed, classification_ok, has_reply,
    pass: no_hallucinated_count && !reask && tcpa_resolved && iltexas_confirmed && classification_ok && has_reply,
  };
}

function scoreReplyGeneric({ meta }) {
  return { classification_ok: meta.case_type === "correspondence" && !meta.staging_files.includes("loader.py"),
    produced_reply: meta.staging_files.includes("correspondence_reply.txt"),
    pass: meta.case_type === "correspondence" && meta.staging_files.includes("correspondence_reply.txt") && meta.exit === 0 };
}

function scoreDelivery({ meta }) {
  const has_loader = meta.staging_files.includes("loader.py");
  const has_counts = meta.staging_files.includes("row_counts.json");
  // loader --dry-run validity is recorded separately during the delivery run
  // (it touches tea_data.db, so it's run under the snapshot guard, not here).
  return { classification_ok: has_loader, has_counts, pass: has_loader && has_counts && meta.exit === 0 };
}

const rows = [];
for (const tag of TAGS) {
  const tagDir = path.join(RESULTS, tag);
  if (!fs.existsSync(tagDir)) continue;
  for (const pir of fs.readdirSync(tagDir)) {
    const pdir = path.join(tagDir, pir);
    if (!fs.statSync(pdir).isDirectory()) continue;
    for (const run of fs.readdirSync(pdir).filter((d) => d.startsWith("run"))) {
      const dir = path.join(pdir, run);
      if (!fs.existsSync(path.join(dir, "meta.json"))) continue;
      const r = readText(dir);
      let sc;
      if (pir === "2503540") sc = scoreReply2503540(r);
      else if (r.meta.case_type === "correspondence") sc = scoreReplyGeneric(r);
      else sc = scoreDelivery(r);
      rows.push({ tag, pir, run, wall_s: r.meta.wall_ms ? +(r.meta.wall_ms / 1000).toFixed(1) : null,
        tok_out: r.meta.tokens_out, gen_tok_s: r.meta.gen_tok_s, exit: r.meta.exit, ...sc });
    }
  }
}

// per-run table
console.log("\n=== PER-RUN ===");
for (const r of rows) {
  console.log(`${r.tag.padEnd(6)} ${r.pir.padEnd(10)} ${r.run.padEnd(5)} pass=${r.pass} ` +
    (r.pir === "2503540" ? `[count=${r.count_state}(ni=${r.count_no_impact},maj=${r.count_major}) no_reask=${r.no_reask} tcpa=${r.tcpa_resolved} ilt=${r.iltexas_confirmed} reply=${r.has_reply}] ` : `[class_ok=${r.classification_ok}] `) +
    `wall=${r.wall_s}s tok_out=${r.tok_out} tok/s=${r.gen_tok_s} exit=${r.exit}`);
}
// per (tag,pir) summary
console.log("\n=== SUMMARY (pass-rate, median tok/s) ===");
const keys = [...new Set(rows.map((r) => `${r.tag}|${r.pir}`))];
for (const k of keys) {
  const g = rows.filter((r) => `${r.tag}|${r.pir}` === k);
  const passes = g.filter((r) => r.pass).length;
  const wrongCounts = g.filter((r) => r.count_state === "WRONG").length;
  const correctCounts = g.filter((r) => r.count_state === "correct").length;
  const toks = g.map((r) => r.gen_tok_s).filter((x) => x != null).sort((a, b) => a - b);
  const medTok = toks.length ? toks[Math.floor(toks.length / 2)] : null;
  const walls = g.map((r) => r.wall_s).filter((x) => x != null).sort((a, b) => a - b);
  const medWall = walls.length ? walls[Math.floor(walls.length / 2)] : null;
  console.log(`${k.padEnd(20)} pass ${passes}/${g.length}` +
    (g[0].pir === "2503540" ? `  count: ${correctCounts} correct / ${wrongCounts} WRONG / ${g.length - correctCounts - wrongCounts} absent` : "") +
    `  median tok/s=${medTok}  median wall=${medWall}s`);
}
