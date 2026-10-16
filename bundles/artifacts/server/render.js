// Crow Artifacts — step-2 renderers (spec §5.2, §12 step 2): page, document,
// diagram (SVG written directly). Rendered engines (Mermaid, Graphviz, D2,
// Typst, pandoc …) arrive with the render kit in step 4 and run in its
// hardened container, never here. Everything here is pure string work in the
// gateway process, so every input is size-capped first.
//
// Output: { files: [{ path, body: Buffer, contentType }], anchorMap, design }
//   anchorMap — what the trusted viewer may anchor to from OUTSIDE a
//   script-free frame: document blocks {id:"b<n>", type, text}; diagram
//   elements {id, title} plus the SVG aspect ratio for region anchors.
import { LIMITS } from "./limits.js";

const ASSET_TYPES = {
  page: new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml", "text/css", "text/javascript", "application/json", "font/woff2", "font/woff"]),
  document: new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml", "font/woff2", "font/woff"]),
  diagram: new Set(),
};

const err = (code, message, extra) => Object.assign(new Error(message || code), { code }, extra || {});

/** Spec §4.3 as amended (Kevin 2026-10-15): only the explicit kit features are
 *  refused without the kit — libs and a diagram's { engine, source }. Fences
 *  in a document stay code, as today. */
export const KIT_MISSING = "the Design kit extension isn't installed: remove libs, and send a diagram as { svg } instead of { engine, source }, or ask the owner to install it";

// Kit errors → static, fixable messages (mcp.js fail() contract: never authored text).
const LIB_MESSAGES = {
  too_many_libs: () => "libs: at most 40 names",
  bad_lib_name: (e) => `libs[${Number(e.index) || 0}] must be a library name such as "css:pico" or "icons:lucide/coffee"`,
  unknown_lib: (e) => `libs[${Number(e.index) || 0}] is not in the Design kit (the design-frontend skill lists the names)`,
  lib_not_allowed: (e, type) => `libs[${Number(e.index) || 0}] is not allowed in a ${type} (allowed in: ${(e.allowed || []).filter((t) => ["page", "document", "diagram"].includes(t)).join(", ")})`,
  lib_integrity: () => "a Design kit file failed its integrity check: ask the owner to reinstall the Design kit",
};
function libError(e, type) {
  const m = e && LIB_MESSAGES[e.code];
  return m ? err(e.code, m(e, type)) : err("lib_integrity", LIB_MESSAGES.lib_integrity());
}

/** source.libs → resolved kit files (spec §4.1). null when nothing is asked. */
async function libsFor(type, source, kit) {
  const names = source.libs === undefined ? [] : source.libs;
  if (!Array.isArray(names)) throw err("bad_source", "libs must be a list of library names");
  if (!names.length) return null;
  if (!kit) throw err("kit_missing", KIT_MISSING);
  try { return kit.resolve(names, { target: type }); } catch (e) { throw libError(e, type); }
}

/** <head> additions for script-free types: stylesheet links for every CSS main
 *  (fonts, CSS, theme) in dependency order, then the font rule when no theme. */
function headLinks(lib) {
  if (!lib || !lib.entries.length) return "";
  const links = lib.entries.filter((e) => e.main.endsWith(".css")).map((e) => `<link rel="stylesheet" href="${escAttr(e.main)}">`).join("");
  const fonts = lib.entries.filter((e) => e.kind === "font");
  let rule = "";
  if (fonts.length && !lib.entries.some((e) => e.kind === "theme")) {
    const fam = (f) => `"${f.family}",${f.fallback}`;
    rule = `body{font-family:${fam(fonts[0])}}` + (fonts[1] ? `h1,h2,h3,h4,h5,h6{font-family:${fam(fonts[1])}}` : "");
  }
  return links + (rule ? `<style>${rule}</style>` : "");
}
const designMeta = (lib, rendered = 0, houseStyle = null) => (lib || rendered || houseStyle ? { libs: lib ? lib.refs : [], house_style: houseStyle, rendered } : null);

