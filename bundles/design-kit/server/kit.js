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

/**
 * Open a kit directory (the bundle root, holding lib/manifest.json).
 * @returns {{ version: string|null, dir: string, entries: Map<string, object>, themes: Map<string, object>,
 *   resolve(names: string[], opts: { target: "page"|"document"|"diagram" }):
 *     { files: {path: string, body: Buffer, contentType: string}[], refs: string[],
 *       entries: {name: string, kind: string, main: string, family?: string, fallback?: string}[] } }}
 * `renderUrl` / `fetchImpl` are accepted now for the renderer (Task 6).
 */
export function openKit(kitDir, { renderUrl = DEFAULT_RENDER_URL, fetchImpl = globalThis.fetch } = {}) {
  void renderUrl; void fetchImpl;
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

  return { version: manifest.kit_version || null, dir: kitDir, entries, themes, resolve };
}
