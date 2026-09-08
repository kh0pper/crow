/**
 * Ramble labels — the ONE rule for "who left this" (spec 2026-09-08 §3.1),
 * used by the MCP world query here and mirrored by the panel client's
 * markLabel (a plain script cannot import this). Order matters:
 *   1. yours (origin local or sync — sync rows are your own other instances);
 *   2. a contact's saved name (verified by the handshake key; no tail);
 *   3. a stranger's chosen world name plus a key tail (unverified, so the
 *      tail keeps two "Kevin"s apart and matches the key the map showed);
 *   4. the short key alone.
 */
export function keyTail(author, n) {
  return typeof author === "string" && author.length > 0 ? author.slice(0, n) : "anon";
}

export function labelFor(row, { contactName = null } = {}) {
  const noun = row?.kind === "caw" ? "caw" : "mark";
  if (row?.origin === "local" || row?.origin === "sync") return `your ${noun}`;
  if (contactName) return `${noun} by ${contactName}`;
  if (row?.author_name) return `${noun} by ${row.author_name} · ${keyTail(row.author, 4)}`;
  return `${noun} by ${keyTail(row?.author, 8)}`;
}

/** The AR anchor title for a caw, same order. */
export function cawTitleFor(row, { contactName = null } = {}) {
  if (row?.origin === "local" || row?.origin === "sync") return "Your caw";
  if (contactName) return `A caw from ${contactName}`;
  if (row?.author_name) return `A caw from ${row.author_name} · ${keyTail(row.author, 4)}`;
  return "A caw";
}
