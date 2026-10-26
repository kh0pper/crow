/**
 * maskSecrets() — Crow's defensive second mask for text a bot controls
 * (approval/ask cards, "needs you" pushes, the log lines that print them).
 *
 * Contract with pi-lab (2026-10-26, the private engineering notes; final rules
 * of pi-lab's secret-mask.ts): pi-lab masks where it builds a confirm card;
 * Crow masks again on every path that turns that text into something stored
 * or sent. The RULES below are pi-lab's, so the two masks agree, and they keep
 * pi-lab's safety property: heuristic masking never hides anything that could
 * execute. In particular:
 *   - text piped or here-stringed into `sudo -S`, and heredoc bodies, have no
 *     pattern at all (with cached sudo credentials that text is the command's
 *     stdin, so it could be code): only exact values hide them;
 *   - every pattern candidate must be password-like (6-256 characters of a
 *     strict charset: no quote, backslash, whitespace, `$`, backtick or
 *     ;&|<>()) and must not be a host or a path;
 *   - PEM private keys only in their strict shape.
 * Exact values (servers/shared/secret-values.js) are the trusted path and
 * always mask, in raw, approvalText-escaped and JSON-escaped form, including
 * the leading part of a value cut by pi-lab's "…(N more characters)" marker.
 *
 * DISPLAY-ONLY. Callers mask a copy for display. Nothing that is sent back to
 * pi (a select option, an editor prefill) is ever masked here.
 *
 * Every regex is linear or bounded, and the cut-prefix match is a linear
 * prefix-function scan.
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

// ---- patterns (pi-lab's RULES) -------------------------------------------

/** One shell word on the display text: double-quoted, single-quoted, bare. */
const W = String.raw`"(?:[^"\\]|\\.)*"|'[^']*'|[^\s"';&|<>()]+`;