export function cleanAssetPath(p) {
  if (typeof p !== "string" || !p || p.length > 200) return null;
  const segs = p.split("/");
  for (const s of segs) if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(s) || s === "." || s === "..") return null;
  // __lib/ (Design kit copies) and __render/ (rendered engine output) are
  // filled by Crow only: a bot's own asset can never land there (ruling F3).
  if (p === "index.html" || /^__(crow|lib|render)(\/|$)/.test(p)) return null;
  return p;
}

const escAttr = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const escText = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function assetsFor(type, assets = []) {
  if (!Array.isArray(assets)) throw err("bad_source", "assets must be a list");
  const out = [];
  const seen = new Set();
  for (const a of assets) {
    const path = cleanAssetPath(a && a.path);
    if (!path) throw err("bad_asset_path", `bad asset path: ${String(a && a.path).slice(0, 80)}`);
    if (seen.has(path)) throw err("bad_asset_path", `duplicate asset ${path}`);
    seen.add(path);
    if (!ASSET_TYPES[type].has(a.contentType)) throw err("bad_asset_type", `${a.contentType} is not allowed for ${type}`);
    if (typeof a.base64 !== "string" || !/^[A-Za-z0-9+/=\s]*$/.test(a.base64)) throw err("bad_asset", `${path}: base64 expected`);
    out.push({ path, body: Buffer.from(a.base64, "base64"), contentType: a.contentType });
  }
  return out;
}

/** External links in sealed content are made inert: a user click on one
 *  would navigate the frame (the tripwire catches it, after the request has
 *  left). The URL stays visible as the title. In-page #links still work. */
export function inertLinks(html) {
  // Linear scan (no regex over the document: ReDoS review). Input is
  // sanitize-html output, so attributes are double-quoted.
  let out = "", i = 0;
  const lower = html.toLowerCase();
  for (;;) {
    const a = lower.indexOf("<a", i);
    if (a < 0) { out += html.slice(i); break; }
    const next = lower.charAt(a + 2);
    const end = lower.indexOf(">", a);
    if (end < 0) { out += html.slice(i); break; }
    if (!(next === " " || next === "\t" || next === "\n" || next === ">")) { out += html.slice(i, a + 2); i = a + 2; continue; }
    let tag = html.slice(a, end);
    const h = tag.toLowerCase().indexOf(' href="');
    if (h >= 0) {
      const q = tag.indexOf('"', h + 7);
      const href = q >= 0 ? tag.slice(h + 7, q) : "";
      if (q >= 0 && !href.startsWith("#")) tag = tag.slice(0, h) + ` data-inert-href="${href}" title="${href}"` + tag.slice(q + 1);
    } else {
      // Outside the sanitize-html contract (single-quoted or unquoted href):
      // neutralise the attribute anyway, so no future caller can feed raw
      // HTML and get a live external link (review L2). Linear: one indexOf.
      const hl = tag.toLowerCase();
      const ht = hl.indexOf("href=");
      if (ht > 0 && /\s/.test(tag.charAt(ht - 1))) tag = tag.slice(0, ht) + "data-inert-href=" + tag.slice(ht + 5);
    }
    out += html.slice(i, a) + tag;
    i = end;
  }
  return out;
}

/** The value of the first `name="…"` attribute in one tag, or null. Linear. */
function attrOf(tag, name) {
  const k = tag.indexOf(" " + name + '="');
  if (k < 0) return null;
  const start = k + name.length + 3, q = tag.indexOf('"', start);
  return q < 0 ? null : tag.slice(start, q);
}

