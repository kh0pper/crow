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
 *   5. a tracked text file names an email address at a personal mail domain
 *      (gmail.com, outlook.com, yahoo.*, icloud.com, proton.me, …) that is not
 *      an allowlisted placeholder (`email:` lines);
 *   6. a tracked text file contains a North American phone number (E.164
 *      +1XXXXXXXXXX or the (xxx) xxx-xxxx / xxx-xxx-xxxx / xxx.xxx.xxxx forms)
 *      outside the fictional 555-0100..555-0199 range, or a non-US E.164
 *      number, unless allowlisted (`phone:` lines, digits only);
 *   7. a tracked path is a mail-message export (.eml, .mbox, .msg, .mbx) or a
 *      tracked text file carries real-mail transport headers (a `Received:`,
 *      `DKIM-Signature:`, `ARC-Seal:` or `X-Received:` header line, or the same
 *      headers as Gmail-API JSON header objects (`"name"` set to one of them)): real
 *      correspondence must never be a fixture — write a synthetic one;
 *   Office/OpenDocument/zip containers (.docx, .xlsx, .pptx, .odt, .zip, …)
 *   are opened and their text parts checked against rules 3-8 (comment
 *   authors and document properties live there).
 *   8. LOCAL ONLY: a tracked path or text file contains a token from the
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
import { inflateRawSync, inflateSync } from "node:zlib";
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

// Personal mail domains. Matched on the domain after `@`; placeholders such as
// your-email@gmail.com go in the allowlist as `email:` lines.
const PERSONAL_MAIL_DOMAIN = String.raw`(?:g(?:oogle)?mail\.com|outlook\.(?:com|[a-z]{2})|hotmail\.(?:com|[a-z.]{2,6})|live\.(?:com|[a-z]{2})|msn\.com|yahoo\.(?:com|[a-z.]{2,6})|ymail\.com|aol\.com|icloud\.com|me\.com|mac\.com|proton(?:mail)?\.(?:me|com|ch)|pm\.me|gmx\.(?:com|net|de|at|ch)|web\.de|t-online\.de|rocketmail\.com|optonline\.net|earthlink\.net|yandex\.(?:com|ru)|mail\.ru|zoho\.com|fastmail\.(?:com|fm)|tutanota\.com|tuta\.io|hey\.com|comcast\.net|att\.net|verizon\.net|sbcglobal\.net|bellsouth\.net|cox\.net|charter\.net|qq\.com|163\.com)`;
// `@` also in its URL-encoded, JSON-escaped, HTML-entity and "[at]" spellings.
export const PERSONAL_EMAIL = new RegExp(String.raw`[A-Za-z0-9._%+-]+(?:@|%40|\\u0040|&#0*64;|&#x0*40;|\s?[\[(]at[\])]\s?)${PERSONAL_MAIL_DOMAIN}\b`, "gi");

// North American numbers in written forms, plus compact E.164 for any country.
// Digits are compared after stripping separators; 555-0100..0199 is the
// reserved fictional range and always passes.
const PB = String.raw`(?<![\d+.]|\d[\s.-])`; // not inside a longer number
const PA = String.raw`(?!\d|[.-]\d)`;          // an extension (x12) may follow
export const PHONE_PATTERNS = [
  new RegExp(String.raw`${PB}\+1[\s.-]?\(?[2-9]\d{2}\)?[\s.-]?\d{3}[\s.-]?\d{4}${PA}`, "g"),
  new RegExp(String.raw`${PB}\(\s?[2-9]\d{2}\s?\)[\s.-]?\d{3}[\s.-]?\d{4}${PA}`, "g"),
  new RegExp(String.raw`${PB}(?:1[\s.-])?[2-9]\d{2}[\s.-]\d{3}[\s.-]\d{4}${PA}`, "g"),
  // any other country, compact or grouped (digit count checked in isPhoneLength)
  new RegExp(String.raw`${PB}\+(?!1)[1-9]\d{0,3}(?:[\s.-]?\d{1,5}){1,6}${PA}`, "g"),
  // a bare 10-digit number next to a phone-ish key
  /\b(?:phone|tel|telephone|cell|mobile|fax|callback|sms|whatsapp)(?:_?number)?\b[^\n\d]{0,24}\+?1?[\s.-]?([2-9]\d{9})(?!\d)/gi,
];
const isPhoneLength = (d) => d.length >= 10 && d.length <= 15;
// Passes the reserved fictional ranges (NANP 555-0100..0199, UK drama
// 020 7946 0xxx) and NANP numbers that can never be assigned (an N11 or
// 0xx/1xx area code or exchange) — test values for dial-blocking rules.
export function isFictionalPhone(digits) {
  const d = digits.replace(/\D/g, "");
  if (/^4420794600\d{2}$|^442079460\d{3}$/.test(d)) return true;
  const local = d.length === 11 && d[0] === "1" ? d.slice(1) : d;
  if (local.length !== 10) return false;
  const area = local.slice(0, 3), exch = local.slice(3, 6);
  if (exch === "555" && /^01\d\d$/.test(local.slice(6))) return true;
  return /^[01]/.test(area) || /^[01]/.test(exch) || /^[2-9]11$/.test(area) || /^[2-9]11$/.test(exch);
}

