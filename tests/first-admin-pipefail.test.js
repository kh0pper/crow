/**
 * First-admin scripts — early-exit readers behind a writer under `pipefail`.
 *
 * Every setup script that runs under `set -euo pipefail` and ends a pipeline with an
 * early-exiting reader (`grep -q`, `head`, `awk … exit`) has a timing bug, not a logic bug:
 * the reader leaves as soon as it has its answer, the writer still has bytes to hand it,
 * the writer dies of SIGPIPE, and `pipefail` then reports the WHOLE pipeline as failed. A
 * role that matched is reported as "no admin role"; a container that answers "healthy" is
 * reported as absent. How much the writer still had to write decides whether the bug shows,
 * so it only appears on a long answer — and only sometimes, which is what made
 * tests/bundle-first-admin-scripts-5.test.js (Kavita) flake in CI.
 *
 * What these tests hold down:
 *
 *   1. STATIC GUARD — no bundle shell script that sets `pipefail` puts an early-exit reader
 *      at the end of a pipe. Reported per file:line, so a new one is easy to place. The same
 *      rule is applied to the stand-in `docker`/`curl` programs embedded as string literals in
 *      the other `tests/*.test.js`: a STUB that dies of SIGPIPE reports a call the script DID
 *      make as failed, which is a test flaking for a reason the product never had. The
 *      detector itself is checked against the shapes that were really in the tree.
 *   2. BEHAVIOUR — for each matcher that used to race, the case that raced is driven
 *      DETERMINISTICALLY: the match comes first and ~1 MiB of further input follows, which
 *      is far more than any pipe buffer, so the old text fails every time and the fixed
 *      text passes every time. The function/statement under test is read out of the real
 *      script, so this test tracks the shipped code rather than a copy of it.
 *   3. Nothing here is retried or skipped: a fix that only narrows the race window fails.
 *
 * No docker, no network: the matchers are pure text functions, driven by the one shell the
 * other bundle tests already require.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLES = join(REPO, "bundles");
const TESTS = join(REPO, "tests");
const BASH = existsSync("/bin/bash") ? "/bin/bash" : "bash";

/** ~1 MiB: far more than a pipe buffer (64 KiB), so a writer is still writing when the
 *  reader has its match — enough to make the race a certainty instead of a coin toss. */
const MIB = 1 << 20;
const fill = (unit, size = MIB) => unit.repeat(Math.ceil(size / unit.length));

/** The marker that makes an early-exit reader a pipeline FAILURE instead of a shortcut. */
const PIPE_FAIL = /^\s*set\s+-[a-zA-Z]*o?\s*[a-zA-Z]*\s*pipefail\b/m;

/** Every bundle `scripts/<name>.sh` that sets `pipefail`. */
function pipefailScripts() {
  const out = [];
  for (const id of readdirSync(BUNDLES).sort()) {
    const dir = join(BUNDLES, id, "scripts");
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith(".sh")) continue;
      const path = join(dir, name);
      const text = readFileSync(path, "utf8");
      if (PIPE_FAIL.test(text)) out.push({ path, text });
    }
  }
  return out;
}

/**
 * The early-exit readers that make a pipeline fail under `pipefail`. A reader that reads its
 * whole input (`tail`, plain `grep`, `sed -n '1p'`, `grep -F`) never leaves a writer holding
 * the pipe, so it is not listed.
 */
const EARLY_EXIT = [
  { kind: "grep -q", hits: (seg) => /^grep\b/.test(seg) && /(^|\s)-[A-Za-z]*q/.test(seg) },
  { kind: "head", hits: (seg) => /^head\b/.test(seg) },
  { kind: "awk exit", hits: (seg) => /^awk\b/.test(seg) && /\bexit\b/.test(seg) },
];

/** Every early-exit reader that sits behind a `|` in `text`, as `<line>:<kind>:<segment>`.
 *  `firstLine` is the source line `text` starts on, so a fragment lifted out of a stub reports
 *  the line of the file it came from.
 *
 *  One exemption, and it is written ON the line it covers: a deliberate old shape kept as a
 *  POSITIVE CONTROL (a fixture that proves the bug is real by failing on the old text). It
 *  cannot be a mode or a file-level flag — the marker exempts exactly that line, and the test
 *  below holds that an unmarked line with the same shape is still a violation. */
