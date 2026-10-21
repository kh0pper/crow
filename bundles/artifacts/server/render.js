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
import { createHash } from "node:crypto";
import { LIMITS } from "./limits.js";

const ASSET_TYPES = {
  page: new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml", "text/css", "text/javascript", "application/json", "font/woff2", "font/woff"]),
  document: new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml", "font/woff2", "font/woff"]),
  diagram: new Set(),
};

const err = (code, message, extra) => Object.assign(new Error(message || code), { code }, extra || {});

/** Spec §4.3 as amended (operator decision 2026-10-15): only the explicit kit features are
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

/** source.libs (+ the house style's theme) → resolved kit files (spec §4.1,
 *  §4.4). null when nothing is asked and no house style applies. A house style
 *  the kit does not know (kit gone, theme dropped by an upgrade) is ignored:
 *  only an explicit libs list is ever refused for a missing kit. */
async function libsFor(type, source, kit, houseStyle) {
  const names = source.libs === undefined ? [] : source.libs;
  if (!Array.isArray(names)) throw err("bad_source", "libs must be a list of library names");
  const style = kit && typeof houseStyle === "string" && kit.themes.has(houseStyle) ? houseStyle : null;
  if (!names.length && !style) return null;
  if (!kit) throw err("kit_missing", KIT_MISSING);
  let r;
  try { r = kit.resolve(style ? [...names, `theme:${style}`] : names, { target: type }); } catch (e) { throw libError(e, type); }
  if (!style) return { ...r, houseStyle: null, houseStyleLinks: [] };
  // resolve() dedupes refs (first-seen order), so the requested libs are the
  // first |distinct names| refs; the appended theme is reported as
  // house_style (+ the CSS a page must link), never as a requested lib.
  const t = kit.themes.get(style);
  const themeFonts = new Set(t && t.fonts ? [t.fonts.heading, t.fonts.body] : []);
  const links = r.entries.filter((e) => e.name === `theme:${style}` || (e.kind === "font" && themeFonts.has(e.name))).map((e) => e.main);
  return { ...r, refs: r.refs.slice(0, new Set(names).size), houseStyle: style, houseStyleLinks: links };
}

/** <head> additions for script-free types: stylesheet links for every CSS main
 *  (fonts, CSS, theme) in dependency order, then the font rule when no theme. */
/** The libs' stylesheet links and font rule for a wrapper's <head>. `xhtml`:
 *  for the XML-parsed diagram wrapper (item 24) — self-closed links, and the
 *  rule's text escaped (XML decodes it before CSS sees it). */
function headLinks(lib, xhtml = false) {
  if (!lib || !lib.entries.length) return "";
  const links = lib.entries.filter((e) => e.main.endsWith(".css")).map((e) => `<link rel="stylesheet" href="${escAttr(e.main)}"${xhtml ? "/" : ""}>`).join("");
  const fonts = lib.entries.filter((e) => e.kind === "font");
  let rule = "";
  if (fonts.length && !lib.entries.some((e) => e.kind === "theme")) {
    const fam = (f) => `"${f.family}",${f.fallback}`;
    rule = `body{font-family:${fam(fonts[0])}}` + (fonts[1] ? `h1,h2,h3,h4,h5,h6{font-family:${fam(fonts[1])}}` : "");
  }
  return links + (rule ? `<style>${xhtml ? rule.replace(/&/g, "&amp;").replace(/</g, "&lt;") : rule}</style>` : "");
}
const designMeta = (lib, rendered = 0, notes = []) => (lib || rendered || notes.length
  ? { libs: lib ? lib.refs : [], house_style: lib ? lib.houseStyle || null : null, ...(lib && lib.houseStyle ? { house_style_links: lib.houseStyleLinks } : {}), rendered, notes }
  : null);

// ---- Specs: fenced vega-lite / mermaid / d2 rendered by the kit (spec §4.2, §4.5) ----
const SPEC_ENGINES = new Set(["vega-lite", "mermaid", "d2"]);
const SPEC_ALT = { "vega-lite": "Vega-Lite chart", mermaid: "Mermaid diagram", d2: "D2 diagram" };
const FAIL_CATEGORIES = new Set(["parse error", "invalid spec", "unsupported diagram type", "timeout", "render error"]);
const SPEC_REASONS = {
  engine: "unknown engine (use vega-lite, mermaid or d2)", empty: "the spec is empty", too_large: "the spec is over 64 KB",
  not_json: "a Vega-Lite spec must be JSON", too_deep: "the Vega-Lite spec is nested too deeply",
  external_data: "Vega-Lite data must be inline (data.values); url and href are not allowed",
  links: "links and click handlers are not allowed", icons: "icons are not allowed", imports: "D2 imports are not allowed",
  directives: "Mermaid directives and front-matter config are not allowed",
  escapes: "backslashes and look-alike letters are not allowed", markup: "Markdown and LaTeX blocks are not allowed",
  unsupported_type: "this diagram type is not supported (the design-frontend skill lists the supported types)",
};
/** Fixed text (operator decision 2026-10-15): the save succeeded, the charts are code for now. */
export const RENDERER_DOWN_NOTE = "renderer_unavailable: the chart and diagram renderer is unavailable, so charts in this version are shown as code; save again later to render them";
const UNAVAILABLE = "the chart and diagram renderer is not answering; try again in a minute";
const TOO_LARGE = "the rendered SVG is over 2 MB; simplify the chart or diagram";
const UNSAFE = "the rendered SVG carried scripts, links, HTML or external references and was refused";
const NOT_XML = "the rendered SVG is not well-formed XML and was refused";

