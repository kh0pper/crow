/**
 * Repo-wide static guard for the fail-open detector bug class.
 *
 * Under `set -o pipefail`, a reader that exits early at the END of a pipeline (`grep -q`,
 * `head -n1`, `awk … exit`) leaves the upstream writer writing into a closed pipe: the
 * writer dies of SIGPIPE, pipefail makes the WHOLE pipeline fail, and a MATCH then reads
 * as "no match". Where the match means "a secret leaked", the detector fails OPEN — a real
 * leak reported as "not found" and the gate passing.
 *
 * The fix shape is never "producer | reader":
 *   grep -qFf "$TOK" <<<"$(producer)"                    # no writer for grep to SIGPIPE
 *   producer > "$tmpfile"; grep -qFf "$TOK" "$tmpfile"   # a file is not a pipe
 *   producer | sed -n '1p'                               # sed reads to EOF
 * and where the check matters, the producer's own failure is read separately ("cannot
 * verify" fails the gate) instead of being folded into grep's exit 1.
 *
 * This scans EVERY shell script in the repo that enables pipefail (`set -euo pipefail`,
 * `set -uo pipefail`, `set -e -o pipefail`, `set -o pipefail`): every *.sh, plus every
 * extension-less file whose shebang says bash or sh (scripts/crow, scripts/crow-satellite,
 * scripts/fence/crow-publish-snapshot, scripts/hooks/pre-push, …). bundles/<app>/scripts/*.sh
 * is the sibling PR's territory (it fixes the same bug class there); it is exempted here by
 * path so this guard can land first, and the exemption is asserted dead the moment that PR
 * merges (its files clean here) instead of quietly outliving its reason.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { closeSync, openSync, readFileSync, readdirSync, readSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".turbo", "vendor"]);

/** The first line of a file (a few bytes), or "" when it cannot be read. */
function firstLine(file) {
  let fd;
  try {
    fd = openSync(file, "r");
    const buffer = Buffer.alloc(256);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytes).toString("utf8").split("\n")[0];
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** `#!/usr/bin/env bash`, `#!/bin/sh`, `#!/usr/local/bin/bash -e` … */
const SHEBANG_SHELL = /^#!.*[\s/](?:bash|sh)\b/;

/**
 * Every shell script under the repo (skipping dependencies and VCS metadata): `*.sh`, plus
 * any file whose shebang says bash/sh. A hard-coded name list goes stale — scripts/crow,
 * crow-satellite, fence/crow-publish-snapshot and hooks/pre-push are not `*.sh`.
 */
function shellScripts(dir = ROOT, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) shellScripts(join(dir, entry.name), out);
    } else if (entry.isFile()) {
      const file = join(dir, entry.name);
      if (entry.name.endsWith(".sh") || SHEBANG_SHELL.test(firstLine(file))) out.push(file);
    }
  }
  return out;
}

/**
 * The sibling PR fixes bundles/<app>/scripts/*.sh: exempted by path, never by file name.
 * DELETE THIS the moment that PR is on main — the `sibling` assertion in the repo-wide test
 * fails as soon as the exemption has nothing left to hide, so an orphaned regex cannot linger.
 */
const SIBLING_OWNED = /^bundles\/[^/]+\/scripts\/[^/]+\.sh$/;

const relOf = (file) => relative(ROOT, file).split(sep).join("/");

/** Does this script turn pipefail on? Accepts the bundled and the separate-flags form. */
const SETS_PIPEFAIL = /^\s*set\s+(?:-[A-Za-z]+\s+)*.*\bpipefail\b/m;

/**
 * The shell commands that actually run, one entry per logical line: a commented-out command
 * is dropped, and a line continued with a trailing `|` (or `\`) is joined to its first line
 * — otherwise `producer |` newline `grep -q …` reads as two harmless lines, and the early-exit
 * reader at the end of a two-line pipeline is never seen.
 */
