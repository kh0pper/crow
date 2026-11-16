// Markdown: the LINK-LABEL BACKTRACKING cliff (marked 17.0.4, BOTH renderers).
//
// marked's inline `link` rule matches a label with
//
//   (?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+[^`]*?`+(?!`)|[^\[\]\\`])*?
//
// The code-span alternative (`+[^`]*?`+(?!`)) has to decide how to split a run
// of backticks between its opener and its closer, and on a run of N backticks
// that is EXPONENTIAL in N. Measured on plain marked 17.0.4 (and live in both
// renderers): "[" + "``a".repeat(30) 39 ms, 32 97 ms, 34 258 ms, 36 649 ms
// (x2.5 per +2), and "[" + "```a".repeat(34) — 138 bytes — runs for minutes.
// `reflink` carries the same label pattern, so `][y]`, a closing `]`, an image
// `![` and a space after the run are all affected. A library post, a bot reply
// or a memory could stall the gateway's event loop for minutes.
//
// The fix (servers/blog/renderer.js, `defuseLinkLabelBacktracking`) is a LINEAR
// pre-pass: a link label cannot span a blank line, so the risky region around
// each `[` is bounded by its matching `]`, the next blank line, or the end of
// the text; a region holding more than LINK_LABEL_BACKTICK_RUNS_MAX maximal
// backtick runs gets a backslash in front of every backtick in it, which makes
// each run one character long and the split impossible (marked renders an
// escape as the character itself, so nothing is removed from the text).
//
// What must stay true:
//   - EVERY pathological shape finishes in well under 100 ms of CPU, in both
//     renderers — and a regression FAILS instead of hanging (each render runs
//     in a child process that is SIGKILLed after 5 s);
//   - the text stays visible: every backtick in the source is still there;
//   - ordinary content is byte-identical (the sha256 pins below were captured
//     from the renderer BEFORE the fix was added);
//   - fenced and indented code stay verbatim (marked never inline-lexes them,
//     so they are neither a risk nor something to rewrite).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  renderMarkdown, renderBotMarkdown,
  defuseLinkLabelBacktracking, LINK_LABEL_BACKTICK_RUNS_MAX,
} from "../servers/blog/renderer.js";

const RENDERER_PATH = fileURLToPath(new URL("../servers/blog/renderer.js", import.meta.url));
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

// --- an isolated render, so a regression fails instead of hanging -----------
// A stuck regex cannot be interrupted from the same thread, so each render runs
// in its OWN process: the parent ships the source in the environment, the child
// renders with both renderers (CPU time of each) and writes one JSON blob.
const CHILD_PROGRAM = [
  'const src = process.env.MD_SRC;',
  '(async () => {',
  '  const mod = await import(process.env.MD_RENDERER);',
  '  const out = {};',
  '  for (const fn of ["renderMarkdown", "renderBotMarkdown"]) {',
  '    const t0 = process.cpuUsage();',
  '    const html = mod[fn](src);',
  '    const u = process.cpuUsage(t0);',
  '    out[fn] = { ms: (u.user + u.system) / 1000, html };',
  '  }',
  '  process.stdout.write(JSON.stringify(out));',
  '})().catch((err) => {',
  '  process.stdout.write(JSON.stringify({ error: String(err && err.message) }));',
  '});',
].join("\n");

const RENDER_TIMEOUT_MS = 5000;

