import { parseXml, NS, all, kid, kids } from "../ooxml/xml.js";
/** [{href, props: Map("ns|local" → Element)}] — only 200 propstats are kept. */
export function parseMultistatus(text) {
  const doc = parseXml(text, "multistatus");
  return all(doc, NS.d, "response").map((r) => {
    const props = new Map();
    for (const ps of kids(r, NS.d, "propstat")) {
      if (!/\s200\s/.test(kid(ps, NS.d, "status")?.textContent || "")) continue;
      for (const p of kids(kid(ps, NS.d, "prop"))) props.set(`${p.namespaceURI}|${p.localName}`, p);
    }
    return { href: kid(r, NS.d, "href")?.textContent || "", props };
  });
}
export const propText = (props, ns, local) => props.get(`${ns}|${local}`)?.textContent ?? null;