function logicalLines(text) {
  const out = [];
  let current = null;
  text.split("\n").forEach((raw, index) => {
    if (/^\s*#/.test(raw)) return; // a commented-out command does not run (and joins nothing)
    const piece = raw.trim();
    if (current === null) current = { text: piece, line: index + 1 };
    else current.text += " " + piece;
    if (/[|\\]$/.test(piece)) {
      // A `|` stays (it is the pipeline); a continuation `\` goes.
      current.text = current.text.replace(/\\$/, "");
      return;
    }
    out.push(current);
    current = null;
  });
  if (current !== null) out.push(current);
  return out;
}

/**
 * The same line with quoted strings blanked out (same length, so offsets still line up):
 * a `|` or `;` inside a regex or an awk program is data, not a pipe. A DOUBLE-quoted
 * string holding `$(…)` or a backtick is not blanked — that is code, and it runs.
 */
const maskQuotes = (line) =>
  line
    .replace(/'[^']*'/g, (m) => "q".repeat(m.length))
    .replace(/"[^"]*"/g, (m) => (/\$\(|`/.test(m) ? m : "q".repeat(m.length)));

/**
 * Split a line at its pipeline pipes; `||` is a shell operator, not a pipe. Each segment
 * keeps both forms so a reader can be recognised from the original and cut from the masked.
 */
function pipelineSegments(line) {
  const masked = maskQuotes(line);
  const segments = [];
  let start = 0;
  for (let i = 0; i < masked.length; i += 1) {
    if (masked[i] !== "|") continue;
    if (masked[i + 1] === "|" || (i > 0 && masked[i - 1] === "|")) continue;
    segments.push({ text: line.slice(start, i), masked: masked.slice(start, i) });
    start = i + 1;
  }
  segments.push({ text: line.slice(start), masked: masked.slice(start) });
  return segments;
}

/**
 * grep's flags decide it: `-q`, `-qFf`, `-qx`, `-qw` … stop grep at its first match, and
 * `-m N` / `--max-count N` stop it after N — `seq 1 200000 | grep -m1 1` still ends the
 * writer with SIGPIPE (exit 141) under pipefail. Both are reported: read the producer whole
 * first either way. A long `--quiet` / `--silent` is not a short-flag bundle and stays out
 * of scope (those sites are rewritten deliberately).
 */
function grepIsRisky(args) {
  if (/--max-count\b/.test(args)) return true;
  const shorts = args.split(/[\s"'=]+/).filter((token) => /^-[^-]/.test(token));
  return shorts.some((token) => token.includes("q") || token.includes("m"));
}

/**
 * sed quits early too: `q` ends the run at that line (`sed q`, `sed 1q`, `sed -n '1{p;q}'`,
 * `/re/q`) and SIGPIPEs the writer exactly like `head`. A `q` inside an `s///` is data, so
 * only a command-position `q` (after `;`/`{`/`}`/whitespace/an address) counts.
 */
function sedIsRisky(args) {
  return /(?:^|[;{}\s])[0-9]*q(?=$|[;}\s])/.test(args) || /\/[0-9]*q(?=$|[;}\s])/.test(args);
}

/** The early-exit reader at the end of this line, or null when there is none. */
function earlyExitReader(line) {
  const segments = pipelineSegments(line);
  if (segments.length < 2) return null;
  // Trailing `; then`, `&& break`, `|| true` belong to the shell, not to the reader.
  const lastSegment = segments[segments.length - 1];
  const cut = lastSegment.masked.search(/;|&&|\|\|/);
  const last = (cut === -1 ? lastSegment.text : lastSegment.text.slice(0, cut)).trim();
  // `| { grep -q …; }` wraps the reader in a block: accepted (never reported).
  const m = /^(?:(?:[A-Za-z_]\w*=\S*)\s+)*(?:(?:timeout|nice|sudo|env|command)\s+\S+\s+)*(grep|head|awk|sed)\b(.*)$/.exec(last);
  if (!m) return null;
  const [, command, args] = m;
  if (command === "grep") return grepIsRisky(args) ? last : null;
  if (command === "head") return last;
  if (command === "awk") return /\bexit\b/.test(args) ? last : null;
  if (command === "sed") return sedIsRisky(args) ? last : null;
  return null;
}

/** Every pipeline ending in an early-exit reader in one script: [{line, text}]. */
function violations(text) {
  const found = [];
  for (const line of logicalLines(text)) {
    const reader = earlyExitReader(line.text);
    if (reader) found.push({ line: line.line, text: reader });
  }
  return found;
}

test("the reader/pipe detector sees the shapes this PR fixes and accepts the safe ones", () => {
  // Flagged: the fail-open shapes.
  for (const line of [
    'if tr \'\\0\' \' \' < "$pid/cmdline" | grep -qFf "$TOK" 2>/dev/null; then',
    'if "$DOCKER" inspect "$SERVICE" 2>/dev/null | grep -qFf "$TOK"; then INSPECT_FOUND=1; fi',
    'if "$DOCKER" logs "$SERVICE" 2>&1 | grep -qFf "$TOK" 2>/dev/null; then LOGS_FOUND=1; fi',
    'CHROME_PATH=$(find /root/.cache -name chrome 2>/dev/null | head -1)',
    'pgrep -P "$parent" -f "$want" 2>/dev/null | head -n 1',
    'if occ dav:list-calendars "$ADMIN_USER" 2>/dev/null | grep -qE \'^\\| Menu +\\|\'; then',
    'status=$(docker compose ps --format "{{.Status}}" | head -c 8 || echo unknown)',
    "OUTPUT=\"$(wlr-randr 2>/dev/null | awk '/^[^ ]/ {print $1; exit}')\"",
    'docker inspect "$c" --format x 2>/dev/null | grep -qw crow-federation',
    'if join -t"\\t" a b | awk -F"\\t" \'$2!=$3 {print $1}\' | grep -q .; then lost=1; fi',
    // A bounded reader still exits early: `grep -m1` stops the writer like `-q` does.
    'printf \'%s\' "$1" | grep -o \'"token":"[^"]*"\' | grep -m 1 \'token\'',
    'seq 1 200000 | grep -m1 1',
    'ls "$d"/*.moc3 2>/dev/null | grep --max-count=1 moc3',
    // …and so does every shape of sed's `q`.
    'docker logs "$SERVICE" 2>&1 | sed q',
    'docker ps --format "{{.Names}}" | sed 1q',
    'git show "$SHA" | sed -n \'1{p;q}\'',
  ]) {
    assert.ok(earlyExitReader(line), "should be reported: " + line);
  }
  // Accepted: no writer left to SIGPIPE, or a reader the fix style deliberately leaves.
  for (const line of [
    'grep -qFf "$TOK" <<<"$(tr \'\\0\' \' \' < "$pid/cmdline")"',
    'grep -qE "$want" <<<"$(tr \'\\0\' \' \' < "$cmdline")" || continue',
    'CHROME_PATH=$(find /root/.cache -name chrome -type f 2>/dev/null | sed -n \'1p\')',
    'ps=$(docker compose ps --format "{{.Status}}" | sed -n \'1p\')',
    'nl=$(ss -ltnH | awk \'{print $4}\')',
    'grep -q -- \'--remote-debugging-port\' <<<"$PRE_ENTRYPOINT"',
    'if occ user:list --output=json | python3 -c \'print(1)\'; then',
    'printf \'%s\' "$1" | grep -o \'"token":"[^"]*"\'',
    'if "$T" devices | { grep -qi "^Device $MAC"; }; then seen=1; fi',
    'if "$CTL" info "$MAC" | sed -n \'1p\'; then :; fi',
    'tail -5 "$log" | sed \'s/^/    /\'',
    'cat "$f" | sed \'s|q|x|g\'', // a `q` in an s/// is data, not a quit
    'grep -q "0C0FFEE0" <<<"$(curl -s http://127.0.0.1:3071/plugins.json)"',
    'grep -qE "\\{32,256\\}" "$CDP_TOKEN_SRC" || die "malformed"',
    'for id in $(occ user:list --output=json | python3 -c \'print(1)\'); do :; done',
  ]) {
    assert.equal(earlyExitReader(line), null, "should be accepted: " + line);
  }
});

test("pipefail is detected in every form the repo uses, including the separate flags", () => {
  for (const text of [
    "#!/bin/bash\nset -euo pipefail\n",
    "#!/bin/bash\nset -uo pipefail\n",
    "#!/bin/bash\nset -e -o pipefail\n",
    "#!/bin/bash\nset -o pipefail\n",
  ]) {
    assert.match(text, SETS_PIPEFAIL, "should count as a pipefail script: " + text.trim());
  }
  assert.doesNotMatch("#!/bin/bash\nset -eu\n", SETS_PIPEFAIL, "plain `set -eu` is not pipefail");
});

test("a pipeline continued on the next line is read as one pipeline (trailing `|` and `\\`)", () => {
  // Without the join these are two innocent-looking halves and the reader is never seen.
  assert.deepEqual(
    violations('docker logs "$S" 2>&1 |\n  grep -qFf "$TOK" 2>/dev/null\n').map((v) => v.line),
    [1],
  );
  assert.deepEqual(
    violations('docker logs "$S" 2>&1 \\\n  | head -1\n').map((v) => v.line),
    [1],
  );
  // A comment inside neither runs nor joins.
  assert.deepEqual(violations('# docker logs | grep -q x\n# head -1\n'), []);
});

test("no shell script that sets pipefail ends a pipeline with an early-exit reader (repo-wide)", (t) => {
  const files = shellScripts();
  const offenders = [];
  let scanned = 0;
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    if (!SETS_PIPEFAIL.test(text)) continue;
    scanned += 1;
    for (const v of violations(text)) offenders.push({ file: relOf(file), ...v });
  }
  assert.ok(scanned > 50, `expected many pipefail scripts, found ${scanned} of ${files.length} shell scripts`);
  // Positive control on the walk itself: it really reaches both halves of the repo, and the
  // shebang half of it (extension-less scripts are not `*.sh`).
  assert.ok(files.some((f) => relOf(f).startsWith("bundles/")), "the walk reaches bundles/");
  assert.ok(files.some((f) => relOf(f).startsWith("scripts/")), "and scripts/");
  for (const name of ["scripts/crow", "scripts/crow-satellite", "scripts/fence/crow-publish-snapshot", "scripts/hooks/pre-push"]) {
    assert.ok(files.some((f) => relOf(f) === name), "the shebang scan reaches " + name);
  }

  // The sibling PR's files, reported but not failed on (see the header comment).
  const sibling = offenders.filter((o) => SIBLING_OWNED.test(o.file));
  const mine = offenders.filter((o) => !SIBLING_OWNED.test(o.file));
  if (sibling.length > 0) {
    t.diagnostic(`bundles/<app>/scripts/*.sh (the sibling PR's): ${sibling.length} site(s)`);
    for (const v of sibling) t.diagnostic(`  ${v.file}:${v.line}: ${v.text}`);
  }
  // The exemption must not outlive its reason: once the sibling PR is on main, its files are
  // clean here, `sibling` is empty, and SIBLING_OWNED has to go or it would hide the next
  // offender in bundles/<app>/scripts/*.sh forever.
  assert.ok(
    sibling.length > 0,
    "SIBLING_OWNED exempts bundles/<app>/scripts/*.sh from this guard because the sibling " +
      "pipefail PR fixes them, and that exemption now covers NO offender: the sibling PR is on " +
      "main, so delete SIBLING_OWNED (and its comment) instead of leaving it to hide a future one",
  );
  assert.deepEqual(
    mine.map((o) => `${o.file}:${o.line}: ${o.text}`),
    [],
    "these must not pipe into an early-exit reader: read the producer whole first " +
      '(grep -qFf "$TOK" <<<"$(producer)", or producer > file then grep the file), use ' +
      "sed -n '1p' instead of head, or grep a file instead of a stream",
  );
});

test("every pipefail script the guard scans still parses (bash -n)", () => {
  const scanned = shellScripts().filter((file) => SETS_PIPEFAIL.test(readFileSync(file, "utf8")));
  for (const file of scanned) {
    assert.doesNotThrow(() => execFileSync("bash", ["-n", file], { stdio: "pipe" }), "bash -n " + relOf(file));
  }
});