/** Diagram anchor map by a bounded linear scan over tags (ReDoS review). */
export function svgElements(svg, max = 500) {
  const out = [];
  let i = 0;
  while (out.length < max) {
    const lt = svg.indexOf("<", i);
    if (lt < 0) break;
    const gt = svg.indexOf(">", lt);
    if (gt < 0) break;
    const tag = svg.slice(lt, gt + 1);
    i = gt + 1;
    const nameEnd = tag.search(/[\s/>]/);
    const name = tag.slice(1, nameEnd < 0 ? tag.length : nameEnd);
    if (!/^[A-Za-z]{1,32}$/.test(name)) continue;
    const id = attrOf(tag, "id");
    if (!id || !/^[A-Za-z][\w.-]{0,63}$/.test(id)) continue;
    let title = "";
    const rest = svg.slice(i, i + 300);
    const t0 = rest.search(/\S/);
    if (t0 >= 0 && rest.startsWith("<title>", t0)) {
      const t1 = rest.indexOf("</title>", t0 + 7);
      if (t1 > 0) title = rest.slice(t0 + 7, Math.min(t1, t0 + 207)).replace(/</g, "");
    }
    out.push({ id, tag: name, title });
  }
  return out;
}

/** Rendered text of SANITIZED block HTML, linear (no regex over the input:
 *  ReDoS review), capped. Entities: the handful sanitize-html emits. */
