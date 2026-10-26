/**
 * maskSecrets() — Crow's defensive second mask for text a bot controls
 * (approval/ask cards, "needs you" pushes, the log lines that print them).
 *
 * Contract with pi-lab (2026-10-26, the private engineering notes; final rules
 * of pi-lab's secret-mask.ts): pi-lab masks where it builds a confirm card;
 * Crow masks again on every path that turns that text into something stored
 * or sent.
 *
 * Two modes. CARD mode (an approval card or an ask the operator answers):
 * only trusted exact values that are shell-safe (safeShape) hide text; no
 * pattern rule hides anything there (a hit is only counted, `possible`), so
 * nothing a bot chose can be hidden on what the operator approves. DISPLAY
 * mode (logs, notifications, transcripts, tool chips): every exact value plus
 * the pattern RULES below. The RULES are pi-lab's, so the two masks agree,
 * and they keep pi-lab's property that heuristic masking never hides
 * anything that could execute. In particular:
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
import { getCardValues, getSecretValues, normalizeValues, safeShape } from "./secret-values.js";

export const REDACTED = "[REDACTED]";

/** The contract's first-line note on a masked card. */
export function hiddenNote(n) {
  return `(${n} secret value(s) hidden from this card) This request contains a secret; approving runs it with the real, unmasked value.`;
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
  return leadingPath(s) || s.includes("://") || /^[\w.-]+(?:\/[\w.-]*)+$/.test(s);
}
/** In a context that already marks a credential (a secret-named assignment,
 * an Authorization header, --password ...) only an obvious path is exempt:
 * `abc/def123` there is a secret, not a path. */
function leadingPath(s) {
  return /^(?:\/|~|\.\.?\/)/.test(s);
}

/** Is [start,end) a host: after "://" (not user-info), after "user@", or the
 * first operand of ssh/scp/rsync/curl? */
