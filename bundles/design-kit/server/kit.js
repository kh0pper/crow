// Design kit — the consumer-agnostic API (spec §3, §4.1, D8). Any Crow consumer
// (Artifacts today, Workspace next) opens the INSTALLED copy of this file:
//   const kit = openKit(<CROW_HOME>/bundles/design-kit)
//   kit.resolve(["font:lora", "icons:lucide/coffee"], { target: "page" })
// Targets are content classes, not consumers: "page" = scripted HTML,
// "document" = script-free HTML, "diagram" = one standalone SVG.
// node: imports only (the installed copy cannot resolve app packages).
//
// resolve() returns every file under "__lib/" with each entry's own layout
// kept (never flattened): font.css loads url(./<file>.woff2) next to itself,
// and pico.min.css loads url(icons/…) relative to its own location. A consumer
// copies `files` as given and links `refs`.
//
// Pico's icon url()s live inside CSS custom properties, and a url() in a
// custom property resolves against the stylesheet that USES var(), so
// pico.min.css must be LINKED as a file (<link href="__lib/css/pico/pico.min.css">),
// never inlined into a <style> element, or its icons resolve against the page.
//
// Licences travel with the files (review M9): every resolved entry, and every
// icon set an icon came from, adds its licence text and third-party notices at
// "__lib/<license_file>" / "__lib/<notice path>". Icons had their per-file
// @license comments stripped, so the set's licence file is their only notice.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex, cleanLibPath, TARGETS, LICENCE_TYPE } from "./lib-check.js";

export { TARGETS };
export const DEFAULT_RENDER_URL = "http://127.0.0.1:8018";
export const KIT_LIMITS = Object.freeze({ libNames: 40, specBytes: 64 * 1024, svgBytes: 2 * 1024 * 1024, renderTimeoutMs: 20000 });

const MESSAGES = Object.freeze({
  bad_target: "unknown target",
  bad_lib_name: "a library name must be a string",
  too_many_libs: "too many libraries",
  unknown_lib: "unknown library",
  lib_not_allowed: "library not allowed for this target",
  lib_integrity: "a library file does not match its pinned hash",
  bad_spec: "spec refused",
  render_unavailable: "the renderer is not answering",
  render_failed: "the renderer could not render this spec",
  render_too_large: "the rendered SVG is too large",
});

/** Errors carry a code and structured fields; the message is a fixed string,
 *  never caller text, so a consumer may show it as is. */
export function kitError(code, extra = {}) {
  return Object.assign(new Error(Object.hasOwn(MESSAGES, code) ? MESSAGES[code] : String(code)), { code }, extra);
}

const ICON_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ICON_PREFIX = "icons:";

export const ENGINES = new Set(["vega-lite", "mermaid", "d2"]);
export const FAIL_CATEGORIES = new Set(["parse error", "invalid spec", "unsupported diagram type", "timeout", "render error"]);
const LOOPBACK = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d{1,5}$/;
const MAX_DEPTH = 64;
// Mermaid diagram types the kit renders with SVG labels (no foreignObject),
// matched lower-cased against the first keyword after blank lines, %% comments
// and front matter, and refused up front otherwise (review M7). Task 8 removes
// any type whose live render fails; the skill lists exactly these. Keep this
// the ONE place the list lives.
export const MERMAID_TYPES = new Set(["flowchart", "graph", "sequencediagram", "classdiagram", "statediagram", "statediagram-v2", "erdiagram", "gantt", "pie", "timeline", "mindmap"]);
// Keys that make Vega-Lite / vega-embed fetch something: data urls, href
// channels/marks, and usermeta (embedOptions config/patch can load a URL).
const VEGA_FETCH_KEYS = new Set(["url", "href", "usermeta"]);