// Static text only (mcp.js fail() contract): engine name from a fixed set, a
// category from a fixed set, an integer line. Never the kit's or renderer's text.
function specError(engine, e) {
  const eng = SPEC_ENGINES.has(engine) ? engine : "spec";
  const code = e && e.code;
  if (code === "bad_spec") return err("bad_spec", `${eng}: ${Object.hasOwn(SPEC_REASONS, e.reason) ? SPEC_REASONS[e.reason] : "spec refused"}`);
  // The text stays fixed; retryable passes through (not_loopback is not).
  if (code === "render_unavailable") return err("render_unavailable", UNAVAILABLE, { retryable: e.retryable !== false });
  if (code === "render_too_large") return err("render_too_large", TOO_LARGE);
  const cat = e && FAIL_CATEGORIES.has(e.category) ? e.category : "render error";
  return err("render_failed", `${eng}: ${cat}${e && Number.isInteger(e.line) ? ` at line ${e.line}` : ""}`);
}

const WS = (c) => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";
const LIB_HREF = /^__lib\/(?!.*\.\.)[a-z0-9._/-]{1,200}\.svg$/;
// data: URLs a rendered SVG may carry in url(): fonts (D2 embeds its fonts)
// and raster images. Never data:image/svg+xml or text/html (a nested document).
const DATA_MIME_PREFIXES = ["font/", "application/font-", "application/x-font-"];
const DATA_MIME_EXACT = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** "data:<mime>" followed by ";" or "," with an allowed MIME type. */
function okDataUrl(low, j) {
  if (!low.startsWith("data:", j)) return false;
  let k = j + 5;
  const m0 = k;
  while (k - m0 < 64 && /[a-z0-9.+/-]/.test(low.charAt(k))) k++;
  if (low.charAt(k) !== ";" && low.charAt(k) !== ",") return false;
  const mime = low.slice(m0, k);
  const slash = mime.indexOf("/");
  const sub = mime.slice(slash + 1);
  if (slash < 1 || !/^[a-z0-9.+-]+$/.test(sub)) return false; // one subtype, no second "/"
  return DATA_MIME_EXACT.has(mime) || DATA_MIME_PREFIXES.some((p) => mime.startsWith(p) && mime.length > p.length);
}
/** href / xlink:href that is not an in-document fragment (any whitespace
 *  around "="), url() that is not #id or a font/raster data: URL, @import,
 *  image-set(, src(. Linear scans (ReDoS review). Input is lowercased. */
export function hasExternalRef(low, libOk = false) {
  let i = 0;
  for (;;) {
    const k = low.indexOf("href", i);
    if (k < 0) break;
    i = k + 4;
    let j = i;
    while (WS(low.charAt(j))) j++;
    if (low.charAt(j) !== "=") continue;
    j++;
    while (WS(low.charAt(j))) j++;
    const q = low.charAt(j);
    if (q !== '"' && q !== "'") return true;
    if (low.charAt(j + 1) === "#") continue;
    // A bot diagram may point an <image> at a Design kit icon copied into the
    // version (__lib/…): same version, relative, no "..", no query or scheme.
    const close = libOk ? low.indexOf(q, j + 1) : -1;
    if (close < 0 || !LIB_HREF.test(low.slice(j + 1, close))) return true;
  }
  if (low.includes("@import") || low.includes("image-set(") || low.includes("src(")) return true;
  i = 0;
  for (;;) {
    const k = low.indexOf("url(", i);
    if (k < 0) return false;
    i = k + 4;
    let j = i;
    while (WS(low.charAt(j)) || low.charAt(j) === "'" || low.charAt(j) === '"') j++;
    if (!(low.startsWith("#", j) || okDataUrl(low, j))) return true;
  }
}

// Elements a rendered chart or diagram may contain (the live Mermaid, Vega and
// D2 output, plus their plain-shape relatives). Everything else is refused:
// <a> (links stay inert by never existing: Task 6 review), script,
// foreignObject, animation/set (they can rewrite href), image/feImage (fetch),
// and any namespaced or HTML element.
const SVG_ELEMENTS = new Set(["svg", "g", "defs", "symbol", "use", "title", "desc", "style", "marker", "mask", "clippath", "pattern",
  "lineargradient", "radialgradient", "stop", "filter", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan", "textpath",
  "feblend", "fecolormatrix", "fecomponenttransfer", "fecomposite", "feconvolvematrix", "fediffuselighting", "fedisplacementmap", "fedistantlight",
  "fedropshadow", "feflood", "fefunca", "fefuncb", "fefuncg", "fefuncr", "fegaussianblur", "femerge", "femergenode", "femorphology", "feoffset",
  "fepointlight", "fespecularlighting", "fespotlight", "fetile", "feturbulence"]);