function hostPosition(input, start, end) {
  // whitespace first, then a bounded window: `ssh` followed by any amount of
  // space still names a host
  let b = start;
  while (b > 0 && /\s/.test(input[b - 1])) b--;
  const before = input.slice(Math.max(0, b - 300), start);
  const next = input[end] ?? "";
  if (/:\/\/$/.test(before)) return next !== "@" && next !== ":";
  if (/[A-Za-z0-9._-]@$/.test(before)) return true;
  return /(?:^|[\s'"(;&|])(?:ssh|scp|rsync|curl)\s+$/.test(before);
}

/** Mask one word at input[start…] if its content is password-like and not a
 * host or a path; quotes are kept. */
function maskWordAt(c, word, input, start, credentialContext = false) {
  const q = word[0];
  const quoted = (q === '"' || q === "'") && word.length >= 2 && word.endsWith(q);
  const inner = quoted ? word.slice(1, -1) : word;
  const isPath = credentialContext ? leadingPath(inner) : pathLike(inner);
  if (!passwordLike(inner) || isPath || hostPosition(input, start, start + word.length)) return word;
  c.n++;
  return quoted ? q + REDACTED + q : REDACTED;
}

const LINE_BREAK = /\n|\\n/;

function startsLine(input, at) {
  if (at === 0 || input[at - 1] === "\n") return true;
  return input.slice(at - 2, at) === "\\n" && input[at - 3] !== "\\";
}

/** Body lines of a PEM block, a trailing CR (raw or displayed `\r`) stripped. */
function pemLines(body) {
  return body.split(LINE_BREAK).map((l) => l.replace(/(?:\r|\\r)$/, ""));
}

/** Base64 lines of one consistent width W (40-76: 64 for PEM, 70 for
 * OpenSSH, up to 76), the last 1-W. `partial` (a block cut before END): the
 * last line may be cut anywhere. Pure base64 lines cannot be a command. */
function base64Rows(rows, minTotal) {
  if (!rows.length) return false;
  const w = rows.length > 1 ? rows[0].length : 0;
  if (rows.length > 1 && (w < 40 || w > 76)) return false;
  for (let i = 0; i < rows.length; i++) {
    const last = i === rows.length - 1;
    if (!/^[A-Za-z0-9+/=]+$/.test(rows[i])) return false;
    if (!last && rows[i].length !== w) return false;
    if (last && rows.length > 1 && rows[i].length > w) return false;
  }
  return rows.join("").length >= minTotal;
}

/** A PEM body as a real key file has it (pi-lab pemShaped, widened to any
 * consistent width up to 76 and CRLF line ends). */
export function pemShaped(body) {
  const lines = pemLines(body);
  if (lines.length < 4 || lines[0] !== "" || lines[lines.length - 1] !== "") return false;
  let rest = lines.slice(1, -1);
  let k = 0;
  while (k < rest.length && /^(?:Proc-Type|DEK-Info): [A-Za-z0-9,-]+$/.test(rest[k])) k++;
  if (k > 0 && rest[k] === "") k++;
  rest = rest.slice(k);
  if (rest.length < 2) return false;
  return base64Rows(rest, 100);
}

/** A key block whose END was cut off (pi-lab's cut marker, or the end of the
 * text): hidden only when every visible body line is base64 of one width. */
function maskCutPem(text, c) {
  const BEGIN_RE = /-----BEGIN ([A-Z0-9 ]{0,40})PRIVATE KEY-----/g;
  let out = "";
  let pos = 0;
  let mt;
  while ((mt = BEGIN_RE.exec(text))) {
    const label = mt[1];
    const after = mt.index + mt[0].length;
    if (!startsLine(text, mt.index) || text.includes("-----END " + label + "PRIVATE KEY-----", after)) continue;
    const cut = text.slice(after).search(/\u2026\(\d+ more characters\)/);
    const end = cut < 0 ? text.length : after + cut;
    const lines = pemLines(text.slice(after, end));
    if (lines.length < 2 || lines[0] !== "") continue;
    const rows = lines.slice(1);
    if (rows[rows.length - 1] === "") rows.pop();
    if (!base64Rows(rows, 40) || (rows.length === 1 && rows[0].length < 40)) continue;
    const sep = text.slice(after).match(LINE_BREAK)[0];
    out += text.slice(pos, after) + sep + REDACTED;
    c.n++;
    pos = end;
    BEGIN_RE.lastIndex = end;
  }
  return out + text.slice(pos);
}

/** The gap between a command name and its -p flag: one character that does
 * not end the command. Not a real or displayed line break, a pipe or list
 * operator, a subshell, a substitution or a brace group, so the flag is the
 * named command's own and not the next command's. */
const GAP = String.raw`(?:(?!\\n)[^|;&\n()\`$\{\}])`;

/** pre + word rules: the word is the last group and ends the match. */
// A credential context narrows the path exemption to a leading /, ~, ./ or
// ../ on display paths only; on a card pi-lab's full pathLike applies (a URL
// or relative path there can be what runs: `X_TOKEN=https://…; curl $X_TOKEN | sh`).
const wordRule = (re, ok = () => true) => [re, (c, mt, g, at, input) => {
  const pre = g[0];
  const w = g[g.length - 1];
  return ok(pre, w, c, input) ? pre + maskWordAt(c, w, input, at + mt.length - w.length, !c.card) : mt;
}];

const RULES = [
  // PEM private key blocks, strict shape only; never to the end of the text.
  // Not on a card (see maskPatterns).
  [/-----BEGIN ([A-Z0-9 ]*)PRIVATE KEY-----([\s\S]*?)-----END \1PRIVATE KEY-----/g, (c, mt, g, at, input) => {
    const [label, body] = g;
    if (!startsLine(input, at) || !pemShaped(body)) return mt;
    const sep = body.match(LINE_BREAK)[0];
    c.n++;
    return `-----BEGIN ${label}PRIVATE KEY-----${sep}${REDACTED}${sep}-----END ${label}PRIVATE KEY-----`;
  }],
  // sshpass with its password option, spaced or attached
  // (no prefix rule crosses a real newline into the next line's command)
  wordRule(new RegExp(String.raw`(\bsshpass\b${GAP}{0,200}?[ \t]-p[ \t]*)(${W})`, "gi"), (pre) => /-p[ \t]*$/.test(pre)),
  // mysql -pword (attached only: `-p word` makes `word` the database)
  wordRule(new RegExp(String.raw`(\b(?:mysql|mariadb|mysqldump|mysqladmin)\b${GAP}{0,200}?[ \t]-p)(${W})`, "gi"), (pre) => pre.endsWith("-p")),
  // --password=word, --password word, --passwd ...
  wordRule(new RegExp(String.raw`(--pass(?:word|wd)(?:=|[ \t]+))(${W})`, "gi"), (_pre, w) => !w.startsWith("-")),
  // Authorization: Bearer|Basic|token <word>; X-Api-Key: <word>; ?token= / &token=
  wordRule(/(\bauthorization:[ \t]*(?:bearer|basic|token)[ \t]+)([^\s"';&|<>()]+)/gi),
  wordRule(/(\bx-api-key:[ \t]*)([^\s"';&|<>()]+)/gi),
  wordRule(/([?&]token=)([^&\s"'#;|<>()]+)/gi),
  // NAME=value, NAME carrying PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|PRIVATE_?KEY,
  // or PASS as a whole _-segment, ending the name or followed by "_". On a
  // card, not when $NAME / ${NAME} is used later: then the value is what runs
  // (`X_PASS=reboot; sudo $X_PASS`).
  wordRule(new RegExp(String.raw`(?<![\w$-])((?:[A-Za-z0-9_]{0,80}?(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|PRIVATE_?KEY)|(?:[A-Za-z0-9_]{0,80}_)?PASS)(?:_[A-Za-z0-9_]{0,80})?=)(${W})`, "gi"),
    (pre, _w, c, input) => !(c.card && new RegExp(String.raw`\$\{?${pre.slice(0, -1)}(?![A-Za-z0-9_])`).test(input))),
  // Known token shapes.
  [/(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|tk_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})(?![A-Za-z0-9])/gi,
    (c, mt, _g, at, input) => maskWordAt(c, mt, input, at)],
];

/**
 * `card`: the text is an approval card or an ask the operator answers. There
 * no PEM heuristic applies: each row of a key-shaped block is one shell word,
 * and a row can be a path (base64 includes "/") or a name planted in a PATH
 * dir the bot can write, so hiding rows could hide what runs. A key on a card
 * is hidden by exact values only. Display-only paths keep the PEM rules.
 */
function maskPatterns(text, c, card = false) {
  let out = text;
  for (const [re, fn] of card ? RULES.slice(1) : RULES) {
    re.lastIndex = 0;
    out = out.replace(re, (mt, ...g) => {
      const input = g.pop();
      const at = g.pop();
      return fn(c, mt, g.map((x) => (typeof x === "string" ? x : "")), at, input);
    });
  }
  return card ? out : maskCutPem(out, c);
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
    // On a card only a marker that ends the text counts: one a bot wrote
    // mid-text would make a guess at a secret's start show up as [REDACTED].
    if (c.card && mt.index + mt[0].length !== text.length) continue;
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
/** Longest text masked in full; longer input is cut first (display only). */
export const MAX_MASK_INPUT = 1024 * 1024;

export function maskSecretsDetailed(text, opts = {}) {
  let src = text == null ? "" : String(text);
  if (!src) return { text: src, count: 0 };
  // Longer input is cut first. The caller is told (`truncated`): a card cut
  // here must not be approved, since part of it was never seen.
  const truncated = src.length > MAX_MASK_INPUT;
  if (truncated) src = src.slice(0, MAX_MASK_INPUT) + "\u2026(" + (src.length - MAX_MASK_INPUT) + " more characters)";
  const c = { n: 0 };
  try {
    c.card = opts.card === true;
    const values = opts.values !== undefined ? opts.values : c.card ? currentCardValues() : currentValues();
    // On a card only shell-safe values hide text (safeShape); display paths
    // use every value, so a password with a space or `$` is still hidden there.
    const usable = normalizeValues(values).filter((v) => v !== REDACTED && (!c.card || safeShape(v)));
    let t = maskValues(src, usable, c);
    if (c.card) {
      // On a card only trusted exact values hide text: a pattern hit there is
      // text the bot wrote, so it stays visible (a bot could otherwise put
      // `X=$(curl …)` behind a secret-looking name). It is only counted, so
      // the card can say a possible secret is shown.
      const probe = { n: 0, card: true };
      maskPatterns(t, probe, true);
      if (truncated) return { text: t, count: c.n, truncated: true, possible: probe.n };
      return c.n || src !== text ? { text: t, count: c.n, possible: probe.n } : { text: src, count: 0, possible: probe.n };
    }
    t = maskPatterns(t, c, false);
    if (truncated) return { text: t, count: c.n, truncated: true };
    return c.n || src !== text ? { text: t, count: c.n } : { text: src, count: 0 };
  } catch {
    // A masking bug must never break a card, a push or a log line, and must
    // never let the unmasked text through either: a blank, flagged, so a card
    // can refuse to be approved unseen.
    return { text: REDACTED, count: 1, failed: true };
  }
}

/** The masked string (display only). `opts.card`: an approval card or ask (no PEM heuristic). */
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

function currentCardValues() {
  try { return getCardValues(); } catch { return []; }
}
