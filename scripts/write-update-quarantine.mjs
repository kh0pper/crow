#!/usr/bin/env node
/**
 * write-update-quarantine.mjs — record a commit this host already rolled back.
 *
 * `scripts/crow-update.sh` is the manual updater and runs outside the gateway's
 * module graph, but it must leave the SAME record the automatic path leaves:
 * otherwise the next automatic tick pulls the commit the script just rolled
 * back and the operator gets a second crash loop (F7).
 *
 * The marker format and its atomic write live in
 * servers/shared/update-quarantine.js — one writer, never a second copy — and
 * this runs with the CHECKOUT's node. The git directory comes from git itself
 * (a worktree's `.git` is a file), with the same hooks-off flags every other
 * updater git call uses.
 *
 * Usage:
 *   node scripts/write-update-quarantine.mjs --sha <40-hex> [--previous <40-hex>]
 *        [--reason startup-crash] [--by crow-update] [--held] [--git-dir <dir>]
 *
 * Exit 0 when the marker is on disk, 1 when it could not be written (a caller
 * under `set -e` turns that into a log line, never a silent skip).
 */
import { execFileSync } from "node:child_process";
import { writeUpdateQuarantine } from "../servers/shared/update-quarantine.js";

const GIT_HOOKS_OFF = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];

function arg(argv, name, fallback = null) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

function gitDirOf(cwd) {
  try {
    return execFileSync("git", [...GIT_HOOKS_OFF, "rev-parse", "--absolute-git-dir"], {
      cwd, encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

const argv = process.argv.slice(2);
const gitDir = arg(argv, "git-dir") || gitDirOf(process.cwd());
const record = writeUpdateQuarantine({
  gitDir,
  sha: arg(argv, "sha"),
  previous: arg(argv, "previous"),
  reason: arg(argv, "reason", "startup-crash"),
  by: arg(argv, "by", "crow-update"),
  persist: argv.includes("--held"),
});

if (!record) {
  process.stderr.write("[update-quarantine] could not write the marker (no git dir, or a bad sha)\n");
  process.exit(1);
}
process.stdout.write(
  `[update-quarantine] ${record.sha.slice(0, 9)} quarantined (${record.reason}${record.held ? ", held" : ""})\n`,
);