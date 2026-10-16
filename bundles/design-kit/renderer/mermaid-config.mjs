// Mermaid settings for the renderer (spec §4.2): strict security, SVG (not
// HTML) labels so output has no foreignObject. No imports: the suite asserts
// on this object (review L14).
//
// `secure` is the second layer behind the kit guard (which refuses front
// matter and %%{init}%% outright). Mermaid deletes every key named in
// `secure`, at ANY depth, from front-matter and directive config before it
// applies it. Mermaid 11.17.2 otherwise lets a spec's own config override
// initialize() (htmlLabels:true comes straight back). Listed: Mermaid's own
// defaults, every top-level key of its 11.17.2 default config (no spec gets to
// configure anything), plus htmlLabels and dompurifyConfig, which are not in
// the defaults but turn on HTML labels or loosen the label sanitizer.
const SECURE = Object.freeze([
  // Mermaid's defaults
  "secure", "securityLevel", "startOnLoad", "maxTextSize", "suppressErrorRendering", "maxEdges",
  // HTML labels, CSS and the sanitizer
  "htmlLabels", "flowchart", "themeCSS", "themeVariables", "fontFamily", "dompurifyConfig",
  "theme", "darkMode", "fontSize", "look", "layout", "elk", "markdownAutoWrap", "legacyMathML", "forceLegacyMathML",
  "arrowMarkerAbsolute", "deterministicIds", "deterministicIDSeed", "handDrawnSeed", "logLevel",
  // per-diagram blocks
  "architecture", "block", "c4", "class", "cynefin", "er", "eventmodeling", "gantt", "gitGraph", "ishikawa",
  "journey", "kanban", "mindmap", "packet", "pie", "quadrantChart", "radar", "railroad", "requirement",
  "sankey", "sequence", "state", "swimlane", "timeline", "treeView", "treemap", "venn", "xyChart",
]);

export const MERMAID_CONFIG = Object.freeze({
  startOnLoad: false, securityLevel: "strict", htmlLabels: false, flowchart: Object.freeze({ htmlLabels: false }),
  maxTextSize: 65536, maxEdges: 2000, theme: "neutral", deterministicIds: true, secure: SECURE,
});