const BLOCK_TAGS = new Set(["p", "div", "br", "li", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6", "pre", "blockquote", "table", "thead", "tbody", "tr", "td", "th", "hr", "dl", "dt", "dd", "figure", "figcaption"]);
const ENT = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&#x27;": "'", "&nbsp;": " " };
export function plainOf(html, cap = 4000) {
  const s = String(html || "");
  // Review M-1: only BLOCK-level tags separate words; inline tags
  // (**un**believable, `foo()`'s) must not insert a space.
  let out = "", inTag = false, tag = "";
  for (let i = 0; i < s.length && out.length < cap * 2; i++) {
    const c = s[i];
    if (inTag) {
      if (c === ">") { inTag = false; if (BLOCK_TAGS.has(tag.replace(/^\//, "").split(/[\s/]/)[0].toLowerCase())) out += " "; tag = ""; }
      else if (tag.length < 16) tag += c;
      continue;
    }
    if (c === "<") { inTag = true; tag = ""; continue; }
    if (c === "&") {
      const semi = s.indexOf(";", i);
      if (semi > i && semi - i <= 6 && ENT[s.slice(i, semi + 1)]) { out += ENT[s.slice(i, semi + 1)]; i = semi; continue; }
    }
    out += c;
  }
  return out.split(/\s+/).filter(Boolean).join(" ").replace(/ ([.,;:!?)])/g, "$1").slice(0, cap);
}

/** viewBox="minx miny w h" → h/w, by splitting (no regex over the document). */
export function svgAspect(svg) {
  const open = svg.slice(0, svg.indexOf(">") + 1);
  const vb = attrOf(open, "viewBox");
  if (!vb) return null;
  const p = vb.split(/[\s,]+/).filter(Boolean).map(Number);
  return p.length === 4 && p.every(Number.isFinite) && p[2] > 0 ? p[3] / p[2] : null;
}

const DOC_CSS = `body{font:16px/1.6 system-ui,sans-serif;max-width:46rem;margin:0 auto;padding:1.5rem;color:#1d1d1f;background:#fff}
@media (prefers-color-scheme:dark){body{color:#e8e8ea;background:#151517}}
.blk{scroll-margin-top:1rem}.blk:target{outline:2px solid #e2a03f;outline-offset:4px;border-radius:4px}
a[data-inert-href]{text-decoration:underline dotted;cursor:help}
img{max-width:100%}pre{overflow:auto}table{border-collapse:collapse}td,th{border:1px solid #8884;padding:.25rem .5rem}
@media print{body{max-width:none;padding:0}.blk:target{outline:none}}`;

export async function renderVersion(type, source, { markdownBlocks, design = null } = {}) {
  if (!source || typeof source !== "object") throw err("bad_source", "source must be an object");
  const kit = design ? await design.kit() : null;
  if (type === "page") {
    if (typeof source.html !== "string" || !source.html.trim()) throw err("bad_source", "page needs html");
    const lib = await libsFor("page", source, kit);
    return {
      files: [{ path: "index.html", body: Buffer.from(source.html), contentType: "text/html; charset=utf-8" }, ...assetsFor("page", source.assets), ...(lib ? lib.files : [])],
      anchorMap: null,
      design: designMeta(lib),
    };
  }
  if (type === "document") {
    if (typeof source.markdown !== "string") throw err("bad_source", "document needs markdown");
    if (Buffer.byteLength(source.markdown) > LIMITS.documentMarkdownBytes) throw err("too_large", `markdown over ${LIMITS.documentMarkdownBytes} bytes`);
    if (typeof markdownBlocks !== "function") throw err("no_renderer", "markdown renderer unavailable");
    const lib = await libsFor("document", source, kit);
    const blocks = markdownBlocks(source.markdown);
    const body = blocks.map((b, i) => `<div class="blk" id="b${i + 1}">${inertLinks(b.html)}</div>`).join("\n");
    const title = typeof source.title === "string" ? source.title.slice(0, LIMITS.titleChars) : "Document";
    const html = `<!doctype html><html lang="${source.lang === "es" ? "es" : "en"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escText(title)}</title><style>${DOC_CSS}</style>${headLinks(lib)}</head><body><main>\n${body}\n</main></body></html>`;
    return {
      files: [{ path: "index.html", body: Buffer.from(html), contentType: "text/html; charset=utf-8" }, ...assetsFor("document", source.assets), ...(lib ? lib.files : [])],
      // D28: `plain` is the block's RENDERED text (tags stripped, entities
      // decoded, whitespace squashed): what a reader can select. `text` stays
      // the markdown source carry-forward matches on.
      anchorMap: { kind: "blocks", blocks: blocks.map((b, i) => ({ id: `b${i + 1}`, type: b.type, text: b.text, plain: plainOf(b.html) })) },
      design: designMeta(lib),
    };
  }
  if (type === "diagram") {
    // Cap BEFORE any scan; then only linear indexOf/startsWith work (ReDoS review).
    if (typeof source.svg !== "string" || source.svg.length > 5 * 1024 * 1024) throw err("too_large", "svg over 5 MB");
    let svg = source.svg.trim();
    if (svg.startsWith("<?xml")) { const e = svg.indexOf("?>"); svg = e < 0 ? "" : svg.slice(e + 2).trim(); }
    const head = svg.slice(0, 5).toLowerCase();
    if (!(head === "<svg>" || (svg.slice(0, 4).toLowerCase() === "<svg" && /\s/.test(svg.charAt(4)))) || !svg.toLowerCase().endsWith("</svg>")) throw err("bad_source", "diagram needs one <svg> element");
    // Script-free sandbox already stops these; refusing them keeps the
    // source honest and the anchor map meaningful.
    const low = svg.toLowerCase();
    if (low.includes("<script") || low.includes("<foreignobject") || hasEventAttr(low)) throw err("bad_source", "svg may not carry scripts, event handlers or foreignObject");
    const aspect = svgAspect(svg);
    const elements = svgElements(svg);
    const lib = await libsFor("diagram", source, kit);
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;background:#fff}svg{display:block;width:100%;height:auto}</style>${headLinks(lib)}</head><body>${svg}</body></html>`;
    return {
      files: [{ path: "index.html", body: Buffer.from(html), contentType: "text/html; charset=utf-8" }, ...(lib ? lib.files : [])],
      anchorMap: { kind: "diagram", aspect, elements },
      design: designMeta(lib),
    };
  }
  throw err("type_unavailable", `${type} needs the render kit (step 4)`);
}

export { escAttr };

/** Any ` on<letters>=` attribute, by a linear scan. */
function hasEventAttr(low) {
  let i = 0;
  for (;;) {
    const k = low.indexOf("on", i);
    if (k < 0) return false;
    i = k + 2;
    const before = low.charAt(k - 1);
    if (!(before === " " || before === "\t" || before === "\n" || before === "\r" || before === "/")) continue;
    let j = k + 2;
    while (j < low.length && j - k < 40 && low.charCodeAt(j) >= 97 && low.charCodeAt(j) <= 122) j++;
    if (j === k + 2) continue;
    while (j < low.length && (low.charAt(j) === " " || low.charAt(j) === "\t" || low.charAt(j) === "\n")) j++;
    if (low.charAt(j) === "=") return true;
  }
}
