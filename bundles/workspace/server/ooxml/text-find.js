/**
 * Format-neutral find/replace core for the OOXML editors. A paragraph is described by a text map
 * { text, segs:[{t, run, start, end}] }: its text-node contents joined, with SEP ("\u0000") standing in for every
 * tab / break / field / drawing, so a match can span runs but never one of those.
 *
 * Matching is done on the NFC form of the text (NFC and NFD spellings are equal) WITHOUT touching the paragraph;
 * only a paragraph that is actually hit gets its text nodes rewritten (normalizeSegs, then spliceSegs).
 * Used by docx-edit.js (Word) and pptx.js (PowerPoint).
 */
export const SEP = "\u0000";

/** Case fold that keeps every UTF-16 offset (a character whose lower case has another length, e.g. "İ", is kept). */
export const fold = (s, matchCase) => (matchCase ? s : Array.from(s, (c) => { const l = c.toLowerCase(); return l.length === c.length ? l : c; }).join(""));

/** The paragraph text as it would read after NFC-normalizing each text node (separators kept in place). */
export function nfcText({ text, segs }) {
  let out = "", at = 0;
  for (const g of segs) { out += text.slice(at, g.start) + text.slice(g.start, g.end).normalize("NFC"); at = g.end; }
  return out + text.slice(at);
}

/** Non-overlapping match offsets of `find` in `text`; a match containing SEP is skipped. */
export function indexAll(text, find, matchCase) {
  const H = fold(text, matchCase), N = fold(find, matchCase);
  const hits = []; let i = 0;
  while (N && (i = H.indexOf(N, i)) !== -1) { if (!text.slice(i, i + N.length).includes(SEP)) hits.push(i); i += N.length; }
  return hits;
}

/** Pure: match offsets in the NFC form of `map`. `normalized` = the stored text already is NFC. */
export function scanMap(map, find, matchCase) {
  const norm = nfcText(map);
  return { hits: indexAll(norm, find, matchCase), normalized: norm === map.text };
}

/** Only for a paragraph that IS hit: store its text nodes NFC so the scan offsets apply. */
export function normalizeSegs(segs) {
  for (const g of segs) { const n = g.t.textContent.normalize("NFC"); if (n !== g.t.textContent) g.t.textContent = n; }
}

/**
 * Replace [start,end) by repl in the text node where the match starts; the other nodes are trimmed.
 * touch(t) runs on every text node written; drop(g) on every segment whose text became empty.
 */
export function spliceSegs(segs, start, end, repl, { touch = () => {}, drop = () => {} } = {}) {
  const hit = segs.filter((g) => g.end > start && g.start < end);
  if (!hit.length) return;
  const first = hit[0];
  const tail = end <= first.end ? first.t.textContent.slice(end - first.start) : "";
  first.t.textContent = first.t.textContent.slice(0, start - first.start) + repl + tail; touch(first.t);
  for (const g of hit.slice(1)) { g.t.textContent = g.t.textContent.slice(Math.min(end, g.end) - g.start); touch(g.t); if (!g.t.textContent) drop(g); }
  if (!first.t.textContent) drop(first);
}
