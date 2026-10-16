/**
 * Design kit — VENDOR TIME ONLY. Turns an upstream CSS build into the plain
 * shape bundles/design-kit/server/lib-check.js accepts (see its header), and
 * says exactly what it changed:
 *   - a leading BOM is dropped; CRLF and lone CR become LF; tabs outside
 *     strings become spaces;
 *   - every comment outside a string is removed and returned in `comments`
 *     (the caller keeps licence banners under licenses/);
 *   - a custom property whose value is an inline SVG data: URL (Pico's icons,
 *     Open Props' noise textures: their xmlns names a remote URL, which the
 *     checker refuses) gets the value `none`, listed in `changes`. Rules that
 *     use the property through var() then draw no image instead of an icon.
 *     With { extractSvgDir: "icons" }, an inline SVG that passes lib-check's
 *     SVG allowlist is instead returned in `assets` as <dir>/<prop>[-n].svg
 *     (one file per distinct SVG, n counting distinct SVGs of one property in
 *     source order) and the value becomes url(<dir>/<file>), relative to the
 *     stylesheet; only a failing SVG gets `none`.
 * Any other inline SVG, or a result the checker still refuses, throws: the
 * vendor step never ships CSS it could not make plain.
 */
import { cssFetches, svgUnsafe } from "../../bundles/design-kit/server/lib-check.js";

const SVG_VAR = /(--[A-Za-z0-9_-]+)[ \n]*:[ \n]*url\([ \n]*(?:"(data:image\/svg\+xml(?:[^"\\\n]|\\.)*)"|'(data:image\/svg\+xml(?:[^'\\\n]|\\.)*)')[ \n]*\)/g;

/** The SVG text of a data:image/svg+xml URL (percent-encoded or base64), or null. */
function decodeSvgDataUrl(url) {
  const m = /^data:image\/svg\+xml((?:;[A-Za-z0-9=-]+)*),(.*)$/s.exec(url);
  if (!m || url.includes("\\")) return null;
  try {
    return /;base64$/i.test(m[1]) ? Buffer.from(m[2], "base64").toString("utf8") : decodeURIComponent(m[2]);
  } catch { return null; }
}

export function normalizeCss(input, { extractSvgDir = null } = {}) {
  let src = String(input);
  if (src.startsWith("﻿")) src = src.slice(1);
  src = src.replace(/\r\n?/g, "\n");
  const comments = [];
  let css = "";
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end < 0) throw new Error("normalizeCss: unterminated comment");
      comments.push(src.slice(i, end + 2));
      i = end + 1;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      for (; j < src.length && src[j] !== c; j++) if (src[j] === "\\") j++;
      css += src.slice(i, j + 1);
      i = j;
      continue;
    }
    css += c === "\t" ? " " : c;
  }
  const changes = [];
  const assets = [];
  const fileOf = new Map(); // "<prop>\0<svg>" -> file
  const perProp = new Map();
  css = css.replace(SVG_VAR, (m, prop, dq, sq) => {
    if (extractSvgDir) {
      const svg = decodeSvgDataUrl(dq ?? sq);
      if (svg === null || svgUnsafe(svg)) {
        changes.push(`${prop}: inline SVG fails the lib-check SVG allowlist, replaced with none`);
        return `${prop}:none`;
      }
      const key = `${prop}\0${svg}`;
      let file = fileOf.get(key);
      if (!file) {
        const n = (perProp.get(prop) || 0) + 1;
        perProp.set(prop, n);
        file = `${extractSvgDir}/${prop.slice(2)}${n > 1 ? `-${n}` : ""}.svg`;
        fileOf.set(key, file);
        assets.push({ file, svg });
      }
      changes.push(`${prop}: inline SVG extracted to ${file}`);
      return `${prop}:url(${file})`;
    }
    changes.push(`${prop}: inline SVG data: URL replaced with none`);
    return `${prop}:none`;
  });
  if (/data:image\/svg/i.test(css)) throw new Error("normalizeCss: an inline data:image/svg URL outside a custom property is left; handle it explicitly");
  if (cssFetches(Buffer.from(css))) throw new Error("normalizeCss: the result still fails the lib-check CSS allowlist (bundles/design-kit/server/lib-check.js)");
  return { css, comments, changes, assets };
}
