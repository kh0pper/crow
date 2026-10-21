/**
 * Find every full-viewport fixed layer (a modal backdrop, a sheet's scrim, a click-catcher) in the
 * dashboard's own CSS and in the bundle panels, with its effective z-index. Used by the z-index guard
 * (tests/dashboard-overlay-z-index.test.js) and the live check (tests/player-bar-overlays-live.test.js).
 *
 * The CSS lives in .css files and inside template literals in .js files; a flat `selector{body}` scan
 * finds both (rules nested in @media still match, their own braces hold no braces). A layer is
 * "full-viewport" when its rule says position:fixed and inset:0, or top/left 0 with right:0 or
 * width:100% and bottom:0 or height:100%. A layer that ends at the bar (bottom: var(--crow-player-h…))
 * does not cover it and is skipped. Its z-index is the highest one any rule with the same selector in
 * the same file gives it (a phone @media rule may raise it).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export const REPO = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");

/** Roots scanned: the dashboard (panels, shared, Perch) and every bundle's panel. */
function roots() {
  const out = [join(REPO, "servers/gateway/dashboard")];
  for (const b of readdirSync(join(REPO, "bundles"))) {
    const p = join(REPO, "bundles", b, "panel");
    try { if (statSync(p).isDirectory()) out.push(p); } catch {}
  }
  return out;
}

function walk(dir, files) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "vendor" || name === "leaflet") continue;   // third-party
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, files);
    else if (/\.(js|mjs|css|html)$/.test(name) && !/\.min\./.test(name)) files.push(p);
  }
  return files;
}

const flat = (s) => s.replace(/\s+/g, "").toLowerCase();

function coversViewport(body) {
  const b = ";" + flat(body);
  if (!/;position:fixed/.test(b)) return false;
  const full = /;inset:0(px)?(;|!|$)/.test(b) ||
    (/;top:0(px)?(;|!|$)/.test(b) && /;left:0(px)?(;|!|$)/.test(b) &&
     (/;right:0(px)?(;|!|$)/.test(b) || /;width:100(%|vw)(;|!|$)/.test(b)) &&
     (/;bottom:0(px)?(;|!|$)/.test(b) || /;height:100(%|vh)(;|!|$)/.test(b)));
  // A layer whose bottom is the bar's top (or any non-zero bottom) ends above the bar.
  return full && !/;bottom:(?!0(px)?(;|!|$))[^;]+/.test(b);
}

function zOf(body) {
  const m = /(?:^|[;{\s])z-index\s*:\s*(-?\d+)/i.exec(body);
  return m ? Number(m[1]) : null;
}

/** Every flat `selector{body}` rule in a file, comments stripped. */
function parseRules(path) {
  const text = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const re = /([^{};`]+)\{([^{}]*)\}/g;
  const rules = [];
  let m;
  while ((m = re.exec(text))) rules.push({ selector: m[1].trim().replace(/\s+/g, " "), body: m[2] });
  return rules;
}

/** [{ file, selector, z }] — z is null when no rule for the selector sets one. */
export function findFixedOverlays() {
  const out = [];
  for (const root of roots()) {
    for (const file of walk(root, [])) {
      const rules = parseRules(file);
      const zBySel = new Map();
      for (const r of rules) {
        const z = zOf(r.body);
        if (z !== null) zBySel.set(r.selector, Math.max(zBySel.get(r.selector) ?? -Infinity, z));
      }
      const seen = new Set();
      for (const r of rules) {
        if (!coversViewport(r.body) || seen.has(r.selector)) continue;
        seen.add(r.selector);
        out.push({ file: relative(REPO, file), selector: r.selector, z: zBySel.get(r.selector) ?? null });
      }
    }
  }
  return out;
}

/** Every rule for `selector` in `file` (the live check injects these, verbatim, into a test page). */
export function rulesFor(file, selector) {
  return parseRules(join(REPO, file)).filter((r) => r.selector === selector).map((r) => `${selector}{${r.body}}`).join("\n");
}
