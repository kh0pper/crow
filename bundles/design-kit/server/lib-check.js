// Design kit — library integrity (spec §3.2, §7). The rules CI enforces on
// bundles/design-kit/lib/ (scripts/check-design-kit-lib.mjs) and the hash check
// the kit repeats when it copies a file. node: imports only: the installed copy,
// the CI script and the vendor script all load this file directly.
//
// CSS and SVG are checked against a fail-closed ALLOWLIST, not a blocklist, so
// the vendor step (scripts/design-kit/vendor-lib.mjs) must normalize what it
// copies: UTF-8 or ASCII with no BOM; LF line endings (no CRLF, no tabs: CSS
// may hold only LF as a control character); all /* comments */ stripped
// (licence text lives under licenses/); no backslash escapes outside quoted
// strings; no @import, @namespace, image(), image-set(), src(), cross-fade() or
// element(); every url() a relative path ([A-Za-z0-9._/-], no query, no colon)
// or a base64 raster data: URL; and no quoted string containing "://" (so
// inline SVG data: URLs with an xmlns must be rewritten or dropped). No
// non-ASCII outside CSS strings. SVG icons pass an element/attribute allowlist
// (see svgUnsafe): no entities, style attributes, comments after the root
// starts, or references other than url(#id) and <use href="#id">. Tabs and CRs
// are fine in SVG.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";

export const LICENSE_IDS = new Set(["OFL-1.1", "MIT", "ISC", "BSD-3-Clause", "Apache-2.0"]);
export const TARGETS = new Set(["page", "document", "diagram"]);
export const KIND_PREFIX = Object.freeze({ font: "font:", css: "css:", "icon-set": "icons:", theme: "theme:", script: "" });
export const CONTENT_TYPES = new Set(["font/woff2", "text/css", "application/json", "text/javascript", "image/svg+xml"]);
export const LICENCE_TYPE = "text/plain; charset=utf-8";
export const FONT_FALLBACKS = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy"]);
export const NAME_RE = /^(?:font:|css:|icons:|theme:)?[a-z0-9][a-z0-9-]{0,39}$/;
const SOURCE_RE = /^(?:npm:(?:@[a-z0-9-]+\/)?[a-z0-9._-]+@\d+\.\d+\.\d+|github:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}|crow:generated)$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const SEG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const FAMILY_RE = /^[A-Za-z0-9 ]{1,60}$/;

export const sha256Hex = (buf) => createHash("sha256").update(buf).digest("hex");

/** A plain relative path of safe segments, or null. */
export function cleanLibPath(p) {
  if (typeof p !== "string" || !p || p.length > 200) return null;
  return p.split("/").every((s) => SEG_RE.test(s) && s !== "." && s !== "..") ? p : null;
}

function walk(dir, root = dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, root, out);
    else out.push(relative(root, p).split(sep).join("/"));
  }
  return out;
}

/** Decode file bytes as strict UTF-8 with no BOM (UTF-8 or UTF-16), or null.
 *  A string is taken as already decoded. */
function decodeText(input) {
  if (typeof input === "string") return input.startsWith("﻿") ? null : input;
  const b = Buffer.from(input);
  if ((b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) || (b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff)) return null;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(b); } catch { return null; }
}

// CSS allows only LF among the control characters (CR, FF and TAB end or alter
// tokens differently in browsers than in a hand-written scanner; DEL and NUL are
// stripped or replaced). SVG may also carry TAB and CR.
const CSS_BAD_CHARS = /[\u0000-\u0009\u000b-\u001f\u007f]/;
const SVG_BAD_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const REL_TARGET = /^(?:\.{1,2}\/)*[A-Za-z0-9._/-]+$/;
const RASTER_DATA = /^data:image\/(?:png|gif|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
// Functions that fetch (or can be handed a string to fetch) other than url().
const FORBIDDEN_CSS = ["@import", "@namespace", "image(", "image-set(", "src(", "cross-fade(", "element("];

/** Walk CSS tokens. Returns the quoted string contents, or null when a comment,
 *  a backslash or a non-ASCII character appears outside a string, or a string
 *  never closes. A string
 *  ends at its closing quote; a newline inside one is refused. */
function cssStrings(css) {
  const out = [];
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    // Non-ASCII outside a string is refused: no legitimate vendored selector or
    // value needs it, and it keeps the scan free of Unicode case-mapping tricks.
    if (c === "\\" || (c === "/" && css[i + 1] === "*") || c.charCodeAt(0) > 0x7e) return null;
    if (c !== '"' && c !== "'") continue;
    let j = i + 1;
    let body = "";
    for (; j < css.length && css[j] !== c; j++) {
      if (css[j] === "\n") return null;
      if (css[j] === "\\") { body += css[j++]; }
      body += css[j] ?? "";
    }
    if (j >= css.length) return null;
    out.push(body);
    i = j;
  }
  return out;
}

