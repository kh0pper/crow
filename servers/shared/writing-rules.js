/**
 * Writing rules (the crow.md `writing_style` section): is it still the seeded
 * template, and what are its real rules?
 *
 * The seed (scripts/init-db.js) is three `###` headings, each followed by a
 * "(Add …)" placeholder line. It is 269 characters, so the Skills panel's old
 * `length < 20` check never offered "Set up writing rules", and its
 * placeholder reached every MCP client as "Writing rules: (Add patterns…)"
 * (skills audit A26). This is not a length check and not an exact-string
 * compare: an older seed with other whitespace, CRLF line endings or a
 * reordering of the same placeholders is still a template.
 *
 * No imports: the gateway, the memory server and the stdio servers all load it.
 */

/** A line that is only a "( … )" placeholder. */
const isPlaceholder = (line) => /^\(.*\)$/.test(line.trim());
const isHeading = (line) => /^#{1,6}\s/.test(line.trim());

/** True when nothing but headings, placeholder lines and whitespace is left. */
export function isWritingRulesTemplate(content) {
  if (typeof content !== "string") return true;
  return content.split(/\r?\n/).every((l) => !l.trim() || isHeading(l) || isPlaceholder(l));
}

/**
 * The section's real rules: placeholder lines removed, and any `###`
 * subsection left with no body dropped. null when nothing real is left.
 * Text with no placeholder line is returned unchanged.
 */
export function writingRulesBody(content) {
  if (isWritingRulesTemplate(content)) return null;
  const lines = content.split(/\r?\n/);
  if (!lines.some(isPlaceholder)) return content;
  const kept = lines.filter((l) => !isPlaceholder(l));
  // Drop a heading whose block (up to the next heading of the same or a
  // higher level) holds no text.
  const level = (l) => (l.trim().match(/^(#{1,6})\s/) || [, ""])[1].length;
  const out = [];
  for (let i = 0; i < kept.length; i++) {
    const l = kept[i];
    if (isHeading(l)) {
      let has = false;
      for (let j = i + 1; j < kept.length; j++) {
        if (isHeading(kept[j]) && level(kept[j]) <= level(l)) break;
        if (kept[j].trim() && !isHeading(kept[j])) { has = true; break; }
      }
      if (!has) continue;
    }
    out.push(l);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() || null;
}
