#!/usr/bin/env node
// pir-stage-assert.mjs — per-stage verdicts for the full-flow PIR harness.
//
// Promotes pir-pipeline-score.mjs's mechanical checks into a STAGE x VERDICT
// model. Each stage returns one of:
//   PASS     — the stage did the correct thing (deterministic assert held, or a
//              model output validated against ground truth).
//   ESCALATE — the stage correctly bailed to needs-human (a model output that
//              could not be verified was refused, NOT shipped). Acceptable.
//   FAIL     — the stage was SILENTLY WRONG: a deterministic assert broke, or a
//              wrong model output slipped past the validators. The bar forbids
//              this and only this.
//
// The functions are pure: they take captured artifacts + a golden ref and return
// {stage, verdict, detail}. The harness (pir-fullflow.mjs) gathers the inputs.
//
// Golden ref provenance (review S5): `counts`/`case_type`/`attachments` are
// human-verified ground truth (independently computed); never assert the bot
// reproduces its own prior output as "correct".

import fs from "node:fs";
import path from "node:path";

export const PASS = "PASS";
export const ESCALATE = "ESCALATE";
export const FAIL = "FAIL";

function v(stage, verdict, detail) { return { stage, verdict, detail }; }
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } }
function readText(p) { try { return fs.readFileSync(p, "utf8"); } catch { return ""; } }

// Recursively collect numeric values from a JSON value (claims.json). Mirrors
// dispatch_pir_processor.mjs collectNumbers so the harness gate matches prod.
export function collectNumbers(val, out = []) {
  if (typeof val === "number") out.push(val);
  else if (Array.isArray(val)) val.forEach((x) => collectNumbers(x, out));
  else if (val && typeof val === "object") Object.values(val).forEach((x) => collectNumbers(x, out));
  return out;
}

// The set of numeric tallies a reply may legitimately state, flattened from
// computed_facts. Mirrors dispatch_pir_processor.mjs verifiedCounts EXACTLY so
// the harness reproduces the production gate (not a looser copy).
export function verifiedCounts(facts) {
  const s = new Set();
  if (!facts) return s;
  if (typeof facts.csv_row_total === "number") s.add(facts.csv_row_total);
  for (const f of facts.files || []) {
    if (typeof f.rows === "number") s.add(f.rows);
    const pl = f.pdf_list;
    if (pl && !pl.unparseable) {
      if (typeof pl.bullet_total === "number") s.add(pl.bullet_total);
      for (const x of Object.values(pl.labeled_counts || {})) s.add(x);
      for (const sec of pl.sections || []) if (typeof sec.count === "number") s.add(sec.count);
    }
  }
  return s;
}