// Second layer, by substring (the brief's list): never in any rendered SVG.
const BANNED_TAGS = ["<script", "<foreignobject", "<set", "<animate", "<a ", "<a>", "<a\n", "<a\t", "<a/", "<iframe", "<embed", "<object", "<img"];
const TEXT_ONLY = new Set(["title", "desc"]);
const NAME_CH = (c) => (c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c === "-";

/** Markup walk (linear): exactly one root <svg>, well nested (an element
 *  stack: every close tag matches the open one), nothing but whitespace after
 *  the root closes (fix round 2: after </svg> an HTML parser reads <style> as
 *  raw text, so a "CDATA" could end it and smuggle live HTML); every tag an
 *  allowed element; no comment, doctype or processing instruction; CDATA only
 *  inside a <style> inside the root; no backslash (a CSS escape such as
 *  \75 rl( or @\69mport) in any tag or in style text. */
function markupOk(low, allowImage = false) {
  let i = 0;
  const stack = [];
  for (;;) {
    const lt = low.indexOf("<", i);
    const inStyle = stack.at(-1) === "style";
    if (lt < 0) return false; // the root never closed
    if (inStyle && low.slice(i, lt).includes("\\")) return false;
    if (low.startsWith("<![cdata[", lt)) {
      if (!inStyle) return false;
      const end = low.indexOf("]]>", lt + 9);
      if (end < 0 || low.slice(lt + 9, end).includes("\\")) return false;
      i = end + 3;
      continue;
    }
    if (i > 0 && !stack.length) return false; // a tag before or after the root
    const closing = low.charAt(lt + 1) === "/";
    let j = lt + (closing ? 2 : 1);
    const n0 = j;
    while (NAME_CH(low.charAt(j))) j++;
    const name = low.slice(n0, j);
    const after = low.charAt(j);
    if (!(name && name.charAt(0) >= "a" && name.charAt(0) <= "z" && (SVG_ELEMENTS.has(name) || (allowImage && name === "image"))) || !(WS(after) || after === "/" || after === ">")) return false;
    if (lt === 0 ? name !== "svg" || closing : !stack.length) return false;
    // Fix round 3: <title> and <desc> are HTML integration points in inline
    // SVG (a <style> in them is HTML raw text, without CDATA): text only.
    if (!closing && TEXT_ONLY.has(stack.at(-1))) return false;
    if (inStyle && !(closing && name === "style")) return false;
    j = closing ? skipWs(low, j) : attrsEnd(low, j);
    if (j < 0 || low.charAt(j) !== ">") return false;
    if (closing) { if (stack.pop() !== name) return false; }
    else if (low.charAt(j - 1) !== "/") stack.push(name);
    else if (!stack.length) return false; // a self-closed root: <svg/>
    i = j + 1;
    if (!stack.length) {
      for (let k = i; k < low.length; k++) if (!WS(low.charAt(k))) return false;
      return true;
    }
  }
}

const skipWs = (low, j) => { while (WS(low.charAt(j))) j++; return j; };
const ATTR_START = (c) => c >= "a" && c <= "z";
const ATTR_CH = (c) => ATTR_START(c) || (c >= "0" && c <= "9") || c === ":" || c === "." || c === "_" || c === "-";
/** Attributes of one start tag, read the way the WHATWG tokenizer would, but
 *  narrower: name [a-z][a-z0-9:._-]*, then "=", then a quoted value with no
 *  "<" or backslash, then whitespace, "/>" or ">". No "on*" names, no xml:base.
 *  Returns the index of the closing ">" or -1. Linear. */
function attrsEnd(low, j) {
  for (;;) {
    const sep = j;
    j = skipWs(low, j);
    const c = low.charAt(j);
    if (c === ">") return j;
    if (c === "/") return low.charAt(j + 1) === ">" ? j + 1 : -1;
    if (j === sep || !ATTR_START(c)) return -1; // a name needs whitespace before it
    const n0 = j;
    while (ATTR_CH(low.charAt(j))) j++;
    const name = low.slice(n0, j);
    if (name.startsWith("on") || name === "xml:base") return -1;
    j = skipWs(low, j);
    if (low.charAt(j) !== "=") return -1;
    j = skipWs(low, j + 1);
    const q = low.charAt(j);
    if (q !== '"' && q !== "'") return -1;
    const close = low.indexOf(q, j + 1);
    if (close < 0) return -1;
    const v = low.slice(j + 1, close);
    if (v.includes("\\") || v.includes("<")) return -1;
    j = close + 1;
    const after = low.charAt(j);
    if (!(WS(after) || after === "/" || after === ">")) return -1;
  }
}

/** The XML character references a renderer emits, decoded; null when any other
 *  "&" appears (an HTML named reference such as &lpar; would decode to "(" when
 *  the SVG is inlined in a page). Linear. */
const XML_ENT = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };
function decodeRefs(s) {
  let out = "", i = 0;
  for (;;) {
    const a = s.indexOf("&", i);
    if (a < 0) return out + s.slice(i);
    out += s.slice(i, a);
    const semi = s.indexOf(";", a);
    const ref = semi > a && semi - a <= 10 ? s.slice(a, semi + 1) : "";
    let ch = null;
    if (Object.hasOwn(XML_ENT, ref)) ch = XML_ENT[ref];
    else if (/^&#x[0-9a-f]{1,6};$/.test(ref)) ch = String.fromCodePoint(Math.min(parseInt(ref.slice(3, -1), 16), 0x10ffff));
    else if (/^&#[0-9]{1,7};$/.test(ref)) ch = String.fromCodePoint(Math.min(parseInt(ref.slice(2, -1), 10), 0x10ffff));
    if (ch === null) return null;
    out += ch;
    i = semi + 1;
  }
}
// ASCII-only lower-casing, as browsers match tag, attribute and CSS names
// (String#toLowerCase would also fold non-ASCII and shift indexes).
const asciiLower = (s) => s.replace(/[A-Z]+/g, (m) => m.toLowerCase());

/** Renderer output is untrusted (spec §4.5): size cap, one <svg> element,
 *  allowed elements only, no event attributes, no external references in
 *  attributes or CSS (also after decoding character references), no CSS
 *  escapes. Fail closed: refused, never repaired. */
export function checkRenderedSvg(raw) {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > LIMITS.renderedSvgBytes) throw err("render_too_large", TOO_LARGE);
  const svg = stripProlog(raw);
  if (!safeSvg(svg, false)) throw err("render_failed", UNSAFE);
  return svg;
}
const stripProlog = (raw) => {
  let svg = raw.trim();
  if (svg.startsWith("<?xml")) { const e = svg.indexOf("?>"); svg = e < 0 ? "" : svg.slice(e + 2).trim(); }
  return svg;
};
/** The structure and reference rules, shared by renderer output and a bot's
 *  own { svg } diagram (fix round 3). `bot` also allows <image> of a kit icon
 *  under __lib/. */
function safeSvg(svg, bot) {
  const low = asciiLower(svg);
  const opens = low.startsWith("<svg>") || (low.startsWith("<svg") && WS(low.charAt(4)));
  const dec = opens ? decodeRefs(low) : null;
  return !(!opens || !low.endsWith("</svg>") || dec === null || BANNED_TAGS.some((t) => low.includes(t)) || !markupOk(low, bot) || hasEventAttr(low)
    || hasExternalRef(low, bot) || hasExternalRef(asciiLower(dec), bot) || dec.includes("\\"));
}
/** Fixed, actionable text for a bot's own SVG that fails safeSvg. */
const BOT_SVG = "svg must be plain SVG: one root <svg> holding shapes, text, gradients, filters and <style> only, every attribute quoted, <title> and <desc> as plain text; no links, HTML, CDATA outside <style>, CSS escapes or external references; no comments; write & as &amp;; no named entities such as &nbsp; (numeric &#160; is fine) (a Design kit icon is <image href=\"__lib/icons/<set>/<name>.svg\">)";

// ---- Item 24: the diagram wrapper is XHTML, so the SVG must be well-formed XML ----
// The checks above were written for the HTML tokenizer and run on lower-cased
// text. The XML parser is stricter where the HTML parser never needed to care:
// case, references, characters, attribute uniqueness and namespaces. And the
// HTML tree builder silently FIXES the case of SVG names (lineargradient →
// linearGradient, viewbox → viewBox); the XML parser does not, so a name in
// the wrong case would save and then draw wrong with no error (plan review
// I1). xmlSvgCheck enforces those rules on the ORIGINAL text (it runs after
// safeSvg / checkRenderedSvg, which already proved one well-nested root of
// allowed elements with quoted attributes) and makes the namespaces explicit.
// The rules follow XML 1.0 + Namespaces, not one engine's leniency.
const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";
const XML_REF = /^&(?:amp|lt|gt|quot|apos|#[0-9]{1,7}|#x[0-9a-fA-F]{1,6});$/;
/** XML 1.0 Char production. */
const xmlChar = (cp) => cp === 0x9 || cp === 0xa || cp === 0xd || (cp >= 0x20 && cp <= 0xd7ff) || (cp >= 0xe000 && cp <= 0xfffd) || (cp >= 0x10000 && cp <= 0x10ffff);
const XWS = (c) => c === " " || c === "\t" || c === "\n" || c === "\r";
const XNAME_CH = (c) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || c === "-";
const XATTR_CH = (c) => XNAME_CH(c) || c === ":" || c === "." || c === "_";
// The camelCase names among the elements markupOk allows (the HTML spec's SVG
// tag-name adjustments); every other allowed element is all lower case.
const CANON_ELEMENT = new Map(["clipPath", "linearGradient", "radialGradient", "textPath", "feBlend", "feColorMatrix", "feComponentTransfer",
  "feComposite", "feConvolveMatrix", "feDiffuseLighting", "feDisplacementMap", "feDistantLight", "feDropShadow", "feFlood", "feFuncA", "feFuncB",
  "feFuncG", "feFuncR", "feGaussianBlur", "feMerge", "feMergeNode", "feMorphology", "feOffset", "fePointLight", "feSpecularLighting", "feSpotLight",
  "feTile", "feTurbulence"].map((n) => [n.toLowerCase(), n]));
// The HTML spec's SVG attribute-name adjustments; every other attribute is lower case.
const CANON_ATTR = new Map(["attributeName", "attributeType", "baseFrequency", "baseProfile", "calcMode", "clipPathUnits", "diffuseConstant", "edgeMode",
  "filterUnits", "glyphRef", "gradientTransform", "gradientUnits", "kernelMatrix", "kernelUnitLength", "keyPoints", "keySplines", "keyTimes",
  "lengthAdjust", "limitingConeAngle", "markerHeight", "markerUnits", "markerWidth", "maskContentUnits", "maskUnits", "numOctaves", "pathLength",
  "patternContentUnits", "patternTransform", "patternUnits", "pointsAtX", "pointsAtY", "pointsAtZ", "preserveAlpha", "preserveAspectRatio",
  "primitiveUnits", "refX", "refY", "repeatCount", "repeatDur", "requiredExtensions", "requiredFeatures", "specularConstant", "specularExponent",
  "spreadMethod", "startOffset", "stdDeviation", "stitchTiles", "surfaceScale", "systemLanguage", "tableValues", "targetX", "targetY", "textLength",
  "viewBox", "viewTarget", "xChannelSelector", "yChannelSelector", "zoomAndPan"].map((n) => [n.toLowerCase(), n]));
const canonElement = (n) => { const l = n.toLowerCase(); return CANON_ELEMENT.get(l) || l; };
const canonAttr = (n) => { const l = n.toLowerCase(); return CANON_ATTR.get(l) || l; };
const MAX_DEPTH = 256; // libxml2's default nesting cap (plan review M7)

/** Fixed, actionable texts for a bot's own SVG that is not well-formed XML
 *  (never echoing input; one per rule so a bot can correct itself). */
export const XML_MESSAGES = Object.freeze({
  char: "svg must be well-formed XML: remove control characters and the non-characters U+FFFE/U+FFFF",
  ref: "svg must be well-formed XML: the only references are &amp; &lt; &gt; &quot; &apos; and numeric ones such as &#160; or &#xA0; (lower-case x) for a real character",
  cdata: "svg must be well-formed XML: text may not contain ]]> (CDATA is allowed only inside <style>)",
  close: "svg must be well-formed XML: close every element with exactly the name it was opened with",
  case: "svg names are case-sensitive: write linearGradient, radialGradient, clipPath, textPath and feGaussianBlur (and the other fe… filters), viewBox, preserveAspectRatio, gradientUnits, stdDeviation and the other camelCase SVG attributes exactly so; everything else in lower case",
  duplicate: "svg must be well-formed XML: never repeat an attribute on one element",
  namespace: "svg namespaces: declare nothing except xmlns=\"http://www.w3.org/2000/svg\" and xmlns:xlink=\"http://www.w3.org/1999/xlink\", on the root <svg> only; the only prefixed attributes are xlink:href, xlink:title and xml:space / xml:lang",
  depth: "svg must nest elements at most 256 deep",
  structure: "svg must be well-formed XML: one root <svg> element, every attribute quoted",
});
export const BOT_XML = XML_MESSAGES.structure;

/** { svg } with xmlns (and xmlns:xlink when xlink: is used) on the root, or
 *  { reason } (a key of XML_MESSAGES) when an XML parser would refuse it or
 *  it would mis-render. Linear; input is size-capped by the caller. */
export function xmlSvgCheck(svg) {
  const no = (reason) => ({ reason });
  if (typeof svg !== "string") return no("structure");
  for (let i = 0; i < svg.length; i++) {
    const c = svg.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) { const d = svg.charCodeAt(i + 1); if (!(d >= 0xdc00 && d <= 0xdfff)) return no("char"); i++; continue; }
    if (!xmlChar(c)) return no("char"); // a lone low surrogate, U+FFFE/U+FFFF, C0 controls such as \f
  }
  for (let a = svg.indexOf("&"); a >= 0; a = svg.indexOf("&", a + 1)) {
    const semi = svg.indexOf(";", a);
    const ref = semi > a && semi - a <= 10 ? svg.slice(a, semi + 1) : "";
    if (!XML_REF.test(ref)) return no("ref");
    // The raw value, before any clamp (&#x110000; is an error, not U+10FFFF).
    if (ref.charAt(1) === "#" && !xmlChar(ref.charAt(2) === "x" ? parseInt(ref.slice(3, -1), 16) : parseInt(ref.slice(2, -1), 10))) return no("ref");
  }
  const stack = [];
  let rootHasXmlns = false, rootHasXlink = false, usesXlink = false, rootTagEnd = -1;
  let i = 0;
  for (;;) {
    const lt = svg.indexOf("<", i);
    if (lt < 0) return no("structure");
    if (svg.slice(i, lt).includes("]]>")) return no("cdata");
    if (svg.startsWith("<![CDATA[", lt)) {
      if (stack.at(-1) !== "style") return no("structure");
      const end = svg.indexOf("]]>", lt + 9);
      if (end < 0) return no("structure");
      i = end + 3;
      continue;
    }
    const closing = svg.charAt(lt + 1) === "/";
    let j = lt + (closing ? 2 : 1);
    const n0 = j;
    while (XNAME_CH(svg.charAt(j))) j++;
    const name = svg.slice(n0, j);
    if (!name) return no("structure");
    if (closing) {
      while (XWS(svg.charAt(j))) j++;
      if (svg.charAt(j) !== ">") return no("structure");
      if (stack.pop() !== name) return no("close"); // case-sensitive
      i = j + 1;
      if (!stack.length) {
        if (!/^[ \t\r\n]*$/.test(svg.slice(i))) return no("structure");
        const add = (rootHasXmlns ? "" : ` xmlns="${SVG_NS}"`) + (usesXlink && !rootHasXlink ? ` xmlns:xlink="${XLINK_NS}"` : "");
        return { svg: add ? svg.slice(0, rootTagEnd) + add + svg.slice(rootTagEnd) : svg };
      }
      continue;
    }
    if (name !== canonElement(name)) return no("case");
    const isRoot = lt === 0;
    if (isRoot !== !stack.length || (isRoot && name !== "svg")) return no("structure");
    const seen = new Set();
    for (;;) {
      const sep = j;
      while (XWS(svg.charAt(j))) j++;
      const c = svg.charAt(j);
      if (c === ">" || (c === "/" && svg.charAt(j + 1) === ">")) break;
      if (j === sep) return no("structure");
      const a0 = j;
      while (XATTR_CH(svg.charAt(j))) j++;
      const an = svg.slice(a0, j);
      while (XWS(svg.charAt(j))) j++;
      if (svg.charAt(j) !== "=") return no("structure");
      j++;
      while (XWS(svg.charAt(j))) j++;
      const q = svg.charAt(j);
      if (q !== '"' && q !== "'") return no("structure");
      const close = svg.indexOf(q, j + 1);
      if (close < 0) return no("structure");
      const v = svg.slice(j + 1, close);
      j = close + 1;
      // Namespaces (plan review I2): exactly two declarations, byte-exact,
      // root only; prefixes xlink: and xml: only. A raw compare, so a
      // reference inside the value (sv&#x67;) can never satisfy it.
      if (an === "xmlns") { if (!isRoot || v !== SVG_NS) return no("namespace"); rootHasXmlns = true; continue; }
      if (an === "xmlns:xlink") { if (!isRoot || v !== XLINK_NS) return no("namespace"); rootHasXlink = true; continue; }
      const colon = an.indexOf(":");
      if (colon >= 0) {
        const p = an.slice(0, colon), local = an.slice(colon + 1);
        if (!((p === "xlink" && (local === "href" || local === "title")) || (p === "xml" && (local === "space" || local === "lang")))) return no("namespace");
        if (p === "xlink") usesXlink = true;
      } else if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(an)) return no("structure");
      else if (an !== canonAttr(an)) return no("case");
      if (seen.has(an)) return no("duplicate");
      seen.add(an);
    }
    const selfClose = svg.charAt(j) === "/";
    if (isRoot) { if (selfClose) return no("structure"); rootTagEnd = n0 + name.length; }
    if (!selfClose) { stack.push(name); if (stack.length > MAX_DEPTH) return no("depth"); }
    i = (selfClose ? j + 1 : j) + 1;
  }
}
/** The namespaced SVG, or null (tests and callers that only need yes/no). */
export const xmlSvg = (svg) => xmlSvgCheck(svg).svg ?? null;

