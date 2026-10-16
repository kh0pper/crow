// svgo clean-up plus two hard rules: no @import in <style>, no external href.
// Artifacts re-checks the result (renderer output is untrusted, spec §4.5).
import { optimize } from "svgo";

function stripImports(svg) {
  let out = "", i = 0;
  const low = svg.toLowerCase();
  for (;;) {
    const k = low.indexOf("@import", i);
    if (k < 0) return out + svg.slice(i);
    const end = low.indexOf(";", k);
    out += svg.slice(i, k);
    i = end < 0 ? svg.length : end + 1;
  }
}
const dropExternalRefs = {
  name: "crowDropExternalRefs",
  fn: () => ({ element: { enter: (node) => { for (const a of ["href", "xlink:href"]) { const v = node.attributes[a]; if (v != null && !String(v).startsWith("#")) delete node.attributes[a]; } } } }),
};
export function cleanSvg(svg) {
  // svgo 4 names the script remover "removeScripts" (v3: removeScriptElement).
  // minifyStyles is off: its csso restructurer throws on the <style> Mermaid
  // 11.17.2 emits for erDiagram and mindmap (a minifier crash, not a security
  // rule; the two hard rules above and below still run).
  return optimize(stripImports(svg), { multipass: true, plugins: [{ name: "preset-default", params: { overrides: { cleanupIds: false, minifyStyles: false } } }, "removeScripts", dropExternalRefs] }).data;
}
