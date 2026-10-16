// No @import survives in renderer output (spec §3.3). Dependency-free so the
// suite can test it without the renderer's own node_modules.
export function stripImports(svg) {
  let out = "", i = 0;
  // ASCII-only lower-casing (as lib-check.js does): String#toLowerCase can
  // change the length (U+0130 becomes two code units), shifting the offsets
  // used to slice the original.
  const low = svg.replace(/[A-Z]/g, (ch) => ch.toLowerCase());
  for (;;) {
    const k = low.indexOf("@import", i);
    if (k < 0) return out + svg.slice(i);
    const end = low.indexOf(";", k);
    out += svg.slice(i, k);
    i = end < 0 ? svg.length : end + 1;
  }
}
