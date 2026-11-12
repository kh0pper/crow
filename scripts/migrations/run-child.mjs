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
// stdout is NDJSON — one JSON object per line:
//   {"log": "<message>"}          progress, forwarded to the parent's log
//   {"result": {...}, nonce}      the runMigrations return value, last line on success
//   {"error": "<message>", nonce} the thrown message, last line on failure
//
// Both final lines repeat the per-run nonce the parent minted and passed in this
// child's environment (CROW_MIGRATION_CHILD_NONCE). It is read here at startup
// and then removed from process.env, so a migration cannot read it. The parent
// trusts a final line only when it carries this run's nonce: the nonce is what
// separates the protocol from a stray line that merely looks like it.
//
// console.log, console.info and console.debug — and the console methods built on
// them — are pointed at stderr before the runner is imported, so a migration, or
// anything it imports, that logs that way does not land on the protocol stream.
// The runner is imported from inside main() for exactly that reason: a static
// import would evaluate it first, import-time logs included. A direct write to
// process.stdout is NOT blocked — console.dir is not redirected either — and
// that is why the parent checks the nonce and the shape of every line.
//
// Exit codes: 0 success, 1 failure. The final line is written with a leading
// newline as well as a trailing one, so a partial line a migration left
// unterminated on stdout cannot swallow it. Its write callback then calls
// process.exit(code), so the child leaves as soon as that line is flushed — even
// when a migration left a timer or a socket open.

// The protocol's own write, captured before anything else can redirect stdout.
const out = process.stdout.write.bind(process.stdout);

// This run's nonce, read once and then taken out of the environment so nothing
// the child runs — the runner, a migration, a module they import — can see it.
const nonce = process.env.CROW_MIGRATION_CHILD_NONCE ?? "";
delete process.env.CROW_MIGRATION_CHILD_NONCE;

// console output belongs to the human reading the journal, not to the protocol.
const toStderr = console.error.bind(console);
console.log = toStderr;
console.info = toStderr;
console.debug = toStderr;

function writeLine(obj) {
  out(`${JSON.stringify(obj)}\n`);
}

/** Write the final line, then exit once it is flushed. */
function finish(obj, code) {
  out(`\n${JSON.stringify(obj)}\n`, () => process.exit(code));
}

async function main() {
  const raw = process.argv[2];
  if (!raw) throw new Error("run-child: missing JSON argument");
  const { migrationsDir, dbPath, tasksDbPath, sha = null } = JSON.parse(raw);
  const { runMigrations } = await import("./runner.mjs");
  return runMigrations({
    migrationsDir,
    dbPath,
    tasksDbPath,
    sha,
    log: (m) => writeLine({ log: String(m) }),
  });
}

main().then(
  (result) => finish({ result, nonce }, 0),
  (err) => {
    // The trace goes to stderr, out of the protocol stream; the parent keeps a
    // tail of stderr for a child that dies without an error line.
    process.stderr.write(`${err?.stack || err?.message || String(err)}\n`, () => {
      finish({ error: String(err?.message ?? err), nonce }, 1);
    });
  },
);
