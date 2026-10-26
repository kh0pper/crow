/**
 * maskSecrets() — Crow's defensive second mask for text a bot controls
 * (approval/ask cards, "needs you" pushes, the log lines that print them).
 *
 * Contract with pi-lab (2026-10-26, the private engineering notes): pi-lab
 * masks where it builds a confirm card (approvalText); Crow masks again on
 * every path that turns that text into something stored or sent. The pattern
 * set here mirrors the contract's, each case-insensitive, and it works on
 * both raw text and pi-lab's escaped display text (a backslash doubled,
 * LF/CR/TAB shown as \n \r \t, anything else outside printable ASCII shown as
 * \u{hex}). On top of the patterns: exact values from the instance's secret
 * values (servers/shared/secret-values.js), in raw and escaped form.
 *
 * DISPLAY-ONLY. Callers mask a copy for display. Nothing that is sent back to
 * pi (a select option, an editor prefill) is ever masked here.
 *
 * Every regex is linear or bounded: no nested quantifiers over the same
 * characters, and the "is sudo reading stdin?" test is a token scan.
 */
import { getSecretValues, normalizeValues } from "./secret-values.js";

export const REDACTED = "[REDACTED]";

/** The contract's first-line note on a masked card. */
export function hiddenNote(n) {
  return `(${n} secret value(s) hidden from this card)`;
}
export const HIDDEN_NOTE_RE = /^\(\d+ secret value\(s\) hidden from this card\)/;

/** pi-lab's visibleChar(), so an exact value is found in escaped display text. */
export function displayEscape(text) {
  let out = "";
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0);
    if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (cp >= 0x20 && cp <= 0x7e) out += ch;
    else out += `\\u{${cp.toString(16)}}`;
  }
  return out;
}

// A shell word: double-quoted (also JSON-escaped \"…\", as in a tool call's
// stringified args), single-quoted, or bare (stops at space, quote, backslash,
// pipe, ; and &). Quotes never span a line.
const WORD = String.raw`(?:\\?"[^"\n]*?\\?"|'[^'\n]*'|(?:[^\s|;&'"\\]|\\(?!"))+)`;

/** Mask one word, keeping its quotes. Unchanged (and not counted) when it is
 * empty, a variable reference, or already masked. */
function maskWord(tok, hit) {
  const q = tok.startsWith('\\"') && tok.endsWith('\\"') && tok.length >= 4 ? '\\"'
    : (tok[0] === '"' || tok[0] === "'") && tok.length >= 2 && tok[tok.length - 1] === tok[0] ? tok[0] : "";
  const inner = q ? tok.slice(q.length, tok.length - q.length) : tok;
  if (!inner || inner.startsWith("$") || inner === REDACTED) return tok;
  hit();
  return q ? q + REDACTED + q : REDACTED;
}

/** Split a command segment into words, cut at a line end (a real newline or
 * an escaped `\n`) or the next command (`;`, `&&`, `||`). */
function segmentTokens(seg) {
  const cut = seg.search(/\n|\\n|;|&&|\|\|/);
  return (cut >= 0 ? seg.slice(0, cut) : seg).split(/\s+/).filter(Boolean);
}

const STDIN_FLAG_RE = /^(?:-[a-z]*s[a-z]*|--stdin)$/i;
/** True when the words run sudo with a read-password-from-stdin flag. */
function sudoReadsStdin(tokens) {
  const at = tokens.findIndex((t) => /(?:^|\/)sudo$/i.test(t));
  if (at < 0) return false;
  for (let i = at + 1; i < tokens.length; i++) {
    if (STDIN_FLAG_RE.test(tokens[i])) return true;
    if (!tokens[i].startsWith("-") && i > at + 4) break;
  }
  return false;
}

/** The text before `offset` on the same line and command (bounded). */
function commandBefore(text, offset) {
  const start = Math.max(0, offset - 400);
  const before = text.slice(start, offset);
  const after = (needle) => { const i = before.lastIndexOf(needle); return i < 0 ? 0 : i + needle.length; };
  return before.slice(Math.max(after("\n"), after("\\n"), after(";"), after("&&"), after("||")));
}