/** { renderMarkdown: {ms, html}, renderBotMarkdown: {ms, html} } or {timedOut}. */
function renderIsolated(src) {
  const res = spawnSync(process.execPath, ["-e", CHILD_PROGRAM], {
    env: { ...process.env, MD_RENDERER: RENDERER_PATH, MD_SRC: src },
    timeout: RENDER_TIMEOUT_MS,
    killSignal: "SIGKILL",
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (res.signal === "SIGKILL" || (res.error && res.error.code === "ETIMEDOUT")) {
    return { timedOut: true };
  }
  if (res.error) return { error: String(res.error.message) };
  try {
    return JSON.parse(res.stdout);
  } catch {
    return { error: "child produced no JSON: " + String(res.stderr || res.stdout).slice(0, 400) };
  }
}

// --- the cliff: four byte shapes x five ways to reach the label rule --------
const SHAPES = [
  { label: '"[" + "``a".repeat(30)', unit: "``a", n: 30 },
  { label: '"[" + "``a".repeat(40)', unit: "``a", n: 40 },
  { label: '"[" + "``a".repeat(200)', unit: "``a", n: 200 },
  { label: '"[" + "```a".repeat(34)', unit: "```a", n: 34 },
];
const VARIANTS = [
  // The unmatched-open shape: `link` and `reflink` both try the label here.
  { label: "as-is", wrap: (body) => "[" + body },
  // A closing `]` — the `label` group has to decide where it ends.
  { label: "closing ]", wrap: (body) => "[" + body + "]" },
  // A reference link: `reflink`'s own copy of the label pattern.
  { label: "reference ][y]", wrap: (body) => "[" + body + "][y]" },
  // An image: the same rule behind an extra `!`.
  { label: "image ![", wrap: (body) => "![" + body },
  // Runs followed by a space (the `[^`]*?` body is allowed to be empty).
  { label: "spaced `` ", wrap: (body) => "[" + body.replace(/`{2,}/g, (m) => m + " ") },
];

for (const shape of SHAPES) {
  test(`${shape.label}: both renderers finish in < 100 ms of CPU, text intact`, (t) => {
    for (const variant of VARIANTS) {
      const doc = variant.wrap(shape.unit.repeat(shape.n));
      const what = `${shape.label} [${variant.label}] (${doc.length} chars)`;
      const got = renderIsolated(doc);
      assert.ok(!got.timedOut,
        `${what}: no result after ${RENDER_TIMEOUT_MS} ms — the label backtracking cliff is back`);
      assert.ok(!got.error, `${what}: ${got.error}`);
      const backticks = (doc.match(/`/g) || []).length;
      for (const fn of ["renderMarkdown", "renderBotMarkdown"]) {
        const r = got[fn];
        assert.ok(r, `${what}: ${fn} produced nothing`);
        assert.ok(r.ms < 100, `${what}: ${fn} took ${r.ms.toFixed(1)} ms of CPU`);
        t.diagnostic(`${what} ${fn}: ${r.ms.toFixed(2)} ms`);
        // Nothing removed: an escaped backtick renders as the character itself,
        // so every backtick in the source is still in the output text.
        assert.equal((r.html.match(/`/g) || []).length, backticks,
          `${what}: ${fn} dropped a backtick: ` + r.html.slice(0, 300));
        assert.ok(!r.html.includes("\\"), `${what}: ${fn} left an escape in the output: ` + r.html.slice(0, 300));
        assert.ok(r.html.includes("a"), `${what}: ${fn} lost the text: ` + r.html.slice(0, 300));
      }
    }
  });
}

// --- the pre-pass itself ----------------------------------------------------
const codeRuns = (n) => ("`a` ").repeat(n);      // 2 backtick runs per repeat
const labelOf = (n) => "[" + codeRuns(n) + "](https://example.com/x)";

test("LINK_LABEL_BACKTICK_RUNS_MAX is 8", () => {
  assert.equal(LINK_LABEL_BACKTICK_RUNS_MAX, 8);
  assert.equal(typeof defuseLinkLabelBacktracking, "function");
});

test("a label with 8 runs is untouched, 10 runs are escaped", () => {
  const eight = labelOf(4);
  assert.equal((eight.match(/`/g) || []).length, 8, "fixture has 8 backticks (4 runs)");
  assert.equal(defuseLinkLabelBacktracking(eight), eight, "at the cap nothing changes");

  const ten = labelOf(5);
  assert.equal(defuseLinkLabelBacktracking(ten), ten.replace(/`/g, "\\`"),
    "over the cap every backtick in the region is escaped");
});

test("a region ends at its matching ] (nested brackets counted) or a blank line", () => {
  // Tail after the closing `]` is a different region: untouched.
  const after = labelOf(5) + " then plain `a` `b` `c` `d` `e` `f` text";
  assert.equal(defuseLinkLabelBacktracking(after), labelOf(5).replace(/`/g, "\\`") +
    " then plain `a` `b` `c` `d` `e` `f` text");

  // A blank line ends the region, so the following paragraph keeps its spans.
  const para = labelOf(5) + "\n\nAnother paragraph with `a` `b` `c` `d` `e` `f` `g`.";
  const out = defuseLinkLabelBacktracking(para);
  assert.ok(out.endsWith("\n\nAnother paragraph with `a` `b` `c` `d` `e` `f` `g`."), out);

  // Nested: the inner bracket's `]` does not end the outer region, and an
  // outer region over the cap is escaped exactly ONCE (no doubled escapes).
  const nestedSmall = "[" + codeRuns(1) + "[" + codeRuns(3) + "]" + "](u)";
  assert.equal((nestedSmall.match(/`/g) || []).length, 8, "8 backticks (4 + 4 runs)");
  assert.equal(defuseLinkLabelBacktracking(nestedSmall), nestedSmall, "8 runs, nested: below the cap");
  const nestedBig = "[" + codeRuns(3) + "[" + codeRuns(3) + "]" + "](u)";
  assert.equal(defuseLinkLabelBacktracking(nestedBig), nestedBig.replace(/`/g, "\\`"),
    "an outer region over the cap escapes every backtick once");

  // …and a `[` with no closing bracket runs to the end of the text.
  const unclosed = "text [" + codeRuns(5);
  assert.equal(defuseLinkLabelBacktracking(unclosed), ("text [" + codeRuns(5)).replace(/`/g, "\\`"));
});

test("no bracket (or no backtick) means no work at all", () => {
  const noBracket = codeRuns(20) + "and `more` `spans`";
  assert.equal(defuseLinkLabelBacktracking(noBracket), noBracket);
  const noTicks = "[a label](/x) with *no* code spans at all";
  assert.equal(defuseLinkLabelBacktracking(noTicks), noTicks);
  assert.equal(defuseLinkLabelBacktracking(""), "");
});

test("fenced and indented code are never rewritten", () => {
  const fenced = "```\n[" + codeRuns(10) + "\n```\n";
  assert.equal(defuseLinkLabelBacktracking(fenced), fenced);
  const tildes = "~~~js\n[" + codeRuns(10) + "\n~~~\n";
  assert.equal(defuseLinkLabelBacktracking(tildes), tildes);
  const indented = "Intro.\n\n    [" + codeRuns(10) + "\n\nAfter.\n";
  assert.equal(defuseLinkLabelBacktracking(indented), indented);
  // CRLF line endings are classified the same way (a blank line is "\r\n\r\n").
  const crlf = labelOf(5).replace(/\n/g, "\r\n") + "\r\n\r\nplain `a` `b` `c` `d` `e` `f` `g`\r\n";
  const crlfOut = defuseLinkLabelBacktracking(crlf);
  assert.ok(crlfOut.endsWith("\r\n\r\nplain `a` `b` `c` `d` `e` `f` `g`\r\n"), crlfOut);
});

// --- normal content is byte-identical --------------------------------------
// Digests captured from the renderer BEFORE the pre-pass existed. If one of
// these changes, something about ordinary rendering changed on purpose — find
// out what before you update the pin.
const INLINE_LABELS = [
  "[`a` and `b`](x) and [use `npm run x`](y)",
  "",
  "[`a` and `b` and `c` and `d`](z) and [one `w` two `v`](q)",
  "",
  "![alt `x`](/blog/media/a.png)",
  "",
  "[![alt `y`](/blog/media/b.png)](https://example.com/doc)",
  "",
].join("\n");

const README = [
  "# crow",
  "",
  "A personal server for notes, research and sharing.",
  "",
  "## Install",
  "",
  "Run `npm ci` and then `npm test`. The `check-ports` gate runs on every",
  "commit: see [the port allocation doc](docs/developers/port-allocation.md).",
  "",
  "```bash",
  "npm ci",
  "CROW_HOME=~/.crow node servers/gateway/index.js --no-auth",
  "```",
  "",
  "| gate | command | what it pins |",
  "| --- | --- | --- |",
  "| ports | `npm run check-ports` | the `port-allocation.md` table |",
  "| registry | `npm run build-registry -- --check` | `registry/add-ons.json` |",
  "",
  "See [`scripts/run-suite.mjs`](scripts/run-suite.mjs) for the scratch env, and",
  "[the add-on guide](docs/developers/creating-addons.md) for `manifest.json`.",
  "",
  "Inline: `a`, `b`, `c`, `d` and a [link](/blog/x) with ``x`` inside it.",
  "Snippets: `CROW_HOME=/tmp/x`, `node --test tests/*.test.js`, `git show`.",
  "",
  "- a bullet with `code` and a [link](/dashboard/board)",
  "- another `span` plus [another](/kb/x)",
  "",
].join("\n");

// A fenced block whose content holds `[` and 20 backtick runs: marked never
// inline-lexes a fence, so this must render verbatim (and must not be escaped).
const FENCED = [
  "A paragraph with a [normal link](/blog/x) and `inline code`.",
  "",
  "```js",
  "[" + "``a".repeat(20),
  "const total = counts.reduce((a, b) => a + b, 0);",
  "```",
  "",
  "~~~",
  "[" + "```a".repeat(12),
  "~~~",
  "",
  "Closing *paragraph* with [another link](/blog/y).",
  "",
].join("\n");

// An indented code block holding the same shape.
const INDENTED = [
  "Intro paragraph with a [link](/blog/x).",
  "",
  "    [" + "``a".repeat(12),
  "    const total = 1;",
  "",
  "After the block, [another](/blog/y) and `code`.",
  "",
].join("\n");

// Inline code with backticks OUTSIDE any bracket — ten runs, no label.
const INLINE_OUTSIDE = [
  "Use `npm test` and ``a ` b`` here, plus `x` `y` `z` `w` `v` `u` `t` `s`.",
  "",
  "Run `node scripts/x.mjs` twice: ``x`` and `y`, then [read this](/blog/z).",
  "",
].join("\n");

const FIXTURES = { INLINE_LABELS, README, FENCED, INDENTED, INLINE_OUTSIDE };

const PINNED = {
  "owner:INLINE_LABELS": "620688bc6a77bc5b152fc82bbb1b197e54322af4e71154f2e13269eb0b8dcb50",
  "bot:INLINE_LABELS": "83674c8f281d921a3a2005f752db37c553c8de67baf6f84400076dfabaf27956",
  "owner:README": "8a3f0bea46e8b7033027728ad070568e1afcc08d471fb70e1c9ef0dcae54b1d6",
  "bot:README": "c486d1efc2e8289bb1d6711604b2effc2fc64c459d663cd843b122339b40ff27",
  "owner:FENCED": "80395bb4a56a3b4e84435e205d176cb113a3b7fe230cd896f4c3271ae61c6b67",
  "bot:FENCED": "1cf592e7c55c4e7339b192f7f38df5461d2f326048087d8f8e8b6e16d5dc16fa",
  "owner:INDENTED": "47b07852f731df7aeb9d21e719a7e27b2d94013cd18f5564912e33c6b4219322",
  "bot:INDENTED": "c9ef3ebda5976c93159078f93a9965aa2a0b78442f13afeb8c758cb78eb40cba",
  "owner:INLINE_OUTSIDE": "88efc74eda736eae4856b88752dba6cd56d97e20ebb553e6df650af980868fdc",
  "bot:INLINE_OUTSIDE": "c0ac4e1cb26ef5ffb10b9bd7bf1e511ec67c5afddf334b9f408f6ec199765ddb",
};

test("normal content renders byte-identical to before the pre-pass", () => {
  const got = {};
  for (const [name, src] of Object.entries(FIXTURES)) {
    got["owner:" + name] = sha256(renderMarkdown(src));
    got["bot:" + name] = sha256(renderBotMarkdown(src));
  }
  assert.deepEqual(got, PINNED);
});

test("the fixtures are what they claim: spans, links, verbatim code", () => {
  const inline = renderMarkdown(INLINE_LABELS);
  assert.match(inline, /<code>a<\/code>/, inline.slice(0, 300));
  assert.match(inline, /<code>npm run x<\/code>/, "a label with a code span still renders as code");
  assert.match(inline, /<a href="x"/, inline.slice(0, 300));

  const readme = renderMarkdown(README);
  assert.match(readme, /<a href="docs\/developers\/port-allocation\.md"/);
  assert.match(readme, /<code>scripts\/run-suite\.mjs<\/code>/);
  assert.match(readme, /<table>/);

  for (const [name, src] of [["fenced", FENCED], ["indented", INDENTED]]) {
    assert.equal(defuseLinkLabelBacktracking(src), src, `${name}: the pre-pass leaves it alone`);
  }
  const fenced = renderBotMarkdown(FENCED);
  assert.ok(fenced.includes("[" + "``a".repeat(20)), "fenced backticks are verbatim: " + fenced.slice(0, 400));
  assert.ok(fenced.includes("[" + "```a".repeat(12)), "the tilde fence too: " + fenced.slice(0, 400));
  const indented = renderBotMarkdown(INDENTED);
  assert.ok(indented.includes("[" + "``a".repeat(12)), "indented code is verbatim: " + indented.slice(0, 400));
  assert.match(indented, /<a href="\/blog\/x"/);
});