export const MAIL_EXPORT_PATH = /\.(eml|mbox|mbx|msg)$/i;
const MAIL_HEADERS = String.raw`(?:Received|X-Received|DKIM-Signature|ARC-Seal|ARC-Message-Signature|ARC-Authentication-Results|Authentication-Results|Return-Path|X-Gm-[A-Za-z-]+|X-Google-[A-Za-z-]+|Delivered-To)`;
// at a line start (optionally quoted/indented) or after an escaped newline in a JSON/raw string
const MAIL_HEADER_LINE = new RegExp(String.raw`(?:^[\s>]*|\\r?\\n|\r?\n)${MAIL_HEADERS}:\s*\S`, "i");
const MAIL_HEADER_JSON = new RegExp(String.raw`"name"\s*:\s*"${MAIL_HEADERS}"`, "i");
const GMAIL_MESSAGE_ID = /Message-ID:\s*<[^>@\s]+@mail\.gmail\.com>/i;

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
  const emails = new Set();
  const phones = new Set();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(tailnet|secret|email|phone):\s*(\S+)$/.exec(line);
    if (!m) continue;
    if (m[1] === "tailnet") tailnets.add(m[2].toLowerCase());
    else if (m[1] === "secret") secrets.add(m[2]);
    else if (m[1] === "email") emails.add(m[2].toLowerCase());
    else phones.add(m[2].replace(/\D/g, ""));
  }
  return { tailnets, secrets, emails, phones };
}

export function parseDenylist(text) {
  return text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && l.length >= 3);
}

export function checkPath(path, denylist = []) {
  const out = [];
  if (PROCESS_DOC_PATTERNS.some((re) => re.test(path))) {
    out.push({ path, line: 0, rule: "process document in the public repo (move it to the private engineering repo)" });
  }
  if (MAIL_EXPORT_PATH.test(path)) {
    out.push({ path, line: 0, rule: "mail-message export in the public repo (use a synthetic fixture)" });
  }
  const lower = path.toLowerCase();
  denylist.forEach((tok, i) => {
    if (lower.includes(tok.toLowerCase())) out.push({ path, line: 0, rule: `denylisted token #${i + 1} in path` });
  });
  return out;
}

const EMPTY_ALLOW = { tailnets: new Set(), secrets: new Set(), emails: new Set(), phones: new Set() };

