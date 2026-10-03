/**
 * Fallback copy of the Crow .env codec's decode/encode (servers/gateway/bundle-env-codec.js),
 * used by ./configure-storage.mjs only when the Crow app cannot be found (an installed copy
 * run without CROW_APP_ROOT). tests/bundle-env-readers.test.js keeps it byte-for-byte
 * equivalent to the real codec on a fuzzed value set. Do not edit one without the other.
 */
const BARE_SAFE = /^[A-Za-z0-9_./:@%+,=^!?*-]*$/;
const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;
const DQ_ESCAPES = { "\\": "\\", '"': '"', $: "$", n: "\n", t: "\t", r: "\r" };

export function encodeEnvValue(value) {
  const s = String(value);
  if (/[\r\n\0]/.test(s)) throw new Error("env value contains a line break or NUL character");
  if (BARE_SAFE.test(s)) return s;
  if (!s.includes("'") && !s.endsWith("\\")) return `'${s}'`;
  if (s.includes("`")) throw new Error("env value cannot contain a backtick together with a single quote or a trailing backslash");
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$")}"`;
}

export function decodeEnvValue(raw) {
  const s = String(raw).trimStart();
  if (s.startsWith("'")) {
    let out = "";
    for (let i = 1; i < s.length; i++) {
      if (s[i] === "\\" && s[i + 1] === "'") { out += "'"; i++; continue; }
      if (s[i] === "'") return out;
      out += s[i];
    }
    return s;
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

export function parseEnvText(text) {
  const out = {};
  for (const line of String(text || "").split("\n")) {
    const m = line.replace(/\r$/, "").match(LINE);
    if (m) out[m[1]] = decodeEnvValue(m[2]);
  }
  return out;
}
