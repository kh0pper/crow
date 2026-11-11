// scripts/migrations/run-child.mjs
//
// The migration registry, run from a FRESH Node process.
//
// Why a child: ESM caches a module by its resolved URL for the lifetime of the
// process. A long-running gateway that pulls an update and then runs the new
// migrations IN PROCESS links them against modules it already evaluated in
// their OLD version — a migration that statically imports a shared module the
// gateway loaded at boot gets the stale namespace, and the link fails with
// "does not provide an export named X". The process never restarts, so the same
// failure repeats on every tick. A fresh child resolves every import against
// the tree as it is on disk now.
//
// CLI contract (servers/gateway/migration-child.js is the only caller):
//   node scripts/migrations/run-child.mjs '<json>'
//   json = { migrationsDir, dbPath, tasksDbPath, sha }
//
// stdout is NDJSON and nothing else — one JSON object per line:
//   {"log": "<message>"}   progress, forwarded to the parent's log
//   {"result": {...}}      the runMigrations return value, last line on success
//   {"error": "<message>"} the thrown message, last line on failure
//
// Exit codes: 0 success, 1 failure. Nothing in this file writes to stdout in
// any other shape, and nothing calls process.exit: exitCode lets the event loop
// drain so the final write reaches the pipe.
import { runMigrations } from "./runner.mjs";

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

async function main() {
  const raw = process.argv[2];
  if (!raw) throw new Error("run-child: missing JSON argument");
  const { migrationsDir, dbPath, tasksDbPath, sha = null } = JSON.parse(raw);
  const result = await runMigrations({
    migrationsDir,
    dbPath,
    tasksDbPath,
    sha,
    log: (m) => emit({ log: String(m) }),
  });
  emit({ result });
}

main().catch((err) => {
  emit({ error: String(err?.message ?? err) });
  process.exitCode = 1;
});