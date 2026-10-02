/**
 * Article HTML -> Markdown for the extract tools (Readability output in,
 * Turndown out), with MathML collapsed to ONE copy of its TeX source.
 *
 * Why: arXiv (LaTeXML) and most MathML pages ship each formula twice inside
 * one <math> element — the presentation tree (<mn>126</mn>) and the TeX in
 * <annotation encoding="application/x-tex">126</annotation>, with the same
 * TeX again in the element's alttext. Turndown has no rule for <math>, so it
 * kept the text of BOTH children: "$126$B" in the paper became "126126B" in
 * the extracted markdown (seen in a hank Perch session, 2026-10-02, arXiv
 * 2608.30320). This rule emits `$tex$` (inline) or a `$$` block (display),
 * which the Perch bot renderer then shows once.
 */

/** The TeX for a <math> element: alttext, else its x-tex annotation, else
 *  the presentation text with every annotation removed. */
export function mathTex(node) {
  const attr = (n, k) => (n && typeof n.getAttribute === "function" ? n.getAttribute(k) : null);
  const alt = attr(node, "alttext");
  if (alt && alt.trim()) return alt.trim();
  const anns = node && typeof node.getElementsByTagName === "function"
    ? Array.from(node.getElementsByTagName("annotation")) : [];
  const tex = anns.find((a) => /tex/i.test(String(attr(a, "encoding") || "")));
  if (tex && tex.textContent && tex.textContent.trim()) return tex.textContent.trim();
  let text = String((node && node.textContent) || "");
  for (const a of anns) text = text.replace(a.textContent || "", "");
  return text.replace(/\s+/g, " ").trim();
}

export const mathRule = {
  filter: (node) => String((node && node.nodeName) || "").toLowerCase() === "math",
  replacement: (_content, node) => {
    const tex = mathTex(node);
    if (!tex) return "";
    const display = String((node.getAttribute && node.getAttribute("display")) || "") === "block";
    return display ? "\n\n$$\n" + tex + "\n$$\n\n" : "$" + tex + "$";
  },
};

/** A configured Turndown instance (the class is injected — the bundle
 *  imports it lazily, exactly as before). */
export function articleTurndown(Turndown) {
  const td = new Turndown({ headingStyle: "atx", codeBlockStyle: "fenced" });
  td.addRule("mathml", mathRule);
  return td;
}
