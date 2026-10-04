import { WsError } from "../result.js";
import { NS, kids, kid, attr } from "./xml.js";
import { RUN_CONTAINERS, runText, paragraphText, paragraphHeadingLevel, paragraphNum, topBlocks, on } from "./docx-model.js";
import { relTarget } from "./opc.js";

const W = NS.w;
const escMd = (s) => s.replace(/([\\`*_[\]|])/g, "\\$1");
function inline(d, p) {
  const walk = (n) => {
    let out = "";
    for (const c of kids(n, W)) {
      if (c.localName === "r") {
        const t = runText(c); if (!t) continue;
        const rPr = kid(c, W, "rPr"); let s = escMd(t).replace(/\n/g, "  \n");
        if (on(rPr, "b") && s.trim()) s = `**${s}**`;
        if (on(rPr, "i") && s.trim()) s = `*${s}*`;
        out += s;
      } else if (c.localName === "hyperlink") {
        const id = attr(c, NS.r, "id"); const url = id ? relTarget(d.pkg, d.part, id) : null;
        const inner = walk(c); out += url ? `[${inner}](${url})` : inner;
      } else if (RUN_CONTAINERS.has(c.localName)) out += walk(c);
    }
    return out;
  };
  return walk(p);
}
function tableMd(d, tbl) {
  const rows = kids(tbl, W, "tr").map((tr) => kids(tr, W, "tc").map((tc) => kids(tc, W, "p").map((p) => inline(d, p)).join("<br>").replace(/\|/g, "\\|")));
  if (!rows.length) return "";
  const n = Math.max(...rows.map((r) => r.length));
  const line = (r) => `| ${Array.from({ length: n }, (_, i) => r[i] ?? "").join(" | ")} |`;
  return [line(rows[0]), `|${" --- |".repeat(n)}`, ...rows.slice(1).map(line)].join("\n");
}
export function blockMd(d, b) {
  if (b.localName === "tbl") return tableMd(d, b);
  if (b.localName === "sdt") return kids(kid(b, W, "sdtContent"), W).map((x) => blockMd(d, x)).filter(Boolean).join("\n\n");
  if (b.localName !== "p") return "";
  const level = paragraphHeadingLevel(d, b);
  const text = inline(d, b);
  if (level) return `${"#".repeat(level)} ${paragraphText(b).trim()}`;
  const num = paragraphNum(d, b);
  if (num) return `${"  ".repeat(num.ilvl)}${d.numbering.fmt(num.numId, num.ilvl) === "bullet" ? "-" : "1."} ${text}`;
  return text;
}
export function toMarkdown(d, blocks = topBlocks(d)) {
  const parts = []; let prevList = false;
  for (const b of blocks) {
    const md = blockMd(d, b);
    const isList = /^\s*(-|1\.) /.test(md) && b.localName === "p" && !!paragraphNum(d, b);
    if (md === "" && b.localName === "p") { prevList = false; continue; }
    parts.push((isList && prevList ? "\n" : "\n\n") + md);
    prevList = isList;
  }
  return parts.join("").trim() + "\n";
}
export function structure(d) {
  return topBlocks(d).map((b, index) => ({ b, index })).filter(({ b }) => b.localName === "p" && paragraphHeadingLevel(d, b))
    .map(({ b, index }) => ({ level: paragraphHeadingLevel(d, b), text: paragraphText(b).trim(), index }));
}
export function sectionRange(d, heading) {
  const blocks = topBlocks(d);
  const want = String(heading).normalize("NFC").trim().toLowerCase();
  const hs = structure(d);
  const h = hs.find((x) => x.text.normalize("NFC").toLowerCase() === want);
  if (!h) throw new WsError("heading_not_found", `Heading "${heading}" not found. Available: ${hs.map((x) => x.text).join(" | ") || "(no headings)"}`);
  const next = hs.find((x) => x.index > h.index && x.level <= h.level);
  return { start: h.index, end: next ? next.index : blocks.length, level: h.level };
}