// echo|printf [flags] [format] WORD | ... sudo ... -S
const SUDO_PIPE_RE = new RegExp(String.raw`\b(echo|printf)((?:\s+-[a-z]+)*\s+)((?:'%s[^'\n]*'|"%s[^"\n]*")\s+)?(${WORD})(\s*\|)([^|\n]{0,400})`, "gi");
// sudo -S ... <<< WORD
const HERESTRING_RE = new RegExp(String.raw`<<<(\s*)(${WORD})`, "g");
// sudo -S ... <<[-]DELIM, then the body up to a line holding only DELIM
const HEREDOC_RE = /<<(?!<)-?[ \t]*(["']?)([A-Za-z_][A-Za-z0-9_]{0,40})\1/g;

/** [regex, replacer(matchArgs, hit)] — each replaces only the secret part. */
const SIMPLE = [
  // sshpass [opts] -p WORD | -pWORD
  [new RegExp(String.raw`(\bsshpass\b(?:\s+-[a-oq-z][^\s]*){0,6}\s+-p\s*)(${WORD})`, "gi"), (a, hit) => a[1] + maskWord(a[2], hit)],
  // mysql/mysqldump/mysqladmin ... -pWORD (no space: `-p WORD` prompts)
  [new RegExp(String.raw`(\bmysql(?:dump|admin)?\b[^|\n]{0,200}?\s-p)(?=[^\s-])(${WORD})`, "gi"), (a, hit) => a[1] + maskWord(a[2], hit)],
  // --password=WORD | --password WORD | --passwd ...
  [new RegExp(String.raw`(--pass(?:word|wd)(?:=|\s+))(${WORD})`, "gi"), (a, hit) => a[1] + maskWord(a[2], hit)],
  // Authorization: Bearer|Basic|token WORD ; X-Api-Key: WORD
  [/(\bauthorization:\s*(?:bearer|basic|token)\s+)([^\s'"]+)/gi, (a, hit) => a[1] + maskWord(a[2], hit)],
  [/(\bx-api-key:\s*)([^\s'"]+)/gi, (a, hit) => a[1] + maskWord(a[2], hit)],
  // ?token= &token= ?access_token= api_key= / apikey= query values
  [/([?&](?:access_)?token=|\bapi_?key=)([^&\s'"#]+)/gi, (a, hit) => a[1] + maskWord(a[2], hit)],
  // NAME=value where NAME names a secret (PGPASSWORD=, DB_PASS=, GH_TOKEN=, ...)
  [new RegExp(String.raw`(\b[A-Za-z_][A-Za-z0-9_]{0,80}=)(${WORD})`, "g"), (a, hit) => {
    const name = a[1].slice(0, -1);
    // The contract's name set, ending the name or a `_` part: PGPASSWORD,
    // DB_PASS, GH_TOKEN, TOKEN_FILE — but not MAX_TOKENS.
    return /(PASS|PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|PRIVATE_?KEY)(?:_[A-Za-z0-9_]*)?$/i.test(name) ? a[1] + maskWord(a[2], hit) : a[0];
  }],
  // Known token shapes.
  [/\bgh[opsur]_[A-Za-z0-9]{20,}\b/g, (a, hit) => (hit(), REDACTED)],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, (a, hit) => (hit(), REDACTED)],
  [/\btk_[A-Za-z0-9]{20,}\b/g, (a, hit) => (hit(), REDACTED)],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, (a, hit) => (hit(), REDACTED)],
  [/\bAKIA[0-9A-Z]{16}\b/g, (a, hit) => (hit(), REDACTED)],
  // PEM private-key blocks (raw newlines or escaped \n), to the matching END
  // or the end of the text.
  [/-{5}BEGIN ([A-Z0-9 ]{0,40})PRIVATE KEY-{5}[\s\S]*?(?:-{5}END \1PRIVATE KEY-{5}|$)/g, (a, hit) => (hit(), REDACTED)],
];

function replaceAll(text, re, fn) {
  re.lastIndex = 0;
  return text.replace(re, (...args) => fn(args));
}

function maskPatterns(text, hit) {
  let t = text;
  t = replaceAll(t, SUDO_PIPE_RE, (a) => {
    const [whole, cmd, flags, fmt, word, pipe, rest] = a;
    if (!sudoReadsStdin(segmentTokens(rest))) return whole;
    return cmd + flags + (fmt || "") + maskWord(word, hit) + pipe + rest;
  });
  t = replaceAll(t, HERESTRING_RE, (a) => {
    const [whole, sp, word] = a;
    const offset = a[a.length - 2];
    const src = a[a.length - 1];
    if (!sudoReadsStdin(segmentTokens(commandBefore(src, offset)))) return whole;
    return "<<<" + sp + maskWord(word, hit);
  });
  t = maskHeredocs(t, hit);
  for (const [re, fn] of SIMPLE) t = replaceAll(t, re, (a) => fn(a, hit));
  return t;
}

/** Mask the body of a heredoc fed to `sudo -S` (raw or escaped newlines). */
function maskHeredocs(text, hit) {
  let out = "";
  let pos = 0;
  HEREDOC_RE.lastIndex = 0;
  let mt;
  while ((mt = HEREDOC_RE.exec(text))) {
    const opEnd = mt.index + mt[0].length;
    if (!sudoReadsStdin(segmentTokens(commandBefore(text, mt.index)))) continue;
    // The body starts after the operator's line end.
    const nl = findLineEnd(text, opEnd);
    if (!nl) continue;
    const delim = mt[2];
    let bodyEnd = text.length;
    for (let scan = nl.next; ;) {
      const lineEnd = findLineEnd(text, scan);
      if (text.slice(scan, lineEnd ? lineEnd.at : text.length).trim() === delim) { bodyEnd = scan; break; }
      if (!lineEnd) break;
      scan = lineEnd.next;
    }
    const body = text.slice(nl.next, bodyEnd);
    // keep the line end that closes the body, so the delimiter stays on its line
    const tail = findTrailingLineEnd(body);
    if (!body || body.slice(0, body.length - tail.length) === REDACTED) continue;
    out += text.slice(pos, nl.next) + REDACTED + tail;
    hit();
    pos = bodyEnd;
    HEREDOC_RE.lastIndex = Math.max(HEREDOC_RE.lastIndex, bodyEnd);
  }
  return out + text.slice(pos);
}

function findLineEnd(text, from) {
  for (let i = from; i < text.length; i++) {
    if (text[i] === "\n") return { at: i, next: i + 1 };
    if (text[i] === "\\" && text[i + 1] === "n" && text[i - 1] !== "\\") return { at: i, next: i + 2 };
    if (text[i] === "\\" && text[i + 1] === "\\") i++;
  }
  return null;
}
function findTrailingLineEnd(body) {
  if (body.endsWith("\\n") && !body.endsWith("\\\\n")) return "\\n";
  if (body.endsWith("\n")) return "\n";
  return "";
}

/** Exact values, longest first, raw and escaped; split/join (no regex). */
function maskValues(text, values, hit) {
  let t = text;
  for (const v of values) {
    for (const form of new Set([v, displayEscape(v)])) {
      if (!t.includes(form)) continue;
      const parts = t.split(form);
      for (let i = 1; i < parts.length; i++) hit();
      t = parts.join(REDACTED);
    }
  }
  return maskCutPrefixes(t, values, hit);
}

// pi-lab's sanitizeForDisplay cuts long model text and appends
// "…(N more characters)"; a value cut there leaves only its start, which an
// exact match cannot see.
const CUT_MARKER_RE = /\u2026\(\d+ more characters\)/g;

/** A value's leading 6+ characters right before a cut marker. */
function maskCutPrefixes(text, values, hit) {
  if (!values.length || !text.includes("\u2026(")) return text;
  let out = "";
  let pos = 0;
  CUT_MARKER_RE.lastIndex = 0;
  let mt;
  while ((mt = CUT_MARKER_RE.exec(text))) {
    let before = text.slice(pos, mt.index);
    found: for (const v of values) {
      for (const form of new Set([v, displayEscape(v)])) {
        for (let k = Math.min(form.length - 1, before.length); k >= 6; k--) {
          if (before.endsWith(form.slice(0, k))) {
            hit();
            before = before.slice(0, before.length - k) + REDACTED;
            break found;
          }
        }
      }
    }
    out += before + mt[0];
    pos = mt.index + mt[0].length;
  }
  return out + text.slice(pos);
}


/**
 * @param {*} text
 * @param {{values?: string[]}} [opts] values overrides the instance list (tests)
 * @returns {{text: string, count: number}} count = spans masked
 */
export function maskSecretsDetailed(text, opts = {}) {
  const src = text == null ? "" : String(text);
  if (!src) return { text: src, count: 0 };
  let count = 0;
  const hit = () => { count++; };
  try {
    let values = opts.values;
    if (values === undefined) {
      try { values = getSecretValues(); } catch { values = []; }
    }
    let t = maskValues(src, normalizeValues(values).filter((v) => v !== REDACTED), hit);
    t = maskPatterns(t, hit);
    return { text: t, count };
  } catch {
    // A masking bug must never break a card, a push or a log line, and must
    // never let the unmasked text through either: fall back to a blank.
    return { text: REDACTED, count: 1 };
  }
}

/** The masked string (display only). */
export function maskSecrets(text, opts) {
  return maskSecretsDetailed(text, opts).text;
}

/** A deep copy with every string leaf masked (display copies of JSON records). */
export function maskDeep(v, opts, depth = 0) {
  if (typeof v === "string") return maskSecrets(v, opts);
  if (depth > 12 || v == null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => maskDeep(x, opts, depth + 1));
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = maskDeep(x, opts, depth + 1);
  return out;
}
