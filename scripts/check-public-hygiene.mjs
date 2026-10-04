#!/usr/bin/env node
/**
 * Public-repository hygiene check (CI static-checks + local pre-push).
 *
 * This repository is public. Process documents (specs, plans, handoffs,
 * ledgers) live in the private engineering repo, and no tracked file may carry
 * credentials or personal details. This check fails when:
 *
 *   1. a tracked path is a process document: anything under docs/superpowers/,
 *      any path with a handoffs/ directory, any *handoff*.md file, or anything
 *      under .claude/;
 *   2. a tracked text file pipes a literal into `sudo -S` (echo/printf of a
 *      value that is not a $variable), or passes an inline password to sshpass;
 *   3. a tracked text file names a real-looking tailnet host
 *      (<host>.<tailnet>.ts.net) whose tailnet label is not an allowlisted
 *      placeholder (scripts/public-hygiene-allowlist.txt, `tailnet:` lines);
 *   4. a tracked text file contains a high-entropy secret pattern (GitHub,
 *      OpenAI/Anthropic-style sk-, Tailscale auth keys, AWS, Google API,
 *      Brave Search, PEM private keys) that is not an allowlisted fake
 *      (`secret:` lines in the allowlist);
 *   5. LOCAL ONLY: a tracked path or text file contains a token from the
 *      optional untracked denylist file (~/.crow-public-denylist, one token per
 *      line, override with CROW_PUBLIC_DENYLIST). Skipped when CI is set.
 *      Denylisted tokens are never printed — only their line number.
 *
 * Usage: node scripts/check-public-hygiene.mjs [--no-denylist]
 * Exit 0 clean, 1 on any violation.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ALLOWLIST_PATH = join(REPO_ROOT, "scripts/public-hygiene-allowlist.txt");

export const PROCESS_DOC_PATTERNS = [
  /^docs\/superpowers\//,
  /(^|\/)handoffs\//i,
  /(^|\/)[^/]*handoff[^/]*\.md$/i,
  /^\.claude\//,
];

// A literal piped into sudo -S: echo/printf whose first argument does not
// start with `$` (optionally quoted). `echo "$VAR" | sudo -S` stays allowed.
const SUDO_LITERAL = /\b(?:echo|printf)\s+(?:-[a-zA-Z]+\s+)*(?:'%s\\?n?'\s+)?(?:"(?!\$)[^"\n]+"|'(?!\$)[^'\n]+'|(?![$"'])[^\s|;&]+)\s*\|\s*sudo\b[^\n|]*\s-S\b/;
const SSHPASS = /\bsshpass\s+-p/;

const TAILNET_HOST = /\b[a-z0-9-]+\.([a-z0-9-]+)\.ts\.net\b/gi;

export const SECRET_PATTERNS = [
  ["github token", /\bghp_[A-Za-z0-9]{36}\b/g],
  ["github fine-grained token", /\bgithub_pat_[A-Za-z0-9_]{22,}/g],
  ["sk- api key", /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g],
  ["tailscale auth key", /\btskey-[a-z]+-[A-Za-z0-9-]{10,}/g],
  ["aws access key", /\bAKIA[0-9A-Z]{16}\b/g],
  ["google api key", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["brave search key", /\bBSA[A-Za-z0-9_-]{24,}\b/g],
  ["pem private key", /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/g],
];

export function loadAllowlist(text) {
  const tailnets = new Set();
  const secrets = new Set();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(tailnet|secret):\s*(\S+)$/.exec(line);
    if (!m) continue;
    (m[1] === "tailnet" ? tailnets : secrets).add(m[1] === "tailnet" ? m[2].toLowerCase() : m[2]);
  }
  return { tailnets, secrets };
}

export function parseDenylist(text) {
  return text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && l.length >= 3);
}

export function checkPath(path, denylist = []) {
  const out = [];
  if (PROCESS_DOC_PATTERNS.some((re) => re.test(path))) {
    out.push({ path, line: 0, rule: "process document in the public repo (move it to the private engineering repo)" });
  }
  const lower = path.toLowerCase();
  denylist.forEach((tok, i) => {
    if (lower.includes(tok.toLowerCase())) out.push({ path, line: 0, rule: `denylisted token #${i + 1} in path` });
  });
  return out;
}

export function checkContent(path, text, { allow = { tailnets: new Set(), secrets: new Set() }, denylist = [] } = {}) {
  const out = [];
  const lowered = denylist.map((t) => t.toLowerCase());
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const n = i + 1;
    if (SUDO_LITERAL.test(line)) out.push({ path, line: n, rule: "literal piped into sudo -S" });
    if (SSHPASS.test(line)) out.push({ path, line: n, rule: "sshpass with an inline password" });
    for (const m of line.matchAll(TAILNET_HOST)) {
      if (!allow.tailnets.has(m[1].toLowerCase())) out.push({ path, line: n, rule: `tailnet hostname (tailnet label not allowlisted)` });
    }
    for (const [name, re] of SECRET_PATTERNS) {
      for (const m of line.matchAll(re)) {
        if (!allow.secrets.has(m[0])) out.push({ path, line: n, rule: `secret pattern: ${name}` });
      }
    }
    if (lowered.length) {
      const l = line.toLowerCase();
      lowered.forEach((tok, k) => {
        if (l.includes(tok)) out.push({ path, line: n, rule: `denylisted token #${k + 1}` });
      });
    }
  }
  return out;
}

function isBinary(buf) {
  return buf.subarray(0, 8000).includes(0);
}

export function loadDenylist(env = process.env) {
  if (env.CI) return { list: [], source: "skipped (CI)" };
  const file = env.CROW_PUBLIC_DENYLIST || join(homedir(), ".crow-public-denylist");
  if (!existsSync(file)) return { list: [], source: `none (${file} absent)` };
  return { list: parseDenylist(readFileSync(file, "utf8")), source: file };
}

export function scanRepo({ root = REPO_ROOT, denylist = [] } = {}) {
  const allow = existsSync(join(root, "scripts/public-hygiene-allowlist.txt"))
    ? loadAllowlist(readFileSync(join(root, "scripts/public-hygiene-allowlist.txt"), "utf8"))
    : loadAllowlist("");
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, maxBuffer: 64 * 1024 * 1024 })
    .toString("utf8").split("\0").filter(Boolean);
  const violations = [];
  for (const f of files) {
    violations.push(...checkPath(f, denylist));
    let buf;
    try { buf = readFileSync(join(root, f)); } catch { continue; } // deleted in the worktree, or a dangling symlink
    if (isBinary(buf)) continue;
    violations.push(...checkContent(f, buf.toString("utf8"), { allow, denylist }));
  }
  return { files: files.length, violations };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const { list, source } = process.argv.includes("--no-denylist") ? { list: [], source: "disabled" } : loadDenylist();
  const { files, violations } = scanRepo({ denylist: list });
  if (violations.length) {
    console.error(`public-hygiene: ${violations.length} violation(s) in ${files} tracked files (denylist: ${source})`);
    for (const v of violations) console.error(`  ${v.path}${v.line ? `:${v.line}` : ""}  ${v.rule}`);
    process.exit(1);
  }
  console.log(`public-hygiene: OK — ${files} tracked files clean (denylist: ${source})`);
}
