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
 * Any other inline SVG, or a result the checker still refuses, throws: the
 * vendor step never ships CSS it could not make plain.
 */
import { cssFetches } from "../../bundles/design-kit/server/lib-check.js";

const SVG_VAR = /(--[A-Za-z0-9_-]+)[ \n]*:[ \n]*url\([ \n]*(?:"data:image\/svg\+xml(?:[^"\\\n]|\\.)*"|'data:image\/svg\+xml(?:[^'\\\n]|\\.)*')[ \n]*\)/g;

export function normalizeCss(input) {
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
  css = css.replace(SVG_VAR, (m, prop) => {
    changes.push(`${prop}: inline SVG data: URL replaced with none`);
    return `${prop}:none`;
  });
  if (/data:image\/svg/i.test(css)) throw new Error("normalizeCss: an inline data:image/svg URL outside a custom property is left; handle it explicitly");
  if (cssFetches(Buffer.from(css))) throw new Error("normalizeCss: the result still fails the lib-check CSS allowlist (bundles/design-kit/server/lib-check.js)");
  return { css, comments, changes };
}
