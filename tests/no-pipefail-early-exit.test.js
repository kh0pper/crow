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
 * This scans EVERY *.sh in the repo that enables pipefail (`set -euo pipefail`,
 * `set -uo pipefail`, `set -e -o pipefail`, `set -o pipefail`), plus the extension-less
 * shell scripts this PR touched. bundles/<app>/scripts/*.sh is the sibling PR's territory
 * (it fixes the same bug class there); it is exempted here by path so this guard can land
 * first, and the exemption goes away when that PR merges.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".turbo", "vendor"]);

/** Every *.sh under the repo (skipping dependencies and VCS metadata). */
function shellScripts(dir = ROOT, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) shellScripts(join(dir, entry.name), out);
    } else if (entry.name.endsWith(".sh")) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

/** Extension-less shell scripts this PR edits; they are not `*.sh`, so scan them by name. */
const EXTRA_SCRIPTS = ["scripts/crow", "scripts/fence/crow-engine-fence"];

/** The sibling PR fixes bundles/<app>/scripts/*.sh: exempted by path, never by file name. */
const SIBLING_OWNED = /^bundles\/[^/]+\/scripts\/[^/]+\.sh$/;

const relOf = (file) => relative(ROOT, file).split(sep).join("/");

/** Does this script turn pipefail on? Accepts the bundled and the separate-flags form. */
const SETS_PIPEFAIL = /^\s*set\s+(?:-[A-Za-z]+\s+)*.*\bpipefail\b/m;

/** Code lines only: a commented-out command does not run. */
const codeLines = (text) => text.split("\n").filter((line) => !/^\s*#/.test(line));

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
 * grep's SHORT flags decide it: `-q`, `-qFf`, `-qx`, `-qw` … stop grep at its first match.
 * Accepted and not reported: `-m` (`grep -m1`), and the long `--quiet` / `--silent` (a
 * long option is not a short-flag bundle, and those sites are rewritten deliberately).
 */
function grepIsRisky(args) {
  const shorts = args.split(/[\s"'=]+/).filter((token) => /^-[^-]/.test(token));
  if (shorts.some((token) => token.includes("m"))) return false;
  return shorts.some((token) => token.includes("q"));
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
  const m = /^(?:(?:[A-Za-z_]\w*=\S*)\s+)*(?:(?:timeout|nice|sudo|env|command)\s+\S+\s+)*(grep|head|awk)\b(.*)$/.exec(last);
  if (!m) return null;
  const [, command, args] = m;
  if (command === "grep") return grepIsRisky(args) ? last : null;
  if (command === "head") return last;
  if (command === "awk") return /\bexit\b/.test(args) ? last : null;
  return null;
}

/** Every pipeline ending in an early-exit reader in one script: [{line, text}]. */
function violations(text) {
  const found = [];
  codeLines(text).forEach((line, index) => {
    const reader = earlyExitReader(line);
    if (reader) found.push({ line: index + 1, text: line.trim() });
  });
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
    'printf \'%s\' "$1" | grep -o \'"token":"[^"]*"\' | grep -m 1 \'token\'',
    'if "$T" devices | { grep -qi "^Device $MAC"; }; then seen=1; fi',
    'if "$CTL" info "$MAC" | sed -n \'1p\'; then :; fi',
    'tail -5 "$log" | sed \'s/^/    /\'',
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

test("no *.sh that sets pipefail ends a pipeline with an early-exit reader (repo-wide)", (t) => {
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
  // Positive control on the walk itself: it really reaches both halves of the repo.
  assert.ok(files.some((f) => relOf(f).startsWith("bundles/")), "the walk reaches bundles/");
  assert.ok(files.some((f) => relOf(f).startsWith("scripts/")), "and scripts/");

  // The sibling PR's files, reported but not failed on (see the header comment).
  const sibling = offenders.filter((o) => SIBLING_OWNED.test(o.file));
  const mine = offenders.filter((o) => !SIBLING_OWNED.test(o.file));
  if (sibling.length > 0) {
    t.diagnostic(`bundles/<app>/scripts/*.sh (the sibling PR's): ${sibling.length} site(s)`);
    for (const v of sibling) t.diagnostic(`  ${v.file}:${v.line}: ${v.text}`);
  }
  assert.deepEqual(
    mine.map((o) => `${o.file}:${o.line}: ${o.text}`),
    [],
    "these must not pipe into an early-exit reader: read the producer whole first " +
      '(grep -qFf "$TOK" <<<"$(producer)", or producer > file then grep the file), use ' +
      "sed -n '1p' instead of head, or grep a file instead of a stream",
  );
});

test("the extension-less shell scripts this PR touches are clean too", () => {
  for (const name of EXTRA_SCRIPTS) {
    const text = readFileSync(join(ROOT, name), "utf8");
    assert.match(text, SETS_PIPEFAIL, name + " is a pipefail script (that is why it is listed)");
    assert.deepEqual(violations(text).map((v) => `${name}:${v.line}: ${v.text}`), []);
  }
});

test("every pipefail script the guard scans still parses (bash -n)", () => {
  const scanned = shellScripts().filter((file) => SETS_PIPEFAIL.test(readFileSync(file, "utf8")));
  for (const file of [...scanned, ...EXTRA_SCRIPTS.map((name) => join(ROOT, name))]) {
    assert.doesNotThrow(() => execFileSync("bash", ["-n", file], { stdio: "pipe" }), "bash -n " + relOf(file));
  }
});