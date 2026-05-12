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

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import Database from "/home/kh0pp/crow/node_modules/better-sqlite3/lib/index.js";

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

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else {
      if (c === '"') {
        inQuotes = true;
      } else if (c === ",") {
        row.push(field);
        field = "";
      } else if (c === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      } else if (c === "\r") {
        // skip carriage returns
      } else {
        field += c;
      }
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function pgFetch() {
  const out = execFileSync(
    "docker",
    [
      "exec",
      "-i",
      PG_CONTAINER,
      "psql",
      "-U",
      PG_USER,
      "-d",
      PG_DB,
      "-q",
      "-c",
      PG_COPY,
    ],
    { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 },
  );
  const rows = [];
  for (const cols of parseCsv(out)) {
    if (cols.length < 21) continue;
    rows.push({
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
    });
  }
  return rows;
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

function main() {
  console.error(`[sync-edjobs] starting at ${new Date().toISOString()}`);

  let rows;
  try {
    rows = pgFetch();
  } catch (err) {
    console.error(`[sync-edjobs] postgres fetch failed: ${err.message}`);
    process.exit(1);
  }
  console.error(`[sync-edjobs] fetched ${rows.length} active postings from edjobs postgres`);

  const db = new Database(MPA_DB);
  db.pragma("journal_mode = DELETE");
  db.pragma("busy_timeout = 5000");

  const upsert = db.prepare(`
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

  const tx = db.transaction((batch) => {
    for (const r of batch) {
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

  try {
    tx(rows);
  } catch (err) {
    console.error(`[sync-edjobs] transaction failed: ${err.message}`);
    db.close();
    process.exit(2);
  }

  const after = db.prepare("SELECT COUNT(*) AS c FROM job_candidates WHERE source = 'ed-jobs-scraper'").get().c;
  const inserted = after - before;
  const updated = rows.length - inserted;
  console.error(`[sync-edjobs] done: ${inserted} new, ${updated} updated, ${after} total ed-jobs candidates`);

  db.close();
}

main();
