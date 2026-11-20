import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { check } from "../servers/shared/quote-check.js";

const PY = "python3";
const pyDir = process.env.QUOTE_CHECK_PY_DIR;

if (!pyDir) {
  console.error("usage: QUOTE_CHECK_PY_DIR=<directory containing the citecheck package> node scripts/quote-check-parity.mjs [seed]");
  process.exit(2);
}

const seed = Number(process.argv[2] ?? 1) >>> 0;
const CASES = JSON.parse(readFileSync(new URL("../tests/fixtures/quote-check/cases.json", import.meta.url), "utf8"));

const CLI_BOOT = [
  "import os, runpy, sys",
  "sys.path.insert(0, os.getcwd())",
  'runpy.run_module("citecheck", run_name="__main__")',
].join("\n");

const STDIN_BOOT = [
  "import json, os, sys",
  "sys.path.insert(0, os.getcwd())",
  "from citecheck.core import check",
  "p = json.load(sys.stdin)",
  'print(json.dumps(check(p["answer"], p["sources"], p["opts"])))',
].join("\n");

const STREAM_BOOT = [
  "import json, os, sys",
  "sys.path.insert(0, os.getcwd())",
  "from citecheck.core import check",
  "for line in sys.stdin:",
  "    line = line.strip()",
  "    if not line:",
  "        continue",
  "    p = json.loads(line)",
  '    print(json.dumps(check(p.get("answer") or "", p.get("sources") or [], p.get("opts") or {})), flush=True)',
].join("\n");

function parseOutput(res, label) {
  if (res.error) throw res.error;
  const out = (res.stdout || "").trim();
  if (!out) throw new Error(`${label}: no JSON (status ${res.status}): ${(res.stderr || "").trim().slice(0, 400)}`);
  return JSON.parse(out);
}

const SPAWN_OPTS = { cwd: pyDir, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 };