// Fixed refusal messages, per engine and reason. Never spec text.
const DIAGRAM_LINKS = "links, callbacks and directives are not allowed in diagrams";
const SPEC_MESSAGES = Object.freeze({
  engine: "unknown diagram engine",
  empty: "the spec is empty",
  too_large: "the spec is too large",
  not_json: "a Vega-Lite spec must be JSON",
  too_deep: "the spec is nested too deeply",
  external_data: "chart data must be inline: urls, links and usermeta are not allowed",
  unsupported_type: "this Mermaid diagram type is not supported",
  escapes: "backslash escapes are not allowed in diagrams",
  "mermaid:links": DIAGRAM_LINKS,
  "mermaid:directives": DIAGRAM_LINKS,
  "d2:icons": "icons are not allowed in D2 diagrams",
  "d2:imports": "imports are not allowed in D2 diagrams",
  "d2:links": "links and urls are not allowed in D2 diagrams",
  "d2:directives": "variables and config are not allowed in D2 diagrams",
  "d2:markup": "Markdown and LaTeX blocks are not allowed in D2 diagrams",
});
const refuse = (reason, engine) => {
  const e = kitError("bad_spec", { reason });
  e.message = SPEC_MESSAGES[`${engine}:${reason}`] || SPEC_MESSAGES[reason] || MESSAGES.bad_spec;
  return e;
};

