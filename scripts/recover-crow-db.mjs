#!/usr/bin/env node
/**
 * Scripted crow.db corruption recovery.
 *
 * Productizes the hand-built 2026-07-02 manual recovery (job fef5d308) into a
 * single, gated, one-command tool: `npm run recover-db`.
 *
 * What it does (OFFLINE only — never against a live gateway):
 *   1. LIVENESS GATE — refuses to run unless the DB file (and its -wal/-shm
 *      sidecars) have NO open handles (lsof/fuser). pi-bots bot_jobs IPC, the
 *      WAL keeper, and other same-host instances all open crow.db, so a TCP
 *      port check is NOT sufficient (review C3). Override with --force.
 *   2. BACKUP — copies the corrupt db (+ -wal/-shm) to <db>.CORRUPT-<ts>.
 *   3. FRESH SCHEMA — builds an empty, current schema into a temp file by
 *      running the in-repo `scripts/init-db.js` with CROW_DB_PATH=<temp>.
 *   4. SALVAGE — ATTACHes the corrupt backup and INSERT-OR-REPLACE-copies every
 *      readable base table (shared columns only, to survive schema drift).
 *        - crow_instances is COPIED when its per-table SELECT succeeds (it is
 *          the peer-auth trust anchor — dropping it blacks out federation until
 *          every peer re-enrolls, review C4). It is SKIPPED only if the SELECT
 *          throws malformed.
 *        - cross_host_calls (expendable audit) and mcp_sessions (ephemeral) are
 *          always skipped.
 *   5. FTS REBUILD — `INSERT INTO fts(fts) VALUES('rebuild')` for each FTS
 *      virtual table.
 *   6. TOKEN RE-INJECT — re-writes sha256(CROW_LOCAL_MCP_TOKEN) so headless MCP
 *      clients keep working, and validates it.
 *   7. TWO SWAP GATES — (a) PRAGMA integrity_check MUST be 'ok'; (b) per-table
 *      row-count completeness (every readable source table's count must equal
 *      the copied count). Any shortfall → LOUD diff + ABORT, no swap.
 *   8. SWAP — atomically renames the rebuilt file over <db>, removes stale
 *      -wal/-shm. Prints the full runbook, every row count, and (if
 *      crow_instances had to be skipped) a LOUD re-enroll warning.
 *
 * Flags:
 *   --db <path>   DB to recover (default ~/.crow/data/crow.db)
 *   --force       bypass the liveness gate (you asserted the gateway is stopped)
 *   --dry-run     do everything EXCEPT the swap; leaves the rebuilt temp file
 *                 in place for inspection and never touches the original.
 *
 * See docs/developers/db-recovery.md.
 */

import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync, copyFileSync, renameSync, rmSync, readFileSync, mkdtempSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// arg parsing
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { db: null, force: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--db") out.db = argv[++i];
    else if (a === "--force") out.force = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "-h" || a === "--help") out.help = true;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log("Usage: node scripts/recover-crow-db.mjs [--db <path>] [--force] [--dry-run]");
  process.exit(0);
}

const DB = resolve(args.db || join(homedir(), ".crow", "data", "crow.db"));
// A CLI script may use new Date() directly (per Task 3 note).
const TS = new Date().toISOString().replace(/[:.]/g, "-");

function log(...a) { console.log(...a); }
function bail(msg, code = 1) {
  console.error("\n❌ ABORT:", msg);
  process.exit(code);
}

log("=== crow.db recovery ===");
log("db:      ", DB);
log("mode:    ", args.dryRun ? "DRY-RUN (no swap)" : "LIVE (will swap on pass)");
log("force:   ", args.force);
log("");

if (!existsSync(DB)) bail(`DB not found: ${DB}`);

// ---------------------------------------------------------------------------
// 1. LIVENESS GATE — no open handles on db / -wal / -shm (review C3)
// ---------------------------------------------------------------------------
function openHandles(path) {
  // Prefer lsof; fall back to fuser. Return list of "pid command" strings.
  const lsof = spawnSync("lsof", ["-t", "-w", "--", path], { encoding: "utf8" });
  if (lsof.status === 0 && lsof.stdout.trim()) {
    const pids = lsof.stdout.trim().split(/\s+/).filter(Boolean);
    return pids.map((pid) => {
      const cmd = spawnSync("ps", ["-p", pid, "-o", "comm="], { encoding: "utf8" });
      return `pid ${pid} (${(cmd.stdout || "").trim() || "?"})`;
    });
  }
  // lsof missing (status null / ENOENT) → try fuser as a fallback signal.
  if (lsof.error) {
    const fuser = spawnSync("fuser", [path], { encoding: "utf8" });
    if (fuser.status === 0 && (fuser.stdout.trim() || fuser.stderr.trim())) {
      return [`(fuser) ${(fuser.stdout + " " + fuser.stderr).trim()}`];
    }
  }
  return [];
}

