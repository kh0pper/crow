#!/usr/bin/env node
// sync_edjobs_to_candidates.mjs — Phase 8.1 Pathway A
//
// Pulls active job_postings from the ed-jobs-scraper postgres (via docker exec
// to the edjobs_postgres container) and upserts them into job_candidates in
// MPA's crow.db. Idempotent. Scheduled via systemd timer every 30 min.
//
// Runs on crow. Requires:
//   - docker daemon reachable (kh0pp in docker group)
//   - edjobs_postgres container running
//   - MPA's crow.db at /home/kh0pp/.crow-mpa/data/crow.db with job_candidates table
//
// Exit codes: 0 success, 1 setup/connectivity error, 2 batch failure.

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import Database from "better-sqlite3";

const MPA_DB = "/home/kh0pp/.crow-mpa/data/crow.db";
const PG_CONTAINER = "edjobs_postgres";
const PG_USER = "edjobs_user";
const PG_DB = "edjobs";

// COPY (...) TO STDOUT WITH CSV emits RFC4180-style CSV that handles
// embedded newlines/tabs/commas inside descriptions.
const PG_COPY = `
  COPY (
    SELECT
      jp.id::text                     AS job_id,
      jp.title,
      jp.application_url              AS url,
      COALESCE(jp.location, '')       AS location,
      COALESCE(jp.city, '')           AS city,
      COALESCE(jp.state, '')          AS state,
      jp.salary_min,
      jp.salary_max,
      COALESCE(jp.salary_text, '')    AS salary_text,
      jp.posting_date,
      jp.first_seen_at,
      jp.last_seen_at,
      jp.is_active,
      COALESCE(jp.description, '')    AS description,
      jp.platform,
      COALESCE(jp.category, '')       AS category,
      COALESCE(jp.raw_category, '')   AS raw_category,
      COALESCE(jp.department, '')     AS department,
      COALESCE(jp.employment_type, '') AS employment_type,
      o.name                          AS employer,
      COALESCE(o.org_type, '')        AS org_type
    FROM job_postings jp
    JOIN organizations o ON o.id = jp.organization_id
    WHERE jp.is_active = true
  ) TO STDOUT WITH CSV
`;

function normalize(s) {
  return (s ?? "").toString().trim().toLowerCase().replace(/\s+/g, " ");
}

function candidateId(employer, title, url) {
  return crypto
    .createHash("sha256")
    .update(`${normalize(employer)}|${normalize(title)}|${normalize(url)}`)
    .digest("hex");
}

// Incremental RFC4180 CSV parser. feed(chunk) is called with successive
// string chunks off the psql stdout stream and invokes onRow(cols) for every
// COMPLETE record; end() flushes a trailing record. Quoted fields may contain
// embedded commas/newlines and "" escapes, and any of those may straddle a
// chunk boundary — the quoteHold flag defers the escape decision to the next
// chunk. Replaces the old buffer-the-whole-result parser that OOM'd node's
// ~4GB heap on the 27k-row / ~150MB dump (three full in-memory copies + rope
// garbage from char-by-char field concatenation).
function makeCsvStreamer(onRow) {
  let row = [];
  let field = "";
  let inQuotes = false;
  let quoteHold = false; // saw a '"' while inQuotes; awaiting next char to disambiguate
  return {
    feed(chunk) {
      for (let i = 0; i < chunk.length; i++) {
        const c = chunk[i];
        if (quoteHold) {
          quoteHold = false;
          if (c === '"') {
            field += '"'; // escaped quote ("")
            continue;
          }
          inQuotes = false; // the earlier '"' closed the quoted field; fall through
        }
        if (inQuotes) {
          if (c === '"') quoteHold = true;
          else field += c;
        } else if (c === '"') {
          inQuotes = true;
        } else if (c === ",") {
          row.push(field);
          field = "";
        } else if (c === "\n") {
          row.push(field);
          onRow(row);
          row = [];
          field = "";
        } else if (c !== "\r") {
          field += c;
        }
      }
    },
    end() {
      if (quoteHold) {
        quoteHold = false;
        inQuotes = false;
      }
      if (field !== "" || row.length > 0) {
        row.push(field);
        onRow(row);
        row = [];
        field = "";
      }
    },
  };
}

function rowToObj(cols) {
  if (cols.length < 21) return null;
  return {
    job_id: cols[0],
    title: cols[1],
    url: cols[2],
    location: cols[3],
    city: cols[4],
    state: cols[5],
    salary_min: cols[6] === "" ? null : Number(cols[6]),
    salary_max: cols[7] === "" ? null : Number(cols[7]),
    salary_text: cols[8],
    posting_date: cols[9],
    first_seen_at: cols[10],
    last_seen_at: cols[11],
    is_active: cols[12] === "t",
    description: cols[13],
    platform: cols[14],
    category: cols[15],
    raw_category: cols[16],
    department: cols[17],
    employment_type: cols[18],
    employer: cols[19],
    org_type: cols[20],
  };
}

function locationStr(r) {
  if (r.location) return r.location;
  if (r.city && r.state) return `${r.city}, ${r.state}`;
  if (r.city) return r.city;
  if (r.state) return r.state;
  return "";
}

function isRemote(r) {
  const blob = `${r.location} ${r.title} ${r.description}`.toLowerCase();
  if (/\bremote\b|work[-\s]from[-\s]home|telecommut/i.test(blob)) return 1;
  return 0;
}