export function checkContent(path, text, { allow = EMPTY_ALLOW, denylist = [], light = false } = {}) {
  allow = { ...EMPTY_ALLOW, ...allow };
  const out = [];
  const lowered = denylist.map((t) => t.toLowerCase());
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const n = i + 1;
    if (!light && (SUDO_PIPE.test(line) || SUDO_HERESTRING.test(line))) out.push({ path, line: n, rule: "literal piped into sudo -S" });
    if (!light && SSHPASS.test(line)) out.push({ path, line: n, rule: "sshpass with an inline password" });
    for (const m of line.matchAll(TAILNET_HOST)) {
      if (!allow.tailnets.has(m[1].toLowerCase())) out.push({ path, line: n, rule: `tailnet hostname (tailnet label not allowlisted)` });
    }
    for (const m of line.matchAll(TAILNET_BARE)) {
      if (!allow.tailnets.has(m[1].toLowerCase())) out.push({ path, line: n, rule: `tailnet domain (not allowlisted)` });
    }
    for (const m of line.matchAll(PERSONAL_EMAIL)) {
      if (!allow.emails.has(m[0].toLowerCase())) out.push({ path, line: n, rule: "personal email address (use an example.com address or read it from config)" });
    }
    const phones = new Set();
    for (const re of light ? [] : PHONE_PATTERNS) {
      for (const m of line.matchAll(re)) {
        const digits = (m[1] || m[0].replace(/^[^\d+(]*/, "")).replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
        if (!isPhoneLength(digits)) continue;
        if (!isFictionalPhone(digits) && !allow.phones.has(digits) && !allow.phones.has(`1${digits}`)) phones.add(digits);
      }
    }
    for (const _ of phones) out.push({ path, line: n, rule: "phone number outside the fictional 555-0100..0199 range" });
    if (!light && MAIL_HEADER_LINE.test(line) || MAIL_HEADER_JSON.test(line) || GMAIL_MESSAGE_ID.test(line)) {
      out.push({ path, line: n, rule: "real-mail transport header (a captured message; use a synthetic fixture)" });
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

// Office / OpenDocument / zip containers hide text (comment authors, document
// properties) inside compressed parts, so a binary skip would miss them.
export const ZIP_CONTAINER = /\.(docx|docm|dotx|xlsx|xlsm|pptx|pptm|odt|ods|odp|epub|zip)$/i;
const ZIP_TEXT_PART = /\.(xml|rels|txt|json|csv|md|html?|vml|xhtml|opf|ncx)$/i;

/** [{ name, text }] for the text parts of a zip buffer (stored or deflated), nested zips included. */
export function zipTextParts(buf, depth = 0) {
  const out = [];
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return out;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let k = 0; k < count && p + 46 <= buf.length && buf.readUInt32LE(p) === 0x02014b50; k++) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString("utf8");
    p += 46 + nlen + xlen + clen;
    const nested = ZIP_CONTAINER.test(name);
    if ((!ZIP_TEXT_PART.test(name) && !nested) || buf.readUInt32LE(local) !== 0x04034b50) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    try {
      const data = method === 0 ? raw : method === 8 ? inflateRawSync(raw) : null;
      if (data && nested) { if (depth < 2) for (const p of zipTextParts(data, depth + 1)) out.push({ name: `${name}!${p.name}`, text: p.text }); }
      else if (data) out.push({ name, text: data.toString("utf8") });
    } catch { /* corrupt part: skip */ }
  }
  return out;
}

/** PNG tEXt / zTXt / iTXt chunks (author, comment, XMP). */
export function pngTextParts(buf) {
  const out = [];
  for (let p = 8; p + 12 <= buf.length;) {
    const len = buf.readUInt32BE(p), type = buf.subarray(p + 4, p + 8).toString("latin1");
    const data = buf.subarray(p + 8, p + 8 + len);
    try {
      if (type === "tEXt") out.push({ name: type, text: data.toString("latin1").replace("\0", ": ") });
      else if (type === "zTXt") { const k = data.indexOf(0); out.push({ name: type, text: inflateSync(data.subarray(k + 2)).toString("latin1") }); }
      else if (type === "iTXt") {
        const k = data.indexOf(0), compressed = data[k + 1] === 1;
        let q = data.indexOf(0, k + 3); q = data.indexOf(0, q + 1);
        const body = data.subarray(q + 1);
        out.push({ name: type, text: (compressed ? inflateSync(body) : body).toString("utf8") });
      }
    } catch { /* malformed chunk */ }
    if (type === "IEND") break;
    p += 12 + len;
  }
  return out;
}

/** PDF document-info strings and the XMP packet. */
export function pdfTextParts(buf) {
  const s = buf.toString("latin1");
  const info = [...s.matchAll(/\/(?:Author|Creator|Producer|Title|Subject|Keywords)\s*\(((?:\\.|[^\\)])*)\)/g)].map((m) => m[1]);
  const xmp = [...s.matchAll(/<x:xmpmeta[\s\S]*?<\/x:xmpmeta>/g)].map((m) => m[0]);
  return [...info, ...xmp].map((text, k) => ({ name: `meta${k}`, text }));
}

/** Printable runs from any other binary (EXIF, ID3, SQLite pages): checked for addresses and denylist only. */
function printableRuns(buf) {
  return buf.subarray(0, 1 << 20).toString("latin1").match(/[\x20-\x7e]{6,}/g) || [];
}

/**
 * The text a binary file carries, as [{ name, text, light }]. `light` parts
 * (raw printable runs) get only the address and denylist rules: phone-like
 * digit runs in binary data are mostly noise.
 */
export function binaryTextParts(path, buf) {
  if (buf.readUInt32LE(0) === 0x04034b50) return zipTextParts(buf);
  if (buf[0] === 0xff && buf[1] === 0xfe) return [{ name: "utf16le", text: buf.subarray(2).toString("utf16le") }];
  if (buf[0] === 0xfe && buf[1] === 0xff) return [{ name: "utf16be", text: Buffer.from(buf.subarray(2)).swap16().toString("utf16le") }];
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return pngTextParts(buf);
  if (buf.subarray(0, 5).toString("latin1") === "%PDF-") return pdfTextParts(buf);
  return [{ name: "strings", text: printableRuns(buf).join("\n"), light: true }];
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
    if (!buf || buf.length < 4) { if (buf) violations.push(...checkContent(path, buf.toString("utf8"), { allow, denylist })); continue; }
    if (isBinary(buf) || buf.readUInt32LE(0) === 0x04034b50) {
      // Binary: office/zip containers, UTF-16 text, PNG text chunks, PDF metadata, and printable runs of anything else.
      for (const part of binaryTextParts(path, buf)) {
        violations.push(...checkContent(`${path}!${part.name}`, part.text, { allow, denylist, light: part.light }));
      }
      continue;
    }
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