const targets = [DB, `${DB}-wal`, `${DB}-shm`].filter(existsSync);
const holders = [];
for (const t of targets) {
  for (const h of openHandles(t)) holders.push(`${t}: ${h}`);
}
if (holders.length) {
  log("⚠️  Open handles detected on the DB file(s):");
  for (const h of holders) log("   -", h);
  if (args.dryRun) {
    log("   (dry-run: continuing anyway — no swap will occur)");
  } else if (!args.force) {
    bail(
      "The DB is in use. Stop the gateway AND any pi-bots / same-host instances " +
      "first, or re-run with --force if you are certain nothing is writing.",
    );
  } else {
    log("   (--force: proceeding despite open handles — you asserted this is safe)");
  }
} else {
  log("Liveness gate: no open handles ✓");
}

// ---------------------------------------------------------------------------
// 2. BACKUP the corrupt db (+ sidecars) to <db>.CORRUPT-<ts>
// ---------------------------------------------------------------------------
const BACKUP = `${DB}.CORRUPT-${TS}`;
copyFileSync(DB, BACKUP);
for (const ext of ["-wal", "-shm"]) {
  if (existsSync(`${DB}${ext}`)) copyFileSync(`${DB}${ext}`, `${BACKUP}${ext}`);
}
log("Backed up corrupt DB →", BACKUP);

// ---------------------------------------------------------------------------
// 3. FRESH SCHEMA into a temp file via the in-repo init-db
// ---------------------------------------------------------------------------
const workDir = mkdtempSync(join(tmpdir(), "crow-recover-"));
const TEMP = join(workDir, "crow.db");
log("Building fresh schema →", TEMP);
const init = spawnSync("node", ["scripts/init-db.js"], {
  cwd: REPO_ROOT,
  env: { ...process.env, CROW_DB_PATH: TEMP },
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});
if (init.status !== 0) {
  bail(`init-db.js failed (exit ${init.status}):\n${init.stderr || init.stdout}`);
}
if (!existsSync(TEMP)) bail("init-db.js did not produce the temp DB file.");

// ---------------------------------------------------------------------------
// 4-5. SALVAGE readable base tables + rebuild FTS
// ---------------------------------------------------------------------------
// Federation audit (corrupt-prone, expendable) + ephemeral session state.
const ALWAYS_SKIP = new Set(["cross_host_calls", "mcp_sessions"]);

function isFtsShadow(name) {
  return /_fts(_data|_idx|_config|_docsize|_content)?$/.test(name);
}
function isVirtual(sql) { return /VIRTUAL\s+TABLE/i.test(sql || ""); }
function isMalformed(msg) {
  return /malformed|not a database|disk image|disk I\/O|SQLITE_IOERR/i.test(msg || "");
}

const db = new Database(TEMP);
db.exec("PRAGMA foreign_keys=OFF;");
// ATTACH the *backup* copy as the read source so the original is untouched
// until the atomic swap.
db.prepare("ATTACH ? AS old").run(BACKUP);

const targetTables = db.prepare(`
  SELECT name, sql FROM main.sqlite_master
  WHERE type='table' AND name NOT LIKE 'sqlite_%'
`).all();

const oldTables = new Set(
  db.prepare("SELECT name FROM old.sqlite_master WHERE type='table'").all().map((r) => r.name),
);

// report rows: [name, status, srcCount, copiedCount]
const report = [];
let crowInstancesSkipped = false;
// completeness pairs to verify AFTER writes settle: {name, srcCount}
const completeness = [];

