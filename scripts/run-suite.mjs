#!/usr/bin/env node
/**
 * npm test — the canonical full-suite runner, safe by construction.
 *
 * Reproduces the exact semantics the green baseline was established under:
 * one fresh scratch CROW_HOME per invocation, node --test's default file-level
 * concurrency, the full tests/*.test.js file set. The scratch env means a run
 * on any box (including the prod host) can never touch the real ~/.crow.
 *
 * Behavior:
 *   npm test                        → full suite (scratch env)
 *   npm test -- --test-reporter=spec  → flags are passed to node --test
 *                                       (BEFORE the file list — node treats
 *                                       post-positional flags as test paths)
 *   npm test -- tests/foo.test.js   → explicit-file mode: runs exactly the
 *                                     named file(s); enumeration AND CI
 *                                     exclusions are bypassed
 *   npm test -- --ci                → apply tests/ci-exclusions.json even
 *                                     outside GitHub Actions
 *
 * CI exclusions (tests/ci-exclusions.json, always present, may be empty) are
 * applied only under GitHub Actions (GITHUB_ACTIONS=true) or --ci. A bare
 * CI=true (devcontainers etc.) does NOT reduce the suite — we warn instead.
 * Every entry must name an existing test file (rot guard, hard error).
 */
import { readdirSync, readFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TESTS_DIR = join(ROOT, "tests");
const EXCLUSIONS_PATH = join(TESTS_DIR, "ci-exclusions.json");

const rawArgs = process.argv.slice(2);
const ciFlag = rawArgs.includes("--ci");
const passthrough = rawArgs.filter((a) => a !== "--ci" && !a.endsWith(".test.js"));
const explicitFiles = rawArgs.filter((a) => a.endsWith(".test.js"));

// --- resolve the file list -------------------------------------------------
let files;
if (explicitFiles.length > 0) {
  // Explicit-file mode: run exactly what was asked, no exclusions.
  files = explicitFiles.map((f) => resolve(process.cwd(), f));
  for (const f of files) {
    if (!existsSync(f)) {
      console.error(`[run-suite] no such test file: ${f}`);
      process.exit(1);
    }
  }
} else {
  files = readdirSync(TESTS_DIR)
    .filter((f) => f.endsWith(".test.js"))
    .sort()
    .map((f) => join(TESTS_DIR, f));

  // The exclusions file is load-bearing infrastructure (flake quarantine with
  // an audit trail) — its absence is a repo defect, not a default.
  if (!existsSync(EXCLUSIONS_PATH)) {
    console.error(`[run-suite] missing ${EXCLUSIONS_PATH} — it must exist (an empty list is fine)`);
    process.exit(1);
  }
  const exclusions = JSON.parse(readFileSync(EXCLUSIONS_PATH, "utf8"));
  const excluded = exclusions.excluded ?? [];
  for (const entry of excluded) {
    if (!existsSync(join(TESTS_DIR, entry.file))) {
      console.error(`[run-suite] ci-exclusions.json names a missing file: ${entry.file} — remove the stale entry`);
      process.exit(1);
    }
  }
  const applyExclusions = process.env.GITHUB_ACTIONS === "true" || ciFlag;
  if (applyExclusions && excluded.length > 0) {
    const skip = new Set(excluded.map((e) => join(TESTS_DIR, e.file)));
    files = files.filter((f) => !skip.has(f));
    for (const e of excluded) {
      console.error(`[run-suite] CI-excluded: ${e.file} (${e.class}) — ${e.reason}`);
    }
  } else if (!applyExclusions && process.env.CI && excluded.length > 0) {
    console.error("[run-suite] CI is set but GITHUB_ACTIONS is not — exclusions NOT applied (pass --ci to apply)");
  }
}

// --- scratch env, one per invocation (baseline semantics) ------------------
const scratch = mkdtempSync(join(tmpdir(), "crow-test-"));
const env = { ...process.env };
env.CROW_HOME = scratch;
env.CROW_DATA_DIR = join(scratch, "data");
// Forced unconditionally: there is no legitimate suite mode with live relay
// or instance-sync traffic.
env.CROW_DISABLE_NOSTR = "1";
env.CROW_DISABLE_INSTANCE_SYNC = "1";
// The suite must never believe it is supervised: a systemd-launched context
// (CI runner, systemd-run, VS Code remote) leaks INVOCATION_ID, and code
// under test would arm real restart/exit paths inside test processes.
delete env.INVOCATION_ID;
delete env.CROW_SUPERVISED;

// Passthrough flags go BEFORE the positional file list; node --test treats
// anything after the first positional as a test path.
// (~308 file paths ≈ 15 KB of argv — well under even the 32 KB Windows cap;
// revisit if the suite ever grows several-fold.)
const nodeArgs = ["--test", ...passthrough, ...files];
const child = spawn(process.execPath, nodeArgs, { stdio: "inherit", env, cwd: ROOT });

const cleanup = () => {
  try { rmSync(scratch, { recursive: true, force: true }); } catch {}
};
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    child.kill(sig); // forward; exit via the child's close event below
  });
}
child.on("error", (err) => {
  console.error(`[run-suite] failed to spawn node --test: ${err.message}`);
  cleanup();
  process.exit(1);
});
child.on("close", (code, signal) => {
  cleanup();
  // A signal-killed child has code null — that is a failed run, never a green.
  process.exit(code ?? 1);
});
