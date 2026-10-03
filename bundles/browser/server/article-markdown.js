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
 *  the presentation tree alone — the first child of <semantics> (which
 *  excludes every <annotation> and <annotation-xml>), or the element's own
 *  text when there is no <semantics>. */
export function mathTex(node) {
  return unwrapStyle(rawMathTex(node));
}

/** Wikipedia wraps every formula as `{\displaystyle …}`; the wrapper is
 *  presentation, and a leading `${` reads as template syntax downstream. */
function unwrapStyle(tex) {
  const m = /^\{\\(?:displaystyle|textstyle|scriptstyle)\b\s*([\s\S]*)\}$/.exec(tex);
  return m ? m[1].trim() : tex;
}

function rawMathTex(node) {
  const attr = (n, k) => (n && typeof n.getAttribute === "function" ? n.getAttribute(k) : null);
  const byTag = (n, t) => (n && typeof n.getElementsByTagName === "function"
    ? Array.from(n.getElementsByTagName(t)) : []);
  const alt = attr(node, "alttext");
  if (alt && alt.trim()) return alt.trim();
  const tex = byTag(node, "annotation").find((a) => /tex/i.test(String(attr(a, "encoding") || "")));
  if (tex && tex.textContent && tex.textContent.trim()) return tex.textContent.trim();
  const sem = byTag(node, "semantics")[0];
  const first = sem && sem.firstElementChild;
  const text = first ? first.textContent : (node && node.textContent);
  return String(text || "").replace(/\s+/g, " ").trim();
}

const isMath = (node) => String((node && node.nodeName) || "").toLowerCase() === "math";

export const mathRule = {
  filter: isMath,
  replacement: (_content, node) => {
    const tex = mathTex(node);
    if (!tex) return "";
    const display = String((node.getAttribute && node.getAttribute("display")) || "") === "block";
    return display ? "\n\n$$\n" + tex + "\n$$\n\n" : "$" + tex + "$";
  },
};

/** The VISUAL duplicate a math renderer ships beside its MathML: KaTeX's
 *  aria-hidden glyph tree (`.katex-html`), and Wikipedia's fallback image
 *  (`img.mwe-math-fallback-image-*`, whose alt is the TeX again). The
 *  MathML half is kept — mathRule turns it into TeX once. */
export const mathDuplicateRule = {
  filter: (node) => {
    const cls = String((node && typeof node.getAttribute === "function" && node.getAttribute("class")) || "");
    return /(?:^|\s)katex-html(?:\s|$)/.test(cls) || /(?:^|\s)mwe-math-fallback-image-/.test(cls);
  },
  replacement: () => "",
};

/** A configured Turndown instance (the class is injected — the bundle
 *  imports it lazily, exactly as before). */
export function articleTurndown(Turndown) {
  const td = new Turndown({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    // Turndown tests "blank" BEFORE custom rules, so a <math> carrying only
    // alttext (no presentation text) never reached mathRule. Default
    // behaviour otherwise (turndown's own blankReplacement).
    // Padded with spaces: a blank node has no flanking whitespace of its
    // own, so the space after it would otherwise collapse into "$z$alt".
    blankReplacement: (content, node) => {
      if (!isMath(node)) return node.isBlock ? "\n\n" : "";
      const md = mathRule.replacement(content, node);
      return md && !md.startsWith("\n") ? " " + md + " " : md;
    },
  });
  td.addRule("mathDuplicate", mathDuplicateRule);
  td.addRule("mathml", mathRule);
  return td;
}