/** True when CSS may fetch at runtime, or is not in the plain shape the vendor
 *  step produces. A fail-closed ALLOWLIST (spec §3.2): valid UTF-8 without a
 *  BOM; LF the only control character; no comments and no backslash outside a
 *  quoted string; no @import/@namespace/image()/image-set()/src()/cross-fade()/
 *  element(); no non-ASCII outside strings; every url() target a relative path (or a base64 raster data:
 *  URL); and no quoted string that holds "://" or begins with "//". Accepts
 *  bytes (preferred; checks the encoding) or an already decoded string. */
export function cssFetches(input) {
  const css = decodeText(input);
  if (css === null || CSS_BAD_CHARS.test(css)) return true;
  const strings = cssStrings(css);
  if (!strings) return true;
  for (const t of strings) if (t.includes("://") || t.trimStart().startsWith("//")) return true;
  // ASCII-only lower-casing: String#toLowerCase can change the length (U+0130
  // becomes two code units), which would shift the offsets used to slice
  // url() targets out of the original text.
  const low = css.replace(/[A-Z]/g, (ch) => ch.toLowerCase());
  if (FORBIDDEN_CSS.some((f) => low.includes(f))) return true;
  for (let i = low.indexOf("url("); i >= 0; i = low.indexOf("url(", i + 4)) {
    const end = low.indexOf(")", i);
    if (end < 0) return true;
    let t = css.slice(i + 4, end).trim();
    const q = t[0];
    if (q === '"' || q === "'") {
      if (t.length < 2 || t[t.length - 1] !== q) return true;
      t = t.slice(1, -1);
    }
    const okRel = REL_TARGET.test(t) && !t.includes("//") && !t.startsWith("/");
    if (!okRel && !RASTER_DATA.test(t)) return true;
  }
  return false;
}

// SVG is an ALLOWLIST too: a tag tokenizer that accepts only these elements
// and attributes. Checked against the per-icon files of lucide-static@1.57.0
// and @tabler/icons@3.49.0 (svg, path, circle, rect, line, polyline, polygon,
// ellipse; class, xmlns, width, height, viewBox, fill, stroke*, d, cx, cy, r,
// rx, ry, x, y, points, opacity).
const SVG_ELEMENTS = new Set(["svg", "path", "circle", "rect", "line", "polyline", "polygon", "ellipse", "g", "defs",
  "linearGradient", "radialGradient", "stop", "clipPath", "mask", "use", "title", "desc"]);
const SVG_ATTRS = new Set(["xmlns", "xmlns:xlink", "viewBox", "width", "height", "fill", "stroke", "stroke-width",
  "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "stroke-dasharray", "stroke-dashoffset", "fill-rule",
  "clip-rule", "opacity", "fill-opacity", "stroke-opacity", "d", "cx", "cy", "r", "rx", "ry", "x", "y", "x1", "y1",
  "x2", "y2", "points", "transform", "class", "id", "offset", "stop-color", "stop-opacity", "gradientUnits",
  "gradientTransform", "clip-path", "mask", "version", "href", "xlink:href"]);