// Mermaid fails closed: these anywhere in the source (case-insensitive, word
// boundaries) refuse it. False positives (a label saying "link") are accepted;
// the author can reword.
//  - any backslash: YAML front matter decodes "\x63onfig", "\u0063onfig" and
//    escaped-newline splits into config/init (trade-off: no "\n" in labels);
//  - "@{" shape data (the image shape fetches its img url in the renderer);
//  - "//" (covers "://" and protocol-relative urls) and "url(";
//  - a tag opener: "<" followed by a letter, "/", "!" or "?" (<img, <style,
//    <br>, </b>, <!--, <?xml). Arrows (<--, <-->, <|--, <.., <==) stay legal;
//    classDiagram <<annotations>> are refused (trade-off).
const MERMAID_DIRECTIVE = /%%\{/;
const BACKSLASH = /\\/;
const MERMAID_LINKS = /\b(?:click|links?|callback|href)\b|javascript:|\/\/|url\(|@\s*\{|<[a-z/!?]/i;
const MERMAID_FRONT_MATTER_BAD = /\b(?:config|init)\b/i;

// D2 fails closed the same way. Any backslash is refused first (escapes can
// spell icon/link/import inside keys or quoted strings). An "@" is refused
// unless it follows a name character [A-Za-z0-9_.+-], so "me@example.org"
// stays legal while "x: @y", "x: [a;@y]", "x: {@y}" and "...@y" are imports.
const D2_RULES = [
  ["escapes", /\\/],
  ["imports", /\.\.\.@|(?<![A-Za-z0-9_.+-])@|\bimport\b/i],
  ["icons", /\bicon\b/i],
  ["links", /\blink\b|\/\//i],
  ["directives", /\bvars\b|d2-config/i],
  ["markup", /\|+`*\s*(?:md|markdown|latex|tex)\b/i],
];

/** Any key in `keys`, at any depth; deeper than MAX_DEPTH is refused. Iterative.
 *  Skipped as inline data (review L10): `values` directly under a `data` object
 *  (at any depth, so layers keep their inline data) and the top-level `datasets`. */
function findKey(root, keys) {
  const stack = [[root, 0, null]];
  while (stack.length) {
    const [v, d, parentKey] = stack.pop();
    if (d > MAX_DEPTH) return "too_deep";
    if (Array.isArray(v)) { for (const x of v) stack.push([x, d + 1, null]); continue; }
    if (v && typeof v === "object") {
      for (const k of Object.keys(v)) {
        if (keys.has(k)) return "external_data";
        if (k === "values" && parentKey === "data") continue;
        if (k === "datasets" && v === root) continue;
        stack.push([v[k], d + 1, k]);
      }
    }
  }
  return null;
}

/** First Mermaid keyword after blank lines, %% comments and one front-matter
 *  block; front matter that is unclosed or carries config/init is a directive. */
function mermaidType(lines) {
  let i = 0;
  const skip = () => { while (i < lines.length && (!lines[i].trim() || lines[i].trim().startsWith("%%"))) i++; };
  skip();
  if (i < lines.length && lines[i].trim() === "---") {
    const end = lines.findIndex((l, j) => j > i && l.trim() === "---");
    if (end < 0 || MERMAID_FRONT_MATTER_BAD.test(lines.slice(i + 1, end).join("\n"))) throw refuse("directives", "mermaid");
    i = end + 1;
    skip();
  }
  return i < lines.length ? lines[i].trim().toLowerCase().split(/[\s:;]/)[0] : null;
}

/** Spec rules checked BEFORE any render (spec §4.2). Throws bad_spec {reason}
 *  with a fixed message; the error never carries spec text. */
export function guardSpec(engine, source) {
  if (!ENGINES.has(engine)) throw refuse("engine");
  if (typeof source !== "string" || !source.trim()) throw refuse("empty");
  if (Buffer.byteLength(source) > KIT_LIMITS.specBytes) throw refuse("too_large");
  if (engine === "vega-lite") {
    let spec;
    try { spec = JSON.parse(source); } catch { throw refuse("not_json"); }
    const hit = findKey(spec, VEGA_FETCH_KEYS);
    if (hit) throw refuse(hit);
    return;
  }
  const text = source.replace(/\r\n?/g, "\n");
  if (engine === "mermaid") {
    if (MERMAID_DIRECTIVE.test(text)) throw refuse("directives", engine);
    if (BACKSLASH.test(text)) throw refuse("escapes", engine);
    if (MERMAID_LINKS.test(text)) throw refuse("links", engine);
    if (!MERMAID_TYPES.has(mermaidType(text.split("\n")))) throw refuse("unsupported_type", engine);
    return;
  }
  for (const [reason, re] of D2_RULES) if (re.test(text)) throw refuse(reason, engine);
}

/** The renderer's HTTP client. Loopback only (a non-loopback url makes every
 *  call throw a fresh render_unavailable {reason:"not_loopback", retryable:false}
 *  without sending). Mapped by the renderer's error code, not HTTP status:
 *  render_failed -> render_failed {category, line}; too_large -> render_too_large
 *  (output) or bad_spec {reason:"too_large"} (input); everything else (network,
 *  timeout, non-JSON, busy, bad_request, not_found, no/unknown code) ->
 *  render_unavailable {retryable:true}, so callers fall back rather than refuse. */
export function makeRenderClient({ url = DEFAULT_RENDER_URL, fetchImpl = globalThis.fetch, timeoutMs = KIT_LIMITS.renderTimeoutMs } = {}) {
  if (!LOOPBACK.test(String(url))) {
    return async () => { throw kitError("render_unavailable", { reason: "not_loopback", retryable: false }); };
  }
  const unavailable = () => kitError("render_unavailable", { retryable: true });
  return async (engine, source, { timeoutMs: callTimeout = timeoutMs } = {}) => {
    const limit = Math.max(1, Math.min(timeoutMs, Number.isFinite(callTimeout) ? callTimeout : timeoutMs));
    let res;
    try {
      res = await fetchImpl(url + "/render", { method: "POST", redirect: "error", headers: { "content-type": "application/json" }, body: JSON.stringify({ engine, source }), signal: AbortSignal.timeout(limit) });
    } catch { throw unavailable(); }
    let j = null;
    try { j = await res.json(); } catch { j = null; }
    if (res.status === 200) {
      if (!j || typeof j.svg !== "string") throw unavailable();
      if (Buffer.byteLength(j.svg) > KIT_LIMITS.svgBytes) throw kitError("render_too_large");
      return j.svg;
    }
    const e = j && j.error && typeof j.error === "object" ? j.error : {};
    if (e.code === "too_large") throw e.category === "output" ? kitError("render_too_large") : refuse("too_large");
    if (e.code !== "render_failed") throw unavailable();
    const category = FAIL_CATEGORIES.has(e.category) ? e.category : "render error";
    const line = Number.isInteger(e.line) && e.line > 0 && e.line < 1e6 ? e.line : null;
    throw kitError("render_failed", { category, line });
  };
}

/**
 * Open a kit directory (the bundle root, holding lib/manifest.json).
 * @returns {{ version: string|null, dir: string, entries: Map<string, object>, themes: Map<string, object>,
 *   resolve(names: string[], opts: { target: "page"|"document"|"diagram" }):
 *     { files: {path: string, body: Buffer, contentType: string}[], refs: string[],
 *       entries: {name: string, kind: string, main: string, family?: string, fallback?: string}[] } }}
 * render(engine, source, { timeoutMs? }) → svg: guardSpec, then the loopback render client.
 */
export function openKit(kitDir, { renderUrl = DEFAULT_RENDER_URL, fetchImpl = globalThis.fetch } = {}) {
  const libDir = join(kitDir, "lib");
  const manifest = JSON.parse(readFileSync(join(libDir, "manifest.json"), "utf8"));
  const entries = new Map(manifest.entries.map((e) => [e.name, e]));

  /** Read one pinned file ({path, sha256}) and check its hash. */
  const readVerified = (f) => {
    const p = cleanLibPath(f && f.path);
    if (!p || typeof f.sha256 !== "string") throw kitError("lib_integrity");
    let body;
    try { body = readFileSync(join(libDir, p)); } catch { throw kitError("lib_integrity"); }
    if (sha256Hex(body) !== f.sha256) throw kitError("lib_integrity");
    return body;
  };

  const themesMeta = (manifest.meta_files || []).find((m) => m.path === "themes.json");
  const themes = new Map(themesMeta ? Object.entries(JSON.parse(readVerified(themesMeta).toString("utf8")).themes || {}) : []);

  const iconSets = new Map();
  const client = makeRenderClient({ url: renderUrl, fetchImpl });
  const render = async (engine, source, opts = {}) => { guardSpec(engine, source); return client(engine, source, opts); };
  const iconsOf = (set) => {
    if (!iconSets.has(set.name)) iconSets.set(set.name, JSON.parse(readVerified(set.files[0]).toString("utf8")));
    return iconSets.get(set.name);
  };

  function resolve(names, { target } = {}) {
    if (typeof target !== "string" || !TARGETS.has(target)) throw kitError("bad_target");
    if (!Array.isArray(names)) throw kitError("bad_lib_name", { index: 0 });
    if (names.length > KIT_LIMITS.libNames) throw kitError("too_many_libs");
    const order = [];
    const added = new Set();
    const icons = new Map();
    const refs = [];

    const addEntry = (e, index, chain) => {
      if (added.has(e.name)) return;
      if (chain.includes(e.name)) throw kitError("lib_integrity"); // a requires cycle
      if (!e.allowed.includes(target)) throw kitError("lib_not_allowed", { index, allowed: e.allowed.slice() });
      for (const r of e.requires || []) {
        const dep = entries.get(r);
        if (!dep || dep.kind === "icon-set") throw kitError("lib_integrity");
        addEntry(dep, index, [...chain, e.name]);
      }
      added.add(e.name);
      order.push(e);
    };

    names.forEach((n, index) => {
      if (typeof n !== "string" || n.length > 120) throw kitError("bad_lib_name", { index });
      if (n.startsWith(ICON_PREFIX) && n.includes("/")) {
        const slash = n.indexOf("/");
        const set = entries.get(n.slice(0, slash));
        const icon = n.slice(slash + 1);
        if (!set || set.kind !== "icon-set" || !ICON_RE.test(icon)) throw kitError("unknown_lib", { index });
        if (!set.allowed.includes(target)) throw kitError("lib_not_allowed", { index, allowed: set.allowed.slice() });
        const all = iconsOf(set);
        if (!Object.hasOwn(all, icon) || typeof all[icon] !== "string") throw kitError("unknown_lib", { index });
        const path = `__lib/icons/${set.name.slice(ICON_PREFIX.length)}/${icon}.svg`;
        icons.set(path, { svg: all[icon], set });
        refs.push(path);
        return;
      }
      const e = entries.get(n);
      if (!e || e.kind === "icon-set") throw kitError("unknown_lib", { index });
      addEntry(e, index, []);
      refs.push(`__lib/${e.main}`);
    });

    const files = [];
    const licences = new Map();
    const addLicences = (e) => {
      licences.set(e.license_file, { path: e.license_file, sha256: e.license_sha256 });
      for (const n of e.notices || []) licences.set(n.path, n);
    };
    for (const e of order) {
      addLicences(e);
      for (const f of e.files) files.push({ path: `__lib/${f.path}`, body: readVerified(f), contentType: f.type });
    }
    for (const [path, { svg, set }] of icons) {
      addLicences(set);
      files.push({ path, body: Buffer.from(svg, "utf8"), contentType: "image/svg+xml" });
    }
    for (const l of licences.values()) files.push({ path: `__lib/${l.path}`, body: readVerified(l), contentType: LICENCE_TYPE });

    return {
      files,
      refs,
      entries: order.map((e) => ({ name: e.name, kind: e.kind, main: `__lib/${e.main}`, ...(e.kind === "font" ? { family: e.family, fallback: e.fallback } : {}) })),
    };
  }

  return { version: manifest.kit_version || null, dir: kitDir, entries, themes, resolve, render };
}