const specKey = (engine, source) => `${engine}:${createHash("sha256").update(String(source)).digest("hex")}`;

/** A cached render, re-checked (it may predate a stricter check). */
function cachedSvg(cache, key) {
  if (!cache || !cache.has(key)) return null;
  try { return checkRenderedSvg(cache.get(key)); } catch { return null; }
}

/** Render one spec inside the save's deadline, then check the output. The
 *  deadline is enforced here too, whatever the kit does with timeoutMs. */
async function renderSpec(kit, engine, source, deadline) {
  const timeoutMs = deadline - Date.now();
  if (timeoutMs <= 0) throw err("render_unavailable", UNAVAILABLE, { retryable: true });
  let timer;
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(err("render_unavailable", UNAVAILABLE, { retryable: true })), timeoutMs); });
  let svg;
  try { svg = await Promise.race([kit.render(engine, source, { timeoutMs }), late]); }
  catch (e) { throw specError(engine, e); }
  finally { clearTimeout(timer); }
  return checkRenderedSvg(svg);
}

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

/** D28 leftover (review L-6): `plain` for a document version saved before
 *  D28, recomputed from the version's OWN stored markdown. Only when the
 *  re-render matches the stored map exactly (same ids, types and markdown
 *  text, block for block) — any drift in the renderer since that save leaves
 *  the version untouched (null), on the mdPlain fallback. Pure. */