function runCli(args) {
  const direct = spawnSync(PY, ["-I", "-m", "citecheck", ...args], SPAWN_OPTS);
  if (direct.error) throw direct.error;
  if (!(direct.stdout || "").trim() && /No module named ['"]?citecheck/.test(direct.stderr || "")) {
    return spawnSync(PY, ["-I", "-c", CLI_BOOT, ...args], SPAWN_OPTS);
  }
  return direct;
}

function cliCase(c, dir) {
  const answerPath = join(dir, "answer.txt");
  writeFileSync(answerPath, c.answer ?? "", "utf8");
  const args = ["--answer", answerPath];
  (c.sources || []).forEach((src, i) => {
    const p = join(dir, `source-${i}.txt`);
    writeFileSync(p, src.text ?? "", "utf8");
    args.push("--source", `${src.id}=${p}`);
  });
  const threshold = c.opts && c.opts.threshold !== undefined ? c.opts.threshold : 0.9;
  args.push("--threshold", String(threshold), "--json");
  return parseOutput(runCli(args), `corpus ${c.name}`);
}

function stdinCase(c) {
  const payload = JSON.stringify({ answer: c.answer ?? "", sources: c.sources ?? [], opts: c.opts ?? {} });
  const res = spawnSync(PY, ["-I", "-c", STDIN_BOOT], { ...SPAWN_OPTS, input: payload });
  return parseOutput(res, `corpus ${c.name}`);
}

function show(value) {
  const text = JSON.stringify(value);
  if (text === undefined) return String(value);
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

function firstDiff(a, b, path = "$") {
  if (a === b) return null;
  const kind = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
  const ka = kind(a);
  const kb = kind(b);
  if (ka !== kb) return `${path}: ${show(a)} != ${show(b)}`;
  if (ka === "array") {
    if (a.length !== b.length) return `${path}.length: ${a.length} != ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = firstDiff(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (ka === "object") {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    for (let i = 0; i < Math.min(keysA.length, keysB.length); i++) {
      if (keysA[i] !== keysB[i]) return `${path}.keys[${i}]: ${keysA[i]} != ${keysB[i]}`;
    }
    if (keysA.length !== keysB.length) return `${path}.keys: ${keysA.join(",")} != ${keysB.join(",")}`;
    for (const key of keysA) {
      const d = firstDiff(a[key], b[key], `${path}.${key}`);
      if (d) return d;
    }
    return null;
  }
  return `${path}: ${show(a)} != ${show(b)}`;
}

function mulberry32(a) {
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORD = /[\p{L}\p{Nd}]+/gu;
const QUOTED = /"[^"\n]*"|\u201c[^\u201d\n]*\u201d/gu;

const words = (text) => [...text.matchAll(WORD)];

function pick(rng, list) {
  return list[Math.floor(rng() * list.length)];
}

function splice(text, start, end, insert) {
  return text.slice(0, start) + insert + text.slice(end);
}

function dropWord(text, rng) {
  const found = words(text);
  if (!found.length) return text;
  const m = pick(rng, found);
  return splice(text, m.index, m.index + m[0].length, "");
}

function swapAdjacent(text, rng) {
  const found = words(text);
  if (found.length < 2) return text;
  const i = Math.floor(rng() * (found.length - 1));
  const a = found[i];
  const b = found[i + 1];
  return splice(text, a.index, b.index + b[0].length, `${b[0]}${text.slice(a.index + a[0].length, b.index)}${a[0]}`);
}

function replaceWord(text, rng) {
  const found = words(text);
  if (!found.length) return text;
  const m = pick(rng, found);
  return splice(text, m.index, m.index + m[0].length, `zq${Math.floor(rng() * 1000)}`);
}

function insertInsideQuote(text, rng) {
  const spans = [...text.matchAll(QUOTED)];
  if (!spans.length) return replaceWord(text, rng);
  const span = pick(rng, spans);
  const open = span[0][0];
  const close = span[0][span[0].length - 1];
  const inner = span[0].slice(1, -1);
  const found = words(inner);
  const at = found.length
    ? (() => {
        const m = pick(rng, found);
        return rng() < 0.5 ? m.index : m.index + m[0].length;
      })()
    : 0;
  const inserted = splice(inner, at, at, ` zq${Math.floor(rng() * 1000)} `);
  return splice(text, span.index, span.index + span[0].length, `${open}${inserted}${close}`);
}

function changeCase(text, rng) {
  const found = words(text);
  if (!found.length) return text;
  const m = pick(rng, found);
  const word = m[0];
  const swapped = word === word.toUpperCase() ? word.toLowerCase() : word.toUpperCase();
  return splice(text, m.index, m.index + word.length, swapped);
}

function curlyQuotes(text) {
  let open = true;
  return text.replace(/"/g, () => {
    const ch = open ? "\u201c" : "\u201d";
    open = !open;
    return ch;
  });
}

const SPACE_REPLACEMENTS = ["\n", "\r\n", "-\n", "\u00a0", "\u2028", "\ufeff"];

function replaceSpace(text, rng) {
  const spaces = [...text.matchAll(/ /g)];
  if (!spaces.length) return text;
  const m = pick(rng, spaces);
  return splice(text, m.index, m.index + 1, pick(rng, SPACE_REPLACEMENTS));
}

function combiningMark(text, rng) {
  const found = words(text);
  if (!found.length) return text;
  const m = pick(rng, found);
  return splice(text, m.index + 1, m.index + 1, "\u0301");
}

function astralOrLigature(text, rng) {
  const ligatureAt = [...text.matchAll(/fi/gu)];
  if (ligatureAt.length && rng() < 0.5) {
    const m = pick(rng, ligatureAt);
    return splice(text, m.index, m.index + 2, "\ufb01");
  }
  const found = words(text);
  if (!found.length) return `${text}\u{1f600}`;
  const m = pick(rng, found);
  return splice(text, m.index + m[0].length, m.index + m[0].length, "\u{1f600}");
}

function formFeed(text, rng) {
  const found = words(text);
  if (!found.length) return `\f${text}`;
  const m = pick(rng, found);
  return splice(text, m.index, m.index, "\f");
}

const TEXT_MUTATIONS = [
  dropWord,
  swapAdjacent,
  replaceWord,
  insertInsideQuote,
  changeCase,
  curlyQuotes,
  replaceSpace,
  combiningMark,
  astralOrLigature,
  formFeed,
];

function duplicateSource(sources) {
  if (!sources.length) return;
  const text = sources[0].text ?? "";
  sources[0] = { ...sources[0], text: `${text}${text}${text}` };
}

function emptySourceFirst(sources) {
  sources.unshift({ id: "empty", text: "" });
}

function applyMutation(rng, state) {
  const roll = rng();
  if (roll < 0.08) return duplicateSource(state.sources);
  if (roll < 0.16) return emptySourceFirst(state.sources);
  const mutate = pick(rng, TEXT_MUTATIONS);
  if (state.sources.length && rng() < 0.5) {
    state.sources[0] = { ...state.sources[0], text: mutate(state.sources[0].text ?? "", rng) };
    return;
  }
  state.answer = mutate(state.answer, rng);
}

function perturb(rng, cases) {
  const c = pick(rng, cases);
  const state = { answer: c.answer ?? "", sources: (c.sources ?? []).map((src) => ({ ...src })) };
  const count = 1 + Math.floor(rng() * 3);
  for (let i = 0; i < count; i++) applyMutation(rng, state);
  return { name: c.name, answer: state.answer, sources: state.sources, opts: c.opts ? JSON.parse(JSON.stringify(c.opts)) : {} };
}

const mismatches = [];
let total = 0;

const tmp = mkdtempSync(join(tmpdir(), "quote-check-parity-"));
try {
  for (const c of CASES) {
    total++;
    const viaPatterns = Boolean(c.opts && c.opts.patterns);
    let py;
    try {
      py = viaPatterns ? stdinCase(c) : cliCase(c, tmp);
    } catch (err) {
      mismatches.push(`corpus ${c.name}: python failed: ${err.message}`);
      continue;
    }
    const js = check(c.answer, c.sources, c.opts);
    if (JSON.stringify(py) !== JSON.stringify(js)) mismatches.push(`corpus ${c.name}: ${firstDiff(py, js)}`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const child = spawn(PY, ["-I", "-c", STREAM_BOOT], { cwd: pyDir, stdio: ["pipe", "pipe", "pipe"] });
let stderrText = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderrText += chunk;
});
child.stdin.on("error", () => {});

const queue = [];
let wake = null;
let exited = false;
const lines = createInterface({ input: child.stdout });
lines.on("line", (line) => {
  queue.push(line);
  if (wake) {
    const resume = wake;
    wake = null;
    resume();
  }
});
const settle = () => {
  exited = true;
  if (wake) {
    const resume = wake;
    wake = null;
    resume();
  }
};
child.on("exit", settle);
child.on("error", settle);

async function nextLine() {
  while (queue.length === 0) {
    if (exited) return null;
    await new Promise((resolve) => {
      wake = resolve;
    });
  }
  return queue.shift();
}

const rng = mulberry32(seed);
for (let i = 0; i < 200; i++) {
  total++;
  const { name, answer, sources, opts } = perturb(rng, CASES);
  child.stdin.write(`${JSON.stringify({ answer, sources, opts })}\n`);
  const line = await nextLine();
  if (line === null) {
    mismatches.push(`perturb #${i} (${name}): python exited: ${stderrText.trim().slice(0, 400)}`);
    break;
  }
  let py;
  try {
    py = JSON.parse(line);
  } catch {
    mismatches.push(`perturb #${i} (${name}): python emitted non-JSON: ${line.slice(0, 200)}`);
    continue;
  }
  const js = check(answer, sources, opts);
  if (JSON.stringify(py) !== JSON.stringify(js)) mismatches.push(`perturb #${i} (${name}): ${firstDiff(py, js)}`);
}

lines.close();
child.stdin.end();
child.kill();
child.unref();

for (const message of mismatches) console.log(`mismatch ${message}`);
console.log(`parity: ${total - mismatches.length}/${total} identical`);
process.exitCode = mismatches.length ? 1 : 0;