// Namespace names, not fetches (written as regexes so checkNoRemoteRefs, which
// scans this file, does not read them as remote URLs).
const SVG_NS = { xmlns: /^http:\/\/www\.w3\.org\/2000\/svg$/, "xmlns:xlink": /^http:\/\/www\.w3\.org\/1999\/xlink$/ };
const ID_REF = /^#[A-Za-z0-9_-]+$/;
const URL_ID = /^url\(#[A-Za-z0-9_-]+\)$/;
// Plain attribute values: no quotes, "<", "&", "\", ":" or "/" (only xmlns,
// matched exactly above, needs those). Parentheses are checked separately.
const SVG_VALUE = /^[A-Za-z0-9 \t\r\n.,%#+_()-]*$/;
const TRANSFORM_FNS = new Set(["matrix", "translate", "scale", "rotate", "skewX", "skewY"]);
const COLOR_FNS = new Set(["rgb", "rgba", "hsl", "hsla"]);
const COLOR_ATTRS = new Set(["fill", "stroke", "stop-color"]);
const PAINT_REF_ATTRS = new Set(["fill", "stroke", "clip-path", "mask"]);
// Optional leading XML declaration, then optional comments of a narrow charset
// (Lucide ships "<!-- @license lucide-static vX - ISC -->"), all before the root.
const XML_DECL = /<\?xml(?:[ \t\r\n]+(?:version|encoding|standalone)[ \t\r\n]*=[ \t\r\n]*(?:"[A-Za-z0-9._-]*"|'[A-Za-z0-9._-]*'))*[ \t\r\n]*\?>/y;
// One character class per step (no nested quantifiers), and no "--" inside.
const LEAD_COMMENT = /[ \t\r\n]*<!--(?:[ A-Za-z0-9@.,_]|-(?!-))*-->/y;
const WS = /[ \t\r\n]*/y;
const END_TAG = /\/([A-Za-z]+)[ \t\r\n]*>/y;
const TAG_NAME = /[A-Za-z]+/y;
const ATTR = /([A-Za-z][A-Za-z0-9:-]*)[ \t\r\n]*=[ \t\r\n]*(["'])/y;
const sticky = (re, s, i) => { re.lastIndex = i; return re.exec(s); };

function svgValueOk(el, name, v) {
  if (name === "xmlns" || name === "xmlns:xlink") return SVG_NS[name].test(v);
  if (name === "href" || name === "xlink:href") return el === "use" && ID_REF.test(v);
  if (!SVG_VALUE.test(v)) return false;
  if (!v.includes("(") && !v.includes(")")) return true;
  if (PAINT_REF_ATTRS.has(name) && URL_ID.test(v)) return true;
  // Otherwise only known function names, each called once with plain numbers.
  const fns = name === "transform" || name === "gradientTransform" ? TRANSFORM_FNS : COLOR_ATTRS.has(name) ? COLOR_FNS : null;
  if (!fns) return false;
  const rest = v.replace(/([A-Za-z]+)\(([0-9 \t\r\n.,%+eE-]*)\)/g, (m, f) => (fns.has(f) ? "" : "("));
  return !rest.includes("(") && !rest.includes(")");
}

/** True when an SVG is not a plain, inert icon. A fail-closed ALLOWLIST: valid
 *  UTF-8 without a BOM; no "&" (so no entities) and no backslash anywhere; an
 *  optional leading XML declaration and leading plain comments, then exactly
 *  one <svg> root built only from SVG_ELEMENTS with SVG_ATTRS (double- or
 *  single-quoted values, read up to the closing quote so newlines cannot hide
 *  anything); no style attribute, doctype, CDATA, processing instruction or
 *  later comment; text only inside <title>/<desc>; href/xlink:href only on
 *  <use> and only "#id"; any url() exactly url(#id). */
export function svgUnsafe(input) {
  const svg = decodeText(input);
  if (svg === null || SVG_BAD_CHARS.test(svg) || svg.includes("&") || svg.includes("\\")) return true;
  let i = 0;
  const decl = sticky(XML_DECL, svg, 0);
  if (decl) i = decl[0].length;
  for (let m; (m = sticky(LEAD_COMMENT, svg, i)); ) i += m[0].length;
  const stack = [];
  let rootDone = false;
  while (i < svg.length) {
    const lt = svg.indexOf("<", i);
    const text = svg.slice(i, lt < 0 ? svg.length : lt);
    const inText = stack.length && (stack.at(-1) === "title" || stack.at(-1) === "desc");
    if (text.trim() && !inText) return true;
    if (text.includes(">") && !inText) return true;
    if (lt < 0) break;
    i = lt + 1;
    if (svg[i] === "/") {
      const m = sticky(END_TAG, svg, i);
      if (!m || stack.pop() !== m[1]) return true;
      i += m[0].length;
      if (!stack.length) rootDone = true;
      continue;
    }
    const nm = sticky(TAG_NAME, svg, i);
    if (!nm || rootDone || !SVG_ELEMENTS.has(nm[0])) return true;
    const el = nm[0];
    if (stack.length === 0 && el !== "svg") return true;
    if (inText) return true;
    i += el.length;
    const seen = new Set();
    for (;;) {
      const ws = sticky(WS, svg, i)[0];
      i += ws.length;
      if (svg.startsWith("/>", i)) { i += 2; if (!stack.length) rootDone = true; break; }
      if (svg[i] === ">") { i += 1; stack.push(el); break; }
      if (!ws) return true;
      const a = sticky(ATTR, svg, i);
      if (!a || !SVG_ATTRS.has(a[1]) || seen.has(a[1])) return true;
      seen.add(a[1]);
      i += a[0].length;
      const close = svg.indexOf(a[2], i);
      if (close < 0) return true;
      const v = svg.slice(i, close);
      if (v.includes("<") || !svgValueOk(el, a[1], v)) return true;
      i = close + 1;
    }
  }
  return !rootDone || stack.length > 0;
}

export function checkLib(libDir) {
  const errors = [];
  const fail = (m) => errors.push(m);
  let man;
  try { man = JSON.parse(readFileSync(join(libDir, "manifest.json"), "utf8")); }
  catch (e) { return { errors: [`manifest.json: ${e.message}`], entries: 0 }; }
  if (man.schema !== 1 || !Array.isArray(man.entries)) return { errors: ["manifest.json: schema 1 with an entries list expected"], entries: 0 };
  const listed = new Set(["manifest.json"]);
  const names = new Set(man.entries.map((e) => e && e.name));
  const seen = new Set();
  const verify = (where, f) => {
    const p = cleanLibPath(f && f.path);
    if (!p) return fail(`${where}: bad path ${JSON.stringify(f && f.path)}`);
    listed.add(p);
    const abs = join(libDir, p);
    if (!existsSync(abs)) return fail(`${where}: missing file ${p}`);
    const body = readFileSync(abs);
    if (sha256Hex(body) !== f.sha256) fail(`${where}: sha256 mismatch for ${p}`);
    if (f.type === "text/css" && cssFetches(body)) fail(`${where}: ${p} would fetch at runtime or is not plain CSS (see the lib-check.js header)`);
    if (f.type === "image/svg+xml" && svgUnsafe(body)) fail(`${where}: ${p} is not a plain SVG (see the lib-check.js header)`);
  };
  for (const e of man.entries) {
    const where = e && typeof e.name === "string" ? e.name : "(unnamed entry)";
    if (!e || !NAME_RE.test(String(e.name))) { fail(`${where}: bad name`); continue; }
    if (seen.has(e.name)) fail(`${where}: duplicate name`);
    seen.add(e.name);
    if (!Object.hasOwn(KIND_PREFIX, e.kind)) fail(`${where}: unknown kind ${e.kind}`);
    else if (KIND_PREFIX[e.kind] ? !e.name.startsWith(KIND_PREFIX[e.kind]) : e.name.includes(":")) fail(`${where}: name does not match kind ${e.kind}`);
    if (!VERSION_RE.test(String(e.version))) fail(`${where}: version must be exact x.y.z`);
    if (!LICENSE_IDS.has(e.license)) fail(`${where}: licence ${e.license} is not on the allowlist`);
    const lf = cleanLibPath(e.license_file);
    if (lf && !lf.startsWith("licenses/")) fail(`${where}: licence file must live under licenses/`);
    if (!lf || !existsSync(join(libDir, lf)) || !readFileSync(join(libDir, lf), "utf8").trim()) fail(`${where}: licence file missing or empty`);
    else {
      listed.add(lf);
      // Licence texts travel with every copy (review M9), so they are hash-pinned like code.
      if (sha256Hex(readFileSync(join(libDir, lf))) !== e.license_sha256) fail(`${where}: licence sha256 mismatch for ${lf}`);
    }
    for (const n of e.notices || []) {
      const np = cleanLibPath(n && n.path);
      if (!np || !np.startsWith("licenses/")) { fail(`${where}: notices must live under licenses/`); continue; }
      verify(where, { ...n, type: "text/plain" });
    }
    if (!SOURCE_RE.test(String(e.source))) fail(`${where}: source must be an exact pin (npm:pkg@x.y.z, github:owner/repo@<40-hex>, crow:generated)`);
    if (!Array.isArray(e.allowed) || !e.allowed.length || e.allowed.some((t) => !TARGETS.has(t))) fail(`${where}: allowed must be a non-empty subset of page, document, diagram`);
    if (e.kind === "font") {
      if (!FAMILY_RE.test(String(e.family))) fail(`${where}: font family must be letters, digits and spaces`);
      if (!FONT_FALLBACKS.has(e.fallback)) fail(`${where}: font fallback must be a generic family`);
    }
    if (!Array.isArray(e.files) || !e.files.length) { fail(`${where}: no files`); continue; }
    for (const f of e.files) {
      if (!CONTENT_TYPES.has(f && f.type)) fail(`${where}: ${f && f.path}: type ${f && f.type} not allowed`);
      verify(where, f);
    }
    if (!e.files.some((f) => f.path === e.main)) fail(`${where}: main must be one of its files`);
    for (const r of e.requires || []) if (!names.has(r)) fail(`${where}: requires unknown ${r}`);
  }
  for (const m of man.meta_files || []) {
    if (!CONTENT_TYPES.has(m && m.type)) fail(`meta_files: ${m && m.path}: type ${m && m.type} not allowed`);
    verify("meta_files", m);
  }
  for (const p of existsSync(libDir) ? walk(libDir) : []) if (!listed.has(p)) fail(`unlisted file in lib/: ${p}`);
  return { errors, entries: man.entries.length };
}

/** The kit's own code and skills never name a remote host (spec §3.2 "no entry
 *  is fetched at runtime"). Loopback URLs are allowed (the renderer). The
 *  Dockerfile's build-time download is not runtime and is not scanned. */
const HOSTS_OK = new Set(["127.0.0.1", "localhost", "[::1]"]);
// A scheme followed by a slash pair and an authority, or a protocol-relative
// authority introduced by a quote, paren or equals sign.
const REMOTE_REF = /(?:\b[a-z][a-z0-9+.-]*:\/\/|["'`(=]\s*\/\/)([^\s"'`<>)\/?#\\]+)/gi;
function namesRemoteHost(text) {
  for (const m of text.matchAll(REMOTE_REF)) {
    // Authority = userinfo@host:port; the host is what follows the LAST "@".
    const hostport = m[1].slice(m[1].lastIndexOf("@") + 1).toLowerCase();
    const host = hostport.startsWith("[") ? hostport.slice(0, hostport.indexOf("]") + 1) : hostport.replace(/:\d*$/, "");
    if (!HOSTS_OK.has(host)) return true;
  }
  return false;
}
export function checkNoRemoteRefs(kitDir) {
  const out = [];
  const scan = (rel, test) => {
    const abs = join(kitDir, rel);
    if (!existsSync(abs)) return;
    for (const f of walk(abs)) {
      if (f.split("/").includes("node_modules") || !test(f)) continue;
      if (namesRemoteHost(readFileSync(join(abs, f), "utf8"))) out.push(`${rel}/${f} names a remote URL`);
    }
  };
  scan("server", (f) => f.endsWith(".js"));
  scan("renderer", (f) => f.endsWith(".mjs"));
  scan("skills", (f) => f.endsWith(".md"));
  return out;
}