for (const { name, sql } of targetTables) {
  if (isVirtual(sql) || isFtsShadow(name)) { report.push([name, "skip(fts)", 0, 0]); continue; }
  if (ALWAYS_SKIP.has(name)) { report.push([name, "skip(audit/ephemeral)", 0, 0]); continue; }
  if (!oldTables.has(name)) { report.push([name, "not-in-old", 0, 0]); continue; }

  // Per-table readability probe (also the crow_instances gate, review C4).
  let srcCount = null;
  try {
    srcCount = db.prepare(`SELECT count(*) c FROM old."${name}"`).get().c;
  } catch (e) {
    if (name === "crow_instances") crowInstancesSkipped = true;
    report.push([name, "UNREADABLE:" + e.message.slice(0, 40), 0, 0]);
    continue;
  }

  if (srcCount === 0) { report.push([name, "empty", 0, 0]); continue; }

  // Shared columns only (guard against schema drift between old and new).
  const newCols = db.prepare(`SELECT name FROM pragma_table_info('${name}')`).all().map((r) => r.name);
  const oldCols = new Set(
    db.prepare(`SELECT name FROM pragma_table_info('${name}', 'old')`).all().map((r) => r.name),
  );
  const shared = newCols.filter((c) => oldCols.has(c));
  const collist = shared.map((c) => `"${c}"`).join(",");
  try {
    const info = db.prepare(
      `INSERT OR REPLACE INTO main."${name}" (${collist}) SELECT ${collist} FROM old."${name}"`,
    ).run();
    report.push([name, "copied", srcCount, info.changes]);
    completeness.push({ name, srcCount });
  } catch (e) {
    // A copy failure on a READABLE table (srcCount>0) is fatal to completeness:
    // count(*) can traverse the b-tree while a full row read hits a corrupt
    // leaf/overflow page and throws (SQLITE_CORRUPT). integrity_check on the
    // fresh target would still be 'ok' (a table merely missing rows is
    // structurally valid), so we MUST register it as a shortfall so the swap
    // gate aborts. Recording {name, srcCount} makes the recount below diff
    // srcCount>0 vs the (0/partial) rows that actually landed.
    report.push([name, "COPY-FAIL:" + e.message.slice(0, 60), srcCount, 0]);
    completeness.push({ name, srcCount });
    if (name === "crow_instances" && isMalformed(e.message)) crowInstancesSkipped = true;
  }
}

// Rebuild every FTS virtual table from its (now-populated) content table.
const ftsVirtual = targetTables.filter((t) => isVirtual(t.sql)).map((t) => t.name);
for (const f of ftsVirtual) {
  try {
    db.prepare(`INSERT INTO main."${f}"("${f}") VALUES('rebuild')`).run();
    report.push([f, "fts-rebuilt", 0, 0]);
  } catch (e) {
    report.push([f, "FTS-REBUILD-FAIL:" + e.message.slice(0, 40), 0, 0]);
  }
}

db.prepare("DETACH old").run();
db.close();