const PASSWORD_LIKE = /^[A-Za-z0-9._~!@#%^&*+=,:\/_-]{6,256}$/;
export function passwordLike(s) {
  return PASSWORD_LIKE.test(s);
}

/** A token that names a path, never a secret. */
function pathLike(s) {
  return /^(?:\/|~|\.\.?\/)/.test(s) || s.includes("://") || /^[\w.-]+(?:\/[\w.-]*)+$/.test(s);
}

/** Is [start,end) a host: after "://" (not user-info), after "user@", or the
 * first operand of ssh/scp/rsync/curl? */
function hostPosition(input, start, end) {
  const before = input.slice(Math.max(0, start - 300), start);
  const next = input[end] ?? "";
  if (/:\/\/$/.test(before)) return next !== "@" && next !== ":";
  if (/[A-Za-z0-9._-]@$/.test(before)) return true;
  return /(?:^|[\s'"(;&|])(?:ssh|scp|rsync|curl)\s+$/.test(before);
}

/** Mask one word at input[start…] if its content is password-like and not a
 * host or a path; quotes are kept. */
function maskWordAt(c, word, input, start) {
  const q = word[0];
  const quoted = (q === '"' || q === "'") && word.length >= 2 && word.endsWith(q);
  const inner = quoted ? word.slice(1, -1) : word;
  if (!passwordLike(inner) || pathLike(inner) || hostPosition(input, start, start + word.length)) return word;
  c.n++;
  return quoted ? q + REDACTED + q : REDACTED;
}

const LINE_BREAK = /\n|\\n/;

function startsLine(input, at) {
  if (at === 0 || input[at - 1] === "\n") return true;
  return input.slice(at - 2, at) === "\\n" && input[at - 3] !== "\\";
}

/** A PEM body as a real key file has it (see pi-lab pemShaped). */
export function pemShaped(body) {
  const lines = body.split(LINE_BREAK);
  if (lines.length < 4 || lines[0] !== "" || lines[lines.length - 1] !== "") return false;
  let rest = lines.slice(1, -1);
  let k = 0;
  while (k < rest.length && /^(?:Proc-Type|DEK-Info): [A-Za-z0-9,-]+$/.test(rest[k])) k++;
  if (k > 0 && rest[k] === "") k++;
  rest = rest.slice(k);
  if (rest.length < 2) return false;
  for (let i = 0; i < rest.length; i++) {
    const last = i === rest.length - 1;
    if (!/^[A-Za-z0-9+/=]+$/.test(rest[i])) return false;
    if (last ? rest[i].length > 64 : rest[i].length !== 64) return false;
  }
  return rest.join("").length >= 100;
}

/** pre + word rules: the word is the last group and ends the match. */
const wordRule = (re, ok = () => true) => [re, (c, mt, g, at, input) => {
  const pre = g[0];
  const w = g[g.length - 1];
  return ok(pre, w) ? pre + maskWordAt(c, w, input, at + mt.length - w.length) : mt;
}];

const RULES = [
  // PEM private key blocks, strict shape only; never to the end of the text.
  [/-----BEGIN ([A-Z0-9 ]*)PRIVATE KEY-----([\s\S]*?)-----END \1PRIVATE KEY-----/g, (c, mt, g, at, input) => {
    const [label, body] = g;
    if (!startsLine(input, at) || !pemShaped(body)) return mt;
    const sep = body.match(LINE_BREAK)[0];
    c.n++;
    return `-----BEGIN ${label}PRIVATE KEY-----${sep}${REDACTED}${sep}-----END ${label}PRIVATE KEY-----`;
  }],
  // sshpass with its password option, spaced or attached
  wordRule(new RegExp(String.raw`(\bsshpass\b[^|;&]{0,200}?\s-p\s*)(${W})`, "gi"), (pre) => /-p\s*$/.test(pre)),
  // mysql -pword (attached only: `-p word` makes `word` the database)
  wordRule(new RegExp(String.raw`(\b(?:mysql|mariadb|mysqldump|mysqladmin)\b[^|;&]{0,200}?\s-p)(${W})`, "gi"), (pre) => pre.endsWith("-p")),
  // --password=word, --password word, --passwd ...
  wordRule(new RegExp(String.raw`(--pass(?:word|wd)(?:=|\s+))(${W})`, "gi"), (_pre, w) => !w.startsWith("-")),
  // Authorization: Bearer|Basic|token <word>; X-Api-Key: <word>; ?token= / &token=
  wordRule(/(\bauthorization:\s*(?:bearer|basic|token)\s+)([^\s"';&|<>()]+)/gi),
  wordRule(/(\bx-api-key:\s*)([^\s"';&|<>()]+)/gi),
  wordRule(/([?&]token=)([^&\s"'#;|<>()]+)/gi),
  // NAME=value, NAME carrying PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|PRIVATE_?KEY,
  // or PASS as a whole _-segment, ending the name or followed by "_".
  wordRule(new RegExp(String.raw`(?<![\w$-])((?:[A-Za-z0-9_]{0,80}?(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|PRIVATE_?KEY)|(?:[A-Za-z0-9_]{0,80}_)?PASS)(?:_[A-Za-z0-9_]{0,80})?=)(${W})`, "gi")),
  // Known token shapes.
  [/(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|tk_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})(?![A-Za-z0-9])/gi,
    (c, mt, _g, at, input) => maskWordAt(c, mt, input, at)],
];

function maskPatterns(text, c) {
  let out = text;
  for (const [re, fn] of RULES) {
    re.lastIndex = 0;
    out = out.replace(re, (mt, ...g) => {
      const input = g.pop();
      const at = g.pop();
      return fn(c, mt, g.map((x) => (typeof x === "string" ? x : "")), at, input);
    });
  }
  return out;
}

// ---- exact values ----------------------------------------------------------

/** The forms a value takes in display text: raw, approvalText-escaped, and
 * JSON-escaped (a tool call's stringified args). */
function valueForms(v) {
  return new Set([v, displayEscape(v), JSON.stringify(v).slice(1, -1)]);
}

/** Exact values, longest first, in every form; split/join (no regex). */
function maskValues(text, values, c) {
  let t = text;
  for (const v of values) {
    for (const form of valueForms(v)) {
      if (!t.includes(form)) continue;
      const parts = t.split(form);
      c.n += parts.length - 1;
      t = parts.join(REDACTED);
    }
  }
  return maskCutPrefixes(t, values, c);
}

// pi-lab's sanitizeForDisplay cuts long model text and appends
// "…(N more characters)"; a value cut there leaves only its start, which an
// exact match cannot see.
const CUT_MARKER_RE = /…\(\d+ more characters\)/g;

/**
 * Length of the longest suffix of `text` (6+ chars, shorter than `form`) that
 * is a prefix of `form`: the KMP prefix function of form + NUL + tail, linear
 * in their lengths, so any value length is matched in bounded time.
 */
function cutPrefixLength(form, text) {
  if (form.length < 7) return 0;
  const tail = text.slice(-(form.length - 1));
  const s = form + "\u0000" + tail;
  const pi = new Int32Array(s.length);
  for (let i = 1; i < s.length; i++) {
    let k = pi[i - 1];
    while (k > 0 && s[i] !== s[k]) k = pi[k - 1];
    if (s[i] === s[k]) k++;
    pi[i] = k;
  }
  const k = pi[s.length - 1];
  return k >= 6 && k < form.length ? k : 0;
}

/** A value's leading 6+ characters right before a cut marker. */
function maskCutPrefixes(text, values, c) {
  if (!values.length || !text.includes("…(")) return text;
  let out = "";
  let pos = 0;
  CUT_MARKER_RE.lastIndex = 0;
  let mt;
  while ((mt = CUT_MARKER_RE.exec(text))) {
    let before = text.slice(pos, mt.index);
    let best = 0;
    for (const v of values) for (const form of valueForms(v)) best = Math.max(best, cutPrefixLength(form, before));
    if (best) { c.n++; before = before.slice(0, before.length - best) + REDACTED; }
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
  const c = { n: 0 };
  try {
    const values = opts.values === undefined ? currentValues() : opts.values;
    let t = maskValues(src, normalizeValues(values).filter((v) => v !== REDACTED), c);
    t = maskPatterns(t, c);
    return c.n ? { text: t, count: c.n } : { text: src, count: 0 };
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

/** A deep copy with every string leaf masked (display copies of JSON records).
 * Past 64 levels a subtree is replaced whole: never returned unmasked. */
export function maskDeep(v, opts) {
  const o = { values: opts && opts.values !== undefined ? opts.values : currentValues() };
  const walk = (x, depth) => {
    if (typeof x === "string") return maskSecrets(x, o);
    if (x == null || typeof x !== "object") return x;
    if (depth > 64) return REDACTED;
    if (Array.isArray(x)) return x.map((y) => walk(y, depth + 1));
    const out = {};
    for (const [k, y] of Object.entries(x)) out[k] = walk(y, depth + 1);
    return out;
  };
  return walk(v, 0);
}

function currentValues() {
  try { return getSecretValues(); } catch { return []; }
}
