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
 * Usage: node scripts/check-public-hygiene.mjs [--no-denylist] [--rev <commit>] [--messages <range>]
 *   --rev scans the committed tree of <commit> instead of the working tree;
 *   --messages also scans the commit messages in <range> (e.g. origin/main..HEAD).
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
  /(^|\/)docs\/superpowers\//i,
  /(^|\/)\.superpowers\//i,
  /(^|\/)hand-?offs?\//i,
  /(^|\/)[^/]*hand-?off[^/]*\.(md|markdown|txt|html)$/i,
  /(^|\/)\.claude\//i,
];

// A literal piped (or here-stringed) into sudo reading stdin (-S, -kS, -Sk,
// --stdin): echo/printf/yes whose argument does not start with `$`.
// `echo "$VAR" | sudo -S` stays allowed.
const LIT = String.raw`(?:"(?!\\?\$)[^"\n]+"|'(?!\$)[^'\n]+'|(?![$"'])[^\s|;&]+)`;
const STDIN_FLAG = String.raw`(?:-[a-zA-Z]*S[a-zA-Z]*|--stdin)\b`;
const SUDO_PIPE = new RegExp(String.raw`\b(?:echo|printf|yes)\s+(?:-[a-zA-Z]+\s+)*(?:(?:'%s[^']*'|"%s[^"]*")\s+)?${LIT}\s*\|\s*(?:[^|\n]*?\s)?(?:\S*\/)?sudo\b[^\n|]*\s${STDIN_FLAG}`);
const SUDO_HERESTRING = new RegExp(String.raw`\bsudo\b[^\n|]*\s${STDIN_FLAG}[^\n]*<<<\s*${LIT}`);
const SSHPASS = /\bsshpass\s+-p|\bSSHPASS=(?!["']?\$)\S/;

// <host>.<tailnet>.ts.net, and a bare generated tailnet domain
// (two hyphenated words or tail + hex, then the ts.net suffix) with no host label.
const TAILNET_HOST = /\b[a-z0-9-]+\.([a-z0-9-]+)\.ts\.net\b/gi;
const TAILNET_BARE = /(?<![a-z0-9.-])([a-z]+-[a-z]+|tail[0-9a-f]{4,})\.ts\.net\b/gi;

export const SECRET_PATTERNS = [
  ["github token", /\bgh[opsur]_[A-Za-z0-9]{36}\b/g],
  ["github fine-grained token", /\bgithub_pat_[A-Za-z0-9_]{22,}/g],
  ["sk- api key", /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g],
  ["stripe live key", /\b[rs]k_live_[A-Za-z0-9]{24,}/g],
  ["tailscale auth key", /\btskey-[A-Za-z0-9-]{10,}/g],
  ["aws access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ["google api key", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["google oauth client secret", /\bGOCSPX-[A-Za-z0-9_-]{28}\b/g],
  ["google oauth access token", /\bya29\.[A-Za-z0-9_-]{20,}/g],
  ["brave search key", /\bBSA[A-Za-z0-9_-]{24,}\b/g],
  ["slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ["hugging face token", /\bhf_[A-Za-z]{34}\b/g],
  ["gitlab token", /\bglpat-[A-Za-z0-9_-]{20,}/g],
  ["npm token", /\bnpm_[A-Za-z0-9]{36}\b/g],
  ["nostr secret key", /\bnsec1[02-9ac-hj-np-z]{58}\b/g],
  ["discord webhook", /discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]{60,}/g],
  ["pem private key", /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/g],
  ["pgp private key", /-{5}BEGIN PGP PRIVATE KEY BLOCK-{5}/g],
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
    if (SUDO_PIPE.test(line) || SUDO_HERESTRING.test(line)) out.push({ path, line: n, rule: "literal piped into sudo -S" });
    if (SSHPASS.test(line)) out.push({ path, line: n, rule: "sshpass with an inline password" });
    for (const m of line.matchAll(TAILNET_HOST)) {
      if (!allow.tailnets.has(m[1].toLowerCase())) out.push({ path, line: n, rule: `tailnet hostname (tailnet label not allowlisted)` });
    }
    for (const m of line.matchAll(TAILNET_BARE)) {
      if (!allow.tailnets.has(m[1].toLowerCase())) out.push({ path, line: n, rule: `tailnet domain (not allowlisted)` });
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

function readTree(root, rev) {
  // [{ path, buf }] for every blob in <rev>, read with one `git cat-file --batch`.
  const git = (args, input) => execFileSync("git", args, { cwd: root, input, maxBuffer: 1024 * 1024 * 1024 });
  const entries = git(["ls-tree", "-r", "-z", rev]).toString("utf8").split("\0").filter(Boolean)
    .map((l) => { const [meta, path] = l.split("\t"); const [, type, sha] = meta.split(" "); return { path, type, sha }; })
    .filter((e) => e.type === "blob");
  const out = git(["cat-file", "--batch"], entries.map((e) => e.sha).join("\n") + "\n");
  let off = 0;
  for (const e of entries) {
    const nl = out.indexOf(10, off);
    const size = Number(out.subarray(off, nl).toString("utf8").split(" ")[2]);
    e.buf = out.subarray(nl + 1, nl + 1 + size);
    off = nl + 1 + size + 1;
  }
  return entries;
}

/**
 * Scan the tracked files of the working tree (default), or the committed tree
 * of `rev` (what a push would publish), plus optionally the commit messages
 * in `messages` (a rev range such as origin/main..HEAD).
 */
export function scanRepo({ root = REPO_ROOT, denylist = [], rev = null, messages = null } = {}) {
  const allowText = rev
    ? (() => { try { return execFileSync("git", ["show", `${rev}:scripts/public-hygiene-allowlist.txt`], { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString("utf8"); } catch { return ""; } })()
    : (existsSync(join(root, "scripts/public-hygiene-allowlist.txt")) ? readFileSync(join(root, "scripts/public-hygiene-allowlist.txt"), "utf8") : "");
  const allow = loadAllowlist(allowText);
  const entries = rev
    ? readTree(root, rev)
    : execFileSync("git", ["ls-files", "-z"], { cwd: root, maxBuffer: 64 * 1024 * 1024 })
      .toString("utf8").split("\0").filter(Boolean)
      .map((path) => { try { return { path, buf: readFileSync(join(root, path)) }; } catch { return { path, buf: null }; } });
  const violations = [];
  for (const { path, buf } of entries) {
    violations.push(...checkPath(path, denylist));
    if (!buf || isBinary(buf)) continue; // deleted in the worktree / dangling symlink, or binary
    violations.push(...checkContent(path, buf.toString("utf8"), { allow, denylist }));
  }
  if (messages) {
    const log = execFileSync("git", ["log", "--format=%H%n%B", messages], { cwd: root, maxBuffer: 64 * 1024 * 1024 }).toString("utf8");
    violations.push(...checkContent(`commit messages ${messages}`, log, { allow, denylist }));
  }
  return { files: entries.length, violations };
}

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : null;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const { list, source } = process.argv.includes("--no-denylist") ? { list: [], source: "disabled" } : loadDenylist();
  const rev = argValue("--rev");
  const { files, violations } = scanRepo({ denylist: list, rev, messages: argValue("--messages") });
  const what = rev ? `files at ${rev}` : "tracked files";
  if (violations.length) {
    console.error(`public-hygiene: ${violations.length} violation(s) in ${files} ${what} (denylist: ${source})`);
    for (const v of violations) console.error(`  ${v.path}${v.line ? `:${v.line}` : ""}  ${v.rule}`);
    process.exit(1);
  }
  console.log(`public-hygiene: OK — ${files} ${what} clean (denylist: ${source})`);
}