// ---------------------------------------------------------------------------
// 6. TOKEN RE-INJECT — sha256(CROW_LOCAL_MCP_TOKEN) so MCP clients keep working
// ---------------------------------------------------------------------------
function readEnvToken() {
  if (process.env.CROW_LOCAL_MCP_TOKEN) return process.env.CROW_LOCAL_MCP_TOKEN;
  const envPath = join(REPO_ROOT, ".env");
  if (!existsSync(envPath)) return null;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = /^\s*CROW_LOCAL_MCP_TOKEN\s*=\s*(.*)\s*$/.exec(line);
    if (m) return m[1].replace(/^["']|["']$/g, "").trim() || null;
  }
  return null;
}

const token = readEnvToken();
let tokenStatus = "no CROW_LOCAL_MCP_TOKEN found (skipped)";
if (token) {
  const { createDbClient } = await import("../servers/db.js");
  const { writeSetting } = await import("../servers/gateway/dashboard/settings/registry.js");
  const { validateLocalToken } = await import("../servers/gateway/local-token.js");
  const tdb = createDbClient(TEMP);
  await writeSetting(tdb, "mcp_local_token_hash", createHash("sha256").update(token).digest("hex"), { scope: "local" });
  await writeSetting(tdb, "mcp_local_token_created", new Date().toISOString(), { scope: "local" });
  const ok = await validateLocalToken(tdb, token);
  tdb.close();
  if (!ok) bail("Re-injected MCP token failed validation — refusing to swap.");
  tokenStatus = "re-injected + validated ✓";
}

// ---------------------------------------------------------------------------
// 7. SWAP GATES — (a) integrity_check == ok ; (b) per-table completeness
// ---------------------------------------------------------------------------
// Fold WAL into the file and drop to DELETE mode so the temp is a single,
// self-contained file safe to rename over the destination.
const fin = new Database(TEMP);
try { fin.pragma("wal_checkpoint(TRUNCATE)"); } catch { /* best-effort */ }
try { fin.pragma("journal_mode = DELETE"); } catch { /* best-effort */ }

const integ = fin.prepare("PRAGMA integrity_check").get();
const integrityOk = integ && integ.integrity_check === "ok";

// Re-count the destination tables and diff against the recorded source counts.
const shortfalls = [];
for (const { name, srcCount } of completeness) {
  let got = 0;
  try { got = fin.prepare(`SELECT count(*) c FROM main."${name}"`).get().c; } catch { got = -1; }
  if (got !== srcCount) shortfalls.push(`${name}: source=${srcCount} rebuilt=${got}`);
}
fin.close();

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
log("");
log("TABLE".padEnd(34), "STATUS".padEnd(24), "SRC".padStart(6), "COPIED".padStart(7));
for (const [n, s, o, c] of report) {
  if (["empty", "not-in-old", "skip(fts)"].some((p) => s.startsWith(p))) continue;
  log(n.padEnd(34), String(s).padEnd(24), String(o).padStart(6), String(c).padStart(7));
}
const copyFails = report.filter((r) => /FAIL|UNREADABLE/.test(r[1]));
log("");
log("integrity_check:", JSON.stringify(integ));
log("copy failures:  ", copyFails.length, copyFails.map((f) => `${f[0]}(${f[1]})`).join(", ") || "(none)");
log("token:          ", tokenStatus);

// A COPY-FAIL on a table with readable rows (report src column > 0) is a hard
// abort even if — belt-and-suspenders — the recount somehow matched. Skipped
// tables (cross_host_calls/mcp_sessions) never reach the copy path so they
// can't trip this. report row shape: [name, status, srcCount, copiedCount].
const readableCopyFail = copyFails.some((r) => r[2] > 0);
const gatePass = integrityOk && shortfalls.length === 0 && !readableCopyFail;

if (!gatePass) {
  log("");
  if (!integrityOk) log("❌ integrity_check is NOT 'ok':", JSON.stringify(integ));
  if (shortfalls.length) {
    log("❌ row-count completeness FAILED — some source rows did not land:");
    for (const s of shortfalls) log("   -", s);
  }
  if (readableCopyFail) {
    log("❌ a READABLE source table failed to copy (partial corruption — rows countable but not readable):");
    for (const r of copyFails.filter((x) => x[2] > 0)) log(`   - ${r[0]} (src=${r[2]}): ${r[1]}`);
  }
  log("");
  log("Rebuilt (rejected) DB left for inspection at:", TEMP);
  log("The original is UNTOUCHED. Backup of the corrupt DB:", BACKUP);
  bail("swap gates failed — NOT swapping.");
}

// ---------------------------------------------------------------------------
// 8. SWAP (or stop, for dry-run)
// ---------------------------------------------------------------------------
if (args.dryRun) {
  log("");
  log("✅ DRY-RUN PASSED — integrity ok + all row counts match.");
  log("   Rebuilt DB (NOT installed):", TEMP);
  log("   Original UNTOUCHED:        ", DB);
  log("   Corrupt backup:            ", BACKUP);
  log("   Re-run without --dry-run to install it.");
  if (crowInstancesSkipped) {
    log("");
    log("⚠️  crow_instances was UNREADABLE in the source — a real recovery would");
    log("    drop it and federation peers would need to RE-ENROLL.");
  }
  process.exit(0);
}

// Atomic-ish swap: rename the rebuilt file over the destination, then remove
// the old WAL sidecars. rename within the same fs is atomic; if TEMP is on a
// different filesystem, copy+rename via a same-dir staging file.
try {
  renameSync(TEMP, DB);
} catch (e) {
  if (e.code === "EXDEV") {
    const staging = `${DB}.rebuilt-${TS}`;
    copyFileSync(TEMP, staging);
    renameSync(staging, DB);
    try { rmSync(TEMP); } catch { /* best-effort */ }
  } else {
    bail(`swap failed: ${e.message}`);
  }
}
for (const ext of ["-wal", "-shm"]) {
  try { rmSync(`${DB}${ext}`, { force: true }); } catch { /* best-effort */ }
}
try { rmSync(workDir, { recursive: true, force: true }); } catch { /* best-effort */ }

log("");
log("✅ RECOVERY COMPLETE — rebuilt DB installed at", DB);
log("");
log("Runbook / next steps:");
log("  1. Corrupt original preserved at:", BACKUP, "(delete once you trust the recovery).");
log("  2. Restart the gateway + pi-bots so they reopen the fresh file:");
log("       sudo systemctl restart crow-gateway   # + crow-pi-bots, etc.");
log("  3. cross_host_calls was intentionally dropped (expendable audit); it now");
log("     stays bounded via the 14-day retention prune + malformed-DB circuit");
log("     breaker (see docs/developers/db-recovery.md).");
if (crowInstancesSkipped) {
  log("");
  log("  ⚠️⚠️  FEDERATION: crow_instances was corrupt and could NOT be salvaged.");
  log("      All federation peers (grackle sync, black-swan, etc.) will be REJECTED");
  log("      until they RE-ENROLL / re-pair with this instance. Re-run the pairing");
  log("      flow for each peer.");
} else {
  log("");
  log("  Federation trust anchor (crow_instances) was preserved — peers keep working.");
}
process.exit(0);