export function plainBackfill(anchorMap, source, markdownBlocks) {
  const old = anchorMap && anchorMap.kind === "blocks" && Array.isArray(anchorMap.blocks) ? anchorMap.blocks : null;
  if (!old || !old.some((b) => !b || typeof b.plain !== "string")) return null;
  if (!source || typeof source.markdown !== "string" || typeof markdownBlocks !== "function") return null;
  let blocks;
  try { blocks = markdownBlocks(source.markdown); } catch { return null; }
  if (!Array.isArray(blocks) || blocks.length !== old.length) return null;
  for (let i = 0; i < old.length; i++) {
    const b = old[i], r = blocks[i];
    if (!b || !r || b.id !== `b${i + 1}` || b.type !== r.type || b.text !== r.text) return null;
  }
  return { ...anchorMap, blocks: old.map((b, i) => (typeof b.plain === "string" ? b : { ...b, plain: plainOf(blocks[i].html) })) };
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

export async function renderVersion(type, source, { markdownBlocks, design = null, priorRenders = null, houseStyle = null } = {}) {
  if (!source || typeof source !== "object") throw err("bad_source", "source must be an object");
  const kit = design ? await design.kit() : null;
  if (type === "page") {
    if (typeof source.html !== "string" || !source.html.trim()) throw err("bad_source", 'page needs source.html: the whole HTML document as one string, e.g. {"html": "<!doctype html>…"}');
    const lib = await libsFor("page", source, kit, houseStyle);
    return {
      files: [{ path: "index.html", body: Buffer.from(source.html), contentType: "text/html; charset=utf-8" }, ...assetsFor("page", source.assets), ...(lib ? lib.files : [])],
      anchorMap: null,
      design: designMeta(lib),
    };
  }
  if (type === "document") {
    if (typeof source.markdown !== "string") throw err("bad_source", 'document needs source.markdown: the whole Markdown text as one string, e.g. {"markdown": "# Title\\n\\nText…"}');
    if (Buffer.byteLength(source.markdown) > LIMITS.documentMarkdownBytes) throw err("too_large", `markdown over ${LIMITS.documentMarkdownBytes} bytes`);
    if (typeof markdownBlocks !== "function") throw err("no_renderer", "markdown renderer unavailable");
    const lib = await libsFor("document", source, kit, houseStyle);
    const blocks = markdownBlocks(source.markdown);
    // Specs (spec §4.2; §4.3 as amended): only with the kit. Without it every
    // fence is code, byte-identical to before the kit existed.
    const specAt = [];
    if (kit) blocks.forEach((b, i) => { if (b.type === "code" && SPEC_ENGINES.has(b.lang)) specAt.push(i); });
    if (specAt.length > LIMITS.specsPerVersion) throw err("too_many_specs", `at most ${LIMITS.specsPerVersion} charts and diagrams per document`);
    const deadline = Date.now() + LIMITS.saveRenderMs;
    const cache = new Map(priorRenders || []);
    const rendered = new Map();
    const notes = [];
    let down = false;
    for (const i of specAt) {
      const key = specKey(blocks[i].lang, blocks[i].code);
      const hit = cachedSvg(cache, key);
      if (hit) { rendered.set(i, { key, svg: hit }); continue; }
      if (down) continue;
      try {
        const svg = await renderSpec(kit, blocks[i].lang, blocks[i].code, deadline);
        cache.set(key, svg);
        rendered.set(i, { key, svg });
      } catch (e) {
        if (e.code !== "render_unavailable") throw e; // the renderer answered: refuse (spec §4.2)
        down = true; // down or out of time: the rest stay code
      }
    }
    if (down) notes.push(RENDERER_DOWN_NOTE);
    const specFiles = [];
    const indexItems = [];
    const body = blocks.map((b, i) => {
      if (!rendered.has(i)) return `<div class="blk" id="b${i + 1}">${inertLinks(b.html)}</div>`;
      const path = `__render/b${i + 1}.svg`;
      specFiles.push({ path, body: Buffer.from(rendered.get(i).svg), contentType: "image/svg+xml" });
      indexItems.push({ key: rendered.get(i).key, path });
      return `<div class="blk" id="b${i + 1}"><figure class="spec"><img src="${path}" alt="${SPEC_ALT[b.lang]}"></figure></div>`;
    }).join("\n");
    if (indexItems.length) specFiles.push({ path: "__render/index.json", body: Buffer.from(JSON.stringify({ schema: 1, items: indexItems })), contentType: "application/json" });
    const specCss = rendered.size ? "<style>figure.spec{margin:1rem 0}figure.spec img{display:block;max-width:100%;height:auto}</style>" : "";
    const title = typeof source.title === "string" ? source.title.slice(0, LIMITS.titleChars) : "Document";
    const html = `<!doctype html><html lang="${source.lang === "es" ? "es" : "en"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escText(title)}</title><style>${DOC_CSS}</style>${headLinks(lib)}${specCss}</head><body><main>\n${body}\n</main></body></html>`;
    return {
      files: [{ path: "index.html", body: Buffer.from(html), contentType: "text/html; charset=utf-8" }, ...assetsFor("document", source.assets), ...(lib ? lib.files : []), ...specFiles],
      // D28: `plain` is the block's RENDERED text (tags stripped, entities
      // decoded, whitespace squashed): what a reader can select. `text` stays
      // the markdown source carry-forward matches on.
      // A rendered spec's `plain` is its alt text (review L7): a reader selects
      // nothing inside an image, and the anchor is block-level only.
      anchorMap: { kind: "blocks", blocks: blocks.map((b, i) => ({ id: `b${i + 1}`, type: b.type, text: b.text, plain: rendered.has(i) ? SPEC_ALT[b.lang] : plainOf(b.html) })) },
      design: designMeta(lib, rendered.size, notes),
    };
  }
  if (type === "diagram") {
    const lib = await libsFor("diagram", source, kit, houseStyle); // a libs error wins over any render
    // { engine, source }: rendered by the kit, then the same path as { svg }.
    let raw = source.svg;
    let renderedN = 0;
    let renderFiles = [];
    if (source.engine !== undefined) {
      if (!kit) throw err("kit_missing", KIT_MISSING);
      if (typeof source.engine !== "string" || typeof source.source !== "string") throw err("bad_source", 'a rendered diagram needs source.engine and source.source as strings, e.g. {"engine": "mermaid", "source": "flowchart LR\\n  a --> b"}');
      const key = specKey(source.engine, source.source);
      // Unavailable here is a retryable refusal: there is no code to fall back to.
      raw = cachedSvg(priorRenders && new Map(priorRenders), key) || await renderSpec(kit, source.engine, source.source, Date.now() + LIMITS.saveRenderMs);
      renderedN = 1;
      // The cache keeps the SVG itself (not the HTML wrapper) for the next version.
      renderFiles = [
        { path: "__render/diagram.svg", body: Buffer.from(raw), contentType: "image/svg+xml" },
        { path: "__render/index.json", body: Buffer.from(JSON.stringify({ schema: 1, items: [{ key, path: "__render/diagram.svg" }] })), contentType: "application/json" },
      ];
    }
    // Cap BEFORE any scan; then only linear indexOf/startsWith work (ReDoS review).
    if (typeof raw !== "string") throw err("bad_source", 'diagram needs source.svg: one <svg>…</svg> element as one string, e.g. {"svg": "<svg xmlns=…>…</svg>"}');
    if (raw.length > 5 * 1024 * 1024) throw err("too_large", "svg over 5 MB");
    let svg = raw.trim();
    if (svg.startsWith("<?xml")) { const e = svg.indexOf("?>"); svg = e < 0 ? "" : svg.slice(e + 2).trim(); }
    const head = svg.slice(0, 5).toLowerCase();
    if (!(head === "<svg>" || (svg.slice(0, 4).toLowerCase() === "<svg" && /\s/.test(svg.charAt(4)))) || !svg.toLowerCase().endsWith("</svg>")) throw err("bad_source", "diagram needs one <svg> element");
    // Script-free sandbox already stops these; refusing them keeps the
    // source honest and the anchor map meaningful.
    const low = svg.toLowerCase();
    if (low.includes("<script") || low.includes("<foreignobject") || hasEventAttr(low)) throw err("bad_source", "svg may not carry scripts, event handlers or foreignObject");
    // Fix round 3: these checks were written for the HTML parser and stay as
    // defence in depth (versions saved before item 24 are still served as
    // HTML). Rendered SVG passed checkRenderedSvg already.
    if (!renderedN && !safeSvg(svg, true)) throw err("bad_source", BOT_SVG);
    // Item 24: the wrapper is XHTML, so the XML parser reads the SVG (no HTML
    // tokenizer, no integration points, no raw-text elements). What it would
    // refuse is refused HERE, never stored as a parse-error page.
    const xc = xmlSvgCheck(svg);
    if (!xc.svg) throw renderedN ? err("render_failed", NOT_XML) : err("bad_source", XML_MESSAGES[xc.reason] || BOT_XML);
    const xsvg = xc.svg;
    const aspect = svgAspect(xsvg);
    const elements = svgElements(xsvg);
    const xhtml = `<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><style>html,body{margin:0;background:#fff}svg{display:block;width:100%;height:auto}</style>${headLinks(lib, true)}</head><body>${xsvg}</body></html>`;
    return {
      files: [{ path: "index.html", body: Buffer.from(xhtml), contentType: "application/xhtml+xml; charset=utf-8" }, ...(lib ? lib.files : []), ...renderFiles],
      anchorMap: { kind: "diagram", aspect, elements },
      design: designMeta(lib, renderedN),
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
    if (!(before === " " || before === "\t" || before === "\n" || before === "\r" || before === "\f" || before === "/" || before === '"' || before === "'")) continue;
    let j = k + 2;
    while (j < low.length && j - k < 40 && low.charCodeAt(j) >= 97 && low.charCodeAt(j) <= 122) j++;
    if (j === k + 2) continue;
    while (j < low.length && (low.charAt(j) === " " || low.charAt(j) === "\t" || low.charAt(j) === "\n" || low.charAt(j) === "\r" || low.charAt(j) === "\f")) j++;
    if (low.charAt(j) === "=") return true;
  }
}
