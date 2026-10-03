/**
 * Compose-exact bundle .env codec.
 *
 * Crow writes every bundle .env value through encodeEnvValue and reads it back through
 * parseEnvText, so a value survives `docker compose` (both `${VAR}` interpolation and
 * `env_file:`), POSIX `set -a; . ./.env` (the hand-run post-install scripts) and Crow's
 * own readers byte-for-byte. Verified against Docker Compose v5.1.2 on crow (2026-10-03)
 * and pinned by tests/bundle-env-codec.test.js (real compose + real bash).
 *
 *   bare      A-Z a-z 0-9 _ . / : @ % + , = ^ ! ? * -   (no `~`: bash expands it)
 *   'single'  anything else without ' and not ending in \  (literal: no $ or ~ expansion)
 *   "double"  the rest, with \ " $ backslash-escaped
 *
 * PATH fields (pathEnvKeys: manifest `path: true`, or a `default` starting with `~/`) keep
 * a `~/…` value bare, because the post-install scripts that source .env rely on bash
 * expanding it to $HOME (frigate, motioneye). Every other tilde form is quoted.
 *
 * Refused (envValueProblem): CR, LF, NUL (one value per line), and a backtick in a value
 * that needs double quotes (it contains ' or ends in \), because `. ./.env` would execute
 * it there. NOT used for the gateway's own .env (literal loader, not a compose file).
 */
const BARE_SAFE = /^[A-Za-z0-9_./:@%+,=^!?*-]*$/;
const PATH_BARE = /^~\/[A-Za-z0-9_./:@%+,=^!?*-]*$/;
const BACKTICK = "`";
const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;
const DQ_ESCAPES = { "\\": "\\", '"': '"', $: "$", n: "\n", t: "\t", r: "\r" };

/** Why `value` cannot be written to a bundle .env, or null. Never includes the value. */
export function envValueProblem(value) {
  const s = String(value);
  if (/[\r\n\0]/.test(s)) return "contains a line break or NUL character";
  if (s.includes(BACKTICK) && (s.includes("'") || s.endsWith("\\"))) {
    return "cannot contain a backtick together with a single quote or a trailing backslash";
  }
  return null;
}

export function encodeEnvValue(value, { path = false } = {}) {
  const s = String(value);
  const problem = envValueProblem(s);
  if (problem) throw new Error(`env value ${problem}`);
  if (BARE_SAFE.test(s)) return s;
  if (path && PATH_BARE.test(s)) return s;
  if (!s.includes("'") && !s.endsWith("\\")) return `'${s}'`;
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$")}"`;
}

/**
 * The literal value for the text after `KEY=`, decoded the way compose's dotenv parser
 * decodes quoting and escapes. It does NOT perform compose's own `${VAR}` interpolation of
 * unquoted or double-quoted LEGACY values (no Crow writer emits such a value unescaped, and
 * the old raw readers did not interpolate either) — re-review m5.
 */
export function decodeEnvValue(raw) {
  const s = String(raw).trimStart();
  if (s.startsWith("'")) {
    let out = "";
    for (let i = 1; i < s.length; i++) {
      if (s[i] === "\\" && s[i + 1] === "'") { out += "'"; i++; continue; }
      if (s[i] === "'") return out;
      out += s[i];
    }
    return s; // unterminated: compose refuses the whole file; keep the raw text
  }
  if (s.startsWith('"')) {
    let out = "";
    for (let i = 1; i < s.length; i++) {
      if (s[i] === "\\" && i + 1 < s.length) {
        const n = s[i + 1];
        if (Object.hasOwn(DQ_ESCAPES, n)) { out += DQ_ESCAPES[n]; i++; continue; }
        out += "\\";
        continue;
      }
      if (s[i] === '"') return out;
      out += s[i];
    }
    return s;
  }
  return s.split(/\s+#/, 1)[0].trim();
}

/** KEY → decoded value. Last occurrence wins; comments, blank lines and CRs are skipped. */
export function parseEnvText(text) {
  const out = {};
  for (const line of String(text || "").split("\n")) {
    const m = line.replace(/\r$/, "").match(LINE);
    if (m) out[m[1]] = decodeEnvValue(m[2]);
  }
  return out;
}

/** Keys whose values are filesystem paths (bare `~/…` allowed). */
export function pathEnvKeys(manifest) {
  const out = new Set();
  for (const v of manifest?.env_vars || []) {
    if (!v || typeof v.name !== "string") continue;
    if (v.path === true || (typeof v.default === "string" && v.default.startsWith("~/"))) out.add(v.name);
  }
  return out;
}

const lineFor = (k, v, pathKeys) => `${k}=${encodeEnvValue(v, { path: !!pathKeys?.has?.(k) })}`;

/** One `KEY=<encoded>` line per entry (undefined/null skipped), newline-terminated. */
export function formatEnvLines(vars, { pathKeys = null } = {}) {
  const lines = [];
  for (const [k, v] of Object.entries(vars || {})) {
    if (v === undefined || v === null) continue;
    lines.push(lineFor(k, v, pathKeys));
  }
  return lines.length ? lines.join("\n") + "\n" : "";
}

/**
 * LINE-PRESERVING update of an existing .env text. Only the keys in `updates` (written
 * encoded) and `remove` (dropped) are touched; every other line — comments, legacy
 * unquoted values compose already interpolated, hand edits — stays byte-for-byte.
 * An updated key replaces its LAST occurrence (the one compose uses) in place; a new
 * key is appended. undefined/null updates are ignored; "" writes `KEY=`.
 */
export function updateEnvText(text, updates = {}, { pathKeys = null, remove = [] } = {}) {
  const src = String(text || "");
  const lines = src === "" ? [] : src.replace(/\n$/, "").split("\n");
  const drop = new Set(remove);
  const lastIdx = new Map();
  lines.forEach((line, i) => {
    const m = line.replace(/\r$/, "").match(LINE);
    if (m) lastIdx.set(m[1], i);
  });
  const out = [];
  lines.forEach((line, i) => {
    const m = line.replace(/\r$/, "").match(LINE);
    if (m && drop.has(m[1])) return;
    if (m && Object.hasOwn(updates, m[1]) && updates[m[1]] !== undefined && updates[m[1]] !== null) {
      if (lastIdx.get(m[1]) === i) out.push(lineFor(m[1], updates[m[1]], pathKeys));
      else out.push(line);
      return;
    }
    out.push(line);
  });
  for (const [k, v] of Object.entries(updates || {})) {
    if (v === undefined || v === null || drop.has(k) || lastIdx.has(k)) continue;
    out.push(lineFor(k, v, pathKeys));
  }
  return out.length ? out.join("\n") + "\n" : "";
}