const DELIBERATE_OLD_SHAPE = "# pipefail-guard: deliberate old shape (positive control)";

function earlyExitReaders(text, firstLine = 1) {
  const found = [];
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    if (line.includes(DELIBERATE_OLD_SHAPE)) return;
    // `||` is not a pipe; anything else separates pipeline stages.
    const stages = line.split(/(?<!\|)\|(?!\|)/);
    for (const stage of stages.slice(1)) {
      const seg = stage.trim();
      for (const rule of EARLY_EXIT) {
        if (rule.hits(seg)) found.push(`${firstLine + i}:${rule.kind}:${seg}`);
      }
    }
  });
  return found;
}

// ── the stand-in programs the other tests ship ─────────────────────────────────────

/** A whole line that is one JS string literal — the shape the stub arrays are written in. A
 *  trailing `//` comment is allowed: an annotated stub line must not go unseen. */
const LITERAL_LINE = /^\s*(['"])((?:\\.|(?!\1)[^\\])*)\1\s*,?\s*(?:\/\/.*)?$/;

/** The shell text a JS string literal body stands for: `\'` → `'`, `\\(` → `\(`, … .
 *  `\n`/`\t` are left alone on purpose: in these stubs they are shell `printf` format text,
 *  not line breaks in the script. */
const decodeShellText = (body) => body.replace(/\\([^A-Za-z0-9])/g, "$1");

/** Line number (1-based) of `offset` in `text`. */
const lineAt = (text, offset) => 1 + (text.slice(0, offset).match(/\n/g) || []).length;

/** `const NAME = `…`` blocks, which is how a multi-line stand-in is written. */
function templateStubs(text) {
  const found = [];
  const OPEN = /^[ \t]*(?:const|let|var)[ \t]+[A-Za-z0-9_]+[ \t]*=[ \t]*(?:String\.raw)?`/gm;
  for (const m of text.matchAll(OPEN)) {
    const start = m.index + m[0].length;
    let end = start;
    while (end < text.length && !(text[end] === "`" && text[end - 1] !== "\\")) end++;
    if (end >= text.length) break;
    found.push({ line: lineAt(text, start), text: text.slice(start, end) });
  }
  return found;
}

/**
 * Every shell script embedded in `tests/*.test.js` that sets `pipefail`, as
 * `{ path, chunks: [{ line, text }] }` — one chunk per array element / template literal, so a
 * hit reports the line of the test file it came from.
 *
 * An ARRAY of string literals (`const FAKE_DOCKER = [ '…', '…' ]`) is ONE script: the
 * `pipefail` marker and the pipelines under it are in different elements, so the elements are
 * read together. Spreads (`...NEXT_FN`) and inline strings that never mention `pipefail` are
 * not followed — this is a guard against the shape coming back, not a shell parser — and the
 * one-line `spawnSync("bash", ["-c", `…`])` snippets in the suite are out of scope.
 */
function stubShellScripts() {
  const out = [];
  for (const name of readdirSync(TESTS).sort()) {
    // This file holds the offending shapes ON PURPOSE, as the detector's own fixtures.
    if (!name.endsWith(".test.js") || name === "first-admin-pipefail.test.js") continue;
    const path = join(TESTS, name);
    const source = readFileSync(path, "utf8");
    const lines = source.split("\n");

    // `const X = [ … ]`: every standalone literal line between the brackets, read as one script.
    let block = null;
    for (let i = 0; i < lines.length; i++) {
      const literal = LITERAL_LINE.exec(lines[i]);
      if (block === null) {
        if (/^\s*(?:const|let|var)\s+[A-Za-z0-9_]+\s*=\s*\[\s*$/.test(lines[i])) block = [];
        continue;
      }
      if (/^\s*\]/.test(lines[i])) {
        if (block.some((c) => PIPE_FAIL.test(c.text))) out.push({ path, chunks: block });
        block = null;
        continue;
      }
      if (literal) block.push({ line: i + 1, text: decodeShellText(literal[2]) });
    }
    if (block && block.some((c) => PIPE_FAIL.test(c.text))) out.push({ path, chunks: block });

    // `const X = `…`` blocks that carry their own `pipefail`.
    for (const stub of templateStubs(source)) {
      if (PIPE_FAIL.test(stub.text)) out.push({ path, chunks: [stub] });
    }

    // Any one-line string literal that carries its own `pipefail` (an inline stand-in).
    for (let i = 0; i < lines.length; i++) {
      for (const m of lines[i].matchAll(/(['"])((?:\\.|(?!\1)[^\\])*)\1/g)) {
        if (!m[2].includes("pipefail")) continue;
        out.push({ path, chunks: [{ line: i + 1, text: decodeShellText(m[2]) }] });
      }
    }
  }
  return out;
}

test("static guard: no pipefail script ends a pipe with an early-exit reader", () => {
  const scripts = pipefailScripts();
  assert.ok(scripts.length >= 20, `the scan found the bundle scripts (${scripts.length})`);

  const offenders = [];
  for (const { path, text } of scripts) {
    for (const hit of earlyExitReaders(text)) offenders.push(`${relative(REPO, path)}:${hit}`);
  }
  assert.deepEqual(
    offenders,
    [],
    "an early-exit reader at the end of a pipe dies of SIGPIPE when the writer still has data,\n" +
      "and under `pipefail` that reports a match as a failure. Feed the reader with a here-string\n" +
      '(`grep … <<<"$value"`), or read the whole stream (`sed -n \'1p\'` instead of `head -1`):\n  ' +
      offenders.join("\n  "),
  );
});

test("static guard: no test stub that sets pipefail ends a pipe with an early-exit reader", () => {
  // The stand-in `docker`/`curl` programs in the other tests are shell scripts under
  // `pipefail` too. One that dies of SIGPIPE fails a call the script DID make, so the test
  // blames the product for a race only the stub has — the same bug, one layer down.
  const stubs = stubShellScripts();
  assert.ok(stubs.length >= 8, `the scan found the stand-in programs (${stubs.length})`);

  const offenders = new Set();
  for (const { path, chunks } of stubs) {
    for (const { line, text } of chunks) {
      for (const hit of earlyExitReaders(text, line)) offenders.add(`${relative(REPO, path)}:${hit}`);
    }
  }
  assert.deepEqual(
    [...offenders],
    [],
    "a stand-in program that ends a pipe with an early-exit reader dies of SIGPIPE and reports\n" +
      "a call the script DID make as failed. Read the whole stream (`sed -n '1p'` instead of\n" +
      '`head -n 1`) or feed the reader a here-string:\n  ' +
      [...offenders].join("\n  "),
  );
});

test("static guard: the deliberate-old-shape marker exempts that one line and nothing else", () => {
  // The positive controls are old-shape pipelines ON PURPOSE (they fail on the old text). They
  // name themselves on the exact line the guard would report — never by file or by mode.
  assert.deepEqual(
    earlyExitReaders(`set -uo pipefail\nproducer | grep -qFf "$TOK" 2>/dev/null  ${DELIBERATE_OLD_SHAPE}`),
    [],
  );
  // Unmarked, the identical line is still a violation.
  assert.deepEqual(earlyExitReaders(`set -uo pipefail\nproducer | grep -qFf "$TOK" 2>/dev/null`), [
    '2:grep -q:grep -qFf "$TOK" 2>/dev/null',
  ]);
  // …and a marker elsewhere does not launder a pipeline below it.
  assert.equal(
    earlyExitReaders(`set -uo pipefail\n${DELIBERATE_OLD_SHAPE}\nproducer | grep -qFf "$TOK"`).length,
    1,
  );
});

test("static guard: the detector flags the shapes that were in the tree", () => {
  // The exact lines this test was written against; if the detector stops seeing them, the
  // guard above has gone blind and its green means nothing.
  const kavita = `is_admin() { printf '%s' "$1" | tr ',' '\\n' | grep -qx '"Admin"'; }`;
  assert.deepEqual(earlyExitReaders(kavita), [`1:grep -q:grep -qx '"Admin"'; }`]);

  const docker = `if ! docker inspect c --format '{{.State.Health.Status}}' 2>/dev/null | grep -qw healthy; then`;
  assert.deepEqual(earlyExitReaders(docker), ["1:grep -q:grep -qw healthy; then"]);

  const head = `  t="$(printf '%s\\n' "$1" | grep -o '"token"' | head -n 1 | sed 's/x//')"`;
  assert.deepEqual(earlyExitReaders(head), ["1:head:head -n 1"]);

  const awk = `read -r W H < <(xrandr --current | awk '/\\*/ {print $1; exit}' | awk -F'x' '{print $1" "$2}')`;
  assert.equal(earlyExitReaders(awk).length, 1);
  assert.match(earlyExitReaders(awk)[0], /^1:awk exit:/);

  // …and it does not flag the shapes that read their whole input.
  for (const safe of [
    'has() { grep -q -- "$2" <<<"$1"; }',
    `flag="$(printf '%s' "$body" | grep -o '"x":true' | sed -n '1p' || true)"`,
    `count="$(printf '%s\\n' "$t" | tr -d ' \\r' | grep -E '^[0-9]+$' | tail -n 1 || true)"`,
  ]) {
    assert.deepEqual(earlyExitReaders(safe), [], safe);
  }
});

test("static guard: every pipefail bundle script still parses", () => {
  // A here-string is easy to misquote; a syntax error here would only surface on an install.
  for (const { path } of pipefailScripts()) {
    const r = spawnSync(BASH, ["-n", path], { encoding: "utf8" });
    assert.equal(r.status, 0, `${relative(REPO, path)}: ${r.stderr}`);
  }
});

// ── driving the shipped matchers ────────────────────────────────────────────────────

/** The source of `name() { … }` exactly as it is in the script (one line or a block). */
function functionSource(text, name) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^\\s*${name}\\s*\\(\\)\\s*\\{`).test(l));
  assert.notEqual(start, -1, `${name}() is defined in the script`);
  const out = [];
  let depth = 0;
  for (let i = start; i < lines.length; i++) {
    out.push(lines[i]);
    for (const ch of lines[i]) {
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
    }
    if (depth === 0) return out.join("\n");
  }
  assert.fail(`${name}() never closes`);
}

/**
 * The one matcher statement on the line carrying `needle`, with the `if`/`&&`/`||`/`; then`
 * sugar around it removed, so it can be run on the variables it reads. Read out of the real
 * script, so the old (piped) text is what fails and the fixed text is what passes.
 */
function statementFor(text, needle) {
  const line = text.split("\n").find((l) => l.includes(needle));
  assert.ok(line, `a matcher carrying ${needle}`);
  let s = line.trim().replace(/^(if|elif|while)\s+/, "").replace(/^!\s+/, "");
  if (s.includes(" && ")) s = s.slice(s.lastIndexOf(" && ") + 4);
  s = s.split(/;\s*then\b/)[0].split(" ||")[0].trim();
  assert.ok(s.includes("grep"), `extracted a grep statement: ${s}`);
  return s;
}

/** Run `script` under the same `set -euo pipefail` the bundle scripts use, `input` on stdin. */
function runBash(script, input) {
  const r = spawnSync(BASH, ["-c", script], {
    input,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 16 * MIB,
  });
  assert.equal(r.status, 0, `bash exited ${r.status}: ${r.stderr}`);
  return r.stdout.trim();
}

/** MATCH/NOMATCH for one shipped function, `input` (bytes) arriving on stdin. */
function driveFunction(file, fn, setup, call, input) {
  const source = functionSource(readFileSync(join(REPO, file), "utf8"), fn);
  const script = [
    "set -euo pipefail",
    source,
    setup,
    `if ${call}; then echo MATCH; else echo NOMATCH; fi`,
  ]
    .filter(Boolean)
    .join("\n");
  return runBash(script, input);
}

/** The MATCH/NOMATCH a shipped inline matcher prints, plus the statement it was given. */
function driveStatement(file, needle, varName, input) {
  const stmt = statementFor(readFileSync(join(REPO, file), "utf8"), needle);
  const script = [
    "set -euo pipefail",
    `${varName}="$(cat)"`,
    `if ${stmt}; then echo MATCH; else echo NOMATCH; fi`,
  ].join("\n");
  return { got: runBash(script, input), stmt };
}

/** The shape check every driven statement must pass: no pipe in front of the grep. */
function assertUnpiped(file, stmt) {
  assert.equal(
    /\|/.test(stmt),
    false,
    `${file}: the matcher is fed without a pipe (an early-exit reader behind a writer is a SIGPIPE race): ${stmt}`,
  );
}

/** The stdin reader the driven snippets use for their payload. */
const READ_PAYLOAD = 'payload="$(cat)"';

// ── Kavita: the Admin role out of the roles array ──────────────────────────────────

const KAVITA = "bundles/kavita/scripts/first-admin.sh";

test("kavita: the Admin role first in a megabyte of roles still confirms", () => {
  // The exact shape that flaked: `"roles":["Admin", …]` — the match is the FIRST entry and
  // `tr`/`grep` are still moving the rest when `grep -q` leaves.
  const roles = '"Admin",' + fill('"Login",');
  assert.equal(driveFunction(KAVITA, "is_admin", READ_PAYLOAD, 'is_admin "$payload"', roles), "MATCH");
});

test("kavita: a megabyte of roles without the Admin role is not an admin", () => {
  const roles = fill('"Login",').replace(/,$/, "");
  assert.equal(driveFunction(KAVITA, "is_admin", READ_PAYLOAD, 'is_admin "$payload"', roles), "NOMATCH");
});

test("kavita: the role is matched exactly — a name that contains the word is not the role", () => {
  for (const [roles, want] of [
    ['"AdminFan","Login"', "NOMATCH"],
    ['"Login","Admin"', "MATCH"],
    ['"Admin"', "MATCH"],
    ['"Login"', "NOMATCH"],
    ["", "NOMATCH"],
    ['"Login",', "NOMATCH"], // a dangling comma must not become an empty role
  ]) {
    assert.equal(
      driveFunction(KAVITA, "is_admin", READ_PAYLOAD, 'is_admin "$payload"', roles),
      want,
      roles,
    );
  }
});

// ── Calibre: the account list ──────────────────────────────────────────────────────

const CALIBRE = "bundles/calibre-server/scripts/first-admin.sh";
/** The account list is a script global, and the name it looks for is the declared admin. */
const CALIBRE_SETUP = 'ADMIN_USER=admin\nUSERS_RAW="$(cat)"';

test("calibre-server: our account first in a megabyte of accounts is still found", () => {
  const users = "admin\n" + fill("someone-else\n");
  const got = driveFunction(CALIBRE, "has_account", CALIBRE_SETUP, "has_account", users);
  assert.equal(got, "MATCH");
});

test("calibre-server: a megabyte of other accounts does not match, and the match is a whole name", () => {
  const others = fill("someone-else\n");
  assert.equal(driveFunction(CALIBRE, "has_account", CALIBRE_SETUP, "has_account", others), "NOMATCH");

  // `-x`: a name that merely contains ours is not our account.
  const similar = fill("administrator\n");
  assert.equal(driveFunction(CALIBRE, "has_account", CALIBRE_SETUP, "has_account", similar), "NOMATCH");
});

// ── Navidrome: a flag inside the page ──────────────────────────────────────────────

const NAVIDROME = "bundles/navidrome/scripts/first-admin.sh";

test("navidrome: the first-run flag first in a megabyte of page still matches", () => {
  // Line-oriented on purpose: `grep -q` only leaves the pipe early once it has a WHOLE
  // matching line, which is the shape that makes the race a certainty.
  const page = '<script>window.__INITIAL_STATE__={"firstTime":true}</script>\n' + fill("z\n");
  assert.equal(
    driveFunction(NAVIDROME, "has", READ_PAYLOAD, 'has "$payload" \'firstTime":true\'', page),
    "MATCH",
  );
});

test("navidrome: a megabyte of page without the flag does not match", () => {
  const page = fill("z\n");
  assert.equal(
    driveFunction(NAVIDROME, "has", READ_PAYLOAD, 'has "$payload" \'firstTime":true\'', page),
    "NOMATCH",
  );
});

// ── Stirling: the "locked" word in an answer ───────────────────────────────────────

const STIRLING = "bundles/stirling-pdf/scripts/first-admin.sh";

test("stirling-pdf: a lock notice first in a megabyte of answer still reads as locked", () => {
  const answer = '{"message":"account locked"}\n' + fill("log line\n");
  assert.equal(driveFunction(STIRLING, "locked", READ_PAYLOAD, 'locked "$payload"', answer), "MATCH");
});

test("stirling-pdf: the word only — an answer that never says it is not locked", () => {
  assert.equal(
    driveFunction(
      STIRLING,
      "locked",
      READ_PAYLOAD,
      'locked "$payload"',
      '{"message":"unlocked"}\n' + fill("log line\n"),
    ),
    "NOMATCH",
  );
});

// ── the inline matchers: same race, no function to name ────────────────────────────

const INLINE = [
  {
    id: "vikunja: the register answer carries a username",
    file: "bundles/vikunja/scripts/first-admin.sh",
    needle: `grep -q '"username"'`,
    varName: "body",
    match: '{"id":1,"username":"admin"}\n' + fill('{"noise":"x"}\n'),
    noMatch: '{"message":"registration is disabled"}\n' + fill('{"noise":"x"}\n'),
  },
  {
    id: "wallabag: the console confirmed the password change",
    file: "bundles/wallabag/scripts/first-admin.sh",
    needle: `grep -q "Changed password"`,
    varName: "answer",
    match: "Changed password for user admin\n" + fill("log line\n"),
    noMatch: fill("log line\n"),
  },
  {
    id: "trilium: the redirect points at the login",
    file: "bundles/trilium/scripts/first-admin.sh",
    needle: `grep -q 'login'`,
    varName: "target",
    match: "http://127.0.0.1:8080/login\n" + fill("z\n"),
    noMatch: "http://127.0.0.1:8080/setup\n" + fill("z\n"),
  },
  {
    id: "frigate: the app answered success",
    file: "bundles/frigate/scripts/first-admin.sh",
    needle: `grep -Eq '"success"`,
    varName: "answer",
    match: '{"success":true,"message":"ok"}\n' + fill('{"noise":"x"}\n'),
    noMatch: '{"success":false,"message":"no"}\n' + fill('{"noise":"x"}\n'),
  },
  {
    id: "actual-budget: a server that is not bootstrapped yet",
    file: "bundles/actual-budget/scripts/set-server-password.sh",
    needle: `grep -q '"bootstrapped":false'`,
    varName: "state",
    match: '{"bootstrapped":false}\n' + fill("log line\n"),
    noMatch: '{"bootstrapped":true}\n' + fill("log line\n"),
  },
];

for (const c of INLINE) {
  test(`${c.id} (first, then a megabyte more)`, () => {
    // The behaviour is asserted first: on the old text the match is LOST, which is the bug
    // itself, not just a shape a linter could have caught.
    const { got, stmt } = driveStatement(c.file, c.needle, c.varName, c.match);
    assert.equal(got, "MATCH", `a match at the start of a long answer was lost: ${stmt}`);
    assertUnpiped(c.file, stmt);
  });

  test(`${c.id}: the same input without the signal does not match`, () => {
    const { got, stmt } = driveStatement(c.file, c.needle, c.varName, c.noMatch);
    assert.equal(got, "NOMATCH");
    assertUnpiped(c.file, stmt);
  });
}