// Soft prose count detector (mirrors dispatch proseCountNumbers). NOT a gate —
// used only as a warning surface.
export function proseCountNumbers(text) {
  const out = [];
  const re = /(\d{1,4})\s*(?:districts?|charters?|entit\w+|campuses|records?|rows|no[- ]?significant|major[- ]?impact|no[- ]?impact)/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const n = +m[1];
    const pre = text.slice(Math.max(0, m.index - 12), m.index);
    if (/[§$#]/.test(pre.slice(-2))) continue;          // §12, $5, #3
    if (/generation\s*$/i.test(pre)) continue;          // "Generation 17" cohort id, not a tally
    if (n >= 1900 && n <= 2100) continue;               // years
    if (n >= 1 && n <= 99999) out.push(n);
  }
  return out;
}

// Impact-tally numbers: a number stated in the SPECIFIC fabrication context that
// the count gate exists to catch — "<n> districts/charters ... (no significant |
// major) impact", or the reverse order. Tight context + Generation-cohort and
// §/$/year exclusions keep this from firing on quoted cohort ids (the S3 trap).
export function impactTallyNumbers(text) {
  const out = new Set();
  const IMPACT = "(?:no[- ]?significant(?:ly)?|not expected to adversely|significant degree|major[- ]?impact|no[- ]?impact)";
  const NOUN = "(?:districts?|charters?|entit\\w+|campuses|schools?)";
  const pats = [
    new RegExp(`(\\d{1,4})\\s+(?:${NOUN}[^.]{0,40}?)?${IMPACT}`, "gi"),  // 27 districts ... no significant impact
    new RegExp(`${IMPACT}[^.]{0,40}?(\\d{1,4})\\b`, "gi"),               // major impact ... 8
  ];
  for (const re of pats) {
    let m;
    while ((m = re.exec(text)) !== null) {
      const n = +m[1];
      const idx = m.index + m[0].indexOf(m[1]);
      const pre = text.slice(Math.max(0, idx - 12), idx);
      if (/generation\s*$/i.test(pre)) continue;
      if (/[§$#]/.test(pre.slice(-2))) continue;
      if (n >= 1900 && n <= 2100) continue;
      if (n >= 1 && n <= 99999) out.add(n);
    }
  }
  return [...out];
}

// ── INGEST ────────────────────────────────────────────────────────────────
// Deterministic. `replay` is the result of sync's ingestReplay(fixtureMsg).
// Asserts case_type, attachment filenames, and a non-empty body against golden.
export function assertIngest({ golden, replay }) {
  if (!replay) return v("ingest", FAIL, "no ingest replay result (fixture missing/unparseable)");
  const fails = [];
  if (golden.case_type && replay.caseType !== golden.case_type) {
    fails.push(`case_type ${replay.caseType} != golden ${golden.case_type}`);
  }
  if (Array.isArray(golden.attachments)) {
    const got = replay.attachments.map((a) => a.filename).sort();
    const want = [...golden.attachments].sort();
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      fails.push(`attachments ${JSON.stringify(got)} != golden ${JSON.stringify(want)}`);
    }
  }
  if (golden.body_required !== false && !(replay.body && replay.body.trim())) {
    fails.push("body empty (expected a cover-letter body)");
  }
  for (const sub of golden.body_contains || []) {
    if (!(replay.body || "").includes(sub)) fails.push(`body missing substring ${JSON.stringify(sub)}`);
  }
  return fails.length ? v("ingest", FAIL, fails.join("; "))
    : v("ingest", PASS, `case_type=${replay.caseType} attachments=${replay.attachments.length}`);
}

// ── DISPATCH + BOT ──────────────────────────────────────────────────────────
// The bot must produce the staging artifacts for its case_type and exit usably.
// Missing required artifacts => FAIL (the run produced nothing reviewable). A
// bridge non-zero exit alone is NOT a fail if staging is complete (matches the
// dispatcher's "exited non-zero but staging valid — proceeding").
export function assertBot({ golden, stagingDir, botResult }) {
  if (!fs.existsSync(stagingDir)) return v("bot", FAIL, `no staging dir at ${stagingDir}`);
  const isReply = golden.close && golden.close.type === "reply";
  const required = isReply
    ? ["correspondence_reply.txt", "review_email.md"]
    : ["loader.py", "row_counts.json", "source_inventory.json", "README.md"];
  // review_email.md has an alias gateway_review.md
  const present = (name) => {
    if (fs.existsSync(path.join(stagingDir, name))) return true;
    if (name === "review_email.md") return fs.existsSync(path.join(stagingDir, "gateway_review.md"));
    return false;
  };
  const missing = required.filter((n) => !present(n));
  // claims.json is MANDATORY for every case after the lock-in (even {}).
  const claimsPresent = fs.existsSync(path.join(stagingDir, "claims.json"));
  if (missing.length) return v("bot", FAIL, `missing staging artifacts: ${missing.join(", ")}`);
  const detail = `artifacts ok${claimsPresent ? "" : " (claims.json ABSENT)"}` +
    (botResult && botResult.action ? ` action=${botResult.action}` : "");
  // Absent claims.json is not by itself a FAIL here (the VALIDATE stage decides
  // whether an unverifiable count slipped); surface it in the detail.
  return v("bot", PASS, detail);
}

// ── VALIDATE (the count gate) ────────────────────────────────────────────────
// The headline correctness stage. Reproduces the production validateClaims gate
// and adds the golden cross-check:
//   - every stated tally (claims.json, exact) must be a verified count -> else
//     the production gate ESCALATEs (acceptable, not wrong).
//   - a WRONG count that slips past the gate (claims absent, prose states a
//     number that contradicts golden) -> FAIL (silently wrong).
//   - correct/omitted -> PASS.
export function assertValidate({ golden, stagingDir, computedFacts }) {
  const verified = verifiedCounts(computedFacts);
  const goldenVerified = new Set([...(golden.counts && golden.counts.verified_set || []), ...verified]);
  const claimsPath = path.join(stagingDir, "claims.json");
  const proseFiles = ["review_email.md", "correspondence_reply.txt", "draft_acknowledgment.txt", "gateway_review.md"];
  const prose = proseFiles.map((n) => readText(path.join(stagingDir, n))).join("\n");
  const claims = fs.existsSync(claimsPath) ? readJson(claimsPath) : undefined;
  const claimNums = new Set(claims && claims !== null ? collectNumbers(claims) : []);

  // 1) Structured gate (exact), reproducing production validateClaims: any number
  //    DECLARED in claims.json that is not a verified count -> ESCALATE (the bot
  //    is refused, never shipped). This is correct-or-escalate, NOT a failure.
  if (claims === null) return v("validate", ESCALATE, "claims.json unparseable -> production gate escalates");
  for (const n of claimNums) {
    if (!goldenVerified.has(n)) {
      return v("validate", ESCALATE, `claims.json states ${n} not in verified set {${[...goldenVerified].join(",")}} -> gate escalates (needs-human)`);
    }
  }

  // 2) Silent-wrong detection (the only FAIL): a fabricated impact tally stated
  //    in PROSE that bypassed claims.json, so the structured gate never saw it.
  //    Tight impact-tally context + Generation/§/year exclusions avoid the S3
  //    false-positive on quoted cohort ids.
  const impactNums = impactTallyNumbers(prose);
  for (const n of impactNums) {
    if (!goldenVerified.has(n) && !claimNums.has(n)) {
      return v("validate", FAIL, `prose states impact tally ${n} (not verified, absent from claims.json) -> silently wrong, gate bypassed`);
    }
  }

  // 3) Optional: if golden requires the correct tally to be PRESENT, note when
  //    the bot declined to state it (acceptable under correct-or-escalate).
  if (golden.counts && golden.counts.require_present) {
    for (const want of golden.counts.require_present) {
      if (!claimNums.has(want) && !impactNums.includes(want)) {
        return v("validate", PASS, `correct count ${want} omitted (declined to state) — acceptable; claims=${[...claimNums].join(",") || "{}"}`);
      }
    }
  }
  const claimsState = claims === undefined ? "absent" : (Object.keys(claims).length ? `{${[...claimNums].join(",")}}` : "{}");
  return v("validate", PASS, `gate clean; claims=${claimsState}; impact_nums=[${impactNums.join(",")}]`);
}

// ── APPROVE -> CLOSE ─────────────────────────────────────────────────────────
// After the APPROVE turn:
//   delivery -> loader committed the golden grand_total rows to the TEA_DB copy
//               AND the tracker row is status=received / lease=done.
//   reply    -> a reply payload is staged (send stubbed) AND lease=done.
// dbRowAfter is the post-APPROVE pir_requests row from the SANDBOX canvas copy.
// teaCommittedRows is the harness's count of rows the loader wrote to TEA_DB copy.
export function assertClose({ golden, stagingDir, dbRowAfter, teaCommittedRows }) {
  const close = golden.close || {};
  const fails = [];
  if (close.type === "delivery") {
    if (typeof close.grand_total === "number") {
      if (teaCommittedRows == null) fails.push("could not read committed row total from TEA_DB copy");
      else if (teaCommittedRows !== close.grand_total) fails.push(`committed ${teaCommittedRows} rows != golden ${close.grand_total}`);
    }
    if (close.final_status && dbRowAfter && dbRowAfter.status !== close.final_status) {
      fails.push(`status ${dbRowAfter && dbRowAfter.status} != golden ${close.final_status}`);
    }
  } else if (close.type === "reply") {
    const replyFiles = close.expect_files || ["correspondence_reply.txt"];
    const haveReply = replyFiles.some((n) => fs.existsSync(path.join(stagingDir, n)) || fs.existsSync(path.join(stagingDir, "approved_reply.txt")));
    if (!haveReply) fails.push(`no staged reply payload (${replyFiles.join("/")})`);
  }
  const wantLease = close.final_lease_status || "done";
  if (dbRowAfter && dbRowAfter.processing_lease_status !== wantLease) {
    fails.push(`lease_status ${dbRowAfter && dbRowAfter.processing_lease_status} != ${wantLease}`);
  }
  return fails.length ? v("close", FAIL, fails.join("; "))
    : v("close", PASS, close.type === "delivery" ? `committed ${teaCommittedRows} rows, status=${dbRowAfter && dbRowAfter.status}` : `reply staged, lease=${dbRowAfter && dbRowAfter.processing_lease_status}`);
}

// Collapse a list of stage verdicts into a run-level verdict: FAIL if any FAIL,
// else ESCALATE if any ESCALATE, else PASS.
export function rollup(stages) {
  if (stages.some((s) => s.verdict === FAIL)) return FAIL;
  if (stages.some((s) => s.verdict === ESCALATE)) return ESCALATE;
  return PASS;
}