// K-12 noise titles the scout would reject anyway. Mirrors the scout agent's
// title_excludes list in presets.js bot-job-search systemPrompt. Skip-on-insert
// reduces the 'new' backlog so each tick scores fresher rows. If the agent's
// exclude list changes, update this list to match.
const TITLE_EXCLUDES = [
  "teacher", "paraprofessional", "coach", "bus driver", "cafeteria",
  "janitor", "custodian", "maintenance", "aide", "secretary",
  "clerk", "substitute", "nurse", "food service", "cook", "librarian",
];

function isNoise(title) {
  const t = (title || "").toLowerCase();
  return TITLE_EXCLUDES.some((kw) => t.includes(kw));
}

const DRY_RUN = process.argv.includes("--dry-run");

function main() {
  console.error(`[sync-edjobs] starting at ${new Date().toISOString()}${DRY_RUN ? " (DRY RUN — no writes)" : ""}`);

  const db = new Database(MPA_DB, DRY_RUN ? { readonly: true } : {});
  // crow.db is owned by the live crow-mpa gateway in WAL mode. Do NOT force a
  // journal_mode flip — that needs an exclusive lock the gateway holds and
  // throws "database is locked" (the old `journal_mode = DELETE` line; it only
  // never fired because the fetch OOM'd first). WAL already lets a secondary
  // writer coexist; just wait politely for the single write lock.
  db.pragma("busy_timeout = 10000");

  const upsert = DRY_RUN
    ? null
    : db.prepare(`
    INSERT INTO job_candidates
      (id, source, source_ref, employer, title, url, location, remote,
       salary_min, salary_max, posted_at, description, raw_payload,
       status, created_at, updated_at)
    VALUES
      (@id, 'ed-jobs-scraper', @source_ref, @employer, @title, @url, @location, @remote,
       @salary_min, @salary_max, @posted_at, @description, @raw_payload,
       'new', datetime('now'), datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      source_ref   = excluded.source_ref,
      employer     = excluded.employer,
      title        = excluded.title,
      url          = excluded.url,
      location     = excluded.location,
      remote       = excluded.remote,
      salary_min   = excluded.salary_min,
      salary_max   = excluded.salary_max,
      posted_at    = excluded.posted_at,
      description  = excluded.description,
      raw_payload  = excluded.raw_payload,
      updated_at   = datetime('now')
  `);

  const before = db.prepare("SELECT COUNT(*) AS c FROM job_candidates WHERE source = 'ed-jobs-scraper'").get().c;

  let filtered = 0;
  let fetched = 0;

  // Stream rows off psql and upsert in bounded batches so peak memory is a few
  // thousand rows, never the whole 27k-row dump.
  const BATCH_SIZE = 2000;
  let batch = [];

  const flush = DRY_RUN
    ? () => {}
    : db.transaction((rows) => {
        for (const r of rows) {
          if (isNoise(r.title)) {
            filtered++;
            continue;
          }
          const id = candidateId(r.employer, r.title, r.url);
          const payload = {
            platform: r.platform,
            category: r.category,
            raw_category: r.raw_category,
            department: r.department,
            employment_type: r.employment_type,
            org_type: r.org_type,
            city: r.city,
            state: r.state,
            salary_text: r.salary_text,
            first_seen_at: r.first_seen_at,
            last_seen_at: r.last_seen_at,
          };
          upsert.run({
            id,
            source_ref: r.job_id,
            employer: r.employer,
            title: r.title,
            url: r.url,
            location: locationStr(r),
            remote: isRemote(r),
            salary_min: r.salary_min,
            salary_max: r.salary_max,
            posted_at: r.posting_date || null,
            description: (r.description || "").slice(0, 8000) || null,
            raw_payload: JSON.stringify(payload),
          });
        }
      });

  // In dry-run, still count noise so the summary matches a real run.
  const drain = (rows) => {
    if (DRY_RUN) {
      for (const r of rows) if (isNoise(r.title)) filtered++;
      return;
    }
    flush(rows);
  };

  const streamer = makeCsvStreamer((cols) => {
    const r = rowToObj(cols);
    if (!r) return;
    fetched++;
    batch.push(r);
    if (batch.length >= BATCH_SIZE) {
      drain(batch);
      batch = [];
    }
  });

  const child = spawn(
    "docker",
    ["exec", "-i", PG_CONTAINER, "psql", "-U", PG_USER, "-d", PG_DB, "-q", "-c", PG_COPY],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => streamer.feed(chunk));
  child.stderr.on("data", (d) => {
    stderr += d;
  });

  child.on("error", (err) => {
    console.error(`[sync-edjobs] failed to spawn docker: ${err.message}`);
    db.close();
    process.exit(1);
  });

  child.on("close", (code) => {
    if (code !== 0) {
      console.error(`[sync-edjobs] postgres fetch failed (psql exit ${code}): ${stderr.trim()}`);
      db.close();
      process.exit(1);
    }
    try {
      streamer.end();
      if (batch.length) {
        drain(batch);
        batch = [];
      }
    } catch (err) {
      console.error(`[sync-edjobs] transaction failed: ${err.message}`);
      db.close();
      process.exit(2);
    }
    console.error(`[sync-edjobs] fetched ${fetched} active postings from edjobs postgres`);
    const after = db.prepare("SELECT COUNT(*) AS c FROM job_candidates WHERE source = 'ed-jobs-scraper'").get().c;
    const inserted = after - before;
    const updated = fetched - inserted - filtered;
    console.error(
      `[sync-edjobs] done: ${inserted} new, ${updated} updated, ${filtered} filtered (noise), ${after} total ed-jobs candidates`,
    );
    db.close();
  });
}

main();
